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

export interface SessionAccessResolver {
  forQuery(req: FastifyRequest, query: SessionFilterQuery): Promise<ResolvedSessionAccess>
  forSessions(
    req: FastifyRequest,
    sessions: readonly Pick<SessionMetaRecord, 'visibility' | 'externalProvider' | 'externalScopeId'>[]
  ): Promise<ResolvedSessionAccess>
}

/**
 * How long one resolved provider snapshot is reused.
 *
 * Deliberately short. One console page load asks the SAME authorization
 * question from `/sessions`, `/sessions/facets` and `/usage` within the same
 * tick, and each answer used to pay its own full provider sweep — which is why
 * those three were the only reads on the page costing seconds while every other
 * read model returned in tens of milliseconds. This window collapses them into
 * one sweep and nothing more: the plugins' own decision leases (allow 120 s,
 * deny 30 s, unknown 5 s) remain the real freshness bound, and this can only add
 * seconds to them.
 *
 * The post-resolution policy re-read (see `forScopes`) is reused for the same
 * window. That fence is backstopped by SQL, which repeats the current-policy
 * check per row on every list read.
 */
const SNAPSHOT_TTL_MS = 5_000
const MAX_SNAPSHOT_ENTRIES = 2_000

/** Exactly the inputs `forScopes` reads — org, the viewer it decides for, the
 *  identities it decides with, and the scope set it decides about. An ACL bump
 *  changes `aclRevision`, so a re-fenced scope can never hit a stale entry. */
function snapshotKey(viewer: SessionAccessViewer, scopes: readonly ExternalScopeRecord[]): string {
  return [
    viewer.orgId,
    viewer.userId,
    [...viewer.identitySet].sort().join(','),
    scopes
      .map((scope) => `${scope.id}:${scope.aclRevision}`)
      .sort()
      .join(',')
  ].join('\u0000')
}

/** Request-bound resolver shared by list/detail/SSE. It never persists a user
 * identity or provider grant; only the adapter's bounded decision cache and the
 * short snapshot below live beyond one call. */
function buildSessionAccessResolver(deps: HttpDeps): SessionAccessResolver {
  const plugins = deps.sessionAccessPlugins ?? []
  const pluginFor = new Map(plugins.map((plugin) => [plugin.provider, plugin]))
  const providers = [...pluginFor.keys()]
  const snapshots = new Map<string, { access: ResolvedSessionAccess; expiresAt: number }>()
  const inFlight = new Map<string, Promise<ResolvedSessionAccess>>()

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

  /** `forScopes` behind the snapshot window, single-flighted so the concurrent
   *  reads of one page load trigger one sweep instead of racing four. Callers
   *  treat the record as immutable; the identity set is copied per hand-out so
   *  a caller that does not cannot corrupt the entry. `decisionAt` is served as
   *  recorded — a reused snapshot truthfully reports when it was decided. */
  const cachedForScopes = (
    scopes: readonly ExternalScopeRecord[],
    viewer: SessionAccessViewer
  ): Promise<ResolvedSessionAccess> => {
    const key = snapshotKey(viewer, scopes)
    const cached = snapshots.get(key)
    if (cached && cached.expiresAt > deps.clock.now()) {
      return Promise.resolve({ ...cached.access, identitySet: new Set(cached.access.identitySet) })
    }
    const pending = inFlight.get(key)
    if (pending) return pending.then((access) => ({ ...access, identitySet: new Set(access.identitySet) }))
    const tracked: Promise<ResolvedSessionAccess> = forScopes(scopes, viewer)
      // Only a completed sweep is recorded — a rejected one skips this and the
      // next read re-asks, rather than inheriting an error as a verdict.
      .then((access) => {
        if (snapshots.size >= MAX_SNAPSHOT_ENTRIES) {
          const oldest = snapshots.keys().next().value as string | undefined
          if (oldest !== undefined) snapshots.delete(oldest)
        }
        snapshots.set(key, { access, expiresAt: deps.clock.now() + SNAPSHOT_TTL_MS })
        return access
      })
      .finally(() => {
        if (inFlight.get(key) === tracked) inFlight.delete(key)
      })
    inFlight.set(key, tracked)
    return tracked
  }

  return {
    async forQuery(req: FastifyRequest, query: SessionFilterQuery): Promise<ResolvedSessionAccess> {
      const viewer = await viewerFor(req)
      const scopes = await deps.repos.session.listExternalScopes({
        ...query,
        viewer: { role: ctxOf(req).role, identitySet: [...viewer.identitySet] }
      })
      return cachedForScopes(scopes, viewer)
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
      const access = await cachedForScopes(
        scopes.filter((scope) => accessIds.has(scope.id)),
        viewer
      )
      // Private rows use scope metadata for provider branding only. Their
      // authorization remains exact owner identity and never reaches a plugin.
      return { ...access, externalScopes: scopes }
    }
  }
}

/**
 * One resolver — and so one snapshot cache — per composed app.
 *
 * Five route modules build a resolver of their own (`/sessions`, `/usage`,
 * `/stream`, `/agents`, plus session detail), and a single console page load
 * asks several of them the same authorization question at once. A per-module
 * instance would give each its own cache and defeat the whole point, so the
 * instance is memoized on the deps object that composes the app. Keying on
 * `deps` rather than a module-level singleton is what keeps two apps in one
 * process (every integration test) from sharing authorization state.
 */
const resolvers = new WeakMap<HttpDeps, SessionAccessResolver>()

export function makeSessionAccessResolver(deps: HttpDeps): SessionAccessResolver {
  const existing = resolvers.get(deps)
  if (existing) return existing
  const resolver = buildSessionAccessResolver(deps)
  resolvers.set(deps, resolver)
  return resolver
}
