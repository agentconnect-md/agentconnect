/**
 * `http/oauth/consent.ts` — the consent-page BACKEND (agent-assistant.md §7.3),
 * mounted under `/api/v1` with interactive human authentication (Logto / devAuth;
 * API keys and OAuth access tokens are rejected). The web console's consent page
 * (which is where the human actually logs in — the CP holds no browser session)
 * calls these:
 *
 *   - `GET  /oauth/consent/context` — the client name, the requested scopes, and the
 *     caller's orgs (the org picker), so the page can render the approval screen.
 *   - `POST /oauth/consent`         — on approve, re-validate everything server-side
 *     (client, redirect_uri, PKCE method, org membership) and mint the one-time code,
 *     returning the redirect URL that bounces the browser back to the MCP client.
 *
 * Plus the Profile "Connected AI tools" surface:
 *   - `GET    /oauth/grants`        — the caller's active grants.
 *   - `DELETE /oauth/grants/:id`    — disconnect (revokes the grant + its access tokens).
 */
import type { FastifyInstance } from 'fastify'
import type { HttpDeps } from '../deps.js'
import { redirectUriMatches, normalizeScopes, OAUTH_SCOPES } from '../../registry/oauthService.js'

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

export function oauthConsentRoutes(deps: HttpDeps) {
  return async function oauthConsentPlugin(app: FastifyInstance): Promise<void> {
    app.addHook('preHandler', app.humanAuth)
    app.addHook('preHandler', async (req, reply) => {
      // Derived credentials may exercise their existing authority, but must not
      // mint, enumerate, or revoke OAuth grants.
      if (req.apiKeyId !== undefined) {
        return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'interactive sign-in required' })
      }
    })

    // Approval-screen data: who's asking, for what, and which org to bind.
    app.get('/oauth/consent/context', { schema: { hide: true } }, async (req, reply) => {
      const q = req.query as Record<string, unknown>
      const clientId = str(q.client_id)
      if (!clientId)
        return reply.code(400).send({ error: 'Bad Request', statusCode: 400, message: 'client_id required' })
      const client = await deps.oauth.getActiveClient(clientId)
      if (!client)
        return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'unknown or expired client' })
      const orgs = await deps.repos.org.listForUser(req.principal!.userId)
      return {
        clientId: client.clientId,
        clientName: client.clientName,
        scopes: normalizeScopes(str(q.scope)),
        organizations: orgs.map((o) => ({ id: o.id, slug: o.slug, name: o.name, role: o.role }))
      }
    })

    // Approve/deny. On approve, mint a single-use code bound to the consenting user+org.
    app.post('/oauth/consent', { schema: { hide: true } }, async (req, reply) => {
      const b = (req.body ?? {}) as Record<string, unknown>
      const clientId = str(b.clientId)
      const redirectUri = str(b.redirectUri)
      const codeChallenge = str(b.codeChallenge)
      const codeChallengeMethod = str(b.codeChallengeMethod)
      const state = str(b.state)
      if (!clientId || !redirectUri) {
        return reply
          .code(400)
          .send({ error: 'Bad Request', statusCode: 400, message: 'clientId and redirectUri required' })
      }
      // Re-validate the client + redirect_uri server-side — the browser-carried params
      // are not trusted (an open redirect / phishing guard).
      const client = await deps.oauth.getActiveClient(clientId)
      if (!client || !redirectUriMatches(client.redirectUris, redirectUri)) {
        req.log.warn({ clientId, redirectUri, knownClient: !!client }, 'oauth: consent rejected — client/redirect')
        return reply
          .code(400)
          .send({ error: 'Bad Request', statusCode: 400, message: 'invalid client or redirect_uri' })
      }

      if (str(b.decision) === 'deny') {
        return { redirectUrl: buildRedirect(redirectUri, { error: 'access_denied', state }) }
      }
      if (codeChallengeMethod !== 'S256' || !codeChallenge) {
        return reply.code(400).send({ error: 'Bad Request', statusCode: 400, message: 'PKCE S256 required' })
      }

      const orgId = str(b.orgId)
      if (!orgId) return reply.code(400).send({ error: 'Bad Request', statusCode: 400, message: 'orgId required' })
      // The consenting user must actually belong to the org they bind the grant to.
      const role = await deps.repos.org.roleOf(orgId, req.principal!.userId)
      if (!role) {
        req.log.warn({ clientId, orgId, userId: req.principal!.userId }, 'oauth: consent rejected — not a member')
        return reply
          .code(403)
          .send({ error: 'Forbidden', statusCode: 403, message: 'not a member of that organization' })
      }

      // Granted scopes = what the user approved, clamped to what we support.
      const requested = normalizeScopes(str(b.scope))
      const approved = Array.isArray(b.grantedScopes)
        ? b.grantedScopes.filter((s): s is string => typeof s === 'string')
        : requested
      const scopes = OAUTH_SCOPES.filter((s) => requested.includes(s) && approved.includes(s))
      if (scopes.length === 0) scopes.push('mcp:read')

      const code = await deps.oauth.issueCode({
        clientId,
        redirectUri,
        userId: req.principal!.userId,
        orgId,
        scopes,
        codeChallenge,
        codeChallengeMethod,
        ...(str(b.resource) ? { resource: str(b.resource)! } : {})
      })
      return { redirectUrl: buildRedirect(redirectUri, { code, state }) }
    })

    // Profile "Connected AI tools": list the caller's active grants.
    app.get('/oauth/grants', { schema: { hide: true } }, async (req) => {
      const grants = await deps.oauth.listGrants(req.principal!.userId)
      const named = await Promise.all(
        grants.map(async (g) => {
          const client = await deps.oauth.getActiveClient(g.clientId)
          return {
            id: g.id,
            clientId: g.clientId,
            clientName: client?.clientName ?? null,
            orgId: g.orgId,
            scopes: g.scopes,
            createdAt: g.createdAt.toISOString(),
            lastUsedAt: g.lastUsedAt ? g.lastUsedAt.toISOString() : null
          }
        })
      )
      return { grants: named }
    })

    // Disconnect: revoke the grant + cascade-revoke its access tokens.
    app.delete('/oauth/grants/:id', { schema: { hide: true } }, async (req, reply) => {
      const { id } = req.params as { id: string }
      const ok = await deps.oauth.revokeGrant(req.principal!.userId, id)
      if (!ok) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'grant not found' })
      return reply.code(204).send(null)
    })
  }
}

function buildRedirect(redirectUri: string, params: Record<string, string | undefined>): string {
  const u = new URL(redirectUri)
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v)
  return u.toString()
}
