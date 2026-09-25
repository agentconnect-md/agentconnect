// What the console needs to offer By decision on a repository or installation (multi-repository-workspaces.md decisions 15 and 18).
import { supportsRepositorySelector, type AgentRepositorySelector } from '@agentconnect.md/protocol/decision'
import type { DecisionProviderOption } from '@agentconnect.md/protocol/decision-api'
import { isSetPlacementKind, type Agent } from '@/lib/data'
import { useDecisionProviders } from '@/lib/decisions/provider'

/** Why By decision cannot be chosen now: the most fixable reason no provider is ready where the agent runs, else no selector yet. */
export type RepositoryDecisionBlock = 'credentials' | 'outdated' | 'offline' | 'provider' | 'selector' | null

type PlacedAgent = Pick<Agent, 'placementKind' | 'setId' | 'daemon'>

/** Catalog entries from the daemons that would run the agent: its daemon, or its group's or the pool's members. */
export function placementDecisionProviders(
  providers: readonly DecisionProviderOption[],
  agent: PlacedAgent
): DecisionProviderOption[] {
  return providers.filter((option) =>
    isSetPlacementKind(agent.placementKind)
      ? !!agent.setId && option.memberSetId === agent.setId
      : option.daemonId === agent.daemon
  )
}

/** Only the models that can answer the selector's Choice questions, as the Control Plane accepts them. */
export function repositorySelectorProviders(providers: readonly DecisionProviderOption[]): DecisionProviderOption[] {
  return providers
    .map((option) => ({
      ...option,
      models: option.models.filter((model) => supportsRepositorySelector({ providerId: option.id, model: model.id }))
    }))
    .filter((option) => option.models.length > 0)
}

export function repositoryDecisionBlock(
  providers: readonly DecisionProviderOption[],
  agent: PlacedAgent,
  selector: AgentRepositorySelector | null | undefined
): RepositoryDecisionBlock {
  const placed = repositorySelectorProviders(placementDecisionProviders(providers, agent))
  if (placed.some((option) => option.readiness.status === 'ready')) return selector ? null : 'selector'
  const statuses = new Set(placed.map((option) => option.readiness.status))
  if (statuses.has('missing_credentials')) return 'credentials'
  if (statuses.has('unsupported')) return 'outdated'
  if (statuses.has('daemon_offline')) return 'offline'
  return 'provider'
}

/** The agent's selector-capable providers and whether By decision is available, from the Decision editor's catalog. */
export function useRepositoryDecision(
  agent: PlacedAgent,
  selector: AgentRepositorySelector | null | undefined
): { providers: DecisionProviderOption[]; block: RepositoryDecisionBlock } {
  const { providers } = useDecisionProviders()
  return {
    providers: repositorySelectorProviders(placementDecisionProviders(providers, agent)),
    block: repositoryDecisionBlock(providers, agent, selector)
  }
}
