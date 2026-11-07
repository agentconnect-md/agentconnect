// Which credential a GitHub request needs (github-app-git-credentials.md, Phase 2): the repository its path names, at its tier.

/** The hosts whose requests the proxy terminates and authenticates. */
export const GITHUB_PROXY_HOSTS: readonly string[] = [
  'github.com',
  'api.github.com',
  'uploads.github.com',
  'codeload.github.com'
]

export type GithubRoute =
  /** A repository's own token: `git` for smart HTTP (contents), `gh` for the API; `push` for receive-pack, which needs write access. */
  | { kind: 'repository'; repo: string; plane: 'git' | 'gh'; readOnly: boolean; push?: boolean }
  /** A GraphQL request: its body decides the repository and whether it may pass. */
  | { kind: 'graphql' }
  /** A read that names no repository, answered with the workspace's read-only token. */
  | { kind: 'workspace' }
  /** A request that needs no credential: forwarded with none. */
  | { kind: 'anonymous' }
  | { kind: 'deny'; status: number; reason: string }

const SEGMENT = /^[\w.-]+$/
const GIT_SERVICE = /^(?:info\/refs|git-upload-pack|git-receive-pack)$/

function repository(owner: string | undefined, name: string | undefined): string | undefined {
  if (!owner || !name || !SEGMENT.test(owner) || !SEGMENT.test(name)) return undefined
  if (owner === '.' || owner === '..' || name === '.' || name === '..') return undefined
  return `${owner}/${name.replace(/\.git$/, '')}`
}

const READS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Whether a smart-HTTP request is a push: receive-pack itself, or its ref advertisement (any `service` naming it). */
export function isGitPush(service: string, target: string): boolean {
  if (service === 'git-receive-pack') return true
  const query = target.includes('?') ? target.slice(target.indexOf('?') + 1) : ''
  return new URLSearchParams(query).getAll('service').some((value) => value.toLowerCase() === 'git-receive-pack')
}

/** Route one request by its canonical host, method and path (query included or not). */
export function githubRoute(host: string, method: string, target: string): GithubRoute {
  const path = target.split('?')[0] ?? ''
  const segments = path.split('/').slice(1)
  const reads = READS.has(method.toUpperCase())
  switch (host) {
    case 'github.com': {
      // Smart HTTP: /owner/repo(.git)/info/refs, /git-upload-pack, /git-receive-pack.
      const service = segments.slice(2).join('/')
      if (GIT_SERVICE.test(service)) {
        const repo = repository(segments[0], segments[1])
        if (!repo) return { kind: 'deny', status: 400, reason: 'the git URL does not name a repository' }
        return { kind: 'repository', repo, plane: 'git', readOnly: false, push: isGitPush(segments.at(-1)!, target) }
      }
      return { kind: 'anonymous' }
    }
    case 'api.github.com': {
      if (path === '/graphql') {
        return method.toUpperCase() === 'POST'
          ? { kind: 'graphql' }
          : { kind: 'deny', status: 405, reason: 'GraphQL takes POST' }
      }
      if (segments[0] === 'repos') {
        const repo = repository(segments[1], segments[2])
        if (!repo) return { kind: 'deny', status: 400, reason: 'the API path does not name a repository' }
        return { kind: 'repository', repo, plane: 'gh', readOnly: false }
      }
      if (reads) return { kind: 'workspace' }
      return {
        kind: 'deny',
        status: 403,
        reason: 'a write outside a repository is not available with this agent’s credential'
      }
    }
    case 'uploads.github.com': {
      if (segments[0] === 'repos') {
        const repo = repository(segments[1], segments[2])
        if (repo) return { kind: 'repository', repo, plane: 'gh', readOnly: false }
      }
      return { kind: 'deny', status: 400, reason: 'the upload path does not name a repository' }
    }
    case 'codeload.github.com': {
      const repo = repository(segments[0], segments[1])
      if (repo && reads) return { kind: 'repository', repo, plane: 'gh', readOnly: true }
      return { kind: 'deny', status: 400, reason: 'the archive path does not name a repository' }
    }
    default:
      return { kind: 'anonymous' }
  }
}

/** The repository a GraphQL request's variables name (`owner` with `name` or `repo`), if any. */
export function graphqlRepository(variables: unknown): string | undefined {
  if (typeof variables !== 'object' || variables === null) return undefined
  const v = variables as Record<string, unknown>
  const owner = typeof v.owner === 'string' ? v.owner : undefined
  const name = typeof v.name === 'string' ? v.name : typeof v.repo === 'string' ? v.repo : undefined
  return repository(owner, name)
}
