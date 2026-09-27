// Google Chat's Layer-1 connection (google-chat-integration.md §5): app-authenticated REST egress, no socket.
import { createHash, createPrivateKey, randomUUID, type KeyObject } from 'node:crypto'
import { SignJWT } from 'jose'
import type { IntegrationGoogleChatConfig } from '@agentconnect.md/protocol'
import type { Agent } from '../../agents/agent-schema.js'
import type { Logger } from '../../log.js'
import type {
  PlatformChannelInfo,
  PlatformChannelRef,
  PlatformConnection,
  PlatformMemberRef,
  PlatformUserProfile
} from '../contract.js'
import { platformIntegrationConfig } from '../integration-config.js'
import { PlatformSendQueue } from '../send-queue.js'

/** Google's fixed OAuth token endpoint; the key's own `token_uri` is never followed (§3). */
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
/** The fixed Chat API root; no endpoint override is accepted (§3). */
export const GOOGLE_CHAT_API_ROOT = 'https://chat.googleapis.com/v1'
/** App authentication only: no user impersonation, no domain-wide delegation (§3). */
export const GOOGLE_CHAT_BOT_SCOPE = 'https://www.googleapis.com/auth/chat.bot'
/** The Markdown mode every create and patch names; a patch without it reverts to Chat syntax (§5). */
export const GOOGLE_CHAT_MARKUP = 'MARKUP_SYNTAX_MARKDOWN'
/** Google allows one write per second per Space, shared by every app acting in it (§5). */
export const GOOGLE_CHAT_SPACE_INTERVAL_MS = 1_000
/** Renew the hour-long access token this far before it expires. */
export const TOKEN_RENEW_MARGIN_MS = 5 * 60 * 1000
/** How long a failed mint blocks the next attempt, so a rejected key is not hammered per send. */
export const TOKEN_RETRY_MS = 30_000
/** A read port's own deadline when its caller sets none — a stall costs a name, never a caller. */
export const GOOGLE_CHAT_READ_DEADLINE_MS = 5_000
const REQUEST_TIMEOUT_MS = 15_000
const SEND_MAX_ATTEMPTS = 3
const SEND_RETRY_BASE_MS = 1_000
const SEND_RETRY_CAP_MS = 5_000
const SPACES_PAGE_SIZE = 100
const MAX_LISTED_SPACES = 200

/** Why one Chat API call failed, in the vocabulary the delivery status is reported in. */
export type GoogleChatFailureKind =
  | 'credential_rejected'
  | 'forbidden'
  | 'not_found'
  | 'already_exists'
  | 'invalid'
  | 'rate_limited'
  | 'unavailable'
  | 'ambiguous'

/** A Chat API or token-endpoint refusal; `ambiguous` means the request may have landed. */
export class GoogleChatApiError extends Error {
  constructor(
    message: string,
    readonly kind: GoogleChatFailureKind,
    readonly status?: number,
    /** The provider's own `Retry-After`, when it sent one — preferred over our backoff. */
    readonly retryAfterMs?: number
  ) {
    super(message)
    this.name = 'GoogleChatApiError'
  }

  /** Worth another attempt of an idempotent request. */
  get retryable(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'unavailable' || this.kind === 'ambiguous'
  }
}

/** One connection's worth of consolidated integrations (§7.5 registry group shape). */
export interface ConsolidatedGoogleChatGroup {
  key: string
  agentId: string
  integrationId: string
  config: IntegrationGoogleChatConfig
  integrations: { agentId: string; integrationId: string }[]
}

/** §7.5 opaque identity: the app AND its key, so a rotated key opens a new client and drains the old one. */
export function googleChatConnKey(c: Pick<IntegrationGoogleChatConfig, 'projectNumber' | 'serviceAccountKey'>): string {
  return createHash('sha256')
    .update(JSON.stringify([c.projectNumber, c.serviceAccountKey]))
    .digest('hex')
}

/** Group an agent set's Google Chat integrations, one connection per (app, key); a rejected config is skipped. */
export function consolidateGoogleChat(agents: Agent[], log?: Logger): Map<string, ConsolidatedGoogleChatGroup> {
  const groups = new Map<string, ConsolidatedGoogleChatGroup>()
  for (const a of agents) {
    for (const int of a.integrations) {
      if (int.platform !== 'googlechat') continue
      const config = platformIntegrationConfig('googlechat', int)
      if (!config) {
        log?.warn(`googlechat: integration ${int.id} skipped — config failed the googlechat schema`)
        continue
      }
      const key = googleChatConnKey(config)
      const group = groups.get(key)
      if (group) group.integrations.push({ agentId: a.id, integrationId: int.id })
      else
        groups.set(key, {
          key,
          agentId: a.id,
          integrationId: int.id,
          config,
          integrations: [{ agentId: a.id, integrationId: int.id }]
        })
    }
  }
  return groups
}

export interface GoogleChatDeps {
  group: ConsolidatedGoogleChatGroup
  log?: Logger
  /** Injected so tests need no network. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Wall clock, injectable for tests; token expiry is absolute time. */
  now?: () => number
  /** Backoff and queue sleep, injectable so a fake clock does not wait in real time. */
  sleep?: (ms: number) => Promise<void>
  /** Min spacing (ms) between writes into one Space. Tests pass 0. */
  sendIntervalMs?: number
  /** Jitter source in [0, 1); injectable for deterministic backoff. */
  random?: () => number
  /** Per-request id for chrome creates; injectable for tests. */
  newRequestId?: () => string
}

/** A Chat message the daemon created, addressed by its resource name and the id it chose. */
export interface GoogleChatMessageRef {
  name: string
  clientId?: string
  text?: string
}

/** A Space as `spaces.list` / `spaces.get` describe it. */
interface SpaceResource {
  name?: string
  displayName?: string
  spaceType?: string
}

interface MessageResource {
  name?: string
  text?: string
  sender?: { name?: string }
}

interface CachedToken {
  token: string
  expiresAtMs: number
}

interface ParsedKey {
  clientEmail: string
  privateKeyId?: string
  signingKey: KeyObject
}

/** The service-account key's usable parts, or the reason it is not one; the JSON itself never reaches a log. */
function parseServiceAccountKey(raw: string): ParsedKey | GoogleChatApiError {
  let fields: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
    fields = parsed as Record<string, unknown>
  } catch {
    return new GoogleChatApiError('the service-account key is not a JSON object', 'credential_rejected')
  }
  const text = (name: string): string | undefined =>
    typeof fields[name] === 'string' && (fields[name] as string).trim() !== '' ? (fields[name] as string) : undefined
  const clientEmail = text('client_email')
  const privateKey = text('private_key')
  if (fields.type !== 'service_account' || !clientEmail || !privateKey)
    return new GoogleChatApiError('the service-account key lacks client_email or private_key', 'credential_rejected')
  try {
    const signingKey = createPrivateKey({ key: privateKey, format: 'pem' })
    if (signingKey.asymmetricKeyType !== 'rsa') throw new Error('not rsa')
    const privateKeyId = text('private_key_id')
    return { clientEmail, ...(privateKeyId ? { privateKeyId } : {}), signingKey }
  } catch {
    return new GoogleChatApiError('the service-account private_key is not a readable RSA key', 'credential_rejected')
  }
}

/** `Retry-After`, as delta-seconds or an HTTP date. Absent/unparseable ⇒ the caller's own backoff. */
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

/** The Chat API's error message, bounded, or the bare status. */
function errorDetail(body: Record<string, unknown> | undefined, status: number): string {
  const message = (body?.error as { message?: unknown } | undefined)?.message
  const text = typeof message === 'string' ? message.trim() : ''
  return text ? `HTTP ${status}: ${text.slice(0, 200)}` : `HTTP ${status}`
}

function classifyStatus(status: number): GoogleChatFailureKind {
  if (status === 401) return 'credential_rejected'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409) return 'already_exists'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'unavailable'
  return 'invalid'
}

export class GoogleChatConnection implements PlatformConnection {
  readonly key: string
  readonly integrationId: string
  readonly agentId: string
  /** The Chat app's Google Cloud project number: its durable identity and token audience. */
  readonly projectNumber: string
  /** No permalink base: Chat deep links come from the message's own `spaceUri`, so the console URL is the fallback. */
  readonly workspaceUrl = ''
  private readonly parsedKey: ParsedKey | GoogleChatApiError
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly random: () => number
  private readonly newRequestId: () => string
  private readonly sendIntervalMs: number
  /** One write queue per Space (§5): Google's write quota is per Space, shared by every app in it. */
  private readonly queues = new Map<string, PlatformSendQueue>()
  private cached: CachedToken | undefined
  /** Single-flight mint: concurrent sends inside the margin issue one token request. */
  private minting: Promise<CachedToken> | undefined
  private mintBlockedUntil = 0
  private mintFailure: GoogleChatApiError | undefined
  private appUserName: string | undefined
  private stopped = false

  constructor(private readonly deps: GoogleChatDeps) {
    const { group } = deps
    this.key = group.key
    this.integrationId = group.integrationId
    this.agentId = group.agentId
    this.projectNumber = group.config.projectNumber
    this.parsedKey = parseServiceAccountKey(group.config.serviceAccountKey)
    if (this.parsedKey instanceof GoogleChatApiError)
      deps.log?.warn(`googlechat: integration ${this.integrationId}: ${this.parsedKey.message}`)
    this.fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
    this.now = deps.now ?? (() => Date.now())
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.random = deps.random ?? (() => Math.random())
    this.newRequestId = deps.newRequestId ?? (() => randomUUID())
    this.sendIntervalMs = deps.sendIntervalMs ?? GOOGLE_CHAT_SPACE_INTERVAL_MS
  }

  /** The app's own `users/…` identity, once `members/app` or a create response has named it. */
  get botUserId(): string | undefined {
    return this.appUserName
  }

  /** The durable tenant anchor Google exposes: the app's project, which survives key rotation. */
  workspaceId(): string {
    return this.projectNumber
  }

  // ── 1. transport lifecycle ──

  /** No socket to open: warm the token, then learn the app identity from a Space it is already in. */
  async start(): Promise<void> {
    this.stopped = false
    await this.token()
    await this.discoverIdentity()
  }

  async stop(): Promise<void> {
    this.stopped = true
  }

  // ── 2. egress ──

  /** Create one message under a `client-` id; a repeat, a conflict, or an ambiguous answer reconciles by that id, never a fresh one. */
  async createMessage(input: {
    space: string
    thread?: string
    clientId: string
    text: string
  }): Promise<GoogleChatMessageRef> {
    const query: Record<string, string> = { messageId: input.clientId, requestId: input.clientId }
    if (input.thread) query.messageReplyOption = 'REPLY_MESSAGE_OR_FAIL'
    const body = {
      text: input.text,
      markupSyntax: GOOGLE_CHAT_MARKUP,
      ...(input.thread ? { thread: { name: input.thread } } : {})
    }
    const byClientId = `${input.space}/messages/${input.clientId}`
    const send = async (): Promise<GoogleChatMessageRef> => {
      const created = await this.request<MessageResource>('POST', `${input.space}/messages`, {
        query,
        body,
        retry: 'rate_limit_only'
      })
      this.noteAppIdentity(created.sender?.name)
      // Only Google's own echo says what the wire shows; a missing one is reported as missing, never as the input.
      return {
        name: created.name ?? byClientId,
        clientId: input.clientId,
        ...(created.text !== undefined ? { text: created.text } : {})
      }
    }
    return this.queueFor(input.space).enqueue(async () => {
      try {
        return await send()
      } catch (err) {
        const kind = err instanceof GoogleChatApiError ? err.kind : undefined
        if (kind !== 'already_exists' && kind !== 'ambiguous' && kind !== 'unavailable') throw err
        // The write may have landed: read the id back before anything is sent again (§5).
        const existing = await this.readMessage(byClientId)
        if (existing) return { ...existing, clientId: input.clientId }
        if (kind === 'already_exists') throw err
        // Nothing landed: the same request once more — same id, same body.
        return await send()
      }
    })
  }

  /** Edit a message this daemon created; `allowMissing` stays off so a deleted message is a `not_found`, never recreated. */
  async patchMessage(name: string, text: string): Promise<void> {
    await this.queueFor(spaceOf(name)).enqueue(() =>
      this.request<MessageResource>('PATCH', name, {
        query: { updateMask: 'text' },
        body: { text, markupSyntax: GOOGLE_CHAT_MARKUP },
        retry: 'idempotent'
      })
    )
  }

  /** Read one message back by resource name or `client-` id; undefined when Google has no such message. */
  async getMessage(name: string): Promise<GoogleChatMessageRef | undefined> {
    return this.queueFor(spaceOf(name)).enqueue(() => this.readMessage(name))
  }

  /** Post chrome (a command reply, a failure notice) with a per-call request id, so a retry cannot double-post. */
  async postChrome(space: string, thread: string | undefined, text: string): Promise<void> {
    const query: Record<string, string> = { requestId: this.newRequestId() }
    if (thread) query.messageReplyOption = 'REPLY_MESSAGE_OR_FAIL'
    const body = { text, markupSyntax: GOOGLE_CHAT_MARKUP, ...(thread ? { thread: { name: thread } } : {}) }
    await this.queueFor(space).enqueue(async () => {
      const created = await this.request<MessageResource>('POST', `${space}/messages`, {
        query,
        body,
        retry: 'idempotent'
      })
      this.noteAppIdentity(created.sender?.name)
    })
  }

  // ── 3. read port ──

  async getChannelInfo(channel: string, opts: { signal?: AbortSignal } = {}): Promise<PlatformChannelInfo> {
    const space = await this.request<SpaceResource>('GET', channel, {
      retry: 'none',
      signal: opts.signal ?? AbortSignal.timeout(GOOGLE_CHAT_READ_DEADLINE_MS)
    })
    const isIm = space.spaceType === 'DIRECT_MESSAGE'
    return {
      id: channel,
      ...(space.displayName ? { name: space.displayName } : {}),
      isIm,
      isPrivate: space.spaceType !== 'SPACE'
    }
  }

  /** No member enumeration in this version: a Space's roster is not something a turn reads. */
  async listMembers(_channel: string): Promise<PlatformMemberRef[]> {
    return []
  }

  /** The named Spaces the app is a member of, as the observed conversation rows (§5); DMs surface from traffic. */
  async listChannels(opts: { signal?: AbortSignal } = {}): Promise<PlatformChannelRef[]> {
    const spaces = await this.listSpaces(opts.signal ?? AbortSignal.timeout(GOOGLE_CHAT_READ_DEADLINE_MS))
    return spaces
      .filter((space) => space.spaceType === 'SPACE' && space.name)
      .map((space) => ({
        id: space.name!,
        ...(space.displayName ? { name: space.displayName } : {}),
        isPrivate: false
      }))
  }

  /** Google exposes no app-authenticated profile read; the sender's display name rides the message itself. */
  async getUserProfile(user: string): Promise<PlatformUserProfile> {
    return { id: user }
  }

  /** Attachments are unsupported in both directions (§5): never fetched, never claimed. */
  async downloadFile(_ref: string, _maxBytes?: number): Promise<Buffer | null> {
    return null
  }

  // ── token ──

  /** A live access token: the cache while it is outside the renewal margin, else one single-flight mint. */
  async token(): Promise<string> {
    const now = this.now()
    if (this.cached && this.cached.expiresAtMs - now > TOKEN_RENEW_MARGIN_MS) return this.cached.token
    if (now < this.mintBlockedUntil) {
      if (this.cached && this.cached.expiresAtMs > now) return this.cached.token
      throw this.mintFailure ?? new GoogleChatApiError('token mint is backing off', 'unavailable')
    }
    return (await this.mint()).token
  }

  private mint(): Promise<CachedToken> {
    if (this.minting) return this.minting
    const pending = this.mintOnce()
      .then((token) => {
        this.cached = token
        this.mintFailure = undefined
        return token
      })
      .catch((err: unknown) => {
        this.mintBlockedUntil = this.now() + TOKEN_RETRY_MS
        this.mintFailure = err instanceof GoogleChatApiError ? err : undefined
        throw err
      })
      .finally(() => {
        this.minting = undefined
      })
    this.minting = pending
    return pending
  }

  /** One JWT-bearer grant: `iss` the service account, `scope` chat.bot, `aud` the fixed token endpoint (§3). */
  private async mintOnce(): Promise<CachedToken> {
    if (this.parsedKey instanceof GoogleChatApiError) throw this.parsedKey
    const key = this.parsedKey
    const issuedAt = Math.floor(this.now() / 1000)
    const assertion = await new SignJWT({ scope: GOOGLE_CHAT_BOT_SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', ...(key.privateKeyId ? { kid: key.privateKeyId } : {}) })
      .setIssuer(key.clientEmail)
      .setAudience(GOOGLE_TOKEN_ENDPOINT)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 3_600)
      .sign(key.signingKey)
    let res: Response
    try {
      res = await this.fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
    } catch (err) {
      throw new GoogleChatApiError(`token endpoint unreachable: ${(err as Error).message}`, 'unavailable')
    }
    const body = await readJson(res)
    if (!res.ok) {
      const code = typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`
      // 4xx names the credential (`invalid_grant`, `invalid_client`); anything else is Google's side.
      const kind: GoogleChatFailureKind = res.status >= 400 && res.status < 500 ? 'credential_rejected' : 'unavailable'
      throw new GoogleChatApiError(`token endpoint refused the service-account grant (${code})`, kind, res.status)
    }
    const token = typeof body?.access_token === 'string' ? body.access_token : undefined
    const expiresIn = typeof body?.expires_in === 'number' ? body.expires_in : 3_600
    if (!token) throw new GoogleChatApiError('token endpoint answered without an access token', 'unavailable')
    return { token, expiresAtMs: this.now() + expiresIn * 1000 }
  }

  // ── REST transport ──

  /** One Chat API call with bounded, jittered retries: `idempotent` retries every retryable refusal, `rate_limit_only` just a 429. */
  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    opts: {
      query?: Record<string, string>
      body?: unknown
      retry: 'idempotent' | 'rate_limit_only' | 'none'
      signal?: AbortSignal
    }
  ): Promise<T> {
    if (this.stopped) throw new GoogleChatApiError('connection stopped', 'unavailable')
    const url = new URL(`${GOOGLE_CHAT_API_ROOT}/${path}`)
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v)
    let refreshed = false
    for (let attempt = 1; ; attempt += 1) {
      const token = await this.token()
      let err: GoogleChatApiError
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {})
          },
          ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
          signal: opts.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        })
        if (res.ok) return ((await readJson(res)) ?? {}) as T
        const detail = errorDetail(await readJson(res), res.status)
        // One 401 may be a token that aged out under us: drop the cache and try once with a fresh mint.
        if (res.status === 401 && !refreshed) {
          refreshed = true
          this.cached = undefined
          continue
        }
        err = new GoogleChatApiError(
          `chat api ${method} ${path} failed: ${detail}`,
          classifyStatus(res.status),
          res.status,
          retryAfterMs(res, this.now())
        )
      } catch (thrown) {
        if (thrown instanceof GoogleChatApiError) throw thrown
        err = new GoogleChatApiError(
          `chat api ${method} ${path} did not answer: ${(thrown as Error).message}`,
          'ambiguous'
        )
      }
      const retry =
        opts.retry === 'idempotent'
          ? err.retryable
          : opts.retry === 'rate_limit_only'
            ? err.kind === 'rate_limited'
            : false
      if (!retry || attempt >= SEND_MAX_ATTEMPTS) throw err
      const backoff = err.retryAfterMs ?? SEND_RETRY_BASE_MS * 2 ** (attempt - 1) * (1 + this.random() * 0.25)
      await this.sleep(Math.min(backoff, SEND_RETRY_CAP_MS))
    }
  }

  private async readMessage(name: string): Promise<GoogleChatMessageRef | undefined> {
    try {
      const message = await this.request<MessageResource>('GET', name, { retry: 'idempotent' })
      this.noteAppIdentity(message.sender?.name)
      return { name: message.name ?? name, ...(message.text !== undefined ? { text: message.text } : {}) }
    } catch (err) {
      if (err instanceof GoogleChatApiError && err.kind === 'not_found') return undefined
      throw err
    }
  }

  private async listSpaces(signal: AbortSignal): Promise<SpaceResource[]> {
    const spaces: SpaceResource[] = []
    let pageToken: string | undefined
    do {
      const page = await this.request<{ spaces?: SpaceResource[]; nextPageToken?: string }>('GET', 'spaces', {
        query: { pageSize: String(SPACES_PAGE_SIZE), ...(pageToken ? { pageToken } : {}) },
        retry: 'none',
        signal
      })
      spaces.push(...(page.spaces ?? []))
      pageToken = page.nextPageToken
    } while (pageToken && spaces.length < MAX_LISTED_SPACES)
    return spaces
  }

  /** `members/app` in any Space the app is in names its `users/…` identity; with no Space yet, the first create does (§5). */
  private async discoverIdentity(): Promise<void> {
    if (this.appUserName) return
    const signal = AbortSignal.timeout(GOOGLE_CHAT_READ_DEADLINE_MS)
    const first = (await this.listSpaces(signal)).find((space) => space.name)
    if (!first?.name) return
    const membership = await this.request<{ member?: { name?: string } }>('GET', `${first.name}/members/app`, {
      retry: 'none',
      signal
    })
    this.noteAppIdentity(membership.member?.name)
  }

  private noteAppIdentity(name: string | undefined): void {
    if (!this.appUserName && name && /^users\/[^/]+$/.test(name)) this.appUserName = name
  }

  private queueFor(space: string): PlatformSendQueue {
    let queue = this.queues.get(space)
    if (!queue) {
      queue = new PlatformSendQueue(this.sendIntervalMs, this.now, this.sleep)
      this.queues.set(space, queue)
    }
    return queue
  }
}

/** The Space a message resource name lives in — the write queue's key. */
export function spaceOf(name: string): string {
  const m = /^(spaces\/[^/]+)/.exec(name)
  return m?.[1] ?? name
}
