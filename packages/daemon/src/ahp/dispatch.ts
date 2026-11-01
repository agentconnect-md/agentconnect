import {
  ActionType,
  MessageKind,
  PendingMessageKind,
  ResponsePartKind,
  type ActionOrigin,
  type ChatState,
  type DispatchActionParams
} from '@microsoft/agent-host-protocol'
import type { AhpAttachmentAuthorization } from '@agentconnect.md/protocol'
import { chatSessionKey } from '../session/chat-application.js'
import { continuedByTarget } from '../session/chat-continuation.js'
import { observeChatTurn } from '../session/chat-observer.js'
import type { ChatOutput, ChatPost, ChatSink } from '../session/chat-turn.js'
import type { MaskedChatEvent } from '../session/chat-events.js'
import type { AhpApplication, AhpActionScope } from './application.js'
import { publishedMessage } from './action-schema.js'
import type { AhpActionContext } from './service.js'

export interface AhpDispatchEnvironment {
  session(sessionId: string, agentId: string): Promise<{ key: string; platform: string; thread?: string } | undefined>
  authorized(auth: AhpAttachmentAuthorization): boolean
  canStart(sessionKey: string, turnId: string): boolean
  now(): number
  mask(agentId: string, text: string): string
  observe(auth: AhpAttachmentAuthorization, event: MaskedChatEvent): void
  output(auth: AhpAttachmentAuthorization, sessionId: string, output: ChatOutput): void
  post(post: ChatPost): void
  markSink(sink: ChatSink): void
}

// Admission, output masking, and the runtime owner are shared; this layer owns only AHP publication.
export async function dispatchAhpAction(
  application: AhpApplication,
  params: DispatchActionParams,
  origin: ActionOrigin | undefined,
  context: AhpActionContext,
  host: AhpDispatchEnvironment
): Promise<void> {
  const { authorization: auth, binding, state } = context
  const local = await host.session(binding.sessionId, auth.agentId)
  const channel = `ahp-chat:${binding.sessionUri.slice('ahp-session:'.length)}/main`
  const scope: AhpActionScope = {
    agentId: auth.agentId,
    conversationId: binding.conversationId,
    sessionId: binding.sessionId,
    sessionUri: binding.sessionUri,
    author: { id: auth.userId, name: auth.user },
    callerRole: auth.callerRole,
    callerApproves: auth.callerApproves,
    ...(!auth.conversationId ? { apiOrigin: true } : {}),
    ...(auth.targetSessionId || (local && continuedByTarget(local)) ? { targetSessionId: binding.sessionId } : {})
  }
  await application.dispatch(scope, params, origin, {
    authorized: () => context.isCurrent() && host.authorized(auth),
    canStart: (turnId) => {
      const chat = state.snapshot(channel) as ChatState | undefined
      return (
        (!chat?.activeTurn || chat.activeTurn.id === turnId) &&
        host.canStart(local?.key ?? chatSessionKey(binding.conversationId, auth.agentId), turnId)
      )
    },
    context: (turnId) => {
      const context = observeChatTurn(
        {
          conversationId: binding.conversationId,
          turnId,
          apiProtocol: 'ahp',
          sink: { output: (update: ChatOutput) => host.output(auth, binding.sessionId, update), done: () => {} },
          postSink: (post: ChatPost) => host.post(post)
        },
        { sessionId: binding.sessionId, generation: 0, now: host.now, emit: (event) => host.observe(auth, event) }
      )
      host.markSink(context.sink)
      return context
    },
    admitted: async (action, acceptedOrigin, result) => {
      if (result.duplicate) throw new Error('Duplicate admission requires snapshot reconciliation')
      // Only the image the runtime received is shown back; ignored client context may name local paths.
      const { attachments } = publishedMessage(action.message)
      await state.apply(
        channel,
        {
          ...action,
          startedAt: new Date(host.now()).toISOString(),
          message: {
            text: host.mask(auth.agentId, action.message.text),
            origin: { kind: MessageKind.User },
            ...(attachments ? { attachments } : {})
          }
        },
        acceptedOrigin
      )
    },
    steered: async (action, acceptedOrigin, result) => {
      if (result.duplicate) throw new Error('Duplicate steering requires snapshot reconciliation')
      const chat = state.snapshot(channel) as ChatState
      if (!chat.activeTurn) throw new Error('Steering lost its active turn')
      const text = host.mask(auth.agentId, action.message.text)
      await state.apply(channel, { ...action, message: { text, origin: { kind: MessageKind.User } } }, acceptedOrigin)
      await state.apply(channel, {
        type: ActionType.ChatPendingMessageRemoved,
        kind: PendingMessageKind.Steering,
        id: action.id
      })
      await state.apply(channel, {
        type: ActionType.ChatResponsePart,
        turnId: chat.activeTurn.id,
        part: {
          kind: ResponsePartKind.SystemNotification,
          content: `Additional user instruction: ${text}`,
          _meta: { 'agentconnect.md': { steeringId: action.id, text } }
        }
      })
    },
    echo: (action, acceptedOrigin) => state.apply(params.channel, action, acceptedOrigin)
  })
}
