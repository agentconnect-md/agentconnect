// The agent's execution strategy (session-executors.md §5): a choice checked against the tables of where the agent is placed.
import { HOST_STRATEGY, type ExecutorStrategyTable } from '@agentconnect.md/protocol'

/** What one daemon says about where its own sessions can run; absent for a daemon that reports no table. */
export interface DaemonStrategyReport {
  strategies?: ExecutorStrategyTable
}

/** An agent with no placement, or one whose daemons report no table, has only the direct child. */
export const UNPLACED: ExecutorStrategyTable = { [HOST_STRATEGY]: { available: true } }

/** A group offers what at least one serving member offers (§5); a pinned daemon is a group of one. */
export function placementStrategies(members: DaemonStrategyReport[]): ExecutorStrategyTable {
  const reporting = members.flatMap((m) => (m.strategies ? [m.strategies] : []))
  if (reporting.length === 0) return UNPLACED
  const table: ExecutorStrategyTable = {}
  for (const strategies of reporting) {
    for (const [slug, entry] of Object.entries(strategies)) {
      const known = table[slug]
      if (!known || (!known.available && entry.available)) table[slug] = entry
    }
  }
  return table
}

/** The strategy to store, or why the placement cannot run it. */
export type ExecutionChoice = { execution: string } | { refused: string }

/** Resolve an ask against the placement's table; absent ⇒ `host` where it runs, as a new agent defaults, else the first available sandbox. */
export function resolveExecution(table: ExecutorStrategyTable, execution: string | undefined): ExecutionChoice {
  const target = execution ?? defaultStrategy(table)
  if (target === undefined) return { refused: 'no execution strategy is available where this agent is placed' }
  const entry = table[target]
  if (!entry) return { refused: `execution strategy "${target}" is not offered where this agent is placed` }
  if (!entry.available) {
    return { refused: `execution strategy "${target}" is unavailable where this agent is placed: ${entry.reason}` }
  }
  return { execution: target }
}

/** `host` when it can run, else the first available sandbox, else `host` so the refusal names its reason. */
function defaultStrategy(table: ExecutorStrategyTable): string | undefined {
  if (table[HOST_STRATEGY]?.available) return HOST_STRATEGY
  const sandbox = Object.keys(table).find((slug) => slug !== HOST_STRATEGY && table[slug]?.available)
  return sandbox ?? (table[HOST_STRATEGY] ? HOST_STRATEGY : undefined)
}
