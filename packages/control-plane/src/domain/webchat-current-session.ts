import { isAppendCoordinate } from '@agentconnect.md/protocol'

/** Whether a webchat row may take its conversation's current-session pointer: one on the conversation's own thread, never a thread-keyed task (webchat-threads.md §5.4). */
export function takesCurrentSession(conversationId: string, thread: string | null | undefined): boolean {
  return !thread || thread === `webchat:${conversationId}` || isAppendCoordinate(thread)
}
