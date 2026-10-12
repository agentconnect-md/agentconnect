import type { ChatActions } from '@agentconnect.md/protocol'
import type { Integration } from './agent-schema.js'
import { conversationAdmitted, conversationTrustLevel, integrationRouting } from '../router/routing-rule.js'

type ChatActionsHolder = { readonly chatActions?: ChatActions } | null | undefined

/** People in the conversation may answer the agent's tool-call approvals in chat (level 'approve' and above). */
export function chatApprovalsAllowed(agent: ChatActionsHolder): boolean {
  return agent?.chatActions === 'approve' || agent?.chatActions === 'settings'
}

/** People in the conversation may change the agent's runtime settings from chat (level 'settings'). */
export function chatSettingsAllowed(agent: ChatActionsHolder): boolean {
  return agent?.chatActions === 'settings'
}

/** How a chat approval card reads for everyone once approving in chat is turned off: still open, for an editor. */
export const CHAT_APPROVALS_OFF = 'Approving in chat was turned off. An Agent editor can answer it in the console.'

/** What only the person whose approval answer was refused is told: who can answer instead, and where. */
export function approvalRefusalText(consoleUrl?: string): string {
  const where = consoleUrl ? `in the console: ${consoleUrl}` : 'in the console.'
  return `Only an Agent editor can answer this request. They can answer it ${where}`
}

/** What only the person whose runtime-settings change was refused is told: who can change them, and where. */
export function settingsRefusalText(consoleUrl: string): string {
  return `Only an Agent editor can change runtime settings. They can change them in the console: ${consoleUrl}`
}

/** Whether a conversation takes chat-side answers and setting changes: `closed` keeps everyone out, `external` sends approvals to an internal member. */
export type ChatSurface = 'open' | 'closed' | 'external'

/** Closed when switched off, admitted per message by a Decision, routed, or unknown; external when shared with another organization. */
export function chatSurfaceOf(int: Integration | undefined, channel: string, externallyShared = false): ChatSurface {
  if (!int) return 'closed'
  const routing = integrationRouting(int)
  if (!conversationAdmitted(routing, channel) || routing.decisionBound(channel) || routing.routingFor(channel))
    return 'closed'
  return externallyShared || conversationTrustLevel(int, channel) === 'external' ? 'external' : 'open'
}
