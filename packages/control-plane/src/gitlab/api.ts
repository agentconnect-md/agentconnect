/**
 * Thin GitLab.com REST wrapper — the only spot the CP talks to gitlab.com (the
 * pattern set by `github/api.ts`). `fetch` is injectable so tests stub the API
 * without network; timeouts are short; every error is typed.
 *
 * NEVER log request headers, token parameters, or token-bearing response bodies.
 */
import { GITLAB_HOST } from './config.js'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export type GitlabErrorCode = 'AUTH_REQUIRED' | 'RATE_LIMITED' | 'NOT_FOUND' | 'INTERNAL'

/** GitLab call failure, pre-mapped for route/service handling. */
export class GitlabApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: GitlabErrorCode,
    readonly retryable: boolean
  ) {
    super(message)
    this.name = 'GitlabApiError'
  }
}

const API_BASE = `${GITLAB_HOST}/api/v4`
const TIMEOUT_MS = 10_000

function codeFor(status: number): GitlabErrorCode {
  if (status === 401 || status === 403) return 'AUTH_REQUIRED'
  if (status === 404) return 'NOT_FOUND'
  if (status === 429) return 'RATE_LIMITED'
  return 'INTERNAL'
}

export interface GitlabRequestOpts {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** OAuth or PAT bearer. Pass null only for the token endpoint itself. */
  auth: string | null
  body?: unknown
  fetchImpl?: FetchLike
  baseUrl?: string
}

/** One GitLab REST call → parsed JSON. Throws `GitlabApiError` on any non-2xx. */
export async function gitlabRequest<T>(path: string, opts: GitlabRequestOpts): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike)
  let res: Response
  try {
    res = await fetchImpl(`${opts.baseUrl ?? API_BASE}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(opts.auth ? { authorization: `Bearer ${opts.auth}` } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (e) {
    throw new GitlabApiError(`gitlab unreachable: ${(e as Error).message}`, 0, 'INTERNAL', true)
  }
  if (res.ok) {
    const text = await res.text()
    if (!text) return undefined as T
    return JSON.parse(text) as T
  }
  // Read the message for diagnostics only; NEVER include token material.
  let detail = ''
  try {
    const body = (await res.json()) as { message?: unknown; error?: unknown; error_description?: unknown }
    const msg = body.message ?? body.error_description ?? body.error
    if (typeof msg === 'string') detail = `: ${msg}`
    else if (msg !== undefined) detail = `: ${JSON.stringify(msg)}`
  } catch {
    // non-JSON error body — status alone
  }
  throw new GitlabApiError(`gitlab ${res.status}${detail}`, res.status, codeFor(res.status), res.status >= 500)
}

/** The token grant GitLab's `/oauth/token` returns for code exchange and refresh. */
export interface GitlabTokenGrant {
  access_token: string
  refresh_token: string
  expires_in?: number
  created_at?: number
  scope?: string
}

/** Exchange an authorization code (with its PKCE verifier) for a token pair. */
export async function gitlabExchangeCode(
  args: {
    clientId: string
    clientSecret: string
    code: string
    verifier: string
    redirectUri: string
  },
  fetchImpl?: FetchLike
): Promise<GitlabTokenGrant> {
  return gitlabTokenCall(
    {
      grant_type: 'authorization_code',
      client_id: args.clientId,
      client_secret: args.clientSecret,
      code: args.code,
      code_verifier: args.verifier,
      redirect_uri: args.redirectUri
    },
    fetchImpl
  )
}

/** One refresh. Rotates BOTH tokens — the caller owns the single-writer/CAS discipline (§9.3). */
export async function gitlabRefreshToken(
  args: { clientId: string; clientSecret: string; refreshToken: string; redirectUri: string },
  fetchImpl?: FetchLike
): Promise<GitlabTokenGrant> {
  return gitlabTokenCall(
    {
      grant_type: 'refresh_token',
      client_id: args.clientId,
      client_secret: args.clientSecret,
      refresh_token: args.refreshToken,
      redirect_uri: args.redirectUri
    },
    fetchImpl
  )
}

async function gitlabTokenCall(params: Record<string, string>, fetchImpl?: FetchLike): Promise<GitlabTokenGrant> {
  const impl = fetchImpl ?? (fetch as FetchLike)
  let res: Response
  try {
    res = await impl(`${GITLAB_HOST}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (e) {
    throw new GitlabApiError(`gitlab token endpoint unreachable: ${(e as Error).message}`, 0, 'INTERNAL', true)
  }
  if (!res.ok) {
    // Deliberately status-only: an OAuth error body can echo request parameters.
    throw new GitlabApiError(`gitlab token endpoint ${res.status}`, res.status, codeFor(res.status), res.status >= 500)
  }
  const grant = (await res.json()) as GitlabTokenGrant
  if (typeof grant.access_token !== 'string' || typeof grant.refresh_token !== 'string') {
    throw new GitlabApiError('gitlab token response is missing the token pair', 0, 'INTERNAL', false)
  }
  return grant
}

/** The authenticated GitLab.com user (`GET /user`) — administration identity facts. */
export interface GitlabCurrentUser {
  id: number
  username: string
}

export async function gitlabCurrentUser(accessToken: string, fetchImpl?: FetchLike): Promise<GitlabCurrentUser> {
  const user = await gitlabRequest<GitlabCurrentUser>('/user', { auth: accessToken, fetchImpl })
  if (typeof user?.id !== 'number' || typeof user.username !== 'string') {
    throw new GitlabApiError('gitlab /user response is not a user', 0, 'INTERNAL', false)
  }
  return user
}
