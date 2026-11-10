// Answers the CP's session/list, session/history, session/thread and session/tool-body REQs from the local store, each REP under the 256 KiB frame cap.
import {
  MAX_FRAME_BYTES,
  SESSION_THREAD_EXCERPT_MAX,
  SESSION_THREAD_PARTICIPANTS_MAX,
  SessionImageAttachment as SessionImageAttachmentSchema,
  computerScreenshotHashesIn
} from '@agentconnect.md/protocol'
import type {
  SessionListReq,
  SessionListPage,
  SessionHistoryReq,
  SessionHistoryPage,
  SessionThreadReq,
  SessionThreadPage,
  SessionThreadSummary,
  SessionToolBodyReq,
  SessionToolBodyChunk,
  SessionMessage,
  SessionUsage,
  ToolBody,
  Platform
} from '@agentconnect.md/protocol'
import {
  parseSharedImageJson,
  transcriptChannelKey,
  type LocalStore,
  type SessionRecord,
  type ThreadRootRow,
  type TranscriptEventCursor,
  type TranscriptRow,
  type TranscriptSessionScope
} from '../store/local-store.js'
import { mentionedUserIds, substituteUserMentions } from '../slack/mentions.js'
import { hasNativeMessageOrder } from '../platforms/message-ordering.js'
import { deriveTitle } from '../session/derive-title.js'
import { displayedSharedImage } from '../webchat/shared-image.js'
import { canonicalPostId } from '../messages/post-id.js'

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

// A row's images, cut to what the requesting CP's response schema admits; the rest stay in its marker.
function transcriptAttachments(
  raw: string | null | undefined,
  max: number
): NonNullable<SessionMessage['attachments']> {
  if (!raw) return []
  try {
    const parsed = SessionImageAttachmentSchema.array().safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data.slice(0, max) : []
  } catch {
    return []
  }
}

// Drop each inlined image's whole entry from the trailing `[attached: …]` marker, by name; other files keep their label.
function withoutAttachmentMention(text: string, attachments: NonNullable<SessionMessage['attachments']>): string {
  if (attachments.length === 0) return text
  const label = /(?:^|\n)\[attached: ([^\n]*)\]$/.exec(text)
  if (!label) return text
  let list = label[1]!
  for (const { name } of attachments) {
    const entry = new RegExp(`(^|, )${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\([^()]*\\)(?=, |$)`).exec(list)
    if (!entry) continue
    const end = entry.index + entry[0].length
    list = entry[1] ? list.slice(0, entry.index) + list.slice(end) : list.slice(end).replace(/^, /, '')
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
function previewBody(full: ToolBody, raw: string): ToolBody {
  const preview: ToolBody = { ...full, truncated: true }
  // Stored screenshot references sit behind the image bytes a trim cuts, so they ride beside the preview.
  const screenshots = full.screenshots ?? computerScreenshotHashesIn(raw)
  if (screenshots.length > 0) preview.screenshots = screenshots
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
  thread(req: SessionThreadReq, scope?: SessionReadScope): Promise<SessionThreadPage>
  toolBody(req: SessionToolBodyReq, scope?: SessionReadScope): Promise<SessionToolBodyChunk>
}

type TranscriptReadStore = Pick<
  LocalStore,
  | 'transcriptTailForAgent'
  | 'transcriptPageForAgentByEventTime'
  | 'transcriptPageForAgent'
  | 'getToolBodyForAgent'
  | 'currentTranscriptRevision'
  | 'threadRootInSession'
  | 'threadPageForAgent'
  | 'threadPageForAgentByEventTime'
  | 'threadTailForAgent'
>

/** One transcript page as the store returns it, newest first (revision order on a forward page). */
interface PageRows {
  rows: TranscriptRow[]
  hasMore: boolean
}

/** The three page walks a read pages by, and the watermark an exhausted one ends at. */
interface PageReads {
  tail(after: number, limit: number): Promise<PageRows>
  byEventTime(before: TranscriptEventCursor | null, limit: number): Promise<PageRows>
  bySeq(before: number | null, limit: number): Promise<PageRows>
  currentRevision(): Promise<number>
}

/** A page's thread summaries: the ids each message names, by index, and those every page of it carries. */
interface PageThreads {
  refs: (readonly string[])[]
  always: readonly string[]
  summaries: Map<string, SessionThreadSummary>
  // A forward page's cursor may not pass this revision: changed threads past it were left for the next poll.
  liveCap?: number
}

type PageThreadsOf = (
  rows: TranscriptRow[],
  built: SessionMessage[],
  after: number | null,
  upto: number | undefined
) => Promise<PageThreads>

/** Each summary rides a page once, paid for by the first kept message naming it, so a page stays under the frame cap. */
function threadBudget(threads: PageThreads | undefined) {
  const carried = new Map<string, SessionThreadSummary>()
  const cost = (ids: readonly string[]): number => {
    let bytes = 0
    for (const id of new Set(ids)) {
      const summary = threads?.summaries.get(id)
      if (summary && !carried.has(id)) bytes += encodedBytes(summary) + 1
    }
    return bytes
  }
  const carry = (ids: readonly string[]): void => {
    for (const id of ids) {
      const summary = threads?.summaries.get(id)
      if (summary) carried.set(id, summary)
    }
  }
  return {
    liveCap: threads?.liveCap,
    carryAlways(): number {
      const bytes = cost(threads?.always ?? [])
      carry(threads?.always ?? [])
      return bytes
    },
    cost: (i: number) => cost(threads?.refs[i] ?? []),
    carry: (i: number) => carry(threads?.refs[i] ?? []),
    // In page order, oldest first, then the changed threads no row names.
    carried: () => {
      if (!threads) return {}
      const order = [...new Set([...threads.refs.flat(), ...threads.always])]
      return { threads: order.flatMap((id) => carried.get(id) ?? []) }
    }
  }
}

/** What one session's reads are scoped to: what THIS agent's session received and produced, never a peer's cross-talk in a shared thread. */
function sessionReadScope(rec: SessionRecord, scope: SessionReadScope | undefined): TranscriptSessionScope {
  return {
    transcriptChannel: transcriptChannelKey(rec.channel, rec.transportScope),
    coordinate: rec.thread,
    sessionKey: rec.key,
    agentId: rec.agentId,
    ...(scope?.orgId !== undefined ? { orgId: scope.orgId } : {})
  }
}

/** The id a root text row names its thread by: a webchat postId, else its platform ts. */
function rootIdOf(row: { ts?: string | null; postId?: string | null }): string | undefined {
  return row.postId ?? row.ts ?? undefined
}

/** A row whose recorded thread is its own, none, or names no other root (a legacy `webchat:<conv>` root) is a root (webchat-threads.md §5.1). */
async function isRootRow(store: LocalStore, scope: TranscriptSessionScope, row: ThreadRootRow): Promise<boolean> {
  if (row.thread === null || row.thread === row.ts || row.thread === row.postId) return true
  return !(await store.threadRootRows(scope, [row.thread])).some((r) => r.seq !== row.seq)
}

/** Whether `rootId` names a root `rec` received, the roots `session/thread` answers for (webchat-threads.md §8). */
export async function sessionReceivedRoot(store: LocalStore, rec: SessionRecord, rootId: string): Promise<boolean> {
  const scope = sessionReadScope(rec, undefined)
  const root = await store.threadRootInSession(scope, rootId)
  return !!root && (await isRootRow(store, scope, root))
}

/** The start of a message on one line, cut to the summary's excerpt length without splitting a surrogate pair. */
function excerptOf(text: string, names: Map<string, string>): string {
  const line = substituteUserMentions(text, names).replace(/\s+/g, ' ').trim()
  if (line.length <= SESSION_THREAD_EXCERPT_MAX) return line
  let end = SESSION_THREAD_EXCERPT_MAX - 1
  const last = line.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end--
  return `${line.slice(0, end)}…`
}

/** The session states in which a turn is running. */
const RUNNING_STATES: ReadonlySet<SessionRecord['state']> = new Set(['prompting', 'cancelling'])

/** At most this many threads changed since `after` ride a forward `roots` page beyond those its rows name. */
const CHANGED_THREADS_MAX = 20

/** The summaries of `rootIds` (webchat-threads.md §5.3); a thread with no reply and no task has none unless `always`. */
async function threadSummaries(
  store: LocalStore,
  rec: SessionRecord,
  scope: TranscriptSessionScope,
  rootIds: readonly string[],
  roots: Map<string, Pick<ThreadRootRow, 'sender' | 'text'>>,
  always = false
): Promise<Map<string, SessionThreadSummary>> {
  const ids = [...new Set(rootIds)]
  const summaries = new Map<string, SessionThreadSummary>()
  if (ids.length === 0) return summaries
  const stats = await store.threadReplyStats(scope, ids, SESSION_THREAD_PARTICIPANTS_MAX)
  const tasks = new Map<string, string>()
  for (const id of ids) {
    const task = await store.assistantSubsessions.taskOfThread(rec.agentId, {
      platform: rec.platform,
      channel: rec.channel,
      transportScope: rec.transportScope ?? null,
      thread: id
    })
    if (task !== undefined) tasks.set(id, task)
  }
  const shown = ids.filter((id) => always || (stats.get(id)?.replies ?? 0) > 0 || tasks.has(id))
  const missing = shown.filter((id) => !roots.has(id))
  for (const row of await store.threadRootRows(scope, missing)) {
    const id = missing.find((m) => m === row.postId || m === row.ts)
    if (id !== undefined && !roots.has(id)) roots.set(id, row)
  }
  const names = await store.getDisplayNames(
    shown.flatMap((id) => {
      const stat = stats.get(id)
      return [
        ...(stat?.participants ?? []),
        ...mentionedUserIds(stat?.latest?.text),
        ...mentionedUserIds(roots.get(id)?.text)
      ]
    })
  )
  const avatars = rec.transportScope
    ? await store.getProfileAvatars(
        rec.transportScope,
        shown.flatMap((id) => stats.get(id)?.participants ?? [])
      )
    : new Map<string, string>()
  const author = (sender: string) => {
    const senderName = names.get(sender)
    const senderAvatarUrl = avatars.get(sender)
    return { sender, ...(senderName ? { senderName } : {}), ...(senderAvatarUrl ? { senderAvatarUrl } : {}) }
  }
  for (const id of shown) {
    const stat = stats.get(id)
    const root = roots.get(id)
    const taskKey = tasks.get(id)
    const row = taskKey !== undefined ? await store.assistantSubsessions.get(rec.agentId, taskKey) : undefined
    const child = taskKey !== undefined ? await store.getSession(taskKey) : undefined
    const owned = row && child?.agentId === rec.agentId ? child : undefined
    summaries.set(id, {
      rootId: id,
      ...(root ? { rootExcerpt: excerptOf(root.text, names) } : {}),
      replies: stat?.replies ?? 0,
      ...(stat?.lastEventTimeUs != null ? { lastReplyAt: new Date(stat.lastEventTimeUs / 1000).toISOString() } : {}),
      ...(stat?.latest
        ? { lastReply: { ...author(stat.latest.sender), excerpt: excerptOf(stat.latest.text, names) } }
        : {}),
      participants: (stat?.participants ?? []).map(author),
      ...(row
        ? {
            task: {
              ...(owned?.sessionId ? { sessionId: owned.sessionId } : {}),
              ...(row.title ? { title: row.title } : {}),
              // A task whose failure report is still on its way has ended, as the Activity view shows it.
              state: row.state === 'reporting' ? ('failed' as const) : row.state
            }
          }
        : {}),
      ...(owned && RUNNING_STATES.has(owned.state) ? { running: true } : {})
    })
  }
  return summaries
}

/** The `roots` view's threads (webchat-threads.md §6.1): marks each reply in a thread with it, and summarizes the roots, the marked threads and, forward, those changed. */
async function rootsViewThreads(
  store: LocalStore,
  rec: SessionRecord,
  scope: TranscriptSessionScope,
  rows: TranscriptRow[],
  built: SessionMessage[],
  after: number | null,
  upto: number | undefined
): Promise<PageThreads> {
  const named = [
    ...new Set(rows.flatMap((r) => (r.thread && r.thread !== r.ts && r.thread !== r.postId ? [r.thread] : [])))
  ]
  const roots = new Map<string, Pick<ThreadRootRow, 'sender' | 'text'>>()
  for (const row of await store.threadRootRows(scope, named)) {
    for (const id of [row.postId, row.ts]) if (id && named.includes(id) && !roots.has(id)) roots.set(id, row)
  }
  const refs = rows.map((r, i): string[] => {
    if (r.thread && roots.has(r.thread) && r.thread !== r.ts && r.thread !== r.postId) {
      built[i]!.thread = r.thread
      return [r.thread]
    }
    // A root handed into a thread stays in the timeline and carries that thread's footer, never one of its own.
    if (r.kind === 'text' && r.handedTo) return [r.handedTo]
    const id = r.kind === 'text' ? rootIdOf(r) : undefined
    if (id !== undefined && !roots.has(id)) roots.set(id, r)
    return id !== undefined ? [id] : []
  })
  const always: string[] = []
  let liveCap: number | undefined
  if (after !== null && upto !== undefined) {
    const changed = await store.threadsChangedBetween(scope, after, upto, CHANGED_THREADS_MAX + 1)
    // More changed than a page carries: the cursor stops before the first left out, which the next poll reports.
    if (changed.length > CHANGED_THREADS_MAX) liveCap = Math.max(after + 1, changed.pop()!.revision - 1)
    for (const { thread } of changed) {
      if (refs.some((ids) => ids.includes(thread))) continue
      const root = await store.threadRootInSession(scope, thread)
      if (!root || !(await isRootRow(store, scope, root))) continue
      roots.set(thread, root)
      always.push(thread)
    }
  }
  const summaries = await threadSummaries(store, rec, scope, [...refs.flat(), ...always], roots)
  return {
    refs,
    always: always.filter((id) => summaries.has(id)),
    summaries,
    ...(liveCap !== undefined ? { liveCap } : {})
  }
}

/** One page of rows through `reads`, projected for display and cut to the frame budget with the thread summaries they name. */
async function readTranscriptPage(
  store: LocalStore,
  rec: SessionRecord,
  req: {
    cursor?: string | undefined
    after?: string | undefined
    limit: number
    imagesPerMessage?: number | undefined
  },
  reads: PageReads,
  threads?: PageThreadsOf
): Promise<Omit<SessionHistoryPage, 'sessionId'>> {
  const tailing = req.after !== undefined
  const afterRevision = tailing ? Number(req.after) : null
  if (afterRevision !== null && (!Number.isSafeInteger(afterRevision) || afterRevision < 0))
    throw new Error('invalid transcript revision')
  // Native-order ids (Slack's) page by event time + seq; opaque ids and a legacy numeric cursor page by seq.
  const nativeOrder = hasNativeMessageOrder(rec.platform)
  const eventCursor = decodeEventCursor(req.cursor)
  const numericCursor = req.cursor !== undefined ? Number(req.cursor) : Number.NaN
  const legacyBefore = Number.isSafeInteger(numericCursor) ? numericCursor : null
  const chronological = nativeOrder && (req.cursor === undefined || eventCursor !== null || legacyBefore === null)
  const page =
    afterRevision !== null
      ? await reads.tail(afterRevision, req.limit)
      : chronological
        ? await reads.byEventTime(eventCursor, req.limit)
        : await reads.bySeq(legacyBefore, req.limit)
  const { rows, hasMore } = page
  // rows are newest-first; the page itself is oldest→newest.
  const ordered = tailing ? rows : rows.slice().reverse()
  const projected = ordered.map((row) => ({ row, sender: row.sender }))
  // Cached names for senders and `<@U…>` mentions; an unresolved id stays raw and omits `senderName`.
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
    const attachments = transcriptAttachments(r.attachmentsJson, req.imagesPerMessage ?? 1)
    const sharedImage = parseSharedImageJson(r.sharedImageJson)
    const base: SessionMessage = {
      seq: r.seq,
      sender,
      ...(senderName ? { senderName } : {}),
      ...(senderAvatarUrl ? { senderAvatarUrl } : {}),
      ...(r.trustedAgentBot ? { trustedAgentBot: true } : {}),
      ts: r.ts,
      ...(r.eventTimeUs ? { eventTimeUs: r.eventTimeUs } : {}),
      ...(r.postId ? { postId: canonicalPostId(r.postId) } : {}),
      ...(r.handedTo && r.kind === 'text' ? { handedTo: r.handedTo } : {}),
      kind: r.kind,
      text: substituteUserMentions(withoutAttachmentMention(r.text, attachments), names),
      ...(attachments.length ? { attachments } : {}),
      ...(sharedImage ? { sharedImage: displayedSharedImage(sharedImage) } : {})
    }
    if (!r.body) return base
    // A user turn's `UserTurnBody` rides inline when it fits; an oversized one drops only the prompt.
    if (r.kind === 'text') {
      const bytes = Buffer.byteLength(r.body)
      if (bytes <= PREVIEW_CAP) {
        base.body = r.body
        return base
      }
      try {
        const { prompt: _prompt, ...facts } = JSON.parse(r.body) as { prompt?: unknown }
        const shrunk = JSON.stringify(facts)
        if (Buffer.byteLength(shrunk) <= PREVIEW_CAP) {
          base.body = shrunk
          base.bodyTruncated = true
          base.bodyBytes = bytes
        }
      } catch {
        // unparseable body → the row's text stands alone
      }
      return base
    }
    // A plan body has no full-body fetch, so an oversized one is dropped and its `Plan · n/m` row stands alone.
    if (r.kind === 'plan') {
      if (Buffer.byteLength(r.body) <= PREVIEW_CAP) base.body = r.body
      return base
    }
    // An elicitation, capability or Fill card's body is the card and has no full-body fetch: inline or not at all.
    if (r.kind === 'elicit' || r.kind === 'capability' || r.kind === 'fill') {
      if (Buffer.byteLength(r.body) <= PREVIEW_CAP) base.body = r.body
      return base
    }
    // An app card's template makes it too large for a page (webchat-mcp-apps.md §8): a shed preview rides, fetched whole by `toolCallId`.
    if (r.kind === 'app') {
      base.toolCallId = r.tool_call_id ?? undefined
      const bytes = Buffer.byteLength(r.body)
      if (bytes <= PREVIEW_CAP) {
        base.body = r.body
        return base
      }
      const preview = previewAppBody(r.body)
      if (preview) {
        base.body = preview
        base.bodyTruncated = true
        base.bodyBytes = bytes
      }
      return base
    }
    if (r.kind !== 'tool') return base
    // A tool row surfaces its id, status and kind, with its body verbatim up to 32 KiB, else a valid-JSON preview.
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
      base.body = JSON.stringify(previewBody(full, r.body))
      base.bodyTruncated = true
      base.bodyBytes = bytes
    }
    return base
  })
  const budget = threadBudget(await threads?.(ordered, built, afterRevision, transcriptPageCursor(page)))
  if (tailing) {
    // A forward page keeps the EARLIEST unseen mutations, so its cursor progresses without skipping one.
    const kept: SessionMessage[] = []
    let acc = budget.carryAlways()
    for (const [i, message] of built.entries()) {
      const enc = encodedBytes(message) + 1 + budget.cost(i)
      if (kept.length > 0 && acc + enc > REPLY_BUDGET) break
      kept.push(message)
      budget.carry(i)
      acc += enc
    }
    const droppedToBudget = kept.length < built.length
    const lastMutationRow = kept.length > 0 ? rows[kept.length - 1] : undefined
    const reached =
      (hasMore || droppedToBudget) && lastMutationRow
        ? lastMutationRow.revision
        : (transcriptPageCursor(page) ?? afterRevision!)
    // Rows past a capped cursor come again on the next poll, as a same-seq update does.
    const capped = budget.liveCap !== undefined && reached > budget.liveCap
    const liveCursor = capped ? budget.liveCap! : reached
    const liveMore = hasMore || droppedToBudget || capped
    // A backfill can insert an older native-order row, so the page is chronological while its cursor stays in mutation order.
    const rowBySeq = new Map(rows.map((row) => [row.seq, row]))
    kept.sort((a, b) => {
      if (!nativeOrder) return a.seq - b.seq
      const ar = rowBySeq.get(a.seq)
      const br = rowBySeq.get(b.seq)
      return (ar?.eventTimeUs ?? 0) - (br?.eventTimeUs ?? 0) || a.seq - b.seq
    })
    return {
      messages: kept,
      liveCursor: String(liveCursor),
      ...(liveMore ? { liveMore: true } : {}),
      ...budget.carried()
    }
  }
  // Keep the NEWEST rows that fit, newest first; a single ≤ 32 KiB preview always fits, so the walk progresses.
  const kept: SessionMessage[] = []
  let acc = budget.carryAlways()
  let droppedToBudget = false
  for (let i = built.length - 1; i >= 0; i--) {
    const m = built[i]!
    const enc = encodedBytes(m) + 1 + budget.cost(i) // + array separator
    if (kept.length > 0 && acc + enc > REPLY_BUDGET) {
      droppedToBudget = true // this row + everything older overflows the frame
      break
    }
    kept.push(m)
    budget.carry(i)
    acc += enc
  }
  kept.reverse() // back to oldest→newest
  // Older rows exist past the store page or the budget; the cursor anchors to the oldest KEPT row in the active order.
  const hasOlder = hasMore || droppedToBudget
  const oldestKept = kept[0]
  const oldestRow = oldestKept ? rows.find((r) => r.seq === oldestKept.seq) : undefined
  return {
    messages: kept,
    liveCursor: String(transcriptPageCursor(page) ?? (await reads.currentRevision())),
    ...(hasOlder && oldestKept
      ? {
          nextCursor:
            chronological && oldestRow
              ? encodeEventCursor({ eventTimeUs: oldestRow.eventTimeUs, seq: oldestRow.seq })
              : String(oldestKept.seq)
        }
      : {}),
    ...budget.carried()
  }
}

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
/**
 * One app card's row, shed until it fits a transcript page (webchat-mcp-apps.md §8).
 *
 * Dropping the template is usually enough, but not always: a tool that answered with tens of KiB
 * of `structuredContent` leaves a card that is still too large with its page already gone. What
 * must survive is the card's IDENTITY — without `appId` and `toolName` the console cannot read the
 * row as a card at all, and a row it cannot read renders as a line of text, which is the card
 * vanishing. So the heavy parts go in order of what the reader can most afford to wait for, and
 * the identity is kept whatever happens; the full body is one fetch away in every case.
 *
 * Null ⇒ the body could not be parsed, and the row's title stands alone. Pure.
 */
export function previewAppBody(body: string): string | null {
  let card: Record<string, unknown>
  try {
    card = JSON.parse(body) as Record<string, unknown>
  } catch {
    return null
  }
  // Heaviest first: the page, then the result the model already received, then the arguments.
  for (const shed of [['html'], ['html', 'toolResult'], ['html', 'toolResult', 'toolInput']]) {
    const lean = { ...card }
    for (const key of shed) delete lean[key]
    const encoded = JSON.stringify(lean)
    if (Buffer.byteLength(encoded) <= PREVIEW_CAP) return encoded
  }
  // Nothing but the card itself. Bounded by the wire schema (three 200-char fields and an enum),
  // so this always fits — a card can be rendered, and everything else is behind the fetch.
  return JSON.stringify({
    appId: card.appId,
    title: card.title,
    toolName: card.toolName,
    ...(card.outcome !== undefined ? { outcome: card.outcome } : {})
  })
}

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
            await store.firstMessageText({
              transcriptChannel: transcriptChannelKey(r.channel, r.transportScope),
              coordinate: r.thread,
              sessionKey: r.key,
              agentId: r.agentId,
              ...(scope?.orgId !== undefined ? { orgId: scope.orgId } : {})
            })
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
      const readScope = sessionReadScope(rec, scope)
      const roots = req.view === 'roots' ? 'roots' : undefined
      const page = await readTranscriptPage(
        store,
        rec,
        req,
        {
          tail: (after, limit) => transcriptRead.transcriptTailForAgent(readScope, after, limit, roots),
          byEventTime: (before, limit) =>
            transcriptRead.transcriptPageForAgentByEventTime(readScope, before, limit, roots),
          bySeq: (before, limit) => transcriptRead.transcriptPageForAgent(readScope, before, limit, roots),
          currentRevision: () => transcriptRead.currentTranscriptRevision(rec.agentId, scope?.orgId)
        },
        roots
          ? (rows, built, after, upto) => rootsViewThreads(store, rec, readScope, rows, built, after, upto)
          : undefined
      )
      return { sessionId: req.sessionId, ...page }
    },
    async thread(req, scope) {
      const empty: SessionThreadPage = { sessionId: req.sessionId, rootId: req.rootId, messages: [] }
      const rec = await sessionForRead(store, req.agentId, req.sessionId)
      if (!rec) return empty
      const readScope = sessionReadScope(rec, scope)
      const root = await transcriptRead.threadRootInSession(readScope, req.rootId)
      if (!root || !(await isRootRow(store, readScope, root))) return empty
      const summaries = await threadSummaries(store, rec, readScope, [req.rootId], new Map([[req.rootId, root]]), true)
      const page = await readTranscriptPage(store, rec, req, {
        tail: (after, limit) => transcriptRead.threadTailForAgent(readScope, req.rootId, after, limit),
        byEventTime: (before, limit) =>
          transcriptRead.threadPageForAgentByEventTime(readScope, req.rootId, before, limit),
        bySeq: (before, limit) => transcriptRead.threadPageForAgent(readScope, req.rootId, before, limit),
        currentRevision: () => transcriptRead.currentTranscriptRevision(rec.agentId, scope?.orgId)
      })
      const summary = summaries.get(req.rootId)
      return { ...empty, ...page, ...(summary ? { summary } : {}) }
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
        {
          transcriptChannel: transcriptChannelKey(rec.channel, rec.transportScope),
          coordinate: rec.thread,
          sessionKey: rec.key,
          agentId: rec.agentId,
          ...(scope?.orgId !== undefined ? { orgId: scope.orgId } : {})
        },
        req.toolCallId
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
