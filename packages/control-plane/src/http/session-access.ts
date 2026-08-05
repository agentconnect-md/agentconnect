import type { FastifyRequest } from 'fastify'
import type {
  ExternalScopeRecord,
  SessionExternalAccessSnapshot,
  SessionFilterQuery,
  SessionMetaRecord
} from '../persistence/ports.js'
import { identitySetOf } from '../authorization/policy.js'
import type { HttpDeps } from './deps.js'
import type { SessionAccessIssue, SessionAccessViewer } from './session-access-plugin.js'
import { ctxOf, orgOf } from './rbac.js'

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
  const plugins = deps.sessionAccessPlugins ?? []
  const pluginFor = new Map(plugins.map((plugin) => [plugin.provider, plugin]))
  const providers = [...pluginFor.keys()]

  const viewerFor = async (req: FastifyRequest): Promise<SessionAccessViewer> => {
    const viewer = {
      request: req,
      orgId: orgOf(req),
      userId: ctxOf(req).userId,
      identitySet: identitySetOf(ctxOf(req))
    }
    await Promise.all(
      plugins.map(async (plugin) => {
        try {
          await plugin.addViewerIdentities?.(viewer)
        } catch (err) {
          req.log.warn({ err, provider: plugin.provider }, 'viewer identity lookup failed')
        }
      })
    )
    return viewer
  }

  const forScopes = async (
    scopes: readonly ExternalScopeRecord[],
    viewer: SessionAccessViewer
  ): Promise<ResolvedSessionAccess> => {
    const { orgId, identitySet } = viewer
    const initialPolicies = await Promise.all(
      providers.map((provider) => deps.repos.session.getExternalAccessPolicy(orgId, provider))
    )
    const results = await Promise.all(
      plugins.map((plugin) =>
        plugin.resolve(
          scopes.filter((scope) => scope.provider === plugin.provider && scope.orgId === orgId),
          viewer
        )
      )
    )
    const resolvedScopes = results.flatMap((result) => result.allowedScopes)
    // Provider lookup can take multiple round trips. Re-read the durable fence
    // afterwards so a concurrent enable cannot authorize with an old disabled
    // snapshot. SQL repeats the current-policy check for list reads.
    const [currentPolicies, currentAllowedScopes] = await Promise.all([
      Promise.all(providers.map((provider) => deps.repos.session.getExternalAccessPolicy(orgId, provider))),
      deps.repos.session.getExternalScopes(resolvedScopes.map((scope) => scope.id))
    ])
    const currentScopeRevisions = new Map(
      currentAllowedScopes
        .filter((scope) => scope.orgId === orgId && pluginFor.has(scope.provider) && scope.revokedAt === null)
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
      degraded: results.some((result) => result.degraded) || allowedScopes.length !== resolvedScopes.length,
      accessIssues: results.flatMap((result) => result.accessIssues ?? [])
    }
  }

  return {
    async forQuery(req: FastifyRequest, query: SessionFilterQuery): Promise<ResolvedSessionAccess> {
      const viewer = await viewerFor(req)
      const scopes = await deps.repos.session.listExternalScopes({
        ...query,
        viewer: { role: ctxOf(req).role, identitySet: [...viewer.identitySet] }
      })
      return forScopes(scopes, viewer)
    },
    async forSessions(
      req: FastifyRequest,
      sessions: readonly Pick<SessionMetaRecord, 'visibility' | 'externalProvider' | 'externalScopeId'>[]
    ): Promise<ResolvedSessionAccess> {
      const viewer = await viewerFor(req)
      const ids = [
        ...new Set(sessions.map((session) => session.externalScopeId).filter((id): id is string => id !== null))
      ]
      const scopes = await deps.repos.session.getExternalScopes(ids)
      const accessIds = new Set(
        sessions
          .filter((session) => session.visibility === 'external')
          .map((session) => session.externalScopeId)
          .filter((id): id is string => id !== null)
      )
      const access = await forScopes(
        scopes.filter((scope) => accessIds.has(scope.id)),
        viewer
      )
      // Private rows use scope metadata for provider branding only. Their
      // authorization remains exact owner identity and never reaches a plugin.
      return { ...access, externalScopes: scopes }
    }
  }
}
