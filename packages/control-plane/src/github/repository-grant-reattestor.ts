// Re-runs decision 8's creation check against each grant's attester on a schedule (agent-multi-repo-authorization.md, Re-attestation).
import type { Clock, TimerHandle } from '../domain/clock.js'
import type { AgentId, OrgId } from '../domain/ids.js'
import type {
  AgentRepoAuthorizationRecord,
  AgentRepoAuthorizationRepo,
  AuditRepo,
  GithubInstallationRepo,
  RepoGrantStaleReason
} from '../persistence/ports.js'
import { UserAuthzDeniedError, type GithubUserAuthzService, type RepoPermission } from './user-authz.js'
import type { GithubService } from './service.js'

export interface RepositoryGrantReattestorConfig {
  /** How often a sweep runs. */
  intervalMs: number
  /** A grant whose last re-attestation is older than this is due. */
  reattestAfterMs: number
  /** Grants re-attested per sweep at most. */
  batch: number
}

export interface RepositoryGrantReattestorDeps {
  grants: Pick<AgentRepoAuthorizationRepo, 'claimDueForReattestation' | 'recordAttestation'>
  installations: Pick<GithubInstallationRepo, 'liveByOrgAndAccount'>
  github: Pick<GithubService, 'repoRefForCommentAuthz'>
  /** The creation gate's check, over {@link strictRepoAccessLookups} so a credential failure throws. */
  authz: Pick<GithubUserAuthzService, 'assertAccess'>
  audit: Pick<AuditRepo, 'append'>
  /** Re-push the agent's spec after a grant left or rejoined it; best-effort. */
  reproject(orgId: OrgId, agentId: AgentId): Promise<void>
  clock: Clock
  log?: {
    info(obj: unknown, msg?: string): void
    warn(obj: unknown, msg?: string): void
    error(obj: unknown, msg?: string): void
  }
}

type ClaimedGrant = AgentRepoAuthorizationRecord & { orgId: OrgId }

/** One grant's verdict: held, stale for a reason, or not this loop's to judge. */
export type ReattestationVerdict =
  { kind: 'held' } | { kind: 'stale'; reason: RepoGrantStaleReason } | { kind: 'skipped'; why: string }

export interface ReattestationSweep {
  checked: number
  held: number
  stale: number
  skipped: number
  flipped: number
  /** True when an upstream failure stopped the sweep early. */
  deferred: boolean
}

/** How a refusal names why a stale grant is not honored. */
export const STALE_REASON_TEXT: Record<RepoGrantStaleReason, string> = {
  access_lost: 'the member who authorized it no longer has that access on GitHub',
  identity_unlinked: 'the member who authorized it no longer has a linked GitHub identity',
  attester_removed: 'the member who authorized it no longer has an account'
}

/** The access check's lookups with the strict error policy: only a missing subject reads as no access. */
export function strictRepoAccessLookups(
  github: Pick<GithubService, 'repoRefForCommentAuthz' | 'userRepoPermissionForCommentAuthz'>
): ConstructorParameters<typeof GithubUserAuthzService>[0]['github'] {
  return {
    getRepoMeta: async (ins, owner, repo) => {
      const ref = await github.repoRefForCommentAuthz(ins, owner, repo)
      return ref ? { private: ref.private } : null
    },
    userRepoPermission: async (ins, owner, repo, login): Promise<RepoPermission> => {
      const role = await github.userRepoPermissionForCommentAuthz(ins, owner, repo, login)
      return role === 'triage' ? 'read' : role
    }
  }
}

export class RepositoryGrantReattestor {
  private timer: TimerHandle | undefined
  private stopped = false

  constructor(
    private readonly deps: RepositoryGrantReattestorDeps,
    private readonly cfg: RepositoryGrantReattestorConfig
  ) {}

  /** Arm the periodic sweep. Idempotent — a second call re-arms from now. */
  start(): void {
    this.stopped = false
    this.arm()
  }

  /** Cancel the loop — call on shutdown so no timer outlives the process. */
  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) {
      this.deps.clock.clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private arm(): void {
    if (this.stopped) return
    if (this.timer !== undefined) this.deps.clock.clearTimeout(this.timer)
    this.timer = this.deps.clock.setTimeout(() => void this.tick(), this.cfg.intervalMs)
  }

  /** One sweep, then re-arm; a failure is logged and never kills the loop. Exposed for tests. */
  async tick(): Promise<void> {
    this.timer = undefined
    try {
      const sweep = await this.sweep()
      if (sweep.flipped > 0 || sweep.deferred) this.deps.log?.info(sweep, 'repository-grant-reattestor: sweep')
    } catch (err) {
      this.deps.log?.error({ err }, 'repository-grant-reattestor: sweep failed')
    } finally {
      this.arm()
    }
  }

  /** Re-attest up to `batch` due grants, oldest check first. */
  async sweep(): Promise<ReattestationSweep> {
    const sweep: ReattestationSweep = { checked: 0, held: 0, stale: 0, skipped: 0, flipped: 0, deferred: false }
    const checkedBefore = new Date(this.deps.clock.now() - this.cfg.reattestAfterMs)
    while (sweep.checked < this.cfg.batch && !this.stopped) {
      const grant = await this.deps.grants.claimDueForReattestation(
        'github',
        checkedBefore,
        new Date(this.deps.clock.now())
      )
      if (!grant) break
      sweep.checked++
      let verdict: ReattestationVerdict
      try {
        verdict = await this.attest(grant)
      } catch (err) {
        // The claim already rotated this grant to the back, so a failure specific to it cannot pin the queue.
        this.deps.log?.warn(
          { err, repoAuthId: grant.id },
          'repository-grant-reattestor: upstream unavailable, sweep deferred'
        )
        sweep.deferred = true
        break
      }
      if (verdict.kind === 'skipped') {
        sweep.skipped++
        continue
      }
      const reason = verdict.kind === 'stale' ? verdict.reason : null
      if (reason) sweep.stale++
      else sweep.held++
      const flipped = await this.deps.grants.recordAttestation(
        grant.id,
        { attestedByUserId: grant.attestedByUserId, access: grant.access },
        reason,
        new Date(this.deps.clock.now())
      )
      if (!flipped) continue
      sweep.flipped++
      this.audit(grant, reason)
      await this.deps.reproject(grant.orgId, grant.agentId).catch((err: unknown) => {
        this.deps.log?.warn({ err, agentId: grant.agentId }, 'repository-grant-reattestor: spec push failed')
      })
    }
    return sweep
  }

  /** The creation gate's check against the grant's attester; throws on an upstream failure. */
  async attest(grant: ClaimedGrant): Promise<ReattestationVerdict> {
    if (grant.attestedByUserId === null) return { kind: 'stale', reason: 'attester_removed' }
    const [owner, repo] = grant.repoFullName.split('/')
    if (!owner || !repo) return { kind: 'skipped', why: 'not an owner/repo name' }
    const installation = await this.deps.installations.liveByOrgAndAccount(grant.orgId, owner)
    if (!installation || installation.suspendedAt) return { kind: 'skipped', why: 'no live installation' }
    // The numeric id is the grant's identity: a reused name is another repository, which the mint gate denies anyway.
    const ref = await this.deps.github.repoRefForCommentAuthz(installation, owner, repo)
    if (!ref || ref.repoId !== grant.repoId) return { kind: 'skipped', why: 'repository no longer resolves' }
    const [refOwner, refRepo] = ref.fullName.split('/')
    try {
      await this.deps.authz.assertAccess(
        grant.attestedByUserId,
        installation,
        refOwner ?? owner,
        refRepo ?? repo,
        grant.access === 'write' ? 'write' : 'read'
      )
      return { kind: 'held' }
    } catch (err) {
      if (!(err instanceof UserAuthzDeniedError)) throw err
      return { kind: 'stale', reason: err.code === 'USER_NO_ACCESS' ? 'access_lost' : 'identity_unlinked' }
    }
  }

  private audit(grant: ClaimedGrant, reason: RepoGrantStaleReason | null): void {
    void this.deps.audit
      .append({
        kind: 'agent_repo_change',
        orgId: grant.orgId,
        agentId: grant.agentId,
        frameType: 'gitcred/grant',
        message: reason
          ? `repo ${grant.repoFullName} authorization suspended: ${STALE_REASON_TEXT[reason]}`
          : `repo ${grant.repoFullName} authorization restored: its authorizer's access was re-attested`,
        details: {
          repoAuthId: grant.id,
          provider: grant.provider,
          repoFullName: grant.repoFullName,
          access: grant.access,
          attestedByUserId: grant.attestedByUserId,
          staleReason: reason
        }
      })
      .catch(() => {})
  }
}
