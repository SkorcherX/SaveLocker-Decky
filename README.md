# SaveLocker — Decky plugin

Sets the Steam launch options [SaveLocker](https://github.com/SkorcherX/SaveLocker) needs, so a Steam
Deck syncs saves without pasting `savelocker run -- %command%` into every game by hand.

**You need the SaveLocker agent installed and running for this to do anything.** The plugin talks to
the agent on `localhost:5178`; with no agent it says so and does nothing else.

**It is an accelerator, never the supported path.** A Deck without it loses nothing: the agent UI's
launch-setup card and `savelocker launch-options` still give you the command to paste, and
`savelocker doctor` still reports whether a game has it.

## Install

The plugin is **not on the Decky store** (see [Why not the store](#why-not-the-store)). Two ways in:

### Custom store — install, and get update prompts

In Decky: **Settings → General → Store**, choose **Custom**, and set the store URL to:

```
https://raw.githubusercontent.com/SkorcherX/SaveLocker-Decky/main/store/plugins
```

SaveLocker then appears in Decky's store, and when a new version is released Decky offers the update
the same way it does for any other plugin.

> ⚠️ **This replaces the official store while it is set.** Decky supports one store URL at a time, so
> you will not see other plugins until you switch back to **Default**. Switch to Custom to install or
> update SaveLocker, then switch back. Plugins already installed keep working either way — the store
> setting only affects what you can browse and what Decky checks for updates.

### One-off install from a URL

Decky's **Settings → General → Install Plugin from URL**, with the latest release asset:

```
https://github.com/SkorcherX/SaveLocker-Decky/releases/latest/download/SaveLocker.zip
```

Simplest, and it does not touch your store setting — but Decky will not tell you when an update
exists, because it only checks the configured store.

## Use

Open the Decky menu → **SaveLocker**.

Writing is **off** by default on every load. Press **Check (no changes)** first: each enrolled game
shows what its launch options are *now* and what they would become. When that looks right, turn
**Allow writing to Steam** on and press **Apply now**.

It **merges** rather than overwrites. A game already running `mangohud`, setting environment
variables, or passing its own arguments keeps all of it — the wrapper is substituted into
`%command%`, where Steam expects it. It also repairs a bare `savelocker` into the full path, which is
the most common setup mistake: Game Mode does not put `~/.local/bin` on `PATH`, so the short form
silently stops the game launching.

## Why this exists as a plugin

The agent **cannot** write launch options. They live in Steam's `localconfig.vdf` / `shortcuts.vdf`,
which Steam holds in memory and rewrites wholesale on exit — so an edit made while Steam is running
is silently discarded, and one made while it is closed races the next launch. A Decky plugin's
frontend runs inside Steam's own JS context, so `SteamClient.Apps.SetAppLaunchOptions` persists
through Steam's normal path. That is the entire reason for the dependency.

## What it knows, and what it does not

It holds no SaveLocker rules. Each pass it:

1. asks the agent which tracked games Steam launches (`GET /api/launch-options`),
2. reads each one's **current** options out of Steam,
3. posts them to `POST /api/launch-options/resolve` and gets back a target per game plus a
   `changed` flag,
4. writes only the ones marked `changed`, and reports every outcome to
   `POST /api/launch-options/applied` so `savelocker doctor` can answer for that game.

The rule lives in the agent (`src/Agent.Core/LaunchOptions.cs`), where it is tested without Steam or
hardware. So the launch command can change without a plugin release — and, more importantly, your own
launch options survive, because the merge happens where the rule is. Step 3 is not optional: the
string from step 1 assumes a game with nothing set, and writing it blindly would wipe the rest out.

## Two constraints that are not negotiable

- **All agent calls happen in `main.py`, never in the frontend.** The agent's API requires a token,
  checks `Host` is loopback and rejects any foreign `Origin`, with no CORS policy — deliberately,
  because reaching that API is equivalent to owning the machine. The frontend runs on
  `https://steamloopback.host` and therefore cannot call it at all. Do not "fix" this by relaxing the
  agent's guard.
- **No `_root` flag, and the backend is read-only against `~/.local/share/SaveLocker/`.** Everything
  it needs is the desktop user's own: the `api-token` is mode 0600 owned by that user and the agent's
  API is loopback. Root would buy nothing, and a root-created file in that directory breaks the agent
  the next time it rewrites it.

## Build

```sh
npm install
npm run build      # -> dist/index.js
```

Releasing is a tag. `.github/workflows/release.yml` builds the bundle, packages the zip exactly as
Decky unpacks it, publishes it, and regenerates `store/plugins` carrying that zip's SHA-256 — which
Decky verifies before installing, so the index and the artifact are always produced together.

## Manual install (development)

`~/homebrew/plugins/` is root-owned, so stage over SSH and move with `sudo`. **All four** of
`plugin.json`, **`package.json`**, `main.py` and `dist/` must be present:

```sh
scp -r plugin.json package.json main.py dist deck@<ip>:~/savelocker-plugin-stage/
ssh deck@<ip> 'sudo cp -r ~/savelocker-plugin-stage /home/deck/homebrew/plugins/SaveLocker && sudo systemctl restart plugin_loader'
```

**`package.json` is not optional**, and omitting it fails misleadingly. Decky chooses how to load a
plugin from that file: `"type": "module"` selects `import()`, and no `package.json` at all falls back
to `eval`ing the bundle as a classic script — so an ESM bundle dies on its own last line with
`SyntaxError: Unexpected token 'export'`, thrown from inside Decky's loader with nothing pointing at a
missing file. The tell is `version: null` for the plugin in `DeckyPluginLoader.plugins`.

## Debugging

The Python backend logs to `~/homebrew/logs/SaveLocker/*.log` on the Deck. The **frontend** logs
nowhere on disk — it runs in Steam's `SharedJSContext`, so a render error exists only in CEF while the
backend log happily reports a clean load. Reach it without touching the Deck's screen:

```sh
ssh -N -L 8080:127.0.0.1:8080 deck@<ip>    # CEF is loopback-only on the Deck
curl -s http://localhost:8080/json          # find the SharedJSContext / QuickAccess targets
```

Then drive CDP over the websocket; `Runtime.evaluate` of `document.body.innerText` against the
**QuickAccess** target prints whatever the panel is showing, error boundary included.

## Why not the store

The [Decky plugin database](https://github.com/SteamDeckHomebrew/decky-plugin-database) requires
submitters to attest that generative AI was not used to write a majority of the submitted code. This
plugin was largely AI-written, so that attestation cannot honestly be made, and it is not submitted.
Store listing also requires verification on both the Stable and Beta SteamOS channels and a
third-party testing report.

Worth noting for any future submission: this repository is **PolyForm Noncommercial**, which is not an
OSI-approved open source licence.

## Licence

PolyForm Noncommercial 1.0.0 — see [LICENSE](LICENSE).
