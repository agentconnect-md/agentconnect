// How a Google Chat row's calls leave the daemon (google-chat-integration.md §5, §10.10): straight to Google with an organization's own key, or through the relay for the deployment app.
import { createPrivateKey, type KeyObject } from 'node:crypto'
import { SignJWT } from 'jose'
import {
  GOOGLE_CHAT_PLATFORM,
  WireGoogleChatCallResult,
  googleChatCallRequest,
  type RdPlatformReply,
  type WireGoogleChatCall
} from '@agentconnect.md/protocol'
import type { Logger } from '../../log.js'
import { PlatformRelayUnsent, type PlatformRelay } from '../platform-relay.js'

/** Google's fixed OAuth token endpoint; the key's own `token_uri` is never followed (§3). */
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
/** The fixed Chat API root; no endpoint override is accepted (§3). */
export const GOOGLE_CHAT_API_ROOT = 'https://chat.googleapis.com/v1'
/** App authentication only: no user impersonation, no domain-wide delegation (§3). */
export const GOOGLE_CHAT_BOT_SCOPE = 'https://www.googleapis.com/auth/chat.bot'
/** Renew the hour-long access token this far before it expires. */
export const TOKEN_RENEW_MARGIN_MS = 5 * 60 * 1000
/** How long a failed mint blocks the next attempt, so a rejected key is not hammered per send. */
export const TOKEN_RETRY_MS = 30_000
const REQUEST_TIMEOUT_MS = 15_000

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
  | 'tenant_refused'

/** A Chat API or token-endpoint refusal; `ambiguous` means the request may have landed. */
export class GoogleChatApiError extends Error {
  constructor(
    message: string,
    readonly kind: GoogleChatFailureKind,
    readonly status?: number,
    /** The provider's own `Retry-After`, when it sent one — preferred over our backoff. */
    readonly retryAfterMs?: number,
    /** The call's operation never reached Google, so any call may be repeated under the retry bound. */
    readonly unsent: boolean = false
  ) {
    super(message)
    this.name = 'GoogleChatApiError'
  }

  /** Worth another attempt of an idempotent request. */
  get retryable(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'unavailable' || this.kind === 'ambiguous'
  }
}

/** Google's answer to one attempt: its status, its JSON body and its own backoff. */
export type GoogleChatAnswer = WireGoogleChatCallResult

/** One attempt of one call; throws a {@link GoogleChatApiError} that says whether to stop, and anything else when the call went unanswered. */
export interface GoogleChatTransport {
  /** Whether a create whose answer was lost may be sent again under its own id; a relay row never does, since its write may have landed (§10.10). */
  readonly resendsAmbiguousCreate: boolean
  /** Warm whatever the first call would otherwise wait for; no read is made. */
  start(): Promise<void>
  attempt(call: WireGoogleChatCall, signal?: AbortSignal): Promise<GoogleChatAnswer>
  /** A 401 may be a token that aged out: drop it, where this side holds one. */
  invalidate(): void
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
  } catch (err) {
    if (err instanceof SyntaxError) return undefined
    throw err
  }
}

/** An organization's own app: its key mints `chat.bot` tokens here, and each call goes straight to Google. */
export class DirectGoogleChatTransport implements GoogleChatTransport {
  readonly resendsAmbiguousCreate = true
  private readonly parsedKey: ParsedKey | GoogleChatApiError
  private cached: CachedToken | undefined
  /** Single-flight mint: concurrent sends inside the margin issue one token request. */
  private minting: Promise<CachedToken> | undefined
  private mintBlockedUntil = 0
  private mintFailure: GoogleChatApiError | undefined

  constructor(
    serviceAccountKey: string,
    private readonly fetchImpl: typeof fetch,
    private readonly now: () => number,
    log: Logger | undefined,
    integrationId: string
  ) {
    this.parsedKey = parseServiceAccountKey(serviceAccountKey)
    if (this.parsedKey instanceof GoogleChatApiError)
      log?.warn(`googlechat: integration ${integrationId}: ${this.parsedKey.message}`)
  }

  async start(): Promise<void> {
    await this.token()
  }

  invalidate(): void {
    this.cached = undefined
  }

  async attempt(call: WireGoogleChatCall, signal?: AbortSignal): Promise<GoogleChatAnswer> {
    const token = await this.token()
    const request = googleChatCallRequest(call)
    const url = new URL(`${GOOGLE_CHAT_API_ROOT}/${request.path}`)
    for (const [k, v] of Object.entries(request.query ?? {})) url.searchParams.set(k, v)
    const res = await this.fetchImpl(url, {
      method: request.method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(request.body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
      signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    const body = await readJson(res)
    const wait = res.ok ? undefined : retryAfterMs(res, this.now())
    return { status: res.status, ...(body ? { body } : {}), ...(wait !== undefined ? { retryAfterMs: wait } : {}) }
  }

  /** A live access token: the cache while it is outside the renewal margin, else one single-flight mint. */
  private async token(): Promise<string> {
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
}

const refusalKinds: Record<string, GoogleChatFailureKind> = {
  tenant_refused: 'tenant_refused',
  invalid: 'invalid'
}

// A signal that fires ends the wait for the relay; the request itself may still be answered there.
async function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return await work
  signal.throwIfAborted()
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason as Error)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([work, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort!)
    work.catch(() => {})
  }
}

/** The deployment app's customer row: no key and no token here; the relay checks and performs each call (§10.10). Without a relay nothing can be sent, and there is no other way out. */
export class RelayGoogleChatTransport implements GoogleChatTransport {
  readonly resendsAmbiguousCreate = false

  constructor(
    private readonly relay: PlatformRelay | undefined,
    private readonly botId: string
  ) {}

  async start(): Promise<void> {}

  invalidate(): void {}

  async attempt(call: WireGoogleChatCall, signal?: AbortSignal): Promise<GoogleChatAnswer> {
    if (!this.relay)
      throw new GoogleChatApiError('googlechat: no relay is reachable', 'unavailable', undefined, undefined, true)
    let reply: RdPlatformReply
    try {
      reply = await untilAborted(
        this.relay.request({ platformId: GOOGLE_CHAT_PLATFORM, botId: this.botId, payload: call }),
        signal
      )
    } catch (err) {
      if (err instanceof PlatformRelayUnsent)
        throw new GoogleChatApiError('googlechat: no relay is reachable', 'unavailable', undefined, undefined, true)
      throw new Error('the relay did not answer')
    }
    if (reply.outcome === 'unavailable')
      throw new GoogleChatApiError(
        'googlechat: the relay could not reach Google',
        'unavailable',
        undefined,
        undefined,
        true
      )
    // A refusal the relays' assignments may still lift is retried as unsent, a bounded number of times; nothing reached Google.
    if (reply.outcome === 'refused') {
      const message = `googlechat: the relay refused the call (${reply.reason ?? 'refused'})`
      if (reply.retryable === true) throw new GoogleChatApiError(message, 'unavailable', undefined, undefined, true)
      throw new GoogleChatApiError(message, refusalKinds[reply.reason ?? ''] ?? 'forbidden')
    }
    const parsed = WireGoogleChatCallResult.safeParse(reply.payload)
    if (!parsed.success) throw new Error('the relay answered an unreadable result')
    return parsed.data
  }
}
