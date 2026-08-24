/**
 * Logto/OIDC authentication for the loopback-only Setup Server.
 *
 * There are two deliberately separate checks:
 *  - bootstrap identity: a signature-checked token, accepted only inside the
 *    local one-time bootstrap session before configuration is persisted;
 *  - deployment admin: the same verification plus exact membership in the
 *    `ADMIN` value of the `roles` claim.
 *
 * The claim name and role value are product constants shared with the private
 * cloud admin-server by contract, not deployment flags that can drift.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'

export const ADMIN_ROLES_CLAIM = 'roles'
export const ADMIN_ROLE = 'ADMIN'

export interface SetupOidcConfig {
  issuer: string
  upstream?: string
  audience?: string
}

/** Reads either the in-memory bootstrap draft or the persisted runtime snapshot. */
export interface SetupOidcConfigProvider {
  get(): Promise<SetupOidcConfig | null>
}

export interface SetupPrincipal {
  subject: string
  email?: string
}

export class SetupAuthError extends Error {
  constructor(
    readonly statusCode: 401 | 403 | 503,
    readonly code: 'ADMIN_OIDC_NOT_CONFIGURED' | 'INVALID_TOKEN' | 'ADMIN_ROLE_REQUIRED',
    message: string
  ) {
    super(message)
    this.name = 'SetupAuthError'
  }
}

export type VerifyOidcToken = (token: string, config: SetupOidcConfig) => Promise<JWTPayload>

export function urlAtOrigin(value: string, origin: string): URL {
  const url = new URL(value)
  const target = new URL(origin)
  url.protocol = target.protocol
  url.host = target.host
  // The host setter keeps the port the value already carried when the assigned host names none, so
  // a URL discovered on a management endpoint's :3001 would keep it at a public origin serving 443.
  url.port = target.port
  return url
}

/** Production JWT verifier. Discovery/JWKS are cached per normalized issuer. */
export function createOidcTokenVerifier(fetchImpl: typeof fetch = fetch): VerifyOidcToken {
  const jwksByIssuer = new Map<string, Promise<ReturnType<typeof createRemoteJWKSet>>>()

  const jwks = (issuer: string, upstream?: string): Promise<ReturnType<typeof createRemoteJWKSet>> => {
    const normalized = issuer.replace(/\/+$/, '')
    const cacheKey = `${normalized}\n${upstream ?? ''}`
    const cached = jwksByIssuer.get(cacheKey)
    if (cached) return cached
    const pending = (async () => {
      const discoveryIssuer = upstream ? urlAtOrigin(normalized, upstream).toString().replace(/\/$/, '') : normalized
      const response = await fetchImpl(`${discoveryIssuer}/.well-known/openid-configuration`)
      if (!response.ok) throw new Error(`OIDC discovery failed: HTTP ${response.status}`)
      const document = (await response.json()) as { jwks_uri?: unknown }
      if (typeof document.jwks_uri !== 'string') throw new Error('OIDC discovery document is missing jwks_uri')
      return createRemoteJWKSet(upstream ? urlAtOrigin(document.jwks_uri, upstream) : new URL(document.jwks_uri))
    })().catch((error) => {
      jwksByIssuer.delete(cacheKey)
      throw error
    })
    jwksByIssuer.set(cacheKey, pending)
    return pending
  }

  return async (token, config) => {
    const issuer = config.issuer.replace(/\/+$/, '')
    const verified = await jwtVerify(token, await jwks(issuer, config.upstream), {
      issuer,
      ...(config.audience ? { audience: config.audience } : {})
    })
    return verified.payload
  }
}

/** Match the private admin-server's compatibility behavior exactly. */
export function extractAdminRoles(claim: unknown): string[] {
  if (Array.isArray(claim)) return claim.filter((role): role is string => typeof role === 'string')
  if (typeof claim === 'string') return claim.split(/[\s,]+/).filter(Boolean)
  return []
}

export class SetupAuthenticator {
  constructor(
    private readonly config: SetupOidcConfigProvider,
    private readonly verifyToken: VerifyOidcToken = createOidcTokenVerifier()
  ) {}

  /** Verify an OIDC identity. Only the one-time local bootstrap flow may call
   *  this with `requireAdminRole=false`. Ordinary Setup routes always require it. */
  async authenticate(authorization: string | undefined, requireAdminRole = true): Promise<SetupPrincipal> {
    const oidc = await this.config.get()
    if (!oidc) {
      throw new SetupAuthError(503, 'ADMIN_OIDC_NOT_CONFIGURED', 'Setup Server OIDC is not configured')
    }
    if (!authorization?.startsWith('Bearer ')) {
      throw new SetupAuthError(401, 'INVALID_TOKEN', 'missing bearer token')
    }

    let payload: JWTPayload
    try {
      payload = await this.verifyToken(authorization.slice('Bearer '.length), oidc)
    } catch {
      throw new SetupAuthError(401, 'INVALID_TOKEN', 'invalid bearer token')
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new SetupAuthError(401, 'INVALID_TOKEN', 'token is missing its subject')
    }
    if (requireAdminRole && !extractAdminRoles(payload[ADMIN_ROLES_CLAIM]).includes(ADMIN_ROLE)) {
      throw new SetupAuthError(403, 'ADMIN_ROLE_REQUIRED', 'ADMIN role required')
    }
    return {
      subject: payload.sub,
      ...(typeof payload.email === 'string' ? { email: payload.email } : {})
    }
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    setupPrincipal?: SetupPrincipal
  }
}
