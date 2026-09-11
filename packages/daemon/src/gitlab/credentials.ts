// GitLab's entry in the daemon's code-host credential seam (codehost/credentials.ts): the one
// instance the spec names (§24.4), namespaced project paths, and per-project grants the CP resolves
// live — so this host's hook-reply and effect leases are re-asked rather than negatively cached.
import { normalizeGitCloneUrl } from '@agentconnect.md/protocol'
import { gitlabManagedHost } from '../gitcred/managed-hosts.js'
import { projectFromPath } from '../gitcred/repo-path.js'
import { gitlabSubtreeName, isRepoSegment } from '../workspace/secondary-layout.js'
import { authorizeWorkspaceGitUrl } from '../workspace/git-origin-policy.js'
import type { CodeHostCredentialModule, CodeHostSpecHosts, SecondaryRootPlacement } from '../codehost/credentials.js'
import type { ManagedCredentialScope } from '../workspace/git-injection.js'

export const gitlabCredentials: CodeHostCredentialModule = {
  provider: 'gitlab',
  specGitCredential: 'gitlab',
  hostFromSpec: true,
  managedHost: (spec) => gitlabManagedHost(spec.gitlabHost),
  credentialRepoPath: projectFromPath,
  // GitLab 301s the suffix-less HTTPS probe and we refuse redirects, so a gitlab remote carries `.git`.
  canonicalCloneUrl: (normalized) => {
    if (!/^https:/i.test(normalized) || /\.git$/i.test(normalized)) return normalized
    return `${normalized}.git`
  },
  // A GitLab workspace's spec repository is already the project's address on its instance.
  managedRemoteUrl: (repository) => repository,
  liveCredentialPurposes: ['gitlab_hook_reply', 'gitlab_effect'],
  workspaceRepoId: (workspace) => workspace.gitlabProjectId,
  placeSecondaryRoot: (row): SecondaryRootPlacement | undefined => {
    // `repos/_gitlab/<project id>` — the id, because a project path is namespaced to any depth and a rename moves it.
    const segments = row.repoFullName.split('/')
    if (!/^[1-9]\d*$/.test(row.repoId) || segments.length < 2 || !segments.every(isRepoSegment)) return undefined
    return { provider: 'gitlab', repoFullName: segments.join('/'), subtreeName: gitlabSubtreeName(row.repoId) }
  },
  // The project on the spec's own instance, under GitLab's `.git` rule — the address a gitlab primary resolves to.
  secondaryCloneUrl: (repoFullName, spec) => {
    const instance = gitlabManagedHost(spec.gitlabHost).baseUrl
    return authorizeWorkspaceGitUrl(
      gitlabCredentials.canonicalCloneUrl(normalizeGitCloneUrl(`${instance}/${repoFullName}`)),
      spec.gitlabHost
    )
  },
  // A gitlab row is repo-bearing by construction (§24.4), so its scope pins the instance's credential path.
  secondaryCredentialScope: (spec: CodeHostSpecHosts): ManagedCredentialScope => ({
    host: gitlabManagedHost(spec.gitlabHost),
    ...(spec.gitlabHost !== undefined ? { gitlabHost: spec.gitlabHost } : {}),
    gitlabRepoBearing: true
  })
}
