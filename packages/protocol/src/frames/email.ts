import { z } from 'zod'
import { EMAIL_ADDRESS_PATTERN, EMAIL_RECIPIENTS_MAX } from './relay-daemon.js'

/** The most addresses one ask names: a mail's sender and its recipients (email-integration.md §6.1). */
export const EMAIL_MEMBERS_MAX = EMAIL_RECIPIENTS_MAX + 1

const EmailMemberAddress = z.string().max(320).regex(EMAIL_ADDRESS_PATTERN)

/** How a started thread's session names its owner in `triggeredBy` (email-integration.md §5.3): `user:<console user id>`, which no address can be. */
export const EMAIL_STARTED_OWNER_PREFIX = 'user:'

/** Who may write to an address (email-integration.md §4.1): members who may use the agent, or any authenticated sender. */
export const EmailWhoMayWrite = z.enum(['members', 'anyone'])
export type EmailWhoMayWrite = z.infer<typeof EmailWhoMayWrite>

// The Email payload (email-integration.md §2): the agent's own address; the sending credential stays on the relay, so every send goes through it.
export const IntegrationEmailConfig = z.object({
  address: EmailMemberAddress,
  egress: z.literal('relay'),
  botId: z.string().uuid(), // the bot row the relay authorizes a send against
  // Absent reads as `members`, so a Control Plane that predates the setting never opens an address.
  whoMayWrite: EmailWhoMayWrite.optional()
})
export type IntegrationEmailConfig = z.infer<typeof IntegrationEmailConfig>

// `agent/email-members` (D→C REQ): which of these canonical addresses are members who may write to the agent by mail (email-integration.md §4 step 3).
export const AgentEmailMembers = z.object({
  agentId: z.string().uuid(),
  addresses: z.array(EmailMemberAddress).min(1).max(EMAIL_MEMBERS_MAX)
})
export type AgentEmailMembers = z.infer<typeof AgentEmailMembers>

/** One admitted address and the console user it is the verified sign-in email of, which keys that person's memory layer. */
export const EmailMember = z.object({
  address: EmailMemberAddress,
  consoleUserId: z.string().min(1).max(256)
})
export type EmailMember = z.infer<typeof EmailMember>

// `agent/email-members/ok` (C→D REP): the members, the addresses no member holds, and whether those may open a session now; anything else is refused without a reason.
export const AgentEmailMembersOk = z.object({
  members: z.array(EmailMember).max(EMAIL_MEMBERS_MAX),
  // Asked addresses no member of the organization holds, as the Control Plane read them (§4 step 3); absent from an older Control Plane.
  outsiders: z.array(EmailMemberAddress).max(EMAIL_MEMBERS_MAX).optional(),
  // Whether a message from one of `outsiders` may open a session now: Anyone, with somewhere for its session to go (§4.1); absent reads as refused.
  outsideSenders: z.enum(['admitted', 'refused']).optional()
})
export type AgentEmailMembersOk = z.infer<typeof AgentEmailMembersOk>
