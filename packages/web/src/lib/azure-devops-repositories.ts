// How the console words an Azure DevOps repository where one is picked or listed (azure-devops-integration.md §5).

import type { AzureDevOpsRepositoryBindingDto, AzureDevOpsRepositoryDto } from './api'

/** The fixed Azure DevOps host; there is no instance axis. */
export const AZURE_DEVOPS_ORIGIN = 'https://dev.azure.com'

/** An organization's page on Azure DevOps. */
export function azureDevOpsOrganizationUrl(organization: string): string {
  return `${AZURE_DEVOPS_ORIGIN}/${encodeURIComponent(organization)}`
}

/** One pickable repository, keyed by GUID; `binding` null means the save that picks it binds it. */
export interface AzureDevOpsRepositoryChoice {
  repositoryId: string
  /** The surrogate numeric id, once the repository was ever bound on this deployment. */
  repoId: string | null
  repoPath: string
  cloneUrl: string
  defaultBranch: string | null
  binding: AzureDevOpsRepositoryBindingDto | null
}

/** What the identity can see, each row with its binding; a bound repository the identity no longer sees stays listed. */
export function mergeAzureDevOpsRepositoryChoices(
  bindings: readonly AzureDevOpsRepositoryBindingDto[],
  visible: readonly AzureDevOpsRepositoryDto[]
): AzureDevOpsRepositoryChoice[] {
  const byRepository = new Map(bindings.map((binding) => [binding.repositoryId.toLowerCase(), binding]))
  const seen = new Set<string>()
  const rows: AzureDevOpsRepositoryChoice[] = visible.map((row) => {
    const binding = byRepository.get(row.repositoryId.toLowerCase()) ?? null
    seen.add(row.repositoryId.toLowerCase())
    return {
      repositoryId: row.repositoryId,
      repoId: binding?.repoId ?? row.repoId,
      repoPath: row.path,
      cloneUrl: row.cloneUrl,
      defaultBranch: row.defaultBranch,
      binding
    }
  })
  const unseen = bindings
    .filter((binding) => !seen.has(binding.repositoryId.toLowerCase()))
    .map((binding) => ({
      repositoryId: binding.repositoryId,
      repoId: binding.repoId,
      repoPath: binding.repoPath,
      cloneUrl: binding.cloneUrl,
      defaultBranch: binding.defaultBranch,
      binding
    }))
  return [...rows, ...unseen]
}

/** Filter by the picker's search box: path substring, case-insensitive. */
export function matchAzureDevOpsRepositories(
  choices: readonly AzureDevOpsRepositoryChoice[],
  query: string
): AzureDevOpsRepositoryChoice[] {
  const wanted = query.trim().toLowerCase()
  return choices.filter((choice) => !wanted || choice.repoPath.toLowerCase().includes(wanted))
}
