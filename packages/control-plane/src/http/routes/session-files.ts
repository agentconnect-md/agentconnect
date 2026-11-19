// Shared-file snapshots (agent-authored-attachments.md §4.1): the bytes a share published, readable while its session is.
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { SessionId } from '../../domain/ids.js'
import { orgOf, ctxOf } from '../rbac.js'
import { canViewSession } from '../../authorization/policy.js'
import { makeSessionAccessResolver } from '../session-access.js'
import { ErrorDto, SessionSharedFileDto, SessionSharedFileParams, SessionSharedFileQuery } from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'

const notFound = { error: 'Not Found', statusCode: 404, message: 'shared file not found' }

export function sessionFileRoutes(deps: HttpDeps) {
  return async function sessionFileRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    const sessionAccess = makeSessionAccessResolver(deps)

    r.get(
      '/sessions/:sessionId/shared-files/:sha256',
      {
        schema: {
          tags: [Tag.Sessions],
          summary: 'Download a file a session shared',
          description:
            'Resolves the digest a `[shared: …]` marker records (its first 16 hex characters, or the whole SHA-256) to the snapshot taken when the agent shared the file, with a short-lived signed URL that downloads it as an attachment. The snapshot is the published revision even after the workspace file changes, and it is kept until the session’s content is deleted. The caller must be able to view the session. Not found when the deployment has no transfer bucket, the share predates snapshots, or its upload failed; the console then falls back to the digest-checked workspace download.',
          operationId: 'getSessionSharedFile',
          params: SessionSharedFileParams,
          querystring: SessionSharedFileQuery,
          response: { 200: SessionSharedFileDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const files = deps.sessionFiles
        if (!files) return reply.code(404).send(notFound)
        // An invisible session reads as absent, as do its snapshots.
        const session = await deps.repos.session.get(orgOf(req), SessionId(req.params.sessionId))
        if (!session) return reply.code(404).send(notFound)
        const access = await sessionAccess.forSessions(req, [session])
        if (!canViewSession(session, ctxOf(req), access.identitySet, access.externalAccess)) {
          return reply.code(404).send(notFound)
        }
        const found = await files.download({
          orgId: orgOf(req),
          sessionId: req.params.sessionId,
          sha256Prefix: req.params.sha256,
          ...(req.query.name ? { name: req.query.name } : {})
        })
        if (!found) return reply.code(404).send(notFound)
        return {
          name: found.name,
          bytes: found.bytes,
          url: found.url,
          expiresAt: new Date(found.expiresAt).toISOString()
        }
      }
    )
  }
}
