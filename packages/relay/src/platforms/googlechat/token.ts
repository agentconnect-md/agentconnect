// Google Chat bearer-token verification (google-chat-integration.md §2, §11): a Chat app's token or a Workspace add-on's Google ID token.
import { decodeJwt, decodeProtectedHeader, importJWK, importX509, jwtVerify, type JWTPayload } from 'jose'
import type { Logger } from '../../log.js'

/** The service account Google signs every Chat app's interaction token as. */
export const GOOGLE_CHAT_TOKEN_ISSUER = 'chat@system.gserviceaccount.com'

/** Google's certificate map for that issuer: a JSON object of `kid` → PEM x509 certificate. */
export const GOOGLE_CHAT_CERTIFICATE_URL =
  'https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com'

/** The issuer spellings of a Google ID token, which is what a Workspace add-on's request carries (§11). */
export const GOOGLE_ID_TOKEN_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

/** Google's OIDC signing keys, as a JWKS. */
export const GOOGLE_OIDC_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'

/** Google issues each token for one hour; a minute absorbs clock skew without stretching that. */
export const GOOGLE_CHAT_CLOCK_TOLERANCE_SEC = 60

/** How long a key set is trusted when Google's response carries no `max-age`. */
export const GOOGLE_CHAT_CERTIFICATE_TTL_MS = 60 * 60 * 1000

/** The least time between two fetches an inbound request can cause, so a forged `kid` cannot drive traffic to Google. */
export const GOOGLE_CHAT_CERTIFICATE_REFETCH_MS = 5 * 60 * 1000

/** Google publishes two or three keys at a time; a set is never allowed to grow past this. */
export const GOOGLE_CHAT_MAX_KEYS = 16

// A Workspace add-on's per-project service account, the only identity its requests are signed for (§11).
const ADD_ON_SERVICE_ACCOUNT = /^service-([1-9]\d{0,19})@gcp-sa-gsuiteaddons\.iam\.gserviceaccount\.com$/
const MIN_TTL_MS = 60 * 1000
const MAX_TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 5_000

type VerificationKey = Awaited<ReturnType<typeof importX509>> | Awaited<ReturnType<typeof importJWK>>

/** Which of Google's two request forms a token belongs to: a Chat app's, or a Workspace add-on's (§11). */
export type GoogleChatTokenForm = 'chat' | 'addon'

/** The claims a verified token proved, with the audience it was checked against. */
export interface GoogleChatTokenClaims {
  form: GoogleChatTokenForm
  aud: string
  iss: string
  iat: number
  exp: number
}

/** What a token must prove for one app: its project number, and the events URL an add-on token's audience must be. */
export interface GoogleChatTokenExpectation {
  projectNumber: string
  eventsUrl?: string
}

/** The bearer token behind `Authorization`, or undefined when the header carries none. */
export function bearerToken(authorization: string | string[] | undefined): string | undefined {
  if (typeof authorization !== 'string') return undefined
  return /^Bearer\s+(\S+)$/i.exec(authorization.trim())?.[1]
}

/** The project number of a Workspace add-on's service account, or undefined for any other email. */
export function addOnProjectNumber(email: unknown): string | undefined {
  return typeof email === 'string' ? ADD_ON_SERVICE_ACCOUNT.exec(email)?.[1] : undefined
}

function unverifiedClaims(authorization: string | string[] | undefined): JWTPayload | undefined {
  const token = bearerToken(authorization)
  if (!token) return undefined
  try {
    return decodeJwt(token)
  } catch {
    return undefined
  }
}

/** The token's UNVERIFIED project number — a Chat token's audience, an add-on token's service account — a demux hint only (§2, §11). */
export function unverifiedProjectNumber(authorization: string | string[] | undefined): string | undefined {
  const claims = unverifiedClaims(authorization)
  if (!claims) return undefined
  if (claims.iss === GOOGLE_CHAT_TOKEN_ISSUER) {
    const aud = claims.aud
    return typeof aud === 'string' ? aud : Array.isArray(aud) && aud.length === 1 ? aud[0] : undefined
  }
  return GOOGLE_ID_TOKEN_ISSUERS.includes(claims.iss ?? '') ? addOnProjectNumber(claims.email) : undefined
}

// Google's `max-age`, clamped so a bad directive neither pins a revoked key nor refetches per request.
function ttlFrom(cacheControl: string | null): number {
  const m = cacheControl ? /(?:^|[\s,])max-age=(\d+)/i.exec(cacheControl) : null
  if (!m) return GOOGLE_CHAT_CERTIFICATE_TTL_MS
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Number(m[1]) * 1000))
}

type KeyReader = (body: unknown, log: Logger | undefined) => Promise<Map<string, VerificationKey>>

// The x509 map Google publishes for the Chat issuer.
const readCertificateMap: KeyReader = async (body, log) => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('not a certificate map')
  const keys = new Map<string, VerificationKey>()
  for (const [kid, pem] of Object.entries(body as Record<string, unknown>).slice(0, GOOGLE_CHAT_MAX_KEYS)) {
    if (typeof pem !== 'string') continue
    try {
      keys.set(kid, await importX509(pem, 'RS256'))
    } catch {
      log?.warn(`googlechat ingress: skipped an unreadable certificate for kid ${kid}`)
    }
  }
  return keys
}

// Google's OIDC JWKS: RSA signing keys only.
const readJwks: KeyReader = async (body, log) => {
  const list = (body as { keys?: unknown } | null)?.keys
  if (!Array.isArray(list)) throw new Error('not a JWKS')
  const keys = new Map<string, VerificationKey>()
  for (const entry of list.slice(0, GOOGLE_CHAT_MAX_KEYS)) {
    const jwk = entry as Record<string, unknown> | null
    const kid = jwk?.kid
    if (typeof kid !== 'string' || jwk?.kty !== 'RSA') continue
    if ((jwk.alg !== undefined && jwk.alg !== 'RS256') || (jwk.use !== undefined && jwk.use !== 'sig')) continue
    try {
      keys.set(kid, await importJWK({ kty: 'RSA', n: jwk.n as string, e: jwk.e as string }, 'RS256'))
    } catch {
      log?.warn(`googlechat ingress: skipped an unreadable signing key for kid ${kid}`)
    }
  }
  return keys
}

/** One of Google's published key sets by `kid`: honours `max-age`, keeps the last good set, refetches an unknown kid at most once a spacing. */
class GoogleKeySet {
  private keys = new Map<string, VerificationKey>()
  private staleAt = 0
  private lastUnknownKidFetchAt = Number.NEGATIVE_INFINITY
  private inflight: Promise<void> | undefined

  constructor(
    private readonly url: string,
    private readonly read: KeyReader,
    private readonly fetchImpl: typeof fetch,
    private readonly log: () => Logger | undefined
  ) {}

  // The cached key for `kid`: refresh a stale set first, and once more for an unknown kid when the spacing allows.
  async key(kid: string, now: number): Promise<VerificationKey | undefined> {
    let refreshed = false
    if (now >= this.staleAt) {
      await this.refresh(now)
      refreshed = true
    }
    const known = this.keys.get(kid)
    if (known) return known
    if (refreshed || now - this.lastUnknownKidFetchAt < GOOGLE_CHAT_CERTIFICATE_REFETCH_MS) return undefined
    this.lastUnknownKidFetchAt = now
    await this.refresh(now)
    return this.keys.get(kid)
  }

  // Concurrent callers share one fetch.
  private refresh(now: number): Promise<void> {
    this.inflight ??= this.fetchKeys(now).finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  private async fetchKeys(now: number): Promise<void> {
    try {
      const response = await this.fetchImpl(this.url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const keys = await this.read(await response.json(), this.log())
      if (keys.size === 0) throw new Error('no usable key')
      this.keys = keys
      this.staleAt = now + ttlFrom(response.headers.get('cache-control'))
    } catch (err) {
      // Keep the last good set and retry no sooner than the spacing: one failed fetch must not 401 every callback.
      this.staleAt = now + GOOGLE_CHAT_CERTIFICATE_REFETCH_MS
      this.log()?.warn(`googlechat ingress: signing key refresh from ${this.url} failed: ${(err as Error).message}`)
    }
  }
}

/** One process-wide cache of Google's signing keys for both token forms, shared by every Google Chat bot's ingest. */
export class GoogleChatCertificateStore {
  private readonly chat: GoogleKeySet
  private readonly oidc: GoogleKeySet
  /** Set by the first ingest built; the store exists before any host does. */
  log: Logger | undefined

  constructor(fetchImpl: typeof fetch) {
    this.chat = new GoogleKeySet(GOOGLE_CHAT_CERTIFICATE_URL, readCertificateMap, fetchImpl, () => this.log)
    this.oidc = new GoogleKeySet(GOOGLE_OIDC_JWKS_URL, readJwks, fetchImpl, () => this.log)
  }

  /** Verify one bearer token for one app on the host clock; any failure is undefined (the route's 401). */
  async verify(
    token: string,
    expected: GoogleChatTokenExpectation,
    now: number
  ): Promise<GoogleChatTokenClaims | undefined> {
    let kid: string
    let issuer: unknown
    try {
      const header = decodeProtectedHeader(token)
      if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid === '') return undefined
      kid = header.kid
      issuer = decodeJwt(token).iss
    } catch {
      return undefined
    }
    // The unverified issuer only picks the key set; the verified payload must name the same issuer.
    if (issuer === GOOGLE_CHAT_TOKEN_ISSUER) {
      const payload = await this.verifyWith(
        this.chat,
        token,
        kid,
        [GOOGLE_CHAT_TOKEN_ISSUER],
        expected.projectNumber,
        now
      )
      return payload && claimsOf('chat', payload, expected.projectNumber)
    }
    if (typeof issuer !== 'string' || !GOOGLE_ID_TOKEN_ISSUERS.includes(issuer) || !expected.eventsUrl) return undefined
    const payload = await this.verifyWith(this.oidc, token, kid, GOOGLE_ID_TOKEN_ISSUERS, expected.eventsUrl, now)
    // Google vouches for the add-on's own service account, and its project number is the app's identity (§11).
    if (!payload || payload.email_verified !== true || addOnProjectNumber(payload.email) !== expected.projectNumber)
      return undefined
    return claimsOf('addon', payload, expected.eventsUrl)
  }

  private async verifyWith(
    keys: GoogleKeySet,
    token: string,
    kid: string,
    issuers: string[],
    audience: string,
    now: number
  ): Promise<JWTPayload | undefined> {
    const key = await keys.key(kid, now)
    if (!key) return undefined
    try {
      const { payload } = await jwtVerify(token, key, {
        algorithms: ['RS256'],
        issuer: issuers,
        audience,
        requiredClaims: ['exp', 'iat'],
        clockTolerance: GOOGLE_CHAT_CLOCK_TOLERANCE_SEC,
        currentDate: new Date(now)
      })
      return payload
    } catch {
      return undefined
    }
  }
}

function claimsOf(form: GoogleChatTokenForm, payload: JWTPayload, aud: string): GoogleChatTokenClaims | undefined {
  if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number' || typeof payload.iss !== 'string')
    return undefined
  return { form, aud, iss: payload.iss, iat: payload.iat, exp: payload.exp }
}
