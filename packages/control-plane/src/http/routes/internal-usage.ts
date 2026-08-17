/**
 * `http/routes/internal-usage.ts` — the NON-DAEMON adapter of the usage report
 * interface, the sibling of the `usage/report` EVT.
 *
 * `POST /internal/usage/reports` accepts a batch of the same cumulative
 * `SessionUsageReport` payload the daemon EVT carries, and hands it to the same
 * `UsageWriter` stamped `gateway`. It exists for a deployment whose sessions are
 * metered upstream of any daemon: the daemon plane is then switched off as a
 * reporter and this endpoint is the single writer for those sessions.
 *
 * NOT a console surface and NOT part of the documented public API (`hide`): it is
 * authenticated by a deployment-shared service secret (`USAGE_INGEST_TOKEN`), and
 * when that secret is unset the route is NEVER REGISTERED — an unconfigured
 * deployment answers 404, not 401, so the surface simply does not exist.
 *
 * Writes are cumulative upserts, so redelivery cannot double-count: on any non-2xx
 * the caller retries the WHOLE batch and no per-item receipt is needed. Reports for
 * an agent that no longer exists are dropped by the store rather than failing the
 * batch, so one stale row can never wedge a retry loop.
 */
import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { UsageReportBatchBody } from '../dto/index.js'

/** Constant-time bearer compare. The length check comes first because
 *  `timingSafeEqual` requires equal lengths, and a token's length is not secret. */
function presentsToken(req: FastifyRequest, expected: string): boolean {
  const header = req.headers.authorization
  if (typeof header !== 'string') return false
  const [scheme, ...rest] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer') return false
  const a = Buffer.from(rest.join(' '))
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function internalUsageRoutes(deps: HttpDeps) {
  return async function internalUsageRoutesPlugin(app: FastifyInstance): Promise<void> {
    const expected = deps.config.USAGE_INGEST_TOKEN
    if (!expected) return
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.post(
      '/internal/usage/reports',
      {
        // `onRequest`, so an unauthenticated caller is refused before the body is
        // even parsed — the batch can be large and is not worth reading first.
        onRequest: async (req: FastifyRequest, reply: FastifyReply) => {
          if (presentsToken(req, expected)) return
          return reply.code(401).send({ error: 'Unauthorized', statusCode: 401, message: 'invalid service credential' })
        },
        schema: { hide: true, body: UsageReportBatchBody, response: { 204: z.null() } }
      },
      async (req, reply) => {
        await deps.usageWriter.recordBatch('gateway', req.body.reports)
        return reply.code(204).send(null)
      }
    )
  }
}
