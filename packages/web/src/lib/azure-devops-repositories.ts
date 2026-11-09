// How the console words an Azure DevOps repository where one is picked or listed (azure-devops-integration.md §5).

import type { AzureDevOpsRepositoryBindingDto, AzureDevOpsRepositoryDto } from './api'

/** The fixed Azure DevOps host; there is no instance axis. */
export const AZURE_DEVOPS_ORIGIN = 'https://dev.azure.com'

/** An organization's page on Azure DevOps. */
export function azureDevOpsOrganizationUrl(organization: string): string {
  return `${AZURE_DEVOPS_ORIGIN}/${encodeURIComponent(organization)}`
}

/** `{organization}/{project}/{repository}` split into its three segments, or null for any other shape. */
function repositorySegments(repoPath: string): [string, string, string] | null {
  const parts = repoPath.split('/')
  return parts.length === 3 && parts.every((part) => part !== '') ? (parts as [string, string, string]) : null
}

/** A repository's page on Azure DevOps, from its `{organization}/{project}/{repository}` path; null for any other shape. */
export function azureDevOpsRepositoryUrl(repoPath: string): string | null {
  const segments = repositorySegments(repoPath)
  if (!segments) return null
  const [organization, project, repository] = segments.map(encodeURIComponent)
  return `${AZURE_DEVOPS_ORIGIN}/${organization}/${project}/_git/${repository}`
}

/** A pull request's page (azure-devops-integration.md §11.8). */
export function azureDevOpsPullRequestUrl(repoPath: string, pullRequestId: number): string | null {
  const repository = azureDevOpsRepositoryUrl(repoPath)
  return repository ? `${repository}/pullrequest/${pullRequestId}` : null
}

/** How a pull request is named to people: `{organization}/{project}/{repository}!{id}` (§11.8). */
export function azureDevOpsPullRequestLabel(repoPath: string, pullRequestId: number): string {
  return `${repoPath}!${pullRequestId}`
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

// Enrich authorized choices with binding metadata; an existing binding never restores an excluded repository.
export function mergeAzureDevOpsRepositoryChoices(
  bindings: readonly AzureDevOpsRepositoryBindingDto[],
  visible: readonly AzureDevOpsRepositoryDto[]
): AzureDevOpsRepositoryChoice[] {
  const byRepository = new Map(bindings.map((binding) => [binding.repositoryId.toLowerCase(), binding]))
  return visible.map((row) => {
    const binding = byRepository.get(row.repositoryId.toLowerCase()) ?? null
    return {
      repositoryId: row.repositoryId,
      repoId: binding?.repoId ?? row.repoId,
      repoPath: row.path,
      cloneUrl: row.cloneUrl,
      defaultBranch: row.defaultBranch,
      binding
    }
  })
}

/** Filter by the picker's search box: path substring, case-insensitive. */
export function matchAzureDevOpsRepositories(
  choices: readonly AzureDevOpsRepositoryChoice[],
  query: string
): AzureDevOpsRepositoryChoice[] {
  const wanted = query.trim().toLowerCase()
  return choices.filter((choice) => !wanted || choice.repoPath.toLowerCase().includes(wanted))
}
