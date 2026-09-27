// Google Chat bearer-token verification (google-chat-integration.md §2): RS256 against Google's published Chat certificates.
import { decodeJwt, decodeProtectedHeader, importX509, jwtVerify } from 'jose'
import type { Logger } from '../../log.js'

/** The service account Google signs every Chat interaction token as. */
export const GOOGLE_CHAT_TOKEN_ISSUER = 'chat@system.gserviceaccount.com'

/** Google's certificate map for that issuer: a JSON object of `kid` → PEM x509 certificate. */
export const GOOGLE_CHAT_CERTIFICATE_URL =
  'https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com'

/** Google issues each token for one hour; a minute absorbs clock skew without stretching that. */
export const GOOGLE_CHAT_CLOCK_TOLERANCE_SEC = 60

/** How long a certificate map is trusted when Google's response carries no `max-age`. */
export const GOOGLE_CHAT_CERTIFICATE_TTL_MS = 60 * 60 * 1000

/** The least time between two fetches an inbound request can cause, so a forged `kid` cannot drive traffic to Google. */
export const GOOGLE_CHAT_CERTIFICATE_REFETCH_MS = 5 * 60 * 1000

const MIN_TTL_MS = 60 * 1000
const MAX_TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 5_000

type VerificationKey = Awaited<ReturnType<typeof importX509>>

/** The claims a verified token proved, with the audience it was checked against. */
export interface GoogleChatTokenClaims {
  aud: string
  iss: string
  iat: number
  exp: number
}

/** The bearer token behind `Authorization`, or undefined when the header carries none. */
export function bearerToken(authorization: string | string[] | undefined): string | undefined {
  if (typeof authorization !== 'string') return undefined
  return /^Bearer\s+(\S+)$/i.exec(authorization.trim())?.[1]
}

/** The token's UNVERIFIED audience — a demux hint only (§2), never an authority. */
export function unverifiedAudience(authorization: string | string[] | undefined): string | undefined {
  const token = bearerToken(authorization)
  if (!token) return undefined
  try {
    const aud = decodeJwt(token).aud
    return typeof aud === 'string' ? aud : Array.isArray(aud) && aud.length === 1 ? aud[0] : undefined
  } catch {
    return undefined
  }
}

// Google's `max-age`, clamped so a bad directive neither pins a revoked certificate nor refetches per request.
function ttlFrom(cacheControl: string | null): number {
  const m = cacheControl ? /(?:^|[\s,])max-age=(\d+)/i.exec(cacheControl) : null
  if (!m) return GOOGLE_CHAT_CERTIFICATE_TTL_MS
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Number(m[1]) * 1000))
}

/** One process-wide cache of Google's Chat certificates, shared by every Google Chat bot's ingest. */
export class GoogleChatCertificateStore {
  private keys = new Map<string, VerificationKey>()
  private staleAt = 0
  private lastUnknownKidFetchAt = Number.NEGATIVE_INFINITY
  private inflight: Promise<void> | undefined
  /** Set by the first ingest built; the store exists before any host does. */
  log: Logger | undefined

  constructor(private readonly fetchImpl: typeof fetch) {}

  /** Verify one bearer token for `audience` on the host clock; any failure is undefined (the route's 401). */
  async verify(token: string, audience: string, now: number): Promise<GoogleChatTokenClaims | undefined> {
    let kid: string
    try {
      const header = decodeProtectedHeader(token)
      if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid === '') return undefined
      kid = header.kid
    } catch {
      return undefined
    }
    const key = await this.keyFor(kid, now)
    if (!key) return undefined
    try {
      const { payload } = await jwtVerify(token, key, {
        algorithms: ['RS256'],
        issuer: GOOGLE_CHAT_TOKEN_ISSUER,
        audience,
        requiredClaims: ['exp', 'iat'],
        clockTolerance: GOOGLE_CHAT_CLOCK_TOLERANCE_SEC,
        currentDate: new Date(now)
      })
      if (
        typeof payload.exp !== 'number' ||
        typeof payload.iat !== 'number' ||
        payload.iss !== GOOGLE_CHAT_TOKEN_ISSUER
      )
        return undefined
      return { aud: audience, iss: payload.iss, iat: payload.iat, exp: payload.exp }
    } catch {
      return undefined
    }
  }

  // The cached key for `kid`: refresh a stale map first, and once more for an unknown kid when the spacing allows.
  private async keyFor(kid: string, now: number): Promise<VerificationKey | undefined> {
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
    this.inflight ??= this.fetchCertificates(now).finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  private async fetchCertificates(now: number): Promise<void> {
    try {
      const response = await this.fetchImpl(GOOGLE_CHAT_CERTIFICATE_URL, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body: unknown = await response.json()
      if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('not a certificate map')
      const keys = new Map<string, VerificationKey>()
      for (const [kid, pem] of Object.entries(body as Record<string, unknown>)) {
        if (typeof pem !== 'string') continue
        try {
          keys.set(kid, await importX509(pem, 'RS256'))
        } catch {
          this.log?.warn(`googlechat ingress: skipped an unreadable certificate for kid ${kid}`)
        }
      }
      if (keys.size === 0) throw new Error('no usable certificate')
      this.keys = keys
      this.staleAt = now + ttlFrom(response.headers.get('cache-control'))
    } catch (err) {
      // Keep the last good map and retry no sooner than the spacing: one failed fetch must not 401 every callback.
      this.staleAt = now + GOOGLE_CHAT_CERTIFICATE_REFETCH_MS
      this.log?.warn(`googlechat ingress: certificate refresh failed: ${(err as Error).message}`)
    }
  }
}
