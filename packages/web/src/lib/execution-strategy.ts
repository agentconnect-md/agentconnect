// The agent's execution strategy in the console (session-executors.md §5): what a placement offers, the picker's rows, and the request that names one.
import type { Agent, DaemonCaps, DaemonRow, StrategyTable } from '@/lib/data'

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

/** The process-level strategy the console calls "Sandbox"; a strategy made default later takes the name, and this one shows its own. */
export const DEFAULT_SANDBOX_STRATEGY = 'srt'

/** The strategies the console names and describes, in the order it lists them; any other slug shows as itself. */
const KNOWN = ['host', 'srt', 'microsandbox', 'docker'] as const
export type KnownStrategy = (typeof KNOWN)[number]

export function isKnownStrategy(value: string): value is KnownStrategy {
  return (KNOWN as readonly string[]).includes(value)
}

/** A strategy's display-name key: `sandbox` for the default one, its own for another known one, none for an unknown slug. */
export function strategyNameKey(
  value: string,
  defaultSandbox: string = DEFAULT_SANDBOX_STRATEGY
): 'sandbox' | KnownStrategy | undefined {
  if (value === defaultSandbox) return 'sandbox'
  return isKnownStrategy(value) ? value : undefined
}

const rank = (slug: string) => (isKnownStrategy(slug) ? KNOWN.indexOf(slug) : KNOWN.length)

/** Strategies weakest boundary first, unknown ones last by slug. */
export function sortStrategies(slugs: readonly string[]): string[] {
  return [...slugs].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

/** What a placement offers the picker; the pool offers nothing, since its boundary is the pod. */
export type PlacementStrategies = { kind: 'pool' } | { kind: 'table'; table: StrategyTable }

/** The table of a daemon that reports none: only the direct child, as the Control Plane reads an unplaced agent. */
export const HOST_ONLY_TABLE: StrategyTable = { [HOST_STRATEGY]: { available: true } }

/** One daemon's offer: its own table, host alone when it reports none. */
export function daemonStrategies(caps: DaemonCaps | undefined): PlacementStrategies {
  return { kind: 'table', table: caps?.strategies ?? HOST_ONLY_TABLE }
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
export function agentStrategies(agent: Pick<Agent, 'strategies'>, pool: boolean): PlacementStrategies {
  return pool ? { kind: 'pool' } : { kind: 'table', table: agent.strategies }
}

/** One picker row; `reason` is the probe's own words, `refusal` a reason the console words itself. */
export interface StrategyOption {
  value: string
  available: boolean
  reason?: string
  refusal?: 'notOffered'
}

/** The picker's rows, weakest boundary first; the current choice stays listed even where the placement no longer offers it. */
export function strategyOptions(placement: PlacementStrategies, current?: string): StrategyOption[] {
  if (placement.kind === 'pool') return []
  const options = tableOptions(placement.table)
  if (current && !options.some((option) => option.value === current)) {
    options.push({ value: current, available: false, refusal: 'notOffered' })
  }
  return options
}

function tableOptions(table: StrategyTable): StrategyOption[] {
  return sortStrategies(Object.keys(table)).map((slug) => {
    const entry = table[slug]!
    return entry.available ? { value: slug, available: true } : { value: slug, available: false, reason: entry.reason }
  })
}

/** A new agent's strategy: `host` where it can run, as the Control Plane defaults, else the first available sandbox. */
export function defaultStrategy(options: readonly StrategyOption[]): string | undefined {
  const available = options.filter((option) => option.available)
  return (available.find((option) => option.value === HOST_STRATEGY) ?? available[0])?.value
}

/** The agent's stored choice as a picker value. */
export function agentStrategyValue(agent: Pick<Agent, 'execution'>): string {
  return agent.execution
}

/** Whether a picker value encloses the runtime in a boundary. */
export function isSandboxStrategy(value: string): boolean {
  return value !== HOST_STRATEGY
}

/** Whether a picker value starts the image's runtime install, so its image-binary warning applies; `host` and `srt` start the host's. */
export function strategyUsesImage(value: string): boolean {
  return value === 'microsandbox'
}

type RuntimeFacts = DaemonRow['runtimeModels'][number]

/** Each runtime as `value` starts it: its entry for that strategy, else an older daemon's host or image reading; a missing one stays listed unless it has no saved login. */
export function strategyRuntimeModels(runtimes: readonly RuntimeFacts[], value: string): RuntimeFacts[] {
  const image = strategyUsesImage(value)
  return runtimes.flatMap((rt) => {
    const entry = rt.strategies?.[value]
    const missing = entry ? !entry.available : image ? !!rt.unavailableReason : rt.hostAvailable === false
    if (missing && rt.credentialsConfigured === false) return []
    return [
      {
        ...rt,
        version: missing ? '' : image ? rt.version : (rt.hostVersion ?? rt.version),
        models: entry ? (entry.models ?? []) : rt.models,
        unavailableReason: !missing
          ? null
          : !image
            ? ('host-binary-missing' as const)
            : entry
              ? ('image-binary-missing' as const)
              : rt.unavailableReason
      }
    ]
  })
}

/** The serving members a group's `value` tab intersects: each whose table can run it, as that strategy starts its runtimes; one with no table keeps its merged list. */
export function strategyMembers<T extends Pick<DaemonRow, 'caps' | 'runtimeModels'>>(
  members: readonly T[],
  value: string
): T[] {
  return members.flatMap((member) => {
    const table = member.caps.strategies
    if (!table) return [member]
    return table[value]?.available
      ? [{ ...member, runtimeModels: strategyRuntimeModels(member.runtimeModels, value) }]
      : []
  })
}

/** A daemon's facts as an agent in `value` picks its models: each runtime's list from its entry for that strategy, else an older daemon's single list; no strategy leaves them as reported. */
export function strategyModelSource<T extends Pick<DaemonRow, 'runtimeModels'>>(
  source: T,
  value: string | undefined
): T {
  if (!value) return source
  return {
    ...source,
    runtimeModels: source.runtimeModels.map((rt) => {
      const entry = rt.strategies?.[value]
      return entry ? { ...rt, models: entry.models ?? [] } : rt
    })
  }
}

/** The request field naming `value`: the slug, or nothing on the pool. */
export function executionAsk(placement: PlacementStrategies, value: string): { execution?: string } {
  return placement.kind === 'pool' ? {} : { execution: value }
}
