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
