// Scheduled repository attestation shared by code hosts with a human authorization gate.
import type { CodeHostProvider } from '@agentconnect.md/protocol'
import type { Clock, TimerHandle } from '../domain/clock.js'
import type { AgentId, OrgId } from '../domain/ids.js'
import type {
  AgentRepoAuthorizationRecord,
  AgentRepoAuthorizationRepo,
  AuditRepo,
  RepoGrantStaleReason
} from '../persistence/ports.js'

export interface RepositoryGrantReattestorConfig {
  /** How often a sweep runs. */
  intervalMs: number
  /** A grant whose last re-attestation is older than this is due. */
  reattestAfterMs: number
  /** Grants re-attested per sweep at most. */
  batch: number
}

export interface RepositoryGrantReattestorDeps {
  provider: CodeHostProvider
  grants: Pick<AgentRepoAuthorizationRepo, 'claimDueForReattestation' | 'recordAttestation'>
  attest(grant: ClaimedGrant): Promise<ReattestationVerdict>
  staleReasonText: Record<RepoGrantStaleReason, string>
  audit: Pick<AuditRepo, 'append'>
  reproject(orgId: OrgId, agentId: AgentId): Promise<void>
  clock: Clock
  log?: {
    info(obj: unknown, msg?: string): void
    warn(obj: unknown, msg?: string): void
    error(obj: unknown, msg?: string): void
  }
}

export type ClaimedGrant = AgentRepoAuthorizationRecord & { orgId: OrgId }

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
        this.deps.provider,
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

  attest(grant: ClaimedGrant): Promise<ReattestationVerdict> {
    return this.deps.attest(grant)
  }

  private audit(grant: ClaimedGrant, reason: RepoGrantStaleReason | null): void {
    void this.deps.audit
      .append({
        kind: 'agent_repo_change',
        orgId: grant.orgId,
        agentId: grant.agentId,
        frameType: 'gitcred/grant',
        message: reason
          ? `repo ${grant.repoFullName} authorization suspended: ${this.deps.staleReasonText[reason]}`
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
