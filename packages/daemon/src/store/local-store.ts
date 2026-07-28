import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { chmodSync, mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DreamInfo, SessionImageAttachment } from '@agentconnect.md/protocol'
import { SESSION_TITLE_TOOL_TITLES } from '../mcp/session-title-tool.js'

/** Per-tool-row rawInput budget in the mining prompt — enough for a command
 *  line or path, short enough that N tool rows can't crowd out the store. */
const DREAM_TOOL_INPUT_CHARS = 300

// node:sqlite binds named params as a generic Record and returns rows as
// Record<string, SQLOutputValue>; our row interfaces map by column name but have
// no index signature, so we widen at the DB boundary.
type SqlParams = Record<string, SQLInputValue>

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
function transcriptEventTimeUs(ts: string | null | undefined): number {
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
  acpSessionId: string | null
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
  // Slack-only chrome: the current in-thread status-bar message ts. One per session
  // so later turns edit the same status line instead of posting duplicates.
  statusBarTs?: string | null
  memoryProvider?: 'none' | 'native' | 'managed' | 'external' | null
  // session-concept §5.3: the origin (parent) session's stable acpSessionId, when this session
  // was spawned by another session's `sendMessage` (case 2a / A2A). DURABLE parent link (first-wins):
  // it authorizes this session's SessionTarget replies back to the parent on EVERY turn, not just
  // the waking one — a human-triggered follow-up turn carries no per-turn CallMeta. NULL for roots.
  originSessionId?: string | null
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
 * `tool`/`reasoning` are recorded for EVERY turn regardless of the agent's Slack
 * output mode — output mode only gates what reaches the platform, never the transcript.
 */
export type TranscriptKind = 'text' | 'tool' | 'reasoning'

export interface TranscriptEntry {
  channel: string
  thread: string
  // Platform message ts for `text`; a daemon wall-clock stamp for internal events
  // (`tool`/`reasoning`). Slack console history normalizes both forms onto eventTimeUs;
  // prompt replay still compares the original platform `ts`.
  ts: string
  sender: string
  kind: TranscriptKind
  text: string
  /** Bounded inline webchat images. Persisted daemon-side; never provider-backed files. */
  attachments?: SessionImageAttachment[]
  /** The agent this row was delivered TO (an inbound trigger / replayed context), when
   *  known. Absent for an agent's own output rows (those attribute via `sender`) and for
   *  unrouted messages. Lets the console session view show what one agent actually
   *  received + produced instead of the whole shared (channel, thread) thread. */
  recipient?: string
}

/** A transcript row as read back, including its insertion-order sequence. The
 *  `toolCallId`/`body` columns carry through raw (NULL on text/reasoning rows). */
export interface TranscriptRow extends TranscriptEntry {
  seq: number
  /** Monotonic mutation watermark; changes when a stable row is updated in place. */
  revision: number
  /** Normalized epoch microseconds used by chronological Slack history pagination. */
  eventTimeUs: number
  toolCallId?: string | null
  body?: string | null // JSON.stringify(ToolBody); NULL for text/reasoning rows
  attachmentsJson?: string | null // JSON.stringify(SessionImageAttachment[]); inline webchat only
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

export function sessionKey(platform: string, channel: string, thread: string, agentId: string): string {
  return `${platform}:${channel}:${thread}:${agentId}`
}

/** Internal transcript namespace. Platform-visible coordinates remain raw on the
 * session row and wire; only local transcript storage uses the physical-bot scope. */
export function transcriptChannelKey(channel: string, transportScope?: string | null): string {
  return transportScope ? `${channel}\u001f${transportScope}` : channel
}

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
  /** Connection generation on which a legacy (pre-ACK-capability) CP was sent
   * this report. A new connection uses a fresh generation and may resend. */
  legacyReportConnection?: string | null
  completedAt?: number | null
  isQueueCmd?: number | null
  /** 1 once this delivery no longer needs replay accounting (charged when applicable).
   *  Legacy rows migrate as 0 and are upgraded on their first successful admission. */
  loopGuardCounted?: number | null
  /** Monotonic decimal string — FIFO order within a sessionKey. */
  enqueuedAt: string
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
  /** Typed reason on a failed delivery (self/not_allowed/not_local/no_agent/offline). */
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

export class LocalStore {
  private db: DatabaseSync
  private transcriptRevision = 0
  private transcriptMutationListener?: (mutation: TranscriptMutation) => void

  constructor(dbPath: string) {
    // This database holds every platform message body, agent reply, tool payload and
    // durable inbox blob the daemon has seen — the same material the console serves
    // behind authorization. Every other secret-bearing artifact the daemon writes is
    // explicitly 0600/0700 (config.json, agent.json, materialized config-file secrets,
    // runtime homes, evaluation artifacts); this one inherited the umask, so on a host
    // where the root pre-exists group/other-readable — a container image `mkdir -p`, a
    // systemd `StateDirectory=` (0755), an operator-created path — a second local
    // account could read the lot. Restrict the directory and the database explicitly,
    // and chmod after creation so a loose umask cannot widen either.
    const dir = dirname(dbPath)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    restrictPath(dir, 0o700)
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    // WAL mode publishes two siblings alongside the database; they carry the same
    // rows, so restricting only the main file would leave the content readable.
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) restrictPath(p, 0o600)
    this.migrateTranscript()
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        key TEXT PRIMARY KEY, agentId TEXT, platform TEXT, channel TEXT, thread TEXT,
        transportScope TEXT, acpSessionId TEXT, state TEXT, lastDeliveredTs TEXT, updatedAt INTEGER,
        usage TEXT, muted INTEGER, triggeredBy TEXT, title TEXT, modelOverride TEXT,
        effortOverride TEXT, permissionModeOverride TEXT, fastModeOverride INTEGER,
        outputModeOverride TEXT, statusBarTs TEXT, memoryProvider TEXT
      );
      -- A !stop can arrive while a cold session is still materializing, before the
      -- sessions row exists. Keep the mute independently keyed so that stop survives a
      -- daemon restart and is applied when the session row is eventually created.
      CREATE TABLE IF NOT EXISTS session_mutes (
        key TEXT PRIMARY KEY
      );
      -- Platform id → human display name (Slack channel/user names, daemon-resolved
      -- and cached here so session read-back can label ids without a Slack call).
      CREATE TABLE IF NOT EXISTS display_names (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, updatedAt INTEGER
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
        resolvedAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS permission_requests_agent_created
        ON permission_requests (agentId, createdAt DESC);
      CREATE TABLE IF NOT EXISTS transcript (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL, thread TEXT NOT NULL, ts TEXT,
        sender TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
        tool_call_id TEXT, body TEXT, recipient TEXT, eventTimeUs INTEGER,
        attachmentsJson TEXT, revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS transcript_thread_seq ON transcript (channel, thread, seq);
      -- Dedup conversational rows by platform ts (double-fired inbound / redelivery);
      -- internal events have no platform ts and are intentionally never deduped here.
      CREATE UNIQUE INDEX IF NOT EXISTS transcript_text_ts
        ON transcript (channel, thread, ts) WHERE kind = 'text';
      -- Per-agent DELIVERY of a shared thread message. The transcript row itself is deduped
      -- by (channel, thread, ts), so the recipient column only records the FIRST agent a
      -- message reached; when several agents on one daemon each catch up on the same message
      -- their deliveries are recorded here so no agent's scoped session view (transcriptPage-
      -- ForAgent) hides a message it actually received.
      CREATE TABLE IF NOT EXISTS transcript_recipient (
        channel TEXT NOT NULL, thread TEXT NOT NULL, ts TEXT NOT NULL, agentId TEXT NOT NULL,
        PRIMARY KEY (channel, thread, ts, agentId)
      );
      -- transcript_agent_tool_call (partial unique on tool_call_id) is created in
      -- migrateTranscriptToolBody, after the column is guaranteed to exist — a legacy
      -- rebuild in migrateTranscript recreates the table without the new columns.
      CREATE TABLE IF NOT EXISTS cp_routing (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        routingEpoch INTEGER, assignments TEXT, globalRules TEXT
      );
      -- Authoritative last-run per cron (protocol §5.4 — missed-fire compensation).
      -- key = "<agentId>:<cronId>" (cron defs themselves live in agent.json).
      CREATE TABLE IF NOT EXISTS cron_runs (
        key TEXT PRIMARY KEY, lastRunAt INTEGER NOT NULL
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
        legacyReportConnection TEXT,
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
      CREATE TABLE IF NOT EXISTS runtime_catalog_meta (
        runtimeId TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        source TEXT NOT NULL,             -- 'native' | 'acp'
        defaultModel TEXT,
        permissionModes TEXT,             -- JSON [{value, name?}]
        defaultPermissionMode TEXT,       -- mode select currentValue on a fresh probe session
        complete INTEGER NOT NULL DEFAULT 0,
        modelsHash TEXT,                  -- hash of probed models[] at last complete discovery
        observedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_model_catalog (
        runtimeId TEXT NOT NULL,
        modelId TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        capsJson TEXT NOT NULL,           -- JSON {name?, efforts?: [{value,name?,description?}], defaultEffort?, fastMode?}
        observedAt INTEGER NOT NULL,
        PRIMARY KEY (runtimeId, modelId)
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
        usage TEXT,                       -- JSON DreamUsage (tokens/cost + bounded byte counts)
        error TEXT,                       -- JSON {type, message}
        createdAt TEXT NOT NULL,
        endedAt TEXT
      );
      CREATE INDEX IF NOT EXISTS dreams_agent_created ON dreams (agentId, createdAt DESC);
    `)
    this.migrateDreamSnapshotWrites()
    this.migrateDreamSupersededStatus()
    this.migrateDreamObservability()
    this.migrateSessionUsage()
    this.migrateSessionMutes()
    this.migrateInboxLoopGuardCounted()
    this.migrateTranscriptToolBody()
    this.migrateTranscriptAttachments()
    this.migrateTranscriptRecipient()
    this.migrateTranscriptEventTime()
    this.migrateTranscriptRevision()
    this.migrateInboxHookContext()
    this.migrateRuntimeCatalogDefaultMode()
    // A daemon restart loses the in-memory ACP resolver. Retain the audit row but
    // never present it as actionable after recovery.
    this.db
      .prepare(
        "UPDATE permission_requests SET status = 'expired', resolvedAt = COALESCE(resolvedAt, ?) WHERE status = 'pending'"
      )
      .run(Date.now())
  }

  /** Add the `transcript.recipient` column (the agent a row was delivered to) to a
   *  pre-existing DB. Legacy rows have NULL recipient, so they surface in a session view
   *  only via `sender` — acceptable (pre-migration history predates per-agent scoping). */
  private migrateTranscriptRecipient(): void {
    const cols = this.db.prepare('PRAGMA table_info(transcript)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'recipient')) this.db.exec('ALTER TABLE transcript ADD COLUMN recipient TEXT')
  }

  /**
   * Add and backfill the chronological history key introduced after `seq`. This is an
   * in-place local-store migration: old sessions retain their original rows/ts and start
   * rendering chronologically as soon as the upgraded daemon opens the DB.
   */
  private migrateTranscriptEventTime(): void {
    const cols = this.db.prepare('PRAGMA table_info(transcript)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'eventTimeUs'))
      this.db.exec('ALTER TABLE transcript ADD COLUMN eventTimeUs INTEGER')

    const nextBatch = this.db.prepare(
      'SELECT seq, ts FROM transcript WHERE seq > ? AND eventTimeUs IS NULL ORDER BY seq ASC LIMIT 1000'
    )
    const update = this.db.prepare('UPDATE transcript SET eventTimeUs = ? WHERE seq = ?')
    this.db.exec('BEGIN')
    try {
      let afterSeq = 0
      while (true) {
        // Bound migration memory for long-lived daemons while retaining one atomic
        // transaction. The PK cursor avoids rescanning already-visited rows.
        const rows = nextBatch.all(afterSeq) as unknown as { seq: number; ts: string | null }[]
        if (rows.length === 0) break
        for (const row of rows) update.run(transcriptEventTimeUs(row.ts), row.seq)
        afterSeq = rows[rows.length - 1]!.seq
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS transcript_thread_event_time ON transcript (channel, thread, eventTimeUs DESC, seq DESC)'
    )
  }

  /** Stable-row updates need a cursor independent of insertion-order `seq`. */
  private migrateTranscriptRevision(): void {
    const cols = this.db.prepare('PRAGMA table_info(transcript)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'revision'))
      this.db.exec('ALTER TABLE transcript ADD COLUMN revision INTEGER NOT NULL DEFAULT 0')
    this.db.exec(`
      UPDATE transcript SET revision = seq WHERE revision = 0;
      CREATE INDEX IF NOT EXISTS transcript_thread_revision
        ON transcript (channel, thread, revision);
    `)
    const row = this.db.prepare('SELECT COALESCE(MAX(revision), 0) AS revision FROM transcript').get() as {
      revision: number
    }
    this.transcriptRevision = row.revision
  }

  /** R1 hook turns must retain their trusted dispatch fence and the poster's
   * single-attempt state across restart. Upgrade existing local stores in place. */
  private migrateInboxHookContext(): void {
    const cols = this.db.prepare('PRAGMA table_info(inbox)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'hookContext')) this.db.exec('ALTER TABLE inbox ADD COLUMN hookContext TEXT')
    if (!cols.some((c) => c.name === 'posterPublishState'))
      this.db.exec('ALTER TABLE inbox ADD COLUMN posterPublishState TEXT')
    if (!cols.some((c) => c.name === 'terminalReport')) this.db.exec('ALTER TABLE inbox ADD COLUMN terminalReport TEXT')
    if (!cols.some((c) => c.name === 'legacyReportConnection'))
      this.db.exec('ALTER TABLE inbox ADD COLUMN legacyReportConnection TEXT')
    if (!cols.some((c) => c.name === 'completedAt')) this.db.exec('ALTER TABLE inbox ADD COLUMN completedAt INTEGER')
  }

  /** Backfill the durable mute tombstones from the legacy sessions.muted column.
   *  Both writes in setSessionMuted stay transactional, so this idempotent sync cannot
   *  resurrect a mute that was explicitly cleared. */
  /** Dreams created before the distillation rebase existed carry no write-ledger
   *  marks. NULL is the fail-closed value: such a dream simply can't be rebased
   *  and falls back to the plain fence. */
  private migrateDreamSnapshotWrites(): void {
    const cols = this.db.prepare('PRAGMA table_info(dreams)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'snapshotWrites'))
      this.db.exec('ALTER TABLE dreams ADD COLUMN snapshotWrites TEXT')
  }

  /** Add metadata-only correlation and execution fields without rewriting
   *  existing dream rows. Usage remains JSON for rolling schema compatibility. */
  private migrateDreamObservability(): void {
    const cols = this.db.prepare('PRAGMA table_info(dreams)').all() as { name: string }[]
    const names = new Set(cols.map((column) => column.name))
    if (!names.has('executionSessionId')) this.db.exec('ALTER TABLE dreams ADD COLUMN executionSessionId TEXT')
    if (!names.has('runtime')) this.db.exec('ALTER TABLE dreams ADD COLUMN runtime TEXT')
    if (!names.has('model')) this.db.exec('ALTER TABLE dreams ADD COLUMN model TEXT')
    if (!names.has('stopReason')) this.db.exec('ALTER TABLE dreams ADD COLUMN stopReason TEXT')
  }

  /** Extend the dream lifecycle without stranding proposals created before the
   *  state existed. SQLite cannot alter a CHECK constraint in place, so rebuild
   *  this metadata-only table and reconcile every completed proposal that
   *  predates a successful adoption for the same agent. */
  private migrateDreamSupersededStatus(): void {
    const table = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'dreams'").get() as
      { sql: string } | undefined
    if (!table || table.sql.includes("'superseded'")) return

    this.db.exec('BEGIN')
    try {
      this.db.exec(`
        ALTER TABLE dreams RENAME TO dreams_before_superseded;
        CREATE TABLE dreams (
          dreamId TEXT PRIMARY KEY,
          agentId TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN
            ('pending', 'running', 'completed', 'failed', 'canceled', 'adopted', 'discarded', 'superseded')),
          triggerKind TEXT NOT NULL,
          sessionIds TEXT NOT NULL,
          snapshotDigest TEXT NOT NULL,
          snapshotWrites TEXT,
          instructions TEXT,
          skills TEXT,
          usage TEXT,
          error TEXT,
          createdAt TEXT NOT NULL,
          endedAt TEXT
        );
        INSERT INTO dreams (
          dreamId, agentId, status, triggerKind, sessionIds, snapshotDigest,
          snapshotWrites, instructions, skills, usage, error, createdAt, endedAt
        ) SELECT
          dreamId, agentId, status, triggerKind, sessionIds, snapshotDigest,
          snapshotWrites, instructions, skills, usage, error, createdAt, endedAt
        FROM dreams_before_superseded;
        DROP TABLE dreams_before_superseded;
        CREATE INDEX dreams_agent_created ON dreams (agentId, createdAt DESC);

        UPDATE dreams AS candidate
        SET status = 'superseded', endedAt = (
          SELECT MIN(adopted.endedAt)
          FROM dreams AS adopted
          WHERE adopted.agentId = candidate.agentId
            AND adopted.status = 'adopted'
            AND adopted.endedAt IS NOT NULL
            AND adopted.endedAt > candidate.createdAt
        )
        WHERE candidate.status = 'completed'
          AND EXISTS (
            SELECT 1
            FROM dreams AS adopted
            WHERE adopted.agentId = candidate.agentId
              AND adopted.status = 'adopted'
              AND adopted.endedAt IS NOT NULL
              AND adopted.endedAt > candidate.createdAt
          );
      `)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  private migrateSessionMutes(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_mutes (key TEXT PRIMARY KEY);
      INSERT OR IGNORE INTO session_mutes (key) SELECT key FROM sessions WHERE muted = 1;
      UPDATE sessions SET muted = 1 WHERE key IN (SELECT key FROM session_mutes);
    `)
  }

  /** Rows written before loop protection had no per-delivery accounting marker. They
   *  start at 0 so the first owner that can replay them charges them exactly once. */
  private migrateInboxLoopGuardCounted(): void {
    const cols = this.db.prepare('PRAGMA table_info(inbox)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'loopGuardCounted'))
      this.db.exec('ALTER TABLE inbox ADD COLUMN loopGuardCounted INTEGER NOT NULL DEFAULT 0')
    else this.db.exec('UPDATE inbox SET loopGuardCounted = 0 WHERE loopGuardCounted IS NULL')
  }

  /** Add the `transcript.tool_call_id` + `transcript.body` columns and agent-scoped
   *  partial unique index to a pre-existing DB. ACP tool ids are session-local, so
   *  same-thread agents may legitimately reuse them. */
  private migrateTranscriptToolBody(): void {
    const cols = this.db.prepare('PRAGMA table_info(transcript)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'tool_call_id'))
      this.db.exec('ALTER TABLE transcript ADD COLUMN tool_call_id TEXT')
    if (!cols.some((c) => c.name === 'body')) this.db.exec('ALTER TABLE transcript ADD COLUMN body TEXT')
    this.db.exec(`
      DROP INDEX IF EXISTS transcript_tool_call;
      CREATE UNIQUE INDEX IF NOT EXISTS transcript_agent_tool_call
        ON transcript (channel, thread, sender, tool_call_id) WHERE tool_call_id IS NOT NULL;
    `)
  }

  /** Add daemon-local inline webchat image storage to existing transcript tables. */
  private migrateTranscriptAttachments(): void {
    const cols = this.db.prepare('PRAGMA table_info(transcript)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'attachmentsJson'))
      this.db.exec('ALTER TABLE transcript ADD COLUMN attachmentsJson TEXT')
  }

  /** Add the defaultPermissionMode column to runtime_catalog_meta for DBs that
   *  created the table before it existed (CREATE TABLE IF NOT EXISTS never alters).
   *  No-op once present. */
  private migrateRuntimeCatalogDefaultMode(): void {
    const cols = this.db.prepare('PRAGMA table_info(runtime_catalog_meta)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'defaultPermissionMode')) {
      this.db.exec('ALTER TABLE runtime_catalog_meta ADD COLUMN defaultPermissionMode TEXT')
    }
  }

  /** Add session columns introduced after the initial schema: usage JSON, mute/title,
   *  sticky runtime controls, and Slack chrome pointers. CREATE TABLE IF NOT EXISTS
   *  above adds them for fresh DBs but never alters an existing table, so upgrade in
   *  place. No-op once the columns are present. */
  private migrateSessionUsage(): void {
    const cols = this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'usage')) this.db.exec('ALTER TABLE sessions ADD COLUMN usage TEXT')
    if (!cols.some((c) => c.name === 'muted')) this.db.exec('ALTER TABLE sessions ADD COLUMN muted INTEGER')
    if (!cols.some((c) => c.name === 'triggeredBy')) this.db.exec('ALTER TABLE sessions ADD COLUMN triggeredBy TEXT')
    if (!cols.some((c) => c.name === 'title')) this.db.exec('ALTER TABLE sessions ADD COLUMN title TEXT')
    if (!cols.some((c) => c.name === 'modelOverride'))
      this.db.exec('ALTER TABLE sessions ADD COLUMN modelOverride TEXT')
    if (!cols.some((c) => c.name === 'effortOverride'))
      this.db.exec('ALTER TABLE sessions ADD COLUMN effortOverride TEXT')
    if (!cols.some((c) => c.name === 'permissionModeOverride'))
      this.db.exec('ALTER TABLE sessions ADD COLUMN permissionModeOverride TEXT')
    if (!cols.some((c) => c.name === 'fastModeOverride'))
      this.db.exec('ALTER TABLE sessions ADD COLUMN fastModeOverride INTEGER')
    if (!cols.some((c) => c.name === 'outputModeOverride'))
      this.db.exec('ALTER TABLE sessions ADD COLUMN outputModeOverride TEXT')
    if (!cols.some((c) => c.name === 'statusBarTs')) this.db.exec('ALTER TABLE sessions ADD COLUMN statusBarTs TEXT')
    if (!cols.some((c) => c.name === 'memoryProvider'))
      this.db.exec('ALTER TABLE sessions ADD COLUMN memoryProvider TEXT')
    if (!cols.some((c) => c.name === 'originSessionId'))
      this.db.exec('ALTER TABLE sessions ADD COLUMN originSessionId TEXT')
    if (!cols.some((c) => c.name === 'transportScope'))
      this.db.exec('ALTER TABLE sessions ADD COLUMN transportScope TEXT')
  }

  /**
   * Pre-`kind` transcript tables keyed on (channel, thread, ts) hold only conversational
   * text. Rebuild them onto the `seq`/`kind` schema, tagging legacy rows `text`. No-op on
   * a fresh DB (CREATE handles it) or an already-migrated one.
   */
  private migrateTranscript(): void {
    const cols = this.db.prepare('PRAGMA table_info(transcript)').all() as { name: string }[]
    if (cols.length === 0 || cols.some((c) => c.name === 'kind')) return
    this.db.exec(`
      ALTER TABLE transcript RENAME TO transcript_legacy;
      CREATE TABLE transcript (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL, thread TEXT NOT NULL, ts TEXT,
        sender TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL
      );
      INSERT INTO transcript (channel, thread, ts, sender, kind, text)
        SELECT channel, thread, ts, sender, 'text', text FROM transcript_legacy ORDER BY ts ASC;
      DROP TABLE transcript_legacy;
    `)
  }

  getSession(key: string): SessionRecord | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE key = ?').get(key) as SessionRecord | undefined
  }

  createPermissionRequest(record: PermissionRequestRecord): void {
    this.db
      .prepare(
        `INSERT INTO permission_requests
           (id, agentId, sessionId, createdAt, requesterId, requesterName, command, status, resolvedAt)
         VALUES
           (@id, @agentId, @sessionId, @createdAt, @requesterId, @requesterName, @command, @status, @resolvedAt)`
      )
      .run(record as unknown as SqlParams)
    this.prunePermissionRequestHistory(record.agentId)
  }

  private prunePermissionRequestHistory(agentId: string): void {
    // Keep all live resolvers addressable; cap only terminal history. A burst of
    // concurrent requests must never disappear from the editor surface while the
    // corresponding ACP promise is still waiting.
    this.db
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

  listPermissionRequests(agentId: string, limit = 50): PermissionRequestRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM permission_requests
         WHERE agentId = ?
         ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, createdAt DESC
         LIMIT ?`
      )
      .all(agentId, Math.max(1, Math.min(100, limit))) as unknown as PermissionRequestRecord[]
  }

  resolvePermissionRequest(
    agentId: string,
    id: string,
    status: Exclude<PermissionRequestStatus, 'pending'>,
    resolvedAt: number
  ): boolean {
    const result = this.db
      .prepare(
        "UPDATE permission_requests SET status = ?, resolvedAt = ? WHERE agentId = ? AND id = ? AND status = 'pending'"
      )
      .run(status, resolvedAt, agentId, id)
    const changed = Number(result.changes) === 1
    if (changed) this.prunePermissionRequestHistory(agentId)
    return changed
  }

  /** All sessions that have an ACP id (i.e. are addressable by sessionId), newest
   *  first. Optionally scoped to one agent. Backs `session/list` read-back — the
   *  `usage` column comes back as raw JSON (parsed by the reader). */
  listSessions(agentId?: string): SessionListRow[] {
    if (agentId !== undefined) {
      return this.db
        .prepare('SELECT * FROM sessions WHERE acpSessionId IS NOT NULL AND agentId = ? ORDER BY updatedAt DESC')
        .all(agentId) as unknown as SessionListRow[]
    }
    return this.db
      .prepare('SELECT * FROM sessions WHERE acpSessionId IS NOT NULL ORDER BY updatedAt DESC')
      .all() as unknown as SessionListRow[]
  }

  /** Distinct conversation targets this agent has been triggered in on a platform,
   *  newest first, joined to their cached display name. Backs the `listChannels`
   *  fallback for platforms whose bot API can't enumerate chats (Telegram): the
   *  observed session history IS the reachable set. */
  observedChannels(agentId: string, platform: string): { id: string; name?: string }[] {
    return this.db
      .prepare(
        `SELECT s.channel AS id, d.name AS name
         FROM (SELECT channel, MAX(updatedAt) AS updatedAt FROM sessions
               WHERE agentId = ? AND platform = ? AND channel IS NOT NULL AND channel <> ''
               GROUP BY channel) s
         LEFT JOIN display_names d ON d.id = s.channel
         ORDER BY s.updatedAt DESC`
      )
      .all(agentId, platform) as { id: string; name?: string }[]
  }

  /** Distinct users this agent has been triggered by on a platform, newest first,
   *  joined to their cached display name (present for Slack ids and Telegram DM
   *  chats where chat id == user id; group senders are id-only). Backs `listKnownUsers`
   *  so an agent can find a user id to DM on a platform with no user directory. */
  observedUsers(agentId: string, platform: string): { id: string; name?: string }[] {
    return this.db
      .prepare(
        `SELECT s.triggeredBy AS id, d.name AS name
         FROM (SELECT triggeredBy, MAX(updatedAt) AS updatedAt FROM sessions
               WHERE agentId = ? AND platform = ? AND triggeredBy IS NOT NULL AND triggeredBy <> ''
               GROUP BY triggeredBy) s
         LEFT JOIN display_names d ON d.id = s.triggeredBy
         ORDER BY s.updatedAt DESC`
      )
      .all(agentId, platform) as { id: string; name?: string }[]
  }

  /** The most recently active addressable session (has an ACP id) for an agent in a
   *  channel, or undefined. Backs `/status` when the command message itself doesn't fall
   *  in a session's thread (a bare Telegram `/status` keys to its own reply thread) — we
   *  then report the channel's latest session rather than "nothing here". */
  latestSession(agentId: string, channel: string): SessionRecord | undefined {
    return this.db
      .prepare(
        'SELECT * FROM sessions WHERE agentId = ? AND channel = ? AND acpSessionId IS NOT NULL ORDER BY updatedAt DESC LIMIT 1'
      )
      .get(agentId, channel) as SessionRecord | undefined
  }

  /** Latest addressable session for one physical platform bot. The explicit
   * transport scope prevents equal Telegram chat ids on different bots from
   * stealing command/callback targeting from one another. */
  latestSessionForTransport(
    agentId: string,
    channel: string,
    transportScope?: string,
    thread?: string
  ): SessionRecord | undefined {
    const args: SQLInputValue[] = [agentId, channel, transportScope ?? '']
    const threadClause = thread === undefined ? '' : ' AND thread = ?'
    if (thread !== undefined) args.push(thread)
    return this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE agentId = ? AND channel = ? AND COALESCE(transportScope, '') = ?
           AND acpSessionId IS NOT NULL${threadClause}
         ORDER BY updatedAt DESC LIMIT 1`
      )
      .get(...args) as SessionRecord | undefined
  }

  /** The most recently active addressable session (has an ACP id) in a channel, across
   *  ALL agents — or undefined. Used to resolve which agent a bare command targets when
   *  routing can't (e.g. a group `/status@bot` with no mention entity / thread). */
  latestSessionInChannel(channel: string): SessionRecord | undefined {
    return this.db
      .prepare('SELECT * FROM sessions WHERE channel = ? AND acpSessionId IS NOT NULL ORDER BY updatedAt DESC LIMIT 1')
      .get(channel) as SessionRecord | undefined
  }

  /** Lookup by ACP session id (the protocol-facing `sessionId`), or undefined. */
  getSessionByAcpId(acpSessionId: string): SessionRecord | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE acpSessionId = ?').get(acpSessionId) as
      SessionRecord | undefined
  }

  /** Agent-scoped ACP id lookup for callbacks from one runtime process. ACP ids
   *  are runtime-owned and need not be globally unique across agents. */
  getSessionByAcpIdForAgent(agentId: string, acpSessionId: string): SessionRecord | undefined {
    return this.db
      .prepare('SELECT * FROM sessions WHERE agentId = ? AND acpSessionId = ?')
      .get(agentId, acpSessionId) as SessionRecord | undefined
  }

  /** Addressable session ids whose authorized transcript scope may have changed. */
  sessionIdsForTranscript(agentId: string, channel: string, thread: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT acpSessionId, channel, transportScope FROM sessions
         WHERE agentId = ? AND thread = ? AND acpSessionId IS NOT NULL`
      )
      .all(agentId, thread) as { acpSessionId: string; channel: string; transportScope: string | null }[]
    return rows
      .filter((row) => transcriptChannelKey(row.channel, row.transportScope) === channel)
      .map((row) => row.acpSessionId)
  }

  currentTranscriptRevision(): number {
    return this.transcriptRevision
  }

  setTranscriptMutationListener(listener?: (mutation: TranscriptMutation) => void): void {
    this.transcriptMutationListener = listener
  }

  /**
   * One newest-first page of a thread's user-visible transcript, for `session/history`.
   * Daemon housekeeping is excluded at read time as well as write time so rows stored
   * by an older daemon disappear after upgrade. Pages backward via `beforeSeq` (the
   * lowest seq already seen; null ⇒ newest page). Over-fetches one row to detect
   * `hasMore` without a second query. Rows stay seq DESC.
   */
  transcriptPage(
    channel: string,
    thread: string,
    beforeSeq: number | null,
    limit: number
  ): { rows: TranscriptRow[]; hasMore: boolean } {
    const hiddenToolTitles = [...SESSION_TITLE_TOOL_TITLES]
    const rows = (beforeSeq !== null
      ? this.db
          .prepare(
            `SELECT * FROM transcript
             WHERE channel = ? AND thread = ? AND seq < ?
               AND NOT (kind = 'tool' AND text IN (?, ?))
             ORDER BY seq DESC LIMIT ?`
          )
          .all(channel, thread, beforeSeq, ...hiddenToolTitles, limit + 1)
      : this.db
          .prepare(
            `SELECT * FROM transcript
             WHERE channel = ? AND thread = ?
               AND NOT (kind = 'tool' AND text IN (?, ?))
             ORDER BY seq DESC LIMIT ?`
          )
          .all(channel, thread, ...hiddenToolTitles, limit + 1)) as unknown as TranscriptRow[]
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
  transcriptPageForAgent(
    channel: string,
    thread: string,
    agentId: string,
    beforeSeq: number | null,
    limit: number
  ): { rows: TranscriptRow[]; hasMore: boolean } {
    // The delivery-table match is keyed by (channel, thread, ts), but internal rows
    // (reasoning/tool) are NOT deduped by ts and can share a ts with a delivered text row —
    // so gate the delivery match on `kind = 'text'`, else a peer's reasoning/tool row at the
    // same ts would be pulled back in. Deliveries only ever concern conversational messages;
    // own internal rows still surface via `sender`.
    const scope = `(sender = ? OR recipient = ? OR (transcript.kind = 'text' AND EXISTS (
        SELECT 1 FROM transcript_recipient tr
        WHERE tr.channel = transcript.channel AND tr.thread = transcript.thread
          AND tr.ts = transcript.ts AND tr.agentId = ?)))`
    const hiddenToolTitles = [...SESSION_TITLE_TOOL_TITLES]
    const rows = (beforeSeq !== null
      ? this.db
          .prepare(
            `SELECT * FROM transcript WHERE channel = ? AND thread = ? AND seq < ?
               AND ${scope}
               AND NOT (kind = 'tool' AND text IN (?, ?))
             ORDER BY seq DESC LIMIT ?`
          )
          .all(channel, thread, beforeSeq, agentId, agentId, agentId, ...hiddenToolTitles, limit + 1)
      : this.db
          .prepare(
            `SELECT * FROM transcript WHERE channel = ? AND thread = ?
               AND ${scope}
               AND NOT (kind = 'tool' AND text IN (?, ?))
             ORDER BY seq DESC LIMIT ?`
          )
          .all(
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
  transcriptPageForAgentByEventTime(
    channel: string,
    thread: string,
    agentId: string,
    before: TranscriptEventCursor | null,
    limit: number
  ): { rows: TranscriptRow[]; hasMore: boolean } {
    const scope = `(sender = ? OR recipient = ? OR (transcript.kind = 'text' AND EXISTS (
        SELECT 1 FROM transcript_recipient tr
        WHERE tr.channel = transcript.channel AND tr.thread = transcript.thread
          AND tr.ts = transcript.ts AND tr.agentId = ?)))`
    const hiddenToolTitles = [...SESSION_TITLE_TOOL_TITLES]
    const rows = (before !== null
      ? this.db
          .prepare(
            `SELECT * FROM transcript WHERE channel = ? AND thread = ?
               AND (eventTimeUs < ? OR (eventTimeUs = ? AND seq < ?))
               AND ${scope}
               AND NOT (kind = 'tool' AND text IN (?, ?))
             ORDER BY eventTimeUs DESC, seq DESC LIMIT ?`
          )
          .all(
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
      : this.db
          .prepare(
            `SELECT * FROM transcript WHERE channel = ? AND thread = ?
               AND ${scope}
               AND NOT (kind = 'tool' AND text IN (?, ?))
             ORDER BY eventTimeUs DESC, seq DESC LIMIT ?`
          )
          .all(
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
  transcriptTailForAgent(
    channel: string,
    thread: string,
    agentId: string,
    afterRevision: number,
    limit: number
  ): { rows: TranscriptRow[]; hasMore: boolean; cursor: number } {
    const scope = `(sender = ? OR recipient = ? OR (transcript.kind = 'text' AND EXISTS (
        SELECT 1 FROM transcript_recipient tr
        WHERE tr.channel = transcript.channel AND tr.thread = transcript.thread
          AND tr.ts = transcript.ts AND tr.agentId = ?)))`
    const rows = this.db
      .prepare(
        `SELECT * FROM transcript
         WHERE channel = ? AND thread = ? AND revision > ?
           AND ${scope}
           AND NOT (kind = 'tool' AND text IN (?, ?))
         ORDER BY revision ASC LIMIT ?`
      )
      .all(
        channel,
        thread,
        afterRevision,
        agentId,
        agentId,
        agentId,
        ...SESSION_TITLE_TOOL_TITLES,
        limit + 1
      ) as unknown as TranscriptRow[]
    const hasMore = rows.length > limit
    const kept = hasMore ? rows.slice(0, limit) : rows
    return {
      rows: kept,
      hasMore,
      cursor: hasMore ? kept[kept.length - 1]!.revision : this.transcriptRevision
    }
  }

  upsertSession(rec: SessionRecord): void {
    // Bind only the mutable session columns explicitly. `rec` may be a row read back
    // via `SELECT *` (e.g. from getSession/listSessions), which now also carries the
    // `usage` and `muted` columns — passing the whole object would trip node:sqlite's
    // unknown-named-parameter check. `usage` is intentionally not touched; `muted`
    // is only promoted from the durable tombstone and never cleared by a state upsert.
    // `triggeredBy` is first-wins: the sender that created the session keeps the
    // credit across later upserts.
    this.db
      .prepare(
        `INSERT INTO sessions
           (key, agentId, platform, channel, thread, transportScope, acpSessionId, state, lastDeliveredTs, updatedAt, muted, triggeredBy, memoryProvider, originSessionId)
         VALUES
           (@key, @agentId, @platform, @channel, @thread, @transportScope, @acpSessionId, @state, @lastDeliveredTs, @updatedAt,
            CASE WHEN EXISTS (SELECT 1 FROM session_mutes WHERE key = @key) THEN 1 ELSE NULL END,
            @triggeredBy, @memoryProvider, @originSessionId)
         ON CONFLICT(key) DO UPDATE SET
           acpSessionId=excluded.acpSessionId, state=excluded.state,
           lastDeliveredTs=excluded.lastDeliveredTs, updatedAt=excluded.updatedAt,
           transportScope=excluded.transportScope,
           muted=CASE
             WHEN EXISTS (SELECT 1 FROM session_mutes WHERE key = excluded.key) THEN 1
             ELSE sessions.muted
           END,
           triggeredBy=COALESCE(sessions.triggeredBy, excluded.triggeredBy),
           memoryProvider=excluded.memoryProvider,
           -- Parent link is first-wins: set once when the session is spawned, never cleared by a
           -- later (human-triggered) turn that carries no origin.
           originSessionId=COALESCE(sessions.originSessionId, excluded.originSessionId)`
      )
      .run({
        key: rec.key,
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
        memoryProvider: rec.memoryProvider ?? null,
        originSessionId: rec.originSessionId ?? null
      })
  }

  /** Targeted state transition for an existing session (§7.3), stamping `updatedAt`
   *  so the change counts as activity for the TTL/idle clocks. No-op if the key is
   *  unknown (the row is created by the SessionManager on first turn). */
  setSessionState(key: string, state: SessionRecord['state'], updatedAt: number): void {
    this.db.prepare('UPDATE sessions SET state = ?, updatedAt = ? WHERE key = ?').run(state, updatedAt, key)
  }

  /** `!stop` thread mute: the tombstone is written even before a session row exists,
   *  then mirrored into sessions.muted for existing readers. An explicit @mention
   *  clears both atomically. */
  setSessionMuted(key: string, muted: boolean): void {
    this.db.exec('BEGIN')
    try {
      if (muted) this.db.prepare('INSERT OR IGNORE INTO session_mutes (key) VALUES (?)').run(key)
      else this.db.prepare('DELETE FROM session_mutes WHERE key = ?').run(key)
      this.db.prepare('UPDATE sessions SET muted = ? WHERE key = ?').run(muted ? 1 : 0, key)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  /** Human-facing session title from ingress, ACP, or the AgentConnect title
   *  tool (latest wins; null clears per ACP semantics). No-op on an unknown key. */
  setSessionTitle(key: string, title: string | null): void {
    this.db.prepare('UPDATE sessions SET title = ? WHERE key = ?').run(title, key)
  }

  /** Slack status-bar message ts for this session, if one has been posted already. */
  getStatusBarTs(key: string): string | undefined {
    const row = this.db.prepare('SELECT statusBarTs FROM sessions WHERE key = ?').get(key) as
      { statusBarTs: string | null } | undefined
    return row?.statusBarTs ?? undefined
  }

  /** Remember the current Slack status-bar message so later turns edit it in place. */
  setStatusBarTs(key: string, ts: string): void {
    this.db.prepare('UPDATE sessions SET statusBarTs = ? WHERE key = ?').run(ts, key)
  }

  isSessionMuted(key: string): boolean {
    const row = this.db
      .prepare(
        `SELECT CASE
           WHEN EXISTS (SELECT 1 FROM session_mutes WHERE key = ?)
             OR EXISTS (SELECT 1 FROM sessions WHERE key = ? AND muted = 1)
           THEN 1 ELSE 0
         END AS muted`
      )
      .get(key, key) as { muted: number }
    return row.muted === 1
  }

  /** The session-scoped model override (set via the console's in-session model switch),
   *  or undefined if the session runs on the agent's default. Sticky across turns and
   *  restarts, re-applied to the ACP session on each dispatch. */
  getModelOverride(key: string): string | undefined {
    const row = this.db.prepare('SELECT modelOverride FROM sessions WHERE key = ?').get(key) as
      { modelOverride: string | null } | undefined
    return row?.modelOverride ?? undefined
  }

  /** Persist the session-scoped model override. No-op on an unknown key. */
  setModelOverride(key: string, model: string): void {
    this.db.prepare('UPDATE sessions SET modelOverride = ? WHERE key = ?').run(model, key)
  }

  /** The session-scoped reasoning-effort override (set via the status-bar effort picker),
   *  or undefined if the session runs on the agent's default. Sticky across turns and
   *  restarts, re-applied to the ACP session on each dispatch. */
  getEffortOverride(key: string): string | undefined {
    const row = this.db.prepare('SELECT effortOverride FROM sessions WHERE key = ?').get(key) as
      { effortOverride: string | null } | undefined
    return row?.effortOverride ?? undefined
  }

  /** Persist the session-scoped reasoning-effort override. No-op on an unknown key. */
  setEffortOverride(key: string, effort: string): void {
    this.db.prepare('UPDATE sessions SET effortOverride = ? WHERE key = ?').run(effort, key)
  }

  /** The session-scoped permission-mode override (set via status bars), or undefined if
   *  the session runs on the agent's default. Sticky across turns and restarts. */
  getPermissionModeOverride(key: string): string | undefined {
    const row = this.db.prepare('SELECT permissionModeOverride FROM sessions WHERE key = ?').get(key) as
      { permissionModeOverride: string | null } | undefined
    return row?.permissionModeOverride ?? undefined
  }

  /** Persist the session-scoped permission-mode override. No-op on an unknown key. */
  setPermissionModeOverride(key: string, mode: string): void {
    this.db.prepare('UPDATE sessions SET permissionModeOverride = ? WHERE key = ?').run(mode, key)
  }

  /** Revoke every chat-authored runtime override for an Agent. Output mode is
   * delivery presentation, not a runtime setting, so it remains independent. */
  clearRuntimeConfigOverrides(agentId: string): void {
    this.db
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
  getFastModeOverride(key: string): boolean | undefined {
    const row = this.db.prepare('SELECT fastModeOverride FROM sessions WHERE key = ?').get(key) as
      { fastModeOverride: number | null } | undefined
    return row?.fastModeOverride === null || row?.fastModeOverride === undefined
      ? undefined
      : row.fastModeOverride === 1
  }

  /** Persist the session-scoped fast-mode override. No-op on an unknown key. */
  setFastModeOverride(key: string, fastMode: boolean): void {
    this.db.prepare('UPDATE sessions SET fastModeOverride = ? WHERE key = ?').run(fastMode ? 1 : 0, key)
  }

  /** The session-scoped Slack output-mode override (set via the status-bar output picker),
   *  or undefined if the session uses the agent's default. Daemon-side rendering verbosity
   *  (minimal/low/medium/high) — NOT an ACP setting; picked up by the next turn's OutputConverger. */
  getOutputModeOverride(key: string): 'none' | 'minimal' | 'low' | 'medium' | 'high' | undefined {
    if (!key) return undefined // defensive: never bind an undefined key into SQL
    const row = this.db.prepare('SELECT outputModeOverride FROM sessions WHERE key = ?').get(key) as
      { outputModeOverride: string | null } | undefined
    const v = row?.outputModeOverride
    return v === 'none' || v === 'minimal' || v === 'low' || v === 'medium' || v === 'high' ? v : undefined
  }

  /** Persist the session-scoped Slack output-mode override. No-op on an unknown key. */
  setOutputModeOverride(key: string, mode: 'none' | 'minimal' | 'low' | 'medium' | 'high'): void {
    this.db.prepare('UPDATE sessions SET outputModeOverride = ? WHERE key = ?').run(mode, key)
  }

  /** Current token accounting for a session (parsed from the `usage` JSON column),
   *  or `{}` if none has been recorded / the JSON is unreadable. */
  getUsage(key: string): StoredUsage {
    const row = this.db.prepare('SELECT usage FROM sessions WHERE key = ?').get(key) as
      { usage: string | null } | undefined
    if (!row?.usage) return {}
    try {
      return JSON.parse(row.usage) as StoredUsage
    } catch {
      return {}
    }
  }

  private writeUsage(key: string, u: StoredUsage): void {
    this.db.prepare('UPDATE sessions SET usage = ? WHERE key = ?').run(JSON.stringify(u), key)
  }

  /** Record the latest token counts for a session when an adapter reports a
   *  running session total. This is latest-wins over the token fields — never
   *  additive. Only provided fields are updated; the context/cost snapshot is
   *  left intact. No-op on an unknown key (the row is created first). */
  setTokenUsage(key: string, counts: TokenCounts): void {
    const u = this.getUsage(key)
    if (counts.totalTokens !== undefined) u.totalTokens = counts.totalTokens
    if (counts.inputTokens !== undefined) u.inputTokens = counts.inputTokens
    if (counts.outputTokens !== undefined) u.outputTokens = counts.outputTokens
    if (counts.thoughtTokens !== undefined) u.thoughtTokens = counts.thoughtTokens
    if (counts.cachedReadTokens !== undefined) u.cachedReadTokens = counts.cachedReadTokens
    if (counts.cachedWriteTokens !== undefined) u.cachedWriteTokens = counts.cachedWriteTokens
    this.writeUsage(key, u)
  }

  /** Add one turn's token counts to the session total. codex-acp currently maps
   *  Codex's `last_token_usage` into PromptResponse.usage, so its values are a
   *  per-turn delta even though other ACP adapters return a session snapshot. */
  addTokenUsage(key: string, counts: TokenCounts): void {
    const u = this.getUsage(key)
    const add = (field: keyof TokenCounts, value: number | undefined) => {
      if (value !== undefined) u[field] = (u[field] ?? 0) + value
    }
    add('totalTokens', counts.totalTokens)
    add('inputTokens', counts.inputTokens)
    add('outputTokens', counts.outputTokens)
    add('thoughtTokens', counts.thoughtTokens)
    add('cachedReadTokens', counts.cachedReadTokens)
    add('cachedWriteTokens', counts.cachedWriteTokens)
    this.writeUsage(key, u)
  }

  /** Overwrite the session's context-window + cost snapshot (latest `usage_update`
   *  wins). Only provided fields are updated. No-op on an unknown key. */
  setUsageSnapshot(key: string, snap: UsageSnapshot): void {
    const u = this.getUsage(key)
    if (snap.contextUsed !== undefined) u.contextUsed = snap.contextUsed
    if (snap.contextSize !== undefined) u.contextSize = snap.contextSize
    if (snap.costAmount !== undefined) u.costAmount = snap.costAmount
    if (snap.costCurrency !== undefined) u.costCurrency = snap.costCurrency
    this.writeUsage(key, u)
  }

  /** Add one turn's fallback cost to the session running total. Refuse to mix
   *  currencies; a later ACP usage_update can still replace the total snapshot. */
  addCost(key: string, amount: number, currency: string): boolean {
    if (!Number.isFinite(amount) || amount <= 0 || !currency) return false
    const u = this.getUsage(key)
    if (u.costCurrency !== undefined && u.costCurrency !== currency) return false
    u.costAmount = (u.costAmount ?? 0) + amount
    u.costCurrency = currency
    this.writeUsage(key, u)
    return true
  }

  /** Most-recent activity across an agent's non-closed sessions (epoch ms), or null
   *  if it has none. Drives idle-host reaping (#111): a host with no recent session
   *  activity AND no in-flight turn is past its idle window. */
  agentLastActivityTs(agentId: string): number | null {
    const row = this.db
      .prepare("SELECT MAX(updatedAt) AS ts FROM sessions WHERE agentId = ? AND state != 'closed'")
      .get(agentId) as { ts: number | null } | undefined
    return row?.ts ?? null
  }

  /** §7.3 TTL close: move every `idle` session untouched since `now - ttlMs` to
   *  `closed`, returning the rows closed (for logging). `prompting`/`cancelling`
   *  sessions are never closed — a live turn keeps the thread open. `isExempt`
   *  (when given) spares a session from closing — used to keep a session with
   *  in-flight background work open past the TTL (see the SDK lease in daemon.ts). */
  closeIdleSessions(
    now: number,
    ttlMs: number,
    isExempt?: (acpSessionId: string | null) => boolean
  ): {
    key: string
    agentId: string
    platform: string
    channel: string
    thread: string
    acpSessionId: string | null
  }[] {
    const cutoff = now - ttlMs
    const candidates = this.db
      .prepare(
        "SELECT key, agentId, platform, channel, thread, acpSessionId FROM sessions WHERE state = 'idle' AND updatedAt < ?"
      )
      .all(cutoff) as {
      key: string
      agentId: string
      platform: string
      channel: string
      thread: string
      acpSessionId: string | null
    }[]
    const rows = isExempt ? candidates.filter((r) => !isExempt(r.acpSessionId)) : candidates
    if (rows.length) {
      const close = this.db.prepare("UPDATE sessions SET state = 'closed' WHERE key = ? AND state = 'idle'")
      this.db.exec('BEGIN')
      try {
        for (const r of rows) close.run(r.key)
        this.db.exec('COMMIT')
      } catch (err) {
        this.db.exec('ROLLBACK')
        throw err
      }
    }
    return rows
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
      usage: dream.usage ? JSON.stringify(dream.usage) : null,
      error: dream.error ? JSON.stringify(dream.error) : null,
      createdAt: dream.createdAt,
      endedAt: dream.endedAt ?? null
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
      ...(row.usage ? { usage: JSON.parse(row.usage as string) as DreamInfo['usage'] } : {}),
      ...(row.error ? { error: JSON.parse(row.error as string) as DreamInfo['error'] } : {}),
      createdAt: row.createdAt as string,
      ...(row.endedAt ? { endedAt: row.endedAt as string } : {})
    }
  }

  insertDream(dream: DreamInfo): void {
    this.db
      .prepare(
        `INSERT INTO dreams (dreamId, agentId, status, triggerKind, sessionIds, snapshotDigest,
           executionSessionId, runtime, model, stopReason, snapshotWrites, instructions, skills, usage, error, createdAt, endedAt)
         VALUES (@dreamId, @agentId, @status, @triggerKind, @sessionIds, @snapshotDigest,
           @executionSessionId, @runtime, @model, @stopReason, @snapshotWrites, @instructions, @skills, @usage, @error, @createdAt, @endedAt)`
      )
      .run(this.dreamToRow(dream))
  }

  updateDream(dream: DreamInfo): void {
    this.db
      .prepare(
        // Every column dreamToRow produces must appear here: better-sqlite3
        // rejects a bound parameter the statement never references ("Unknown
        // named parameter"). triggerKind/createdAt are immutable in practice but
        // are still assigned, so the row shape and the SQL can't drift apart.
        `UPDATE dreams SET status = @status, triggerKind = @triggerKind, sessionIds = @sessionIds,
           snapshotDigest = @snapshotDigest, executionSessionId = @executionSessionId, runtime = @runtime,
           model = @model, stopReason = @stopReason, snapshotWrites = @snapshotWrites, instructions = @instructions,
           skills = @skills, usage = @usage, error = @error, createdAt = @createdAt, endedAt = @endedAt
         WHERE dreamId = @dreamId AND agentId = @agentId`
      )
      .run(this.dreamToRow(dream))
  }

  getDream(agentId: string, dreamId: string): DreamInfo | undefined {
    const row = this.db.prepare('SELECT * FROM dreams WHERE dreamId = ? AND agentId = ?').get(dreamId, agentId) as
      Record<string, unknown> | undefined
    return row ? this.dreamFromRow(row) : undefined
  }

  listDreams(agentId: string, limit: number): DreamInfo[] {
    return (
      this.db
        .prepare('SELECT * FROM dreams WHERE agentId = ? ORDER BY createdAt DESC, dreamId DESC LIMIT ?')
        .all(agentId, limit) as Record<string, unknown>[]
    ).map((row) => this.dreamFromRow(row))
  }

  /** Non-terminal dreams — the boot-time crash-recovery sweep. */
  openDreams(): DreamInfo[] {
    return (
      this.db.prepare("SELECT * FROM dreams WHERE status IN ('pending', 'running')").all() as Record<string, unknown>[]
    ).map((row) => this.dreamFromRow(row))
  }

  completedDreams(agentId: string): DreamInfo[] {
    return (
      this.db.prepare("SELECT * FROM dreams WHERE agentId = ? AND status = 'completed'").all(agentId) as Record<
        string,
        unknown
      >[]
    ).map((row) => this.dreamFromRow(row))
  }

  /** Store proposals reconciled as stale during upgrade. The runner removes
   *  their daemon-local staging once agent directories are available. */
  supersededDreams(): DreamInfo[] {
    return (this.db.prepare("SELECT * FROM dreams WHERE status = 'superseded'").all() as Record<string, unknown>[]).map(
      (row) => this.dreamFromRow(row)
    )
  }

  /** Newest-first addressable sessions to mine as dream transcript sources. */
  dreamSessionSources(
    agentId: string,
    limit: number
  ): { sessionId: string; channel: string; thread: string; transportScope?: string | null }[] {
    const rows = this.db
      .prepare(
        `SELECT acpSessionId AS sessionId, channel, thread, transportScope FROM sessions
         WHERE agentId = ? AND acpSessionId IS NOT NULL AND platform <> 'dream'
         ORDER BY updatedAt DESC LIMIT ?`
      )
      .all(agentId, limit) as {
      sessionId: string
      channel: string
      thread: string
      transportScope: string | null
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

  dreamTranscriptText(
    channel: string,
    thread: string,
    agentId: string,
    limit: number,
    includeTools = false,
    transportScope?: string | null
  ): { sender: string; text: string; kind?: string }[] {
    const transcriptChannel = transcriptChannelKey(channel, transportScope)
    const rows = this.db
      .prepare(
        // SECURITY: gate the delivery-table match on `kind = 'text'`, exactly as
        // the session-history query does. Internal rows (tool/reasoning) are NOT
        // deduped by ts and can share a ts with a delivered text row, so an
        // ungated EXISTS would pull a PEER's private tool title into this agent's
        // mining prompt. Deliveries only ever concern conversational messages;
        // this agent's own tool rows still surface through `sender`.
        `SELECT sender, text, kind, body FROM transcript
         WHERE channel = ? AND thread = ? AND kind ${includeTools ? "IN ('text','tool')" : "= 'text'"}
           AND (sender = ? OR recipient = ? OR (transcript.kind = 'text' AND EXISTS (
             SELECT 1 FROM transcript_recipient tr
             WHERE tr.channel = transcript.channel AND tr.thread = transcript.thread
               AND tr.ts = transcript.ts AND tr.agentId = ?)))
           AND NOT (kind = 'tool' AND text IN (?, ?))
         ORDER BY seq DESC LIMIT ?`
      )
      .all(transcriptChannel, thread, agentId, agentId, agentId, ...SESSION_TITLE_TOOL_TITLES, limit) as {
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

  appendTranscript(e: TranscriptEntry): void {
    const { attachments, ...entry } = e
    const revision = this.transcriptRevision + 1
    const inserted = this.db
      .prepare(
        `INSERT OR IGNORE INTO transcript
           (channel, thread, ts, sender, kind, text, recipient, eventTimeUs, attachmentsJson, revision)
         VALUES
           (@channel, @thread, @ts, @sender, @kind, @text, @recipient, @eventTimeUs, @attachmentsJson, @revision)`
      )
      .run({
        ...entry,
        recipient: e.recipient ?? null,
        eventTimeUs: transcriptEventTimeUs(e.ts),
        attachmentsJson: attachments?.length ? JSON.stringify(attachments) : null,
        revision
      } as unknown as SqlParams)
    if (Number(inserted.changes) === 1) this.transcriptRevision = revision
    // Record the delivery separately so it survives the text-row dedup above: if this same
    // (channel, thread, ts) was already recorded by another agent, the INSERT OR IGNORE
    // dropped this row and its `recipient`, but the message WAS delivered to this agent too.
    const delivered =
      e.recipient && e.ts
        ? this.db
            .prepare('INSERT OR IGNORE INTO transcript_recipient (channel, thread, ts, agentId) VALUES (?, ?, ?, ?)')
            .run(e.channel, e.thread, e.ts, e.recipient)
        : undefined

    if (Number(inserted.changes) === 1) {
      this.notifyTranscriptMutation(e.channel, e.thread, [e.sender, e.recipient], revision)
    } else if (e.recipient && Number(delivered?.changes ?? 0) === 1) {
      const deliveryRevision = this.transcriptRevision + 1
      this.db
        .prepare("UPDATE transcript SET revision = ? WHERE channel = ? AND thread = ? AND ts = ? AND kind = 'text'")
        .run(deliveryRevision, e.channel, e.thread, e.ts)
      this.transcriptRevision = deliveryRevision
      this.notifyTranscriptMutation(e.channel, e.thread, [e.recipient], deliveryRevision)
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
  }): void {
    const revision = this.transcriptRevision + 1
    const inserted = this.db
      .prepare(
        `INSERT OR IGNORE INTO transcript
           (channel, thread, ts, sender, kind, text, tool_call_id, body, eventTimeUs, revision)
         VALUES (@channel, @thread, @ts, @sender, 'tool', @text, @toolCallId, @body, @eventTimeUs, @revision)`
      )
      .run({
        channel: e.channel,
        thread: e.thread,
        ts: e.ts,
        sender: e.sender,
        text: e.title,
        toolCallId: e.toolCallId,
        body: e.body,
        eventTimeUs: transcriptEventTimeUs(e.ts),
        revision
      })
    if (Number(inserted.changes) === 1) {
      this.transcriptRevision = revision
      this.notifyTranscriptMutation(e.channel, e.thread, [e.sender], revision)
    }
  }

  /** Later update for one agent's tool call. `seq`/`ts` keep their first-seen
   *  values; a peer reusing the same session-local tool id cannot overwrite it. */
  updateToolCall(
    channel: string,
    thread: string,
    agentId: string,
    toolCallId: string,
    patch: { title: string; body: string }
  ): void {
    const revision = this.transcriptRevision + 1
    const updated = this.db
      .prepare(
        `UPDATE transcript SET text = ?, body = ?, revision = ?
         WHERE channel = ? AND thread = ? AND sender = ? AND tool_call_id = ?
           AND (text IS NOT ? OR body IS NOT ?)`
      )
      .run(patch.title, patch.body, revision, channel, thread, agentId, toolCallId, patch.title, patch.body)
    if (Number(updated.changes) === 1) {
      this.transcriptRevision = revision
      this.notifyTranscriptMutation(channel, thread, [agentId], revision)
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
    try {
      this.transcriptMutationListener?.({ channel, thread, agentIds, revision })
    } catch {
      // Live-view invalidation is best-effort and must never fail a durable write.
    }
  }

  /** One agent's full stored ToolBody JSON, or undefined if unknown/not owned. */
  getToolBodyForAgent(channel: string, thread: string, agentId: string, toolCallId: string): string | undefined {
    const row = this.db
      .prepare('SELECT body FROM transcript WHERE channel = ? AND thread = ? AND sender = ? AND tool_call_id = ?')
      .get(channel, thread, agentId, toolCallId) as { body: string | null } | undefined
    return row?.body ?? undefined
  }

  /**
   * §8.5 cross-agent catch-up: conversational (`text`) rows only — tool/reasoning rows
   * are audit/UI data and must never be replayed back into an agent's prompt. Ordered by
   * platform `ts` (every text row carries one), compared against the session marker.
   */
  transcriptSince(channel: string, thread: string, sinceTs: string | null): TranscriptEntry[] {
    if (sinceTs === null) {
      return this.db
        .prepare("SELECT * FROM transcript WHERE channel = ? AND thread = ? AND kind = 'text' ORDER BY ts ASC")
        .all(channel, thread) as unknown as TranscriptEntry[]
    }
    return this.db
      .prepare("SELECT * FROM transcript WHERE channel = ? AND thread = ? AND kind = 'text' AND ts > ? ORDER BY ts ASC")
      .all(channel, thread, sinceTs) as unknown as TranscriptEntry[]
  }

  /** The earliest inbound (non-agent) `text` message in a thread — the triggering user
   *  message. Used as a session-title fallback when neither ACP nor the title tool
   *  supplied one. Before the first meaningful request, this avoids showing only
   *  "Session <id>". Returns undefined when the thread holds no non-agent text row
   *  yet. Indexed by (channel, thread, seq). */
  firstMessageText(channel: string, thread: string, agentId: string): string | undefined {
    const row = this.db
      .prepare(
        "SELECT text FROM transcript WHERE channel = ? AND thread = ? AND kind = 'text' AND sender != ? ORDER BY seq ASC LIMIT 1"
      )
      .get(channel, thread, agentId) as { text: string } | undefined
    return row?.text
  }

  /** Full activity log for a thread (all kinds), in insertion order — for the Web UI. */
  threadTranscript(channel: string, thread: string): TranscriptRow[] {
    return this.db
      .prepare('SELECT * FROM transcript WHERE channel = ? AND thread = ? ORDER BY seq ASC')
      .all(channel, thread) as unknown as TranscriptRow[]
  }

  /**
   * The session thread a Telegram message belongs to, recovered from the transcript
   * (every conversational `text` row carries its platform message id in `ts`, and
   * Telegram message ids are unique per chat). Backs reply-based session continuity:
   * a human reply to a bot message (`reply_to_message.message_id`) resolves to the
   * session that bot message was posted in. Undefined when the id was never recorded
   * as text (e.g. a reply to transient chrome, or an unknown message).
   */
  telegramThreadForMessage(channel: string, messageId: string): string | undefined {
    const row = this.db
      .prepare("SELECT thread FROM transcript WHERE channel = ? AND ts = ? AND kind = 'text' ORDER BY seq DESC LIMIT 1")
      .get(channel, messageId) as { thread: string } | undefined
    return row?.thread
  }

  openSessionAgents(channel: string, thread: string): string[] {
    return (
      this.db
        .prepare("SELECT agentId FROM sessions WHERE channel = ? AND thread = ? AND state != 'closed'")
        .all(channel, thread) as { agentId: string }[]
    ).map((r) => r.agentId)
  }

  /** Agents with a TTL-`closed` session in this thread (§7.3). Backs thread-affinity
   *  revival: when no OPEN session owns a thread, a follow-up reply can still be routed
   *  to the sole agent that previously owned it, and SessionManager.handle recreates/
   *  resumes the ACP session. Kept separate from `openSessionAgents` so the live
   *  multi-agent disambiguation (2+ open owners → mention-gated) is never perturbed. */
  closedSessionAgents(channel: string, thread: string): string[] {
    return (
      this.db
        .prepare("SELECT agentId FROM sessions WHERE channel = ? AND thread = ? AND state = 'closed'")
        .all(channel, thread) as { agentId: string }[]
    ).map((r) => r.agentId)
  }

  /** Count non-closed sessions in (channel, thread) touched at/after `sinceTs`
   *  (epoch ms). Used to bound unrouted-transcript growth to recently-active
   *  threads, since there is no session-`closed` lifecycle yet. */
  activeSessionCountSince(channel: string, thread: string, sinceTs: number, transportScope?: string | null): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM sessions
         WHERE channel = ? AND thread = ? AND COALESCE(transportScope, '') = ?
           AND state != 'closed' AND updatedAt >= ?`
      )
      .get(channel, thread, transportScope ?? '', sinceTs) as { n: number } | undefined
    return row?.n ?? 0
  }

  /** Cache a platform id's human display name (channel or user; Slack ids don't
   *  collide across the two). Latest-wins — renames overwrite. */
  setDisplayName(id: string, name: string, updatedAt: number): void {
    this.db
      .prepare(
        `INSERT INTO display_names (id, name, updatedAt) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, updatedAt=excluded.updatedAt`
      )
      .run(id, name, updatedAt)
  }

  /** Display names for a set of platform ids — only the ids that have one.
   *  One batched `IN (…)` query, not a round-trip per id. */
  getDisplayNames(ids: string[]): Map<string, string> {
    const out = new Map<string, string>()
    const unique = [...new Set(ids)]
    if (unique.length === 0) return out
    const rows = this.db
      .prepare(`SELECT id, name FROM display_names WHERE id IN (${unique.map(() => '?').join(',')})`)
      .all(...unique) as unknown as { id: string; name: string }[]
    for (const r of rows) if (r.name) out.set(r.id, r.name)
    return out
  }

  getCpRouting(): { routingEpoch: number; assignments: string; globalRules: string } | undefined {
    return this.db.prepare('SELECT routingEpoch, assignments, globalRules FROM cp_routing WHERE id = 1').get() as
      { routingEpoch: number; assignments: string; globalRules: string } | undefined
  }

  setCpRouting(routingEpoch: number, assignments: string, globalRules: string): void {
    this.db
      .prepare(
        `INSERT INTO cp_routing (id, routingEpoch, assignments, globalRules) VALUES (1, @routingEpoch, @assignments, @globalRules)
         ON CONFLICT(id) DO UPDATE SET routingEpoch=excluded.routingEpoch, assignments=excluded.assignments, globalRules=excluded.globalRules`
      )
      .run({ routingEpoch, assignments, globalRules })
  }

  /** Stamp a cron fire (key = `<agentId>:<cronId>`). */
  setCronLastRun(key: string, lastRunAt: number): void {
    this.db
      .prepare(
        `INSERT INTO cron_runs (key, lastRunAt) VALUES (@key, @lastRunAt)
         ON CONFLICT(key) DO UPDATE SET lastRunAt=excluded.lastRunAt`
      )
      .run({ key, lastRunAt })
  }

  getCronLastRun(key: string): number | undefined {
    const row = this.db.prepare('SELECT lastRunAt FROM cron_runs WHERE key = ?').get(key) as
      { lastRunAt: number } | undefined
    return row?.lastRunAt
  }

  /** Self-introduce-on-join (issue #536). The set of channels this agent has already
   *  introduced itself into (or adopted as the silent baseline) on `platform`. */
  channelIntroSet(agentId: string, platform: string): Set<string> {
    const rows = this.db
      .prepare('SELECT channel FROM channel_intro WHERE agentId = ? AND platform = ?')
      .all(agentId, platform) as { channel: string }[]
    return new Set(rows.map((r) => r.channel))
  }

  /** Record that the agent has introduced itself in a channel (idempotent). `introducedAt`
   *  is null when the channel was adopted as the silent baseline (never introduced-in). */
  markChannelIntro(agentId: string, platform: string, channel: string, introducedAt: number | null): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO channel_intro (agentId, platform, channel, introducedAt)
         VALUES (@agentId, @platform, @channel, @introducedAt)`
      )
      .run({ agentId, platform, channel, introducedAt })
  }

  /** Whether an integration's first channel snapshot has been baselined (seeded). */
  isChannelIntroSeeded(integrationId: string): boolean {
    return this.db.prepare('SELECT 1 FROM channel_intro_seed WHERE integrationId = ?').get(integrationId) !== undefined
  }

  /** Mark an integration's channel baseline as seeded (idempotent). */
  markChannelIntroSeeded(integrationId: string, seededAt: number): void {
    this.db
      .prepare('INSERT OR IGNORE INTO channel_intro_seed (integrationId, seededAt) VALUES (?, ?)')
      .run(integrationId, seededAt)
  }

  /** §6.9 #353 durable inbox: persist an admitted message BEFORE its admission ACK. Keyed
   *  by the stable id (deliveryId/msgId). A re-append preserves the original payload/FIFO
   *  position and may only advance the durable loop-accounting marker from 0 to 1. */
  appendInbox(row: InboxRow): boolean {
    const inserted = this.db
      .prepare(
        `INSERT OR IGNORE INTO inbox
          (id, sessionKey, agentId, msg, integrationId, callMeta, hookContext, posterPublishState,
            terminalReport, legacyReportConnection, completedAt, isQueueCmd, loopGuardCounted, enqueuedAt)
         VALUES
           (@id, @sessionKey, @agentId, @msg, @integrationId, @callMeta, @hookContext, @posterPublishState,
            @terminalReport, @legacyReportConnection, @completedAt, @isQueueCmd, @loopGuardCounted, @enqueuedAt)`
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
        legacyReportConnection: row.legacyReportConnection ?? null,
        completedAt: row.completedAt ?? null,
        isQueueCmd: row.isQueueCmd ?? null,
        loopGuardCounted: row.loopGuardCounted ?? 0,
        enqueuedAt: row.enqueuedAt
      })
    if (inserted.changes === 0 && row.loopGuardCounted === 1) {
      this.db.prepare('UPDATE inbox SET loopGuardCounted = MAX(loopGuardCounted, 1) WHERE id = ?').run(row.id)
    }
    return inserted.changes === 1
  }

  /** Stable-id admission probe used before any hook anchoring side effect. A
   * live row will be replayed (or is already running); a terminal row is the
   * durable receipt. Either way, redelivery must not post another anchor. */
  hasInbox(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM inbox WHERE id = ?').get(id) !== undefined
  }

  updateInboxHookState(
    id: string,
    hookContext: string,
    posterPublishState?: 'not_started' | 'in_flight' | 'settled'
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE inbox
         SET hookContext = @hookContext,
             posterPublishState = COALESCE(@posterPublishState, posterPublishState)
         WHERE id = @id`
      )
      .run({ id, hookContext, posterPublishState: posterPublishState ?? null })
    return result.changes === 1
  }

  /** Atomically turn a live hook inbox row into a redacted terminal receipt.
   * The stable id remains present to absorb relay redelivery after restart;
   * startup re-emits only the metadata report, never the model prompt. The CAS
   * result identifies the sole writer so a later terminal path cannot replace
   * the winning outbox body. */
  completeHookInbox(
    id: string,
    terminalReport: string,
    completedAt: number
  ): 'completed' | 'already-terminal' | 'missing' {
    const result = this.db
      .prepare(
        `UPDATE inbox
         SET msg = '{}', integrationId = NULL, callMeta = NULL, hookContext = NULL,
             posterPublishState = 'settled', terminalReport = @terminalReport,
             legacyReportConnection = NULL, completedAt = @completedAt, isQueueCmd = NULL
         WHERE id = @id AND hookContext IS NOT NULL AND completedAt IS NULL`
      )
      .run({ id, terminalReport, completedAt })
    if (result.changes === 1) return 'completed'

    const row = this.db.prepare('SELECT completedAt FROM inbox WHERE id = ?').get(id) as
      { completedAt: number | null } | undefined
    return row?.completedAt !== null && row?.completedAt !== undefined ? 'already-terminal' : 'missing'
  }

  /** Remember a best-effort legacy EVT on this exact CP connection so an
   * outbox pump can move past it without repeatedly re-sending. The report body
   * remains retained until a future ACK-capable connection durably converges it. */
  markLegacyHookReportSent(id: string, connectionId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE inbox
         SET legacyReportConnection = @connectionId
         WHERE id = @id AND terminalReport IS NOT NULL`
      )
      .run({ id, connectionId })
    return result.changes === 1
  }

  /** A CP-correlated ACK releases only the report payload. Keep a bounded
   * metadata-only stable-id receipt so relay redelivery still cannot rerun the
   * model; unacknowledged reports are never capacity-evicted. */
  acknowledgeHookInbox(id: string, maxAcknowledgedReceipts = 10_000): boolean {
    const result = this.db
      .prepare(
        `UPDATE inbox
         SET terminalReport = NULL, legacyReportConnection = NULL
         WHERE id = @id AND completedAt IS NOT NULL AND terminalReport IS NOT NULL`
      )
      .run({ id })
    if (result.changes === 1) {
      this.db
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

  /** Remove an ordinary inbox row once its turn reaches a terminal state. Hook
   * rows are converted to bounded redacted receipts by completeHookInbox. */
  removeInbox(id: string): void {
    this.db.prepare('DELETE FROM inbox WHERE id = ?').run(id)
  }

  /** All pending inbox rows, ordered FIFO-by-sessionKey (sessionKey, then enqueuedAt) for
   *  startup replay (§6.9 #353). Order within a sessionKey is preserved by `enqueuedAt`. */
  listInboxBySessionKeyFifo(): InboxRow[] {
    return this.db.prepare('SELECT * FROM inbox ORDER BY sessionKey ASC, enqueuedAt ASC').all() as unknown as InboxRow[]
  }

  /** Remove ordinary durable turns owned by an agent. Live hook rows have their
   *  own single completion owner and must survive until that owner atomically
   *  redacts them into a terminal report. Unacknowledged terminal hook reports
   *  are an outbox and likewise must survive lifecycle purges. ACKed receipts
   *  may be discarded here because CP already durably converged them. */
  removeInboxByAgentId(agentId: string): string[] {
    const removable = 'agentId = ? AND hookContext IS NULL AND terminalReport IS NULL'
    const rows = this.db.prepare(`SELECT id FROM inbox WHERE ${removable}`).all(agentId) as Array<{ id: string }>
    this.db.prepare(`DELETE FROM inbox WHERE ${removable}`).run(agentId)
    return rows.map((row) => row.id)
  }

  /** Persist a bounded capture before any external side effect. Both the stable
   * operation id and the semantic (agent, connection, turn) key deduplicate
   * redelivery. A conflicting duplicate fails closed instead of replacing body. */
  appendMemoryCapture(row: MemoryCaptureOutboxRow): 'inserted' | 'duplicate' | 'conflict' {
    const result = this.db
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
    const existing = this.db
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
      }) as
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

  getMemoryCapture(operationId: string): MemoryCaptureOutboxRow | undefined {
    return this.db.prepare('SELECT * FROM memory_capture_outbox WHERE operationId = ?').get(operationId) as
      MemoryCaptureOutboxRow | undefined
  }

  listMemoryCaptures(): MemoryCaptureOutboxRow[] {
    return this.db
      .prepare('SELECT * FROM memory_capture_outbox ORDER BY createdAt ASC, operationId ASC')
      .all() as unknown as MemoryCaptureOutboxRow[]
  }

  nextDueMemoryCapture(now: number): MemoryCaptureOutboxRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM memory_capture_outbox
         WHERE state IN ('pending', 'accepted') AND nextAttemptAt <= ?
         ORDER BY nextAttemptAt ASC, createdAt ASC, operationId ASC
         LIMIT 1`
      )
      .get(now) as MemoryCaptureOutboxRow | undefined
  }

  nextMemoryCaptureDueAt(): number | undefined {
    const row = this.db
      .prepare(
        `SELECT MIN(nextAttemptAt) AS dueAt FROM memory_capture_outbox
         WHERE state IN ('pending', 'accepted')`
      )
      .get() as { dueAt: number | null } | undefined
    return row?.dueAt ?? undefined
  }

  /** Next age/retention deadline even when there is no due send. This keeps a
   * quiet daemon from retaining terminal dedup receipts indefinitely. */
  nextMemoryCaptureMaintenanceAt(activeAgeMs: number, terminalRetentionMs: number): number | undefined {
    const row = this.db
      .prepare(
        `SELECT
           MIN(CASE WHEN state IN ('pending', 'accepted') THEN createdAt + @activeAgeMs END) AS activeAt,
           MIN(CASE WHEN state IN ('completed', 'failed', 'ambiguous')
                    THEN updatedAt + @terminalRetentionMs END) AS terminalAt
         FROM memory_capture_outbox`
      )
      .get({ activeAgeMs, terminalRetentionMs }) as { activeAt: number | null; terminalAt: number | null } | undefined
    const deadlines = [row?.activeAt, row?.terminalAt].filter(
      (value): value is number => value !== null && value !== undefined
    )
    return deadlines.length ? Math.min(...deadlines) : undefined
  }

  claimMemoryCapture(operationId: string, now: number): MemoryCaptureOutboxRow | undefined {
    const changed = this.db
      .prepare(
        `UPDATE memory_capture_outbox
         SET state = 'sending', attempts = attempts + 1, updatedAt = @now
         WHERE operationId = @operationId AND state = 'pending'`
      )
      .run({ operationId, now })
    return changed.changes === 1 ? this.getMemoryCapture(operationId) : undefined
  }

  deferPendingMemoryCapture(operationId: string, nextAttemptAt: number, now: number, reasonCode: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE memory_capture_outbox
           SET nextAttemptAt = @nextAttemptAt, updatedAt = @now, reasonCode = @reasonCode
           WHERE operationId = @operationId AND state = 'pending'`
        )
        .run({ operationId, nextAttemptAt, now, reasonCode }).changes === 1
    )
  }

  retryMemoryCapture(operationId: string, nextAttemptAt: number, now: number, reasonCode: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE memory_capture_outbox
           SET state = 'pending', nextAttemptAt = @nextAttemptAt, updatedAt = @now,
               reasonCode = @reasonCode
           WHERE operationId = @operationId AND state = 'sending'`
        )
        .run({ operationId, nextAttemptAt, now, reasonCode }).changes === 1
    )
  }

  acceptMemoryCapture(operationId: string, backendOperationId: string, nextAttemptAt: number, now: number): boolean {
    return (
      this.db
        .prepare(
          `UPDATE memory_capture_outbox
           SET state = 'accepted', backendOperationId = @backendOperationId,
               nextAttemptAt = @nextAttemptAt, updatedAt = @now, reasonCode = NULL,
               input = '', output = '', sessionId = NULL,
               payloadBytes = length(CAST(config AS BLOB))
           WHERE operationId = @operationId AND state = 'sending'`
        )
        .run({ operationId, backendOperationId, nextAttemptAt, now }).changes === 1
    )
  }

  rescheduleAcceptedMemoryCapture(operationId: string, nextAttemptAt: number, now: number): boolean {
    return (
      this.db
        .prepare(
          `UPDATE memory_capture_outbox
           SET nextAttemptAt = @nextAttemptAt, updatedAt = @now
           WHERE operationId = @operationId AND state = 'accepted'`
        )
        .run({ operationId, nextAttemptAt, now }).changes === 1
    )
  }

  finishMemoryCapture(
    operationId: string,
    state: 'completed' | 'failed' | 'ambiguous',
    now: number,
    reasonCode?: string
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE memory_capture_outbox
           SET state = @state, updatedAt = @now, nextAttemptAt = @now,
               reasonCode = @reasonCode, config = '{}', input = '', output = '',
               sessionId = NULL, payloadBytes = 0
           WHERE operationId = @operationId AND state IN ('sending', 'accepted', 'pending')`
        )
        .run({ operationId, state, now, reasonCode: reasonCode ?? null }).changes === 1
    )
  }

  /** Crash recovery is deliberately asymmetric. A sending idempotent operation
   * may be replayed with the same id; a non-idempotent one may already have
   * reached the plugin and therefore becomes terminal ambiguous. */
  recoverMemoryCaptures(now: number): { retried: number; ambiguous: number } {
    const retried = this.db
      .prepare(
        `UPDATE memory_capture_outbox
         SET state = 'pending', nextAttemptAt = @now, updatedAt = @now,
             reasonCode = 'restart_retry'
         WHERE state = 'sending' AND idempotency = 'operation-id'`
      )
      .run({ now }).changes
    const ambiguous = this.db
      .prepare(
        `UPDATE memory_capture_outbox
         SET state = 'ambiguous', nextAttemptAt = @now, updatedAt = @now,
             reasonCode = 'restart_after_send', config = '{}', input = '', output = '',
             sessionId = NULL, payloadBytes = 0
         WHERE state = 'sending' AND idempotency = 'none'`
      )
      .run({ now }).changes
    return { retried: Number(retried), ambiguous: Number(ambiguous) }
  }

  expireMemoryCaptures(activeBefore: number, terminalBefore: number, now: number): { expired: number; purged: number } {
    const expired = this.db
      .prepare(
        `UPDATE memory_capture_outbox
         SET state = 'failed', nextAttemptAt = @now, updatedAt = @now,
             reasonCode = 'retention_expired', config = '{}', input = '', output = '',
             sessionId = NULL, payloadBytes = 0
         WHERE state IN ('pending', 'accepted') AND createdAt <= @activeBefore`
      )
      .run({ now, activeBefore }).changes
    const purged = this.db
      .prepare(
        `DELETE FROM memory_capture_outbox
         WHERE state IN ('completed', 'failed', 'ambiguous') AND updatedAt <= ?`
      )
      .run(terminalBefore).changes
    return { expired: Number(expired), purged: Number(purged) }
  }

  memoryCaptureStats(): MemoryCaptureOutboxStats {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS activeCount, COALESCE(SUM(payloadBytes), 0) AS activeBytes,
                MIN(createdAt) AS oldestActiveAt
         FROM memory_capture_outbox
         WHERE state IN ('pending', 'sending', 'accepted')`
      )
      .get() as { activeCount: number; activeBytes: number; oldestActiveAt: number | null }
    return {
      activeCount: row.activeCount,
      activeBytes: row.activeBytes,
      ...(row.oldestActiveAt === null ? {} : { oldestActiveAt: row.oldestActiveAt })
    }
  }

  /** Record one turn admission against a conversation-wide fixed window. A trusted
   *  human boundary resets only the consecutive automatic counter; the total-rate
   *  backstop deliberately keeps counting so a platform bug that misclassifies its
   *  own events as human still eventually opens the circuit. */
  recordLoopGuardTurn(
    scopeKey: string,
    now: number,
    automatic: boolean,
    limits: { windowMs: number; maxTotal: number; maxAutomatic: number }
  ): LoopGuardVerdict {
    // Keep only active-window counters plus intentionally-latched incidents. Without
    // this bounded cleanup, every one-off channel thread would leave a row forever.
    this.db
      .prepare(
        `DELETE FROM loop_guard
         WHERE trippedAt IS NULL AND windowStartedAt <= @cutoff AND automaticWindowStartedAt <= @cutoff`
      )
      .run({ cutoff: now - limits.windowMs })
    const current = this.getLoopGuard(scopeKey)
    if (current?.trippedAt !== null && current?.trippedAt !== undefined) {
      return {
        allowed: false,
        trippedNow: false,
        totalCount: current.totalCount,
        automaticCount: current.automaticCount,
        ...(current.reason ? { reason: current.reason } : {})
      }
    }

    const totalWindowExpired = !current || now - current.windowStartedAt >= limits.windowMs
    const automaticWindowExpired = !current || now - current.automaticWindowStartedAt >= limits.windowMs
    const windowStartedAt = totalWindowExpired ? now : current.windowStartedAt
    const totalCount = totalWindowExpired ? 1 : current.totalCount + 1
    const automaticWindowStartedAt = automaticWindowExpired || !automatic ? now : current.automaticWindowStartedAt
    const automaticCount = automatic ? (automaticWindowExpired ? 1 : current.automaticCount + 1) : 0
    const reason =
      automaticCount > limits.maxAutomatic
        ? 'automatic_turn_burst'
        : totalCount > limits.maxTotal
          ? 'turn_rate_burst'
          : undefined
    const trippedAt = reason ? now : null

    this.db
      .prepare(
        `INSERT INTO loop_guard
           (scopeKey, windowStartedAt, totalCount, automaticWindowStartedAt, automaticCount, trippedAt, reason)
         VALUES (@scopeKey, @windowStartedAt, @totalCount, @automaticWindowStartedAt, @automaticCount, @trippedAt, @reason)
         ON CONFLICT(scopeKey) DO UPDATE SET
           windowStartedAt=excluded.windowStartedAt,
           totalCount=excluded.totalCount,
           automaticWindowStartedAt=excluded.automaticWindowStartedAt,
           automaticCount=excluded.automaticCount,
           trippedAt=excluded.trippedAt,
           reason=excluded.reason`
      )
      .run({
        scopeKey,
        windowStartedAt,
        totalCount,
        automaticWindowStartedAt,
        automaticCount,
        trippedAt,
        reason: reason ?? null
      })

    return {
      allowed: reason === undefined,
      trippedNow: reason !== undefined,
      totalCount,
      automaticCount,
      ...(reason ? { reason } : {})
    }
  }

  /** Charge a migrated inbox delivery and advance its marker in one SQLite transaction.
   *  A crash can therefore neither lose the charge nor charge the same retained row again
   *  after ownership moves. A tripping delivery is intentionally left at marker 0: the
   *  newly-open durable circuit makes its whole scope terminal and replay purges it. */
  recordLoopGuardTurnForInbox(
    inboxId: string,
    scopeKey: string,
    now: number,
    automatic: boolean,
    limits: { windowMs: number; maxTotal: number; maxAutomatic: number }
  ): LoopGuardVerdict {
    this.db.exec('BEGIN')
    try {
      const verdict = this.recordLoopGuardTurn(scopeKey, now, automatic, limits)
      if (verdict.allowed) {
        const marked = this.db.prepare('UPDATE inbox SET loopGuardCounted = 1 WHERE id = ?').run(inboxId)
        if (marked.changes !== 1) throw new Error(`inbox delivery disappeared while charging loop guard: ${inboxId}`)
      }
      this.db.exec('COMMIT')
      return verdict
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  /** Open a loop circuit immediately for a structurally-invalid platform event. */
  tripLoopGuard(scopeKey: string, now: number, reason: string): LoopGuardVerdict {
    const current = this.getLoopGuard(scopeKey)
    if (current?.trippedAt !== null && current?.trippedAt !== undefined) {
      return {
        allowed: false,
        trippedNow: false,
        totalCount: current.totalCount,
        automaticCount: current.automaticCount,
        ...(current.reason ? { reason: current.reason } : {})
      }
    }
    const row = current ?? {
      scopeKey,
      windowStartedAt: now,
      totalCount: 0,
      automaticWindowStartedAt: now,
      automaticCount: 0
    }
    this.db
      .prepare(
        `INSERT INTO loop_guard
           (scopeKey, windowStartedAt, totalCount, automaticWindowStartedAt, automaticCount, trippedAt, reason)
         VALUES (@scopeKey, @windowStartedAt, @totalCount, @automaticWindowStartedAt, @automaticCount, @trippedAt, @reason)
         ON CONFLICT(scopeKey) DO UPDATE SET trippedAt=excluded.trippedAt, reason=excluded.reason`
      )
      .run({ ...row, trippedAt: now, reason })
    return {
      allowed: false,
      trippedNow: true,
      totalCount: row.totalCount,
      automaticCount: row.automaticCount,
      reason
    }
  }

  getLoopGuard(scopeKey: string): LoopGuardRow | undefined {
    return this.db.prepare('SELECT * FROM loop_guard WHERE scopeKey = ?').get(scopeKey) as LoopGuardRow | undefined
  }

  isLoopGuardOpen(scopeKey: string): boolean {
    const row = this.getLoopGuard(scopeKey)
    return row?.trippedAt !== null && row?.trippedAt !== undefined
  }

  /** Explicit operator/user reset. Purged inbox rows stay purged; reset only lets a
   *  future fresh message start a new window. Returns whether a guard existed. */
  resetLoopGuard(scopeKey: string): boolean {
    return this.db.prepare('DELETE FROM loop_guard WHERE scopeKey = ?').run(scopeKey).changes > 0
  }

  // ── §3.4/§6.8 main-agent orchestration ──

  /**
   * RECORD-FIRST (§3.4): persist the orchestration header + all subtask rows (status
   * 'pending') in ONE transaction, BEFORE any delivery. A fast worker's reply that
   * arrives before this returns has nothing to correlate against and is dropped — so
   * this MUST complete before startOrchestration delivers anything. Idempotent via
   * INSERT OR IGNORE on the stable ids (replay-safe).
   */
  createOrchestration(orch: OrchestrationRow, subtasks: SubtaskRow[]): void {
    const insertOrch = this.db.prepare(
      `INSERT OR IGNORE INTO orchestration
         (orchestrationId, mainSessionKey, mainAgentId, platform, channel, thread,
          integrationId, replyTarget, deadline, status, createdAt, updatedAt)
       VALUES (@orchestrationId, @mainSessionKey, @mainAgentId, @platform, @channel, @thread,
          @integrationId, @replyTarget, @deadline, @status, @createdAt, @updatedAt)`
    )
    const insertSub = this.db.prepare(
      `INSERT OR IGNORE INTO orchestration_subtask
         (orchestrationId, correlationId, idx, toAgentId, text, status, result, deliveryReason, updatedAt)
       VALUES (@orchestrationId, @correlationId, @idx, @toAgentId, @text, @status, @result, @deliveryReason, @updatedAt)`
    )
    this.db.exec('BEGIN')
    try {
      insertOrch.run({
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
        insertSub.run({
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
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  getOrchestration(orchestrationId: string): OrchestrationRow | undefined {
    return this.db.prepare('SELECT * FROM orchestration WHERE orchestrationId = ?').get(orchestrationId) as unknown as
      OrchestrationRow | undefined
  }

  getSubtasks(orchestrationId: string): SubtaskRow[] {
    return this.db
      .prepare('SELECT * FROM orchestration_subtask WHERE orchestrationId = ? ORDER BY idx ASC')
      .all(orchestrationId) as unknown as SubtaskRow[]
  }

  getSubtaskByCorrelation(orchestrationId: string, correlationId: string): SubtaskRow | undefined {
    return this.db
      .prepare('SELECT * FROM orchestration_subtask WHERE orchestrationId = ? AND correlationId = ?')
      .get(orchestrationId, correlationId) as unknown as SubtaskRow | undefined
  }

  /** All still-`active` orchestrations — for startup re-arm of deadlines + re-drive
   *  of non-terminal subtasks (§6.8). */
  listActiveOrchestrations(): OrchestrationRow[] {
    return this.db
      .prepare("SELECT * FROM orchestration WHERE status = 'active' ORDER BY createdAt ASC")
      .all() as unknown as OrchestrationRow[]
  }

  /** CAS subtask status — only advances when the current status is one of `from`.
   *  Idempotent + monotonic: a stale/duplicate transition (current status not in
   *  `from`) is a no-op and returns false. */
  setSubtaskStatus(
    orchestrationId: string,
    correlationId: string,
    from: SubtaskRow['status'][],
    to: SubtaskRow['status'],
    updatedAt: string,
    extra?: { result?: string | null; deliveryReason?: string | null }
  ): boolean {
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
    const info = this.db
      .prepare(
        `UPDATE orchestration_subtask SET status=@to, updatedAt=@updatedAt${setResult}
         WHERE orchestrationId=@orchestrationId AND correlationId=@correlationId AND status IN (${placeholders})`
      )
      .run(params)
    return info.changes > 0
  }

  setOrchestrationStatus(orchestrationId: string, status: OrchestrationRow['status'], updatedAt: number): void {
    this.db
      .prepare('UPDATE orchestration SET status=?, updatedAt=? WHERE orchestrationId=?')
      .run(status, updatedAt, orchestrationId)
  }

  setOrchestrationDeadline(orchestrationId: string, deadline: number | null, updatedAt: number): void {
    this.db
      .prepare('UPDATE orchestration SET deadline=?, updatedAt=? WHERE orchestrationId=?')
      .run(deadline, updatedAt, orchestrationId)
  }

  // ── runtime model-catalog cache (runtime-model-catalog.md §4) ──

  /** Upsert a runtime's catalog metadata (phase-1 probe fold or a discovery run).
   *  A same-fingerprint write PRESERVES the stored complete/modelsHash — a phase-1
   *  meta refresh must neither satisfy nor re-open the §3.3 discovery gate; a
   *  fingerprint change (adapter upgrade) resets both so the runtime is re-discovered. */
  recordRuntimeCatalogMeta(meta: Omit<RuntimeCatalogMetaRecord, 'complete' | 'modelsHash'>): void {
    this.db.exec('BEGIN')
    try {
      const existing = this.db
        .prepare('SELECT fingerprint, complete, modelsHash FROM runtime_catalog_meta WHERE runtimeId = ?')
        .get(meta.runtimeId) as { fingerprint: string; complete: number; modelsHash: string | null } | undefined
      const sameGeneration = existing && existing.fingerprint === meta.fingerprint ? existing : undefined
      this.db
        .prepare(
          `INSERT INTO runtime_catalog_meta
             (runtimeId, fingerprint, source, defaultModel, permissionModes, defaultPermissionMode, complete, modelsHash, observedAt)
           VALUES (@runtimeId, @fingerprint, @source, @defaultModel, @permissionModes, @defaultPermissionMode, @complete, @modelsHash, @observedAt)
           ON CONFLICT(runtimeId) DO UPDATE SET
             fingerprint=excluded.fingerprint, source=excluded.source, defaultModel=excluded.defaultModel,
             permissionModes=excluded.permissionModes, defaultPermissionMode=excluded.defaultPermissionMode,
             complete=excluded.complete,
             modelsHash=excluded.modelsHash, observedAt=excluded.observedAt`
        )
        .run({
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
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  /** Close the discovery gate for ONE generation: complete=1 + the probed-models hash,
   *  only where the stored fingerprint still matches — a discovery finishing after the
   *  runtime was upgraded must not close the new generation's gate. */
  markRuntimeCatalogComplete(runtimeId: string, fingerprint: string, modelsHash: string, observedAt: number): void {
    this.db
      .prepare(
        `UPDATE runtime_catalog_meta
         SET complete = 1, modelsHash = @modelsHash, observedAt = @observedAt
         WHERE runtimeId = @runtimeId AND fingerprint = @fingerprint`
      )
      .run({ runtimeId, fingerprint, modelsHash, observedAt })
  }

  /** Upsert one model's capability row (latest-wins). Written incrementally as each
   *  model is discovered, so a single-model failure never discards the rest. */
  upsertRuntimeModelCap(rec: RuntimeModelCapRecord): void {
    this.db
      .prepare(
        `INSERT INTO runtime_model_catalog (runtimeId, modelId, fingerprint, capsJson, observedAt)
         VALUES (@runtimeId, @modelId, @fingerprint, @capsJson, @observedAt)
         ON CONFLICT(runtimeId, modelId) DO UPDATE SET
           fingerprint=excluded.fingerprint, capsJson=excluded.capsJson, observedAt=excluded.observedAt`
      )
      .run({
        runtimeId: rec.runtimeId,
        modelId: rec.modelId,
        fingerprint: rec.fingerprint,
        capsJson: JSON.stringify(rec.caps),
        observedAt: rec.observedAt
      })
  }

  /** Drop models that vanished from a runtime's catalog. Called only after a COMPLETE
   *  successful discovery (prune-on-success) — failures must keep last-good rows. */
  pruneRuntimeModelCaps(runtimeId: string, keepModelIds: string[]): void {
    // SQLite accepts an empty IN () list (always false), so an empty keep-set clears
    // the runtime's rows — correct for a runtime whose catalog came back empty.
    const placeholders = keepModelIds.map(() => '?').join(', ')
    this.db
      .prepare(`DELETE FROM runtime_model_catalog WHERE runtimeId = ? AND modelId NOT IN (${placeholders})`)
      .run(runtimeId, ...keepModelIds)
  }

  getRuntimeCatalogMeta(runtimeId: string): RuntimeCatalogMetaRecord | undefined {
    const row = this.db.prepare('SELECT * FROM runtime_catalog_meta WHERE runtimeId = ?').get(runtimeId) as
      RuntimeCatalogMetaRow | undefined
    return row ? runtimeCatalogMetaFromRow(row) : undefined
  }

  listRuntimeCatalogMetas(): RuntimeCatalogMetaRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM runtime_catalog_meta ORDER BY runtimeId ASC')
      .all() as unknown as RuntimeCatalogMetaRow[]
    return rows.map(runtimeCatalogMetaFromRow)
  }

  listRuntimeModelCaps(runtimeId?: string): RuntimeModelCapRecord[] {
    const rows = (runtimeId !== undefined
      ? this.db.prepare('SELECT * FROM runtime_model_catalog WHERE runtimeId = ? ORDER BY modelId ASC').all(runtimeId)
      : this.db
          .prepare('SELECT * FROM runtime_model_catalog ORDER BY runtimeId ASC, modelId ASC')
          .all()) as unknown as RuntimeModelCapRow[]
    return rows.map((row) => ({
      runtimeId: row.runtimeId,
      modelId: row.modelId,
      fingerprint: row.fingerprint,
      caps: parseJsonColumn<RuntimeModelCapRecord['caps']>(row.capsJson) ?? {},
      observedAt: row.observedAt
    }))
  }

  /** Startup GC (§4 rule 6): drop rows unseen for the caller-computed retention window
   *  (30 days) from both tables, so uninstalled runtimes cannot accumulate forever. */
  gcRuntimeCatalog(cutoffEpochMs: number): void {
    this.db.prepare('DELETE FROM runtime_catalog_meta WHERE observedAt < ?').run(cutoffEpochMs)
    this.db.prepare('DELETE FROM runtime_model_catalog WHERE observedAt < ?').run(cutoffEpochMs)
  }

  close(): void {
    this.db.close()
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
