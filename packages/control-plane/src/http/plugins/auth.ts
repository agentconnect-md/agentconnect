/**
 * `http/plugins/auth.ts` (design §5.6b) — the **human** auth plane (C2), the
 * WebUI identity axis. Kept completely separate from the daemon-token plane
 * (C4): this NEVER touches `ws/`.
 *
 * Two implementations, chosen by config:
 *  - **devAuth (default)** — when `OIDC_ISSUER` is unset, a stub that injects a
 *    fixed principal (the bootstrapped owner in the default org) and logs a warning
 *    once. Lets every `/agents`,`/workspaces`,`/crons`,`/sessions`,`/daemons`
 *    route register `humanAuth` from day one.
 *  - **oidcAuth** — when `OIDC_ISSUER` is set, verifies the `Authorization:
 *    Bearer <jwt>` against the issuer's JWKS (`jose`), and maps `sub` → principal.
 *
 * Enabling real OIDC is a config flip; the routes don't change. The decorated
 * `humanAuth` is a Fastify `preHandler` routes attach via `onRequest`/`preHandler`.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify'
import fp from 'fastify-plugin'
import { createRemoteJWKSet, jwtVerify } from 'jose'

/** The authenticated WebUI user attached to a request (`req.principal`).
 *  Identity ONLY — the org a request acts on lives in the URL
 *  (`/orgs/:orgId/…`) and is verified by the org-scope guard, never here. */
export interface HumanPrincipal {
  userId: string
  email?: string
}

export interface HumanAuthConfig {
  /** When set, verify a bearer JWT against this issuer's JWKS. Unset ⇒ devAuth stub. */
  OIDC_ISSUER?: string
  /** OIDC audience to require (optional). */
  OIDC_AUDIENCE?: string
  /** The user the devAuth stub injects (the bootstrapped owner of the local default org). */
  DEFAULT_OWNER_ID: string
}

/**
 * JIT user resolver — maps a verified OIDC `sub` to a LOCAL user (creating the
 * `app_user` + their personal org on first sight = signup). Injected by the
 * composition root so `auth.ts` stays decoupled from the persistence ports.
 * When absent, oidcAuth falls back to using the raw `sub` as the principal id
 * (no DB write).
 */
export type ResolveOidcUser = (input: {
  oidcSubject: string
  email?: string
  /** True only when `email` came from a VERIFIED source (the access token's own
   *  claim, or a signature-checked id-token hint whose `sub` matches). Only a
   *  verified email may claim invited member rows or be stored as the user's
   *  real address — an unverified one could squat someone else's identity. */
  emailVerified?: boolean
  displayName?: string
  /** Avatar URL from the `picture` claim (display-only; no verification gate —
   *  it can only ever come from a signature-checked token or id-token hint). */
  picture?: string
}) => Promise<{ userId: string }>

/**
 * Verifies an opaque `Authorization: Bearer <key>` (a personal API key) against the
 * same credential store the WS daemon-auth uses, resolving it to the caller's identity
 * and the org the key is bound to (daemon-api-key-auth.md §8). Returns `null` for a
 * malformed / unknown / revoked / expired / non-user key; THROWS only on a transient
 * store error (mapped to 503, never 401 — a blip must not read as a dead key). Injected
 * by the composition root so `auth.ts` stays decoupled from persistence (mirrors
 * {@link ResolveOidcUser}). Absent ⇒ no API-key credential is accepted (JWT/dev only).
 */
export type VerifyApiKey = (
  token: string
) => Promise<{ userId: string; orgId: string; apiKeyId: string; scopes: string[] } | null>

/** Registration options: the config plus the optional JIT resolver + API-key verifier. */
export type HumanAuthOptions = HumanAuthConfig & {
  resolveUser?: ResolveOidcUser
  verifyApiKey?: VerifyApiKey
}

declare module 'fastify' {
  interface FastifyInstance {
    /** preHandler that authenticates the WebUI caller and sets `req.principal`. */
    humanAuth: preHandlerHookHandler
    /** Real OIDC only: never falls back to devAuth or a personal API key. */
    oidcAuth: preHandlerHookHandler
  }
  interface FastifyRequest {
    principal?: HumanPrincipal
    /** Set only when the caller authenticated with a personal API key (not OIDC/dev):
     *  the key's row id (audit / self-mint guard) and the org it is bound to. The
     *  org-scope guard asserts this equals the URL org, so a key acts only in its org. */
    apiKeyId?: string
    apiKeyOrgId?: string
    /** The authenticating key's granted scopes. EMPTY = unrestricted (personal key);
     *  non-empty = confined (an OAuth token: `mcp:read`/`mcp:write`) — the org-scope
     *  guard blocks org-resource writes without `mcp:write` (agent-assistant.md §6.3). */
    apiKeyScopes?: string[]
  }
}

function unauthorized(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(401).send({ error: 'Unauthorized', statusCode: 401, message })
}

/** Build the devAuth stub preHandler — admits every request with a fixed principal. */
function devAuth(cfg: HumanAuthConfig, log: FastifyInstance['log']): preHandlerHookHandler {
  let warned = false
  return async (req: FastifyRequest) => {
    if (!warned) {
      log.warn('humanAuth: OIDC_ISSUER unset — using devAuth stub (fixed principal). DO NOT use in production.')
      warned = true
    }
    req.principal = { userId: cfg.DEFAULT_OWNER_ID }
  }
}

/** A route that depends on distinct human accounts cannot operate in devAuth mode. */
const oidcUnavailable: preHandlerHookHandler = async (_req, reply) =>
  reply.code(503).send({
    error: 'Service Unavailable',
    statusCode: 503,
    message: 'OIDC sign-in is required for this endpoint',
    code: 'OIDC_AUTH_UNAVAILABLE'
  })

/** Build the OIDC preHandler — verifies a bearer JWT against the issuer JWKS. */
function oidcAuth(cfg: HumanAuthOptions & { OIDC_ISSUER: string }): preHandlerHookHandler {
  // Resolve the JWKS via OIDC discovery rather than assuming the conventional
  // `${issuer}/.well-known/jwks.json` — Logto (and others) publish `jwks_uri` at
  // a non-conventional path (`${issuer}/jwks`). Fetched once, lazily; on failure
  // the promise is cleared so the next request retries. `jose` caches/rotates the
  // key set internally thereafter.
  const issuer = cfg.OIDC_ISSUER.replace(/\/$/, '')
  let jwksPromise: Promise<ReturnType<typeof createRemoteJWKSet>> | undefined
  function getJwks(): Promise<ReturnType<typeof createRemoteJWKSet>> {
    if (!jwksPromise) {
      jwksPromise = (async () => {
        const res = await fetch(`${issuer}/.well-known/openid-configuration`)
        if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`)
        const doc = (await res.json()) as { jwks_uri?: string }
        if (!doc.jwks_uri) throw new Error('OIDC discovery doc missing jwks_uri')
        return createRemoteJWKSet(new URL(doc.jwks_uri))
      })().catch((err) => {
        jwksPromise = undefined // allow retry on the next request
        throw err
      })
    }
    return jwksPromise
  }
  // Memoize the sub → local user mapping so JIT provisioning runs once per
  // subject. The value is the IN-FLIGHT promise (not the settled result) so the
  // N parallel calls a console page-load fires all await the same signup instead
  // of racing user/org creation; a rejected promise is evicted so a transient DB
  // error can retry. The ORG context is deliberately NOT cached: it's resolved
  // per request so org switches (x-ac-org-id), role edits and removals take
  // effect immediately.
  const resolved = new Map<string, Promise<{ userId: string }>>()
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      return unauthorized(reply, 'missing bearer token')
    }
    const token = header.slice('Bearer '.length)
    try {
      const { payload } = await jwtVerify(token, await getJwks(), {
        issuer,
        ...(cfg.OIDC_AUDIENCE ? { audience: cfg.OIDC_AUDIENCE } : {})
      })
      if (!payload.sub) return unauthorized(reply, 'token missing subject')
      const sub = payload.sub
      // The creator identity we surface is the user's real EMAIL. A Logto access
      // token minted for an API resource omits the `email` claim, so we also accept
      // it from the browser (which has it from the id token) via `x-ac-user-email`.
      // The verified token still proves the subject; the header is a display-only
      // hint, used only to fill a missing email — and the repo only ever upgrades a
      // synthetic placeholder, never overwrites a real email. A token claim wins.
      // The identity email must be VERIFIED before it can claim invited member
      // rows or be stored as the user's address — a raw request header would let
      // anyone bind their OIDC subject to a victim's pending invite. Verified
      // sources: the access token's own `email` claim, or an id-token hint
      // (`x-ac-id-token`) that passes the SAME issuer/JWKS check and whose `sub`
      // matches the access token (Logto resource tokens omit `email`, so the
      // browser forwards the id token it already holds). The legacy plain-text
      // `x-ac-user-email` header remains display-only: never used to provision.
      let email = payload.email as string | undefined
      let displayName = typeof payload.name === 'string' ? payload.name : undefined
      // The `picture` claim is the avatar URL — display-only, so no verification
      // gate (it rides the same signature-checked sources as name). Resource
      // access tokens omit it, so it usually arrives via the id-token hint below.
      let picture = typeof payload.picture === 'string' ? payload.picture : undefined
      const rawIdTokenHint = req.headers['x-ac-id-token']
      const idTokenHint = (Array.isArray(rawIdTokenHint) ? rawIdTokenHint[0] : rawIdTokenHint)?.trim() || undefined
      if (!email && idTokenHint) {
        try {
          const { payload: idClaims } = await jwtVerify(idTokenHint, await getJwks(), { issuer })
          if (idClaims.sub === sub) {
            if (typeof idClaims.email === 'string') email = idClaims.email
            if (!displayName && typeof idClaims.name === 'string') displayName = idClaims.name
            if (!picture && typeof idClaims.picture === 'string') picture = idClaims.picture
          }
        } catch {
          /* invalid hint — ignore; identity stays token-only */
        }
      }
      const emailVerified = email !== undefined
      // Display-only fallback for req.principal.email (creator labels) — never provisioned.
      const rawEmailHint = req.headers['x-ac-user-email']
      const headerEmail = (Array.isArray(rawEmailHint) ? rawEmailHint[0] : rawEmailHint)?.trim() || undefined
      // Resolve to a LOCAL user id when a resolver is wired; else fall back to
      // the raw `sub` (no DB). The in-flight promise is cached synchronously so
      // parallel first requests coalesce into ONE signup.
      let pending = resolved.get(sub)
      if (!pending) {
        pending = cfg.resolveUser
          ? cfg.resolveUser({
              oidcSubject: sub,
              ...(email ? { email } : {}),
              emailVerified,
              ...(displayName ? { displayName } : {}),
              ...(picture ? { picture } : {})
            })
          : Promise.resolve({ userId: sub })
        resolved.set(sub, pending)
        pending.catch(() => resolved.delete(sub))
      }
      const identity = await pending
      // Identity only — which org the request acts on is the URL's business
      // (`/orgs/:orgId/…`, verified by the org-scope guard).
      req.principal = { userId: identity.userId, email: email ?? headerEmail }
    } catch (err) {
      // Surface WHY verification failed — expiry vs. audience/issuer vs. signature.
      // jose tags each with a stable `code` (ERR_JWT_EXPIRED,
      // ERR_JWT_CLAIM_VALIDATION_FAILED, ERR_JWS_SIGNATURE_VERIFICATION_FAILED, …).
      // Log code + message only; never the token. Without this the route returns a
      // bare 401 and the reason is unknowable from the logs.
      const e = err as { code?: string; claim?: string; message?: string }
      req.log.warn({ code: e.code, claim: e.claim, reason: e.message }, 'humanAuth: bearer token rejected')
      return unauthorized(reply, 'invalid token')
    }
  }
}

/** Extract a personal-API-key bearer, or null. Bare opaque keys are dot-free
 *  base62; OIDC bearers are dotted JWTs — so a `.`-free bearer is treated as an
 *  API key and everything else falls through to the OIDC/dev handler (the §8
 *  disambiguation, no key prefix needed). */
function bearerApiKey(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null
  const tok = header.slice('Bearer '.length).trim()
  return tok.length > 0 && !tok.includes('.') ? tok : null
}

/**
 * Wrap the OIDC/dev handler so a dot-free `Authorization: Bearer <key>` is verified
 * as a personal API key FIRST. A valid key sets `req.principal` (+ `apiKeyId` /
 * `apiKeyOrgId`); an invalid one is a hard 401 (never falls through to devAuth's
 * admit-all). Any other Authorization (a JWT, or none) delegates to `base`.
 */
function withApiKeyAuth(verify: VerifyApiKey, base: preHandlerHookHandler): preHandlerHookHandler {
  // Our dev/oidc handlers are async 2-arg preHandlers (Fastify awaits them, never
  // passing `done`); call `base` through that shape rather than the 3-arg hook type.
  const delegate = base as (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const tok = bearerApiKey(req.headers.authorization)
    if (!tok) return delegate(req, reply)
    let resolved: Awaited<ReturnType<VerifyApiKey>>
    try {
      resolved = await verify(tok)
    } catch (err) {
      // A store blip must not read as a bad credential — 503 so the client retries
      // (mirrors the daemon plane's 1011-vs-4401 split).
      req.log.error({ err }, 'humanAuth: api-key verification errored')
      return reply.code(503).send({ error: 'Service Unavailable', statusCode: 503, message: 'temporarily unavailable' })
    }
    if (!resolved) return unauthorized(reply, 'invalid api key')
    // Identity only (like the OIDC path); the org the key is bound to is stashed so
    // the org-scope guard can assert the URL org matches — a key acts ONLY in its org.
    req.principal = { userId: resolved.userId }
    req.apiKeyId = resolved.apiKeyId
    req.apiKeyOrgId = resolved.orgId
    req.apiKeyScopes = resolved.scopes
  }
}

/**
 * Decorate the instance with `humanAuth`. Registered once on the root server via
 * `fastify-plugin` so the decorator is visible to every route plugin. When a
 * `verifyApiKey` is wired, a dot-free bearer is accepted as a personal API key in
 * front of the OIDC/dev handler (daemon-api-key-auth.md §8).
 */
export const humanAuthPlugin = fp(
  function humanAuthPlugin(app: FastifyInstance, cfg: HumanAuthOptions, done: (err?: Error) => void) {
    const realOidc = cfg.OIDC_ISSUER ? oidcAuth({ ...cfg, OIDC_ISSUER: cfg.OIDC_ISSUER }) : undefined
    const base = realOidc ?? devAuth(cfg, app.log)
    const handler = cfg.verifyApiKey ? withApiKeyAuth(cfg.verifyApiKey, base) : base
    app.decorate('humanAuth', handler)
    // Invite redemption and any future account-distinct flow use this hook so
    // an OSS devAuth principal or personal API key can never impersonate a user.
    app.decorate('oidcAuth', realOidc ?? oidcUnavailable)
    app.decorateRequest('principal', undefined)
    app.decorateRequest('apiKeyId', undefined)
    app.decorateRequest('apiKeyOrgId', undefined)
    app.decorateRequest('apiKeyScopes', undefined)
    done()
  },
  { name: 'human-auth', fastify: '5.x' }
)
