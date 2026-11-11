// What the console needs to offer the coordinator filter (auto-session-mode.md §4.7).
import { supportsCoordinatorFilter } from '@agentconnect.md/protocol/decision'
import type { DecisionProviderOption } from '@agentconnect.md/protocol/decision-api'
import type { Agent } from '@/lib/data'
import { useDecisionProviders } from '@/lib/decisions/provider'

/** The daemon screens a coordinator's messages (protocol `COORDINATOR_FILTER_V1_FEATURE`). */
export const COORDINATOR_FILTER_FEATURE = 'coordinator-filter-v1'

/** Whether a daemon advertising `features` runs the filter. */
export function coordinatorFilterSupported(features: readonly string[] | undefined): boolean {
  return features?.includes(COORDINATOR_FILTER_FEATURE) === true
}

/** Where the agent runs or will run: one machine, a group's members, or the managed pool. */
export type CoordinatorFilterPlacement =
  { kind: 'daemon'; daemonId: string } | { kind: 'set'; setId: string } | { kind: 'pool' }

/** An existing agent's placement, as the filter reads its providers. */
export function agentFilterPlacement(
  agent: Pick<Agent, 'placementKind' | 'setId' | 'daemon'> | undefined
): CoordinatorFilterPlacement | undefined {
  if (!agent) return undefined
  if (agent.placementKind === 'pool') return { kind: 'pool' }
  if (agent.placementKind === 'set') return agent.setId ? { kind: 'set', setId: agent.setId } : undefined
  return agent.daemon ? { kind: 'daemon', daemonId: agent.daemon } : undefined
}

// The filter names a provider by its model family where the catalog names the company, as the design does.
const FILTER_PROVIDER_NAMES: Readonly<Record<string, string>> = Object.freeze({ typesafe: 'Jev' })

/** One entry per provider at the placement, keeping the models that answer the filter's Boolean question, ready daemons first. */
export function coordinatorFilterProviders(
  providers: readonly DecisionProviderOption[],
  placement?: CoordinatorFilterPlacement
): DecisionProviderOption[] {
  const placed = placement
    ? providers.filter((option) =>
        placement.kind === 'daemon'
          ? option.daemonId === placement.daemonId
          : placement.kind === 'pool'
            ? option.pool === true
            : option.pool !== true && option.memberSetId === placement.setId
      )
    : providers
  const byId = new Map<string, DecisionProviderOption>()
  const ready = [...placed].sort(
    (a, b) => Number(b.readiness.status === 'ready') - Number(a.readiness.status === 'ready')
  )
  for (const option of ready) {
    if (byId.has(option.id)) continue
    const models = option.models.filter((model) =>
      supportsCoordinatorFilter({ providerId: option.id, model: model.id })
    )
    if (!models.length) continue
    const name = Object.hasOwn(FILTER_PROVIDER_NAMES, option.kind) ? FILTER_PROVIDER_NAMES[option.kind]! : option.name
    byId.set(option.id, { ...option, name, models })
  }
  return [...byId.values()]
}

/** The filter's providers where the agent runs or will run, from the Decision editor's catalog. */
export function useCoordinatorFilterProviders(
  placement: CoordinatorFilterPlacement | undefined
): DecisionProviderOption[] {
  const { providers } = useDecisionProviders()
  return placement ? coordinatorFilterProviders(providers, placement) : []
}

/** The filter as the console names it: its model's label where that already names the provider, else provider · model. */
export function coordinatorFilterLabel(
  filter: { providerId: string; model: string },
  providers: readonly Pick<DecisionProviderOption, 'id' | 'name' | 'models'>[]
): string {
  const option = providers.find((one) => one.id === filter.providerId)
  const model = option?.models.find((one) => one.id === filter.model)?.label ?? filter.model
  const name = option?.name ?? filter.providerId
  return model.toLowerCase().startsWith(name.toLowerCase()) ? model : `${name} · ${model}`
}
