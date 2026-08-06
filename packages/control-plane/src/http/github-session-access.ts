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

type Decision = 'allow' | 'deny' | 'unknown'
type CachedDecision = { decision: Decision; expiresAt: number }
/** Narrowed `repoRefById` result; null = outside the installation's grant. */
type RepoShape = { fullName: string; private: boolean } | null
type ObservedRepoShape = { shape: RepoShape; fetchedAt: number }

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
  private readonly cache = new Map<string, CachedDecision>()
  /** (installation, repo) → shape. Shared across viewers, unlike `cache`. */
  private readonly shapes = new Map<string, ObservedRepoShape>()
  private readonly shapesInFlight = new Map<string, Promise<ObservedRepoShape>>()

  constructor(
    private readonly deps: {
      installations: GithubInstallationRepo
      github?: Pick<GithubService, 'repoRefById'>
      userAuthz?: Pick<GithubUserAuthzService, 'permissionForUser'>
      clock: Clock
    }
  ) {}

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
    if (cached && cached.expiresAt > this.deps.clock.now()) return cached.decision

    let decision: Decision
    // When the verdict rests on a reused repository shape, its lease runs from
    // when that shape was observed rather than from now.
    let evidenceAt = this.deps.clock.now()
    try {
      const observed = await this.repoShapeOf(github, installation, BigInt(scope.resourceKey))
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

  /** Cached + deduped repository shape. A failed lookup propagates uncached —
   *  the caller turns it into `unknown`, which must stay a per-request verdict
   *  rather than pinning a transient GitHub failure for two minutes. */
  private repoShapeOf(
    github: Pick<GithubService, 'repoRefById'>,
    ins: GithubInstallationRecord,
    repoId: bigint
  ): Promise<ObservedRepoShape> {
    const key = `${ins.installationId}:${repoId}`
    const cached = this.shapes.get(key)
    if (cached && this.deps.clock.now() - cached.fetchedAt < REPO_SHAPE_TTL_MS) return Promise.resolve(cached)
    let pending = this.shapesInFlight.get(key)
    if (!pending) {
      const tracked: Promise<ObservedRepoShape> = github
        .repoRefById(ins, repoId)
        .then((repo) => {
          const observed: ObservedRepoShape = {
            shape: repo ? { fullName: repo.fullName, private: repo.private } : null,
            fetchedAt: this.deps.clock.now()
          }
          if (this.shapes.size >= MAX_CACHE_ENTRIES) {
            const oldest = this.shapes.keys().next().value as string | undefined
            if (oldest !== undefined) this.shapes.delete(oldest)
          }
          this.shapes.set(key, observed)
          return observed
        })
        .finally(() => {
          if (this.shapesInFlight.get(key) === tracked) this.shapesInFlight.delete(key)
        })
      pending = tracked
      this.shapesInFlight.set(key, pending)
    }
    return pending
  }

  private putCache(key: string, decision: Decision, evidenceAt: number): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value as string | undefined
      if (oldest) this.cache.delete(oldest)
    }
    const ttl = decision === 'allow' ? ALLOW_TTL_MS : decision === 'deny' ? DENY_TTL_MS : UNKNOWN_TTL_MS
    const now = this.deps.clock.now()
    // An `allow` is leased from the EVIDENCE it rests on, so reusing a cached
    // repository shape can never stretch the window a fresh lookup would have
    // granted. `deny`/`unknown` keep the wall-clock lease: reused evidence can
    // only ever narrow access, never widen it.
    const from = decision === 'allow' ? Math.min(evidenceAt, now) : now
    this.cache.set(key, { decision, expiresAt: from + ttl })
  }
}
