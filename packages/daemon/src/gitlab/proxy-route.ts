// GitLab's routes in the credential proxy (github-app-git-credentials.md, Phase 2): git at any namespace depth, and API v4 on a project by numeric id or encoded path, a write at the agent's `write` tier.
import {
  gitServicePrefix,
  isGitPush,
  READS,
  repositoryPath,
  underInstance,
  type ProxyRouteDescriptor
} from '../credential-proxy/route-descriptor.js'

const NO_PROJECT_REFUSAL = 'this GitLab API read names no project and the agent has no workspace project'
const NO_PROJECT_WRITE_REFUSAL = 'a GitLab API write outside a project is not available with this agent’s credential'
const ADMIN_REFUSAL = 'GitLab project settings, members and secrets are not available with this agent’s credential'
const NOT_A_PLAIN_PATH = 'the API path under the project has an empty or dot segment'

/** Project subresources that hold secrets or reach beyond the project, refused at every tier and for every method. */
const SECRET_SUBRESOURCES: ReadonlySet<string> = new Set([
  'access_tokens',
  'deploy_keys',
  'deploy_tokens',
  'hooks',
  'integrations',
  'job_token_scope',
  'remote_mirrors',
  'runners',
  'secure_files',
  'services',
  'triggers',
  'variables'
])

/** Project subresources only a maintainer changes: who reaches the project, how it is protected, and where it lives. */
const ADMIN_SUBRESOURCES: ReadonlySet<string> = new Set([
  'approval_rules',
  'approvals',
  'archive',
  'avatar',
  'badges',
  'cluster_agents',
  'clusters',
  'export',
  'fork',
  'housekeeping',
  'import',
  'invitations',
  'members',
  'mirror',
  'pipeline_schedules',
  'protected_branches',
  'protected_environments',
  'protected_tags',
  'push_rule',
  'repository_storage_moves',
  'restore',
  'share',
  'transfer',
  'unarchive'
])

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

/** A segment decoded, or undefined where it does not decode. */
function decoded(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment)
  } catch {
    return undefined
  }
}

export const gitlabProxyRoute: ProxyRouteDescriptor = {
  provider: 'gitlab',
  refusedHeaders: ['x-http-method-override', 'x-http-method', 'x-method-override'],
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
    const reads = READS.has(method.toUpperCase())
    // A request that names no project answers with the service account's own memberships, under the workspace project's read lease.
    if (segments[2] !== 'projects' || segments.length < 4) {
      if (!reads) return { kind: 'deny', status: 403, reason: NO_PROJECT_WRITE_REFUSAL }
      const workspace = repositories.find((row) => row.workspace)
      if (!workspace) return { kind: 'deny', status: 403, reason: NO_PROJECT_REFUSAL }
      return { kind: 'repository', plane: 'api', repoId: workspace.repoId }
    }
    const project = gitlabProject(segments[3]!)
    if (!project) return { kind: 'deny', status: 400, reason: 'the API path does not name a project' }
    const under = segments.slice(4)
    // An encoded separator is how GitLab names a file or a branch, but an empty or dot segment could route as another subresource.
    if (under.some((segment) => ['', '.', '..', undefined].includes(decoded(segment))))
      return { kind: 'deny', status: 400, reason: NOT_A_PLAIN_PATH }
    const subresource = decoded(under[0] ?? '')?.toLowerCase() ?? ''
    if (SECRET_SUBRESOURCES.has(subresource)) return { kind: 'deny', status: 403, reason: ADMIN_REFUSAL }
    if (reads) return { kind: 'repository', plane: 'api', ...project }
    // The project itself is its settings: editing or deleting it, like the maintainer subresources, is not the agent's.
    if (under.length === 0 || ADMIN_SUBRESOURCES.has(subresource))
      return { kind: 'deny', status: 403, reason: ADMIN_REFUSAL }
    return { kind: 'repository', plane: 'api', ...project, readOnly: false, write: true }
  }
}
