import type { Clock } from '../domain/clock.js'
import type { ExternalScopeRecord, GithubInstallationRepo } from '../persistence/ports.js'
import type { GithubService } from '../github/service.js'
import { UserAuthzDeniedError, type GithubUserAuthzService } from '../github/user-authz.js'

const ALLOW_TTL_MS = 120_000
const DENY_TTL_MS = 30_000
const UNKNOWN_TTL_MS = 5_000
const MAX_CACHE_ENTRIES = 10_000
const MAX_SCOPES_PER_REQUEST = 200

type Decision = 'allow' | 'deny' | 'unknown'
type CachedDecision = { decision: Decision; expiresAt: number }

export interface GithubSessionAccessResult {
  allowedScopes: Array<{ id: string; aclRevision: bigint }>
  degraded: boolean
}

export interface GithubSessionAccessResolver {
  resolve(scopes: readonly ExternalScopeRecord[], userId: string): Promise<GithubSessionAccessResult>
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
export class GithubSessionAccessService implements GithubSessionAccessResolver {
  private readonly cache = new Map<string, CachedDecision>()

  constructor(
    private readonly deps: {
      installations: GithubInstallationRepo
      github: Pick<GithubService, 'repoRefById'>
      userAuthz?: Pick<GithubUserAuthzService, 'permissionForUser'>
      clock: Clock
    }
  ) {}

  async resolve(scopes: readonly ExternalScopeRecord[], userId: string): Promise<GithubSessionAccessResult> {
    if (scopes.length === 0) return { allowedScopes: [], degraded: false }
    const bounded = scopes.slice(0, MAX_SCOPES_PER_REQUEST)
    let degraded = scopes.length > bounded.length
    const decisions = await mapLimited(bounded, 6, async (scope) => {
      const decision = await this.resolveScope(scope, userId)
      if (decision === 'unknown') degraded = true
      return { scope, decision }
    })
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
    const installation = await this.deps.installations.get(scope.credentialId).catch(() => null)
    if (!installation) return 'unknown'
    if (installation.orgId !== scope.orgId || installation.revokedAt || installation.suspendedAt) return 'deny'

    const key = [scope.id, scope.aclRevision.toString(), installation.installationId.toString(), userId].join(':')
    const cached = this.cache.get(key)
    if (cached && cached.expiresAt > this.deps.clock.now()) return cached.decision

    let decision: Decision
    try {
      const repo = await this.deps.github.repoRefById(installation, BigInt(scope.resourceKey))
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
    this.putCache(key, decision)
    return decision
  }

  private putCache(key: string, decision: Decision): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value as string | undefined
      if (oldest) this.cache.delete(oldest)
    }
    const ttl = decision === 'allow' ? ALLOW_TTL_MS : decision === 'deny' ? DENY_TTL_MS : UNKNOWN_TTL_MS
    this.cache.set(key, { decision, expiresAt: this.deps.clock.now() + ttl })
  }
}
