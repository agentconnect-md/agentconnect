import {
  supportsRepositorySelector,
  type AgentRepositorySelector,
  type DecisionProviderCatalog
} from '@agentconnect.md/protocol'

export const REPOSITORY_SELECTOR_UNSUPPORTED =
  'The repository selector needs a Decision provider and model that answer Choice questions.'

// Why an agent write's repository selector cannot be saved, or null when it can (multi-repository-workspaces.md decision 15).
export function repositorySelectorRefusal(
  selector: AgentRepositorySelector | null | undefined,
  catalog?: DecisionProviderCatalog
): string | null {
  return !selector || supportsRepositorySelector(selector, catalog) ? null : REPOSITORY_SELECTOR_UNSUPPORTED
}
