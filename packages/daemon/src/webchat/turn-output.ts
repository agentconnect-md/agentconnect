// Webchat output mapping and canonical transcript helpers used by the turn engine.
import type { SessionImageAttachment, WebchatEvent } from '@agentconnect.md/protocol'
import type { LocalStore } from '../store/local-store.js'
import { monotonicTs } from '../store/monotonic-ts.js'
import { isNoResponsePrefix } from '../session/no-response.js'
import { planEntriesOf } from '../session/plan-entries.js'
import { flattenUnsafeLinks } from '../messages/agent-links.js'
import { agentMessageId } from '../messages/message-boundary.js'
import type { WorkspaceFileLinkResolver } from '../messages/workspace-file-links.js'
import { chunkText } from './chunk.js'
import type { Pending } from '../daemon/turn-types.js'

/** One turn's live sink, output cursor, and buffered Markdown message. */
export type WebchatTurnOutput = NonNullable<Pending['webchat']>

/** Map streamable ACP updates into indexed webchat events below the relay frame limit. */
export function emitWebchatUpdate(
  wc: WebchatTurnOutput,
  update: any,
  resolveFileLink?: WorkspaceFileLinkResolver
): void {
  const emit = (event: WebchatEvent): void => {
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
    ['agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan'].includes(update?.sessionUpdate)
  if (boundary && !isNoResponsePrefix(wc.replyText.trim())) flushHeldWebchatText(wc, resolveFileLink)
  if (messageId) wc.messageId = messageId
  switch (update?.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = update.content?.type === 'text' ? (update.content.text ?? '') : ''
      if (text) {
        wc.replyText += text
        wc.heldText += text
        // Keep the sentinel and any Markdown that later chunks could turn into a file link off the stream.
        if (!wc.messageEmitted && isNoResponsePrefix(wc.replyText.trim())) return
        const linkStart = wc.heldText.search(/[<[\]]/)
        const end = (linkStart < 0 ? wc.heldText : wc.heldText.slice(0, linkStart)).trimEnd().length
        const ready = wc.heldText.slice(wc.heldTextOffset ?? 0, end)
        wc.heldTextOffset = end
        if (ready) {
          wc.messageEmitted = true
          for (const t of chunkText(ready)) emit({ kind: 'message', text: t })
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
        status: String(update.status ?? 'pending')
      })
      return
    case 'tool_call_update': {
      // A later update can retitle the call (e.g. Codex web_search starts generic,
      // then reports the actual query) — forward it so the live view retitles in
      // place instead of being stuck on the first `tool_call`'s placeholder title.
      const title = typeof update.title === 'string' ? update.title : undefined
      emit({
        kind: 'tool_update',
        toolCallId: String(update.toolCallId ?? ''),
        status: String(update.status ?? ''),
        ...(title !== undefined ? { title } : {})
      })
      return
    }
    case 'session_info_update': {
      // The runtime's auto-generated title (already persisted by the update handler).
      // Stream it so the live playground session renames in place. Slack
      // app-DM threads are updated independently through setTitle above. Only a
      // non-empty set is streamed; a null/clear leaves the client's fallback label
      // untouched.
      const title = typeof update.title === 'string' ? update.title.trim() : ''
      if (title) emit({ kind: 'session_info', title })
      return
    }
    case 'plan': {
      // A SNAPSHOT, not a chunk: ACP resends the whole list on each revision, so the browser
      // replaces its copy rather than appending. Same entries the transcript row records, so
      // a live turn shows the plan it is working through instead of only revealing it on the
      // reload that switches the page to history.
      const entries = planEntriesOf(update)
      if (entries.length) emit({ kind: 'plan', entries })
      return
    }
    default:
      return // usage/etc. are not part of the webchat reply stream
  }
}

/**
 * Append one webchat conversation text row at (or just after) `ts`. The
 * `(channel, thread, ts)` unique index dedups by timestamp alone, and two
 * daemons can mint the same millisecond for DISTINCT concurrent posts — an
 * unchecked `INSERT OR IGNORE` would silently drop the later one. Probe the
 * slot: an identical post dedups in place (the recipient delivery is still
 * recorded), a foreign occupant bumps the ts by 1 ms (bounded). Returns the
 * ts actually used, which becomes the post's canonical `at` when the caller
 * is the origin.
 */
export async function appendWebchatTextRow(
  store: LocalStore,
  channel: string,
  thread: string,
  ts: string,
  entry: {
    sender: string
    recipient?: string
    text: string
    /** Canonical webchat post id — persisted on the row (§6). */
    postId?: string
    trustedAgentBot?: boolean
    attachments?: SessionImageAttachment[]
  }
): Promise<string> {
  let slot = BigInt(ts)
  for (let attempt = 0; attempt < 32; attempt++) {
    const existing = await store.transcriptTextAt(channel, thread, String(slot), entry)
    // Canonical identity decides slot reuse (§6): two DISTINCT posts can share
    // sender, text, AND millisecond (`at` minting is connection-local, so two
    // tabs can collide) — only a matching postId proves the occupant IS this
    // post. Rows without an id on either side keep the historical
    // (sender, text) heuristic as the legacy fallback.
    const samePost =
      existing !== undefined &&
      (entry.postId && existing.postId
        ? existing.postId === entry.postId
        : existing.sender === entry.sender && existing.text === entry.text)
    if (!existing || samePost) {
      await store.appendTranscript({ channel, thread, ts: String(slot), kind: 'text', ...entry })
      return String(slot)
    }
    slot += 1n
  }
  // Pathological pile-up — fall back to the process-monotonic clock (locally unique).
  const fallback = monotonicTs()
  await store.appendTranscript({ channel, thread, ts: fallback, kind: 'text', ...entry })
  return fallback
}

/** Resolve one complete Markdown message before releasing its held suffix and recording the canonical reply. */
export function flushHeldWebchatText(wc: WebchatTurnOutput, resolveFileLink?: WorkspaceFileLinkResolver): void {
  if (!wc.heldText) return
  const rendered = flattenUnsafeLinks(wc.heldText, { resolveFileLink })
  const held = rendered.slice(wc.heldTextOffset ?? 0)
  wc.replyText = wc.replyText.slice(0, -wc.heldText.length) + rendered
  wc.heldText = ''
  wc.heldTextOffset = 0
  if (!held) return
  wc.messageEmitted = true
  for (const text of chunkText(held)) {
    wc.sink.output({
      conversationId: wc.conversationId,
      turnId: wc.turnId,
      index: wc.index++,
      event: { kind: 'message', text }
    })
  }
}
