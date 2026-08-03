import { z } from 'zod'
import { Platform } from './route.js'

/**
 * Channel agent directory (D→C REQ → REP) — agent collaboration lookup.
 *
 * An agent asks (via a daemon-side tool) "who else is in this channel?". The
 * daemon forwards it to the CP — the ONLY authority for the FULL channel roster,
 * because agents in one channel may run on different daemons (each daemon knows
 * only its own agents). The CP joins the channel's integrations to their agents
 * and returns their public metadata (name / displayName / description / status).
 * Metadata only — never message content (§1/§12).
 *
 * Direction is daemon→CP (like `auth` / `register`): the daemon sends the REQ and
 * the CP replies with `channel/agents/ok` (corr = the req id).
 *
 * `channel` is OPTIONAL, and that is the whole scope switch:
 *  - ABSENT → the ORG-WIDE peer directory. Channel membership plays no part; a
 *    session with no IM integration at all (webchat, hook, dream) can still
 *    discover peers.
 *  - PRESENT → the same directory, ADDITIONALLY narrowed to agents present in that
 *    channel. A filter, never a gate.
 * Only a CP advertising `agent-directory-org-scope-v1` understands the channel-less
 * form; against an older CP the daemon substitutes the caller's current channel
 * (today's behavior) rather than sending a payload that CP would reject.
 *
 * The REQ is bound to the requesting daemon's authenticated org AND to the
 * session-derived `requesterAgentId` (never a tool input — §2.2/§6.1). The roster is
 * POLICY-filtered, not membership-gated: an entry survives iff the caller's outbound
 * policy admits it and its own inbound `callPolicy` admits the caller, within the one
 * org (the caller always sees itself). Discovery IS the authorization surface — a peer
 * that fails the predicate is omitted entirely, never listed-but-uncallable — so an
 * agent still cannot probe peers it may not call, and cross-org never resolves.
 */

/** One agent visible in a channel — the collaboration directory entry. */
export const ChannelAgent = z.object({
  agentId: z.string().uuid(),
  name: z.string(), // slug
  displayName: z.string().optional(), // human-readable name, if set
  description: z.string().optional(), // what the agent does (its system-prompt seed)
  status: z.enum(['active', 'inactive', 'paused']),
  /**
   * The exact platform-native address for this agent in the LISTED conversation —
   * `<@U_REVIEWER>` for a dedicated bot, `<@U_SHARED> reviewer` for a shared one
   * (send-message-routing-rework.md §8.5).
   *
   * Present only on a CHANNEL-FILTERED listing: an org-wide listing has no single
   * conversation-specific address, and offering a wrong token would silently address
   * nobody. It gives the model an exact string to put in its ordinary reply (§2.1)
   * instead of guessing from a display name, without exposing any credential.
   *
   * The DAEMON fills this from its local conversation directory; it is not a CP field.
   */
  mention: z.string().optional()
})
export type ChannelAgent = z.infer<typeof ChannelAgent>

/** D→C REQ: list the caller's callable peers (for the asking agent's collaboration tool). */
export const ChannelAgentsReq = z.object({
  platform: Platform,
  /** Platform channel id. Omit for the org-wide directory; present = channel filter. */
  channel: z.string().optional(),
  /** The agent asking, derived by the daemon from the MCP session context — NEVER
   *  a tool input (§6.1). The CP resolves it in the org directory and applies the
   *  bidirectional call-policy filter; an unknown requester fails CLOSED. */
  requesterAgentId: z.string().uuid()
})
export type ChannelAgentsReq = z.infer<typeof ChannelAgentsReq>

/** C→D REP (corr = req id): the policy-filtered roster across all daemons. `channel`
 *  echoes the REQ's scope — absent when the listing was org-wide. */
export const ChannelAgentsOk = z.object({
  platform: Platform,
  channel: z.string().optional(),
  agents: z.array(ChannelAgent)
})
export type ChannelAgentsOk = z.infer<typeof ChannelAgentsOk>
