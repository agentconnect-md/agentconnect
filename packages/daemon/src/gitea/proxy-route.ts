// Gitea's routes in the credential proxy (gitea-integration.md §9): the bot token reaches every repository the bot can, so a request is served only on one of the agent's own repositories or a short allowlist.
import {
  gitServicePrefix,
  isGitPush,
  READS,
  repositoryPath,
  underInstance,
  type ProxyRouteDescriptor
} from '../credential-proxy/route-descriptor.js'

const WRITE_REFUSAL =
  'Gitea API writes are not available with this agent’s credential. Use the giteaPullRequest, giteaIssue or giteaComment tool.'
const NO_REPOSITORY_REFUSAL =
  'a Gitea API read that names no repository is not available with this agent’s credential; name the repository as /api/v1/repos/{owner}/{repo}/…'
const SETTINGS_REFUSAL = 'repository settings are not available with this agent’s credential'
const NOT_A_PLAIN_PATH = 'the API path under the repository has an empty, dot or encoded-separator segment'

/** A segment Gitea or Forgejo could route as something else: empty (Forgejo collapses repeated slashes), a dot segment, or one decoding to a separator. */
function ambiguousSegment(segment: string): boolean {
  let decoded: string
  try {
    decoded = decodeURIComponent(segment)
  } catch {
    return true
  }
  return decoded === '' || decoded === '.' || decoded === '..' || /[/\\]/.test(decoded)
}

/** Repository subresources only an administrator reads, the bot always being one: webhooks, deploy keys, mirrors, Actions secrets, variables and runners. */
function adminSetting(rest: readonly string[]): boolean {
  const [first, second] = rest.map((segment) => decodeURIComponent(segment).toLowerCase())
  if (first === 'hooks' || first === 'keys' || first === 'push_mirrors') return true
  return first === 'actions' && (second === 'secrets' || second === 'variables' || second === 'runners')
}

export const giteaProxyRoute: ProxyRouteDescriptor = {
  provider: 'gitea',
  route: (instance, method, target, { repositories }) => {
    const stripped = underInstance(instance, target)
    // Another application beside the instance on the same host is not the agent's code host.
    if (stripped === undefined) return { kind: 'anonymous' }
    const segments = stripped.split('/')
    const service = gitServicePrefix(segments)
    if (service) {
      const repo = repositoryPath(service, false)
      if (!repo) return { kind: 'deny', status: 400, reason: 'the git URL does not name a repository' }
      return { kind: 'repository', plane: 'git', repo, push: isGitPush(segments.at(-1)!, target) }
    }
    if (segments[0] !== 'api') return { kind: 'anonymous' }
    if (segments[1] !== 'v1') return { kind: 'deny', status: 400, reason: 'only API v1 is available' }
    if (!READS.has(method.toUpperCase())) return { kind: 'deny', status: 403, reason: WRITE_REFUSAL }
    const rest = segments.slice(2)
    if (rest[0] !== 'repos') {
      // The instance's version needs no credential; the bot's own profile shows no repository, so the workspace's lease reads it.
      if (rest.length === 1 && rest[0] === 'version') return { kind: 'anonymous' }
      const workspace = repositories.find((row) => row.workspace)
      if (rest.length === 1 && rest[0] === 'user' && workspace) {
        return { kind: 'repository', plane: 'api', repo: workspace.repoFullName.toLowerCase() }
      }
      return { kind: 'deny', status: 403, reason: NO_REPOSITORY_REFUSAL }
    }
    if (rest.length < 3) return { kind: 'deny', status: 403, reason: NO_REPOSITORY_REFUSAL }
    const named = rest.slice(1, 3)
    const repo = /\.git$/i.test(named[1] ?? '') ? undefined : repositoryPath(named, false)
    if (!repo) return { kind: 'deny', status: 400, reason: 'the API path does not name a repository' }
    const under = rest.slice(3)
    if (under.some(ambiguousSegment)) return { kind: 'deny', status: 400, reason: NOT_A_PLAIN_PATH }
    if (adminSetting(under)) return { kind: 'deny', status: 403, reason: SETTINGS_REFUSAL }
    return { kind: 'repository', plane: 'api', repo }
  }
}
