// The Bot Connector REST calls a Teams bot makes (teams-integration.md §2, §4.3): a client-credentials token and activity writes at the conversation's serviceUrl.

/** The scope every Bot Connector token names; the token endpoint is the bot's own tenant's (§2). */
export const MSTEAMS_TOKEN_SCOPE = 'https://api.botframework.com/.default'
/** Renew the token this far before it expires, so no call races its expiry. */
export const MSTEAMS_TOKEN_RENEW_MARGIN_MS = 5 * 60_000
/** The Markdown dialect every send and edit names (§4.3). */
export const MSTEAMS_TEXT_FORMAT = 'extendedmarkdown'

const REQUEST_TIMEOUT_MS = 15_000
const MAX_ATTEMPTS = 4
const RETRY_BASE_MS = 1_000
const RETRY_WAIT_CAP_MS = 10_000

/** The tenant's Entra token endpoint; the tenant is the bot registration's, never the activity's. */
export function msTeamsTokenEndpoint(tenantId: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`
}

/** Why a call failed; `ambiguous` means the write may have landed. */
export type MsTeamsFailureKind =
  | 'credential_rejected'
  | 'not_installed'
  | 'writes_blocked'
  | 'forbidden'
  | 'not_found'
  | 'invalid'
  | 'rate_limited'
  | 'unavailable'
  | 'ambiguous'

/** A refused or unanswered call; its message names the status and Microsoft's error code, never a credential. */
export class MsTeamsApiError extends Error {
  constructor(
    message: string,
    readonly kind: MsTeamsFailureKind,
    readonly status?: number,
    readonly code?: string,
    readonly retryAfterMs?: number
  ) {
    super(message)
    this.name = 'MsTeamsApiError'
  }

  /** A refusal no retry or later write into the same conversation can change (§3). */
  get permanent(): boolean {
    return this.kind === 'not_installed' || this.kind === 'writes_blocked' || this.kind === 'credential_rejected'
  }
}

/** Where a conversation's writes go: the regional origin its latest activity carried, and its raw ID. */
export interface MsTeamsTarget {
  serviceUrl: string
  conversationId: string
}

export interface MsTeamsCredentials {
  appId: string
  tenantId: string
  clientSecret: string
}

export interface MsTeamsApiOptions {
  fetchImpl?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

/** The activities URL under a recorded serviceUrl; the conversation ID is encoded because a channel's carries `;messageid=`. */
export function msTeamsActivitiesUrl(serviceUrl: string, conversationId: string, activityId?: string): string {
  let base: URL
  try {
    base = new URL(serviceUrl.endsWith('/') ? serviceUrl : `${serviceUrl}/`)
  } catch {
    throw new MsTeamsApiError('the conversation has no usable service URL', 'invalid')
  }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash)
    throw new MsTeamsApiError('the conversation has no usable service URL', 'invalid')
  const path = `v3/conversations/${encodeURIComponent(conversationId)}/activities${activityId ? `/${encodeURIComponent(activityId)}` : ''}`
  return new URL(path, base).toString()
}

/** `Retry-After` as delta-seconds or an HTTP date; undefined leaves the caller's own backoff. */
function retryAfterMs(res: Response, now: number): number | undefined {
  const raw = res.headers?.get?.('retry-after')
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(raw)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

async function readJson(res: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await res.json()
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** Microsoft's `{ error: { code, message } }`, bounded. */
function errorOf(body: Record<string, unknown> | undefined): { code?: string; message?: string } {
  const error = body?.error as { code?: unknown; message?: unknown } | undefined
  return {
    ...(typeof error?.code === 'string' && error.code ? { code: error.code.slice(0, 100) } : {}),
    ...(typeof error?.message === 'string' && error.message ? { message: error.message.slice(0, 200) } : {})
  }
}

function classify(status: number, code?: string, message?: string): MsTeamsFailureKind {
  if (status === 401) return 'credential_rejected'
  if (status === 403 && code === 'MessageWritesBlocked') return 'writes_blocked'
  if (status === 403 && code === 'BadArgument' && /not installed/i.test(message ?? '')) return 'not_installed'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 429 || status === 412) return 'rate_limited'
  if (status === 502 || status === 504) return 'ambiguous'
  if (status >= 500) return 'unavailable'
  return 'invalid'
}

/** One bot's Bot Connector client: a cached token and activity writes with bounded retries. */
export class MsTeamsApi {
  private cached: { token: string; expiresAtMs: number } | undefined
  private minting: Promise<string> | undefined
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly random: () => number

  constructor(
    private readonly credentials: MsTeamsCredentials,
    options: MsTeamsApiOptions = {}
  ) {
    this.fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
    this.now = options.now ?? (() => Date.now())
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.random = options.random ?? (() => Math.random())
  }

  /** A live token: the cache until five minutes before expiry, else one shared request. */
  async token(): Promise<string> {
    if (this.cached && this.cached.expiresAtMs - this.now() > MSTEAMS_TOKEN_RENEW_MARGIN_MS) return this.cached.token
    this.minting ??= this.mint().finally(() => {
      this.minting = undefined
    })
    return await this.minting
  }

  private async mint(): Promise<string> {
    const { appId, tenantId, clientSecret } = this.credentials
    let res: Response
    try {
      res = await this.fetchImpl(msTeamsTokenEndpoint(tenantId), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: appId,
          client_secret: clientSecret,
          scope: MSTEAMS_TOKEN_SCOPE
        }).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
    } catch {
      throw new MsTeamsApiError('msteams: the token endpoint did not answer', 'unavailable')
    }
    const body = await readJson(res)
    if (!res.ok) {
      const code = typeof body?.error === 'string' ? body.error.slice(0, 100) : undefined
      // A 4xx names the app, tenant or secret (`invalid_client`); anything else is Entra's side (§2).
      const kind: MsTeamsFailureKind = res.status >= 400 && res.status < 500 ? 'credential_rejected' : 'unavailable'
      throw new MsTeamsApiError(
        `msteams: the token endpoint refused the client credentials (HTTP ${res.status}${code ? ` ${code}` : ''})`,
        kind,
        res.status,
        code
      )
    }
    const token = typeof body?.access_token === 'string' ? body.access_token : undefined
    if (!token) throw new MsTeamsApiError('msteams: the token endpoint answered without a token', 'unavailable')
    const expiresIn = typeof body?.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3_600
    this.cached = { token, expiresAtMs: this.now() + expiresIn * 1000 }
    return token
  }

  /** Post a message activity; answers the activity ID Teams assigned, which a quote of it names (§4.1). */
  async postActivity(target: MsTeamsTarget, activity: Record<string, unknown>): Promise<string> {
    const body = await this.request('POST', msTeamsActivitiesUrl(target.serviceUrl, target.conversationId), activity)
    const id = typeof body.id === 'string' && body.id ? body.id : undefined
    if (!id) throw new MsTeamsApiError('msteams: a send answered without an activity ID', 'ambiguous')
    return id
  }

  /** Replace a posted activity in place. */
  async updateActivity(target: MsTeamsTarget, activityId: string, activity: Record<string, unknown>): Promise<void> {
    const url = msTeamsActivitiesUrl(target.serviceUrl, target.conversationId, activityId)
    await this.request('PUT', url, { ...activity, id: activityId })
  }

  /** Delete a posted activity; one already gone counts as deleted. */
  async deleteActivity(target: MsTeamsTarget, activityId: string): Promise<void> {
    try {
      await this.request('DELETE', msTeamsActivitiesUrl(target.serviceUrl, target.conversationId, activityId))
    } catch (err) {
      if (!(err instanceof MsTeamsApiError && err.kind === 'not_found')) throw err
    }
  }

  /** One call: 429 and 412 retry for every method, 502, 504 and no answer only for the idempotent PUT and DELETE, honoring `Retry-After`. */
  private async request(
    method: 'POST' | 'PUT' | 'DELETE',
    url: string,
    body?: unknown
  ): Promise<Record<string, unknown>> {
    let refreshed = false
    for (let attempt = 1; ; attempt += 1) {
      const token = await this.token()
      let err: MsTeamsApiError
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            ...(body !== undefined ? { 'content-type': 'application/json' } : {})
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        })
        if (res.ok) return (await readJson(res)) ?? {}
        // One 401 may be a token that aged out under us: drop it and try once with a fresh one.
        if (res.status === 401 && !refreshed) {
          refreshed = true
          this.cached = undefined
          continue
        }
        const { code, message } = errorOf(await readJson(res))
        err = new MsTeamsApiError(
          `msteams: ${method} activity failed (HTTP ${res.status}${code ? ` ${code}` : ''})`,
          classify(res.status, code, message),
          res.status,
          code,
          retryAfterMs(res, this.now())
        )
      } catch (thrown) {
        if (thrown instanceof MsTeamsApiError) throw thrown
        err = new MsTeamsApiError(`msteams: ${method} activity did not answer`, 'ambiguous')
      }
      // A POST that may have landed is never sent again: a duplicate message is worse than a missing one.
      const retry = err.kind === 'rate_limited' || (method !== 'POST' && err.kind === 'ambiguous')
      if (!retry || attempt >= MAX_ATTEMPTS) throw err
      const backoff = err.retryAfterMs ?? RETRY_BASE_MS * 2 ** (attempt - 1) * (1 + this.random() * 0.25)
      await this.sleep(Math.min(backoff, RETRY_WAIT_CAP_MS))
    }
  }
}
