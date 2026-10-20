import { z } from 'zod'
import { COMPUTER_AGENT_MODES } from '../computer-channel-token.js'

// The Computer data plane (computer-use.md §3.7): how an agent daemon reaches a desktop daemon's `/mcp` for one session.

/** A relay a desktop daemon dials out to; `url` is the relay's per-instance daemon-facing address. */
export const ComputerRelayEntry = z.object({
  relayId: z.string().uuid(),
  url: z.string().min(1).max(2048)
})
export type ComputerRelayEntry = z.infer<typeof ComputerRelayEntry>

/** The most relays one grant or roster names. */
export const COMPUTER_RELAYS_MAX = 64

/** Which risky actions need a person's approval (computer-use.md §4.2); every field defaults to asking. */
export const ComputerApprovalsSchema = z.object({
  // Ask before a session's first click, drag, type, key or launch; any allow covers the rest of the session.
  firstInputPerSession: z.boolean().default(true),
  // `always` asks per launch until an approver answers "Allow for this session"; `session` asks once.
  launchApp: z.enum(['always', 'session', 'never-ask']).default('always'),
  // Ask before each Enter until an approver answers "Allow for this session".
  submitLikeKeys: z.boolean().default(true)
})
export type ComputerApprovals = z.infer<typeof ComputerApprovalsSchema>

/** Definite refusals: no token was issued. */
export const COMPUTER_CHANNEL_REFUSALS = ['denied', 'unavailable'] as const
export type ComputerChannelRefusal = (typeof COMPUTER_CHANNEL_REFUSALS)[number]

// D→C REQ on the daemon wire, behind `computer-channel-v1`: a channel token for one agent session's calls to a Computer.
export const ComputerChannelGrantRequest = z.object({
  computerId: z.string().uuid(),
  agentId: z.string().uuid(),
  sessionId: z.string().min(1).max(256)
})
export type ComputerChannelGrantRequest = z.infer<typeof ComputerChannelGrantRequest>

// C→D REP: the token is a bearer credential for the desktop's `/mcp`, never logged; the relays are where to send it.
export const ComputerChannelGrantResult = z.discriminatedUnion('granted', [
  z.object({
    granted: z.literal(true),
    token: z.string().min(1).max(2048),
    expiresAt: z.string().datetime(),
    mode: z.enum(COMPUTER_AGENT_MODES),
    relays: z.array(ComputerRelayEntry).max(COMPUTER_RELAYS_MAX),
    // What the approval cards name and whom they also reach (§4.2); an older CP sends none, and every approval is asked.
    name: z.string().min(1).max(200).optional(),
    ownerUserId: z.string().min(1).max(128).optional(),
    approvals: ComputerApprovalsSchema.optional()
  }),
  z.object({
    granted: z.literal(false),
    code: z.enum(COMPUTER_CHANNEL_REFUSALS),
    message: z.string().max(500)
  })
])
export type ComputerChannelGrantResult = z.infer<typeof ComputerChannelGrantResult>
