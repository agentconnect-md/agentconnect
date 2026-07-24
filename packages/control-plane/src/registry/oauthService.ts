/**
 * `OAuthService` — the embedded OAuth 2.1 Authorization Server's business logic
 * (docs/designs/agent-assistant.md §7).
 *
 * The CP issues its OWN tokens so MCP clients (claude.ai / Claude Code) can do the
 * browser login flow: DCR registration, single-use PKCE authorization codes, access
 * tokens (an `api_key` row, principalType='oauth', 1h) and rotating refresh tokens.
 * The human login on /authorize is delegated to the web console (Logto / devAuth);
 * this module never sees a password. Pure logic + repos — no Fastify, so it is unit-
 * and integration-testable in isolation.
 */
import { randomUUID, createHash } from 'node:crypto'
import { OrgId } from '../domain/ids.js'
import type { Clock } from '../domain/clock.js'
import type { ApiKeyAdmin } from '../ports.js'
import type { OAuthRepo, OAuthClientRecord, OAuthGrantRecord } from '../persistence/ports.js'
import { ApiKeyCodec } from './apiKey.js'

/** base64url(SHA-256(input)) — the PKCE S256 transform (agent-assistant.md §7). */
function s256(input: string): string {
  return createHash('sha256').update(input).digest('base64url')
}

/** The scopes the AgentConnect MCP resource understands (agent-assistant.md §6.2). */
export const OAUTH_SCOPES = ['mcp:read', 'mcp:write'] as const

const CLIENT_TTL_MS = 90 * 86_400_000 // DCR registration TTL
const CODE_TTL_MS = 60_000 // authorization code — short (single browser round-trip)
const ACCESS_TTL_SEC = 3600 // access token = 1h
const REFRESH_TTL_MS = 30 * 86_400_000 // refresh inactivity window, slid on each use
const DEFAULT_GRANT_TYPES = ['authorization_code', 'refresh_token']

export interface OAuthTokens {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  scope: string
}

/** RFC 6749 §5.2 error (the `error` code is what clients branch on). */
export interface OAuthFailure {
  error:
    | 'invalid_request'
    | 'invalid_grant'
    | 'invalid_client'
    | 'unauthorized_client'
    | 'unsupported_grant_type'
    | 'invalid_scope'
  error_description?: string
}

export type OAuthResult<T> = { ok: true; value: T } | { ok: false; failure: OAuthFailure }

const fail = (error: OAuthFailure['error'], error_description?: string): { ok: false; failure: OAuthFailure } => ({
  ok: false,
  failure: error_description ? { error, error_description } : { error }
})

/** Is this a loopback redirect (RFC 8252) whose port must be ignored on match? */
function isLoopback(u: URL): boolean {
  return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]')
}

/** A redirect_uri is registerable if it is https, or an http loopback (native apps). */
export function isRegisterableRedirectUri(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.hash) return false // fragments are never allowed in redirect URIs
  return u.protocol === 'https:' || isLoopback(u)
}

/** Does `requested` match one of the client's registered redirect URIs? Exact match,
 *  except loopback URIs compare scheme+host+path and IGNORE the port (RFC 8252 §7.3 —
 *  native clients bind an ephemeral localhost port per attempt). */
export function redirectUriMatches(registered: string[], requested: string): boolean {
  let req: URL
  try {
    req = new URL(requested)
  } catch {
    return false
  }
  return registered.some((r) => {
    if (r === requested) return true
    let reg: URL
    try {
      reg = new URL(r)
    } catch {
      return false
    }
    if (!isLoopback(reg) || !isLoopback(req)) return false
    return reg.protocol === req.protocol && reg.hostname === req.hostname && reg.pathname === req.pathname
  })
}

/** Intersect a requested space-delimited scope string with what we support; default to
 *  `mcp:read` when nothing valid was requested. */
export function normalizeScopes(raw: string | undefined | null): string[] {
  const requested = (raw ?? '').split(/\s+/).filter(Boolean)
  const granted = OAUTH_SCOPES.filter((s) => requested.includes(s))
  return granted.length > 0 ? granted : ['mcp:read']
}

export class OAuthService {
  constructor(
    private readonly oauth: OAuthRepo,
    private readonly apiKeys: ApiKeyAdmin,
    private readonly codec: ApiKeyCodec,
    private readonly clock: Clock
  ) {}

  private now(): number {
    return this.clock.now()
  }

  /** RFC 7591 dynamic client registration. Public clients only (no secret); PKCE is the
   *  proof. We generate the opaque `client_id` (`mcp-<uuid>`). Returns the created record
   *  or a validation failure. */
  async registerClient(input: {
    clientName?: string
    redirectUris: unknown
    grantTypes?: unknown
  }): Promise<OAuthResult<OAuthClientRecord>> {
    const uris = Array.isArray(input.redirectUris)
      ? input.redirectUris.filter((u): u is string => typeof u === 'string')
      : []
    if (uris.length === 0) return fail('invalid_request', 'redirect_uris is required')
    if (!uris.every(isRegisterableRedirectUri)) {
      return fail('invalid_request', 'redirect_uris must be https or http loopback, without a fragment')
    }
    const grantTypes =
      Array.isArray(input.grantTypes) && input.grantTypes.every((g): g is string => typeof g === 'string')
        ? input.grantTypes
        : DEFAULT_GRANT_TYPES
    const client = await this.oauth.createClient({
      clientId: `mcp-${randomUUID()}`,
      ...(input.clientName ? { clientName: input.clientName } : {}),
      redirectUris: uris,
      grantTypes,
      expiresAt: new Date(this.now() + CLIENT_TTL_MS)
    })
    return { ok: true, value: client }
  }

  async getActiveClient(clientId: string): Promise<OAuthClientRecord | null> {
    const client = await this.oauth.getClient(clientId)
    if (!client) return null
    return client.expiresAt.getTime() > this.now() ? client : null
  }

  /** Issue a single-use authorization code after the user has consented (the console
   *  route has already authenticated the user + verified org membership + redirect_uri).
   *  Returns the plaintext code (hash-only at rest). */
  async issueCode(input: {
    clientId: string
    redirectUri: string
    userId: string
    orgId: string
    scopes: string[]
    codeChallenge: string
    codeChallengeMethod: string
    resource?: string | null
  }): Promise<string> {
    const minted = this.codec.mint()
    await this.oauth.createCode({
      codeHash: minted.hash,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      userId: input.userId,
      orgId: OrgId(input.orgId),
      scopes: input.scopes,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: input.codeChallengeMethod,
      resource: input.resource ?? null,
      expiresAt: new Date(this.now() + CODE_TTL_MS)
    })
    return minted.token
  }

  /** Exchange an authorization code + PKCE verifier for tokens (grant_type=authorization_code).
   *  Atomically consumes the single-use code, verifies PKCE S256, then mints the grant. */
  async exchangeCode(input: {
    code: string
    clientId: string
    redirectUri: string
    codeVerifier: string
  }): Promise<OAuthResult<OAuthTokens>> {
    const parsed = this.codec.parse(input.code)
    if (!parsed) return fail('invalid_grant', 'malformed code')
    // Atomic single-use consume — a replayed/concurrent exchange loses the race → null.
    const code = await this.oauth.consumeCode(this.codec.hash(parsed.secret), new Date(this.now()))
    if (!code) return fail('invalid_grant', 'code is invalid, expired, or already used')
    if (code.clientId !== input.clientId) return fail('invalid_grant', 'client mismatch')
    if (code.redirectUri !== input.redirectUri) return fail('invalid_grant', 'redirect_uri mismatch')
    // PKCE: the verifier must hash to the challenge bound at authorize time (S256 only).
    if (code.codeChallengeMethod !== 'S256' || s256(input.codeVerifier) !== code.codeChallenge) {
      return fail('invalid_grant', 'PKCE verification failed')
    }
    return this.mintGrantTokens({
      userId: code.userId,
      orgId: code.orgId,
      clientId: code.clientId,
      scopes: code.scopes,
      resource: code.resource
    })
  }

  /** Rotate a refresh token for a fresh access token (grant_type=refresh_token). */
  async refresh(input: { refreshToken: string }): Promise<OAuthResult<OAuthTokens>> {
    const parsed = this.codec.parse(input.refreshToken)
    if (!parsed) return fail('invalid_grant', 'malformed refresh token')
    const presentedHash = this.codec.hash(parsed.secret)
    const grant = await this.oauth.findGrantByRefreshHash(presentedHash)
    if (!grant) return fail('invalid_grant', 'unknown refresh token')
    if (grant.revokedAt) return fail('invalid_grant', 'grant revoked')
    if (grant.rtExpiresAt && grant.rtExpiresAt.getTime() <= this.now()) return fail('invalid_grant', 'refresh expired')

    const newRt = this.codec.mint()
    const rotated = await this.oauth.rotateGrant(grant.id, grant.rtHash, {
      rtHash: newRt.hash,
      prevRtHash: grant.rtHash, // the just-superseded token stays valid for one more use
      rtExpiresAt: new Date(this.now() + REFRESH_TTL_MS),
      lastUsedAt: new Date(this.now())
    })
    // Lost a concurrent rotation race — reject rather than fork the token chain; the
    // client re-auths. (Sequential lost-response retries succeed via the prev-hash window.)
    if (!rotated) return fail('invalid_grant', 'refresh token superseded')

    const access = await this.apiKeys.mintOauthAccess({
      userId: rotated.userId,
      orgId: rotated.orgId,
      scopes: rotated.scopes,
      oauthGrantId: rotated.id,
      ttlSeconds: ACCESS_TTL_SEC
    })
    // Close the disconnect↔refresh race: a concurrent revokeGrant may have set
    // revokedAt AND run its cascade sweep between our rotate and this mint, leaving
    // the freshly-minted token alive under a revoked grant. Re-check and re-sweep so
    // "disconnect" reliably kills active access (the sweep now sees the new token).
    const check = await this.oauth.getGrant(rotated.id)
    if (!check || check.revokedAt) {
      await this.apiKeys.revokeOauthGrantTokens(rotated.id)
      return fail('invalid_grant', 'grant revoked')
    }
    return {
      ok: true,
      value: {
        access_token: access.token,
        token_type: 'Bearer',
        expires_in: ACCESS_TTL_SEC,
        refresh_token: newRt.token,
        scope: rotated.scopes.join(' ')
      }
    }
  }

  /** Create the grant (with a fresh refresh token) + mint the first access token. */
  private async mintGrantTokens(input: {
    userId: string
    orgId: string
    clientId: string
    scopes: string[]
    resource: string | null
  }): Promise<OAuthResult<OAuthTokens>> {
    const rt = this.codec.mint()
    const grant = await this.oauth.createGrant({
      userId: input.userId,
      orgId: OrgId(input.orgId),
      clientId: input.clientId,
      scopes: input.scopes,
      resource: input.resource,
      rtHash: rt.hash,
      rtExpiresAt: new Date(this.now() + REFRESH_TTL_MS)
    })
    const access = await this.apiKeys.mintOauthAccess({
      userId: input.userId,
      orgId: input.orgId,
      scopes: input.scopes,
      oauthGrantId: grant.id,
      ttlSeconds: ACCESS_TTL_SEC
    })
    return {
      ok: true,
      value: {
        access_token: access.token,
        token_type: 'Bearer',
        expires_in: ACCESS_TTL_SEC,
        refresh_token: rt.token,
        scope: input.scopes.join(' ')
      }
    }
  }

  listGrants(userId: string): Promise<OAuthGrantRecord[]> {
    return this.oauth.listGrantsForUser(userId)
  }

  /** Revoke a grant the caller owns (idempotent) + cascade-revoke its access tokens.
   *  Returns false when the grant isn't the user's / doesn't exist. */
  async revokeGrant(userId: string, grantId: string): Promise<boolean> {
    const grant = await this.oauth.getGrant(grantId)
    if (!grant || grant.userId !== userId) return false
    await this.oauth.revokeGrant(grantId, new Date(this.now()))
    await this.apiKeys.revokeOauthGrantTokens(grantId)
    return true
  }
}
