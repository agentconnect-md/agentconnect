import { LRUCache } from 'lru-cache'
import { cacheOptions } from '../cache.js'
import type { Clock } from '../domain/clock.js'
import { OrgId } from '../domain/ids.js'
import type { ExternalScopeRecord, GithubInstallationRecord, GithubInstallationRepo } from '../persistence/ports.js'
import type { GithubService } from '../github/service.js'
import { PROVIDER_IDENTITY_TTL_MS } from '../github/logto-identity.js'
import { UserAuthzDeniedError, type GithubUserAuthzService } from '../github/user-authz.js'
import type {
  SessionAccessPlugin,
  SessionAccessResult,
  SessionAccessViewer,
  SessionAccessWarmOutcome
} from './session-access-plugin.js'

const DENY_TTL_MS = 30_000
const UNKNOWN_TTL_MS = 5_000
const MAX_CACHE_ENTRIES = 10_000
const SCOPES_PER_BATCH = 200
const SCOPE_CONCURRENCY = 6
// Defaults for the §2.3 knobs (`SESSION_ACCESS_RECHECK_SEC` / `_PUBLIC_TTL_SEC`,
// session-access-cold-visit.md) when a caller constructs the service without them.
const DEFAULT_RECHECK_MS = 120_000
const DEFAULT_PUBLIC_TTL_MS = 3_600_000

type Decision = 'allow' | 'deny' | 'unknown'
/** Narrowed `repoRefById` result; null = outside the installation's grant. */
type RepoShape = { fullName: string; private: boolean } | null
type ObservedRepoShape = { shape: RepoShape; fetchedAt: number }
type ShapeLookup = { github: Pick<GithubService, 'repoRefById'>; ins: GithubInstallationRecord; repoId: bigint }

/** The scope rows GitHub can answer for at all — the shared gate of the read path
 *  (anything else is a plain deny) and the §4.1 warm entry (a skip). */
function installationRepositoryScope(
  scope: ExternalScopeRecord
): scope is ExternalScopeRecord & { credentialId: string } {
  return (
    scope.provider === 'github' &&
    scope.realmKey === 'github.com' &&
    scope.resourceKind === 'repository' &&
    scope.revokedAt === null &&
    scope.credentialKind === 'github_installation' &&
    !!scope.credentialId &&
    /^[1-9]\d*$/.test(scope.resourceKey)
  )
}

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
   *  per-request verdict instead of pinning a transient GitHub failure.
   *  Leased by VERDICT (§2 verdict split): a public shape serves for
   *  `publicTtlMs`, a private (or out-of-grant) one for `recheckMs`. */
  private readonly shapes: LRUCache<string, ObservedRepoShape, ShapeLookup>
  /** In-flight §4.2(5) background re-observations, single-flighted per shape key. */
  private readonly revalidating = new Map<string, Promise<void>>()
  /** §2.3 recheck (ms): the per-viewer allow lease AND the shape re-observation threshold. */
  private readonly recheckMs: number
  /** §2.3 serving ceiling (ms) for a public repository shape. */
  private readonly publicTtlMs: number
  /** §5 instrumentation: fetch-method runs = shape-cache misses; revalidations = §4.2(5) firings. */
  readonly stats = { shapeFetches: 0, shapeRevalidations: 0 }

  constructor(
    private readonly deps: {
      installations: GithubInstallationRepo
      github?: Pick<GithubService, 'repoRefById'>
      userAuthz?: Pick<GithubUserAuthzService, 'permissionForUser'>
      clock: Clock
      /** `SESSION_ACCESS_RECHECK_SEC` in ms; defaults so tests can omit it. */
      recheckMs?: number
      /** `SESSION_ACCESS_PUBLIC_TTL_SEC` in ms; defaults so tests can omit it. */
      publicTtlMs?: number
      log?: { debug: (obj: object, msg: string) => void }
    }
  ) {
    this.recheckMs = deps.recheckMs ?? DEFAULT_RECHECK_MS
    this.publicTtlMs = deps.publicTtlMs ?? DEFAULT_PUBLIC_TTL_MS
    this.cache = new LRUCache(cacheOptions(deps.clock, MAX_CACHE_ENTRIES))
    this.shapes = new LRUCache({
      ...cacheOptions(deps.clock, MAX_CACHE_ENTRIES),
      ttl: this.recheckMs,
      // Per-entry TTL, set here because the verdict deciding it is only known after the
      // fetch. A rejection must keep dropping the entry (never a cached failure).
      fetchMethod: async (_key, _stale, { context, options }) => {
        this.stats.shapeFetches += 1
        const observed = {
          shape: await context.github
            .repoRefById(context.ins, context.repoId)
            .then((repo) => (repo ? { fullName: repo.fullName, private: repo.private } : null)),
          fetchedAt: deps.clock.now()
        }
        options.ttl = this.shapeTtl(observed.shape)
        return observed
      }
    })
  }

  /** §2 verdict split: only a PUBLIC shape — a repository fact whose late correction §2.1 bounds — leases long. */
  private shapeTtl(shape: RepoShape): number {
    return shape && !shape.private ? this.publicTtlMs : this.recheckMs
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
    if (!installationRepositoryScope(scope)) return 'deny'
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
    let identityBacked = false
    try {
      const observed = await this.shapeOf(`${installation.installationId}:${scope.resourceKey}`, {
        github,
        ins: installation,
        repoId: BigInt(scope.resourceKey)
      })
      // Only reachable if the entry is dropped mid-flight. Fail closed rather
      // than reading it as "no such repository", which is a deny we cannot back.
      if (!observed) return 'unknown'
      const repo = observed.shape
      if (!repo) decision = 'deny'
      else if (!repo.private) decision = 'allow'
      else if (!this.deps.userAuthz) decision = 'deny'
      else {
        const [owner, name] = repo.fullName.split('/')
        if (!owner || !name) decision = 'unknown'
        else {
          identityBacked = true
          decision =
            (await this.deps.userAuthz.permissionForUser(userId, installation, owner, name, {
              // The permission is the revocable fact — demand it age-zero.
              // WHICH GitHub account the viewer is, is identity metadata that
              // changes only through link/unlink (both invalidate the cache),
              // so it rides the same 120 s identity lease the Slack and Feishu
              // session-access plugins already run on.
              maxCacheAgeMs: 0,
              loginMaxAgeMs: PROVIDER_IDENTITY_TTL_MS
            })) !== 'none'
              ? 'allow'
              : 'deny'
        }
      }
    } catch (err) {
      decision = err instanceof UserAuthzDeniedError ? 'deny' : 'unknown'
    }
    this.putCache(key, decision, identityBacked)
    return decision
  }

  /** Cached + deduped repository shape; past the recheck threshold it serves the
   *  cached value and re-observes behind the response (§4.2(5) touch-revalidation). */
  private async shapeOf(key: string, context: ShapeLookup): Promise<ObservedRepoShape | undefined> {
    const observed = await this.shapes.fetch(key, { context })
    if (observed && this.deps.clock.now() - observed.fetchedAt > this.recheckMs) {
      this.revalidateShape(key, context, observed)
    }
    return observed
  }

  /** §4.2(5) re-observation: single-flighted, never awaited by a request; a failure is
   *  logged, never cached, and never evicts the still-leased entry it failed to replace. */
  private revalidateShape(key: string, context: ShapeLookup, replacing: ObservedRepoShape): void {
    if (this.revalidating.has(key)) return
    this.stats.shapeRevalidations += 1
    this.deps.log?.debug({ provider: 'github' }, 'github repo-shape touch-revalidation fired')
    const task = (async () => {
      try {
        const repo = await context.github.repoRefById(context.ins, context.repoId)
        const shape = repo ? { fullName: repo.fullName, private: repo.private } : null
        // Write fence: land only over the exact entry this re-observation set out to
        // replace — a newer observation since capture must not lose to a stale write.
        if (this.shapes.peek(key) !== replacing) return
        this.shapes.set(key, { shape, fetchedAt: this.deps.clock.now() }, { ttl: this.shapeTtl(shape) })
      } catch {
        this.deps.log?.debug({ provider: 'github' }, 'github repo-shape re-observation failed')
      } finally {
        this.revalidating.delete(key)
      }
    })()
    this.revalidating.set(key, task)
  }

  /** Await in-flight background re-observations — nothing else ever awaits them. */
  async settle(): Promise<void> {
    await Promise.all([...this.revalidating.values()])
  }

  /**
   * §4.1 warm entry (session-access-cold-visit.md): observe one scope's
   * repository shape so a later cold visit finds it leased. The observation
   * goes through `shapeOf` — the classifying wrapper — never the raw cache
   * (§4.2(3)): a rejected lookup stays a per-request failure, and a touch past
   * the recheck threshold re-observes in the background under the write fence.
   * The installation is resolved here, at execution, through the read path's
   * own org fence (§4.2(2)); a failed fence skips and caches nothing.
   */
  async warmShape(scope: ExternalScopeRecord): Promise<SessionAccessWarmOutcome> {
    if (!installationRepositoryScope(scope)) return { outcome: 'skipped', reason: 'scope_shape' }
    const github = this.deps.github
    if (!github) return { outcome: 'skipped', reason: 'github_unconfigured' }
    const installation = await this.deps.installations.get(OrgId(scope.orgId), scope.credentialId).catch(() => null)
    if (!installation) return { outcome: 'skipped', reason: 'installation_unresolved' }
    if (installation.revokedAt || installation.suspendedAt)
      return { outcome: 'skipped', reason: 'installation_revoked' }
    try {
      const observed = await this.shapeOf(`${installation.installationId}:${scope.resourceKey}`, {
        github,
        ins: installation,
        repoId: BigInt(scope.resourceKey)
      })
      if (!observed) return { outcome: 'failed', reason: 'shape_evicted' }
      const shape = observed.shape
      return { outcome: 'warmed', verdict: shape === null ? 'ungranted' : shape.private ? 'private' : 'public' }
    } catch {
      return { outcome: 'failed', reason: 'lookup_failed' }
    }
  }

  private putCache(key: string, decision: Decision, identityBacked: boolean): void {
    // An `allow` leases from the per-viewer check that just ran (age-0 permission for a
    // private repo); the shared shape's age routes WHICH check runs and deliberately no
    // longer bounds the verdict (§2.2) — anchoring to a warmed public observation would
    // mint allows already past their TTL. What this relaxes is exactly the §2.1
    // conversion window, bounded by touch-revalidation.
    //
    // An identity-backed allow (private repo: WHICH GitHub account the viewer is decided
    // it) additionally caps at the provider-identity lease: the key carries only the
    // local user id and link/unlink invalidates the identity caches, never this one, so
    // a recheck knob above 120 s must not stretch what an unlink can leave behind.
    const allowTtl = identityBacked ? Math.min(this.recheckMs, PROVIDER_IDENTITY_TTL_MS) : this.recheckMs
    const ttl = decision === 'allow' ? allowTtl : decision === 'deny' ? DENY_TTL_MS : UNKNOWN_TTL_MS
    this.cache.set(key, decision, { ttl })
  }
}
