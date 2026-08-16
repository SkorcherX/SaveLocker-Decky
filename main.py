"""
SaveLocker's Decky plugin — backend.

Every call to the agent happens HERE, not in the frontend, and that is not a style choice. The
agent's local API on :5178 requires an X-SaveLocker-Token header, checks that Host is loopback, and
rejects any foreign Origin — with no CORS policy, deliberately, because that API can re-point the
machine at another server. The plugin's frontend runs on https://steamloopback.host, so it is a
foreign origin and cannot call the agent at all. That is the defence working, not an obstacle to
route around: do not ask for a CORS exemption.

This plugin does NOT ask for the `_root` flag, and must not. Everything it needs is the desktop
user's own: the api-token file is mode 0600 owned by that user, and the agent's API is loopback. A
root backend would gain nothing and cost plenty — Decky would run this code as root, and a
root-created file under ~/.local/share/SaveLocker would break the agent the next time it rewrote
that file as the desktop user. Read the token; write nothing there.
"""

import asyncio
import json
import os
import urllib.error
import urllib.request

import decky

AGENT = "http://127.0.0.1:5178"
TIMEOUT = 5


def _state_dir() -> str:
    # DECKY_USER_HOME, not HOME: the backend runs as root, whose home is /root.
    home = decky.DECKY_USER_HOME or os.path.expanduser("~")
    return os.path.join(home, ".local", "share", "SaveLocker")


def _token() -> str | None:
    try:
        with open(os.path.join(_state_dir(), "api-token"), "r", encoding="utf-8") as handle:
            token = handle.read().strip()
        return token or None
    except OSError:
        # No agent installed, or it has never run. Not an error worth shouting about: most Decks
        # that install this plugin will get here at least once.
        return None


def _request(path: str, payload=None):
    token = _token()
    if token is None:
        return {"ok": False, "reason": "no-agent"}

    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(AGENT + path, data=body, method="POST" if body else "GET")
    request.add_header("X-SaveLocker-Token", token)
    if body:
        request.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            raw = response.read().decode("utf-8")
        return {"ok": True, "data": json.loads(raw) if raw else None}
    except urllib.error.HTTPError as err:
        decky.logger.warning("SaveLocker agent returned HTTP %s for %s", err.code, path)
        return {"ok": False, "reason": f"http-{err.code}"}
    except (urllib.error.URLError, TimeoutError, OSError):
        # The daemon is not running. Expected on a Deck that has not started it yet.
        return {"ok": False, "reason": "unreachable"}
    except json.JSONDecodeError:
        return {"ok": False, "reason": "bad-response"}


def _user_systemd_env() -> dict:
    """
    The environment `systemctl --user` needs, which a plugin host does not supply.

    Decky's backend is not a login shell, so it has no XDG_RUNTIME_DIR — and without one systemctl
    cannot find the user manager's socket and fails with "Failed to connect to bus", which reads
    like systemd being broken rather than an unset variable. The socket lives at a fixed path per
    uid, so it can simply be named.

    This is also why the plugin must stay non-`_root`: `savelocker.service` is a `systemd --user`
    unit belonging to the desktop user, and root's systemd has never heard of it.
    """
    env = dict(os.environ)
    env.setdefault("XDG_RUNTIME_DIR", "/run/user/%d" % os.getuid())
    return env


def _agent_binary() -> str | None:
    """
    The installed agent binary. Preferred over `~/.local/bin/savelocker` because that is a symlink
    install.sh may not have created, and a missing one would read as "no agent" on a working device.
    """
    home = decky.DECKY_USER_HOME or os.path.expanduser("~")
    for candidate in (
        os.path.join(home, ".local", "share", "SaveLocker", "savelocker"),
        os.path.join(home, ".local", "bin", "savelocker"),
    ):
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


class Plugin:
    async def state(self):
        """Connection, machine, last sync, and any lease warnings this device is holding."""
        return _request("/api/state")

    async def agent_version(self):
        """Current version, and whether the agent has a newer one waiting."""
        return _request("/api/agent-version")

    async def restart_agent(self):
        """
        Restart `savelocker.service` — which is how an update the agent already staged gets
        installed.

        **Not `savelocker update`, deliberately.** That command re-checks the server, so it fails
        when the Deck is offline even though a downloaded, verified payload is sitting on disk, and
        it applies while the daemon is still live. The unit's own `ExecStartPre` performs the swap
        in a fresh invocation with the old daemon already gone, which is the entire reason the
        agent's design puts it there. Same outcome on a good day, better on every other.

        Safe to call from here even though the restart kills the agent's whole cgroup: this process
        belongs to Decky's cgroup, not to `savelocker.service`. The agent itself cannot do this to
        itself for exactly that reason.

        The caller must expect the agent's API to disappear for a few seconds afterwards — this
        command is the thing that takes it away.
        """
        try:
            proc = await asyncio.create_subprocess_exec(
                "systemctl", "--user", "restart", "savelocker.service",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                env=_user_systemd_env(),
            )
            # `restart` is synchronous: it returns once the unit is active, which means after
            # ExecStartPre has finished the swap. Generous, because that swap copies the whole
            # install.
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=120)
            output = stdout.decode("utf-8", "replace").strip()
            if proc.returncode != 0:
                decky.logger.warning("restart failed (%s): %s", proc.returncode, output)
                # systemctl's own words, passed through: "Failed to connect to bus" and "Unit
                # savelocker.service not found" are completely different problems with completely
                # different fixes, and only it can tell them apart.
                return {"ok": False, "reason": output or "exit-%d" % proc.returncode}
            return {"ok": True, "data": None}
        except asyncio.TimeoutError:
            try: proc.kill()
            except Exception: pass
            return {"ok": False, "reason": "timeout"}
        except OSError as err:
            decky.logger.warning("could not run systemctl: %s", err)
            return {"ok": False, "reason": "exec-failed"}

    async def dismiss_warning(self, game_name: str):
        """
        Clear one lease warning.

        Dismiss is not resolve: it clears the notice, not the condition. If the other machine still
        holds the lease the agent will record it again, which is correct — the warning exists to be
        seen before launching, not to be permanently silenced.
        """
        return _request("/api/lease-warnings/dismiss", {"gameName": game_name})

    async def doctor(self):
        """
        Run `savelocker doctor` and hand back its output.

        Executed rather than fetched: doctor has no API, and on a Deck it is the only diagnostic
        there is — reaching it otherwise means Desktop Mode and a terminal, which is exactly the
        friction this panel exists to remove. It makes network calls, so it is slow and on-demand
        only, never on a timer.
        """
        binary = _agent_binary()
        if binary is None:
            return {"ok": False, "reason": "no-agent"}
        try:
            proc = await asyncio.create_subprocess_exec(
                binary, "doctor",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=60)
            return {"ok": True, "data": {"exitCode": proc.returncode,
                                         "output": stdout.decode("utf-8", "replace")}}
        except asyncio.TimeoutError:
            # Leaving it running would hold a subprocess for the life of the plugin.
            try: proc.kill()
            except Exception: pass
            return {"ok": False, "reason": "timeout"}
        except OSError as err:
            decky.logger.warning("could not run doctor: %s", err)
            return {"ok": False, "reason": "exec-failed"}

    async def games(self):
        """Every game this machine tracks — not just the ones Steam launches."""
        return _request("/api/games")

    async def sync(self, action: str, game: str | None = None, force: bool = False):
        """
        Run `savelocker push|pull [game|all] [--force]`.

        Executed rather than reimplemented, so it inherits every guard the agent already has instead
        of this plugin growing its own opinion about when a sync is safe:

          * `pull` refuses while the game is running — checked in the CLI and AGAIN in SyncEngine,
            and forcing does not override it.
          * a plain `pull` refuses to overwrite local saves holding un-pushed changes;
          * a plain `push` that diverged becomes a conflict rather than overwriting the server head.

        `--force` defeats the first two of those and is the only way to lose data here, which is why
        the caller has to confirm it against a named target.
        """
        if action not in ("push", "pull"):
            return {"ok": False, "reason": "bad-action"}

        binary = _agent_binary()
        if binary is None:
            return {"ok": False, "reason": "no-agent"}

        # A list, never a shell string: a game name is user data and can contain anything.
        args = [binary, action, game or "all"]
        if force:
            args.append("--force")

        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            # Generous: a push waits out the settle gate, and a big save over a slow link is slower
            # still. Better to wait than to orphan a sync half-done.
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=600)
            return {"ok": True, "data": {"exitCode": proc.returncode,
                                         "output": stdout.decode("utf-8", "replace")}}
        except asyncio.TimeoutError:
            try: proc.kill()
            except Exception: pass
            return {"ok": False, "reason": "timeout"}
        except OSError as err:
            decky.logger.warning("could not run %s: %s", action, err)
            return {"ok": False, "reason": "exec-failed"}

    async def rows(self):
        """Every tracked game Steam launches, and what it should carry."""
        return _request("/api/launch-options")

    async def resolve(self, games):
        """
        Merge each game's CURRENT options with the wrapper.

        The agent owns the rule and Steam owns the current value, so neither side can do this
        alone — which is why this is a round trip and not a string assembled here. Nothing in this
        plugin knows what a launch option should look like, so the rule can change without a
        plugin release.
        """
        return _request("/api/launch-options/resolve", {"games": games})

    async def report(self, steam_app_id: int, applied: bool, error: str | None = None):
        """Tell the agent what happened, so `savelocker doctor` can answer for this game."""
        return _request(
            "/api/launch-options/applied",
            {"steamAppId": steam_app_id, "applied": applied, "error": error},
        )

    async def _main(self):
        decky.logger.info("SaveLocker plugin loaded; agent state dir: %s", _state_dir())

    async def _unload(self):
        decky.logger.info("SaveLocker plugin unloaded")
