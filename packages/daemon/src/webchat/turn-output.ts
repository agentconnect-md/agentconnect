/**
 * The webchat turn-output surface: the ACP-update → `WebchatEvent` mapping the turn
 * engine streams through a turn's sink, plus the two transcript helpers that share it.
 * Pure functions over the turn's webchat state (and, where a row is written, the store),
 * called directly by the turn engine.
 */
import type { SessionImageAttachment, WebchatEvent } from '@agentconnect.md/protocol'
import type { LocalStore } from '../store/local-store.js'
import { monotonicTs } from '../store/monotonic-ts.js'
import { isNoResponsePrefix } from '../session/no-response.js'
import { planEntriesOf } from '../session/plan-entries.js'
import { chunkText } from './chunk.js'
import type { Pending } from '../daemon/turn-types.js'

/** One turn's live webchat state — the sink, its output cursor, and the sentinel hold. */
export type WebchatTurnOutput = NonNullable<Pending['webchat']>

/**
 * Map one ACP SessionUpdate to a WebchatEvent and stream it through the sink (→ relay
 * `rd/chat`, webchat's "send"). Only the streamable kinds map; usage and the rest are
 * handled elsewhere or dropped. A single event whose inline text would
 * blow the 256 KiB frame cap is split across multiple chunks, each with its own `index`.
 */
export function emitWebchatUpdate(wc: WebchatTurnOutput, update: any): void {
  const emit = (event: WebchatEvent): void => {
    wc.sink.output({
      conversationId: wc.conversationId,
      turnId: wc.turnId,
      index: wc.index++,
      event
    })
  }
  switch (update?.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = update.content?.type === 'text' ? (update.content.text ?? '') : ''
      if (text) {
        wc.replyText += text // recorded once at turn end (no Slack post boundary)
        // Response-choice hold (product-conventions §No-response control marker):
        // while the whole accumulated body could still be the bare sentinel,
        // keep it off the live stream — an agent silently declining a
        // conversation-wide activation must not flash AC_NO_RESPONSE into the
        // browser. Everything is released the instant the body diverges.
        if (wc.messageEmitted) {
          for (const t of chunkText(text)) emit({ kind: 'message', text: t })
        } else {
          wc.heldText += text
          if (!isNoResponsePrefix(wc.heldText.trim())) {
            const held = wc.heldText
            wc.heldText = ''
            wc.messageEmitted = true
            for (const t of chunkText(held)) emit({ kind: 'message', text: t })
          }
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
      // The runtime's auto-generated title (already persisted via setSessionTitle
      // above). Stream it so the live playground session renames in place. Slack
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

/** Release stream text held back by the no-response sentinel check once the
 *  turn is known to be a real reply (it diverged only at the very end, e.g. a
 *  body shorter than the sentinel). */
export function flushHeldWebchatText(wc: WebchatTurnOutput): void {
  if (!wc.heldText) return
  const held = wc.heldText
  wc.heldText = ''
  wc.messageEmitted = true
  wc.sink.output({
    conversationId: wc.conversationId,
    turnId: wc.turnId,
    index: wc.index++,
    event: { kind: 'message', text: held }
  })
}
