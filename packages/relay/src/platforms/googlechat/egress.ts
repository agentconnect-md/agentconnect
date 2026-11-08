// The deployment Google Chat app's egress on the relay (google-chat-integration.md §10.10): its customer rows' Chat API calls, so its key never reaches a daemon.
import { createPrivateKey, type KeyObject } from 'node:crypto'
import { SignJWT } from 'jose'
import {
  RD_PLATFORM_REQUEST_BUDGET_MS,
  googleChatCallRequest,
  type GoogleChatHttpRequest,
  type RcGoogleChatDeploymentApp,
  type RdPlatformReply,
  type WireGoogleChatCall,
  type WireGoogleChatCallResult
} from '@agentconnect.md/protocol'
import { retryAfterMs, within } from '../provider-call.js'

/** Google's fixed OAuth token endpoint; the key's own `token_uri` is never followed. */
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const CHAT_API_ORIGIN = 'https://chat.googleapis.com'
const CHAT_API_PATH = '/v1'
/** App authentication only: no user impersonation, no domain-wide delegation. */
export const GOOGLE_CHAT_BOT_SCOPE = 'https://www.googleapis.com/auth/chat.bot'
/** Renew the hour-long token this far before it expires. */
const TOKEN_RENEW_MARGIN_MS = 5 * 60_000
/** How long a failed mint blocks the next attempt, so a rejected key is not hammered per call. */
const TOKEN_RETRY_MS = 30_000
const TOKEN_TIMEOUT_MS = 10_000
/** A send is not started with less than this left of the request's budget. */
const MIN_SEND_MS = 1_000
/** A Space's customer is immutable and a 1:1 DM's human is fixed, so a long TTL only bounds what a mistake costs. */
const TENANT_TTL_MS = 60 * 60_000
const TENANTS_MAX = 10_000
/** One row's share on one relay: a quarter of the project's 3,000 calls a minute, as a daemon's own budget defaults to. */
export const GOOGLE_CHAT_ROW_CALLS_PER_MINUTE = 750
const ROW_LIMITS_MAX = 10_000

type Obj = Record<string, unknown>
const obj = (value: unknown): Obj | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : undefined
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

/** Google refused or failed a token request; `status` is Google's, absent when it did not answer or the key cannot sign. */
export class GoogleChatTokenError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'GoogleChatTokenError'
  }
}

interface SigningKey {
  clientEmail: string
  privateKeyId?: string
  key: KeyObject
}

function signingKeyOf(serviceAccountKey: string): SigningKey | undefined {
  try {
    const fields = obj(JSON.parse(serviceAccountKey))
    const clientEmail = text(fields?.client_email)
    const privateKey = text(fields?.private_key)
    if (fields?.type !== 'service_account' || !clientEmail || !privateKey) return undefined
    const key = createPrivateKey({ key: privateKey, format: 'pem' })
    if (key.asymmetricKeyType !== 'rsa') return undefined
    const privateKeyId = text(fields.private_key_id)
    return { clientEmail, ...(privateKeyId ? { privateKeyId } : {}), key }
  } catch {
    return undefined
  }
}

/** The app's `chat.bot` token: cached until shortly before it expires, a mint in flight shared, a failed one not repeated for a while. */
class GoogleChatAppToken {
  private readonly signing: SigningKey | undefined
  private cached?: { value: string; until: number }
  private minting?: Promise<{ value: string; until: number }>
  private blockedUntil = 0
  private failure?: GoogleChatTokenError

  constructor(
    serviceAccountKey: string,
    private readonly fetchImpl: typeof fetch,
    private readonly now: () => number
  ) {
    this.signing = signingKeyOf(serviceAccountKey)
  }

  drop(): void {
    this.cached = undefined
  }

  /** Rejects with {@link GoogleChatTokenError}. */
  async get(): Promise<string> {
    const now = this.now()
    if (this.cached && this.cached.until > now) return this.cached.value
    if (now < this.blockedUntil) throw this.failure ?? new GoogleChatTokenError('the token mint is backing off')
    this.minting ??= this.mint()
      .then((token) => {
        this.cached = token
        this.failure = undefined
        return token
      })
      .catch((err: unknown) => {
        this.blockedUntil = this.now() + TOKEN_RETRY_MS
        this.failure = err instanceof GoogleChatTokenError ? err : new GoogleChatTokenError('the token mint failed')
        throw this.failure
      })
      .finally(() => {
        this.minting = undefined
      })
    return (await this.minting).value
  }

  // One JWT-bearer grant: `iss` the service account, `scope` chat.bot, `aud` the fixed token endpoint.
  private async mint(): Promise<{ value: string; until: number }> {
    if (!this.signing) throw new GoogleChatTokenError('the deployment key cannot sign', 400)
    const { clientEmail, privateKeyId, key } = this.signing
    const issuedAt = Math.floor(this.now() / 1000)
    const assertion = await new SignJWT({ scope: GOOGLE_CHAT_BOT_SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', ...(privateKeyId ? { kid: privateKeyId } : {}) })
      .setIssuer(clientEmail)
      .setAudience(GOOGLE_TOKEN_ENDPOINT)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 3_600)
      .sign(key)
    let response: Response
    try {
      response = await this.fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS)
      })
    } catch {
      throw new GoogleChatTokenError('Google did not answer')
    }
    const body = obj(await response.json().catch(() => undefined))
    const value = text(body?.access_token)
    if (!response.ok || !value)
      throw new GoogleChatTokenError(`Google answered ${response.status} without a token`, response.status)
    const expiresIn = typeof body?.expires_in === 'number' ? body.expires_in : 3_600
    return { value, until: this.now() + Math.max(0, expiresIn * 1000 - TOKEN_RENEW_MARGIN_MS) }
  }
}

/** A Space's tenant as Google states it: a named Space's owning customer, a DM's one human member's domain. */
type SpaceTenant = { kind: 'space'; customer?: string } | { kind: 'dm'; domain?: string }

function tenantPermitted(tenant: SpaceTenant, keys: readonly string[]): boolean {
  const key = tenant.kind === 'space' ? tenant.customer : tenant.domain
  return key !== undefined && keys.includes(key)
}

/** The bot row a call acts for, as its CP assignment states it: never anything the daemon names. */
export interface GoogleChatEgressRow {
  botId: string
  tenantIds: readonly string[]
}

type CallKind = 'write' | 'read'

function callKind(call: WireGoogleChatCall): CallKind {
  switch (call.op) {
    case 'create-message':
    case 'patch-text':
    case 'patch-cards':
    case 'delete-message':
      return 'write'
    default:
      return 'read'
  }
}

/** Token buckets per row and kind, on this relay alone; another relay keeps its own (§10.10). */
class GoogleChatRowLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>()

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number
  ) {}

  /** Take one call's token; answers 0, or how long until one is free. */
  take(botId: string, kind: CallKind): number {
    const key = `${botId}\0${kind}`
    const now = this.now()
    const held = this.buckets.get(key)
    const refilled = held
      ? Math.min(this.perMinute, held.tokens + ((now - held.at) * this.perMinute) / 60_000)
      : this.perMinute
    this.buckets.delete(key)
    const free = refilled >= 1
    this.buckets.set(key, { tokens: free ? refilled - 1 : refilled, at: now })
    while (this.buckets.size > ROW_LIMITS_MAX) this.buckets.delete(this.buckets.keys().next().value!)
    return free ? 0 : Math.ceil(((1 - refilled) * 60_000) / this.perMinute)
  }
}

const refused = (reason: string, retryable = false): RdPlatformReply => ({
  outcome: 'refused',
  reason,
  ...(retryable ? { retryable } : {})
})
const unavailable = (reason: string): RdPlatformReply => ({ outcome: 'unavailable', reason })
const answered = (result: WireGoogleChatCallResult): RdPlatformReply => ({ outcome: 'ok', payload: result })
const succeeded = (result: WireGoogleChatCallResult) => result.status >= 200 && result.status < 300

/** Google's answer, or the reply that stops the call first: a step made no write, or nothing reached Google. */
type Performed = { result: WireGoogleChatCallResult } | { stopped: RdPlatformReply }
type Fenced = { tenant: SpaceTenant } | { stopped: RdPlatformReply }

export interface GoogleChatRelayEgressOptions {
  /** Wall clock, which dates tokens, cached tenants and row limits. */
  now?: () => number
  /** The whole call's bound, tokens, fence reads and a 401 retry included, so the relay answers before the daemon stops waiting. */
  budgetMs?: number
  /** Elapsed time for the budget, apart from `now`. */
  clock?: () => number
  rowCallsPerMinute?: number
}

/** The deployment app's caller for its customer rows: every target is checked against what Google says of it, with the app's own token. */
export class GoogleChatRelayEgress {
  private token: GoogleChatAppToken
  private readonly tenants = new Map<string, { tenant: SpaceTenant; until: number }>()
  private readonly limiter: GoogleChatRowLimiter
  private readonly now: () => number
  private readonly budgetMs: number
  private readonly clock: () => number

  constructor(
    private app: RcGoogleChatDeploymentApp,
    private readonly fetchImpl: typeof fetch,
    options: GoogleChatRelayEgressOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.budgetMs = options.budgetMs ?? RD_PLATFORM_REQUEST_BUDGET_MS
    this.clock = options.clock ?? (() => performance.now())
    this.limiter = new GoogleChatRowLimiter(options.rowCallsPerMinute ?? GOOGLE_CHAT_ROW_CALLS_PER_MINUTE, this.now)
    this.token = new GoogleChatAppToken(app.serviceAccountKey, fetchImpl, this.now)
  }

  get projectNumber(): string {
    return this.app.projectNumber
  }

  /** Take a new snapshot's app in place; a changed key drops the token and another project what it knew of its Spaces. */
  update(app: RcGoogleChatDeploymentApp): void {
    if (app.projectNumber !== this.app.projectNumber) this.tenants.clear()
    if (app.serviceAccountKey !== this.app.serviceAccountKey)
      this.token = new GoogleChatAppToken(app.serviceAccountKey, this.fetchImpl, this.now)
    this.app = app
  }

  /** Perform one call for a row within the request budget; the caller has checked the daemon serves the row. */
  async call(row: GoogleChatEgressRow, call: WireGoogleChatCall): Promise<RdPlatformReply> {
    const started = this.clock()
    const left = () => this.budgetMs - (this.clock() - started)
    if (call.op === 'create-message' && call.thread && !call.thread.startsWith(`${call.space}/threads/`))
      return refused('invalid')
    const wait = this.limiter.take(row.botId, callKind(call))
    // Answered as Google's own 429 would be: nothing was sent, and the daemon backs off without asking another relay.
    if (wait > 0)
      return answered({
        status: 429,
        retryAfterMs: wait,
        body: { error: { status: 'RESOURCE_EXHAUSTED', message: 'this bot used its share of the Chat API quota' } }
      })
    const target = targetSpace(call)
    if (target) {
      const fenced = await this.fence(target, row, left)
      if (fenced) return fenced
    }
    const performed = await this.perform(call, left)
    if ('stopped' in performed) return performed.stopped
    const { result } = performed
    if (!succeeded(result)) return answered(result)
    if (call.op === 'list-spaces') return answered(ownSpaces(result, row))
    if (call.op === 'find-direct-message') {
      const space = text(result.body?.name)
      if (!space) return answered(result)
      // The lookup itself only names a DM; its human's domain decides whether this row may learn it.
      const fenced = await this.fence(space, row, left)
      if (fenced) return fenced
    }
    return answered(result)
  }

  // Undefined when the Space is the row's own; anything else, a failed lookup included, stops the call before its operation.
  private async fence(
    space: string,
    row: GoogleChatEgressRow,
    left: () => number
  ): Promise<RdPlatformReply | undefined> {
    const read = await this.spaceTenant(space, left)
    if ('stopped' in read) return read.stopped
    return tenantPermitted(read.tenant, row.tenantIds) ? undefined : refused('tenant_refused')
  }

  // What Google says of the Space, read with the app's own token; a failed read is never cached.
  private async spaceTenant(space: string, left: () => number): Promise<Fenced> {
    const hit = this.tenants.get(space)
    if (hit && hit.until > this.now()) return { tenant: hit.tenant }
    const named = await this.perform({ op: 'get-space', space }, left)
    if ('stopped' in named) return named
    if (!succeeded(named.result)) return { stopped: lookupFailed(named.result) }
    let tenant: SpaceTenant
    if (named.result.body?.spaceType === 'DIRECT_MESSAGE') {
      const members = await this.perform({ op: 'list-dm-humans', space }, left)
      if ('stopped' in members) return members
      if (!succeeded(members.result)) return { stopped: lookupFailed(members.result) }
      const humans = (Array.isArray(members.result.body?.memberships) ? members.result.body.memberships : [])
        .map((membership) => obj(obj(membership)?.member))
        .filter((member) => member?.type === 'HUMAN')
      const domainId = humans.length === 1 ? text(humans[0]?.domainId) : undefined
      tenant = { kind: 'dm', ...(domainId ? { domain: `domains/${domainId}` } : {}) }
    } else {
      const customer = text(named.result.body?.customer)
      tenant = { kind: 'space', ...(customer ? { customer } : {}) }
    }
    this.tenants.delete(space)
    this.tenants.set(space, { tenant, until: this.now() + TENANT_TTL_MS })
    while (this.tenants.size > TENANTS_MAX) this.tenants.delete(this.tenants.keys().next().value!)
    return { tenant }
  }

  // One Chat API request; one 401 may be a token that aged out, and Google answering it means nothing landed.
  private async perform(call: WireGoogleChatCall, left: () => number): Promise<Performed> {
    const request = googleChatCallRequest(call)
    const url = new URL(`${CHAT_API_ORIGIN}${CHAT_API_PATH}/${request.path}`)
    // A dot segment or anything else the URL parser rewrites would leave the fixed operation's path.
    if (url.origin !== CHAT_API_ORIGIN || url.pathname !== `${CHAT_API_PATH}/${request.path}`)
      return { stopped: refused('invalid') }
    for (const [name, value] of Object.entries(request.query ?? {})) url.searchParams.set(name, value)
    let result: WireGoogleChatCallResult | undefined
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let token: string | undefined
      try {
        token = await within(this.token.get(), left())
      } catch (err) {
        return result ? { result } : { stopped: tokenRefusal(err) }
      }
      // Out of time before sending: nothing went out, or the first attempt's answer stands.
      if (!token || left() < MIN_SEND_MS) return result ? { result } : { stopped: unavailable('deadline') }
      result = await this.send(url, request, token, left())
      if (result.status !== 401) break
      this.token.drop()
    }
    return { result: result! }
  }

  private async send(
    url: URL,
    request: GoogleChatHttpRequest,
    token: string,
    timeoutMs: number
  ): Promise<WireGoogleChatCallResult> {
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
}

// The Space a call acts in, when the call names one.
function targetSpace(call: WireGoogleChatCall): string | undefined {
  switch (call.op) {
    case 'create-message':
    case 'get-space':
    case 'list-dm-humans':
    case 'list-members':
      return call.space
    case 'patch-text':
    case 'patch-cards':
    case 'delete-message':
    case 'get-message':
      return call.message.slice(0, call.message.indexOf('/messages/'))
    case 'find-direct-message':
    case 'list-spaces':
      return undefined
  }
}

// `spaces.list` under app authentication names every Space the app is in, across all customers; a row sees its own.
function ownSpaces(result: WireGoogleChatCallResult, row: GoogleChatEgressRow): WireGoogleChatCallResult {
  const spaces = Array.isArray(result.body?.spaces) ? result.body.spaces : []
  const own = spaces.filter((space) => {
    const customer = text(obj(space)?.customer)
    return customer !== undefined && row.tenantIds.includes(customer)
  })
  return { ...result, body: { ...result.body, spaces: own } }
}

// A failed lookup stops the call before its operation: Google's own refusal is the daemon's to read, and a failure or no answer leaves nothing sent.
function lookupFailed(result: WireGoogleChatCallResult): RdPlatformReply {
  return result.status >= 500 ? unavailable('fence') : answered(result)
}

// Google's refusal reads as the credential's (a 401 the daemon treats as such); no answer means nothing was sent.
function tokenRefusal(err: unknown): RdPlatformReply {
  const status = err instanceof GoogleChatTokenError ? err.status : undefined
  if (status !== undefined && status >= 400 && status < 500)
    return answered({ status: 401, body: { error: { message: 'Google refused the deployment app’s key' } } })
  return unavailable('token')
}
