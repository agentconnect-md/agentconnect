// Which credential a GitLab or Gitea request needs (github-app-git-credentials.md, Phase 2): the repository its path names under the instance's prefix.
import { parseManagedBaseUrl, stripHostPathPrefix, type ManagedCredentialHost } from '../gitcred/managed-hosts.js'
import { GITHUB_PROXY_HOSTS, isGitPush } from './github-route.js'

/** One code-host instance an agent's credential reaches, as the proxy matches it. */
export interface ProxyInstance {
  provider: string
  /** What a placeholder is sealed for and TLS is terminated on: the host with a non-default port; GitHub's names on any port. */
  hosts: readonly string[]
  /** The instance's path prefix, without surrounding slashes; empty at the root. */
  pathPrefix: string
}

/** The SaaS hosts, which never resolve into private space; a self-managed instance may. */
export const SAAS_HOSTS: readonly string[] = [...GITHUB_PROXY_HOSTS, 'gitlab.com', 'gitea.com']

/** A host as a base URL spells it: the name, and the port unless it is HTTPS's own. */
export function hostKey(hostname: string, port: number): string {
  const name = hostname.includes(':') ? `[${hostname}]` : hostname
  return port === 443 ? name : `${name}:${port}`
}

/** The proxy's view of a managed host; undefined for one it cannot carry (not HTTPS, or unparseable). */
export function proxyInstance(host: ManagedCredentialHost): ProxyInstance | undefined {
  if (host.provider === 'github') return { provider: 'github', hosts: GITHUB_PROXY_HOSTS, pathPrefix: '' }
  const parts = parseManagedBaseUrl(host.baseUrl)
  if (!parts || parts.protocol !== 'https') return undefined
  return { provider: host.provider, hosts: [parts.host.replace(/:443$/, '')], pathPrefix: parts.pathPrefix }
}

/** The instance's host names without a port: what DNS resolves and what srt routes. */
export function instanceHostnames(instance: ProxyInstance): string[] {
  return instance.hosts.map((host) => host.replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1'))
}

/** The sealed host this request reaches on the instance, or undefined when the instance does not serve it. */
export function instanceHost(instance: ProxyInstance, hostname: string, port: number): string | undefined {
  // GitHub's names match on any port, as they always have; a self-managed host only on its own.
  const key = instance.provider === 'github' ? hostname : hostKey(hostname, port)
  return instance.hosts.includes(key) ? key : undefined
}

export type InstanceRoute =
  /** A repository's smart HTTP at the agent's tier; `push` for receive-pack, which needs write access. */
  | { kind: 'repository'; plane: 'git'; repo: string; push: boolean }
  /** An API read of a repository. */
  | { kind: 'repository'; plane: 'api'; repo: string }
  /** A GitLab API read naming its project by numeric id. */
  | { kind: 'repository'; plane: 'api'; repoId: string }
  /** An API read that names no repository, answered with the workspace's read token. */
  | { kind: 'workspace' }
  /** A request that needs no credential: forwarded with none. */
  | { kind: 'anonymous' }
  | { kind: 'deny'; status: number; reason: string }

const SEGMENT = /^[\w.-]+$/
const READS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

/** How an API write is made instead, per host. */
const WRITE_REFUSAL: Record<string, string> = {
  gitlab:
    'GitLab API writes are not available with this agent’s credential. Use the gitlabMergeRequest, gitlabIssue, gitlabComment or gitlabPipeline tool.',
  gitea:
    'Gitea API writes are not available with this agent’s credential. Use the giteaPullRequest, giteaIssue or giteaComment tool.'
}

function plainSegment(segment: string): boolean {
  return SEGMENT.test(segment) && segment !== '.' && segment !== '..' && segment !== '-'
}

/** A repository path from its segments, `.git` dropped from the last, lower-cased as the credential helper reads it; undefined for anything ambiguous. */
function repositoryPath(segments: string[], nested: boolean): string | undefined {
  if (segments.length < 2 || (!nested && segments.length !== 2)) return undefined
  const named = [...segments.slice(0, -1), segments.at(-1)!.replace(/\.git$/i, '')]
  return named.every(plainSegment) ? named.join('/').toLowerCase() : undefined
}

/** The repository segments before a smart-HTTP service, or undefined when the path is not one. */
function gitServicePrefix(segments: string[]): string[] | undefined {
  const last = segments.at(-1)
  if (last === 'git-upload-pack' || last === 'git-receive-pack') return segments.slice(0, -1)
  if (last === 'refs' && segments.at(-2) === 'info') return segments.slice(0, -2)
  return undefined
}

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

/** Route one GitLab or Gitea request by its method and path (query included or not), under the instance's prefix. */
export function instanceRoute(instance: ProxyInstance, method: string, target: string): InstanceRoute {
  const stripped = stripHostPathPrefix(target.split('?')[0] ?? '', instance.pathPrefix)
  // Another application beside the instance on the same host is not the agent's code host.
  if (stripped === undefined) return { kind: 'anonymous' }
  const segments = stripped.split('/')
  const gitlab = instance.provider === 'gitlab'
  const service = gitServicePrefix(segments)
  if (service) {
    const repo = repositoryPath(service, gitlab)
    if (!repo) return { kind: 'deny', status: 400, reason: 'the git URL does not name a repository' }
    return { kind: 'repository', plane: 'git', repo, push: isGitPush(segments.at(-1)!, target) }
  }
  if (segments[0] !== 'api') return { kind: 'anonymous' }
  const version = gitlab ? 'v4' : 'v1'
  if (segments[1] !== version) return { kind: 'deny', status: 400, reason: `only API ${version} is available` }
  if (!READS.has(method.toUpperCase())) {
    return { kind: 'deny', status: 403, reason: WRITE_REFUSAL[instance.provider] ?? 'API writes are not available' }
  }
  if (segments[2] !== (gitlab ? 'projects' : 'repos') || segments.length < 4) return { kind: 'workspace' }
  if (gitlab) {
    const project = gitlabProject(segments[3]!)
    if (!project) return { kind: 'deny', status: 400, reason: 'the API path does not name a project' }
    return { kind: 'repository', plane: 'api', ...project }
  }
  const named = segments.slice(3, 5)
  const repo = /\.git$/i.test(named[1] ?? '') ? undefined : repositoryPath(named, false)
  if (!repo) return { kind: 'deny', status: 400, reason: 'the API path does not name a repository' }
  return { kind: 'repository', plane: 'api', repo }
}
