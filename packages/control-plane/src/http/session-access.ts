import type { FastifyRequest } from 'fastify'
import type {
  ExternalScopeRecord,
  SessionExternalAccessSnapshot,
  SessionFilterQuery,
  SessionMetaRecord
} from '../persistence/ports.js'
import type { HttpDeps } from './deps.js'
import { makeViewerIdentitySet } from './viewer-identity.js'
import { orgOf } from './rbac.js'

export interface ResolvedSessionAccess {
  identitySet: Set<string>
  externalAccess: SessionExternalAccessSnapshot
  degraded: boolean
}

/** Request-bound resolver shared by list/detail/SSE. It never persists a user
 * identity or provider grant; only the adapter's bounded decision cache lives
 * beyond this call. */
export function makeSessionAccessResolver(deps: HttpDeps) {
  const identitySetFor = makeViewerIdentitySet(deps.logtoIdentity)

  const forScopes = async (
    req: FastifyRequest,
    scopes: readonly ExternalScopeRecord[]
  ): Promise<ResolvedSessionAccess> => {
    const [identitySet, initialSlackPolicy] = await Promise.all([
      identitySetFor(req),
      deps.repos.session.getExternalAccessPolicy(orgOf(req), 'slack')
    ])
    const slackScopes = scopes.filter((scope) => scope.provider === 'slack' && scope.orgId === orgOf(req))
    const result = deps.slackSessionAccess
      ? await deps.slackSessionAccess.resolve(slackScopes, identitySet)
      : { allowedScopes: [], degraded: slackScopes.length > 0 }
    // Provider lookup can take multiple round trips. Re-read the durable fence
    // afterwards so a concurrent enable cannot authorize with an old disabled
    // snapshot. SQL repeats the current-policy check for list reads.
    const [slackPolicy, currentAllowedScopes] = await Promise.all([
      deps.repos.session.getExternalAccessPolicy(orgOf(req), 'slack'),
      deps.repos.session.getExternalScopes(result.allowedScopes.map((scope) => scope.id))
    ])
    const currentScopeRevisions = new Map(
      currentAllowedScopes
        .filter((scope) => scope.orgId === orgOf(req) && scope.provider === 'slack' && scope.revokedAt === null)
        .map((scope) => [scope.id, scope.aclRevision])
    )
    const allowedScopes = result.allowedScopes.filter(
      (scope) => currentScopeRevisions.get(scope.id) === scope.aclRevision
    )
    return {
      identitySet,
      externalAccess: {
        policies:
          slackPolicy && initialSlackPolicy
            ? [{ provider: slackPolicy.provider, readFenceRev: slackPolicy.readFenceRev }]
            : [],
        allowedScopes,
        decisionAt: new Date(deps.clock.now())
      },
      // Request diagnostics describe this authorization attempt. Durable
      // migration degradation (for example an unrelated historical pending
      // row) stays on the owner-only settings surface and must not make every
      // member-facing list/detail claim that Slack itself is unavailable.
      degraded: result.degraded || allowedScopes.length !== result.allowedScopes.length
    }
  }

  return {
    async forQuery(req: FastifyRequest, query: SessionFilterQuery): Promise<ResolvedSessionAccess> {
      return forScopes(req, await deps.repos.session.listExternalScopes(query))
    },
    async forSessions(
      req: FastifyRequest,
      sessions: readonly Pick<SessionMetaRecord, 'visibility' | 'externalScopeId'>[]
    ): Promise<ResolvedSessionAccess> {
      const ids = [
        ...new Set(
          sessions
            .filter((session) => session.visibility === 'external')
            .map((session) => session.externalScopeId)
            .filter((id): id is string => id !== null)
        )
      ]
      return forScopes(req, await deps.repos.session.getExternalScopes(ids))
    }
  }
}
