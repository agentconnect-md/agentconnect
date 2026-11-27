// `PUT /internal/orgs/:orgId/session-policy` — a deployment-level service delivers an org's session policy by revision (org-session-policy.md).
import { SESSION_POLICY_WRITER_SA_NAME } from '@agentconnect.md/protocol'
import { z } from 'zod'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { ErrorDto } from '../dto/index.js'
import { bearerOf, matchesSecret } from './internal-usage.js'
import { pushOrgHistoryRetention } from '../../registry/orgHistoryRetention.js'

// The columns are int4, so a larger value is refused as a bad body rather than failing the write.
const INT4_MAX = 2_147_483_647

export const SessionPolicyBody = z
  .object({
    revision: z.number().int().min(1).max(INT4_MAX),
    monthlySessionLimit: z.number().int().min(0).max(INT4_MAX).nullable(),
    historyRetentionDays: z.number().int().min(1).max(INT4_MAX).nullable(),
    enforce: z.boolean(),
    // Bytes the org's artifacts may hold (artifacts.md §10.2); omitted or null is no limit, and `enforce` does not gate it.
    artifactBytesLimit: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional()
  })
  .strict()

export function internalSessionPolicyRoutes(deps: HttpDeps) {
  return async function internalSessionPolicyRoutesPlugin(app: FastifyInstance): Promise<void> {
    const expected = deps.config.SESSION_POLICY_TOKEN
    const writerSa = deps.config.SESSION_POLICY_WRITER_SERVICE_ACCOUNT ?? SESSION_POLICY_WRITER_SA_NAME
    const cluster = deps.clusterWorkloadIdentity
    const policies = deps.repos.orgSessionPolicy
    // Neither credential mode configured ⇒ the route does not exist, so the path answers 404.
    if ((!expected && !cluster) || !policies) return
    const r = app.withTypeProvider<ZodTypeProvider>()

    const authenticate = async (credential: string): Promise<boolean> => {
      if (expected && matchesSecret(credential, expected)) return true
      if (!cluster) return false
      return (await cluster.verify(credential, writerSa)) !== null
    }

    r.put(
      '/internal/orgs/:orgId/session-policy',
      {
        // Before the body is parsed; a review outage is retryable (503), not a verdict on the caller.
        onRequest: async (req: FastifyRequest, reply: FastifyReply) => {
          const credential = bearerOf(req)
          try {
            if (credential && (await authenticate(credential))) return
          } catch (err) {
            req.log.error({ err }, 'session policy: identity review failed')
            return reply.code(503).send({
              error: 'Service Unavailable',
              statusCode: 503,
              message: 'could not verify the service credential'
            })
          }
          return reply.code(401).send({ error: 'Unauthorized', statusCode: 401, message: 'invalid service credential' })
        },
        schema: {
          hide: true,
          params: z.object({ orgId: z.string().min(1) }),
          body: SessionPolicyBody,
          response: { 200: z.object({ appliedRevision: z.number().int() }), 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const appliedRevision = await policies.apply(req.params.orgId, req.body)
        if (appliedRevision === null) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'organization not found' })
        }
        // An applied revision reaches the serving daemons now; a failed push only waits for their next register/ok.
        if (appliedRevision === req.body.revision) {
          await pushOrgHistoryRetention(
            {
              policies,
              agents: deps.repos.agent,
              placement: deps.placementResolver,
              daemonConns: deps.daemonConns,
              control: deps.control,
              log: req.log
            },
            req.params.orgId
          ).catch((err: unknown) => req.log.warn({ err }, 'session policy: history retention push failed'))
        }
        return { appliedRevision }
      }
    )
  }
}
