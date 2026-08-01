import type { FastifyRequest } from 'fastify'
import type {
  ExternalScopeRecord,
  SessionExternalAccessSnapshot,
  SessionFilterQuery,
  SessionMetaRecord
} from '../persistence/ports.js'
import type { HttpDeps } from './deps.js'
import { makeViewerIdentitySet } from './viewer-identity.js'
import { ctxOf, orgOf } from './rbac.js'

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
    const orgId = orgOf(req)
    const providers = ['slack', 'github'] as const
    const [identitySet, initialPolicies] = await Promise.all([
      identitySetFor(req),
      Promise.all(providers.map((provider) => deps.repos.session.getExternalAccessPolicy(orgId, provider)))
    ])
    const slackScopes = scopes.filter((scope) => scope.provider === 'slack' && scope.orgId === orgId)
    const githubScopes = scopes.filter((scope) => scope.provider === 'github' && scope.orgId === orgId)
    const [slackResult, githubResult] = await Promise.all([
      deps.slackSessionAccess
        ? deps.slackSessionAccess.resolve(slackScopes, identitySet)
        : Promise.resolve({ allowedScopes: [], degraded: slackScopes.length > 0 }),
      deps.githubSessionAccess
        ? deps.githubSessionAccess.resolve(githubScopes, ctxOf(req).userId)
        : Promise.resolve({ allowedScopes: [], degraded: githubScopes.length > 0 })
    ])
    const resolvedScopes = [...slackResult.allowedScopes, ...githubResult.allowedScopes]
    // Provider lookup can take multiple round trips. Re-read the durable fence
    // afterwards so a concurrent enable cannot authorize with an old disabled
    // snapshot. SQL repeats the current-policy check for list reads.
    const [currentPolicies, currentAllowedScopes] = await Promise.all([
      Promise.all(providers.map((provider) => deps.repos.session.getExternalAccessPolicy(orgId, provider))),
      deps.repos.session.getExternalScopes(resolvedScopes.map((scope) => scope.id))
    ])
    const currentScopeRevisions = new Map(
      currentAllowedScopes
        .filter(
          (scope) =>
            scope.orgId === orgId &&
            providers.includes(scope.provider as (typeof providers)[number]) &&
            scope.revokedAt === null
        )
        .map((scope) => [scope.id, scope.aclRevision])
    )
    const allowedScopes = resolvedScopes.filter((scope) => currentScopeRevisions.get(scope.id) === scope.aclRevision)
    return {
      identitySet,
      externalAccess: {
        policies: currentPolicies.flatMap((policy, index) => {
          const initial = initialPolicies[index]
          return policy && initial ? [{ provider: policy.provider, readFenceRev: policy.readFenceRev }] : []
        }),
        allowedScopes,
        decisionAt: new Date(deps.clock.now())
      },
      // Request diagnostics describe this authorization attempt. Durable
      // migration degradation (for example an unrelated historical pending
      // row) stays on the owner-only settings surface and must not make every
      // member-facing list/detail claim that a provider itself is unavailable.
      degraded: slackResult.degraded || githubResult.degraded || allowedScopes.length !== resolvedScopes.length
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
