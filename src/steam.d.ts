/**
 * The two SteamClient members this plugin uses, declared locally.
 *
 * These are undocumented Valve internals reached through Steam's own JS context — the reason the
 * plugin exists, and the reason it is only ever an accelerator: when Steam changes them the plugin
 * breaks, and SaveLocker's copy-paste path has to still be there. Declaring only what we call keeps
 * that surface visible and small, rather than importing a wide ambient global.
 *
 * Signatures match SteamDeckHomebrew/decky-frontend-lib `globals/steam-client/App.ts`.
 */
interface SaveLockerAppDetails {
  /** Launch options for an installed Steam game. */
  strLaunchOptions?: string
  /** Launch options for a NON-Steam shortcut — the case SaveLocker exists for. */
  strShortcutLaunchOptions?: string
}

interface SaveLockerUnregisterable {
  unregister(): void
}

declare const SteamClient: {
  Apps: {
    SetAppLaunchOptions(appId: number, launchOptions: string): void
    RegisterForAppDetails(
      appId: number,
      callback: (data: SaveLockerAppDetails) => void,
    ): SaveLockerUnregisterable
  }
}
