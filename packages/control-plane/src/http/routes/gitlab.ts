/**
 * `http/routes/gitlab.ts` — GitLab.com OAuth connections
 * (gitlab-com-integration.md §9, §18.2).
 *
 * TWO plugins, mirroring `github.ts`:
 *  - `gitlabRoutes` mounts inside the `/orgs/:orgId` subtree: oauth start,
 *    connection list, disconnect. Connections are infrastructure-class
 *    (org-visible, never canView-filtered), like GitHub installations.
 *  - `gitlabOauthRoutes` mounts at the API version root, UNAUTHENTICATED
 *    (GitLab redirects a browser): the begin hop that stamps the
 *    browser-binding cookie, and the callback that consumes the one-shot
 *    state. Hidden from the published OpenAPI spec.
 *
 * Without GITLAB_CLIENT_ID/SECRET, `deps.gitlab` is absent and none of these
 * routes register — the whole surface 404s.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { orgOf, denyViewerWrite } from '../rbac.js'
import { Tag } from '../plugins/openapi.js'
import { GitlabOauthDenied, OAUTH_BROWSER_COOKIE } from '../../gitlab/oauth.service.js'
import { ErrorDto, GitlabConnectionDto, GitlabConnectionListDto, GitlabOauthStartDto, IdParam } from '../dto/index.js'
import type { GitlabConnectionRecord } from '../../persistence/ports.js'

function toDto(r: GitlabConnectionRecord) {
  return {
    id: r.id,
    gitlabUserId: r.gitlabUserId.toString(),
    gitlabUsername: r.gitlabUsername,
    state: r.state,
    scopes: r.scopes,
    connectedBy: r.userId,
    accessExpiresAt: r.accessExpiresAt ? r.accessExpiresAt.toISOString() : null,
    createdAt: r.createdAt.toISOString()
  }
}

/** The begin-hop browser cookie, parsed by hand (no cookie plugin dependency). */
function browserCookie(req: FastifyRequest): string | undefined {
  const header = req.headers.cookie
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === OAUTH_BROWSER_COOKIE) return part.slice(eq + 1).trim()
  }
  return undefined
}

export function gitlabRoutes(deps: HttpDeps) {
  return async function gitlabRoutesPlugin(app: FastifyInstance): Promise<void> {
    const gitlab = deps.gitlab
    if (!gitlab) return
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.post(
      '/gitlab/oauth/start',
      {
        schema: {
          tags: [Tag.GitLab],
          summary: 'Start a GitLab.com OAuth connection',
          description:
            'Mints a one-shot authorization state bound to this organization and the calling user, and returns the URL the browser must visit to continue on GitLab.com.',
          operationId: 'startGitlabOauth',
          body: z.object({ returnPath: z.string().max(512).optional() }).optional(),
          response: { 200: GitlabOauthStartDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        try {
          return await gitlab.oauth.start(orgOf(req), req.principal!.userId, req.body?.returnPath)
        } catch (e) {
          if (e instanceof GitlabOauthDenied) {
            return reply.code(e.status).send({ error: 'Bad Request', statusCode: e.status, message: e.message })
          }
          throw e
        }
      }
    )

    r.get(
      '/gitlab/connections',
      {
        schema: {
          tags: [Tag.GitLab],
          summary: 'List GitLab.com connections',
          description:
            'The organization-owned GitLab.com OAuth connections: administration identities only, no token material.',
          operationId: 'listGitlabConnections',
          response: { 200: GitlabConnectionListDto }
        }
      },
      async (req) => {
        const rows = await deps.repos.gitlabConnection.listForOrg(orgOf(req))
        return { connections: rows.map(toDto) }
      }
    )

    r.delete(
      '/gitlab/connections/:id',
      {
        schema: {
          tags: [Tag.GitLab],
          summary: 'Disconnect a GitLab.com connection',
          description:
            'Revokes the OAuth grant when possible and removes the stored token pair. Project bindings are not deleted implicitly.',
          operationId: 'disconnectGitlabConnection',
          params: IdParam,
          response: { 200: GitlabConnectionDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const orgId = orgOf(req)
        const removed = await gitlab.oauth.disconnect(orgId, req.params.id)
        const record = removed ? await deps.repos.gitlabConnection.get(orgId, req.params.id) : null
        if (!record) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'gitlab connection not found' })
        }
        return toDto(record)
      }
    )
  }
}

export function gitlabOauthRoutes(deps: HttpDeps) {
  return async function gitlabOauthRoutesPlugin(app: FastifyInstance): Promise<void> {
    const gitlab = deps.gitlab
    if (!gitlab) return
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.get(
      '/gitlab/oauth/begin',
      { schema: { hide: true, querystring: z.object({ state: z.string().min(1).max(128) }) } },
      async (req, reply) => {
        const begun = await gitlab.oauth.begin(req.query.state)
        if (!begun) {
          // Unknown, expired, or already-begun state: uniform failure, restart from the console.
          return reply.redirect(gitlab.oauth.redirectTarget('/', 'state_invalid'))
        }
        const secure = deps.config.PUBLIC_CP_URL?.startsWith('https://') === true
        reply.header(
          'set-cookie',
          `${OAUTH_BROWSER_COOKIE}=${begun.browserNonce}; Max-Age=900; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
        )
        return reply.redirect(begun.redirectUrl)
      }
    )

    r.get(
      '/gitlab/oauth/callback',
      {
        schema: {
          hide: true,
          querystring: z.object({
            code: z.string().max(4096).optional(),
            state: z.string().max(128).optional(),
            error: z.string().max(128).optional()
          })
        }
      },
      async (req, reply) => {
        const { redirectPath, result } = await gitlab.oauth.callback(
          req.query.state,
          req.query.error ? undefined : req.query.code,
          browserCookie(req)
        )
        // The one-shot cookie has served its purpose either way.
        reply.header('set-cookie', `${OAUTH_BROWSER_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`)
        return reply.redirect(gitlab.oauth.redirectTarget(redirectPath, result))
      }
    )
  }
}
