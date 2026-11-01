// Shared human-chat output mapping and canonical reply accumulation.
import { randomUUID } from 'node:crypto'
import type { ChatEvent, ChatTurnOutput } from './chat-turn.js'
import { isNoResponsePrefix } from './no-response.js'
import { planEntriesOf } from './plan-entries.js'
import { flattenUnsafeLinks } from '../messages/agent-links.js'
import { agentMessageId } from '../messages/message-boundary.js'
import type { WorkspaceFileLinkResolver } from '../messages/workspace-file-links.js'
import { chunkText } from './chat-chunk.js'
import { extractToolOutput } from './tool-output.js'
import { toolEditsOf, type ToolEdit } from './tool-edits.js'

// Map already-masked runtime updates into shared chat events without choosing a protocol.
export function emitChatUpdate(wc: ChatTurnOutput, update: any, resolveFileLink?: WorkspaceFileLinkResolver): void {
  const emit = (event: ChatEvent): void => {
    wc.sink.output({
      conversationId: wc.conversationId,
      turnId: wc.turnId,
      index: wc.index++,
      event
    })
  }
  const messageId = update?.sessionUpdate === 'agent_message_chunk' ? agentMessageId(update) : ''
  const boundary =
    (messageId && wc.messageId && messageId !== wc.messageId) ||
    ['agent_thought_chunk', 'tool_call', 'plan'].includes(update?.sessionUpdate)
  if ((boundary || update?.sessionUpdate === 'tool_call_update') && !isNoResponsePrefix(wc.replyText.trim())) {
    flushHeldChatText(wc, resolveFileLink)
    if (boundary) wc.segmentIndex = undefined
  }
  if (messageId) wc.messageId = messageId
  switch (update?.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = update.content?.type === 'text' ? (update.content.text ?? '') : ''
      if (text) {
        if (wc.segmentIndex === undefined) {
          if (wc.replySegments.length)
            wc.replyText += wc.replyText.endsWith('\n\n') ? '' : wc.replyText.endsWith('\n') ? '\n' : '\n\n'
          wc.segmentIndex = wc.replySegments.length
          wc.replySegments.push({ postId: randomUUID(), text: '' })
        }
        const segment = wc.replySegments[wc.segmentIndex]!
        segment.text += text
        wc.replyText += text
        wc.heldText += text
        // Keep the sentinel and any Markdown that later chunks could turn into a file link off the stream.
        if (!wc.messageEmitted && isNoResponsePrefix(wc.replyText.trim())) return
        const linkStart = wc.heldText.search(/[!<[\]]/)
        const end = (linkStart < 0 ? wc.heldText : wc.heldText.slice(0, linkStart)).trimEnd().length
        const ready = wc.heldText.slice(wc.heldTextOffset ?? 0, end)
        wc.heldTextOffset = end
        if (ready) {
          wc.messageEmitted = true
          for (const t of chunkText(ready))
            emit({
              kind: 'message',
              text: t,
              segmentId: segment.postId,
              ...(!wc.continuation ? { postId: segment.postId } : {})
            })
        }
      }
      return
    }
    case 'agent_thought_chunk': {
      const text = update.content?.text ?? ''
      if (text) for (const t of chunkText(text)) emit({ kind: 'thinking', text: t })
      return
    }
    case 'tool_call':
      emit({
        kind: 'tool_call',
        toolCallId: String(update.toolCallId ?? ''),
        title: String(update.title ?? update.toolCallId ?? 'tool'),
        status: String(update.status ?? 'pending'),
        ...toolPreview(update)
      })
      return
    case 'tool_call_update': {
      // Keep a refined tool title consistent with the durable transcript.
      const title = typeof update.title === 'string' ? update.title : undefined
      emit({
        kind: 'tool_update',
        toolCallId: String(update.toolCallId ?? ''),
        status: String(update.status ?? ''),
        ...(title !== undefined ? { title } : {}),
        ...toolPreview(update)
      })
      return
    }
    case 'session_info_update': {
      // Empty titles retain the existing fallback; the update handler already persisted nonempty titles.
      const title = typeof update.title === 'string' ? update.title.trim() : ''
      if (title) emit({ kind: 'session_info', title })
      return
    }
    case 'plan': {
      // Plans replace the previous snapshot, matching the durable transcript.
      const entries = planEntriesOf(update)
      if (entries.length) emit({ kind: 'plan', entries })
      return
    }
    default:
      return // usage/etc. are not part of the webchat reply stream
  }
}

export { appendChatTextRow } from './chat-transcript.js'

/** Resolve one complete Markdown message before releasing its held suffix and recording the canonical reply. */
export function flushHeldChatText(wc: ChatTurnOutput, resolveFileLink?: WorkspaceFileLinkResolver): void {
  if (!wc.heldText) return
  const rendered = flattenUnsafeLinks(wc.heldText, { resolveFileLink })
  const held = rendered.slice(wc.heldTextOffset ?? 0)
  wc.replyText = wc.replyText.slice(0, -wc.heldText.length) + rendered
  const segment = wc.segmentIndex === undefined ? undefined : wc.replySegments[wc.segmentIndex]
  if (segment) segment.text = segment.text.slice(0, -wc.heldText.length) + rendered
  wc.heldText = ''
  wc.heldTextOffset = 0
  if (!held) return
  wc.messageEmitted = true
  for (const text of chunkText(held)) {
    wc.sink.output({
      conversationId: wc.conversationId,
      turnId: wc.turnId,
      index: wc.index++,
      event: {
        kind: 'message',
        text,
        ...(segment ? { segmentId: segment.postId, ...(!wc.continuation ? { postId: segment.postId } : {}) } : {})
      }
    })
  }
}

/** Close the streamed text before a shared image: release its held suffix and start any later text as a new segment. */
export function closeChatSegmentForImage(wc: ChatTurnOutput, resolveFileLink?: WorkspaceFileLinkResolver): void {
  if (!isNoResponsePrefix(wc.replyText.trim())) flushHeldChatText(wc, resolveFileLink)
  wc.segmentIndex = undefined
}

/** A segment's single transcript write: every caller awaits the same promise, and a failed write may be retried. */
export function commitSegmentOnce(segment: { committing?: Promise<void> }, write: () => Promise<void>): Promise<void> {
  segment.committing ??= write().catch((err: unknown) => {
    segment.committing = undefined
    throw err
  })
  return segment.committing
}

// Preview only already-masked values, bounded independently of transcript retention.
function toolPreview(update: { rawInput?: unknown; rawOutput?: unknown; content?: unknown }): {
  input?: string
  output?: string
  edits?: ToolEdit[]
} {
  const preview = (value: unknown): string | undefined => {
    if (value === undefined) return undefined
    try {
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      if (text === undefined) return undefined
      const bytes = Buffer.from(text)
      return bytes.length <= 8192
        ? text
        : bytes
            .subarray(0, 8188)
            .toString('utf8')
            .replace(/\ufffd$/, '') + '…'
    } catch {
      return undefined
    }
  }
  const input = preview(update.rawInput)
  const output = preview(extractToolOutput(update) || update.rawOutput)
  const edits = toolEditsOf(update)
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(edits ? { edits } : {})
  }
}
