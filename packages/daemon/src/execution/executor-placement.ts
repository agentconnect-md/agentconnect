// Placement at session birth (session-executors.md §6, §7). The two consents are already in what the CP answers, so what is left here is the eligibility predicate, the one rule that selects, and the reason a session that stays home records.
import type {
  ExecutorCandidate,
  ExecutorCandidatesResult,
  RuntimeStrategyEntry,
  SessionStayedHomeReason
} from '@agentconnect.md/protocol'

/** What the holder knows about a session being born, and nothing wider. */
export interface PlacementAsk {
  /** The session's own `workspaceIsolation`: only a `session`-isolated one can be placed elsewhere (§2). */
  isolation: 'shared' | 'session' | undefined
  /** The agent's strategy slug (§5); a candidate must offer exactly it, never a stronger or weaker boundary. */
  strategy: string
  /** The runtime this session runs; a candidate that cannot authenticate it is not one (§8). */
  runtime: string
  /** The model it runs; a candidate whose catalog for the strategy lacks it is not one (§5). */
  model?: string
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

/** The strategies a holder drives on another machine: every one the facet has a launcher for (§5). */
const SPREADING_STRATEGIES: ReadonlySet<string> = new Set(['host', 'srt', 'microsandbox'])

/** Whether a session of this strategy may be placed on another member at all. */
export function strategySpreads(strategy: string): boolean {
  return SPREADING_STRATEGIES.has(strategy)
}

/** The strategy a candidate offers for this ask: the agent's own, when its effective table has it available (§5). */
export function strategyFor(ask: PlacementAsk, candidate: ExecutorCandidate): string | undefined {
  return candidate.strategies[ask.strategy]?.available === true ? ask.strategy : undefined
}

/** Whether the candidate can authenticate the session's runtime — the `authRequired` its `facts/daemon-runtimes` already reports (§8). */
function authenticates(candidate: ExecutorCandidate, runtime: string): boolean {
  return candidate.runtimes.some((profile) => profile.runtime === runtime && !profile.authRequired)
}

/** Whether one strategy's catalog starts the runtime with this model; a `cached`, empty or absent list is permissive, as the activation check reads it (§5). */
export function catalogOffers(entry: RuntimeStrategyEntry | undefined, model: string | undefined): boolean {
  if (!entry?.available) return false
  // An empty live list is a runtime without a model selector, which names no model to refuse.
  if (model === undefined || !entry.models?.length || entry.modelsSource === 'cached') return true
  return entry.models.includes(model)
}

/** The candidate's catalog for the ask's strategy; a member that reports no entries predates them and is not second-guessed (§5). */
function offers(candidate: ExecutorCandidate, ask: PlacementAsk): boolean {
  const profile = candidate.runtimes.find((entry) => entry.runtime === ask.runtime)
  if (!profile?.strategies) return true
  return catalogOffers(profile.strategies[ask.strategy], ask.model)
}

/** A member the session could land on: its table offers the strategy, it has an endpoint, and it authenticates and starts the runtime and model (§5, §8). */
export function candidateEligible(ask: PlacementAsk, candidate: ExecutorCandidate): boolean {
  // No endpoint means nothing to dial, whatever the table says.
  return (
    strategyFor(ask, candidate) !== undefined &&
    !!candidate.endpoint &&
    authenticates(candidate, ask.runtime) &&
    offers(candidate, ask)
  )
}

/** As fresh as the last heartbeat and advisory either way; a member that has not reported one yet hosts nothing (§6). */
function load(candidate: ExecutorCandidate): number {
  return candidate.hostedSessions ?? 0
}

/** A machine's hosted count against its `limits.maxConcurrentSessions`; one that reports none weighs like the holder. */
interface Fill {
  hosted: number
  capacity: number
}

/** Whether `a` would be less full than `b` with this session on it: `(hosted + 1) / capacity`, cross-multiplied so no ratio is rounded (§6). */
function compareFill(a: Fill, b: Fill): number {
  return (a.hosted + 1) * b.capacity - (b.hosted + 1) * a.capacity
}

/** Why an answer nothing could be placed from was empty; the CP's own reason where it has one. */
function emptyReason(answer: ExecutorCandidatesResult): SessionStayedHomeReason {
  if (answer.reason === 'group_switch_off' || answer.reason === 'not_on_group') return answer.reason
  return 'no_candidate'
}

/** Decide where one session is born: the holder is its own candidate, never in the CP's list, and a tie stays home, which costs no link. */
export function placeSession(input: {
  ask: PlacementAsk
  /** What this machine hosts, counted as a candidate's `hostedSessions` is: its own isolated sessions included (§6). */
  holderHostedSessions: number
  /** This machine's own `limits.maxConcurrentSessions`, the denominator its load is read against. */
  holderCapacity: number
  /** Whether this machine authenticates `ask.runtime`, by the rule the candidates are read with (§8); false ⇒ a home only when nothing else is. */
  holderAuthenticates: boolean
  /** Whether this machine's own catalog for the strategy starts `ask.runtime` and `ask.model` (§5); false ⇒ likewise. */
  holderOffers?: boolean
  /** The CP's answer; undefined ⇒ it could not be asked, and the session stays home. */
  answer?: ExecutorCandidatesResult
  /** A lost executor being replaced (§7): it is no candidate, and the holder cannot take a placed session back, so only the rest are ordered. */
  replacing?: string
}): Placement {
  const { ask, answer, replacing } = input
  if (ask.isolation !== 'session') return { stayedHome: 'shared_session' }
  if (ask.memoryDaemonHomed) return { stayedHome: 'memory_daemon_homed' }
  // A strategy no facet prepares cannot run elsewhere, so no candidate is the honest verdict, whatever the CP would answer.
  if (!strategySpreads(ask.strategy)) return { stayedHome: 'no_candidate' }
  if (!answer) return { stayedHome: 'control_plane_unreachable' }
  const holder: Fill = { hosted: input.holderHostedSessions, capacity: Math.max(0, input.holderCapacity) }
  const eligible: Array<{ fill: Fill; choice: PlacementChoice }> = []
  for (const candidate of answer.candidates) {
    if (candidate.daemonId === replacing || !candidateEligible(ask, candidate)) continue
    eligible.push({
      fill: { hosted: load(candidate), capacity: candidate.capacity ?? holder.capacity },
      choice: { daemonId: candidate.daemonId, strategy: ask.strategy }
    })
  }
  if (eligible.length === 0) return { stayedHome: emptyReason(answer) }
  const hint = replacing === undefined ? answer.currentExecutorDaemonId : undefined
  // A member already at capacity would answer `full`; the hinted one may still hold this session's environment, so it decides.
  const open = eligible.filter(({ fill, choice }) => choice.daemonId === hint || fill.hosted < fill.capacity)
  if (open.length === 0) return { stayedHome: 'candidates_full' }
  const ordered = open.sort((a, b) => compareFill(a.fill, b.fill) || (a.choice.daemonId < b.choice.daemonId ? -1 : 1))
  // The hint wins over the rule: a successor attaches to the environment its predecessor left rather than re-placing the work in it (§7).
  const hinted = ordered.findIndex(({ choice }) => choice.daemonId === hint)
  if (hinted >= 0) ordered.unshift(...ordered.splice(hinted, 1))
  // Credentials never travel: a holder that cannot authenticate or start the runtime is no candidate, so its lighter load keeps nothing (§8).
  else if (
    replacing === undefined &&
    input.holderAuthenticates &&
    input.holderOffers !== false &&
    compareFill(holder, ordered[0]!.fill) <= 0
  ) {
    return { stayedHome: 'holder_least_loaded' }
  }
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
