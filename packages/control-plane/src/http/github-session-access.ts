import { LRUCache } from 'lru-cache'
import type { Clock } from '../domain/clock.js'
import { OrgId } from '../domain/ids.js'
import type { ExternalScopeRecord, GithubInstallationRecord, GithubInstallationRepo } from '../persistence/ports.js'
import type { GithubService } from '../github/service.js'
import { UserAuthzDeniedError, type GithubUserAuthzService } from '../github/user-authz.js'
import type { SessionAccessPlugin, SessionAccessResult, SessionAccessViewer } from './session-access-plugin.js'

const ALLOW_TTL_MS = 120_000
const DENY_TTL_MS = 30_000
const UNKNOWN_TTL_MS = 5_000
const MAX_CACHE_ENTRIES = 10_000
const SCOPES_PER_BATCH = 200
const SCOPE_CONCURRENCY = 6
/**
 * How long one repository's shape (private flag + full name) is reused.
 *
 * The shape is a property of the REPOSITORY, not of the viewer — a public repo
 * is readable by every org member with no identity check at all — while the
 * decision cache below is keyed per user. So each user was paying their own
 * uncached `GET /repositories/:id`, and for the public majority that lookup IS
 * the entire check. Reusing it costs no lease: an `allow` expires this long
 * after the shape was OBSERVED, not after it was reused (see `putCache`).
 */
const REPO_SHAPE_TTL_MS = 120_000

/**
 * Shared `LRUCache` wiring.
 *
 * `perf` is THE time seam — without it the cache would read the wall clock
 * while everything around it reads the injected one. `ttlResolution: 0` turns
 * off lru-cache's 1 ms `now()` debounce, which is driven by a real timer a
 * `FakeClock` cannot advance; expiry is evaluated lazily on read, so no
 * background timer exists either way.
 *
 * The clock MUST report real epoch milliseconds, as `Clock` documents. lru-cache
 * stores an entry's start time and treats a falsy one as "no TTL recorded", so an
 * entry written at time 0 would never expire. Production passes `Date.now()`;
 * a test clock has to be seeded with an epoch rather than left at 0.
 */
function cacheOptions(clock: Clock) {
  return { max: MAX_CACHE_ENTRIES, ttlResolution: 0, perf: clock } as const
}

type Decision = 'allow' | 'deny' | 'unknown'
/** Narrowed `repoRefById` result; null = outside the installation's grant. */
type RepoShape = { fullName: string; private: boolean } | null
type ObservedRepoShape = { shape: RepoShape; fetchedAt: number }
type ShapeLookup = { github: Pick<GithubService, 'repoRefById'>; ins: GithubInstallationRecord; repoId: bigint }

async function mapLimited<T, R>(values: readonly T[], limit: number, fn: (value: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(values.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (next < values.length) {
        const index = next++
        out[index] = await fn(values[index]!)
      }
    })
  )
  return out
}

/** Current GitHub repository visibility for one console user. Repository ids
 * and installation locators are durable; user identity and permission remain
 * provider-owned and only bounded verdicts are cached in process. */
export class GithubSessionAccessService implements SessionAccessPlugin {
  readonly provider = 'github'
  /** Per-viewer verdicts. Every entry carries its own TTL — see `putCache`. */
  private readonly cache: LRUCache<string, Decision>
  /** (installation, repo) → shape. Shared across viewers, unlike `cache`.
   *  `fetch` hands concurrent callers of one key the same promise, and drops
   *  the entry when the lookup rejects, so a failed lookup stays a
   *  per-request verdict instead of pinning a transient GitHub failure. */
  private readonly shapes: LRUCache<string, ObservedRepoShape, ShapeLookup>

  constructor(
    private readonly deps: {
      installations: GithubInstallationRepo
      github?: Pick<GithubService, 'repoRefById'>
      userAuthz?: Pick<GithubUserAuthzService, 'permissionForUser'>
      clock: Clock
    }
  ) {
    this.cache = new LRUCache(cacheOptions(deps.clock))
    this.shapes = new LRUCache({
      ...cacheOptions(deps.clock),
      ttl: REPO_SHAPE_TTL_MS,
      fetchMethod: async (_key, _stale, { context }) => ({
        shape: await context.github
          .repoRefById(context.ins, context.repoId)
          .then((repo) => (repo ? { fullName: repo.fullName, private: repo.private } : null)),
        fetchedAt: deps.clock.now()
      })
    })
  }

  get available(): boolean {
    return this.deps.github !== undefined && this.deps.userAuthz !== undefined
  }

  async resolve(scopes: readonly ExternalScopeRecord[], viewer: SessionAccessViewer): Promise<SessionAccessResult> {
    if (scopes.length === 0) return { allowedScopes: [], degraded: false }
    let degraded = false
    const decisions: Array<{ scope: ExternalScopeRecord; decision: Decision }> = []
    // 200 is a provider-work batch, never a visibility ceiling. Walk every
    // batch so UUID ordering cannot silently hide an otherwise-allowed scope.
    for (let start = 0; start < scopes.length; start += SCOPES_PER_BATCH) {
      decisions.push(
        ...(await mapLimited(scopes.slice(start, start + SCOPES_PER_BATCH), SCOPE_CONCURRENCY, async (scope) => {
          const decision = await this.resolveScope(scope, viewer.userId)
          if (decision === 'unknown') degraded = true
          return { scope, decision }
        }))
      )
    }
    return {
      allowedScopes: decisions
        .filter(({ decision }) => decision === 'allow')
        .map(({ scope }) => ({ id: scope.id, aclRevision: scope.aclRevision })),
      degraded
    }
  }

  private async resolveScope(scope: ExternalScopeRecord, userId: string): Promise<Decision> {
    if (
      scope.provider !== 'github' ||
      scope.realmKey !== 'github.com' ||
      scope.resourceKind !== 'repository' ||
      scope.revokedAt !== null ||
      scope.credentialKind !== 'github_installation' ||
      !scope.credentialId ||
      !/^[1-9]\d*$/.test(scope.resourceKey)
    ) {
      return 'deny'
    }
    const github = this.deps.github
    if (!github) return 'unknown'
    // Fenced on the org recorded in the session's own external scope row — the
    // check this replaces (org-scoped-data-layer.md §3).
    const installation = await this.deps.installations.get(OrgId(scope.orgId), scope.credentialId).catch(() => null)
    if (!installation) return 'unknown'
    if (installation.revokedAt || installation.suspendedAt) return 'deny'

    const key = [scope.id, scope.aclRevision.toString(), installation.installationId.toString(), userId].join(':')
    const cached = this.cache.get(key)
    if (cached) return cached

    let decision: Decision
    // When the verdict rests on a reused repository shape, its lease runs from
    // when that shape was observed rather than from now.
    let evidenceAt = this.deps.clock.now()
    try {
      const observed = await this.shapes.fetch(`${installation.installationId}:${scope.resourceKey}`, {
        context: { github, ins: installation, repoId: BigInt(scope.resourceKey) }
      })
      // Only reachable if the entry is dropped mid-flight. Fail closed rather
      // than reading it as "no such repository", which is a deny we cannot back.
      if (!observed) return 'unknown'
      evidenceAt = observed.fetchedAt
      const repo = observed.shape
      if (!repo) decision = 'deny'
      else if (!repo.private) decision = 'allow'
      else if (!this.deps.userAuthz) decision = 'deny'
      else {
        const [owner, name] = repo.fullName.split('/')
        if (!owner || !name) decision = 'unknown'
        else
          decision =
            (await this.deps.userAuthz.permissionForUser(userId, installation, owner, name, {
              maxCacheAgeMs: 0
            })) !== 'none'
              ? 'allow'
              : 'deny'
      }
    } catch (err) {
      decision = err instanceof UserAuthzDeniedError ? 'deny' : 'unknown'
    }
    this.putCache(key, decision, evidenceAt)
    return decision
  }

  private putCache(key: string, decision: Decision, evidenceAt: number): void {
    const ttl = decision === 'allow' ? ALLOW_TTL_MS : decision === 'deny' ? DENY_TTL_MS : UNKNOWN_TTL_MS
    // An `allow` is leased from the EVIDENCE it rests on — `start` is the
    // observation, not the reuse — so serving a cached repository shape can
    // never stretch the window a fresh lookup would have granted. `deny` and
    // `unknown` run from now: reused evidence can only narrow access, never
    // widen it, so there is nothing to bound.
    const start = decision === 'allow' ? Math.min(evidenceAt, this.deps.clock.now()) : undefined
    this.cache.set(key, decision, { ttl, ...(start !== undefined ? { start } : {}) })
  }
}
