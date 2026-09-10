/**
 * Thin GitHub REST wrapper — the only spot the CP talks to github.com (the
 * pattern set by `http/slack-identity.ts` for Slack). `fetch` is injectable so
 * integration tests stub the API without network; timeouts are short, a read
 * repeats a transient failure twice, and every error is typed for the WS
 * handler's ErrorCode mapping.
 *
 * NEVER log request headers or token-bearing response bodies.
 */
import { createAppAuth } from '@octokit/auth-app'
import type { GithubAppConfig } from './config.js'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export type GithubErrorCode = 'LEASE_DENIED' | 'RATE_LIMITED' | 'INTERNAL'

/** When GitHub said to come back: `retry-after` as a delay, `x-ratelimit-reset` as an instant (epoch ms). */
export interface GithubRetryHint {
  retryAfterMs?: number
  rateLimitResetAt?: number
}

/** GitHub call failure, pre-mapped onto the wire ErrorCode vocabulary. */
export class GithubApiError extends Error {
  readonly retryAfterMs?: number
  readonly rateLimitResetAt?: number

  constructor(
    message: string,
    readonly status: number,
    readonly code: GithubErrorCode,
    readonly retryable: boolean,
    hint: GithubRetryHint = {}
  ) {
    super(message)
    this.name = 'GithubApiError'
    if (hint.retryAfterMs !== undefined) this.retryAfterMs = hint.retryAfterMs
    if (hint.rateLimitResetAt !== undefined) this.rateLimitResetAt = hint.rateLimitResetAt
  }
}

/** A secondary limit that names no wait asks for "at least one minute" (GitHub's own guidance). */
const RATE_LIMIT_DEFAULT_WAIT_MS = 60_000

/** How long GitHub asked the caller to wait before retrying `err`, measured from the caller's clock. */
export function githubRetryAfterMs(err: unknown, nowMs: number): number | undefined {
  if (!(err instanceof GithubApiError)) return undefined
  if (err.retryAfterMs !== undefined) return err.retryAfterMs
  if (err.rateLimitResetAt !== undefined) return Math.max(0, err.rateLimitResetAt - nowMs)
  return err.code === 'RATE_LIMITED' ? RATE_LIMIT_DEFAULT_WAIT_MS : undefined
}

/** `retry-after` is delta-seconds and `x-ratelimit-reset` epoch-seconds; anything unparseable is no hint. */
function retryHintFrom(headers: Headers): GithubRetryHint {
  const retryAfter = headers.get('retry-after')
  // The reset names the primary window; while that budget still has requests it is not a wait at all.
  const reset = headers.get('x-ratelimit-remaining') === '0' ? headers.get('x-ratelimit-reset') : null
  const retryAfterSec = retryAfter === null ? NaN : Number(retryAfter)
  const resetSec = reset === null ? NaN : Number(reset)
  return {
    ...(Number.isFinite(retryAfterSec) && retryAfterSec >= 0 ? { retryAfterMs: retryAfterSec * 1000 } : {}),
    ...(Number.isFinite(resetSec) && resetSec > 0 ? { rateLimitResetAt: resetSec * 1000 } : {})
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
  /** Between read retries; injectable so tests do not wait out real delays. */
  sleep?: (ms: number) => Promise<void>
  /** The caller vouches this POST has no effect (a GraphQL query), so it repeats like a GET. */
  idempotent?: boolean
}

// A GET is the one verb safe to repeat blind; every write's retry belongs to its caller's fenced, marker-first loop.
// The first retry is immediate (a 502 or a reset is usually one bad hop); the second waits 300–600ms.
const READ_RETRY_DELAYS_MS = [0, 300]

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Unreachable or 5xx on a read; a timeout already spent its 10s and would only spend it again. */
function isTransientRead(err: unknown): boolean {
  if (!(err instanceof GithubApiError)) return false
  if (err.status >= 500) return true
  return err.status === 0 && (err.cause as { name?: string } | undefined)?.name !== 'TimeoutError'
}

/** One page of a paginated GitHub list: the body plus the `rel="next"` cursor. */
export interface GithubPage<T> {
  data: T
  /** Next page as a path under the SAME base — a `next` pointing anywhere else
   *  is dropped rather than followed. */
  nextPath?: string
}

/** `rel="next"` from a Link header, relative to `baseUrl`. */
function nextPathFrom(link: string | null, baseUrl: string): string | undefined {
  if (!link) return undefined
  for (const part of link.split(',')) {
    const url = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim())?.[1]
    if (url?.startsWith(baseUrl)) return url.slice(baseUrl.length)
  }
  return undefined
}

/** One GitHub REST call → parsed JSON. Throws `GithubApiError` on any non-2xx. */
export async function githubRequest<T>(path: string, opts: GithubRequestOpts): Promise<T> {
  return (await githubRequestPage<T>(path, opts)).data
}

/** {@link githubRequest} keeping the pagination cursor — for the list endpoints
 *  whose first page is not the whole answer. */
export async function githubRequestPage<T>(path: string, opts: GithubRequestOpts): Promise<GithubPage<T>> {
  const retries = (opts.method ?? 'GET') === 'GET' || opts.idempotent === true ? READ_RETRY_DELAYS_MS : []
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await githubRequestOnce<T>(path, opts)
    } catch (err) {
      // A rate limit names its own wait and stays the caller's; only the transient read class repeats here.
      const delay = retries[attempt]
      if (delay === undefined || !isTransientRead(err)) throw err
      await (opts.sleep ?? realSleep)(delay + Math.floor(Math.random() * delay))
    }
  }
}

async function githubRequestOnce<T>(path: string, opts: GithubRequestOpts): Promise<GithubPage<T>> {
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
    const unreachable = new GithubApiError(`github unreachable: ${(e as Error).message}`, 0, 'INTERNAL', true)
    unreachable.cause = e // the read-retry loop tells a timeout from a reset by it
    throw unreachable
  }
  if (res.ok) {
    const text = await res.text()
    const nextPath = nextPathFrom(res.headers.get('link'), opts.baseUrl ?? API_BASE)
    if (!text) return { data: undefined as T } // 202-style empty success (e.g. redelivery accepted)
    // Only `id` keys with ≥15 digits are re-quoted — small numeric ids
    // (repositories, installations) stay numbers for existing callers.
    const safe = opts.bigIdsAsStrings ? text.replace(/"id"\s*:\s*(\d{15,})/g, '"id":"$1"') : text
    return { data: JSON.parse(safe) as T, ...(nextPath ? { nextPath } : {}) }
  }

  // Read the message for diagnostics; GitHub error bodies carry no secrets.
  let detail = ''
  try {
    const body = (await res.json()) as { message?: string }
    detail = body.message ?? ''
  } catch {
    // non-JSON error body — status alone will do
  }

  // A primary limit is 403/429 with remaining 0; a secondary limit is 403/429 with `retry-after` and remaining still positive.
  const hint = retryHintFrom(res.headers)
  const rateLimited =
    res.status === 429 ||
    (res.status === 403 &&
      (hint.retryAfterMs !== undefined ||
        res.headers.get('x-ratelimit-remaining') === '0' ||
        /rate limit/i.test(detail)))
  if (rateLimited) {
    throw new GithubApiError(`github rate limited: ${detail}`, res.status, 'RATE_LIMITED', true, hint)
  }
  // 404 (installation gone / repo out of the grant set) and 422 (narrowing to a
  // repo the installation can't reach) are operator-recoverable denials.
  if (res.status === 404 || res.status === 422 || res.status === 403) {
    throw new GithubApiError(`github denied (${res.status}): ${detail}`, res.status, 'LEASE_DENIED', false)
  }
  // 401 = our own JWT/key is wrong (misconfig) — internal, not retryable-by-daemon.
  throw new GithubApiError(`github error (${res.status}): ${detail}`, res.status, 'INTERNAL', res.status >= 500, hint)
}

// One GraphQL query/mutation → its `data` — for facts with no REST equivalent (thread resolution
// state, `resolveReviewThread`, `enablePullRequestAutoMerge`). `strictErrors` is for MUTATIONS:
// GitHub rejects one as `{ data: { <mutation>: null }, errors: [...] }` — truthy data beside the
// refusal — and reporting that as success would claim a write that never happened.
export async function githubGraphql<T>(
  query: string,
  variables: Record<string, unknown>,
  opts: Omit<GithubRequestOpts, 'method' | 'body'> & { strictErrors?: boolean }
): Promise<T> {
  // GraphQL failures ride inside a 200, so `errors` decides here — the REST status mapping cannot.
  const res = await githubRequest<{ data?: T | null; errors?: Array<{ type?: string; message?: string }> }>(
    '/graphql',
    { ...opts, method: 'POST', body: { query, variables } }
  )
  // Partial data beats a thrown read: a field-level denial degrades that field, not the whole answer.
  if (res?.data && !(opts.strictErrors && res.errors?.length)) return res.data
  const errors = res?.errors ?? []
  if (errors.length > 0) {
    const detail = errors.map((e) => e.message ?? e.type ?? 'unknown').join('; ')
    // GitHub's GraphQL primary rate limit is a 200 with `errors[].type === 'RATE_LIMITED'`.
    if (errors.some((e) => e.type === 'RATE_LIMITED')) {
      throw new GithubApiError(`github graphql rate limited: ${detail}`, 200, 'RATE_LIMITED', true)
    }
    // Authorization and missing-node failures — the denial REST would have answered 404/403 with.
    const denied = errors.some((e) => e.type === 'FORBIDDEN' || e.type === 'NOT_FOUND')
    throw new GithubApiError(
      `github graphql ${denied ? 'denied' : 'error'}: ${detail}`,
      200,
      denied ? 'LEASE_DENIED' : 'INTERNAL',
      false
    )
  }
  // `data` absent with no `errors` is a contract violation, not a partial answer.
  throw new GithubApiError('github graphql returned no data', 200, 'INTERNAL', false)
}
