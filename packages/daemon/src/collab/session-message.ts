// How a session message reaches the model (send-message-guide.md §9.5): its id, its source, and the reply call when one is owed.
import { createHash } from 'node:crypto'
import type { SessionMessageTurnFacts, UserTurnBody } from '@agentconnect.md/protocol'
import type { SessionMessageKind } from '../store/session-messages.js'

/** The trusted facts the receiving daemon shows about one session message. */
export interface SessionMessageView {
  messageId: string
  kind: SessionMessageKind
  sourceAgentId: string
  /** The source agent's display name; its id when absent. */
  sourceLabel?: string
  sourceSessionId: string
  inReplyTo?: string
  /** The source asked for an outcome (`needsReply`, or always for a task input). */
  replyRequested: boolean
  /** A task input that starts the task, rather than one that continues it. */
  startsTask?: boolean
}

/** The exact call that answers a message. */
export const replyToMessageCall = (messageId: string): string =>
  `sendMessage {"action":"replyToSession","messageId":"${messageId}","message":"..."}`

/** The first line of every rendered session message; approval cards strip it from a task's label. */
export const SESSION_MESSAGE_HEADER = /^\[Message [^\]\s]+\][^\n]*\n/

function headline(view: SessionMessageView): string {
  const who = view.sourceLabel
    ? `${view.sourceLabel} (agent ${view.sourceAgentId}, session ${view.sourceSessionId})`
    : `agent ${view.sourceAgentId} (session ${view.sourceSessionId})`
  switch (view.kind) {
    case 'taskInput':
      return view.startsTask
        ? `From your own session (session ${view.sourceSessionId}), as a background task:`
        : `From the session that started this task (session ${view.sourceSessionId}), a new message for this background task:`
    case 'reply':
      return `Reply from ${who}${view.inReplyTo ? ` to your message ${view.inReplyTo}` : ''}:`
    case 'report':
      return `Report from your task (session ${view.sourceSessionId}):`
    case 'call':
      return `From ${who}:`
  }
}

function trailer(view: SessionMessageView): string {
  if (!view.replyRequested) return ''
  if (view.kind === 'taskInput')
    return (
      `\n\n[Send progress, a question, or your result for it with ${replyToMessageCall(view.messageId)}; ` +
      'a reply does not end your work.]'
    )
  return (
    `\n\n[This message waits on your reply. When you finish, or cannot, answer it with ` +
    `${replyToMessageCall(view.messageId)}, saying whether you succeeded and what the result was. Your ordinary ` +
    'response here does not reach it; after the reply is delivered, end your turn without repeating it.]'
  )
}

/** One session message as its input text: a header naming its id and source, the body, then the reply call when owed. */
export function renderSessionMessage(view: SessionMessageView, body: string): string {
  return `[Message ${view.messageId}] ${headline(view)}\n${body}${trailer(view)}`
}

/** What a delivery shows the console in place of its model input: the readable part, and the guidance folded under it. */
export interface ShownInput {
  text: string
  notes?: string[]
}

/** One delivered message as the model's prompt and the console's view of it: the body shown, the header and guidance folded beneath. */
export function sessionMessageInput(
  facts: Omit<SessionMessageTurnFacts, 'notes'>,
  prompt: string,
  shown: ShownInput
): { text: string; turnBody: UserTurnBody } {
  const notes = shown.notes?.filter((note) => note.trim() !== '') ?? []
  return {
    text: shown.text,
    turnBody: { prompt, sessionMessage: { ...facts, ...(notes.length > 0 ? { notes } : {}) } }
  }
}

/** {@link renderSessionMessage}'s prompt with the body shown on its own, its reply call among the folded notes. */
export function renderedSessionMessageInput(
  view: SessionMessageView,
  body: string,
  shown: ShownInput = { text: body }
): { text: string; turnBody: UserTurnBody } {
  return sessionMessageInput(
    {
      messageId: view.messageId,
      kind: view.kind,
      source: {
        agentId: view.sourceAgentId,
        ...(view.sourceLabel !== undefined ? { label: view.sourceLabel } : {}),
        sessionId: view.sourceSessionId
      },
      ...(view.inReplyTo !== undefined ? { inReplyTo: view.inReplyTo } : {}),
      ...(view.replyRequested ? { replyRequested: true } : {}),
      ...(view.startsTask ? { startsTask: true } : {})
    },
    renderSessionMessage(view, body),
    { text: shown.text, notes: [...(shown.notes ?? []), trailer(view).trim()] }
  )
}

/** A session message's id minted from its submission, so a replay of that submission keeps it. */
export function submissionMessageId(agentId: string, senderKey: string, submissionId: string): string {
  return `msg-${createHash('sha256').update(`session-message\n${agentId}\n${senderKey}\n${submissionId}`).digest('hex').slice(0, 32)}`
}

/** The id a delivery that carried none is recorded under, the same on every replay of it. */
export function legacySessionMessageId(sourceAgentId: string, deliveryId: string): string {
  return `msg-${createHash('sha256').update(`legacy-session-message\n${sourceAgentId}\n${deliveryId}`).digest('hex').slice(0, 32)}`
}
