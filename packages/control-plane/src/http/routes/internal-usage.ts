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
 * NOT a console surface and NOT part of the documented public API (`hide`). Two
 * credential modes, each independently configured, mirroring how a daemon may knock
 * with either a projected cluster identity or a key:
 *
 *  - **projected token** — a Kubernetes ServiceAccount token from the collector pod,
 *    verified by TokenReview. Preferred wherever it is available: short-lived and
 *    rotated by the kubelet, revocable by deleting the pod without redeploying the CP,
 *    audience-scoped against replay, and it attests WHICH pod for audit.
 *  - **shared secret** — `USAGE_INGEST_TOKEN`, for a deployment with no cluster to
 *    review against (self-hosted, or a collector outside the CP's namespace).
 *
 * With NEITHER configured the route is NEVER REGISTERED — an unconfigured deployment
 * answers 404, not 401, so the surface simply does not exist.
 *
 * Writes are cumulative upserts, so redelivery cannot double-count: on any non-2xx
 * the caller retries the WHOLE batch and no per-item receipt is needed. Reports for
 * an agent that no longer exists are dropped by the store rather than failing the
 * batch, so one stale row can never wedge a retry loop.
 *
 * These reports are the ones that get billed, so the body schema is stricter than the
 * daemon EVT's: the cost must be the exact decimal string and its currency must be
 * present, and a batch that violates either is refused whole (400) before anything is
 * written. Silently treating a missing amount as zero spend is the failure this
 * prevents — the caller retries once its own metering is complete.
 */
import { timingSafeEqual } from 'node:crypto'
import { USAGE_COLLECTOR_SA_NAME } from '@agentconnect.md/protocol'
import { z } from 'zod'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { UsageReportBatchBody } from '../dto/index.js'
import { normalizeUsageReport } from '../../usage/writer.js'

/** The bearer credential, or null when the header is absent or not a bearer. */
function bearerOf(req: FastifyRequest): string | null {
  const header = req.headers.authorization
  if (typeof header !== 'string') return null
  const [scheme, ...rest] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer') return null
  const credential = rest.join(' ')
  return credential.length > 0 ? credential : null
}

/** Constant-time compare. The length check comes first because `timingSafeEqual`
 *  requires equal lengths, and a token's length is not the secret. */
function matchesSecret(presented: string, expected: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function internalUsageRoutes(deps: HttpDeps) {
  return async function internalUsageRoutesPlugin(app: FastifyInstance): Promise<void> {
    const expected = deps.config.USAGE_INGEST_TOKEN
    // The deployment names its collector workload; this is how it tells the verifying side.
    const collectorSa = deps.config.USAGE_COLLECTOR_SERVICE_ACCOUNT ?? USAGE_COLLECTOR_SA_NAME
    const cluster = deps.clusterWorkloadIdentity
    if (!expected && !cluster) return
    const r = app.withTypeProvider<ZodTypeProvider>()

    // Secret first: it is a local compare, so the API server is spared a round trip on
    // every request in a deployment that uses it. A projected token can never collide
    // with the secret — a mismatch just falls through to the review.
    const authenticate = async (credential: string): Promise<boolean> => {
      if (expected && matchesSecret(credential, expected)) return true
      if (!cluster) return false
      return (await cluster.verify(credential, collectorSa)) !== null
    }

    r.post(
      '/internal/usage/reports',
      {
        // `onRequest`, so an unauthenticated caller is refused before the body is
        // even parsed — the batch can be large and is not worth reading first.
        onRequest: async (req: FastifyRequest, reply: FastifyReply) => {
          const credential = bearerOf(req)
          // A TokenReview failure is an UPSTREAM outage, not a verdict on the caller:
          // answering 401 would tell a correctly-credentialed collector to stop
          // retrying, so it is a retryable 503 instead.
          try {
            if (credential && (await authenticate(credential))) return
          } catch (err) {
            req.log.error({ err }, 'usage ingest: identity review failed')
            return reply.code(503).send({
              error: 'Service Unavailable',
              statusCode: 503,
              message: 'could not verify the service credential'
            })
          }
          return reply.code(401).send({ error: 'Unauthorized', statusCode: 401, message: 'invalid service credential' })
        },
        schema: { hide: true, body: UsageReportBatchBody, response: { 204: z.null() } }
      },
      async (req, reply) => {
        // The schema already refused anything unnormalizable, so this only canonicalizes
        // (`"12.50"` → `"12.5"`) — the writer's input is then one exact shape, always.
        await deps.usageWriter.recordBatch('gateway', req.body.reports.map(normalizeUsageReport))
        return reply.code(204).send(null)
      }
    )
  }
}
