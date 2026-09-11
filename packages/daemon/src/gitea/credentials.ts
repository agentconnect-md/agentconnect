// Gitea's entry in the daemon's code-host credential seam (codehost/credentials.ts).
//
// Real where the instance axis is (gitea-integration.md §3, §9): the host comes off the spec, and
// the injected host table names it, so the classifier knows the address exists. Everything that
// would SERVE a credential there is G4's: `gitcred/repo-path.ts` registers no Gitea path grammar
// yet, so the credential helper reads a request to this host as "not ours" and stays silent — git
// falls through to its other helpers exactly as it does today, and no refusal is invented for a
// public clone. The placement members decline per row rather than guessing a subtree name.
import { giteaManagedHost } from '../gitcred/managed-hosts.js'
import { giteaNotImplemented } from './not-implemented.js'
import type { CodeHostCredentialModule, CodeHostSpecHosts, SecondaryRootPlacement } from '../codehost/credentials.js'
import type { ManagedCredentialScope } from '../workspace/git-injection.js'

export const giteaCredentials: CodeHostCredentialModule = {
  provider: 'gitea',
  specGitCredential: 'gitea',
  hostFromSpec: true,
  managedHost: (spec) => giteaManagedHost(spec.giteaHost),
  // G4 registers the `owner/repo` grammar in the leaf both ends of the channel share; until then
  // the helper resolves no repository on this host and therefore asks the daemon for nothing.
  credentialRepoPath: () => undefined,
  // Whether Gitea needs GitLab's `.git` suffix rule is a G4 question about its HTTPS probes; taking
  // an address as given is what an anonymous remote on an unknown host already gets.
  canonicalCloneUrl: (normalized) => normalized,
  managedRemoteUrl: (repository) => repository,
  liveCredentialPurposes: ['gitea_hook_reply', 'gitea_effect'],
  // Fail closed per row: core logs the row as unplaceable and skips it (multi-repository-workspaces.md).
  placeSecondaryRoot: (): SecondaryRootPlacement | undefined => undefined,
  secondaryCloneUrl: () => giteaNotImplemented('secondary clone URLs'),
  secondaryCredentialScope: (_spec: CodeHostSpecHosts): ManagedCredentialScope =>
    giteaNotImplemented('secondary credential scopes')
}
