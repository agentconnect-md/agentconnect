/**
 * `http/routes/health.ts` (design §2.1) — the infra probes, at the ROOT and
 * unversioned (versioning a probe is an anti-pattern), unauthenticated.
 *
 *   - `GET /livez`  — liveness. Static `{status:'ok'}`; must stay green through
 *      graceful shutdown so the kubelet never SIGKILLs a draining pod.
 *   - `GET /readyz` — readiness (issue #240). 200 only while serving; 503 with a
 *      reason once shutdown has begun OR the DB is unreachable, so a rolling
 *      update removes the pod from the Service endpoints before it stops
 *      accepting sockets — no dropped requests in the drain window.
 *   - `GET /health` — the original static probe, kept as a back-compat alias.
 */
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { Readiness } from '../readiness.js'
import { HealthDto, LivezDto, ReadyzDto } from '../dto/index.js'

export interface HealthRouteDeps {
  readiness: Readiness
}

export function healthRoutes(deps: HealthRouteDeps) {
  return async function (app: FastifyInstance): Promise<void> {
    const typed = app.withTypeProvider<ZodTypeProvider>()

    // Back-compat: the pre-#240 static probe. `hide` keeps infra probes out of
    // the public OpenAPI doc (versioning/documenting a probe is an anti-pattern).
    typed.get('/health', { schema: { hide: true, response: { 200: HealthDto } } }, async () => ({
      status: 'ok' as const
    }))

    // Liveness — never gated: a draining pod is still alive and must not be killed.
    typed.get('/livez', { schema: { hide: true, response: { 200: LivezDto } } }, async () => ({
      status: 'ok' as const
    }))

    // Readiness — red on shutdown or a dead DB.
    typed.get(
      '/readyz',
      { schema: { hide: true, response: { 200: ReadyzDto, 503: ReadyzDto } } },
      async (_req, reply) => {
        if (deps.readiness.isShuttingDown()) {
          return reply.code(503).send({ status: 'shutting_down' as const })
        }
        try {
          await deps.readiness.pingDb()
        } catch {
          return reply.code(503).send({ status: 'db_unreachable' as const })
        }
        return reply.code(200).send({ status: 'ok' as const })
      }
    )
  }
}
