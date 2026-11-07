// The Bot Connector REST calls a Teams bot makes (teams-integration.md §2, §4.3, §8.5): straight to Microsoft with the bot's own secret, or through the relay for the deployment app.
import {
  MSTEAMS_PLATFORM,
  WireMsTeamsCallResult,
  type RdPlatformReply,
  type WireMsTeamsCall
} from '@agentconnect.md/protocol'
import { PlatformRelayUnsent, type PlatformRelay } from '../platform-relay.js'

/** The scope every Bot Connector token names; the token endpoint is the bot's own tenant's (§2). */
export const MSTEAMS_TOKEN_SCOPE = 'https://api.botframework.com/.default'
/** The scope of an app-only Microsoft Graph token, minted in the tenant whose resource-specific consent it carries. */
export const MSTEAMS_GRAPH_SCOPE = 'https://graph.microsoft.com/.default'
/** Renew the token this far before it expires, so no call races its expiry. */
export const MSTEAMS_TOKEN_RENEW_MARGIN_MS = 5 * 60_000
/** The Markdown dialect every send and edit names (§4.3). */
export const MSTEAMS_TEXT_FORMAT = 'extendedmarkdown'

const REQUEST_TIMEOUT_MS = 15_000
const MEMBERS_PAGE_SIZE = 100
const MAX_ATTEMPTS = 4
const RETRY_BASE_MS = 1_000
const RETRY_WAIT_CAP_MS = 10_000
/** The longest server-given `Retry-After` honored; a longer cooldown fails the write rather than retrying before it ends. */
export const MSTEAMS_MAX_RETRY_AFTER_MS = 60_000
/** A write's whole budget in its conversation queue: every attempt's timeout plus the longest honored waits between them. */
export const MSTEAMS_WRITE_TIMEOUT_MS =
  MAX_ATTEMPTS * REQUEST_TIMEOUT_MS + (MAX_ATTEMPTS - 1) * MSTEAMS_MAX_RETRY_AFTER_MS

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
    readonly retryAfterMs?: number,
    /** Nothing left the daemon, so even a post may be tried again. */
    readonly unsent = false
  ) {
    super(message)
    this.name = 'MsTeamsApiError'
  }

  /** A refusal no retry or later write into the same conversation can change (§3). */
  get permanent(): boolean {
    return this.kind === 'not_installed' || this.kind === 'writes_blocked' || this.kind === 'credential_rejected'
  }
}

/** Where a conversation's writes go: the regional origin its latest activity carried, its raw ID, and the relay's ticket for it on a deployment app's row (§8.5). */
export interface MsTeamsTarget {
  serviceUrl: string
  conversationId: string
  ticket?: string
}

export interface MsTeamsCredentials {
  appId: string
  tenantId: string
  clientSecret: string
}

export interface MsTeamsApiOptions {
  /** The token scope; absent, the Bot Connector's. */
  scope?: string
  fetchImpl?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

/** The team's channels URL under a recorded serviceUrl, which the bot reads with its own token (no Graph permission). */
export function msTeamsTeamChannelsUrl(serviceUrl: string, teamId: string): string {
  return new URL(`v3/teams/${encodeURIComponent(teamId)}/conversations`, serviceBase(serviceUrl)).toString()
}

/** The team's details URL under a recorded serviceUrl; it names the team's Microsoft 365 group, which Graph addresses it by. */
export function msTeamsTeamUrl(serviceUrl: string, teamId: string): string {
  return new URL(`v3/teams/${encodeURIComponent(teamId)}`, serviceBase(serviceUrl)).toString()
}

/** A Teams channel's membership type as its team's channel list reports it. */
export const MSTEAMS_CHANNEL_KINDS = ['standard', 'private', 'shared'] as const
export type MsTeamsChannelKind = (typeof MSTEAMS_CHANNEL_KINDS)[number]

/** One conversation member as the Bot Connector answers: `userRole` tells a guest, `tenantId` another organization. */
export interface MsTeamsMember {
  id: string
  aadObjectId?: string
  name?: string
  userRole?: string
  tenantId?: string
}

function memberOf(entry: unknown): MsTeamsMember | undefined {
  const raw = (entry ?? {}) as Record<string, unknown>
  const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
  const id = text(raw.id)
  if (!id) return undefined
  const aadObjectId = text(raw.aadObjectId)
  const name = text(raw.name)
  const userRole = text(raw.userRole)
  const tenantId = text(raw.tenantId)
  return {
    id,
    ...(aadObjectId ? { aadObjectId } : {}),
    ...(name ? { name } : {}),
    ...(userRole ? { userRole } : {}),
    ...(tenantId ? { tenantId } : {})
  }
}

/** One member of a conversation under a recorded serviceUrl. */
export function msTeamsConversationMemberUrl(serviceUrl: string, conversationId: string, memberId: string): string {
  const path = `v3/conversations/${encodeURIComponent(conversationId)}/members/${encodeURIComponent(memberId)}`
  return new URL(path, serviceBase(serviceUrl)).toString()
}

/** One page of a conversation's members under a recorded serviceUrl, read with the bot's own token. */
export function msTeamsPagedMembersUrl(serviceUrl: string, conversationId: string, continuationToken?: string): string {
  const url = new URL(`v3/conversations/${encodeURIComponent(conversationId)}/pagedmembers`, serviceBase(serviceUrl))
  url.searchParams.set('pageSize', String(MEMBERS_PAGE_SIZE))
  if (continuationToken) url.searchParams.set('continuationToken', continuationToken)
  return url.toString()
}

// A recorded serviceUrl as a base, refused unless it is a plain https origin and path.
function serviceBase(serviceUrl: string): URL {
  let base: URL
  try {
    base = new URL(serviceUrl.endsWith('/') ? serviceUrl : `${serviceUrl}/`)
  } catch {
    throw new MsTeamsApiError('the conversation has no usable service URL', 'invalid')
  }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash)
    throw new MsTeamsApiError('the conversation has no usable service URL', 'invalid')
  return base
}

/** The URL that opens a conversation, a 1:1 chat with one member included. */
export function msTeamsConversationsUrl(serviceUrl: string): string {
  return new URL('v3/conversations', serviceBase(serviceUrl)).toString()
}

/** The activities URL under a recorded serviceUrl; the conversation ID is encoded because a channel's carries `;messageid=`. */
export function msTeamsActivitiesUrl(serviceUrl: string, conversationId: string, activityId?: string): string {
  const base = serviceBase(serviceUrl)
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

/** A live bearer token; `invalidate` drops one a 401 says aged out. */
export interface MsTeamsTokenSource {
  token(): Promise<string>
  invalidate(): void
}

// One minted token held until five minutes before expiry; concurrent callers share one request.
abstract class CachedToken implements MsTeamsTokenSource {
  private cached: { token: string; expiresAtMs: number } | undefined
  private minting: Promise<string> | undefined

  constructor(protected readonly now: () => number) {}

  async token(): Promise<string> {
    if (this.cached && this.cached.expiresAtMs - this.now() > MSTEAMS_TOKEN_RENEW_MARGIN_MS) return this.cached.token
    this.minting ??= this.mint()
      .then(({ token, expiresInSec }) => {
        this.cached = { token, expiresAtMs: this.now() + expiresInSec * 1000 }
        return token
      })
      .finally(() => {
        this.minting = undefined
      })
    return await this.minting
  }

  invalidate(): void {
    this.cached = undefined
  }

  protected abstract mint(): Promise<{ token: string; expiresInSec: number }>
}

// Read Entra's token answer, naming a 4xx as the credential's failure and anything else as Entra's.
function tokenAnswer(status: number, ok: boolean, body: Record<string, unknown> | undefined) {
  if (!ok) {
    const code = typeof body?.error === 'string' ? body.error.slice(0, 100) : undefined
    const kind: MsTeamsFailureKind = status >= 400 && status < 500 ? 'credential_rejected' : 'unavailable'
    throw new MsTeamsApiError(
      `msteams: the token endpoint refused the client credentials (HTTP ${status}${code ? ` ${code}` : ''})`,
      kind,
      status,
      code
    )
  }
  const token = typeof body?.access_token === 'string' ? body.access_token : undefined
  if (!token) throw new MsTeamsApiError('msteams: the token endpoint answered without a token', 'unavailable')
  const expiresInSec = typeof body?.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3_600
  return { token, expiresInSec }
}

/** A client-credentials token minted with the bot's own secret in its own tenant (§2). */
export class MsTeamsClientCredentials extends CachedToken {
  constructor(
    private readonly credentials: MsTeamsCredentials,
    private readonly scope: string,
    private readonly fetchImpl: typeof fetch,
    now: () => number
  ) {
    super(now)
  }

  protected async mint(): Promise<{ token: string; expiresInSec: number }> {
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
          scope: this.scope
        }).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
    } catch {
      throw new MsTeamsApiError('msteams: the token endpoint did not answer', 'unavailable')
    }
    return tokenAnswer(res.status, res.ok, await readJson(res))
  }
}

/** How a deployment app's row reaches its relay: one `rd/platform/request` for its bot (§8.5). */
export interface MsTeamsRelayPort {
  /** Rejects with an `unsent` {@link MsTeamsApiError} when no relay could take the request, or an `ambiguous` one when it went unanswered. */
  request(botId: string, call: WireMsTeamsCall): Promise<RdPlatformReply>
}

/** The daemon's relays as a Teams row's port: no relay to take a call is unsent, an unanswered one may have reached Microsoft. */
export function msTeamsRelayPort(relay: PlatformRelay): MsTeamsRelayPort {
  return {
    request: async (botId, call) => {
      try {
        return await relay.request({ platformId: MSTEAMS_PLATFORM, botId, payload: call })
      } catch (err) {
        if (err instanceof PlatformRelayUnsent)
          throw new MsTeamsApiError(
            'msteams: no relay is reachable',
            'unavailable',
            undefined,
            undefined,
            undefined,
            true
          )
        throw new MsTeamsApiError('msteams: the relay did not answer', 'ambiguous')
      }
    }
  }
}

// A relay refusal is final for the request; `unavailable` means nothing reached Microsoft.
function relayAnswer(reply: RdPlatformReply): WireMsTeamsCallResult {
  if (reply.outcome === 'unavailable')
    throw new MsTeamsApiError(
      'msteams: the relay could not reach Microsoft',
      'unavailable',
      undefined,
      undefined,
      undefined,
      true
    )
  // A refusal the relays' assignments may still lift is retried as unsent, a bounded number of times; nothing reached Microsoft.
  if (reply.outcome === 'refused')
    throw new MsTeamsApiError(
      `msteams: the relay refused the call (${reply.reason ?? 'refused'})`,
      reply.retryable ? 'unavailable' : 'forbidden',
      undefined,
      undefined,
      undefined,
      reply.retryable === true
    )
  const parsed = WireMsTeamsCallResult.safeParse(reply.payload)
  if (!parsed.success) throw new MsTeamsApiError('msteams: the relay answered an unreadable result', 'ambiguous')
  return parsed.data
}

/** An app-only Graph token for the row's own tenant, minted by the relay, which holds the deployment app's secret (§8.5). */
export class MsTeamsRelayGraphToken extends CachedToken {
  constructor(
    private readonly port: MsTeamsRelayPort,
    private readonly botId: string,
    now: () => number
  ) {
    super(now)
  }

  protected async mint(): Promise<{ token: string; expiresInSec: number }> {
    const result = relayAnswer(await this.port.request(this.botId, { op: 'graph-token' }))
    return tokenAnswer(result.status, result.status >= 200 && result.status < 300, result.body)
  }
}

/** One Bot Connector call as the daemon names it; a team's calls name the team as the target's conversation. */
export type MsTeamsConnectorCall =
  | { op: 'post-activity'; target: MsTeamsTarget; activity: Record<string, unknown> }
  | { op: 'update-activity'; target: MsTeamsTarget; activityId: string; activity: Record<string, unknown> }
  | { op: 'delete-activity'; target: MsTeamsTarget; activityId: string }
  | { op: 'get-member'; target: MsTeamsTarget; memberId: string }
  | { op: 'get-paged-members'; target: MsTeamsTarget; continuationToken?: string }
  | { op: 'get-team'; target: MsTeamsTarget }
  | { op: 'get-team-conversations'; target: MsTeamsTarget }
  | { op: 'create-conversation'; target: MsTeamsTarget; memberId: string; tenantId: string; botId: string }

/** One answer: Microsoft's status and body, and the relay's tickets for conversations the answer named. */
export type MsTeamsAnswer = WireMsTeamsCallResult

/** How the bot's Bot Connector calls leave the daemon: directly with its own token, or through the relay. */
export interface MsTeamsConnector {
  /** One attempt; rejects with an {@link MsTeamsApiError} when nothing answered. */
  send(call: MsTeamsConnectorCall): Promise<MsTeamsAnswer>
  /** Drop a token a 401 may have aged out; the relay keeps its own. */
  invalidate(): void
  /** Prove the credential at start where the daemon holds one. */
  warm(): Promise<void>
}

const methodOf = (op: MsTeamsConnectorCall['op']): 'GET' | 'POST' | 'PUT' | 'DELETE' =>
  op === 'post-activity' || op === 'create-conversation'
    ? 'POST'
    : op === 'update-activity'
      ? 'PUT'
      : op === 'delete-activity'
        ? 'DELETE'
        : 'GET'

// The URL and body a call makes under its target's recorded serviceUrl.
function directRequest(call: MsTeamsConnectorCall): { url: string; body?: unknown } {
  const { serviceUrl, conversationId } = call.target
  switch (call.op) {
    case 'post-activity':
      return { url: msTeamsActivitiesUrl(serviceUrl, conversationId), body: call.activity }
    case 'update-activity':
      return {
        url: msTeamsActivitiesUrl(serviceUrl, conversationId, call.activityId),
        body: { ...call.activity, id: call.activityId }
      }
    case 'delete-activity':
      return { url: msTeamsActivitiesUrl(serviceUrl, conversationId, call.activityId) }
    case 'get-member':
      return { url: msTeamsConversationMemberUrl(serviceUrl, conversationId, call.memberId) }
    case 'get-paged-members':
      return { url: msTeamsPagedMembersUrl(serviceUrl, conversationId, call.continuationToken) }
    case 'get-team':
      return { url: msTeamsTeamUrl(serviceUrl, conversationId) }
    case 'get-team-conversations':
      return { url: msTeamsTeamChannelsUrl(serviceUrl, conversationId) }
    case 'create-conversation':
      return {
        url: msTeamsConversationsUrl(serviceUrl),
        body: {
          isGroup: false,
          bot: { id: call.botId },
          members: [{ id: call.memberId }],
          tenantId: call.tenantId,
          channelData: { tenant: { id: call.tenantId } }
        }
      }
  }
}

// One HTTP exchange with a bearer token; no answer at all may mean the write landed.
async function fetchAnswer(
  fetchImpl: typeof fetch,
  method: string,
  url: string,
  token: string,
  body: unknown,
  now: () => number
): Promise<MsTeamsAnswer> {
  let res: Response
  try {
    res = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch {
    throw new MsTeamsApiError(`msteams: ${method} request did not answer`, 'ambiguous')
  }
  const json = await readJson(res)
  const wait = retryAfterMs(res, now())
  return { status: res.status, ...(json ? { body: json } : {}), ...(wait !== undefined ? { retryAfterMs: wait } : {}) }
}

/** Calls made straight to Microsoft with the bot's own token (an organization's own bot). */
export function directMsTeamsConnector(
  tokens: MsTeamsTokenSource,
  fetchImpl: typeof fetch,
  now: () => number
): MsTeamsConnector {
  return {
    send: async (call) => {
      const { url, body } = directRequest(call)
      return await fetchAnswer(fetchImpl, methodOf(call.op), url, await tokens.token(), body, now)
    },
    invalidate: () => tokens.invalidate(),
    warm: async () => {
      await tokens.token()
    }
  }
}

/** Calls the relay makes with the deployment app's token, each carrying the relay's ticket for its conversation (§8.5). */
export function relayMsTeamsConnector(port: MsTeamsRelayPort, botId: string): MsTeamsConnector {
  return {
    send: async (call) => {
      const ticket = call.target.ticket
      // A conversation from before the relay ticketed it is reachable again after its next activity (§8.5).
      if (!ticket) throw new MsTeamsApiError('msteams: the relay has not ticketed this conversation yet', 'forbidden')
      return relayAnswer(await port.request(botId, wireCall(call, ticket)))
    },
    invalidate: () => {},
    warm: async () => {}
  }
}

function wireCall(call: MsTeamsConnectorCall, ticket: string): WireMsTeamsCall {
  const conversationId = call.target.conversationId
  switch (call.op) {
    case 'post-activity':
      return { op: call.op, ticket, conversationId, activity: call.activity }
    case 'update-activity':
      return { op: call.op, ticket, conversationId, activityId: call.activityId, activity: call.activity }
    case 'delete-activity':
      return { op: call.op, ticket, conversationId, activityId: call.activityId }
    case 'get-member':
      return { op: call.op, ticket, conversationId, memberId: call.memberId }
    case 'get-paged-members':
      return {
        op: call.op,
        ticket,
        conversationId,
        ...(call.continuationToken ? { continuationToken: call.continuationToken } : {})
      }
    case 'get-team':
    case 'get-team-conversations':
      return { op: call.op, ticket, teamId: conversationId }
    case 'create-conversation':
      // The relay names the bot and the row's tenant itself.
      return { op: call.op, ticket, memberId: call.memberId }
  }
}

interface RetryDeps {
  now: () => number
  sleep: (ms: number) => Promise<void>
  random: () => number
}

// One call with bounded retries: 429 and 412 for every method, 502, 504 and no answer only for the idempotent GET, PUT and DELETE, anything unsent always; `Retry-After` is honored.
async function withRetries(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  attemptOnce: () => Promise<MsTeamsAnswer>,
  invalidate: () => void,
  deps: RetryDeps
): Promise<MsTeamsAnswer> {
  let refreshed = false
  for (let attempt = 1; ; attempt += 1) {
    let err: MsTeamsApiError
    try {
      const answer = await attemptOnce()
      if (answer.status >= 200 && answer.status < 300) return answer
      // One 401 may be a token that aged out under us: drop it and try once with a fresh one.
      if (answer.status === 401 && !refreshed) {
        refreshed = true
        invalidate()
        continue
      }
      const { code, message } = errorOf(answer.body)
      err = new MsTeamsApiError(
        `msteams: ${method} request failed (HTTP ${answer.status}${code ? ` ${code}` : ''})`,
        classify(answer.status, code, message),
        answer.status,
        code,
        answer.retryAfterMs
      )
    } catch (thrown) {
      if (!(thrown instanceof MsTeamsApiError) || (!thrown.unsent && thrown.kind !== 'ambiguous')) throw thrown
      err = thrown
    }
    // A POST that may have landed is never sent again: a duplicate message is worse than a missing one.
    const retry = err.unsent || err.kind === 'rate_limited' || (method !== 'POST' && err.kind === 'ambiguous')
    if (!retry || attempt >= MAX_ATTEMPTS) throw err
    // The server's deadline is honored in full, since retrying earlier only spends attempts; only our own backoff is capped.
    if (err.retryAfterMs !== undefined && err.retryAfterMs > MSTEAMS_MAX_RETRY_AFTER_MS) throw err
    const backoff =
      err.retryAfterMs ?? Math.min(RETRY_BASE_MS * 2 ** (attempt - 1) * (1 + deps.random() * 0.25), RETRY_WAIT_CAP_MS)
    await deps.sleep(backoff)
  }
}

function retryDeps(options: MsTeamsApiOptions): RetryDeps {
  return {
    now: options.now ?? (() => Date.now()),
    sleep: options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    random: options.random ?? (() => Math.random())
  }
}

/** What a Graph client needs: one retried JSON read. */
export interface MsTeamsReader {
  read(url: string): Promise<Record<string, unknown>>
}

/** Graph reads with an app-only token for the row's tenant, from its own secret or from the relay (§8.5). */
export class MsTeamsGraphReader implements MsTeamsReader {
  private readonly fetchImpl: typeof fetch
  private readonly deps: RetryDeps

  constructor(
    private readonly tokens: MsTeamsTokenSource,
    options: MsTeamsApiOptions = {}
  ) {
    this.fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
    this.deps = retryDeps(options)
  }

  async read(url: string): Promise<Record<string, unknown>> {
    const answer = await withRetries(
      'GET',
      async () => fetchAnswer(this.fetchImpl, 'GET', url, await this.tokens.token(), undefined, this.deps.now),
      () => this.tokens.invalidate(),
      this.deps
    )
    return answer.body ?? {}
  }
}

/** One bot's Bot Connector client: activity writes, team and member reads, and 1:1 chats, with bounded retries. */
export class MsTeamsApi {
  private readonly connector: MsTeamsConnector
  private readonly deps: RetryDeps

  constructor(source: MsTeamsCredentials | MsTeamsConnector, options: MsTeamsApiOptions = {}) {
    this.deps = retryDeps(options)
    const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
    this.connector =
      'send' in source
        ? source
        : directMsTeamsConnector(
            new MsTeamsClientCredentials(source, options.scope ?? MSTEAMS_TOKEN_SCOPE, fetchImpl, this.deps.now),
            fetchImpl,
            this.deps.now
          )
  }

  /** Prove the credential where the daemon holds one: a token warmed at start (§2). */
  async warm(): Promise<void> {
    await this.connector.warm()
  }

  /** Post a message activity; answers the activity ID Teams assigned, which a quote of it names (§4.1). */
  async postActivity(target: MsTeamsTarget, activity: Record<string, unknown>): Promise<string> {
    const body = await this.call({ op: 'post-activity', target, activity })
    const id = typeof body.id === 'string' && body.id ? body.id : undefined
    if (!id) throw new MsTeamsApiError('msteams: a send answered without an activity ID', 'ambiguous')
    return id
  }

  /** Replace a posted activity in place. */
  async updateActivity(target: MsTeamsTarget, activityId: string, activity: Record<string, unknown>): Promise<void> {
    await this.call({ op: 'update-activity', target, activityId, activity })
  }

  /** A team's channels by ID; Teams names every channel but the default one, which it answers unnamed; the relay tickets each. */
  async teamChannels(
    team: MsTeamsTarget
  ): Promise<{ id: string; name?: string; kind?: MsTeamsChannelKind; ticket?: string }[]> {
    const answer = await this.exchange({ op: 'get-team-conversations', target: team })
    const body = answer.body ?? {}
    const list = Array.isArray(body.conversations) ? (body.conversations as unknown[]) : []
    return list.flatMap((entry) => {
      const { id, name, type } = (entry ?? {}) as { id?: unknown; name?: unknown; type?: unknown }
      if (typeof id !== 'string' || !id) return []
      const kind = MSTEAMS_CHANNEL_KINDS.find((k) => k === type)
      const ticket = answer.tickets?.[id]
      return [
        {
          id,
          ...(typeof name === 'string' && name ? { name } : {}),
          ...(kind ? { kind } : {}),
          ...(ticket ? { ticket } : {})
        }
      ]
    })
  }

  /** A team's details: its display name and its Microsoft 365 group ID, read with the bot's own token. */
  async teamDetails(team: MsTeamsTarget): Promise<{ name?: string; aadGroupId?: string }> {
    const body = await this.call({ op: 'get-team', target: team })
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    return {
      ...(name ? { name } : {}),
      ...(typeof body.aadGroupId === 'string' ? { aadGroupId: body.aadGroupId } : {})
    }
  }

  /** A team's Microsoft 365 group ID, which Graph addresses the team by; the activity's team ID is its thread ID. */
  async teamGroupId(team: MsTeamsTarget): Promise<string> {
    const id = (await this.teamDetails(team)).aadGroupId ?? ''
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new MsTeamsApiError('msteams: the team answered without its group ID', 'invalid')
    return id
  }

  /** A conversation's members, up to `max`; a shared channel refuses the bot this read (measured: HTTP 403). */
  async conversationMembers(
    target: MsTeamsTarget,
    max: number
  ): Promise<{ members: MsTeamsMember[]; complete: boolean }> {
    const members: MsTeamsMember[] = []
    let token: string | undefined
    do {
      const body = await this.call({
        op: 'get-paged-members',
        target,
        ...(token ? { continuationToken: token } : {})
      })
      for (const entry of Array.isArray(body.members) ? (body.members as unknown[]) : []) {
        const member = memberOf(entry)
        if (member) members.push(member)
      }
      token = typeof body.continuationToken === 'string' && body.continuationToken ? body.continuationToken : undefined
    } while (token && members.length < max)
    return { members: members.slice(0, max), complete: !token && members.length <= max }
  }

  /** One person's membership of a conversation, by `29:` or Entra object ID; undefined when they are not a member. */
  async conversationMember(target: MsTeamsTarget, memberId: string): Promise<MsTeamsMember | undefined> {
    try {
      return memberOf(await this.call({ op: 'get-member', target, memberId }))
    } catch (err) {
      if (err instanceof MsTeamsApiError && err.kind === 'not_found') return undefined
      throw err
    }
  }

  /** The bot's 1:1 chat with a member by their `29:` ID, opened or found under `at`'s serviceUrl, and the relay's ticket for it; by Entra object ID Teams refuses anyone who has not installed the app themselves (measured). */
  async openDirectConversation(
    at: MsTeamsTarget,
    memberId: string,
    tenantId: string,
    botId: string
  ): Promise<{ id: string; ticket?: string }> {
    const answer = await this.exchange({ op: 'create-conversation', target: at, memberId, tenantId, botId })
    const id = typeof answer.body?.id === 'string' && answer.body.id ? answer.body.id : undefined
    if (!id) throw new MsTeamsApiError('msteams: opening a chat answered without its conversation ID', 'ambiguous')
    const ticket = answer.tickets?.[id]
    return { id, ...(ticket ? { ticket } : {}) }
  }

  /** Delete a posted activity; one already gone counts as deleted. */
  async deleteActivity(target: MsTeamsTarget, activityId: string): Promise<void> {
    try {
      await this.call({ op: 'delete-activity', target, activityId })
    } catch (err) {
      if (!(err instanceof MsTeamsApiError && err.kind === 'not_found')) throw err
    }
  }

  private async call(call: MsTeamsConnectorCall): Promise<Record<string, unknown>> {
    return (await this.exchange(call)).body ?? {}
  }

  private async exchange(call: MsTeamsConnectorCall): Promise<MsTeamsAnswer> {
    return await withRetries(
      methodOf(call.op),
      () => this.connector.send(call),
      () => this.connector.invalidate(),
      this.deps
    )
  }
}
