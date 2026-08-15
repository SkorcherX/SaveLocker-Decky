import { useEffect, useState } from 'react'
import { ButtonItem, Focusable, PanelSection, PanelSectionRow, ToggleField, staticClasses } from '@decky/ui'
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
  state: 'written' | 'already-correct' | 'failed' | 'would-write'
  /** Exactly what was read out of Steam. Shown verbatim — it is the evidence, not a summary. */
  current: string
  target: string
  detail?: string
}

/**
 * One pass: read what Steam has, ask the agent what it should be, write only what differs.
 *
 * Writing only on `changed` is the whole safety story. `Row.desired` assumes a game with nothing
 * set; a user running mangohud, setting environment variables or passing per-game arguments has
 * something set, and the resolve round trip is what preserves it.
 */
async function applyAll(write: boolean): Promise<{ outcomes: Outcome[]; problem?: string }> {
  const rows = await fetchRows()
  if (!rows.ok) return { outcomes: [], problem: rows.reason }
  if (rows.data.length === 0) return { outcomes: [] }

  const current = await Promise.all(
    rows.data.map(async (row) => ({
      steamAppId: row.steamAppId,
      current: await currentLaunchOptions(row.steamAppId),
    })),
  )
  const currentByAppId = new Map(current.map((c) => [c.steamAppId, c.current]))

  const resolved = await resolveOptions(current)
  if (!resolved.ok) return { outcomes: [], problem: resolved.reason }

  const byAppId = new Map(resolved.data.map((r) => [r.steamAppId, r]))
  const outcomes: Outcome[] = []

  for (const row of rows.data) {
    const target = byAppId.get(row.steamAppId)
    if (!target) continue
    const was = currentByAppId.get(row.steamAppId) ?? ''
    const base = { name: row.name, current: was, target: target.desired }

    if (!target.changed) {
      outcomes.push({ ...base, state: 'already-correct' })
      // Reported anyway: "already correct" is exactly as much of an answer to "are this game's
      // launch options set?" as having just written them, and doctor should be able to say so.
      // Not in dry run — nothing has been confirmed if nothing was allowed to act.
      if (write) await report(row.steamAppId, true, null)
      continue
    }

    // Dry run stops here, having read everything and changed nothing. This is the mode a first run
    // on real hardware wants: if the field this plugin reads is the wrong one, it sees an empty
    // string, concludes the game has no options, and would clobber a real mangohud line. Better to
    // be shown that in a list than to discover it afterwards.
    if (!write) {
      outcomes.push({ ...base, state: 'would-write' })
      continue
    }

    try {
      SteamClient.Apps.SetAppLaunchOptions(row.steamAppId, target.desired)
      outcomes.push({ ...base, state: 'written' })
      await report(row.steamAppId, true, null)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      outcomes.push({ ...base, state: 'failed', detail })
      await report(row.steamAppId, false, detail)
    }
  }

  return { outcomes }
}

const shortState = (o: Outcome) =>
  o.state === 'written' ? 'set'
    : o.state === 'already-correct' ? 'ok'
      : o.state === 'would-write' ? 'would change'
        : 'failed'

/** One line the user can read at a glance, so the list below is detail rather than the answer. */
function summarise(outcomes: Outcome[]): string {
  const n = (s: Outcome['state']) => outcomes.filter((o) => o.state === s).length
  const parts = [`${outcomes.length} game${outcomes.length === 1 ? '' : 's'}`]
  if (n('already-correct')) parts.push(`${n('already-correct')} already set`)
  if (n('would-write')) parts.push(`${n('would-write')} would change`)
  if (n('written')) parts.push(`${n('written')} set`)
  if (n('failed')) parts.push(`${n('failed')} failed`)
  return parts.join(' · ')
}

function Content() {
  const [outcomes, setOutcomes] = useState<Outcome[]>([])
  const [problem, setProblem] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  // Off on every load, deliberately, and not persisted. Writing to Steam's launch options is the
  // only destructive thing here, and it should be an act rather than a setting someone turned on
  // once. Turn it on after a dry run shows the right values.
  const [write, setWrite] = useState(false)

  const run = async (announce: boolean, writeNow: boolean) => {
    setBusy(true)
    try {
      const result = await applyAll(writeNow)
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
    // The automatic pass NEVER writes. Only the button does, and only with the toggle on.
    void run(false, false)
    // Enrollment is rare, so this is a slow safety net rather than a poll. Idempotence on the agent
    // side is what makes re-running it free.
    const timer = setInterval(() => void run(false, false), 5 * 60 * 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    <PanelSection title="Launch options">
      <PanelSectionRow>
        <ToggleField
          label="Allow writing to Steam"
          description="Off: read and show what would change. On: actually set launch options."
          checked={write}
          onChange={setWrite}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" disabled={busy} onClick={() => void run(true, write)}>
          {busy ? 'Checking…' : write ? 'Apply now' : 'Check (no changes)'}
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

      {outcomes.length > 0 && (
        <PanelSectionRow>
          <div style={{ fontSize: '0.85em', opacity: 0.8 }}>{summarise(outcomes)}</div>
        </PanelSectionRow>
      )}

      {/* Every row is Focusable, and that is load-bearing rather than decorative: Steam's Quick
          Access panel only scrolls to things the D-pad can reach, so a list of plain <div>s is
          simply unreachable past the fold — with four games it already overflowed with no way to
          scroll. Focusable rows also give each game a selection ring, which is how a gamepad user
          reads a list at all.

          Only rows that need attention print their strings. A run where everything is already
          correct is the common case and should be four short lines, not four paragraphs. */}
      <PanelSectionRow>
        <Focusable style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {outcomes.map((o) => (
            <Focusable
              key={o.name}
              style={{ padding: '4px 6px', borderRadius: '4px', fontSize: '0.8em' }}
              focusWithinClassName="gpfocuswithin"
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '6px' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {o.name}
                </span>
                <span style={{ flexShrink: 0, opacity: 0.75 }}>{shortState(o)}</span>
              </div>

              {/* The current value is the whole diagnostic on a first run: a game known to carry
                  mangohud that reads back "(empty)" proves the wrong field is being read, and that
                  it must not be allowed to write. */}
              {o.state !== 'already-correct' && (
                <div style={{ opacity: 0.7, wordBreak: 'break-all', marginTop: '2px' }}>
                  <div>now: {o.current === '' ? '(empty)' : o.current}</div>
                  <div>target: {o.target}</div>
                  {o.detail && <div>error: {o.detail}</div>}
                </div>
              )}
            </Focusable>
          ))}
        </Focusable>
      </PanelSectionRow>
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
