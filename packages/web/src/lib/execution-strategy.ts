// The agent's execution strategy in the console (session-executors.md §5): what a placement offers, the picker's rows, and the request that names one.
import type { Agent, DaemonCaps, StrategyTable } from '@/lib/data'

/** The unsandboxed strategy, protocol's `HOST_STRATEGY`; the console value-imports no protocol module that is not a leaf. */
export const HOST_STRATEGY = 'host'

/** What encloses a session under a strategy. */
export type StrategyBoundary = 'none' | 'process' | 'vm' | 'container'

const BOUNDARIES: Record<string, StrategyBoundary> = {
  host: 'none',
  srt: 'process',
  microsandbox: 'vm',
  docker: 'container'
}

/** A slug the console does not know yet has no boundary to show. */
export function strategyBoundary(slug: string): StrategyBoundary | undefined {
  return BOUNDARIES[slug]
}

/** A daemon that predates the table has "a sandbox" of unknown kind; this value is never a slug, so it is sent as `runInSandbox`. */
export const LEGACY_SANDBOX = ':sandbox'

/** The sandbox fields of a placement that reports no table. */
export interface LegacySandbox {
  supported: boolean
  required: boolean
  unavailable?: string | null
}

/** What a placement offers the picker; the pool offers nothing, since its boundary is the pod. */
export type PlacementStrategies =
  { kind: 'pool' } | { kind: 'table'; table: StrategyTable } | { kind: 'legacy'; sandbox: LegacySandbox }

/** No placement: only the direct child, as the Control Plane reads an unplaced agent. */
const UNPLACED: PlacementStrategies = { kind: 'legacy', sandbox: { supported: false, required: false } }

/** One daemon's offer: its own table, or its sandbox features when it predates the table. */
export function daemonStrategies(caps: DaemonCaps | undefined): PlacementStrategies {
  if (!caps) return UNPLACED
  if (caps.strategies) return { kind: 'table', table: caps.strategies }
  const required = caps.features.includes('sandbox-required')
  const supported = required || caps.features.includes('sandbox')
  return { kind: 'legacy', sandbox: { supported, required, unavailable: caps.sandboxUnavailable ?? null } }
}

/** A group's offer, the rule the Control Plane validates (`placementStrategies`): what one serving member offers, available when any can run it, else the first reason. */
export function groupStrategies(members: readonly DaemonCaps[]): PlacementStrategies {
  const tables = members.flatMap((caps) => (caps.strategies ? [caps.strategies] : []))
  // The first member speaks for a group none of whose members reports a table.
  if (tables.length === 0) return daemonStrategies(members[0])
  const table: StrategyTable = {}
  for (const strategies of tables) {
    for (const [slug, entry] of Object.entries(strategies)) {
      const known = table[slug]
      if (!known || (!known.available && entry.available)) table[slug] = entry
    }
  }
  return { kind: 'table', table }
}

/** An agent's current placement as the Control Plane projected it. */
export function agentStrategies(
  agent: Pick<Agent, 'strategies' | 'sandboxSupported' | 'sandboxRequired' | 'sandboxUnavailable'>,
  pool: boolean
): PlacementStrategies {
  if (pool) return { kind: 'pool' }
  if (agent.strategies) return { kind: 'table', table: agent.strategies }
  return {
    kind: 'legacy',
    sandbox: {
      supported: agent.sandboxSupported,
      required: agent.sandboxRequired,
      unavailable: agent.sandboxUnavailable ?? null
    }
  }
}

/** One picker row; `reason` is the probe's own words, `refusal` a reason the console words itself. */
export interface StrategyOption {
  value: string
  available: boolean
  reason?: string
  refusal?: 'sandboxRequired' | 'notOffered'
}

const ORDER = ['host', 'srt', 'microsandbox', 'docker']
const rank = (slug: string) => (ORDER.includes(slug) ? ORDER.indexOf(slug) : ORDER.length)

/** The picker's rows, weakest boundary first; the current choice stays listed even where the placement no longer offers it. */
export function strategyOptions(placement: PlacementStrategies, current?: string): StrategyOption[] {
  if (placement.kind === 'pool') return []
  const options = placement.kind === 'table' ? tableOptions(placement.table) : legacyOptions(placement.sandbox)
  if (current && !options.some((option) => option.value === current)) {
    options.push({ value: current, available: false, refusal: 'notOffered' })
  }
  return options
}

function tableOptions(table: StrategyTable): StrategyOption[] {
  return Object.keys(table)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((slug) => {
      const entry = table[slug]!
      return entry.available
        ? { value: slug, available: true }
        : { value: slug, available: false, reason: entry.reason }
    })
}

function legacyOptions(sandbox: LegacySandbox): StrategyOption[] {
  const host: StrategyOption = sandbox.required
    ? { value: HOST_STRATEGY, available: false, refusal: 'sandboxRequired' }
    : { value: HOST_STRATEGY, available: true }
  if (!sandbox.supported) return [host]
  const reason = sandbox.unavailable
  return [
    host,
    reason ? { value: LEGACY_SANDBOX, available: false, reason } : { value: LEGACY_SANDBOX, available: true }
  ]
}

/** A new agent's strategy: `host` where it can run, as the Control Plane defaults, else the first available sandbox. */
export function defaultStrategy(options: readonly StrategyOption[]): string | undefined {
  const available = options.filter((option) => option.available)
  return (available.find((option) => option.value === HOST_STRATEGY) ?? available[0])?.value
}

/** The agent's stored choice as a picker value: its strategy, or the legacy sandbox while its backend is unreported. */
export function agentStrategyValue(agent: Pick<Agent, 'execution' | 'runInSandbox'>): string {
  return agent.execution ?? (agent.runInSandbox ? LEGACY_SANDBOX : HOST_STRATEGY)
}

/** Whether a picker value encloses the runtime in a boundary. */
export function isSandboxStrategy(value: string): boolean {
  return value !== HOST_STRATEGY
}

/** Whether a picker value starts the image's runtime install, so its image-binary warning applies; `host` and `srt` start the host's. */
export function strategyUsesImage(value: string): boolean {
  return value === 'microsandbox' || value === LEGACY_SANDBOX
}

/** The request field naming `value`: the slug where the placement reports a table, the legacy boolean where it does not, nothing on the pool. */
export function executionAsk(
  placement: PlacementStrategies,
  value: string
): { execution?: string; runInSandbox?: boolean } {
  if (placement.kind === 'pool') return {}
  if (placement.kind === 'legacy' || value === LEGACY_SANDBOX) return { runInSandbox: isSandboxStrategy(value) }
  return { execution: value }
}
