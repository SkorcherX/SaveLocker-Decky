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

interface LeaseWarning {
  gameName: string
  holderMachine: string
}

interface AgentState {
  connected: boolean
  currentVersion: string
  machineName: string
  serverUrl: string
  gamesTracked: number
  savesBacked: number
  lastSyncAgo: string
  leaseWarnings: LeaseWarning[]
}

interface AgentVersion {
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
}

interface DoctorResult {
  exitCode: number
  output: string
}

type AgentResult<T> = { ok: true; data: T } | { ok: false; reason: string }

const fetchRows = callable<[], AgentResult<Row[]>>('rows')
const resolveOptions =
  callable<[{ steamAppId: number; current: string }[]], AgentResult<Resolved[]>>('resolve')
const report = callable<[number, boolean, string | null], AgentResult<null>>('report')
const fetchState = callable<[], AgentResult<AgentState>>('state')
const fetchVersion = callable<[], AgentResult<AgentVersion>>('agent_version')
const dismissWarning = callable<[string], AgentResult<null>>('dismiss_warning')
const runDoctor = callable<[], AgentResult<DoctorResult>>('doctor')

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

/**
 * "Your other machine has this game checked out."
 *
 * This is the highest-value thing in the panel and the reason the status surface exists at all. The
 * agent records lease warnings durably on disk precisely so they survive to *some* UI, but until now
 * that UI was the agent's web UI or the server console — neither of which anyone is looking at while
 * holding a Deck about to press play. Here it reaches the user at the only moment it can act on.
 */
function LeaseWarnings({ warnings, onDismiss }: {
  warnings: LeaseWarning[]
  onDismiss: (gameName: string) => void
}) {
  if (warnings.length === 0) return null
  return (
    <PanelSection title="Checked out elsewhere">
      {warnings.map((w) => (
        <PanelSectionRow key={w.gameName}>
          <Focusable style={{ padding: '4px 6px', fontSize: '0.85em' }}>
            <div><b>{w.gameName}</b></div>
            <div style={{ opacity: 0.75 }}>
              open on {w.holderMachine}. Playing here may cause a conflict.
            </div>
          </Focusable>
        </PanelSectionRow>
      ))}
      {warnings.map((w) => (
        <PanelSectionRow key={`dismiss-${w.gameName}`}>
          {/* Dismiss clears the notice, not the condition — if the lease is still held the agent
              records it again. That is right: the warning exists to be seen before launching. */}
          <ButtonItem layout="below" onClick={() => onDismiss(w.gameName)}>
            Dismiss {w.gameName}
          </ButtonItem>
        </PanelSectionRow>
      ))}
    </PanelSection>
  )
}

function Status({ state, version }: { state: AgentState | null; version: AgentVersion | null }) {
  if (!state) return null
  const line = (label: string, value: string) => (
    <PanelSectionRow>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85em', gap: '8px' }}>
        <span style={{ opacity: 0.7 }}>{label}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
      </div>
    </PanelSectionRow>
  )
  return (
    <PanelSection title="Status">
      {line('Server', state.connected ? state.machineName : 'not connected')}
      {line('Last sync', state.lastSyncAgo)}
      {line('Games', String(state.gamesTracked))}
      {line('Saves pushed', String(state.savesBacked))}
      {/* The agent already stages its own update and applies it at next start; this is the only
          place on a Deck in Game Mode that says so before the reboot happens. */}
      {version?.updateAvailable
        ? line('Agent', `${version.currentVersion} → ${version.latestVersion} ready`)
        : line('Agent', state.currentVersion)}
    </PanelSection>
  )
}

/**
 * `savelocker doctor`, on demand.
 *
 * Doctor is the only diagnostic a Deck has, and reaching it otherwise means Desktop Mode and a
 * terminal. On-demand only: it makes network calls and takes seconds, so it must never sit on a
 * timer behind a panel the user opened for something else.
 */
function Diagnostics() {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<DoctorResult | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const run = async () => {
    setBusy(true)
    setProblem(null)
    try {
      const r = await runDoctor()
      if (r.ok) setResult(r.data)
      else { setResult(null); setProblem(r.reason) }
    } finally {
      setBusy(false)
    }
  }

  return (
    <PanelSection title="Diagnostics">
      <PanelSectionRow>
        <ButtonItem layout="below" disabled={busy} onClick={() => void run()}>
          {busy ? 'Running doctor…' : 'Run doctor'}
        </ButtonItem>
      </PanelSectionRow>
      {problem && (
        <PanelSectionRow>
          {problem === 'no-agent' ? 'SaveLocker is not installed on this device.'
            : problem === 'timeout' ? 'doctor did not finish within 60 seconds.'
              : `Could not run doctor (${problem}).`}
        </PanelSectionRow>
      )}
      {result && (
        <PanelSectionRow>
          <Focusable style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontSize: '0.8em', opacity: 0.75, marginBottom: '4px' }}>
              {result.exitCode === 0 ? 'No problems found.' : `Exited ${result.exitCode} — see below.`}
            </div>
            {/* Every line focusable, or the D-pad cannot reach past the fold and doctor's output is
                far longer than one screen. */}
            {result.output.split('\n').filter((l) => l.trim() !== '').map((l, i) => (
              <Focusable key={i} style={{ fontSize: '0.72em', whiteSpace: 'pre-wrap', wordBreak: 'break-all', padding: '1px 4px' }}>
                {l}
              </Focusable>
            ))}
          </Focusable>
        </PanelSectionRow>
      )}
    </PanelSection>
  )
}

function Content() {
  const [outcomes, setOutcomes] = useState<Outcome[]>([])
  const [problem, setProblem] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  // Off on every load, deliberately, and not persisted. Writing to Steam's launch options is the
  // only destructive thing here, and it should be an act rather than a setting someone turned on
  // once. Turn it on after a dry run shows the right values.
  const [write, setWrite] = useState(false)
  const [state, setState] = useState<AgentState | null>(null)
  const [version, setVersion] = useState<AgentVersion | null>(null)
  // Which warnings have already been toasted, so a standing warning is announced once rather than
  // every refresh. A panel that toasts the same thing every minute gets uninstalled.
  const [toasted, setToasted] = useState<Set<string>>(new Set())

  const refreshStatus = async () => {
    const [s, v] = await Promise.all([fetchState(), fetchVersion()])
    if (v.ok) setVersion(v.data)
    if (!s.ok) { setState(null); return }
    setState(s.data)

    const fresh = s.data.leaseWarnings.filter((w) => !toasted.has(w.gameName))
    if (fresh.length > 0) {
      for (const w of fresh) {
        toaster.toast({
          title: 'SaveLocker',
          body: `${w.gameName} is checked out on ${w.holderMachine}`,
        })
      }
      setToasted((prev) => new Set([...prev, ...fresh.map((w) => w.gameName)]))
    }
  }

  const dismiss = async (gameName: string) => {
    await dismissWarning(gameName)
    // Forget it here too, or the same warning could never be announced again this session.
    setToasted((prev) => {
      const next = new Set(prev)
      next.delete(gameName)
      return next
    })
    await refreshStatus()
  }

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
    void refreshStatus()
    // Enrollment is rare, so this is a slow safety net rather than a poll. Idempotence on the agent
    // side is what makes re-running it free.
    const timer = setInterval(() => void run(false, false), 5 * 60 * 1000)
    // Status is cheap and time-sensitive in a way launch options are not: a lease taken on another
    // machine while this panel is open is exactly what the warning is for.
    const statusTimer = setInterval(() => void refreshStatus(), 30 * 1000)
    return () => { clearInterval(timer); clearInterval(statusTimer) }
  }, [])

  return (
    <>
    <LeaseWarnings warnings={state?.leaseWarnings ?? []} onDismiss={(g) => void dismiss(g)} />
    <Status state={state} version={version} />
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
    <Diagnostics />
    </>
  )
}

export default definePlugin(() => ({
  name: 'SaveLocker',
  titleView: <div className={staticClasses.Title}>SaveLocker</div>,
  content: <Content />,
  icon: <FaGamepad />,
  onDismount() { /* the interval is owned by Content's effect */ },
}))
