/**
 * `WebchatTokenService` — mints + verifies the short-lived webchat token the browser
 * presents to the relay pool (shared-bot-relay.md §10, milestone A4).
 *
 * The browser can't hand the relay an OIDC token the relay could verify (the relay
 * holds no JWKS / no DB), so the CP mints a self-contained token AFTER the console's
 * normal human-auth + agent-visibility check, and the relay delegates verification
 * back to the CP via `rc/verify(webchat-token)`. The token is a compact HS256 JWT —
 * no new table, no cleanup — carrying `{ userId, user, agentId, orgId }` with a short
 * expiry; the CP re-resolves the agent's CURRENT placement (daemonId) at verify time
 * (placement can change between mint and dial), so the token never encodes it.
 *
 * The signing key is DERIVED from `API_KEY_PEPPER` (domain-separated) so no new secret
 * config is required; it never leaves the CP.
 */
import { createHmac } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'

/** The identity a minted webchat token attests (authz already checked at mint time). */
export interface WebchatTokenClaims {
  userId: string
  /** Display handle for the transcript author line. */
  user: string
  agentId: string
  orgId: string
}

const KEY_INFO = 'agentconnect.webchat-token.v1'
const DEFAULT_TTL_SEC = 300 // 5 min — long enough to dial the relay, short enough to bound misuse

export class WebchatTokenService {
  private readonly key: Uint8Array

  constructor(
    pepper: string,
    private readonly ttlSec: number = DEFAULT_TTL_SEC
  ) {
    // Domain-separated HMAC of the pepper → a dedicated 256-bit signing key.
    this.key = new Uint8Array(createHmac('sha256', pepper).update(KEY_INFO).digest())
  }

  /** Mint a short-lived token for `claims` (call ONLY after human-auth + canView). */
  async mint(claims: WebchatTokenClaims): Promise<string> {
    return new SignJWT({ user: claims.user, agentId: claims.agentId, orgId: claims.orgId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.userId)
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSec}s`)
      .sign(this.key)
  }

  /** Verify signature + expiry and return the claims, or null on any failure. */
  async verify(token: string): Promise<WebchatTokenClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ['HS256'] })
      const { sub, user, agentId, orgId } = payload as Record<string, unknown>
      if (typeof sub !== 'string' || typeof agentId !== 'string' || typeof orgId !== 'string') return null
      return { userId: sub, user: typeof user === 'string' ? user : sub, agentId, orgId }
    } catch {
      return null // bad signature / expired / malformed
    }
  }
}
