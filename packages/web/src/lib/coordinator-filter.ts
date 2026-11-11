// What the console needs to offer the coordinator filter (auto-session-mode.md §4.7).
import { supportsCoordinatorFilter } from '@agentconnect.md/protocol/decision'
import type { DecisionProviderOption } from '@agentconnect.md/protocol/decision-api'
import type { Agent } from '@/lib/data'
import { useDecisionProviders } from '@/lib/decisions/provider'
import { placementDecisionProviders } from '@/lib/repository-selector'

/** The daemon screens a coordinator's messages (protocol `COORDINATOR_FILTER_V1_FEATURE`). */
export const COORDINATOR_FILTER_FEATURE = 'coordinator-filter-v1'

/** Whether a daemon advertising `features` runs the filter. */
export function coordinatorFilterSupported(features: readonly string[] | undefined): boolean {
  return features?.includes(COORDINATOR_FILTER_FEATURE) === true
}

/** One entry per provider, keeping the models that answer the filter's Boolean question, ready daemons first. */
export function coordinatorFilterProviders(providers: readonly DecisionProviderOption[]): DecisionProviderOption[] {
  const byId = new Map<string, DecisionProviderOption>()
  const ready = [...providers].sort(
    (a, b) => Number(b.readiness.status === 'ready') - Number(a.readiness.status === 'ready')
  )
  for (const option of ready) {
    if (byId.has(option.id)) continue
    const models = option.models.filter((model) =>
      supportsCoordinatorFilter({ providerId: option.id, model: model.id })
    )
    if (models.length) byId.set(option.id, { ...option, models })
  }
  return [...byId.values()]
}

/** The filter's providers where the agent runs, from the Decision editor's catalog. */
export function useCoordinatorFilterProviders(
  agent: Pick<Agent, 'placementKind' | 'setId' | 'daemon'> | undefined
): DecisionProviderOption[] {
  const { providers } = useDecisionProviders()
  return agent ? coordinatorFilterProviders(placementDecisionProviders(providers, agent)) : []
}

/** The filter as the console names it: provider · model, by the catalog's labels where it has them. */
export function coordinatorFilterLabel(
  filter: { providerId: string; model: string },
  providers: readonly Pick<DecisionProviderOption, 'id' | 'name' | 'models'>[]
): string {
  const option = providers.find((one) => one.id === filter.providerId)
  const model = option?.models.find((one) => one.id === filter.model)?.label ?? filter.model
  return `${option?.name ?? filter.providerId} · ${model}`
}
