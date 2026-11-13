// Runtime message IDs separate successive replies even when no tool or thought occurs between them.
import { isNoResponsePrefix } from '../session/no-response.js'

/** The runtime's own id for the message a chunk belongs to, or `''` where it names none. */
export function agentMessageId(update: unknown): string {
  const id = (update as { messageId?: unknown } | undefined)?.messageId
  return typeof id === 'string' ? id : ''
}

/** Tracks that id across the chunks of one turn, reporting where a new message begins. */
export class AgentMessageRun {
  private current = ''
  private text = ''
  private closedSentinel = ''

  /** Only a change between named messages closes the preceding reply. */
  opens(update: unknown): boolean {
    const id = agentMessageId(update)
    const opens = id !== '' && this.current !== '' && id !== this.current
    this.closedSentinel = opens && this.text.trim() && isNoResponsePrefix(this.text.trim()) ? this.text : ''
    if (opens) this.text = ''
    if (id) this.current = id
    this.text += agentMessageText(update)
    return opens
  }

  /** `buffered` without the message just closed when that message was only sentinel text, which can no longer complete. */
  withoutClosedSentinel(buffered: string): string {
    const closed = this.closedSentinel
    return closed && buffered.endsWith(closed) ? buffered.slice(0, -closed.length) : buffered
  }
}

function agentMessageText(update: unknown): string {
  const content = (update as { content?: { type?: unknown; text?: unknown } } | undefined)?.content
  return content?.type === 'text' && typeof content.text === 'string' ? content.text : ''
}

/** Tracks new work in one turn; ongoing tool output does not finish the agent's current text block. */
export class WorkBoundary {
  private readonly tools = new Set<string>()

  opens(update: unknown): boolean {
    const u = update as { sessionUpdate?: string; toolCallId?: unknown } | undefined
    if (u?.sessionUpdate === 'agent_thought_chunk' || u?.sessionUpdate === 'plan') return true
    if (u?.sessionUpdate !== 'tool_call' && u?.sessionUpdate !== 'tool_call_update') return false
    const id = u.toolCallId
    if (typeof id !== 'string' || !id) return true
    const opens = !this.tools.has(id)
    this.tools.add(id)
    return opens
  }
}
