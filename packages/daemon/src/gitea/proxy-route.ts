// Gitea's routes in the credential proxy (github-app-git-credentials.md, Phase 2): git at `owner/repo`, and API v1 reads of `repos/{owner}/{repo}`.
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

export const giteaProxyRoute: ProxyRouteDescriptor = {
  provider: 'gitea',
  route: (instance, method, target) => {
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
    if (segments[2] !== 'repos' || segments.length < 4) return { kind: 'workspace' }
    const named = segments.slice(3, 5)
    const repo = /\.git$/i.test(named[1] ?? '') ? undefined : repositoryPath(named, false)
    if (!repo) return { kind: 'deny', status: 400, reason: 'the API path does not name a repository' }
    return { kind: 'repository', plane: 'api', repo }
  }
}
