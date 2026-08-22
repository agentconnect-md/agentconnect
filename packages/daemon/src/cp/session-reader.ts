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
import {
  transcriptChannelKey,
  type LocalStore,
  type SessionRecord,
  type TranscriptEventCursor
} from '../store/local-store.js'
import { mentionedUserIds, substituteUserMentions } from '../slack/mentions.js'
import { hasNativeMessageOrder } from '../platforms/message-ordering.js'

/** Encoded-payload ceiling, leaving headroom under MAX_FRAME_BYTES for the
 *  envelope (id/ts/type/corr + fencing ext, well under 4 KiB). */
const REPLY_BUDGET = MAX_FRAME_BYTES - 4096

/** Inline `SessionMessage.body` preview cap. Bodies over this are shrunk to a
 *  valid-JSON preview + `bodyTruncated`; the full body is fetched via `toolBody`. */
const PREVIEW_CAP = 32 * 1024

/** New chronological history cursor, used by platforms whose message ids carry a
 * native order. Numeric cursors remain the legacy insertion-seq format so an
 * in-flight page load survives a daemon upgrade. */
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

/**
 * The persisted text keeps a synthetic `[attached: name (mimeType), …]` suffix for
 * prompt replay, listing EVERY file on the message; the console instead receives the
 * one image the daemon inlined. Drop only that image's entry and keep the rest as
 * their label, so a second image, an over-cap image, or a plain file stays visible.
 *
 * Entries are matched on the name, not rebuilt from the attachment: the row may have
 * been written by the observer before a download settled the real image type (a
 * Feishu image event declares none). Nothing recognized ⇒ the row is left alone.
 */
function withoutAttachmentMention(text: string, attachments: NonNullable<SessionMessage['attachments']>): string {
  if (attachments.length === 0) return text
  const label = /(?:^|\n)\[attached: ([^\]\n]*)\]$/.exec(text)
  if (!label) return text
  let list = label[1]!
  for (const { name } of attachments) {
    const entry = new RegExp(`(, )?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\([^()]*\\)(, )?`).exec(list)
    if (entry)
      list = list.slice(0, entry.index) + (entry[1] && entry[2] ? ', ' : '') + list.slice(entry.index + entry[0].length)
  }
  if (list === label[1]) return text
  const head = text.slice(0, label.index).trimEnd()
  return (list ? `${head}\n[attached: ${list}]` : head).trim()
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

/** The console addresses a session by its OUTWARD id (session-concept.md §1.1), so that is what
 *  a read resolves. Current CPs send the authorized owner; the unscoped branch preserves rolling
 *  compatibility only while a newly upgraded daemon is still connected to an old CP. */
async function sessionForRead(store: LocalStore, agentId: string | undefined, sessionId: string) {
  return await store.getSessionByOutwardId(sessionId, agentId)
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

/** The org the reading CP named in the frame — the authoritative partition for a shared pool
 *  store, where a member serves sessions of agents it does not hold and cannot resolve itself. */
export interface SessionReadScope {
  orgId?: string
}

export interface SessionReader {
  list(req: SessionListReq, scope?: SessionReadScope): Promise<SessionListPage>
  history(req: SessionHistoryReq, scope?: SessionReadScope): Promise<SessionHistoryPage>
  toolBody(req: SessionToolBodyReq, scope?: SessionReadScope): Promise<SessionToolBodyChunk>
}

type TranscriptReadStore = Pick<
  LocalStore,
  | 'transcriptTailForAgent'
  | 'transcriptPageForAgentByEventTime'
  | 'transcriptPageForAgent'
  | 'getToolBodyForAgent'
  | 'currentTranscriptRevision'
>

function transcriptPageCursor(page: unknown): number | undefined {
  if (!page || typeof page !== 'object' || !('cursor' in page)) return undefined
  const cursor = (page as { cursor?: unknown }).cursor
  return typeof cursor === 'number' && Number.isSafeInteger(cursor) ? cursor : undefined
}

/**
 * @param threadUrlFor Best-effort platform strategy for legacy/dynamic links that
 *   were not persisted on the session itself (Slack workspace permalinks today).
 *   Absent (or returning undefined) leaves `threadUrl` unset.
 */
export function createSessionReader(
  store: LocalStore,
  threadUrlFor?: (session: SessionRecord) => string | undefined,
  transcriptRead: TranscriptReadStore = store
): SessionReader {
  return {
    async list(req, scope) {
      const rows = await store.listSessions(req.agentId)
      // Title = the ingress/runtime/tool title, else a fallback derived from the
      // session's FIRST user message. Before the agent has a meaningful request to
      // name, this keeps the console better than "Session <id>".
      // firstMessageText only runs for untitled rows (`||` short-circuits).
      const enriched = []
      for (const r of rows) {
        const rawTitle =
          r.title ||
          deriveTitle(
            await store.firstMessageText(
              transcriptChannelKey(r.channel, r.transportScope),
              r.thread,
              r.agentId,
              scope?.orgId
            )
          )
        enriched.push({ r, rawTitle })
      }
      // Display names for every channel + triggering sender + `<@U…>` mention in a
      // title we know one for (daemon-resolved + cached; absent ids just stay raw).
      const names = await store.getDisplayNames(
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
        // A link captured by the ingress wins. The strategy fallback keeps links
        // derivable from live platform identity (Slack workspace URLs) available
        // for legacy rows without moving platform branches into this reader.
        const threadUrl = r.threadUrl ?? threadUrlFor?.(r)
        return {
          // The console addresses what it is shown, and the CP stores the row under this id
          // (session-concept.md §1.1). A row from before the column answers with its ACP id,
          // which is exactly what such a session was reported under.
          sessionId: r.sessionId ?? r.acpSessionId!,
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
    async history(req, scope) {
      const rec = await sessionForRead(store, req.agentId, req.sessionId)
      if (!rec) return { sessionId: req.sessionId, messages: [] }
      const tailing = req.after !== undefined
      const afterRevision = tailing ? Number(req.after) : null
      if (afterRevision !== null && (!Number.isSafeInteger(afterRevision) || afterRevision < 0))
        throw new Error('invalid transcript revision')
      // A platform whose ids order natively can append an OLDER row during warm-thread
      // backfill (Slack's, today — see platforms/message-ordering.ts), so its
      // authoritative history pages by normalized event time + seq tie-breaker. Where
      // ids are opaque, insertion seq IS the only order there is and stays the page
      // walk. A plain numeric cursor came from a pre-upgrade daemon: finish that page
      // walk in legacy seq order to avoid mixing cursor domains mid-request.
      const nativeOrder = hasNativeMessageOrder(rec.platform)
      const eventCursor = decodeEventCursor(req.cursor)
      const numericCursor = req.cursor !== undefined ? Number(req.cursor) : Number.NaN
      const legacyBefore = Number.isSafeInteger(numericCursor) ? numericCursor : null
      const chronological = nativeOrder && (req.cursor === undefined || eventCursor !== null || legacyBefore === null)
      const transcriptChannel = transcriptChannelKey(rec.channel, rec.transportScope)
      // Scope to what THIS agent's session received + produced, not the whole shared
      // (channel, thread) thread — an agent-called session only ever saw the message handed
      // to it (context isolation), so the view must not leak other participants' cross-talk.
      const page =
        afterRevision !== null
          ? await transcriptRead.transcriptTailForAgent(
              transcriptChannel,
              rec.thread,
              rec.agentId,
              afterRevision,
              req.limit,
              scope?.orgId
            )
          : chronological
            ? await transcriptRead.transcriptPageForAgentByEventTime(
                transcriptChannel,
                rec.thread,
                rec.agentId,
                eventCursor,
                req.limit,
                scope?.orgId
              )
            : await transcriptRead.transcriptPageForAgent(
                transcriptChannel,
                rec.thread,
                rec.agentId,
                legacyBefore,
                req.limit,
                scope?.orgId
              )
      const { rows, hasMore } = page
      // rows are newest-first; the page itself is oldest→newest.
      const ordered = tailing ? rows : rows.slice().reverse()
      const projected = ordered.map((row) => ({ row, sender: row.sender }))
      // Display names (cached in the store) for both senders AND `<@U…>` mentions in
      // message bodies; agent-id senders and unresolved ids have no entry, so
      // `senderName` is omitted (UI falls back) and mentions stay as the raw token.
      const names = await store.getDisplayNames(
        projected.flatMap(({ row, sender }) => [sender, ...mentionedUserIds(row.text)])
      )
      const avatars = rec.transportScope
        ? await store.getProfileAvatars(
            rec.transportScope,
            projected.map(({ sender }) => sender)
          )
        : new Map<string, string>()
      const built = projected.map<SessionMessage>(({ row: r, sender }) => {
        const senderName = names.get(sender)
        const senderAvatarUrl = avatars.get(sender)
        const attachments = transcriptAttachments(r.attachmentsJson)
        const base: SessionMessage = {
          seq: r.seq,
          sender,
          ...(senderName ? { senderName } : {}),
          ...(senderAvatarUrl ? { senderAvatarUrl } : {}),
          ...(r.trustedAgentBot ? { trustedAgentBot: true } : {}),
          ts: r.ts,
          ...(r.eventTimeUs ? { eventTimeUs: r.eventTimeUs } : {}),
          ...(r.postId ? { postId: r.postId } : {}),
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
        base.toolCallId = full.toolCallId ?? r.tool_call_id ?? undefined
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
      if (tailing) {
        // A forward page must retain the EARLIEST unseen mutations so its cursor
        // always makes progress without skipping an insert or same-seq update.
        const kept: SessionMessage[] = []
        let acc = 0
        for (const message of built) {
          const enc = encodedBytes(message) + 1
          if (kept.length > 0 && acc + enc > REPLY_BUDGET) break
          kept.push(message)
          acc += enc
        }
        const droppedToBudget = kept.length < built.length
        const liveMore = hasMore || droppedToBudget
        const lastMutationRow = kept.length > 0 ? rows[kept.length - 1] : undefined
        const liveCursor =
          liveMore && lastMutationRow ? lastMutationRow.revision : (transcriptPageCursor(page) ?? afterRevision)
        // Mutation order and display order differ when a warm-thread backfill inserts
        // an older platform message — possible only where message ids order natively.
        // Return a chronological page while the revision cursor above remains anchored
        // to mutation order.
        const rowBySeq = new Map(rows.map((row) => [row.seq, row]))
        kept.sort((a, b) => {
          if (!nativeOrder) return a.seq - b.seq
          const ar = rowBySeq.get(a.seq)
          const br = rowBySeq.get(b.seq)
          return (ar?.eventTimeUs ?? 0) - (br?.eventTimeUs ?? 0) || a.seq - b.seq
        })
        return {
          sessionId: req.sessionId,
          messages: kept,
          liveCursor: String(liveCursor),
          ...(liveMore ? { liveMore: true } : {})
        }
      }
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
        liveCursor: String(
          transcriptPageCursor(page) ?? (await transcriptRead.currentTranscriptRevision(rec.agentId, scope?.orgId))
        ),
        ...(hasOlder && oldestKept
          ? {
              nextCursor:
                chronological && oldestRow
                  ? encodeEventCursor({ eventTimeUs: oldestRow.eventTimeUs, seq: oldestRow.seq })
                  : String(oldestKept.seq)
            }
          : {})
      }
    },
    async toolBody(req, scope) {
      const rec = await sessionForRead(store, req.agentId, req.sessionId)
      const empty: SessionToolBodyChunk = {
        sessionId: req.sessionId,
        toolCallId: req.toolCallId,
        data: '',
        totalBytes: 0
      }
      if (!rec) return empty
      const body = await transcriptRead.getToolBodyForAgent(
        transcriptChannelKey(rec.channel, rec.transportScope),
        rec.thread,
        rec.agentId,
        req.toolCallId,
        scope?.orgId
      )
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
