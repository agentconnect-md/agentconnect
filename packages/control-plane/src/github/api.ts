/**
 * Thin GitHub REST wrapper — the only spot the CP talks to github.com (the
 * pattern set by `http/slack-identity.ts` for Slack). `fetch` is injectable so
 * integration tests stub the API without network; timeouts are short and every
 * error is typed for the WS handler's ErrorCode mapping.
 *
 * NEVER log request headers or token-bearing response bodies.
 */
import { createAppAuth } from '@octokit/auth-app'
import type { GithubAppConfig } from './config.js'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export type GithubErrorCode = 'LEASE_DENIED' | 'RATE_LIMITED' | 'INTERNAL'

/** GitHub call failure, pre-mapped onto the wire ErrorCode vocabulary. */
export class GithubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: GithubErrorCode,
    readonly retryable: boolean
  ) {
    super(message)
    this.name = 'GithubApiError'
  }
}

const API_BASE = 'https://api.github.com'
const TIMEOUT_MS = 10_000

const appAuthByConfig = new WeakMap<GithubAppConfig, ReturnType<typeof createAppAuth>>()

/** App JWT façade. `@octokit/auth-app` owns the signing protocol; installation
 *  token policy/cache and every REST request remain in AgentConnect services. */
export async function mintAppJwt(cfg: GithubAppConfig): Promise<string> {
  let auth = appAuthByConfig.get(cfg)
  if (!auth) {
    auth = createAppAuth({
      // GitHub recommends the client id as `iss`; numeric App id remains the
      // fallback. auth-app accepts either as its appId/JWT issuer input.
      appId: cfg.jwtIssuer,
      privateKey: cfg.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    })
    appAuthByConfig.set(cfg, auth)
  }
  return (await auth({ type: 'app' })).token
}

export interface GithubRequestOpts {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  /** `Bearer <jwt>` for app-auth calls, `Bearer <ghs_…>` for installation-token calls.
   *  Pass null only for GitHub's explicitly public endpoints. */
  auth: string | null
  body?: unknown
  fetchImpl?: FetchLike
  baseUrl?: string
  /** Re-quote huge `"id"` values BEFORE JSON.parse. Webhook delivery ids exceed
   *  Number.MAX_SAFE_INTEGER (19 digits), so a plain parse silently rounds them
   *  and a follow-up redeliver call 404s on a nonexistent id. The caller's type
   *  must declare those ids as `string`. */
  bigIdsAsStrings?: boolean
}

/** One GitHub REST call → parsed JSON. Throws `GithubApiError` on any non-2xx. */
export async function githubRequest<T>(path: string, opts: GithubRequestOpts): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike)
  let res: Response
  try {
    res = await fetchImpl(`${opts.baseUrl ?? API_BASE}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(opts.auth ? { authorization: `Bearer ${opts.auth}` } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (e) {
    throw new GithubApiError(`github unreachable: ${(e as Error).message}`, 0, 'INTERNAL', true)
  }
  if (res.ok) {
    const text = await res.text()
    if (!text) return undefined as T // 202-style empty success (e.g. redelivery accepted)
    // Only `id` keys with ≥15 digits are re-quoted — small numeric ids
    // (repositories, installations) stay numbers for existing callers.
    const safe = opts.bigIdsAsStrings ? text.replace(/"id"\s*:\s*(\d{15,})/g, '"id":"$1"') : text
    return JSON.parse(safe) as T
  }

  // Read the message for diagnostics; GitHub error bodies carry no secrets.
  let detail = ''
  try {
    const body = (await res.json()) as { message?: string }
    detail = body.message ?? ''
  } catch {
    // non-JSON error body — status alone will do
  }

  if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) {
    throw new GithubApiError(`github rate limited: ${detail}`, res.status, 'RATE_LIMITED', true)
  }
  // 404 (installation gone / repo out of the grant set) and 422 (narrowing to a
  // repo the installation can't reach) are operator-recoverable denials.
  if (res.status === 404 || res.status === 422 || res.status === 403) {
    throw new GithubApiError(`github denied (${res.status}): ${detail}`, res.status, 'LEASE_DENIED', false)
  }
  // 401 = our own JWT/key is wrong (misconfig) — internal, not retryable-by-daemon.
  throw new GithubApiError(`github error (${res.status}): ${detail}`, res.status, 'INTERNAL', res.status >= 500)
}

/** One GraphQL query/mutation → its `data`, for the handful of facts REST does not carry.
 *  Review-thread RESOLUTION state is the reason this exists: `/pulls/:n/comments` returns the
 *  comments but has no `isResolved` on any REST route, so a panel that names unresolved threads
 *  cannot be built on REST alone. `resolveReviewThread` and `enablePullRequestAutoMerge` are
 *  likewise mutations with no REST equivalent. */
export async function githubGraphql<T>(
  query: string,
  variables: Record<string, unknown>,
  opts: Omit<GithubRequestOpts, 'method' | 'body'>
): Promise<T> {
  // A GraphQL error is reported inside a 200, so the REST helper's status mapping cannot see it —
  // hence the `errors` inspection below rather than reusing `githubRequest` wholesale.
  const res = await githubRequest<{ data?: T; errors?: Array<{ type?: string; message?: string }> }>('/graphql', {
    ...opts,
    method: 'POST',
    body: { query, variables }
  })
  const errors = res?.errors ?? []
  if (errors.length > 0) {
    const detail = errors.map((e) => e.message ?? e.type ?? 'unknown').join('; ')
    // GitHub reports authorization and missing-node failures as GraphQL errors inside a 200; both
    // are the operator-recoverable denial REST would have answered 404/403 with.
    const denied = errors.some((e) => e.type === 'FORBIDDEN' || e.type === 'NOT_FOUND')
    throw new GithubApiError(
      `github graphql ${denied ? 'denied' : 'error'}: ${detail}`,
      200,
      denied ? 'LEASE_DENIED' : 'INTERNAL',
      false
    )
  }
  // `data` absent with no `errors` is a contract violation, not a partial answer.
  if (!res?.data) throw new GithubApiError('github graphql returned no data', 200, 'INTERNAL', false)
  return res.data
}
