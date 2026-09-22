// Placement at session birth (session-executors.md §6, §7). The two consents are already in what the CP answers, so what is left here is the eligibility predicate, the one rule that selects, and the reason a session that stays home records.
import type { ExecutorCandidate, ExecutorCandidatesResult, SessionStayedHomeReason } from '@agentconnect.md/protocol'

/** What the holder knows about a session being born, and nothing wider. */
export interface PlacementAsk {
  /** The session's own `workspaceIsolation`: only a `session`-isolated one can be placed elsewhere (§2). */
  isolation: 'shared' | 'session' | undefined
  /** The agent's ask, the `runInSandbox` boolean of v1: true ⇒ a sandboxing strategy, false ⇒ `host` (§5). */
  runInSandbox: boolean
  /** The runtime this session runs; a candidate that cannot authenticate it is not one (§8). */
  runtime: string
  /** A managed-memory binding the Control Plane's boot-time flip has not reached yet; the predicate has no other memory condition (§7). */
  memoryDaemonHomed?: boolean
}

/** One machine the holder may prepare on, and what to ask it for. */
export interface PlacementChoice {
  daemonId: string
  strategy: string
}

/** The verdict: the candidates to try in order, or why this session stays with its holder. */
export type Placement = { spread: PlacementChoice[] } | { stayedHome: SessionStayedHomeReason }

/** How long the CP must have gone without hearing from an executor before its environment counts as lost (§7, §13). */
export const EXECUTOR_LOSS_GRACE_MS = 10 * 60_000

/** The strategy a candidate offers for this ask: `host` when the agent asked for no sandbox, else the first sandboxing strategy its effective table has (§5). */
export function strategyFor(ask: PlacementAsk, candidate: ExecutorCandidate): string | undefined {
  const available = (name: string): boolean => candidate.strategies[name]?.available === true
  if (!ask.runInSandbox) return available('host') ? 'host' : undefined
  // Sorted rather than table order, so two holders reading the same facts ask for the same thing.
  return Object.keys(candidate.strategies)
    .filter((name) => name !== 'host' && available(name))
    .sort()[0]
}

/** Whether the candidate can authenticate the session's runtime — the `authRequired` its `facts/daemon-runtimes` already reports (§8). */
function authenticates(candidate: ExecutorCandidate, runtime: string): boolean {
  return candidate.runtimes.some((profile) => profile.runtime === runtime && !profile.authRequired)
}

/** As fresh as the last heartbeat and advisory either way; a member that has not reported one yet hosts nothing (§6). */
function load(candidate: ExecutorCandidate): number {
  return candidate.hostedSessions ?? 0
}

/** Why an answer nothing could be placed from was empty; the CP's own reason where it has one. */
function emptyReason(answer: ExecutorCandidatesResult): SessionStayedHomeReason {
  if (answer.reason === 'group_switch_off' || answer.reason === 'not_on_group') return answer.reason
  return 'no_candidate'
}

/**
 * Decide where one session is born.
 *
 * The holder is always its own candidate — it is never in the CP's list — so the rule compares the
 * list against this machine's own load and a tie stays home, which costs no link.
 */
export function placeSession(input: {
  ask: PlacementAsk
  /** What this machine hosts, counted as a candidate's `hostedSessions` is: its own isolated sessions included (§6). */
  holderHostedSessions: number
  /** The CP's answer; undefined ⇒ it could not be asked, and the session stays home. */
  answer?: ExecutorCandidatesResult
}): Placement {
  const { ask, answer } = input
  if (ask.isolation !== 'session') return { stayedHome: 'shared_session' }
  if (ask.memoryDaemonHomed) return { stayedHome: 'memory_daemon_homed' }
  if (!answer) return { stayedHome: 'control_plane_unreachable' }
  const eligible: Array<{ candidate: ExecutorCandidate; choice: PlacementChoice }> = []
  for (const candidate of answer.candidates) {
    const strategy = strategyFor(ask, candidate)
    // No endpoint means nothing to dial, whatever the table says.
    if (!strategy || !candidate.endpoint || !authenticates(candidate, ask.runtime)) continue
    eligible.push({ candidate, choice: { daemonId: candidate.daemonId, strategy } })
  }
  if (eligible.length === 0) return { stayedHome: emptyReason(answer) }
  const ordered = [...eligible].sort(
    (a, b) => load(a.candidate) - load(b.candidate) || (a.choice.daemonId < b.choice.daemonId ? -1 : 1)
  )
  // The hint wins over the rule: a successor attaches to the environment its predecessor left rather than re-placing the work in it (§7).
  const hinted = ordered.findIndex(({ choice }) => choice.daemonId === answer.currentExecutorDaemonId)
  if (hinted >= 0) ordered.unshift(...ordered.splice(hinted, 1))
  else if (input.holderHostedSessions <= load(ordered[0]!.candidate)) return { stayedHome: 'holder_least_loaded' }
  return { spread: ordered.map(({ choice }) => choice) }
}

/** An executor the CP could not relay to: lost only once its record is older than the grace, because a machine that is rebooting comes back with its directories (§7). */
export function executorLost(input: { lastSeenAt: string | null; now: number; graceMs?: number }): boolean {
  // No record at all is not a machine that might return: the CP no longer knows that daemon.
  if (input.lastSeenAt === null) return true
  const seen = Date.parse(input.lastSeenAt)
  if (Number.isNaN(seen)) return false
  return input.now - seen >= (input.graceMs ?? EXECUTOR_LOSS_GRACE_MS)
}
