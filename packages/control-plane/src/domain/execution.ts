// The agent's execution strategy (session-executors.md §5): the one-time migration of `runInSandbox`, and a choice checked against the tables of where the agent is placed.
import { HOST_STRATEGY, type ExecutorStrategyTable } from '@agentconnect.md/protocol'

/** What one daemon says about where its own sessions can run; `legacy` is read only when it reports no table. */
export interface DaemonStrategyReport {
  strategies?: ExecutorStrategyTable
  sandboxBackend?: string
  legacy: { supported: boolean; required: boolean }
}

/** What a placement offers: its members' tables merged, or the legacy sandbox policy of a daemon that reports none. */
export type PlacementStrategies =
  | { kind: 'table'; table: ExecutorStrategyTable; backend?: string }
  | { kind: 'legacy'; supported: boolean; required: boolean; backend?: string }

/** An agent with no placement has only the direct child, as a daemon without a sandbox. */
export const UNPLACED: PlacementStrategies = { kind: 'legacy', supported: false, required: false }

/** A group offers what at least one serving member offers (§5); a pinned daemon is a group of one, and the first member speaks for a group that reports no table. */
export function placementStrategies(members: DaemonStrategyReport[]): PlacementStrategies {
  const backend = members.find((m) => m.sandboxBackend !== undefined)?.sandboxBackend
  const reporting = members.flatMap((m) => (m.strategies ? [m.strategies] : []))
  if (reporting.length === 0) {
    const first = members[0]
    return first ? { kind: 'legacy', ...first.legacy, ...(backend ? { backend } : {}) } : UNPLACED
  }
  const table: ExecutorStrategyTable = {}
  for (const strategies of reporting) {
    for (const [slug, entry] of Object.entries(strategies)) {
      const known = table[slug]
      if (!known || (!known.available && entry.available)) table[slug] = entry
    }
  }
  return { kind: 'table', table, ...(backend ? { backend } : {}) }
}

/** The one-time migration (§5): `host`, else the backend the daemon reported, `srt` unless it is `microsandbox`. */
export function migratedExecution(runInSandbox: boolean, backend: string | undefined): string {
  if (!runInSandbox) return HOST_STRATEGY
  return backend === 'microsandbox' ? 'microsandbox' : 'srt'
}

/** A request's ask: a strategy, the legacy boolean, or neither (a create's default). */
export interface ExecutionAsk {
  execution?: string
  runInSandbox?: boolean
}

/** The pair to store, or why the placement cannot run it; `execution` is null only while a legacy daemon's backend is unknown. */
export type ExecutionChoice = { execution: string | null; runInSandbox: boolean } | { refused: string }

/** Resolve an ask against the placement, in place of the two sandbox conflicts; `current` is the stored strategy of an agent being edited. */
export function resolveExecution(
  placement: PlacementStrategies,
  ask: ExecutionAsk,
  current?: string | null
): ExecutionChoice {
  if (placement.kind === 'legacy') return resolveLegacy(placement, ask, current)
  const { table } = placement
  const defaultsToHost =
    ask.runInSandbox === false || (ask.runInSandbox === undefined && table[HOST_STRATEGY]?.available)
  const target = ask.execution ?? (defaultsToHost ? HOST_STRATEGY : sandboxOf(table, placement.backend, current))
  if (target === undefined) return { refused: 'no sandboxing strategy is offered where this agent is placed' }
  const entry = table[target]
  if (!entry) return { refused: `execution strategy "${target}" is not offered where this agent is placed` }
  if (!entry.available) {
    return { refused: `execution strategy "${target}" is unavailable where this agent is placed: ${entry.reason}` }
  }
  return { execution: target, runInSandbox: target !== HOST_STRATEGY }
}

/** The legacy boolean on a daemon that reports no table: today's two checks, and a strategy only once the backend is known. */
function resolveLegacy(
  placement: Extract<PlacementStrategies, { kind: 'legacy' }>,
  ask: ExecutionAsk,
  current: string | null | undefined
): ExecutionChoice {
  const sandboxed =
    ask.execution !== undefined ? ask.execution !== HOST_STRATEGY : (ask.runInSandbox ?? placement.required)
  if (placement.required && !sandboxed) {
    return {
      refused: `execution strategy "${HOST_STRATEGY}" is unavailable where this agent is placed: its daemon requires a sandbox`
    }
  }
  if (!placement.supported && sandboxed) return { refused: 'no sandbox is available where this agent is placed' }
  if (ask.execution !== undefined) return { execution: ask.execution, runInSandbox: sandboxed }
  if (!sandboxed) return { execution: HOST_STRATEGY, runInSandbox: false }
  if (current && current !== HOST_STRATEGY) return { execution: current, runInSandbox: true }
  return { execution: placement.backend ? migratedExecution(true, placement.backend) : null, runInSandbox: true }
}

/** The sandboxing strategy the legacy `runInSandbox: true` means here: the agent's own, the daemon's backend, then any available one. */
function sandboxOf(table: ExecutorStrategyTable, backend: string | undefined, current: string | null | undefined) {
  if (current && current !== HOST_STRATEGY) return current
  const sandboxes = Object.keys(table).filter((slug) => slug !== HOST_STRATEGY)
  const preferred = backend && table[backend] ? [backend, ...sandboxes.filter((slug) => slug !== backend)] : sandboxes
  return preferred.find((slug) => table[slug]?.available) ?? preferred[0]
}
