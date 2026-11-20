import { z } from 'zod'
import { EMAIL_ADDRESS_PATTERN, EMAIL_RECIPIENTS_MAX } from './relay-daemon.js'

/** The most addresses one ask names: a mail's sender and its recipients (email-integration.md §6.1). */
export const EMAIL_MEMBERS_MAX = EMAIL_RECIPIENTS_MAX + 1

const EmailMemberAddress = z.string().max(320).regex(EMAIL_ADDRESS_PATTERN)

// The Email payload (email-integration.md §2): the agent's own address; the sending credential stays on the relay, so every send goes through it.
export const IntegrationEmailConfig = z.object({
  address: EmailMemberAddress,
  egress: z.literal('relay'),
  botId: z.string().uuid() // the bot row the relay authorizes a send against
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

// `agent/email-members/ok` (C→D REP): the admitted addresses only; one left out is refused, and the reply never says why.
export const AgentEmailMembersOk = z.object({
  members: z.array(EmailMember).max(EMAIL_MEMBERS_MAX)
})
export type AgentEmailMembersOk = z.infer<typeof AgentEmailMembersOk>
