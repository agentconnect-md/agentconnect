// Azure DevOps's entry in the credential seam (azure-devops-integration.md §4–§6): one fixed host, `organization/project/repository` paths, a surrogate numeric id, and a credential only the proxy and the daemon's own Git present.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AZURE_DEVOPS_HOST, normalizeGitCloneUrl } from '@agentconnect.md/protocol'
import { AZURE_DEVOPS_MANAGED_HOST } from '../gitcred/managed-hosts.js'
import { AZURE_DEVOPS_ORGANIZATION, azureDevOpsName, azureDevOpsRepoFromPath } from '../gitcred/repo-path.js'
import { azureDevOpsSubtreeName } from '../workspace/secondary-layout.js'
import { authorizeWorkspaceGitUrl } from '../workspace/git-origin-policy.js'
import type { CodeHostCredentialModule, SecondaryRootPlacement } from '../codehost/credentials.js'
import type { ManagedCredentialScope } from '../workspace/git-injection.js'

/** One repository as its `repoFullName` names it, decoded. */
export interface AzureDevOpsRepoName {
  organization: string
  project: string
  repository: string
}

/** A `organization/project/repository` label split into its names; undefined for anything else. */
export function azureDevOpsRepoName(repoFullName: string): AzureDevOpsRepoName | undefined {
  const [organization, project, repository, ...rest] = repoFullName.split('/')
  if (rest.length > 0 || !organization || !AZURE_DEVOPS_ORGANIZATION.test(organization)) return undefined
  const named = { project: azureDevOpsName(project), repository: azureDevOpsName(repository) }
  return named.project && named.repository
    ? { organization, project: named.project, repository: named.repository }
    : undefined
}

/** The canonical clone address of one repository: the four-segment form, each name percent-encoded so a space is `%20`. */
export function azureDevOpsCloneUrl(name: AzureDevOpsRepoName): string {
  const { organization, project, repository } = name
  return `https://${AZURE_DEVOPS_HOST}/${organization}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}`
}

/** Every Azure DevOps operation pins the one fixed host. */
const AZURE_DEVOPS_SCOPE: ManagedCredentialScope = { host: AZURE_DEVOPS_MANAGED_HOST }

export const azureDevOpsCredentials: CodeHostCredentialModule = {
  provider: 'azure-devops',
  displayName: 'Azure DevOps',
  specGitCredential: 'azure-devops',
  hostFromSpec: false,
  managedHost: () => AZURE_DEVOPS_MANAGED_HOST,
  credentialRepoPath: azureDevOpsRepoFromPath,
  // The protocol's normalizer already writes every accepted form as the four-segment canonical address.
  canonicalCloneUrl: (normalized) => normalized,
  managedRemoteUrl: (repository) => repository,
  // The hook reply lease follows the hook's lifecycle, which never replicates a spec (§11.5).
  liveCredentialPurposes: ['azure_devops_hook_reply'],
  workspaceRepoId: (workspace) => workspace.azureDevOpsRepoId,
  resolvesByName: false,
  placeSecondaryRoot: (row): SecondaryRootPlacement | undefined => {
    // `repos/_azure-devops/<surrogate id>`: names may hold spaces, and a rename or a move changes them.
    if (!/^[1-9]\d*$/.test(row.repoId) || !azureDevOpsRepoName(row.repoFullName)) return undefined
    return { provider: 'azure-devops', repoFullName: row.repoFullName, subtreeName: azureDevOpsSubtreeName(row.repoId) }
  },
  secondaryCloneUrl: (repoFullName) => {
    const name = azureDevOpsRepoName(repoFullName)
    if (!name) throw new Error(`"${repoFullName}" does not name an Azure DevOps repository`)
    return authorizeWorkspaceGitUrl(normalizeGitCloneUrl(azureDevOpsCloneUrl(name)))
  },
  secondaryCredentialScope: () => AZURE_DEVOPS_SCOPE,
  // §6.1: the token is organization-wide, so only the proxy and the daemon's own Git may present it.
  proxyOnly: true,
  // §6.4: the CLI sends the placeholder as a Basic password, and an empty configuration directory keeps it off any cached sign-in.
  cli: {
    command: 'az',
    extensionDir: (config) => config.azureDevOps?.cliExtensionDir ?? join(homedir(), '.azure', 'cliextensions'),
    env: ({ placeholder, stateDir, extensionDir }) => ({
      AZURE_DEVOPS_EXT_PAT: placeholder,
      AZURE_CONFIG_DIR: stateDir,
      AZURE_EXTENSION_DIR: extensionDir ?? `${stateDir}/cliextensions`,
      AZURE_CORE_COLLECT_TELEMETRY: 'false'
    })
  }
}
