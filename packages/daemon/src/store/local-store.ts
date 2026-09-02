import { randomUUID } from 'node:crypto'
import type { SQLInputValue } from 'node:sqlite'
import { chmodSync, mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  QuotedMessageSchema,
  SessionImageAttachment as SessionImageAttachmentSchema,
  type DreamInfo,
  type ExternalSessionOrigin,
  type QuotedMessage,
  type SessionImageAttachment
} from '@agentconnect.md/protocol'
import type { NoteProjectionOutcome, NoteProjectionPhase, NoteProjectionRow } from '../gitlab/note-projection.js'
import type { ReviewIntentRow } from '../gitlab/review-adapter.js'
import { SESSION_TITLE_TOOL_TITLES } from '../mcp/session-title-tool.js'
import type { ScheduleRun } from '../scheduler/scheduler.js'
import { AsyncMutex } from './async-mutex.js'
import type { StoreRetentionCandidate, StoreRetentionRule } from './retention.js'
import {
  ClusterSkillLedgerSchema,
  type ClusterSkillLedger,
  type ClusterSkillLedgerRecord,
  type ClusterSkillReconcileAuthority
} from './cluster-skill-ledger.js'
import { SqliteAsyncDatabase } from './sqlite-async-database.js'
import type { StoreBatchResult, StoreBatchStatement, StoreDatabase, StoreTx } from './store-database.js'

/** Per-tool-row rawInput budget in the mining prompt — enough for a command
 *  line or path, short enough that N tool rows can't crowd out the store. */
const DREAM_TOOL_INPUT_CHARS = 300

// node:sqlite binds named params as a generic Record and returns rows as
// Record<string, SQLOutputValue>; our row interfaces map by column name but have
// no index signature, so we widen at the DB boundary.
type SqlParams = Record<string, SQLInputValue>

export type { StoreBatchResult, StoreBatchStatement, StoreDatabase } from './store-database.js'

/** One statement bound to its SQL, over the async seam. A call-site convenience, not a cache:
 *  `query` is the seam, and statement caching is an adapter's business. */
export interface StoreStatement {
  run(...params: unknown[]): Promise<{ changes: number }>
  get(...params: unknown[]): Promise<unknown>
  all(...params: unknown[]): Promise<unknown[]>
}

/** The statement surface every LocalStore method uses: the async seam plus `prepare`. */
interface StoreAccess extends StoreTx {
  prepare(sql: string): StoreStatement
}

/** Bind `prepare` onto a statement runner — the backend itself, or a transaction's pinned tx. */
function accessOf(tx: StoreTx): StoreAccess {
  return {
    exec: (sql) => tx.exec(sql),
    query: (sql, params) => tx.query(sql, params),
    batch: (statements) => tx.batch(statements),
    prepare: (sql) => ({
      run: async (...params) => ({ changes: (await tx.query(sql, params)).changes }),
      get: async (...params) => (await tx.query(sql, params)).rows[0],
      all: async (...params) => (await tx.query(sql, params)).rows
    })
  }
}

/** Abandon a transaction without failing the call: `transaction()` rolls back on a throw, and
 *  a site whose guard simply did not hold answers its caller instead of propagating. */
class RollbackSignal extends Error {}

async function rollbackAs<T>(run: Promise<T>, value: T): Promise<T> {
  try {
    return await run
  } catch (error) {
    if (error instanceof RollbackSignal) return value
    throw error
  }
}

/** The facade every LocalStore method uses: draining the coalescing buffer before each
 *  statement is what makes it invisible — no read reaches the database without passing here. */
function drainPendingWritesFirst(backend: StoreDatabase, drain: () => Promise<void>): StoreAccess {
  const access = accessOf(backend)
  const drained = <T>(run: () => Promise<T>): Promise<T> => drain().then(run)
  return {
    exec: (sql) => drained(() => access.exec(sql)),
    query: (sql, params) => drained(() => access.query(sql, params)),
    batch: (statements) => drained(() => access.batch(statements)),
    prepare: (sql) => {
      const statement = access.prepare(sql)
      return {
        run: (...params) => drained(() => statement.run(...params)),
        get: (...params) => drained(() => statement.get(...params)),
        all: (...params) => drained(() => statement.all(...params))
      }
    }
  }
}

/** One coalesced streaming tool-call write, already fenced: `orgId` was resolved when the
 *  update was enqueued, from the same agent the unbuffered write would have resolved it from. */
interface PendingToolWrite {
  orgId: string
  channel: string
  thread: string
  agentId: string
  toolCallId: string
  title: string
  body: string
  bytes: number
}

/** The partition a coalesced write lands in — its notification and revision scope. */
const threadKeyOf = (write: PendingToolWrite): string => [write.orgId, write.channel, write.thread].join('\0')

/** The buffer slot one tool call owns: latest-wins, one entry per call in flight. */
const writeKeyOf = (write: PendingToolWrite): string =>
  [write.orgId, write.channel, write.thread, write.agentId, write.toolCallId].join('\0')

/** How long a streaming tool-call body may sit unwritten. Short enough that a crash loses at
 *  most this much of an in-flight tool body, long enough to swallow a chunk burst. */
const TOOL_WRITE_FLUSH_MS = 200

/** Rows the coalescing buffer may hold — one per tool call in flight — before it flushes early. */
const MAX_PENDING_TOOL_WRITES = 64

/** The bound that actually caps memory: a single body may reach 1 MiB, so counting rows alone
 *  would let 64 of them buffer far more than this. Reaching it flushes early, same as the count. */
const MAX_PENDING_TOOL_WRITE_BYTES = 4 * 1024 * 1024

/** The daemon's agent registry, projected to the org that owns one agent. */
export type OrgForAgent = (agentId: string) => string | undefined

export type LocalStoreSource =
  string | { database: StoreDatabase; shared?: boolean; ownerId?: string; orgForAgent?: OrgForAgent }

/** Transcript org partition of a store no pool shares: it holds exactly one daemon's
 *  threads, so it owns one partition forever, the way `cacheOwnerId` owns one. */
const LOCAL_TRANSCRIPT_ORG = ''

/** How long a shared-store claim survives without renewal. A pool member renews on
 *  every drain attempt, so a lapsed claim means its owner is gone and a peer may take
 *  the row over. Local (single-owner) stores never lease. */
const SHARED_OUTBOX_LEASE_MS = 2 * 60 * 1_000

/** Every column dreamToRow produces must appear here: node:sqlite rejects a bound parameter the
 *  statement never references. triggerKind/createdAt are immutable in practice but are still
 *  assigned, so the row shape and the SQL can't drift apart. */
const DREAM_UPDATE_SET = `status = @status, triggerKind = @triggerKind, sessionIds = @sessionIds,
  snapshotDigest = @snapshotDigest, executionSessionId = @executionSessionId, runtime = @runtime,
  model = @model, stopReason = @stopReason, snapshotWrites = @snapshotWrites, instructions = @instructions,
  skills = @skills, organizationSuggestions = @organizationSuggestions, usage = @usage, error = @error,
  createdAt = @createdAt, endedAt = @endedAt, ownerId = @ownerId`

function idScope(column: string, values: readonly string[] | undefined): { sql: string; params: SqlParams } {
  if (values === undefined) return { sql: '', params: {} }
  if (values.length === 0) return { sql: ' AND 0 = 1', params: {} }
  const params = Object.fromEntries(values.map((value, index) => [`scopeId${index}`, value])) as SqlParams
  return { sql: ` AND ${column} IN (${values.map((_value, index) => `@scopeId${index}`).join(', ')})`, params }
}

/**
 * Normalize the timestamp forms stored in transcript rows onto one epoch-microsecond
 * axis for chronological Slack history reads:
 *
 * - Slack text rows: decimal epoch seconds with up to microsecond precision.
 * - daemon-local activity/replies: integer epoch milliseconds (optionally `local-`).
 * - hook rows: epoch milliseconds with a deterministic `|delivery-id` suffix.
 * - legacy/synthetic integer seconds and ISO timestamps.
 *
 * Unknown/unsafe values fall back to 0. They remain stable via the `seq` tie-breaker
 * and sort before real timestamps instead of blocking an in-place store migration.
 */
export function transcriptEventTimeUs(ts: string | null | undefined): number {
  let raw = ts?.trim() ?? ''
  if (!raw) return 0
  const local = raw.startsWith('local-')
  if (local) raw = raw.slice('local-'.length)
  raw = raw.split('|', 1)[0] ?? ''

  const decimal = /^(\d+)\.(\d+)$/.exec(raw)
  if (decimal) {
    const seconds = BigInt(decimal[1]!)
    const micros = BigInt(decimal[2]!.slice(0, 6).padEnd(6, '0'))
    return safeEventTimeUs(seconds * 1_000_000n + micros)
  }

  if (/^\d+$/.test(raw)) {
    const value = BigInt(raw)
    // Match the console parser: 10-digit-era values are epoch seconds; modern
    // 13-digit values (and every explicit `local-` value) are epoch milliseconds.
    const micros = local || value >= 10_000_000_000n ? value * 1_000n : value * 1_000_000n
    return safeEventTimeUs(micros)
  }

  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) && Number.isSafeInteger(parsed * 1_000) ? parsed * 1_000 : 0
}

function safeEventTimeUs(value: bigint): number {
  return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : 0
}

export interface SessionRecord {
  key: string
  agentId: string
  platform: string
  channel: string
  thread: string
  /** Opaque physical-bot scope for transcript/session lookup isolation. */
  transportScope?: string | null
  /** What the RUNTIME knows this session by, used on the ACP hop alone (§1.1). Null until it exists. */
  acpSessionId: string | null
  /** The session's OUTWARD identity (§1.1), minted when the slot resolves — so it exists before
   *  the runtime does. Null only on a pre-v12 row that had no ACP id to backfill from. */
  sessionId?: string | null
  // §7.3 session lifecycle. `prompting` ⇒ a turn is in flight; `cancelling` ⇒
  // a `!stop` was issued and we're awaiting the agent (with a force backstop);
  // `resuming` ⇒ re-attaching a persisted session after a restart/host eviction;
  // `closed` ⇒ TTL-expired (no activity past agentIdleTimeoutMs).
  state: 'idle' | 'prompting' | 'cancelling' | 'resuming' | 'closed'
  lastDeliveredTs: string | null
  updatedAt: number
  // `!stop` thread mute: 1 ⇒ implicit routing (thread affinity / keyword / auto)
  // must not auto-dispatch this session's thread to the agent; only an explicit
  // @mention clears it. SQLite boolean (0/1); NULL on legacy rows.
  muted?: number | null
  // Platform id of the sender whose message created the session (first-wins;
  // NULL on legacy rows / non-platform sessions). Display-name resolution is a
  // separate `display_names` lookup keyed by this id.
  triggeredBy?: string | null
  // Human-facing session title supplied by an ingress when the session is
  // created, by the runtime (ACP `session_info_update`), or by AgentConnect's
  // `setSessionTitle` tool. Later runtime/tool updates win.
  title?: string | null
  // Platform-native link to the source message/thread. First non-null wins so
  // later messages in the same logical session cannot move the title link.
  threadUrl?: string | null
  // Slack-only chrome: the current in-thread status-bar message ts. One per session
  // so later turns edit the same status line instead of posting duplicates.
  statusBarTs?: string | null
  memoryProvider?: 'none' | 'native' | 'managed' | 'external' | null
  /** Workspace choice pinned when the logical session is created. A manual
   * Playground override is therefore session-local and survives daemon restarts. */
  workspaceIsolation?: 'shared' | 'session' | null
  conversationKind?: 'dm' | 'group_dm' | 'channel' | null
  // Immutable trusted source binding for supported shared input. These fields
  // are metadata only and are echoed on every event/session milestone.
  externalProvider?: string | null
  externalRealmKey?: string | null
  externalResourceKind?: string | null
  externalResourceKey?: string | null
  externalIntegrationId?: string | null
  /** Provider-specific proof retained only so a later event/session retry can
   * re-present the exact direct origin to the CP. */
  externalOriginJson?: string | null
  // Null is legacy/unknown. New rows pin either an external shared input or a
  // non-external origin so a later turn cannot silently change audiences.
  sourceBindingKind?: 'local' | 'external' | null
  /** 1 when this session's coordinates are its own conversation, so a parent link is
   *  lineage only and the CP must not inherit the parent's audience (§4.2). */
  directDestination?: number | null
  // session-concept §5.3: the origin (parent) session's stable acpSessionId, when this session
  // was spawned by another session's `sendMessage` (case 2a / A2A). DURABLE parent link (first-wins):
  // it authorizes this session's SessionTarget replies back to the parent on EVERY turn, not just
  // the waking one — a human-triggered follow-up turn carries no per-turn CallMeta. NULL for roots.
  originSessionId?: string | null
  // Outcome of the LAST completed turn of this session: 'done' when the turn ended cleanly,
  // 'failed' when it ended in a problem phase (agent start failure, ACP/prompt rejection, loop
  // protection). NULL until the session has completed a turn. `state` still decides whether a
  // turn is in flight; this only distinguishes a finished-well from a finished-badly session —
  // it is what `viewSessionStatus` reports as `failed`.
  lastTurnOutcome?: 'done' | 'failed' | null
  // session-concept §5.3 companion of {@link originSessionId}: 1 when the parent woke this
  // session with `toAgent.needsReply`, so the session carries a standing directive to report
  // back into its parent when it finishes or fails. STICKY (never cleared by a later wake that
  // omits it), so the directive survives resume and later human-triggered turns.
  needsParentReply?: number | null
  // The platform module's standing block (`NormalizedMessage.standingContext`), persisted with the
  // logical session (first-wins) so a cold resume or a continuation that reconstructs its message
  // without the bag still re-asserts it. NULL on rows from before it existed and on platforms without one.
  platformStanding?: string | null
}

export type PermissionRequestStatus = 'pending' | 'allowed' | 'denied' | 'expired'

/** Secret-masked editor approval metadata. The live ACP resolver stays in memory;
 * this bounded daemon-local row only powers the Agent page request history. */
export interface PermissionRequestRecord {
  id: string
  agentId: string
  sessionId: string
  createdAt: number
  requesterId: string | null
  requesterName: string | null
  command: string
  status: PermissionRequestStatus
  resolvedAt: number | null
  // Who decided (slack-approval-dm.md §6.1): `user:<id>` / `slack:<teamId>:<userId>`.
  resolvedBy?: string | null
  resolvedByName?: string | null
}

/** A pending approval's posted DM card — the §5.4 handle an orphan rewrite needs. */
export interface PermissionNoticeRow {
  id: string
  agentId: string
  status: PermissionRequestStatus
  command: string
  resolvedByName: string | null
  notifyChannel: string
  notifyTs: string
}

/**
 * Per-session token accounting, folded from the agent's ACP usage stream (mirrors
 * the protocol `SessionUsage`). Token counts are cumulative across turns; context
 * and cost are the latest snapshot. Persisted as JSON in `sessions.usage`.
 */
export interface StoredUsage {
  totalTokens?: number
  inputTokens?: number
  outputTokens?: number
  thoughtTokens?: number
  cachedReadTokens?: number
  cachedWriteTokens?: number
  contextUsed?: number
  contextSize?: number
  costAmount?: number
  costCurrency?: string
}

/** The token counts from `PromptResponse.usage`. Adapter semantics differ: most
 *  runtimes report a session snapshot, while codex-acp currently reports a turn delta. */
export type TokenCounts = Pick<
  StoredUsage,
  'totalTokens' | 'inputTokens' | 'outputTokens' | 'thoughtTokens' | 'cachedReadTokens' | 'cachedWriteTokens'
>

/** Context-window + cost snapshot (from a `usage_update`), latest-wins. */
export type UsageSnapshot = Pick<StoredUsage, 'contextUsed' | 'contextSize' | 'costAmount' | 'costCurrency'>

/** `{}` for an unrecorded or unreadable blob — an unparseable one is not worth failing a turn over. */
function parseUsage(raw: string | null): StoredUsage {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as StoredUsage
  } catch {
    return {}
  }
}

/** CAS attempts before the usage merge writes blind. One session has one writer plus, at most, a
 *  handover peer, so losing four in a row means something other than contention is going on. */
const USAGE_MERGE_ATTEMPTS = 5

/** A session row as read back for `session/list`, carrying the raw usage JSON. */
export interface SessionListRow extends SessionRecord {
  usage: string | null
}

/**
 * What an entry captures:
 *  - `text`      — a conversational message (human inbound, or an agent reply/result
 *                  posted to the platform). Carries the platform message `ts`, and is
 *                  the ONLY kind replayed as cross-agent context (§8.5).
 *  - `tool`      — an agent tool invocation (label). Audit/UI only.
 *  - `reasoning` — an agent's coalesced thinking block. Audit/UI only.
 *  - `plan`      — the turn's task list (one upserted row, `Plan · n/m` label). Audit/UI only.
 * `tool`/`reasoning`/`plan` are recorded for EVERY turn regardless of the agent's Slack
 * output mode — output mode only gates what reaches the platform, never the transcript.
 * Only `text` and `tool` rows ever rebuild model context; the other two are read-only history.
 */
export type TranscriptKind = 'text' | 'tool' | 'reasoning' | 'plan'

export interface TranscriptEntry {
  channel: string
  thread: string
  // Platform message ts for `text`; a daemon wall-clock stamp for internal events
  // (`tool`/`reasoning`). Slack console history normalizes both forms onto eventTimeUs;
  // prompt replay still compares the original platform `ts`.
  ts: string
  sender: string
  /** Canonical webchat post id (merged-conversation-view.md §6): minted once at
   *  origin, identical on every participant's copy regardless of a
   *  collision-bumped `ts`. Text rows only; absent everywhere else. */
  postId?: string
  /** Provider-authoritative event time (epoch µs) for the normalized
   *  chronological axis — platforms whose message ids carry no time
   *  (Telegram/Feishu) supply it from the message's own send time. Computed
   *  from `ts` when absent. */
  eventTimeUs?: number
  /** True only when the daemon verified that this Slack history row came from an
   *  AgentConnect-managed bot identity. Legacy rows and all other platforms omit it. */
  trustedAgentBot?: boolean
  /** This arrival carries the message's FINAL text and may overwrite an earlier row on
   *  the same coordinates.
   *
   *  A streamed reply is posted before it is finished, so the post that lands first can
   *  hold a prefix; the closing edit is the same Slack message (same `ts`, so the same
   *  row) and is the authoritative version. Without this the plain INSERT OR IGNORE would
   *  keep the prefix forever, since a text row has no other update path. */
  authoritative?: boolean
  kind: TranscriptKind
  text: string
  /** JSON `UserTurnBody` on a text row — the model prompt when it differs from `text`, plus the
   *  platform facts the console formats. Tool and plan rows write their own bodies elsewhere. */
  body?: string | null
  /** Bounded inline webchat images. Persisted daemon-side; never provider-backed files. */
  attachments?: SessionImageAttachment[]
  /** Bounded provider-supplied reply source used only when rebuilding model context.
   *  It is stored beside the conversational row but never exposed as transcript text. */
  quoted?: QuotedMessage
  /** Durable SQLite representation populated on reads. Callers should normally write
   *  `quoted`; retaining this field on read-back entries makes replay/reconciliation
   *  preserve the sidecar without adding it to the user-visible message contract. */
  quoteJson?: string | null
  /** The agent this row was delivered TO (an inbound trigger / replayed context), when
   *  known. Absent for an agent's own output rows (those attribute via `sender`) and for
   *  unrouted messages. Lets the console session view show what one agent actually
   *  received + produced instead of the whole shared (channel, thread) thread. */
  recipient?: string
  /** Names the org that owns this row when neither `sender` nor `recipient` is an agent —
   *  an inbound observed before routing picks one. Attribution only: never a column, and
   *  never a delivery, so it cannot widen any agent's scoped view. */
  orgAgentId?: string
}

/** A transcript row as read back (raw `SELECT *`), including its insertion-order sequence. */
export interface TranscriptRow extends TranscriptEntry {
  seq: number
  /** Monotonic mutation watermark; changes when a stable row is updated in place. */
  revision: number
  /** Normalized epoch microseconds used by chronological Slack history pagination. */
  eventTimeUs: number
  tool_call_id?: string | null // the one snake_case column; readers never alias it. NULL off tool rows
  attachmentsJson?: string | null // JSON.stringify(SessionImageAttachment[]); inline webchat only
}

/** The text the model reads for a transcript row: the persisted prompt behind a text row when it
 *  carries one, else the row's own text. Fail-closed like the quote sidecar — a malformed body
 *  from an older schema or a corrupt store must never turn arbitrary JSON into prompt context. */
export function transcriptPromptText(entry: Pick<TranscriptEntry, 'kind' | 'text' | 'body'>): string {
  if (entry.kind !== 'text' || !entry.body) return entry.text
  try {
    const parsed: unknown = JSON.parse(entry.body)
    const prompt = (parsed as { prompt?: unknown } | null)?.prompt
    if (typeof prompt === 'string') return prompt
  } catch {
    // fall through — the row's text stands
  }
  return entry.text
}

/** Decode daemon-private quote metadata fail-closed. Local DB corruption or a row from
 * an older schema must never turn arbitrary JSON into prompt context. */
export function transcriptQuoted(entry: Pick<TranscriptEntry, 'quoted' | 'quoteJson'>): QuotedMessage | undefined {
  if (entry.quoted?.text) return entry.quoted
  if (!entry.quoteJson) return undefined
  try {
    const parsed = QuotedMessageSchema.safeParse(JSON.parse(entry.quoteJson))
    return parsed.success && parsed.data.text ? parsed.data : undefined
  } catch {
    return undefined
  }
}

export interface TranscriptEventCursor {
  eventTimeUs: number
  seq: number
}

export interface TranscriptMutation {
  channel: string
  thread: string
  agentIds: string[]
  revision: number
}

export function sessionKey(
  platform: string,
  channel: string,
  thread: string,
  agentId: string,
  transportScope?: string | null
): string {
  const base = `${platform}:${channel}:${thread}:${agentId}`
  return transportScope ? `${base}:${transportScope}` : base
}

/** Internal transcript namespace. Platform-visible coordinates remain raw on the
 * session row and wire; only local transcript storage uses the physical-bot scope. */
export function transcriptChannelKey(channel: string, transportScope?: string | null): string {
  return transportScope ? `${channel}\u001f${transportScope}` : channel
}

/**
 * The per-agent delivery scope shared by every agent-scoped transcript read: a
 * row is visible to an agent when the agent SENT it (`sender`), was the row's
 * first-recorded recipient (`recipient`), or the message was delivered to it
 * per `transcript_recipient` (which captures deliveries the text-row dedup
 * would otherwise drop when several co-daemon agents catch up on the same
 * message). The delivery-table match is gated on `kind = 'text'` because
 * internal rows (reasoning/tool) are not deduped by ts and can share a ts with
 * a delivered text row. Binds three parameters: (agentId, agentId, agentId).
 */
const AGENT_DELIVERY_SCOPE_SQL = `(sender = ? OR recipient = ? OR (transcript.kind = 'text' AND EXISTS (
        SELECT 1 FROM transcript_recipient tr
        WHERE tr.orgId = transcript.orgId AND tr.channel = transcript.channel AND tr.thread = transcript.thread
          AND tr.ts = transcript.ts AND tr.agentId = ?)))`

/**
 * A durably-persisted admitted-but-not-yet-completed inbox message (§6.9 #353). Holds the
 * bits needed to reconstruct a QueueEntry's DispatchContext on replay — everything EXCEPT
 * the live `resolve`/`reject` (freshly minted by the replay `dispatch()`) and the webchat
 * `sink` (non-persistable; webchat turns are never written here). `msg`/`callMeta` are JSON.
 */
export interface InboxRow {
  /** Stable deliveryId/msgId (§6.3) — the row PK, idempotent against re-append/replay. */
  id: string
  sessionKey: string
  agentId: string
  /** JSON.stringify(NormalizedMessage). */
  msg: string
  integrationId?: string | null
  /** JSON.stringify(CallMeta), or null for non-agent-call turns. */
  callMeta?: string | null
  /** JSON.stringify(HookDispatchContext), or null for ordinary turns. This is
   * daemon-private trusted metadata; prompt excerpts remain in `msg`. */
  hookContext?: string | null
  /** Single-attempt GitHub final-poster state, durable across daemon restart. */
  posterPublishState?: 'not_started' | 'in_flight' | 'settled' | null
  /** A redacted, metadata-only HookReport retained as the durable dedup receipt
   * after the model turn finishes. Completed hook rows are never replayed. */
  terminalReport?: string | null
  /** Daemon entitled to emit the retained report — the dispatch the CP will accept
   *  it from. NULL on a local store and on rows written before pool ownership. */
  reportOwnerId?: string | null
  /** Epoch (ms) the owner last renewed its claim; a lapsed claim is takeable. */
  reportClaimedAt?: number | null
  completedAt?: number | null
  isQueueCmd?: number | null
  /** 1 once this delivery no longer needs replay accounting (charged when applicable).
   *  Legacy rows migrate as 0 and are upgraded on their first successful admission. */
  loopGuardCounted?: number | null
  /** Monotonic decimal string — FIFO order within a sessionKey. */
  enqueuedAt: string
}

/** How long a terminal (admitted / transcript-only) rendezvous record is retained past
 *  its expiry before being swept. Long enough that a late retry still reads back its
 *  `childSessionId` instead of opening a second session, short enough that a busy
 *  channel's table stays bounded. */

/**
 * One activation rendezvous record (send-message-routing-rework.md §8.6).
 *
 * A paired `toAgent + channel` send produces TWO observations of ONE logical delivery:
 * an internal wake carrying the complete trusted call envelope, and the visible platform
 * post the peer's daemon also receives. They can arrive in either order and, cross-daemon,
 * over different transports. This record is what makes them one admission instead of two
 * — or, worse, an admission built from whichever arrived first.
 *
 * The asymmetry between the two halves is deliberate. The internal wake is the semantic
 * AUTHORITY: only it carries lineage, correlation, `needsReply`, hop depth, external
 * origin, and privacy gates. The platform event contributes provider-authenticated
 * coordinates and the transcript observation — correlation, never authority. Hence a
 * platform-first record can be claimed `pending` but can NEVER reach `admitted` without
 * `callEnvelope`: dispatching an envelope-less child would silently invent a lineage-less
 * session in place of the call the caller actually made.
 */
export interface ActivationRecord {
  /** `platform + transportScope + platformMessageId + targetAgentId` — one logical
   *  delivery to one target. Including the target is what lets a single visible post
   *  addressing several agents admit each of them exactly once. */
  activationKey: string
  /** Daemon-minted pairing id from the visible half of a `toAgent + channel` send. */
  agentCallDeliveryId?: string | null
  /** The provider-authenticated visible observation, once seen. */
  platformMessageId?: string | null
  /** Transcript coordinates the visible observation was recorded at, so the later half
   *  reconciles onto the SAME row instead of duplicating the hand-off. */
  transcriptCoordinates?: string | null
  /** JSON.stringify of the trusted call envelope (the internal wake's payload). Absent
   *  until the authoritative half arrives; its presence is the admission precondition. */
  callEnvelope?: string | null
  /** `pending` — claimed, not dispatched. `admitted` — dispatched exactly once; retries
   *  read back `childSessionId` rather than dispatching again. `transcript-only` — the
   *  terminal state of a pairing whose envelope never arrived (§3.2): recorded and
   *  reported as a delivery failure, never downgraded into an envelope-less child. */
  state: 'pending' | 'admitted' | 'transcript-only'
  childSessionId?: string | null
  expiresAt: number
}

/** Durable conversation-wide loop guard. A non-null `trippedAt` is a latched
 *  circuit: daemon restart must not silently re-open it. The two counters let the
 *  daemon use a lower threshold for turns that did not originate from a verified
 *  human while retaining a high, last-resort cap for every admission. */
export interface LoopGuardRow {
  scopeKey: string
  windowStartedAt: number
  totalCount: number
  automaticWindowStartedAt: number
  automaticCount: number
  trippedAt?: number | null
  reason?: string | null
}

export interface LoopGuardVerdict {
  allowed: boolean
  trippedNow: boolean
  totalCount: number
  automaticCount: number
  reason?: string
}

/** One retention-GC receipt (#485) owed to the CP: this daemon deleted the
 *  session's local content and the CP has not yet acknowledged the report. */
export interface SessionPurgeRow {
  agentId: string
  /** The ACP session id — the only session identity the CP knows. */
  sessionId: string
  reason: string
  purgedAt: number
}

/** One latest-wins session metadata snapshot awaiting the CP's commit ACK. */
export interface SessionMetadataOutboxRow {
  agentId: string
  sessionId: string
  revision: number
  snapshot: string
  queuedAt: number
  failedAttempts: number
  nextAttemptAt: number | null
}

/**
 * One daemon-local external-memory capture. The conversation body never leaves
 * this table except through the selected plugin data plane; CP frames and logs
 * carry only metadata/facts. `operationId` is stable across restart/retry.
 */
export interface MemoryCaptureOutboxRow {
  operationId: string
  turnId: string
  agentId: string
  connectionId: string
  /** Fences an old turn from a replacement backend/config at the same id. */
  connectionRevision: number
  pluginId: string
  manifestDigest?: string | null
  /** Non-secret connection config captured with the turn. */
  config: string
  scopeKey: string
  sessionId?: string | null
  input: string
  output: string
  /** Hash of the unredacted semantic payload, retained for body-free dedup. */
  payloadHash: string
  payloadBytes: number
  idempotency: 'operation-id' | 'none'
  state: 'pending' | 'sending' | 'accepted' | 'completed' | 'failed' | 'ambiguous'
  attempts: number
  backendOperationId?: string | null
  reasonCode?: string | null
  nextAttemptAt: number
  createdAt: number
  updatedAt: number
}

export interface MemoryCaptureOutboxStats {
  activeCount: number
  activeBytes: number
  oldestActiveAt?: number
}

/** Durable, non-secret record of a CP remote webchat MCP grant authority held by
 *  this daemon (no token material). `active` tracks a live descriptor; `revoking`
 *  rows form a revocation outbox: a `webchat/mcp-grant/revoke` that could not
 *  reach the CP must survive reconnects and restarts rather than leaving a
 *  remotely usable credential to age out on its own. */
export interface WebchatMcpGrantLedgerRow {
  conversationId: string
  agentId: string
  authorityId: string
  authorityGeneration: number
  state: 'active' | 'revoking'
  reason: string | null
  attempts: number
  nextAttemptAt: number | null
  updatedAt: number
  /** The daemon incarnation answerable for this row; NULL on an exclusively owned store. */
  ownerId: string | null
}

/** The stored §16 run-projection write marker, as the column types present it. */
interface CodeHostNoteProjectionRow {
  projectionKey: string
  projectionId: string
  hookId: string
  agentId: string
  orgId: string | null
  provider: string
  projectId: string
  mergeRequestIid: number
  headSha: string
  generation: string
  writeMarker: string
  state: string
  body: string
  noteId: string | null
  credentialEpoch: string
  phase: string
  outcome: string | null
  code: string | null
  updatedAt: number
  daemonId: string
  ownerId: string | null
}

const NOTE_PROJECTION_PHASES: readonly NoteProjectionPhase[] = ['in_flight', 'settled_unreported', 'settled']
const NOTE_PROJECTION_OUTCOMES: readonly NoteProjectionOutcome[] = ['written', 'skipped', 'failed']

function toNoteProjectionRow(row: CodeHostNoteProjectionRow): NoteProjectionRow {
  const outcome = NOTE_PROJECTION_OUTCOMES.find((o) => o === row.outcome)
  return {
    projectionKey: row.projectionKey,
    projectionId: row.projectionId,
    hookId: row.hookId,
    agentId: row.agentId,
    ...(row.orgId ? { orgId: row.orgId } : {}),
    provider: row.provider,
    projectId: row.projectId,
    mergeRequestIid: row.mergeRequestIid,
    headSha: row.headSha,
    generation: row.generation,
    writeMarker: row.writeMarker,
    state: row.state as NoteProjectionRow['state'],
    body: row.body,
    ...(row.noteId ? { noteId: row.noteId } : {}),
    credentialEpoch: row.credentialEpoch,
    daemonId: row.daemonId,
    // An unknown phase reads as fully settled: it can neither be rewritten nor replayed.
    phase: NOTE_PROJECTION_PHASES.find((p) => p === row.phase) ?? 'settled',
    ...(outcome ? { outcome } : {}),
    ...(row.code ? { code: row.code } : {})
  }
}

/** One upsert for both projection phases: the row is identical, only the phase and outcome differ. */
const NOTE_PROJECTION_UPSERT = `INSERT INTO code_host_note_projection
   (projectionKey, projectionId, hookId, agentId, orgId, provider, projectId, mergeRequestIid, headSha,
    generation, writeMarker, state, body, noteId, credentialEpoch, phase, outcome, code, updatedAt,
    daemonId, ownerId)
 VALUES (@projectionKey, @projectionId, @hookId, @agentId, @orgId, @provider, @projectId, @mergeRequestIid,
    @headSha, @generation, @writeMarker, @state, @body, @noteId, @credentialEpoch, @phase, @outcome, @code,
    @now, @daemonId, @ownerId)
 ON CONFLICT (projectionKey) DO UPDATE SET
   projectionId = excluded.projectionId, hookId = excluded.hookId, agentId = excluded.agentId,
   orgId = excluded.orgId, provider = excluded.provider, projectId = excluded.projectId,
   mergeRequestIid = excluded.mergeRequestIid, headSha = excluded.headSha,
   generation = excluded.generation, writeMarker = excluded.writeMarker, state = excluded.state,
   body = excluded.body, noteId = excluded.noteId, credentialEpoch = excluded.credentialEpoch,
   phase = excluded.phase, outcome = excluded.outcome, code = excluded.code,
   updatedAt = excluded.updatedAt, daemonId = excluded.daemonId, ownerId = excluded.ownerId`

function noteProjectionParams(row: NoteProjectionRow, now: number, ownerId: string | null): SqlParams {
  return {
    projectionKey: row.projectionKey,
    projectionId: row.projectionId,
    hookId: row.hookId,
    agentId: row.agentId,
    orgId: row.orgId ?? null,
    provider: row.provider,
    projectId: row.projectId,
    mergeRequestIid: row.mergeRequestIid,
    headSha: row.headSha,
    generation: row.generation,
    writeMarker: row.writeMarker,
    state: row.state,
    body: row.body,
    noteId: row.noteId ?? null,
    credentialEpoch: row.credentialEpoch,
    now,
    daemonId: row.daemonId,
    ownerId
  }
}

/** §3.4/§6.8 main-agent orchestration record (daemon-local). `status` is the
 *  orchestration-level lifecycle; per-subtask status lives on {@link SubtaskRow}. */
export interface OrchestrationRow {
  orchestrationId: string
  mainSessionKey: string
  mainAgentId: string
  platform: string
  channel: string
  thread: string
  integrationId?: string | null
  /** Where the main should post its human-facing summary (opaque to the daemon). */
  replyTarget?: string | null
  /** Deadline epoch (ms) — the durable SoT for the one-shot cron. NULL ⇒ no deadline. */
  deadline?: number | null
  status: 'active' | 'done' | 'cancelled'
  createdAt: number
  updatedAt: number
}

/** One subtask of an orchestration. `correlationId` = `<orchestrationId>.<idx>` is the
 *  stable delivery/report correlation key (§3.3). */
export interface SubtaskRow {
  orchestrationId: string
  correlationId: string
  idx: number
  toAgentId: string
  text: string
  status: 'pending' | 'sending' | 'delivered' | 'succeeded' | 'worker_error' | 'timed_out'
  result?: string | null
  /** Typed reason on a failed delivery (`self` for postless/unpaired self-wakes, or not_allowed/not_local/no_agent/offline). */
  deliveryReason?: string | null
  updatedAt: string
}

/** Runtime-level model-catalog metadata (runtime-model-catalog.md §4). `fingerprint`
 *  is the discovery generation (runtime id + probed version + launch definition);
 *  `complete` flips true only after one FULL successful discovery, so the §3.3
 *  discovery gate can tell "never fully discovered" from "last-good on file". */
export interface RuntimeCatalogMetaRecord {
  runtimeId: string
  fingerprint: string
  source: 'native' | 'acp'
  /** Resolved concrete default-model id (absent when only a literal "default" was seen). */
  defaultModel?: string
  /** Runtime-level (model-independent) permission modes from the probe session. */
  permissionModes?: Array<{ value: string; name?: string; description?: string }>
  /** The mode select's currentValue on a fresh probe session — the runtime's default. */
  defaultPermissionMode?: string
  complete: boolean
  /** Hash of the probed models[] at the last complete discovery (gate rule 3). */
  modelsHash?: string
  observedAt: number
}

/** One model's cached capability row. `caps` stores only normalized RAW advertised
 *  values — daemon-synthesized effort tiers are augmented at report time, never here. */
export interface RuntimeModelCapRecord {
  runtimeId: string
  modelId: string
  fingerprint: string
  caps: {
    name?: string
    efforts?: Array<{ value: string; name?: string; description?: string }>
    defaultEffort?: string
    fastMode?: boolean
  }
  observedAt: number
}

/**
 * Narrow an existing path's mode, mirroring `cli/login.ts:protectCredentialsFile`.
 * Best-effort by design: Windows has no enforceable POSIX mode semantics, and a
 * path that vanished (WAL siblings appear lazily) is not an error worth failing a
 * daemon boot over.
 */
function restrictPath(path: string, mode: number): void {
  try {
    if ((statSync(path).mode & 0o777) !== mode) chmodSync(path, mode)
  } catch {
    // absent, or a platform without POSIX modes — nothing to narrow
  }
}

/**
 * Schema version a freshly created database is stamped with. Bump it in the same
 * change that edits a `CREATE TABLE` below, and append the matching step to
 * {@link SCHEMA_MIGRATIONS}. Appending a step WITHOUT bumping this leaves the step
 * unreachable — `upgradeSchema` stops at this number — so the column exists only on
 * fresh databases and every established one fails at query time. `SCHEMA_MIGRATIONS`
 * asserts the two stay in lockstep for exactly that reason.
 */
const SCHEMA_VERSION = 16

/**
 * Ordered in-place upgrades for a store created by an EARLIER daemon.
 *
 * This store lives on the user's machine and holds their transcripts, sessions and
 * durable inbox — it is upgraded in place, never recreated, and a daemon is a
 * long-lived install that can be several versions behind. `CREATE TABLE IF NOT
 * EXISTS` never alters an existing table, so a schema change that ships without a
 * step here leaves the new column missing on every pre-existing database and fails
 * at query time rather than at boot.
 *
 * Step `i` upgrades a database at `user_version === i + 1` to `i + 2`; each runs
 * exactly once, in order, inside one transaction, and all of them run BEFORE the
 * constructor's `CREATE` block. A fresh database is stamped straight to
 * {@link SCHEMA_VERSION} and skips the list, because the `CREATE` block always
 * emits the current schema.
 *
 * A step only needs to reshape what already exists — add a column, rewrite a
 * table, backfill. Plain `CREATE TABLE`/`CREATE INDEX` for anything new belongs
 * in the `CREATE` block, which runs afterwards and is `IF NOT EXISTS`, so it
 * covers fresh and upgraded stores from the one description.
 */
/** How long a probed image's published answer outlives its last publish. A rollback inside the
 *  window costs nothing; past it, one member probes the image again. */
const RUNTIME_IMAGE_PROBE_RETENTION_MS = 30 * 24 * 60 * 60_000

const SCHEMA_MIGRATIONS: ((db: StoreTx, store: { shared: boolean }) => Promise<void>)[] = [
  async (db) => await db.exec('ALTER TABLE permission_requests ADD COLUMN ownerId TEXT'),
  async (db) =>
    await db.exec(`
      ALTER TABLE session_metadata_outbox ADD COLUMN failedAttempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE session_metadata_outbox ADD COLUMN nextAttemptAt INTEGER;
    `),
  async (db) =>
    await db.exec(`
      ALTER TABLE dreams ADD COLUMN ownerId TEXT;
      ALTER TABLE webchat_mcp_grant_ledger ADD COLUMN ownerId TEXT;
    `),
  async (db) =>
    await db.exec(`
      ALTER TABLE inbox ADD COLUMN reportOwnerId TEXT;
      ALTER TABLE inbox ADD COLUMN reportClaimedAt INTEGER;
    `),
  // session_gates gains the owning agent in its key. Existing rows are attributed
  // through the sessions row that holds the ACP id; a row no session claims is
  // dropped, and an id several agents claim is rewritten to the fail-closed state
  // because its stored verdict was never attributable to one of them.
  async (db) =>
    await db.exec(`
      CREATE TABLE session_gates_keyed (
        agentId TEXT NOT NULL,
        acpSessionId TEXT NOT NULL,
        localExcluded INTEGER NOT NULL DEFAULT 1,
        cpPrivate INTEGER,
        cpRev INTEGER NOT NULL DEFAULT 0,
        updatedAt INTEGER,
        PRIMARY KEY (agentId, acpSessionId)
      );
      INSERT INTO session_gates_keyed (agentId, acpSessionId, localExcluded, cpPrivate, cpRev, updatedAt)
      SELECT o.agentId, g.acpSessionId, g.localExcluded, g.cpPrivate, g.cpRev, g.updatedAt
      FROM session_gates g
      JOIN (
        SELECT DISTINCT agentId, acpSessionId FROM sessions
        WHERE agentId IS NOT NULL AND acpSessionId IS NOT NULL
      ) o ON o.acpSessionId = g.acpSessionId;
      UPDATE session_gates_keyed SET localExcluded = 1, cpPrivate = NULL, cpRev = 0
      WHERE acpSessionId IN (
        SELECT acpSessionId FROM session_gates_keyed GROUP BY acpSessionId HAVING COUNT(*) > 1
      );
      DROP TABLE session_gates;
      ALTER TABLE session_gates_keyed RENAME TO session_gates;
    `),
  async (db) => await db.exec('ALTER TABLE cron_runs ADD COLUMN definition TEXT'),
  // The catalog cache is re-keyed on its owning member (#1039): pre-owner rows name none, so
  // they are dropped rather than misattributed and the CREATE block rebuilds both tables.
  async (db) =>
    await db.exec(`
      DROP TABLE IF EXISTS runtime_catalog_meta;
      DROP TABLE IF EXISTS runtime_model_catalog;
    `),
  async (db) =>
    await db.exec(`
      ALTER TABLE session_purges ADD COLUMN ownerId TEXT;
      ALTER TABLE session_purges ADD COLUMN claimedAt INTEGER;
    `),
  async (db) =>
    await db.exec(`
      ALTER TABLE session_metadata_outbox ADD COLUMN ownerId TEXT;
      ALTER TABLE session_metadata_outbox ADD COLUMN claimedAt INTEGER;
    `),
  // Transcripts gain the owning org in their key (#1041 item 7). A store no pool shares
  // holds one daemon's threads, so every existing row belongs to its single partition and
  // the added default IS the backfill. A shared store cannot attribute what it already
  // holds: nothing here records an agent's org — the daemon learns it from the CP at
  // runtime — so sessions → agent → org resolves to nothing at migration time and the rows
  // are dropped rather than misfiled into one org's fenced reads. Only test data exists on
  // any shared store today, which is why dropping is the accepted price of the fence.
  // The recipient table is rebuilt rather than altered: its PRIMARY KEY gains the org, and
  // the transcript indexes are dropped so the CREATE block re-emits them org-first.
  async (db, store) => {
    if (store.shared) await db.exec('DELETE FROM transcript; DELETE FROM transcript_recipient;')
    await db.exec(`
      ALTER TABLE transcript ADD COLUMN orgId TEXT NOT NULL DEFAULT '';
      DROP INDEX IF EXISTS transcript_thread_seq;
      DROP INDEX IF EXISTS transcript_text_ts;
      DROP INDEX IF EXISTS transcript_agent_tool_call;
      DROP INDEX IF EXISTS transcript_thread_event_time;
      DROP INDEX IF EXISTS transcript_thread_revision;
      CREATE TABLE transcript_recipient_orged (
        orgId TEXT NOT NULL, channel TEXT NOT NULL, thread TEXT NOT NULL, ts TEXT NOT NULL, agentId TEXT NOT NULL,
        PRIMARY KEY (orgId, channel, thread, ts, agentId)
      );
      INSERT INTO transcript_recipient_orged (orgId, channel, thread, ts, agentId)
      SELECT '', channel, thread, ts, agentId FROM transcript_recipient;
      DROP TABLE transcript_recipient;
      ALTER TABLE transcript_recipient_orged RENAME TO transcript_recipient;
    `)
  },
  // The outward id (§1.1), split from the ACP hop's. Existing sessions are backfilled with the id
  // they already answer to, so nothing the CP or the console knows changes name.
  async (db) =>
    await db.exec(`
      ALTER TABLE sessions ADD COLUMN sessionId TEXT;
      UPDATE sessions SET sessionId = acpSessionId WHERE acpSessionId IS NOT NULL;
      CREATE TABLE IF NOT EXISTS session_outward_ids (
        key TEXT PRIMARY KEY,
        agentId TEXT,
        sessionId TEXT NOT NULL,
        mintedAt INTEGER NOT NULL
      );
    `),
  // Whether a child session's coordinates are its OWN conversation (§4.2). Left null on
  // existing rows: absent keeps the CP's ordinary child inheritance, which is what they got.
  async (db) => await db.exec('ALTER TABLE sessions ADD COLUMN directDestination INTEGER'),
  // Cluster skill tables are emitted by the current CREATE block after this step.
  async () => undefined,
  // Approval decisions record who decided, and a DM card's handle survives a restart
  // so an orphaned card can be rewritten (slack-approval-dm.md §5.4/§6.1).
  async (db) =>
    await db.exec(`
      ALTER TABLE permission_requests ADD COLUMN resolvedBy TEXT;
      ALTER TABLE permission_requests ADD COLUMN resolvedByName TEXT;
      ALTER TABLE permission_requests ADD COLUMN notifyIntegrationId TEXT;
      ALTER TABLE permission_requests ADD COLUMN notifyChannel TEXT;
      ALTER TABLE permission_requests ADD COLUMN notifyTs TEXT;
    `),
  // The platform standing block travels with the logical session, not only the message that opened it.
  async (db) => await db.exec('ALTER TABLE sessions ADD COLUMN platformStanding TEXT')
]

// The list and the version are two halves of one fact: step `i` moves a database from
// `user_version === i + 1` to `i + 2`, so the last step must land exactly on SCHEMA_VERSION.
// A step appended without the bump is silently dead code — the failure mode that shipped
// `directDestination` to fresh databases only, and broke every established one at query time.
if (SCHEMA_MIGRATIONS.length !== SCHEMA_VERSION - 1) {
  throw new Error(
    `local store schema is inconsistent: ${SCHEMA_MIGRATIONS.length} migration step(s) cannot reach v${SCHEMA_VERSION}`
  )
}

export class LocalStore {
  /** The backend as given. Only the tool-write flush uses it directly; everything else goes
   *  through `db`, which drains that buffer first. */
  private readonly backend: StoreDatabase
  private readonly db: StoreAccess
  /** The backend without the drain, for the transcript write path: that path holds the mutex a
   *  flush also needs, so a statement inside it must never try to flush. */
  private readonly lockedDb: StoreAccess
  private readonly shared: boolean
  private readonly ownerId: string | undefined
  /** Partition key for per-member cache rows; a single-daemon store owns one partition forever. */
  private readonly cacheOwnerId: string
  /** Set only on a shared store, where transcript rows of several orgs share one table. */
  private readonly orgForAgent: OrgForAgent | undefined
  private transcriptRevision = 0
  private transcriptMutationListener?: (mutation: TranscriptMutation) => void | Promise<void>
  private readonly pendingToolWrites = new Map<string, PendingToolWrite>()
  private pendingToolWriteBytes = 0
  private toolWriteTimer?: ReturnType<typeof setTimeout>
  /** Serializes the transcript write path. Async execution lets two turns interleave between a
   *  method's statements, and these rows and the in-memory revision must stay in lockstep. */
  private readonly transcriptMutex = new AsyncMutex()

  private constructor(
    backend: StoreDatabase,
    options: { shared: boolean; ownerId: string | undefined; orgForAgent: OrgForAgent | undefined }
  ) {
    this.backend = backend
    this.db = drainPendingWritesFirst(backend, () => this.drainToolCallWrites())
    this.lockedDb = accessOf(backend)
    this.shared = options.shared
    this.ownerId = options.ownerId
    this.orgForAgent = options.orgForAgent
    this.cacheOwnerId = this.ownerId ?? ''
  }

  /**
   * Open a store and bring its schema to {@link SCHEMA_VERSION}. Two-phase construction because
   * every step of that sequence is awaited now; the ordering it keeps is the load-bearing part.
   */
  static async open(source: LocalStoreSource): Promise<LocalStore> {
    // This database holds every platform message body, agent reply, tool payload and
    // durable inbox blob the daemon has seen — the same material the console serves
    // behind authorization. Every other secret-bearing artifact the daemon writes is
    // explicitly 0600/0700 (config.json, agent.json, materialized config-file secrets,
    // runtime homes, evaluation artifacts); this one inherited the umask, so on a host
    // where the root pre-exists group/other-readable — a container image `mkdir -p`, a
    // systemd `StateDirectory=` (0755), an operator-created path — a second local
    // account could read the lot. Restrict the directory and the database explicitly,
    // and chmod after creation so a loose umask cannot widen either.
    let store: LocalStore
    if (typeof source === 'string') {
      const dir = dirname(source)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      restrictPath(dir, 0o700)
      store = new LocalStore(SqliteAsyncDatabase.open(source), {
        shared: false,
        ownerId: undefined,
        orgForAgent: undefined
      })
      await store.db.exec('PRAGMA journal_mode = WAL')
      // WAL mode publishes two siblings alongside the database; they carry the same
      // rows, so restricting only the main file would leave the content readable.
      for (const p of [source, `${source}-wal`, `${source}-shm`]) restrictPath(p, 0o600)
    } else {
      const shared = source.shared === true
      if (shared && !source.ownerId) throw new Error('shared LocalStore requires an ownerId')
      if (shared && !source.orgForAgent) throw new Error('shared LocalStore requires an orgForAgent resolver')
      store = new LocalStore(source.database, {
        shared,
        ownerId: source.ownerId,
        orgForAgent: source.orgForAgent
      })
    }
    await store.initializeSchema()
    return store
  }

  private async initializeSchema(): Promise<void> {
    // Decided BEFORE the CREATE block, which is what makes an empty file
    // indistinguishable from an old one a moment later.
    const freshDatabase =
      ((await this.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get()) as { n: number })
        .n === 0
    await this.upgradeSchema(freshDatabase)
    const schema = `
      CREATE TABLE IF NOT EXISTS sessions (
        key TEXT PRIMARY KEY, agentId TEXT, platform TEXT, channel TEXT, thread TEXT,
        transportScope TEXT, acpSessionId TEXT, sessionId TEXT, state TEXT, lastDeliveredTs TEXT, updatedAt INTEGER,
        usage TEXT, muted INTEGER, triggeredBy TEXT, title TEXT, threadUrl TEXT, modelOverride TEXT,
        observedModel TEXT, observedModelSet INTEGER NOT NULL DEFAULT 0,
        effortOverride TEXT, permissionModeOverride TEXT, fastModeOverride INTEGER,
        outputModeOverride TEXT, statusBarTs TEXT, memoryProvider TEXT, workspaceIsolation TEXT,
        originSessionId TEXT, lastTurnOutcome TEXT, needsParentReply INTEGER,
        externalProvider TEXT, externalRealmKey TEXT, externalResourceKind TEXT,
        externalResourceKey TEXT, externalIntegrationId TEXT, externalOriginJson TEXT,
        sourceBindingKind TEXT, directDestination INTEGER,
        -- session-visibility.md §4.1: persisted so EVERY event/session re-emit
        -- carries them, not just the one dispatch that knew the message.
        conversationKind TEXT, tenantScope TEXT, launchCorrelationId TEXT,
        platformStanding TEXT
      );
      -- A !stop can arrive while a cold session is still materializing, before the
      -- sessions row exists. Keep the mute independently keyed so that stop survives a
      -- daemon restart and is applied when the session row is eventually created.
      CREATE TABLE IF NOT EXISTS session_mutes (
        key TEXT PRIMARY KEY
      );
      -- Per-session memory-capture gate (session-visibility.md §5.1). Keyed by
      -- (agentId, acpSessionId), NOT the logical session key: the CP addresses
      -- sessions by the id it knows, and its push can arrive before (or after a
      -- resume recreates) the sessions row — so this table stands alone, like
      -- session_mutes. The agent is part of the key because ACP session ids are
      -- runtime-local: on a pool's shared store every agent of every org can hold
      -- an acp-1, and one org's push must never answer for another org's gate.
      --   localExcluded: the daemon-local initial verdict (DM/webchat/launch/A2A).
      --   cpPrivate    : the CP-confirmed bit; authoritative once it is set.
      --   cpRev        : the CP's durable visibilityRev — the dedup/order key.
      -- (localExcluded, not "excluded": SQLite's upsert pseudo-table owns that name.)
      CREATE TABLE IF NOT EXISTS session_gates (
        agentId TEXT NOT NULL,
        acpSessionId TEXT NOT NULL,
        localExcluded INTEGER NOT NULL DEFAULT 1,
        cpPrivate INTEGER,
        cpRev INTEGER NOT NULL DEFAULT 0,
        updatedAt INTEGER,
        PRIMARY KEY (agentId, acpSessionId)
      );
      -- Latest-wins session metadata awaiting a correlated CP persistence ACK.
      -- This is deliberately separate from sessions: an upgrade starts with an
      -- empty outbox and never treats historical session rows as pending work.
      -- On a shared pool store ownerId / claimedAt lease each snapshot to one
      -- member the way inbox.reportOwnerId and session_purges.ownerId do.
      CREATE TABLE IF NOT EXISTS session_metadata_outbox (
        agentId TEXT NOT NULL,
        sessionId TEXT NOT NULL,
        revision INTEGER NOT NULL,
        snapshot TEXT NOT NULL,
        queuedAt INTEGER NOT NULL,
        failedAttempts INTEGER NOT NULL DEFAULT 0,
        nextAttemptAt INTEGER,
        ownerId TEXT,
        claimedAt INTEGER,
        PRIMARY KEY (agentId, sessionId)
      );
      CREATE INDEX IF NOT EXISTS session_metadata_outbox_fifo
        ON session_metadata_outbox (queuedAt);
      CREATE INDEX IF NOT EXISTS session_metadata_outbox_attempt
        ON session_metadata_outbox (nextAttemptAt, queuedAt);
      -- Outward session ids minted BEFORE their session row exists — a credential is issued to
      -- start the runtime, and the turn writes the session only once it dispatches (§1.1). The
      -- insert adopts the mint, so this table holds only what has not become a session yet: an
      -- in-flight slot, or an internal:* key (dream / memory / commit) that never will.
      CREATE TABLE IF NOT EXISTS session_outward_ids (
        key TEXT PRIMARY KEY,
        agentId TEXT,
        sessionId TEXT NOT NULL,
        mintedAt INTEGER NOT NULL
      );
      -- Retention-GC receipts (#485): sessions this daemon has already deleted
      -- locally, still owed to the CP as an event/session-purged report. Durable
      -- because the local row is GONE — unlike every other D→C report, an
      -- unacknowledged receipt cannot be re-derived from daemon state later, so
      -- losing it would leave the console rendering a permanently empty transcript
      -- with no explanation. Rows are dropped only on the CP's ACK.
      -- Keyed by (agentId, sessionId): ACP session ids are runtime-local, so two
      -- agents can both have purged an acp-1. On a shared pool store ownerId /
      -- claimedAt lease each receipt to one member the way inbox.reportOwnerId does.
      CREATE TABLE IF NOT EXISTS session_purges (
        agentId TEXT NOT NULL,
        sessionId TEXT NOT NULL,
        reason TEXT NOT NULL,
        purgedAt INTEGER NOT NULL,
        ownerId TEXT,
        claimedAt INTEGER,
        PRIMARY KEY (agentId, sessionId)
      );
      CREATE INDEX IF NOT EXISTS session_purges_fifo ON session_purges (purgedAt);
      -- Minted durable tenant scopes for platforms that expose none (§2).
      CREATE TABLE IF NOT EXISTS tenant_scopes (
        integrationId TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        createdAt INTEGER
      );
      -- Platform id → human display name (Slack channel/user names, daemon-resolved
      -- and cached here so session read-back can label ids without a Slack call).
      CREATE TABLE IF NOT EXISTS display_names (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, updatedAt INTEGER
      );
      -- Platform id → public provider-hosted profile image. Kept separate from
      -- display_names because a provider may expose an avatar without a name.
      CREATE TABLE IF NOT EXISTS profile_avatars (
        transportScope TEXT NOT NULL, id TEXT NOT NULL, url TEXT NOT NULL, updatedAt INTEGER,
        PRIMARY KEY (transportScope, id)
      );
      -- Where a conversation id SITS: its enclosing channel (a Discord thread's parent
      -- channel — a session keys on the thread id, so the reachable channel it belongs
      -- to is otherwise unrecoverable) and its enclosing space (the Discord guild, whose
      -- name a reported channel row carries so a bot in several servers stays legible).
      -- Backs observed-channel collapsing: threads fold onto their channel, whose
      -- snowflake is the uniqueness key of a reported row. isIm (1/0) records that the
      -- conversation is a DM: the sessions table cannot tell a DM from a group, so
      -- without it observed discovery reports a DM as a channel row named "@someone".
      CREATE TABLE IF NOT EXISTS channel_scopes (
        id TEXT PRIMARY KEY, parentId TEXT, spaceId TEXT, isIm INTEGER, updatedAt INTEGER
      );
      -- Conversations this daemon must stop REPORTING: the bot left, or an operator
      -- forgot the row. Needed because the observed set of a platform that cannot
      -- enumerate is derived from SESSION HISTORY, which knows nothing about leaving —
      -- so without a durable marker the next refresh rebuilds the row from old
      -- sessions and silently undoes the departure. Survives restart for the same
      -- reason: the history it is suppressing is itself durable.
      CREATE TABLE IF NOT EXISTS retracted_conversations (
        integrationId TEXT NOT NULL, channelId TEXT NOT NULL, retractedAt INTEGER NOT NULL,
        PRIMARY KEY (integrationId, channelId)
      );
      CREATE TABLE IF NOT EXISTS permission_requests (
        id TEXT PRIMARY KEY,
        agentId TEXT NOT NULL,
        sessionId TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        requesterId TEXT,
        requesterName TEXT,
        command TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'allowed', 'denied', 'expired')),
        resolvedAt INTEGER,
        ownerId TEXT,
        resolvedBy TEXT,
        resolvedByName TEXT,
        notifyIntegrationId TEXT,
        notifyChannel TEXT,
        notifyTs TEXT
      );
      CREATE INDEX IF NOT EXISTS permission_requests_agent_created
        ON permission_requests (agentId, createdAt DESC);
      -- orgId fences every thread on the org that owns it (#1041 item 7): a pool's shared
      -- store carries several orgs' threads, and platform channel/thread ids are only
      -- unique WITHIN one of them. A store no pool shares holds one org and stores ''.
      CREATE TABLE IF NOT EXISTS transcript (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        orgId TEXT NOT NULL DEFAULT '',
        channel TEXT NOT NULL, thread TEXT NOT NULL, ts TEXT,
        sender TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
        tool_call_id TEXT, body TEXT, recipient TEXT, eventTimeUs INTEGER,
        attachmentsJson TEXT, quoteJson TEXT, trustedAgentBot INTEGER, revision INTEGER NOT NULL DEFAULT 0,
        postId TEXT
      );
      CREATE INDEX IF NOT EXISTS transcript_thread_seq ON transcript (orgId, channel, thread, seq);
      -- Dedup conversational rows by platform ts (double-fired inbound / redelivery);
      -- internal events have no platform ts and are intentionally never deduped here.
      CREATE UNIQUE INDEX IF NOT EXISTS transcript_text_ts
        ON transcript (orgId, channel, thread, ts) WHERE kind = 'text';
      -- Per-agent DELIVERY of a shared thread message. The transcript row itself is deduped
      -- by (orgId, channel, thread, ts), so the recipient column only records the FIRST agent a
      -- message reached; when several agents on one daemon each catch up on the same message
      -- their deliveries are recorded here so no agent's scoped session view (transcriptPage-
      -- ForAgent) hides a message it actually received.
      CREATE TABLE IF NOT EXISTS transcript_recipient (
        orgId TEXT NOT NULL DEFAULT '',
        channel TEXT NOT NULL, thread TEXT NOT NULL, ts TEXT NOT NULL, agentId TEXT NOT NULL,
        PRIMARY KEY (orgId, channel, thread, ts, agentId)
      );
      -- ACP tool ids are session-local, so same-thread agents may legitimately reuse
      -- them; the uniqueness that matters is per agent.
      CREATE UNIQUE INDEX IF NOT EXISTS transcript_agent_tool_call
        ON transcript (orgId, channel, thread, sender, tool_call_id) WHERE tool_call_id IS NOT NULL;
      -- Chronological history key: rows carry both an insertion-order seq and an
      -- event time, and the console reads in event-time order.
      CREATE INDEX IF NOT EXISTS transcript_thread_event_time
        ON transcript (orgId, channel, thread, eventTimeUs DESC, seq DESC);
      -- Stable-row updates need a cursor independent of insertion-order seq.
      CREATE INDEX IF NOT EXISTS transcript_thread_revision
        ON transcript (orgId, channel, thread, revision);
      -- Written ONLY by an exclusively owned store: a shared store's members would each
      -- serialize their own map over this one row, so they do not persist here at all.
      CREATE TABLE IF NOT EXISTS cp_routing (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        routingEpoch INTEGER, assignments TEXT, globalRules TEXT
      );
      -- Authoritative last-run per cron (protocol §5.4 — missed-fire compensation).
      -- key = "<agentId>:<cronId>" (cron defs themselves live in agent.json).
      -- The definition column fingerprints the entry the stamp was written under (#1031): schedules are
      -- edited in place, so a stamp is only comparable to a fire of the SAME definition. NULL on
      -- rows written before it existed, which simply makes them ineligible for a catch-up.
      CREATE TABLE IF NOT EXISTS cron_runs (
        key TEXT PRIMARY KEY, lastRunAt INTEGER NOT NULL, definition TEXT
      );
      -- The dream half of cron_runs (#1031): a dream schedule's only durable last-fired, so a
      -- handover can tell a swallowed occurrence from one that already ran. One row per agent.
      CREATE TABLE IF NOT EXISTS dream_runs (
        agentId TEXT PRIMARY KEY, lastRunAt INTEGER NOT NULL, definition TEXT
      );
      -- §6.9 #353 durable inbox: an ADMITTED-but-QUEUED message persisted BEFORE the
      -- admission ACK, so a hard kill / agent move can't lose a message the caller was
      -- already told delivered:true. Replayed FIFO-by-sessionKey on startup and removed
      -- on every terminal path (success / reject / cancel / gate-drop). The id column is the
      -- message's STABLE deliveryId/msgId (§6.3) so re-append and replay are idempotent
      -- against the existing admission-idempotency maps. Webchat turns are NOT persisted
      -- here (their live sink can't be restored — see §6.9 #367). enqueuedAt is a
      -- monotonic decimal string (fixed-width ⇒ string order == numeric order) driving
      -- FIFO within a sessionKey.
      CREATE TABLE IF NOT EXISTS inbox (
        id TEXT PRIMARY KEY,
        sessionKey TEXT NOT NULL,
        agentId TEXT NOT NULL,
        msg TEXT NOT NULL,
        integrationId TEXT,
        callMeta TEXT,
        hookContext TEXT,
        posterPublishState TEXT,
        terminalReport TEXT,
        reportOwnerId TEXT,
        reportClaimedAt INTEGER,
        completedAt INTEGER,
        isQueueCmd INTEGER,
        loopGuardCounted INTEGER NOT NULL DEFAULT 0,
        enqueuedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS inbox_fifo ON inbox (sessionKey, enqueuedAt);
      -- External-memory capture is reply-after-delivery and eventually
      -- consistent. Persist the bounded observation before any plugin call so a
      -- daemon restart cannot lose it. Bodies stay daemon-local; CP sees only
      -- body-free connection facts/metrics.
      CREATE TABLE IF NOT EXISTS memory_capture_outbox (
        operationId TEXT PRIMARY KEY,
        turnId TEXT NOT NULL,
        agentId TEXT NOT NULL,
        connectionId TEXT NOT NULL,
        connectionRevision INTEGER NOT NULL CHECK (connectionRevision > 0),
        pluginId TEXT NOT NULL,
        manifestDigest TEXT,
        config TEXT NOT NULL,
        scopeKey TEXT NOT NULL,
        sessionId TEXT,
        input TEXT NOT NULL,
        output TEXT NOT NULL,
        payloadHash TEXT NOT NULL,
        payloadBytes INTEGER NOT NULL CHECK (payloadBytes >= 0),
        idempotency TEXT NOT NULL CHECK (idempotency IN ('operation-id', 'none')),
        state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'accepted', 'completed', 'failed', 'ambiguous')),
        attempts INTEGER NOT NULL CHECK (attempts >= 0),
        backendOperationId TEXT,
        reasonCode TEXT,
        nextAttemptAt INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS memory_capture_turn
        ON memory_capture_outbox (agentId, connectionId, turnId);
      CREATE INDEX IF NOT EXISTS memory_capture_due
        ON memory_capture_outbox (state, nextAttemptAt, createdAt);
      -- Remote webchat MCP grant authorities held by this daemon (non-secret —
      -- token plaintext stays in process memory only). See WebchatMcpGrantLedgerRow.
      CREATE TABLE IF NOT EXISTS webchat_mcp_grant_ledger (
        conversationId TEXT PRIMARY KEY,
        agentId TEXT NOT NULL,
        authorityId TEXT NOT NULL,
        authorityGeneration INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'revoking')),
        reason TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        nextAttemptAt INTEGER,
        updatedAt INTEGER NOT NULL,
        ownerId TEXT                      -- daemon incarnation holding the grant; NULL on an exclusively owned store
      );
      CREATE INDEX IF NOT EXISTS webchat_mcp_grant_ledger_due
        ON webchat_mcp_grant_ledger (state, nextAttemptAt);
      -- send-message-routing-rework.md §8.6: the durable rendezvous that collapses the
      -- internal wake and the visible platform echo of ONE paired agent-call delivery
      -- into one admission. Durable rather than in-memory because the two halves may be
      -- separated by a restart, and because an already-admitted key must keep answering
      -- retries with the SAME childSessionId instead of opening a second session.
      CREATE TABLE IF NOT EXISTS activation_rendezvous (
        activationKey TEXT PRIMARY KEY,
        agentCallDeliveryId TEXT,
        platformMessageId TEXT,
        transcriptCoordinates TEXT,
        callEnvelope TEXT,
        -- The durable inbox row id this claim's dispatch will write, recorded AT CLAIM
        -- TIME so a crash in the dispatch window is reconcilable rather than guessable:
        -- the sweep can ask whether the turn is durably queued instead of assuming.
        dispatchId TEXT,
        state TEXT NOT NULL CHECK (state IN ('pending', 'admitted', 'transcript-only')),
        childSessionId TEXT,
        expiresAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS activation_rendezvous_expiry
        ON activation_rendezvous (state, expiresAt);
      -- Conversation-wide spam/feedback-loop circuit. Unlike the in-memory dedup
      -- caches, this latch survives a daemon restart, so durable inbox replay cannot
      -- re-ignite a conversation that was already stopped by loop protection.
      CREATE TABLE IF NOT EXISTS loop_guard (
        scopeKey TEXT PRIMARY KEY,
        windowStartedAt INTEGER NOT NULL,
        totalCount INTEGER NOT NULL,
        automaticWindowStartedAt INTEGER NOT NULL,
        automaticCount INTEGER NOT NULL,
        trippedAt INTEGER,
        reason TEXT
      );
      -- §3.4/§6.8 main-agent orchestration: a main agent fans out N subtasks to
      -- worker agents, then waits asynchronously and summarizes. The record is
      -- persisted BEFORE any delivery (record-first — a fast worker's reply must
      -- never arrive before the record exists, else §3.3 correlation drops it).
      -- daemon-local (never on the CP hot path); the deadline epoch is the durable
      -- SoT for the one-shot cron re-armed on startup. status: active|done|cancelled.
      CREATE TABLE IF NOT EXISTS orchestration (
        orchestrationId TEXT PRIMARY KEY,
        mainSessionKey TEXT NOT NULL,
        mainAgentId TEXT NOT NULL,
        -- The main's session coords, stored explicitly (not parsed from mainSessionKey,
        -- whose channel/thread may contain ':') so the deadline fire wakes the exact session.
        platform TEXT NOT NULL,
        channel TEXT NOT NULL,
        thread TEXT NOT NULL,
        integrationId TEXT,
        replyTarget TEXT,
        deadline INTEGER,
        status TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS orchestration_active ON orchestration (status);
      -- One row per subtask. Stable correlationId = "<orchestrationId>.<idx>" is the
      -- delivery/report correlation key (§3.3). State machine (§6.8):
      --   pending → sending → delivered → succeeded | worker_error | timed_out
      -- busy/offline are RETRYABLE attempt states folded back to a delivery failure.
      -- Transitions are CAS + idempotent on (orchestrationId, correlationId).
      CREATE TABLE IF NOT EXISTS orchestration_subtask (
        orchestrationId TEXT NOT NULL,
        correlationId TEXT NOT NULL,
        idx INTEGER NOT NULL,
        toAgentId TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        deliveryReason TEXT,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (orchestrationId, correlationId)
      );
      CREATE INDEX IF NOT EXISTS orchestration_subtask_by_orch
        ON orchestration_subtask (orchestrationId, idx);
      -- Self-introduce-on-join (issue #536). channel_intro is the durable set of
      -- channels an agent has already introduced itself into (or adopted as the
      -- silent baseline), so an intro fires at most once per (agent, platform,
      -- channel) across restarts. channel_intro_seed marks that an integration's
      -- FIRST channel snapshot has been baselined — until then every listed channel
      -- is adopted silently, so a restart / re-list never storms peers.
      CREATE TABLE IF NOT EXISTS channel_intro (
        agentId TEXT NOT NULL, platform TEXT NOT NULL, channel TEXT NOT NULL,
        introducedAt INTEGER,
        PRIMARY KEY (agentId, platform, channel)
      );
      CREATE TABLE IF NOT EXISTS channel_intro_seed (
        integrationId TEXT PRIMARY KEY, seededAt INTEGER NOT NULL
      );
      -- Runtime model-catalog cache (runtime-model-catalog.md §4): last-good discovery
      -- results, hydrated synchronously at boot so the first facts/daemon-runtimes frame
      -- carries the previous models + capability matrix instead of an empty REPLACE.
      -- Failures never clear rows; models are pruned only after a COMPLETE successful
      -- discovery. complete stays 0 on phase-1 probe writes so the discovery gate
      -- can tell "never fully discovered" from "last-good on file".
      -- ownerId leads both keys (#1039): the cache describes an image, so on a store every
      -- pool member shares, two rollout generations would re-probe and prune each other.
      -- The last slash-command list each agent's runtime advertised (ACP
      -- available_commands_update), so a daemon restart/upgrade does not blind the
      -- console's skill picker until the next session happens to start.
      CREATE TABLE IF NOT EXISTS runtime_commands (
        agentId TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        updatedAt TEXT NOT NULL,          -- ISO timestamp of the advertisement
        payload TEXT NOT NULL             -- JSON RuntimeCommand[]
      );
      CREATE TABLE IF NOT EXISTS runtime_catalog_meta (
        ownerId TEXT NOT NULL DEFAULT '', -- the owning member; '' is the single-daemon store
        runtimeId TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        source TEXT NOT NULL,             -- 'native' | 'acp'
        defaultModel TEXT,
        permissionModes TEXT,             -- JSON [{value, name?}]
        defaultPermissionMode TEXT,       -- mode select currentValue on a fresh probe session
        complete INTEGER NOT NULL DEFAULT 0,
        modelsHash TEXT,                  -- hash of probed models[] at last complete discovery
        observedAt INTEGER NOT NULL,
        PRIMARY KEY (ownerId, runtimeId)
      );
      -- The pool-wide runtime probe's published answer, keyed on the runtime IMAGE it describes
      -- (docs/designs/daemon-detailed-design.md §2.6). One member claims a key and probes; every
      -- member reads the payload and advertises it, so a pool runs ONE probe sandbox rather than
      -- one per replica. The image is the key because that is what the answer is about: a template
      -- bump is a different row, and no member can be served a previous image's models.
      CREATE TABLE IF NOT EXISTS runtime_image_probe (
        imageRef TEXT PRIMARY KEY,
        claimedBy TEXT,                   -- member currently probing; the claim goes stale on its own
        claimedAt INTEGER,
        probedAt INTEGER,                 -- when a payload landed; NULL while only claimed
        payload TEXT                      -- JSON {table, results} — the image table and probe results
      );
      CREATE TABLE IF NOT EXISTS runtime_model_catalog (
        ownerId TEXT NOT NULL DEFAULT '',
        runtimeId TEXT NOT NULL,
        modelId TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        capsJson TEXT NOT NULL,           -- JSON {name?, efforts?: [{value,name?,description?}], defaultEffort?, fastMode?}
        observedAt INTEGER NOT NULL,
        PRIMARY KEY (ownerId, runtimeId, modelId)
      );
      -- Memory dream jobs (docs/designs/memory-dreaming.md §4). METADATA ONLY —
      -- staged store bodies live on disk under <agent-root>/memory-dreams/ and
      -- never enter this DB. Column shapes mirror protocol DreamInfo; the JSON
      -- columns hold its array/object fields verbatim.
      CREATE TABLE IF NOT EXISTS dreams (
        dreamId TEXT PRIMARY KEY,
        agentId TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN
          ('pending', 'running', 'completed', 'failed', 'canceled', 'adopted', 'discarded', 'superseded')),
        triggerKind TEXT NOT NULL,
        sessionIds TEXT NOT NULL,         -- JSON string[]
        snapshotDigest TEXT NOT NULL,
        executionSessionId TEXT,
        runtime TEXT,
        model TEXT,
        stopReason TEXT,
        snapshotWrites TEXT,              -- JSON {total, nonDistill} write-ledger marks
        instructions TEXT,
        skills TEXT,                      -- JSON DreamSkillInfo[]
        organizationSuggestions TEXT,     -- JSON DreamOrganizationSuggestionInfo[] (metadata only)
        usage TEXT,                       -- JSON DreamUsage (tokens/cost + bounded byte counts)
        error TEXT,                       -- JSON {type, message}
        createdAt TEXT NOT NULL,
        endedAt TEXT,
        ownerId TEXT                      -- daemon incarnation running it; NULL on an exclusively owned store
      );
      CREATE INDEX IF NOT EXISTS dreams_agent_created ON dreams (agentId, createdAt DESC);
      -- Monotonic shim-binding generation per agent. Durable and install-shared because a sandbox
      -- pod outlives the daemon holding it: a member that restarted the count would dial below the
      -- generation that pod already bound, which its shim refuses for the rest of the pod's life.
      CREATE TABLE IF NOT EXISTS sandbox_generations (
        agentId TEXT PRIMARY KEY,
        generation INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS duty_write_fence (
        groupId TEXT PRIMARY KEY,
        term TEXT NOT NULL,
        daemonId TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cluster_skill_ledger (
        agentId TEXT NOT NULL,
        workspaceIncarnation TEXT NOT NULL,
        revision INTEGER NOT NULL,
        ledger TEXT NOT NULL,
        PRIMARY KEY (agentId, workspaceIncarnation)
      );
      CREATE TABLE IF NOT EXISTS cluster_skill_journal (
        agentId TEXT NOT NULL,
        workspaceIncarnation TEXT NOT NULL,
        operationId TEXT NOT NULL,
        groupId TEXT NOT NULL,
        term TEXT NOT NULL,
        daemonId TEXT NOT NULL,
        priorRevision INTEGER NOT NULL,
        desiredHash TEXT NOT NULL,
        replayKey TEXT,
        state TEXT NOT NULL CHECK (state IN ('applying', 'applied')),
        resultLedger TEXT,
        PRIMARY KEY (agentId, workspaceIncarnation)
      );
      -- gitlab-com-integration.md §16 run projection: the write marker this daemon persists BEFORE
      -- every provider mutation. An 'in_flight' row surviving a restart is reconciled by listing the
      -- merge request's notes and matching the hidden marker, never by replaying the write. A
      -- 'settled_unreported' row holds a definite outcome the control plane has not acknowledged yet:
      -- it is replayed until acked, so a dropped result cannot wedge the control plane's write mutex.
      CREATE TABLE IF NOT EXISTS code_host_note_projection (
        projectionKey TEXT PRIMARY KEY,
        projectionId TEXT NOT NULL,
        hookId TEXT NOT NULL,
        agentId TEXT NOT NULL,
        orgId TEXT,
        provider TEXT NOT NULL,
        projectId TEXT NOT NULL,
        mergeRequestIid INTEGER NOT NULL,
        headSha TEXT NOT NULL,
        generation TEXT NOT NULL,
        writeMarker TEXT NOT NULL,
        state TEXT NOT NULL,
        body TEXT NOT NULL,
        noteId TEXT,
        credentialEpoch TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('in_flight', 'settled_unreported', 'settled')),
        outcome TEXT,                     -- the definite outcome awaiting acknowledgement
        code TEXT,                        -- its normalized reason code
        updatedAt INTEGER NOT NULL,
        -- The STABLE daemon identity the control plane dispatches to, not a process incarnation: a
        -- restarted daemon must find its own unfinished writes, and the control plane keeps an
        -- ambiguous marker on that identity, so no peer is ever dispatched to finish them.
        daemonId TEXT NOT NULL,
        ownerId TEXT                      -- process incarnation that started the write; informational only
      );
      CREATE INDEX IF NOT EXISTS code_host_note_projection_pending
        ON code_host_note_projection (daemonId, phase, updatedAt);
      -- Daemon-local secrets that must survive a restart. Nothing here authenticates to a peer:
      -- the only entry today is the formal-review marker key, whose whole claim is "this daemon's
      -- attempt authored this draft", so a key that changed every boot would make same-attempt
      -- crash recovery unverifiable (gitlab-com-integration.md §15.1).
      CREATE TABLE IF NOT EXISTS daemon_secret (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );
      -- gitlab-com-integration.md §15.1: control-plane frames a finished review still OWES. Both
      -- the operation settle and the terminal result are idempotent REQs, so an unacknowledged one
      -- is replayed verbatim until the control plane takes it; a lost ack must never leave an
      -- operation record started forever or an outcome unreconciled.
      CREATE TABLE IF NOT EXISTS code_host_review_intent (
        intentId TEXT PRIMARY KEY,
        daemonId TEXT NOT NULL,
        attemptId TEXT NOT NULL,
        orgId TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('operation', 'result')),
        frame TEXT NOT NULL,              -- the exact payload replayed, verbatim
        attempts INTEGER NOT NULL DEFAULT 0,
        updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS code_host_review_intent_pending
        ON code_host_review_intent (daemonId, updatedAt);
    `
    // One transaction, not 58: a multi-statement script commits — and so flushes — each statement.
    // The stamp joins it, so a creation that fails halfway leaves no schema to claim it is current.
    // Creation only: an established store re-runs this block as pure IF NOT EXISTS, so it saves
    // nothing there, and BEGIN IMMEDIATE held across 58 statements would collide with any peer
    // holding the same file open — every boot, not just the first.
    if (freshDatabase)
      await this.transaction(async (tx) => {
        await tx.exec(schema)
        await tx.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      })
    else await this.db.exec(schema)
    // The revision counter is in-memory but the rows it numbers are durable, so it
    // must resume from the database on every open — starting a restarted daemon back
    // at 0 would hand already-issued revisions to new rows. Deliberately unfenced: it
    // allocates across every org partition, so it must clear the highest of them all.
    this.transcriptRevision = (
      (await this.db.prepare('SELECT COALESCE(MAX(revision), 0) AS revision FROM transcript').get()) as {
        revision: number
      }
    ).revision
    // Only an exclusively owned store proves that every old in-memory resolver died.
    if (!this.shared) {
      await this.db
        .prepare(
          "UPDATE permission_requests SET status = 'expired', resolvedAt = COALESCE(resolvedAt, ?) WHERE status = 'pending'"
        )
        .run(Date.now())
    }
  }

  /**
   * Bring a store written by an older daemon up to {@link SCHEMA_VERSION}.
   *
   * Runs BEFORE the constructor's `CREATE` block, and both halves of that
   * ordering are load-bearing:
   *
   * - The `CREATE` block describes the CURRENT schema, so it may index a column
   *   some future step introduces. Running it first would put that
   *   `CREATE INDEX` against a table the step has not widened yet.
   * - A store from a newer daemon must be refused having been left ALONE. The
   *   `CREATE` block is `IF NOT EXISTS`, but on a newer database "not exists" is
   *   itself the wrong question — it would add this version's objects to a store
   *   whose shape this build cannot reason about, and only then reject it.
   *
   * Each step commits with the version it produced, so an interrupted upgrade
   * resumes at the first unapplied step instead of replaying applied ones.
   */
  private async upgradeSchema(freshDatabase: boolean): Promise<void> {
    // Nothing to upgrade, and nothing to refuse: the caller stamps the version
    // once the `CREATE` block has emitted the current schema.
    if (freshDatabase) return
    // Databases created before versioning read 0; they carry the v1 schema.
    let version = ((await this.db.prepare('PRAGMA user_version').get()) as { user_version: number }).user_version || 1
    if (version > SCHEMA_VERSION)
      throw new Error(
        `local store schema v${version} is newer than this daemon understands (v${SCHEMA_VERSION}) — upgrade the daemon`
      )
    while (version < SCHEMA_VERSION) {
      const step = SCHEMA_MIGRATIONS[version - 1]
      if (!step) throw new Error(`local store is missing a migration step for schema v${version}`)
      const upgraded = version + 1
      await this.transaction(async (tx) => {
        await step(tx, { shared: this.shared })
        await tx.exec(`PRAGMA user_version = ${upgraded}`)
      })
      version = upgraded
    }
  }

  /** One transaction on a pinned connection, with the tool-write buffer drained first: a flush
   *  issued from inside the transaction would run on a different connection. */
  private async transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    await this.drainToolCallWrites()
    return this.backend.transaction(fn)
  }

  async getSession(key: string): Promise<SessionRecord | undefined> {
    return (await this.db.prepare('SELECT * FROM sessions WHERE key = ?').get(key)) as SessionRecord | undefined
  }

  /**
   * The slot's OUTWARD session id (§1.1), minted on first ask and stable for the slot's life.
   * Asked before a credential is issued — earlier than the runtime, so earlier than any ACP id,
   * and usually earlier than the session ROW, which the turn writes only once it dispatches.
   *
   * A mint therefore lands in `session_outward_ids`, never in a half-built `sessions` row: the
   * turn's own insert adopts it, and a key that never becomes a session — the pool also runs
   * dream / memory / commit work under `internal:*` keys — leaves nothing behind that looks like
   * one. Idempotent without depending on a driver's `changes`, since a pool's members share one
   * store: each step is a no-op for the loser and the final read settles who won.
   *
   * THE SESSION ROW WINS. A full insert can land between the first read and the stage — its own
   * id already generated, since the stage it would have adopted did not exist yet — and the
   * adopting UPDATE below then finds nothing to fill. Answering with the stage there would split
   * one session's identity in two: the credential under one name, its metadata and usage under
   * another, which is the very failure this column exists to end. So the row is re-read after the
   * UPDATE, and where it disagrees the stage is settled onto it.
   */
  async ensureOutwardSessionId(key: string, agentId?: string, now = Date.now()): Promise<string> {
    const onSession = (
      (await this.db.prepare('SELECT sessionId FROM sessions WHERE key = ?').get(key)) as
        { sessionId: string | null } | undefined
    )?.sessionId
    if (onSession) return onSession
    await this.db
      .prepare('INSERT OR IGNORE INTO session_outward_ids (key, agentId, sessionId, mintedAt) VALUES (?, ?, ?, ?)')
      .run(key, agentId ?? null, randomUUID(), now)
    const minted = (
      (await this.db.prepare('SELECT sessionId FROM session_outward_ids WHERE key = ?').get(key)) as
        { sessionId: string } | undefined
    )?.sessionId
    if (!minted) throw new Error(`could not mint an outward session id for ${key}`)
    // A session row written before this column existed adopts the mint rather than a second name.
    await this.db.prepare('UPDATE sessions SET sessionId = ? WHERE key = ? AND sessionId IS NULL').run(minted, key)
    const settled = (
      (await this.db.prepare('SELECT sessionId FROM sessions WHERE key = ?').get(key)) as
        { sessionId: string | null } | undefined
    )?.sessionId
    if (settled && settled !== minted) {
      await this.db.prepare('UPDATE session_outward_ids SET sessionId = ? WHERE key = ?').run(settled, key)
      return settled
    }
    return minted
  }

  async createPermissionRequest(record: PermissionRequestRecord): Promise<void> {
    // node:sqlite rejects bound params the statement never names — new rows start undecided anyway.
    const { resolvedBy: _rb, resolvedByName: _rn, ...row } = record
    await this.db
      .prepare(
        `INSERT INTO permission_requests
           (id, agentId, sessionId, createdAt, requesterId, requesterName, command, status, resolvedAt, ownerId)
         VALUES
           (@id, @agentId, @sessionId, @createdAt, @requesterId, @requesterName, @command, @status, @resolvedAt, @ownerId)`
      )
      .run({ ...row, ownerId: this.ownerId ?? null } as unknown as SqlParams)
    await this.prunePermissionRequestHistory(record.agentId)
  }

  private async prunePermissionRequestHistory(agentId: string): Promise<void> {
    // Keep all live resolvers addressable; cap only terminal history. A burst of
    // concurrent requests must never disappear from the editor surface while the
    // corresponding ACP promise is still waiting.
    await this.db
      .prepare(
        `DELETE FROM permission_requests
         WHERE agentId = ? AND status != 'pending' AND id NOT IN (
           SELECT id FROM permission_requests
           WHERE agentId = ? AND status != 'pending'
           ORDER BY createdAt DESC LIMIT 100
         )`
      )
      .run(agentId, agentId)
  }

  async listPermissionRequests(agentId: string, limit = 50): Promise<PermissionRequestRecord[]> {
    return (await this.db
      .prepare(
        `SELECT * FROM permission_requests
         WHERE agentId = ?
         ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, createdAt DESC
         LIMIT ?`
      )
      .all(agentId, Math.max(1, Math.min(100, limit)))) as unknown as PermissionRequestRecord[]
  }

  async resolvePermissionRequest(
    agentId: string,
    id: string,
    status: Exclude<PermissionRequestStatus, 'pending'>,
    resolvedAt: number,
    by?: { resolvedBy: string | null; resolvedByName: string | null }
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE permission_requests SET status = @status, resolvedAt = @resolvedAt,
           resolvedBy = @resolvedBy, resolvedByName = @resolvedByName
         WHERE agentId = @agentId AND id = @id AND status = 'pending'`
      )
      .run({
        status,
        resolvedAt,
        agentId,
        id,
        resolvedBy: by?.resolvedBy ?? null,
        resolvedByName: by?.resolvedByName ?? null
      })
    const changed = Number(result.changes) === 1
    if (changed) await this.prunePermissionRequestHistory(agentId)
    return changed
  }

  /** Record a pending approval's DM card handle; false if the row already settled. */
  async setPermissionRequestNotify(
    agentId: string,
    id: string,
    integrationId: string,
    channel: string,
    ts: string
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE permission_requests SET notifyIntegrationId = ?, notifyChannel = ?, notifyTs = ?
         WHERE agentId = ? AND id = ? AND status = 'pending'`
      )
      .run(integrationId, channel, ts, agentId, id)
    return Number(result.changes) === 1
  }

  /** Drop the DM handle after its card has been rewritten to a terminal state. */
  async clearPermissionRequestNotify(agentId: string, id: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE permission_requests SET notifyIntegrationId = NULL, notifyChannel = NULL, notifyTs = NULL
         WHERE agentId = ? AND id = ?`
      )
      .run(agentId, id)
  }

  /** Settled rows whose DM card was never rewritten (daemon died first) — returned
   *  once, handles cleared, so a reconnect sweep rewrites each orphan exactly once. */
  async takeOrphanedPermissionNotices(integrationId: string, limit = 20): Promise<PermissionNoticeRow[]> {
    const rows = (await this.db
      .prepare(
        `SELECT id, agentId, status, command, resolvedByName, notifyChannel, notifyTs
         FROM permission_requests
         WHERE notifyIntegrationId = ? AND notifyTs IS NOT NULL AND status != 'pending'
         ORDER BY resolvedAt DESC LIMIT ?`
      )
      .all(integrationId, Math.max(1, Math.min(100, limit)))) as unknown as PermissionNoticeRow[]
    for (const row of rows) await this.clearPermissionRequestNotify(row.agentId, row.id)
    return rows
  }

  /** Expire orphaned resolvers only after this process authoritatively takes ownership of their agents. */
  async recoverPermissionRequests(agentIds: readonly string[], resolvedAt: number): Promise<number> {
    if (!this.shared || agentIds.length === 0) return 0
    const scope = idScope('agentId', agentIds)
    return Number(
      (
        await this.db
          .prepare(
            `UPDATE permission_requests SET status = 'expired', resolvedAt = @resolvedAt
           WHERE status = 'pending' AND (ownerId IS NULL OR ownerId != @ownerId)${scope.sql}`
          )
          .run({ resolvedAt, ownerId: this.ownerId!, ...scope.params })
      ).changes
    )
  }

  /** All sessions that have an ACP id (i.e. are addressable by sessionId), newest
   *  first. Optionally scoped to one agent. Backs `session/list` read-back — the
   *  `usage` column comes back as raw JSON (parsed by the reader). */
  async listSessions(agentId?: string): Promise<SessionListRow[]> {
    if (agentId !== undefined) {
      return (await this.db
        .prepare('SELECT * FROM sessions WHERE acpSessionId IS NOT NULL AND agentId = ? ORDER BY updatedAt DESC')
        .all(agentId)) as unknown as SessionListRow[]
    }
    return (await this.db
      .prepare('SELECT * FROM sessions WHERE acpSessionId IS NOT NULL ORDER BY updatedAt DESC')
      .all()) as unknown as SessionListRow[]
  }

  /**
   * Stop reporting these conversations for this integration — the bot left, or an
   * operator forgot the row.
   *
   * This has to be durable, not in-memory, because the thing it suppresses is: the
   * observed set of a non-enumerating platform is rebuilt from session history, so a
   * restart (or merely the next refresh) would otherwise resurrect a conversation the
   * bot demonstrably left. Sessions and transcripts are untouched — this hides the
   * conversation from the console's channel list, it does not erase what happened.
   */
  async markRetractedConversations(integrationId: string, channelIds: readonly string[], now: number): Promise<void> {
    const stmt = await this.db.prepare(
      `INSERT INTO retracted_conversations (integrationId, channelId, retractedAt) VALUES (?, ?, ?)
       ON CONFLICT (integrationId, channelId) DO UPDATE SET retractedAt = excluded.retractedAt`
    )
    for (const channelId of channelIds) await stmt.run(integrationId, channelId, now)
  }

  /** Integrations holding any suppression. The reconnect replay keys on this as well
   *  as its in-memory snapshots: a restart before the first reconnect leaves the
   *  tombstone on disk with no cached snapshot to replay it alongside. */
  async retractedIntegrations(): Promise<string[]> {
    const rows = (await this.db.prepare('SELECT DISTINCT integrationId FROM retracted_conversations').all()) as {
      integrationId: string
    }[]
    return rows.map((r) => r.integrationId)
  }

  /** The conversations currently suppressed for one integration. */
  async retractedConversations(integrationId: string): Promise<Set<string>> {
    const rows = (await this.db
      .prepare('SELECT channelId FROM retracted_conversations WHERE integrationId = ?')
      .all(integrationId)) as { channelId: string }[]
    return new Set(rows.map((r) => r.channelId))
  }

  /**
   * Forget the suppression for one conversation — it is back.
   *
   * The trigger is a real inbound message: a platform only delivers those for a
   * conversation the bot is actually in, so traffic is proof the departure has been
   * undone (someone re-invited it). Self-healing, and it keeps a stale marker from
   * hiding a conversation forever.
   */
  async clearRetractedConversation(integrationId: string, channelId: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM retracted_conversations WHERE integrationId = ? AND channelId = ?')
      .run(integrationId, channelId)
  }

  /** Distinct conversation targets this agent has been triggered in through one
   *  physical bot, newest first, joined to their cached display name. Backs the
   *  `listChannels` fallback for platforms whose bot API can't enumerate chats
   *  (Telegram): only history from the current bot is reachable through it. */
  async observedChannels(
    agentId: string,
    platform: string,
    transportScope: string
  ): Promise<{ id: string; name?: string }[]> {
    return (await this.db
      .prepare(
        `SELECT s.channel AS id, d.name AS name
         FROM (SELECT channel, MAX(updatedAt) AS updatedAt FROM sessions
               WHERE agentId = ? AND platform = ? AND transportScope = ?
                 AND channel IS NOT NULL AND channel <> ''
               GROUP BY channel) s
         LEFT JOIN display_names d ON d.id = s.channel
         ORDER BY s.updatedAt DESC`
      )
      .all(agentId, platform, transportScope)) as { id: string; name?: string }[]
  }

  /** Distinct users this agent has been triggered by through one physical bot,
   *  newest first, joined to their cached display name (present for Slack ids and
   *  Telegram DM chats where chat id == user id; group senders are id-only). */
  async observedUsers(
    agentId: string,
    platform: string,
    transportScope: string
  ): Promise<{ id: string; name?: string }[]> {
    return (await this.db
      .prepare(
        `SELECT s.triggeredBy AS id, d.name AS name
         FROM (SELECT triggeredBy, MAX(updatedAt) AS updatedAt FROM sessions
               WHERE agentId = ? AND platform = ? AND transportScope = ?
                 AND triggeredBy IS NOT NULL AND triggeredBy <> ''
               GROUP BY triggeredBy) s
         LEFT JOIN display_names d ON d.id = s.triggeredBy
         ORDER BY s.updatedAt DESC`
      )
      .all(agentId, platform, transportScope)) as { id: string; name?: string }[]
  }

  /** The most recently active addressable session (has an ACP id) for an agent in a
   *  channel, or undefined. Backs `/status` when the command message itself doesn't fall
   *  in a session's thread (a bare Telegram `/status` keys to its own reply thread) — we
   *  then report the channel's latest session rather than "nothing here". */
  async latestSession(agentId: string, channel: string): Promise<SessionRecord | undefined> {
    return (await this.db
      .prepare(
        'SELECT * FROM sessions WHERE agentId = ? AND channel = ? AND acpSessionId IS NOT NULL ORDER BY updatedAt DESC LIMIT 1'
      )
      .get(agentId, channel)) as SessionRecord | undefined
  }

  /** Latest addressable session for one physical platform bot. The explicit
   * transport scope prevents equal Telegram chat ids on different bots from
   * stealing command/callback targeting from one another. */
  async latestSessionForTransport(
    agentId: string,
    channel: string,
    transportScope?: string,
    thread?: string
  ): Promise<SessionRecord | undefined> {
    const args: SQLInputValue[] = [agentId, channel, transportScope ?? '']
    const threadClause = thread === undefined ? '' : ' AND thread = ?'
    if (thread !== undefined) args.push(thread)
    return (await this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE agentId = ? AND channel = ? AND COALESCE(transportScope, '') = ?
           AND acpSessionId IS NOT NULL${threadClause}
         ORDER BY updatedAt DESC LIMIT 1`
      )
      .get(...args)) as SessionRecord | undefined
  }

  /** The agent's session on one platform THREAD inside one channel. Exists for a platform
   *  action that addresses a session by the provider's own session id (Linear's AgentSession):
   *  unlike `latestSessionForTransport` it does not require an ACP id, so a stop still reaches
   *  a turn that has not spawned yet. */
  async latestSessionForThread(
    agentId: string,
    platform: string,
    channel: string,
    thread: string,
    transportScope?: string
  ): Promise<SessionRecord | undefined> {
    return (await this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE agentId = ? AND platform = ? AND channel = ? AND thread = ?
           AND COALESCE(transportScope, '') = ?
         ORDER BY updatedAt DESC LIMIT 1`
      )
      .get(agentId, platform, channel, thread, transportScope ?? '')) as SessionRecord | undefined
  }

  /** The same, CHANNEL-BLIND: for a platform whose thread id is unique on its own — Linear's
   *  AgentSession UUID, whose channel (the team, §4.5) no stop payload carries. */
  async latestSessionForPlatformThread(
    agentId: string,
    platform: string,
    thread: string,
    transportScope?: string
  ): Promise<SessionRecord | undefined> {
    return (await this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE agentId = ? AND platform = ? AND thread = ?
           AND COALESCE(transportScope, '') = ?
         ORDER BY updatedAt DESC LIMIT 1`
      )
      .get(agentId, platform, thread, transportScope ?? '')) as SessionRecord | undefined
  }

  /** The most recently active addressable session (has an ACP id) in a channel, across
   *  ALL agents — or undefined. Used to resolve which agent a bare command targets when
   *  routing can't (e.g. a group `/status@bot` with no mention entity / thread). */
  async latestSessionInChannel(channel: string): Promise<SessionRecord | undefined> {
    return (await this.db
      .prepare('SELECT * FROM sessions WHERE channel = ? AND acpSessionId IS NOT NULL ORDER BY updatedAt DESC LIMIT 1')
      .get(channel)) as SessionRecord | undefined
  }

  /** Lookup by ACP session id (the protocol-facing `sessionId`), or undefined. */
  async getSessionByAcpId(acpSessionId: string): Promise<SessionRecord | undefined> {
    return (await this.db.prepare('SELECT * FROM sessions WHERE acpSessionId = ?').get(acpSessionId)) as
      SessionRecord | undefined
  }

  /** Agent-scoped ACP id lookup for callbacks from one runtime process. ACP ids
   *  are runtime-owned and need not be globally unique across agents. */
  async getSessionByAcpIdForAgent(agentId: string, acpSessionId: string): Promise<SessionRecord | undefined> {
    return (await this.db
      .prepare('SELECT * FROM sessions WHERE agentId = ? AND acpSessionId = ?')
      .get(agentId, acpSessionId)) as SessionRecord | undefined
  }

  /** Resolve a slot from the id the OUTSIDE world addresses it by (session-concept.md §1.1).
   *  Falls back to the ACP id so a caller still holding the runtime's name — and a control
   *  plane that recorded one before the outward column existed — still lands on the session. */
  async getSessionByOutwardId(sessionId: string, agentId?: string): Promise<SessionRecord | undefined> {
    const scope = agentId === undefined ? '' : ' AND agentId = @agentId'
    const params = { sessionId, ...(agentId === undefined ? {} : { agentId }) }
    return ((await this.db.prepare(`SELECT * FROM sessions WHERE sessionId = @sessionId${scope}`).get(params)) ??
      (await this.db.prepare(`SELECT * FROM sessions WHERE acpSessionId = @sessionId${scope}`).get(params))) as
      SessionRecord | undefined
  }

  /**
   * The org partition one transcript read or write belongs to. A store no pool shares owns
   * a single partition whatever the agent; a shared store resolves the agent's org through
   * the daemon's registry and refuses a row it cannot attribute, since an unattributed one
   * would be served to whichever org happened to reuse the same channel/thread ids.
   */
  private orgFor(agentId: string | undefined): string {
    if (!this.shared) return LOCAL_TRANSCRIPT_ORG
    const orgId = agentId ? this.orgForAgent?.(agentId) : undefined
    if (!orgId) throw new Error(`cannot resolve the transcript organization for agent ${agentId ?? '(none)'}`)
    return orgId
  }

  /** The org partition a CP-addressed READ belongs to. The reading CP names the org in the
   *  frame, and that is the authoritative one: a pool member serves the transcripts of every
   *  member of its store, including agents it does not hold and therefore cannot resolve
   *  locally. Only a shared store has more than one partition to choose between. */
  private orgForRead(agentId: string | undefined, orgId: string | undefined): string {
    if (!this.shared) return LOCAL_TRANSCRIPT_ORG
    return orgId ?? this.orgFor(agentId)
  }

  /** The org of a row written from a message rather than by an agent: its recipient or
   *  sender when either names one, else an agent already holding a session in the thread —
   *  an observed inbound is recorded before routing picks a recipient, and only a thread
   *  with live work is recorded at all. */
  private async transcriptOrg(
    channel: string,
    thread: string,
    ...candidates: Array<string | undefined>
  ): Promise<string> {
    if (!this.shared) return LOCAL_TRANSCRIPT_ORG
    for (const candidate of candidates) {
      const orgId = candidate ? this.orgForAgent?.(candidate) : undefined
      if (orgId) return orgId
    }
    return this.orgFor(await this.threadSessionAgent(channel, thread))
  }

  /** An agent holding a session in a transcript thread, for that fallback attribution. */
  private async threadSessionAgent(channel: string, thread: string): Promise<string | undefined> {
    const rows = (await this.db
      .prepare(
        'SELECT DISTINCT agentId, channel, transportScope FROM sessions WHERE thread = ? AND agentId IS NOT NULL'
      )
      .all(thread)) as { agentId: string; channel: string; transportScope: string | null }[]
    return rows.find(
      (row) => transcriptChannelKey(row.channel, row.transportScope) === channel && this.orgForAgent?.(row.agentId)
    )?.agentId
  }

  /** Addressable session ids whose authorized transcript scope may have changed. */
  async sessionIdsForTranscript(agentId: string, channel: string, thread: string): Promise<string[]> {
    // Outward ids (§1.1): the only consumer is the CP's transcript-activity signal, and the CP
    // invalidates by the id it filed the session under. A pre-v12 row answers with its ACP id.
    const rows = (await this.db
      .prepare(
        `SELECT DISTINCT COALESCE(sessionId, acpSessionId) AS sessionId, channel, transportScope FROM sessions
         WHERE agentId = ? AND thread = ? AND acpSessionId IS NOT NULL`
      )
      .all(agentId, thread)) as { sessionId: string; channel: string; transportScope: string | null }[]
    return rows
      .filter((row) => transcriptChannelKey(row.channel, row.transportScope) === channel)
      .map((row) => row.sessionId)
  }

  async currentTranscriptRevision(agentId?: string, orgId?: string): Promise<number> {
    const row = (await this.db
      .prepare('SELECT COALESCE(MAX(revision), 0) AS revision FROM transcript WHERE orgId = ?')
      .get(this.orgForRead(agentId, orgId))) as { revision: number }
    // The in-memory allocator spans every partition; only the answer is org-scoped.
    this.transcriptRevision = Math.max(this.transcriptRevision, row.revision)
    return row.revision
  }

  setTranscriptMutationListener(listener?: (mutation: TranscriptMutation) => void | Promise<void>): void {
    this.transcriptMutationListener = listener
  }

  /**
   * One newest-first page of a thread's user-visible transcript, for `session/history`.
   * Daemon housekeeping is excluded at read time as well as write time so rows stored
   * by an older daemon disappear after upgrade. Pages backward via `beforeSeq` (the
   * lowest seq already seen; null ⇒ newest page). Over-fetches one row to detect
   * `hasMore` without a second query. Rows stay seq DESC.
   *
   * `agentId` names the org partition only, never a delivery scope, and may be omitted on
   * a store no pool shares — a shared store has no single partition to fall back on.
   */
  async transcriptPage(
    channel: string,
    thread: string,
    beforeSeq: number | null,
    limit: number,
    agentId?: string
  ): Promise<{ rows: TranscriptRow[]; hasMore: boolean }> {
    const orgId = this.orgFor(agentId)
    const hiddenToolTitles = [...SESSION_TITLE_TOOL_TITLES]
    const rows = (beforeSeq !== null
      ? await this.db
          .prepare(
            `SELECT * FROM transcript
             WHERE orgId = ? AND channel = ? AND thread = ? AND seq < ?
               AND NOT (kind = 'tool' AND text IN (?, ?))
             ORDER BY seq DESC LIMIT ?`
          )
          .all(orgId, channel, thread, beforeSeq, ...hiddenToolTitles, limit + 1)
      : await this.db
          .prepare(
            `SELECT * FROM transcript
             WHERE orgId = ? AND channel = ? AND thread = ?
               AND NOT (kind = 'tool' AND text IN (?, ?))
             ORDER BY seq DESC LIMIT ?`
          )
          .all(orgId, channel, thread, ...hiddenToolTitles, limit + 1)) as unknown as TranscriptRow[]
    const hasMore = rows.length > limit
    return { rows: hasMore ? rows.slice(0, limit) : rows, hasMore }
  }

  /** Legacy seq-ordered/non-Slack history for ONE agent (the console session view),
   *  scoped to what THAT agent received or produced. A row is included when the agent
   *  SENT it (`sender`), was the row's
   *  first-recorded recipient (`recipient`), OR the message was delivered to it per the
   *  `transcript_recipient` table (which captures deliveries the text-row dedup would other-
   *  wise drop when several co-daemon agents catch up on the same message). When agents share
   *  a (channel, thread) on one daemon their rows live in one transcript, so an unscoped page
   *  would leak a peer's PRIVATE reasoning/tool activity (sender = peer, no delivery to us);
   *  this scoping shows every conversational message this agent actually received plus every-
   *  thing it produced, excluding only peers' internal activity. Separate from the §8.5 model
   *  catch-up (transcriptSince), which is unchanged. Slack's normal read path uses
   *  transcriptPageForAgentByEventTime; this method remains for non-Slack platform ids
   *  and numeric cursors issued by a pre-upgrade daemon. */
  async transcriptPageForAgent(
    channel: string,
    thread: string,
    agentId: string,
    beforeSeq: number | null,
    limit: number,
    orgId?: string
  ): Promise<{ rows: TranscriptRow[]; hasMore: boolean }> {
    // The delivery-table match is keyed by (channel, thread, ts), but internal rows
    // (reasoning/tool) are NOT deduped by ts and can share a ts with a delivered text row —
    // so gate the delivery match on `kind = 'text'`, else a peer's reasoning/tool row at the
    // same ts would be pulled back in. Deliveries only ever concern conversational messages;
    // own internal rows still surface via `sender`.
    const scope = AGENT_DELIVERY_SCOPE_SQL
    const partition = this.orgForRead(agentId, orgId)
    const hiddenToolTitles = [...SESSION_TITLE_TOOL_TITLES]
    const rows = (beforeSeq !== null
      ? await this.db
          .prepare(
            `SELECT * FROM transcript WHERE orgId = ? AND channel = ? AND thread = ? AND seq < ?
               AND ${scope}
               AND NOT (kind = 'tool' AND text IN (?, ?))
             ORDER BY seq DESC LIMIT ?`
          )
          .all(partition, channel, thread, beforeSeq, agentId, agentId, agentId, ...hiddenToolTitles, limit + 1)
      : await this.db
          .prepare(
            `SELECT * FROM transcript WHERE orgId = ? AND channel = ? AND thread = ?
               AND ${scope}
               AND NOT (kind = 'tool' AND text IN (?, ?))
             ORDER BY seq DESC LIMIT ?`
          )
          .all(
            partition,
            channel,
            thread,
            agentId,
            agentId,
            agentId,
            ...hiddenToolTitles,
            limit + 1
          )) as unknown as TranscriptRow[]
    const hasMore = rows.length > limit
    return { rows: hasMore ? rows.slice(0, limit) : rows, hasMore }
  }

  /**
   * One globally chronological page for a Slack session. Unlike `seq`, `eventTimeUs`
   * remains correct when a warm-thread snapshot appends an older Slack row after the
   * current trigger. The compound `(eventTimeUs, seq)` cursor gives equal timestamps a
   * deterministic order and keeps page boundaries stable.
   *
   * Rows are returned newest-first; callers reverse one page for display. The same
   * per-agent delivery scope as `transcriptPageForAgent` prevents peer-private activity
   * from leaking into the session view.
   */
  async transcriptPageForAgentByEventTime(
    channel: string,
    thread: string,
    agentId: string,
    before: TranscriptEventCursor | null,
    limit: number,
    orgId?: string
  ): Promise<{ rows: TranscriptRow[]; hasMore: boolean }> {
    const scope = AGENT_DELIVERY_SCOPE_SQL
    const partition = this.orgForRead(agentId, orgId)
    const hiddenToolTitles = [...SESSION_TITLE_TOOL_TITLES]
    const rows = (before !== null
      ? await this.db
          .prepare(
            `SELECT * FROM transcript WHERE orgId = ? AND channel = ? AND thread = ?
               AND (eventTimeUs < ? OR (eventTimeUs = ? AND seq < ?))
               AND ${scope}
               AND NOT (kind = 'tool' AND text IN (?, ?))
             ORDER BY eventTimeUs DESC, seq DESC LIMIT ?`
          )
          .all(
            partition,
            channel,
            thread,
            before.eventTimeUs,
            before.eventTimeUs,
            before.seq,
            agentId,
            agentId,
            agentId,
            ...hiddenToolTitles,
            limit + 1
          )
      : await this.db
          .prepare(
            `SELECT * FROM transcript WHERE orgId = ? AND channel = ? AND thread = ?
               AND ${scope}
               AND NOT (kind = 'tool' AND text IN (?, ?))
             ORDER BY eventTimeUs DESC, seq DESC LIMIT ?`
          )
          .all(
            partition,
            channel,
            thread,
            agentId,
            agentId,
            agentId,
            ...hiddenToolTitles,
            limit + 1
          )) as unknown as TranscriptRow[]
    const hasMore = rows.length > limit
    return { rows: hasMore ? rows.slice(0, limit) : rows, hasMore }
  }

  /**
   * Forward mutation page for one authorized session view. Rows are revision-ordered,
   * so inserts and same-seq tool updates share one lossless cursor. The returned
   * cursor skips unrelated/global revisions only after this scope is fully drained.
   */
  async transcriptTailForAgent(
    channel: string,
    thread: string,
    agentId: string,
    afterRevision: number,
    limit: number,
    orgId?: string
  ): Promise<{ rows: TranscriptRow[]; hasMore: boolean; cursor: number }> {
    const scope = AGENT_DELIVERY_SCOPE_SQL
    const rows = (await this.db
      .prepare(
        `SELECT * FROM transcript
         WHERE orgId = ? AND channel = ? AND thread = ? AND revision > ?
           AND ${scope}
           AND NOT (kind = 'tool' AND text IN (?, ?))
         ORDER BY revision ASC LIMIT ?`
      )
      .all(
        this.orgForRead(agentId, orgId),
        channel,
        thread,
        afterRevision,
        agentId,
        agentId,
        agentId,
        ...SESSION_TITLE_TOOL_TITLES,
        limit + 1
      )) as unknown as TranscriptRow[]
    const hasMore = rows.length > limit
    const kept = hasMore ? rows.slice(0, limit) : rows
    return {
      rows: kept,
      hasMore,
      cursor: hasMore ? kept[kept.length - 1]!.revision : await this.currentTranscriptRevision(agentId, orgId)
    }
  }

  async upsertSession(rec: SessionRecord): Promise<void> {
    // Bind only the mutable session columns explicitly. `rec` may be a row read back
    // via `SELECT *` (e.g. from getSession/listSessions), which now also carries the
    // `usage` and `muted` columns — passing the whole object would trip node:sqlite's
    // unknown-named-parameter check. `usage` is intentionally not touched; `muted`
    // is only promoted from the durable tombstone and never cleared by a state upsert.
    // `triggeredBy` is first-wins: the sender that created the session keeps the
    // credit across later upserts.
    await this.db
      .prepare(
        `INSERT INTO sessions
           (key, sessionId, agentId, platform, channel, thread, transportScope, acpSessionId, state, lastDeliveredTs, updatedAt, muted, triggeredBy, threadUrl, memoryProvider, workspaceIsolation, originSessionId, needsParentReply,
            externalProvider, externalRealmKey, externalResourceKind, externalResourceKey, externalIntegrationId,
            externalOriginJson, sourceBindingKind, platformStanding)
         VALUES
           (@key, COALESCE((SELECT sessionId FROM session_outward_ids WHERE key = @key), @sessionId), @agentId, @platform, @channel, @thread, @transportScope, @acpSessionId, @state, @lastDeliveredTs, @updatedAt,
            CASE WHEN EXISTS (SELECT 1 FROM session_mutes WHERE key = @key) THEN 1 ELSE NULL END,
            @triggeredBy, @threadUrl, @memoryProvider, @workspaceIsolation, @originSessionId, @needsParentReply,
            @externalProvider, @externalRealmKey, @externalResourceKind, @externalResourceKey, @externalIntegrationId,
            @externalOriginJson, @sourceBindingKind, @platformStanding)
         ON CONFLICT(key) DO UPDATE SET
           sessionId=COALESCE(sessions.sessionId, excluded.sessionId),
           -- The key's own components. A row this daemon minted an outward id into before the
           -- session existed (ensureOutwardSessionId) carries none of them, and they are immutable
           -- once written, so COALESCE hydrates that skeleton exactly once and never rewrites a
           -- real row. Without this the session could not be read back from its own coordinates.
           platform=COALESCE(sessions.platform, excluded.platform),
           channel=COALESCE(sessions.channel, excluded.channel),
           thread=COALESCE(sessions.thread, excluded.thread),
           acpSessionId=excluded.acpSessionId, state=excluded.state,
           lastDeliveredTs=excluded.lastDeliveredTs, updatedAt=excluded.updatedAt,
           transportScope=excluded.transportScope,
           muted=CASE
             WHEN EXISTS (SELECT 1 FROM session_mutes WHERE key = excluded.key) THEN 1
             ELSE sessions.muted
           END,
           triggeredBy=COALESCE(sessions.triggeredBy, excluded.triggeredBy),
           threadUrl=COALESCE(sessions.threadUrl, excluded.threadUrl),
           memoryProvider=excluded.memoryProvider,
           workspaceIsolation=COALESCE(excluded.workspaceIsolation, sessions.workspaceIsolation),
           externalProvider=COALESCE(sessions.externalProvider, excluded.externalProvider),
           externalRealmKey=COALESCE(sessions.externalRealmKey, excluded.externalRealmKey),
           externalResourceKind=COALESCE(sessions.externalResourceKind, excluded.externalResourceKind),
           externalResourceKey=COALESCE(sessions.externalResourceKey, excluded.externalResourceKey),
           -- Credential locator is not part of the immutable source tuple. A
           -- Slack reinstall may replace the integration while the same
           -- workspace/conversation remains the audience.
           externalIntegrationId=COALESCE(excluded.externalIntegrationId, sessions.externalIntegrationId),
           externalOriginJson=COALESCE(sessions.externalOriginJson, excluded.externalOriginJson),
           sourceBindingKind=COALESCE(sessions.sourceBindingKind, excluded.sourceBindingKind),
           -- Parent link is first-wins: set once when the session is spawned, never cleared by a
           -- later (human-triggered) turn that carries no origin.
           originSessionId=COALESCE(sessions.originSessionId, excluded.originSessionId),
           -- The report-back directive is STICKY-TRUE: a parent that asked for a reply keeps it
           -- for the session's lifetime, and an ordinary turn (which carries no flag) never
           -- clears it. lastTurnOutcome is deliberately absent — setSessionTurnOutcome owns it.
           needsParentReply=CASE
             WHEN excluded.needsParentReply = 1 THEN 1
             ELSE sessions.needsParentReply
           END,
           -- First-wins like the parent link: the block that opened the session is the session's.
           platformStanding=COALESCE(sessions.platformStanding, excluded.platformStanding)`
      )
      .run({
        key: rec.key,
        sessionId: rec.sessionId ?? randomUUID(),
        agentId: rec.agentId,
        platform: rec.platform,
        channel: rec.channel,
        thread: rec.thread,
        transportScope: rec.transportScope ?? null,
        acpSessionId: rec.acpSessionId,
        state: rec.state,
        lastDeliveredTs: rec.lastDeliveredTs,
        updatedAt: rec.updatedAt,
        triggeredBy: rec.triggeredBy ?? null,
        threadUrl: rec.threadUrl ?? null,
        memoryProvider: rec.memoryProvider ?? null,
        workspaceIsolation: rec.workspaceIsolation ?? null,
        externalProvider: rec.externalProvider ?? null,
        externalRealmKey: rec.externalRealmKey ?? null,
        externalResourceKind: rec.externalResourceKind ?? null,
        externalResourceKey: rec.externalResourceKey ?? null,
        externalIntegrationId: rec.externalIntegrationId ?? null,
        externalOriginJson: rec.externalOriginJson ?? null,
        sourceBindingKind: rec.sourceBindingKind ?? null,
        originSessionId: rec.originSessionId ?? null,
        needsParentReply: rec.needsParentReply === 1 ? 1 : null,
        platformStanding: rec.platformStanding ?? null
      })
  }

  /** Record how the turn that just ended went (§7.3 companion of {@link setSessionState}):
   *  'done' for a clean finish, 'failed' for a problem phase. Read back by
   *  `viewSessionStatus` so a parent session can tell a finished child from a broken one.
   *  No-op if the key is unknown (a turn that failed before the row existed). */
  async setSessionTurnOutcome(key: string, outcome: 'done' | 'failed', updatedAt: number): Promise<void> {
    await this.db
      .prepare('UPDATE sessions SET lastTurnOutcome = ?, updatedAt = ? WHERE key = ?')
      .run(outcome, updatedAt, key)
  }

  /** Targeted state transition for an existing session (§7.3), stamping `updatedAt`
   *  so the change counts as activity for the TTL/idle clocks. No-op if the key is
   *  unknown (the row is created by the SessionManager on first turn). */
  async setSessionState(key: string, state: SessionRecord['state'], updatedAt: number): Promise<void> {
    await this.db.prepare('UPDATE sessions SET state = ?, updatedAt = ? WHERE key = ?').run(state, updatedAt, key)
  }

  /** `!stop` thread mute: the tombstone is written even before a session row exists,
   *  then mirrored into sessions.muted for existing readers. An explicit @mention
   *  clears both atomically. */
  async setSessionMuted(key: string, muted: boolean): Promise<void> {
    await this.transaction(async (raw) => {
      const tx = accessOf(raw)
      if (muted) await tx.prepare('INSERT OR IGNORE INTO session_mutes (key) VALUES (?)').run(key)
      else await tx.prepare('DELETE FROM session_mutes WHERE key = ?').run(key)
      await tx.prepare('UPDATE sessions SET muted = ? WHERE key = ?').run(muted ? 1 : 0, key)
    })
  }

  // ── memory-capture gate (session-visibility.md §5.1) ──────────────────────
  // Two layers: the daemon-local verdict it can reach without a CP round-trip
  // (DM / webchat / launch-correlated / A2A ⇒ excluded), and the CP-confirmed
  // effective state, which supersedes it once it arrives. Unknown ⇒ excluded:
  // a missed or delayed frame may only under-capture, never leak.

  /** Seed the local verdict for a session the daemon just created. Never lowers
   *  `cpRev`: a CP push that arrived first stays authoritative. */
  async setLocalCaptureGate(agentId: string, acpSessionId: string, localExcluded: boolean): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO session_gates (agentId, acpSessionId, localExcluded, cpRev, updatedAt)
         VALUES (?, ?, ?, 0, ?)
         ON CONFLICT(agentId, acpSessionId) DO UPDATE SET
           localExcluded = excluded.localExcluded, updatedAt = excluded.updatedAt`
      )
      .run(agentId, acpSessionId, localExcluded ? 1 : 0, Date.now())
  }

  /**
   * Apply a CP `session/visibility` push. Idempotent by revision: a frame whose
   * rev is at or below what we hold is NOT reapplied but IS still acknowledged
   * (`superseded`) — "ignore" must never mean "don't ACK", or a lost ack leaves
   * the CP retrying forever.
   *
   * The revision test is the upsert's own `WHERE`, not a prior `SELECT`: two members
   * on the shared store otherwise interleave read and write and land the older rev last.
   */
  async applyCpCaptureGate(
    agentId: string,
    acpSessionId: string,
    isPrivate: boolean,
    rev: number
  ): Promise<'applied' | 'superseded'> {
    // rev 0 is a legitimate first revision (a session ingested and never
    // changed), so it applies once — but only while we hold nothing newer.
    const changes = (
      await this.db
        .prepare(
          `INSERT INTO session_gates (agentId, acpSessionId, localExcluded, cpPrivate, cpRev, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(agentId, acpSessionId) DO UPDATE SET
           cpPrivate = excluded.cpPrivate, cpRev = excluded.cpRev, updatedAt = excluded.updatedAt
         WHERE session_gates.cpRev < excluded.cpRev
            OR (excluded.cpRev = 0 AND session_gates.cpRev = 0)`
        )
        .run(agentId, acpSessionId, isPrivate ? 1 : 0, isPrivate ? 1 : 0, rev, Date.now())
    ).changes
    return Number(changes) > 0 ? 'applied' : 'superseded'
  }

  /** The one agent holding this ACP id locally, or undefined when none or several
   *  do — how a push from a CP too old to name the agent is attributed. */
  async soleAgentForAcpSession(sessionId: string): Promise<string | undefined> {
    const rows = (await this.db
      .prepare(
        `SELECT DISTINCT agentId FROM sessions
         WHERE (sessionId = @sessionId OR acpSessionId = @sessionId) AND agentId IS NOT NULL LIMIT 2`
      )
      .all({ sessionId })) as { agentId: string }[]
    return rows.length === 1 ? rows[0]!.agentId : undefined
  }

  /**
   * Is memory capture excluded for this session? The CP-confirmed bit wins once
   * we have one; otherwise the local verdict; otherwise excluded. An A2A child
   * therefore starts closed and only a CP-confirmed `org` state opens it.
   */
  async isCaptureExcluded(agentId: string, acpSessionId: string | undefined): Promise<boolean> {
    if (!acpSessionId) return true
    // External-source binding (a Slack/Feishu channel = external identity domain)
    // no longer forces memory exclusion: such channels behave like any other
    // channel (Discord/Telegram already did), gated only by the local verdict and
    // the CP-confirmed visibility below (#653 follow-up; session-visibility.md
    // §5.1). DM / webchat / A2A / launch-correlated sessions stay private through
    // those same layers.
    const row = (await this.db
      .prepare('SELECT localExcluded, cpPrivate FROM session_gates WHERE agentId = ? AND acpSessionId = ?')
      .get(agentId, acpSessionId)) as { localExcluded: number; cpPrivate: number | null } | undefined
    if (!row) return true
    if (row.cpPrivate !== null) return row.cpPrivate === 1
    return row.localExcluded === 1
  }

  // ── durable tenant scopes (session-visibility.md §2) ──────────────────────
  // A platform with no durable tenant id of its own (Discord today) mints one
  // per integration ONCE and keeps it: the credential-derived transportScope
  // rotates with tokens, which would orphan historical identity matches.

  /** The minted tenant scope for an integration, or undefined if never minted. */
  async getMintedTenantScope(integrationId: string): Promise<string | undefined> {
    const row = (await this.db
      .prepare('SELECT value FROM tenant_scopes WHERE integrationId = ?')
      .get(integrationId)) as { value: string } | undefined
    return row?.value
  }

  /** Mint-once: concurrent callers converge on the first stored value. */
  async mintTenantScope(integrationId: string, value: string): Promise<string> {
    await this.db
      .prepare('INSERT OR IGNORE INTO tenant_scopes (integrationId, value, createdAt) VALUES (?, ?, ?)')
      .run(integrationId, value, Date.now())
    return (await this.getMintedTenantScope(integrationId)) ?? value
  }

  /** Persist a session's visibility-classification inputs so EVERY later
   *  `event/session` re-emit carries them, not just the dispatch that knew the
   *  originating message (session-visibility.md §4.1). First non-null wins. */
  async setSessionClassification(
    key: string,
    c: {
      conversationKind?: string
      tenantScope?: string
      launchCorrelationId?: string
      externalProvider?: string
      externalRealmKey?: string
      externalResourceKind?: string
      externalResourceKey?: string
      externalIntegrationId?: string
      externalOrigin?: ExternalSessionOrigin
      sourceBindingKind?: 'local' | 'external'
      directDestination?: boolean
    }
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE sessions SET
           conversationKind = COALESCE(conversationKind, ?),
           tenantScope = COALESCE(tenantScope, ?),
           launchCorrelationId = COALESCE(launchCorrelationId, ?),
           externalProvider = COALESCE(externalProvider, ?),
           externalRealmKey = COALESCE(externalRealmKey, ?),
           externalResourceKind = COALESCE(externalResourceKind, ?),
           externalResourceKey = COALESCE(externalResourceKey, ?),
           -- Unlike the source tuple, the credential locator is replaceable.
           externalIntegrationId = COALESCE(?, externalIntegrationId),
           externalOriginJson = COALESCE(externalOriginJson, ?),
           sourceBindingKind = COALESCE(sourceBindingKind, ?),
           directDestination = COALESCE(directDestination, ?)
         WHERE key = ?`
      )
      .run(
        c.conversationKind ?? null,
        c.tenantScope ?? null,
        c.launchCorrelationId ?? null,
        c.externalProvider ?? null,
        c.externalRealmKey ?? null,
        c.externalResourceKind ?? null,
        c.externalResourceKey ?? null,
        c.externalIntegrationId ?? null,
        c.externalOrigin ? JSON.stringify(c.externalOrigin) : null,
        c.sourceBindingKind ?? null,
        c.directDestination === undefined ? null : c.directDestination ? 1 : 0,
        key
      )
  }

  /** Read them back by ACP session id, the key the telemetry emitter holds. */
  async getSessionClassification(
    agentId: string,
    acpSessionId: string
  ): Promise<
    | {
        conversationKind?: string
        tenantScope?: string
        launchCorrelationId?: string
        externalProvider?: string
        externalRealmKey?: string
        externalResourceKind?: string
        externalResourceKey?: string
        externalIntegrationId?: string
        externalOrigin?: ExternalSessionOrigin
        sourceBindingKind?: 'local' | 'external'
        directDestination?: boolean
      }
    | undefined
  > {
    const row = (await this.db
      .prepare(
        `SELECT conversationKind, tenantScope, launchCorrelationId,
                externalProvider, externalRealmKey, externalResourceKind,
                externalResourceKey, externalIntegrationId, externalOriginJson,
                sourceBindingKind, directDestination
         FROM sessions WHERE agentId = ? AND acpSessionId = ?`
      )
      .get(agentId, acpSessionId)) as
      | {
          conversationKind: string | null
          tenantScope: string | null
          launchCorrelationId: string | null
          externalProvider: string | null
          externalRealmKey: string | null
          externalResourceKind: string | null
          externalResourceKey: string | null
          externalIntegrationId: string | null
          externalOriginJson: string | null
          sourceBindingKind: 'local' | 'external' | null
          directDestination: number | null
        }
      | undefined
    if (!row) return undefined
    return {
      ...(row.conversationKind ? { conversationKind: row.conversationKind } : {}),
      ...(row.tenantScope ? { tenantScope: row.tenantScope } : {}),
      ...(row.launchCorrelationId ? { launchCorrelationId: row.launchCorrelationId } : {}),
      ...(row.externalProvider ? { externalProvider: row.externalProvider } : {}),
      ...(row.externalRealmKey ? { externalRealmKey: row.externalRealmKey } : {}),
      ...(row.externalResourceKind ? { externalResourceKind: row.externalResourceKind } : {}),
      ...(row.externalResourceKey ? { externalResourceKey: row.externalResourceKey } : {}),
      ...(row.externalIntegrationId ? { externalIntegrationId: row.externalIntegrationId } : {}),
      ...(row.externalOriginJson
        ? { externalOrigin: JSON.parse(row.externalOriginJson) as ExternalSessionOrigin }
        : {}),
      ...(row.sourceBindingKind ? { sourceBindingKind: row.sourceBindingKind } : {}),
      ...(row.directDestination ? { directDestination: true } : {})
    }
  }

  /** Human-facing session title from ingress, ACP, or the AgentConnect title
   *  tool (latest wins; null clears per ACP semantics). No-op on an unknown key. */
  async setSessionTitle(key: string, title: string | null): Promise<void> {
    await this.db.prepare('UPDATE sessions SET title = ? WHERE key = ?').run(title, key)
  }

  /** Slack status-bar message ts for this session, if one has been posted already. */
  async getStatusBarTs(key: string): Promise<string | undefined> {
    const row = (await this.db.prepare('SELECT statusBarTs FROM sessions WHERE key = ?').get(key)) as
      { statusBarTs: string | null } | undefined
    return row?.statusBarTs ?? undefined
  }

  /** Remember the current Slack status-bar message so later turns edit it in place. */
  async setStatusBarTs(key: string, ts: string): Promise<void> {
    await this.db.prepare('UPDATE sessions SET statusBarTs = ? WHERE key = ?').run(ts, key)
  }

  /** Forget a removed Slack status-bar message so a later enabled turn posts a fresh one. */
  async clearStatusBarTs(key: string): Promise<void> {
    await this.db.prepare('UPDATE sessions SET statusBarTs = NULL WHERE key = ?').run(key)
  }

  async isSessionMuted(key: string): Promise<boolean> {
    const row = (await this.db
      .prepare(
        `SELECT CASE
           WHEN EXISTS (SELECT 1 FROM session_mutes WHERE key = ?)
             OR EXISTS (SELECT 1 FROM sessions WHERE key = ? AND muted = 1)
           THEN 1 ELSE 0
         END AS muted`
      )
      .get(key, key)) as { muted: number }
    return row.muted === 1
  }

  /** The session-scoped model override (set via the console's in-session model switch),
   *  or undefined if the session runs on the agent's default. Sticky across turns and
   *  restarts, re-applied to the ACP session on each dispatch. */
  async getModelOverride(key: string): Promise<string | undefined> {
    const row = (await this.db.prepare('SELECT modelOverride FROM sessions WHERE key = ?').get(key)) as
      { modelOverride: string | null } | undefined
    return row?.modelOverride ?? undefined
  }

  /** Last model the runtime actually exposed for this session. `null` is an
   *  explicit opaque/default observation; undefined means no turn observed yet. */
  async getObservedModel(key: string): Promise<string | null | undefined> {
    const row = (await this.db
      .prepare('SELECT observedModel, observedModelSet FROM sessions WHERE key = ?')
      .get(key)) as { observedModel: string | null; observedModelSet: number } | undefined
    if (!row || row.observedModelSet !== 1) return undefined
    return row.observedModel
  }

  /** Persist the runtime observation so late usage corrections and metadata
   *  re-emits retain a named model or an explicit unknown across turn teardown. */
  async setObservedModel(key: string, model: string | null): Promise<void> {
    await this.db.prepare('UPDATE sessions SET observedModel = ?, observedModelSet = 1 WHERE key = ?').run(model, key)
  }

  /** Persist the session-scoped model override. No-op on an unknown key. */
  async setModelOverride(key: string, model: string): Promise<void> {
    await this.db.prepare('UPDATE sessions SET modelOverride = ? WHERE key = ?').run(model, key)
  }

  /** The session-scoped reasoning-effort override (set via the status-bar effort picker),
   *  or undefined if the session runs on the agent's default. Sticky across turns and
   *  restarts, re-applied to the ACP session on each dispatch. */
  async getEffortOverride(key: string): Promise<string | undefined> {
    const row = (await this.db.prepare('SELECT effortOverride FROM sessions WHERE key = ?').get(key)) as
      { effortOverride: string | null } | undefined
    return row?.effortOverride ?? undefined
  }

  /** Persist the session-scoped reasoning-effort override. No-op on an unknown key. */
  async setEffortOverride(key: string, effort: string): Promise<void> {
    await this.db.prepare('UPDATE sessions SET effortOverride = ? WHERE key = ?').run(effort, key)
  }

  /** The session-scoped permission preset (set via status bars), or undefined if the
   *  session runs on the agent's default. Codex Auto is stored as AgentConnect's
   *  composite preset and decomposed only when applied to ACP. Sticky across turns
   *  and restarts. */
  async getPermissionModeOverride(key: string): Promise<string | undefined> {
    const row = (await this.db.prepare('SELECT permissionModeOverride FROM sessions WHERE key = ?').get(key)) as
      { permissionModeOverride: string | null } | undefined
    return row?.permissionModeOverride ?? undefined
  }

  /** Persist the session-scoped permission preset. No-op on an unknown key. */
  async setPermissionModeOverride(key: string, preset: string): Promise<void> {
    await this.db.prepare('UPDATE sessions SET permissionModeOverride = ? WHERE key = ?').run(preset, key)
  }

  /** Revoke every chat-authored runtime override for an Agent. Output mode is
   * delivery presentation, not a runtime setting, so it remains independent. */
  async clearRuntimeConfigOverrides(agentId: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE sessions
         SET modelOverride = NULL,
             effortOverride = NULL,
             permissionModeOverride = NULL,
             fastModeOverride = NULL
         WHERE agentId = ?`
      )
      .run(agentId)
  }

  /** The session-scoped fast-mode override (set via the status-bar fast toggle), or
   *  undefined if the session runs on the agent's default. Stored as 0/1; sticky across
   *  turns and restarts, re-applied to the ACP session on each dispatch. */
  async getFastModeOverride(key: string): Promise<boolean | undefined> {
    const row = (await this.db.prepare('SELECT fastModeOverride FROM sessions WHERE key = ?').get(key)) as
      { fastModeOverride: number | null } | undefined
    return row?.fastModeOverride === null || row?.fastModeOverride === undefined
      ? undefined
      : row.fastModeOverride === 1
  }

  /** Persist the session-scoped fast-mode override. No-op on an unknown key. */
  async setFastModeOverride(key: string, fastMode: boolean): Promise<void> {
    await this.db.prepare('UPDATE sessions SET fastModeOverride = ? WHERE key = ?').run(fastMode ? 1 : 0, key)
  }

  /** The session-scoped Slack output-mode override (set via the status-bar output picker),
   *  or undefined if the session uses the agent's default. Daemon-side rendering verbosity
   *  (minimal/low/medium/high) — NOT an ACP setting; picked up by the next turn's OutputConverger. */
  async getOutputModeOverride(key: string): Promise<'none' | 'minimal' | 'low' | 'medium' | 'high' | undefined> {
    if (!key) return undefined // defensive: never bind an undefined key into SQL
    const row = (await this.db.prepare('SELECT outputModeOverride FROM sessions WHERE key = ?').get(key)) as
      { outputModeOverride: string | null } | undefined
    const v = row?.outputModeOverride
    return v === 'none' || v === 'minimal' || v === 'low' || v === 'medium' || v === 'high' ? v : undefined
  }

  /** Persist the session-scoped Slack output-mode override. No-op on an unknown key. */
  async setOutputModeOverride(key: string, mode: 'none' | 'minimal' | 'low' | 'medium' | 'high'): Promise<void> {
    await this.db.prepare('UPDATE sessions SET outputModeOverride = ? WHERE key = ?').run(mode, key)
  }

  /** Current token accounting for a session (parsed from the `usage` JSON column),
   *  or `{}` if none has been recorded / the JSON is unreadable. */
  async getUsage(key: string): Promise<StoredUsage> {
    const row = (await this.db.prepare('SELECT usage FROM sessions WHERE key = ?').get(key)) as
      { usage: string | null } | undefined
    return parseUsage(row?.usage ?? null)
  }

  /**
   * Read-merge-write `sessions.usage` under a compare-and-set on the value read, retried when a
   * concurrent writer wins. `addTokenUsage` and `addCost` are genuinely additive, so a plain
   * read-then-write drops the loser's increment; on a shared store two members touch one session
   * across a handover. A relative UPDATE would be simpler but the column is one JSON blob and the
   * two backends spell JSON mutation differently, whereas a CAS is plain SQL in both.
   *
   * `merge` runs again on every attempt, so it must be safe to repeat; returning undefined aborts.
   */
  private async mergeUsage(key: string, merge: (u: StoredUsage) => StoredUsage | undefined): Promise<void> {
    for (let attempt = 1; attempt <= USAGE_MERGE_ATTEMPTS; attempt++) {
      const row = (await this.db.prepare('SELECT usage FROM sessions WHERE key = ?').get(key)) as
        { usage: string | null } | undefined
      if (!row) return // unknown key: the row is created first (unchanged from the plain write)
      const merged = merge(parseUsage(row.usage))
      if (!merged) return
      const next = JSON.stringify(merged)
      // The last attempt writes unconditionally. Losing an increment is exactly the behavior this
      // replaces, so it is the floor to degrade to rather than dropping the write entirely.
      if (attempt === USAGE_MERGE_ATTEMPTS) {
        await this.db.prepare('UPDATE sessions SET usage = ? WHERE key = ?').run(next, key)
        return
      }
      // Two statements, not one NULL-safe comparison: `IS` / `IS NOT DISTINCT FROM` are spelled
      // differently by the two backends, and which case applies is already known here.
      const changes =
        row.usage === null
          ? (await this.db.prepare('UPDATE sessions SET usage = ? WHERE key = ? AND usage IS NULL').run(next, key))
              .changes
          : (
              await this.db
                .prepare('UPDATE sessions SET usage = ? WHERE key = ? AND usage = ?')
                .run(next, key, row.usage)
            ).changes
      if (changes > 0) return
    }
  }

  /** Record the latest token counts for a session when an adapter reports a
   *  running session total. This is latest-wins over the token fields — never
   *  additive. Only provided fields are updated; the context/cost snapshot is
   *  left intact. No-op on an unknown key (the row is created first). */
  async setTokenUsage(key: string, counts: TokenCounts): Promise<void> {
    await this.mergeUsage(key, (u) => {
      if (counts.totalTokens !== undefined) u.totalTokens = counts.totalTokens
      if (counts.inputTokens !== undefined) u.inputTokens = counts.inputTokens
      if (counts.outputTokens !== undefined) u.outputTokens = counts.outputTokens
      if (counts.thoughtTokens !== undefined) u.thoughtTokens = counts.thoughtTokens
      if (counts.cachedReadTokens !== undefined) u.cachedReadTokens = counts.cachedReadTokens
      if (counts.cachedWriteTokens !== undefined) u.cachedWriteTokens = counts.cachedWriteTokens
      return u
    })
  }

  /** Add one turn's token counts to the session total. codex-acp currently maps
   *  Codex's `last_token_usage` into PromptResponse.usage, so its values are a
   *  per-turn delta even though other ACP adapters return a session snapshot. */
  async addTokenUsage(key: string, counts: TokenCounts): Promise<void> {
    await this.mergeUsage(key, (u) => {
      const add = (field: keyof TokenCounts, value: number | undefined) => {
        if (value !== undefined) u[field] = (u[field] ?? 0) + value
      }
      add('totalTokens', counts.totalTokens)
      add('inputTokens', counts.inputTokens)
      add('outputTokens', counts.outputTokens)
      add('thoughtTokens', counts.thoughtTokens)
      add('cachedReadTokens', counts.cachedReadTokens)
      add('cachedWriteTokens', counts.cachedWriteTokens)
      return u
    })
  }

  /** Overwrite the session's context-window + cost snapshot (latest `usage_update`
   *  wins). Only provided fields are updated. No-op on an unknown key. */
  async setUsageSnapshot(key: string, snap: UsageSnapshot): Promise<void> {
    await this.mergeUsage(key, (u) => {
      if (snap.contextUsed !== undefined) u.contextUsed = snap.contextUsed
      if (snap.contextSize !== undefined) u.contextSize = snap.contextSize
      if (snap.costAmount !== undefined) u.costAmount = snap.costAmount
      if (snap.costCurrency !== undefined) u.costCurrency = snap.costCurrency
      return u
    })
  }

  /** Add one turn's fallback cost to the session running total. Refuse to mix
   *  currencies; a later ACP usage_update can still replace the total snapshot. */
  async addCost(key: string, amount: number, currency: string): Promise<boolean> {
    if (!Number.isFinite(amount) || amount <= 0 || !currency) return false
    // Set at most once and only by the refusal branch, so repeating the merge cannot change it.
    let mixedCurrency = false
    await this.mergeUsage(key, (u) => {
      if (u.costCurrency !== undefined && u.costCurrency !== currency) {
        mixedCurrency = true
        return undefined
      }
      u.costAmount = (u.costAmount ?? 0) + amount
      u.costCurrency = currency
      return u
    })
    return !mixedCurrency
  }

  /** Most-recent activity across an agent's non-closed sessions (epoch ms), or null
   *  if it has none. Drives idle-host reaping (#111): a host with no recent session
   *  activity AND no in-flight turn is past its idle window. */
  async agentLastActivityTs(agentId: string): Promise<number | null> {
    const row = (await this.db
      .prepare("SELECT MAX(updatedAt) AS ts FROM sessions WHERE agentId = ? AND state != 'closed'")
      .get(agentId)) as { ts: number | null } | undefined
    return row?.ts ?? null
  }

  /** One session's own last activity (epoch ms), or null once closed or gone — reaps a session-bound host. */
  async sessionLastActivityTs(key: string): Promise<number | null> {
    const row = (await this.db
      .prepare("SELECT updatedAt AS ts FROM sessions WHERE key = ? AND state != 'closed'")
      .get(key)) as { ts: number | null } | undefined
    return row?.ts ?? null
  }

  /** Close expired idle sessions unless daemon-side work exempts them. */
  async closeIdleSessions(
    now: number,
    ttlMs: number,
    // ACP ids need agent scope; the logical key also fences work admitted before durable prompting state.
    isExempt?: (agentId: string, acpSessionId: string | null, key: string) => boolean | Promise<boolean>
  ): Promise<
    {
      key: string
      agentId: string
      platform: string
      channel: string
      thread: string
      acpSessionId: string | null
    }[]
  > {
    const cutoff = now - ttlMs
    const candidates = (await this.db
      .prepare(
        "SELECT key, agentId, platform, channel, thread, acpSessionId FROM sessions WHERE state = 'idle' AND updatedAt < ?"
      )
      .all(cutoff)) as {
      key: string
      agentId: string
      platform: string
      channel: string
      thread: string
      acpSessionId: string | null
    }[]
    // The exemption probe is awaited before the close transaction opens, never inside it.
    const exempt = isExempt
      ? await Promise.all(candidates.map((r) => isExempt(r.agentId, r.acpSessionId, r.key)))
      : undefined
    const rows = exempt ? candidates.filter((_, i) => !exempt[i]) : candidates
    // Only the rows this call closed are reported: a candidate a new turn reopened meanwhile is not.
    const closed: typeof rows = []
    if (rows.length) {
      await this.transaction(async (raw) => {
        const close = accessOf(raw).prepare("UPDATE sessions SET state = 'closed' WHERE key = ? AND state = 'idle'")
        for (const r of rows) if (Number((await close.run(r.key)).changes) === 1) closed.push(r)
      })
    }
    return closed
  }

  /** Retention-GC candidates (#485): sessions whose last activity (`updatedAt`)
   *  is older than `cutoff` and that are not mid-turn. Unlike listSessions this
   *  includes rows with no ACP id — a session that never bound one can still own
   *  a worktree directory. Oldest first, so a bounded pass drains the backlog in
   *  eviction order. `resuming`/`prompting`/`cancelling` rows are live by
   *  definition and never candidates. */
  async listExpiredSessions(cutoff: number): Promise<SessionRecord[]> {
    return (await this.db
      .prepare("SELECT * FROM sessions WHERE state IN ('idle', 'closed') AND updatedAt < ? ORDER BY updatedAt ASC")
      .all(cutoff)) as unknown as SessionRecord[]
  }

  /** True when the session key still has PENDING durable inbox rows (admitted
   *  work that has not reached a terminal state). The retention sweep treats such
   *  a session as active and skips it. Completed rows — hook dedup receipts and
   *  unacknowledged terminal reports — do NOT pin the session: a hook session
   *  keeps its receipt forever, and counting it would exempt exactly the
   *  review-agent sessions #485 exists to collect. */
  async sessionHasPendingInboxRows(key: string): Promise<boolean> {
    const row = (await this.db
      .prepare('SELECT 1 AS present FROM inbox WHERE sessionKey = ? AND completedAt IS NULL LIMIT 1')
      .get(key)) as { present: number } | undefined
    return row !== undefined
  }

  /** The same question asked of a whole AGENT, for a decision about something every one of its
   *  sessions shares — a retired workspace root. Completed rows are excluded for the same reason. */
  async agentHasPendingInboxRows(agentId: string): Promise<boolean> {
    const row = (await this.db
      .prepare('SELECT 1 AS present FROM inbox WHERE agentId = ? AND completedAt IS NULL LIMIT 1')
      .get(agentId)) as { present: number } | undefined
    return row !== undefined
  }

  /** Retention-GC delete (#485): remove one session row and its dependent rows —
   *  mute, memory-capture gate, durable inbox, permission-request history.
   *  Two deliberate survivors:
   *  - transcript rows — (channel, thread)-scoped and shared across agents, the
   *    thread's history outlives the session;
   *  - unacknowledged terminal hook reports (`terminalReport IS NOT NULL`) — an
   *    outbox the CP has not converged yet, preserved exactly like
   *    removeInboxByAgentId does.
   *  permission_requests and the capture gate are both scoped by agentId, so a
   *  neighbour holding the same runtime-local `acp-1` keeps its own rows.
   *  Returns false when the row is already gone (idempotent). */
  async deleteSession(key: string, purge?: { reason: string; at: number; ownerId?: string }): Promise<boolean> {
    const rec = await this.getSession(key)
    if (!rec) return false
    await this.transaction(async (raw) => {
      const tx = accessOf(raw)
      // The CP-owed receipt is written in the SAME transaction as the delete: the
      // fact "this session's content is gone" must not be able to exist without
      // the report that carries it, in either direction. Only a session that bound
      // an ACP id was ever reported to the CP, so only that one has a row to mark.
      // How the CONTROL PLANE knows this session (§1.1): the id its receipt marks and its outbox
      // row is keyed by. A pre-v12 row answers with its ACP id, which is what it was reported under.
      const outward = rec.sessionId ?? rec.acpSessionId
      // OR IGNORE keeps the FIRST stamp if a still-unacked receipt is somehow
      // re-created for the same id — the console should show when the content
      // actually went away, not when the daemon last retried.
      if (purge && rec.acpSessionId) {
        // Stamped to the deleting member on a shared store: its drain owns it.
        await tx
          .prepare(
            `INSERT OR IGNORE INTO session_purges (agentId, sessionId, reason, purgedAt, ownerId, claimedAt)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(rec.agentId, outward, purge.reason, purge.at, purge.ownerId ?? null, purge.at)
      }
      await tx.prepare('DELETE FROM sessions WHERE key = ?').run(key)
      // Its identity goes with it: the receipt just reported this id as purged, so the next
      // session on the same slot must be a new one, not this one's name reused.
      await tx.prepare('DELETE FROM session_outward_ids WHERE key = ?').run(key)
      await tx.prepare('DELETE FROM session_mutes WHERE key = ?').run(key)
      await tx.prepare('DELETE FROM inbox WHERE sessionKey = ? AND terminalReport IS NULL').run(key)
      if (rec.acpSessionId) {
        // Once the local session content is gone, creating a new CP metadata row
        // from an unacknowledged snapshot would race its purge receipt. Drop the
        // obsolete snapshot; an existing CP row is handled by session_purges.
        await tx
          .prepare('DELETE FROM session_metadata_outbox WHERE agentId = ? AND sessionId = ?')
          .run(rec.agentId, outward)
        await tx
          .prepare('DELETE FROM session_gates WHERE agentId = ? AND acpSessionId = ?')
          .run(rec.agentId, rec.acpSessionId)
        await tx
          .prepare('DELETE FROM permission_requests WHERE agentId = ? AND sessionId = ?')
          .run(rec.agentId, rec.acpSessionId)
      }
    })
    return true
  }

  /**
   * Save the latest metadata snapshot. Lifecycle milestones create an outbox
   * row; enrichment-only updates merely coalesce into a row that is already
   * pending, so startup name refreshes never backfill historical sessions.
   * Returns the revision when a durable row exists after the write.
   */
  async saveSessionMetadataSnapshot(
    agentId: string,
    sessionId: string,
    snapshot: string,
    enqueue: boolean,
    queuedAt: number,
    ownerId?: string
  ): Promise<number | undefined> {
    // Stamped to the writing member: the daemon that produced the snapshot serves the
    // agent, so it is the one that can scope the frame's organization right now.
    const owner = ownerId ?? null
    const row = enqueue
      ? ((await this.db
          .prepare(
            `INSERT INTO session_metadata_outbox
               (agentId, sessionId, revision, snapshot, queuedAt, failedAttempts, nextAttemptAt, ownerId, claimedAt)
             VALUES (?, ?, 1, ?, ?, 0, NULL, ?, ?)
             ON CONFLICT (agentId, sessionId) DO UPDATE SET
               revision = session_metadata_outbox.revision + 1,
               snapshot = excluded.snapshot,
               queuedAt = excluded.queuedAt,
               failedAttempts = 0,
               nextAttemptAt = NULL,
               ownerId = excluded.ownerId,
               claimedAt = excluded.claimedAt
             RETURNING revision`
          )
          .get(agentId, sessionId, snapshot, queuedAt, owner, queuedAt)) as { revision: number } | undefined)
      : ((await this.db
          .prepare(
            `UPDATE session_metadata_outbox
             SET revision = revision + 1, snapshot = ?, queuedAt = ?, failedAttempts = 0, nextAttemptAt = NULL,
                 ownerId = ?, claimedAt = ?
             WHERE agentId = ? AND sessionId = ?
             RETURNING revision`
          )
          .get(snapshot, queuedAt, owner, queuedAt, agentId, sessionId)) as { revision: number } | undefined)
    return row?.revision
  }

  async pendingSessionMetadataSnapshot(
    agentId: string,
    sessionId: string
  ): Promise<SessionMetadataOutboxRow | undefined> {
    return (await this.db
      .prepare(
        `SELECT agentId, sessionId, revision, snapshot, queuedAt, failedAttempts, nextAttemptAt
         FROM session_metadata_outbox WHERE agentId = ? AND sessionId = ?`
      )
      .get(agentId, sessionId)) as unknown as SessionMetadataOutboxRow | undefined
  }

  /** The scope of the outbox this member may work on. A local store owns every row
   *  outright. On a shared pool store a row is offered when this member owns it, or
   *  when it is unowned / its owner's claim lapsed AND this member serves the agent.
   *  Unlike the hook outbox, an unowned row is NOT offered install-wide: the frame
   *  carries the agent's organization, which only a serving member can resolve, so a
   *  parked snapshot must wait for that member instead of circling the pool (#1023). */
  private sessionMetadataScope(
    now: number,
    ownerId?: string,
    agentIds?: readonly string[]
  ): { sql: string; params: SqlParams } {
    if (!this.shared) return { sql: '', params: {} }
    const scope = idScope('agentId', agentIds)
    return {
      sql: ` AND (ownerId = @ownerId OR ((ownerId IS NULL OR COALESCE(claimedAt, 0) <= @staleBefore)${scope.sql}))`,
      params: { ownerId: ownerId ?? null, staleBefore: now - SHARED_OUTBOX_LEASE_MS, ...scope.params }
    }
  }

  /** Everything this member is eventually answerable for: its own rows plus every row of
   *  an agent it serves, whoever holds the claim right now. Wider than the claimable-now
   *  scope on purpose — a peer's live claim on a served agent's row still has to arm this
   *  member's wake, or nothing would run when that claim lapses. */
  private sessionMetadataWorkScope(ownerId?: string, agentIds?: readonly string[]): { sql: string; params: SqlParams } {
    if (!this.shared) return { sql: '', params: {} }
    const scope = idScope('agentId', agentIds)
    return {
      sql: ` AND (ownerId = @ownerId OR 1 = 1${scope.sql})`,
      params: { ownerId: ownerId ?? null, ...scope.params }
    }
  }

  async nextSessionMetadataSnapshot(
    now = Date.now(),
    ownerId?: string,
    agentIds?: readonly string[]
  ): Promise<SessionMetadataOutboxRow | undefined> {
    const scope = this.sessionMetadataScope(now, ownerId, agentIds)
    return (await this.db
      .prepare(
        `SELECT agentId, sessionId, revision, snapshot, queuedAt, failedAttempts, nextAttemptAt
         FROM session_metadata_outbox
         WHERE (nextAttemptAt IS NULL OR nextAttemptAt <= @now)${scope.sql}
         ORDER BY queuedAt ASC LIMIT 1`
      )
      .get({ now, ...scope.params })) as unknown as SessionMetadataOutboxRow | undefined
  }

  /** Take or renew this member's claim on one snapshot before emitting it. Local
   *  stores never lease: the single owner claims everything. */
  async claimSessionMetadataSnapshot(
    agentId: string,
    sessionId: string,
    revision: number,
    ownerId: string | undefined,
    now: number
  ): Promise<boolean> {
    if (!this.shared) return true
    return (
      (
        await this.db
          .prepare(
            `UPDATE session_metadata_outbox
           SET ownerId = @ownerId, claimedAt = @now
           WHERE agentId = @agentId AND sessionId = @sessionId AND revision = @revision
             AND (ownerId IS NULL OR ownerId = @ownerId OR COALESCE(claimedAt, 0) <= @staleBefore)`
          )
          .run({
            agentId,
            sessionId,
            revision,
            ownerId: ownerId ?? null,
            now,
            staleBefore: now - SHARED_OUTBOX_LEASE_MS
          })
      ).changes === 1
    )
  }

  /** Hand a snapshot this member cannot scope back to the pool: the claim is released
   *  so the member serving the agent picks it up, the body and the failure count are
   *  untouched, and the backoff keeps it out of this member's next pass. Returns false
   *  on a local store, where there is no other member to park it for. */
  async parkSessionMetadataSnapshot(
    agentId: string,
    sessionId: string,
    revision: number,
    retryAt: number
  ): Promise<boolean> {
    if (!this.shared) return false
    return (
      (
        await this.db
          .prepare(
            `UPDATE session_metadata_outbox
           SET ownerId = NULL, claimedAt = NULL, nextAttemptAt = @retryAt
           WHERE agentId = @agentId AND sessionId = @sessionId AND revision = @revision`
          )
          .run({ agentId, sessionId, revision, retryAt })
      ).changes === 1
    )
  }

  /** Hand the snapshots of agents a member has just gained back to the pool: the parked
   *  ones lose their backoff and a previous holder's claim — live or not — is released,
   *  because the duty ledger has already proved that member no longer serves the agent.
   *  This member's own claims are left alone; only it knows whether they are in flight. */
  async reclaimSessionMetadataSnapshots(agentIds: readonly string[], ownerId?: string): Promise<number> {
    if (!this.shared || agentIds.length === 0) return 0
    const scope = idScope('agentId', agentIds)
    return Number(
      (
        await this.db
          .prepare(
            `UPDATE session_metadata_outbox
           SET ownerId = NULL, claimedAt = NULL, nextAttemptAt = NULL
           WHERE (ownerId IS NULL OR ownerId <> @ownerId)${scope.sql}`
          )
          .run({ ownerId: ownerId ?? null, ...scope.params })
      ).changes
    )
  }

  /** Release every claim this member still holds, at shutdown: it will not emit again, so
   *  a successor must not wait out the lease. Bodies, revisions and backoffs survive. */
  async releaseOwnedSessionMetadataSnapshots(ownerId?: string): Promise<number> {
    if (!this.shared) return 0
    return Number(
      (
        await this.db
          .prepare(
            `UPDATE session_metadata_outbox
           SET ownerId = NULL, claimedAt = NULL, nextAttemptAt = NULL
           WHERE ownerId = @ownerId`
          )
          .run({ ownerId: ownerId ?? null })
      ).changes
    )
  }

  /** When the earliest row this member is answerable for becomes workable: its own backoff,
   *  or — for a row a peer still holds — the later of that backoff and the moment the claim
   *  lapses. Without the second half a graceful handoff leaves a live foreign claim with
   *  nothing armed to outlast it. Written as one CASE rather than a two-argument `max()`: the
   *  same statement text runs on the pool's PostgreSQL, where `MAX` is only an aggregate. */
  async nextSessionMetadataAttemptAt(ownerId?: string, agentIds?: readonly string[]): Promise<number | undefined> {
    const scope = this.sessionMetadataWorkScope(ownerId, agentIds)
    const workableAt = this.shared
      ? `CASE WHEN ownerId IS NOT NULL AND ownerId <> @ownerId
                AND COALESCE(claimedAt, 0) + @lease > COALESCE(nextAttemptAt, 0)
           THEN COALESCE(claimedAt, 0) + @lease ELSE COALESCE(nextAttemptAt, 0) END`
      : 'COALESCE(nextAttemptAt, 0)'
    const row = (await this.db
      .prepare(`SELECT MIN(${workableAt}) AS attemptAt FROM session_metadata_outbox WHERE 1 = 1${scope.sql}`)
      .get({ ...scope.params, ...(this.shared ? { lease: SHARED_OUTBOX_LEASE_MS } : {}) })) as
      { attemptAt: number | null } | undefined
    return row?.attemptAt === null || row?.attemptAt === undefined ? undefined : Number(row.attemptAt)
  }

  async recordSessionMetadataSnapshotFailure(
    agentId: string,
    sessionId: string,
    revision: number,
    nextAttemptAt: number | null,
    ownerId?: string
  ): Promise<Pick<SessionMetadataOutboxRow, 'failedAttempts' | 'nextAttemptAt'> | undefined> {
    const fence = this.shared ? ' AND (ownerId IS NULL OR ownerId = @ownerId)' : ''
    return (await this.db
      .prepare(
        `UPDATE session_metadata_outbox
         SET failedAttempts = failedAttempts + 1, nextAttemptAt = @nextAttemptAt
         WHERE agentId = @agentId AND sessionId = @sessionId AND revision = @revision${fence}
         RETURNING failedAttempts, nextAttemptAt`
      )
      .get({ agentId, sessionId, revision, nextAttemptAt, ...(fence ? { ownerId: ownerId ?? null } : {}) })) as
      Pick<SessionMetadataOutboxRow, 'failedAttempts' | 'nextAttemptAt'> | undefined
  }

  /** Any row this member is answerable for, workable now or once a peer's claim lapses. */
  async hasPendingSessionMetadata(ownerId?: string, agentIds?: readonly string[]): Promise<boolean> {
    const scope = this.sessionMetadataWorkScope(ownerId, agentIds)
    return (
      (await this.db
        .prepare(`SELECT 1 AS pending FROM session_metadata_outbox WHERE 1 = 1${scope.sql} LIMIT 1`)
        .get(scope.params)) !== undefined
    )
  }

  /** Clear exactly the revision the CP ACKed. A newer coalesced snapshot wins. On a
   *  shared store only the claim holder may drop a row — never a peer's. */
  async acknowledgeSessionMetadataSnapshot(
    agentId: string,
    sessionId: string,
    revision: number,
    ownerId?: string
  ): Promise<boolean> {
    const fence = this.shared ? ' AND (ownerId IS NULL OR ownerId = @ownerId)' : ''
    const result = await this.db
      .prepare(
        `DELETE FROM session_metadata_outbox
         WHERE agentId = @agentId AND sessionId = @sessionId AND revision = @revision${fence}`
      )
      .run({ agentId, sessionId, revision, ...(fence ? { ownerId: ownerId ?? null } : {}) })
    return result.changes === 1
  }

  /** Retention-GC receipts still owed to the CP, oldest purge first, bounded.
   *  Grouped per agent by the caller: one `event/session-purged` frame reports one
   *  agent, because the CP authorizes the report against that agent's placement.
   *  A local store owns every receipt outright. On a shared pool store a row is
   *  offered only when this member owns it, when it is unowned (pre-pool), or when
   *  its owner's claim lapsed AND this member serves the agent — the same lease
   *  the hook-completion outbox uses, so a live peer's receipt stays with its owner. */
  async listSessionPurges(
    limit: number,
    now: number,
    ownerId?: string,
    agentIds?: readonly string[]
  ): Promise<SessionPurgeRow[]> {
    const columns = 'SELECT agentId, sessionId, reason, purgedAt FROM session_purges'
    const order = ' ORDER BY purgedAt ASC LIMIT @limit'
    if (!this.shared)
      return (await this.db.prepare(`${columns}${order}`).all({ limit })) as unknown as SessionPurgeRow[]
    const scope = idScope('agentId', agentIds)
    return (await this.db
      .prepare(
        `${columns}
         WHERE (ownerId IS NULL OR ownerId = @ownerId
                OR (COALESCE(claimedAt, 0) <= @staleBefore${scope.sql}))${order}`
      )
      .all({
        limit,
        ownerId: ownerId ?? null,
        staleBefore: now - SHARED_OUTBOX_LEASE_MS,
        ...scope.params
      })) as unknown as SessionPurgeRow[]
  }

  /** Take or renew this member's claim on the receipts of one frame before emitting
   *  it, returning the session ids actually claimed — a row a peer took over between
   *  the list and this CAS is left out. Local stores never lease: everything is claimed. */
  async claimSessionPurges(
    agentId: string,
    sessionIds: readonly string[],
    ownerId: string | undefined,
    now: number
  ): Promise<string[]> {
    if (!this.shared) return [...sessionIds]
    const staleBefore = now - SHARED_OUTBOX_LEASE_MS
    const claimed: string[] = []
    await this.transaction(async (raw) => {
      const claim = accessOf(raw).prepare(
        `UPDATE session_purges
       SET ownerId = @ownerId, claimedAt = @now
       WHERE agentId = @agentId AND sessionId = @sessionId
         AND (ownerId IS NULL OR ownerId = @ownerId OR COALESCE(claimedAt, 0) <= @staleBefore)`
      )
      for (const sessionId of sessionIds) {
        if ((await claim.run({ agentId, sessionId, ownerId: ownerId ?? null, now, staleBefore })).changes === 1)
          claimed.push(sessionId)
      }
    })
    return claimed
  }

  /** Settle receipts the CP has ACKed. Scoped by agent: the same ACP id may still
   *  be owed for a different agent (ids are runtime-local). On a shared store only
   *  the claim holder (or nobody) may release a row — never a peer. */
  async acknowledgeSessionPurges(agentId: string, sessionIds: string[], ownerId?: string): Promise<void> {
    if (sessionIds.length === 0) return
    const fence = this.shared ? ' AND (ownerId IS NULL OR ownerId = @ownerId)' : ''
    await this.transaction(async (raw) => {
      const stmt = accessOf(raw).prepare(
        `DELETE FROM session_purges WHERE agentId = @agentId AND sessionId = @sessionId${fence}`
      )
      for (const sessionId of sessionIds) {
        await stmt.run({ agentId, sessionId, ...(fence ? { ownerId: ownerId ?? null } : {}) })
      }
    })
  }

  // ── retention (docs/designs/k8s-daemon-pool.md §4; the rule table in store/retention.ts) ──

  /** True on a pool's shared data-plane store — the only place a row can outlive its writer. */
  get isShared(): boolean {
    return this.shared
  }

  /** The partition this process stamps its per-member cache rows with. The retention sweep
   *  compares against it to tell its own rows from a departed writer's. */
  get cacheOwner(): string {
    return this.cacheOwnerId
  }

  /** Every row one retention rule is about, oldest first, with the clock it is judged by.
   *  Reads only: which of these are collectable is policy and lives in the rule table. */
  async listRetentionCandidates(rule: StoreRetentionRule, limit = 5_000): Promise<StoreRetentionCandidate[]> {
    const columns = [
      ...new Set([
        ...rule.key,
        ...(rule.agentColumn ? [rule.agentColumn] : []),
        ...(rule.ownerColumn ? [rule.ownerColumn] : [])
      ])
    ]
    const rows = (await this.db
      .prepare(
        `SELECT ${columns.join(', ')}, ${rule.clock} AS touchedAt FROM ${rule.table}
         WHERE ${rule.where ?? '1 = 1'} ORDER BY ${rule.clock} ASC LIMIT @limit`
      )
      .all({ limit })) as unknown as Record<string, string | number | null>[]
    return rows.map((row) => ({
      key: Object.fromEntries(rule.key.map((column) => [column, row[column] as string | number])),
      ...(rule.agentColumn && row[rule.agentColumn] != null ? { agentId: String(row[rule.agentColumn]) } : {}),
      ...(rule.ownerColumn && row[rule.ownerColumn] != null ? { ownerId: String(row[rule.ownerColumn]) } : {}),
      touchedAt: Number(row.touchedAt)
    }))
  }

  /** Collect one row the sweeper decided is collectable. The clock it was judged on rides the
   *  DELETE, so a row anything wrote between the read and here is left alone. */
  async deleteRetentionRow(rule: StoreRetentionRule, candidate: StoreRetentionCandidate): Promise<boolean> {
    const key = rule.key.map((column) => `${column} = @key_${column}`).join(' AND ')
    const params = Object.fromEntries(rule.key.map((column) => [`key_${column}`, candidate.key[column]!]))
    const result = await this.db
      .prepare(
        `DELETE FROM ${rule.table}
         WHERE ${key} AND ${rule.clock} <= @touchedAt${rule.where ? ` AND ${rule.where}` : ''}`
      )
      .run({ ...params, touchedAt: candidate.touchedAt } as SqlParams)
    return Number(result.changes) === 1
  }

  // ── memory dream jobs (docs/designs/memory-dreaming.md §4; DreamStorePort) ──

  private dreamToRow(dream: DreamInfo): SqlParams {
    return {
      dreamId: dream.dreamId,
      agentId: dream.agentId,
      status: dream.status,
      triggerKind: dream.trigger,
      sessionIds: JSON.stringify(dream.sessionIds),
      snapshotDigest: dream.snapshotDigest,
      executionSessionId: dream.executionSessionId ?? null,
      runtime: dream.runtime ?? null,
      model: dream.model ?? null,
      stopReason: dream.stopReason ?? null,
      snapshotWrites: dream.snapshotWrites ? JSON.stringify(dream.snapshotWrites) : null,
      instructions: dream.instructions ?? null,
      skills: dream.skills ? JSON.stringify(dream.skills) : null,
      organizationSuggestions: dream.organizationSuggestions ? JSON.stringify(dream.organizationSuggestions) : null,
      usage: dream.usage ? JSON.stringify(dream.usage) : null,
      error: dream.error ? JSON.stringify(dream.error) : null,
      createdAt: dream.createdAt,
      endedAt: dream.endedAt ?? null,
      ownerId: this.ownerId ?? null
    }
  }

  private dreamFromRow(row: Record<string, unknown>): DreamInfo {
    return {
      dreamId: row.dreamId as string,
      agentId: row.agentId as string,
      status: row.status as DreamInfo['status'],
      trigger: row.triggerKind as DreamInfo['trigger'],
      sessionIds: JSON.parse(row.sessionIds as string) as string[],
      snapshotDigest: row.snapshotDigest as string,
      ...(row.executionSessionId ? { executionSessionId: row.executionSessionId as string } : {}),
      ...(row.runtime ? { runtime: row.runtime as string } : {}),
      ...(row.model ? { model: row.model as string } : {}),
      ...(row.stopReason ? { stopReason: row.stopReason as string } : {}),
      ...(row.snapshotWrites
        ? { snapshotWrites: JSON.parse(row.snapshotWrites as string) as DreamInfo['snapshotWrites'] }
        : {}),
      ...(row.instructions ? { instructions: row.instructions as string } : {}),
      ...(row.skills ? { skills: JSON.parse(row.skills as string) as DreamInfo['skills'] } : {}),
      ...(row.organizationSuggestions
        ? {
            organizationSuggestions: JSON.parse(
              row.organizationSuggestions as string
            ) as DreamInfo['organizationSuggestions']
          }
        : {}),
      ...(row.usage ? { usage: JSON.parse(row.usage as string) as DreamInfo['usage'] } : {}),
      ...(row.error ? { error: JSON.parse(row.error as string) as DreamInfo['error'] } : {}),
      createdAt: row.createdAt as string,
      ...(row.endedAt ? { endedAt: row.endedAt as string } : {})
    }
  }

  async insertDream(dream: DreamInfo): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO dreams (dreamId, agentId, status, triggerKind, sessionIds, snapshotDigest,
           executionSessionId, runtime, model, stopReason, snapshotWrites, instructions, skills, organizationSuggestions,
           usage, error, createdAt, endedAt, ownerId)
         VALUES (@dreamId, @agentId, @status, @triggerKind, @sessionIds, @snapshotDigest,
           @executionSessionId, @runtime, @model, @stopReason, @snapshotWrites, @instructions, @skills,
           @organizationSuggestions, @usage, @error, @createdAt, @endedAt, @ownerId)`
      )
      .run(this.dreamToRow(dream))
  }

  /** Whoever writes a dream row is the process running it, so every write re-stamps
   *  ownership — a reclaimed dream never reads as its former owner's. */
  async updateDream(dream: DreamInfo): Promise<void> {
    await this.db
      .prepare(`UPDATE dreams SET ${DREAM_UPDATE_SET} WHERE dreamId = @dreamId AND agentId = @agentId`)
      .run(this.dreamToRow(dream))
  }

  /** Crash-recovery write, CAS'd on the open statuses so a losing race can never overwrite
   *  the terminal outcome the dream's own runner recorded. */
  async failOpenDream(dream: DreamInfo): Promise<boolean> {
    return (
      Number(
        (
          await this.db
            .prepare(
              `UPDATE dreams SET ${DREAM_UPDATE_SET}
             WHERE dreamId = @dreamId AND agentId = @agentId AND status IN ('pending', 'running')`
            )
            .run(this.dreamToRow(dream))
        ).changes
      ) === 1
    )
  }

  async getDream(agentId: string, dreamId: string): Promise<DreamInfo | undefined> {
    const row = (await this.db
      .prepare('SELECT * FROM dreams WHERE dreamId = ? AND agentId = ?')
      .get(dreamId, agentId)) as Record<string, unknown> | undefined
    return row ? this.dreamFromRow(row) : undefined
  }

  async listDreams(agentId: string, limit: number): Promise<DreamInfo[]> {
    return (
      (await this.db
        .prepare('SELECT * FROM dreams WHERE agentId = ? ORDER BY createdAt DESC, dreamId DESC LIMIT ?')
        .all(agentId, limit)) as Record<string, unknown>[]
    ).map((row) => this.dreamFromRow(row))
  }

  async organizationSuggestionDreams(limit: number): Promise<DreamInfo[]> {
    return (
      (
        (await this.db
          .prepare(
            `SELECT * FROM dreams WHERE organizationSuggestions LIKE '%"state":"proposed"%'
             ORDER BY createdAt DESC, dreamId DESC LIMIT ?`
          )
          .all(limit)) as Record<string, unknown>[]
      )
        // The LIKE is only a bounded pre-filter. Decode and decide on the
        // structured value so terminal rows can never consume the inventory.
        .map((row) => this.dreamFromRow(row))
        .filter((dream) => (dream.organizationSuggestions ?? []).some((suggestion) => suggestion.state === 'proposed'))
    )
  }

  /** Dreams still holding an unreviewed skill candidate, newest first. Scanned
   *  independently of the public history page: a proposal survives adoption and
   *  discard until it is reviewed, so it must not age out behind newer runs. */
  async pendingSkillDreams(agentId: string, limit: number): Promise<DreamInfo[]> {
    return (
      (
        (await this.db
          .prepare(
            `SELECT * FROM dreams WHERE agentId = ? AND skills LIKE '%"state":"proposed"%'
             ORDER BY createdAt DESC, dreamId DESC LIMIT ?`
          )
          .all(agentId, limit)) as Record<string, unknown>[]
      )
        // The LIKE is a cheap SUPERSET pre-filter pushed into the query so rows
        // with no pending candidate (empty, or only accepted/dismissed) never
        // consume the window — a bounded pre-scan filtered afterwards just moves
        // the age-out boundary. The decode below is what actually decides.
        .map((row) => this.dreamFromRow(row))
        .filter((dream) => (dream.skills ?? []).some((skill) => skill.state === 'proposed'))
    )
  }

  /** Non-terminal dreams this process is answerable for — the boot-time crash-recovery sweep. On a
   *  shared store that is only what this incarnation started: a peer's in-flight dream is live work. */
  async openDreams(): Promise<DreamInfo[]> {
    const owned = this.shared ? ' AND ownerId = @ownerId' : ''
    return (
      (await this.db
        .prepare(`SELECT * FROM dreams WHERE status IN ('pending', 'running')${owned}`)
        .all(...(this.shared ? [{ ownerId: this.ownerId! }] : []))) as Record<string, unknown>[]
    ).map((row) => this.dreamFromRow(row))
  }

  /** Non-terminal dreams left behind by a FORMER owner of these agents. Only the CP handing
   *  this process the duty makes them recoverable — mirrors recoverPermissionRequests. */
  async strandedDreams(agentIds: readonly string[]): Promise<DreamInfo[]> {
    if (!this.shared || agentIds.length === 0) return []
    const scope = idScope('agentId', agentIds)
    return (
      (await this.db
        .prepare(
          `SELECT * FROM dreams
           WHERE status IN ('pending', 'running') AND (ownerId IS NULL OR ownerId != @ownerId)${scope.sql}`
        )
        .all({ ownerId: this.ownerId!, ...scope.params })) as Record<string, unknown>[]
    ).map((row) => this.dreamFromRow(row))
  }

  async completedDreams(agentId: string): Promise<DreamInfo[]> {
    return (
      (await this.db.prepare("SELECT * FROM dreams WHERE agentId = ? AND status = 'completed'").all(agentId)) as Record<
        string,
        unknown
      >[]
    ).map((row) => this.dreamFromRow(row))
  }

  /** Store proposals reconciled as stale during upgrade. The runner removes
   *  their daemon-local staging once agent directories are available. */
  async supersededDreams(): Promise<DreamInfo[]> {
    return (
      (await this.db.prepare("SELECT * FROM dreams WHERE status = 'superseded'").all()) as Record<string, unknown>[]
    ).map((row) => this.dreamFromRow(row))
  }

  /** Newest-first addressable sessions to mine as dream transcript sources. */
  async dreamSessionSources(
    agentId: string,
    limit: number
  ): Promise<
    { sessionId: string; channel: string; thread: string; transportScope?: string | null; updatedAt: number }[]
  > {
    const rows = (await this.db
      .prepare(
        // Outward ids (§1.1): these become the citations the model grounds a skill candidate in,
        // and from there the dream's durable, CP-visible provenance. A pre-v12 row answers with
        // its ACP id, which is what that session was reported under.
        `SELECT COALESCE(sessionId, acpSessionId) AS sessionId, channel, thread, transportScope, updatedAt
         FROM sessions
         WHERE agentId = ? AND acpSessionId IS NOT NULL AND platform <> 'dream'
         ORDER BY updatedAt DESC LIMIT ?`
      )
      .all(agentId, limit)) as {
      sessionId: string
      channel: string
      thread: string
      transportScope: string | null
      updatedAt: number
    }[]
    return rows.map(({ transportScope, ...row }) => (transportScope ? { ...row, transportScope } : row))
  }

  /** Chronological conversational text of one session thread, scoped like
   *  `transcriptPageForAgent` (a peer's private rows never enter a dream). */
  /**
   * Rows for one session thread. `includeTools` additionally returns tool
   * TITLES — the ACP `title` (e.g. `Bash(npm run deploy)`), which carries the
   * command or path. It never returns the tool `body`: that holds rawOutput as
   * well as rawInput, and raw output is where secrets and bulk noise live
   * (design §4). Skill mining needs the trajectory, not the payloads.
   */
  /**
   * A bounded, single-line summary of a tool row's `rawInput` — the command or
   * path the agent ran. Reads ONLY `rawInput`: `rawOutput` and `content` are the
   * bulk/secret-bearing halves of the body and never reach a prompt.
   */
  private static toolRawInput(body: string | null | undefined): string | undefined {
    if (!body) return undefined
    let parsed: { rawInput?: unknown }
    try {
      parsed = JSON.parse(body) as { rawInput?: unknown }
    } catch {
      return undefined
    }
    const raw = parsed.rawInput
    if (raw === undefined || raw === null) return undefined
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
    if (!text) return undefined
    const flat = text.replace(/[\r\n]+/g, ' ').trim()
    return flat.length > DREAM_TOOL_INPUT_CHARS ? `${flat.slice(0, DREAM_TOOL_INPUT_CHARS)}…` : flat
  }

  async dreamTranscriptText(
    channel: string,
    thread: string,
    agentId: string,
    limit: number,
    includeTools = false,
    transportScope?: string | null
  ): Promise<{ sender: string; text: string; kind?: string; input?: string }[]> {
    const transcriptChannel = transcriptChannelKey(channel, transportScope)
    const rows = (await this.db
      .prepare(
        // SECURITY: gate the delivery-table match on `kind = 'text'`, exactly as
        // the session-history query does. Internal rows (tool/reasoning) are NOT
        // deduped by ts and can share a ts with a delivered text row, so an
        // ungated EXISTS would pull a PEER's private tool title into this agent's
        // mining prompt. Deliveries only ever concern conversational messages;
        // this agent's own tool rows still surface through `sender`.
        `SELECT sender, text, kind, body FROM transcript
         WHERE orgId = ? AND channel = ? AND thread = ? AND kind ${includeTools ? "IN ('text','tool')" : "= 'text'"}
           AND (sender = ? OR recipient = ? OR (transcript.kind = 'text' AND EXISTS (
             SELECT 1 FROM transcript_recipient tr
             WHERE tr.orgId = transcript.orgId AND tr.channel = transcript.channel
               AND tr.thread = transcript.thread
               AND tr.ts = transcript.ts AND tr.agentId = ?)))
           AND NOT (kind = 'tool' AND text IN (?, ?))
         ORDER BY seq DESC LIMIT ?`
      )
      .all(
        this.orgFor(agentId),
        transcriptChannel,
        thread,
        agentId,
        agentId,
        agentId,
        ...SESSION_TITLE_TOOL_TITLES,
        limit
      )) as {
      sender: string
      text: string
      kind?: string
      body?: string | null
    }[]
    // Tool rows carry the title plus a BOUNDED rawInput (the command or path),
    // which a generic title like "Bash" would otherwise lose. rawOutput is never
    // read: it is the bulk/secret-bearing half of the body (design §4).
    return rows.reverse().map((row) => {
      if (row.kind !== 'tool') return { sender: row.sender, text: row.text, kind: row.kind }
      return { sender: row.sender, text: row.text, kind: row.kind, input: LocalStore.toolRawInput(row.body) }
    })
  }

  /** The conversational text row occupying one exact `(channel, thread, ts)` slot,
   *  if any — the probe behind webchat's canonical-timestamp collision bump:
   *  `INSERT OR IGNORE` under the `transcript_text_ts` unique index would silently
   *  drop a DIFFERENT post landing on an occupied millisecond, so writers check
   *  the slot first and bump when it holds foreign content. */
  async transcriptTextAt(
    channel: string,
    thread: string,
    ts: string,
    row: { sender: string; recipient?: string }
  ): Promise<{ sender: string; text: string; postId: string | null } | undefined> {
    // Attributed exactly like the append it guards, or the probe would read a partition
    // the write does not land in and every slot would look free.
    const orgId = await this.transcriptOrg(channel, thread, row.recipient, row.sender)
    return (await this.db
      .prepare(
        `SELECT sender, text, postId FROM transcript
         WHERE orgId = ? AND channel = ? AND thread = ? AND ts = ? AND kind = 'text'`
      )
      .get(orgId, channel, thread, ts)) as { sender: string; text: string; postId: string | null } | undefined
  }

  async appendTranscript(e: TranscriptEntry): Promise<void> {
    const { attachments, trustedAgentBot, quoted, quoteJson, authoritative, orgAgentId, ...entry } = e
    const durableQuoteJson = quoted?.text ? JSON.stringify(quoted) : (quoteJson ?? null)
    // Attribution is a plain read, resolved before the lock the write path below holds.
    const orgId = await this.transcriptOrg(e.channel, e.thread, e.recipient, e.sender, orgAgentId)
    // The row, its delivery record, and the thread revision the caller needs next, in one
    // round trip. `transcript_recipient` is a different table, so its insert moving ahead of
    // the in-place upgrades below changes nothing either statement can observe.
    const recordsDelivery = !!e.recipient && !!e.ts
    return this.transcriptMutex.run(() =>
      this.appendTranscriptLocked(e, {
        orgId,
        recordsDelivery,
        entry,
        attachments,
        trustedAgentBot,
        durableQuoteJson,
        authoritative
      })
    )
  }

  /** The transcript write itself, under {@link transcriptMutex}: its statements and the
   *  in-memory revision they allocate from must not interleave with another turn's. */
  private async appendTranscriptLocked(
    e: TranscriptEntry,
    ctx: {
      orgId: string
      recordsDelivery: boolean
      entry: Omit<
        TranscriptEntry,
        'attachments' | 'trustedAgentBot' | 'quoted' | 'quoteJson' | 'authoritative' | 'orgAgentId'
      >
      attachments: SessionImageAttachment[] | undefined
      trustedAgentBot: boolean | undefined
      durableQuoteJson: string | null
      authoritative: boolean | undefined
    }
  ): Promise<void> {
    const { orgId, recordsDelivery, entry, attachments, trustedAgentBot, durableQuoteJson, authoritative } = ctx
    const { changes, revision } = await this.writeTranscriptRows(orgId, e.channel, e.thread, [
      {
        kind: 'run',
        sql: `INSERT OR IGNORE INTO transcript
           (orgId, channel, thread, ts, sender, kind, text, body, recipient, eventTimeUs, attachmentsJson, quoteJson, trustedAgentBot, revision, postId)
         VALUES
           (@orgId, @channel, @thread, @ts, @sender, @kind, @text, @body, @recipient, @eventTimeUs, @attachmentsJson, @quoteJson, @trustedAgentBot, @revision, @postId)`,
        params: [
          {
            ...entry,
            orgId,
            body: e.body ?? null,
            recipient: e.recipient ?? null,
            postId: e.postId ?? null,
            eventTimeUs: e.eventTimeUs ?? transcriptEventTimeUs(e.ts),
            attachmentsJson: attachments?.length ? JSON.stringify(attachments) : null,
            quoteJson: durableQuoteJson,
            trustedAgentBot: trustedAgentBot ? 1 : null,
            revision: this.transcriptRevision + 1
          } as unknown as SqlParams
        ]
      },
      // Recorded separately so it survives the text-row dedup above: if this same
      // (channel, thread, ts) was already recorded by another agent, the INSERT OR IGNORE
      // dropped this row and its `recipient`, but the message WAS delivered to this agent too.
      ...(recordsDelivery
        ? [
            {
              kind: 'run' as const,
              sql: 'INSERT OR IGNORE INTO transcript_recipient (orgId, channel, thread, ts, agentId) VALUES (?, ?, ?, ?, ?)',
              params: [orgId, e.channel, e.thread, e.ts, e.recipient]
            }
          ]
        : [])
    ])
    const inserted = changes[0] ?? 0
    const delivered = recordsDelivery ? (changes[1] ?? 0) : 0
    if (inserted === 1) this.transcriptRevision = revision
    // The closing edit of a streamed reply lands on the row its own post created, so the
    // text is refreshed in place rather than lost to INSERT OR IGNORE. Scoped to text
    // rows on identical coordinates, and only ever toward the authoritative version.
    if (inserted === 0 && authoritative && e.kind === 'text') {
      const refreshed = await this.writeTranscriptRows(orgId, e.channel, e.thread, [
        {
          kind: 'run',
          sql: `UPDATE transcript SET text = ?, revision = ?
           WHERE orgId = ? AND channel = ? AND thread = ? AND ts = ? AND kind = 'text' AND text IS NOT ?`,
          params: [e.text, this.transcriptRevision + 1, orgId, e.channel, e.thread, e.ts, e.text]
        }
      ])
      if (refreshed.changes[0] === 1) {
        this.transcriptRevision = refreshed.revision
        this.notifyTranscriptMutation(e.channel, e.thread, e.recipient ? [e.recipient] : [], this.transcriptRevision)
      }
    }
    // A row may predate this column and later be re-observed in an authoritative Slack
    // snapshot. Upgrade only toward trusted=true; an untrusted replay can never clear or
    // manufacture provenance, and the stable text-row coordinates keep this scoped.
    const provenanceUpgraded =
      inserted === 0 && trustedAgentBot
        ? await this.lockedDb
            .prepare(
              `UPDATE transcript SET trustedAgentBot = 1
               WHERE orgId = ? AND channel = ? AND thread = ? AND ts = ? AND kind = 'text'
                 AND COALESCE(trustedAgentBot, 0) = 0`
            )
            .run(orgId, e.channel, e.thread, e.ts)
        : undefined
    // The same canonical post can be recorded first by a pre-upgrade write (no
    // postId column value) and re-observed by a copy that carries it. Upgrade in
    // place; an identity can be added but never changed or cleared.
    const postIdUpgraded =
      inserted === 0 && e.postId
        ? await this.lockedDb
            .prepare(
              `UPDATE transcript SET postId = ?
               WHERE orgId = ? AND channel = ? AND thread = ? AND ts = ? AND kind = 'text' AND postId IS NULL`
            )
            .run(e.postId, orgId, e.channel, e.thread, e.ts)
        : undefined
    // The observer often wins the INSERT race against the ingest that carries the turn body, so
    // the body upgrades in place like the post id: added once, never changed or cleared.
    const bodyUpgraded =
      inserted === 0 && e.body && e.kind === 'text'
        ? await this.lockedDb
            .prepare(
              `UPDATE transcript SET body = ?
               WHERE orgId = ? AND channel = ? AND thread = ? AND ts = ? AND kind = 'text' AND body IS NULL`
            )
            .run(e.body, orgId, e.channel, e.thread, e.ts)
        : undefined
    // A later duplicate can be the first copy that carries the AUTHORITATIVE
    // provider send time (an early observer wrote the row with the derived
    // axis). Explicit values only — two derived computations must never flap.
    const eventTimeUpgraded =
      inserted === 0 && e.eventTimeUs
        ? await this.lockedDb
            .prepare(
              `UPDATE transcript SET eventTimeUs = ?
               WHERE orgId = ? AND channel = ? AND thread = ? AND ts = ? AND kind = 'text' AND eventTimeUs IS NOT ?`
            )
            .run(e.eventTimeUs, orgId, e.channel, e.thread, e.ts, e.eventTimeUs)
        : undefined
    // The observer often wins the INSERT race against SessionManager's authoritative
    // append, and only that append has fetched the image bytes — upgrade the row in
    // place instead of leaving attachmentsJson pinned to NULL (the console would then
    // show only the `[attached: …]` label).
    const attachmentsUpgraded =
      inserted === 0 && attachments?.length
        ? await this.lockedDb
            .prepare(
              `UPDATE transcript SET attachmentsJson = ?
               WHERE orgId = ? AND channel = ? AND thread = ? AND ts = ? AND kind = 'text' AND attachmentsJson IS NULL`
            )
            .run(JSON.stringify(attachments), orgId, e.channel, e.thread, e.ts)
        : undefined
    // A later duplicate can be the first copy that carries provider reply metadata
    // (or a corrected selected passage). Upgrade it without ever clearing a quote when
    // a provider snapshot subsequently re-appends the same text row without metadata.
    const quoteUpgraded =
      inserted === 0 && durableQuoteJson !== null
        ? await this.lockedDb
            .prepare(
              `UPDATE transcript SET quoteJson = ?
               WHERE orgId = ? AND channel = ? AND thread = ? AND ts = ? AND kind = 'text'
                 AND COALESCE(quoteJson, '') <> ?`
            )
            .run(durableQuoteJson, orgId, e.channel, e.thread, e.ts, durableQuoteJson)
        : undefined
    if (inserted === 1) {
      this.notifyTranscriptMutation(e.channel, e.thread, [e.sender, e.recipient], this.transcriptRevision)
    } else if (
      Number(provenanceUpgraded?.changes ?? 0) === 1 ||
      Number(attachmentsUpgraded?.changes ?? 0) === 1 ||
      Number(quoteUpgraded?.changes ?? 0) === 1 ||
      Number(postIdUpgraded?.changes ?? 0) === 1 ||
      Number(bodyUpgraded?.changes ?? 0) === 1 ||
      Number(eventTimeUpgraded?.changes ?? 0) === 1 ||
      delivered === 1
    ) {
      // An in-place upgrade mutates the SHARED row: every agent whose scoped
      // view already contains it must be invalidated, not just this append's
      // sender/recipient — a co-hosted participant delivered earlier would
      // otherwise keep serving the stale copy until an unrelated mutation.
      const bumped = await this.lockedDb.batch([
        {
          kind: 'run',
          sql: "UPDATE transcript SET revision = ? WHERE orgId = ? AND channel = ? AND thread = ? AND ts = ? AND kind = 'text'",
          params: [this.transcriptRevision + 1, orgId, e.channel, e.thread, e.ts]
        },
        {
          kind: 'read',
          sql: 'SELECT COALESCE(MAX(revision), 0) AS revision FROM transcript WHERE orgId = ? AND channel = ? AND thread = ?',
          params: [orgId, e.channel, e.thread]
        },
        {
          kind: 'read',
          sql: 'SELECT agentId FROM transcript_recipient WHERE orgId = ? AND channel = ? AND thread = ? AND ts = ?',
          params: [orgId, e.channel, e.thread, e.ts]
        }
      ])
      this.transcriptRevision = Number((bumped[1]?.rows[0] as { revision: number } | undefined)?.revision ?? 0)
      const sharedRecipients = (bumped[2]?.rows as { agentId: string }[]).map((r) => r.agentId)
      this.notifyTranscriptMutation(
        e.channel,
        e.thread,
        [e.sender, e.recipient, ...sharedRecipients],
        this.transcriptRevision
      )
    }
  }

  /** Write this turn's plan row (summary in `text`, the serialized PlanBody in `body`).
   *  An ACP plan update replaces the WHOLE list, so this is an upsert rather than an append:
   *  the insert claims the row on first sight and the update overwrites it on every later
   *  one, keeping `seq`/`ts` at their first-seen values so the plan holds its place in the
   *  turn. Shares the tool row's `tool_call_id` column as its identity — `planId` is minted
   *  per turn and namespaced, and both statements are fenced on kind so a tool id can never
   *  collide with one. */
  upsertPlan(e: {
    channel: string
    thread: string
    ts: string
    sender: string
    planId: string
    title: string
    body: string
  }): Promise<void> {
    const orgId = this.orgFor(e.sender)
    return this.transcriptMutex.run(() => this.upsertPlanLocked(e, orgId))
  }

  /** The upsert itself, under {@link transcriptMutex} — see {@link appendTranscriptLocked}. */
  private async upsertPlanLocked(
    e: { channel: string; thread: string; ts: string; sender: string; planId: string; title: string; body: string },
    orgId: string
  ): Promise<void> {
    const revision = this.transcriptRevision + 1
    const written = await this.writeTranscriptRows(orgId, e.channel, e.thread, [
      {
        kind: 'run',
        sql: `INSERT OR IGNORE INTO transcript
           (orgId, channel, thread, ts, sender, kind, text, tool_call_id, body, eventTimeUs, revision)
         VALUES (@orgId, @channel, @thread, @ts, @sender, 'plan', @text, @planId, @body, @eventTimeUs, @revision)`,
        params: [
          {
            orgId,
            channel: e.channel,
            thread: e.thread,
            ts: e.ts,
            sender: e.sender,
            text: e.title,
            planId: e.planId,
            body: e.body,
            eventTimeUs: transcriptEventTimeUs(e.ts),
            revision
          }
        ]
      },
      {
        kind: 'run',
        sql: `UPDATE transcript SET text = ?, body = ?, revision = ?
         WHERE orgId = ? AND channel = ? AND thread = ? AND sender = ? AND tool_call_id = ? AND kind = 'plan'
           AND (text IS NOT ? OR body IS NOT ?)`,
        params: [e.title, e.body, revision, orgId, e.channel, e.thread, e.sender, e.planId, e.title, e.body]
      }
    ])
    // Either statement changing a row means this thread moved; an unchanged re-send changes
    // neither and must not bump the revision a live console polls on.
    if (written.changes.some((changed) => changed > 0)) {
      this.transcriptRevision = written.revision
      this.notifyTranscriptMutation(e.channel, e.thread, [e.sender], this.transcriptRevision)
    }
  }

  /** First sight of a tool call: insert its kind='tool' row (title in `text`, the
   *  serialized ToolBody in `body`). INSERT OR IGNORE so a re-fired first update is a
   *  no-op — the partial unique index on (channel, thread, sender, tool_call_id)
   *  dedups within one agent. `seq` stays stable across later updates. */
  insertToolCall(e: {
    channel: string
    thread: string
    ts: string
    sender: string
    toolCallId: string
    title: string
    body: string
  }): Promise<void> {
    const orgId = this.orgFor(e.sender)
    return this.transcriptMutex.run(() => this.insertToolCallLocked(e, orgId))
  }

  /** The insert itself, under {@link transcriptMutex} — see {@link appendTranscriptLocked}. */
  private async insertToolCallLocked(
    e: { channel: string; thread: string; ts: string; sender: string; toolCallId: string; title: string; body: string },
    orgId: string
  ): Promise<void> {
    const { changes, revision } = await this.writeTranscriptRows(orgId, e.channel, e.thread, [
      {
        kind: 'run',
        sql: `INSERT OR IGNORE INTO transcript
           (orgId, channel, thread, ts, sender, kind, text, tool_call_id, body, eventTimeUs, revision)
         VALUES (@orgId, @channel, @thread, @ts, @sender, 'tool', @text, @toolCallId, @body, @eventTimeUs, @revision)`,
        params: [
          {
            orgId,
            channel: e.channel,
            thread: e.thread,
            ts: e.ts,
            sender: e.sender,
            text: e.title,
            toolCallId: e.toolCallId,
            body: e.body,
            eventTimeUs: transcriptEventTimeUs(e.ts),
            revision: this.transcriptRevision + 1
          }
        ]
      }
    ])
    if (changes[0] === 1) {
      this.transcriptRevision = revision
      this.notifyTranscriptMutation(e.channel, e.thread, [e.sender], this.transcriptRevision)
    }
  }

  /** Later update for one agent's tool call. `seq`/`ts` keep their first-seen values; a peer
   *  reusing the same session-local tool id cannot overwrite it. The store's highest-frequency
   *  writer, and every write is a full latest-wins overlay of the merged ToolBody rather than an
   *  append — so the burst is coalesced per row, and writing only its last state leaves exactly
   *  the row the per-chunk path left. Flushed before any other statement, on
   *  {@link TOOL_WRITE_FLUSH_MS}, at either buffer bound, at turn end, and on drain. */
  async updateToolCall(
    channel: string,
    thread: string,
    agentId: string,
    toolCallId: string,
    patch: { title: string; body: string }
  ): Promise<void> {
    // Resolved here, not at flush time: the org fence must reject an unattributable agent at
    // the same call, with the same inputs, as the per-chunk write it replaces.
    const orgId = this.orgFor(agentId)
    const write = { orgId, channel, thread, agentId, toolCallId, bytes: 0, ...patch }
    const key = writeKeyOf(write)
    this.pendingToolWriteBytes -= this.pendingToolWrites.get(key)?.bytes ?? 0
    const bytes = patch.title.length + patch.body.length
    this.pendingToolWrites.set(key, { ...write, bytes })
    this.pendingToolWriteBytes += bytes
    if (this.pendingToolWrites.size >= MAX_PENDING_TOOL_WRITES) return await this.flushToolCallWrites()
    if (this.pendingToolWriteBytes >= MAX_PENDING_TOOL_WRITE_BYTES) return await this.flushToolCallWrites()
    this.armToolWriteFlush()
  }

  /** Write every buffered streaming tool-call update, plus the post-write revision of each
   *  thread they touched, in one round trip — so buffered content is durable before a shutdown
   *  and never outlives the turn that produced it. Entries survive a failed flush, and the timer
   *  is re-armed, so a retry re-applies them. */
  async flushToolCallWrites(): Promise<void> {
    if (this.pendingToolWrites.size === 0) return
    // Queuing on the mutex is what awaits a flush already in flight; this pass then writes
    // whatever was buffered while that one ran, so a joiner never returns ahead of its own entry.
    return this.transcriptMutex.run(() => this.flushPendingToolCallWrites())
  }

  /** Drain before another statement runs. Taking the mutex only when there is something to
   *  write keeps ordinary traffic off the transcript lock. */
  private drainToolCallWrites(): Promise<void> {
    return this.pendingToolWrites.size === 0 ? Promise.resolve() : this.flushToolCallWrites()
  }

  private async flushPendingToolCallWrites(): Promise<void> {
    if (this.pendingToolWrites.size === 0) return
    this.clearToolWriteFlush()
    const pending = [...this.pendingToolWrites.values()]
    // Distinct threads in write order, so each one's revision read rides the same round trip.
    const threads = new Map<string, PendingToolWrite>()
    for (const write of pending) threads.set(threadKeyOf(write), write)
    const threadList = [...threads.values()]
    let results: StoreBatchResult[]
    try {
      results = await this.backend.batch([
        ...pending.map((write, index) => ({
          kind: 'run' as const,
          sql: `UPDATE transcript SET text = ?, body = ?, revision = ?
         WHERE orgId = ? AND channel = ? AND thread = ? AND sender = ? AND tool_call_id = ?
           AND (text IS NOT ? OR body IS NOT ?)`,
          params: [
            write.title,
            write.body,
            this.transcriptRevision + index + 1,
            write.orgId,
            write.channel,
            write.thread,
            write.agentId,
            write.toolCallId,
            write.title,
            write.body
          ]
        })),
        ...threadList.map((write) => ({
          kind: 'read' as const,
          sql: 'SELECT COALESCE(MAX(revision), 0) AS revision FROM transcript WHERE orgId = ? AND channel = ? AND thread = ?',
          params: [write.orgId, write.channel, write.thread]
        }))
      ])
    } catch (error) {
      // Nothing is dropped: the entries stay buffered and the timer comes back, so a store that
      // goes quiet after the failure still lands them instead of holding them until the next call.
      this.armToolWriteFlush()
      throw error
    }
    // Only what this pass actually wrote is dropped: an update buffered while the batch was in
    // flight is a NEWER state of the same row, and clearing the map would lose it outright.
    for (const write of pending) {
      const key = writeKeyOf(write)
      if (this.pendingToolWrites.get(key) !== write) continue
      this.pendingToolWrites.delete(key)
      this.pendingToolWriteBytes -= write.bytes
    }
    this.armToolWriteFlush()
    const revisions = new Map<string, number>()
    for (const [index, write] of threadList.entries()) {
      const row = results[pending.length + index]?.rows[0] as { revision: number } | undefined
      revisions.set(threadKeyOf(write), Number(row?.revision ?? 0))
    }
    // The allocator spans every partition, so it takes the highest revision any thread now
    // carries — a thread whose write was a no-op must never pull it back below one already issued.
    this.transcriptRevision = Math.max(this.transcriptRevision, ...revisions.values())
    // One notification per thread that actually changed, carrying that thread's own revision —
    // the per-chunk path emitted one per write, and every intermediate one is now superseded.
    const changed = new Map<string, string[]>()
    for (const [index, write] of pending.entries()) {
      if (Number(results[index]?.changes ?? 0) !== 1) continue
      const key = threadKeyOf(write)
      const agentIds = changed.get(key)
      if (agentIds) agentIds.push(write.agentId)
      else changed.set(key, [write.agentId])
    }
    for (const write of threadList) {
      const key = threadKeyOf(write)
      const agentIds = changed.get(key)
      if (agentIds) this.notifyTranscriptMutation(write.channel, write.thread, agentIds, revisions.get(key) ?? 0)
    }
  }

  private armToolWriteFlush(): void {
    if (this.toolWriteTimer || this.pendingToolWrites.size === 0) return
    this.toolWriteTimer = setTimeout(() => {
      this.toolWriteTimer = undefined
      // The backend reported this through its own failure channel and the entries are still
      // buffered; an idempotent latest-wins overlay is always safe to re-apply.
      void this.flushToolCallWrites().catch(() => this.armToolWriteFlush())
    }, TOOL_WRITE_FLUSH_MS)
    this.toolWriteTimer.unref?.()
  }

  private clearToolWriteFlush(): void {
    if (!this.toolWriteTimer) return
    clearTimeout(this.toolWriteTimer)
    this.toolWriteTimer = undefined
  }

  /** One round trip for a transcript mutation plus the thread revision the caller needs next.
   *  Each statement still commits on its own, so a failure leaves what the same sequence of
   *  single-statement calls would have left. Callers hold {@link transcriptMutex}. */
  private async writeTranscriptRows(
    orgId: string,
    channel: string,
    thread: string,
    statements: StoreBatchStatement[]
  ): Promise<{ changes: number[]; revision: number }> {
    const results = await this.lockedDb.batch([
      ...statements,
      {
        kind: 'read',
        sql: 'SELECT COALESCE(MAX(revision), 0) AS revision FROM transcript WHERE orgId = ? AND channel = ? AND thread = ?',
        params: [orgId, channel, thread]
      }
    ])
    return {
      changes: results.slice(0, -1).map((result) => Number(result.changes)),
      revision: Number((results.at(-1)?.rows[0] as { revision: number } | undefined)?.revision ?? 0)
    }
  }

  private notifyTranscriptMutation(
    channel: string,
    thread: string,
    candidates: Array<string | undefined>,
    revision: number
  ): void {
    const agentIds = [...new Set(candidates.filter((candidate): candidate is string => !!candidate))]
    if (agentIds.length === 0) return
    if (!this.transcriptMutationListener) return
    // Post-commit dispatch: the listener reads the store, so it must never run mid-write and
    // observe a half-applied batch (or re-enter an open transaction). Re-read at dispatch so a
    // listener detached during shutdown does not fire from a queued notice.
    queueMicrotask(() => {
      try {
        // Listener may be async now; a rejected store read stays best-effort, never unhandled.
        void Promise.resolve(this.transcriptMutationListener?.({ channel, thread, agentIds, revision })).catch(
          () => undefined
        )
      } catch {
        // Live-view invalidation is best-effort and must never fail a durable write.
      }
    })
  }

  /** One agent's full stored ToolBody JSON, or undefined if unknown/not owned. */
  async getToolBodyForAgent(
    channel: string,
    thread: string,
    agentId: string,
    toolCallId: string,
    orgId?: string
  ): Promise<string | undefined> {
    const row = (await this.db
      .prepare(
        'SELECT body FROM transcript WHERE orgId = ? AND channel = ? AND thread = ? AND sender = ? AND tool_call_id = ?'
      )
      .get(this.orgForRead(agentId, orgId), channel, thread, agentId, toolCallId)) as
      { body: string | null } | undefined
    return row?.body ?? undefined
  }

  /**
   * §8.5 cross-agent catch-up: conversational (`text`) rows only — tool/reasoning rows
   * are audit/UI data and must never be replayed back into an agent's prompt. Ordered by
   * platform `ts` (every text row carries one), compared against the session marker.
   */
  async transcriptSince(
    channel: string,
    thread: string,
    sinceTs: string | null,
    agentId: string
  ): Promise<TranscriptEntry[]> {
    const orgId = this.orgFor(agentId)
    if (sinceTs === null) {
      return (await this.db
        .prepare(
          "SELECT * FROM transcript WHERE orgId = ? AND channel = ? AND thread = ? AND kind = 'text' ORDER BY ts ASC"
        )
        .all(orgId, channel, thread)) as unknown as TranscriptEntry[]
    }
    return (await this.db
      .prepare(
        `SELECT * FROM transcript WHERE orgId = ? AND channel = ? AND thread = ? AND kind = 'text' AND ts > ?
         ORDER BY ts ASC`
      )
      .all(orgId, channel, thread, sinceTs)) as unknown as TranscriptEntry[]
  }

  /**
   * `transcriptSince`, scoped to what ONE agent sent or received — the same
   * delivery predicate the console session views use. For a synthetic pairwise
   * `a2a:<caller>` thread (see `isSyntheticA2aChannel` in cp-collab-routes),
   * every child of one caller shares the physical thread while each row is a
   * private pairwise delivery: the §8.5 model catch-up must read only this
   * pair's rows, or siblings see each other's private deliveries (#967).
   */
  async transcriptSinceForAgent(
    channel: string,
    thread: string,
    sinceTs: string | null,
    agentId: string
  ): Promise<TranscriptEntry[]> {
    const orgId = this.orgFor(agentId)
    if (sinceTs === null) {
      return (await this.db
        .prepare(
          `SELECT * FROM transcript WHERE orgId = ? AND channel = ? AND thread = ? AND kind = 'text'
             AND ${AGENT_DELIVERY_SCOPE_SQL} ORDER BY ts ASC`
        )
        .all(orgId, channel, thread, agentId, agentId, agentId)) as unknown as TranscriptEntry[]
    }
    return (await this.db
      .prepare(
        `SELECT * FROM transcript WHERE orgId = ? AND channel = ? AND thread = ? AND kind = 'text' AND ts > ?
           AND ${AGENT_DELIVERY_SCOPE_SQL} ORDER BY ts ASC`
      )
      .all(orgId, channel, thread, sinceTs, agentId, agentId, agentId)) as unknown as TranscriptEntry[]
  }

  /**
   * Provider-neutral context fence for one physical conversation thread. Unlike
   * `transcriptSince`, this never compares provider message ids from different
   * ordering domains; it follows the daemon's monotonic observation revision.
   */
  async threadTranscriptRevision(channel: string, thread: string, agentId?: string): Promise<number> {
    return await this.threadRevisionInOrg(await this.transcriptOrg(channel, thread, agentId), channel, thread)
  }

  /** {@link threadTranscriptRevision} for a partition already resolved by a write. */
  private async threadRevisionInOrg(orgId: string, channel: string, thread: string): Promise<number> {
    const row = (await this.db
      .prepare(
        'SELECT COALESCE(MAX(revision), 0) AS revision FROM transcript WHERE orgId = ? AND channel = ? AND thread = ?'
      )
      .get(orgId, channel, thread)) as { revision: number }
    return row.revision
  }

  /** Conversation and audit rows observed after a thread-local revision fence. */
  async transcriptSinceRevision(
    channel: string,
    thread: string,
    afterRevision: number,
    agentId: string
  ): Promise<TranscriptRow[]> {
    return (await this.db
      .prepare(
        `SELECT * FROM transcript
         WHERE orgId = ? AND channel = ? AND thread = ? AND revision > ?
         ORDER BY revision ASC, seq ASC`
      )
      .all(this.orgFor(agentId), channel, thread, afterRevision)) as unknown as TranscriptRow[]
  }

  /** `transcriptSinceRevision`, scoped to one agent's sent/received rows — the
   *  turn-context refresh's read on a synthetic pairwise `a2a:<caller>` thread,
   *  for the same reason as {@link transcriptSinceForAgent} (#967). */
  async transcriptSinceRevisionForAgent(
    channel: string,
    thread: string,
    afterRevision: number,
    agentId: string
  ): Promise<TranscriptRow[]> {
    return (await this.db
      .prepare(
        `SELECT * FROM transcript
         WHERE orgId = ? AND channel = ? AND thread = ? AND revision > ?
           AND ${AGENT_DELIVERY_SCOPE_SQL}
         ORDER BY revision ASC, seq ASC`
      )
      .all(
        this.orgFor(agentId),
        channel,
        thread,
        afterRevision,
        agentId,
        agentId,
        agentId
      )) as unknown as TranscriptRow[]
  }

  /** The earliest inbound (non-agent) `text` message in a thread — the triggering user
   *  message. Used as a session-title fallback when neither ACP nor the title tool
   *  supplied one. Before the first meaningful request, this avoids showing only
   *  "Session <id>". Returns undefined when the thread holds no non-agent text row
   *  yet. Indexed by (channel, thread, seq). */
  async firstMessageText(
    channel: string,
    thread: string,
    agentId: string,
    orgId?: string
  ): Promise<string | undefined> {
    const row = (await this.db
      .prepare(
        `SELECT text FROM transcript WHERE orgId = ? AND channel = ? AND thread = ? AND kind = 'text'
           AND sender != ? ORDER BY seq ASC LIMIT 1`
      )
      .get(this.orgForRead(agentId, orgId), channel, thread, agentId)) as { text: string } | undefined
    return row?.text
  }

  /** Full activity log for a thread (all kinds), in insertion order — for the Web UI.
   *  `agentId` names the org partition only, and may be omitted on a store no pool shares. */
  async threadTranscript(channel: string, thread: string, agentId?: string): Promise<TranscriptRow[]> {
    return (await this.db
      .prepare('SELECT * FROM transcript WHERE orgId = ? AND channel = ? AND thread = ? ORDER BY seq ASC')
      .all(this.orgFor(agentId), channel, thread)) as unknown as TranscriptRow[]
  }

  /**
   * The bytes of an inline transcript image in one thread, by the file NAME the agent read
   * in its `[attached: …]` marker. Latest wins — the same name can legitimately recur.
   *
   * Backs forwarding a received file: the copy already kept for console replay is reused, so
   * no second fetch hits the source platform and the bytes never pass through the model. That
   * copy is BOUNDED (and may be a smaller rendition), so a forward can be lower-resolution
   * than what arrived. Bounded scan depth for the same reason the copy is bounded.
   */
  async transcriptAttachmentByName(
    channel: string,
    thread: string,
    agentId: string | undefined,
    name: string
  ): Promise<SessionImageAttachment | undefined> {
    const rows = (await this.db
      .prepare(
        `SELECT attachmentsJson FROM transcript
          WHERE orgId = ? AND channel = ? AND thread = ? AND attachmentsJson IS NOT NULL
          ORDER BY seq DESC LIMIT 100`
      )
      .all(this.orgFor(agentId), channel, thread)) as unknown as { attachmentsJson: string }[]
    for (const row of rows) {
      let raw: unknown
      try {
        raw = JSON.parse(row.attachmentsJson)
      } catch {
        continue
      }
      const parsed = SessionImageAttachmentSchema.array().safeParse(raw)
      const match = parsed.success ? parsed.data.find((attachment) => attachment.name === name) : undefined
      if (match) return match
    }
    return undefined
  }

  /**
   * The session thread a Telegram message belongs to, recovered from the transcript
   * (every conversational `text` row carries its platform message id in `ts`, and
   * Telegram message ids are unique per chat). Backs reply-based session continuity:
   * a human reply to a bot message (`reply_to_message.message_id`) resolves to the
   * session that bot message was posted in. Undefined when the id was never recorded
   * as text (e.g. a reply to transient chrome, or an unknown message).
   *
   * The one transcript read with no org fence, because it runs BEFORE routing picks an
   * agent. It is safe unfenced: `channel` is the physical-bot-scoped transcript key, one
   * integration owns that bot, one org owns that integration — and it returns a thread id,
   * never content.
   */
  async telegramThreadForMessage(channel: string, messageId: string): Promise<string | undefined> {
    const row = (await this.db
      .prepare("SELECT thread FROM transcript WHERE channel = ? AND ts = ? AND kind = 'text' ORDER BY seq DESC LIMIT 1")
      .get(channel, messageId)) as { thread: string } | undefined
    return row?.thread
  }

  async openSessionAgents(channel: string, thread: string, transportScope?: string | null): Promise<string[]> {
    return (
      (await this.db
        .prepare(
          "SELECT agentId FROM sessions WHERE channel = ? AND thread = ? AND COALESCE(transportScope, '') = ? AND state != 'closed'"
        )
        .all(channel, thread, transportScope ?? '')) as { agentId: string }[]
    ).map((r) => r.agentId)
  }

  /** Agents with a TTL-`closed` session in this thread (§7.3). Backs thread-affinity
   *  revival: when no OPEN session owns a thread, a follow-up reply can still be routed
   *  to the sole agent that previously owned it, and SessionManager.handle recreates/
   *  resumes the ACP session. Kept separate from `openSessionAgents` so the live
   *  multi-agent disambiguation (2+ open owners → mention-gated) is never perturbed. */
  async closedSessionAgents(channel: string, thread: string, transportScope?: string | null): Promise<string[]> {
    return (
      (await this.db
        .prepare(
          "SELECT agentId FROM sessions WHERE channel = ? AND thread = ? AND COALESCE(transportScope, '') = ? AND state = 'closed'"
        )
        .all(channel, thread, transportScope ?? '')) as { agentId: string }[]
    ).map((r) => r.agentId)
  }

  /** Count non-closed sessions in (channel, thread) touched at/after `sinceTs`
   *  (epoch ms). Used to bound unrouted-transcript growth to recently-active
   *  threads, since there is no session-`closed` lifecycle yet. */
  async activeSessionCountSince(
    channel: string,
    thread: string,
    sinceTs: number,
    transportScope?: string | null
  ): Promise<number> {
    const row = (await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM sessions
         WHERE channel = ? AND thread = ? AND COALESCE(transportScope, '') = ?
           AND state != 'closed' AND updatedAt >= ?`
      )
      .get(channel, thread, transportScope ?? '', sinceTs)) as { n: number } | undefined
    return row?.n ?? 0
  }

  /** Cache a platform id's human display name (channel or user; Slack ids don't
   *  collide across the two). Latest-wins — renames overwrite. */
  async setDisplayName(id: string, name: string, updatedAt: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO display_names (id, name, updatedAt) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, updatedAt=excluded.updatedAt`
      )
      .run(id, name, updatedAt)
  }

  /** Display names for a set of platform ids — only the ids that have one.
   *  One batched `IN (…)` query, not a round-trip per id. */
  async getDisplayNames(ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    const unique = [...new Set(ids)]
    if (unique.length === 0) return out
    const rows = (await this.db
      .prepare(`SELECT id, name FROM display_names WHERE id IN (${unique.map(() => '?').join(',')})`)
      .all(...unique)) as unknown as { id: string; name: string }[]
    for (const r of rows) if (r.name) out.set(r.id, r.name)
    return out
  }

  /** Cache a public provider-hosted profile image. Latest-wins as users update avatars. */
  async setProfileAvatar(transportScope: string, id: string, url: string, updatedAt: number): Promise<void> {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return
    }
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) return
    await this.db
      .prepare(
        `INSERT INTO profile_avatars (transportScope, id, url, updatedAt) VALUES (?, ?, ?, ?)
         ON CONFLICT(transportScope, id) DO UPDATE SET url=excluded.url, updatedAt=excluded.updatedAt`
      )
      .run(transportScope, id, url, updatedAt)
  }

  /** Profile images for platform ids on one physical provider connection. */
  async getProfileAvatars(transportScope: string, ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    const unique = [...new Set(ids)]
    if (unique.length === 0) return out
    const rows = (await this.db
      .prepare(
        `SELECT id, url FROM profile_avatars
         WHERE transportScope = ? AND id IN (${unique.map(() => '?').join(',')})`
      )
      .all(transportScope, ...unique)) as unknown as { id: string; url: string }[]
    for (const row of rows) if (row.url) out.set(row.id, row.url)
    return out
  }

  /** Record where a conversation id sits — the channel and/or space enclosing it.
   *  Latest-wins per supplied dimension; an empty note writes nothing, and a note that
   *  carries only one dimension leaves the other as it was (the message path knows the
   *  parent channel immediately, the space arrives with the later name lookup). */
  async setChannelScope(
    id: string,
    scope: { parentId?: string; spaceId?: string; isIm?: boolean },
    updatedAt: number
  ): Promise<void> {
    if (scope.parentId === undefined && scope.spaceId === undefined && scope.isIm === undefined) return
    await this.db
      .prepare(
        `INSERT INTO channel_scopes (id, parentId, spaceId, isIm, updatedAt) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           parentId = COALESCE(excluded.parentId, channel_scopes.parentId),
           spaceId = COALESCE(excluded.spaceId, channel_scopes.spaceId),
           isIm = COALESCE(excluded.isIm, channel_scopes.isIm),
           updatedAt = excluded.updatedAt`
      )
      .run(
        id,
        scope.parentId ?? null,
        scope.spaceId ?? null,
        scope.isIm === undefined ? null : scope.isIm ? 1 : 0,
        updatedAt
      )
  }

  /** Scopes for a set of conversation ids — only the ids that have one. One batched
   *  `IN (…)` query, not a round-trip per id (mirrors getDisplayNames). */
  async getChannelScopes(ids: string[]): Promise<Map<string, { parentId?: string; spaceId?: string; isIm?: boolean }>> {
    const out = new Map<string, { parentId?: string; spaceId?: string; isIm?: boolean }>()
    const unique = [...new Set(ids)]
    if (unique.length === 0) return out
    const rows = (await this.db
      .prepare(
        `SELECT id, parentId, spaceId, isIm FROM channel_scopes WHERE id IN (${unique.map(() => '?').join(',')})`
      )
      .all(...unique)) as unknown as {
      id: string
      parentId: string | null
      spaceId: string | null
      isIm: number | null
    }[]
    for (const r of rows) {
      if (!r.parentId && !r.spaceId && r.isIm === null) continue
      out.set(r.id, {
        ...(r.parentId ? { parentId: r.parentId } : {}),
        ...(r.spaceId ? { spaceId: r.spaceId } : {}),
        ...(r.isIm === null ? {} : { isIm: r.isIm === 1 })
      })
    }
    return out
  }

  /**
   * The persisted CP routing map — one row, and therefore EXCLUSIVELY OWNED STORES ONLY.
   *
   * `CpRoutingLayer` serializes its whole in-memory map on every mutation, so on a shared store
   * each member's write erased every other member's and each boot hydrated a foreign map — a
   * foreign `routingEpoch` with it, which then made `applyUpdate`'s stale guard discard legitimate
   * global-rule updates until the real epoch caught up. Partitioning the row per member does not
   * fix it either: `ownerId` is a process incarnation, so the key would change on every restart,
   * leaking a row each time and still hydrating nothing.
   *
   * A shared member therefore starts from an empty map at epoch 0, which is the safe direction: it
   * accepts the first `route/update` it is pushed, and `converge()` restates assignments from the
   * CP snapshot on register/ok. An exclusively owned store keeps persisting exactly as before.
   */
  async getCpRouting(): Promise<{ routingEpoch: number; assignments: string; globalRules: string } | undefined> {
    if (this.shared) return undefined
    return (await this.db
      .prepare('SELECT routingEpoch, assignments, globalRules FROM cp_routing WHERE id = 1')
      .get()) as { routingEpoch: number; assignments: string; globalRules: string } | undefined
  }

  async setCpRouting(routingEpoch: number, assignments: string, globalRules: string): Promise<void> {
    if (this.shared) return
    await this.db
      .prepare(
        `INSERT INTO cp_routing (id, routingEpoch, assignments, globalRules) VALUES (1, @routingEpoch, @assignments, @globalRules)
         ON CONFLICT(id) DO UPDATE SET routingEpoch=excluded.routingEpoch, assignments=excluded.assignments, globalRules=excluded.globalRules`
      )
      .run({ routingEpoch, assignments, globalRules })
  }

  /** Stamp a cron fire (key = `<agentId>:<cronId>`). */
  async setCronLastRun(key: string, lastRunAt: number, definition: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO cron_runs (key, lastRunAt, definition) VALUES (@key, @lastRunAt, @definition)
         ON CONFLICT(key) DO UPDATE SET lastRunAt=excluded.lastRunAt, definition=excluded.definition`
      )
      .run({ key, lastRunAt, definition })
  }

  async cronRun(key: string): Promise<ScheduleRun | undefined> {
    return (await this.db.prepare('SELECT lastRunAt, definition FROM cron_runs WHERE key = ?').get(key)) as
      ScheduleRun | undefined
  }

  /** Every stamp key this agent still carries — the substring match is exact, so an agent id with
   *  LIKE metacharacters cannot widen it. */
  async cronRunKeys(agentId: string): Promise<string[]> {
    const prefix = `${agentId}:`
    return (
      (await this.db.prepare('SELECT key FROM cron_runs WHERE substr(key, 1, @len) = @prefix').all({
        len: prefix.length,
        prefix
      })) as { key: string }[]
    ).map((row) => row.key)
  }

  /** Drop a cron's stamp: the definition it fingerprints is gone, and a re-minted id of the same
   *  name must start from no evidence rather than inherit the deleted schedule's last run. */
  async deleteCronRun(key: string): Promise<void> {
    await this.db.prepare('DELETE FROM cron_runs WHERE key = ?').run(key)
  }

  /** Stamp a dream-schedule fire (one row per agent), under the definition that fired. */
  async setDreamLastRun(agentId: string, lastRunAt: number, definition: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO dream_runs (agentId, lastRunAt, definition) VALUES (@agentId, @lastRunAt, @definition)
         ON CONFLICT(agentId) DO UPDATE SET lastRunAt=excluded.lastRunAt, definition=excluded.definition`
      )
      .run({ agentId, lastRunAt, definition })
  }

  async dreamRun(agentId: string): Promise<ScheduleRun | undefined> {
    return (await this.db.prepare('SELECT lastRunAt, definition FROM dream_runs WHERE agentId = ?').get(agentId)) as
      ScheduleRun | undefined
  }

  /** CAS claim on a cron occurrence a handover missed (#1031): take it iff the stamp is still older
   *  than the occurrence AND was written under the definition asking for it, so two members racing
   *  one handoff compensate it exactly once and an edited schedule replays nothing. A row with no
   *  stamp, or one fingerprinted differently, is never claimed. */
  async claimCronCatchUp(key: string, occurrence: number, claimedAt: number, definition: string): Promise<boolean> {
    return (
      (
        await this.db
          .prepare('UPDATE cron_runs SET lastRunAt = ? WHERE key = ? AND lastRunAt < ? AND definition = ?')
          .run(claimedAt, key, occurrence, definition)
      ).changes === 1
    )
  }

  /** The dream twin of {@link claimCronCatchUp}, over the per-agent dream stamp. */
  async claimDreamCatchUp(
    agentId: string,
    occurrence: number,
    claimedAt: number,
    definition: string
  ): Promise<boolean> {
    return (
      (
        await this.db
          .prepare('UPDATE dream_runs SET lastRunAt = ? WHERE agentId = ? AND lastRunAt < ? AND definition = ?')
          .run(claimedAt, agentId, occurrence, definition)
      ).changes === 1
    )
  }

  /** Self-introduce-on-join (issue #536). The set of channels this agent has already
   *  introduced itself into (or adopted as the silent baseline) on `platform`. */
  async channelIntroSet(agentId: string, platform: string): Promise<Set<string>> {
    const rows = (await this.db
      .prepare('SELECT channel FROM channel_intro WHERE agentId = ? AND platform = ?')
      .all(agentId, platform)) as { channel: string }[]
    return new Set(rows.map((r) => r.channel))
  }

  /** Record that the agent has introduced itself in a channel (idempotent). `introducedAt`
   *  is null when the channel was adopted as the silent baseline (never introduced-in). */
  async markChannelIntro(
    agentId: string,
    platform: string,
    channel: string,
    introducedAt: number | null
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO channel_intro (agentId, platform, channel, introducedAt)
         VALUES (@agentId, @platform, @channel, @introducedAt)`
      )
      .run({ agentId, platform, channel, introducedAt })
  }

  /** Whether an integration's first channel snapshot has been baselined (seeded). */
  /** Persist one agent's advertised slash-command list (latest-wins, whole list). */
  async setRuntimeCommands(agentId: string, row: { sessionId: string; updatedAt: string; payload: string }) {
    await this.db
      .prepare(
        `INSERT INTO runtime_commands (agentId, sessionId, updatedAt, payload) VALUES (?, ?, ?, ?)
         ON CONFLICT(agentId) DO UPDATE SET sessionId=excluded.sessionId, updatedAt=excluded.updatedAt, payload=excluded.payload`
      )
      .run(agentId, row.sessionId, row.updatedAt, row.payload)
  }

  async getRuntimeCommands(
    agentId: string
  ): Promise<{ sessionId: string; updatedAt: string; payload: string } | undefined> {
    const row = (await this.db
      .prepare('SELECT sessionId, updatedAt, payload FROM runtime_commands WHERE agentId = ?')
      .get(agentId)) as { sessionId: string; updatedAt: string; payload: string } | undefined
    return row ?? undefined
  }

  async deleteRuntimeCommands(agentId: string): Promise<void> {
    await this.db.prepare('DELETE FROM runtime_commands WHERE agentId = ?').run(agentId)
  }

  async isChannelIntroSeeded(integrationId: string): Promise<boolean> {
    return (
      (await this.db.prepare('SELECT 1 FROM channel_intro_seed WHERE integrationId = ?').get(integrationId)) !==
      undefined
    )
  }

  /** Mark an integration's channel baseline as seeded (idempotent). */
  async markChannelIntroSeeded(integrationId: string, seededAt: number): Promise<void> {
    await this.db
      .prepare('INSERT OR IGNORE INTO channel_intro_seed (integrationId, seededAt) VALUES (?, ?)')
      .run(integrationId, seededAt)
  }

  /** §6.9 #353 durable inbox: persist an admitted message BEFORE its admission ACK. Keyed
   *  by the stable delivery id (agent deliveryId or bot-scoped platform message id).
   *  A re-append preserves the original payload/FIFO position and may only advance
   *  the durable loop-accounting marker from 0 to 1. */
  async appendInbox(row: InboxRow): Promise<boolean> {
    const inserted = await this.db
      .prepare(
        `INSERT OR IGNORE INTO inbox
          (id, sessionKey, agentId, msg, integrationId, callMeta, hookContext, posterPublishState,
            terminalReport, completedAt, isQueueCmd, loopGuardCounted, enqueuedAt)
         VALUES
           (@id, @sessionKey, @agentId, @msg, @integrationId, @callMeta, @hookContext, @posterPublishState,
            @terminalReport, @completedAt, @isQueueCmd, @loopGuardCounted, @enqueuedAt)`
      )
      .run({
        id: row.id,
        sessionKey: row.sessionKey,
        agentId: row.agentId,
        msg: row.msg,
        integrationId: row.integrationId ?? null,
        callMeta: row.callMeta ?? null,
        hookContext: row.hookContext ?? null,
        posterPublishState: row.posterPublishState ?? null,
        terminalReport: row.terminalReport ?? null,
        completedAt: row.completedAt ?? null,
        isQueueCmd: row.isQueueCmd ?? null,
        loopGuardCounted: row.loopGuardCounted ?? 0,
        enqueuedAt: row.enqueuedAt
      })
    if (inserted.changes === 0 && row.loopGuardCounted === 1) {
      await this.db
        .prepare(
          'UPDATE inbox SET loopGuardCounted = CASE WHEN loopGuardCounted < 1 THEN 1 ELSE loopGuardCounted END WHERE id = ?'
        )
        .run(row.id)
    }
    return inserted.changes === 1
  }

  /**
   * Admit a message and mint its permanent DELIVERY RECEIPT in ONE transaction.
   *
   * The receipt is a born-completed row recording that this delivery was served; the ordinary
   * row is the replay queue entry, which is deleted the moment the turn settles. A provider
   * whose redelivery ladder outlives the turn needs both, and needs them to share one fate:
   *
   *  - written separately, a crash between them leaves an ordinary row that replays with no
   *    receipt, so the next redelivery is unrecognizable and runs the turn a second time;
   *  - committed together, an ordinary row can only exist where its receipt does.
   *
   * `admitted` is false when the receipt was already there — the delivery has been served
   * before, and the caller must run nothing, not merely stay quiet.
   */
  async appendInboxWithReceipt(row: InboxRow, receipt: InboxRow): Promise<{ admitted: boolean }> {
    return await this.transaction(async (raw) => {
      const tx = accessOf(raw)
      const insert = (r: InboxRow): Promise<{ changes: number }> =>
        tx
          .prepare(
            `INSERT OR IGNORE INTO inbox
              (id, sessionKey, agentId, msg, integrationId, callMeta, hookContext, posterPublishState,
                terminalReport, completedAt, isQueueCmd, loopGuardCounted, enqueuedAt)
             VALUES
               (@id, @sessionKey, @agentId, @msg, @integrationId, @callMeta, @hookContext, @posterPublishState,
                @terminalReport, @completedAt, @isQueueCmd, @loopGuardCounted, @enqueuedAt)`
          )
          .run({
            id: r.id,
            sessionKey: r.sessionKey,
            agentId: r.agentId,
            msg: r.msg,
            integrationId: r.integrationId ?? null,
            callMeta: r.callMeta ?? null,
            hookContext: r.hookContext ?? null,
            posterPublishState: r.posterPublishState ?? null,
            terminalReport: r.terminalReport ?? null,
            completedAt: r.completedAt ?? null,
            isQueueCmd: r.isQueueCmd ?? null,
            loopGuardCounted: r.loopGuardCounted ?? 0,
            enqueuedAt: r.enqueuedAt
          })
      // The receipt is the CAS. Losing it means another delivery of the same event owns this
      // work, so the ordinary row is never written and no turn is admitted for this copy.
      const minted = await insert(receipt)
      if (minted.changes !== 1) return { admitted: false }
      await insert(row)
      return { admitted: true }
    })
  }

  /** Stable-id admission probe used before any hook anchoring side effect. A
   * live row will be replayed (or is already running); a terminal row is the
   * durable receipt. Either way, redelivery must not post another anchor. */
  async hasInbox(id: string): Promise<boolean> {
    return (await this.db.prepare('SELECT 1 FROM inbox WHERE id = ?').get(id)) !== undefined
  }

  async updateInboxHookState(
    id: string,
    hookContext: string,
    posterPublishState?: 'not_started' | 'in_flight' | 'settled'
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE inbox
         SET hookContext = @hookContext,
             posterPublishState = COALESCE(@posterPublishState, posterPublishState)
         WHERE id = @id`
      )
      .run({ id, hookContext, posterPublishState: posterPublishState ?? null })
    return result.changes === 1
  }

  /** Persist a hook prompt rewrite and its matching trusted context together. */
  async updateInboxHookPayload(id: string, msg: string, hookContext: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE inbox
         SET msg = @msg, hookContext = @hookContext
         WHERE id = @id AND hookContext IS NOT NULL AND completedAt IS NULL`
      )
      .run({ id, msg, hookContext })
    return result.changes === 1
  }

  /** Atomically fold one live hook delivery into another and retain the follower as a terminal receipt. */
  async coalesceHookInbox(input: {
    leaderId: string
    leaderMsg: string
    leaderHookContext: string
    followerId: string
    followerTerminalReport: string
    followerOwnerId?: string
    completedAt: number
  }): Promise<boolean> {
    if (input.leaderId === input.followerId) return false
    return rollbackAs(
      this.transaction(async (raw) => {
        const tx = accessOf(raw)
        const leader = await tx
          .prepare(
            `UPDATE inbox
           SET msg = @leaderMsg, hookContext = @leaderHookContext
           WHERE id = @leaderId AND hookContext IS NOT NULL AND completedAt IS NULL`
          )
          .run({
            leaderId: input.leaderId,
            leaderMsg: input.leaderMsg,
            leaderHookContext: input.leaderHookContext
          })
        const follower = await tx
          .prepare(
            `UPDATE inbox
           SET msg = '{}', integrationId = NULL, callMeta = NULL, hookContext = NULL,
               posterPublishState = 'settled', terminalReport = @followerTerminalReport,
               reportOwnerId = @followerOwnerId, reportClaimedAt = @completedAt,
               completedAt = @completedAt, isQueueCmd = NULL
           WHERE id = @followerId AND hookContext IS NOT NULL AND completedAt IS NULL`
          )
          .run({
            followerId: input.followerId,
            followerTerminalReport: input.followerTerminalReport,
            followerOwnerId: input.followerOwnerId ?? null,
            completedAt: input.completedAt
          })
        if (leader.changes !== 1 || follower.changes !== 1) throw new RollbackSignal()
        return true
      }),
      false
    )
  }

  /** Atomically turn a live hook inbox row into a redacted terminal receipt.
   * The stable id remains present to absorb relay redelivery after restart;
   * startup re-emits only the metadata report, never the model prompt. The CAS
   * result identifies the sole writer so a later terminal path cannot replace
   * the winning outbox body. */
  async completeHookInbox(
    id: string,
    terminalReport: string,
    completedAt: number,
    ownerId?: string
  ): Promise<'completed' | 'already-terminal' | 'missing'> {
    const result = await this.db
      .prepare(
        `UPDATE inbox
         SET msg = '{}', integrationId = NULL, callMeta = NULL, hookContext = NULL,
             posterPublishState = 'settled', terminalReport = @terminalReport,
             reportOwnerId = @ownerId, reportClaimedAt = @completedAt,
             completedAt = @completedAt, isQueueCmd = NULL
         WHERE id = @id AND hookContext IS NOT NULL AND completedAt IS NULL`
      )
      .run({ id, terminalReport, completedAt, ownerId: ownerId ?? null })
    if (result.changes === 1) return 'completed'

    const row = (await this.db.prepare('SELECT completedAt FROM inbox WHERE id = ?').get(id)) as
      { completedAt: number | null } | undefined
    return row?.completedAt !== null && row?.completedAt !== undefined ? 'already-terminal' : 'missing'
  }

  /** A CP-correlated ACK releases only the report payload. Keep a bounded
   * metadata-only stable-id receipt so relay redelivery still cannot rerun the
   * model; unacknowledged reports are never capacity-evicted. On a shared pool
   * store only the claim holder may release a body — a peer's verdict about its
   * own dispatch says nothing about this row. */
  async acknowledgeHookInbox(
    id: string,
    options: { ownerId?: string; maxAcknowledgedReceipts?: number } = {}
  ): Promise<boolean> {
    const maxAcknowledgedReceipts = options.maxAcknowledgedReceipts ?? 10_000
    const fence = this.shared ? ' AND (reportOwnerId IS NULL OR reportOwnerId = @ownerId)' : ''
    const result = await this.db
      .prepare(
        `UPDATE inbox
         SET terminalReport = NULL, reportOwnerId = NULL, reportClaimedAt = NULL
         WHERE id = @id AND completedAt IS NOT NULL AND terminalReport IS NOT NULL${fence}`
      )
      .run({ id, ...(fence ? { ownerId: options.ownerId ?? null } : {}) })
    if (result.changes === 1) {
      await this.db
        .prepare(
          `DELETE FROM inbox
           WHERE id IN (
             SELECT id FROM inbox
             WHERE completedAt IS NOT NULL AND terminalReport IS NULL
             ORDER BY completedAt DESC, id DESC
             LIMIT -1 OFFSET @maxAcknowledgedReceipts
           )`
        )
        .run({ maxAcknowledgedReceipts })
    }
    return result.changes === 1
  }

  /** Unacknowledged hook terminal reports this member may emit right now.
   *
   * A local store owns every row outright, so it drains the whole outbox as
   * before. On a shared pool store the outbox is one table for every member, so
   * a row is offered only when this member owns it, when it is unowned (legacy
   * or pre-pool), or when its owner's claim lapsed AND this member currently
   * serves the agent — draining a live peer's row would only earn a CONFLICT
   * for a dispatch that is not ours. */
  async listHookTerminalReports(now: number, ownerId?: string, agentIds?: readonly string[]): Promise<InboxRow[]> {
    const order = ' ORDER BY sessionKey ASC, enqueuedAt ASC'
    if (!this.shared) {
      return (await this.db
        .prepare(`SELECT * FROM inbox WHERE terminalReport IS NOT NULL${order}`)
        .all()) as unknown as InboxRow[]
    }
    const scope = idScope('agentId', agentIds)
    return (await this.db
      .prepare(
        `SELECT * FROM inbox
         WHERE terminalReport IS NOT NULL
           AND (reportOwnerId IS NULL OR reportOwnerId = @ownerId
                OR (COALESCE(reportClaimedAt, 0) <= @staleBefore${scope.sql}))${order}`
      )
      .all({
        ownerId: ownerId ?? null,
        staleBefore: now - SHARED_OUTBOX_LEASE_MS,
        ...scope.params
      })) as unknown as InboxRow[]
  }

  /** Take or renew this member's claim on one report before emitting it. */
  async claimHookTerminalReport(id: string, ownerId: string | undefined, now: number): Promise<boolean> {
    if (!this.shared) return true
    return (
      (
        await this.db
          .prepare(
            `UPDATE inbox
           SET reportOwnerId = @ownerId, reportClaimedAt = @now
           WHERE id = @id AND terminalReport IS NOT NULL
             AND (reportOwnerId IS NULL OR reportOwnerId = @ownerId
                  OR COALESCE(reportClaimedAt, 0) <= @staleBefore)`
          )
          .run({ id, ownerId: ownerId ?? null, now, staleBefore: now - SHARED_OUTBOX_LEASE_MS })
      ).changes === 1
    )
  }

  /** Hand a claimed report back to the daemon whose dispatch the CP accepts it
   * from. The body is never released here: a CONFLICT raised against a peer's
   * dispatch means "not mine to report", not "this can never be valid". */
  async releaseHookTerminalReport(id: string, ownerId: string, now: number): Promise<boolean> {
    if (!this.shared) return false
    return (
      (
        await this.db
          .prepare(
            `UPDATE inbox
           SET reportOwnerId = @ownerId, reportClaimedAt = @now
           WHERE id = @id AND terminalReport IS NOT NULL`
          )
          .run({ id, ownerId, now })
      ).changes === 1
    )
  }

  /** Remove an ordinary inbox row once its turn reaches a terminal state. Hook
   * rows are converted to bounded redacted receipts by completeHookInbox. */
  async removeInbox(id: string): Promise<void> {
    await this.db.prepare('DELETE FROM inbox WHERE id = ?').run(id)
  }

  /** All pending inbox rows, ordered FIFO-by-sessionKey (sessionKey, then enqueuedAt) for
   *  startup replay (§6.9 #353). Order within a sessionKey is preserved by `enqueuedAt`. */
  async listInboxBySessionKeyFifo(): Promise<InboxRow[]> {
    return (await this.db
      .prepare('SELECT * FROM inbox ORDER BY sessionKey ASC, enqueuedAt ASC')
      .all()) as unknown as InboxRow[]
  }

  /** Remove ordinary durable turns owned by an agent. Live hook rows have their
   *  own single completion owner and must survive until that owner atomically
   *  redacts them into a terminal report. Unacknowledged terminal hook reports
   *  are an outbox and likewise must survive lifecycle purges. ACKed receipts
   *  may be discarded here because CP already durably converged them. */
  async removeInboxByAgentId(agentId: string): Promise<string[]> {
    const removable = 'agentId = ? AND hookContext IS NULL AND terminalReport IS NULL'
    const rows = (await this.db.prepare(`SELECT id FROM inbox WHERE ${removable}`).all(agentId)) as Array<{
      id: string
    }>
    await this.db.prepare(`DELETE FROM inbox WHERE ${removable}`).run(agentId)
    return rows.map((row) => row.id)
  }

  /** Persist a bounded capture before any external side effect. Both the stable
   * operation id and the semantic (agent, connection, turn) key deduplicate
   * redelivery. A conflicting duplicate fails closed instead of replacing body.
   * Insert-then-classify, not a transaction: the INSERT is the CAS, and the read that
   * follows only names why a duplicate lost — a writer interleaving there changes neither. */
  async appendMemoryCapture(row: MemoryCaptureOutboxRow): Promise<'inserted' | 'duplicate' | 'conflict'> {
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO memory_capture_outbox
          (operationId, turnId, agentId, connectionId, connectionRevision, pluginId, manifestDigest, config,
           scopeKey, sessionId, input, output, payloadHash, payloadBytes, idempotency, state,
           attempts, backendOperationId, reasonCode, nextAttemptAt, createdAt, updatedAt)
         VALUES
          (@operationId, @turnId, @agentId, @connectionId, @connectionRevision, @pluginId, @manifestDigest, @config,
           @scopeKey, @sessionId, @input, @output, @payloadHash, @payloadBytes, @idempotency, @state,
           @attempts, @backendOperationId, @reasonCode, @nextAttemptAt, @createdAt, @updatedAt)`
      )
      .run({
        ...row,
        manifestDigest: row.manifestDigest ?? null,
        sessionId: row.sessionId ?? null,
        backendOperationId: row.backendOperationId ?? null,
        reasonCode: row.reasonCode ?? null
      })
    if (result.changes === 1) return 'inserted'
    const existing = (await this.db
      .prepare(
        `SELECT operationId, turnId, agentId, connectionId, connectionRevision, pluginId, manifestDigest,
                payloadHash, idempotency
         FROM memory_capture_outbox
         WHERE operationId = @operationId OR (agentId = @agentId AND connectionId = @connectionId AND turnId = @turnId)
         LIMIT 1`
      )
      .get({
        operationId: row.operationId,
        agentId: row.agentId,
        connectionId: row.connectionId,
        turnId: row.turnId
      })) as
      | Pick<
          MemoryCaptureOutboxRow,
          | 'operationId'
          | 'turnId'
          | 'agentId'
          | 'connectionId'
          | 'connectionRevision'
          | 'pluginId'
          | 'manifestDigest'
          | 'payloadHash'
          | 'idempotency'
        >
      | undefined
    if (
      existing &&
      existing.operationId === row.operationId &&
      existing.turnId === row.turnId &&
      existing.agentId === row.agentId &&
      existing.connectionId === row.connectionId &&
      existing.connectionRevision === row.connectionRevision &&
      existing.pluginId === row.pluginId &&
      (existing.manifestDigest ?? null) === (row.manifestDigest ?? null) &&
      existing.payloadHash === row.payloadHash &&
      existing.idempotency === row.idempotency
    ) {
      return 'duplicate'
    }
    return 'conflict'
  }

  async getMemoryCapture(operationId: string): Promise<MemoryCaptureOutboxRow | undefined> {
    return (await this.db.prepare('SELECT * FROM memory_capture_outbox WHERE operationId = ?').get(operationId)) as
      MemoryCaptureOutboxRow | undefined
  }

  async listMemoryCaptures(): Promise<MemoryCaptureOutboxRow[]> {
    return (await this.db
      .prepare('SELECT * FROM memory_capture_outbox ORDER BY createdAt ASC, operationId ASC')
      .all()) as unknown as MemoryCaptureOutboxRow[]
  }

  async nextDueMemoryCapture(
    now: number,
    connectionIds?: readonly string[]
  ): Promise<MemoryCaptureOutboxRow | undefined> {
    const scope = idScope('connectionId', connectionIds)
    return (await this.db
      .prepare(
        `SELECT * FROM memory_capture_outbox
         WHERE state IN ('pending', 'accepted') AND nextAttemptAt <= @now${scope.sql}
         ORDER BY nextAttemptAt ASC, createdAt ASC, operationId ASC
         LIMIT 1`
      )
      .get({ now, ...scope.params })) as MemoryCaptureOutboxRow | undefined
  }

  async nextMemoryCaptureDueAt(connectionIds?: readonly string[]): Promise<number | undefined> {
    const scope = idScope('connectionId', connectionIds)
    const row = (await this.db
      .prepare(
        `SELECT MIN(nextAttemptAt) AS dueAt FROM memory_capture_outbox
         WHERE state IN ('pending', 'accepted')${scope.sql}`
      )
      .get(scope.params)) as { dueAt: number | null } | undefined
    return row?.dueAt ?? undefined
  }

  /** Next age/retention deadline even when there is no due send. This keeps a
   * quiet daemon from retaining terminal dedup receipts indefinitely. */
  async nextMemoryCaptureMaintenanceAt(
    activeAgeMs: number,
    connectionIds?: readonly string[]
  ): Promise<number | undefined> {
    const scope = idScope('connectionId', connectionIds)
    const row = (await this.db
      .prepare(
        `SELECT
           MIN(CASE WHEN state IN ('pending', 'accepted') THEN createdAt + @activeAgeMs END) AS activeAt,
           MIN(CASE WHEN state = 'sending' THEN updatedAt + @recoveryLeaseMs END) AS recoveryAt
         FROM memory_capture_outbox
         WHERE 1 = 1${scope.sql}`
      )
      .get({
        activeAgeMs,
        recoveryLeaseMs: this.shared ? SHARED_OUTBOX_LEASE_MS : 0,
        ...scope.params
      })) as { activeAt: number | null; recoveryAt: number | null } | undefined
    const deadlines = [row?.activeAt, row?.recoveryAt].filter(
      (value): value is number => value !== null && value !== undefined
    )
    return deadlines.length ? Math.min(...deadlines) : undefined
  }

  /** The claim and the read-back are one transaction: the row this call answers with must be the
   *  one it just claimed, not whatever a peer's retry left behind between the two statements. */
  async claimMemoryCapture(operationId: string, now: number): Promise<MemoryCaptureOutboxRow | undefined> {
    return await this.transaction(async (raw) => {
      const tx = accessOf(raw)
      const changed = await tx
        .prepare(
          `UPDATE memory_capture_outbox
         SET state = 'sending', attempts = attempts + 1, updatedAt = @now
         WHERE operationId = @operationId AND state = 'pending'`
        )
        .run({ operationId, now })
      if (changed.changes !== 1) return undefined
      return (await tx.prepare('SELECT * FROM memory_capture_outbox WHERE operationId = ?').get(operationId)) as
        MemoryCaptureOutboxRow | undefined
    })
  }

  async deferPendingMemoryCapture(
    operationId: string,
    nextAttemptAt: number,
    now: number,
    reasonCode: string
  ): Promise<boolean> {
    return (
      (
        await this.db
          .prepare(
            `UPDATE memory_capture_outbox
           SET nextAttemptAt = @nextAttemptAt, updatedAt = @now, reasonCode = @reasonCode
           WHERE operationId = @operationId AND state = 'pending'`
          )
          .run({ operationId, nextAttemptAt, now, reasonCode })
      ).changes === 1
    )
  }

  async retryMemoryCapture(
    operationId: string,
    nextAttemptAt: number,
    now: number,
    reasonCode: string
  ): Promise<boolean> {
    return (
      (
        await this.db
          .prepare(
            `UPDATE memory_capture_outbox
           SET state = 'pending', nextAttemptAt = @nextAttemptAt, updatedAt = @now,
               reasonCode = @reasonCode
           WHERE operationId = @operationId AND state = 'sending'`
          )
          .run({ operationId, nextAttemptAt, now, reasonCode })
      ).changes === 1
    )
  }

  async acceptMemoryCapture(
    operationId: string,
    backendOperationId: string,
    nextAttemptAt: number,
    now: number
  ): Promise<boolean> {
    return (
      (
        await this.db
          .prepare(
            `UPDATE memory_capture_outbox
           SET state = 'accepted', backendOperationId = @backendOperationId,
               nextAttemptAt = @nextAttemptAt, updatedAt = @now, reasonCode = NULL,
               input = '', output = '', sessionId = NULL,
               payloadBytes = length(CAST(config AS BLOB))
           WHERE operationId = @operationId AND state = 'sending'`
          )
          .run({ operationId, backendOperationId, nextAttemptAt, now })
      ).changes === 1
    )
  }

  async rescheduleAcceptedMemoryCapture(operationId: string, nextAttemptAt: number, now: number): Promise<boolean> {
    return (
      (
        await this.db
          .prepare(
            `UPDATE memory_capture_outbox
           SET nextAttemptAt = @nextAttemptAt, updatedAt = @now
           WHERE operationId = @operationId AND state = 'accepted'`
          )
          .run({ operationId, nextAttemptAt, now })
      ).changes === 1
    )
  }

  async finishMemoryCapture(
    operationId: string,
    state: 'completed' | 'failed' | 'ambiguous',
    now: number,
    reasonCode?: string
  ): Promise<boolean> {
    return (
      (
        await this.db
          .prepare(
            `UPDATE memory_capture_outbox
           SET state = @state, updatedAt = @now, nextAttemptAt = @now,
               reasonCode = @reasonCode, config = '{}', input = '', output = '',
               sessionId = NULL, payloadBytes = 0
           WHERE operationId = @operationId AND state IN ('sending', 'accepted', 'pending')`
          )
          .run({ operationId, state, now, reasonCode: reasonCode ?? null })
      ).changes === 1
    )
  }

  /** Recover only abandoned shared claims; local stores remain exclusively owned across restart. */
  async recoverMemoryCaptures(
    now: number,
    staleOnly = false,
    connectionIds?: readonly string[]
  ): Promise<{ retried: number; ambiguous: number }> {
    if (staleOnly && !this.shared) return { retried: 0, ambiguous: 0 }
    const scope = idScope('connectionId', !this.shared && !staleOnly ? undefined : connectionIds)
    const staleClause = this.shared ? ' AND updatedAt <= @staleBefore' : ''
    const params = this.shared
      ? { now, staleBefore: now - SHARED_OUTBOX_LEASE_MS, ...scope.params }
      : { now, ...scope.params }
    const retried = (
      await this.db
        .prepare(
          `UPDATE memory_capture_outbox
         SET state = 'pending', nextAttemptAt = @now, updatedAt = @now,
             reasonCode = 'restart_retry'
         WHERE state = 'sending' AND idempotency = 'operation-id'${staleClause}${scope.sql}`
        )
        .run(params)
    ).changes
    const ambiguous = (
      await this.db
        .prepare(
          `UPDATE memory_capture_outbox
         SET state = 'ambiguous', nextAttemptAt = @now, updatedAt = @now,
             reasonCode = 'restart_after_send', config = '{}', input = '', output = '',
             sessionId = NULL, payloadBytes = 0
         WHERE state = 'sending' AND idempotency = 'none'${staleClause}${scope.sql}`
        )
        .run(params)
    ).changes
    return { retried: Number(retried), ambiguous: Number(ambiguous) }
  }

  /** Age out a capture that never settled: a state change with a redaction and a metric, so it
   *  stays here. Dropping the terminal row afterwards is retention and belongs to the rule table. */
  async expireMemoryCaptures(activeBefore: number, now: number, connectionIds?: readonly string[]): Promise<number> {
    const scope = idScope('connectionId', connectionIds)
    return Number(
      (
        await this.db
          .prepare(
            `UPDATE memory_capture_outbox
           SET state = 'failed', nextAttemptAt = @now, updatedAt = @now,
               reasonCode = 'retention_expired', config = '{}', input = '', output = '',
               sessionId = NULL, payloadBytes = 0
           WHERE state IN ('pending', 'accepted') AND createdAt <= @activeBefore${scope.sql}`
          )
          .run({ now, activeBefore, ...scope.params })
      ).changes
    )
  }

  async memoryCaptureStats(connectionIds?: readonly string[]): Promise<MemoryCaptureOutboxStats> {
    const scope = idScope('connectionId', connectionIds)
    const row = (await this.db
      .prepare(
        `SELECT COUNT(*) AS activeCount, COALESCE(SUM(payloadBytes), 0) AS activeBytes,
                MIN(createdAt) AS oldestActiveAt
         FROM memory_capture_outbox
         WHERE state IN ('pending', 'sending', 'accepted')${scope.sql}`
      )
      .get(scope.params)) as { activeCount: number; activeBytes: number; oldestActiveAt: number | null }
    return {
      activeCount: row.activeCount,
      activeBytes: row.activeBytes,
      ...(row.oldestActiveAt === null ? {} : { oldestActiveAt: row.oldestActiveAt })
    }
  }

  /** Upsert the durable non-secret record of a provisioned remote MCP grant.
   *  Overwrites a pending revocation for the conversation: re-provisioning means
   *  the CP re-validated the authority and the stale queued revoke must not fire
   *  against the fresh grant. */
  async recordWebchatMcpGrant(input: {
    conversationId: string
    agentId: string
    authorityId: string
    authorityGeneration: number
    now: number
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO webchat_mcp_grant_ledger
           (conversationId, agentId, authorityId, authorityGeneration, state, reason, attempts, nextAttemptAt,
            updatedAt, ownerId)
         VALUES (@conversationId, @agentId, @authorityId, @authorityGeneration, 'active', NULL, 0, NULL, @now, @ownerId)
         ON CONFLICT (conversationId) DO UPDATE SET
           agentId = excluded.agentId,
           authorityId = excluded.authorityId,
           authorityGeneration = excluded.authorityGeneration,
           state = 'active', reason = NULL, attempts = 0, nextAttemptAt = NULL,
           updatedAt = excluded.updatedAt, ownerId = excluded.ownerId`
      )
      .run({ ...input, ownerId: this.ownerId ?? null })
  }

  /** Queue a durable revocation for a grant authority whose remote revoke failed
   *  (or must outlive this process). Fenced to the exact authority tuple via the
   *  upsert so a concurrent re-provision (newer tuple) is not downgraded. */
  async markWebchatMcpGrantRevoking(input: {
    conversationId: string
    agentId: string
    authorityId: string
    authorityGeneration: number
    reason: string
    now: number
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO webchat_mcp_grant_ledger
           (conversationId, agentId, authorityId, authorityGeneration, state, reason, attempts, nextAttemptAt,
            updatedAt, ownerId)
         VALUES (@conversationId, @agentId, @authorityId, @authorityGeneration, 'revoking', @reason, 0, @now, @now,
            @ownerId)
         ON CONFLICT (conversationId) DO UPDATE SET
           state = 'revoking', reason = excluded.reason, nextAttemptAt = excluded.nextAttemptAt,
           updatedAt = excluded.updatedAt, ownerId = excluded.ownerId
         WHERE webchat_mcp_grant_ledger.authorityId = excluded.authorityId
           AND webchat_mcp_grant_ledger.authorityGeneration <= excluded.authorityGeneration`
      )
      .run({ ...input, ownerId: this.ownerId ?? null })
  }

  /** Drop the ledger row after the CP confirmed revocation — only for the exact
   *  tuple, so a newer re-provisioned authority record survives a late confirm. */
  async clearWebchatMcpGrant(conversationId: string, authorityId: string, authorityGeneration: number): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM webchat_mcp_grant_ledger
         WHERE conversationId = ? AND authorityId = ? AND authorityGeneration = ?`
      )
      .run(conversationId, authorityId, authorityGeneration)
  }

  /** Startup orphan sweep over the grants THIS incarnation recorded: its descriptors and
   *  plaintext died with it. On a shared store an 'active' row may be a peer's live authority
   *  for a conversation in progress, so ownership — not process start — decides. */
  async markOwnedWebchatMcpGrantsRevoking(reason: string, now: number): Promise<number> {
    const owned = this.shared ? ' AND ownerId = @ownerId' : ''
    return Number(
      (
        await this.db
          .prepare(
            `UPDATE webchat_mcp_grant_ledger
           SET state = 'revoking', reason = @reason, nextAttemptAt = @now, updatedAt = @now
           WHERE state = 'active'${owned}`
          )
          .run({ reason, now, ...(this.shared ? { ownerId: this.ownerId! } : {}) })
      ).changes
    )
  }

  /** Take over the grant rows of a former owner of these agents once the CP makes this process
   *  responsible for them: the plaintext went with the owner, so the authority must be revoked. */
  async reclaimWebchatMcpGrants(agentIds: readonly string[], reason: string, now: number): Promise<number> {
    if (!this.shared || agentIds.length === 0) return 0
    const scope = idScope('agentId', agentIds)
    return Number(
      (
        await this.db
          .prepare(
            `UPDATE webchat_mcp_grant_ledger
           SET state = 'revoking', reason = @reason, attempts = 0, nextAttemptAt = @now,
               updatedAt = @now, ownerId = @ownerId
           WHERE (ownerId IS NULL OR ownerId != @ownerId)${scope.sql}`
          )
          .run({ reason, now, ownerId: this.ownerId!, ...scope.params })
      ).changes
    )
  }

  /** The revocations this process must deliver: its own queue, plus rows written before ownership was
   *  recorded. A peer's queued revoke is the peer's to land — here it would duplicate the CP call. */
  async listDueWebchatMcpRevocations(now: number, limit = 50): Promise<WebchatMcpGrantLedgerRow[]> {
    const owned = this.shared ? ' AND (ownerId IS NULL OR ownerId = @ownerId)' : ''
    return (await this.db
      .prepare(
        `SELECT * FROM webchat_mcp_grant_ledger
         WHERE state = 'revoking' AND (nextAttemptAt IS NULL OR nextAttemptAt <= @now)${owned}
         ORDER BY nextAttemptAt ASC, conversationId ASC
         LIMIT @limit`
      )
      .all({ now, limit, ...(this.shared ? { ownerId: this.ownerId! } : {}) })) as unknown as WebchatMcpGrantLedgerRow[]
  }

  /** Reschedule one failed revocation attempt (exact-tuple fenced). */
  async retryWebchatMcpRevocation(
    conversationId: string,
    authorityId: string,
    authorityGeneration: number,
    nextAttemptAt: number,
    now: number
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE webchat_mcp_grant_ledger
         SET attempts = attempts + 1, nextAttemptAt = @nextAttemptAt, updatedAt = @now
         WHERE conversationId = @conversationId AND authorityId = @authorityId
           AND authorityGeneration = @authorityGeneration AND state = 'revoking'`
      )
      .run({ conversationId, authorityId, authorityGeneration, nextAttemptAt, now })
  }

  /** The §16 projection THIS daemon identity last wrote for a merge-request head, or nothing yet.
   *  Scoped by the stable daemon id on every store: a pool peer's row is not this daemon's to read. */
  async getNoteProjection(daemonId: string, projectionKey: string): Promise<NoteProjectionRow | undefined> {
    const row = (await this.db
      .prepare('SELECT * FROM code_host_note_projection WHERE projectionKey = @projectionKey AND daemonId = @daemonId')
      .get({ projectionKey, daemonId })) as CodeHostNoteProjectionRow | undefined
    return row ? toNoteProjectionRow(row) : undefined
  }

  /** Record the write marker BEFORE the provider mutation, so an interrupted write is reconcilable. */
  async beginNoteProjectionWrite(row: NoteProjectionRow, now: number): Promise<void> {
    await this.db
      .prepare(NOTE_PROJECTION_UPSERT)
      .run({ ...noteProjectionParams(row, now, this.ownerId ?? null), phase: 'in_flight', outcome: null, code: null })
  }

  /** Persist a definite outcome as UNREPORTED: it is replayed until the control plane acknowledges it. */
  async recordNoteProjectionOutcome(
    row: NoteProjectionRow,
    outcome: NoteProjectionOutcome,
    code: string | undefined,
    now: number
  ): Promise<void> {
    await this.db.prepare(NOTE_PROJECTION_UPSERT).run({
      ...noteProjectionParams(row, now, this.ownerId ?? null),
      phase: 'settled_unreported',
      outcome,
      code: code ?? null
    })
  }

  /** The control plane acknowledged the result: only then does the row stop being replayed. */
  async markNoteProjectionReported(
    daemonId: string,
    projectionKey: string,
    writeMarker: string,
    now: number
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE code_host_note_projection
         SET phase = 'settled', updatedAt = @now
         WHERE projectionKey = @projectionKey AND daemonId = @daemonId AND writeMarker = @writeMarker
           AND phase = 'settled_unreported'`
      )
      .run({ projectionKey, daemonId, writeMarker, now })
  }

  /**
   * Writes THIS DAEMON IDENTITY has not carried to a reported outcome: reconcile or replay.
   *
   * Keyed by the stable daemon id, never the process incarnation, because a restart is exactly when
   * recovery is owed — and the control plane keeps an ambiguous write marker on that same identity,
   * so a row no restarted daemon could see would never be settled by anyone.
   */
  async listUnsettledNoteProjections(daemonId: string, limit = 100): Promise<NoteProjectionRow[]> {
    const rows = (await this.db
      .prepare(
        `SELECT * FROM code_host_note_projection
         WHERE daemonId = @daemonId AND phase IN ('in_flight', 'settled_unreported')
         ORDER BY updatedAt ASC LIMIT @limit`
      )
      .all({ daemonId, limit })) as unknown as CodeHostNoteProjectionRow[]
    return rows.map(toNoteProjectionRow)
  }

  /**
   * A restart-stable daemon-local secret, minted once on first use.
   *
   * The insert is `ON CONFLICT DO NOTHING` and the read follows it, so two callers racing
   * the same name both observe the one stored value rather than each keeping its own.
   */
  async getOrCreateDaemonSecret(name: string, mint: () => string, now: number): Promise<string> {
    await this.db
      .prepare('INSERT INTO daemon_secret (name, value, createdAt) VALUES (@name, @value, @now) ON CONFLICT DO NOTHING')
      .run({ name, value: mint(), now })
    const row = (await this.db.prepare('SELECT value FROM daemon_secret WHERE name = @name').get({ name })) as
      { value: string } | undefined
    if (!row) throw new Error(`daemon secret ${name} could not be stored`)
    return row.value
  }

  /** Remember a control-plane frame this review attempt still owes, so a lost ack is replayed. */
  async recordReviewIntent(row: ReviewIntentRow, now: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO code_host_review_intent (intentId, daemonId, attemptId, orgId, kind, frame, attempts, updatedAt)
         VALUES (@intentId, @daemonId, @attemptId, @orgId, @kind, @frame, @attempts, @now)
         ON CONFLICT (intentId) DO UPDATE SET
           attempts = excluded.attempts, frame = excluded.frame, updatedAt = excluded.updatedAt`
      )
      .run({
        intentId: row.intentId,
        daemonId: row.daemonId,
        attemptId: row.attemptId,
        orgId: row.orgId ?? null,
        kind: row.kind,
        frame: row.frame,
        attempts: row.attempts,
        now
      })
  }

  /** The control plane took it; nothing is owed for that frame any more. */
  async clearReviewIntent(intentId: string): Promise<void> {
    await this.db.prepare('DELETE FROM code_host_review_intent WHERE intentId = @intentId').run({ intentId })
  }

  /** Scoped to the stable daemon identity, so a restart replays its own frames and no peer's. */
  async listReviewIntents(daemonId: string, limit = 100): Promise<ReviewIntentRow[]> {
    const rows = (await this.db
      .prepare(
        `SELECT intentId, daemonId, attemptId, orgId, kind, frame, attempts FROM code_host_review_intent
         WHERE daemonId = @daemonId ORDER BY updatedAt ASC LIMIT @limit`
      )
      .all({ daemonId, limit })) as unknown as Array<ReviewIntentRow & { orgId: string | null }>
    return rows.map((row) => ({
      intentId: row.intentId,
      daemonId: row.daemonId,
      attemptId: row.attemptId,
      ...(row.orgId ? { orgId: row.orgId } : {}),
      kind: row.kind,
      frame: row.frame,
      attempts: row.attempts
    }))
  }

  /** Record one turn admission against a conversation-wide fixed window. A trusted
   *  human boundary resets only the consecutive automatic counter; the total-rate
   *  backstop deliberately keeps counting so a platform bug that misclassifies its
   *  own events as human still eventually opens the circuit. */
  async recordLoopGuardTurn(
    scopeKey: string,
    now: number,
    automatic: boolean,
    limits: { windowMs: number; maxTotal: number; maxAutomatic: number }
  ): Promise<LoopGuardVerdict> {
    return await this.chargeLoopGuardTurn(this.db, scopeKey, now, automatic, limits)
  }

  /** The charge itself, on whichever statement runner the caller owns — the inbox variant runs
   *  it inside its transaction, where a statement on the pooled facade would land outside. */
  private async chargeLoopGuardTurn(
    db: StoreAccess,
    scopeKey: string,
    now: number,
    automatic: boolean,
    limits: { windowMs: number; maxTotal: number; maxAutomatic: number }
  ): Promise<LoopGuardVerdict> {
    // Keep only active-window counters plus intentionally-latched incidents. Without
    // this bounded cleanup, every one-off channel thread would leave a row forever.
    await db
      .prepare(
        `DELETE FROM loop_guard
         WHERE trippedAt IS NULL AND windowStartedAt <= @cutoff AND automaticWindowStartedAt <= @cutoff`
      )
      .run({ cutoff: now - limits.windowMs })
    // The charge is one relative, window-aware statement, never a JS read-modify-write:
    // pool members sharing this store charge the same conversation concurrently, and an
    // absolute upsert would let the faster loop lose exactly the increments that matter.
    // The DO UPDATE guard makes a latched circuit skip the charge and return no row.
    const charged = (await db
      .prepare(
        `INSERT INTO loop_guard
           (scopeKey, windowStartedAt, totalCount, automaticWindowStartedAt, automaticCount, trippedAt, reason)
         VALUES (@scopeKey, @now, 1, @now, @automatic, NULL, NULL)
         ON CONFLICT(scopeKey) DO UPDATE SET
           windowStartedAt=CASE WHEN @now - loop_guard.windowStartedAt >= @windowMs
             THEN @now ELSE loop_guard.windowStartedAt END,
           totalCount=CASE WHEN @now - loop_guard.windowStartedAt >= @windowMs
             THEN 1 ELSE loop_guard.totalCount + 1 END,
           automaticWindowStartedAt=CASE WHEN @automatic = 0
             OR @now - loop_guard.automaticWindowStartedAt >= @windowMs
             THEN @now ELSE loop_guard.automaticWindowStartedAt END,
           automaticCount=CASE WHEN @automatic = 0 THEN 0
             WHEN @now - loop_guard.automaticWindowStartedAt >= @windowMs
             THEN 1 ELSE loop_guard.automaticCount + 1 END
         WHERE loop_guard.trippedAt IS NULL
         RETURNING totalCount, automaticCount`
      )
      .get({ scopeKey, now, automatic: automatic ? 1 : 0, windowMs: limits.windowMs })) as
      { totalCount: number; automaticCount: number } | undefined
    if (!charged) return await this.latchedLoopGuardVerdict(db, scopeKey)

    const totalCount = Number(charged.totalCount)
    const automaticCount = Number(charged.automaticCount)
    const reason =
      automaticCount > limits.maxAutomatic
        ? 'automatic_turn_burst'
        : totalCount > limits.maxTotal
          ? 'turn_rate_burst'
          : undefined
    if (!reason) return { allowed: true, trippedNow: false, totalCount, automaticCount }
    // The verdict is computed from what was actually stored, so the latch is a CAS: a
    // member that loses it still refuses the turn but runs no duplicate side effects.
    const latched =
      (
        await db
          .prepare(
            'UPDATE loop_guard SET trippedAt=@now, reason=@reason WHERE scopeKey=@scopeKey AND trippedAt IS NULL'
          )
          .run({ scopeKey, now, reason })
      ).changes === 1
    return { allowed: false, trippedNow: latched, totalCount, automaticCount, reason }
  }

  /** The verdict for a scope another writer already latched: refuse, own no side effects. */
  private async latchedLoopGuardVerdict(db: StoreAccess, scopeKey: string): Promise<LoopGuardVerdict> {
    const current = await this.loopGuardRow(db, scopeKey)
    return {
      allowed: false,
      trippedNow: false,
      totalCount: Number(current?.totalCount ?? 0),
      automaticCount: Number(current?.automaticCount ?? 0),
      ...(current?.reason ? { reason: current.reason } : {})
    }
  }

  /** Charge a migrated inbox delivery and advance its marker in one transaction, so a crash
   *  can neither lose the charge nor charge the same retained row again after ownership moves.
   *  The transaction buys atomicity only — the charge itself is a relative SQL statement and
   *  never depends on an exclusive writer, which a shared PostgreSQL store cannot give it.
   *  A tripping delivery is intentionally left at marker 0: the newly-open durable circuit
   *  makes its whole scope terminal and replay purges it. */
  async recordLoopGuardTurnForInbox(
    inboxId: string,
    scopeKey: string,
    now: number,
    automatic: boolean,
    limits: { windowMs: number; maxTotal: number; maxAutomatic: number }
  ): Promise<LoopGuardVerdict> {
    return await this.transaction(async (raw) => {
      const tx = accessOf(raw)
      const verdict = await this.chargeLoopGuardTurn(tx, scopeKey, now, automatic, limits)
      if (verdict.allowed) {
        const marked = await tx.prepare('UPDATE inbox SET loopGuardCounted = 1 WHERE id = ?').run(inboxId)
        if (marked.changes !== 1) throw new Error(`inbox delivery disappeared while charging loop guard: ${inboxId}`)
      }
      return verdict
    })
  }

  /** Open a loop circuit immediately for a structurally-invalid platform event. The latch
   *  is a single guarded statement, so concurrent members elect exactly one side-effect owner. */
  async tripLoopGuard(scopeKey: string, now: number, reason: string): Promise<LoopGuardVerdict> {
    const latched = (await this.db
      .prepare(
        `INSERT INTO loop_guard
           (scopeKey, windowStartedAt, totalCount, automaticWindowStartedAt, automaticCount, trippedAt, reason)
         VALUES (@scopeKey, @now, 0, @now, 0, @now, @reason)
         ON CONFLICT(scopeKey) DO UPDATE SET trippedAt=@now, reason=@reason
         WHERE loop_guard.trippedAt IS NULL
         RETURNING totalCount, automaticCount`
      )
      .get({ scopeKey, now, reason })) as { totalCount: number; automaticCount: number } | undefined
    if (!latched) return await this.latchedLoopGuardVerdict(this.db, scopeKey)
    return {
      allowed: false,
      trippedNow: true,
      totalCount: Number(latched.totalCount),
      automaticCount: Number(latched.automaticCount),
      reason
    }
  }

  async getLoopGuard(scopeKey: string): Promise<LoopGuardRow | undefined> {
    return await this.loopGuardRow(this.db, scopeKey)
  }

  private async loopGuardRow(db: StoreAccess, scopeKey: string): Promise<LoopGuardRow | undefined> {
    return (await db.prepare('SELECT * FROM loop_guard WHERE scopeKey = ?').get(scopeKey)) as LoopGuardRow | undefined
  }

  async isLoopGuardOpen(scopeKey: string): Promise<boolean> {
    const row = await this.getLoopGuard(scopeKey)
    return row?.trippedAt !== null && row?.trippedAt !== undefined
  }

  /** Explicit operator/user reset. Purged inbox rows stay purged; reset only lets a
   *  future fresh message start a new window. Returns whether a guard existed. */
  async resetLoopGuard(scopeKey: string): Promise<boolean> {
    return (await this.db.prepare('DELETE FROM loop_guard WHERE scopeKey = ?').run(scopeKey)).changes > 0
  }

  // ── send-message-routing-rework.md §8.6: activation rendezvous ──

  async getActivation(activationKey: string): Promise<ActivationRecord | undefined> {
    return (await this.db.prepare('SELECT * FROM activation_rendezvous WHERE activationKey = ?').get(activationKey)) as
      ActivationRecord | undefined
  }

  /**
   * Record the VISIBLE half of a paired delivery and claim the key `pending`
   * (§3.2 "platform event first"): the observation is stored, and nothing is dispatched.
   *
   * Deliberately never advances state on its own. The visible post is provider-
   * authenticated, but it carries none of the trusted call envelope — so treating its
   * arrival as an admission would fabricate the very lineage the rendezvous exists to
   * preserve. It waits for {@link attachActivationEnvelope}.
   *
   * Idempotent: a redelivered platform event re-runs this and changes nothing about an
   * existing record's state or envelope.
   */
  async claimActivationObservation(
    activationKey: string,
    observation: { agentCallDeliveryId?: string; platformMessageId: string; transcriptCoordinates: string },
    expiresAt: number
  ): Promise<ActivationRecord> {
    return await this.transaction(async (raw) => {
      const tx = accessOf(raw)
      await tx
        .prepare(
          `INSERT INTO activation_rendezvous
             (activationKey, agentCallDeliveryId, platformMessageId, transcriptCoordinates, state, expiresAt)
           VALUES (?, ?, ?, ?, 'pending', ?)
           ON CONFLICT(activationKey) DO UPDATE SET
             agentCallDeliveryId = COALESCE(excluded.agentCallDeliveryId, activation_rendezvous.agentCallDeliveryId),
             platformMessageId = excluded.platformMessageId,
             transcriptCoordinates = excluded.transcriptCoordinates`
        )
        .run(
          activationKey,
          observation.agentCallDeliveryId ?? null,
          observation.platformMessageId,
          observation.transcriptCoordinates,
          expiresAt
        )
      return (await tx
        .prepare('SELECT * FROM activation_rendezvous WHERE activationKey = ?')
        .get(activationKey)) as ActivationRecord
    })
  }

  /** Atomically attach the authoritative envelope; exactly one replica receives the dispatch claim.
   *  Left CAS-shaped rather than transactional: the guarded INSERT/UPDATE elects the claimer, and
   *  the retry loop already answers the interleaving a peer's write can cause. */
  async attachActivationEnvelope(
    activationKey: string,
    callEnvelope: string,
    expiresAt: number,
    /** Durable inbox id used to reconcile a crash between claim and admission. */
    dispatchId?: string
  ): Promise<{ dispatch: boolean; record: ActivationRecord }> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const inserted = await this.db
        .prepare(
          `INSERT OR IGNORE INTO activation_rendezvous
             (activationKey, callEnvelope, dispatchId, state, expiresAt)
           VALUES (?, ?, ?, 'pending', ?)`
        )
        .run(activationKey, callEnvelope, dispatchId ?? null, expiresAt)
      const claimed =
        Number(inserted.changes) === 1
          ? true
          : Number(
              (
                await this.db
                  .prepare(
                    `UPDATE activation_rendezvous
                   SET callEnvelope = ?, dispatchId = ?, expiresAt = ?
                   WHERE activationKey = ? AND state = 'pending' AND callEnvelope IS NULL`
                  )
                  .run(callEnvelope, dispatchId ?? null, expiresAt, activationKey)
              ).changes
            ) === 1
      const record = await this.getActivation(activationKey)
      if (record) return { dispatch: claimed, record }
    }
    throw new Error(`activation claim for "${activationKey}" changed too often`)
  }

  /**
   * Commit a dispatched activation: `pending -> admitted`, storing the child session the
   * delivery opened so every later retry is answered from the record rather than by
   * opening a second session. Only a `pending` record with an envelope may transition —
   * the CHECK the design states as "a platform-first paired record cannot become
   * `admitted` until `callEnvelope` is present".
   */
  async admitActivation(activationKey: string, childSessionId: string): Promise<boolean> {
    return (
      (
        await this.db
          .prepare(
            `UPDATE activation_rendezvous SET state = 'admitted', childSessionId = ?
           WHERE activationKey = ? AND state = 'pending' AND callEnvelope IS NOT NULL`
          )
          .run(childSessionId, activationKey)
      ).changes === 1
    )
  }

  /**
   * Give the claim back when the dispatch it was claimed for never reached durable
   * admission (§8.6 — exactly-once must not become never).
   *
   * `attachActivationEnvelope` hands out `dispatch: true` exactly once, so a delivery
   * that then fails to admit — a rejected turn, a persistence error, a crash in the
   * window — would leave the key claimed forever and every retry would be deduplicated
   * against a child that does not exist. Releasing restores the pre-claim state so the
   * next attempt is a first attempt.
   *
   * Deliberately narrow: only a `pending` record is released. An `admitted` one has a
   * real child, and a `transcript-only` one was already reported as a delivery failure —
   * reopening either would undo a decision something downstream has acted on.
   */
  async releaseActivation(activationKey: string): Promise<boolean> {
    return (
      (
        await this.db
          .prepare(`DELETE FROM activation_rendezvous WHERE activationKey = ? AND state = 'pending'`)
          .run(activationKey)
      ).changes === 1
    )
  }

  /**
   * Sweep expired pending records. Two DIFFERENT failures share this table, and they must
   * not share an outcome.
   *
   * **No envelope** — the visible half of a paired call whose authoritative wake never
   * arrived (§3.2/§8.6). The observation stands, the delivery is a FAILURE, and no
   * envelope-less child is ever synthesized from platform metadata. Terminal
   * `transcript-only`, returned so the caller can raise the operational failure.
   *
   * **With an envelope** — a claim whose dispatch never reached admission. In-process that
   * is repaired by `releaseActivation` on the admission barrier, but a hard CRASH between
   * the claim and admission leaves the row behind with nobody to run that callback. Left
   * alone it is claimed forever: `attachActivationEnvelope` answers every retry with
   * `dispatch: false`, so exactly-once quietly becomes never — the failure mode the whole
   * record exists to prevent. Past its TTL the claim is RELEASED (deleted), so the next
   * attempt is a first attempt. It is not reported as a delivery failure because, unlike
   * the envelope-less case, nothing here says the delivery was observed and lost.
   */
  async expireActivations(now: number): Promise<{ transcriptOnly: ActivationRecord[]; released: number }> {
    return await this.transaction(async (raw) => {
      const tx = accessOf(raw)
      const transcriptOnly = (await tx
        .prepare(
          `SELECT * FROM activation_rendezvous
           WHERE state = 'pending' AND callEnvelope IS NULL AND expiresAt <= ?`
        )
        .all(now)) as unknown as ActivationRecord[]
      if (transcriptOnly.length > 0) {
        await tx
          .prepare(
            `UPDATE activation_rendezvous SET state = 'transcript-only'
             WHERE state = 'pending' AND callEnvelope IS NULL AND expiresAt <= ?`
          )
          .run(now)
      }
      // The crash-recovery arm, RECONCILED against the durable inbox rather than assumed.
      // A crash between claim and admission leaves two rows that look identical but need
      // OPPOSITE answers:
      //   - the inbox row EXISTS ⇒ startup replay will run this turn. The delivery is
      //     alive, so the claim is completed (`admitted`), never released — releasing
      //     would let a later retry dispatch the same logical delivery a second time.
      //   - no inbox row ⇒ the dispatch never persisted. Release, so the next attempt is a
      //     first attempt; leaving it claimed is exactly-once becoming never.
      // A legacy row with no `dispatchId` is not reconcilable and takes the release arm —
      // the same answer as "never persisted".
      await tx
        .prepare(
          `UPDATE activation_rendezvous SET state = 'admitted'
           WHERE state = 'pending' AND callEnvelope IS NOT NULL AND expiresAt <= ?
             AND dispatchId IS NOT NULL
             AND EXISTS (SELECT 1 FROM inbox WHERE inbox.id = activation_rendezvous.dispatchId)`
        )
        .run(now)
      const released = (
        await tx
          .prepare(
            `DELETE FROM activation_rendezvous
           WHERE state = 'pending' AND callEnvelope IS NOT NULL AND expiresAt <= ?`
          )
          .run(now)
      ).changes
      return { transcriptOnly, released: Number(released) }
    })
  }

  // ── §3.4/§6.8 main-agent orchestration ──

  /**
   * RECORD-FIRST (§3.4): persist the orchestration header + all subtask rows (status
   * 'pending') in ONE transaction, BEFORE any delivery. A fast worker's reply that
   * arrives before this returns has nothing to correlate against and is dropped — so
   * this MUST complete before startOrchestration delivers anything. Idempotent via
   * INSERT OR IGNORE on the stable ids (replay-safe).
   */
  async createOrchestration(orch: OrchestrationRow, subtasks: SubtaskRow[]): Promise<void> {
    await this.transaction(async (raw) => {
      const tx = accessOf(raw)
      const insertOrch = tx.prepare(
        `INSERT OR IGNORE INTO orchestration
         (orchestrationId, mainSessionKey, mainAgentId, platform, channel, thread,
          integrationId, replyTarget, deadline, status, createdAt, updatedAt)
       VALUES (@orchestrationId, @mainSessionKey, @mainAgentId, @platform, @channel, @thread,
          @integrationId, @replyTarget, @deadline, @status, @createdAt, @updatedAt)`
      )
      const insertSub = tx.prepare(
        `INSERT OR IGNORE INTO orchestration_subtask
         (orchestrationId, correlationId, idx, toAgentId, text, status, result, deliveryReason, updatedAt)
       VALUES (@orchestrationId, @correlationId, @idx, @toAgentId, @text, @status, @result, @deliveryReason, @updatedAt)`
      )
      await insertOrch.run({
        orchestrationId: orch.orchestrationId,
        mainSessionKey: orch.mainSessionKey,
        mainAgentId: orch.mainAgentId,
        platform: orch.platform,
        channel: orch.channel,
        thread: orch.thread,
        integrationId: orch.integrationId ?? null,
        replyTarget: orch.replyTarget ?? null,
        deadline: orch.deadline ?? null,
        status: orch.status,
        createdAt: orch.createdAt,
        updatedAt: orch.updatedAt
      })
      for (const s of subtasks) {
        await insertSub.run({
          orchestrationId: s.orchestrationId,
          correlationId: s.correlationId,
          idx: s.idx,
          toAgentId: s.toAgentId,
          text: s.text,
          status: s.status,
          result: s.result ?? null,
          deliveryReason: s.deliveryReason ?? null,
          updatedAt: s.updatedAt
        })
      }
    })
  }

  async getOrchestration(orchestrationId: string): Promise<OrchestrationRow | undefined> {
    return (await this.db
      .prepare('SELECT * FROM orchestration WHERE orchestrationId = ?')
      .get(orchestrationId)) as unknown as OrchestrationRow | undefined
  }

  async getSubtasks(orchestrationId: string): Promise<SubtaskRow[]> {
    return (await this.db
      .prepare('SELECT * FROM orchestration_subtask WHERE orchestrationId = ? ORDER BY idx ASC')
      .all(orchestrationId)) as unknown as SubtaskRow[]
  }

  async getSubtaskByCorrelation(orchestrationId: string, correlationId: string): Promise<SubtaskRow | undefined> {
    return (await this.db
      .prepare('SELECT * FROM orchestration_subtask WHERE orchestrationId = ? AND correlationId = ?')
      .get(orchestrationId, correlationId)) as unknown as SubtaskRow | undefined
  }

  /** All still-`active` orchestrations — for startup re-arm of deadlines + re-drive
   *  of non-terminal subtasks (§6.8). */
  async listActiveOrchestrations(): Promise<OrchestrationRow[]> {
    return (await this.db
      .prepare("SELECT * FROM orchestration WHERE status = 'active' ORDER BY createdAt ASC")
      .all()) as unknown as OrchestrationRow[]
  }

  /** CAS subtask status — only advances when the current status is one of `from`.
   *  Idempotent + monotonic: a stale/duplicate transition (current status not in
   *  `from`) is a no-op and returns false. */
  async setSubtaskStatus(
    orchestrationId: string,
    correlationId: string,
    from: SubtaskRow['status'][],
    to: SubtaskRow['status'],
    updatedAt: string,
    extra?: { result?: string | null; deliveryReason?: string | null }
  ): Promise<boolean> {
    const placeholders = from.map((_, i) => `@from${i}`).join(', ')
    const params: SqlParams = { orchestrationId, correlationId, to, updatedAt }
    from.forEach((f, i) => (params[`from${i}`] = f))
    let setResult = ''
    if (extra && 'result' in extra) {
      setResult += ', result=@result'
      params.result = extra.result ?? null
    }
    if (extra && 'deliveryReason' in extra) {
      setResult += ', deliveryReason=@deliveryReason'
      params.deliveryReason = extra.deliveryReason ?? null
    }
    const info = await this.db
      .prepare(
        `UPDATE orchestration_subtask SET status=@to, updatedAt=@updatedAt${setResult}
         WHERE orchestrationId=@orchestrationId AND correlationId=@correlationId AND status IN (${placeholders})`
      )
      .run(params)
    return info.changes > 0
  }

  async setOrchestrationStatus(
    orchestrationId: string,
    status: OrchestrationRow['status'],
    updatedAt: number
  ): Promise<void> {
    await this.db
      .prepare('UPDATE orchestration SET status=?, updatedAt=? WHERE orchestrationId=?')
      .run(status, updatedAt, orchestrationId)
  }

  async setOrchestrationDeadline(orchestrationId: string, deadline: number | null, updatedAt: number): Promise<void> {
    await this.db
      .prepare('UPDATE orchestration SET deadline=?, updatedAt=? WHERE orchestrationId=?')
      .run(deadline, updatedAt, orchestrationId)
  }

  /** CAS fire claim: clear the deadline iff it is still the armed one — every member sharing the
   *  store may hold a timer for it, and exactly one of them gets `true`. */
  async claimOrchestrationDeadline(orchestrationId: string, deadline: number, updatedAt: number): Promise<boolean> {
    return (
      (
        await this.db
          .prepare(
            "UPDATE orchestration SET deadline=NULL, updatedAt=? WHERE orchestrationId=? AND status='active' AND deadline=?"
          )
          .run(updatedAt, orchestrationId, deadline)
      ).changes === 1
    )
  }

  // ── runtime model-catalog cache (runtime-model-catalog.md §4) ──

  /** Upsert a runtime's catalog metadata (phase-1 probe fold or a discovery run).
   *  A same-fingerprint write PRESERVES the stored complete/modelsHash — a phase-1
   *  meta refresh must neither satisfy nor re-open the §3.3 discovery gate; a
   *  fingerprint change (adapter upgrade) resets both so the runtime is re-discovered. */
  async recordRuntimeCatalogMeta(meta: Omit<RuntimeCatalogMetaRecord, 'complete' | 'modelsHash'>): Promise<void> {
    await this.transaction(async (raw) => {
      const tx = accessOf(raw)
      const existing = (await tx
        .prepare(
          'SELECT fingerprint, complete, modelsHash FROM runtime_catalog_meta WHERE ownerId = ? AND runtimeId = ?'
        )
        .get(this.cacheOwnerId, meta.runtimeId)) as
        { fingerprint: string; complete: number; modelsHash: string | null } | undefined
      const sameGeneration = existing && existing.fingerprint === meta.fingerprint ? existing : undefined
      await tx
        .prepare(
          `INSERT INTO runtime_catalog_meta
             (ownerId, runtimeId, fingerprint, source, defaultModel, permissionModes, defaultPermissionMode, complete, modelsHash, observedAt)
           VALUES (@ownerId, @runtimeId, @fingerprint, @source, @defaultModel, @permissionModes, @defaultPermissionMode, @complete, @modelsHash, @observedAt)
           ON CONFLICT(ownerId, runtimeId) DO UPDATE SET
             fingerprint=excluded.fingerprint, source=excluded.source, defaultModel=excluded.defaultModel,
             permissionModes=excluded.permissionModes, defaultPermissionMode=excluded.defaultPermissionMode,
             complete=excluded.complete,
             modelsHash=excluded.modelsHash, observedAt=excluded.observedAt`
        )
        .run({
          ownerId: this.cacheOwnerId,
          runtimeId: meta.runtimeId,
          fingerprint: meta.fingerprint,
          source: meta.source,
          defaultModel: meta.defaultModel ?? null,
          permissionModes: meta.permissionModes ? JSON.stringify(meta.permissionModes) : null,
          defaultPermissionMode: meta.defaultPermissionMode ?? null,
          complete: sameGeneration?.complete ?? 0,
          modelsHash: sameGeneration?.modelsHash ?? null,
          observedAt: meta.observedAt
        })
    })
  }

  /** Close the discovery gate for ONE generation: complete=1 + the probed-models hash,
   *  only where the stored fingerprint still matches — a discovery finishing after the
   *  runtime was upgraded must not close the new generation's gate. */
  async markRuntimeCatalogComplete(
    runtimeId: string,
    fingerprint: string,
    modelsHash: string,
    observedAt: number
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE runtime_catalog_meta
         SET complete = 1, modelsHash = @modelsHash, observedAt = @observedAt
         WHERE ownerId = @ownerId AND runtimeId = @runtimeId AND fingerprint = @fingerprint`
      )
      .run({ ownerId: this.cacheOwnerId, runtimeId, fingerprint, modelsHash, observedAt })
  }

  /** Upsert one model's capability row (latest-wins). Written incrementally as each
   *  model is discovered, so a single-model failure never discards the rest. */
  async upsertRuntimeModelCap(rec: RuntimeModelCapRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO runtime_model_catalog (ownerId, runtimeId, modelId, fingerprint, capsJson, observedAt)
         VALUES (@ownerId, @runtimeId, @modelId, @fingerprint, @capsJson, @observedAt)
         ON CONFLICT(ownerId, runtimeId, modelId) DO UPDATE SET
           fingerprint=excluded.fingerprint, capsJson=excluded.capsJson, observedAt=excluded.observedAt`
      )
      .run({
        ownerId: this.cacheOwnerId,
        runtimeId: rec.runtimeId,
        modelId: rec.modelId,
        fingerprint: rec.fingerprint,
        capsJson: JSON.stringify(rec.caps),
        observedAt: rec.observedAt
      })
  }

  /** Drop models that vanished from a runtime's catalog. Called only after a COMPLETE
   *  successful discovery (prune-on-success) — failures must keep last-good rows. */
  async pruneRuntimeModelCaps(runtimeId: string, keepModelIds: string[]): Promise<void> {
    // SQLite accepts an empty IN () list (always false), so an empty keep-set clears
    // the runtime's rows — correct for a runtime whose catalog came back empty.
    const placeholders = keepModelIds.map(() => '?').join(', ')
    await this.db
      .prepare(
        `DELETE FROM runtime_model_catalog
         WHERE ownerId = ? AND runtimeId = ? AND modelId NOT IN (${placeholders})`
      )
      .run(this.cacheOwnerId, runtimeId, ...keepModelIds)
  }

  async getRuntimeCatalogMeta(runtimeId: string): Promise<RuntimeCatalogMetaRecord | undefined> {
    const row = (await this.db
      .prepare('SELECT * FROM runtime_catalog_meta WHERE ownerId = ? AND runtimeId = ?')
      .get(this.cacheOwnerId, runtimeId)) as RuntimeCatalogMetaRow | undefined
    return row ? runtimeCatalogMetaFromRow(row) : undefined
  }

  async listRuntimeCatalogMetas(): Promise<RuntimeCatalogMetaRecord[]> {
    const rows = (await this.db
      .prepare('SELECT * FROM runtime_catalog_meta WHERE ownerId = ? ORDER BY runtimeId ASC')
      .all(this.cacheOwnerId)) as unknown as RuntimeCatalogMetaRow[]
    return rows.map(runtimeCatalogMetaFromRow)
  }

  async listRuntimeModelCaps(runtimeId?: string): Promise<RuntimeModelCapRecord[]> {
    const rows = (runtimeId !== undefined
      ? await this.db
          .prepare('SELECT * FROM runtime_model_catalog WHERE ownerId = ? AND runtimeId = ? ORDER BY modelId ASC')
          .all(this.cacheOwnerId, runtimeId)
      : await this.db
          .prepare('SELECT * FROM runtime_model_catalog WHERE ownerId = ? ORDER BY runtimeId ASC, modelId ASC')
          .all(this.cacheOwnerId)) as unknown as RuntimeModelCapRow[]
    return rows.map((row) => ({
      runtimeId: row.runtimeId,
      modelId: row.modelId,
      fingerprint: row.fingerprint,
      caps: parseJsonColumn<RuntimeModelCapRecord['caps']>(row.capsJson) ?? {},
      observedAt: row.observedAt
    }))
  }

  /**
   * Try to become the member that probes this runtime image. One atomic upsert decides it, so two
   * members starting together cannot both win: the loser reads the winner's payload instead. A
   * claim whose holder died is retaken once it goes stale — otherwise one crashed member would
   * leave the pool with no probe at all.
   */
  async claimRuntimeImageProbe(input: {
    imageRef: string
    memberId: string
    now: number
    staleBefore: number
  }): Promise<boolean> {
    const row = (await this.db
      .prepare(
        `INSERT INTO runtime_image_probe (imageRef, claimedBy, claimedAt)
         VALUES (@imageRef, @memberId, @now)
         ON CONFLICT(imageRef) DO UPDATE SET claimedBy = @memberId, claimedAt = @now
           WHERE runtime_image_probe.claimedBy IS NULL
              OR runtime_image_probe.claimedBy = @memberId
              OR COALESCE(runtime_image_probe.claimedAt, 0) <= @staleBefore
         RETURNING claimedBy`
      )
      .get(input)) as { claimedBy: string | null } | undefined
    return row?.claimedBy === input.memberId
  }

  /** The published answer for an image, if one has landed. */
  async readRuntimeImageProbe(imageRef: string): Promise<{ payload: string; probedAt: number } | undefined> {
    const row = (await this.db
      .prepare('SELECT payload, probedAt FROM runtime_image_probe WHERE imageRef = ?')
      .get(imageRef)) as { payload: string | null; probedAt: number | null } | undefined
    if (!row?.payload || row.probedAt === null) return undefined
    return { payload: row.payload, probedAt: row.probedAt }
  }

  /** Hand a claim back without an answer: this member tried and failed, and the pool should not
   *  have to wait out the whole stale window before another member does. */
  async releaseRuntimeImageProbe(imageRef: string, memberId: string): Promise<void> {
    await this.db
      .prepare('UPDATE runtime_image_probe SET claimedBy = NULL, claimedAt = NULL WHERE imageRef = ? AND claimedBy = ?')
      .run(imageRef, memberId)
  }

  /** Publish what this member's probe found, and release the claim with it. Rows for images the
   *  pool has long stopped running are dropped on the way past: one per image tag ever deployed
   *  would otherwise accumulate for the life of the deployment. */
  async publishRuntimeImageProbe(input: { imageRef: string; payload: string; now: number }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO runtime_image_probe (imageRef, claimedBy, claimedAt, probedAt, payload)
         VALUES (@imageRef, NULL, NULL, @now, @payload)
         ON CONFLICT(imageRef) DO UPDATE SET claimedBy = NULL, claimedAt = NULL,
           probedAt = @now, payload = @payload`
      )
      .run(input)
    await this.db
      .prepare('DELETE FROM runtime_image_probe WHERE imageRef <> ? AND COALESCE(probedAt, claimedAt, 0) < ?')
      .run(input.imageRef, input.now - RUNTIME_IMAGE_PROBE_RETENTION_MS)
  }

  /** Next shim-binding generation for an agent's sandbox: one atomic upsert, so two members cannot tie. */
  // The row outlives the claim on purpose — nothing here may hand out a number a pod has seen before.
  async nextSandboxGeneration(agentId: string): Promise<number> {
    const row = (await this.db
      .prepare(
        `INSERT INTO sandbox_generations (agentId, generation) VALUES (?, 1)
         ON CONFLICT(agentId) DO UPDATE SET generation = sandbox_generations.generation + 1
         RETURNING generation`
      )
      .get(agentId)) as { generation: number } | undefined
    if (row === undefined) throw new Error(`could not allocate a sandbox generation for agent ${agentId}`)
    return Number(row.generation)
  }

  /** Advance the shared write fence before a newly granted duty may mutate cluster skill state. */
  async projectDutyWriteFence(input: { groupId: string; term: string; daemonId: string }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO duty_write_fence (groupId, term, daemonId) VALUES (@groupId, @term, @daemonId)
         ON CONFLICT(groupId) DO UPDATE SET term = excluded.term, daemonId = excluded.daemonId
         WHERE length(excluded.term) > length(duty_write_fence.term)
            OR (length(excluded.term) = length(duty_write_fence.term) AND excluded.term > duty_write_fence.term)
            OR (excluded.term = duty_write_fence.term AND excluded.daemonId = duty_write_fence.daemonId)`
      )
      .run(input)
    return result.changes === 1
  }

  async revokeDutyWriteFence(input: { groupId: string; term: string; daemonId: string }): Promise<void> {
    await this.db
      .prepare('DELETE FROM duty_write_fence WHERE groupId = @groupId AND term = @term AND daemonId = @daemonId')
      .run(input)
  }

  async clusterSkillLedger(
    agentId: string,
    workspaceIncarnation: string
  ): Promise<ClusterSkillLedgerRecord | undefined> {
    const row = (await this.db
      .prepare('SELECT revision, ledger FROM cluster_skill_ledger WHERE agentId = ? AND workspaceIncarnation = ?')
      .get(agentId, workspaceIncarnation)) as { revision: number; ledger: string } | undefined
    if (!row) return undefined
    return { revision: Number(row.revision), ledger: ClusterSkillLedgerSchema.parse(JSON.parse(row.ledger)) }
  }

  async beginClusterSkillReconcile(
    input: ClusterSkillReconcileAuthority & { desiredHash: string; replayKey: string }
  ): Promise<
    | {
        ok: true
        operationId: string
        replayKey: string
        priorRevision: number
        priorLedger: ClusterSkillLedger
        resumed: boolean
      }
    | { ok: false; reason: 'lost_authority' }
  > {
    return await this.transaction(async (raw) => {
      const tx = accessOf(raw)
      const fence = (await tx
        .prepare('SELECT term, daemonId FROM duty_write_fence WHERE groupId = ?')
        .get(input.groupId)) as { term: string; daemonId: string } | undefined
      if (!fence || fence.term !== input.term || fence.daemonId !== input.daemonId) {
        return { ok: false, reason: 'lost_authority' as const }
      }
      const prior = (await tx
        .prepare('SELECT revision, ledger FROM cluster_skill_ledger WHERE agentId = ? AND workspaceIncarnation = ?')
        .get(input.agentId, input.workspaceIncarnation)) as { revision: number; ledger: string } | undefined
      const priorRevision = prior ? Number(prior.revision) : 0
      const priorLedger = prior ? ClusterSkillLedgerSchema.parse(JSON.parse(prior.ledger)) : { roots: [] }
      const existing = (await tx
        .prepare(
          `SELECT operationId, priorRevision, desiredHash, replayKey FROM cluster_skill_journal
           WHERE agentId = ? AND workspaceIncarnation = ? AND state = 'applying'`
        )
        .get(input.agentId, input.workspaceIncarnation)) as
        { operationId: string; priorRevision: number; desiredHash: string; replayKey: string | null } | undefined
      const resumed = Boolean(
        existing && Number(existing.priorRevision) === priorRevision && existing.desiredHash === input.desiredHash
      )
      const operationId = resumed ? existing!.operationId : input.operationId
      const replayKey = resumed && existing!.replayKey ? existing!.replayKey : input.replayKey
      await tx
        .prepare(
          `INSERT INTO cluster_skill_journal
             (agentId, workspaceIncarnation, operationId, groupId, term, daemonId, priorRevision, desiredHash, replayKey, state)
           VALUES (@agentId, @workspaceIncarnation, @operationId, @groupId, @term, @daemonId, @priorRevision, @desiredHash, @replayKey, 'applying')
           ON CONFLICT(agentId, workspaceIncarnation) DO UPDATE SET
             operationId = excluded.operationId, groupId = excluded.groupId, term = excluded.term,
             daemonId = excluded.daemonId, priorRevision = excluded.priorRevision,
             desiredHash = excluded.desiredHash, replayKey = excluded.replayKey,
             state = 'applying', resultLedger = NULL`
        )
        .run({ ...input, operationId, replayKey, priorRevision })
      return { ok: true, operationId, replayKey, priorRevision, priorLedger, resumed }
    })
  }

  async commitClusterSkillReconcile(
    input: ClusterSkillReconcileAuthority & { priorRevision: number; ledger: ClusterSkillLedger }
  ): Promise<{ ok: true; revision: number } | { ok: false; reason: 'lost_authority' }> {
    return await this.transaction(async (raw) => {
      const tx = accessOf(raw)
      const fence = (await tx
        .prepare('SELECT term, daemonId FROM duty_write_fence WHERE groupId = ?')
        .get(input.groupId)) as { term: string; daemonId: string } | undefined
      const journal = (await tx
        .prepare(
          `SELECT operationId, term, daemonId, priorRevision FROM cluster_skill_journal
           WHERE agentId = ? AND workspaceIncarnation = ? AND state = 'applying'`
        )
        .get(input.agentId, input.workspaceIncarnation)) as
        { operationId: string; term: string; daemonId: string; priorRevision: number } | undefined
      if (
        !fence ||
        fence.term !== input.term ||
        fence.daemonId !== input.daemonId ||
        !journal ||
        journal.operationId !== input.operationId ||
        journal.term !== input.term ||
        journal.daemonId !== input.daemonId ||
        Number(journal.priorRevision) !== input.priorRevision
      ) {
        return { ok: false, reason: 'lost_authority' as const }
      }
      const current = (await tx
        .prepare('SELECT revision FROM cluster_skill_ledger WHERE agentId = ? AND workspaceIncarnation = ?')
        .get(input.agentId, input.workspaceIncarnation)) as { revision: number } | undefined
      if ((current ? Number(current.revision) : 0) !== input.priorRevision) {
        return { ok: false, reason: 'lost_authority' as const }
      }
      const revision = input.priorRevision + 1
      const ledger = JSON.stringify(ClusterSkillLedgerSchema.parse(input.ledger))
      await tx
        .prepare(
          `INSERT INTO cluster_skill_ledger (agentId, workspaceIncarnation, revision, ledger)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(agentId, workspaceIncarnation) DO UPDATE SET revision = excluded.revision, ledger = excluded.ledger`
        )
        .run(input.agentId, input.workspaceIncarnation, revision, ledger)
      await tx
        .prepare(
          `UPDATE cluster_skill_journal SET state = 'applied', resultLedger = ?
           WHERE agentId = ? AND workspaceIncarnation = ? AND operationId = ?`
        )
        .run(ledger, input.agentId, input.workspaceIncarnation, input.operationId)
      return { ok: true, revision }
    })
  }

  async authorizeClusterSkillMutation(
    input: ClusterSkillReconcileAuthority & { priorRevision: number }
  ): Promise<boolean> {
    const row = (await this.db
      .prepare(
        `SELECT j.operationId, j.term, j.daemonId, j.priorRevision
         FROM cluster_skill_journal j
         JOIN duty_write_fence f ON f.groupId = j.groupId
         WHERE j.agentId = ? AND j.workspaceIncarnation = ? AND j.state = 'applying'
           AND f.term = j.term AND f.daemonId = j.daemonId`
      )
      .get(input.agentId, input.workspaceIncarnation)) as
      { operationId: string; term: string; daemonId: string; priorRevision: number } | undefined
    return Boolean(
      row &&
      row.operationId === input.operationId &&
      row.term === input.term &&
      row.daemonId === input.daemonId &&
      Number(row.priorRevision) === input.priorRevision
    )
  }

  async close(): Promise<void> {
    // Last chance for a buffered tool body: the backend is about to go away.
    await this.flushToolCallWrites()
    this.clearToolWriteFlush()
    // Closing under the mutex waits out a transcript write still in flight.
    await this.transcriptMutex.run(() => this.backend.close())
  }
}

interface RuntimeCatalogMetaRow {
  runtimeId: string
  fingerprint: string
  source: string
  defaultModel: string | null
  permissionModes: string | null
  defaultPermissionMode: string | null
  complete: number
  modelsHash: string | null
  observedAt: number
}

interface RuntimeModelCapRow {
  runtimeId: string
  modelId: string
  fingerprint: string
  capsJson: string
  observedAt: number
}

function runtimeCatalogMetaFromRow(row: RuntimeCatalogMetaRow): RuntimeCatalogMetaRecord {
  const permissionModes = parseJsonColumn<NonNullable<RuntimeCatalogMetaRecord['permissionModes']>>(row.permissionModes)
  return {
    runtimeId: row.runtimeId,
    fingerprint: row.fingerprint,
    source: row.source as RuntimeCatalogMetaRecord['source'],
    ...(row.defaultModel === null ? {} : { defaultModel: row.defaultModel }),
    ...(permissionModes === undefined ? {} : { permissionModes }),
    ...(row.defaultPermissionMode === null || row.defaultPermissionMode === undefined
      ? {}
      : { defaultPermissionMode: row.defaultPermissionMode }),
    complete: row.complete === 1,
    ...(row.modelsHash === null ? {} : { modelsHash: row.modelsHash }),
    observedAt: row.observedAt
  }
}

/** Parse store-written JSON, tolerating a corrupted row — hydrate runs at daemon boot
 *  and must degrade to "field unknown" rather than fail the whole startup. */
function parseJsonColumn<T>(raw: string | null): T | undefined {
  if (raw === null) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}
