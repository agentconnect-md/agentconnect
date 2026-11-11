import {
  supportsCoordinatorFilter,
  supportsRepositorySelector,
  type AgentCoordinatorFilter,
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

export const COORDINATOR_FILTER_UNSUPPORTED =
  'The coordinator filter needs a Decision provider and model that answer Boolean questions.'

// Why an agent write's coordinator filter cannot be saved, or null when it can (auto-session-mode.md §4.7).
export function coordinatorFilterRefusal(
  filter: AgentCoordinatorFilter | null | undefined,
  catalog?: DecisionProviderCatalog
): string | null {
  return !filter || supportsCoordinatorFilter(filter, catalog) ? null : COORDINATOR_FILTER_UNSUPPORTED
}
