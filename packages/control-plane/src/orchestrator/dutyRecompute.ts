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
}

export interface DutyRecomputeLog {
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

export class DutyRecomputeSweep {
  private timer: TimerHandle | undefined
  private stopped = false
  private cursor: string | null = null

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
