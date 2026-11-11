// The deployment Teams app's egress on the relay (teams-integration.md §8.5): its customer rows' Bot Connector calls and Graph tokens, so its secret never reaches a daemon.
import {
  RD_PLATFORM_REQUEST_BUDGET_MS,
  type RcMsTeamsBlueprint,
  type RcMsTeamsDeploymentApp,
  type RdPlatformReply,
  type WireMsTeamsCall,
  type WireMsTeamsCallResult
} from '@agentconnect.md/protocol'
import {
  mintMsTeamsTicket,
  msTeamsTicketConversation,
  openMsTeamsTicket,
  type MsTeamsTicketBinding,
  type MsTeamsTicketed
} from './ticket.js'
import { retryAfterMs, within } from '../provider-call.js'

export const MSTEAMS_BOT_SCOPE = 'https://api.botframework.com/.default'
export const MSTEAMS_GRAPH_SCOPE = 'https://graph.microsoft.com/.default'
/** A token is refreshed this long before Entra says it expires. */
const TOKEN_MARGIN_MS = 60_000
const TOKEN_TIMEOUT_MS = 10_000
/** A send is not started with less than this left of the request's budget. */
const MIN_SEND_MS = 1_000
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
    readonly status?: number,
    /** Entra's own code for the refusal, as `AADSTS<number>`. */
    readonly code?: string
  ) {
    super(message)
    this.name = 'MsTeamsTokenError'
  }
}

type Token = { value: string; until: number }

// One client-credentials request to a tenant's token endpoint; rejects with {@link MsTeamsTokenError}.
async function requestToken(
  fetchImpl: typeof fetch,
  now: () => number,
  tenantId: string,
  params: Record<string, string>
): Promise<Token> {
  let response: Response
  try {
    response = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', ...params }).toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS)
    })
  } catch {
    throw new MsTeamsTokenError('Entra did not answer')
  }
  const body = obj(await response.json().catch(() => undefined))
  const value = typeof body?.access_token === 'string' && body.access_token ? body.access_token : undefined
  if (!response.ok || !value) {
    const first: unknown = Array.isArray(body?.error_codes) ? body.error_codes[0] : undefined
    throw new MsTeamsTokenError(
      `Entra answered ${response.status} without a token`,
      response.status,
      typeof first === 'number' ? `AADSTS${first}` : undefined
    )
  }
  const expiresIn = typeof body?.expires_in === 'number' ? body.expires_in * 1000 : 0
  return { value, until: now() + Math.max(0, expiresIn - TOKEN_MARGIN_MS) }
}

// Tokens by key, kept until shortly before they expire; a request in flight is shared.
class TokenCache {
  private readonly cache = new Map<string, Token>()
  private readonly minting = new Map<string, Promise<Token>>()

  constructor(private readonly now: () => number) {}

  clear(): void {
    this.cache.clear()
  }

  drop(key: string): void {
    this.cache.delete(key)
  }

  async get(key: string, mint: () => Promise<Token>): Promise<Token> {
    const hit = this.cache.get(key)
    if (hit && hit.until > this.now()) return hit
    let pending = this.minting.get(key)
    if (!pending) {
      pending = mint().finally(() => this.minting.delete(key))
      this.minting.set(key, pending)
    }
    const token = await pending
    this.cache.delete(key)
    this.cache.set(key, token)
    while (this.cache.size > TOKENS_MAX) this.cache.delete(this.cache.keys().next().value!)
    return token
  }
}

/** Client-credentials tokens of one app, per tenant and scope, cached until shortly before they expire. */
export class MsTeamsAppTokens {
  private readonly cache: TokenCache

  constructor(
    private credential: { appId: string; clientSecret: string },
    private readonly fetchImpl: typeof fetch,
    private readonly now: () => number = Date.now
  ) {
    this.cache = new TokenCache(now)
  }

  /** Take a new credential; a changed one drops every cached token. */
  update(credential: { appId: string; clientSecret: string }): void {
    if (credential.appId !== this.credential.appId || credential.clientSecret !== this.credential.clientSecret)
      this.cache.clear()
    this.credential = credential
  }

  drop(tenantId: string, scope: string): void {
    this.cache.drop(`${tenantId}\0${scope}`)
  }

  /** A live token and when it stops being used; rejects with {@link MsTeamsTokenError}. */
  async get(tenantId: string, scope: string): Promise<Token> {
    const { appId, clientSecret } = this.credential
    return await this.cache.get(`${tenantId}\0${scope}`, () =>
      requestToken(this.fetchImpl, this.now, tenantId, { client_id: appId, client_secret: clientSecret, scope })
    )
  }
}

/** The scope a blueprint asks for to act as one of its agent identities. */
export const MSTEAMS_TOKEN_EXCHANGE_SCOPE = 'api://AzureADTokenExchange/.default'

/** Bot Connector tokens of the blueprint's agent identities, issued by each identity's own tenant (teams-integration.md §8.6.2). */
export class MsTeamsAgentBotTokens {
  private readonly cache: TokenCache

  constructor(
    private blueprint: RcMsTeamsBlueprint,
    private readonly fetchImpl: typeof fetch,
    private readonly now: () => number = Date.now
  ) {
    this.cache = new TokenCache(now)
  }

  /** Take a new blueprint; a changed one drops every cached token. */
  update(blueprint: RcMsTeamsBlueprint): void {
    if (blueprint.appId !== this.blueprint.appId || blueprint.clientSecret !== this.blueprint.clientSecret)
      this.cache.clear()
    this.blueprint = blueprint
  }

  drop(tenantId: string, identity: string): void {
    this.cache.drop(`${tenantId}\0${identity}`)
  }

  /** A live token for one identity; rejects with {@link MsTeamsTokenError}. */
  async get(tenantId: string, identity: string): Promise<Token> {
    const { appId, clientSecret } = this.blueprint
    return await this.cache.get(`${tenantId}\0${identity}`, async () => {
      // The blueprint vouches for the identity, which then presents that token as its own client assertion.
      const assertion = await requestToken(this.fetchImpl, this.now, tenantId, {
        client_id: appId,
        client_secret: clientSecret,
        scope: MSTEAMS_TOKEN_EXCHANGE_SCOPE,
        fmi_path: identity
      })
      return await requestToken(this.fetchImpl, this.now, tenantId, {
        client_id: identity,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion.value,
        scope: MSTEAMS_BOT_SCOPE
      })
    })
  }
}

/** Entra's codes for an identity, or the blueprint's principal, the customer disabled or deleted (teams-integration.md §8.6.5). */
const AGENT_BOT_STOPPED_CODES = new Set(['AADSTS7000112', 'AADSTS700016'])

/** What a token request for an agent bot showed about its credential: it works, or the customer stopped it. */
export type MsTeamsAgentBotCheck = { result: 'ok' } | { result: 'rejected'; code: string }

/** The row a call is for: its ticket binding, and its agent identity when the bot is one the deployment made for an agent. */
export interface MsTeamsEgressRow extends MsTeamsTicketBinding {
  agentBotId?: string
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

const refused = (reason: string): RdPlatformReply => ({ outcome: 'refused', reason })
const unavailable = (reason: string): RdPlatformReply => ({ outcome: 'unavailable', reason })
const answered = (result: WireMsTeamsCallResult): RdPlatformReply => ({ outcome: 'ok', payload: result })

/** The deployment's sender for its rows: Bot Connector tokens (the app's from the home tenant, an agent bot's from its own), Graph tokens for a row's own tenant, and tickets. */
export class MsTeamsRelayEgress {
  private readonly tokens: MsTeamsAppTokens
  private agentBots: MsTeamsAgentBotTokens | undefined
  // The blueprint's own app tokens: an agent bot's package grants its resource-specific consent to the blueprint (§8.6.1).
  private blueprintTokens: MsTeamsAppTokens | undefined
  private key: Buffer

  constructor(
    private app: RcMsTeamsDeploymentApp,
    private readonly fetchImpl: typeof fetch,
    private readonly now: () => number = Date.now,
    /** The whole call's bound, tokens and a 401 retry included, so the relay answers before the daemon stops waiting. */
    private readonly budgetMs: number = RD_PLATFORM_REQUEST_BUDGET_MS,
    /** Elapsed time for the budget, apart from `now`, which dates tokens. */
    private readonly clock: () => number = () => performance.now()
  ) {
    this.tokens = new MsTeamsAppTokens(app, fetchImpl, now)
    this.key = Buffer.from(app.ticketKey, 'base64url')
    this.takeBlueprint(app.blueprint)
  }

  /** Whether the snapshot carries the blueprint an agent bot's row is sent with. */
  get servesAgentBots(): boolean {
    return this.agentBots !== undefined
  }

  private takeBlueprint(blueprint: RcMsTeamsBlueprint | undefined): void {
    if (!blueprint) {
      this.agentBots = undefined
      this.blueprintTokens = undefined
      return
    }
    if (this.agentBots) this.agentBots.update(blueprint)
    else this.agentBots = new MsTeamsAgentBotTokens(blueprint, this.fetchImpl, this.now)
    if (this.blueprintTokens) this.blueprintTokens.update(blueprint)
    else this.blueprintTokens = new MsTeamsAppTokens(blueprint, this.fetchImpl, this.now)
  }

  get appId(): string {
    return this.app.appId
  }

  /** Take a new snapshot's app in place; a changed credential drops every token. */
  update(app: RcMsTeamsDeploymentApp): void {
    this.tokens.update(app)
    this.takeBlueprint(app.blueprint)
    this.app = app
    this.key = Buffer.from(app.ticketKey, 'base64url')
  }

  /** A ticket for a conversation a verified activity named; undefined for a service URL no token may go to. */
  ticket(binding: MsTeamsTicketBinding, raw: { conversationId: string; serviceUrl: string }): string | undefined {
    return mintMsTeamsTicket(this.key, binding, raw)
  }

  /** Perform one call for a row of tenant `row.tenantId` within the request budget; the caller has checked the daemon serves the row. */
  async call(
    row: MsTeamsEgressRow,
    call: WireMsTeamsCall,
    /** Told what each token request for an agent bot showed, so the row's credential can be marked. */
    onAgentBotCheck?: (check: MsTeamsAgentBotCheck) => void
  ): Promise<RdPlatformReply> {
    const binding: MsTeamsTicketBinding = { botId: row.botId, tenantId: row.tenantId }
    // An agent bot sends as its own identity with a token of its own tenant; the app's bot with the home tenant's.
    const agentBots = row.agentBotId ? this.agentBots : undefined
    if (row.agentBotId && !agentBots) return refused('no_blueprint')
    const botToken = agentBots
      ? {
          get: () => agentBots.get(row.tenantId, row.agentBotId!),
          drop: () => agentBots.drop(row.tenantId, row.agentBotId!)
        }
      : {
          get: () => this.tokens.get(this.app.tenantId, MSTEAMS_BOT_SCOPE),
          drop: () => this.tokens.drop(this.app.tenantId, MSTEAMS_BOT_SCOPE)
        }
    const started = this.clock()
    const left = () => this.budgetMs - (this.clock() - started)
    // An agent bot's row reads Graph as the blueprint, which holds its package's consent; the app's row as the app.
    if (call.op === 'graph-token')
      return await this.graphToken(row.agentBotId ? this.blueprintTokens! : this.tokens, binding.tenantId, left)
    const ticketed = openMsTeamsTicket(this.key, binding, call.ticket)
    if (!ticketed) return refused('ticket')
    const request = requestOf(call, ticketed, { ...binding, appId: row.agentBotId ?? this.app.appId })
    if (!request) return refused('ticket_mismatch')
    const base = new URL(ticketed.serviceUrl.endsWith('/') ? ticketed.serviceUrl : `${ticketed.serviceUrl}/`)
    const url = new URL(request.path, base)
    // A dot segment or anything else the URL parser rewrites would leave the fixed operation's path.
    if (url.pathname !== `${base.pathname}${request.path}`) return refused('invalid')
    for (const [name, value] of Object.entries(request.query ?? {})) url.searchParams.set(name, value)
    let result: WireMsTeamsCallResult | undefined
    // One 401 may be a token that aged out under us: drop it and try once with a fresh one, while the budget lasts.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let token: { value: string } | undefined
      try {
        token = await within(botToken.get(), left())
        if (token && agentBots) onAgentBotCheck?.({ result: 'ok' })
      } catch (err) {
        const code = err instanceof MsTeamsTokenError ? err.code : undefined
        if (agentBots && code && AGENT_BOT_STOPPED_CODES.has(code)) onAgentBotCheck?.({ result: 'rejected', code })
        return result ? answered(result) : this.tokenRefusal(err)
      }
      // Out of time before sending: nothing reached Microsoft, or the first attempt's answer stands.
      if (!token || left() < MIN_SEND_MS) return result ? answered(result) : unavailable('deadline')
      result = await this.send(url, request, token.value, left())
      if (result.status !== 401) break
      botToken.drop()
    }
    if (!result || result.status < 200 || result.status >= 300) return answered(result!)
    const tickets = this.answerTickets(call, binding, ticketed, result.body)
    return answered({ ...result, ...(tickets ? { tickets } : {}) })
  }

  private async send(
    url: URL,
    request: ConnectorRequest,
    token: string,
    timeoutMs: number
  ): Promise<WireMsTeamsCallResult> {
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
        signal: AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)))
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
  private async graphToken(tokens: MsTeamsAppTokens, tenantId: string, left: () => number): Promise<RdPlatformReply> {
    try {
      let token = await within(tokens.get(tenantId, MSTEAMS_GRAPH_SCOPE), left())
      // The daemon renews five minutes early, so a token near its end is replaced rather than handed out again.
      if (token && token.until - this.now() < GRAPH_HANDOUT_MIN_MS) {
        tokens.drop(tenantId, MSTEAMS_GRAPH_SCOPE)
        token = await within(tokens.get(tenantId, MSTEAMS_GRAPH_SCOPE), left())
      }
      if (!token) return unavailable('deadline')
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
    return unavailable('token')
  }
}
