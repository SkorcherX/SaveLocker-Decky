# SaveLocker — Decky plugin

Sets the Steam launch options SaveLocker needs, so a Deck syncs saves without pasting
`savelocker run -- %command%` into every game by hand.

**It is an accelerator, never the supported path.** A Deck without Decky Loader loses nothing: the
agent UI's launch-setup card and `savelocker launch-options` still give you the command to paste,
and `savelocker doctor` still reports whether a game has it.

## Why this is a plugin and not part of the agent

The agent *cannot* write launch options. They live in Steam's `localconfig.vdf` / `shortcuts.vdf`,
which Steam holds in memory and rewrites wholesale on exit — so an edit made while Steam is running
is silently discarded, and one made while it is closed races the next launch. A Decky plugin's
frontend runs inside Steam's own JS context, so `SteamClient.Apps.SetAppLaunchOptions` persists
through Steam's normal path. That is the entire reason for the dependency.

## What it does and does not know

It knows nothing about what a launch option should look like. Each pass it:

1. asks the agent which tracked games Steam launches (`GET /api/launch-options`),
2. reads each one's **current** options out of Steam,
3. posts them to `POST /api/launch-options/resolve` and gets back a target per game plus a
   `changed` flag,
4. writes only the ones marked `changed`, and reports every outcome to
   `POST /api/launch-options/applied` so `savelocker doctor` can answer for that game.

The rule lives in the agent (`src/Agent.Core/LaunchOptions.cs`), tested without Steam or hardware.
So the launch command can change without a plugin release — and, more importantly, a user's
`mangohud`, environment variables and per-game arguments survive, because the merge happens where
the rule is. Step 3 is not optional: the `desired` string from step 1 assumes a game with nothing
set, and writing it blindly would wipe all of that out.

## Two constraints that are not negotiable

- **All agent calls happen in `main.py`, never in the frontend.** The agent's API requires a token,
  checks `Host` is loopback and rejects any foreign `Origin`, with no CORS policy — deliberately,
  because reaching that API is equivalent to owning the machine. The frontend runs on
  `https://steamloopback.host` and therefore cannot call it at all. Do not "fix" this by relaxing
  the agent's guard.
- **The backend is read-only against `~/.local/share/SaveLocker/`.** Decky runs plugin backends as
  root; a root-created file there would break the agent the next time it rewrote it as the desktop
  user. It reads `api-token` and nothing else.

## Build

```sh
cd decky
npm install
npm run build      # -> dist/index.js
```

## Install on a Deck

Decky loads plugins from `~/homebrew/plugins/<name>/`, which is **root-owned**, so the copy needs
`sudo` on the Deck itself. Four things must be there: `plugin.json`, **`package.json`**, `main.py`
and `dist/`.

```sh
# from your dev machine
scp -r plugin.json package.json main.py dist deck@<deck-ip>:~/savelocker-plugin-stage/
# then, on the Deck
sudo cp -r ~/savelocker-plugin-stage /home/deck/homebrew/plugins/SaveLocker
sudo chown -R root:root /home/deck/homebrew/plugins/SaveLocker
sudo systemctl restart plugin_loader
```

**`package.json` is not optional, and leaving it out fails in a way that points at the wrong thing.**
Decky chooses how to load a plugin from it: with `"type": "module"` it uses `import()`
(`ESMODULE_V1`), and without a `package.json` at all it falls back to `LEGACY_EVAL_IIFE`, which
`eval`s the bundle as a classic script. The ESM bundle then dies on its own last line with
`SyntaxError: Unexpected token 'export'` — inside Decky's loader, with no mention of a missing file.
The tell is `version: null` for the plugin in `DeckyPluginLoader.plugins`, since that field also
comes from `package.json`.

## Debugging it

The backend logs to `~/homebrew/logs/SaveLocker/*.log` on the Deck, readable over SSH. The
**frontend** logs nowhere on disk — it runs in Steam's `SharedJSContext`, so errors are only in CEF.
Reach it without touching the Deck's screen:

```sh
ssh -N -L 8080:127.0.0.1:8080 deck@<deck-ip>     # CEF is loopback-only on the Deck
curl -s http://localhost:8080/json               # find the SharedJSContext / QuickAccess targets
```

Then drive CDP over the websocket: `Runtime.evaluate` with `document.body.innerText` on the
QuickAccess target prints whatever the panel is showing, error boundary included.
