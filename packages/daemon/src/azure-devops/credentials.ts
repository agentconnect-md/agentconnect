// Azure DevOps's entry in the credential seam: the fixed host is known, but every member that would serve a credential is A3's.
import { AZURE_DEVOPS_MANAGED_HOST } from '../gitcred/managed-hosts.js'
import { azureDevOpsNotImplemented } from './not-implemented.js'
import type { CodeHostCredentialModule, SecondaryRootPlacement } from '../codehost/credentials.js'
import type { ManagedCredentialScope } from '../workspace/git-injection.js'

export const azureDevOpsCredentials: CodeHostCredentialModule = {
  provider: 'azure-devops',
  displayName: 'Azure DevOps',
  specGitCredential: 'azure-devops',
  hostFromSpec: false,
  managedHost: () => AZURE_DEVOPS_MANAGED_HOST,
  // No path grammar yet, so the helper reads a request to this host as "not ours" and stays silent.
  credentialRepoPath: () => undefined,
  canonicalCloneUrl: (normalized) => normalized,
  managedRemoteUrl: (repository) => repository,
  liveCredentialPurposes: [],
  workspaceRepoId: () => undefined,
  resolvesByName: false,
  // Fail closed per row: core logs the row as unplaceable and skips it.
  placeSecondaryRoot: (): SecondaryRootPlacement | undefined => undefined,
  secondaryCloneUrl: () => azureDevOpsNotImplemented('secondary clone URLs'),
  secondaryCredentialScope: (): ManagedCredentialScope => azureDevOpsNotImplemented('secondary credential scopes')
}
