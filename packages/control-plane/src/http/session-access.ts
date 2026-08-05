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

/** Provider-neutral, requester-safe diagnostic from a session-visibility
 * plugin. A platform may add a region without turning that region into a
 * separate provider identity. */
export interface SessionAccessIssue {
  provider: string
  region?: string
  reason: 'authorization' | 'unavailable'
}

export interface ResolvedSessionAccess {
  identitySet: Set<string>
  externalAccess: SessionExternalAccessSnapshot
  /** Provider scopes already loaded for this authorization decision. Detail
   *  responses reuse their verified realm metadata instead of guessing a
   *  provider variant from the session's protocol platform. */
  externalScopes: readonly ExternalScopeRecord[]
  degraded: boolean
  accessIssues: SessionAccessIssue[]
}

/** Request-bound resolver shared by list/detail/SSE. It never persists a user
 * identity or provider grant; only the adapter's bounded decision cache lives
 * beyond this call. */
export function makeSessionAccessResolver(deps: HttpDeps) {
  const identitySetFor = makeViewerIdentitySet(deps.logtoIdentity, deps.repos.bot)

  const feishuViewerFor = (identitySet: ReadonlySet<string>) => ({
    unionIdsFor: (region: 'feishu' | 'lark') => {
      const prefix = `feishu:${region}:`
      return [...identitySet]
        .filter((identity) => identity.startsWith(prefix))
        .map((identity) => identity.split(':')[3])
        .filter((identity): identity is string => Boolean(identity))
    }
  })

  const forScopes = async (
    req: FastifyRequest,
    scopes: readonly ExternalScopeRecord[],
    identitySet: Set<string>,
    accessScopes: readonly ExternalScopeRecord[] = scopes
  ): Promise<ResolvedSessionAccess> => {
    const orgId = orgOf(req)
    const providers = ['slack', 'github', 'feishu'] as const
    const initialPolicies = await Promise.all(
      providers.map((provider) => deps.repos.session.getExternalAccessPolicy(orgId, provider))
    )
    const slackScopes = accessScopes.filter((scope) => scope.provider === 'slack' && scope.orgId === orgId)
    const githubScopes = accessScopes.filter((scope) => scope.provider === 'github' && scope.orgId === orgId)
    const feishuScopes = accessScopes.filter((scope) => scope.provider === 'feishu' && scope.orgId === orgId)
    const feishuViewer = feishuViewerFor(identitySet)
    const [slackResult, githubResult, feishuResult] = await Promise.all([
      deps.slackSessionAccess
        ? deps.slackSessionAccess.resolve(slackScopes, identitySet)
        : Promise.resolve({ allowedScopes: [], degraded: slackScopes.length > 0 }),
      deps.githubSessionAccess
        ? deps.githubSessionAccess.resolve(githubScopes, ctxOf(req).userId)
        : Promise.resolve({ allowedScopes: [], degraded: githubScopes.length > 0 }),
      deps.feishuSessionAccess
        ? deps.feishuSessionAccess.resolve(feishuScopes, feishuViewer)
        : Promise.resolve({ allowedScopes: [], degraded: feishuScopes.length > 0, accessIssues: [] })
    ])
    const resolvedScopes = [...slackResult.allowedScopes, ...githubResult.allowedScopes, ...feishuResult.allowedScopes]
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
      externalScopes: scopes,
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
      degraded:
        slackResult.degraded ||
        githubResult.degraded ||
        feishuResult.degraded ||
        allowedScopes.length !== resolvedScopes.length,
      accessIssues: feishuResult.accessIssues ?? []
    }
  }

  return {
    async forQuery(req: FastifyRequest, query: SessionFilterQuery): Promise<ResolvedSessionAccess> {
      const identitySet = await identitySetFor(req)
      const scopes = await deps.repos.session.listExternalScopes({
        ...query,
        viewer: { role: ctxOf(req).role, identitySet: [...identitySet] }
      })
      return forScopes(req, scopes, identitySet)
    },
    async forSessions(
      req: FastifyRequest,
      sessions: readonly Pick<
        SessionMetaRecord,
        'visibility' | 'ownerIdentity' | 'externalProvider' | 'externalScopeId'
      >[]
    ): Promise<ResolvedSessionAccess> {
      const identitySet = await identitySetFor(req)
      const scoped = sessions.filter(
        (session) => session.visibility === 'external' || session.externalProvider === 'feishu'
      )
      const ids = [
        ...new Set(scoped.map((session) => session.externalScopeId).filter((id): id is string => id !== null))
      ]
      const membershipIds = new Set(
        scoped
          .filter(
            (session) =>
              session.visibility === 'external' ||
              (session.visibility === 'private' &&
                session.externalProvider === 'feishu' &&
                (!session.ownerIdentity || !identitySet.has(session.ownerIdentity)))
          )
          .map((session) => session.externalScopeId)
          .filter((id): id is string => id !== null)
      )
      const scopes = await deps.repos.session.getExternalScopes(ids)
      return forScopes(
        req,
        scopes,
        identitySet,
        scopes.filter((scope) => membershipIds.has(scope.id))
      )
    }
  }
}
