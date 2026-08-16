import { useEffect, useState } from 'react'
import {
  ButtonItem, ConfirmModal, DropdownItem, Field, Focusable, PanelSection, PanelSectionRow,
  ToggleField, showModal, staticClasses,
} from '@decky/ui'

/**
 * A read-only row the D-pad can actually land on.
 *
 * `Field`'s own `focusable` prop, not a bare `Focusable`: the QAM scrolls by MOVING FOCUS, and a
 * `Focusable` with no handler is not reliably a navigation target — so a block of them is a hole the
 * D-pad skips, and scrolling up into it jumps to the back button instead. Every read-only row in
 * this panel goes through here for that reason.
 */
const ReadOnlyRow = ({ children }: { children: React.ReactNode; key?: string | number }) => (
  <Field focusable={true} bottomSeparator="none" childrenLayout="below"
         childrenContainerWidth="max">
    {children}
  </Field>
)
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

/**
 * `updateAvailable` and `stagedVersion` are different states and only one of them is actionable
 * from here.
 *
 * Available means the server is offering something newer and nothing has been downloaded: taking it
 * needs network, a download, a digest check and a smoke test, any of which can fail and all of which
 * take a while. Staged means the payload is already on this disk, verified against the published
 * SHA-256 and smoke-tested — applying it is a file copy and a restart, which works offline and
 * cannot fail for any of the reasons a download can.
 *
 * The "Install update now" button is offered for `stagedVersion` and never for `updateAvailable`,
 * because on the second it would be promising something it cannot deliver quickly or offline.
 */
interface AgentVersion {
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  stagedVersion: string | null
  /** Why restarting right now would install nothing. The agent's own sentence — show it verbatim. */
  stagedBlockedReason: string | null
}

interface DoctorResult {
  exitCode: number
  output: string
}

interface TrackedGame {
  gameId: string
  name: string
  saveDirectory: string
}

type AgentResult<T> = { ok: true; data: T } | { ok: false; reason: string }

const fetchRows = callable<[], AgentResult<Row[]>>('rows')
const resolveOptions =
  callable<[{ steamAppId: number; current: string }[]], AgentResult<Resolved[]>>('resolve')
const report = callable<[number, boolean, string | null], AgentResult<null>>('report')
const fetchGames = callable<[], AgentResult<TrackedGame[]>>('games')
const runSync = callable<[string, string | null, boolean], AgentResult<DoctorResult>>('sync')
const fetchState = callable<[], AgentResult<AgentState>>('state')
const fetchVersion = callable<[], AgentResult<AgentVersion>>('agent_version')
const dismissWarning = callable<[string], AgentResult<null>>('dismiss_warning')
const runDoctor = callable<[], AgentResult<DoctorResult>>('doctor')
const restartAgent = callable<[], AgentResult<null>>('restart_agent')

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
          <ReadOnlyRow>
            <div style={{ fontSize: '0.85em' }}><b>{w.gameName}</b></div>
            <div style={{ opacity: 0.75 }}>
              open on {w.holderMachine}. Playing here may cause a conflict.
            </div>
          </ReadOnlyRow>
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

/**
 * Read-only status.
 *
 * The whole block is ONE Focusable, and that shape is deliberate. Steam's Quick Access panel scrolls
 * by moving focus, so a run of non-focusable rows between focusable ones is a hole the D-pad cannot
 * land in: scrolling up into it reveals a line, finds nothing to focus, and jumps to the back button
 * — leaving the user toggling up/down to inch through. One focusable block is a single stop that
 * scrolls into view whole. Several focusable lines would fix the jumping too, but would make the
 * user press down five times to get past information they only read.
 */
function Status({ state, version }: { state: AgentState | null; version: AgentVersion | null }) {
  if (!state) return null
  const line = (label: string, value: string) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85em', gap: '8px' }}>
      <span style={{ opacity: 0.7 }}>{label}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  )
  return (
    <PanelSection title="Status">
      <PanelSectionRow>
        <ReadOnlyRow>
          {line('Server', state.connected ? state.machineName : 'not connected')}
          {line('Last sync', state.lastSyncAgo)}
          {line('Games', String(state.gamesTracked))}
          {line('Saves pushed', String(state.savesBacked))}
          {/* Staged and available are not the same thing and must not read the same. "ready" is
              only true of a payload that is already here and verified — the one the Update section
              below can install on the spot. */}
          {version?.stagedVersion
            ? line('Agent', `${version.currentVersion} → ${version.stagedVersion} ready`)
            : version?.updateAvailable
              ? line('Agent', `${version.currentVersion} → ${version.latestVersion} available`)
              : line('Agent', state.currentVersion)}
        </ReadOnlyRow>
      </PanelSectionRow>
    </PanelSection>
  )
}

/**
 * "Install update now" — the only thing on a Deck that can take a waiting update without a terminal.
 *
 * Without this, a staged update says it will be installed "the next time this device starts
 * SaveLocker" and offers nothing. That phrase means the `savelocker.service` systemd `--user` unit
 * starting, which nothing on screen says, so the routes to it are a reboot or a terminal — neither
 * of which is where the notice is being read.
 *
 * **Only ever offered for `stagedVersion`.** A merely-available update needs a network round trip
 * that can fail; this one is a file copy the agent has already verified, so pressing the button is
 * the last step rather than the first.
 *
 * The button destroys the API this panel is talking to. That is not a hazard to work around — it is
 * how the update installs — so `unreachable` during the wait is the expected shape of SUCCESS, and
 * anything that error-toasts on the first failed call reports a working update as a failure.
 */
function StagedUpdate({ version, onSettled }: {
  version: AgentVersion | null
  onSettled: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)

  const staged = version?.stagedVersion ?? null
  const blocked = version?.stagedBlockedReason ?? null

  // Success REMOVES the thing this section is about: the staged marker is gone the moment the swap
  // lands, so `staged` goes null and this would unmount with the result unread. The outcome keeps
  // the section on screen by itself — a press that ends with a row quietly disappearing is
  // indistinguishable from a press that did nothing.
  if (!staged && !outcome) return null

  const install = async () => {
    const before = version?.currentVersion ?? ''
    setBusy(true)
    setOutcome(null)
    try {
      const restarted = await restartAgent()
      if (!restarted.ok) {
        setOutcome({ ok: false, text: describeRestartFailure(restarted.reason) })
        return
      }

      // systemctl returns once the unit is active, but the agent's HTTP listener comes up a moment
      // after that, so the first few polls legitimately fail. Success is not a version string match
      // — the agent prints Major.Minor.Patch and the server's string need not agree on component
      // count — it is the staged marker being GONE, which only happens once the swap ran.
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000))
        const v = await fetchVersion()
        if (!v.ok) continue

        if (v.data.stagedVersion === null) {
          setOutcome(v.data.currentVersion === before
            // Applied, and the agent came back on the version it started on. The updater rolls a
            // version back by itself when it will not start, so this is what that looks like from
            // here — and saying "installed" would be a lie the user finds out about later.
            ? { ok: false, text: `The agent restarted but is still on v${before}. Run doctor.` }
            : { ok: true, text: `Installed. Now running v${v.data.currentVersion}.` })
          return
        }
        // Still staged after a restart means the apply declined, and the agent knows why.
        if (v.data.stagedBlockedReason) {
          setOutcome({ ok: false, text: v.data.stagedBlockedReason })
          return
        }
      }
      setOutcome({ ok: false, text: 'The agent did not come back within two minutes. Run doctor.' })
    } finally {
      setBusy(false)
      onSettled()
    }
  }

  return (
    <PanelSection title="Update">
      {staged && (
        <PanelSectionRow>
          <ReadOnlyRow>
            <div style={{ fontSize: '0.85em' }}>
              <b>v{staged}</b> is downloaded and verified.
            </div>
            <div style={{ opacity: 0.75, fontSize: '0.8em' }}>
              {blocked ?? 'Installing takes a few seconds and restarts the agent. No game is affected.'}
            </div>
          </ReadOnlyRow>
        </PanelSectionRow>
      )}

      {/* Blocked is shown instead of the button, not beside it. Restarting while a game is running
          is harmless and does NOTHING — the agent defers the swap on purpose — and a button whose
          success case is "nothing happened" is worse than no button. The 30 s status poll brings it
          back on its own once the game closes. */}
      {staged && !blocked && (
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={busy} onClick={() => void install()}>
            {busy ? 'Installing…' : `Install v${staged} now`}
          </ButtonItem>
        </PanelSectionRow>
      )}

      {outcome && (
        <PanelSectionRow>
          <ReadOnlyRow>
            <span style={{ fontSize: '0.8em', opacity: outcome.ok ? 0.8 : 1 }}>{outcome.text}</span>
          </ReadOnlyRow>
        </PanelSectionRow>
      )}
    </PanelSection>
  )
}

/**
 * systemctl's failure, in words a Deck owner can act on.
 *
 * The two that matter are named because they are not the same problem: no bus means this plugin's
 * backend has no user session to talk to (and the agent is fine), while a missing unit means the
 * agent was never installed through `install.sh`. Anything else is passed through verbatim rather
 * than flattened into "it failed" — systemctl's own text is the only real diagnostic there is.
 */
function describeRestartFailure(reason: string): string {
  if (reason === 'timeout') return 'The restart did not finish within two minutes. Run doctor.'
  if (reason === 'exec-failed') return 'systemctl is not available on this device.'
  if (reason.includes('connect to bus'))
    return 'Could not reach this user\'s systemd. Restart your device to install the update.'
  if (reason.includes('not found') || reason.includes('not loaded'))
    return 'savelocker.service is not installed, so there is nothing to restart. '
      + 'Restart your device, or run install.sh from Desktop mode.'
  return `Could not restart the agent: ${reason}`
}

/**
 * Push and pull, for one game or all of them.
 *
 * The plain buttons cannot lose data — the agent refuses a pull while the game is running, refuses
 * one that would overwrite un-pushed local changes, and turns a diverged push into a conflict rather
 * than overwriting the server. `--force` defeats the middle two, and is the only way to lose
 * progress from this panel, so it goes through a confirmation that names the game and says what is
 * lost. Deliberately not a toggle: a toggle left on makes the NEXT press destructive too.
 */
const ALL_GAMES = '__all_games__'

/**
 * The sync target, held at MODULE scope rather than in component state.
 *
 * Opening Steam's dropdown tears down and rebuilds the Quick Access panel content, so a selection
 * made in it is destroyed by the very act of making it — the component remounts and every useState
 * goes back to its initial value. Measured on hardware: the render immediately after a selection
 * reports `games = 0`, i.e. the parent's state reset too, not just this component's.
 *
 * Module scope outlives that remount. It resets if the plugin itself is reloaded, which is correct:
 * this is a transient UI choice, not a setting worth persisting.
 */
let stickyTarget: string | null = null

function Sync({ games }: { games: TrackedGame[] }) {
  const [target, setTargetState] = useState<string | null>(stickyTarget) // null = all games
  const setTarget = (value: string | null) => { stickyTarget = value; setTargetState(value) }
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<{ label: string; exitCode: number; output: string } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const targetName = target ?? 'all games'

  const go = async (action: 'push' | 'pull', force: boolean) => {
    const label = `${force ? 'force ' : ''}${action} ${targetName}`
    setBusy(label)
    setProblem(null)
    try {
      const r = await runSync(action, target, force)
      if (r.ok) {
        setResult({ label, exitCode: r.data.exitCode, output: r.data.output })
        // A manual sync is worth announcing even though the result is listed below: it can take a
        // while, and the user may have closed the panel or started a game before it finishes.
        toaster.toast({
          title: 'SaveLocker',
          body: r.data.exitCode === 0 ? `${label} finished` : `${label} failed — see the plugin`,
        })
      } else {
        setResult(null)
        setProblem(r.reason)
      }
    } finally {
      setBusy(null)
    }
  }

  const confirmForce = (action: 'push' | 'pull') => {
    const consequence = action === 'push'
      ? `This replaces the server's copy for ${targetName} with this device's save. Every other machine will pull it.`
      : `This discards this device's save for ${targetName} and takes the server's copy. Unsynced progress here is lost.`
    showModal(
      <ConfirmModal
        bDestructiveWarning
        strTitle={`Force ${action} ${targetName}?`}
        strDescription={consequence}
        strOKButtonText={`Force ${action}`}
        onOK={() => void go(action, true)}
      />,
    )
  }

  return (
    <PanelSection title="Sync">
      <PanelSectionRow>
        <DropdownItem
          label="Target"
          rgOptions={[
            { data: ALL_GAMES, label: 'All games' },
            ...games.map((g) => ({ data: g.name, label: g.name })),
          ]}
          selectedOption={target ?? ALL_GAMES}
          onChange={(o: any) => {
            // Steam's own Dropdown, resolved out of CommonUIModule by shape — its callback contract
            // is not ours to assume, so accept either the option object or a bare value.
            const picked = o && typeof o === 'object' && 'data' in o ? o.data : o
            setTarget(picked === ALL_GAMES || picked == null ? null : String(picked))
          }}
        />
      </PanelSectionRow>

      <PanelSectionRow>
        <ButtonItem layout="below" disabled={busy !== null} onClick={() => void go('push', false)}>
          {busy === `push ${targetName}` ? 'Pushing…' : `Push ${targetName}`}
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" disabled={busy !== null} onClick={() => void go('pull', false)}>
          {busy === `pull ${targetName}` ? 'Pulling…' : `Pull ${targetName}`}
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" disabled={busy !== null} onClick={() => confirmForce('push')}>
          {`Force push ${targetName}…`}
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" disabled={busy !== null} onClick={() => confirmForce('pull')}>
          {`Force pull ${targetName}…`}
        </ButtonItem>
      </PanelSectionRow>

      {problem && (
        <PanelSectionRow>
          <ReadOnlyRow>
            {problem === 'no-agent' ? 'SaveLocker is not installed on this device.'
              : problem === 'timeout' ? 'The sync did not finish within 10 minutes.'
                : `Could not run it (${problem}).`}
          </ReadOnlyRow>
        </PanelSectionRow>
      )}

      {result && (
        <PanelSectionRow>
          <Focusable style={{ display: 'flex', flexDirection: 'column' }}>
            <ReadOnlyRow>
              <span style={{ fontSize: '0.8em', opacity: 0.8 }}>
                {result.label} — {result.exitCode === 0 ? 'ok' : `exit ${result.exitCode}`}
              </span>
            </ReadOnlyRow>
            {/* The agent's own words, not a summary of them: a refusal explains itself ("X is
                running — pull refused"), and paraphrasing that would lose the reason. */}
            {result.output.split('\n').filter((l) => l.trim() !== '').slice(-12).map((l, i) => (
              <ReadOnlyRow key={i}>
                <span style={{ fontSize: '0.72em', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{l}</span>
              </ReadOnlyRow>
            ))}
          </Focusable>
        </PanelSectionRow>
      )}
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
          <ReadOnlyRow>
            {problem === 'no-agent' ? 'SaveLocker is not installed on this device.'
              : problem === 'timeout' ? 'doctor did not finish within 60 seconds.'
                : `Could not run doctor (${problem}).`}
          </ReadOnlyRow>
        </PanelSectionRow>
      )}
      {result && (
        <PanelSectionRow>
          <Focusable style={{ display: 'flex', flexDirection: 'column' }}>
            <ReadOnlyRow>
              <span style={{ fontSize: '0.8em', opacity: 0.75 }}>
                {result.exitCode === 0 ? 'No problems found.' : `Exited ${result.exitCode} — see below.`}
              </span>
            </ReadOnlyRow>
            {/* Every line focusable, or the D-pad cannot reach past the fold and doctor's output is
                far longer than one screen. */}
            {result.output.split('\n').filter((l) => l.trim() !== '').map((l, i) => (
              <ReadOnlyRow key={i}>
                <span style={{ fontSize: '0.72em', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{l}</span>
              </ReadOnlyRow>
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
  const [games, setGames] = useState<TrackedGame[]>([])
  // Which warnings have already been toasted, so a standing warning is announced once rather than
  // every refresh. A panel that toasts the same thing every minute gets uninstalled.
  const [toasted, setToasted] = useState<Set<string>>(new Set())

  const refreshStatus = async () => {
    const [s, v, g] = await Promise.all([fetchState(), fetchVersion(), fetchGames()])
    if (v.ok) setVersion(v.data)
    if (g.ok) setGames(g.data)
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

  const run = async (writeNow: boolean) => {
    setBusy(true)
    try {
      const result = await applyAll(writeNow)
      setOutcomes(result.outcomes)
      setProblem(result.problem)
      // No toast here either. Writes only happen when the user presses the button, and the outcome
      // list is right underneath it — announcing what someone is already looking at is noise. The
      // one thing worth interrupting for is a lease warning, which arrives on a timer while the
      // panel is closed.
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    // The automatic pass NEVER writes. Only the button does, and only with the toggle on.
    void run(false)
    void refreshStatus()
    // Enrollment is rare, so this is a slow safety net rather than a poll. Idempotence on the agent
    // side is what makes re-running it free.
    const timer = setInterval(() => void run(false), 5 * 60 * 1000)
    // Status is cheap and time-sensitive in a way launch options are not: a lease taken on another
    // machine while this panel is open is exactly what the warning is for.
    const statusTimer = setInterval(() => void refreshStatus(), 30 * 1000)
    return () => { clearInterval(timer); clearInterval(statusTimer) }
  }, [])

  return (
    <>
    <LeaseWarnings warnings={state?.leaseWarnings ?? []} onDismiss={(g) => void dismiss(g)} />
    <Status state={state} version={version} />
    <StagedUpdate version={version} onSettled={() => void refreshStatus()} />
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
        <ButtonItem layout="below" disabled={busy} onClick={() => void run(write)}>
          {busy ? 'Checking…' : write ? 'Apply now' : 'Check (no changes)'}
        </ButtonItem>
      </PanelSectionRow>

      {problem === 'no-agent' && (
        <PanelSectionRow><ReadOnlyRow>SaveLocker is not installed on this device.</ReadOnlyRow></PanelSectionRow>
      )}
      {problem === 'unreachable' && (
        <PanelSectionRow><ReadOnlyRow>The SaveLocker agent is not running.</ReadOnlyRow></PanelSectionRow>
      )}
      {problem && problem !== 'no-agent' && problem !== 'unreachable' && (
        <PanelSectionRow><ReadOnlyRow>Could not reach the SaveLocker agent ({problem}).</ReadOnlyRow></PanelSectionRow>
      )}

      {!problem && outcomes.length === 0 && (
        <PanelSectionRow><ReadOnlyRow>No tracked game launches through Steam.</ReadOnlyRow></PanelSectionRow>
      )}

      {outcomes.length > 0 && (
        <PanelSectionRow>
          <ReadOnlyRow>
            <span style={{ fontSize: '0.85em', opacity: 0.8 }}>{summarise(outcomes)}</span>
          </ReadOnlyRow>
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
            <ReadOnlyRow key={o.name}>
              <div style={{ fontSize: '0.8em', width: '100%' }}>
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
              </div>
            </ReadOnlyRow>
          ))}
        </Focusable>
      </PanelSectionRow>
    </PanelSection>
    <Sync games={games} />
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
