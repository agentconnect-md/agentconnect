// DutyLeaseService — the CP half of the duty lease exchange (k8s daemons).
// Renewal IS the heartbeat: one batched expiry refresh per frame, then a digest
// diff answered with duty/grant (missed or re-issued terms) and duty/revoke
// (superseded or vanished groups), and vacancy grants up to the member's
// declared headroom. Terms only ever move through the repo's grant paths.
import type { HeartbeatDuties, DutyGrantEntry, DutyRevoke } from '@agentconnect.md/protocol'
import type { DutyGroupRepo, DutyGroupRecord, DutyGrantRecord } from '../persistence/ports.js'
import type { DaemonId } from '../domain/ids.js'
import type { Clock } from '../domain/clock.js'

export interface DutyLeaseConfig {
  /** Renewal horizon written on every renew/grant — the T_reassign vacancy bound. */
  leaseMs: number
  /** Startup recovery grace: no vacancy grants until boot + this, so a CP
   *  restart cannot misread quiet members as dead. Renewals are unaffected. */
  recoveryGraceMs: number
  /** Cap on fresh vacancy grants per heartbeat, under the member's headroom. */
  grantMaxPerTick: number
}

export const DUTY_LEASE_DEFAULTS: DutyLeaseConfig = {
  leaseMs: 120_000,
  recoveryGraceMs: 120_000,
  grantMaxPerTick: 32
}

type Send = (type: 'duty/grant' | 'duty/revoke', payload: unknown) => void

function toGrantEntry(g: Pick<DutyGrantRecord, 'groupId' | 'orgId' | 'term' | 'members'>): DutyGrantEntry {
  return { groupId: g.groupId, orgId: g.orgId, term: String(g.term), members: g.members }
}

export class DutyLeaseService {
  private readonly bootedAtMs: number

  constructor(
    private readonly repo: DutyGroupRepo,
    private readonly clock: Clock,
    private readonly config: DutyLeaseConfig = DUTY_LEASE_DEFAULTS
  ) {
    this.bootedAtMs = clock.now()
  }

  /** The full per-heartbeat exchange. `send` emits on the reporting connection. */
  async onHeartbeat(daemonId: DaemonId, duties: HeartbeatDuties, send: Send): Promise<void> {
    const now = new Date(this.clock.now())
    await this.repo.renewHeld(daemonId, now, this.config.leaseMs)
    const held = await this.repo.listHeldBy(daemonId)
    const heldById = new Map(held.map((g) => [g.groupId, g]))
    const digestIds = new Set(duties.held.map((d) => d.groupId))

    // Digest entries the ledger no longer grants this member: superseded when the
    // group lives under someone else, gone when its edges were removed entirely.
    const lost = duties.held.filter((d) => !heldById.has(d.groupId))
    const revocations: DutyRevoke['revocations'] = []
    if (lost.length > 0) {
      const existing = new Set((await this.repo.getByIds(lost.map((d) => d.groupId))).map((g) => g.groupId))
      for (const d of lost)
        revocations.push({ groupId: d.groupId, reason: existing.has(d.groupId) ? 'superseded' : 'gone' })
    }

    // Re-issue any held group whose term the member has stale (a lost grant EVT
    // after a composition re-grant) or does not know it holds at all — the
    // reconnect crossing point: confirm the terms or supersede, never both.
    const regrants: DutyGroupRecord[] = held.filter((g) => {
      const claimed = duties.held.find((d) => d.groupId === g.groupId)
      return claimed === undefined || claimed.term !== String(g.term) || !digestIds.has(g.groupId)
    })

    let granted: DutyGrantRecord[] = []
    if (duties.headroom > 0 && this.clock.now() >= this.bootedAtMs + this.config.recoveryGraceMs) {
      const max = Math.min(duties.headroom, this.config.grantMaxPerTick)
      granted = await this.repo.claimVacant(daemonId, max, now, this.config.leaseMs)
    }

    const grants = [...regrants.map(toGrantEntry), ...granted.map(toGrantEntry)]
    if (grants.length > 0) send('duty/grant', { grants })
    if (revocations.length > 0) send('duty/revoke', { revocations })
  }

  /** Explicit drain release — vacate now instead of waiting out T_reassign. */
  async release(daemonId: DaemonId, groupIds: string[]): Promise<void> {
    await this.repo.release(daemonId, groupIds)
  }
}
