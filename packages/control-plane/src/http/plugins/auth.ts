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
import type { InternalInvocationAuth } from '../mcp/internal-invocation-auth.js'

/** The authenticated WebUI user attached to a request (`req.principal`).
 *  Identity ONLY — the org a request acts on lives in the URL
 *  (`/orgs/:orgId/…`) and is verified by the org-scope guard, never here. */
export interface HumanPrincipal {
  userId: string
  email?: string
  /** True only when a verified OIDC token carries the deployment ADMIN role. */
  isAdmin?: boolean
}

const ADMIN_ROLE = 'ADMIN'

function hasAdminRole(claim: unknown): boolean {
  if (Array.isArray(claim)) return claim.some((role) => role === ADMIN_ROLE)
  if (typeof claim === 'string') return claim.split(/[\s,]+/).includes(ADMIN_ROLE)
  return false
}

export interface HumanAuthConfig {
  /** When set, verify a bearer JWT against this issuer's JWKS. Unset ⇒ devAuth stub. */
  OIDC_ISSUER?: string
  /** Optional server-reachable origin for discovery and JWKS reads. */
  OIDC_UPSTREAM?: string
  /** OIDC audience to require (optional). */
  OIDC_AUDIENCE?: string
  /** The user the devAuth stub injects (the bootstrapped owner of the local default org). */
  DEFAULT_OWNER_ID: string
}

/**
 * JIT user resolver — maps a verified OIDC `sub` to a LOCAL user (creating the
 * `app_user` on first sight = signup; no organization comes with it). Injected by the
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

/**
 * Does the resolved local user row still exist? An admin can delete an account
 * while a browser still holds a valid OIDC session — and while this plane's
 * `sub → userId` memo still points at the deleted row. Without this check the
 * session limps on against a dangling identity (reads come back empty, writes
 * fail obscurely); with it the request is refused as `ACCOUNT_GONE` so the client
 * signs out. Deliberately NOT a "re-provision the row" hook: an account an admin
 * removed must not come back to life under the old session — the user signs in
 * again and JIT signup then treats them as the new account they are. Absent ⇒ no
 * check (the identity is trusted for the process lifetime).
 */
export type PrincipalExists = (userId: string) => Promise<boolean>

/**
 * The durable half of the deleted-account boundary (see the cutoff map in
 * `oidcAuth`). `read` is consulted the FIRST time a process sees a subject —
 * precisely the post-restart case, where an in-memory cutoff is gone but a
 * pre-deletion bearer may still be live. The rows it reads are written by a database
 * trigger on the deletion itself (see the `deleted_identity_trigger` migration), so
 * the boundary exists even when NO process ever observed the deletion; `record` adds
 * what this process observes, covering a row that vanished without the trigger.
 * Both are expiry-limited: a boundary around one deletion, not a ban on the identity.
 * Absent ⇒ the cutoff is process-local only.
 */
export interface DeletedIdentityStore {
  read: (oidcSubject: string, now: Date) => Promise<Date | null>
  record: (oidcSubject: string, cutoffAt: Date, expiresAt: Date) => Promise<void>
}

/**
 * Fire-and-forget warm of the caller's provider-identity projection
 * (session-access-cold-visit.md §3), fired after every successful OIDC or
 * API-key authentication. `oidcSubject` rides along when the OIDC path already
 * verified it; the API-key path resolves it behind the trigger. Never awaited —
 * the request must complete identically whether it fires, throws, or is absent.
 */
export type EnsureIdentityFresh = (principal: { userId: string; oidcSubject?: string }) => void

/** Registration options: the config plus the optional JIT resolver + API-key verifier. */
export type HumanAuthOptions = HumanAuthConfig & {
  resolveUser?: ResolveOidcUser
  verifyApiKey?: VerifyApiKey
  principalExists?: PrincipalExists
  deletedIdentities?: DeletedIdentityStore
  ensureIdentityFresh?: EnsureIdentityFresh
  /** In-process one-time nonce verifier for nested delegated MCP REST calls. */
  internalInvocationAuth?: Pick<InternalInvocationAuth, 'authorizeInjectedRequest'>
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
    /** The verified OIDC `sub` behind this request. Set only on the real-OIDC path
     *  (never devAuth or an API key). Routes use it to confirm the caller is who
     *  the client thought it was, or to address the CALLER'S OWN provider record
     *  (Logto reads: profile identities, the viewer identity set) — never to look
     *  up anyone else. */
    oidcSubject?: string
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

/** The token is valid but the account behind it was deleted. A distinct `code` so
 *  the console can tell this apart from an expired/invalid token and force a
 *  sign-out instead of retrying with the same (now identity-less) session. */
function accountGone(reply: FastifyReply): FastifyReply {
  return reply.code(401).send({
    error: 'Unauthorized',
    statusCode: 401,
    message: 'this account no longer exists — sign in again',
    code: 'ACCOUNT_GONE'
  })
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
  const upstream = cfg.OIDC_UPSTREAM?.replace(/\/$/, '')
  const discoveryIssuer = upstream
    ? new URL(new URL(issuer).pathname, `${upstream}/`).toString().replace(/\/$/, '')
    : issuer
  let jwksPromise: Promise<ReturnType<typeof createRemoteJWKSet>> | undefined
  function getJwks(): Promise<ReturnType<typeof createRemoteJWKSet>> {
    if (!jwksPromise) {
      jwksPromise = (async () => {
        const res = await fetch(`${discoveryIssuer}/.well-known/openid-configuration`)
        if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`)
        const doc = (await res.json()) as { jwks_uri?: string }
        if (!doc.jwks_uri) throw new Error('OIDC discovery doc missing jwks_uri')
        const jwksUrl = new URL(doc.jwks_uri)
        if (upstream) {
          const target = new URL(upstream)
          jwksUrl.protocol = target.protocol
          jwksUrl.host = target.host
        }
        return createRemoteJWKSet(jwksUrl)
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
  // Subjects whose local account was found deleted, and WHEN (epoch seconds) — a
  // cutoff: every token issued at or before it is refused, for good. The memo
  // eviction alone would let the very next request with the same bearer re-run JIT
  // provisioning and recreate the account the admin just removed — a retry or a
  // parallel console poll would resurrect it before the client finishes signing out.
  // Only a token issued AFTER the deletion (a new authentication) may provision
  // again, and admitting one does NOT lift the cutoff, so the old bearer never
  // becomes valid against the replacement row.
  //
  // This map is the fast path; `cfg.deletedIdentities` is its durable twin, read the
  // first time a process sees a subject and written whenever a deletion is observed,
  // so a restart does not forget the boundary while a pre-deletion bearer is still
  // live. Both are expiry-limited (TOMBSTONE_TTL_SECONDS, far beyond any access-token
  // lifetime): a boundary around one deletion, NOT a ban on the identity. Once it
  // expires, a deleted user signing in again is ordinary open signup — a fresh, gated
  // account with nothing inherited — and whether that is allowed at all is the
  // deleting application's policy, not this plane's.
  const tombstoned = new Map<string, number>()
  const TOMBSTONE_TTL_SECONDS = 24 * 60 * 60
  async function tombstone(
    sub: string,
    issuedAt: number | undefined,
    nowSeconds: number,
    log: FastifyRequest['log']
  ): Promise<void> {
    for (const [key, at] of tombstoned) if (nowSeconds - at > TOMBSTONE_TTL_SECONDS) tombstoned.delete(key)
    // At least the offending token's own `iat`, so an issuer clock running ahead of
    // ours cannot mint a token that reads as "issued after the deletion".
    const cutoff = Math.max(nowSeconds, issuedAt ?? 0)
    tombstoned.set(sub, cutoff)
    try {
      await cfg.deletedIdentities?.record(
        sub,
        new Date(cutoff * 1000),
        new Date((cutoff + TOMBSTONE_TTL_SECONDS) * 1000)
      )
    } catch (err) {
      // The in-memory cutoff still holds for this process; only restart durability
      // is lost, and refusing the request is the important part.
      log.warn({ err }, 'humanAuth: could not persist the deleted-account cutoff')
    }
  }

  /** The cutoff for `sub`: the in-memory one, or — the first time this process sees
   *  the subject — whatever a previous process durably recorded. Fail-open on a store
   *  error: a blip must not lock people out. */
  async function cutoffFor(sub: string, log: FastifyRequest['log']): Promise<number | undefined> {
    const known = tombstoned.get(sub)
    if (known !== undefined) return known
    // Only on first sight: once the subject is resolved (or tombstoned) in this
    // process, the maps answer and this never runs again — so it stays off the hot path.
    if (!cfg.deletedIdentities || resolved.has(sub)) return undefined
    try {
      const at = await cfg.deletedIdentities.read(sub, new Date())
      if (!at) return undefined
      const seconds = Math.floor(at.getTime() / 1000)
      tombstoned.set(sub, seconds)
      return seconds
    } catch (err) {
      log.warn({ err }, 'humanAuth: could not read the deleted-account cutoff — admitting')
      return undefined
    }
  }
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
      let isAdmin = hasAdminRole(payload.roles)
      // Was this subject's account deleted? Anything issued at or before that moment
      // — including the bearer that was live when it happened — stays rejected, so no
      // amount of retrying re-provisions it. A token with no `iat` cannot prove it is
      // newer, so it is refused too. A demonstrably newer one clears the tombstone
      // and signs up afresh. (A silent refresh also mints a newer `iat`; a bearer
      // alone cannot distinguish that from a re-login, and the console drops its
      // tokens on ACCOUNT_GONE, so this is the achievable line.)
      const tombstonedAt = await cutoffFor(sub, req.log)
      if (tombstonedAt !== undefined) {
        const issuedAt = typeof payload.iat === 'number' ? payload.iat : undefined
        if (issuedAt === undefined || issuedAt <= tombstonedAt) {
          req.log.warn('humanAuth: token predates the account deletion — session rejected')
          return accountGone(reply)
        }
        // The cutoff is KEPT, not cleared, when a newer token is admitted: clearing it
        // would let the pre-deletion bearer through again (it would then resolve to the
        // replacement row and pass the existence check), quietly reviving the very
        // session the deletion ended. It only ages out via TOMBSTONE_TTL_SECONDS.
      }
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
      if (idTokenHint) {
        try {
          const { payload: idClaims } = await jwtVerify(idTokenHint, await getJwks(), { issuer })
          if (idClaims.sub === sub) {
            isAdmin ||= hasAdminRole(idClaims.roles)
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
      // The memo (and the token) can outlive the account: an admin deleting a user
      // leaves this subject mapped to a row that no longer exists. Confirm it, drop
      // the dead mapping, and refuse the session so the client signs out — the next
      // sign-in provisions a genuinely new account instead of resurrecting the old
      // session. Fail-OPEN on a store error: a DB blip must not sign everyone out.
      if (cfg.principalExists) {
        let alive = true
        try {
          alive = await cfg.principalExists(identity.userId)
        } catch (err) {
          req.log.warn({ err }, 'humanAuth: could not confirm the principal still exists — admitting')
        }
        if (!alive) {
          resolved.delete(sub)
          // Tombstone the subject as well, so this bearer (and every concurrent
          // request already holding it) cannot fall through to JIT provisioning and
          // recreate the account the admin just deleted.
          await tombstone(
            sub,
            typeof payload.iat === 'number' ? payload.iat : undefined,
            Math.floor(Date.now() / 1000),
            req.log
          )
          req.log.warn({ userId: identity.userId }, 'humanAuth: account no longer exists — session rejected')
          return accountGone(reply)
        }
      }
      // Identity only — which org the request acts on is the URL's business
      // (`/orgs/:orgId/…`, verified by the org-scope guard).
      req.principal = {
        userId: identity.userId,
        email: email ?? headerEmail,
        ...(isAdmin ? { isAdmin: true } : {})
      }
      req.oidcSubject = sub
      // Warm the identity projection behind this response (cold-visit §3). Contained:
      // a throw here must not fall into the outer catch and 401 a valid token.
      try {
        cfg.ensureIdentityFresh?.({ userId: identity.userId, oidcSubject: sub })
      } catch (warmErr) {
        req.log.debug({ err: warmErr }, 'humanAuth: identity warm trigger failed')
      }
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
function withApiKeyAuth(
  verify: VerifyApiKey,
  base: preHandlerHookHandler,
  ensureIdentityFresh?: EnsureIdentityFresh
): preHandlerHookHandler {
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
    // Cold-visit §3: for API-key readers (agent-assistant MCP) the first authenticated
    // request can BE `/sessions`, so the warm fires here too; the trigger resolves the
    // sub itself. Contained — it must never fail an authenticated request.
    try {
      ensureIdentityFresh?.({ userId: resolved.userId })
    } catch (warmErr) {
      req.log.debug({ err: warmErr }, 'humanAuth: identity warm trigger failed')
    }
  }
}

function withInternalInvocationAuth(
  internal: Pick<InternalInvocationAuth, 'authorizeInjectedRequest'>,
  base: preHandlerHookHandler
): preHandlerHookHandler {
  const delegate = base as (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (internal.authorizeInjectedRequest(req)) return
    return delegate(req, reply)
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
    const externalHandler = cfg.verifyApiKey ? withApiKeyAuth(cfg.verifyApiKey, base, cfg.ensureIdentityFresh) : base
    const handler = cfg.internalInvocationAuth
      ? withInternalInvocationAuth(cfg.internalInvocationAuth, externalHandler)
      : externalHandler
    app.decorate('humanAuth', handler)
    // Invite redemption and any future account-distinct flow use this hook so
    // an OSS devAuth principal or personal API key can never impersonate a user.
    app.decorate('oidcAuth', realOidc ?? oidcUnavailable)
    app.decorateRequest('principal', undefined)
    app.decorateRequest('apiKeyId', undefined)
    app.decorateRequest('apiKeyOrgId', undefined)
    app.decorateRequest('apiKeyScopes', undefined)
    app.decorateRequest('delegatedInvocation', undefined)
    done()
  },
  { name: 'human-auth', fastify: '5.x' }
)
