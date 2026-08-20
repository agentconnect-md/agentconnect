import type { AnyFrame, DutyGrant, DutyRenewed, DutyRevoke } from '@agentconnect.md/protocol'
import type { ConfigApplyDeps } from './config.js'
import type { ControlHandler } from './context.js'

/** The lease-deadline half of the duty exchange stays with the client's heartbeat/fence timers —
 *  these are the three edges a duty control frame moves. */
export interface DutyControlDeps extends ConfigApplyDeps {
  /** A grant or a won claim CREATES (or re-terms) exactly one lease per group. */
  noteLeasesGranted(groupIds: string[]): void
  /** A released or revoked group is no longer ours to fence. */
  forgetLeaseDeadlines(groupIds: string[]): void
  /** `duty/renewed`: adopt the confirmed horizon and restart every held group's countdown. */
  onDutyRenewed(leaseMs: number): void
}

export const dutyGrant: ControlHandler<DutyControlDeps> = (frame: AnyFrame, deps) => {
  const { grants } = frame.payload as DutyGrant
  // BEFORE admission, which is async: the CP's lease on these groups is already running, and a grant whose
  // renewal confirmation never arrives must still fence — the receipt of the grant is what arms it.
  deps.noteLeasesGranted(grants.map((entry) => entry.groupId))
  deps.configApply.applyDutyGrant(grants)
  return // EVT — no reply
}

export const dutyRenewed: ControlHandler<DutyControlDeps> = (frame: AnyFrame, deps) => {
  deps.onDutyRenewed((frame.payload as DutyRenewed).leaseMs)
  return // EVT — no reply
}

export const dutyRevoke: ControlHandler<DutyControlDeps> = (frame: AnyFrame, deps) => {
  const { revocations } = frame.payload as DutyRevoke
  deps.configApply.applyDutyRevoke(revocations)
  // Not ours any more: a revoked group must not keep a deadline that could fence it a second time, nor
  // hold the timer earlier than any group still held.
  deps.forgetLeaseDeadlines(revocations.map((revocation) => revocation.groupId))
  return // EVT — no reply
}
