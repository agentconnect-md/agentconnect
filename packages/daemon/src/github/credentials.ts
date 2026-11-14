// GitHub's entry in the daemon's code-host credential seam (codehost/credentials.ts): one fixed
// host, owner/repo addresses, and an App installation token the CP mints for a covered repository.
import { normalizeGithubRepoUrl } from '@agentconnect.md/protocol'
import { GITHUB_MANAGED_HOST, type ManagedCredentialHost } from '../gitcred/managed-hosts.js'
import { repoFromPath } from '../gitcred/repo-path.js'
import { isRepoSegment, RESERVED_SECONDARY_ROOT_DIRS } from '../workspace/secondary-layout.js'
import { authorizeWorkspaceGitUrl } from '../workspace/git-origin-policy.js'
import type { CodeHostCredentialModule, SecondaryRootPlacement } from '../codehost/credentials.js'
import type { ManagedCredentialScope } from '../workspace/git-injection.js'

/** The deployment switch that makes GitHub proxy-only on this daemon, as Gitea, GitLab and Azure DevOps always are; set by the chart's `features.githubGitProxy`. */
export const GITHUB_GIT_PROXY_ENV = 'AC_GITHUB_GIT_PROXY'

/** Anonymous and github-app operations both pin github.com; only a spec-carried host moves the axis. */
const GITHUB_SCOPE: ManagedCredentialScope = { host: GITHUB_MANAGED_HOST }

export const githubCredentials: CodeHostCredentialModule = {
  provider: 'github',
  displayName: 'GitHub',
  specGitCredential: 'github-app',
  hostFromSpec: false,
  managedHost: (): ManagedCredentialHost => GITHUB_MANAGED_HOST,
  credentialRepoPath: repoFromPath,
  // github.com serves the suffix-less HTTPS address, so a normalized URL is already canonical.
  canonicalCloneUrl: (normalized) => normalized,
  managedRemoteUrl: (repository) => normalizeGithubRepoUrl(repository),
  // An App installation token is re-minted per repository, so a scope denial is the repo-level one.
  liveCredentialPurposes: [],
  // The GitHub arm still resolves by name (§17.1), so the spec carries no numeric workspace identity.
  workspaceRepoId: () => undefined,
  resolvesByName: true,
  placeSecondaryRoot: (row): SecondaryRootPlacement | undefined => {
    // `repos/<owner>/<repo>`; undefined when its text is not two plain segments, which would place the subtree by that text.
    const [owner, repo, ...rest] = row.repoFullName.split('/')
    if (rest.length > 0 || !isRepoSegment(owner) || !isRepoSegment(repo)) return undefined
    if (RESERVED_SECONDARY_ROOT_DIRS.has(owner)) return undefined
    return { provider: 'github', repoFullName: `${owner}/${repo}`, subtreeName: `${owner}/${repo}` }
  },
  secondaryCloneUrl: (repoFullName) =>
    authorizeWorkspaceGitUrl(normalizeGithubRepoUrl(`https://github.com/${repoFullName}`)),
  secondaryCredentialScope: () => GITHUB_SCOPE,
  // gh reads the placeholder from its config when a runtime drops GH_TOKEN; `version: "1"` skips a migration that asks the API who the user is.
  cli: {
    command: 'gh',
    ownTokenEnv: ['GH_TOKEN'],
    env: ({ stateDir }) => ({ GH_CONFIG_DIR: stateDir }),
    stateFiles: ({ placeholder, hosts }) => {
      const token = JSON.stringify(placeholder)
      const entries = [...new Set(hosts.map((host) => new URL(host.baseUrl).host))].map(
        (host) =>
          `${host}:\n    git_protocol: https\n    users:\n        x-access-token:\n            oauth_token: ${token}\n` +
          `    oauth_token: ${token}\n    user: x-access-token\n`
      )
      return { 'config.yml': 'version: "1"\n', 'hosts.yml': entries.join('') }
    }
  },
  // Read per call, so the switch is the process environment alone.
  get proxyOnly(): boolean {
    const raw = process.env[GITHUB_GIT_PROXY_ENV]?.trim().toLowerCase()
    return raw === 'true' || raw === '1'
  }
}
