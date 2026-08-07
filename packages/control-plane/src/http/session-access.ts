import type { FastifyRequest } from 'fastify'
import { LRUCache } from 'lru-cache'
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
 * How long a snapshot is served with no provider work at all.
 *
 * One console page load asks the SAME authorization question from `/sessions`,
 * `/sessions/facets` and `/usage` within the same tick, and each answer used to
 * pay its own full provider sweep — which is why those three were the only reads
 * on the page costing seconds while every other read model returned in tens of
 * milliseconds. Collapsing them fixed the common case but not the tail: whenever
 * this window and a plugin's own decision lease both lapsed, some unlucky
 * request still wore the whole sweep.
 */
const SNAPSHOT_FRESH_MS = 30_000

/**
 * The ceiling on serving a snapshot while its refresh runs behind the request.
 *
 * Past the fresh window a read hands back what it has and re-sweeps in the
 * background, so no console read waits on Slack or GitHub. Past THIS window the
 * entry is gone and the next read blocks on a real sweep — an unbounded
 * stale-while-revalidate would mean a revoked user is never re-checked until
 * they happen to come back.
 *
 * It is not free, and the arithmetic is worth stating: a sweep reuses plugin
 * verdicts that are themselves already up to their own allow lease (120 s) old,
 * so the worst-case age of the evidence behind a served answer is this window
 * PLUS that lease. The pre-SWR 5 s window made that ~125 s; 60 s makes it
 * ~180 s. Every second added here is a second added to the revocation window,
 * one for one — that is the entire price of never blocking, and no setting of
 * this constant avoids it.
 */
const SNAPSHOT_MAX_STALE_MS = 60_000

const MAX_SNAPSHOT_ENTRIES = 2_000

/**
 * Hand back the entry we have and refresh behind the request.
 *
 * The `allowStale…` pair is scoped to THIS path deliberately. A refresh that
 * fails keeps serving the snapshot it was refreshing, up to the ceiling; a COLD
 * sweep that fails must still reject, because resolving it to "no external
 * access" would silently hide every external row instead of reporting an error.
 */
const REFRESH_BEHIND = {
  forceRefresh: true,
  allowStale: true,
  allowStaleOnFetchRejection: true,
  noDeleteOnFetchRejection: true
} as const

/** What one sweep needs, carried to `fetchMethod` as its context. */
type Sweep = { scopes: readonly ExternalScopeRecord[]; viewer: SessionAccessViewer }

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

  /** `fetch` hands concurrent callers of one key the SAME promise, which is the
   *  single-flight this exists for, and drops the entry when the sweep rejects —
   *  a failed sweep is never inherited as a verdict. `perf` is the time seam;
   *  `ttlResolution: 0` turns off lru-cache's 1 ms `now()` debounce, which is
   *  driven by a real timer a `FakeClock` cannot advance. The clock must report
   *  real epoch milliseconds, as `Clock` documents: lru-cache treats a falsy
   *  entry start as "no TTL recorded", so a snapshot written at time 0 would
   *  never expire. */
  const snapshots = new LRUCache<string, ResolvedSessionAccess, Sweep>({
    max: MAX_SNAPSHOT_ENTRIES,
    // The entry's lifetime is the CEILING, not the fresh window: an entry has to
    // outlive its own freshness for there to be anything to serve while the
    // refresh runs. `SNAPSHOT_FRESH_MS` is applied by the reader below.
    ttl: SNAPSHOT_MAX_STALE_MS,
    ttlResolution: 0,
    perf: deps.clock,
    fetchMethod: (_key, _stale, { context }) => forScopes(context.scopes, context.viewer)
  })

  /** `forScopes` behind the snapshot window. Callers treat the record as
   *  immutable; the identity set is copied per hand-out so a caller that does
   *  not cannot corrupt the entry. `decisionAt` is served as recorded — a
   *  reused snapshot truthfully reports when it was decided, which is the only
   *  honest thing to report once one can be served stale. */
  const cachedForScopes = async (
    scopes: readonly ExternalScopeRecord[],
    viewer: SessionAccessViewer
  ): Promise<ResolvedSessionAccess> => {
    const key = snapshotKey(viewer, scopes)
    // The entry's lifetime IS the ceiling, so what remains of it gives the age.
    // A missing or expired key reports 0 and takes the blocking path, which is
    // also what a cold start and anything past the ceiling should do.
    const remaining = snapshots.getRemainingTTL(key)
    const refreshBehind = remaining > 0 && remaining <= SNAPSHOT_MAX_STALE_MS - SNAPSHOT_FRESH_MS
    // `fetch` resolves undefined only if the entry is dropped mid-flight. Sweep
    // directly rather than reporting no external access, which would hide rows.
    const access =
      (await snapshots.fetch(key, {
        context: { scopes, viewer },
        ...(refreshBehind ? REFRESH_BEHIND : {})
      })) ?? (await forScopes(scopes, viewer))
    return { ...access, identitySet: new Set(access.identitySet) }
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
