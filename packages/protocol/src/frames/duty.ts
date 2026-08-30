// Duty lease wire (k8s daemons). The exchange rides the existing heartbeat
// cadence: the heartbeat's optional `duties` field carries the member's held
// digest and remaining headroom; the CP answers — only when there is something
// to say — with `duty/grant` and `duty/revoke` EVTs on the same connection, and
// a draining member returns groups explicitly with the `duty/release` REQ.
// Single-org daemons never send `duties`, which keeps the whole path dormant.
import { z } from 'zod'
import { AgentSpec } from './agent.js'
import { IntegrationSpec } from './integration.js'
import { CronUpsert } from './cron.js'
import { McpServerSpec } from './mcpserver.js'
import { MemoryConnectionSpec } from './memory-connection.js'

/** A per-group fencing term — bigint as a decimal string (JSON-safe). */
export const DutyTerm = z.string().regex(/^\d+$/)
export type DutyTerm = z.infer<typeof DutyTerm>

/** One member of a duty group: an agent to serve or a daemon-held bot to connect.
 *  `configRevision` is the freshness signal for AGENT members — the CP's current
 *  `AgentSpec.configRevision` — so a member that already has the agent can tell a
 *  current replica from a frozen one and refetch only the frozen ones. Optional:
 *  an older CP omits it and the member falls back to presence alone. */
export const DutyMemberRef = z.object({
  kind: z.enum(['agent', 'bot']),
  refId: z.string().uuid(),
  configRevision: z.string().regex(/^\d+$/).optional(),
  // Agent members only: the CP's placement kind — 'set' work can move to a successor and earns
  // the pool drain wait; readers treat absent (older CP, row gone) as 'set', the long class.
  placement: z.enum(['daemon', 'set']).optional()
})
export type DutyMemberRef = z.infer<typeof DutyMemberRef>

/** Hard cap on one grant entry's member list. A connected component past this is
 *  not deliverable over this wire at all — it is the dedicated-tier signal, and
 *  the CP refuses to grant it rather than emit a frame the daemon must reject. */
export const DUTY_GRANT_MEMBERS_MAX = 1000

/** The heartbeat's lease fields: what I hold (with the terms I believe), how many more groups I
 *  will accept, and whether I am draining. Capacity gating is member-side; `draining` is sticky
 *  CP-side for the connection — a member that said it once claims nothing (vacancy or rendezvous)
 *  until it registers afresh, so a rollout's retiring members can never take back a vacated group. */
export const HeartbeatDuties = z.object({
  held: z.array(z.object({ groupId: z.string().uuid(), term: DutyTerm })).max(1000),
  headroom: z.number().int().min(0),
  draining: z.boolean().optional()
})
export type HeartbeatDuties = z.infer<typeof HeartbeatDuties>

/** One granted (or re-confirmed) duty group. A groupId the daemon already holds
 *  REPLACES its entry — a bumped term after a composition change, or a term the
 *  daemon missed because the original grant EVT was lost. */
export const DutyGrantEntry = z.object({
  groupId: z.string().uuid(),
  orgId: z.string().min(1).max(64),
  term: DutyTerm,
  members: z.array(DutyMemberRef).max(DUTY_GRANT_MEMBERS_MAX)
})
export type DutyGrantEntry = z.infer<typeof DutyGrantEntry>

/** C→D EVT: duties granted to (or re-confirmed for) this member. */
export const DutyGrant = z.object({
  grants: z.array(DutyGrantEntry).min(1).max(100)
})
export type DutyGrant = z.infer<typeof DutyGrant>

/**
 * C→D EVT: the renewal the CP just performed for this member, emitted on every
 * duty-carrying heartbeat it actually processed. `leaseMs` is RELATIVE — "the
 * leases I hold for you live this much longer, measured from when I renewed
 * them" — so the daemon anchors its self-fence on RECEIPT and the two sides
 * never compare wall clocks. Receipt is strictly after the CP's renew, which is
 * what makes the daemon's deadline conservative and `T_reassign > T_fence`
 * sound. A beat the CP dropped produces no confirmation, so a member's fence
 * countdown keeps running — sending a beat is not renewing a lease.
 */
export const DutyRenewed = z.object({
  leaseMs: z.number().int().positive()
})
export type DutyRenewed = z.infer<typeof DutyRenewed>

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

/**
 * D→C REQ (reply: `duty/claim/ok`) — the activation rendezvous of the design's
 * §4.4. A member handed a trigger for an agent it does not serve claims that
 * agent's group on receipt: winning creates or takes the lease and it serves the
 * trigger; losing names the incumbent so the router can re-route. Idempotent for
 * the current holder, so a retry never churns a term.
 */
export const DutyClaim = z.object({
  agentId: z.string().uuid()
})
export type DutyClaim = z.infer<typeof DutyClaim>

/** C→D REP to `duty/claim`. `granted` ⇒ `grant` carries the lease exactly as a
 *  `duty/grant` entry would; otherwise `holder` names the live incumbent (absent
 *  when the CP cannot resolve one, e.g. an unknown agent). */
export const DutyClaimOk = z.object({
  granted: z.boolean(),
  grant: DutyGrantEntry.optional(),
  holder: z.string().uuid().optional()
})
export type DutyClaimOk = z.infer<typeof DutyClaimOk>

/**
 * D→C REQ (reply: `duty/fetch/ok`) — a grant opens the SERVING gate; it does not
 * install. A member that wins a duty for an agent it has never had pulls that
 * agent's definition here, so grants stay thin and a member asks only for what
 * it lacks. Holding the duty IS the authorization: the CP answers only for an
 * agent the asking daemon currently holds.
 */
export const DutyFetch = z.object({
  agentId: z.string().uuid()
})
export type DutyFetch = z.infer<typeof DutyFetch>

/**
 * One agent's complete installable definition — the trio `agent/activate` carries,
 * without the move token or the staging fence, plus the two definition kinds the
 * spec only NAMES: the proxied MCP servers its `mcpServers` list enables and its
 * external-memory connection. Those arrive separately on the placement-keyed
 * paths, so a duty holder that is not the placement would otherwise install an
 * agent referencing tools and a memory backend it has no definitions for.
 *
 * Both are token-bearing (relay proxy url + grant key, memory grant + secret
 * leases) — NEVER log this bundle. They are scoped to what THIS agent references,
 * so the reply widens nothing beyond the duty the asker already holds. Optional
 * for decode tolerance: an older CP omits them and the member installs the trio.
 */
export const DutyAgentBundle = z.object({
  agentId: z.string().uuid(),
  spec: AgentSpec,
  integrations: z.array(IntegrationSpec),
  crons: z.array(CronUpsert),
  mcpServers: z.array(McpServerSpec).default([]),
  memoryConnections: z.array(MemoryConnectionSpec).default([])
})
export type DutyAgentBundle = z.infer<typeof DutyAgentBundle>

/** C→D REP to `duty/fetch`. An absent `bundle` means the asker does not hold
 *  this agent's duty, or the agent is gone — never an error frame, because
 *  either way the correct member behavior is to install nothing. */
export const DutyFetchOk = z.object({
  bundle: DutyAgentBundle.optional()
})
export type DutyFetchOk = z.infer<typeof DutyFetchOk>
