// What people can do in chat (product-conventions.md): the agent's level, and who the Control Plane knows someone is in webchat.
import type { ChatActions, ChatCallerRole } from '@agentconnect.md/protocol'

/** People in a conversation may answer the agent's tool-call approvals: level `approve` and above. */
export function chatApprovalsAllowed(agent: { chatActions?: ChatActions }): boolean {
  return agent.chatActions === 'approve' || agent.chatActions === 'settings'
}

/** Who a console user is to an agent's webchat conversation: one of its editors, the conversation's owner, or anyone else who may continue it. */
export function chatCallerRole(editor: boolean, owner: boolean): ChatCallerRole {
  return editor ? 'editor' : owner ? 'owner' : 'participant'
}
