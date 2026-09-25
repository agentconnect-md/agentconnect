// What the console needs to offer By decision on a repository or installation (multi-repository-workspaces.md decisions 15 and 18).
import { supportsRepositorySelector, type AgentRepositorySelector } from '@agentconnect.md/protocol/decision'
import type { DecisionProviderOption } from '@agentconnect.md/protocol/decision-api'
import { isSetPlacementKind, type Agent } from '@/lib/data'
import { useDecisionProviders } from '@/lib/decisions/provider'

/** Why By decision cannot be chosen now: no ready provider where the agent runs, or no selector yet. */
export type RepositoryDecisionBlock = 'provider' | 'selector' | null

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
  const ready = repositorySelectorProviders(placementDecisionProviders(providers, agent)).some(
    (option) => option.readiness.status === 'ready'
  )
  if (!ready) return 'provider'
  return selector ? null : 'selector'
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
