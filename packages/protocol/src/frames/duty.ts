// Duty lease wire (k8s daemons). The exchange rides the existing heartbeat
// cadence: the heartbeat's optional `duties` field carries the member's held
// digest and remaining headroom; the CP answers — only when there is something
// to say — with `duty/grant` and `duty/revoke` EVTs on the same connection, and
// a draining member returns groups explicitly with the `duty/release` REQ.
// Single-org daemons never send `duties`, which keeps the whole path dormant.
import { z } from 'zod'

/** A per-group fencing term — bigint as a decimal string (JSON-safe). */
export const DutyTerm = z.string().regex(/^\d+$/)
export type DutyTerm = z.infer<typeof DutyTerm>

/** One member of a duty group: an agent to serve or a daemon-held bot to connect. */
export const DutyMemberRef = z.object({
  kind: z.enum(['agent', 'bot']),
  refId: z.string().uuid()
})
export type DutyMemberRef = z.infer<typeof DutyMemberRef>

/** The heartbeat's lease fields: what I hold (with the terms I believe), and
 *  how many more groups I will accept. Capacity gating is member-side. */
export const HeartbeatDuties = z.object({
  held: z.array(z.object({ groupId: z.string().uuid(), term: DutyTerm })).max(1000),
  headroom: z.number().int().min(0)
})
export type HeartbeatDuties = z.infer<typeof HeartbeatDuties>

/** One granted (or re-confirmed) duty group. A groupId the daemon already holds
 *  REPLACES its entry — a bumped term after a composition change, or a term the
 *  daemon missed because the original grant EVT was lost. */
export const DutyGrantEntry = z.object({
  groupId: z.string().uuid(),
  orgId: z.string().min(1).max(64),
  term: DutyTerm,
  members: z.array(DutyMemberRef).max(1000)
})
export type DutyGrantEntry = z.infer<typeof DutyGrantEntry>

/** C→D EVT: duties granted to (or re-confirmed for) this member. */
export const DutyGrant = z.object({
  grants: z.array(DutyGrantEntry).min(1).max(100)
})
export type DutyGrant = z.infer<typeof DutyGrant>

/** Why a held group is being taken away: `superseded` = another member holds it
 *  now (term reassigned), `gone` = the group no longer exists (edges removed). */
export const DutyRevokeReason = z.enum(['superseded', 'gone'])
export type DutyRevokeReason = z.infer<typeof DutyRevokeReason>

/** C→D EVT: stop serving these groups and tear down their platform connections. */
export const DutyRevoke = z.object({
  revocations: z
    .array(z.object({ groupId: z.string().uuid(), reason: DutyRevokeReason }))
    .min(1)
    .max(1000)
})
export type DutyRevoke = z.infer<typeof DutyRevoke>

/** D→C REQ (reply: generic `ack`): a draining member returns groups explicitly,
 *  vacating them immediately instead of waiting out T_reassign. */
export const DutyRelease = z.object({
  groupIds: z.array(z.string().uuid()).min(1).max(1000)
})
export type DutyRelease = z.infer<typeof DutyRelease>
