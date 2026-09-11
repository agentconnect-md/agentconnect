// Gitea's entry in the daemon's code-host credential seam (codehost/credentials.ts): the one instance
// the spec names (gitea-integration.md §3, §9), `owner/repo` addresses measured from that instance's
// root, and per-repository grants the CP resolves live. One bot token serves the helper and both
// effect leases (§4.2), so there is no helper/broker token split to keep apart here.
import { normalizeGitCloneUrl } from '@agentconnect.md/protocol'
import { giteaManagedHost } from '../gitcred/managed-hosts.js'
import { repoFromPath } from '../gitcred/repo-path.js'
import { giteaSubtreeName, isRepoSegment } from '../workspace/secondary-layout.js'
import { authorizeWorkspaceGitUrl } from '../workspace/git-origin-policy.js'
import type { CodeHostCredentialModule, CodeHostSpecHosts, SecondaryRootPlacement } from '../codehost/credentials.js'
import type { ManagedCredentialScope } from '../workspace/git-injection.js'

export const giteaCredentials: CodeHostCredentialModule = {
  provider: 'gitea',
  specGitCredential: 'gitea',
  hostFromSpec: true,
  managedHost: (spec) => giteaManagedHost(spec.giteaHost),
  // Two segments and no subgroups: the grammar both ends of the channel share (gitcred/repo-path.ts).
  credentialRepoPath: repoFromPath,
  // Gitea serves the suffix-less HTTPS address without a redirect, so a normalized URL is already canonical.
  canonicalCloneUrl: (normalized) => normalized,
  // A Gitea workspace's spec repository is already the repository's address on its instance.
  managedRemoteUrl: (repository) => repository,
  liveCredentialPurposes: ['gitea_hook_reply', 'gitea_effect'],
  workspaceRepoId: (workspace) => workspace.giteaRepoId,
  placeSecondaryRoot: (row): SecondaryRootPlacement | undefined => {
    // `repos/_gitea/<repository id>` — the id, because a rename or a transfer moves the path.
    const [owner, repo, ...rest] = row.repoFullName.split('/')
    if (!/^[1-9]\d*$/.test(row.repoId) || rest.length > 0 || !isRepoSegment(owner) || !isRepoSegment(repo)) {
      return undefined
    }
    return { provider: 'gitea', repoFullName: `${owner}/${repo}`, subtreeName: giteaSubtreeName(row.repoId) }
  },
  // The repository on the spec's own instance — the address a gitea primary resolves to.
  secondaryCloneUrl: (repoFullName, spec) =>
    authorizeWorkspaceGitUrl(
      normalizeGitCloneUrl(`${giteaManagedHost(spec.giteaHost).baseUrl}/${repoFullName}`),
      spec.giteaHost
    ),
  // A gitea row is repo-bearing by construction, so its scope pins the instance's credential path.
  secondaryCredentialScope: (spec: CodeHostSpecHosts): ManagedCredentialScope => ({
    host: giteaManagedHost(spec.giteaHost),
    ...(spec.giteaHost !== undefined ? { giteaHost: spec.giteaHost } : {}),
    giteaRepoBearing: true
  })
}
