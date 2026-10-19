import { SessionStatus, type ChatState } from '@microsoft/agent-host-protocol'
import type { AhpAttachmentAuthorization } from '@agentconnect.md/protocol'
import type { LocalStore } from '../store/local-store.js'
import { chatSessionKey } from '../session/chat-application.js'
import type { BoundAhpSession } from './service.js'
import { readAhpHistory } from './history.js'

// A reserved native slot exists before its first runtime and must not be mistaken for lost history.
export async function initialAhpChat(
  store: LocalStore,
  binding: BoundAhpSession,
  auth: AhpAttachmentAuthorization,
  mask: (text: string) => string,
  now: number
): Promise<ChatState> {
  const local = await store.getSessionByOutwardIdOnly(binding.sessionId, auth.agentId)
  let page: Awaited<ReturnType<typeof readAhpHistory>> = { turns: [], hasMore: false }
  if (local)
    page = await readAhpHistory(store, { orgId: auth.orgId, agentId: auth.agentId, sessionId: binding.sessionId }, mask)
  else if (
    auth.targetSessionId ||
    (await store.outwardSessionIdFor(chatSessionKey(binding.conversationId, auth.agentId), auth.agentId)) !==
      binding.sessionId
  )
    throw new Error('AHP session has no current local slot')
  return {
    resource: `ahp-chat:${binding.sessionUri.slice('ahp-session:'.length)}/main`,
    title: local?.title ? mask(local.title) : 'Conversation',
    status: SessionStatus.Idle,
    modifiedAt: new Date(local?.updatedAt ?? now).toISOString(),
    turns: page.turns,
    ...(page.cursor
      ? { turnsNextCursor: page.cursor, _meta: { 'agentconnect.md': { historyCursor: page.cursor } } }
      : {})
  }
}
