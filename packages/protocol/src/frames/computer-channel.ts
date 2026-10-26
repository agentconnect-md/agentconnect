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

/** Who answers a Windows administrator (UAC) prompt while an agent controls the Computer (computer-use.md §4.2.1). */
export const COMPUTER_ADMIN_PROMPT_MODES = ['agent', 'people', 'approve', 'deny'] as const
export type ComputerAdminPromptMode = (typeof COMPUTER_ADMIN_PROMPT_MODES)[number]
/** The mode while a policy names none: the Computer's allowed members approve each prompt. */
export const DEFAULT_COMPUTER_ADMIN_PROMPT_MODE: ComputerAdminPromptMode = 'people'

/** Whether agents ask before using a Computer (computer-use.md §4.2): once per session, before its first input. */
export const ComputerApprovalsSchema = z.object({
  // Ask before a session's first click, drag, type, key or launch; an allow covers the rest of the session.
  firstInputPerSession: z.boolean().default(true),
  // Windows only; absent means the default, so policies stored before it keep their meaning.
  adminPrompts: z.enum(COMPUTER_ADMIN_PROMPT_MODES).optional()
})
export type ComputerApprovals = z.infer<typeof ComputerApprovalsSchema>

/** A grant's approvals: daemons before the single ask default the dropped asks on, so a CP turns them off explicitly. */
export const ComputerGrantApprovalsSchema = ComputerApprovalsSchema.extend({
  launchApp: z.enum(['always', 'session', 'never-ask']).optional(),
  submitLikeKeys: z.boolean().optional()
})
export type ComputerGrantApprovals = z.infer<typeof ComputerGrantApprovalsSchema>

/** What a grant sends daemons before the single ask, so they ask only before the first input too. */
export const LEGACY_COMPUTER_APPROVALS_OFF = { launchApp: 'never-ask', submitLikeKeys: false } as const

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
    approvals: ComputerGrantApprovalsSchema.optional(),
    // The console users who may answer its approvals: the Computer's allowed members; an older CP sends none.
    approvers: z.array(z.string().min(1).max(128)).max(500).optional()
  }),
  z.object({
    granted: z.literal(false),
    code: z.enum(COMPUTER_CHANNEL_REFUSALS),
    message: z.string().max(500)
  })
])
export type ComputerChannelGrantResult = z.infer<typeof ComputerChannelGrantResult>
