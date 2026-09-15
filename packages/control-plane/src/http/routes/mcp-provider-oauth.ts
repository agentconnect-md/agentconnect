/**
 * The HTTP edge of the MCP-provider authorization funnel (docs/designs/mcp-provider-oauth.md).
 *
 * Two plugins, because the hops have different audiences. `mcpProviderOauthRoutes` is the
 * authenticated org-scoped surface the console calls. `mcpProviderOauthPublicRoutes` carries
 * the two hops a BROWSER performs — unauthenticated by necessity, since the user is arriving
 * from the authorization server rather than from the console.
 *
 * Those two are mounted at BOTH `/api/v1` and the public `/v1` alias, exactly like
 * `gitlabOauthRoutes`: the callback url is registered with the authorization server once,
 * in its public form, and cannot change afterwards. Mounting only the internal prefix is a
 * failure that appears in production and nowhere else.
 *
 * SECURITY: no handler here may log a code, a state value, or a cookie.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { Tag } from '../plugins/openapi.js'
import type { HttpDeps } from '../deps.js'
import { orgOf, denyViewerWrite, ctxOf } from '../rbac.js'
import { canEdit } from '../../authorization/policy.js'
import { ErrorDto, IdParam, McpProviderOauthStartDto, StartMcpProviderOauthBody } from '../dto/index.js'
import { McpOauthDenied, MCP_OAUTH_BROWSER_COOKIE } from '../../mcp-oauth/service.js'
import { serializeByProvider } from '../provider-chain.js'

/** The one-shot browser-binding cookie, read back at the callback. */
function browserCookie(req: FastifyRequest): string | undefined {
  const raw = req.headers.cookie
  if (raw === undefined) return undefined
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === MCP_OAUTH_BROWSER_COOKIE) return rest.join('=')
  }
  return undefined
}

export function mcpProviderOauthRoutes(deps: HttpDeps) {
  return async function mcpProviderOauthRoutesPlugin(app: FastifyInstance): Promise<void> {
    const oauth = deps.mcpProviderOauth
    if (!oauth) return
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.post(
      '/mcp-providers/:id/oauth/start',
      {
        schema: {
          tags: [Tag.Mcp],
          summary: 'Start MCP provider authorization',
          description:
            "Discover the provider's authorization server, obtain a client identity, and return a URL the console opens in a popup to complete OAuth. Supplying `clientId` uses a pre-registered client instead of dynamic registration. Requires a deployment public CP URL, since the callback is registered with the authorization server.",
          operationId: 'startMcpProviderOauth',
          params: IdParam,
          body: StartMcpProviderOauthBody,
          response: { 200: McpProviderOauthStartDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const provider = await deps.repos.mcpProvider.get(orgOf(req), req.params.id)
        if (!provider || !canEdit(provider, ctxOf(req))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'mcp provider not found' })
        }
        try {
          return await oauth.start({
            orgId: orgOf(req),
            providerId: req.params.id,
            userId: req.principal?.userId ?? '',
            ...(req.body.returnPath !== undefined ? { returnPath: req.body.returnPath } : {}),
            ...(req.body.clientId !== undefined ? { clientId: req.body.clientId } : {}),
            ...(req.body.clientSecret !== undefined ? { clientSecret: req.body.clientSecret } : {})
          })
        } catch (err) {
          if (err instanceof McpOauthDenied) {
            // `reason` is a closed code set and never carries a host or a secret.
            return reply.code(err.status).send({ error: 'Bad Request', statusCode: err.status, message: err.reason })
          }
          throw err
        }
      }
    )

    r.post(
      '/mcp-providers/:id/oauth/disconnect',
      {
        schema: {
          tags: [Tag.Mcp],
          summary: 'Disconnect an MCP provider grant',
          description:
            'Drop the stored OAuth grant and stop projecting it into the relay binding. The provider row and its grant key stay, so re-authorizing restores it without any agent having to re-select the provider.',
          operationId: 'disconnectMcpProviderOauth',
          params: IdParam,
          response: { 204: z.void(), 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const provider = await deps.repos.mcpProvider.get(orgOf(req), req.params.id)
        if (!provider || !canEdit(provider, ctxOf(req))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'mcp provider not found' })
        }
        // BOTH halves inside the provider's chain, as one critical section. A refresher
        // rebind re-reads this provider inside the same chain, so running the state change
        // and the unbind outside it lets a rebind that read a live credential land AFTER the
        // unbind and republish a callable binding for a grant the database has revoked.
        await serializeByProvider(orgOf(req), provider.name, async () => {
          await oauth.disconnect(orgOf(req), req.params.id)
          await deps.mcpOauthUnbind?.(orgOf(req), provider)
        })
        return reply.code(204).send(undefined)
      }
    )
  }
}

/** The two browser hops. Mounted at BOTH prefixes — see the file header. */
export function mcpProviderOauthPublicRoutes(deps: HttpDeps) {
  return async function mcpProviderOauthPublicRoutesPlugin(app: FastifyInstance): Promise<void> {
    const oauth = deps.mcpProviderOauth
    if (!oauth) return
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.get(
      '/mcp-providers/oauth/begin',
      { schema: { hide: true, querystring: z.object({ state: z.string().min(1).max(128) }) } },
      async (req, reply) => {
        const begun = await oauth.begin(req.query.state)
        // Unknown, expired, or already-begun state: one uniform failure, restart from the console.
        if (!begun) return reply.redirect(oauth.redirectTarget('/', 'state_invalid'))
        const secure = deps.config.PUBLIC_CP_URL?.startsWith('https://') === true
        reply.header(
          'set-cookie',
          `${MCP_OAUTH_BROWSER_COOKIE}=${begun.browserNonce}; Max-Age=900; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
        )
        return reply.redirect(begun.redirectUrl)
      }
    )

    r.get(
      '/mcp-providers/oauth/callback',
      {
        schema: {
          hide: true,
          querystring: z.object({
            code: z.string().max(4096).optional(),
            state: z.string().max(128).optional(),
            iss: z.string().max(512).optional(),
            error: z.string().max(128).optional()
          })
        }
      },
      async (req, reply) => {
        const { redirectPath, result } = await oauth.callback({
          state: req.query.state,
          code: req.query.code,
          iss: req.query.iss,
          error: req.query.error,
          browserNonce: browserCookie(req)
        })
        // The one-shot cookie has served its purpose either way.
        reply.header('set-cookie', `${MCP_OAUTH_BROWSER_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`)
        return reply.redirect(oauth.redirectTarget(redirectPath, result))
      }
    )
  }
}
