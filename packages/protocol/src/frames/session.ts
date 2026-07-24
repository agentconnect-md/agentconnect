import { z } from 'zod'
import { SessionKey } from './route.js'

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
  sessionId: z.string(), // opaque ACP session id (agent-assigned; NOT a wire UUID)
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
  // Platform-native deep link back to the source thread (e.g. a Slack
  // `…/archives/<C…>/p<ts>` permalink), built by the daemon from the platform
  // credentials it holds. Optional — absent when the daemon can't resolve the
  // workspace URL (yet) or the platform has no addressable thread link.
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

/** One message in a session transcript page (a body — returned only for display). */
export const SessionMessage = z.object({
  seq: z.number().int(), // daemon-local insertion order within the session
  sender: z.string(), // platform handle/id of the author
  senderName: z.string().optional(), // display name (daemon-resolved; absent if unknown)
  ts: z.string(), // platform timestamp (daemon-local string form)
  kind: z.string(), // "text" / tool / … (daemon transcript kind)
  text: z.string(),
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
export const SessionHistoryReq = z.object({
  sessionId: z.string(), // opaque ACP session id (agent-assigned; NOT a wire UUID)
  cursor: z.string().optional(), // opaque; omit ⇒ newest page
  limit: z.number().int().positive().max(200).default(50)
})
export type SessionHistoryReq = z.infer<typeof SessionHistoryReq>

/** D→C REP (corr = the req id): a page of messages + the cursor for the next page. */
export const SessionHistoryPage = z.object({
  sessionId: z.string(), // opaque ACP session id (agent-assigned; NOT a wire UUID)
  messages: z.array(SessionMessage), // chronological oldest→newest within the page (seq breaks equal-time ties)
  nextCursor: z.string().optional() // absent ⇒ no older messages
})
export type SessionHistoryPage = z.infer<typeof SessionHistoryPage>

/**
 * C→D REQ: fetch the FULL (untruncated) ToolBody JSON for one tool call, chunked.
 * The inline `SessionMessage.body` preview is capped at 32 KiB; when a body is
 * bigger the console pages the whole thing back through this frame by offset.
 */
export const SessionToolBodyReq = z.object({
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
