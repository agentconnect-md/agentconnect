// Google Chat bearer-token verification (google-chat-integration.md §11.2): the Google ID token a Workspace add-on's request carries.
import { decodeJwt, decodeProtectedHeader, importJWK, jwtVerify, type JWTPayload } from 'jose'
import type { Logger } from '../../log.js'

/** The issuer spellings of a Google ID token. */
export const GOOGLE_ID_TOKEN_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

/** Google's OIDC signing keys, as a JWKS. */
export const GOOGLE_OIDC_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'

/** Google issues each token for one hour; a minute absorbs clock skew without stretching that. */
export const GOOGLE_CHAT_CLOCK_TOLERANCE_SEC = 60

/** How long the key set is trusted when Google's response carries no `max-age`. */
export const GOOGLE_CHAT_KEYS_TTL_MS = 60 * 60 * 1000

/** The least time between two fetches an inbound request can cause, so a forged `kid` cannot drive traffic to Google. */
export const GOOGLE_CHAT_KEYS_REFETCH_MS = 5 * 60 * 1000

/** Google publishes two or three keys at a time; the set is never allowed to grow past this. */
export const GOOGLE_CHAT_MAX_KEYS = 16

// A Workspace add-on's per-project service account, the only identity its requests are signed for.
const ADD_ON_SERVICE_ACCOUNT = /^service-([1-9]\d{0,19})@gcp-sa-gsuiteaddons\.iam\.gserviceaccount\.com$/
const MIN_TTL_MS = 60 * 1000
const MAX_TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 5_000

type VerificationKey = Awaited<ReturnType<typeof importJWK>>

/** The claims a verified token proved, with the audience it was checked against. */
export interface GoogleChatTokenClaims {
  aud: string
  iss: string
  iat: number
  exp: number
}

/** What a token must prove for one app: the project number of its signing service account, and the events URL as its audience. */
export interface GoogleChatTokenExpectation {
  projectNumber: string
  eventsUrl: string
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

/** The token's UNVERIFIED project number, read from its service account: a demux hint only. */
export function unverifiedProjectNumber(authorization: string | string[] | undefined): string | undefined {
  const token = bearerToken(authorization)
  if (!token) return undefined
  let claims: JWTPayload
  try {
    claims = decodeJwt(token)
  } catch {
    return undefined
  }
  return GOOGLE_ID_TOKEN_ISSUERS.includes(claims.iss ?? '') ? addOnProjectNumber(claims.email) : undefined
}

// Google's `max-age`, clamped so a bad directive neither pins a revoked key nor refetches per request.
function ttlFrom(cacheControl: string | null): number {
  const m = cacheControl ? /(?:^|[\s,])max-age=(\d+)/i.exec(cacheControl) : null
  if (!m) return GOOGLE_CHAT_KEYS_TTL_MS
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Number(m[1]) * 1000))
}

// Google's OIDC JWKS: RSA signing keys only.
async function readJwks(body: unknown, log: Logger | undefined): Promise<Map<string, VerificationKey>> {
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

/** Google's published signing keys by `kid`: honours `max-age`, keeps the last good set, refetches an unknown kid at most once a spacing. */
class GoogleKeySet {
  private keys = new Map<string, VerificationKey>()
  private staleAt = 0
  private lastUnknownKidFetchAt = Number.NEGATIVE_INFINITY
  private inflight: Promise<void> | undefined

  constructor(
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
    if (refreshed || now - this.lastUnknownKidFetchAt < GOOGLE_CHAT_KEYS_REFETCH_MS) return undefined
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
      const response = await this.fetchImpl(GOOGLE_OIDC_JWKS_URL, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const keys = await readJwks(await response.json(), this.log())
      if (keys.size === 0) throw new Error('no usable key')
      this.keys = keys
      this.staleAt = now + ttlFrom(response.headers.get('cache-control'))
    } catch (err) {
      // Keep the last good set and retry no sooner than the spacing: one failed fetch must not 401 every callback.
      this.staleAt = now + GOOGLE_CHAT_KEYS_REFETCH_MS
      this.log()?.warn(
        `googlechat ingress: signing key refresh from ${GOOGLE_OIDC_JWKS_URL} failed: ${(err as Error).message}`
      )
    }
  }
}

/** One process-wide verifier over Google's signing keys, shared by every Google Chat bot's ingest. */
export class GoogleChatTokenVerifier {
  private readonly keys: GoogleKeySet
  /** Set by the first ingest built; the verifier exists before any host does. */
  log: Logger | undefined

  constructor(fetchImpl: typeof fetch) {
    this.keys = new GoogleKeySet(fetchImpl, () => this.log)
  }

  /** Verify one bearer token for one app on the host clock; any failure is undefined (the route's 401). */
  async verify(
    token: string,
    expected: GoogleChatTokenExpectation,
    now: number
  ): Promise<GoogleChatTokenClaims | undefined> {
    let kid: string
    try {
      const header = decodeProtectedHeader(token)
      if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid === '') return undefined
      kid = header.kid
      // Another issuer is refused before any key lookup; the verified payload must name a Google issuer too.
      if (!GOOGLE_ID_TOKEN_ISSUERS.includes(decodeJwt(token).iss ?? '')) return undefined
    } catch {
      return undefined
    }
    const key = await this.keys.key(kid, now)
    if (!key) return undefined
    let payload: JWTPayload
    try {
      ;({ payload } = await jwtVerify(token, key, {
        algorithms: ['RS256'],
        issuer: GOOGLE_ID_TOKEN_ISSUERS,
        audience: expected.eventsUrl,
        requiredClaims: ['exp', 'iat'],
        clockTolerance: GOOGLE_CHAT_CLOCK_TOLERANCE_SEC,
        currentDate: new Date(now)
      }))
    } catch {
      return undefined
    }
    // Google vouches for the add-on's own service account, and its project number is the app's identity.
    if (payload.email_verified !== true || addOnProjectNumber(payload.email) !== expected.projectNumber)
      return undefined
    if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number' || typeof payload.iss !== 'string')
      return undefined
    return { aud: expected.eventsUrl, iss: payload.iss, iat: payload.iat, exp: payload.exp }
  }
}
