/**
 * `WebchatTokenService` — mints + verifies the short-lived webchat token the browser
 * presents to the relay pool (shared-bot-relay.md §10, milestone A4).
 *
 * The browser can't hand the relay an OIDC token the relay could verify (the relay
 * holds no JWKS / no DB), so the CP mints a self-contained token AFTER the console's
 * normal human-auth + agent-visibility check, and the relay delegates verification
 * back to the CP via `rc/verify(webchat-token)`. The token is a compact HS256 JWT —
 * carrying `{ userId, user, agentId, orgId, conversationId }` and an optional
 * private-session owner proof with a short expiry.
 * The conversation id was already registered to that identity in CP metadata before
 * minting. The CP re-resolves the agent's CURRENT placement (daemonId) at verify time
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
  /** Public avatar URL, when the profile has one — the identity a platform mirror posts under. */
  userPicture?: string
  agentId: string
  orgId: string
  conversationId: string
  /** Exact private-session owner proven by the mint-time identity expansion. */
  privateSessionOwnerIdentity?: string
}

// v2 is intentionally incompatible with the pre-conversation-binding verifier:
// a new token must not be accepted by an old CP during a rolling deployment.
const KEY_INFO = 'agentconnect.webchat-token.v2'
const DEFAULT_TTL_SEC = 300 // 5 min — long enough to dial the relay, short enough to bound misuse
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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
    return new SignJWT({
      user: claims.user,
      ...(claims.userPicture ? { userPicture: claims.userPicture } : {}),
      agentId: claims.agentId,
      orgId: claims.orgId,
      conversationId: claims.conversationId,
      ...(claims.privateSessionOwnerIdentity ? { privateSessionOwnerIdentity: claims.privateSessionOwnerIdentity } : {})
    })
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
      const { sub, user, userPicture, agentId, orgId, conversationId, privateSessionOwnerIdentity } = payload as Record<
        string,
        unknown
      >
      if (
        typeof sub !== 'string' ||
        typeof agentId !== 'string' ||
        typeof orgId !== 'string' ||
        typeof conversationId !== 'string' ||
        !UUID_RE.test(conversationId)
      ) {
        return null
      }
      return {
        userId: sub,
        user: typeof user === 'string' ? user : sub,
        ...(typeof userPicture === 'string' ? { userPicture } : {}),
        agentId,
        orgId,
        conversationId: conversationId.toLowerCase(),
        ...(typeof privateSessionOwnerIdentity === 'string' ? { privateSessionOwnerIdentity } : {})
      }
    } catch {
      return null // bad signature / expired / malformed
    }
  }
}
