import { z } from 'zod'
import { SessionKey } from './route.js'
import { WebchatImageAttachment } from './webchat.js'

/**
 * Session read-back (C→D REQ → REP) — the console's on-demand pulls.
 *
 * Session bodies are daemon-local (body-locality, §1/§12). The CP may persist a
 * metadata-only session-list snapshot from daemon `event/session` events, while
 * transcript/tool bodies are pulled live from the owning daemon and proxied to
 * the console only for display.
 *
 * - `session/list`: the daemon's local metadata projection, used for snapshots
 *   and direct read-back/debugging.
 * - `session/history`: one cursor-paginated page of a session's transcript.
 */

/**
 * Per-session token accounting, metered by the daemon from the agent's ACP usage
 * stream. Token counts are CUMULATIVE across the session's turns (summed from each
 * turn's `PromptResponse.usage`); context/cost are the LATEST snapshot from the
 * agent's `usage_update` stream. Every field is optional — a runtime that reports
 * no usage yields an absent field, not a zero.
 */
export const SessionUsage = z.object({
  totalTokens: z.number().int().optional(),
  inputTokens: z.number().int().optional(),
  outputTokens: z.number().int().optional(),
  thoughtTokens: z.number().int().optional(),
  cachedReadTokens: z.number().int().optional(),
  cachedWriteTokens: z.number().int().optional(),
  contextUsed: z.number().int().optional(), // current context-window occupancy
  contextSize: z.number().int().optional(), // context-window size
  costAmount: z.number().optional(), // running session cost
  costCurrency: z.string().optional()
})
export type SessionUsage = z.infer<typeof SessionUsage>

/** One row in the session list (metadata + console metrics; NOT the transcript). */
export const SessionListItem = z.object({
  sessionId: z.string(), // the session's opaque outward identity (session-concept.md §1.1) — never the ACP hop's id
  // The stable ACP session id that spawned this session through sendMessage.
  // Absent for root sessions. This is lineage metadata only, never a body.
  parentSessionId: z.string().optional(),
  sessionKey: SessionKey, // platform/channel/thread — drives the "integration · channel" column
  agentId: z.string().uuid(),
  title: z.string().optional(), // human-facing session title (daemon-derived)
  status: z.string().optional(), // e.g. "plan" / "completed" / "awaiting approval"
  lastActivityAt: z.string().optional(), // ISO/string ts of the last activity
  usage: SessionUsage.optional(), // per-session token/cost accounting (daemon-metered)
  triggeredBy: z.string().optional(), // sender handle/id that triggered/drove the run
  // Human-readable display names, resolved + cached by the daemon (the only side
  // holding platform credentials). Always optional — the raw ids above stay the
  // canonical identity; absent when the daemon hasn't resolved them (yet).
  channelName: z.string().optional(), // "general" for a Slack "C…" channel; "@Dana Reyes" for a "D…" DM
  triggeredByName: z.string().optional(), // display name for `triggeredBy`
  // Platform-native deep link back to the source message/thread. The daemon
  // either captures the provider URL at ingress or derives it from the owning
  // integration. Optional when the platform exposes no addressable source.
  threadUrl: z.string().optional()
})
export type SessionListItem = z.infer<typeof SessionListItem>

/** C→D REQ: list the daemon's sessions (optionally just one agent's). */
export const SessionListReq = z.object({
  agentId: z.string().uuid().optional() // omit ⇒ all this daemon's sessions
})
export type SessionListReq = z.infer<typeof SessionListReq>

/** D→C REP (corr = req id): the daemon's current sessions. */
export const SessionListPage = z.object({
  sessions: z.array(SessionListItem)
})
export type SessionListPage = z.infer<typeof SessionListPage>

/**
 * The full ACP tool body, transported as a JSON STRING in `SessionMessage.body`.
 * Kept structurally faithful to the ACP `ToolCall`; free-form fields stay opaque
 * (`z.unknown()`) so no daemon-side redaction/reshaping is implied.
 */
export const ToolBody = z.object({
  toolCallId: z.string(),
  kind: z.string().optional(), // ACP ToolKind: read|edit|delete|move|search|execute|think|fetch|switch_mode|other
  status: z.string().optional(), // ACP ToolCallStatus: pending|in_progress|completed|failed
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
  content: z.array(z.unknown()).optional(), // ACP ToolCallContent[] kept opaque (content|diff|terminal blocks)
  locations: z.array(z.object({ path: z.string(), line: z.number().int().optional() })).optional(),
  truncated: z.boolean().optional() // set when the daemon capped the stored body at write time
})
export type ToolBody = z.infer<typeof ToolBody>

/** One bounded webchat image persisted only in the daemon-local transcript. */
export const SessionImageAttachment = WebchatImageAttachment
export type SessionImageAttachment = z.infer<typeof SessionImageAttachment>

/** One message in a session transcript page (a body — returned only for display). */
export const SessionMessage = z.object({
  seq: z.number().int(), // daemon-local insertion order within the session
  sender: z.string(), // platform handle/id of the author
  senderName: z.string().optional(), // display name (daemon-resolved; absent if unknown)
  senderAvatarUrl: z.string().url().optional(), // public provider profile image; absent if unavailable
  // Daemon-verified AgentConnect Slack app/bot provenance. Optional for rolling
  // compatibility and absent on legacy rows or every non-Slack transport.
  trustedAgentBot: z.boolean().optional(),
  ts: z.string(), // platform timestamp (daemon-local string form)
  // Normalized chronological coordinate (epoch µs) from the daemon's event-time
  // axis — provider-authoritative when the platform supplied its send time.
  // Absent on legacy rows; consumers fall back to deriving it from `ts`.
  eventTimeUs: z.number().int().positive().optional(),
  // Canonical webchat post identity (merged-conversation-view.md §6): minted once
  // at origin and identical on every participant's copy, independent of a
  // collision-bumped `ts`. Absent on non-webchat rows and pre-upgrade rows.
  postId: z.string().uuid().optional(),
  kind: z.string(), // "text" / tool / … (daemon transcript kind)
  text: z.string(),
  attachments: z.array(SessionImageAttachment).max(1).optional(),
  // ── tool-body enrichment (optional ⇒ text/reasoning rows and old daemons omit these) ──
  toolCallId: z.string().optional(), // parsed from the ToolBody (tool rows only)
  toolStatus: z.string().optional(), // ACP ToolCallStatus, surfaced for the console badge
  toolKind: z.string().optional(), // ACP ToolKind, surfaced for the console icon
  body: z.string().optional(), // JSON.stringify(ToolBody); may be a truncated-but-VALID-JSON preview
  bodyTruncated: z.boolean().optional(), // preview was shrunk for the frame; full body via session/tool-body
  bodyBytes: z.number().int().optional() // full (untruncated) body byte length
})
export type SessionMessage = z.infer<typeof SessionMessage>

/** C→D REQ: fetch one page of a session's history from the owning daemon. */
export const SessionHistoryReq = z
  .object({
    // Optional only for rolling compatibility with an older CP. A current CP always
    // sends the authorized owner and the daemon re-checks the session binding.
    agentId: z.string().uuid().optional(),
    sessionId: z.string(), // the session's opaque outward identity (session-concept.md §1.1) — never the ACP hop's id
    cursor: z.string().optional(), // opaque; omit ⇒ newest page
    // Monotonic daemon-local transcript revision. Mutually exclusive with the
    // backward-pagination cursor; used by an open console view to pull inserts
    // and same-seq tool updates without replaying the whole transcript.
    after: z
      .string()
      .regex(/^\d+$/)
      .refine((value) => Number.isSafeInteger(Number(value)))
      .optional(),
    limit: z.number().int().positive().max(200).default(50)
  })
  .refine(({ cursor, after }) => cursor === undefined || after === undefined, {
    message: 'cursor and after are mutually exclusive'
  })
export type SessionHistoryReq = z.infer<typeof SessionHistoryReq>

/** D→C REP (corr = the req id): a page of messages + the cursor for the next page. */
export const SessionHistoryPage = z.object({
  sessionId: z.string(), // the session's opaque outward identity (session-concept.md §1.1) — never the ACP hop's id
  messages: z.array(SessionMessage), // chronological oldest→newest within the page (seq breaks equal-time ties)
  nextCursor: z.string().optional(), // absent ⇒ no older messages
  // Optional for rolling compatibility. `liveCursor` is the next `after`
  // watermark; `liveMore` means another forward page is immediately available.
  liveCursor: z.string().optional(),
  liveMore: z.boolean().optional()
})
export type SessionHistoryPage = z.infer<typeof SessionHistoryPage>

/**
 * C→D REQ: fetch the FULL (untruncated) ToolBody JSON for one tool call, chunked.
 * The inline `SessionMessage.body` preview is capped at 32 KiB; when a body is
 * bigger the console pages the whole thing back through this frame by offset.
 */
export const SessionToolBodyReq = z.object({
  // Optional only for rolling compatibility with an older CP; see SessionHistoryReq.
  agentId: z.string().uuid().optional(),
  sessionId: z.string(),
  toolCallId: z.string(),
  offset: z.number().int().nonnegative().default(0)
})
export type SessionToolBodyReq = z.infer<typeof SessionToolBodyReq>

/** D→C REP (corr = the req id): one frame-budgeted byte slice of the full ToolBody JSON. */
export const SessionToolBodyChunk = z.object({
  sessionId: z.string(),
  toolCallId: z.string(),
  data: z.string(), // UTF-8-boundary-safe byte slice of the FULL ToolBody JSON
  totalBytes: z.number().int(),
  nextOffset: z.number().int().optional() // absent ⇒ this is the last chunk
})
export type SessionToolBodyChunk = z.infer<typeof SessionToolBodyChunk>

/**
 * session-concept §5.4 — the shared shape of a child-session status answer, returned by BOTH
 * legs of a cross-daemon status read (`session/child-status/ok` from the CP to the asking daemon,
 * and `session/child-status/probe/ok` from the owning daemon to the CP).
 *
 * `found:false` is deliberately the single negative outcome for "unknown session" AND "not your
 * child": distinguishing them would let a caller probe for the existence of sessions it may not
 * read, which is exactly what the daemon-local path also refuses to do. `reason` describes only
 * TRANSPORT-level failure (the owning daemon is unreachable), never an authorization verdict.
 */
export const ChildSessionStatus = z.object({
  found: z.boolean(),
  /** The agent that owns the child session. Present only when `found`. */
  agentId: z.string().uuid().optional(),
  /** Coarse progress, collapsed by the OWNING daemon from its own session lifecycle. */
  status: z.enum(['in-progress', 'failed', 'done']).optional(),
  /** The underlying lifecycle state, for a caller that wants the detail. */
  state: z.enum(['starting', 'idle', 'prompting', 'cancelling', 'resuming', 'closed']).optional(),
  /** Epoch ms of the child's last state change. */
  updatedAt: z.number().int().optional(),
  /** Optional during rolling upgrades; current daemons always return it for found children. */
  reply: z
    .object({
      requested: z.boolean(),
      state: z.enum(['not-requested', 'awaiting', 'queued-for-parent', 'not-sent', 'failed', 'unknown'])
    })
    .optional(),
  nextAction: z.enum(['none', 'wait', 'finish-turn-and-wait', 'report-failure', 'report-missing-reply']).optional(),
  message: z.string().optional(),
  /** Transport-level failure only: the owning daemon is not currently reachable. */
  reason: z.enum(['offline']).optional()
})
export type ChildSessionStatus = z.infer<typeof ChildSessionStatus>

/**
 * D→C REQ: "what is the status of a child session my session started, which lives on ANOTHER
 * daemon?" The CP is the placement authority, so it resolves `childAgentId` to the owning daemon
 * and forwards the question there — the daemon never addresses another daemon directly.
 *
 * AUTHORIZATION IS TWO-SIDED. The CP verifies that `parentSessionId` really is a session reported
 * by the ASKING daemon (a daemon cannot claim someone else's parent session), and the owning
 * daemon then verifies that the child's durable origin link actually equals `parentSessionId`.
 * Neither check alone is sufficient: the first stops a forged parent claim, the second is the
 * real lineage rule and is enforced where the session lives.
 */
export const ChildSessionStatusReq = z.object({
  /** The ASKING session's own stable acpSessionId. The CP validates ownership of this. */
  parentSessionId: z.string().min(1),
  /** The child's logical session key, exactly as `sendMessage` handed it back. Opaque to the CP. */
  childSessionId: z.string().min(1),
  /** The child agent, so the CP can resolve placement without parsing the composite key. */
  childAgentId: z.string().uuid()
})
export type ChildSessionStatusReq = z.infer<typeof ChildSessionStatusReq>

/**
 * C→D REQ: the forwarded leg of {@link ChildSessionStatusReq}, sent to the daemon that OWNS the
 * child. `childAgentId` is dropped — placement is already resolved — leaving exactly the lineage
 * pair the owning daemon authorizes on. The CP does not persist or interpret the answer.
 */
export const ChildSessionStatusProbe = z.object({
  parentSessionId: z.string().min(1),
  childSessionId: z.string().min(1)
})
export type ChildSessionStatusProbe = z.infer<typeof ChildSessionStatusProbe>

/**
 * C→D REQ → `session/visibility/ok` (session-visibility.md §5.1): the CP pushes
 * a session's authoritative effective visibility so the owning daemon updates
 * its local memory-capture gate. Control signaling only — one privacy bit per
 * session, never content.
 *
 * `visibilityRev` is the session's dedicated durable visibility counter
 * (bumped in the same CP transaction as every visibility change, settlement,
 * and cascade). It is deliberately NOT the transcript revision nor the WS
 * `sessionEpoch`/`seq` fences — those are connection/launch-scoped and do not
 * advance with visibility. Delivery is at-least-once; the rev makes duplicate
 * and out-of-order application safe on the daemon.
 */
export const SessionVisibilityPush = z.object({
  sessionId: z.string().min(1), // the session's opaque outward identity (session-concept.md §1.1) — never the ACP hop's id
  // The session's owning agent. ACP session ids are runtime-local, so on a pool's
  // shared store the id alone names a gate every org could claim. Optional for
  // rolling upgrades: an older CP omits it and the daemon attributes the push to
  // the sole local holder, or leaves the gate closed when there is no single one.
  agentId: z.string().min(1).optional(),
  visibility: z.enum(['private', 'org', 'external']),
  // New daemons use this explicit capture/recall verdict. It is optional for
  // wire compatibility with older CPs and decouples the runtime safety gate
  // from the console visibility vocabulary.
  sharedMemoryExcluded: z.boolean().optional(),
  visibilityRev: z.number().int().nonnegative()
})
export type SessionVisibilityPush = z.infer<typeof SessionVisibilityPush>

/**
 * D→C REP (corr = the push's id). `status` reports how the daemon settled the
 * push: `applied` = the rev advanced its stored gate state; `superseded` = the
 * rev is ≤ the stored one, so nothing was reapplied — but the frame is STILL
 * acknowledged (never answered with an `error` frame): "ignore" must never
 * mean "don't ACK", or a lost ACK leaves the CP retrying forever. The CP
 * records the ack watermark on either status.
 */
export const SessionVisibilityOk = z.object({
  sessionId: z.string().min(1),
  visibilityRev: z.number().int().nonnegative(),
  status: z.enum(['applied', 'superseded'])
})
export type SessionVisibilityOk = z.infer<typeof SessionVisibilityOk>

/**
 * C→D REQ → generic `ack` (session-visibility.md §5.1): the register-time
 * replay of the current `(sessionId, visibility, visibilityRev)` set for the
 * daemon's active sessions — a snapshot, not a diff — closing the window
 * where a visibility change happened while the daemon was offline. Each entry
 * applies with the same rev semantics as a single push; a stale entry is
 * skipped, never an error. Chunked by the CP; ≤ 1000 entries per frame keeps
 * it far under the frame-size cap.
 */
export const SessionVisibilitySnapshot = z.object({
  entries: z.array(SessionVisibilityPush).max(1000)
})
export type SessionVisibilitySnapshot = z.infer<typeof SessionVisibilitySnapshot>

/** Body-free GitHub signal that asks the daemon to continue an existing PR session. */
export const PullRequestFeedbackKind = z.enum(['review', 'review_comment', 'comment', 'ci_failure'])
export type PullRequestFeedbackKind = z.infer<typeof PullRequestFeedbackKind>

export const PullRequestFeedbackEvent = z.enum([
  'pull_request_review:submitted',
  'pull_request_review_comment:created',
  'pull_request_review_comment:edited',
  'issue_comment:created',
  'issue_comment:edited',
  'check_suite:completed'
])
export type PullRequestFeedbackEvent = z.infer<typeof PullRequestFeedbackEvent>

/** R→C persistence request. It contains routing/control metadata only; review bodies and CI logs stay off the CP. */
export const PullRequestFeedbackSignal = z.object({
  deliveryKey: z.string().min(1).max(200),
  installationId: z.string().regex(/^[1-9]\d*$/),
  repoId: z.string().regex(/^[1-9]\d*$/),
  repoFullName: z.string().min(3).max(300),
  pullNumber: z.number().int().positive(),
  event: PullRequestFeedbackEvent,
  kind: PullRequestFeedbackKind,
  detail: z.string().min(1).max(80).optional(),
  observedAt: z.string().datetime()
})
export type PullRequestFeedbackSignal = z.infer<typeof PullRequestFeedbackSignal>

/** C→D exact-session continuation. The daemon constructs the prompt locally and fetches GitHub content itself. */
export const SessionPullRequestFeedback = PullRequestFeedbackSignal.omit({
  installationId: true,
  observedAt: true
}).extend({
  agentId: z.string().uuid(),
  sessionId: z.string().min(1)
})
export type SessionPullRequestFeedback = z.infer<typeof SessionPullRequestFeedback>

export const SessionPullRequestFeedbackResult = z.object({
  deliveryKey: z.string().min(1).max(200),
  accepted: z.boolean(),
  reason: z
    .enum(['not_found', 'not_ready', 'paused', 'busy', 'draining', 'integration_offline', 'durability'])
    .optional()
})
export type SessionPullRequestFeedbackResult = z.infer<typeof SessionPullRequestFeedbackResult>
