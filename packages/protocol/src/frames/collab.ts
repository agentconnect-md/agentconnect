import { z } from 'zod'
import { Platform } from './route.js'

/**
 * Bot-AGNOSTIC agent-collaboration routing snapshot (agent-collaboration §2.3 / §6.2 / §6.5).
 *
 * The existing shared-bot `members` table is keyed by botId (`BotAssignment`) and
 * CANNOT address an agent on a DIFFERENT bot / arbitrary channel. This snapshot is
 * the fix: it maps a channel — `(orgId, platform, channelId)` — to the per-agent
 * placement + call policy the relay needs to route a cross-daemon `rd/agentmsg` and
 * the target daemon needs to terminal-verify a remote caller.
 *
 * It carries NO message body — pure routing/policy metadata, like the rest of the
 * control plane. The SAME shape is distributed two ways (§6.5):
 *  - CP→relay over the `rc/*` wire (`rc/collab-routes`) — the relay routes
 *    `toAgentId` → owning `daemonId` and authorizes the caller/target policy.
 *  - CP→daemon over the daemon↔CP wire — as a `register/ok` field (reconnect
 *    baseline) + a `collaboration/routes` EVT (hot push) — so the OWNING daemon of
 *    the target can terminal-verify (defense in depth, §2.5 #4) the remote caller's
 *    org/channel/placement against its OWN copy, never trusting the relay's claim
 *    blindly.
 *
 * FOLLOW-UP (scoped down in P2, see PR description): the full versioned lifecycle
 * of §6.5 — per-entry tombstones, TTL/expiry after a CP disconnect, and
 * fail-closed-on-stale — is NOT fully implemented here. `generation` is present as
 * the version hook and the snapshot is FULL-REPLACE (converge-don't-diff, same as
 * `register/ok`), which is enough to route + authorize on a live CP. TTL-expiry and
 * tombstone semantics are a follow-up within this phase.
 */

/** One agent's placement + call policy within a channel. `daemonId` is the owning
 *  daemon the relay forwards to; `integrationId` is the DEFINITE reply integration
 *  (§6.2 — no fallback to "first connection"). */
export const CollabAgentPlacement = z.object({
  agentId: z.string().uuid(),
  daemonId: z.string().uuid(),
  integrationId: z.string().uuid().optional(),
  /** Public Slack app id (`A…`) for this agent's bot. Receivers use it only to
   *  recognize AgentConnect-authored platform messages and keep agent-to-agent
   *  activation on the trusted `messageAgent` path. */
  botAppId: z.string().optional(),
  callPolicy: z.enum(['all', 'selected']).default('all'),
  allowedCallerAgentIds: z.array(z.string()).default([]),
  /** Caller-side authorization. Effective A→B access requires A's outbound
   * policy to admit B and B's inbound call policy to admit A. */
  outboundPolicy: z.enum(['all', 'selected']).default('all'),
  allowedTargetAgentIds: z.array(z.string()).default([]),
  // Directory name of the agent — carried so any daemon holding the snapshot can label a
  // REMOTE peer (caller or target) by name in a visible agent-call post, without a CP
  // round-trip or having listed the channel. `name` is the slug; `displayName` the
  // human-readable label. Optional for back-compat with an older CP that omits them.
  name: z.string().optional(),
  displayName: z.string().optional()
})
export type CollabAgentPlacement = z.infer<typeof CollabAgentPlacement>

/**
 * One agent's placement + call policy carried OUTSIDE any channel — the org-scoped
 * peer directory entry.
 *
 * Every structure on the CP→daemon and CP→relay wires is channel-keyed, so an agent
 * with NO IM integration (webchat, hook, dream, memory-only) never appears in any
 * `channels[]` entry at all. The channel-keyed snapshot structurally cannot express
 * "which agents exist in this org", which is precisely the input channel-free
 * authorization needs: discovery and A2A authorization depend only on the directional
 * call policy (`outboundPolicy`/`allowedTargetAgentIds` on the caller,
 * `callPolicy`/`allowedCallerAgentIds` on the target), org-scoped, with channel
 * demoted to an optional filter. Hence the flat list below.
 */
export const CollabOrgAgent = CollabAgentPlacement.extend({
  // Org ids are opaque strings (see CollabChannelRoute) — carried per entry because
  // the flat list is not nested under an org-keyed parent. Cross-org pairs never resolve.
  orgId: z.string().min(1)
})
export type CollabOrgAgent = z.infer<typeof CollabOrgAgent>

/** All agents present in one channel, across daemons. `orgId` scopes routing +
 *  authorization: a cross-org caller/target pair never resolves (§2.5 — cross-org
 *  rejected). */
export const CollabChannelRoute = z.object({
  // Org ids are opaque strings (Prisma uses cuid(); the seeded dev org uses
  // `org_default...`), unlike daemon/agent/integration ids which are UUIDs.
  orgId: z.string().min(1),
  platform: Platform,
  channelId: z.string().min(1),
  agents: z.array(CollabAgentPlacement)
})
export type CollabChannelRoute = z.infer<typeof CollabChannelRoute>

/**
 * The full collaboration snapshot — FULL-REPLACE (converge-don't-diff): the
 * recipient replaces its whole table with `channels`. `generation` monotonically
 * increases per source so a recipient can ignore a stale re-order (version hook for
 * the §6.5 lifecycle follow-up).
 */
export const CollabRoutesSnapshot = z.object({
  generation: z.number().int().nonnegative().default(0),
  channels: z.array(CollabChannelRoute).default([]),
  /**
   * FLAT org-scoped directory, alongside (not instead of) `channels`. It is the only
   * place an integration-less agent can appear — see `CollabOrgAgent` — and therefore
   * the authorization input for channel-free A2A. `default([])` keeps a snapshot from
   * an older CP (which advertises no `agent-directory-org-scope-v1`) decodable.
   */
  agents: z.array(CollabOrgAgent).default([])
})
export type CollabRoutesSnapshot = z.infer<typeof CollabRoutesSnapshot>
