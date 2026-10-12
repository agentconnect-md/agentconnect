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
