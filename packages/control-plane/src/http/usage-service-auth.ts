/**
 * `http/usage-service-auth.ts` — the second way onto the org usage aggregate.
 *
 * The window route serves two callers with one implementation: a console user, whose
 * answer stays inside their session visibility, and a settlement job, which must total
 * everything an org spent whether or not any human may read those sessions. That second
 * caller authenticates as a Kubernetes workload, exactly as the usage collector does on
 * the write side — a different ServiceAccount, because creating spend records and
 * disclosing them are not the same risk and no pod should hold both by accident.
 *
 * Both credentials arrive as `Authorization: Bearer`, so this hook must decide which
 * verifier to run WITHOUT paying for the wrong one. It reads the unverified payload and
 * looks for the `kubernetes.io` claim a projected ServiceAccount token carries. That
 * peek decides routing only — never trust: a token that looks like a workload's is still
 * proven by TokenReview, and one that does not is left entirely to `humanAuth`. Skipping
 * it would mean a TokenReview round trip to the API server for every console dashboard
 * poll.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { USAGE_READER_SA_NAME } from '@agentconnect.md/protocol'
import type { HttpDeps } from './deps.js'
import { OrgId } from '../domain/ids.js'

declare module 'fastify' {
  interface FastifyRequest {
    /** Set when a verified usage-reader workload is asking: read the org whole, with no
     *  human's visibility applied. Absent ⇒ this is an ordinary console request. */
    usageServiceOrgId?: OrgId
  }
}

/** The bearer credential, or null when the header is absent or not a bearer. */
function bearerOf(req: FastifyRequest): string | null {
  const header = req.headers.authorization
  if (typeof header !== 'string') return null
  const [scheme, ...rest] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer') return null
  const credential = rest.join(' ')
  return credential.length > 0 ? credential : null
}

/** Does this JWT's UNVERIFIED payload carry the claim a projected ServiceAccount token
 *  has? Routing only — the answer decides which verifier runs, never whether to trust. */
function looksLikeWorkloadToken(credential: string): boolean {
  const payload = credential.split('.')[1]
  if (!payload) return false
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return typeof claims === 'object' && claims !== null && 'kubernetes.io' in claims
  } catch {
    return false
  }
}

/**
 * Admit a verified usage-reader workload, or leave the request untouched for `humanAuth`.
 *
 * Registered BEFORE `humanAuth` and the org scope, both of which stand down once this
 * has admitted the caller — a workload has no membership row to check and no session
 * visibility to apply.
 */
export function usageServiceAuth(deps: HttpDeps) {
  return async function usageServiceAuthHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const cluster = deps.clusterWorkloadIdentity
    if (!cluster) return
    const credential = bearerOf(req)
    if (!credential || !looksLikeWorkloadToken(credential)) return

    let verified: Awaited<ReturnType<typeof cluster.verify>>
    try {
      verified = await cluster.verify(credential, USAGE_READER_SA_NAME)
    } catch (err) {
      // A TokenReview failure is an UPSTREAM outage, not a verdict on the caller:
      // answering 401 would tell a correctly-credentialed job to stop retrying.
      req.log.error({ err }, 'usage read: identity review failed')
      return reply.code(503).send({
        error: 'Service Unavailable',
        statusCode: 503,
        message: 'could not verify the service credential'
      })
    }
    // A workload token that is not the reader is refused here rather than falling
    // through: `humanAuth` would reject it anyway, but as an opaque 401 that hides
    // which credential was wrong from the operator reading CP logs.
    if (!verified) {
      return reply.code(401).send({ error: 'Unauthorized', statusCode: 401, message: 'invalid service credential' })
    }

    const orgId = (req.params as { orgId?: string }).orgId
    if (!orgId) {
      return reply.code(400).send({ error: 'Bad Request', statusCode: 400, message: 'missing orgId' })
    }
    // The org must EXIST, or a mistyped id would read as a real org that spent nothing.
    // Membership is deliberately not checked — this principal is install-level and the
    // whole point is to total an org no human need belong to.
    if (!(await deps.repos.org.slugById(orgId))) {
      return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'organization not found' })
    }
    req.usageServiceOrgId = OrgId(orgId)
  }
}

/** Wrap a hook so it stands down once the usage-reader workload is admitted. Both
 *  wrapped hooks are async and ignore the `done` callback, so the no-op passed here is
 *  never called — Fastify awaits the returned promise instead. */
export function unlessUsageService(hook: preHandlerHookHandler): preHandlerHookHandler {
  return async function skipForService(this: FastifyInstance, req, reply) {
    if (req.usageServiceOrgId) return
    await hook.call(this, req, reply, () => {})
  }
}
