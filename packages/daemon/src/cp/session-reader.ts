/**
 * `SessionReader` — the read-only seam answering the CP's `session/list`,
 * `session/history` and `session/tool-body` REQs from the daemon's local store.
 * Bodies live only on the daemon (§1/§12); this projects store rows onto the
 * protocol shapes. The protocol `sessionId` IS the store's `acpSessionId`
 * (SessionManager returns it).
 *
 * Frame-size safety: every REP must serialise under the 256 KiB wire cap. A single
 * tool body can be large, so `history` caps each inline `body` at a 32 KiB VALID-JSON
 * preview and assembles a page under the per-frame budget (newest rows that fit);
 * the FULL body is pulled on demand via `toolBody`, chunked by offset.
 */
import { MAX_FRAME_BYTES, SessionImageAttachment as SessionImageAttachmentSchema } from '@agentconnect.md/protocol'
import type {
  SessionListReq,
  SessionListPage,
  SessionHistoryReq,
  SessionHistoryPage,
  SessionToolBodyReq,
  SessionToolBodyChunk,
  SessionMessage,
  SessionUsage,
  ToolBody,
  Platform
} from '@agentconnect.md/protocol'
import type { LocalStore, TranscriptEventCursor } from '../store/local-store.js'
import { mentionedUserIds, substituteUserMentions } from '../slack/mentions.js'
import { slackThreadUrl } from '../slack/permalink.js'

/** Encoded-payload ceiling, leaving headroom under MAX_FRAME_BYTES for the
 *  envelope (id/ts/type/corr + fencing ext, well under 4 KiB). */
const REPLY_BUDGET = MAX_FRAME_BYTES - 4096

/** Inline `SessionMessage.body` preview cap. Bodies over this are shrunk to a
 *  valid-JSON preview + `bodyTruncated`; the full body is fetched via `toolBody`. */
const PREVIEW_CAP = 32 * 1024

/** New chronological Slack-history cursor. Numeric cursors remain the legacy
 * insertion-seq format so an in-flight page load survives a daemon upgrade. */
const EVENT_CURSOR_PREFIX = 'event-v1:'

function encodeEventCursor(cursor: TranscriptEventCursor): string {
  return `${EVENT_CURSOR_PREFIX}${cursor.eventTimeUs}:${cursor.seq}`
}

function decodeEventCursor(raw: string | undefined): TranscriptEventCursor | null {
  if (!raw?.startsWith(EVENT_CURSOR_PREFIX)) return null
  const [eventRaw, seqRaw, extra] = raw.slice(EVENT_CURSOR_PREFIX.length).split(':')
  if (extra !== undefined) return null
  const eventTimeUs = Number(eventRaw)
  const seq = Number(seqRaw)
  return Number.isSafeInteger(eventTimeUs) && eventTimeUs >= 0 && Number.isSafeInteger(seq) && seq > 0
    ? { eventTimeUs, seq }
    : null
}

/** The encoded size of the payload the wire will carry (JSON.stringify matches the
 *  codec's `encode`), measured in bytes. */
function encodedBytes(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload))
}

function transcriptAttachments(raw: string | null | undefined): NonNullable<SessionMessage['attachments']> {
  if (!raw) return []
  try {
    const parsed = SessionImageAttachmentSchema.array().max(1).safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

/** The persisted text keeps this synthetic suffix for prompt replay; the console
 * receives the real image instead, matching the live turn. */
function withoutAttachmentMention(text: string, attachments: NonNullable<SessionMessage['attachments']>): string {
  if (attachments.length === 0) return text
  const mention = `[attached: ${attachments.map((attachment) => `${attachment.name} (${attachment.mimeType})`).join(', ')}]`
  if (text === mention) return ''
  const suffix = `\n${mention}`
  return text.endsWith(suffix) ? text.slice(0, -suffix.length) : text
}

/** Largest index ≤ `len` that lands on a UTF-8 character boundary — never cuts a
 *  multi-byte sequence (mirrors workspace-reader's slicer). */
function utf8Boundary(buf: Buffer, len: number): number {
  if (len >= buf.length) len = buf.length
  if (len <= 0) return 0
  let start = len - 1
  while (start > 0 && ((buf[start] ?? 0) & 0xc0) === 0x80) start-- // step back over continuation bytes
  const lead = buf[start] ?? 0
  const seqLen =
    lead < 0x80 ? 1 : (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf8) === 0xf0 ? 4 : 1
  return start + seqLen <= len ? len : start
}

/** Cap for a first-message-derived session title (chars). Runtime-pushed titles are
 *  already short; a raw user message can be long, so the fallback is trimmed. */
const TITLE_MAX_CHARS = 80

/** A short, single-line session title from a raw message body: the first non-empty
 *  line, trimmed and capped at TITLE_MAX_CHARS (a trailing `…` marks truncation).
 *  Returns undefined for empty/whitespace input. Used as the session/list fallback
 *  when the runtime never pushed a title. */
function deriveTitle(text: string | undefined): string | undefined {
  if (!text) return undefined
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return undefined
  return line.length > TITLE_MAX_CHARS ? line.slice(0, TITLE_MAX_CHARS).trimEnd() + '…' : line
}

/** Parse a session row's `usage` JSON into the wire shape. Returns undefined when
 *  absent, empty, or unparseable so the optional field is simply omitted. */
function parseUsage(raw: string | null): SessionUsage | undefined {
  if (!raw) return undefined
  try {
    const u = JSON.parse(raw) as SessionUsage
    return u && Object.keys(u).length > 0 ? u : undefined
  } catch {
    return undefined
  }
}

/** Rough character budget to trim a free-form value to when shrinking a preview. A
 *  string is truncated to this many chars; a non-string is stringified then truncated
 *  (kept as a string — the preview is still valid JSON, just lossy on that field). */
function shrinkField(value: unknown, chars: number): unknown {
  if (value === undefined) return undefined
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  if (s.length <= chars) return value
  return s.slice(0, chars) + '…'
}

/**
 * Build a VALID-JSON preview of a tool body that encodes within PREVIEW_CAP. The
 * heavy free-form fields (rawOutput, rawInput, content) are trimmed progressively
 * until it fits; `truncated`/status/kind/locations are preserved. Always sets
 * `truncated:true` on the returned preview.
 */
function previewBody(full: ToolBody): ToolBody {
  const preview: ToolBody = { ...full, truncated: true }
  // Progressively tighten the char budget on the biggest fields until we fit.
  for (const chars of [8192, 2048, 512, 128, 16]) {
    preview.rawOutput = shrinkField(full.rawOutput, chars)
    preview.rawInput = shrinkField(full.rawInput, chars)
    if (full.content !== undefined) {
      const asStr = JSON.stringify(full.content)
      preview.content = asStr.length <= chars ? full.content : [shrinkField(asStr, chars)]
    }
    if (encodedBytes(preview) <= PREVIEW_CAP) return preview
  }
  // Last resort: drop the free-form fields entirely (metadata still fits).
  preview.rawOutput = undefined
  preview.rawInput = undefined
  preview.content = undefined
  return preview
}

export interface SessionReader {
  list(req: SessionListReq): SessionListPage
  history(req: SessionHistoryReq): SessionHistoryPage
  toolBody(req: SessionToolBodyReq): SessionToolBodyChunk
}

/**
 * @param workspaceUrlFor Resolve an agent's Slack workspace base URL (the daemon's
 *   live `SlackConnection.workspaceUrl` for that agent), used to build each Slack
 *   session's thread permalink. Absent (or returning undefined) ⇒ no `threadUrl`.
 */
export function createSessionReader(
  store: LocalStore,
  workspaceUrlFor?: (agentId: string) => string | undefined
): SessionReader {
  return {
    list(req) {
      const rows = store.listSessions(req.agentId)
      // Title = the title supplied by ACP or the AgentConnect title tool, else a
      // fallback derived from the session's FIRST user message. Before the agent has
      // a meaningful request to name, this keeps the console better than "Session <id>".
      // firstMessageText only runs for untitled rows (`||` short-circuits).
      const enriched = rows.map((r) => ({
        r,
        rawTitle: r.title || deriveTitle(store.firstMessageText(r.channel, r.thread, r.agentId))
      }))
      // Display names for every channel + triggering sender + `<@U…>` mention in a
      // title we know one for (daemon-resolved + cached; absent ids just stay raw).
      const names = store.getDisplayNames(
        enriched.flatMap(({ r, rawTitle }) => [
          r.channel,
          ...(r.triggeredBy ? [r.triggeredBy] : []),
          ...mentionedUserIds(rawTitle)
        ])
      )
      const sessions = enriched.map(({ r, rawTitle }) => {
        const usage = parseUsage(r.usage)
        const channelName = names.get(r.channel)
        const triggeredByName = r.triggeredBy ? names.get(r.triggeredBy) : undefined
        // Titles (explicit OR the first-message fallback) can carry raw `<@U…>`
        // mentions — rewrite to `@name` like the transcript does.
        const title = rawTitle ? substituteUserMentions(rawTitle, names) : undefined
        // Slack thread deep link, built from the agent's live workspace URL + the
        // session's channel/thread-root ts. Only Slack sessions have this form.
        const threadUrl =
          r.platform === 'slack' ? slackThreadUrl(workspaceUrlFor?.(r.agentId), r.channel, r.thread) : undefined
        return {
          sessionId: r.acpSessionId!, // listSessions filters out null acpSessionId
          ...(r.originSessionId ? { parentSessionId: r.originSessionId } : {}),
          // store `platform` is a free string; the daemon only ever writes a valid Platform.
          sessionKey: { platform: r.platform as Platform, channel: r.channel, thread: r.thread },
          agentId: r.agentId,
          status: r.state,
          lastActivityAt: new Date(r.updatedAt).toISOString(),
          ...(usage ? { usage } : {}),
          ...(title ? { title } : {}),
          ...(r.triggeredBy ? { triggeredBy: r.triggeredBy } : {}),
          ...(channelName ? { channelName } : {}),
          ...(triggeredByName ? { triggeredByName } : {}),
          ...(threadUrl ? { threadUrl } : {})
        }
      })
      return { sessions }
    },
    history(req) {
      const rec = store.getSessionByAcpId(req.sessionId)
      if (!rec) return { sessionId: req.sessionId, messages: [] }
      // Slack can append an older platform row during warm-thread backfill, so its
      // authoritative history pages by normalized event time + seq tie-breaker. A
      // plain numeric cursor came from a pre-upgrade daemon: finish that page walk in
      // legacy seq order to avoid mixing cursor domains mid-request.
      const eventCursor = decodeEventCursor(req.cursor)
      const numericCursor = req.cursor !== undefined ? Number(req.cursor) : Number.NaN
      const legacyBefore = Number.isSafeInteger(numericCursor) ? numericCursor : null
      const chronologicalSlack =
        rec.platform === 'slack' && (req.cursor === undefined || eventCursor !== null || legacyBefore === null)
      // Scope to what THIS agent's session received + produced, not the whole shared
      // (channel, thread) thread — an agent-called session only ever saw the message handed
      // to it (context isolation), so the view must not leak other participants' cross-talk.
      const { rows, hasMore } = chronologicalSlack
        ? store.transcriptPageForAgentByEventTime(rec.channel, rec.thread, rec.agentId, eventCursor, req.limit)
        : store.transcriptPageForAgent(rec.channel, rec.thread, rec.agentId, legacyBefore, req.limit)
      // rows are newest-first; the page itself is oldest→newest.
      const ordered = rows.slice().reverse()
      // Display names (cached in the store) for both senders AND `<@U…>` mentions in
      // message bodies; agent-id senders and unresolved ids have no entry, so
      // `senderName` is omitted (UI falls back) and mentions stay as the raw token.
      const names = store.getDisplayNames(ordered.flatMap((r) => [r.sender, ...mentionedUserIds(r.text)]))
      const built = ordered.map<SessionMessage>((r) => {
        const senderName = names.get(r.sender)
        const attachments = transcriptAttachments(r.attachmentsJson)
        const base: SessionMessage = {
          seq: r.seq,
          sender: r.sender,
          ...(senderName ? { senderName } : {}),
          ts: r.ts,
          kind: r.kind,
          text: substituteUserMentions(withoutAttachmentMention(r.text, attachments), names),
          ...(attachments.length ? { attachments } : {})
        }
        if (r.kind !== 'tool' || !r.body) return base
        // Enrich a tool row: surface toolCallId/status/kind + an inline body (verbatim
        // when ≤ 32 KiB, else a valid-JSON preview with bodyTruncated + full byte length).
        let full: ToolBody
        try {
          full = JSON.parse(r.body) as ToolBody
        } catch {
          return base // unparseable body → fall back to the title-only row
        }
        const bytes = Buffer.byteLength(r.body)
        base.toolCallId = full.toolCallId ?? r.toolCallId ?? undefined
        if (full.status !== undefined) base.toolStatus = full.status
        if (full.kind !== undefined) base.toolKind = full.kind
        if (bytes <= PREVIEW_CAP) {
          base.body = r.body
        } else {
          base.body = JSON.stringify(previewBody(full))
          base.bodyTruncated = true
          base.bodyBytes = bytes
        }
        return base
      })
      // Per-page frame budget: keep the NEWEST rows that fit, drop older overflow, and
      // page older via nextCursor = oldest KEPT seq. `built` is oldest→newest, so we
      // accumulate from the newest end. A single ≤ 32 KiB preview always fits ⇒ progress.
      const kept: SessionMessage[] = []
      let acc = 0
      let droppedToBudget = false
      for (let i = built.length - 1; i >= 0; i--) {
        const m = built[i]!
        const enc = encodedBytes(m) + 1 // + array separator
        if (kept.length > 0 && acc + enc > REPLY_BUDGET) {
          droppedToBudget = true // this row + everything older overflows the frame
          break
        }
        kept.push(m)
        acc += enc
      }
      kept.reverse() // back to oldest→newest
      // Older rows exist if the store had more beyond this page (hasMore) OR the frame
      // budget forced us to drop some of this page. Anchor the next cursor to the oldest
      // KEPT row in the active ordering (event-time+seq for Slack; seq otherwise), so the
      // console pages strictly older. A ≤ 32 KiB preview always fits ⇒ kept is non-empty
      // when the page is ⇒ progress is guaranteed.
      const hasOlder = hasMore || droppedToBudget
      const oldestKept = kept[0]
      const oldestRow = oldestKept ? rows.find((r) => r.seq === oldestKept.seq) : undefined
      return {
        sessionId: req.sessionId,
        messages: kept,
        ...(hasOlder && oldestKept
          ? {
              nextCursor:
                chronologicalSlack && oldestRow
                  ? encodeEventCursor({ eventTimeUs: oldestRow.eventTimeUs, seq: oldestRow.seq })
                  : String(oldestKept.seq)
            }
          : {})
      }
    },
    toolBody(req) {
      const rec = store.getSessionByAcpId(req.sessionId)
      const empty: SessionToolBodyChunk = {
        sessionId: req.sessionId,
        toolCallId: req.toolCallId,
        data: '',
        totalBytes: 0
      }
      if (!rec) return empty
      const body = store.getToolBody(rec.channel, rec.thread, req.toolCallId)
      if (body === undefined) return empty
      const buf = Buffer.from(body, 'utf8')
      const totalBytes = buf.length
      const offset = Math.min(req.offset, totalBytes)
      const remaining = buf.subarray(offset)
      // Bound the slice by the encoded reply budget (JSON escaping can blow up size),
      // ending on a UTF-8 boundary. Shrink until the encoded chunk fits.
      let end = utf8Boundary(remaining, remaining.length)
      let data = remaining.toString('utf8', 0, end)
      while (end > 0 && encodedBytes(data) > REPLY_BUDGET) {
        const factor = REPLY_BUDGET / encodedBytes(data)
        const shrunk = Math.max(1, Math.floor(end * factor * 0.9))
        end = utf8Boundary(remaining, Math.min(shrunk, end - 1)) // strictly < end ⇒ terminates
        data = remaining.toString('utf8', 0, end)
      }
      const nextOffset = offset + end
      return {
        sessionId: req.sessionId,
        toolCallId: req.toolCallId,
        data,
        totalBytes,
        ...(nextOffset < totalBytes ? { nextOffset } : {})
      }
    }
  }
}
