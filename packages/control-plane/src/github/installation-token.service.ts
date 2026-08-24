/**
 * Installation-token mint + cache + single-flight (design §CP Side).
 *
 * Every grant is scoped to ONE repository with narrowed permissions
 * (`contents: read|write`, `metadata: read`, plus `workflows: write` whenever
 * contents are writable) and lives exactly one hour (GitHub-fixed,
 * non-renewable). Cache + in-flight coalescing exist to bound GitHub API
 * traffic AND to make the daemon's 5s ReqRep retransmits idempotent: duplicate
 * dispatches of the same gitcred/request collapse onto one GitHub call and
 * return byte-identical grants.
 *
 * Threshold nesting (the daemon hands tokens out only while >10min remain):
 * the CP serves a cached token only while >15min remain, so a grant always
 * reaches the daemon with ≥15min of life. All expiry math shaves a 60s
 * clock-skew allowance off GitHub's `expires_at` and compares against the
 * injected Clock — never a raw Date.now().
 *
 * Token material stays in this process's memory and the grant payload. NEVER
 * log it.
 */
import type { GitCredCapability } from '@agentconnect.md/protocol'
import type { Clock } from '../domain/clock.js'
import { githubRequest, mintAppJwt, type FetchLike } from './api.js'
import type { GithubAppConfig } from './config.js'

export type GitAccess = 'read' | 'write'

/** Per-capability permission levels (agent-multi-repo-authorization.md decision 3):
 *  a `comment`-tier additional repo mints contents:read + issues/PR:write — a shape
 *  the uniform (access × capabilities) form cannot express. Only listed
 *  agent capabilities are granted; `workflows: write` follows
 *  `contents: write`, and `metadata: read` always rides along. */
export type CapabilityLevels = Partial<Record<GitCredCapability, GitAccess>>
type InternalPermission = GitCredCapability | 'checks' | 'workflows'
type InternalPermissionLevels = Partial<Record<InternalPermission, GitAccess>>

/** Absent `capabilities` on the wire ⇒ the pre-P2.5 contents-only grant. */
const DEFAULT_CAPABILITIES: readonly GitCredCapability[] = ['contents']

export interface MintedGitCred {
  token: string
  /** Seconds of remaining life at serve time (skew already shaved). */
  ttlSec: number
  /** GitHub's absolute expiry — observability only; consumers use ttlSec. */
  expiresAt: string
  repoFullName: string
  access: GitAccess
  /** Numeric repository id the token was scoped to, when the resolution had one — the v2 grant echo. */
  repoId?: bigint
}

/** Serve cached only while more than this remains (nests over the daemon's 10min). */
const FRESH_MIN_MS = 15 * 60 * 1000
/** Shaved off GitHub's expires_at before any comparison or ttlSec computation. */
const SKEW_MS = 60 * 1000

interface CacheEntry {
  token: string
  /** expires_at minus skew, epoch ms. */
  expiresAtMs: number
  expiresAtIso: string
}

interface GithubTokenResponse {
  token: string
  expires_at: string
}

/** The installation facts changed while a token request was in flight. The
 * token may exist at GitHub, but it must never cross an action boundary based
 * on the superseded authorization generation. */
export class InstallationTokenInvalidatedError extends Error {
  readonly retryable = true

  constructor() {
    super('github installation changed while minting a token')
    this.name = 'InstallationTokenInvalidatedError'
  }
}

export class InstallationTokenService {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inflight = new Map<string, Promise<CacheEntry>>()
  /** Invalidation generation per installation. A mint that started before a
   * doorbell/sync invalidation may finish, but can never repopulate the cache. */
  private readonly installationEpoch = new Map<string, number>()

  constructor(
    private readonly cfg: GithubAppConfig,
    private readonly clock: Clock,
    private readonly fetchImpl?: FetchLike,
    private readonly baseUrl?: string
  ) {}

  /**
   * A repo-scoped, permission-narrowed installation token with ≥15min of life.
   * `capabilities` widen the permission set (P2.5 write-back: issues / pull_requests
   * for `gh` write-back, actions for workflow inspection/execution) but every
   * capability is CLAMPED to the agent's
   * `access` level — a read-only workspace never receives a write scope of any
   * kind. Distinct capability sets are distinct cache entries.
   */
  async mint(
    installationId: bigint,
    repoFullName: string,
    access: GitAccess,
    capabilities: readonly GitCredCapability[] = DEFAULT_CAPABILITIES
  ): Promise<MintedGitCred> {
    // NOTE: #475's `extraRepoNames` (hook-watched repos riding the workspace
    // token, same installation, token-wide permissions) is superseded by
    // per-repo minting over AgentRepoAuthorization rows — each repo gets its
    // own tier-clamped token via mintLevels (agent-multi-repo-authorization.md).
    const levels: CapabilityLevels = {}
    for (const cap of capabilities) levels[cap] = access
    return this.mintLevels(installationId, repoFullName, levels)
  }

  /**
   * The per-capability form ({@link CapabilityLevels}) — additional-repo grants
   * mint asymmetric shapes (comment tier: contents:read + issues/PR:write).
   * The grant's `access` reports the CONTENTS level (that is what the git plane
   * consumes; absent contents ⇒ 'read'). Distinct level maps are distinct
   * cache entries; the uniform {@link mint} collapses onto the same keyspace.
   *
   * `repoId` (modern workspace and additional-repo paths): when present the
   * GitHub token is scoped by NUMERIC id (`repository_ids`), never by name — a
   * renamed repo whose old name is reused cannot mint for the replacement.
   * The cache key uses the id too; `repoFullName` is display metadata.
   * `forceRefresh` bypasses both cache and single-flight for a token GitHub
   * explicitly rejected; ownership checks prevent an older in-flight mint from
   * overwriting the replacement when it settles late.
   */
  async mintLevels(
    installationId: bigint,
    repoFullName: string,
    levels: CapabilityLevels,
    repoId?: bigint,
    forceRefresh = false
  ): Promise<MintedGitCred> {
    return this.mintPermissionLevels(installationId, repoFullName, levels, repoId, forceRefresh)
  }

  /** CP-only reporter token. `pull_requests:read` is required for the live
   * commit -> current PR association barrier before terminal Check writes.
   * Neither permission enters a daemon grant or the agent environment. */
  async mintChecks(installationId: bigint, repoFullName: string, repoId: bigint): Promise<MintedGitCred> {
    return this.mintPermissionLevels(installationId, repoFullName, { checks: 'write', pull_requests: 'read' }, repoId)
  }

  // CP-only READ token for the console's PR panel; read is the permission floor, so no tier clamp.
  async mintPullRequestRead(installationId: bigint, repoFullName: string, repoId: bigint): Promise<MintedGitCred> {
    return this.mintPermissionLevels(installationId, repoFullName, { checks: 'read', pull_requests: 'read' }, repoId)
  }

  /** Drop every cached/in-flight token for one installation after a permission,
   * suspension, revoke, or reinstall fact changes. In-flight requests cannot be
   * cancelled, so the generation check below prevents stale repopulation. */
  invalidateInstallation(installationId: bigint): void {
    const prefix = `${installationId}:`
    const epochKey = installationId.toString()
    this.installationEpoch.set(epochKey, this.epoch(installationId) + 1)
    for (const key of [...this.cache.keys()]) if (key.startsWith(prefix)) this.cache.delete(key)
    for (const key of [...this.inflight.keys()]) if (key.startsWith(prefix)) this.inflight.delete(key)
  }

  private async mintPermissionLevels(
    installationId: bigint,
    repoFullName: string,
    levels: InternalPermissionLevels,
    repoId?: bigint,
    forceRefresh = false
  ): Promise<MintedGitCred> {
    const serveEpoch = this.epoch(installationId)
    const effectiveLevels: InternalPermissionLevels =
      levels.contents === 'write' ? { ...levels, workflows: 'write' } : levels
    const caps = (Object.keys(effectiveLevels) as InternalPermission[]).sort()
    const access: GitAccess = effectiveLevels.contents ?? 'read'
    const scope = repoId !== undefined ? `#${repoId}` : repoFullName.toLowerCase()
    const key = `${installationId}:${scope}:${caps.map((c) => `${c}=${effectiveLevels[c]}`).join('+')}`
    const cached = forceRefresh ? undefined : this.cache.get(key)
    if (cached && cached.expiresAtMs - this.clock.now() > FRESH_MIN_MS) {
      return this.toGrant(cached, repoFullName, access, repoId)
    }
    let pending = forceRefresh ? undefined : this.inflight.get(key)
    if (!pending) {
      const epoch = this.epoch(installationId)
      const pendingFresh: Promise<CacheEntry> = this.mintFresh(
        installationId,
        repoFullName,
        effectiveLevels,
        repoId
      ).then(
        (entry) => {
          // A forced refresh supersedes any older in-flight mint. Only the
          // promise currently owning the key may populate the cache; otherwise
          // a late stale request could overwrite the freshly accepted token.
          if (this.inflight.get(key) === pendingFresh) {
            if (this.epoch(installationId) === epoch) this.cache.set(key, entry)
            this.inflight.delete(key)
          }
          return entry
        },
        (err: unknown) => {
          if (this.inflight.get(key) === pendingFresh) this.inflight.delete(key)
          throw err
        }
      )
      pending = pendingFresh
      this.inflight.set(key, pendingFresh)
    }
    const entry = await pending
    if (this.epoch(installationId) !== serveEpoch) throw new InstallationTokenInvalidatedError()
    return this.toGrant(entry, repoFullName, access, repoId)
  }

  /**
   * An UNSCOPED metadata-read token for listing an installation's repositories
   * (`GET /installation/repositories` needs an installation token; metadata is
   * implicit on every installation, and no repo narrowing is possible before we
   * know the repos). Cached under a reserved key.
   */
  async metadataToken(installationId: bigint): Promise<string> {
    const serveEpoch = this.epoch(installationId)
    const key = `${installationId}::metadata`
    const cached = this.cache.get(key)
    if (cached && cached.expiresAtMs - this.clock.now() > FRESH_MIN_MS) return cached.token
    let pending = this.inflight.get(key)
    if (!pending) {
      const epoch = this.epoch(installationId)
      pending = this.request(installationId, { permissions: { metadata: 'read' } }).then(
        (entry) => {
          if (this.epoch(installationId) === epoch) this.cache.set(key, entry)
          if (this.inflight.get(key) === pending) this.inflight.delete(key)
          return entry
        },
        (err: unknown) => {
          if (this.inflight.get(key) === pending) this.inflight.delete(key)
          throw err
        }
      )
      this.inflight.set(key, pending)
    }
    const entry = await pending
    if (this.epoch(installationId) !== serveEpoch) throw new InstallationTokenInvalidatedError()
    return entry.token
  }

  private async mintFresh(
    installationId: bigint,
    repoFullName: string,
    levels: InternalPermissionLevels,
    repoId?: bigint
  ): Promise<CacheEntry> {
    // Scope by numeric id whenever the workspace/grant has one; only a legacy
    // workspace without workspaceRepoId falls back to its repository name.
    // Repo ids are ≪ 2^53, so Number() is exact.
    const scope =
      repoId !== undefined ? { repository_ids: [Number(repoId)] } : { repositories: [repoFullName.split('/')[1]] }
    return this.request(installationId, {
      ...scope,
      permissions: {
        metadata: 'read',
        ...(levels.contents ? { contents: levels.contents } : {}),
        ...(levels.issues ? { issues: levels.issues } : {}),
        ...(levels.pull_requests ? { pull_requests: levels.pull_requests } : {}),
        ...(levels.actions ? { actions: levels.actions } : {}),
        ...(levels.checks ? { checks: levels.checks } : {}),
        ...(levels.workflows ? { workflows: levels.workflows } : {})
      }
    })
  }

  private epoch(installationId: bigint): number {
    return this.installationEpoch.get(installationId.toString()) ?? 0
  }

  private async request(installationId: bigint, body: unknown): Promise<CacheEntry> {
    const jwt = await mintAppJwt(this.cfg)
    const res = await githubRequest<GithubTokenResponse>(`/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      auth: jwt,
      body,
      fetchImpl: this.fetchImpl,
      baseUrl: this.baseUrl
    })
    return {
      token: res.token,
      expiresAtMs: Date.parse(res.expires_at) - SKEW_MS,
      expiresAtIso: res.expires_at
    }
  }

  private toGrant(entry: CacheEntry, repoFullName: string, access: GitAccess, repoId?: bigint): MintedGitCred {
    return {
      token: entry.token,
      ttlSec: Math.max(0, Math.floor((entry.expiresAtMs - this.clock.now()) / 1000)),
      expiresAt: entry.expiresAtIso,
      repoFullName,
      access,
      ...(repoId !== undefined ? { repoId } : {})
    }
  }
}
