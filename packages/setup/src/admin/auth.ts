/**
 * Logto/OIDC authentication for the temporary Tenant Admin surface.
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

export interface AdminOidcConfig {
  issuer: string
  audience?: string
}

/** Reads either the in-memory bootstrap draft or the persisted runtime snapshot. */
export interface AdminOidcConfigProvider {
  get(): Promise<AdminOidcConfig | null>
}

export interface TenantAdminPrincipal {
  subject: string
  email?: string
}

export class TenantAdminAuthError extends Error {
  constructor(
    readonly statusCode: 401 | 403 | 503,
    readonly code: 'ADMIN_OIDC_NOT_CONFIGURED' | 'INVALID_TOKEN' | 'ADMIN_ROLE_REQUIRED',
    message: string
  ) {
    super(message)
    this.name = 'TenantAdminAuthError'
  }
}

export type VerifyOidcToken = (token: string, config: AdminOidcConfig) => Promise<JWTPayload>

/** Production JWT verifier. Discovery/JWKS are cached per normalized issuer. */
export function createOidcTokenVerifier(fetchImpl: typeof fetch = fetch): VerifyOidcToken {
  const jwksByIssuer = new Map<string, Promise<ReturnType<typeof createRemoteJWKSet>>>()

  const jwks = (issuer: string): Promise<ReturnType<typeof createRemoteJWKSet>> => {
    const normalized = issuer.replace(/\/+$/, '')
    const cached = jwksByIssuer.get(normalized)
    if (cached) return cached
    const pending = (async () => {
      const response = await fetchImpl(`${normalized}/.well-known/openid-configuration`)
      if (!response.ok) throw new Error(`OIDC discovery failed: HTTP ${response.status}`)
      const document = (await response.json()) as { jwks_uri?: unknown }
      if (typeof document.jwks_uri !== 'string') throw new Error('OIDC discovery document is missing jwks_uri')
      return createRemoteJWKSet(new URL(document.jwks_uri))
    })().catch((error) => {
      jwksByIssuer.delete(normalized)
      throw error
    })
    jwksByIssuer.set(normalized, pending)
    return pending
  }

  return async (token, config) => {
    const issuer = config.issuer.replace(/\/+$/, '')
    const verified = await jwtVerify(token, await jwks(issuer), {
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

export class TenantAdminAuthenticator {
  constructor(
    private readonly config: AdminOidcConfigProvider,
    private readonly verifyToken: VerifyOidcToken = createOidcTokenVerifier()
  ) {}

  /** Verify an OIDC identity. Only the one-time local bootstrap flow may call
   *  this with `requireAdminRole=false`. Ordinary admin routes always require it. */
  async authenticate(authorization: string | undefined, requireAdminRole = true): Promise<TenantAdminPrincipal> {
    const oidc = await this.config.get()
    if (!oidc) {
      throw new TenantAdminAuthError(503, 'ADMIN_OIDC_NOT_CONFIGURED', 'tenant admin OIDC is not configured')
    }
    if (!authorization?.startsWith('Bearer ')) {
      throw new TenantAdminAuthError(401, 'INVALID_TOKEN', 'missing bearer token')
    }

    let payload: JWTPayload
    try {
      payload = await this.verifyToken(authorization.slice('Bearer '.length), oidc)
    } catch {
      throw new TenantAdminAuthError(401, 'INVALID_TOKEN', 'invalid bearer token')
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new TenantAdminAuthError(401, 'INVALID_TOKEN', 'token is missing its subject')
    }
    if (requireAdminRole && !extractAdminRoles(payload[ADMIN_ROLES_CLAIM]).includes(ADMIN_ROLE)) {
      throw new TenantAdminAuthError(403, 'ADMIN_ROLE_REQUIRED', 'ADMIN role required')
    }
    return {
      subject: payload.sub,
      ...(typeof payload.email === 'string' ? { email: payload.email } : {})
    }
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    tenantAdminPrincipal?: TenantAdminPrincipal
  }
}
