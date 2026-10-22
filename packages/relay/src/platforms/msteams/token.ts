// Bot Framework inbound token verification (teams-integration.md §3): the JWT the Bot Connector signs on every activity it posts.
import { decodeJwt, decodeProtectedHeader, importJWK, jwtVerify, type JWTPayload } from 'jose'
import type { Logger } from '../../log.js'

/** The only issuer an inbound Bot Connector token may name; an Entra-issued token is refused. */
export const BOT_FRAMEWORK_ISSUER = 'https://api.botframework.com'

/** The Bot Framework's OpenID metadata, whose `jwks_uri` names the signing keys. */
export const BOT_FRAMEWORK_OPENID_CONFIG_URL = 'https://login.botframework.com/v1/.well-known/openidconfiguration'

/** The Bot Framework allows five minutes of clock skew. */
export const MSTEAMS_CLOCK_TOLERANCE_SEC = 5 * 60

/** How long the key set is trusted when the keys response carries no `max-age`. */
export const MSTEAMS_KEYS_TTL_MS = 60 * 60 * 1000

/** The least time between two fetches an inbound request can cause, so a forged `kid` cannot drive traffic to Microsoft. */
export const MSTEAMS_KEYS_REFETCH_MS = 5 * 60 * 1000

/** The key set is never allowed to grow past this. */
export const MSTEAMS_MAX_KEYS = 32

// A key that lists the channels it is endorsed for must name Teams.
const MSTEAMS_CHANNEL = 'msteams'
const MIN_TTL_MS = 60 * 1000
const MAX_TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 5_000

type VerificationKey = Awaited<ReturnType<typeof importJWK>>

/** The claims a verified token proved. */
export interface MsTeamsTokenClaims {
  aud: string
  iss: string
  exp: number
  serviceUrl: string
}

/** What a token must prove for one activity: the bot's app ID as its audience, and the activity's `serviceUrl` as its `serviceurl` claim. */
export interface MsTeamsTokenExpectation {
  appId: string
  serviceUrl: string
}

/** The bearer token behind `Authorization`, or undefined when the header carries none. */
export function bearerToken(authorization: string | string[] | undefined): string | undefined {
  if (typeof authorization !== 'string') return undefined
  return /^Bearer\s+(\S+)$/i.exec(authorization.trim())?.[1]
}

// The single audience a token names, as a string or a one-element list.
function audienceOf(claims: JWTPayload): string | undefined {
  const aud = Array.isArray(claims.aud) && claims.aud.length === 1 ? claims.aud[0] : claims.aud
  return typeof aud === 'string' && aud.length > 0 ? aud : undefined
}

/** The token's UNVERIFIED app ID, read from a Bot Framework token's audience: a demux hint only. */
export function unverifiedAppId(authorization: string | string[] | undefined): string | undefined {
  const token = bearerToken(authorization)
  if (!token) return undefined
  let claims: JWTPayload
  try {
    claims = decodeJwt(token)
  } catch {
    return undefined
  }
  return claims.iss === BOT_FRAMEWORK_ISSUER ? audienceOf(claims)?.toLowerCase() : undefined
}

// The keys response's `max-age`, clamped so a bad directive neither pins a revoked key nor refetches per request.
function ttlFrom(cacheControl: string | null): number {
  const m = cacheControl ? /(?:^|[\s,])max-age=(\d+)/i.exec(cacheControl) : null
  if (!m) return MSTEAMS_KEYS_TTL_MS
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Number(m[1]) * 1000))
}

// RSA signing keys only, and only those endorsed for Teams when the key lists its channels.
async function readJwks(body: unknown, log: Logger | undefined): Promise<Map<string, VerificationKey>> {
  const list = (body as { keys?: unknown } | null)?.keys
  if (!Array.isArray(list)) throw new Error('not a JWKS')
  const keys = new Map<string, VerificationKey>()
  for (const entry of list.slice(0, MSTEAMS_MAX_KEYS)) {
    const jwk = entry as Record<string, unknown> | null
    const kid = jwk?.kid
    if (typeof kid !== 'string' || jwk?.kty !== 'RSA') continue
    if ((jwk.alg !== undefined && jwk.alg !== 'RS256') || (jwk.use !== undefined && jwk.use !== 'sig')) continue
    if (
      jwk.endorsements !== undefined &&
      !(Array.isArray(jwk.endorsements) && jwk.endorsements.includes(MSTEAMS_CHANNEL))
    )
      continue
    try {
      keys.set(kid, await importJWK({ kty: 'RSA', n: jwk.n as string, e: jwk.e as string }, 'RS256'))
    } catch {
      log?.warn(`msteams ingress: skipped an unreadable signing key for kid ${kid}`)
    }
  }
  return keys
}

/** The Bot Framework's published signing keys by `kid`: honours `max-age`, keeps the last good set, refetches an unknown kid at most once a spacing. */
class BotFrameworkKeySet {
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
    if (refreshed || now - this.lastUnknownKidFetchAt < MSTEAMS_KEYS_REFETCH_MS) return undefined
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

  private async getJson(url: string): Promise<{ body: unknown; cacheControl: string | null }> {
    const response = await this.fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`)
    return { body: await response.json(), cacheControl: response.headers.get('cache-control') }
  }

  private async fetchKeys(now: number): Promise<void> {
    try {
      const config = await this.getJson(BOT_FRAMEWORK_OPENID_CONFIG_URL)
      const jwksUri = (config.body as { jwks_uri?: unknown } | null)?.jwks_uri
      if (typeof jwksUri !== 'string' || new URL(jwksUri).protocol !== 'https:') throw new Error('no https jwks_uri')
      const jwks = await this.getJson(jwksUri)
      const keys = await readJwks(jwks.body, this.log())
      if (keys.size === 0) throw new Error('no usable key')
      this.keys = keys
      this.staleAt = now + ttlFrom(jwks.cacheControl)
    } catch (err) {
      // Keep the last good set and retry no sooner than the spacing: one failed fetch must not 401 every activity.
      this.staleAt = now + MSTEAMS_KEYS_REFETCH_MS
      this.log()?.warn(`msteams ingress: Bot Framework signing key refresh failed: ${(err as Error).message}`)
    }
  }
}

/** One process-wide verifier over the Bot Framework's signing keys, shared by every Teams bot's ingest. */
export class MsTeamsTokenVerifier {
  private readonly keys: BotFrameworkKeySet
  /** Set by the first ingest built; the verifier exists before any host does. */
  log: Logger | undefined

  constructor(fetchImpl: typeof fetch) {
    this.keys = new BotFrameworkKeySet(fetchImpl, () => this.log)
  }

  /** Verify one bearer token for one bot and activity on the host clock; any failure is undefined (the route's 401). */
  async verify(token: string, expected: MsTeamsTokenExpectation, now: number): Promise<MsTeamsTokenClaims | undefined> {
    let kid: string
    try {
      const header = decodeProtectedHeader(token)
      if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid === '') return undefined
      kid = header.kid
      // An Entra or any other issuer is refused before any key lookup; the verified payload must name it too.
      if (decodeJwt(token).iss !== BOT_FRAMEWORK_ISSUER) return undefined
    } catch {
      return undefined
    }
    const key = await this.keys.key(kid, now)
    if (!key) return undefined
    let payload: JWTPayload
    try {
      ;({ payload } = await jwtVerify(token, key, {
        algorithms: ['RS256'],
        issuer: BOT_FRAMEWORK_ISSUER,
        requiredClaims: ['exp'],
        clockTolerance: MSTEAMS_CLOCK_TOLERANCE_SEC,
        currentDate: new Date(now)
      }))
    } catch {
      return undefined
    }
    // The audience is the bot's app ID, a GUID that compares case-insensitively.
    const aud = audienceOf(payload)
    if (!aud || aud.toLowerCase() !== expected.appId.toLowerCase()) return undefined
    // The token vouches for the origin the activity names, so a replay cannot redirect the bot's replies (measured claim spelling).
    const serviceUrl = payload.serviceurl
    if (typeof serviceUrl !== 'string' || serviceUrl !== expected.serviceUrl) return undefined
    if (typeof payload.exp !== 'number' || typeof payload.iss !== 'string') return undefined
    return { aud, iss: payload.iss, exp: payload.exp, serviceUrl }
  }
}
