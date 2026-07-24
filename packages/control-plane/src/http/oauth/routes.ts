/**
 * `http/oauth/routes.ts` — the embedded OAuth AS's protocol endpoints (agent-assistant.md
 * §7.2), served at the ROOT (outside `/api/v1`, unauthenticated — these ARE the auth
 * bootstrap). Plain Fastify (inject-testable); the OAuth logic lives in `OAuthService`.
 *   - `POST /oauth/register`  — RFC 7591 dynamic client registration (public clients).
 *   - `GET  /oauth/authorize` — validates the request, then 302s to the web console's
 *     consent page (where the human logs in — the CP holds no browser session).
 *   - `POST /oauth/token`     — authorization_code + refresh_token grants (PKCE-verified).
 *
 * The consent page (web console) calls back into `/api/v1/oauth/consent` (consent.ts) to
 * mint the code.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { HttpDeps } from '../deps.js'
import { publicBaseUrl } from './base.js'
import { redirectUriMatches } from '../../registry/oauthService.js'

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

/** Build `redirect_uri?...params` for the browser to bounce back to the client. */
function redirectWith(redirectUri: string, params: Record<string, string | undefined>): string {
  const u = new URL(redirectUri)
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v)
  return u.toString()
}

/** Where the browser consent page lives: the web console origin (PUBLIC_WEB_URL), or the
 *  CP origin as a single-origin fallback. */
function consentOrigin(req: FastifyRequest, deps: HttpDeps): string {
  return (deps.config.PUBLIC_WEB_URL ?? publicBaseUrl(req, deps.config)).replace(/\/+$/, '')
}

export function oauthRoutes(deps: HttpDeps) {
  return async function oauthRoutesPlugin(app: FastifyInstance): Promise<void> {
    // /token is form-urlencoded (OAuth 2.1); the global JSON parser would 415 it.
    // Scoped to this plugin so it doesn't affect the rest of the API.
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)))
      } catch (err) {
        done(err as Error)
      }
    })

    // ── RFC 7591 Dynamic Client Registration ──────────────────────────────────
    app.post('/oauth/register', { schema: { hide: true } }, async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const result = await deps.oauth.registerClient({
        ...(str(body.client_name) ? { clientName: str(body.client_name)! } : {}),
        redirectUris: body.redirect_uris,
        ...(body.grant_types !== undefined ? { grantTypes: body.grant_types } : {})
      })
      if (!result.ok) {
        req.log.warn({ failure: result.failure, clientName: str(body.client_name) }, 'oauth: register rejected')
        return reply.code(400).send(result.failure)
      }
      const c = result.value
      return reply.code(201).send({
        client_id: c.clientId,
        ...(c.clientName ? { client_name: c.clientName } : {}),
        redirect_uris: c.redirectUris,
        grant_types: c.grantTypes,
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        client_id_issued_at: Math.floor(c.createdAt.getTime() / 1000)
      })
    })

    // ── Authorization endpoint → 302 to the console consent page ──────────────
    app.get('/oauth/authorize', { schema: { hide: true } }, async (req, reply) => {
      const q = req.query as Record<string, unknown>
      const clientId = str(q.client_id)
      const redirectUri = str(q.redirect_uri)
      const responseType = str(q.response_type)
      const codeChallenge = str(q.code_challenge)
      const codeChallengeMethod = str(q.code_challenge_method)

      // Without a validated client + redirect_uri we must NOT redirect (open-redirect /
      // credential-phishing guard) — surface a plain 400 instead.
      if (!clientId || !redirectUri) {
        req.log.warn({ clientId }, 'oauth: authorize rejected — client_id/redirect_uri missing')
        return reply
          .code(400)
          .send({ error: 'invalid_request', error_description: 'client_id and redirect_uri required' })
      }
      const client = await deps.oauth.getActiveClient(clientId)
      if (!client) {
        req.log.warn({ clientId }, 'oauth: authorize rejected — unknown or expired client')
        return reply.code(400).send({ error: 'invalid_client', error_description: 'unknown or expired client' })
      }
      if (!redirectUriMatches(client.redirectUris, redirectUri)) {
        req.log.warn({ clientId, redirectUri }, 'oauth: authorize rejected — redirect_uri not registered')
        return reply.code(400).send({ error: 'invalid_request', error_description: 'redirect_uri not registered' })
      }

      // From here the redirect_uri is trusted, so protocol errors bounce back to it.
      const state = str(q.state)
      if (responseType !== 'code') {
        req.log.warn({ clientId, responseType }, 'oauth: authorize bounced — unsupported response_type')
        return reply.redirect(redirectWith(redirectUri, { error: 'unsupported_response_type', state }))
      }
      if (!codeChallenge || codeChallengeMethod !== 'S256') {
        req.log.warn({ clientId, codeChallengeMethod }, 'oauth: authorize bounced — PKCE S256 required')
        return reply.redirect(
          redirectWith(redirectUri, { error: 'invalid_request', error_description: 'PKCE S256 required', state })
        )
      }

      // Hand the (browser-carried) request to the console consent page. No server-side
      // pending-request row: the params ride the browser and are re-validated at consent.
      const consent = new URL('/oauth/consent', consentOrigin(req, deps))
      consent.searchParams.set('client_id', clientId)
      consent.searchParams.set('redirect_uri', redirectUri)
      consent.searchParams.set('code_challenge', codeChallenge)
      consent.searchParams.set('code_challenge_method', codeChallengeMethod)
      if (str(q.scope)) consent.searchParams.set('scope', str(q.scope)!)
      if (state) consent.searchParams.set('state', state)
      if (str(q.resource)) consent.searchParams.set('resource', str(q.resource)!)
      return reply.redirect(consent.toString())
    })

    // ── Token endpoint ────────────────────────────────────────────────────────
    app.post('/oauth/token', { schema: { hide: true } }, async (req, reply) => {
      const b = (req.body ?? {}) as Record<string, unknown>
      void reply.header('cache-control', 'no-store')
      const grantType = str(b.grant_type)

      if (grantType === 'authorization_code') {
        const code = str(b.code)
        const redirectUri = str(b.redirect_uri)
        const clientId = str(b.client_id)
        const codeVerifier = str(b.code_verifier)
        if (!code || !redirectUri || !clientId || !codeVerifier) {
          req.log.warn(
            { clientId, has: { code: !!code, redirectUri: !!redirectUri, codeVerifier: !!codeVerifier } },
            'oauth: token rejected — missing code exchange parameter'
          )
          return reply
            .code(400)
            .send({ error: 'invalid_request', error_description: 'missing code exchange parameter' })
        }
        const result = await deps.oauth.exchangeCode({ code, clientId, redirectUri, codeVerifier })
        if (!result.ok) {
          req.log.warn({ clientId, redirectUri, failure: result.failure }, 'oauth: code exchange rejected')
          return reply.code(400).send(result.failure)
        }
        return reply.send(result.value)
      }

      if (grantType === 'refresh_token') {
        const refreshToken = str(b.refresh_token)
        if (!refreshToken) {
          req.log.warn('oauth: token rejected — refresh_token required')
          return reply.code(400).send({ error: 'invalid_request', error_description: 'refresh_token required' })
        }
        const result = await deps.oauth.refresh({ refreshToken })
        if (!result.ok) {
          req.log.warn({ failure: result.failure }, 'oauth: refresh rejected')
          return reply.code(400).send(result.failure)
        }
        return reply.send(result.value)
      }

      req.log.warn({ grantType }, 'oauth: token rejected — unsupported grant_type')
      return reply.code(400).send({ error: 'unsupported_grant_type' })
    })
  }
}
