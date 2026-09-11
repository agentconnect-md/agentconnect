/**
 * The small Gitea REST client the daemon's Gitea consumers share (gitea-integration.md §4.2): the
 * `Authorization: token` header, JSON in and out with big ids preserved, and a typed failure that
 * tells a definite authentication rejection — the one case a caller may re-mint once for — from
 * everything else. Callers hand it the lease's token and the per-turn `/api/v1` root; it holds nothing.
 */
import { isRepoSegment } from '../workspace/secondary-layout.js'
import { parseCodeHostJson } from '../codehost/json.js'

const MAX_ERROR_CHARS = 200

export class GiteaRequestError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    /** A bounded, single-line hint from Gitea's error body — never the request or the token. */
    readonly detail: string
  ) {
    super(`Gitea ${method} failed with ${status}${detail ? `: ${detail}` : ''}`)
    this.name = 'GiteaRequestError'
  }

  /** A definite authentication rejection: the lease is stale or revoked, never the request's fault. */
  get authRejected(): boolean {
    return this.status === 401 || this.status === 403
  }
}

export interface GiteaApiClient {
  /** The instance's `/api/v1` root, resolved per turn (api-base.ts). */
  apiBaseUrl: string
  token: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

export interface GiteaApiRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  /** Absolute API path under the root, already encoded (`/repos/o/r/issues/1/comments`). */
  path: string
  query?: Record<string, string>
  body?: unknown
}

/** One request; the parsed JSON body, or undefined for an empty one. Throws {@link GiteaRequestError} on any non-2xx. */
export async function giteaRequest(client: GiteaApiClient, request: GiteaApiRequest): Promise<unknown> {
  const doFetch = client.fetchImpl ?? fetch
  const search = new URLSearchParams(request.query ?? {}).toString()
  const res = await doFetch(`${client.apiBaseUrl}${request.path}${search ? `?${search}` : ''}`, {
    method: request.method,
    headers: {
      authorization: `token ${client.token}`,
      accept: 'application/json',
      ...(request.body !== undefined ? { 'content-type': 'application/json' } : {})
    },
    ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
    ...(client.signal ? { signal: client.signal } : {})
  })
  const raw = await res.text()
  if (!res.ok) throw new GiteaRequestError(request.method, res.status, giteaErrorDetail(raw))
  if (!raw.trim()) return undefined
  try {
    return parseCodeHostJson(raw)
  } catch {
    throw new Error(`Gitea returned an unreadable ${request.method} response`)
  }
}

/** The bounded message of a Gitea error body (`{"message": …}`), or an empty string. */
export function giteaErrorDetail(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { message?: unknown }
    const message = typeof parsed.message === 'string' ? parsed.message : ''
    return message.trim() ? message.replace(/\s+/g, ' ').slice(0, MAX_ERROR_CHARS) : ''
  } catch {
    return ''
  }
}

/** `owner/repo` as two validated path segments; a path that is not exactly that never composes a URL. */
export function giteaRepoSegments(repoPath: string): { owner: string; repo: string } {
  const [owner, repo, ...rest] = repoPath.split('/')
  if (rest.length > 0 || !isRepoSegment(owner) || !isRepoSegment(repo)) {
    throw new Error('a Gitea repository path must be exactly owner/repo')
  }
  return { owner, repo }
}

/** `/repos/<owner>/<repo>` — the prefix every repository-scoped Gitea path starts with. */
export function giteaRepoPath(repoPath: string): string {
  const { owner, repo } = giteaRepoSegments(repoPath)
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
}
