import { useEffect, useState } from 'react'
import { ButtonItem, PanelSection, PanelSectionRow, staticClasses } from '@decky/ui'
import { callable, definePlugin, toaster } from '@decky/api'
import { FaGamepad } from 'react-icons/fa'

/**
 * SaveLocker's Decky plugin.
 *
 * It sets the Steam launch options SaveLocker needs, which the agent cannot do itself: Steam holds
 * localconfig.vdf / shortcuts.vdf in memory and rewrites them on exit, so an agent-side edit is
 * discarded. This runs inside Steam's own JS context, so `SteamClient.Apps.SetAppLaunchOptions`
 * persists through Steam's normal path.
 *
 * It deliberately knows NOTHING about what a launch option should look like. It reads current
 * values out of Steam, asks the agent to merge them, and writes back what it is told. The rule
 * lives in the agent (`LaunchOptions.cs`), where it is tested without Steam or hardware, so the
 * command can change without a plugin release.
 */

interface Row {
  steamAppId: number
  gameId: string
  name: string
  desired: string
  appliedAt: string | null
  error: string | null
}

interface Resolved {
  steamAppId: number
  desired: string
  changed: boolean
}

type AgentResult<T> = { ok: true; data: T } | { ok: false; reason: string }

const fetchRows = callable<[], AgentResult<Row[]>>('rows')
const resolveOptions =
  callable<[{ steamAppId: number; current: string }[]], AgentResult<Resolved[]>>('resolve')
const report = callable<[number, boolean, string | null], AgentResult<null>>('report')

/**
 * A game's launch options as Steam holds them right now.
 *
 * `RegisterForAppDetails` is a subscription, not a getter, so this takes the first callback and
 * unregisters. The timeout matters: an AppID Steam does not know never calls back at all, and
 * without it the whole sweep would hang on one stale shortcut.
 *
 * A non-Steam shortcut keeps its options in `strShortcutLaunchOptions` while an installed Steam
 * game uses `strLaunchOptions`, and the first is the case SaveLocker exists for — so take whichever
 * is set rather than guessing which kind of app this is.
 */
function currentLaunchOptions(appId: number): Promise<string> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: string) => {
      if (settled) return
      settled = true
      try { registration?.unregister() } catch { /* already gone */ }
      resolve(value)
    }

    const registration = SteamClient.Apps.RegisterForAppDetails(appId, (details: any) => {
      finish(details?.strShortcutLaunchOptions || details?.strLaunchOptions || '')
    })

    setTimeout(() => finish(''), 4000)
  })
}

interface Outcome {
  name: string
  state: 'written' | 'already-correct' | 'failed'
  detail?: string
}

/**
 * One pass: read what Steam has, ask the agent what it should be, write only what differs.
 *
 * Writing only on `changed` is the whole safety story. `Row.desired` assumes a game with nothing
 * set; a user running mangohud, setting environment variables or passing per-game arguments has
 * something set, and the resolve round trip is what preserves it.
 */
async function applyAll(): Promise<{ outcomes: Outcome[]; problem?: string }> {
  const rows = await fetchRows()
  if (!rows.ok) return { outcomes: [], problem: rows.reason }
  if (rows.data.length === 0) return { outcomes: [] }

  const current = await Promise.all(
    rows.data.map(async (row) => ({
      steamAppId: row.steamAppId,
      current: await currentLaunchOptions(row.steamAppId),
    })),
  )

  const resolved = await resolveOptions(current)
  if (!resolved.ok) return { outcomes: [], problem: resolved.reason }

  const byAppId = new Map(resolved.data.map((r) => [r.steamAppId, r]))
  const outcomes: Outcome[] = []

  for (const row of rows.data) {
    const target = byAppId.get(row.steamAppId)
    if (!target) continue

    if (!target.changed) {
      outcomes.push({ name: row.name, state: 'already-correct' })
      // Reported anyway: "already correct" is exactly as much of an answer to "are this game's
      // launch options set?" as having just written them, and doctor should be able to say so.
      await report(row.steamAppId, true, null)
      continue
    }

    try {
      SteamClient.Apps.SetAppLaunchOptions(row.steamAppId, target.desired)
      outcomes.push({ name: row.name, state: 'written' })
      await report(row.steamAppId, true, null)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      outcomes.push({ name: row.name, state: 'failed', detail })
      await report(row.steamAppId, false, detail)
    }
  }

  return { outcomes }
}

function Content() {
  const [outcomes, setOutcomes] = useState<Outcome[]>([])
  const [problem, setProblem] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  const run = async (announce: boolean) => {
    setBusy(true)
    try {
      const result = await applyAll()
      setOutcomes(result.outcomes)
      setProblem(result.problem)
      const written = result.outcomes.filter((o) => o.state === 'written').length
      // Only ever toast for a change the user did not ask for. A sweep that found nothing to do is
      // the normal case and must stay silent, or this becomes something people uninstall.
      if (written > 0) {
        toaster.toast({
          title: 'SaveLocker',
          body: `Launch options set for ${written} game${written === 1 ? '' : 's'}`,
        })
      } else if (announce && !result.problem) {
        toaster.toast({ title: 'SaveLocker', body: 'Launch options already correct' })
      }
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void run(false)
    // Enrollment is rare, so this is a slow safety net rather than a poll. Idempotence on the agent
    // side is what makes re-running it free.
    const timer = setInterval(() => void run(false), 5 * 60 * 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    <PanelSection title="Launch options">
      <PanelSectionRow>
        <ButtonItem layout="below" disabled={busy} onClick={() => void run(true)}>
          {busy ? 'Checking…' : 'Apply now'}
        </ButtonItem>
      </PanelSectionRow>

      {problem === 'no-agent' && (
        <PanelSectionRow>SaveLocker is not installed on this device.</PanelSectionRow>
      )}
      {problem === 'unreachable' && (
        <PanelSectionRow>The SaveLocker agent is not running.</PanelSectionRow>
      )}
      {problem && problem !== 'no-agent' && problem !== 'unreachable' && (
        <PanelSectionRow>Could not reach the SaveLocker agent ({problem}).</PanelSectionRow>
      )}

      {!problem && outcomes.length === 0 && (
        <PanelSectionRow>No tracked game launches through Steam.</PanelSectionRow>
      )}

      {/* Everything it did, always visible. A plugin that edits Steam settings without showing
          what it changed is one nobody should trust. */}
      {outcomes.map((o) => (
        <PanelSectionRow key={o.name}>
          {o.name}: {o.state === 'written' ? 'set' : o.state === 'already-correct' ? 'already set' : `failed — ${o.detail}`}
        </PanelSectionRow>
      ))}
    </PanelSection>
  )
}

export default definePlugin(() => ({
  name: 'SaveLocker',
  titleView: <div className={staticClasses.Title}>SaveLocker</div>,
  content: <Content />,
  icon: <FaGamepad />,
  onDismount() { /* the interval is owned by Content's effect */ },
}))
