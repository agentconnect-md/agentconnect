import { z } from 'zod'
import { ReportedCostAmount } from '../decimal-amount.js'
import { SessionUsage } from './session.js'
import { Platform } from './route.js'
import { HeartbeatDuties } from './duty.js'

/**
 * Telemetry & facts (D→C) — protocol §7.
 *
 * The dashboard's real-time source. `event/session` is the converged milestone
 * feed (NOT the message stream); `facts/daemon-runtimes` is the observed runtime
 * capability feed; `heartbeat` drives the watchdog.
 */

export const Heartbeat = z.object({
  load: z.object({
    cpu: z.number(), // 0..1 CPU utilization fraction (busy-time across cores) — NOT a raw load average
    mem: z.number(), // 0..1 utilization fraction
    agents: z.number().int()
  }),
  health: z.enum(['ok', 'degraded']),
  activeSessions: z.number().int(),
  degradedScopes: z.array(z.string()).default([]), // e.g. expired-lease bindings (§6)
  // Duty lease exchange (k8s daemons only; frames/duty.ts). Absent ⇒ this daemon
  // does not participate in the duty ledger and the CP-side path stays dormant.
  duties: HeartbeatDuties.optional()
})
export type Heartbeat = z.infer<typeof Heartbeat>

const ExternalKey = z.string().min(1).max(200)
const GithubId = z.string().regex(/^[1-9]\d*$/)

/** Immutable audience identity inherited by A2A descendants. Credential proof
 * stays on the direct root only; children inherit this tuple from their parent. */
export const ExternalSessionAudience = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('slack'),
    realmKey: ExternalKey.optional(),
    resourceKind: z.literal('conversation'),
    resourceKey: ExternalKey
  }),
  z.object({
    provider: z.literal('feishu'),
    realmKey: ExternalKey.optional(),
    resourceKind: z.literal('conversation'),
    resourceKey: ExternalKey
  }),
  z.object({
    provider: z.literal('github'),
    realmKey: z.literal('github.com'),
    resourceKind: z.literal('repository'),
    // Rename-proof GitHub repository id, never owner/repo.
    resourceKey: GithubId
  })
])
export type ExternalSessionAudience = z.infer<typeof ExternalSessionAudience>

/** Direct-ingress audience plus the provider-specific proof the CP validates
 * before binding a durable ExternalScope. */
export const ExternalSessionOrigin = z.discriminatedUnion('provider', [
  ExternalSessionAudience.options[0].extend({
    integrationId: z.string().uuid().optional()
  }),
  ExternalSessionAudience.options[1].extend({
    integrationId: z.string().uuid().optional()
  }),
  ExternalSessionAudience.options[2].extend({
    hookId: z.string().uuid(),
    deliveryKey: ExternalKey,
    sourceInstallationId: GithubId,
    // Trusted webhook snapshot; display/API-routing hint only. repoId above is
    // the authorization identity and must still match the accepted HookRun.
    repoFullName: ExternalKey
  })
])
export type ExternalSessionOrigin = z.infer<typeof ExternalSessionOrigin>

/** Converged session lifecycle milestone — protocol §7.2. NOT the message stream. */
export const EventSession = z.object({
  sessionId: z.string(), // the session's outward identity (session-concept.md §1.1), never the ACP hop's
  // Stable ACP session id of the session that spawned this one. Absent for roots.
  // Stored as metadata so the console can navigate the session family.
  parentSessionId: z.string().optional(),
  agentId: z.string().uuid(),
  launchId: z.string().uuid().optional(), // 🅰️ CP launch fence — absent for sessions created on the Slack/Discord→daemon path (no CP-initiated launch)
  phase: z.enum(['start', 'plan', 'problem', 'end']),
  // sessionKey echo — where the session lives; the CP stores it so a deep-link
  // detail page (…/sessions/:id) can show the channel without the daemon online.
  platform: Platform.optional(),
  channel: z.string().optional(),
  thread: z.string().optional(),
  link: z.string().optional(), // deep-link to detail view
  summary: z.string().optional(), // short, human-facing milestone text
  // Dashboard-list metadata snapshot. Still metadata-only: no message bodies,
  // transcript stream, attachment bytes, or tool payloads cross into the CP store.
  title: z.string().optional(),
  status: z.string().optional(),
  lastActivityAt: z.string().datetime().optional(),
  triggeredBy: z.string().optional(),
  channelName: z.string().optional(),
  triggeredByName: z.string().optional(),
  threadUrl: z.string().optional(),
  // ── visibility classification inputs (session-visibility.md §4.1) ──
  // What kind of conversation the session lives in, from the daemon's own
  // NormalizedMessage.isDm/isGroupDm. Absent (old daemon) ⇒ 'channel' behavior,
  // i.e. the CP classifies the session `org`.
  conversationKind: z.enum(['dm', 'group_dm', 'channel']).optional(),
  // DURABLE workspace/tenant scope for ownerIdentity (§2) — a Slack team id,
  // Feishu tenant key, or a minted stable per-integration scope. NOT the
  // daemon's credential-derived transport scope (that rotates with tokens).
  // Absent ⇒ the CP records no IM owner (fail closed).
  transportScope: z.string().min(1).max(200).optional(),
  // Web API launch provenance (§4.4): the correlation id the CP minted on
  // `agent/launch`, echoed back so ingest can attribute the session to the
  // launching console user. NOT the launchId fence above.
  launchCorrelationId: z.string().uuid().optional(),
  // Durable daemon-local source provenance. `local` distinguishes synthetic or
  // otherwise non-provider sessions that retain platform-shaped coordinates
  // for session-key compatibility. Absent keeps mixed-version ingest on the
  // conservative legacy path.
  sourceBindingKind: z.enum(['local', 'external']).optional(),
  // This session's coordinates ARE its own conversation — an agent's channel-ROOT
  // post, or a peer woken by a platform-observed mention there. Its `parentSessionId`
  // is lineage, not an audience ancestor: the row classifies by the conversation it
  // lives in instead of inheriting one it was never posted to (§4.2). Absent keeps
  // the ordinary child-inheritance path.
  directDestination: z.literal(true).optional(),
  // Immutable audience candidate for a supported shared input. This is
  // metadata-only: the CP validates the integration before binding a scope and
  // resolves current provider membership only on authorized read paths.
  externalOrigin: ExternalSessionOrigin.optional(),
  // Effective execution-config snapshot: what the session actually ran with
  // (per-session sticky override, else the agent's config at run time; absent ⇒
  // the runtime's own default). Recorded so the console shows what a session
  // USED, not the owning agent's config at view time. The reporting daemon is
  // NOT echoed here — the CP stamps it from the authenticated WS connection.
  runtime: z.string().optional(),
  model: z.string().optional(),
  // Runtime observation for this milestone. `null` means the runtime exposed
  // only an opaque/default model; absent is a legacy/config-only snapshot. New
  // readers prioritize this over `model`, while old readers safely ignore it.
  observedModel: z.string().nullable().optional(),
  effort: z.string().optional(), // reasoning effort level (runtime-owned vocabulary)
  fastMode: z.boolean().optional(),
  // Effective session permission preset. Usually the runtime-owned mode; Codex Auto
  // is the AgentConnect composite value that the daemon decomposes before ACP.
  permissionMode: z.string().optional(),
  outputMode: z.string().optional(), // daemon-side output verbosity (none/minimal/low/medium/high)
  // Workspace choice pinned when the logical session was created. This is
  // metadata only; it lets the console offer a link to an isolated worktree
  // without assuming the Agent's current setting still matches this session.
  workspaceIsolation: z.enum(['shared', 'session']).optional(),
  ts: z.string().datetime()
})
export type EventSession = z.infer<typeof EventSession>

/**
 * Metadata-only transcript invalidation. Message/tool bodies remain daemon-local;
 * an authorized browser uses this signal to pull the changed rows through
 * `session/history.after`.
 */
export const SessionActivity = z.object({
  sessionId: z.string(),
  agentId: z.string().uuid(),
  revision: z.string().regex(/^\d+$/),
  ts: z.string().datetime()
})
export type SessionActivity = z.infer<typeof SessionActivity>

/** Why a daemon dropped a session's local content. Only the retention sweep
 *  (#485) purges autonomously today; the vocabulary is an enum so an explicit
 *  operator-initiated delete can join it without a frame revision. */
export const SessionPurgeReason = z.enum(['retention'])
export type SessionPurgeReason = z.infer<typeof SessionPurgeReason>

/**
 * Retention-GC receipt — D→C REQ, answered with the generic `ack` (#485).
 *
 * The daemon deleted these sessions' local rows (and any per-session worktree)
 * after `sessions.retention` elapsed, so their transcripts can never be pulled
 * again. The CP keeps the metadata row and MARKS it purged — that is what lets
 * the console explain an empty transcript instead of rendering it as "this
 * session said nothing".
 *
 * Correlated rather than fire-and-forget precisely because the local row is
 * already gone: an unacknowledged report cannot be re-derived from daemon state
 * later, so the daemon holds a durable receipt until this ACKs. Delivery is
 * therefore at-least-once and the CP applies it idempotently (a re-reported
 * session keeps its first `contentPurgedAt`).
 */
export const SessionPurged = z.object({
  // One agent per frame: the CP authorizes the report by checking that THIS
  // agent is placed on the reporting daemon, the same trust boundary as
  // `event/session`. A sweep spanning several agents sends several frames.
  agentId: z.string().uuid(),
  // The purged sessions' outward ids (§1.1) — the rows these receipts mark over there. Batched
  // because a single sweep commonly expires many sessions at once; capped well under the frame
  // budget so the daemon chunks instead of overflowing the wire.
  sessionIds: z.array(z.string().min(1)).min(1).max(200),
  reason: SessionPurgeReason,
  ts: z.string().datetime()
})
export type SessionPurged = z.infer<typeof SessionPurged>

/** A report's usage: `SessionUsage`, except that the cost may arrive as the exact
 *  decimal string OR as a JSON number from a daemon that predates it. Only the
 *  REPORT accepts the union — the CP's ingress adapter normalizes to the decimal
 *  string, so storage and every reader downstream see one money shape. */
export const ReportedSessionUsage = SessionUsage.extend({ costAmount: ReportedCostAmount.optional() })
export type ReportedSessionUsage = z.infer<typeof ReportedSessionUsage>

/**
 * Per-session token-usage report — D→C EVT. The daemon meters usage from the
 * agent's ACP stream and reports the session's CUMULATIVE snapshot (latest-wins)
 * so the CP can persist it for the console's historical usage aggregates. This is
 * dashboard metadata (token counts + cost), never the message stream. Idempotent
 * by `sessionId`: re-sending the same snapshot is a no-op upsert on the CP.
 */
export const UsageReport = z.object({
  sessionId: z.string(), // the session's outward identity (§1.1) — the same id the gateway meters under
  agentId: z.string().uuid(),
  platform: z.string().optional(), // denormalized sessionKey echo for dashboard filters
  channel: z.string().optional(),
  // The model observed for the usage delta ending at this cumulative snapshot.
  // `null` is an explicit runtime-owned default/unknown; absent is an old daemon.
  observedModel: z.string().nullable().optional(),
  lastActivityAt: z.string(), // ISO ts of the session's last activity
  usage: ReportedSessionUsage
})
export type UsageReport = z.infer<typeof UsageReport>

/**
 * Observed capabilities of an installed runtime — protocol §7.3. The element
 * type of the `facts/daemon-runtimes` snapshot. As a standalone per-runtime
 * frame (`facts/runtime-profile`, upsert-only) it is DEPRECATED: current
 * daemons report the full snapshot instead; the CP keeps accepting the old
 * frame from older daemons.
 */
/**
 * MCP transports a runtime accepts on `session/new` `mcpServers` (from the ACP
 * `initialize` response's `agentCapabilities.mcpCapabilities`). Stdio is the ACP
 * baseline every agent must accept, so only the optional transports are listed.
 */
export const McpTransportCapabilities = z.object({
  http: z.boolean(),
  sse: z.boolean()
})
export type McpTransportCapabilities = z.infer<typeof McpTransportCapabilities>

/**
 * One thought-level (reasoning-effort) choice a model offers — value is the
 * wire vocabulary the runtime accepts; name/description are display metadata
 * straight from the runtime's select options (or catalog driver), when present.
 */
export const EffortOption = z.object({
  value: z.string(),
  name: z.string().optional(),
  description: z.string().optional()
})
export type EffortOption = z.infer<typeof EffortOption>

/** One runtime permission-mode choice. The display metadata is forwarded
 *  verbatim from the runtime's ACP `category: "mode"` select option. */
export const PermissionModeOption = z.object({
  value: z.string(),
  name: z.string().optional(),
  description: z.string().optional()
})
export type PermissionModeOption = z.infer<typeof PermissionModeOption>

/**
 * Per-model capability entry of a runtime's model catalog (design doc
 * runtime-model-catalog.md). `efforts` carries the thought_level vocabulary the
 * daemon will actually offer when this model is selected (daemon-side synthetic
 * levels included): `[]` = the model has no effort selector; absent = not yet
 * discovered. `fastMode` mirrors whether the model_config fast toggle appears
 * for this model; absent = unknown.
 */
export const RuntimeModelCapability = z.object({
  id: z.string(), // model-selector value
  name: z.string().optional(), // display name (sent only when it differs from id)
  efforts: z.array(EffortOption).optional(),
  defaultEffort: z.string().optional(),
  fastMode: z.boolean().optional()
})
export type RuntimeModelCapability = z.infer<typeof RuntimeModelCapability>

/**
 * A runtime's discovered model × config capability matrix. One shape shared by
 * the wire, the CP's `runtime_profile.modelCatalog` JSONB column, and the DTO —
 * no field renames between layers.
 */
export const RuntimeModelCatalog = z.object({
  models: z.array(RuntimeModelCapability).max(128),
  defaultModel: z.string().optional(), // resolved concrete model id (never the literal "default")
  permissionModes: z.array(PermissionModeOption).optional(),
  // The mode select's currentValue on a fresh probe session — the runtime's own
  // default permission mode (e.g. copilot 'agent'). Absent = not observed.
  defaultPermissionMode: z.string().optional(),
  source: z.enum(['native', 'acp']), // native = catalog driver, acp = per-model enumeration / probe seed
  observedAt: z.string().datetime()
})
export type RuntimeModelCatalog = z.infer<typeof RuntimeModelCatalog>

export const FactsRuntimeProfile = z.object({
  runtime: z.string(), // "claude" / "codex" / ...
  version: z.string(),
  models: z.array(z.string()),
  contextWindow: z.number().int().optional(),
  acpSupport: z.enum(['full', 'partial', 'none']), // gates the dual-mode decision (#1)
  // ACP protocol version the runtime negotiated at `initialize` (the number the
  // agent echoed/downgraded to). Absent for older daemons / runtimes not probed yet.
  acpProtocolVersion: z.number().int().optional(),
  toolCalling: z.boolean(),
  // MCP transports the runtime advertised at `initialize`. Absent for older
  // daemons / runtimes not probed yet (⇒ assume stdio-only).
  mcpCapabilities: McpTransportCapabilities.optional(),
  // Provenance of `models[]`: 'cached' = hydrated from the daemon's local
  // last-good catalog cache (a live probe has not confirmed it this process) —
  // capability gates (agent move / activation model checks) MUST treat it as
  // permissive, exactly like an empty list; 'probed' = confirmed by a live
  // probe. Absent ⇒ 'probed' semantics.
  modelsSource: z.enum(['cached', 'probed']).optional(),
  // The last probe was rejected with the ACP auth-required error (-32000): the
  // runtime is installed but needs an interactive login on the daemon host
  // before sessions can start. Cleared (absent) once a probe succeeds; absent
  // also for older daemons that don't report it.
  authRequired: z.boolean().optional(),
  // Discovered model × config capability matrix (last-good; survives probe
  // failures — advertisement (`models`) empties on failure, capability
  // knowledge does not). Absent = this daemon has no catalog for the runtime.
  modelCatalog: RuntimeModelCatalog.optional()
})
export type FactsRuntimeProfile = z.infer<typeof FactsRuntimeProfile>

/**
 * One daemon-configured MCP server (daemon config `mcpServers`), surfaced so the
 * console can list the servers an agent may enable. Name + transport only —
 * derived directly from config; the daemon does NOT connect to the server.
 * Definitions (commands, URLs, headers) stay daemon-local.
 */
export const FactsMcpServer = z.object({
  name: z.string(), // config key; what AgentSpec.mcpServers references
  transport: z.enum(['stdio', 'http', 'sse'])
})
export type FactsMcpServer = z.infer<typeof FactsMcpServer>

/**
 * Full snapshot of the daemon's installed runtimes — D→C EVT (protocol §7.3a),
 * emitted on each register and again once the background probe sweep completes
 * (with the learned `models[]`). REPLACE semantics: the CP reconciles its
 * stored runtime list for the daemon to exactly `runtimes[]`, pruning runtimes
 * that are no longer installed. Idempotent (latest-wins). Supersedes the
 * per-runtime `facts/runtime-profile` upsert.
 */
export const DaemonRuntimes = z.object({
  runtimes: z.array(FactsRuntimeProfile),
  // Daemon-level (not per-runtime) MCP-server list (name + transport, from
  // config) — same REPLACE semantics as `runtimes`. Default [] so older daemons
  // parse clean.
  mcpServers: z.array(FactsMcpServer).default([]),
  // Per-connection monotonic snapshot ordinal. The CP resets its stored value
  // on register and ignores snapshots whose seq is <= the stored one, so two
  // frames whose DB transactions interleave (sweep frame vs catalog frame; the
  // CP dispatches inbound frames without awaiting) cannot commit out of order.
  // Absent (older daemon) ⇒ latest-commit-wins as before.
  seq: z.number().int().optional()
})
export type DaemonRuntimes = z.infer<typeof DaemonRuntimes>

/** Non-secret config update — C→D EVT, protocol §8.3 / frame #26. */
export const ConfigPush = z.object({
  keys: z.record(z.string(), z.unknown())
})
export type ConfigPush = z.infer<typeof ConfigPush>

/** Auth-time upgrade result, legal before full registration. */
export const DaemonBootstrapResult = z.object({
  operationId: z.string(),
  status: z.enum(['installed', 'failed']),
  reason: z.string().max(500).optional()
})
export type DaemonBootstrapResult = z.infer<typeof DaemonBootstrapResult>

/** Fleet: drain+exit, supervisor restarts — C→D REQ, protocol §8.3 / frame #27. */
export const DaemonRestart = z.object({
  reason: z.string(),
  drainFirst: z.boolean().default(true)
})
export type DaemonRestart = z.infer<typeof DaemonRestart>

/** Fleet: drain+exit for version bump — C→D REQ, protocol §8.3 / frame #28. */
export const DaemonUpgrade = z.object({
  targetVersion: z.string(),
  drainFirst: z.boolean().default(true)
})
export type DaemonUpgrade = z.infer<typeof DaemonUpgrade>

/** Reply to a fleet restart/upgrade REQ (protocol §8.3). */
export const DaemonControlAck = z.object({
  accepted: z.boolean(),
  willDrainUntil: z.string().datetime().optional(),
  // Why the daemon declined (`accepted:false`) — e.g. no supervisor, CLI not
  // locatable, another lifecycle op in flight (cli-daemon-split.md §7.1).
  // Optional + backward-compatible: an older daemon simply omits it.
  reason: z.string().optional()
})
export type DaemonControlAck = z.infer<typeof DaemonControlAck>

/**
 * Generic acknowledgement for REQs whose reply is just `ack` in the frame index
 * (cron/upsert, cron/remove, agent/stop). Kept permissive but typed.
 */
export const Ack = z.object({
  ok: z.boolean(),
  reason: z.string().optional()
})
export type Ack = z.infer<typeof Ack>
