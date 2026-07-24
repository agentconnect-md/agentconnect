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
 * The REQ is bound to the requesting daemon's authenticated org AND to the
 * session-derived `requesterAgentId` (never a tool input — §2.2/§6.1): the CP
 * verifies the requester actually belongs to the target (platform, channel)
 * before returning the roster, and filters it by call policy so non-callable /
 * private peers are not leaked. This stops one agent from probing arbitrary
 * (including private) channels of its own org.
 */

/** One agent visible in a channel — the collaboration directory entry. */
export const ChannelAgent = z.object({
  agentId: z.string().uuid(),
  name: z.string(), // slug
  displayName: z.string().optional(), // human-readable name, if set
  description: z.string().optional(), // what the agent does (its system-prompt seed)
  status: z.enum(['active', 'inactive', 'paused'])
})
export type ChannelAgent = z.infer<typeof ChannelAgent>

/** D→C REQ: list the agents in a channel (for the asking agent's collaboration tool). */
export const ChannelAgentsReq = z.object({
  platform: Platform,
  channel: z.string(), // platform channel id
  /** The agent asking, derived by the daemon from the MCP session context — NEVER
   *  a tool input (§6.1). The CP uses it to verify the requester belongs to the
   *  target channel and to apply per-peer call-policy visibility filtering. */
  requesterAgentId: z.string().uuid()
})
export type ChannelAgentsReq = z.infer<typeof ChannelAgentsReq>

/** C→D REP (corr = req id): every agent in the channel across all daemons. */
export const ChannelAgentsOk = z.object({
  platform: Platform,
  channel: z.string(),
  agents: z.array(ChannelAgent)
})
export type ChannelAgentsOk = z.infer<typeof ChannelAgentsOk>
