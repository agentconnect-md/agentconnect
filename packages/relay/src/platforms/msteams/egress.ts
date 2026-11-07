// The deployment Teams app's egress on the relay (teams-integration.md §8.5): its customer rows' Bot Connector calls and Graph tokens, so its secret never reaches a daemon.
import type {
  RcMsTeamsDeploymentApp,
  RdPlatformReply,
  WireMsTeamsCall,
  WireMsTeamsCallResult
} from '@agentconnect.md/protocol'
import {
  mintMsTeamsTicket,
  msTeamsTicketConversation,
  openMsTeamsTicket,
  type MsTeamsTicketBinding,
  type MsTeamsTicketed
} from './ticket.js'

export const MSTEAMS_BOT_SCOPE = 'https://api.botframework.com/.default'
export const MSTEAMS_GRAPH_SCOPE = 'https://graph.microsoft.com/.default'
/** A token is refreshed this long before Entra says it expires. */
const TOKEN_MARGIN_MS = 60_000
const TOKEN_TIMEOUT_MS = 10_000
/** One Bot Connector request's bound, under the daemon's 15-second wait for the reply. */
const CALL_TIMEOUT_MS = 12_000
const TOKENS_MAX = 1_000
/** The least lifetime a Graph token handed to a daemon has left. */
const GRAPH_HANDOUT_MIN_MS = 10 * 60_000
const MEMBERS_PAGE_SIZE = 100

type Obj = Record<string, unknown>
const obj = (value: unknown): Obj | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : undefined

/** Entra refused or failed a client-credentials request; `status` is Entra's, absent when it did not answer. */
export class MsTeamsTokenError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'MsTeamsTokenError'
  }
}

/** Client-credentials tokens of one app, per tenant and scope, cached until shortly before they expire; a request in flight is shared. */
export class MsTeamsAppTokens {
  private readonly cache = new Map<string, { value: string; until: number }>()
  private readonly minting = new Map<string, Promise<{ value: string; until: number }>>()

  constructor(
    private credential: { appId: string; clientSecret: string },
    private readonly fetchImpl: typeof fetch,
    private readonly now: () => number = Date.now
  ) {}

  /** Take a new credential; a changed one drops every cached token. */
  update(credential: { appId: string; clientSecret: string }): void {
    if (credential.appId !== this.credential.appId || credential.clientSecret !== this.credential.clientSecret)
      this.cache.clear()
    this.credential = credential
  }

  drop(tenantId: string, scope: string): void {
    this.cache.delete(`${tenantId}\0${scope}`)
  }

  /** A live token and when it stops being used; rejects with {@link MsTeamsTokenError}. */
  async get(tenantId: string, scope: string): Promise<{ value: string; until: number }> {
    const key = `${tenantId}\0${scope}`
    const hit = this.cache.get(key)
    if (hit && hit.until > this.now()) return hit
    let pending = this.minting.get(key)
    if (!pending) {
      pending = this.mint(tenantId, scope).finally(() => this.minting.delete(key))
      this.minting.set(key, pending)
    }
    const token = await pending
    this.cache.delete(key)
    this.cache.set(key, token)
    while (this.cache.size > TOKENS_MAX) this.cache.delete(this.cache.keys().next().value!)
    return token
  }

  private async mint(tenantId: string, scope: string): Promise<{ value: string; until: number }> {
    let response: Response
    try {
      response = await this.fetchImpl(
        `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: this.credential.appId,
            client_secret: this.credential.clientSecret,
            scope
          }).toString(),
          signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS)
        }
      )
    } catch {
      throw new MsTeamsTokenError('Entra did not answer')
    }
    const body = obj(await response.json().catch(() => undefined))
    const value = typeof body?.access_token === 'string' && body.access_token ? body.access_token : undefined
    if (!response.ok || !value)
      throw new MsTeamsTokenError(`Entra answered ${response.status} without a token`, response.status)
    const expiresIn = typeof body?.expires_in === 'number' ? body.expires_in * 1000 : 0
    return { value, until: this.now() + Math.max(0, expiresIn - TOKEN_MARGIN_MS) }
  }
}

/** One Bot Connector request the relay builds from a call; never a path the daemon named. */
interface ConnectorRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  query?: Record<string, string>
  body?: Obj
}

const conversationPath = (id: string) => `v3/conversations/${encodeURIComponent(id)}`
const teamPath = (id: string) => `v3/teams/${encodeURIComponent(id)}`

// The request a call makes, once its target matches what the ticket vouches for; undefined when it does not.
function requestOf(
  call: Exclude<WireMsTeamsCall, { op: 'graph-token' }>,
  ticketed: MsTeamsTicketed,
  bot: MsTeamsTicketBinding & { appId: string }
): ConnectorRequest | undefined {
  switch (call.op) {
    case 'post-activity':
    case 'update-activity':
    case 'delete-activity':
    case 'get-member':
    case 'get-paged-members':
      if (msTeamsTicketConversation(call.conversationId) !== ticketed.conversationId) return undefined
      break
    case 'get-team':
    case 'get-team-conversations':
      if (call.teamId !== ticketed.conversationId) return undefined
      break
    case 'create-conversation':
      break
  }
  switch (call.op) {
    case 'post-activity':
      return { method: 'POST', path: `${conversationPath(call.conversationId)}/activities`, body: call.activity }
    case 'update-activity':
      return {
        method: 'PUT',
        path: `${conversationPath(call.conversationId)}/activities/${encodeURIComponent(call.activityId)}`,
        body: { ...call.activity, id: call.activityId }
      }
    case 'delete-activity':
      return {
        method: 'DELETE',
        path: `${conversationPath(call.conversationId)}/activities/${encodeURIComponent(call.activityId)}`
      }
    case 'get-member':
      return {
        method: 'GET',
        path: `${conversationPath(call.conversationId)}/members/${encodeURIComponent(call.memberId)}`
      }
    case 'get-paged-members':
      return {
        method: 'GET',
        path: `${conversationPath(call.conversationId)}/pagedmembers`,
        query: {
          pageSize: String(MEMBERS_PAGE_SIZE),
          ...(call.continuationToken ? { continuationToken: call.continuationToken } : {})
        }
      }
    case 'get-team':
      return { method: 'GET', path: teamPath(call.teamId) }
    case 'get-team-conversations':
      return { method: 'GET', path: `${teamPath(call.teamId)}/conversations` }
    case 'create-conversation':
      // The tenant is the row's, whatever the daemon would have named.
      return {
        method: 'POST',
        path: 'v3/conversations',
        body: {
          isGroup: false,
          bot: { id: `28:${bot.appId}` },
          members: [{ id: call.memberId }],
          tenantId: bot.tenantId,
          channelData: { tenant: { id: bot.tenantId } }
        }
      }
  }
}

function retryAfterMs(res: Response, now: number): number | undefined {
  const raw = res.headers?.get?.('retry-after')
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000))
  const at = Date.parse(raw)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

const refused = (reason: string): RdPlatformReply => ({ outcome: 'refused', reason })
const answered = (result: WireMsTeamsCallResult): RdPlatformReply => ({ outcome: 'ok', payload: result })

/** The deployment app's sender for its customer rows: home-tenant Bot Connector tokens, Graph tokens for a row's own tenant, and tickets. */
export class MsTeamsRelayEgress {
  private readonly tokens: MsTeamsAppTokens
  private key: Buffer

  constructor(
    private app: RcMsTeamsDeploymentApp,
    private readonly fetchImpl: typeof fetch,
    private readonly now: () => number = Date.now
  ) {
    this.tokens = new MsTeamsAppTokens(app, fetchImpl, now)
    this.key = Buffer.from(app.ticketKey, 'base64url')
  }

  get appId(): string {
    return this.app.appId
  }

  /** Take a new snapshot's app in place; a changed credential drops every token. */
  update(app: RcMsTeamsDeploymentApp): void {
    this.tokens.update(app)
    this.app = app
    this.key = Buffer.from(app.ticketKey, 'base64url')
  }

  /** A ticket for a conversation a verified activity named; undefined for a service URL no token may go to. */
  ticket(binding: MsTeamsTicketBinding, raw: { conversationId: string; serviceUrl: string }): string | undefined {
    return mintMsTeamsTicket(this.key, binding, raw)
  }

  /** Perform one call for a row of tenant `binding.tenantId`; the caller has checked the daemon serves the row. */
  async call(binding: MsTeamsTicketBinding, call: WireMsTeamsCall): Promise<RdPlatformReply> {
    if (call.op === 'graph-token') return await this.graphToken(binding.tenantId)
    const ticketed = openMsTeamsTicket(this.key, binding, call.ticket)
    if (!ticketed) return refused('ticket')
    const request = requestOf(call, ticketed, { ...binding, appId: this.app.appId })
    if (!request) return refused('ticket_mismatch')
    const base = new URL(ticketed.serviceUrl.endsWith('/') ? ticketed.serviceUrl : `${ticketed.serviceUrl}/`)
    const url = new URL(request.path, base)
    for (const [name, value] of Object.entries(request.query ?? {})) url.searchParams.set(name, value)
    let result: WireMsTeamsCallResult | undefined
    // One 401 may be a token that aged out under us: drop it and try once with a fresh one.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let token: string
      try {
        token = (await this.tokens.get(this.app.tenantId, MSTEAMS_BOT_SCOPE)).value
      } catch (err) {
        return this.tokenRefusal(err)
      }
      result = await this.send(url, request, token)
      if (result.status !== 401) break
      this.tokens.drop(this.app.tenantId, MSTEAMS_BOT_SCOPE)
    }
    if (!result || result.status < 200 || result.status >= 300) return answered(result!)
    const tickets = this.answerTickets(call, binding, ticketed, result.body)
    return answered({ ...result, ...(tickets ? { tickets } : {}) })
  }

  private async send(url: URL, request: ConnectorRequest, token: string): Promise<WireMsTeamsCallResult> {
    let res: Response
    try {
      res = await this.fetchImpl(url.toString(), {
        method: request.method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(request.body ? { 'content-type': 'application/json' } : {})
        },
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
      })
    } catch {
      // No answer: the write may have landed, which the daemon reads from a gateway timeout.
      return { status: 504 }
    }
    const body = obj(await res.json().catch(() => undefined))
    const wait = retryAfterMs(res, this.now())
    return { status: res.status, ...(body ? { body } : {}), ...(wait !== undefined ? { retryAfterMs: wait } : {}) }
  }

  // A conversation the call opened, or each channel a team's list named, under the service URL the ticket vouched for.
  private answerTickets(
    call: WireMsTeamsCall,
    binding: MsTeamsTicketBinding,
    ticketed: MsTeamsTicketed,
    body: Obj | undefined
  ): Record<string, string> | undefined {
    const ids: string[] = []
    if (call.op === 'create-conversation' && typeof body?.id === 'string' && body.id) ids.push(body.id)
    if (call.op === 'get-team-conversations' && Array.isArray(body?.conversations))
      for (const entry of body.conversations) {
        const id = obj(entry)?.id
        if (typeof id === 'string' && id) ids.push(id)
      }
    if (ids.length === 0) return undefined
    const tickets: Record<string, string> = {}
    for (const id of ids) {
      const ticket = this.ticket(binding, { conversationId: id, serviceUrl: ticketed.serviceUrl })
      if (ticket) tickets[id] = ticket
    }
    return tickets
  }

  // An app-only Graph token minted in the row's own tenant, which carries only that tenant's consent.
  private async graphToken(tenantId: string): Promise<RdPlatformReply> {
    try {
      let token = await this.tokens.get(tenantId, MSTEAMS_GRAPH_SCOPE)
      // The daemon renews five minutes early, so a token near its end is replaced rather than handed out again.
      if (token.until - this.now() < GRAPH_HANDOUT_MIN_MS) {
        this.tokens.drop(tenantId, MSTEAMS_GRAPH_SCOPE)
        token = await this.tokens.get(tenantId, MSTEAMS_GRAPH_SCOPE)
      }
      const expiresIn = Math.max(0, Math.floor((token.until - this.now()) / 1000))
      return answered({ status: 200, body: { access_token: token.value, expires_in: expiresIn } })
    } catch (err) {
      return this.tokenRefusal(err)
    }
  }

  // Entra's refusal reads as the credential's (a 401 the daemon treats as such); no answer means nothing was sent.
  private tokenRefusal(err: unknown): RdPlatformReply {
    const status = err instanceof MsTeamsTokenError ? err.status : undefined
    if (status !== undefined && status >= 400 && status < 500)
      return answered({ status: 401, body: { error: { code: 'DeploymentTokenRefused' } } })
    return { outcome: 'unavailable', reason: 'token' }
  }
}
