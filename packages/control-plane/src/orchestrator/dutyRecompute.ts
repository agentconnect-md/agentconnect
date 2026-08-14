// DutyRecomputeSweep — keeps the duty ledger's membership projection derived
// from reality: every tick it walks a slice of orgs (keyset rotation), recomputes
// connected components from Integration/CronDef rows, and applies the plan.
// The sweep only WRITES THE LEDGER — grants, re-grants after a merge, and
// supersessions all reach daemons through the next heartbeat's lease exchange,
// so no delivery mechanism exists here to duplicate or race it.
import { computeDutyComponents, planDutyReconcile, toExistingDutyGroups } from './dutyGroup.js'
import type { DutyGroupRepo } from '../persistence/ports.js'
import { OrgId } from '../domain/ids.js'
import type { Clock, TimerHandle } from '../domain/clock.js'

export interface DutyRecomputeConfig {
  /** How often a slice of orgs is recomputed. */
  intervalMs: number
  /** Orgs handled per tick — the rotation wraps when a slice comes back short. */
  orgsPerTick: number
  /** Renewal horizon for re-grants applied inside the reconcile. */
  leaseMs: number
  /** Mirrors the lease exchange's grant policy: under `incumbent`, a placement
   *  move must also move the duty, so each tick vacates leases whose holder no
   *  longer hosts any of the group's agents. Flip together with the policy. */
  incumbentFence: boolean
  /** Coalescing window for {@link DutyRecomputeSweep.kick}: a burst of writes to
   *  one org (an install touching several rows) costs one recompute. */
  kickDelayMs: number
}

export interface DutyRecomputeLog {
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

export class DutyRecomputeSweep {
  private timer: TimerHandle | undefined
  private stopped = false
  private cursor: string | null = null
  private readonly kicked = new Set<string>()
  private kickTimer: TimerHandle | undefined

  constructor(
    private readonly repo: Pick<
      DutyGroupRepo,
      'listDutyOrgs' | 'computeInputs' | 'applyReconcile' | 'vacateNonIncumbent'
    >,
    private readonly clock: Clock,
    private readonly cfg: DutyRecomputeConfig,
    private readonly log?: DutyRecomputeLog
  ) {}

  start(): void {
    this.stopped = false
    this.arm()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.kickTimer !== undefined) {
      this.clock.clearTimeout(this.kickTimer)
      this.kickTimer = undefined
    }
    this.kicked.clear()
  }

  /**
   * Recompute one org promptly instead of waiting for its rotation slice — the
   * ledger's inputs just changed (an integration, a cron's enabled flag, a bot
   * credential, a placement move). Fire-and-forget and coalescing: callers on
   * the request path never await it, and a burst against one org collapses into
   * a single recompute. The rotation remains the backstop, so a dropped kick
   * costs latency, never correctness.
   */
  kick(orgId: string): void {
    if (this.stopped) return
    this.kicked.add(orgId)
    if (this.kickTimer !== undefined) return
    this.kickTimer = this.clock.setTimeout(() => {
      this.kickTimer = undefined
      const orgs = [...this.kicked]
      this.kicked.clear()
      for (const org of orgs) {
        void this.recomputeOrg(org).catch((err) => this.log?.error({ err, orgId: org }, 'duty recompute kick failed'))
      }
    }, this.cfg.kickDelayMs)
  }

  private arm(): void {
    this.timer = this.clock.setTimeout(() => {
      void this.tick()
        .catch((err) => this.log?.error({ err }, 'duty recompute sweep failed'))
        .finally(() => {
          if (!this.stopped) this.arm()
        })
    }, this.cfg.intervalMs)
  }

  /** One rotation slice; exported for tests. Returns the number of orgs handled. */
  async tick(): Promise<number> {
    const orgs = await this.repo.listDutyOrgs(this.cursor, this.cfg.orgsPerTick)
    this.cursor = orgs.length < this.cfg.orgsPerTick ? null : (orgs[orgs.length - 1] ?? null)
    for (const orgId of orgs) {
      try {
        await this.recomputeOrg(orgId)
      } catch (err) {
        // One org's failure must not starve the rest of the rotation.
        this.log?.error({ err, orgId }, 'duty recompute failed for org')
      }
    }
    return orgs.length
  }

  async recomputeOrg(orgId: string): Promise<void> {
    const { edges, seeds } = await this.repo.computeInputs(OrgId(orgId))
    const components = computeDutyComponents(edges, seeds)
    const now = new Date(this.clock.now())
    await this.repo.applyReconcile(
      OrgId(orgId),
      (existing) => planDutyReconcile(toExistingDutyGroups(existing, now), components),
      { now, leaseMs: this.cfg.leaseMs }
    )
    if (this.cfg.incumbentFence) {
      const vacated = await this.repo.vacateNonIncumbent(OrgId(orgId))
      if (vacated.length > 0)
        this.log?.warn({ orgId, groupIds: vacated }, 'duty leases vacated after a placement move-away')
    }
  }
}
