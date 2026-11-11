// GitLab's routes in the credential proxy (github-app-git-credentials.md, Phase 2): git at any namespace depth, and API v4 reads of a project by numeric id or encoded path.
import {
  gitServicePrefix,
  isGitPush,
  READS,
  repositoryPath,
  underInstance,
  type ProxyRouteDescriptor
} from '../credential-proxy/route-descriptor.js'

const NO_PROJECT_REFUSAL = 'this GitLab API read names no project and the agent has no workspace project'

const WRITE_REFUSAL =
  'GitLab API writes are not available with this agent’s credential. Use the gitlabMergeRequest, gitlabIssue, gitlabComment or gitlabPipeline tool.'

/** A GitLab project as `/projects/:id` names it: a numeric id, or a URL-encoded path. */
function gitlabProject(encoded: string): { repo: string } | { repoId: string } | undefined {
  if (/^\d+$/.test(encoded)) return { repoId: encoded }
  let decoded: string
  try {
    decoded = decodeURIComponent(encoded)
  } catch {
    return undefined
  }
  if (/\.git$/i.test(decoded)) return undefined
  const repo = repositoryPath(decoded.split('/'), true)
  return repo ? { repo } : undefined
}

export const gitlabProxyRoute: ProxyRouteDescriptor = {
  provider: 'gitlab',
  route: (instance, method, target, { repositories }) => {
    const stripped = underInstance(instance, target)
    // Another application beside the instance on the same host is not the agent's code host.
    if (stripped === undefined) return { kind: 'anonymous' }
    const segments = stripped.split('/')
    const service = gitServicePrefix(segments)
    if (service) {
      const repo = repositoryPath(service, true)
      if (!repo) return { kind: 'deny', status: 400, reason: 'the git URL does not name a repository' }
      return { kind: 'repository', plane: 'git', repo, push: isGitPush(segments.at(-1)!, target) }
    }
    if (segments[0] !== 'api') return { kind: 'anonymous' }
    if (segments[1] !== 'v4') return { kind: 'deny', status: 400, reason: 'only API v4 is available' }
    if (!READS.has(method.toUpperCase())) return { kind: 'deny', status: 403, reason: WRITE_REFUSAL }
    // A read that names no project answers with the service account's own memberships, under the workspace project's read lease.
    if (segments[2] !== 'projects' || segments.length < 4) {
      const workspace = repositories.find((row) => row.workspace)
      if (!workspace) return { kind: 'deny', status: 403, reason: NO_PROJECT_REFUSAL }
      return { kind: 'repository', plane: 'api', repoId: workspace.repoId }
    }
    const project = gitlabProject(segments[3]!)
    if (!project) return { kind: 'deny', status: 400, reason: 'the API path does not name a project' }
    return { kind: 'repository', plane: 'api', ...project }
  }
}
