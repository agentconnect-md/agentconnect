import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { hostname, tmpdir } from 'node:os'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { watch as chokidarWatch, type FSWatcher } from 'chokidar'
import { loadConfig, persistDaemonId, persistRelays, type FlatOverrides } from './config/load-config.js'
import type { RuntimeDef } from './config/config-schema.js'
import { loadAgents, selectAgent, type LoadedAgent } from './agents/load-agents.js'
import { agentChildEnv } from './agents/agent-env.js'
import { cpRuntimeEnv } from './agents/cp-overlay.js'
import { diffAgents } from './reconciler/reconciler.js'
import {
  resolveRoot,
  statePath,
  mcpSocketPath,
  delegatedMcpBrokerRoot,
  delegatedMcpRuntimeHomeRoot,
  daemonEntryForShims,
  cliEntryPointer
} from './paths.js'
import {
  LocalStore,
  sessionKey,
  transcriptChannelKey,
  type InboxRow,
  type OrchestrationRow,
  type SessionRecord,
  type SubtaskRow,
  type TranscriptMutation,
  type StoredUsage
} from './store/local-store.js'
import { AcpHost, turnFailureCode, turnFailureReason, type AcpPermissionPolicyEvent } from './acp/acp-host.js'
import {
  delegatedMcpInCellSocketDirectory,
  detectSandbox,
  SandboxError,
  supportsDelegatedMcpIsolation,
  type SandboxMechanism
} from './acp/sandbox.js'
import {
  DelegatedWebchatHostManager,
  type DelegatedWebchatHost,
  type DelegatedWebchatHostFactoryInput,
  type StartDelegatedWebchatHost
} from './acp/delegated-webchat-host-manager.js'
import { effectiveRunInSandbox, prepareRuntimeLaunch } from './acp/runtime-launch.js'
import { permissionModeDisplayLabel } from './acp/permission-modes.js'
import { SessionManager, transcriptCoords, isStandingContextTitleEcho } from './session/session-manager.js'
import { maskableSecrets, maskSecretsDeep } from './session/secret-mask.js'
import { monotonicTs } from './store/monotonic-ts.js'
import { TranscriptRecorder, type TranscriptEvent } from './session/transcript-recorder.js'
import { attachmentMention } from './session/attachment-block.js'
import { McpControlServer } from './mcp/control-server.js'
import { SessionMcpBroker } from './mcp/session-mcp-broker.js'
import { defaultDelegatedMcpMetrics } from './mcp/delegated-metrics.js'
import type {
  MessageAgentReq,
  MessageAgentResult,
  ReplyToSessionReq,
  ReplyToSessionResult,
  SessionStatusReq,
  SessionStatusResult,
  StartOrchestrationReq,
  StartOrchestrationResult,
  OrchestrationOwnerReq,
  SetSessionTitleReq,
  SubmitGithubReviewReq
} from './mcp/ops.js'
import { GitCredentialCache } from './cp/git-credential.js'
import { cleanupConfigFiles, materializeConfigFiles } from './agents/config-file-env.js'
import { writeGhShim } from './cp/gh-shim.js'
import { GitCredServer, gitcredShimPath, gitcredSocketPath, writeGitcredShim } from './cp/gitcred-server.js'
import { gitCredentialEnv, initGitInjection, probeGitVersion, sessionGitEnv } from './workspace/git-injection.js'
import { configureWorkspaceGitOrigins } from './workspace/git-origin-policy.js'
import { buildMcpServers } from './mcp/inject.js'
import { resolveAgentMcpServers, RESERVED_MCP_SERVER_NAME } from './mcp/resolve-servers.js'
import { toolsForIntegrations, MEMORY_TOOL_NAMES, ALL_TOOL_NAMES, GITHUB_REVIEW_TOOLS } from './mcp/tools.js'
import { isSessionTitleToolCall } from './mcp/session-title-tool.js'
import { MEMORY_DISTILLATION_SYSTEM_PROMPT, trustedExtractionMode } from './agents/memory-distiller.js'
import { DreamRunner, DreamStateError, type DreamLifecycleEvent } from './agents/dream-runner.js'
import { createDreamReader } from './cp/dream-reader.js'
import { routeRules, type RouteVia } from './router/routing-table.js'
import { parseCommand, type AgentCommand } from './commands/commands.js'
import {
  rulesFromAgent,
  resolveCpRule,
  resolveAgentIntegration,
  integrationRouting,
  conversationAdmitted,
  type RoutingRule
} from './router/routing-rule.js'
import { CpRoutingLayer } from './router/cp-routing-layer.js'
import {
  consolidate,
  consolidateShared,
  SlackConnection,
  type InteractionActor,
  type SlackPostOptions,
  type SlackStatusOptions
} from './slack/connection.js'
import {
  consolidateTelegram,
  TelegramConnection,
  type TelegramCallback,
  type TelegramObservedChat,
  type InlineButton
} from './telegram/connection.js'
import { consolidateDiscord, DiscordConnection } from './discord/connection.js'
import { collapseDiscordChannels, collapseNameLookupIds } from './discord/channels.js'
import { consolidateFeishu, FeishuConnection, type FeishuStreamingCard } from './feishu/connection.js'
import { SlackNameResolver } from './slack/name-resolver.js'
import { splitIntoSections } from './slack/formatter.js'
import { ChannelNameResolver } from './messages/channel-name-resolver.js'
import {
  cleanupStaleWorkspaceClones,
  convergeGithubAppWorkspaceRename,
  ensureWorkspaceMaterialization,
  isWorkspaceEmpty,
  prepareWorkspaceForActivation,
  prefetchWorkspace
} from './workspace/workspace-manager.js'
import {
  OutputConverger,
  renderStatusBar,
  buildStatusBlocks,
  buildAttributionBlocks,
  buildPermissionCard,
  buildPermissionResolvedCard,
  buildElicitationCard,
  buildElicitationResolvedCard,
  elicitTarget,
  type SlackAction,
  type SlackAttributionInfo,
  type StatusBarInfo,
  type StatusModalIdentity
} from './slack/render.js'
import { TelegramConverger, renderStatusReply, TELEGRAM_MESSAGE_LIMIT, type TelegramAction } from './telegram/render.js'
import {
  DiscordConverger,
  renderStatusText,
  buildDiscordSelectComponents,
  buildLinkComponents,
  type DiscordAction,
  type DiscordComponents
} from './discord/render.js'
import { FeishuConverger, renderStatusReply as renderFeishuStatusReply, type FeishuAction } from './feishu/render.js'
import { Scheduler, buildSyntheticMessage } from './scheduler/scheduler.js'
import { DreamScheduler } from './scheduler/dream-scheduler.js'
import { planChannelIntros, buildIntroMessage } from './agents/channel-intro.js'
import { buildHookMessage, hookAnchorText } from './messages/hook-message.js'
import { GithubFinalPoster, GithubReplyCollector, type GithubCommentAttribution } from './github/poster.js'
import {
  GithubReviewClient,
  type GithubReviewEffect,
  type GithubReviewEvent,
  type GithubReviewTarget,
  type GithubReviewVerdict
} from './github/review.js'
import { resolveRuntimeCatalog, type ResolvedRuntimeCatalog } from './runtimes/registry.js'
import { installedRuntimeCatalog, installedRuntimes, resolveCommandPath } from './runtimes/probe.js'
import {
  probeAllRuntimes,
  isAuthRequiredError,
  sweepStaleProbeRoots,
  type ProbeOptions,
  type RuntimeProbeResult
} from './runtimes/runtime-prober.js'
import { ModelCatalogService, catalogFingerprint } from './runtimes/model-catalog.js'
import { makeModelEnumerator } from './runtimes/model-enumerator.js'
import { capsFromConfigOptions, augmentEffortOptions } from './runtimes/config-caps.js'
import { isClaudeRuntimeDef } from './acp/claude-runtime.js'
import { prepareRuntimeHome, runtimeHomeEnvironment, runtimeHomePath } from './runtimes/runtime-home.js'
import { prepareSharedRuntimeCredentials } from './runtimes/runtime-credentials.js'
import { CuratedRuntimeAdmission } from './runtimes/curated-admission.js'
import { composeRuntimeLaunch, runtimeSandboxReadRoots } from './runtimes/launch-policy.js'
import { resolveTrustedExecutable, trustedRuntimeReadRoots } from './runtimes/read-roots.js'
import { nodeExecArgvModuleEntries } from './runtimes/node-exec-argv.js'
import { makeLogger, type Logger } from './log.js'
import { CpClient, CP_SUBPROTOCOL, CP_WS_PATH } from './cp/client.js'
import { RelayManager } from './cp/relay-manager.js'
import { CpCollabRoutes } from './cp/cp-collab-routes.js'
import { ClientTransport, systemClock, type Clock, type TimerHandle } from '@agentconnect.md/connection'
import {
  AgentActivate as AgentActivateSchema,
  DELEGATED_MCP_ASSERTION_FEATURE,
  encodeSharedSlackStatusTarget,
  HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED,
  HookReport,
  RELAY_DAEMON_SUBPROTOCOL,
  RELAY_DAEMON_WS_PATH,
  RESERVED_RESTART_CODE,
  SESSION_VISIBILITY_FEATURE,
  effectiveMemoryDreamingPolicy,
  gitRepoLabel
} from '@agentconnect.md/protocol'
import { createSessionReader } from './cp/session-reader.js'
import { createWorkspaceReader, WorkspaceConflictError } from './cp/workspace-reader.js'
import { createMemoryReader } from './cp/memory-reader.js'
import {
  createMemoryProvider,
  memoryProviderFor,
  memoryKindOf,
  MemoryProviderUnavailableError,
  type DispatchingMemoryProvider,
  type PreparedExternalMemoryCapture
} from './agents/memory-provider.js'
import { createWorkspaceGit } from './cp/workspace-git.js'
import { DAEMON_VERSION } from './version.js'
import { CpCronRegistry } from './cp/cp-cron.js'
import { CpAgentRegistry } from './cp/cp-agent-registry.js'
import {
  agentMoveStages,
  clearAgentMoveStage,
  commitAgentMove,
  stageAgentMove,
  type AgentMoveStageMetadata
} from './agents/write-agent.js'
import { CpIntegrationRegistry } from './cp/cp-integration-registry.js'
import { CpMcpDefs } from './mcp/cp-mcp-defs.js'
import { CpMemoryConnectionRegistry, type MemoryPluginConnector } from './cp/memory-connection-registry.js'
import { MemoryCaptureOutbox } from './memory-plugin/outbox.js'
import { defaultMemoryPluginMetrics } from './memory-plugin/metrics.js'
import {
  EvaluationCapabilityProfileSchema,
  EvaluationEventEmitter,
  type EvaluationCapabilityProfile,
  type EvaluationEventInput,
  type EvaluationObserver
} from './evaluation/events.js'
import { mergeConfigPush, type ConfigApply } from './cp/config-apply.js'
import { SystemMetrics } from './metrics/system-metrics.js'
import { estimateOpenAiTurnCost } from './usage/openai-public-pricing.js'
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  McpServer,
  RequestPermissionRequest,
  RequestPermissionResponse
} from '@agentclientprotocol/sdk'
import type { Agent, CronDef, Integration } from './agents/agent-schema.js'
import { fromPlatformMessage, stableMessageId, stableTurnId, type NormalizedMessage } from './messages/normalized.js'
import type {
  RegisterReq,
  RegisterOk,
  RelayRosterEntry,
  CronReport,
  CronUpsert,
  RouteAssign,
  RouteUpdate,
  FactsRuntimeProfile,
  FactsMcpServer,
  McpTransportCapabilities,
  RuntimeModelCatalog,
  IntegrationChannel,
  Drain,
  DrainProgress,
  DrainDone,
  SessionKey,
  EventSession,
  SessionActivity,
  SessionListItem,
  AgentLaunch,
  AgentLaunched,
  AgentStop,
  AgentDetach,
  AgentActivate,
  AgentPermissionRequestList,
  AgentPermissionRequestPage,
  AgentPermissionDecision,
  Ack,
  DaemonRestart,
  DaemonUpgrade,
  DaemonControlAck,
  WebchatAck,
  WebchatEvent,
  WebchatOutput,
  WebchatDone,
  WebchatRuntimeConfig,
  RdMsg,
  RdMsgWebchat,
  WebchatImageAttachment,
  RdMsgIm,
  RdMsgSlackAction,
  RdMsgFeishuAction,
  RdMsgHook,
  RdAck,
  RdAgentMsgFwd,
  RdAgentMsgAck,
  RdChatEvent,
  HookConfigSnapshot,
  GithubHookMetadata,
  GitCommitIdentity,
  GithubReviewAuthorized,
  HookReviewResult,
  FeishuRegion,
  MemoryDreamingPolicy,
  ChildSessionStatus,
  ChildSessionStatusProbe,
  SessionVisibilityPush,
  WebchatMcpDelegationReference,
  ChannelAgentsOk
} from '@agentconnect.md/protocol'

/** Format an error for logs, surfacing a JSON-RPC/ACP RequestError's `code` and
 *  `data` — for an agent-side `Internal error` the actionable detail (the adapter's
 *  underlying exception) lives in `data`, which a bare `.stack` discards. */
/** Identity of a desired Feishu connection: appId + gateway region + ingress mode.
 *  A region or mode change on the same appId yields a different key, so it is
 *  treated as a distinct connection for reuse-matching, mapping-eviction, and
 *  the in-flight guard (`|` can't collide — an appId `cli_…` and the region/mode
 *  literals contain none). */
function feishuConnKey(appId: string, region: string, mode: 'direct' | 'shared'): string {
  return `${appId}|${region}|${mode}`
}

function formatErr(err: unknown): string {
  const e = err as { name?: string; message?: string; code?: number; data?: unknown; stack?: string }
  if (e && typeof e.code === 'number') {
    const data = e.data === undefined ? '' : ` data=${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}`
    return `${e.name ?? 'Error'}: ${e.message ?? ''} (code=${e.code})${data}`
  }
  return e?.stack ?? String(err)
}

// ACP runtime identities for THIS daemon's own MCP tools. ALL_TOOL_NAMES is the
// registry of every tool the agentconnect MCP server can inject; both approval
// transports below derive their trust policy from this same set.
const BUILTIN_TOOL_NAMES = new Set(ALL_TOOL_NAMES)
const BUILTIN_PERMISSION_TOOL_FQNS = new Set(ALL_TOOL_NAMES.map((name) => `mcp__${RESERVED_MCP_SERVER_NAME}__${name}`))
const BUILTIN_TOOL_FQNS = new Set(
  ALL_TOOL_NAMES.flatMap((name) => [
    `mcp__${RESERVED_MCP_SERVER_NAME}__${name}`,
    `mcp.${RESERVED_MCP_SERVER_NAME}.${name}`
  ])
)

function containsBuiltinToolFqn(id: string): boolean {
  if (BUILTIN_TOOL_FQNS.has(id)) return true
  // Some ACP adapters suffix an opaque invocation id to the flattened MCP name.
  for (const fqn of BUILTIN_PERMISSION_TOOL_FQNS) if (id.includes(fqn)) return true
  return false
}

/** Identify a structured ACP tool event for one of this daemon's own MCP tools. */
export function isBuiltinSystemToolCall(update: unknown): boolean {
  if (!update || typeof update !== 'object') return false
  const u = update as { sessionUpdate?: unknown; rawInput?: unknown; title?: unknown }
  if (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update') return false
  const rawInput =
    u.rawInput && typeof u.rawInput === 'object' ? (u.rawInput as { server?: unknown; tool?: unknown }) : undefined
  // When the adapter provides structured identity, it is authoritative. Do not let
  // a friendly/misleading display title override a different MCP server identity.
  if (rawInput && (rawInput.server !== undefined || rawInput.tool !== undefined)) {
    return (
      rawInput.server === RESERVED_MCP_SERVER_NAME &&
      typeof rawInput.tool === 'string' &&
      BUILTIN_TOOL_NAMES.has(rawInput.tool)
    )
  }
  return typeof u.title === 'string' && BUILTIN_TOOL_FQNS.has(u.title)
}

/**
 * True when an ACP permission request is for one of the daemon's OWN built-in MCP tools.
 * Those are platform system tools the agent is always granted — a human should never have
 * to approve them per call (they carry no more authority than the agent already has). We
 * match the runtime-assigned `mcp__agentconnect__<name>` FQN against our registered tool
 * set across the request's identifying fields (`title`/`kind`/`toolCallId`). Deliberately
 * strict + fail-SAFE: an unrecognized/friendly title simply falls through to the normal
 * permission card, never a wrongful auto-allow. The runtime's own dangerous built-ins
 * (Bash/Edit/…) carry different names, are NOT in this set, and still prompt.
 */
export function isBuiltinSystemTool(
  params: RequestPermissionRequest,
  correlatedToolCallIds?: ReadonlySet<string>
): boolean {
  const tc = params.toolCall
  if (typeof tc?.toolCallId === 'string' && correlatedToolCallIds?.has(tc.toolCallId)) return true
  const ids = [tc?.title, tc?.kind, tc?.toolCallId]
  return ids.some((id) => typeof id === 'string' && containsBuiltinToolFqn(id))
}

/** Codex ACP carries MCP approval through form elicitation when the client supports it. */
export function isBuiltinSystemToolElicitation(
  params: CreateElicitationRequest,
  correlatedToolCallIds: ReadonlySet<string>
): boolean {
  const toolCallId = 'toolCallId' in params ? params.toolCallId : undefined
  return (
    params.mode === 'form' &&
    typeof toolCallId === 'string' &&
    correlatedToolCallIds.has(toolCallId) &&
    params._meta?.codex_approval_kind === 'mcp_tool_call'
  )
}

function isMcpToolApprovalElicitation(params: CreateElicitationRequest): boolean {
  return params.mode === 'form' && params._meta?.codex_approval_kind === 'mcp_tool_call'
}

function approvalSummary(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return (text || fallback).slice(0, 240)
}

function approvalInputSummary(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const input = value as Record<string, unknown>
  for (const key of ['command', 'cmd', 'path', 'file_path', 'query', 'url']) {
    if (typeof input[key] === 'string' && input[key].trim()) return input[key]
  }
  return ''
}

function permissionRequestSummary(params: RequestPermissionRequest): string {
  const label = approvalSummary(params.toolCall?.title ?? params.toolCall?.kind, 'Tool permission request')
  const input = approvalInputSummary(params.toolCall?.rawInput)
  return approvalSummary(input ? `${label}: ${input}` : label, 'Tool permission request')
}

function elicitationApprovalSummary(params: CreateElicitationRequest): string {
  return approvalSummary((params as { message?: unknown }).message, 'MCP tool permission request')
}

/**
 * True when `none` output mode removed THIS turn's interactive permission/elicitation
 * surface. Permission requests still enter the Agent-editor queue; this flag only prevents
 * a chat-side card from being rendered for the turn.
 *
 * Scoped narrowly to the surface `none` actually removes: an interactive card renders ONLY
 * on Slack (see `onAcpPermission`), and only for a live user turn. So this is true iff the
 * turn is `none` AND on Slack AND not webchat/headless. Telegram/Discord/Feishu have no card
 * surface, so `none` removes nothing there; webchat/headless are non-IM transports.
 * Computed once at dispatch (frozen for the turn) so a mid-turn mode flip can't desync it
 * from the connection it was derived from.
 */
export function noneSuppressedApprovalSurface(
  mode: string,
  turn: { platform: string; webchat?: unknown; headless?: boolean }
): boolean {
  return mode === 'none' && turn.platform === 'slack' && !turn.webchat && !turn.headless
}

function hookSnapshot(msg: RdMsgHook): HookConfigSnapshot | undefined {
  if (
    msg.configRevision === undefined ||
    msg.dispatchRevision === undefined ||
    msg.dispatchDaemonId === undefined ||
    msg.reviewPolicy === undefined ||
    msg.reportingMode === undefined ||
    msg.gateMode === undefined
  )
    return undefined
  return {
    configRevision: msg.configRevision,
    dispatchRevision: msg.dispatchRevision,
    dispatchDaemonId: msg.dispatchDaemonId,
    reviewPolicy: msg.reviewPolicy,
    reportingMode: msg.reportingMode,
    gateMode: msg.gateMode
  }
}

function reviewPolicyAllows(policy: HookConfigSnapshot['reviewPolicy'], event: GithubReviewEvent): boolean {
  if (policy === 'full') return true
  if (policy === 'request_changes') return event === 'COMMENT' || event === 'REQUEST_CHANGES'
  if (policy === 'comment') return event === 'COMMENT'
  return false
}

function reviewResultForWire(effect: GithubReviewEffect): HookReviewResult {
  if (effect.state === 'submitted') return effect
  return { state: effect.state, code: effect.code }
}

// Cap per-session `!queue` depth so a hung turn or a user spamming `!queue` can't
// grow `queued` without bound. Past the cap we reject with a clear message.
/** An agent's effective dreaming policy. Managed memory defaults to a daily
 *  auto-adopting dream; an explicit disabled policy or non-managed provider is
 *  preserved by the shared resolver. */
function dreamingPolicyOf(agent: { memory?: Agent['memory'] } | undefined): MemoryDreamingPolicy | undefined {
  if (!agent) return undefined
  return effectiveMemoryDreamingPolicy(agent.memory)
}

const MAX_QUEUED_PER_SESSION = 10

/** Bounded hard-stop for a dream extraction whose runtime ignores `session/cancel`:
 *  how long after the abort the daemon stops awaiting `host.prompt` and discards
 *  the isolated ACP session, rather than wedging forever. The runner's own grace
 *  window (DreamRunnerDeps.cancelGraceMs) releases the reservation independently. */
const DREAM_CANCEL_FORCE_MS = 15_000

/** How often the idle sweep also reclaims abandoned probe temp roots. Much slower than
 *  the idle cadence: the scan reads the whole OS temp dir, and a leaked root only costs
 *  disk, so a lazy reclaim is enough. */
const PROBE_ROOT_SWEEP_INTERVAL_MS = 15 * 60_000

// Last-resort feedback-loop protection. The lower automatic threshold catches
// agent/system/platform-echo chains; the higher all-turn threshold still stops a
// platform bug that accidentally labels its own events as ordinary human messages.
// The latch is durable and has no cooldown: only an explicit !resume resets it.
const LOOP_GUARD_WINDOW_MS = 60_000
const MAX_AUTOMATIC_TURNS_PER_WINDOW = 8
const MAX_TOTAL_TURNS_PER_WINDOW = 60

// Bound the correlated hook/report outbox drain. Each request may live through
// several CP retries, so admitting an unbounded retained backlog at reconnect
// would turn a long outage into a memory/socket fan-out spike.
const MAX_HOOK_REPORT_INFLIGHT = 100

/** Thrown to a `dispatch()` caller when the per-session admission queue is at its depth
 *  cap (§4.4 backpressure): the message is fast-failed, not buffered. Carries a stable
 *  `reason` so an agent-call source (P1/P2) can surface a typed `queue_full`. */
export class QueueFullError extends Error {
  readonly reason = 'queue_full' as const
  constructor(sessionKey: string) {
    super(`admission queue full for session ${sessionKey}`)
    this.name = 'QueueFullError'
  }
}

/** Thrown to the `dispatch()` callers of the messages still queued behind a turn that
 *  FAILED (§6.9 #378 fail-stop): the daemon does not auto-run buffered work onto a broken
 *  session, so each follow-up is rejected rather than silently dropped or force-run. */
export class FailStopError extends Error {
  readonly reason = 'fail_stop' as const
  constructor(sessionKey: string) {
    super(`turn failed for session ${sessionKey}; queued messages were not auto-run`)
    this.name = 'FailStopError'
  }
}

/** Internal fail-closed outcome for a turn whose process cleanup rejected. The raw
 * cleanup rejection is logged once at the lifecycle boundary; this stable sentinel
 * lets the serial gate fail-stop and release its dispatch lease without reporting the
 * same rejection again through transport fire-and-forget handlers. */
class LifecycleCleanupBlockedError extends Error {
  readonly reason = 'lifecycle_cleanup_blocked' as const
  constructor(sessionKey: string, cause: unknown) {
    super(`lifecycle cleanup blocked for session ${sessionKey}`, { cause })
    this.name = 'LifecycleCleanupBlockedError'
  }
}

/** The session-control selectors driven by `/models` `/effort` `/permission` + their
 *  tappable cards. Single-char codes keep the inline-button `callback_data` (≤64 bytes)
 *  compact — `<code>:<optionIndex>`. */
type SelectKind = 'model' | 'effort' | 'permission'
const SELECT_KIND_CODE: Record<SelectKind, string> = { model: 'm', effort: 'e', permission: 'p' }
const SELECT_CODE_KIND = { m: 'model', e: 'effort', p: 'permission' } as const satisfies Record<string, SelectKind>

// Budget for the inline text carried by one WebchatOutput payload. Well under
// the 256 KiB JSON frame cap so the envelope overhead (conversationId/turnId/index/
// kind + JSON escaping of control chars, up to a 6× blowup) can never push a chunk
// over the wire limit. Long agent output is split across several chunks at this size.
const WEBCHAT_CHUNK_BYTES = 32 * 1024
// A reconnectable turn keeps a bounded in-memory output window on the daemon,
// where the stream originates. This survives a browser moving between relay
// instances without putting message bodies on the Control Plane or disk.
const WEBCHAT_REPLAY_MAX_EVENTS = 256
const WEBCHAT_REPLAY_MAX_BYTES = 1024 * 1024
const WEBCHAT_REPLAY_MAX_STREAMS = 64
const WEBCHAT_REPLAY_TTL_MS = 5 * 60_000

/** Split `text` into pieces whose UTF-8 byte length each stays under WEBCHAT_CHUNK_BYTES
 *  so no single relay `rd/chat` payload exceeds the 256 KiB cap. Splits on byte budget
 *  by character (never mid-code-point); short text returns a single piece. */
function chunkText(text: string): string[] {
  if (Buffer.byteLength(text) <= WEBCHAT_CHUNK_BYTES) return [text]
  const out: string[] = []
  let buf = ''
  let bytes = 0
  for (const ch of text) {
    const w = Buffer.byteLength(ch)
    if (bytes + w > WEBCHAT_CHUNK_BYTES && buf) {
      out.push(buf)
      buf = ''
      bytes = 0
    }
    buf += ch
    bytes += w
  }
  if (buf) out.push(buf)
  return out
}

// §9.1 text-buffer: flush buffered agent body after this much streaming idle.
const IDLE_FLUSH_MS = 2000
/** CardKit updates are cumulative and rate-limited. Sampling the converger at this
 * cadence streams visibly without queuing one HTTP request per model token. */
const FEISHU_STREAM_FLUSH_MS = 350

/** Local Web App console origin used for session deep links when neither a local
 *  `webAppUrl` config nor a CP-provided one is set. */
const DEFAULT_WEB_APP_URL = 'http://localhost:3000'

/** ACP session ids are scoped to one agent runtime, not globally unique. */
function pendingTurnKey(agentId: string, acpSessionId: string): string {
  return JSON.stringify([agentId, acpSessionId])
}

/** Background-task leases are per (agent, ACP session) for the same reason turns are: two
 *  agents can each expose an `acp-1`. Sharing one entry would let one agent's live task
 *  suppress the other's completion wake, or overwrite its task record under a colliding id. */
function sdkLeaseKey(agentId: string, acpSessionId: string): string {
  return pendingTurnKey(agentId, acpSessionId)
}

/** Cap on agent→agent hop depth (design §2.4/§4.5) — reject a `messageAgent` that
 *  would push the outgoing hopCount past this, so an A↔B wake loop can't run away. */
const MAX_AGENT_CALL_HOPS = 8

/** Poll interval for the deferred background-task wake (background-task-aware-reclaim.md
 *  §5.1). Claude re-enters a `running` cycle of its own to drain a settled task; the wake
 *  waits that cycle out rather than firing into it, because a turn injected mid-cycle would
 *  race the runtime's own work. It does NOT stand down for it — that cycle carries no
 *  `Pending`, so everything it emits is dropped at `onAcpUpdate` and the user sees nothing. */
const BG_TASK_WAKE_GRACE_MS = 4_000

/** How many times the wake may re-arm while the runtime's self-drain cycle is still
 *  `running` (≈1 minute at {@link BG_TASK_WAKE_GRACE_MS}). A cycle that never returns to
 *  `idle` is either a genuinely long piece of work — which will produce its own turn-end —
 *  or a wedged runtime; either way, stop re-arming instead of polling forever. */
const MAX_BG_TASK_WAKE_REARMS = 15

/** Per-session budget for background-task wakes. Unlike an agent call these carry no
 *  hopCount to bound, and a woken turn may spawn further background tasks, so the
 *  budget is the only backstop against a self-feeding wake loop. Counted over the
 *  lease's life (i.e. until the host is reclaimed), not per turn. */
const MAX_BG_TASK_WAKES_PER_SESSION = 20

/**
 * DAEMON-PRIVATE trusted metadata for an agent-originated delivery. Authoritative
 * (never derived from model output or platform text): the caller identity the target can
 * trust, the correlationId to bounce back, and the hop/origin chain for loop protection.
 * Most deliveries run a turn whose nested `messageAgent` reads this to auto-increment
 * hopCount (§2.4); a self-authored channel root instead carries `initializeOnly`.
 */
interface CallMeta {
  /** Trusted caller agentId (the agent that invoked `messageAgent`). */
  callFrom: string
  /** Opaque correlation id supplied by the caller (orchestration), if any. */
  correlationId?: string
  /** Depth of this agent-call chain; inbound platform/user turns are 0. */
  hopCount: number
  /** Stable id of the delivery that started this turn (== the msgId's ts segment). */
  deliveryId: string
  /** A self-authored channel-root post initializes its new session but is not a model turn.
   *  Persisted with the inbox row so crash replay cannot accidentally activate the model. */
  initializeOnly?: boolean
  /** session-concept §5.3: the WAKING (parent/origin) session's stable acpSessionId. This
   *  is the value surfaced to the child as its `Parent session` (§2.3) and the SessionTarget
   *  the child replies into via `sendMessage`. Absent on root turns (human-initiated) and the
   *  self-introduce fan-out — those have no parent, so the child gets no `Parent session` line
   *  and cannot address a SessionTarget. */
  originSessionId?: string
  /** session-concept §5.3: the origin session's landing coords. Used to route a SessionTarget
   *  reply back when the origin session lives on ANOTHER daemon (the relay has no
   *  sessionId→daemon registry, so a cross-daemon reply routes by these coords + `callFrom`).
   *  Set alongside `originSessionId`. */
  originCoords?: { platform: Exclude<NormalizedMessage['platform'], 'hook'>; channel: string; thread?: string }
  /** Daemon-internal (issue #536, never a tool input): when this turn calls
   *  `messageAgent`, deliver the woken peer's turn HEADLESS so it records silently
   *  with no channel output. Set only by the self-introduce-on-join fan-out; does
   *  NOT cascade (the peer's own callMeta doesn't carry it). */
  deliverHeadless?: boolean
  /** Daemon-internal (issue #536, never a tool input): the channel this turn exists to
   *  introduce the agent into. It HARD-BOUNDS peer discovery for the turn — the
   *  `channelAgents` dep forces this channel as the directory filter even when the model
   *  omits (or widens, or redirects) the tool's `channel` argument. Without a code-level
   *  bound the org-wide default would fan one channel join out to every agent in the org;
   *  `MAX_AGENT_CALL_HOPS` bounds depth and `INTRO_MAX_BURST` bounds channels per snapshot,
   *  but neither bounds PEERS per intro. The prompt asks for the same filter (belt and
   *  braces); this is what makes it true regardless of model compliance. Set only by the
   *  self-introduce-on-join dispatch and, like `deliverHeadless`, does NOT cascade. */
  introChannel?: string
  /** session-concept §5.3: the waking parent asked this session to report back when it is done
   *  or has failed (`sendMessage`'s `toAgent.needsReply`). Handed to prompt assembly, which turns
   *  it into a standing directive on the child naming `originSessionId` as the reply target.
   *  Like `deliverHeadless` it does NOT cascade — a grandchild is only obliged if its own parent
   *  asks. Absent ⇒ an ordinary fire-and-forget wake. */
  needsReply?: boolean
  /** session-visibility.md §5.1: the WAKING session is private, so this child's
   *  transcript holds prompt text copied out of it and must not feed shared agent
   *  memory. Strictly ONE-DIRECTIONAL — it can only tighten. A `false`/absent
   *  value never opens capture: an A2A child always starts excluded, and only a
   *  CP-confirmed `org` state (which the CP derives from the post-cascade parent)
   *  may open it. That is what makes a stale hint in flight during a §4.3
   *  tightening harmless. */
  parentPrivate?: boolean
}

type TurnInterruptReason = 'pause' | 'loop protection' | 'stop' | 'cancel' | 'shutdown'

/** One durable loop-guard scope shared by every agent on one physical bot.
 *  DMs are keyed at channel level because malformed platform wrappers may lose
 *  thread coordinates; threaded channel conversations retain their canonical
 *  thread. Platform coordinates can overlap across bot installations. */
function loopGuardScopeFromCoords(
  platform: string,
  channel: string,
  thread: string,
  isDm: boolean,
  transportScope?: string
): string {
  const base = `${platform}:${channel}:${isDm ? 'dm' : thread}`
  return transportScope ? `${base}:${transportScope}` : base
}

function slackTopLevelLoopGuardScope(channel: string): string {
  return `slack:${channel}:top-level`
}

function loopGuardScope(msg: NormalizedMessage): string {
  if (msg.platform === 'slack' && !msg.isDm) {
    const prefix = `slack:${msg.channel}:`
    const eventTs = msg.msgId.startsWith(prefix) ? msg.msgId.slice(prefix.length) : undefined
    // Slack normalizes a top-level event with thread=its own ts. Those roots must
    // share one channel-level circuit: otherwise two bots can alternate fresh roots
    // forever and every message gets a brand-new guard scope.
    if (eventTs !== undefined && msg.thread === eventTs) return slackTopLevelLoopGuardScope(msg.channel)
  }
  return loopGuardScopeFromCoords(msg.platform, msg.channel, msg.thread ?? msg.msgId, msg.isDm, msg.transportScope)
}

function isTrustedHumanTurn(msg: NormalizedMessage): boolean {
  return msg.source === 'user' && !msg.sender.isBot && msg.sender.id !== 'unknown'
}

/** The coarse rate circuit protects platform chat ingress. Agent calls have an exact
 *  trusted hop cap; cron/hooks are operator automation; webchat has a separate sync ACK
 *  contract and no in-band !resume surface. */
function usesLoopGuard(msg: NormalizedMessage): boolean {
  return msg.source === 'user' && msg.platform !== 'webchat'
}

/** The exact poison shape produced when a Slack message_changed/assistant metadata
 *  wrapper was normalized as if it were a real message. No supported platform has a
 *  legitimate anonymous, empty, attachment-less user turn, so fail closed and latch. */
function isMalformedPlatformTurn(msg: NormalizedMessage): boolean {
  return (
    msg.platform === 'slack' &&
    msg.source === 'user' &&
    !msg.sender.isBot &&
    msg.sender.id === 'unknown' &&
    msg.text.trim() === '' &&
    (msg.attachments?.length ?? 0) === 0
  )
}

interface GithubReplyTarget {
  hookId: string
  repo: string
  number: number
  /** The review-comment delivery that triggered this turn (diagnostic identity). */
  reviewCommentId?: string
  /** Stable root of the GitHub inline-review thread; replies must target this id. */
  reviewThreadRootCommentId?: string
}

/** Durable, daemon-private identity for one accepted hook delivery. Unlike the
 * model-visible NormalizedMessage, this contains only relay-verified metadata
 * and the exact CP-compiled dispatch fence. */
interface HookDispatchContext {
  hookId: string
  agentId: string
  deliveryKey: string
  firedAt: string
  event?: string
  snapshot?: HookConfigSnapshot
  github?: GithubHookMetadata
  githubReply?: GithubReplyTarget
  turnStartedAt?: string
  reviewAttemptId?: string
  reviewRequestedEvent?: GithubReviewEvent
  reviewRequestedVerdict?: GithubReviewVerdict
  reviewResult?: HookReviewResult
  /** Latest body-free outcome retained for terminal hook/report even when a
   * proved no-effect reservation is released to permit a corrected retry. */
  reviewReportAttemptId?: string
  reviewReportResult?: HookReviewResult
}

/** An ordinary comment is safe only when no formal attempt exists, or when the
 * latest/current attempt has a correlated, definite no-effect result. Any
 * unresolved or contradictory state fails closed because GitHub may already
 * own the public response. */
function githubFallbackAllowed(hook: HookDispatchContext | undefined): boolean {
  if (!hook) return true

  const currentAttemptId = hook.reviewAttemptId
  const reportAttemptId = hook.reviewReportAttemptId
  const hasFormalState =
    currentAttemptId !== undefined ||
    reportAttemptId !== undefined ||
    hook.reviewResult !== undefined ||
    hook.reviewReportResult !== undefined
  if (!hasFormalState) return true

  if (currentAttemptId !== undefined) {
    if (reportAttemptId !== undefined) {
      return (
        reportAttemptId === currentAttemptId &&
        hook.reviewReportResult?.state === 'not_submitted' &&
        (hook.reviewResult === undefined || hook.reviewResult.state === 'not_submitted')
      )
    }
    return hook.reviewResult?.state === 'not_submitted'
  }

  return (
    reportAttemptId !== undefined &&
    hook.reviewReportResult?.state === 'not_submitted' &&
    (hook.reviewResult === undefined || hook.reviewResult.state === 'not_submitted')
  )
}

/** Select only an outcome that belongs to the current attempt, falling back to
 * the retained terminal outcome once no current reservation remains. */
function githubReviewResultForCompletion(
  hook: HookDispatchContext
): { attemptId: string; result: HookReviewResult } | undefined {
  if (hook.reviewAttemptId !== undefined) {
    if (hook.reviewReportAttemptId === hook.reviewAttemptId && hook.reviewReportResult) {
      return { attemptId: hook.reviewAttemptId, result: hook.reviewReportResult }
    }
    if (hook.reviewReportAttemptId === undefined && hook.reviewResult) {
      return { attemptId: hook.reviewAttemptId, result: hook.reviewResult }
    }
    return undefined
  }
  if (hook.reviewReportAttemptId && hook.reviewReportResult) {
    return { attemptId: hook.reviewReportAttemptId, result: hook.reviewReportResult }
  }
  return undefined
}

interface ActiveGithubTurnMeta {
  entry: QueueEntry
  hook: HookDispatchContext
  snapshot: HookConfigSnapshot
  repoId: string
  repoFullName: string
  pullNumber: number
  expectedHeadSha: string
  expectedBaseSha: string
  reportSha: string
  /** ACP session owning this turn, used only to build daemon-authored review attribution. */
  sessionId: string
  reviewState: 'idle' | 'submitting' | 'done'
}

/** Review-comment follow-ups already belong to one existing inline thread.
 * They may receive exactly one daemon-owned inline reply, but must never gain
 * authority to create a second, top-level formal PR review. */
function isGithubReviewCommentHook(hook: HookDispatchContext): boolean {
  return (
    hook.event?.split(':', 1)[0] === 'pull_request_review_comment' ||
    hook.github?.reviewThreadRootCommentId !== undefined
  )
}

function authorizedReviewTargetMatches(
  active: ActiveGithubTurnMeta,
  attemptId: string,
  authorized: GithubReviewAuthorized
): boolean {
  return (
    authorized.attemptId === attemptId &&
    authorized.repoId === active.repoId &&
    authorized.repoFullName.toLowerCase() === active.repoFullName.toLowerCase() &&
    authorized.pullNumber === active.pullNumber &&
    authorized.expectedHeadSha === active.expectedHeadSha &&
    authorized.expectedBaseSha === active.expectedBaseSha
  )
}

function authorizedReviewTarget(
  active: ActiveGithubTurnMeta,
  attemptId: string,
  authorized: GithubReviewAuthorized,
  recovering = false
): GithubReviewTarget {
  return {
    token: authorized.token,
    repoFullName: authorized.repoFullName,
    pullNumber: authorized.pullNumber,
    expectedHeadSha: authorized.expectedHeadSha,
    expectedBaseSha: authorized.expectedBaseSha,
    hookId: active.hook.hookId,
    deliveryKey: active.hook.deliveryKey,
    attemptId,
    ...(recovering ? { recovering: true } : {})
  }
}

/**
 * One admitted message waiting in (or entering) the per-sessionKey serial gate (design
 * §4.3/§6.9). Carries the FULL DispatchContext so a queued turn dispatches identically to
 * one that ran immediately — same reply transport (`integrationId`), same webchat sink,
 * same trusted `callMeta` — and settles its OWN `dispatch()` promise (§6.9 #367). The gate
 * is keyed by the LOGICAL sessionKey (platform:channel:thread:agentId[:transportScope]), NOT the ACP
 * sessionId, so a cold session (no ACP id yet) is serialized too.
 */
interface SelectedTurnHost {
  host: AcpHost
  /** A private delegated process cannot be trusted after its session/prompt
   * transport rejects. Ordinary shared hosts keep their established error policy. */
  stopOnError: boolean
  /** Full lifecycle cleanup for the selected process. Delegated turns route this
   * through their manager so broker drain/release and private-HOME removal remain
   * generation-fenced and teardown-singleflight. */
  stop: (deadlineMs?: number) => Promise<void>
  /** The exact stop operation once lifecycle cleanup has begun, or an already
   * settled promise while the selected process has not been asked to stop. */
  waitForCleanup: () => Promise<void>
}

type TurnLifecycleCleanupOutcome = { blocked: false } | { blocked: true; error: unknown }

interface QueueEntry {
  agentId: string
  msg: NormalizedMessage
  /** Cancels the entire cold SessionManager initialization path after the bounded
   *  host-stop backstop, including non-host awaits such as workspace/history I/O. */
  initAbort: AbortController
  integrationId?: string
  webchat?: WebchatTurnContext
  callMeta?: CallMeta
  hookContext?: HookDispatchContext
  /** Best-effort lifecycle notification after ACP session initialization but
   *  before prompting. Used by trigger sources that expose a live deep-link. */
  onSessionReady?: (sessionId: string) => void
  /** True when this entry was buffered via the user `!queue` command (ACK wording only —
   *  it is one and the same admission queue as ordinary inbound, per §6.9 #390). */
  isQueueCmd?: boolean
  /** Settles the `dispatch()` promise for THIS message: resolve with its ACP sessionId
   *  (or null when a gate skipped it), reject with its own turn error. */
  resolve: (sessionId: string | null) => void
  reject: (err: unknown) => void
  /** §6.9 #353 durable inbox: the stable id (deliveryId/msgId) of the row persisted for
   *  this entry BEFORE its admission ACK, or undefined when nothing was persisted (webchat
   *  turns, or a replayed entry re-admitted from an already-present row). Set once on
   *  admission and used to delete the row on every terminal path. */
  inboxId?: string
  /** P3 outbound: publish the turn's completed reply on this GitHub thread. Hook
   * deliveries duplicate this reference in their durable HookDispatchContext so
   * restart replay can recreate the poster behind its publish-state fence. */
  githubReply?: GithubReplyTarget
  /** Selected before session/new|load. Retained across the cold pre-Pending gap
   * so cancellation never has to rediscover a private host through this.hosts. */
  selectedHost?: SelectedTurnHost
  /** Cold cleanup can begin before a selected host exists (for example while the
   * broker registration is pending). Session initialization must await this gate
   * before releasing ownership or writing idle. */
  lifecycleCleanup?: Promise<void>
  /** Permanent fail-closed latch after lifecycle cleanup rejects. The serial
   * dispatch lease may terminate, but admission must remain fenced until restart. */
  lifecycleCleanupBlocked?: Promise<never>
  /** Deduplicates cleanup-failure observability across error, backstop, and final
   * cleanup observers of the same admitted turn. */
  lifecycleCleanupFailureLogged?: boolean
  /** Latched cancellation for an already-admitted head. Unlike reading the current
   *  pause/loop state, this survives a quick pause→unpause or trip→!resume race while
   *  a cold sessions.handle() call is still initializing. */
  cancelledReason?: TurnInterruptReason
  posterPublishState?: 'not_started' | 'in_flight' | 'settled'
  /** The live inbox row was redacted into a durable terminal HookReport
   * receipt; removeInbox must retain it for restart-safe redelivery dedup. */
  hookTerminalReceipt?: boolean
}

/** The narrow persistence ownership needed to terminalize a hook delivery.
 * A live QueueEntry implements this, while startup replay can use the retained
 * inbox id directly without fabricating an in-memory turn. */
interface HookCompletionOwner {
  inboxId?: string
  hookTerminalReceipt?: boolean
}

interface MemoryExtractionCollector {
  chunks: string[]
  sessionKey?: string
  runtimeCostReported?: boolean
  /** Dream sessions expose the same original reasoning/tool activity as ordinary
   *  sessions. Background distillation has no transcript and leaves this unset. */
  transcript?: { channel: string; thread: string; recorder: TranscriptRecorder }
}

function isSlackStatusBarText(text: string): boolean {
  return text.startsWith(':bar_chart:') || text.startsWith('\uD83D\uDCCA')
}

/** Per-in-flight-turn rendering state, keyed by ACP sessionId in `this.pending`. */
interface Pending {
  /** Admitted-turn lifecycle owner. Backstops and finalization share its cleanup
   * failure latch so one rejected stop cannot be logged or fenced twice. */
  entry: QueueEntry
  // Platform-tagged converger: OutputConverger emits SlackAction[] (slack/webchat),
  // TelegramConverger emits TelegramAction[]. enqueueApply routes by `platform`.
  conv: OutputConverger | TelegramConverger | DiscordConverger | FeishuConverger
  /** Captures the full activity log (tool/reasoning) from the raw ACP stream,
   *  independent of output mode. Text/result rows are recorded at send time. */
  rec: TranscriptRecorder
  /** Complete raw assistant text, used only as input to opt-in memory distillation. */
  replyText: string
  /** Tool-call ids structurally identified as this daemon's own MCP tools. Approval
   *  requests may carry only this opaque id, regardless of which ACP path is used. */
  builtinSystemToolCallIds: Set<string>
  /** Tool-call ids for the internal Codex title fallback. Its MCP call updates the
   *  session metadata, but housekeeping must not appear in platform/webchat output
   *  or the persisted user-visible activity log. */
  hiddenSessionTitleToolCallIds: Set<string>
  /** Agent that owns this turn — the sender stamped on its recorded reply rows. */
  agentId: string
  /** Human-readable AgentConnect agent name captured for this turn's Slack channel authorship. */
  agentName: string
  /** Trusted sender id for the message that started this turn. Approval audit rows use
   *  this actor, not the session's historical first trigger. */
  requesterId?: string
  /** Exact integration that owns the reply path. HTTP Slack turns encode it into the
   *  status controls so the relay can route each button to the right owner. */
  integrationId?: string
  /** Public avatar URL for this turn's Slack channel messages (icon_url), if the CP resolved one. */
  iconUrl?: string
  /** Source platform (for building the protocol SessionKey on drain release). */
  platform: string
  /** Whether the source conversation is a direct message. Slack thread titles are
   *  valid only for Agents-feature app threads, which live in the app DM. */
  isDm: boolean
  /** Durable loop-breaker scope captured from the original event shape. */
  loopGuardScope: string
  /** Local session key (platform:channel:thread:agentId[:transportScope]) — for state writes. */
  sessionKey: string
  /** The live ACP session id for this turn (part of the `this.pending` map key) — surfaced
   *  in the status bar so the console can deep-link to the session detail page. */
  acpSessionId: string
  /** The exact host selected for this turn, including its full cleanup boundary. */
  selectedHost?: SelectedTurnHost
  /** Once an operator pause or loop trip targets this turn, no subsequent ACP update
   *  or queued renderer action may publish output, even if the gate is later reset. */
  outputSuppressed?: TurnInterruptReason
  channel: string
  /** Internal transcript namespace for this physical bot connection. */
  transcriptChannel: string
  /** thread_ts for body posts (undefined for a top-level message). */
  thread?: string
  /** Telegram reply target: the message id every post this turn replies to (the
   *  triggering message — "the last message in the session" at turn start), so the
   *  bot's answer threads under it and a human reply-to-bot stitches back to this
   *  session. Undefined off Telegram. */
  tgReplyTo?: number
  /** thread_ts for the assistant status bar (always set; falls back to msgId). */
  statusThread: string
  /** P3 outbound: the final-answer selector + completed comment on the triggering
   *  GitHub issue/PR. Commentary stays transcript-local; final is awaited at turn end.
   *  For a headless hook, explicit final chunks are withheld from OutputConverger and
   *  persisted once from the collector so transport flushes cannot split one answer. */
  github?: { poster: GithubFinalPoster; collector: GithubReplyCollector; deferredFinalTranscript: boolean }
  conn?: SlackConnection | TelegramConnection | DiscordConnection | FeishuConnection
  /** Feishu/Lark's one CardKit reply entity for this turn. Undefined until
   * `card-start` succeeds; `feishuCardAttempted` prevents duplicate initial cards. */
  feishuCard?: FeishuStreamingCard
  feishuCardAttempted?: boolean
  /** True when `none` output mode removed this turn's interactive permission surface — see
   *  {@link noneSuppressedApprovalSurface}. Snapshotted at dispatch ALONGSIDE `conn`; the
   *  permission policy still queues the request for an Agent editor, but never exposes a
   *  chat-side approval card. Frozen for the turn, so a mid-turn `none → low` change can't
   *  desync it from the connection it was derived from. */
  approvalSurfaceSuppressed: boolean
  /** ts of the single in-place "main progress" message, once posted (medium/high). */
  progressTs?: string
  /** Whether the progress message's first post was attempted (so a failed initial
   *  post does not spam a duplicate on the next progress action). */
  progressAttempted?: boolean
  /** ts of the single in-place plan-summary message, once posted (medium/high). */
  planTs?: string
  /** Whether the plan message's first post was attempted (see progressAttempted). */
  planAttempted?: boolean
  /** ts of the single in-place reasoning "context block" message, once posted (high). */
  reasoningTs?: string
  /** Whether the reasoning message's first post was attempted (see progressAttempted). */
  reasoningAttempted?: boolean
  /** Telegram: the id and exact sent text of the LAST body message posted this turn, so a
   *  turn-end `continue-hint` action can append the continue-the-topic line to it in place
   *  (the body may have been flushed long before the turn ended). */
  tgLastBody?: { id: string; text: string }
  /** ts of the single in-place agent reply message (minimal mode's `live-reply`), once posted. */
  liveReplyTs?: string
  /** Whether the live-reply's first post was attempted (see progressAttempted). */
  liveReplyAttempted?: boolean
  /** Text last written to the live-reply message — skip a chat.update when unchanged. */
  liveReplyText?: string
  /** Set after an interactive card that needs a human answer (permission / elicitation) is
   *  posted: the current live reply is now ABOVE that card, so the NEXT live-reply action
   *  starts a FRESH reply BELOW the card (leaving the old one frozen above) instead of
   *  editing the one above in place. Consumed lazily by the next live-reply so an empty tail
   *  keeps the old message (and its settled footer). */
  liveReplyReanchor?: boolean
  /** Linked footer prepared before the runtime starts streaming. Every reply section is
   *  initially posted with these trailing blocks so Slack can suppress unfurls. */
  attribution?: { blocks: unknown[]; key: string }
  /** Current successfully-delivered agent reply message. `footerKey` records which footer
   *  it owns; progress/tool/reasoning chrome never replaces this pointer. */
  lastReply?: { ts: string; text: string; footerKey?: string }
  /** Older reply sections whose footer-removal update failed. Retried on the next body
   *  section and once more at finalization so a transient Slack error cannot leave two. */
  staleReplyFooters?: { ts: string; text: string }[]
  /** ts of the session's interactive status-bar message, once known. Persisted in the
   *  session row so later turns update the first line instead of posting duplicates. */
  statusBarTs?: string
  /** Whether the status bar's first post was attempted (see progressAttempted). */
  statusBarAttempted?: boolean
  /** Dedup key for the last status snapshot + cancel availability emitted this turn, so
   *  a `usage_update` that changes nothing observable skips a redundant edit. */
  lastStatusBar?: string
  /** Whether the Slack status controls may still interrupt this turn. Cleared as soon as
   *  cancellation starts or terminal cleanup begins, then included in the dedup key so
   *  the persisted status row drops its stale Cancel run option. */
  statusCancellable: boolean
  /** Whether this turn received an ACP-native cost. When true, it wins and the
   *  public-pricing fallback must not add another amount for the same turn. */
  runtimeCostReported: boolean
  /** True once the normal turn-end usage/report has been emitted. */
  usageReportSent: boolean
  /** Stable semantic turn id used by evaluation events (never shown to the model). */
  evaluationTurnId: string
  /** Pending idle-flush timer (§9.1). */
  idleTimer?: NodeJS.Timeout
  /** Periodic cumulative CardKit element flush (separate from transcript idle flush). */
  feishuStreamTimer?: NodeJS.Timeout
  /** Serializes applyAction so in-place edits don't race on progressTs/planTs/reasoningTs. */
  applyChain: Promise<void>
  /** Resolves when this turn leaves `pending` (success or failure) — drain awaits it. */
  done: Promise<void>
  /** Settles `done`; called once from dispatch's finally. */
  resolveDone: () => void
  /**
   * DAEMON-PRIVATE trusted call metadata for an agent→agent turn (design §3.3a/§6.6/§6.7).
   * Present iff this turn was started by `messageAgent`. Holds the AUTHORITATIVE caller
   * identity, correlationId, hop/origin, and stable deliveryId — kept OUT of the
   * model-visible prompt (that only ever sees `msg.text`); it is the trust basis for a
   * future auto-hop/auto-correlation of a nested `messageAgent` (§2.4). Keyed here by the
   * turn's Pending so a tool call within this turn can read it.
   * TODO(P4): move into the unified sessionKey QueueEntry/DispatchContext (§6.9 #367).
   */
  callMeta?: CallMeta
  /**
   * Present iff this is a webchat turn received over relay `rd/*`. When set,
   * onAcpUpdate maps each SessionUpdate to a WebchatEvent and streams it through
   * the relay reply sink instead of driving the Slack renderer. `index` is the per-turn monotonic
   * assembly counter incremented on each emitted WebchatOutput payload. `replyText`
   * accumulates the agent's message chunks so the finished reply is recorded to the
   * transcript once (webchat has no Slack post boundary where text is otherwise saved).
   */
  webchat?: WebchatTurnContext & { index: number; replyText: string }
}

/** Visible Slack thread messages that establish a new chronological boundary. Any live
 * in-place chrome from the active turn must continue below one of these messages. */
type LiveChromeBoundaryMessageType = 'human-input-card' | 'agent-message'

const LIVE_CHROME_BOUNDARY_MESSAGE_TYPES = new Set<LiveChromeBoundaryMessageType>(['human-input-card', 'agent-message'])

/** Exact platform delivery route retained after a turn leaves `pending`, so a
 *  late ACP title update can still rename the same Slack DM it came from. */
interface SessionDeliveryBinding {
  agentId: string
  platform: string
  integrationId?: string
  isDm: boolean
}

/**
 * Where a webchat turn's reply stream goes — the transport-neutral sink the turn engine
 * writes to instead of a hardcoded client. The relay path streams each item as `rd/chat`
 * over the relay socket the turn arrived on (milestone A4: the only webchat transport).
 */
export interface WebchatSink {
  output(o: WebchatOutput): void
  done(d: WebchatDone): void
}

interface BufferedWebchatEvent {
  event: RdChatEvent
  bytes: number
}

interface WebchatTurnContext {
  conversationId: string
  turnId: string
  sink: WebchatSink
  runtime?: WebchatRuntimeConfig
  /** Authority captured only from the relay's validated rd/msg envelope. It is
   * consumed by the daemon host selector and never forwarded to ACP/model input. */
  delegation?: WebchatMcpDelegationReference
  doneSent?: boolean
  /** This turn is driven by the local evaluation harness, not a browser. Its
   *  webchat shape is synthetic, so the session-visibility capture gate does NOT
   *  treat it as a private Playground conversation — measuring memory capture is
   *  the harness's whole purpose (session-visibility.md §4.2 applies to real
   *  user conversations). */
  evaluation?: boolean
}

/** One daemon-owned turn stream. `sink` is stable for the turn engine; `transport`
 * is rebound when a browser resumes through any relay. The replay window is
 * ephemeral, bounded, and never written to disk. */
interface WebchatTurnStream extends WebchatTurnContext {
  agentId: string
  transport: WebchatSink
  resumeGeneration: number
  replay: BufferedWebchatEvent[]
  replayBytes: number
  replayFloor: number
  replayDisabled: boolean
  lastOutputIndex: number
  completedAt?: number
}

export interface DaemonEvaluationOptions {
  /** Optional semantic-event tap. When absent, all instrumentation is a no-op. */
  observer?: EvaluationObserver
  /** Stable run identity shared by event, ATIF, and manifest artifacts. */
  runId?: string
  /** Add-on treatment. Production defaults to both configured. */
  capabilityProfile?: EvaluationCapabilityProfile
  /** Evaluation health sink. It is contained with the observer and cannot fail a turn. */
  onObserverError?: (error: unknown) => void
}

export interface DaemonEvaluationTurnInput {
  agentId: string
  conversationId: string
  text: string
  turnId?: string
  user?: string
}

export interface DaemonEvaluationTurnResult {
  turnId: string
  sessionId: string | null
  output: string
  events: WebchatEvent[]
  stopReason?: string
  usage?: { used?: number }
}

/** Build the wire SessionKey (protocol §5) for a pending turn — what `drain/done`
 *  reports as released so the CP may reassign it. Uses the real `thread` (absent for
 *  a channel-root message), NOT `statusThread` (which falls back to msgId): the CP
 *  keys assignments by `thread ?? "-"`, so reporting the msgId would miss the match. */
function pendingSessionKey(p: Pending): SessionKey {
  const platform = p.platform as SessionKey['platform']
  return p.thread !== undefined ? { platform, channel: p.channel, thread: p.thread } : { platform, channel: p.channel }
}

/** Name for a Discord thread opened off a top-level @mention: the first line of the
 *  prompt, collapsed to one line and clamped to Discord's 100-char thread-name cap
 *  (createThread also clamps). Empty prompts (e.g. attachment-only) get a default. */
function discordThreadName(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim().slice(0, 90)
  return oneLine || 'Agent thread'
}

export class Daemon {
  private readonly evaluation: EvaluationEventEmitter
  private readonly evaluationProfile: EvaluationCapabilityProfile
  private store!: LocalStore
  private mcp!: McpControlServer
  // The agent memory provider. Per-agent: it dispatches each call to the agent's
  // configured backend (managed = our <agent-root>/memory/ dir; native = the
  // runtime's own memory redirected under the private runtime HOME only while the
  // agent runs in the sandbox). Backs the memory MCP tools, the session-start index
  // injection, and the CP console's memory reads.
  private memory: DispatchingMemoryProvider = createMemoryProvider(
    (id) => {
      const agent = this.agents.get(id)
      if (!agent) return undefined
      return memoryKindOf(agent) === 'native' &&
        effectiveRunInSandbox(this.cfg.security.requireSandbox, agent.restrictFileAccess, this.sandboxMechanism)
        ? runtimeHomePath(agent.dir)
        : agent.dir
    },
    (id) => {
      const a = this.agents.get(id)
      return a ? this.runtimes[a.runtime] : undefined
    },
    (id) => {
      const a = this.agents.get(id)
      return a ? memoryKindOf(a) : 'managed'
    },
    (id) => {
      const memory = this.agents.get(id)?.memory
      return memory?.provider !== 'external' && memory?.autoDistill === true
    },
    (id, prompt) => this.runMemoryExtraction(id, prompt),
    (id) => {
      const binding = this.agents.get(id)?.memory
      return binding?.provider === 'external' ? binding : undefined
    },
    {
      registry: {
        clientFor: (connectionId) => this.memoryConnections?.clientFor(connectionId),
        specFor: (connectionId) => this.memoryConnections?.specFor(connectionId),
        markDegraded: (connectionId, reasonCode) => this.memoryConnections?.markDegraded(connectionId, reasonCode),
        markRecovered: (connectionId, reasonCodes) => this.memoryConnections?.markRecovered(connectionId, reasonCodes)
      },
      outbox: {
        enqueue: (input) => {
          if (!this.memoryOutbox) throw new MemoryProviderUnavailableError('external memory outbox is not ready')
          return this.memoryOutbox.enqueue(input)
        }
      }
    }
  )
  /** Provider-neutral serialized post-turn work. Managed distills; external enqueues capture. */
  private memoryPostTurnChains = new Map<string, Promise<void>>()
  private memoryExtractionCollectors = new Map<string, MemoryExtractionCollector>()
  /** Finished/discarded extraction sessions. ACP adapters may emit callbacks even
   *  after prompt() resolves, so retain this lightweight terminal fence until the
   *  owning host stops; otherwise late private content can escape into generic
   *  evaluation or transcript surfaces after its collector has been released. */
  private memoryExtractionQuarantines = new Map<string, string>()
  /** One isolated extractor session per agent/host lifetime (never shown to users). */
  private memoryExtractionSessions = new Map<string, string>()
  private memoryExtractionDirs = new Map<string, string>()
  /** Host instances that failed the trusted/read-only preflight; retry only after host replacement. */
  private memoryExtractionUnavailable = new WeakSet<AcpHost>()
  /** Lazily-built dream-job engine (docs/designs/memory-dreaming.md §4). */
  private dreamRunnerInstance?: DreamRunner
  private gitCreds!: GitCredentialCache
  /** Public commit attribution selected by the CP deployment's GitHub App. */
  private gitCommitIdentity?: GitCommitIdentity
  private gitCredServer?: GitCredServer
  /** run/bin with the gh wrapper (multi-repo #457) — prepended to github-app
   *  agents' PATH at host spawn; unset ⇒ shim write failed, spawn without it. */
  private ghBinDir?: string
  /** Spawn-time config warnings per agent (config-file secrets: pointer-var
   *  conflicts, write failures) — flushed into the next dispatched session. */
  private pendingSpawnNotices = new Map<string, string[]>()
  // Effective agents = the on-disk agent.json files (the single source of truth;
  // CP specs are written into them). Everything (routing, dispatch, hosts) reads
  // `agents`; `fileAgents` mirrors the loaded files and is rebuilt each reconcile.
  private agents = new Map<string, LoadedAgent>()
  private fileAgents = new Map<string, LoadedAgent>()
  private hosts = new Map<string, AcpHost>()
  // agentId → when its current host was (re)built (clock ms). The idle reaper reads
  // this so a freshly-started host that hasn't recorded session activity yet is NOT
  // treated as idle-since-epoch (`agentLastActivityTs` is unset until the first turn
  // stamps it) and reclaimed the instant it comes up, racing its own first dispatch.
  private hostStartedAt = new Map<string, number>()
  // agentId → config-file secret state for the current host (agents/config-file-env.ts).
  // Recorded at spawn because the reconcile remove path drops the roster entry BEFORE
  // stopping the host — the agent dir can't be re-resolved there. `childEnv` is the
  // merged spawn env snapshot the materialization was planned from: the idle sweep
  // deletes the files once the agent goes quiet (`materialized` → false) and
  // rematerializeConfigFiles() re-writes them from this snapshot before the next
  // turn — the pointer env vars fixed at spawn always reference the same paths, so
  // the warm child never notices.
  private hostConfigFiles = new Map<
    string,
    { agentDir: string; childEnv?: Record<string, string | undefined>; materialized: boolean }
  >()
  // Background-task lease keyed by acpSessionId, fed by the Claude SDK lifecycle
  // feed (`_claude/sdkMessage`, claude-agent-acp ≥ 0.59.0). A session is NOT
  // quiescent — and its host must not be idle-reclaimed nor the session TTL-closed —
  // while it has live background tasks OR the SDK's top-level cycle is `running`
  // (a self-initiated followup turn that Claude wakes to drain a completed bg task,
  // with no user prompt and thus no `this.pending` entry). `end_turn` from
  // AcpHost.prompt() is NOT the end of work. Absent (non-Claude runtime, or an
  // adapter that doesn't forward the feed) ⇒ treated as quiescent ⇒ plain-TTL behavior.
  // See docs/designs/background-task-aware-reclaim.md.
  // Keyed by {@link sdkLeaseKey} — NOT by bare acpSessionId, which is runtime-local.
  private sdkLease = new Map<
    string,
    {
      agentId: string
      tasks: Map<string, { description?: string; isSubagent: boolean }>
      sdkState: 'idle' | 'running'
      /** Background-task wakes already spent on this session — see
       *  {@link MAX_BG_TASK_WAKES_PER_SESSION}. */
      bgWakes: number
      /** Wake timers armed (or deferred) but not yet fired. `settle()` removes the task
       *  BEFORE arming the timer, so without counting these the session would read as
       *  quiescent during the grace/re-arm window and an idle sweep could close it (and drop
       *  the lease) out from under a completion that is about to be delivered. Deliberately
       *  SEPARATE from {@link deliveringWakes}: several armed timers coalesce (none has run),
       *  whereas a delivery in flight must never absorb a newly settled task. */
      armedWakes: number
      /** Wake dispatches in flight — taken before `dispatch()` and released when its promise
       *  settles, so the fence spans async turn initialization. Counted apart from
       *  `armedWakes` because a delivery is past the point where it could carry another
       *  task's completion: once `host.prompt()` has returned the model is no longer running,
       *  yet the dispatch stays pending through renderer/finalization. */
      deliveringWakes: number
    }
  >()
  /** Armed background-task wake checks (one per settled non-subagent task), tracked so
   *  daemon drain cannot leave a timer behind. The callback re-validates everything it
   *  needs, so a lease dropped by stopHost simply makes the wake a no-op. */
  private bgWakeTimers = new Set<TimerHandle>()
  private connections: SlackConnection[] = []
  // Telegram long-poll connections (one per bot token). Kept parallel to `connections`
  // (Slack) — the Slack socket layer (appToken keying, retry, refreshChannels) is
  // untouched; Telegram gets its own map so its conns never flow through Slack-only code.
  private telegramConns: TelegramConnection[] = []
  // Discord Gateway connections (one per bot token). Parallel to Slack/Telegram —
  // its own map so its conns never flow through Slack-only code (`.appToken` reads).
  private discordConns: DiscordConnection[] = []
  // Feishu WSClient long-connections (one per appId). Parallel to Slack/Telegram/Discord —
  // its own map so its conns never flow through Slack-only code (`.appToken` reads).
  private feishuConns: FeishuConnection[] = []
  // In-flight connect guards: a token/appId is added BEFORE `await conn.start()` and
  // removed once it resolves (and is pushed onto the *Conns list) or fails. The per-token
  // `find()` dedup in each reconcile only sees a conn AFTER it's pushed, so without this a
  // reconcile overlapping a still-pending connect (the initial background connects now run
  // concurrently with CP/file-watch-driven reconciles, and the window widens to the whole
  // outage when the platform API is unreachable) would open a *second* connection for the
  // same bot → duplicate inbound delivery. Checked alongside `find()` to serialize opens.
  private telegramConnecting = new Set<string>()
  private discordConnecting = new Set<string>()
  private feishuConnecting = new Set<string>()
  // Slack id → display-name resolver (created with the store in start()).
  private nameResolver?: SlackNameResolver
  // agentId → its directory name, learned from `channelAgents` (the listAgents tool)
  // responses. REMOTE agents (hosted on another daemon) aren't in `this.agents`, so this is
  // the only local source for their display name when addressing them in a visible agent-call
  // post. Warm whenever a call is legitimately made — the caller must have listed the channel
  // (which is where it learned the target's id) — with a raw-agentId fallback if it's cold.
  private readonly channelAgentNames = new Map<string, { name?: string; displayName?: string }>()
  // Discord/Telegram channel id → display-name resolver (Slack learns names in bulk
  // from its membership snapshot instead — see refreshChannels). Created in start().
  private channelNameResolver?: ChannelNameResolver
  private scheduler!: Scheduler
  private dreamScheduler!: DreamScheduler
  private sessions!: SessionManager
  // integrationId -> the SlackConnection that owns it (for replies). Holds BOTH
  // socket-mode (direct) and send-only (HTTP-bot) connections — an HTTP bot's
  // send-only client is registered here too so replies/attachments/MCP reuse it.
  private connByIntegration = new Map<string, SlackConnection>()
  // HTTP-bot send-only Slack clients, keyed by xoxb (one per bot token; the relay
  // owns their inbound). Separate from the direct sockets so reconcile can dedup +
  // tear down a bot's old direct socket when it flips to HTTP transport.
  private httpSlackConns = new Map<string, SlackConnection>()
  // integrationId -> the TelegramConnection that owns it (for replies). Separate from
  // connByIntegration so Slack reconcile (which reads `.appToken`) never sees a Telegram conn.
  private tgConnByIntegration = new Map<string, TelegramConnection>()
  // integrationId -> the DiscordConnection that owns it (for replies). Separate from
  // connByIntegration so Slack reconcile (which reads `.appToken`) never sees a Discord conn.
  private dcConnByIntegration = new Map<string, DiscordConnection>()
  // integrationId -> the FeishuConnection that owns it (for replies). Separate from
  // connByIntegration so Slack reconcile (which reads `.appToken`) never sees a Feishu conn.
  private fsConnByIntegration = new Map<string, FeishuConnection>()
  // agentId → the in-flight (or resolved) host-startup promise. Resolves to the
  // STARTED host (startHostWithRetry may build several across retries — the last,
  // successful one wins). `.has()` doubles as "is this agent starting / started?".
  private hostStarts = new Map<string, Promise<AcpHost>>()
  // Monotonic per-agent fence. stop/evict increments it so an older async startup
  // (including its retry loop) can never publish or retry after teardown.
  private hostStartGeneration = new Map<string, number>()
  // Wakes a retry that is sleeping in backoff when its generation is invalidated.
  // Without this, shutdown could return while an old timer still owns executable work.
  private hostStartAborts = new Map<string, AbortController>()
  private watcher?: FSWatcher
  private debounceTimer?: NodeJS.Timeout
  private agentsDir = ''
  private cfg!: ReturnType<typeof loadConfig>
  private log: Logger = makeLogger('info')
  private root = ''
  // Background host-load sampler (CPU/mem via systeminformation), started with the CP
  // client since its snapshot only feeds the heartbeat's `load`. Read synchronously.
  private metrics?: SystemMetrics
  private runtimes: Record<string, import('./config/config-schema.js').RuntimeDef> = {}
  /** All installed winners, including curated candidates still awaiting ACP admission. */
  private runtimeCatalog: ResolvedRuntimeCatalog = { entries: {}, runtimes: {} }
  private readonly curatedRuntimeAdmission: CuratedRuntimeAdmission
  // Live Linux SRT/bwrap support, detected once at boot. undefined means optional
  // per-agent requests are ineffective; security.requireSandbox refuses startup
  // (including on unsupported macOS/Windows hosts).
  private sandboxMechanism: SandboxMechanism | undefined
  private runtimeNames: Record<string, string> = {} // registry id -> display name (for CP reporting)
  private runtimeVersions: Record<string, string> = {} // registry id -> version (for the facts/daemon-runtimes snapshot)
  // Models learned by actively probing each runtime (registry id -> model ids).
  // Empty/absent until the post-connect probe sweep completes; feeds runtimeProfiles().
  private runtimeModels = new Map<string, string[]>()
  // ACP protocol version each runtime negotiated at its last probe; feeds runtimeProfiles().
  private runtimeAcpVersions = new Map<string, number>()
  // The agent's self-reported version (`agentInfo.version` from `initialize`) learned
  // at the last probe — the ACTUAL running adapter release (e.g. claude-agent-acp
  // 0.59.0). Preferred over the registry's declared version in runtimeProfileFor().
  private runtimeProbedVersions = new Map<string, string>()
  // MCP transports each runtime advertised at its last probe; feeds runtimeProfiles()
  // and gates which configured http/sse servers attach at session/new (absent ⇒ not
  // probed yet ⇒ assume stdio-only but attach optimistically — see resolve-servers.ts).
  private runtimeMcpCaps = new Map<string, McpTransportCapabilities>()
  // Provenance of runtimeModels entries: 'cached' = hydrated from the local
  // catalog cache at boot (a live probe has not confirmed it this process) —
  // the activation model gate treats it as permissive; 'probed' = live result.
  private runtimeModelsSource = new Map<string, 'cached' | 'probed'>()
  // Runtimes whose last probe was rejected with the ACP auth-required error
  // (-32000): installed but needing an interactive login on this host. Feeds the
  // console's per-runtime login warning; cleared on any successful probe.
  private runtimeAuthRequired = new Set<string>()
  // Same signal observed on a LIVE turn (dispatch): kept separate from the
  // probe-derived set because a successful probe must not clear it —
  // claude-agent-acp initializes, opens sessions, and enumerates models fine
  // while logged out and only rejects the live prompt with -32000, so the probe
  // sweep is blind to its login state. Cleared by the next successful turn.
  private runtimeAuthRequiredLive = new Set<string>()
  // Report-shape model catalogs (last-good CAPABILITY knowledge, augmented for
  // reporting). Deliberately independent of the fail-to-empty rule that wipes
  // runtimeModels (ADVERTISEMENT): a probe failure empties the offered list but
  // keeps the catalog, so the CP's capability data survives transient timeouts.
  private runtimeCatalogs = new Map<string, RuntimeModelCatalog>()
  private modelCatalogSvc?: ModelCatalogService
  // EFFECTIVE MCP-server defs (local config `mcpServers` with CP-pushed defs layered
  // on top, CP wins) — resolved into agent sessions and reported to the CP (name +
  // transport) alongside runtimes. Recomputed from `cpMcpDefs` whenever the CP set changes.
  private mcpServerDefs: Record<string, import('./config/config-schema.js').McpServerDef> = {}
  // CP-pushed MCP defs over the local base (centralized-tool-management.md §7/§8);
  // memory-only, re-converged from register/ok. Built from config at start.
  private cpMcpDefs?: import('./mcp/cp-mcp-defs.js').CpMcpDefs
  /** CP-owned, daemon-private external-memory definitions + verified clients. */
  private memoryConnections?: CpMemoryConnectionRegistry
  /** Durable reply-after-delivery capture pump. Bodies remain in LocalStore. */
  private memoryOutbox?: MemoryCaptureOutbox
  private probing = false // a probe sweep is in flight (dedup concurrent onReady fires)
  private ordinaryProbePending = false // a CP-ready sweep arrived behind a local curated sweep
  private curatedProbePending = false // a local TTL sweep arrived behind another sweep
  private lastProbeAtMs = 0 // when ordinary runtimes were last swept; gates re-probe on reconnect
  private runtimeProbeTimer?: TimerHandle
  private cpClient?: CpClient
  /** Present only when the complete enforced-bwrap delegated MCP path initialized. */
  private delegatedMcpBroker?: SessionMcpBroker
  private delegatedWebchatHosts?: DelegatedWebchatHostManager
  private relays?: RelayManager
  private cpCrons?: CpCronRegistry
  // Latest channel report per integrationId plus whether it came from a complete
  // membership listing. Replayed with the same authority on each CP (re)connect.
  private channelSnapshots = new Map<string, { channels: IntegrationChannel[]; authoritative: boolean }>()
  private cpAgents?: CpAgentRegistry
  private cpIntegrations?: CpIntegrationRegistry
  private botUserIds: Record<string, string> = {}
  private cpRouting?: CpRoutingLayer
  // Daemon-side cache of the bot-agnostic collaboration snapshot (agent-collaboration
  // §2.3/§6.2) — the terminal-verify source for forwarded REMOTE agent callers.
  private readonly cpCollab = new CpCollabRoutes()
  /** One active PR hook turn per logical session key. Long-lived ACP sessions
   * may span deliveries, so authorization must never live in SessionContext. */
  private readonly activeGithubTurnMeta = new Map<string, ActiveGithubTurnMeta>()
  private readonly githubReviewClient = new GithubReviewClient()
  // ── lifecycle (§2.5/§5.3/§7.2/§7.3) ──
  private clock: Clock
  private requestExit: (code: number) => void
  // Guards against a second CP lifecycle command (restart/upgrade) racing one
  // already in flight (§7.1). Cleared only if an upgrade aborts before exiting.
  private lifecycleInFlight = false
  // Whole-daemon drain gate: once set, no new turns are dispatched (SIGTERM, or a
  // scope:daemon drain). Agent-scoped drains gate just their agentId.
  private draining = false
  private drainingAgents = new Set<string>()
  // Agents removed/detached by a CP lifecycle frame or reconnect convergence.
  // Only a later authoritative CP upsert/snapshot may revive them; until then
  // this separate latch keeps the admission gate closed.
  private cpDroppedAgents = new Set<string>()
  // Pause/loop interruption keeps an agent-level admission gate latched until every
  // targeted turn has fully unwound (including cancel backstops). This prevents a
  // quick reset or another-thread message from starting work an old backstop could kill.
  private safetyDrainingAgents = new Set<string>()
  private safetyDrainWaits = new Map<string, Set<Promise<void>>>()
  private safetyDrainRuns = new Map<string, symbol>()
  // Cold-move staging is distinct from an ordinary agent/stop gate: staged
  // agents are excluded from the effective roster, so restoring an old archive
  // during bootstrap cannot reopen stale platform credentials before activate
  // exact-sets its CP-owned dependents.
  private moveStagedAgents = new Set<string>()
  private moveStageMetadata = new Map<string, AgentMoveStageMetadata>()
  private activatingAgents = new Set<string>()
  /** Suppress reconcile's fire-and-forget clone while an acknowledged activation
   *  owns atomic workspace materialization. */
  private preparingWorkspaces = new Set<string>()
  // Per-agent queue + same-request join. CP has its own move mutex, but daemon
  // handlers still need serialization because transport retransmits a REQ up to
  // five times and different lifecycle frames may arrive before an ACK lands.
  private agentMoveTails = new Map<string, Promise<void>>()
  private agentMoveInFlight = new Map<string, Promise<Ack>>()
  // dispatchOne leases close the pre-pending gap: a turn captures its platform
  // connection before sessions.handle() returns and before it appears in `pending`.
  // Agent detach waits these leases before archiving/closing the last connection.
  private activeDispatchesByAgent = new Map<string, Set<Promise<void>>>()
  private activeDispatchDoneByKey = new Map<string, Promise<void>>()
  private workspaceFileWrites = new Map<string, Promise<void>>()
  // Connection-specific half of the same lease. Unlike `pending[].conn`, this is
  // acquired immediately when dispatchOne captures replyConn, before its first
  // await, so ordinary config reconciliation cannot close that pre-pending use.
  private activeReplyConnectionUses = new Map<
    SlackConnection | TelegramConnection | DiscordConnection | FeishuConnection,
    Set<Promise<void>>
  >()
  private sessionDeliveryBindings = new Map<string, SessionDeliveryBinding>()
  // ACP adapters may emit title/usage metadata before session/new returns, while
  // SessionManager has not committed the local row yet. Buffer only those
  // latest-wins metadata kinds until the exact initialization materializes.
  private sessionInitializationsByAgent = new Map<string, number>()
  private earlySessionMetadata = new Map<
    string,
    { agentId: string; sessionId: string; updates: { sessionUpdate: string; [key: string]: any }[] }
  >()
  // In-progress host teardowns, keyed by agentId. ensureHostAsync awaits an entry
  // before (re)spawning so a stop racing a new message can't leave two live hosts.
  private hostStopping = new Map<string, Promise<void>>()
  // Recurring idle sweep (reap idle hosts + TTL-close idle sessions).
  private idleSweepTimer?: TimerHandle
  // Last probe-temp-root reclaim, so it rides the idle sweep at its own slower
  // cadence — the OS temp dir can hold thousands of entries to scan.
  private lastProbeRootSweepAt = 0
  // §7.3 force-cancel backstops, keyed by (agentId, acpSessionId); cleared at turn end.
  private cancelTimers = new Map<string, TimerHandle>()
  // Backstop for an interrupt that lands before a Pending/ACP session id exists
  // (host startup / session materialization). Keyed by logical session key and guarded
  // by the exact active-dispatch promise so an old timer cannot stop a newer turn.
  private coldCancelTimers = new Map<string, { timer: TimerHandle; active: Promise<void> }>()
  // Pending background retry timers for Slack connections that failed to open
  // at startup (keyed by appToken). Cleared on daemon stop.
  private slackRetryTimers = new Map<string, TimerHandle>()
  // Durable hook/report outbox drain. A READY socket may survive a temporary
  // CP/DB failure, so retries cannot depend only on reconnect callbacks.
  private hookReportRetryTimer?: TimerHandle
  private transcriptActivityTimers = new Map<string, { timer: TimerHandle; activity: SessionActivity }>()
  private readonly hookReportInflight = new Set<string>()
  // Fresh per READY connection. Legacy CPs have no correlated ACK, so the local
  // outbox stamps each best-effort EVT with this generation and sends it at
  // most once until reconnect (while retaining the report for a future upgrade).
  private hookReportConnectionId = randomUUID()
  // A timer callback may already be inside conn.start() when an agent detaches.
  // Track those runs so detach can await them and prevent a stale socket from
  // appearing after its strict close pass has ACKed.
  private slackRetryRuns = new Map<string, { botToken: string; promise: Promise<void> }>()

  constructor(
    private opts: {
      root?: string
      configPath?: string
      overrides?: FlatOverrides
      agentName?: string
      hostFactory?: (agent: Agent, onUpdate: (sid: string, u: any) => void) => AcpHost
      /** Time seam for the idle sweep + cancel backstop (FakeClock in tests). */
      clock?: Clock
      /** How the daemon exits for daemon/restart + daemon/upgrade (spied in tests). */
      requestExit?: (code: number) => void
      /** Who supervises this process — 'cli' (respawn shell) or 'service' (launchd/
       *  systemd). Set by the launcher via AGENTCONNECT_SUPERVISOR. Absent/unknown
       *  means no supervisor (bare `node dist/index.js run`), so CP-commanded
       *  restart/upgrade is refused: exiting would leave the daemon down
       *  (cli-daemon-split.md §7.1). */
      supervisor?: string
      /** Seam for the post-connect runtime probe sweep (tests inject a fake to avoid
       *  spawning real agent subprocesses). Defaults to the real `probeAllRuntimes`. */
      probeRuntimes?: (
        runtimes: Record<string, import('./config/config-schema.js').RuntimeDef>,
        opts: ProbeOptions
      ) => Promise<RuntimeProbeResult[]>
      /** Test seams for local catalog resolution and executable/state filtering. */
      resolveCatalog?: typeof resolveRuntimeCatalog
      installed?: typeof installedRuntimes
      /** Test seam: null simulates a host without Linux SRT/bwrap. */
      sandboxMechanism?: SandboxMechanism | null
      /** Test seam for delegated-isolation capability gating. */
      platform?: NodeJS.Platform
      /** Test seam for the daemon-private memory-plugin transport. */
      memoryPluginConnect?: MemoryPluginConnector
      /** Optional, observer-only evaluation surface and add-on treatment. */
      evaluation?: DaemonEvaluationOptions
    } = {}
  ) {
    this.sandboxMechanism = opts.sandboxMechanism === null ? undefined : (opts.sandboxMechanism ?? detectSandbox())
    this.clock = opts.clock ?? systemClock
    if (opts.evaluation?.capabilityProfile && !opts.evaluation.observer) {
      throw new Error('evaluation capability profile requires an evaluation observer')
    }
    this.evaluationProfile = EvaluationCapabilityProfileSchema.parse(
      opts.evaluation?.capabilityProfile ?? { memory: 'configured', collaboration: 'configured' }
    )
    this.evaluation = new EvaluationEventEmitter({
      observer: opts.evaluation?.observer,
      runId: opts.evaluation?.runId,
      now: () => this.clock.now(),
      onObserverError: (error) => {
        this.log.warn(`evaluation observer failed: ${error instanceof Error ? error.name : 'unknown'}`)
        opts.evaluation?.onObserverError?.(error)
      }
    })
    this.curatedRuntimeAdmission = new CuratedRuntimeAdmission({
      now: () => this.clock.now(),
      ttlMs: Daemon.PROBE_TTL_MS
    })
    this.requestExit = opts.requestExit ?? ((code) => process.exit(code))
  }

  private emitEvaluation(input: EvaluationEventInput): void {
    this.evaluation.emit(input)
  }

  private evaluationTurnIdFor(agentId: string, msg: NormalizedMessage): string {
    return stableTurnId(agentId, msg)
  }

  /** Drive a real daemon turn through the same SessionManager, ACP host, memory,
   * permission, MCP, serial-gate, and transcript path as relay webchat. This is the
   * only product-specific surface the Promptfoo adapter needs. */
  async runEvaluationTurn(input: DaemonEvaluationTurnInput): Promise<DaemonEvaluationTurnResult> {
    if (!this.evaluation.enabled) throw new Error('daemon evaluation observer is not enabled')
    if (!this.agents.has(input.agentId)) throw new Error(`unknown evaluation agent ${input.agentId}`)

    const turnId = input.turnId?.trim() || randomUUID()
    const events: WebchatEvent[] = []
    let terminal: WebchatDone | undefined
    const sink: WebchatSink = {
      output: (output) => {
        if (output.event) events.push(output.event)
      },
      done: (done) => {
        terminal = done
      }
    }
    const message: NormalizedMessage = {
      msgId: `webchat:${input.conversationId}`,
      traceId: turnId,
      source: 'user',
      platform: 'webchat',
      channel: input.conversationId,
      sender: { id: input.user?.trim() || 'evaluation-user', isBot: false },
      text: input.text,
      mentionedBots: [],
      isDm: true,
      trigger: 'dm'
    }
    const sessionId = await this.dispatch(input.agentId, message, undefined, {
      conversationId: input.conversationId,
      turnId,
      sink,
      evaluation: true
    })
    // Product turns intentionally enqueue post-turn memory work. Evaluation waits
    // for this agent's chain so the returned artifact has a terminal capture event.
    await (this.memoryPostTurnChains.get(input.agentId) ?? Promise.resolve())
    return {
      turnId,
      sessionId,
      output: events
        .filter((event): event is Extract<WebchatEvent, { kind: 'message' }> => event.kind === 'message')
        .map((event) => event.text)
        .join(''),
      events,
      ...(terminal?.stopReason ? { stopReason: terminal.stopReason } : {}),
      ...(terminal?.usage ? { usage: terminal.usage } : {})
    }
  }

  /** Wait until turns spawned asynchronously by collaboration have left the real
   * serial gate and all provider-neutral post-turn memory chains have settled. */
  async waitForEvaluationIdle(timeoutMs = 30_000): Promise<void> {
    if (!this.evaluation.enabled) throw new Error('daemon evaluation observer is not enabled')
    const deadline = Date.now() + Math.max(1, timeoutMs)
    while (this.inflight.size > 0 || this.activeDispatchesByAgent.size > 0) {
      if (Date.now() >= deadline) throw new Error(`evaluation daemon did not become idle within ${timeoutMs}ms`)
      const active = [...new Set([...this.activeDispatchesByAgent.values()].flatMap((runs) => [...runs]))]
      if (active.length > 0) {
        const remaining = Math.max(1, deadline - Date.now())
        let timer: NodeJS.Timeout | undefined
        await Promise.race([
          Promise.allSettled(active),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`evaluation daemon did not become idle within ${timeoutMs}ms`)),
              remaining
            )
          })
        ]).finally(() => {
          if (timer) clearTimeout(timer)
        })
      } else {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
    await Promise.all([...this.memoryPostTurnChains.values()])
  }

  async start(): Promise<void> {
    const root = resolveRoot(this.opts.root)
    const cfg = loadConfig({
      root,
      configPath: this.opts.configPath,
      overrides: this.opts.overrides,
      optional: !!this.opts.agentName,
      autoCreate: true
    })
    this.cfg = cfg
    configureWorkspaceGitOrigins(cfg.security.workspaceGitAllowedOrigins)
    if (cfg.security.requireSandbox && !this.sandboxMechanism) {
      throw new Error(
        'daemon startup refused: security.requireSandbox is true but this host has no supported Linux SRT/bwrap mechanism'
      )
    }
    if (this.sandboxMechanism === 'bwrap') {
      for (const privateRoot of [delegatedMcpBrokerRoot(root), delegatedMcpRuntimeHomeRoot(root)]) {
        mkdirSync(privateRoot, { recursive: true, mode: 0o700 })
        const info = lstatSync(privateRoot)
        if (!info.isDirectory() || info.isSymbolicLink()) {
          throw new Error('daemon startup refused: delegated private root must be a real directory')
        }
        chmodSync(privateRoot, 0o700)
      }
    }
    // Mint a stable local daemonId only when we are NOT onboarding via a CP
    // token: with a `controlPlane.key` and no explicit id, the CP assigns the
    // id from the token's `sub` and the daemon adopts it (see startCpClient).
    const cpKeyOnboarding = !!(cfg.controlPlane?.enabled && cfg.controlPlane.key)

    // github-app git credentials — initialized FIRST: reconcile-time prefetch
    // clones can fire as soon as agents load, and they pre-warm through this
    // cache. The request fn resolves this.cpClient lazily (it connects later);
    // until the WS is READY a pull just fails fast and the prefetch retries at
    // first session. Everything written to disk here is secret-free.
    this.gitCreds = new GitCredentialCache({
      request: (payload) => {
        const client = this.cpClient
        if (!client) throw Object.assign(new Error('control plane is not connected'), { code: 'INTERNAL' })
        return client.requestGitCred(payload)
      },
      log: { warn: (m: string) => this.log.warn(m) },
      actionsSupported: () => this.cpClient?.supportsServerFeature('gitcred-actions-v1') ?? false
    })
    this.gitCredServer = new GitCredServer(this.gitCreds, gitcredSocketPath(root), {
      log: {
        info: (m: string) => this.log.info(m),
        warn: (m: string) => this.log.warn(m)
      },
      // Folds a helper request naming the workspace repo onto the repo-less
      // cache key (shared with pre-warm/spawn; old-CP-safe).
      workspaceRepoOf: (agentId: string) => {
        const ws = this.agents.get(agentId)?.workspace
        if (ws?.mode !== 'git-repo' || !ws.gitRepo) return undefined
        return gitRepoLabel(ws.gitRepo) ?? undefined
      }
    })
    initGitInjection({
      shimPath: writeGitcredShim(root, daemonEntryForShims(root)),
      runDir: join(root, 'run'),
      capabilityFor: (agentId) => this.gitCredServer!.capabilityFor(agentId),
      preWarm: async (agentId, reason) => {
        await this.gitCreds.get(agentId, reason)
      }
    })
    try {
      // gh wrapper (multi-repo #457) — secret-free, regenerated per boot like
      // the git shim. A write failure only costs gh per-repo credentials, so it
      // must not block startup.
      this.ghBinDir = writeGhShim(root, daemonEntryForShims(root))
    } catch (err) {
      this.log.warn(`gitcred: gh wrapper shim write failed — spawning agents without it (${formatErr(err)})`)
    }
    this.gitCredServer.start()
    probeGitVersion((m) => this.log.warn(m))
    if (!cfg.daemonId && !cpKeyOnboarding) {
      cfg.daemonId = randomUUID()
      persistDaemonId(root, cfg.daemonId, this.opts.configPath)
    }
    this.log = makeLogger(cfg.logging.level)
    this.log.info(`starting daemon (root=${root})`)
    // Reclaim probe temp roots orphaned by an earlier lifetime (a hard kill mid-sweep,
    // or a runtime that kept writing after its adapter was reaped). Each can hold a
    // private runtime HOME, so without this they accumulate until the disk fills.
    sweepStaleProbeRoots({ log: this.log })
    this.log.info(
      `control plane: ${cfg.controlPlane?.enabled ? `enabled (${cfg.controlPlane.url ?? 'no url'})` : 'disabled — running local'}`
    )
    this.agentsDir = cfg.agentsDir!
    this.moveStageMetadata = agentMoveStages(this.agentsDir)
    this.moveStagedAgents = new Set(
      [...this.moveStageMetadata].filter(([, metadata]) => metadata.state === 'staging').map(([agentId]) => agentId)
    )
    for (const agentId of this.moveStagedAgents) this.drainingAgents.add(agentId)
    const discoveredAgents = this.loadAgentList()
    for (const agent of discoveredAgents) {
      try {
        const removed = cleanupStaleWorkspaceClones(agent)
        if (removed > 0) {
          this.log.info(`workspace: removed ${removed} stale conversion clone(s) for agent "${agent.id}"`)
        }
      } catch (err) {
        // A stale temp tree must never prevent the daemon from serving the real
        // workspace. A later restart can retry the best-effort cleanup.
        this.log.warn(`workspace: stale conversion clone cleanup failed for agent "${agent.id}" (${formatErr(err)})`)
      }
      // No host is running at boot, so no materialized config-file secret should
      // exist. A clean shutdown removed them in stopHost; sweep what a
      // non-graceful exit (crash/SIGKILL) left behind.
      const staleConfigFiles = cleanupConfigFiles(agent.dir)
      if (staleConfigFiles)
        this.log.warn(`config-files: startup cleanup for agent "${agent.id}" failed — ${staleConfigFiles}`)
    }
    const agents = discoveredAgents.filter((agent) => !this.moveStagedAgents.has(agent.id))
    this.fileAgents = new Map(discoveredAgents.map((a) => [a.id, a]))
    // `this.agents` is populated from the file agents once the CP registries are
    // built below; see effectiveAgents().
    this.log.info(
      `loaded ${agents.length} agent(s) from ${this.agentsDir}${agents.length ? `: ${agents.map((a) => a.id).join(', ')}` : ''}`
    )

    this.root = root
    const resolvedCatalog = await (this.opts.resolveCatalog ?? resolveRuntimeCatalog)(cfg, root, {
      neededRuntimes: discoveredAgents.map((a) => a.runtime),
      mode: 'cache-first'
    })
    // Advertise (and launch) only runtimes actually installed on this host — the
    // registry lists every known agent, but most aren't present here.
    const installedCatalog = this.opts.installed
      ? (() => {
          const runtimes = this.opts.installed!(resolvedCatalog.runtimes)
          return {
            runtimes,
            entries: Object.fromEntries(
              Object.entries(resolvedCatalog.entries).filter(([id]) => runtimes[id] !== undefined)
            )
          }
        })()
      : installedRuntimeCatalog(resolvedCatalog)
    const { runtimes: installed, entries: installedEntries } = installedCatalog
    this.runtimeCatalog = installedCatalog
    this.refreshAdmittedRuntimes()
    this.runtimeNames = Object.fromEntries(
      Object.entries(installedEntries).map(([id, entry]) => [id, entry.name || id])
    )
    this.runtimeVersions = Object.fromEntries(
      Object.entries(installedEntries).map(([id, entry]) => [id, entry.version])
    )
    this.log.info(`runtimes ready: ${Object.keys(this.runtimes).join(', ') || '(none)'}`)
    const pendingCurated = Object.keys(installed).filter((id) => installedEntries[id]?.source === 'curated')
    if (pendingCurated.length) this.log.info(`runtimes pending ACP admission: ${pendingCurated.join(', ')}`)
    const skipped = Object.keys(resolvedCatalog.runtimes).filter((id) => !installed[id])
    if (skipped.length) this.log.info(`runtimes not installed (skipped): ${skipped.join(', ')}`)

    // Configured MCP servers — the reserved bridge key is stripped ONCE here, so
    // every consumer (the probe sweep, agent-session resolution) sees a clean map.
    const { [RESERVED_MCP_SERVER_NAME]: reservedMcp, ...mcpServerDefs } = cfg.mcpServers ?? {}
    if (reservedMcp)
      this.log.warn(`mcp: config server name "${RESERVED_MCP_SERVER_NAME}" is reserved for the daemon bridge — ignored`)
    this.cpMcpDefs = new CpMcpDefs(mcpServerDefs)
    this.mcpServerDefs = this.cpMcpDefs.effective()
    if (Object.keys(mcpServerDefs).length)
      this.log.info(`mcp servers configured: ${Object.keys(mcpServerDefs).join(', ')}`)

    this.memoryConnections = new CpMemoryConnectionRegistry({
      ...(this.opts.memoryPluginConnect ? { connect: this.opts.memoryPluginConnect } : {}),
      stdioAllowlist: cfg.memoryPlugins ?? {},
      onFacts: (facts) => this.cpClient?.emitMemoryConnectionFacts(facts),
      onDefinitionChange: (connectionId) => this.onMemoryConnectionDefinitionChange(connectionId)
    })

    this.store = new LocalStore(statePath(root))
    this.store.setTranscriptMutationListener((mutation) => this.scheduleSessionActivity(mutation))
    this.memoryOutbox = new MemoryCaptureOutbox(this.store, this.memoryConnections, {
      log: { warn: (message) => this.log.warn(message) }
    })
    this.memoryOutbox.start()
    // Model-catalog cache: synchronous last-good hydrate BEFORE the CP client
    // starts, so the register-time facts snapshot already carries models + the
    // capability matrix instead of blanking the CP until the sweep completes.
    this.hydrateRuntimeCatalogCache()
    this.modelCatalogSvc = new ModelCatalogService({
      store: this.store,
      log: this.log,
      now: () => this.clock.now(),
      // No hostFactory seam here: daemon unit tests never reach the enumerator
      // (the probe sweep early-returns under the fake-host guard, so noteProbe
      // never fires); enumerator tests inject a fake EnumerateFn instead.
      enumerate: makeModelEnumerator({
        log: this.log,
        isolateAccountApps: this.cfg.security.isolateAccountApps,
        sandboxMechanism: this.sandboxMechanism,
        daemonRoot: root,
        agentsRoot: this.cfg.agentsDir,
        mcpSocketPath: mcpSocketPath(root),
        maskedReadRoots:
          this.sandboxMechanism === 'bwrap'
            ? [delegatedMcpBrokerRoot(root), delegatedMcpRuntimeHomeRoot(root)]
            : undefined
      }),
      onUpdated: (runtimeId) => {
        this.rebuildRuntimeCatalog(runtimeId)
        this.cpClient?.emitDaemonRuntimes?.(
          this.admittedRuntimeIds().map((id) => this.runtimeProfileFor(id)),
          this.mcpServerFactsFromDefs()
        )
      }
    })
    // Off-hot-path Slack id → display-name resolution, cached into the store so
    // session read-back can label channels/senders without a live Slack call.
    this.nameResolver = new SlackNameResolver((id, name) => {
      this.store.setDisplayName(id, name, Date.now())
      this.emitSessionMetadataSnapshotsForDisplayName(id)
    }, this.log)
    // Same cache-then-emit sink for Discord/Telegram/Feishu channel and user names.
    this.channelNameResolver = new ChannelNameResolver(
      (id, name) => {
        this.store.setDisplayName(id, name, Date.now())
        this.emitSessionMetadataSnapshotsForDisplayName(id)
        // A freshly-resolved Telegram/Discord/Feishu channel name should also refresh that
        // integration's observed-channel snapshot (approach-A discovery) so the console
        // shows the human name rather than the raw chat/channel id.
        this.refreshObservedChannels()
      },
      {
        // A newly-learnt scope changes which rows the observed set collapses onto (a
        // Discord thread folds into its channel), so re-emit the snapshot with it.
        saveScope: (id, scope) => {
          this.store.setChannelScope(id, scope, Date.now())
          this.refreshObservedChannels()
        },
        log: this.log
      }
    )
    this.cpRouting = new CpRoutingLayer({
      load: () => {
        const row = this.store.getCpRouting()
        return row
          ? {
              routingEpoch: row.routingEpoch,
              assignments: JSON.parse(row.assignments),
              globalRules: JSON.parse(row.globalRules)
            }
          : undefined
      },
      save: (s) => this.store.setCpRouting(s.routingEpoch, JSON.stringify(s.assignments), JSON.stringify(s.globalRules))
    })
    // CP agent specs are written straight to the on-disk agent.json (the single
    // source of truth) via create-or-merge keyed by agentId; a write re-reconciles
    // (re-loads agents from disk; restarts a host only on a real config change).
    this.cpAgents = new CpAgentRegistry(
      this.agentsDir,
      { knownRuntimes: Object.keys(this.runtimeCatalog.runtimes), warn: (m) => this.log.warn(m) },
      () =>
        void this.reconcile().catch((err) =>
          this.log.error(`cp: agent reconcile failed: ${(err as Error).stack ?? err}`)
        )
    )
    // CP integrations are written straight to the owning agent's on-disk agent.json
    // `integrations[]` (the single source of truth) — so they survive a restart with
    // the CP down and start() opens the Socket Mode sockets from disk alone. A write
    // re-reconciles (diffAgents flags the integrations dimension → re-opens/binds).
    this.cpIntegrations = new CpIntegrationRegistry(
      this.agentsDir,
      { warn: (m) => this.log.warn(m) },
      () =>
        void this.reconcile().catch((err) =>
          this.log.error(`cp: integration reconcile failed: ${(err as Error).stack ?? err}`)
        )
    )
    // CP crons are written straight into the owning agent's on-disk agent.json
    // `crons[]` (the single source of truth, origin:"cp") — so they survive a
    // restart with the CP down and the Scheduler registers them from disk alone.
    // A write re-reconciles (diffAgents sees the crons change → Scheduler re-sync).
    this.cpCrons = new CpCronRegistry(
      this.agentsDir,
      { warn: (m) => this.log.warn(m) },
      () =>
        void this.reconcile().catch((err) =>
          this.log.error(`cp: cron reconcile failed: ${(err as Error).stack ?? err}`)
        )
    )
    // Initial population goes straight into `agents` (not through reconcile's
    // toStart path), so warm each git-repo checkout here too — otherwise a freshly
    // booted daemon wouldn't clone until the first message.
    for (const a of this.effectiveAgents()) {
      this.agents.set(a.id, a)
      this.prefetchClone(a)
    }

    // MCP control server: the daemon *is* the MCP server. The bridge subprocess
    // (spawned by the agent harness) relays tool calls here over a local socket,
    // so sends go through our Slack connection and land in the transcript.
    this.mcp = new McpControlServer({
      socketPath: mcpSocketPath(root),
      log: this.log,
      now: () => Date.now(),
      canRun: (ctx) => {
        const key = sessionKey(ctx.platform, ctx.channel, ctx.thread, ctx.agentId, ctx.transportScope)
        const active = this.activeGateEntries.get(key)
        // A transient safety drain only gates NEW admissions while an interrupted turn
        // unwinds. It must not break MCP tools in an unrelated, already-running turn.
        // Persisted pause is agent-wide; cancellation is latched on the exact active key.
        // MCP tokens are session-static, so absence of an active turn must fail closed too.
        return !this.paused(ctx.agentId) && active !== undefined && !active.cancelledReason
      },
      setSessionTitle: (req) => this.setSessionTitleFromTool(req),
      gatewayFor: (integrationId) => this.connForIntegration(integrationId),
      // History-backed discovery for platforms whose bot API can't enumerate chats/users
      // (Telegram): only the sole current physical bot's scoped history is reachable.
      observedChannels: (agentId, platform) => {
        const integrations = this.agents.get(agentId)?.integrations.filter((i) => i.platform === platform) ?? []
        return integrations.length === 1
          ? this.store.observedChannels(agentId, platform, this.transportScopeForIntegration(integrations[0]!))
          : []
      },
      observedUsers: (agentId, platform) => {
        const integrations = this.agents.get(agentId)?.integrations.filter((i) => i.platform === platform) ?? []
        return integrations.length === 1
          ? this.store.observedUsers(agentId, platform, this.transportScopeForIntegration(integrations[0]!))
          : []
      },
      // Peer discovery goes to the CP (the only authority for the cross-daemon
      // roster). Resolve the client lazily; fail closed when it isn't connected.
      channelAgents: async ({ currentChannel, currentThread, currentTransportScope, ...req }) => {
        const client = this.cpClient
        if (!client) throw Object.assign(new Error('control plane is not connected'), { code: 'INTERNAL' })
        // Cache each peer's directory name so the caller-framed text delivered to a messaged
        // agent can name a REMOTE caller by directory name instead of its raw agentId
        // (see agentDisplayLabel / prepareAgentDelivery).
        const cacheNames = (ok: ChannelAgentsOk): ChannelAgentsOk => {
          if (this.channelAgentNames.size >= 5000) this.channelAgentNames.clear()
          for (const a of ok.agents) this.channelAgentNames.set(a.agentId, { name: a.name, displayName: a.displayName })
          return ok
        }
        // Rolling-upgrade negotiation: only a CP advertising `agent-directory-org-scope-v1`
        // accepts a channel-less request (the org-wide directory). An older CP can answer
        // exactly one question — "who is in this channel" — so a channel-less ask has to be
        // narrowed to the caller's CURRENT channel for it, which is today's behavior.
        const orgScope = client.supportsServerFeature('agent-directory-org-scope-v1')
        // A daemon-initiated channel-intro turn is HARD-BOUND to the channel it joined:
        // the scope is decided HERE, from the turn's trusted CallMeta, not from the tool
        // args (see CallMeta.introChannel — an unfiltered listing would fan one join out
        // to the entire org). It also overrides an explicit arg: an intro turn has exactly
        // one legitimate scope, so a model asking for another channel gets its own.
        const introChannel = this.introChannelForTurn(req.requesterAgentId, req.platform, {
          channel: currentChannel,
          thread: currentThread,
          transportScope: currentTransportScope
        })
        const channel = introChannel ?? req.channel ?? (orgScope ? undefined : currentChannel)
        if (channel === undefined) {
          // Org-wide, and the CP understands it.
          if (orgScope) return cacheNames(await client.channelAgents(req))
          // Old CP + nothing to narrow to (a session that does not know its own channel):
          // a channel-less REQ is a BAD_PAYLOAD there and an invented channel would be
          // worse, so answer locally. An old CP has nothing to say about a directory scope
          // it does not implement anyway.
          this.log.debug('channelAgents: CP predates agent-directory-org-scope-v1 and no channel to narrow to')
          return { platform: req.platform, agents: [] }
        }
        // A channel-scoped question must name a PERSISTED coordinate. A hook turn's session
        // platform is 'hook' but it LANDS on real Slack coordinates, so its channel filter is
        // a Slack one (the same mapping the removed local wake check applied) — otherwise the
        // CP's session-identity short-circuit silently answers `agents: []` and the agent
        // concludes nobody is there. webchat/dream have no persisted channel at all, so an
        // empty roster is the honest answer — and it must be computed HERE, because an old CP
        // would THROW on such a payload (`toDbPlatform`) and `ws/connection.ts` turns that
        // into close(1011), killing the whole control socket and every in-flight request.
        // A current CP already short-circuits it to this same empty roster.
        const coordPlatform = req.platform === 'hook' ? 'slack' : req.platform
        if (coordPlatform === 'webchat' || coordPlatform === 'dream') {
          return { platform: req.platform, channel, agents: [] }
        }
        const ok = await client.channelAgents({ ...req, platform: coordPlatform, channel })
        // Echo the SESSION's own platform back to the caller, not the coordinate platform we
        // may have rewritten above: everything else the agent sees about a hook turn calls it
        // 'hook', and the roster is the same either way.
        return cacheNames({ ...ok, platform: req.platform })
      },
      // Agent→agent wake (§2.2). Same-daemon delivery only in P1; the daemon owns the
      // trusted caller identity + policy check + dispatch (a target elsewhere gets
      // reason:'not_local' — cross-daemon relay is P2).
      messageAgent: (req) => this.messageAgent(req),
      preflightWake: (req) => this.wakeRejectionReason(req),
      replyToSession: (req) => this.replyToSession(req),
      viewSessionStatus: (req) => Promise.resolve(this.viewSessionStatus(req)),
      rootPostRelation: (req) => this.rootPostRelation(req),
      spawnChannelRootSession: (req) => this.spawnChannelRootSession(req),
      startOrchestration: (req) => this.startOrchestration(req),
      getOrchestration: (req) => Promise.resolve(this.getOrchestrationForOwner(req)),
      cancelOrchestration: (req) => Promise.resolve(this.cancelOrchestrationForOwner(req)),
      submitGithubReview: (req) => this.submitGithubReview(req),
      memory: this.memory,
      // session-visibility.md §5.1: the same capture gate that blocks automatic
      // distillation also blocks an EXPLICIT write from a private session —
      // agent memory is shared across users, so the tool path would otherwise
      // be a way around it. Resolved from the caller's trusted session coords
      // at call time, so a session tightened mid-life is covered.
      memoryWriteAllowed: (ctx) => !this.store.isCaptureExcluded(this.acpSessionIdForToolCall(ctx)),
      recordOutbound: (ctx, channel, thread, text, ts, integrationId) =>
        this.store.appendTranscript({
          channel: transcriptChannelKey(channel, this.transportScopeForIntegrationIds([integrationId])),
          thread: thread ?? ctx.thread,
          ts,
          sender: ctx.agentId,
          kind: 'text',
          text
        }),
      maxAttachmentBytes: cfg.limits.maxAttachmentBytes
    })
    await this.mcp.start()

    const cliEntry = daemonEntryForShims(root)

    this.sessions = new SessionManager({
      store: this.store,
      // Must hand back a *started* host: handle() calls host.newSession() immediately,
      // which needs the ACP connection that start() establishes.
      hostFor: (agentId) => this.ensureHostAsync(agentId),
      // Whether the runtime process is already up. When it isn't, hostFor cold-starts
      // it, so the workspace (and skills) must be prepared first — see SessionManager.
      isHostRunning: (agentId) => this.hosts.has(agentId),
      agentById: (id) => this.agents.get(id),
      memory: this.memory,
      onMemoryRecallError: (agentId, error) =>
        this.log.warn(
          `memory recall degraded for agent ${agentId}: ${error instanceof Error ? error.name : 'unknown'}`
        ),
      onMemoryRecallInjected: (_agentId, bytes) => defaultMemoryPluginMetrics.recallInjected(bytes),
      onMemoryRecallEvent: (agentId, event) =>
        this.emitEvaluation({
          type: `memory.recall.${event.kind}`,
          agentId,
          sessionId: event.sessionId,
          turnId: event.turnId,
          data: Object.fromEntries(
            Object.entries(event).filter(([key]) => !['kind', 'sessionId', 'turnId'].includes(key))
          )
        }),
      memoryEnabled: this.evaluationProfile.memory === 'configured',
      collaborationEnabled: this.evaluationProfile.collaboration === 'configured',
      // No runtime is whitelisted for the model-authored `setSessionTitle` fallback
      // anymore: codex-acp >= 1.1.3 emits native session_info_update titles itself
      // (issue #659), so every runtime now relies on its native ACP title path. The
      // ingress side (MCP handler + event hiding) stays for warm pre-upgrade sessions.
      // Same runtime-def env base the spawn path merges under the agent env, so
      // the standing-context config-file description matches what materialized.
      runtimeEnvFor: (runtimeId) =>
        Object.fromEntries((this.runtimes[runtimeId]?.env ?? []).map((entry) => [entry.name, entry.value])),
      // Inject the agent's tool set. Memory/collaboration tools are universal, so a
      // session is registered even with no platform integration. The token binds this
      // ACP session to its exact channel/thread/delivery integration.
      // The agent's enabled daemon-configured MCP servers are appended AFTER the bridge entry, gated
      // on the runtime's probed transport caps.
      mcpServersFor: ({ agent, platform, channel, thread, integrationId, transportScope, isDm }) => {
        const servers: McpServer[] = []
        let tools = toolsForIntegrations(agent.integrations, {
          collaboration: this.evaluationProfile.collaboration === 'configured'
        })
        // Static descriptor, dynamic authority: a per-thread ACP session can
        // outlive many hook deliveries. The call resolves the CURRENT daemon-
        // private turn and fails closed everywhere else.
        tools = [...tools, ...GITHUB_REVIEW_TOOLS]
        // Replace the legacy managed descriptors with this provider's stable core
        // tools. An external plugin's raw MCP tools never enter the ACP session.
        tools = tools.filter((t) => !MEMORY_TOOL_NAMES.has(t.name))
        if (this.evaluationProfile.memory === 'configured') {
          tools.push(...this.memory.toolsForAgent(agent.id))
        }
        // Bind the bridge token to the exact integration that delivered this turn.
        // Falling back to agent.integrations[0] can send a title/message through the
        // wrong bot when one agent has multiple integrations. A memory-only session
        // still registers with no integration so its universal tools work.
        if (tools.length > 0) {
          const token = this.mcp.register({
            agentId: agent.id,
            platform,
            ...(integrationId ? { integrationId } : {}),
            ...(transportScope ? { transportScope } : {}),
            isDm,
            channel,
            thread,
            tools,
            // Full integration set so sendPlatformMessage can route to ANY connected
            // platform, not only the one that delivered this turn.
            integrations: agent.integrations.map((i) => ({ id: i.id, platform: i.platform })),
            // Agent display identity, stamped on tool sends so they match ordinary
            // replies (slackAgentPostOptions uses the same displayName||name + iconUrl).
            agentName: agent.displayName?.trim() || agent.name,
            ...(agent.iconUrl ? { iconUrl: agent.iconUrl } : {})
          })
          servers.push(...buildMcpServers({ socketPath: mcpSocketPath(root), token, cliEntry }))
        }
        servers.push(
          ...resolveAgentMcpServers({
            enabled: agent.mcpServers,
            defs: this.mcpServerDefs,
            caps: this.runtimeMcpCaps.get(agent.runtime),
            ...(effectiveRunInSandbox(cfg.security.requireSandbox, agent.restrictFileAccess, this.sandboxMechanism)
              ? {
                  resolveStdioCommand: (command: string, entries: { name: string; value: string }[]) =>
                    resolveTrustedExecutable(command, {
                      ...process.env,
                      ...Object.fromEntries(entries.map((entry) => [entry.name, entry.value]))
                    })
                }
              : {}),
            warn: (m) => this.log.warn(m)
          })
        )
        return servers
      },
      // §9.2: download inbound attachment bytes via the agent's Slack connection
      // (bot-token auth). Returns null (→ baseline resource_link) if no connection.
      downloadAttachment: (agentId, att) =>
        att.sourceUrl
          ? (this.replyConnFor(agentId)?.downloadFile?.(att.sourceUrl, this.cfg.limits.maxAttachmentBytes) ??
            Promise.resolve(null))
          : Promise.resolve(null),
      attachmentMaxBytes: cfg.limits.maxAttachmentBytes,
      // §8.4/§8.5/§9.2: snapshot real Slack thread history for cold backfill and
      // warm-turn unread reconciliation (#649).
      fetchThreadHistory: (agentId, channel, threadTs, cutoffTs, afterTs) =>
        this.fetchThreadHistory(agentId, channel, threadTs, cutoffTs, afterTs)
    })
    this.scheduler = new Scheduler({
      onFire: (agentId, msg, cron) =>
        void this.onCronFire(agentId, msg, cron).catch((err) =>
          this.log.error(`cron dispatch failed for agent "${agentId}": ${formatErr(err)}`)
        ),
      newTraceId: () => randomUUID(),
      warn: (m) => this.log.warn(m)
    })
    // Scheduled dreams ride their own trigger, never a synthetic turn (§9).
    this.dreamScheduler = new DreamScheduler({
      onFire: (agentId) => this.onDreamScheduleFire(agentId),
      warn: (m) => this.log.warn(m)
    })

    // open consolidated Slack connections, resolve bot user ids (merged rules are per-message)
    const groups = consolidate(agents)
    this.botUserIds = {}
    if (groups.size === 0) this.log.info('slack: no slack integrations configured')
    else this.log.info(`slack: opening ${groups.size} socket connection(s)`)
    for (const group of groups.values()) {
      const conn: SlackConnection = new SlackConnection({
        group,
        newTraceId: () => randomUUID(),
        onMessage: (msg) => {
          this.nameResolver?.noteMessage(conn, msg)
          this.onInbound(msg, this.srcIntegrationIds(conn))
        },
        onChannelsChanged: () => void this.refreshChannels(conn),
        onMessageShortcut: (shortcut) => this.slackShortcutSession(shortcut, this.srcIntegrationIds(conn)),
        onStatusAction: (a) => this.handleStatusAction(a),
        onStatusInfo: (key) => this.statusInfoForKey(key),
        onPermissionChoice: (a) => this.handlePermissionChoice(a),
        onElicitChoice: (a) => this.handleElicitChoice(a),
        log: this.log,
        boltDebug: cfg.logging.level === 'debug' || cfg.logging.level === 'trace'
      })
      this.log.info(
        `slack: connecting (${group.integrations.length} integration(s): ${group.integrations.map((i) => i.agentId).join(', ')})…`
      )
      try {
        await conn.start()
        this.log.info(`slack: socket connected as bot user ${conn.botUserId}`)
        for (const { integrationId } of group.integrations) {
          this.botUserIds[integrationId] = conn.botUserId
          this.connByIntegration.set(integrationId, conn)
        }
        this.connections.push(conn)
        // Initial membership snapshot (fire-and-forget; cached + emitted when CP is up).
        void this.refreshChannels(conn)
      } catch (err) {
        // Release any Bolt SocketModeClient / reconnect loop the half-open connection
        // may have started before we discard it — otherwise a failure during app.start()
        // would leak a live reconnecting client on every attempt of the loop below.
        await conn.stop().catch(() => {})
        this.log.warn(`slack: connection failed for appToken — retrying in 60s: ${formatErr(err)}`)
        // Don't give up; retry in the background at a slow pace so a temporary
        // network outage or Slack API blip self-heals without manual intervention.
        const timer = this.clock.setTimeout(() => {
          if (this.draining) return
          this.startSlackRetry(group.appToken)
        }, 60_000)
        this.slackRetryTimers.set(group.appToken, timer)
      }
    }

    // Open send-only Slack clients for HTTP bots (inbound lives on the relay).
    await this.openHttpSlackConnections(agents)
    // Long-poll / gateway / WS platform connects (Telegram/Discord/Feishu) must NOT gate
    // boot: their start() awaits a bot-identity handshake (e.g. Telegram getMe) that can
    // HANG indefinitely when the platform API is unreachable — which would otherwise stall
    // the daemon before it ever reaches startCpClient() below, taking CP + Slack (via the
    // relay) down with it. Fire them in the background so the rest of boot proceeds; each
    // reconcile already catches its own per-token failures and leaves other tokens intact.
    void this.reconcileTelegramConnections().catch((err) =>
      this.log.error(`telegram: initial connect failed: ${formatErr(err)}`)
    )
    void this.reconcileDiscordConnections().catch((err) =>
      this.log.error(`discord: initial connect failed: ${formatErr(err)}`)
    )
    void this.reconcileFeishuConnections().catch((err) =>
      this.log.error(`feishu: initial connect failed: ${formatErr(err)}`)
    )

    // register crons (sync per agent — the same converge reconcile re-runs on change)
    for (const a of agents) this.scheduler.sync(a.id, a.crons)
    for (const a of agents) this.dreamScheduler.sync(a.id, dreamingPolicyOf(a))
    const cronCount = agents.reduce((n, a) => n + this.scheduler.count(a.id), 0)
    if (cronCount) this.log.info(`registered ${cronCount} cron(s)`)

    // file-watch: reconcile on any agents/** change (debounced 300ms)
    this.watcher = chokidarWatch(this.agentsDir, {
      ignoreInitial: true,
      depth: 4,
      ignored: (p: string) => /[\\/](node_modules|\.git|\.detached|\.staged)([\\/]|$)/.test(p)
    })
    const debounced = () => {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = setTimeout(() => {
        void this.reconcile().catch((err) => console.error('agentconnect: reconcile failed:', err))
      }, 300)
    }
    this.watcher.on('add', debounced).on('change', debounced).on('unlink', debounced)
    this.log.info(`watching ${this.agentsDir} for agent changes`)
    this.replayInbox()
    this.rearmOrchestrationDeadlines()
    // Curated admission belongs to local runtime resolution, not CP readiness.
    // Start it even when the control plane is disabled or still unreachable.
    void this.probeRuntimesAndEmit(false).finally(() => this.armRuntimeProbeRefresh())
    this.startCpClient(root)
    this.armIdleSweep()
    this.log.info('daemon ready')
  }

  // Multi-agent: all active agents under agentsDir. Single-agent (--agent): just
  // the selected agent, regardless of status.
  private loadAgentList(): LoadedAgent[] {
    return this.opts.agentName ? [selectAgent(this.agentsDir, this.opts.agentName)] : loadAgents(this.agentsDir)
  }

  /**
   * Effective agent set = the on-disk `agent.json` files, with the CP-owned
   * integrations overlaid in memory. Agent SPECS are no longer overlaid — `agent/
   * upsert` writes those straight to disk (cp/cp-agent-registry.ts). INTEGRATIONS,
   * however, carry plaintext tokens and are kept in memory only (cp/cp-integration-
   * registry.ts); they are merged onto the matching file agent's `integrations[]`
   * HERE — the single seam so consolidate, routing rules, tool injection, and reply
   * routing (all of which read `agent.integrations`) see one merged view.
   */
  private effectiveAgents(): LoadedAgent[] {
    // Integrations live on disk in each agent.json (CP pushes are persisted by
    // CpIntegrationRegistry before reconcile re-loads), so the file agents ARE
    // the effective set — no in-memory overlay.
    return [...this.fileAgents.values()].filter((agent) => !this.moveStagedAgents.has(agent.id))
  }

  /**
   * Converge the running set to the desired effective agents. Driven by both the
   * `agents/**` file-watch AND CP convergence (agent/upsert, agent/remove, the
   * register/ok roster, via the registry's onChange). `diffAgents` detects a
   * changed effective config (runtime/workspace/model/prompt/env/…) and restarts
   * the host lazily so the next session picks up fresh config.
   *
   * Single-flight: overlapping triggers (e.g. a burst of CP frames, or a file
   * event landing mid-reconcile) coalesce into one trailing re-run so we never
   * run two passes concurrently and double-evict a host.
   */
  private reconcileRun?: Promise<void>
  private reconcilePending = false
  async reconcile(): Promise<void> {
    if (this.reconcileRun) {
      this.reconcilePending = true
      return this.reconcileRun
    }
    this.reconcileRun = this.runReconcile()
    try {
      await this.reconcileRun
    } finally {
      this.reconcileRun = undefined
    }
    if (this.reconcilePending) {
      this.reconcilePending = false
      await this.reconcile()
    }
  }

  private async runReconcile(): Promise<void> {
    const files = this.loadAgentList()
    this.fileAgents = new Map(files.map((a) => [a.id, a]))
    const desired = this.effectiveAgents()
    const { toStart, toStop, toChange } = diffAgents(desired, this.agents)
    if (toStart.length || toStop.length || toChange.length)
      this.log.info(
        `reconcile: ${desired.length} desired agent(s) from ${this.agentsDir}; ` +
          `start=[${toStart.map((a) => a.id).join(', ')}] stop=[${toStop.join(', ')}] ` +
          `change=[${toChange
            .map((c) => {
              const dims = [
                c.hostRespawn && 'host',
                c.workspace && 'workspace',
                c.workspaceRepoRename && 'workspace-origin',
                c.integrations && 'integrations'
              ]
                .filter(Boolean)
                .join('+')
              return `${c.agent.id}(${dims || 'soft'})`
            })
            .join(', ')}]`
      )
    else this.log.debug(`reconcile: no changes (${desired.length} desired agent(s))`)
    for (const id of toStop) {
      // Remove routing + gate dispatch BEFORE the teardown await. Otherwise a message
      // arriving while host.stop() is in flight can resolve the still-present agent and
      // make ensureHostAsync reuse the child that is currently stopping.
      const wasDraining = this.drainingAgents.has(id)
      this.drainingAgents.add(id)
      this.interruptAgentTurns(id, 'stop')
      this.agents.delete(id)
      this.scheduler.unregister(id)
      this.dreamScheduler.unregister(id)
      this.gitCreds.remove(id)
      this.gitCredServer?.revoke(id)
      // Use the one generation-safe teardown path: it evicts the host synchronously,
      // publishes hostStopping, and fences every older startup/retry generation.
      await this.stopHost(id)
      await this.delegatedWebchatHosts?.stopAgentHosts?.(id)
      // Preserve lifecycle/move gates that predated this reconcile. A plain file/CP
      // removal needs no permanent gate once the host is proven stopped (the agent is
      // absent); a later toStart can then serve it normally. Safety-drain state is NOT
      // cleared here — in particular, a cold force-stop failure must remain fail-closed.
      if (!wasDraining && !this.moveStagedAgents.has(id)) this.drainingAgents.delete(id)
    }
    let connectionsDirty = toStart.length > 0 || toStop.length > 0
    for (const change of toChange) {
      const a = change.agent
      const previous = this.agents.get(a.id)
      const wasPaused = previous?.pause === true
      const chatRuntimeSettingChanged = previous?.allowRuntimeChangesInChat !== a.allowRuntimeChangesInChat
      if (chatRuntimeSettingChanged) this.store.clearRuntimeConfigOverrides(a.id)
      if (previous?.allowRuntimeChangesInChat === true && !a.allowRuntimeChangesInChat) {
        this.disableChatPermissionSurfaces(a.id)
      }
      // ALWAYS publish fresh config first, so live reads — output.mode (per dispatch),
      // per-session cwd/tools, routing (mergedRules reads this.agents) — see the new config.
      this.agents.set(a.id, a as LoadedAgent)
      if (previous?.allowRuntimeChangesInChat === true && !a.allowRuntimeChangesInChat) {
        this.restoreConfiguredRuntimeSettings(a as LoadedAgent)
      }
      let workspaceNeedsColdRecovery = change.workspace
      // A GitHub rename changes only the canonical remote URL for the same
      // App-backed repository. Keep active/queued turns and the cached host only
      // after origin convergence succeeds. Otherwise fall back to the ordinary
      // cold workspace path so a live host cannot keep serving an untrusted or
      // stale checkout.
      if (change.workspaceRepoRename) {
        try {
          await convergeGithubAppWorkspaceRename(a as LoadedAgent)
        } catch (err) {
          workspaceNeedsColdRecovery = true
          this.log.warn(
            `workspace: canonical rename convergence for "${a.id}" failed; evicting its host: ${formatErr(err)}`
          )
        }
      }
      // Pause is an operator stop, not merely a gate for the next message. Publish the
      // gate first so no new turn can enter, then interrupt every active logical session
      // and drop its buffered follow-ups. The host/session stay warm for unpause.
      if (!wasPaused && a.pause) this.interruptAgentTurns(a.id, 'pause')
      // crons live in the whole-agent signature, so any change re-syncs the agent's
      // job set (design §5.2: crons change → Scheduler upsert/remove). Idempotent.
      this.scheduler.sync(a.id, a.crons)
      this.dreamScheduler.sync(a.id, dreamingPolicyOf(a))
      // host-spawn or workspace change → evict the cached host (once) so the next
      // session lazily re-spawns it with fresh env and/or re-materializes cwd via
      // prepareWorkspace. Soft-only and integration-only changes never touch the host.
      if (change.hostRespawn || workspaceNeedsColdRecovery) {
        // A config-triggered respawn keeps the agent in the roster, so install a
        // temporary admission gate around the generation-safe teardown, preserving any
        // older lifecycle gate intact.
        const wasDraining = this.drainingAgents.has(a.id)
        this.drainingAgents.add(a.id)
        this.interruptAgentTurns(a.id, 'stop')
        if (workspaceNeedsColdRecovery) {
          this.gitCreds.remove(a.id)
          this.gitCredServer?.revoke(a.id)
        }
        let delegatedCleanupFailed = false
        try {
          // Ordinary teardown keeps its established degrading behavior: eviction
          // already fenced future starts, so a stop rejection is logged but does
          // not permanently darken the agent.
          try {
            await this.stopHost(a.id)
          } catch (err) {
            this.log.error(
              `reconcile: host teardown failed for "${a.id}" — releasing admission gate anyway: ${formatErr(err)}`
            )
          }
          // A failed private-cell teardown is different: the broker authority and
          // child may still be live, so reopening admission could overlap generations.
          try {
            await this.delegatedWebchatHosts?.stopAgentHosts?.(a.id)
          } catch (err) {
            delegatedCleanupFailed = true
            this.log.error(
              `reconcile: delegated host teardown failed for "${a.id}" — retaining admission gate: ${formatErr(err)}`
            )
          }
        } finally {
          if (!wasDraining && !delegatedCleanupFailed) this.drainingAgents.delete(a.id)
        }
      }
      // workspace change → eagerly (re-)materialize the checkout in the background so
      // a re-pointed git-repo is warm before the next message, instead of paying the
      // clone latency on that first session.
      if (workspaceNeedsColdRecovery) this.prefetchClone(a as LoadedAgent)
      // Defer platform convergence until EVERY agent delta has been installed.
      // This preserves a token handed from one agent to another in the same batch:
      // reconciling midway through the diff would briefly see zero references and
      // close/reopen a connection that the final roster still shares.
      if (change.integrations) connectionsDirty = true
    }
    for (const a of toStart) {
      this.agents.set(a.id, a as LoadedAgent)
      // Rows may have been retained while this daemon did not own the agent. Adding it
      // already paused is still an explicit operator stop, so terminally discard that
      // old backlog now rather than letting a later unpause+restart resurrect it.
      if (a.pause) this.purgeAgentInbox(a.id)
      // New agent: warm its git-repo checkout in the background now (e.g. on daemon
      // start every agent is a toStart), so the repo is cloned ahead of the first message.
      this.prefetchClone(a as LoadedAgent)
      this.scheduler.sync(a.id, a.crons)
      this.dreamScheduler.sync(a.id, dreamingPolicyOf(a))
    }
    // Reconcile exactly once from the final live roster. The close phase is strict:
    // detach ACKs only after last-reference connections have actually stopped.
    if (connectionsDirty) {
      await this.closeUnusedPlatformConnections()
      await this.reconcileSlackConnections()
      await this.reconcileTelegramConnections()
      await this.reconcileDiscordConnections()
      await this.reconcileFeishuConnections()
    }
  }

  /**
   * Fire-and-forget eager clone of a git-repo workspace so the checkout is warm
   * before the first message. Deliberately NOT awaited: reconcile must not block on
   * the network (design §4.3), and `prepareWorkspace` is the authoritative clone
   * (awaited + hard-fail) at session start — so a prefetch failure here is only
   * logged and harmlessly retried then. No-op for from-scratch / already-cloned.
   */
  private prefetchClone(agent: LoadedAgent): void {
    if (this.preparingWorkspaces.has(agent.id)) return
    void prefetchWorkspace(agent).catch((err) =>
      this.log.warn(
        `workspace: prefetch clone for "${agent.id}" failed (will retry at first session): ${formatErr(err)}`
      )
    )
  }

  /**
   * Close platform clients whose credential key has no reference in the FINAL
   * active-agent roster, and evict every derived index that points at a removed
   * or re-keyed integration. Consolidation maps are the reference counts: direct
   * Slack is keyed by appToken; HTTP Slack, Telegram and Discord by botToken.
   *
   * A captured connection on a live turn is a temporary reference too. Detach
   * drains its own dispatch leases before reaching this method; the guard also
   * keeps ordinary concurrent reconcile safe for unrelated in-flight turns.
   */
  private async closeUnusedPlatformConnections(): Promise<void> {
    const agents = [...this.agents.values()]
    const direct = consolidate(agents)
    const shared = consolidateShared(agents)
    const telegram = consolidateTelegram(agents)
    const discord = consolidateDiscord(agents)
    const feishu = consolidateFeishu(agents)

    const directByIntegration = new Map<string, { appToken: string; botToken: string }>()
    for (const group of direct.values())
      for (const { integrationId } of group.integrations)
        directByIntegration.set(integrationId, { appToken: group.appToken, botToken: group.botToken })
    const sharedByIntegration = new Map<string, string>()
    for (const group of shared.values())
      for (const { integrationId } of group.integrations) sharedByIntegration.set(integrationId, group.botToken)
    const telegramByIntegration = new Map<string, string>()
    for (const group of telegram.values())
      for (const { integrationId } of group.integrations) telegramByIntegration.set(integrationId, group.botToken)
    const discordByIntegration = new Map<string, string>()
    for (const group of discord.values())
      for (const { integrationId } of group.integrations) discordByIntegration.set(integrationId, group.botToken)
    // Feishu keys on appId (one provider client per self-built app), not a bot token —
    // plus region and mode, so either change produces a different desired connection.
    const feishuByIntegration = new Map<string, string>()
    for (const group of feishu.values())
      for (const { integrationId } of group.integrations)
        feishuByIntegration.set(integrationId, feishuConnKey(group.appId, group.region, group.mode))

    const allDesiredIds = new Set([
      ...directByIntegration.keys(),
      ...sharedByIntegration.keys(),
      ...telegramByIntegration.keys(),
      ...discordByIntegration.keys(),
      ...feishuByIntegration.keys()
    ])
    const dropIdentity = (integrationId: string): void => {
      delete this.botUserIds[integrationId]
      this.channelSnapshots.delete(integrationId)
    }
    for (const integrationId of Object.keys(this.botUserIds))
      if (!allDesiredIds.has(integrationId)) dropIdentity(integrationId)
    for (const integrationId of [...this.channelSnapshots.keys()])
      if (!allDesiredIds.has(integrationId)) this.channelSnapshots.delete(integrationId)

    for (const [integrationId, conn] of this.connByIntegration) {
      const expectedDirect = directByIntegration.get(integrationId)
      const expectedShared = sharedByIntegration.get(integrationId)
      const matches = expectedDirect
        ? conn.appToken === expectedDirect.appToken && conn.botToken === expectedDirect.botToken
        : expectedShared !== undefined
          ? conn.appToken === '' && conn.botToken === expectedShared
          : false
      if (!matches) {
        this.connByIntegration.delete(integrationId)
        dropIdentity(integrationId)
      }
    }
    for (const [integrationId, conn] of this.tgConnByIntegration) {
      if (conn.botToken !== telegramByIntegration.get(integrationId)) {
        this.tgConnByIntegration.delete(integrationId)
        dropIdentity(integrationId)
      }
    }
    for (const [integrationId, conn] of this.dcConnByIntegration) {
      if (conn.botToken !== discordByIntegration.get(integrationId)) {
        this.dcConnByIntegration.delete(integrationId)
        dropIdentity(integrationId)
      }
    }
    for (const [integrationId, conn] of this.fsConnByIntegration) {
      // Compare appId AND region: a region flip on the same appId must evict the stale
      // mapping here (not only when a replacement start succeeds), so a failed replacement
      // never leaves an integration routed at the stopped old-domain client.
      if (feishuConnKey(conn.appId, conn.region, conn.mode) !== feishuByIntegration.get(integrationId)) {
        this.fsConnByIntegration.delete(integrationId)
        dropIdentity(integrationId)
      }
    }

    // A startup retry captures only the stable appToken and re-reads the live
    // group when it fires. Cancel timers for keys whose final reference vanished.
    for (const [appToken, timer] of this.slackRetryTimers) {
      if (direct.has(appToken)) continue
      this.clock.clearTimeout(timer)
      this.slackRetryTimers.delete(appToken)
    }
    // Join only attempts whose credential key vanished or changed. An unrelated
    // slow appToken must not block this move; same-key/same-bot attempts re-read
    // the final integration roster themselves before publishing their mapping.
    const retryRuns = [...this.slackRetryRuns]
      .filter(([appToken, run]) => direct.get(appToken)?.botToken !== run.botToken)
      .map(([, run]) => run.promise)
    if (retryRuns.length) await Promise.all(retryRuns)

    for (const conn of [...this.connections]) {
      const group = direct.get(conn.appToken)
      if (group?.botToken === conn.botToken) continue
      await this.waitForConnectionUses(conn)
      await conn.stop()
      this.connections = this.connections.filter((candidate) => candidate !== conn)
    }
    for (const [botToken, conn] of [...this.httpSlackConns]) {
      if (shared.has(botToken)) continue
      await this.waitForConnectionUses(conn)
      await conn.stop()
      this.httpSlackConns.delete(botToken)
    }
    for (const conn of [...this.telegramConns]) {
      if (telegram.has(conn.botToken)) continue
      await this.waitForConnectionUses(conn)
      await conn.stop()
      this.telegramConns = this.telegramConns.filter((candidate) => candidate !== conn)
    }
    for (const conn of [...this.discordConns]) {
      if (discord.has(conn.botToken)) continue
      await this.waitForConnectionUses(conn)
      await conn.stop()
      this.discordConns = this.discordConns.filter((candidate) => candidate !== conn)
    }
    for (const conn of [...this.feishuConns]) {
      // Keep only a conn whose appId is still desired and whose region/mode are
      // unchanged. A region or transport flip must drop the old client so the open
      // loop initializes the correct gateway and inbound ownership.
      const want = feishu.get(conn.appId)
      if (want && want.region === conn.region && want.mode === conn.mode) continue
      await this.waitForConnectionUses(conn)
      await conn.stop()
      this.feishuConns = this.feishuConns.filter((candidate) => candidate !== conn)
    }
  }

  /**
   * Reconcile the connection-derived Slack state (`botUserIds`, `connByIntegration`,
   * open sockets) against the live `this.agents` set. Routing itself is rebuilt
   * implicitly each message (mergedRules reads this.agents) — this only maintains the
   * socket layer that is otherwise written only at startup.
   *
   * Safe-by-construction (per the recon report):
   *  - NEW appToken  → construct + start an isolated socket, then fan botUserId/conn
   *    out to every integrationId on that appToken. A failed start() is logged and
   *    leaves all existing sockets untouched (never throws out of reconcile).
   *  - NEW integration reusing an ALREADY-OPEN appToken → no socket churn; just
   *    backfill botUserIds/connByIntegration from the existing conn (mention routing
   *    for the new bot would otherwise silently never match).
   *  - REMOVED/re-keyed appToken → closed by closeUnusedPlatformConnections first,
   *    after checking the final roster and captured-turn connection leases.
   */
  private async reconcileSlackConnections(): Promise<void> {
    const groups = consolidate([...this.agents.values()])
    for (const group of groups.values()) {
      const existing = this.connections.find((c) => c.appToken === group.appToken && c.botToken === group.botToken)
      if (existing) {
        // Already-open appToken: bind any integrationId not yet pointing at this conn
        // (tier 1). Covers both a brand-new integrationId AND one that was re-pointed
        // from a different appToken onto this already-open one — without the
        // `!== existing` check the latter would keep its stale mapping/botUserId.
        let bound = false
        for (const { integrationId } of group.integrations) {
          if (this.connByIntegration.get(integrationId) !== existing) {
            this.botUserIds[integrationId] = existing.botUserId
            this.connByIntegration.set(integrationId, existing)
            this.log.info(`slack: bound integration ${integrationId} onto existing socket (appToken reuse)`)
            bound = true
          }
        }
        // A newly-bound integration needs its channel snapshot reported too.
        if (bound) void this.refreshChannels(existing)
        continue
      }
      // New appToken: open an isolated socket (tier 2). Guard so a bad token logs
      // and leaves existing sockets intact instead of throwing out of reconcile.
      try {
        const conn: SlackConnection = new SlackConnection({
          group,
          newTraceId: () => randomUUID(),
          onMessage: (msg) => {
            this.nameResolver?.noteMessage(conn, msg)
            this.onInbound(msg, this.srcIntegrationIds(conn))
          },
          onChannelsChanged: () => void this.refreshChannels(conn),
          onMessageShortcut: (shortcut) => this.slackShortcutSession(shortcut, this.srcIntegrationIds(conn)),
          onStatusAction: (a) => this.handleStatusAction(a),
          onStatusInfo: (key) => this.statusInfoForKey(key),
          onPermissionChoice: (a) => this.handlePermissionChoice(a),
          onElicitChoice: (a) => this.handleElicitChoice(a),
          log: this.log,
          boltDebug: this.cfg.logging.level === 'debug' || this.cfg.logging.level === 'trace'
        })
        this.log.info(
          `slack: opening new socket at runtime (${group.integrations.length} integration(s): ${group.integrations
            .map((i) => i.agentId)
            .join(', ')})…`
        )
        await conn.start()
        this.log.info(`slack: runtime socket connected as bot user ${conn.botUserId}`)
        for (const { integrationId } of group.integrations) {
          this.botUserIds[integrationId] = conn.botUserId
          this.connByIntegration.set(integrationId, conn)
        }
        this.connections.push(conn)
        void this.refreshChannels(conn)
        // This reconcile just brought the socket up; cancel any pending startup-retry
        // timer for the same appToken so it doesn't fire and open a duplicate socket.
        const pending = this.slackRetryTimers.get(group.appToken)
        if (pending !== undefined) {
          this.clock.clearTimeout(pending)
          this.slackRetryTimers.delete(group.appToken)
        }
      } catch (err) {
        this.log.error(
          `slack: failed to open runtime socket for appToken — leaving existing sockets intact: ${formatErr(err)}`
        )
      }
    }
    // HTTP-bot send-only clients (wire mode `shared`) — reconciled alongside the sockets.
    await this.openHttpSlackConnections([...this.agents.values()])
  }

  /**
   * Open (or reuse) a SEND-ONLY Slack Web-API client per HTTP bot token and bind
   * it into `connByIntegration`, so replies / attachment fetches / MCP platform
   * tools / cron anchors resolve a connection for a `mode:'shared'` integration
   * (shared-bot-relay.md §11). No Socket Mode socket is opened — the bot's inbound
   * arrives from the relay as `rd/msg(im)`. Idempotent: an already-open client for
   * the same xoxb is reused; when a bot flips direct→HTTP transport its old direct socket
   * (same botToken) is stopped so it stops competing with the relay for the single
   * Socket Mode consumer.
   */
  private async openHttpSlackConnections(agents: LoadedAgent[]): Promise<void> {
    const groups = consolidateShared(agents)
    for (const group of groups.values()) {
      let conn = this.httpSlackConns.get(group.botToken)
      let bound = false
      if (!conn) {
        conn = new SlackConnection({
          group,
          sendOnly: true,
          newTraceId: () => randomUUID(),
          onMessage: () => {}, // never called (relay owns inbound)
          onStatusAction: (a) => this.handleStatusAction(a),
          onStatusInfo: (key) => this.statusInfoForKey(key),
          onPermissionChoice: (a) => this.handlePermissionChoice(a),
          onElicitChoice: (a) => this.handleElicitChoice(a),
          log: this.log
        })
        try {
          await conn.start()
          this.httpSlackConns.set(group.botToken, conn)
          this.log.info(`slack: send-only (HTTP) client ready as bot user ${conn.botUserId}`)
        } catch (err) {
          this.log.warn(`slack: HTTP send-only client failed — retry on next reconcile: ${formatErr(err)}`)
          continue
        }
      }
      for (const { integrationId } of group.integrations) {
        if (this.connByIntegration.get(integrationId) !== conn) bound = true
        this.botUserIds[integrationId] = conn.botUserId
        this.connByIntegration.set(integrationId, conn)
      }
      // HTTP integrations still have the same xoxb Web API surface as direct
      // sockets. Once a send-only client is bound, use it to seed the membership
      // snapshot too; otherwise rows created by shared routing know only the raw
      // channel id and the console can never render Slack's channel name.
      if (bound) void this.refreshChannels(conn)
    }
  }

  /**
   * Reconcile the connection-derived Telegram state (`botUserIds`,
   * `tgConnByIntegration`, open long-poll connections) against the live `agents`.
   * Parallel to reconcileSlackConnections but simpler (Telegram has no app-level
   * token; one connection per bot token):
   *  - NEW bot token → construct + start a long-poll, then bind botUserIds
   *    (the bot's @username, matching what normalize puts in `mentionedBots`) +
   *    tgConnByIntegration for every integrationId on that token. A failed start
   *    is logged and leaves existing connections intact (never throws out).
   *  - integration reusing an ALREADY-OPEN token → bind it onto the live conn.
   *  - REMOVED token → closed by closeUnusedPlatformConnections before this opener.
   */
  private async reconcileTelegramConnections(): Promise<void> {
    const groups = consolidateTelegram([...this.agents.values()])
    for (const group of groups.values()) {
      const existing = this.telegramConns.find((c) => c.botToken === group.botToken)
      if (existing) {
        for (const { integrationId } of group.integrations) {
          if (this.tgConnByIntegration.get(integrationId) !== existing) {
            this.botUserIds[integrationId] = existing.botUsername
            this.tgConnByIntegration.set(integrationId, existing)
            this.log.info(`telegram: bound integration ${integrationId} onto existing bot @${existing.botUsername}`)
          }
        }
        continue
      }
      // Another connect for this token is already in flight (not yet pushed onto
      // telegramConns, so `find()` above can't see it). Skip to avoid opening a duplicate;
      // that connect binds this group's integrations when it resolves.
      if (this.telegramConnecting.has(group.botToken)) continue
      const conn: TelegramConnection = new TelegramConnection({
        group,
        newTraceId: () => randomUUID(),
        onMessage: (msg) => {
          this.channelNameResolver?.noteChannel(conn, msg.channel, msg.sender.id)
          this.onInbound(msg, this.srcIntegrationIds(conn))
        },
        onBotAddedToChat: (chat) => {
          const integrationIds = new Set(group.integrations.map(({ integrationId }) => integrationId))
          for (const integrationId of this.srcIntegrationIds(conn)) integrationIds.add(integrationId)
          this.observeTelegramChat(chat, [...integrationIds])
        },
        onCallback: (cb) => this.handleTelegramCallback(cb, conn),
        log: this.log
      })
      this.telegramConnecting.add(group.botToken)
      try {
        this.log.info(
          `telegram: connecting (${group.integrations.length} integration(s): ${group.integrations
            .map((i) => i.agentId)
            .join(', ')})…`
        )
        await conn.start()
        this.log.info(`telegram: long-poll connected as @${conn.botUsername} (id ${conn.botUserId})`)
        for (const { integrationId } of group.integrations) {
          // Mention-routing matches the bot's @username (normalize's mentionedBots are usernames).
          this.botUserIds[integrationId] = conn.botUsername
          this.tgConnByIntegration.set(integrationId, conn)
        }
        this.telegramConns.push(conn)
      } catch (err) {
        await conn.stop().catch(() => {})
        this.log.error(`telegram: failed to open long-poll for a bot token — leaving others intact: ${formatErr(err)}`)
      } finally {
        this.telegramConnecting.delete(group.botToken)
      }
    }
    // Label existing sessions' chats now that connections are up (per-message resolution
    // otherwise only fires on fresh traffic — see backfillChannelNames).
    this.backfillChannelNames()
  }

  /**
   * Reconcile the connection-derived Discord state (`botUserIds`,
   * `dcConnByIntegration`, open Gateway connections) against the live `agents`.
   * Parallel to reconcileTelegramConnections (one Gateway per bot token), but
   * mention-routing matches the bot's numeric user id (normalize's `mentionedBots`
   * are Discord user ids). A failed start is logged and leaves other connections
   * intact (never throws out); removed tokens are closed by the shared close phase.
   */
  private async reconcileDiscordConnections(): Promise<void> {
    const groups = consolidateDiscord([...this.agents.values()])
    for (const group of groups.values()) {
      const existing = this.discordConns.find((c) => c.botToken === group.botToken)
      if (existing) {
        for (const { integrationId } of group.integrations) {
          if (this.dcConnByIntegration.get(integrationId) !== existing) {
            this.botUserIds[integrationId] = existing.botUserId
            this.dcConnByIntegration.set(integrationId, existing)
            this.log.info(`discord: bound integration ${integrationId} onto existing bot @${existing.botUsername}`)
          }
        }
        continue
      }
      // Another connect for this token is already in flight (not yet pushed onto
      // discordConns, so `find()` above can't see it). Skip to avoid opening a duplicate;
      // that connect binds this group's integrations when it resolves.
      if (this.discordConnecting.has(group.botToken)) continue
      const conn: DiscordConnection = new DiscordConnection({
        group,
        newTraceId: () => randomUUID(),
        onMessage: (msg) => {
          // The gateway message already knows where it sits — record it before the
          // (async, TTL-cached) name lookup so channel discovery can fold this thread
          // onto its channel on the very first turn.
          this.noteChannelScope(msg)
          // Unlike Telegram, Discord CAN resolve an arbitrary user id — collect the
          // sender's (and mentioned users') display names so session read-back labels
          // them by name the way Slack does.
          this.channelNameResolver?.noteMessage(conn, { ...msg, mentionedUserIds: msg.mentionedBots })
          this.onInbound(msg, this.srcIntegrationIds(conn))
        },
        onStatusAction: (a) => this.handleStatusAction(a),
        onSelectAction: (a) => this.handleDiscordSelect(a),
        log: this.log
      })
      this.discordConnecting.add(group.botToken)
      try {
        this.log.info(
          `discord: connecting (${group.integrations.length} integration(s): ${group.integrations
            .map((i) => i.agentId)
            .join(', ')})…`
        )
        await conn.start()
        this.log.info(`discord: gateway connected as @${conn.botUsername} (id ${conn.botUserId})`)
        for (const { integrationId } of group.integrations) {
          // Mention-routing matches the bot's numeric user id (normalize's mentionedBots are ids).
          this.botUserIds[integrationId] = conn.botUserId
          this.dcConnByIntegration.set(integrationId, conn)
        }
        this.discordConns.push(conn)
      } catch (err) {
        await conn.stop().catch(() => {})
        this.log.error(`discord: failed to open Gateway for a bot token — leaving others intact: ${formatErr(err)}`)
      } finally {
        this.discordConnecting.delete(group.botToken)
      }
    }
    // Label existing sessions' channels now that connections are up (per-message
    // resolution otherwise only fires on fresh traffic — see backfillChannelNames).
    this.backfillChannelNames()
  }

  /** The live desired gateway region for a Feishu appId, or undefined if no agent
   *  currently has a feishu integration on that appId. Lets an in-flight connect detect a
   *  region change (or removal) that landed during its handshake and self-discard instead
   *  of publishing an old-domain mapping. */
  private desiredFeishuConfig(appId: string): { region: FeishuRegion; mode: 'direct' | 'shared' } | undefined {
    for (const group of consolidateFeishu([...this.agents.values()]).values())
      if (group.appId === appId) return { region: group.region, mode: group.mode }
    return undefined
  }

  /**
   * Reconcile the connection-derived Feishu state (`botUserIds`, `fsConnByIntegration`,
   * provider clients and direct WSClient long-connections) against the live `agents`.
   * Parallel to reconcileDiscordConnections, but mention-routing matches
   * the bot's own `open_id` (normalize's `mentionedBots` are Feishu open_ids). A failed
   * start is logged and leaves other connections intact (never throws out); a removed
   * appId is NOT torn down here (same deferred-close reasoning as Slack/Telegram/Discord).
   */
  private async reconcileFeishuConnections(): Promise<void> {
    const groups = consolidateFeishu([...this.agents.values()])
    for (const group of groups.values()) {
      // Match on appId AND region: a region change on the same appId must NOT reuse the
      // old-domain client (the prune pass drops it; this guards a same-pass race too).
      const existing = this.feishuConns.find(
        (c) => c.appId === group.appId && c.region === group.region && c.mode === group.mode
      )
      if (existing) {
        for (const { integrationId } of group.integrations) {
          if (this.fsConnByIntegration.get(integrationId) !== existing) {
            this.botUserIds[integrationId] = existing.botOpenId
            this.fsConnByIntegration.set(integrationId, existing)
            this.log.info(`feishu: bound integration ${integrationId} onto existing app ${existing.appId}`)
          }
        }
        continue
      }
      // A connect for this appId+region is already in flight (not yet pushed onto
      // feishuConns, so `find()` above can't see it). Skip to avoid opening a duplicate;
      // that connect binds this group's integrations when it resolves. Keyed on region
      // too, so a NEW-region reconcile is NOT blocked by an in-flight OLD-region connect.
      const connectKey = feishuConnKey(group.appId, group.region, group.mode)
      if (this.feishuConnecting.has(connectKey)) continue
      const conn: FeishuConnection = new FeishuConnection({
        group,
        newTraceId: () => randomUUID(),
        onMessage: (msg) => {
          this.channelNameResolver?.noteMessage(conn, { ...msg, mentionedUserIds: msg.mentionedBots })
          this.onInbound(msg, this.srcIntegrationIds(conn))
        },
        onStatusAction: (a) => this.handleStatusAction(a),
        log: this.log
      })
      this.feishuConnecting.add(connectKey)
      try {
        this.log.info(
          `feishu: connecting (${group.integrations.length} integration(s): ${group.integrations
            .map((i) => i.agentId)
            .join(', ')})…`
        )
        await conn.start()
        // The handshake can take seconds; a region change for this appId may have landed
        // meanwhile. Re-check the live desired region before publishing — otherwise this
        // now-stale (old-domain) connect would bind its mapping over the newer region.
        const desired = this.desiredFeishuConfig(group.appId)
        if (!desired || desired.region !== group.region || desired.mode !== group.mode) {
          await conn.stop().catch(() => {})
          this.log.info(
            `feishu: discarding connect for app ${conn.appId} (${group.region}) — desired region is now ` +
              `${desired ? `${desired.region}/${desired.mode}` : 'none'} (superseded mid-handshake)`
          )
          continue
        }
        this.log.info(
          `feishu: ${conn.mode === 'shared' ? 'send-only HTTP client ready' : 'WSClient connected'} for app ` +
            `${conn.appId} (bot ${conn.botOpenId || '?'})`
        )
        for (const { integrationId } of group.integrations) {
          // Mention-routing matches the bot's own open_id (normalize's mentionedBots are open_ids).
          this.botUserIds[integrationId] = conn.botOpenId
          this.fsConnByIntegration.set(integrationId, conn)
        }
        this.feishuConns.push(conn)
      } catch (err) {
        await conn.stop().catch(() => {})
        this.log.error(`feishu: failed to initialize an appId — leaving others intact: ${formatErr(err)}`)
      } finally {
        this.feishuConnecting.delete(connectKey)
      }
    }
    // Label existing sessions' channels now that connections are up (per-message
    // resolution otherwise only fires on fresh traffic — see backfillChannelNames).
    this.backfillChannelNames()
  }

  /**
   * Resolve display names for the channels and triggering users of already-stored
   * Discord/Telegram/Feishu sessions so the console labels them without waiting
   * for a new inbound message (the per-message ChannelNameResolver only fires on
   * fresh traffic). The Slack analog is refreshChannels' bulk membership snapshot;
   * these platforms have no cheap channel enumeration, so we resolve each live
   * session's channel individually via its bot connection. Best-effort +
   * TTL-guarded by the resolver, so calling it on every reconcile is cheap.
   */
  private backfillChannelNames(): void {
    const resolver = this.channelNameResolver
    if (!resolver) return
    for (const row of this.store.listSessions()) {
      if (row.platform !== 'discord' && row.platform !== 'telegram' && row.platform !== 'feishu') continue
      // Legacy unscoped sessions cannot be attributed to the current physical bot.
      // In particular, never use a replacement bot to look up an old bot's chats.
      if (!row.transportScope) continue
      const integrationId = this.integrationIdForTransportScope(row.agentId, row.platform, row.transportScope)
      if (!integrationId) continue
      const conn =
        row.platform === 'discord'
          ? this.dcConnByIntegration.get(integrationId)
          : row.platform === 'telegram'
            ? this.tgConnByIntegration.get(integrationId)
            : this.fsConnByIntegration.get(integrationId)
      if (!conn) continue
      if (row.triggeredBy) {
        resolver.noteMessage(conn, {
          channel: row.channel,
          sender: { id: row.triggeredBy, isBot: false }
        })
      } else {
        resolver.noteChannel(conn, row.channel)
      }
    }
    this.refreshObservedChannels()
  }

  /**
   * Record the enclosing channel of an inbound conversation straight from the message,
   * which already carries it — no platform call, and no waiting on the TTL-cached name
   * lookup. Channel discovery folds a thread onto the channel it belongs to with it; a
   * message that carries none is a no-op.
   */
  private noteChannelScope(msg: NormalizedMessage): void {
    if (!msg.parentChannel) return
    this.store.setChannelScope(msg.channel, { parentId: msg.parentChannel }, this.clock.now())
    this.refreshObservedChannels()
  }

  /**
   * Observed-conversation discovery for Telegram, Discord, and Feishu. These platforms do
   * not give us an authoritative set of chats the bot is engaged in, so stored
   * session history is merged with explicitly-addressed Off conversations already
   * cached for the integration. Reports carry `authoritative:false`: the CP upserts
   * what we know but never treats an absent row as a leave.
   *
   * Names fill in lazily through ChannelNameResolver. Re-merging the cached rows
   * here is important for Off conversations: they have no session row, so without
   * preserving and enriching the cached entry an async Telegram getChat result
   * could never replace the console's raw numeric id.
   *
   * Discord rows are folded onto the channel they belong to first (a session keys on
   * the thread, so raw history repeats one channel per thread) — see collapseObserved.
   */
  private refreshObservedChannels(): void {
    for (const agent of this.agents.values()) {
      for (const platform of ['telegram', 'discord', 'feishu'] as const) {
        const integrations = agent.integrations.filter((i) => i.platform === platform)
        if (integrations.length === 0) continue
        for (const integ of integrations) {
          const observed = this.collapseObserved(
            this.store.observedChannels(agent.id, platform, this.transportScopeForIntegration(integ)),
            platform
          )
          const prior = this.channelSnapshots.get(integ.id)?.channels ?? []
          if (observed.length === 0 && prior.length === 0) continue
          const priorById = new Map(prior.map((c) => [c.id, c]))
          const observedIds = new Set(observed.map((c) => c.id))
          const names = this.store.getDisplayNames([...new Set([...observedIds, ...prior.map((c) => c.id)])])
          // The sessions table cannot distinguish DMs from groups, so the kind comes
          // from the channel lookup's own verdict (`channel_scopes.isIm`), falling back
          // to the kind explicit gated-conversation discovery established. Without it a
          // DM surfaces as a configurable channel row named "@someone", which is not a
          // channel anyone can invite the bot to or set a trigger on.
          const kinds = this.store.getChannelScopes([...observedIds])
          const fromSessions: IntegrationChannel[] = observed.map((c) => {
            const previous = priorById.get(c.id)
            const isIm = kinds.get(c.id)?.isIm
            const kind = isIm === undefined ? previous?.kind : isIm ? ('im' as const) : ('channel' as const)
            const name = c.name ?? names.get(c.id)
            // The enclosing Discord server: the guild snowflake is the identity the
            // console groups on (two servers may share a name), the label is display
            // only. Keep the last known values when this pass can't resolve them (the
            // guild name lands with the channel's name lookup), so the console never
            // flickers back to a bare "#general".
            const spaceId = c.spaceId ?? previous?.spaceId
            const space = c.space ?? previous?.space
            return {
              id: c.id,
              ...(name ? { name } : {}),
              ...(spaceId ? { spaceId } : {}),
              ...(space ? { space } : {}),
              ...(previous?.isPrivate !== undefined ? { isPrivate: previous.isPrivate } : {}),
              ...(kind ? { kind } : {})
            }
          })
          const retained = prior
            .filter((c) => !observedIds.has(c.id))
            .map((c) => {
              const name = names.get(c.id)
              // A retained row has no session behind it (a gated Off channel), so its
              // space is looked up directly rather than coming out of the collapse.
              const found = platform === 'discord' ? this.spaceFor(c.id) : undefined
              const spaceId = found?.id ?? c.spaceId
              const space = found?.name ?? c.space
              const next = {
                ...c,
                ...(name ? { name } : {}),
                ...(spaceId ? { spaceId } : {}),
                ...(space ? { space } : {})
              }
              return next.name === c.name && next.spaceId === c.spaceId && next.space === c.space ? c : next
            })
          const channels = [...fromSessions, ...retained]
          this.channelSnapshots.set(integ.id, { channels, authoritative: false })
          this.cpClient?.emitIntegrationChannels({ integrationId: integ.id, channels, authoritative: false })
        }
      }
    }
  }

  /**
   * Telegram cannot enumerate a bot's chats. Its own `new_chat_members` service
   * record therefore contributes one non-authoritative observed channel row, but
   * never enters `onInbound` or creates an agent turn.
   */
  private observeTelegramChat(chat: TelegramObservedChat, integrationIds: readonly string[]): void {
    if (chat.name) {
      this.store.setDisplayName(chat.id, chat.name, Date.now())
      this.emitSessionMetadataSnapshotsForDisplayName(chat.id)
    }
    for (const integrationId of integrationIds) {
      const integration = this.integrationConfigById(integrationId)
      if (!integration || integration.platform !== 'telegram') continue
      const prior = this.channelSnapshots.get(integrationId)?.channels ?? []
      const current = prior.find((channel) => channel.id === chat.id)
      const observed: IntegrationChannel = {
        ...current,
        id: chat.id,
        ...(chat.name ? { name: chat.name } : {}),
        isPrivate: chat.isPrivate,
        kind: 'channel'
      }
      if (
        current?.name === observed.name &&
        current?.isPrivate === observed.isPrivate &&
        current?.kind === observed.kind
      ) {
        continue
      }
      const channels = current
        ? prior.map((channel) => (channel.id === chat.id ? observed : channel))
        : [...prior, observed]
      this.channelSnapshots.set(integrationId, { channels, authoritative: false })
      this.cpClient?.emitIntegrationChannels({ integrationId, channels, authoritative: false })
    }
  }

  /** The space (Discord guild) a channel sits in — the id that keeps one bot's several
   *  "#general" rows apart, plus its display name once resolved. Undefined until the
   *  channel's name lookup has recorded its guild. */
  private spaceFor(channelId: string): { id: string; name?: string } | undefined {
    const id = this.store.getChannelScopes([channelId]).get(channelId)?.spaceId
    if (!id) return undefined
    const name = this.store.getDisplayNames([id]).get(id)
    return { id, ...(name ? { name } : {}) }
  }

  /**
   * Fold the observed conversations of one platform onto the channel set the console
   * should offer. Discord sessions key on a THREAD channel (the daemon opens one off
   * every top-level mention), so the raw observed set repeats the same channel once per
   * thread — collapse each row onto its enclosing channel and dedupe on the channel
   * snowflake, labelling each row with the guild it sits in (a bot in several servers
   * reaches a "#general" in each). Telegram chats have neither notion; they pass through.
   */
  private collapseObserved(
    observed: { id: string; name?: string }[],
    platform: 'telegram' | 'discord' | 'feishu'
  ): { id: string; name?: string; spaceId?: string; space?: string }[] {
    if (platform !== 'discord') return observed
    // Two-step: the observed (thread) ids first, then the channels they fold onto —
    // whose OWN scope carries the guild, which a thread row may never have recorded.
    const scopes = this.store.getChannelScopes(observed.map((c) => c.id))
    const parents = [...scopes.values()].map((s) => s.parentId).filter((id): id is string => !!id)
    for (const [id, scope] of this.store.getChannelScopes(parents)) scopes.set(id, scope)
    const names = this.store.getDisplayNames(collapseNameLookupIds(observed, scopes))
    return collapseDiscordChannels(observed, scopes, names)
  }

  /**
   * Re-list the channels this connection's bot is a member of and report the
   * snapshot to the CP for every integration bound to the connection (one bot ⇒
   * one membership set, fanned out per integrationId). Best-effort + never throws:
   * a Slack API failure keeps the previous snapshot (listBotChannels returns null),
   * and the emit is a no-op while the CP is down — the cached snapshot is re-emitted
   * on the next CP (re)connect (see startCpClient's onReady).
   */
  private async refreshChannels(conn: SlackConnection): Promise<void> {
    try {
      const channels = await conn.listBotChannels()
      if (!channels) return
      // The snapshot already carries names — cache them for session read-back too.
      for (const c of channels) {
        if (!c.name) continue
        this.store.setDisplayName(c.id, c.name, Date.now())
        this.emitSessionMetadataSnapshotsForDisplayName(c.id)
      }
      for (const [integrationId, c] of this.connByIntegration) {
        if (c !== conn) continue
        // Preserve reported DM rows (§14.3): the membership listing carries channels
        // only, but a gated integration's snapshot also holds DM conversations — a
        // refresh must not wipe them (the CP protects them too; this keeps the
        // in-memory snapshot honest for the reconnect re-assert).
        const ims = (this.channelSnapshots.get(integrationId)?.channels ?? []).filter((x) => x.kind === 'im')
        const merged = [...channels, ...ims]
        this.channelSnapshots.set(integrationId, { channels: merged, authoritative: true })
        this.cpClient?.emitIntegrationChannels({ integrationId, channels: merged })
        this.maybeIntroduceOnJoin(integrationId, channels)
      }
      this.log.debug(`slack: channel snapshot for bot ${conn.botUserId}: ${channels.length} channel(s)`)
    } catch (err) {
      this.log.debug(`slack: channel snapshot refresh failed: ${formatErr(err)}`)
    }
  }

  /**
   * Self-introduce-on-join (issue #536). Given one integration's fresh channel
   * snapshot, detect GENUINE new joins against durable state and, for an opted-in
   * agent, dispatch a one-shot headless intro turn per newly-joined channel — the
   * agent introduces itself to the peers already there via `messageAgent`.
   *
   * Storm-safe: the FIRST snapshot per integration (and any batch larger than
   * `INTRO_MAX_BURST`) is adopted as the silent baseline, so a daemon restart /
   * socket reconnect that re-lists every channel never fires intros. State is
   * marked BEFORE dispatch, so a failed turn is simply skipped (never retried in a
   * loop). Not opted in ⇒ no seeding either, so enabling it later baselines cleanly.
   */
  private maybeIntroduceOnJoin(integrationId: string, channels: { id: string }[]): void {
    const agent = [...this.agents.values()].find((a) => a.integrations.some((i) => i.id === integrationId))
    if (!agent?.introduceOnJoin) return
    const platform = 'slack'
    const plan = planChannelIntros(
      {
        seeded: this.store.isChannelIntroSeeded(integrationId),
        introduced: this.store.channelIntroSet(agent.id, platform)
      },
      channels.map((c) => c.id)
    )
    const now = this.clock.now()
    for (const ch of plan.adoptSilently) this.store.markChannelIntro(agent.id, platform, ch, null)
    if (plan.markSeeded) this.store.markChannelIntroSeeded(integrationId, now)
    for (const ch of plan.introduce) {
      this.store.markChannelIntro(agent.id, platform, ch, now)
      this.log.info(`intro: agent "${agent.id}" self-introducing in channel ${ch}`)
      const traceId = randomUUID()
      const msg = buildIntroMessage(agent.id, platform, ch, traceId)
      // `deliverHeadless` marks THIS turn's fan-out: peers woken via messageAgent run
      // headless and record the newcomer silently. No correlationId ⇒ no orchestration /
      // worker-report side effect (recordWorkerReport only fires on a correlationId).
      // No origin fields (§5.3): a self-introduce is root-like — the woken peer has no parent
      // session to reply into, so it gets no `Parent session` line and no SessionTarget.
      // `introChannel` is the CODE-level bound on the fan-out: discovery in this turn is
      // pinned to the joined channel whatever the model passes to `listAgents` (the prompt
      // asks for the same filter, but a prompt is not a bound — see CallMeta.introChannel).
      const callMeta: CallMeta = {
        callFrom: agent.id,
        hopCount: 0,
        deliveryId: traceId,
        deliverHeadless: true,
        introChannel: ch
      }
      void this.dispatch(agent.id, msg, integrationId, undefined, callMeta).catch((err) =>
        this.log.warn(`intro: dispatch failed for agent "${agent.id}" in ${ch}: ${formatErr(err)}`)
      )
    }
  }

  /**
   * Background retry loop for a Slack connection that failed at initial startup.
   * Creates a fresh SlackConnection (the old one is in an unknown state) and, on
   * success, wires it into `botUserIds` / `connByIntegration` / `connections` so
   * the agent can begin processing messages. On failure, schedules another retry
   * at a slow, fixed interval — never gives up, so a temporary network outage
   * self-heals without manual daemon restart.
   */
  private startSlackRetry(appToken: string): void {
    if (this.slackRetryRuns.has(appToken)) return
    const group = consolidate([...this.agents.values()]).get(appToken)
    if (!group) return
    const run = this.retrySlackConnection(appToken)
      .catch((err) => this.log.error(`slack: retry loop error: ${formatErr(err)}`))
      .finally(() => {
        if (this.slackRetryRuns.get(appToken)?.promise === run) this.slackRetryRuns.delete(appToken)
      })
    this.slackRetryRuns.set(appToken, { botToken: group.botToken, promise: run })
  }

  private async retrySlackConnection(appToken: string): Promise<void> {
    if (this.draining) return
    // Never reuse a captured integration roster: an agent may have detached (or a
    // token may have moved) during the 60s backoff. Resolve the current group now.
    const group = consolidate([...this.agents.values()]).get(appToken)
    if (!group) {
      this.slackRetryTimers.delete(appToken)
      return
    }
    // A file-watch reconcile (reconcileSlackConnections) may have opened this
    // appToken's socket while the retry timer was pending. Opening another here would
    // leave two live Socket Mode connections for one app (a wasted per-app connection
    // slot). The live socket is authoritative — drop the timer and bail.
    if (this.connections.some((c) => c.appToken === group.appToken && c.botToken === group.botToken)) {
      this.slackRetryTimers.delete(group.appToken)
      return
    }
    this.log.info(
      `slack: background retry for appToken (${group.integrations.length} integration(s): ${group.integrations.map((i) => i.agentId).join(', ')})…`
    )
    const conn: SlackConnection = new SlackConnection({
      group,
      newTraceId: () => randomUUID(),
      onMessage: (msg) => {
        // The arrow captures the NEW `conn` ref so nameResolver/onInbound use the
        // successfully-retried connection, not a stale one from an earlier attempt.
        this.nameResolver?.noteMessage(conn, msg)
        this.onInbound(msg, this.srcIntegrationIds(conn))
      },
      onChannelsChanged: () => void this.refreshChannels(conn),
      onMessageShortcut: (shortcut) => this.slackShortcutSession(shortcut, this.srcIntegrationIds(conn)),
      onStatusAction: (a) => this.handleStatusAction(a),
      onStatusInfo: (key) => this.statusInfoForKey(key),
      onPermissionChoice: (a) => this.handlePermissionChoice(a),
      onElicitChoice: (a) => this.handleElicitChoice(a),
      log: this.log,
      boltDebug: this.cfg.logging.level === 'debug' || this.cfg.logging.level === 'trace'
    })
    try {
      await conn.start()
      // The roster may have changed while start() was in flight. Never publish a
      // socket or captured integration list from before a detach/token handoff.
      const currentGroup = consolidate([...this.agents.values()]).get(appToken)
      if (this.draining || !currentGroup || currentGroup.botToken !== group.botToken) {
        await conn.stop().catch(() => {})
        this.slackRetryTimers.delete(appToken)
        return
      }
      this.log.info(`slack: background retry succeeded — connected as bot user ${conn.botUserId}`)
      this.slackRetryTimers.delete(group.appToken)
      for (const { integrationId } of currentGroup.integrations) {
        this.botUserIds[integrationId] = conn.botUserId
        this.connByIntegration.set(integrationId, conn)
      }
      this.connections.push(conn)
      void this.refreshChannels(conn)
    } catch (err) {
      // Release the half-open connection before discarding it so a failure during
      // app.start() doesn't leak a live reconnecting Bolt client each iteration.
      await conn.stop().catch(() => {})
      if (this.draining || !consolidate([...this.agents.values()]).has(appToken)) {
        this.slackRetryTimers.delete(appToken)
        return
      }
      this.log.warn(`slack: background retry failed — scheduling next attempt in 60s: ${formatErr(err)}`)
      const timer = this.clock.setTimeout(() => {
        if (this.draining) return
        this.startSlackRetry(appToken)
      }, 60_000)
      this.slackRetryTimers.set(group.appToken, timer)
    }
  }

  /** Code/socket carve-backs below the denied host HOME/daemon root. Every input
   * is daemon- or registry-owned; agent.json contributes only MCP names, never a
   * filesystem path. */
  private sandboxRuntimeReadRoots(
    agent: LoadedAgent,
    runtime: RuntimeDef,
    launchEnv: Record<string, string>,
    githubAppCredentials: boolean
  ): string[] {
    const configuredMcp = agent.mcpServers.flatMap((name) => {
      const definition = this.mcpServerDefs[name]
      return definition ? [definition] : []
    })
    const cliEntry = daemonEntryForShims(this.root)
    const paths = [mcpSocketPath(this.root)]
    const executableCommands = [process.execPath]
    if (githubAppCredentials) {
      paths.push(gitcredSocketPath(this.root), gitcredShimPath(this.root))
      if (this.ghBinDir) paths.push(this.ghBinDir)
      if (launchEnv.GIT_CONFIG_GLOBAL) paths.push(launchEnv.GIT_CONFIG_GLOBAL)
      const gh = resolveCommandPath('gh', process.env)
      if (gh) executableCommands.push(gh)
    }
    return trustedRuntimeReadRoots({
      runtime,
      hostEnv: process.env,
      mcpServers: configuredMcp,
      executableCommands,
      moduleEntries: [cliEntry, ...nodeExecArgvModuleEntries()],
      paths
    })
  }

  private ensureHost(agentId: string, cfg: ReturnType<typeof loadConfig>): AcpHost {
    let host = this.hosts.get(agentId)
    if (host) return host
    const agent = this.agents.get(agentId)!
    const onUpdate = (sid: string, u: any) => this.onAcpUpdate(agentId, sid, u)
    const runtimeEntry = this.runtimeCatalog.entries[agent.runtime]
    if (runtimeEntry?.source === 'curated') {
      this.curatedRuntimeAdmission.assertLaunch(agent.runtime, runtimeEntry.source)
    }
    // The hostFactory seam must obey the same static external-memory admission
    // gate as a real ACP child; otherwise tests/custom embedders could start an
    // agent whose connection is missing/invalid or whose runtime off-switch is
    // unverified.
    if (agent.memory?.provider === 'external') {
      const runtime = this.runtimes[agent.runtime]
      if (!runtime) throw new MemoryProviderUnavailableError(`runtime "${agent.runtime}" is unavailable`)
      memoryProviderFor(
        agent,
        runtime,
        { ...agentChildEnv(agent), ...cpRuntimeEnv(agent) },
        this.externalMemoryAdmission()
      ).runtimeEnv()
    }
    let configFileState: { childEnv?: Record<string, string | undefined>; materialized: boolean } = {
      materialized: false
    }
    if (this.opts.hostFactory) {
      host = this.opts.hostFactory(agent, onUpdate)
    } else {
      const runtime = this.runtimes[agent.runtime]
      if (!runtime)
        throw new Error(
          `runtime "${agent.runtime}" not available: not installed on this host, or absent from config.runtimes / the ACP registry`
        )
      // A GitHub workspace uses this channel for its implicit repo; scratch uses
      // it only for explicitly authorized repos named by git/gh.
      const githubAppCredentials = agent.workspace.gitCredential === 'github-app'
      // sessionGitEnv LAST: the github-app credential-helper env must win over
      // runtimeOverrides env (a user-supplied GIT_CONFIG_* would reopen
      // the machine-credential leak the injection exists to close).
      const baseEnv: Record<string, string> = { ...agentChildEnv(agent), ...cpRuntimeEnv(agent) }
      const runInSandbox = effectiveRunInSandbox(
        cfg.security.requireSandbox,
        agent.restrictFileAccess,
        this.sandboxMechanism
      )
      if (agent.restrictFileAccess && !runInSandbox) {
        this.log.warn(
          `acp: agent "${agentId}" requested Run in sandbox but this host has no supported Linux sandbox — running without it (#312)`
        )
      }
      const memoryAgent =
        memoryKindOf(agent) === 'native' && runInSandbox ? { ...agent, dir: runtimeHomePath(agent.dir) } : agent
      const runtimeEnv = Object.fromEntries(runtime.env.map((entry) => [entry.name, entry.value]))
      const env: Record<string, string> = {
        ...baseEnv,
        // Memory backend env: managed disables the runtime's own memory; native
        // redirects it under the private runtime HOME. Throws
        // MemoryProviderUnavailableError for an unbuildable provider (external, or
        // native on an unregistered runtime) — surfaced here at spawn.
        ...memoryProviderFor(memoryAgent, runtime, baseEnv, this.externalMemoryAdmission()).runtimeEnv(),
        ...(githubAppCredentials ? sessionGitEnv(agent.id, this.gitCommitIdentity) : {})
      }
      // Config-file secrets (agents/config-file-env.ts): materialize `*_DATA`
      // contents under the agent dir and point the tool-native env vars
      // (KUBECONFIG / DOCKER_CONFIG) at the result; the raw values are stripped
      // from the child env. Detection spans the runtime-def env too, so an
      // explicit pointer var configured anywhere wins and skips materialization.
      // The pre-strip merged env is snapshotted so the idle sweep can delete the
      // files and rematerializeConfigFiles() can re-write them before a later turn.
      const configFileSourceEnv = { ...runtimeEnv, ...env }
      const configFiles = materializeConfigFiles(agent.dir, configFileSourceEnv)
      for (const name of configFiles.strip) {
        delete env[name]
        delete runtimeEnv[name]
      }
      Object.assign(env, configFiles.env)
      this.queueSpawnNotices(agentId, configFiles.notices)
      if (Object.keys(configFiles.env).length > 0) {
        configFileState = { childEnv: configFileSourceEnv, materialized: true }
      }
      const shimDirs = new Set<string>()
      if (githubAppCredentials && this.ghBinDir) {
        // gh wrapper (multi-repo #457): PATH prepend + the agent identity the
        // wrapper hands to the hidden token helper. sessionGitEnv supplies the
        // matching runtime-only capability; a user PATH override must not
        // shadow the wrapper.
        env.AC_AGENT_ID = agent.id
        shimDirs.add(this.ghBinDir)
      }
      if (shimDirs.size > 0) {
        env.PATH = `${[...shimDirs].join(':')}:${env.PATH ?? process.env.PATH ?? ''}`
      }
      // OS sandbox decision (issue #312). security.requireSandbox forces every agent
      // on; otherwise the per-agent preference is effective only when this host has a
      // mechanism. The writable set is derived from the TRUSTED agent dir
      // (agent.dir — the daemon's filesystem-scan result), NOT from the mutable
      // workspace.path in agent.json: the agent-dir ROOT (which holds agent.json)
      // stays read-only, so a confined runtime can't rewrite the config that controls
      // sandboxing and escape on respawn. An un-sandboxable layout (SandboxError)
      // always refuses — never runs unconfined behind an effective on toggle.
      let launch: ReturnType<typeof prepareRuntimeLaunch>
      let launchRuntime = runtime
      try {
        const composed = composeRuntimeLaunch({
          runtimeId: agent.runtime,
          runtime,
          provider: memoryKindOf(agent),
          scopeDir: agent.dir,
          cwd: agent.workspace.path,
          runInSandbox,
          daemonRoot: this.root,
          agentsRoot: cfg.agentsDir,
          runtimeReadRoots: runInSandbox
            ? this.sandboxRuntimeReadRoots(agent, runtime, { ...runtimeEnv, ...env }, githubAppCredentials)
            : undefined,
          explicitEnv: { ...runtimeEnv, ...env },
          sandboxMechanism: this.sandboxMechanism,
          mcpSocketPath: mcpSocketPath(this.root),
          maskedReadRoots:
            runInSandbox && this.sandboxMechanism === 'bwrap'
              ? [delegatedMcpBrokerRoot(this.root), delegatedMcpRuntimeHomeRoot(this.root)]
              : undefined
        })
        launch = composed.launch
        launchRuntime = composed.runtime
      } catch (err) {
        if (err instanceof SandboxError) {
          throw new Error(
            `agent "${agentId}" cannot be safely sandboxed: ${err.message} ` +
              `(turn off Run in sandbox to run it without confinement)`
          )
        }
        throw new Error(`agent "${agentId}" runtime launch preparation failed: ${formatErr(err)}`, { cause: err })
      }
      host = new AcpHost(launchRuntime, {
        onUpdate,
        onPermission: (sid, params) => this.onAcpPermission(agentId, sid, params),
        ...(this.evaluation.enabled
          ? { onPermissionEvent: (sid, params, event) => this.onAcpPermissionEvent(agentId, sid, params, event) }
          : {}),
        onElicit: (sid, params) => this.onAcpElicit(agentId, sid, params),
        onSdkLifecycle: (sid, message) => this.onSdkLifecycle(agentId, sid, message),
        env: launch.env,
        inheritProcessEnv: launch.inheritProcessEnv,
        runtimeId: agent.runtime,
        isolateAccountApps: cfg.security.isolateAccountApps,
        sandbox: launch.sandbox,
        configPrefs: {
          model: agent.runtimeOverrides?.model,
          permissionMode: agent.permissionMode,
          reasoningEffort: agent.reasoningEffort,
          fastMode: agent.fastMode
        },
        log: this.log
      })
    }
    this.hosts.set(agentId, host)
    this.hostStartedAt.set(agentId, this.clock.now())
    this.hostConfigFiles.set(agentId, { agentDir: agent.dir, ...configFileState })
    return host
  }

  /** Construct an ACP host whose process is owned by one delegated webchat cell.
   * Unlike ordinary agent-scoped hosts it is never published in `this.hosts`. */
  private createDelegatedWebchatHost(input: DelegatedWebchatHostFactoryInput): AcpHost {
    const agent = this.agents.get(input.agentId)
    if (!agent) throw new Error(`unknown delegated webchat agent ${input.agentId}`)
    const runtime = this.runtimes[agent.runtime]
    if (!runtime) throw new Error(`runtime "${agent.runtime}" is unavailable for delegated webchat`)
    const runtimeEntry = this.runtimeCatalog.entries[agent.runtime]
    if (runtimeEntry?.source === 'curated') {
      this.curatedRuntimeAdmission.assertLaunch(agent.runtime, runtimeEntry.source)
    }

    const baseEnv: Record<string, string> = { ...agentChildEnv(agent), ...cpRuntimeEnv(agent) }
    const runtimeEnv = Object.fromEntries(runtime.env.map((entry) => [entry.name, entry.value]))
    const memoryEnv = memoryProviderFor(
      agent,
      runtime,
      { ...runtimeEnv, ...baseEnv },
      this.externalMemoryAdmission()
    ).runtimeEnv()
    const githubAppCredentials = agent.workspace.gitCredential === 'github-app'
    const launchEnv = {
      ...runtimeEnv,
      ...baseEnv,
      ...memoryEnv,
      ...(githubAppCredentials ? sessionGitEnv(agent.id, this.gitCommitIdentity) : {})
    }
    const composed = composeRuntimeLaunch({
      runtimeId: agent.runtime,
      runtime,
      provider: memoryKindOf(agent),
      scopeDir: agent.dir,
      cwd: agent.workspace.path,
      runInSandbox: true,
      daemonRoot: this.root,
      agentsRoot: this.cfg.agentsDir,
      runtimeReadRoots: this.sandboxRuntimeReadRoots(agent, runtime, launchEnv, githubAppCredentials),
      sandboxMechanism: 'bwrap',
      mcpSocketPath: mcpSocketPath(this.root),
      maskedReadRoots: [delegatedMcpBrokerRoot(this.root), delegatedMcpRuntimeHomeRoot(this.root)],
      explicitEnv: launchEnv
    })
    // Seed only bounded auth/config files into this conversation-private HOME.
    // Custom targets skip legacy-state moves, so one cell can never steal another
    // host's durable runtime state.
    const credentials = prepareSharedRuntimeCredentials({ runtimeId: agent.runtime, runtime, hostEnv: process.env })
    prepareRuntimeHome(agent.runtime, agent.dir, process.env, input.runtimeHome, credentials?.seedExclusions)
    credentials?.preparePrivateHome(input.runtimeHome)
    const env = {
      ...runtimeHomeEnvironment(agent.runtime, input.runtimeHome, composed.launch.env),
      ...credentials?.env
    }
    const ordinaryRuntimeHome = composed.launch.runtimeHome
    const delegatedWritable = (composed.launch.sandbox?.writable ?? []).filter((path) => path !== ordinaryRuntimeHome)
    const delegatedAllowRead = (composed.launch.sandbox?.allowReadRoots ?? []).filter(
      (path) => path !== ordinaryRuntimeHome
    )
    return new AcpHost(composed.runtime, {
      onUpdate: (sid, update) => this.onAcpUpdate(input.agentId, sid, update),
      onPermission: (sid, params) => this.onAcpPermission(input.agentId, sid, params),
      ...(this.evaluation.enabled
        ? {
            onPermissionEvent: (sid, params, event) => this.onAcpPermissionEvent(input.agentId, sid, params, event)
          }
        : {}),
      onElicit: (sid, params) => this.onAcpElicit(input.agentId, sid, params),
      onSdkLifecycle: (sid, message) => this.onSdkLifecycle(input.agentId, sid, message),
      env,
      inheritProcessEnv: false,
      runtimeId: agent.runtime,
      isolateAccountApps: this.cfg.security.isolateAccountApps,
      sandbox: {
        ...input.sandbox,
        denyReadRoots: composed.launch.sandbox?.denyReadRoots,
        allowReadRoots: delegatedAllowRead,
        // Keep the ordinary trusted workspace/memory/shared-MCP writable set,
        // then add only this cell's private HOME. delegatedCellSandboxWrap
        // removes anything beneath the masked private roots before binding back
        // this exact cell.
        writable: [...delegatedWritable, input.runtimeHome]
      },
      onTerminal: input.onTerminal,
      configPrefs: {
        model: agent.runtimeOverrides?.model,
        permissionMode: agent.permissionMode,
        reasoningEffort: agent.reasoningEffort,
        fastMode: agent.fastMode
      },
      log: this.log
    })
  }

  private delegatedMcpIsolationHealthy(): boolean {
    return supportsDelegatedMcpIsolation({
      platform: this.opts.platform ?? process.platform,
      mechanism: this.sandboxMechanism,
      requireSandbox: this.cfg.security.requireSandbox,
      // detectSandbox() returns bwrap only after its mount/PID probe succeeds.
      bwrapProbePassed: this.sandboxMechanism === 'bwrap'
    })
  }

  private registrationFeatures(): string[] {
    return [
      ...(this.opts.agentName ? [] : ['agent-move-v1', 'workspace-convert-v1', 'workspace-edit-v2']),
      'workspace-file-edit-v1',
      'workspace-file-delete-v1',
      ...(this.sandboxMechanism ? ['sandbox'] : []),
      ...(this.cfg.security.requireSandbox ? ['sandbox-required'] : []),
      'memory-dreaming-v1',
      SESSION_VISIBILITY_FEATURE,
      ...(this.delegatedMcpBroker && this.delegatedWebchatHosts && this.delegatedMcpIsolationHealthy()
        ? [DELEGATED_MCP_ASSERTION_FEATURE]
        : [])
    ]
  }

  private initializeDelegatedMcp(root: string, cpUrl: string, cpClient: CpClient): void {
    if (!this.delegatedMcpIsolationHealthy()) {
      defaultDelegatedMcpMetrics.denied('capability_probe_failed')
      return
    }
    const endpoint = new URL('/api/v1/mcp', cpUrl)
    if (endpoint.protocol === 'ws:') endpoint.protocol = 'http:'
    if (endpoint.protocol === 'wss:') endpoint.protocol = 'https:'
    const broker = new SessionMcpBroker({
      socketRoot: delegatedMcpBrokerRoot(root),
      inCellSocketDirectory: delegatedMcpInCellSocketDirectory(),
      cliEntry: daemonEntryForShims(root),
      mcpEndpoint: endpoint.toString(),
      cpClient,
      metrics: defaultDelegatedMcpMetrics
    })
    const manager = new DelegatedWebchatHostManager({
      broker,
      brokerSourceRoot: delegatedMcpBrokerRoot(root),
      runtimeHomeRoot: delegatedMcpRuntimeHomeRoot(root),
      isolationHealthy: () => this.delegatedMcpIsolationHealthy(),
      hostFactory: (input) => this.createDelegatedWebchatHost(input),
      metrics: defaultDelegatedMcpMetrics,
      log: { warn: (message) => this.log.warn(message) }
    })
    this.delegatedMcpBroker = broker
    this.delegatedWebchatHosts = manager
  }

  private async revokeDelegatedAuthority(
    authority: Pick<StartDelegatedWebchatHost, 'delegationId' | 'generation'>,
    reason: 'session_closed' | 'session_expired' | 'agent_detached'
  ): Promise<void> {
    const client = this.cpClient
    if (!client) return
    await client.revokeWebchatMcpDelegation({
      delegationId: authority.delegationId,
      generation: authority.generation,
      reason
    })
  }

  private async closeDelegatedConversation(
    agentId: string,
    conversationId: string,
    reason: 'session_closed' | 'session_expired'
  ): Promise<void> {
    const authority = await this.delegatedWebchatHosts?.closeConversation({ agentId, conversationId })
    if (!authority) return
    await this.revokeDelegatedAuthority(authority, reason)
  }

  private async closeDelegatedAgent(agentId: string): Promise<void> {
    const authorities = (await this.delegatedWebchatHosts?.closeAgent(agentId)) ?? []
    await Promise.all(authorities.map((authority) => this.revokeDelegatedAuthority(authority, 'agent_detached')))
  }

  private selectedDelegatedTurnHost(
    agentId: string,
    conversationId: string,
    delegatedHost: DelegatedWebchatHost
  ): SelectedTurnHost {
    const manager = this.delegatedWebchatHosts
    let cleanup: Promise<void> | undefined
    return {
      host: delegatedHost.host,
      stopOnError: true,
      stop: () =>
        (cleanup ??= (async () => {
          if (!manager) {
            throw new Error('delegated webchat host manager is unavailable during turn cleanup')
          }
          await manager.stopHost({
            agentId,
            conversationId,
            isolationCellId: delegatedHost.isolationCellId
          })
        })()),
      waitForCleanup: () => cleanup ?? Promise.resolve()
    }
  }

  private selectedOrdinaryTurnHost(agentId: string, host: AcpHost): SelectedTurnHost {
    let cleanup: Promise<void> | undefined
    return {
      host,
      stopOnError: false,
      stop: (deadlineMs) => (cleanup ??= this.stopHost(agentId, deadlineMs)),
      waitForCleanup: () => cleanup ?? Promise.resolve()
    }
  }

  private fenceLifecycleCleanupFailure(
    agentId: string,
    key: string,
    entry: QueueEntry,
    error: unknown
  ): Promise<never> {
    if (!entry.lifecycleCleanupFailureLogged) {
      entry.lifecycleCleanupFailureLogged = true
      const scope = entry.selectedHost?.stopOnError ? 'delegated ' : ''
      this.log.error(
        `${scope}lifecycle cleanup blocked for agent "${agentId}" (session ${key}); ownership and admission remain fenced: ${formatErr(error)}`
      )
    }
    if (!entry.lifecycleCleanupBlocked) {
      this.beginSafetyDrain(agentId, 'stop', [key])
      entry.lifecycleCleanupBlocked = new Promise<never>(() => {})
      this.addSafetyDrainWait(agentId, entry.lifecycleCleanupBlocked)
    }
    return entry.lifecycleCleanupBlocked
  }

  private async waitForTurnLifecycleCleanup(
    entry: QueueEntry,
    key: string,
    selectedHost?: SelectedTurnHost
  ): Promise<TurnLifecycleCleanupOutcome> {
    try {
      await entry.lifecycleCleanup
      await selectedHost?.waitForCleanup()
      return { blocked: false }
    } catch (error) {
      this.fenceLifecycleCleanupFailure(entry.agentId, key, entry, error)
      return { blocked: true, error }
    }
  }

  private beginFailedTurnCleanup(
    agentId: string,
    key: string,
    entry: QueueEntry,
    selectedHost?: SelectedTurnHost
  ): void {
    if (!selectedHost?.stopOnError) return
    // The error itself is the atomic lifecycle boundary. Do not wait for a child
    // exit or bridge callback: synchronously enter the manager's exact-cell,
    // teardown-singleflight stop path before any dispatch state can be released.
    this.beginSafetyDrain(agentId, 'stop', [key])
    const cleanup = selectedHost.stop(0)
    const failClosed = cleanup.catch((error) => this.fenceLifecycleCleanupFailure(agentId, key, entry, error))
    this.addSafetyDrainWait(agentId, failClosed)
  }

  private async stopSelectedTurnHosts(turns: Iterable<Pick<Pending, 'selectedHost'>>): Promise<void> {
    const selected = new Set<SelectedTurnHost>()
    for (const turn of turns) {
      if (turn.selectedHost) selected.add(turn.selectedHost)
    }
    await Promise.all([...selected].map((lifecycle) => lifecycle.stop(0)))
  }

  private queueMemoryPostTurn(
    agentId: string,
    sessionId: string,
    turnId: string,
    input: string,
    output: string,
    binding: Agent['memory'],
    captureTarget?: PreparedExternalMemoryCapture,
    evaluationTurnId = turnId
  ): void {
    if (this.evaluationProfile.memory === 'off') return
    if (!output.trim()) return
    // Agent memory is agent-scoped and shared across users, so a private
    // session's turn must never be distilled into it (session-visibility.md
    // §5.1). The gate is checked HERE — before both the managed distillation and
    // the external capture outbox — and fails closed on unknown state.
    if (this.store.isCaptureExcluded(sessionId)) return
    const provider = binding?.provider ?? 'managed'
    const observableCapture = provider === 'managed' || provider === 'external'
    const record = async () => {
      if (observableCapture) {
        this.emitEvaluation({
          type: 'memory.capture.requested',
          agentId,
          sessionId,
          turnId: evaluationTurnId,
          data: { provider, inputBytes: Buffer.byteLength(input), outputBytes: Buffer.byteLength(output) }
        })
      }
      try {
        await this.memory.recordTurnForBinding(
          { agentId, sessionId },
          { turnId, sessionId, input, output },
          binding,
          captureTarget
        )
        if (observableCapture) {
          this.emitEvaluation({
            type: 'memory.capture.completed',
            agentId,
            sessionId,
            turnId: evaluationTurnId,
            data: { provider }
          })
        }
      } catch (error) {
        if (observableCapture) {
          this.emitEvaluation({
            type: 'memory.capture.failed',
            agentId,
            sessionId,
            turnId: evaluationTurnId,
            data: { provider, errorName: error instanceof Error ? error.name : 'UnknownError' }
          })
        }
        throw error
      }
    }
    const logFailure = (err: unknown) =>
      this.log.warn(`memory post-turn failed for agent ${agentId}: ${err instanceof Error ? err.name : 'unknown'}`)

    // External recordTurn performs only a synchronous SQLite enqueue before it
    // returns its promise. Do it immediately after delivery, rather than placing
    // it behind an older managed distillation job where a crash could lose it.
    if (binding?.provider === 'external') {
      try {
        void record().catch(logFailure)
      } catch (err) {
        logFailure(err)
      }
      return
    }
    const prior = this.memoryPostTurnChains.get(agentId) ?? Promise.resolve()
    const next = prior
      .then(async () => {
        await record()
      })
      // Never log plugin/upstream response text: it may contain memory bodies or credentials.
      .catch(logFailure)
      .finally(() => {
        if (this.memoryPostTurnChains.get(agentId) === next) this.memoryPostTurnChains.delete(agentId)
      })
    this.memoryPostTurnChains.set(agentId, next)
  }

  private async runMemoryExtraction(agentId: string, prompt: string): Promise<string> {
    const agent = this.agents.get(agentId)
    if (!agent) throw new Error(`unknown agent ${agentId}`)
    const host = await this.ensureHostAsync(agentId)
    if (this.memoryExtractionUnavailable.has(host)) {
      throw new Error('memory extraction is unavailable for this runtime host')
    }
    let sessionId = this.memoryExtractionSessions.get(agentId)
    if (!sessionId || !host.hasSession(sessionId)) {
      const modes = host.permissionModeOptions()?.modes ?? []
      const readOnlyMode = trustedExtractionMode(host.usesMetaSystemPrompt(), modes)
      if (!readOnlyMode) {
        this.memoryExtractionUnavailable.add(host)
        throw new Error('runtime lacks a trusted system prompt or verified read-only memory-extraction mode')
      }
      let cwd = this.memoryExtractionDirs.get(agentId)
      if (!cwd) {
        cwd = await mkdtemp(join(tmpdir(), 'agentconnect-memory-distill-'))
        this.memoryExtractionDirs.set(agentId, cwd)
      }
      sessionId = await host.newSession(cwd, [], undefined, MEMORY_DISTILLATION_SYSTEM_PROMPT)
      if (!(await host.setSessionPermissionMode(sessionId, readOnlyMode))) {
        host.discardSession(sessionId)
        this.memoryExtractionUnavailable.add(host)
        throw new Error('runtime lacks a trusted system prompt or verified read-only memory-extraction mode')
      }
      this.memoryExtractionSessions.set(agentId, sessionId)
    }
    const key = pendingTurnKey(agentId, sessionId)
    const chunks: string[] = []
    this.memoryExtractionQuarantines.delete(key)
    this.memoryExtractionCollectors.set(key, { chunks })
    try {
      // Extraction runs read-only and shouldn't touch the config files, but keep
      // the invariant uniform: every host.prompt is preceded by re-materialization.
      this.rematerializeConfigFiles(agentId)
      await host.prompt(sessionId, [{ type: 'text', text: prompt }])
      return chunks.join('')
    } catch (err) {
      if (this.memoryExtractionSessions.get(agentId) === sessionId) this.memoryExtractionSessions.delete(agentId)
      throw err
    } finally {
      this.memoryExtractionQuarantines.set(key, agentId)
      this.memoryExtractionCollectors.delete(key)
    }
  }

  /**
   * Run one isolated dream-extraction session (docs/designs/memory-dreaming.md §5).
   * Unlike the long-lived distillation session, every dream gets a FRESH session
   * and discards it — dreams are rare and their huge prompts should not linger in
   * a cached context.
   *
   * Two independent trust dimensions, deliberately gated differently:
   *
   * - **Side effects during the run — HARD GATE (fail closed).** The mined
   *   transcript is attacker-controlled; a prompt injection could drive the
   *   runtime's native shell/file/network tools before it ever returns JSON, and
   *   staged-output review only contains the *memory result*, not tool side
   *   effects. So we REQUIRE a verified non-mutating (read-only/plan) permission
   *   mode and throw if the runtime has none or the switch doesn't take — the
   *   dream then fails rather than running with write access. (Passing `[]`
   *   mcpServers only drops our MCP tools, not the runtime's built-ins.)
   * - **Trusted system-prompt channel — OBSERVED.** When the runtime carries the
   *   system prompt via `_meta.systemPrompt` the dream policy rides it; otherwise
   *   the policy is prepended to the user prompt. Auto-accept is the user's
   *   explicit choice to skip content review, so this transport distinction does
   *   not override it; the verified non-mutating mode above still gates the run.
   */
  private async runDreamExtraction(
    agentId: string,
    systemPrompt: string,
    prompt: string,
    signal: AbortSignal,
    context: { dreamId: string; trigger: 'manual' | 'schedule' | 'auto'; sessionIds: string[] }
  ): Promise<{
    output: string
    sessionId: string
    runtime: string
    model?: string
    stopReason: string
    usage?: StoredUsage
  }> {
    const agent = this.agents.get(agentId)
    if (!agent) throw new Error(`unknown agent ${agentId}`)
    const host = await this.ensureHostAsync(agentId)
    // Capture the transport capability from THIS host so the extraction policy
    // uses the same dedicated-system-prompt or inline path as the proposal run.
    const trusted = host.usesMetaSystemPrompt()
    let cwd = this.memoryExtractionDirs.get(agentId)
    if (!cwd) {
      cwd = await mkdtemp(join(tmpdir(), 'agentconnect-memory-distill-'))
      this.memoryExtractionDirs.set(agentId, cwd)
    }
    // Abort can land during the awaited setup below, before any prompt exists —
    // then `session/cancel` has nothing to cancel. Guard on the signal after each
    // await and immediately before dispatch so a canceled dream bails instead of
    // launching an uncancellable prompt.
    if (signal.aborted) throw new Error('dream extraction canceled before dispatch')
    const sessionId = trusted ? await host.newSession(cwd, [], undefined, systemPrompt) : await host.newSession(cwd, [])
    const modelOptions = host.modelOptions?.(sessionId) ?? null
    const selectedModel = modelOptions?.current
    // Mirror ordinary-turn attribution: a runtime-owned `default` means the
    // concrete model is unknown. Only use config when the runtime exposes no
    // selector at all; an advertised `default` may mean the override failed to
    // apply, and persisting/pricing that override would be false observability.
    const model =
      modelOptions === null ? agent.runtimeOverrides?.model : selectedModel === 'default' ? undefined : selectedModel
    const executionKey = sessionKey('dream', 'memory', context.dreamId, agentId)
    const now = this.clock.now()
    this.store.upsertSession({
      key: executionKey,
      agentId,
      platform: 'dream',
      channel: 'memory',
      thread: context.dreamId,
      acpSessionId: sessionId,
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: now,
      triggeredBy: context.trigger,
      memoryProvider: 'managed'
    })
    this.store.setSessionTitle(executionKey, 'Memory dream')
    const dream = this.store.getDream(agentId, context.dreamId)
    if (dream) {
      this.store.updateDream({
        ...dream,
        executionSessionId: sessionId,
        runtime: agent.runtime,
        ...(model ? { model } : {})
      })
    }
    this.store.appendTranscript({
      channel: 'memory',
      thread: context.dreamId,
      ts: monotonicTs(),
      sender: agentId,
      kind: 'text',
      text: 'Memory dream started.'
    })
    this.emitSessionMetadataSnapshot({
      sessionId,
      agentId,
      phase: 'start',
      platform: 'dream',
      channel: 'memory',
      thread: context.dreamId,
      status: 'running',
      runtime: agent.runtime,
      ...(model ? { model } : {})
    })
    // On cancel, drive the ACP turn-cancel path so a hung/long prompt actually
    // stops instead of pinning the dream's one-in-flight reservation.
    const onAbort = () => void host.cancel(sessionId).catch(() => {})
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    let promptCompleted = false
    let extractionMode: string | undefined
    let collector: MemoryExtractionCollector | undefined
    try {
      if (signal.aborted) throw new Error('dream extraction canceled before dispatch')
      // HARD GATE: require a verified non-mutating mode. Fail closed if the
      // runtime advertises none or the switch is rejected — never run an
      // injection-exposed extraction with write access.
      const modes = host.permissionModeOptions()?.modes ?? []
      const readOnlyMode = modes.find((mode) => mode === 'read-only') ?? modes.find((mode) => mode === 'plan')
      extractionMode = readOnlyMode
      if (!readOnlyMode || !(await host.setSessionPermissionMode(sessionId, readOnlyMode))) {
        throw new Error('runtime lacks a verified read-only/plan mode; dream extraction cannot run safely')
      }
      // Final guard immediately before dispatch — abort during permission setup.
      if (signal.aborted) throw new Error('dream extraction canceled before dispatch')

      const key = pendingTurnKey(agentId, sessionId)
      const chunks: string[] = []
      collector = {
        chunks,
        sessionKey: executionKey,
        runtimeCostReported: false,
        transcript: { channel: 'memory', thread: context.dreamId, recorder: new TranscriptRecorder() }
      }
      this.memoryExtractionQuarantines.delete(key)
      this.memoryExtractionCollectors.set(key, collector)
      try {
        this.rematerializeConfigFiles(agentId)
        const text = trusted ? prompt : `${systemPrompt}\n\n${prompt}`
        this.store.appendTranscript({
          channel: 'memory',
          thread: context.dreamId,
          ts: monotonicTs(),
          sender: 'memory',
          recipient: agentId,
          kind: 'text',
          text
        })
        // Bounded backstop: if the runtime ignores `session/cancel` and never
        // yields, stop awaiting after DREAM_CANCEL_FORCE_MS from the abort so the
        // `finally` discards the ACP session instead of leaking it. The runner's
        // own grace window already releases the reservation independently.
        const result = await this.promptWithCancelBackstop(host, sessionId, text, signal, (prompt) => {
          // Release the potentially large proposal chunks once the backstop wins,
          // but retain a key-only tombstone until the owning host stops. Some ACP
          // adapters can still emit callbacks after the prompt promise settles.
          if (this.memoryExtractionCollectors.get(key) === collector) this.memoryExtractionCollectors.delete(key)
          this.memoryExtractionQuarantines.set(key, agentId)
          void prompt.catch(() => {})
        })
        promptCompleted = true
        if (result.usage) {
          const counts = {
            totalTokens: result.usage.totalTokens,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            thoughtTokens: result.usage.thoughtTokens ?? undefined,
            cachedReadTokens: result.usage.cachedReadTokens ?? undefined,
            cachedWriteTokens: result.usage.cachedWriteTokens ?? undefined
          }
          this.store.setTokenUsage(executionKey, counts)
          if (this.isCodexRuntime(agentId) && !collector.runtimeCostReported) {
            const estimate = estimateOpenAiTurnCost(model, counts)
            if (estimate.ok) this.store.addCost(executionKey, estimate.amount, estimate.currency)
          }
        }
        const usage = this.store.getUsage(executionKey)
        return {
          output: chunks.join(''),
          sessionId,
          runtime: agent.runtime,
          ...(model ? { model } : {}),
          stopReason: String(result.stopReason),
          ...(Object.keys(usage).length ? { usage } : {})
        }
      } finally {
        this.memoryExtractionQuarantines.set(key, agentId)
        if (this.memoryExtractionCollectors.get(key) === collector) this.memoryExtractionCollectors.delete(key)
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      if (collector?.transcript) {
        const { channel, thread, recorder } = collector.transcript
        for (const ev of recorder.onFinal()) this.recordEvent(agentId, channel, thread, ev)
        const output = collector.chunks.join('')
        if (output) {
          this.store.appendTranscript({
            channel,
            thread,
            ts: monotonicTs(),
            sender: agentId,
            kind: 'text',
            text: output
          })
        }
      }
      // Report even on failed/canceled prompts: a runtime may have streamed a
      // native cost/context snapshot before the terminal error. The CP upsert is
      // latest-wins, so the success path and this failure-safe path share one
      // idempotent emission point.
      this.emitStoredUsageReport(sessionId, agentId, 'dream', 'memory', executionKey)
      this.store.appendTranscript({
        channel: 'memory',
        thread: context.dreamId,
        ts: monotonicTs(),
        sender: agentId,
        kind: 'text',
        text: promptCompleted
          ? 'Model extraction finished. The dream job is validating and staging the result.'
          : 'Model extraction stopped before producing a result.'
      })
      this.store.setSessionState(executionKey, 'idle', this.clock.now())
      this.emitSessionMetadataSnapshot({
        sessionId,
        agentId,
        phase: promptCompleted ? 'end' : 'problem',
        platform: 'dream',
        channel: 'memory',
        thread: context.dreamId,
        status: promptCompleted ? 'completed' : signal.aborted ? 'canceled' : 'failed',
        runtime: agent.runtime,
        ...(model ? { model } : {}),
        ...(extractionMode ? { permissionMode: extractionMode } : {})
      })
      host.discardSession(sessionId)
    }
  }

  /** Await `host.prompt`, but stop waiting `DREAM_CANCEL_FORCE_MS` after an abort
   *  if the runtime never yields — so a runtime that ignores `session/cancel`
   *  can't wedge this call (and its ACP session) forever. */
  private async promptWithCancelBackstop(
    host: AcpHost,
    sessionId: string,
    text: string,
    signal: AbortSignal,
    onDetached?: (prompt: ReturnType<AcpHost['prompt']>) => void
  ): Promise<Awaited<ReturnType<AcpHost['prompt']>>> {
    const done = host.prompt(sessionId, [{ type: 'text', text }])
    let timer: ReturnType<typeof setTimeout> | undefined
    const backstop = new Promise<never>((_resolve, reject) => {
      const arm = () =>
        (timer = setTimeout(() => {
          onDetached?.(done)
          reject(new Error('dream extraction ignored session/cancel; detached after backstop'))
        }, DREAM_CANCEL_FORCE_MS))
      if (signal.aborted) arm()
      else signal.addEventListener('abort', arm, { once: true })
    })
    try {
      return await Promise.race([done, backstop])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** Bridge the dream engine's metadata-only lifecycle into evaluation telemetry
   *  and the transcript of its background execution session. Raw ACP activity is
   *  recorded separately by the extraction collector; it never enters evaluation
   *  events, platform delivery, or logs. */
  private recordDreamLifecycle(event: DreamLifecycleEvent): void {
    const { dream } = event
    this.emitEvaluation({
      type: event.type,
      agentId: dream.agentId,
      ...(dream.executionSessionId ? { sessionId: dream.executionSessionId } : {}),
      data: {
        dreamId: dream.dreamId,
        trigger: dream.trigger,
        sourceSessionCount: dream.sessionIds.length,
        ...(dream.runtime ? { runtime: dream.runtime } : {}),
        ...(dream.model ? { model: dream.model } : {}),
        ...(dream.stopReason ? { stopReason: dream.stopReason } : {}),
        ...(dream.usage ? { usage: dream.usage } : {}),
        ...(dream.error ? { errorType: dream.error.type } : {}),
        ...(event.skillName ? { skillName: event.skillName } : {})
      }
    })

    if (!dream.executionSessionId || event.type === 'memory.dream.started') return
    const rec = this.store.getSessionByAcpIdForAgent(dream.agentId, dream.executionSessionId)
    if (!rec) return
    const message: Partial<Record<DreamLifecycleEvent['type'], string>> = {
      'memory.dream.completed': 'Dream completed. The staged memory is ready for review.',
      'memory.dream.failed': 'Dream failed during proposal validation or staging.',
      'memory.dream.adopted': 'The staged memory was adopted.',
      'memory.dream.skill_accepted': 'A recommended skill was accepted.',
      'memory.dream.skill_dismissed': 'A recommended skill was dismissed.'
    }
    const text = message[event.type]
    if (text) {
      this.store.appendTranscript({
        channel: rec.channel,
        thread: rec.thread,
        ts: monotonicTs(),
        sender: dream.agentId,
        kind: 'text',
        text
      })
    }
    this.store.setSessionState(rec.key, 'idle', this.clock.now())
    this.emitSessionMetadataSnapshot({
      sessionId: dream.executionSessionId,
      agentId: dream.agentId,
      phase: event.type === 'memory.dream.failed' ? 'problem' : 'end',
      platform: 'dream',
      channel: rec.channel,
      thread: rec.thread,
      status: dream.status,
      ...(dream.runtime ? { runtime: dream.runtime } : {}),
      ...(dream.model ? { model: dream.model } : {})
    })
  }

  /** The daemon's single dream-job engine, built on first use (the local store
   *  must exist for the boot-time crash-recovery sweep). */
  private dreamRunner(): DreamRunner {
    this.dreamRunnerInstance ??= new DreamRunner({
      agentDirByAgent: (id) => this.agents.get(id)?.dir,
      dreamingPolicyFor: (id) => dreamingPolicyOf(this.agents.get(id)),
      store: this.store,
      extract: (agentId, systemPrompt, prompt, signal, context) =>
        this.runDreamExtraction(agentId, systemPrompt, prompt, signal, context),
      onEvent: (event) => this.recordDreamLifecycle(event),
      log: this.log
    })
    return this.dreamRunnerInstance
  }

  /** Whether this agent is backed by Codex ACP. Registry ids are canonical, while
   *  command/args matching keeps user-defined runtime aliases working. */
  private isCodexRuntime(agentId: string): boolean {
    const agent = this.agents.get(agentId)
    if (!agent) return false
    const runtime = this.runtimes[agent.runtime]
    return [agent.runtime, runtime?.command, ...(runtime?.args ?? [])]
      .filter((part): part is string => typeof part === 'string')
      .some((part) => /(?:^|[\\/])codex-acp(?:@[^\\/]*)?$/.test(part.toLowerCase()))
  }

  /** The bare Telegram message id from a normalized `telegram:<chatId>:<messageId>`
   *  msgId (the last segment; chat ids may be negative, so split, don't parse). */
  private telegramMessageId(msg: NormalizedMessage): string {
    const parts = msg.msgId.split(':')
    return parts[parts.length - 1] ?? ''
  }

  /**
   * Resolve the session thread for a Telegram message and set it on `msg.thread` in
   * place (normalize leaves it unset for Telegram). Ladder:
   *   - forum topic       → the topic id (a real native thread; numeric, so it also
   *                          drives the post's `message_thread_id`)
   *   - native reply-root → `tg:<root>` from Telegram's own `message_thread_id` in a
   *                          plain supergroup (Telegram auto-threads replies to the root)
   *   - DM                → one continuous session per chat (`dm`)
   *   - reply that maps   → the session the replied-to message belongs to, resolved from
   *                          the transcript (basic groups carry no `message_thread_id`)
   *   - otherwise         → a fresh session rooted at this message (`tg:<msgId>`) — a new
   *                          @mention, or a reply we can't place
   * A fresh @mention (message N, no thread root) keys `tg:N`; every later reply in that
   * thread carries `message_thread_id = N`, so it keys `tg:N` too — the two meet with no
   * lookup. The non-topic keys are deliberately NON-numeric so posting never mistakes
   * them for a forum `message_thread_id` (see TelegramConnection.postMessage). No-op for
   * other platforms or when the thread is already set.
   */
  private canonicalizeTelegramThread(msg: NormalizedMessage): void {
    if (msg.platform !== 'telegram' || msg.thread !== undefined) return
    if (msg.telegramTopicId !== undefined) {
      msg.thread = msg.telegramTopicId
      return
    }
    if (msg.telegramThreadRoot !== undefined) {
      msg.thread = `tg:${msg.telegramThreadRoot}`
      return
    }
    if (msg.isDm) {
      msg.thread = 'dm'
      return
    }
    if (msg.replyTo) {
      const owner = this.store.telegramThreadForMessage(
        transcriptChannelKey(msg.channel, msg.transportScope),
        msg.replyTo
      )
      msg.thread = owner ?? `tg:${msg.replyTo}`
      return
    }
    msg.thread = `tg:${this.telegramMessageId(msg)}`
  }

  /** Telegram reply target for a turn/command triggered by `msg`: the triggering
   *  message's own id, so the bot's posts reply to it (req: reply to the last message
   *  in the session, and keep the reply chain resolvable). An agent-call turn
   *  (`replyToSession` / a peer wake) synthesizes its msgId (`agentcall:<channel>:<uuid>`)
   *  so no platform id can be recovered — without a fallback its answer posts to the
   *  chat root, visually outside the reply chain the session lives in. Those turns
   *  anchor to the session's thread root instead (`tg:<root>`, see
   *  {@link canonicalizeTelegramThread}); `dm` and numeric forum-topic threads carry no
   *  reply anchor. Undefined off Telegram or when neither id resolves. */
  private telegramReplyTarget(msg: NormalizedMessage): number | undefined {
    if (msg.platform !== 'telegram') return undefined
    const n = Number(this.telegramMessageId(msg))
    if (Number.isInteger(n) && n > 0) return n
    const root = msg.thread !== undefined ? /^tg:(\d+)$/.exec(msg.thread) : null
    const r = root ? Number(root[1]) : NaN
    return Number.isInteger(r) && r > 0 ? r : undefined
  }

  // route an inbound Slack message
  private seenMsgIds = new Set<string>()

  /** Platform messages from AgentConnect-managed Slack apps may remain visible in
   *  conversation history, but are never an activation path. Same-daemon bots use their
   *  resolved Slack identities; cross-daemon bots use the CP collaboration snapshot's
   *  public Slack app ids. Internal `messageAgent` delivery bypasses platform ingress. */
  private isManagedSlackBotIdentity(channel: string, senderId: string, appId?: string): boolean {
    const localIdentity = [...this.connByIntegration.values()].some(
      (conn) => (!!conn.botUserId && senderId === conn.botUserId) || (!!conn.botId && senderId === conn.botId)
    )
    return localIdentity || (!!appId && this.cpCollab.isAgentBotApp('slack', channel, appId))
  }

  private isAgentBotMessage(msg: NormalizedMessage): boolean {
    if (msg.source !== 'user' || msg.platform !== 'slack') return false
    return this.isManagedSlackBotIdentity(msg.channel, msg.sender.id, msg.sender.appId)
  }

  private onInbound(msg: NormalizedMessage, srcIntegrationIds?: string[]): void {
    // Drain gate (§2.5/§5.3): once the daemon is draining (SIGTERM or a scope:daemon
    // drain) it accepts no new turns — in-flight turns finish, new arrivals are
    // dropped (the platform redelivers / the user retries against the new owner).
    if (this.draining) {
      this.log.debug(`routing: dropping inbound ${msg.msgId} (daemon draining)`)
      return
    }
    if (this.isAgentBotMessage(msg)) {
      this.log.debug(`routing: dropping AgentConnect bot message ${msg.msgId}`)
      return
    }
    msg.transportScope ??= this.transportScopeForIntegrationIds(srcIntegrationIds)
    // A mention in a watched Slack channel can arrive via both `message.*` and
    // `app_mention`; both share channel:ts, so dedup the double-fire from ONE bot
    // connection. Do not dedup across bot connections: several Slack apps receive
    // the same channel:ts, and Telegram DMs to different bots can share user chat ids
    // plus per-bot message numbers.
    const sourceKey =
      msg.transportScope ??
      (srcIntegrationIds === undefined ? '' : [...srcIntegrationIds].sort((a, b) => a.localeCompare(b)).join(','))
    const seenMsgId = `${sourceKey}|${msg.msgId}`
    if (this.seenMsgIds.has(seenMsgId)) {
      this.log.debug(`routing: duplicate ${msg.msgId} ignored`)
      return
    }
    this.seenMsgIds.add(seenMsgId)
    if (this.seenMsgIds.size > 2000) this.seenMsgIds.clear()

    // Telegram reply-based session threading: derive the session thread from the reply
    // chain BEFORE command parsing / routing, so both see the canonical thread (an
    // @mention opens a fresh session; a reply to any message already in a session
    // continues it). No-op on other platforms.
    this.canonicalizeTelegramThread(msg)

    // §14.3: gated-conversation discovery must precede command interception AND
    // routing. An Off DM whose first inbound is a command still needs its row; an
    // explicitly-mentioned Off channel likewise needs a pending row even though no
    // session will be created. Report-only: the notice remains conditional on the
    // message actually resolving to no admitted target.
    this.discoverGatedConversations(msg, srcIntegrationIds ?? [])
    const routingRules = this.mergedRulesForSource(srcIntegrationIds)

    // In-conversation control commands (`!stop` / `!queue …`) act on the running
    // agent and never reach it as a prompt — intercept before routing/dispatch.
    const command = parseCommand(msg.text)
    if (command) {
      // Resetting a durable safety latch is privileged control input. A malformed
      // platform wrapper or bot echo must never be able to forge !resume and reopen
      // the same loop it caused.
      if (command.kind === 'resume' && !isTrustedHumanTurn(msg)) {
        this.log.warn(`loop guard: ignored unauthenticated resume for ${loopGuardScope(msg)}`)
        return
      }
      // §14.3: a command that resolved no admitted target in an Off gated
      // conversation gets the same one-time notice as an unrouted message.
      if (!this.handleCommand(command, msg, undefined, srcIntegrationIds))
        this.maybeGatedNotice(msg, srcIntegrationIds ?? [])
      return
    }

    const result = routeRules(msg, routingRules, (c, t) => this.sessions.threadOwner(c, t, msg.transportScope))
    if (!result) {
      // §8.5: a message that activates no agent (a human @human reply, or one
      // addressed to another bot) must still enter the transcript when a session
      // is live in this thread, so that agent "catches up" on it when next
      // activated. Gated on an open session to bound growth in idle channels;
      // platform ingresses already skipped their own bot echoes. Same (thread, ts)
      // coords as SessionManager → INSERT OR IGNORE
      // dedups rather than double-recording.
      this.recordUnrouted(msg)
      // Conversation gating (§14): if this unrouted message explicitly addressed a
      // GATED integration's bot (mention or DM), answer once per conversation and
      // surface DM conversations to the console instead of appearing silently broken.
      this.maybeGatedNotice(msg, srcIntegrationIds ?? [])
      this.log.debug(
        `routing: dropped message in ch=${msg.channel} (no agent matched — not a mention of a known bot, not a subscribed 'all' channel, not a thread/DM hit)`
      )
      return
    }
    // Preserve the router's trusted self-mention match for prompt assembly. The raw
    // platform text contains only an opaque id (`<@U…>` on Slack); without this cause the
    // model cannot know that id is the bot identity bound to the selected agent.
    if (result.via === 'mention') msg.trigger = 'mention'
    // Agent-scoped drain (scope:agent): this agent is being reclaimed/rebalanced —
    // drop new turns for it while its in-flight turns finish.
    if (this.drainingAgents.has(result.agentId)) {
      this.log.debug(`routing: dropping ${msg.msgId} for agent "${result.agentId}" (draining)`)
      return
    }
    // `!stop` thread mute: while muted, implicit routing (thread affinity / keyword /
    // auto / dm) never dispatches — only an explicit @mention does, and it clears the
    // mute. Muted-thread traffic still enters the transcript (recordUnrouted) so the
    // agent catches up on it when re-activated (§8.5).
    const muteKey = sessionKey(msg.platform, msg.channel, msg.thread ?? msg.msgId, result.agentId, msg.transportScope)
    if (this.isSessionMuted(muteKey)) {
      if (result.via !== 'mention') {
        this.recordUnrouted(msg)
        this.log.debug(
          `routing: dropping ${msg.msgId} for agent "${result.agentId}" (muted by !stop; awaiting @mention)`
        )
        return
      }
      this.setSessionMuted(muteKey, false)
      this.log.info(`routing: agent "${result.agentId}" un-muted in ch=${msg.channel} (explicit @mention)`)
    }
    this.log.info(`routing: ch=${msg.channel} → agent "${result.agentId}" (integration ${result.integrationId})`)
    // A Discord top-level channel @mention: open a thread off it first, then dispatch
    // into that thread (Slack-parity). Async (a REST call), so it runs on its own path;
    // dispatch is fire-and-forget either way.
    if (msg.platform === 'discord' && msg.discordTopLevel) {
      void this.dispatchDiscordTopLevel(result.agentId, msg, result.integrationId).catch((err) =>
        this.log.error(`dispatch failed for agent "${result.agentId}": ${formatErr(err)}`)
      )
      return
    }
    void this.dispatch(result.agentId, msg, result.integrationId).catch((err) =>
      this.log.error(`dispatch failed for agent "${result.agentId}": ${formatErr(err)}`)
    )
  }

  /**
   * Discord top-level channel @mention (§Slack-parity threading): open a thread off the
   * triggering message so the whole turn — reply + progress/status chrome — lands in a
   * thread instead of flooding the channel. The new thread's id equals the message id, so
   * we re-key the turn onto the thread channel; every follow-up posted there arrives with
   * `channelId` = thread id and normalizes to the SAME session, giving the conversation
   * continuity. Best-effort: if thread creation fails (e.g. the bot lacks Create Public
   * Threads), we fall back to replying in the channel (the pre-thread behavior).
   */
  private async dispatchDiscordTopLevel(agentId: string, msg: NormalizedMessage, integrationId: string): Promise<void> {
    const conn = this.dcConnByIntegration.get(integrationId)
    const messageId = msg.msgId.split(':').pop() ?? ''
    const threadId = conn ? await conn.createThread(msg.channel, messageId, discordThreadName(msg.text)) : undefined
    if (threadId) {
      this.log.info(`discord: opened thread ${threadId} for ch=${msg.channel} msg=${messageId}`)
      // The session is about to key on the thread; record the channel it belongs to (and
      // its space) NOW, while `msg.channel` still names the parent — channel discovery
      // then reports this one channel instead of a row per thread we open under it.
      this.store.setChannelScope(threadId, { parentId: msg.channel }, this.clock.now())
      // Re-key the turn onto the thread channel (channel == thread == session; see
      // discord/normalize.ts). msgId keeps the original message id → its `ts`, which
      // equals the thread id, so the session treats this message as the thread root.
      msg.parentChannel = msg.channel
      msg.channel = threadId
      msg.thread = threadId
      // The session now keys on the thread id, not the parent channel the inbound
      // resolver already noted — label the thread too so the console shows its name.
      // `conn` is non-null here (threadId is only set when createThread ran on it).
      if (conn) this.channelNameResolver?.noteChannel(conn, threadId)
    } else {
      this.log.debug(`discord: no thread opened for ch=${msg.channel} — replying in channel`)
    }
    await this.dispatch(agentId, msg, integrationId)
  }

  /**
   * Dispatch one webchat turn onto the named agent and return the ack — transport-neutral:
   * the reply stream flows to `sink`. A webchat turn is a REAL session (recorded to the
   * transcript, visible in session/list); only its transport differs. The op names its
   * target agent explicitly (no trigger matching). Fed by the relay path (`rd/msg`).
   */
  private dispatchWebchatTurn(
    agentId: string,
    chatId: string,
    text: string,
    user: string,
    sink: WebchatSink,
    requestedTurnId?: string,
    inlineImages?: WebchatImageAttachment[],
    requestedRuntime?: WebchatRuntimeConfig,
    delegation?: WebchatMcpDelegationReference
  ): WebchatAck {
    const turnId = requestedTurnId ?? randomUUID()
    // Route directly to the named agent (bypasses arbitration); null when it isn't a
    // servable agent on this daemon.
    const result = routeRules(
      { platform: 'webchat', channel: chatId } as NormalizedMessage,
      this.mergedRules(),
      () => null,
      agentId
    )
    if (!result || !this.agents.has(result.agentId)) {
      this.log.warn(`webchat: no agent "${agentId}" on this daemon — rejecting turn`)
      return { accepted: false, turnId, reason: 'no_agent' }
    }
    // Pause gate (#288): reject up-front with a specific reason. dispatch() would also
    // skip it, but the webchat ack is returned synchronously (before the fire-and-forget
    // dispatch), so a silent accept would leave the client waiting on a turn that never runs.
    if (this.paused(result.agentId)) {
      this.log.info(`webchat: agent "${result.agentId}" is paused — rejecting turn`)
      return { accepted: false, turnId, reason: 'paused' }
    }
    if (this.safetyDrainingAgents.has(result.agentId)) {
      this.log.info(`webchat: agent "${result.agentId}" is stopping an interrupted turn — rejecting turn`)
      return { accepted: false, turnId, reason: 'busy' }
    }
    // Drain gate: same reasoning as pause. dispatch() drops a draining agent's turn and
    // resolves null, but the ack is already returned — a silent accept would leave the
    // browser spinning with no reply and no terminal frame. Reject synchronously instead.
    if (this.draining || this.drainingAgents.has(result.agentId)) {
      this.log.info(`webchat: agent "${result.agentId}" is draining — rejecting turn`)
      return { accepted: false, turnId, reason: 'draining' }
    }
    // platform:'webchat', channel:conversationId, no thread (the wire SessionKey omits
    // it — §5), source:'user'. The trigger is a direct address (dm-equivalent) — webchat
    // always targets one agent. msgId is stable per-conversation (NOT per-turn) so every
    // turn in a conversation maps to the ONE local session (statusThread falls back to
    // msgId), giving the conversation continuity a real session — recorded, resumable,
    // listable — like any other. Fresh turnIds still correlate each reply stream.
    const msg: NormalizedMessage = {
      msgId: `webchat:${chatId}`,
      traceId: turnId,
      source: 'user',
      platform: 'webchat',
      channel: chatId,
      sender: { id: user, isBot: false },
      text,
      mentionedBots: [],
      ...(inlineImages?.length
        ? {
            attachments: inlineImages.map((image, index) => {
              const inlineData = Buffer.from(image.data, 'base64')
              return {
                id: `webchat:${turnId}:${index}`,
                name: image.name,
                mimeType: image.mimeType,
                size: inlineData.byteLength,
                inlineData
              }
            })
          }
        : {}),
      isDm: true,
      trigger: 'dm'
    }
    // dispatch() claims/enqueues synchronously inside its Promise executor, so this
    // exact-key preflight cannot race another admission on this event-loop tick. Without
    // it a queue-full rejection happens before a QueueEntry exists, leaving an accepted
    // webchat turn with no terminal `done` frame.
    const key = this.webchatSessionKey(chatId, result.agentId)
    if (this.inflight.has(key) && (this.serialQueue.get(key)?.length ?? 0) >= MAX_QUEUED_PER_SESSION) {
      this.log.warn(`webchat: queue full for session ${key} — rejecting turn`)
      return { accepted: false, turnId, reason: 'busy' }
    }
    this.pruneWebchatStreams()
    if (this.webchatStreams.has(turnId)) {
      return { accepted: false, turnId, reason: 'busy' }
    }
    const initialRuntime =
      this.agents.get(result.agentId)?.allowRuntimeChangesInChat === true ? requestedRuntime : undefined
    const stream = this.createWebchatTurnStream(result.agentId, chatId, turnId, sink, initialRuntime, delegation)
    void this.dispatch(result.agentId, msg, undefined, stream).catch((err) => {
      if (!(err instanceof LifecycleCleanupBlockedError))
        this.log.error(`webchat dispatch failed for agent "${result.agentId}": ${formatErr(err)}`)
    })
    return { accepted: true, turnId }
  }

  /** Handle a webchat conversation close (relay `close` op). No live resources are
   *  bound per-conversation (the session TTL-closes like any other), so this is
   *  currently just observability — the in-flight turn, if any, runs to completion. */
  private handleWebchatClose(conversationId: string): void {
    this.log.debug(`webchat: conversation ${conversationId} closed by client`)
  }

  /** The local session key a webchat conversation maps to — mirrors `dispatchWebchatTurn`
   *  (channel = conversationId, statusThread = the stable `webchat:<id>` msgId, no thread). */
  private webchatSessionKey(conversationId: string, agentId: string): string {
    return sessionKey('webchat', conversationId, `webchat:${conversationId}`, agentId)
  }

  /** Wrap the turn's relay-bound transport with daemon-owned bounded replay. The
   * turn engine keeps calling the stable wrapper while resume swaps only the raw
   * transport underneath it. */
  private createWebchatTurnStream(
    agentId: string,
    conversationId: string,
    turnId: string,
    transport: WebchatSink,
    runtime?: WebchatRuntimeConfig,
    delegation?: WebchatMcpDelegationReference
  ): WebchatTurnStream {
    this.pruneWebchatStreams()
    const stream: WebchatTurnStream = {
      agentId,
      conversationId,
      turnId,
      transport,
      ...(runtime ? { runtime } : {}),
      ...(delegation ? { delegation } : {}),
      resumeGeneration: 0,
      sink: {
        output: (output) => this.publishWebchatStreamEvent(stream, { kind: 'output', output }),
        done: (done) => this.publishWebchatStreamEvent(stream, { kind: 'done', done })
      },
      replay: [],
      replayBytes: 0,
      replayFloor: 0,
      replayDisabled: false,
      lastOutputIndex: -1
    }
    this.webchatStreams.set(turnId, stream)
    this.pruneWebchatStreams()
    return stream
  }

  /** Buffer before sending so a transport gap is recoverable even when the live
   * write is lost. The terminal frame carries the final output index for browser
   * gap detection. */
  private publishWebchatStreamEvent(stream: WebchatTurnStream, event: RdChatEvent): void {
    const normalized: RdChatEvent =
      event.kind === 'output' ? event : { kind: 'done', done: { ...event.done, lastIndex: stream.lastOutputIndex } }
    if (normalized.kind === 'output') {
      stream.lastOutputIndex = Math.max(stream.lastOutputIndex, normalized.output.index)
    }
    if (!stream.replayDisabled) this.bufferWebchatStreamEvent(stream, normalized)
    this.deliverWebchatStreamEvent(stream.transport, normalized)
    if (normalized.kind === 'done') {
      stream.completedAt = this.clock.now()
      this.pruneWebchatStreams()
    }
  }

  private bufferWebchatStreamEvent(stream: WebchatTurnStream, event: RdChatEvent): void {
    const bytes = Buffer.byteLength(JSON.stringify(event))
    stream.replay.push({ event, bytes })
    stream.replayBytes += bytes
    while (stream.replay.length > WEBCHAT_REPLAY_MAX_EVENTS || stream.replayBytes > WEBCHAT_REPLAY_MAX_BYTES) {
      const dropped = stream.replay.shift()
      if (!dropped) break
      stream.replayBytes -= dropped.bytes
      if (dropped.event.kind === 'output') {
        stream.replayFloor = Math.max(stream.replayFloor, dropped.event.output.index + 1)
      } else {
        // A terminal frame is tiny and should never be the overflow victim. Fail
        // closed if a future payload shape violates that assumption.
        stream.replayDisabled = true
        stream.replay = []
        stream.replayBytes = 0
        break
      }
    }
  }

  private deliverWebchatStreamEvent(sink: WebchatSink, event: RdChatEvent): void {
    if (event.kind === 'output') sink.output(event.output)
    else sink.done(event.done)
  }

  private resumeWebchatStream(
    agentId: string,
    conversationId: string,
    turnId: string,
    generation: number,
    afterIndex: number,
    transport: WebchatSink
  ): { accepted: boolean; turnId?: string; reason?: string } {
    this.pruneWebchatStreams()
    const stream = this.webchatStreams.get(turnId)
    if (!stream || stream.agentId !== agentId || stream.conversationId !== conversationId) {
      return { accepted: false, reason: 'stream_not_found' }
    }
    if (generation <= stream.resumeGeneration) {
      return { accepted: false, turnId: stream.turnId, reason: 'stream_stale' }
    }
    // Claim the newer connection generation before validating its cursor. Even a
    // failed newer resume must fence an older request that is still in flight.
    stream.resumeGeneration = generation
    if (stream.replayDisabled || afterIndex < stream.replayFloor - 1) {
      return { accepted: false, turnId: stream.turnId, reason: 'stream_gap' }
    }
    if (afterIndex > stream.lastOutputIndex) {
      return { accepted: false, turnId: stream.turnId, reason: 'stream_cursor_invalid' }
    }

    // Rebind first: outputs produced after this synchronous replay leave through
    // the same new relay connection. Replay bypasses the stable buffering wrapper
    // so retained frames are not inserted twice.
    stream.transport = transport
    for (const buffered of stream.replay) {
      if (buffered.event.kind === 'output' && buffered.event.output.index <= afterIndex) continue
      this.deliverWebchatStreamEvent(transport, buffered.event)
    }
    return { accepted: true, turnId: stream.turnId }
  }

  private removeWebchatStream(turnId: string, stream: WebchatTurnStream): void {
    this.webchatStreams.delete(turnId)
    stream.replayDisabled = true
    stream.replay = []
    stream.replayBytes = 0
  }

  private pruneWebchatStreams(): void {
    const now = this.clock.now()
    for (const [turnId, stream] of this.webchatStreams) {
      if (stream.completedAt !== undefined && now - stream.completedAt > WEBCHAT_REPLAY_TTL_MS) {
        this.removeWebchatStream(turnId, stream)
      }
    }
    while (this.webchatStreams.size > WEBCHAT_REPLAY_MAX_STREAMS) {
      const completed =
        [...this.webchatStreams].find(([, stream]) => stream.completedAt !== undefined) ??
        this.webchatStreams.entries().next().value
      if (!completed) break
      this.removeWebchatStream(completed[0], completed[1])
    }
  }

  /**
   * Record who drove one chat-side session action. The platform interaction is the only
   * place the acting user exists — the session key alone says what changed, never by whom —
   * so it is logged at every funnel point. `unknown` when an ingress could not report an
   * actor (today: relay-forwarded Slack actions, whose frame carries no user).
   */
  private logSessionAction(verb: string, sessionKey: string, actor?: InteractionActor): void {
    const who = actor ? `${actor.userId}${actor.isBot ? ' (bot)' : ''}` : 'unknown'
    this.log.info(`session ${sessionKey}: "${verb}" by ${who}`)
  }

  /** Resolve a session only while its Agent explicitly permits chat-side runtime changes. */
  private chatRuntimeSession(key: string) {
    const rec = this.store.getSession(key)
    return rec && this.agents.get(rec.agentId)?.allowRuntimeChangesInChat === true ? rec : undefined
  }

  /** Switch a session's model by its local key — the core shared by the webchat
   *  `set-model` frame and the Slack status-bar select. Records the sticky per-session
   *  override (re-applied on every turn by dispatch) and, if the ACP session is warm,
   *  applies it live now and re-pushes the status bar. Never changes the agent default. */
  private setModelByKey(key: string, model: string): boolean {
    const rec = this.chatRuntimeSession(key)
    if (!rec) return false
    this.store.setModelOverride(key, model)
    this.log.info(`session ${key} model override → "${model}"`)
    const acpSessionId = rec.acpSessionId
    const host = this.hosts.get(rec.agentId)
    if (!acpSessionId || !host?.hasSession(acpSessionId)) return true // no live session — applies next turn
    void host
      .setSessionModel(acpSessionId, model)
      .then((applied) => {
        const p = this.pending.get(pendingTurnKey(rec.agentId, acpSessionId))
        if (applied && p) this.emitStatusBar(p) // reflect the new model on the status bar
      })
      .catch((err) => this.log.warn(`set-model failed: ${(err as Error).message}`))
    return true
  }

  /** Cancel the in-flight turn for a local session key — the `!cancel` core (interrupt,
   *  NO mute) shared by the Slack status-bar Cancel button. No-op if nothing is running. */
  private cancelSessionByKey(key: string): boolean {
    const rec = this.store.getSession(key)
    // Cancel a gate-owned/queued session even if it has no live ACP turn yet (§6.9 #390):
    // interruptTurn drains the queue by key and cancels the ACP turn only if one exists.
    if (!this.inflight.has(key)) return false
    const agentId = rec?.agentId ?? this.serialQueue.get(key)?.[0]?.agentId
    if (!agentId) return false
    this.interruptTurn(agentId, key, 'cancel', rec?.acpSessionId ?? undefined)
    return true // reports whether a turn was actually interrupted (nothing else reads it)
  }

  /** Switch a session's reasoning effort by its local key — the effort counterpart of
   *  {@link setModelByKey}. Records the sticky override and, if the ACP session is warm,
   *  applies it live via the `thought_level` select. `ultracode` can't ride the select
   *  (setSessionEffort returns false); it's honored via session `_meta` when the session
   *  is next (re)created or resumed, and the override still shows on the bar meanwhile. */
  private setEffortByKey(key: string, effort: string): boolean {
    const rec = this.chatRuntimeSession(key)
    if (!rec) return false
    this.store.setEffortOverride(key, effort)
    this.log.info(`session ${key} effort override → "${effort}"`)
    const acpSessionId = rec.acpSessionId
    const host = this.hosts.get(rec.agentId)
    if (!acpSessionId || !host?.hasSession(acpSessionId)) {
      this.refreshStatusBarForKey(key)
      return true
    }
    void host
      .setSessionEffort(acpSessionId, effort)
      .then(() => this.refreshStatusBarForKey(key))
      .catch((err) => this.log.warn(`set-effort failed: ${(err as Error).message}`))
    return true
  }

  /** Every chat-side runtime change funnels through the same Agent-level guard before
   * a sticky override can be written, including stale callbacks and relay frames. */
  private setPermissionModeByKey(key: string, permissionMode: string): boolean {
    const rec = this.chatRuntimeSession(key)
    if (!rec) return false
    this.store.setPermissionModeOverride(key, permissionMode)
    this.log.info(`session ${key} permission-mode override → "${permissionMode}"`)
    const acpSessionId = rec.acpSessionId
    const host = this.hosts.get(rec.agentId)
    if (!acpSessionId || !host?.hasSession(acpSessionId)) {
      this.refreshStatusBarForKey(key)
      return true
    }
    void host
      .setSessionPermissionMode(acpSessionId, permissionMode)
      .then(() => this.refreshStatusBarForKey(key))
      .catch((err) => this.log.warn(`set-permission-mode failed: ${(err as Error).message}`))
    return true
  }

  /** Apply the Agent's configured runtime policy to one live session. Callers that
   *  fence a pending prompt await this; reconciliation fans it out in the background. */
  private async applyConfiguredRuntimeSettings(agent: LoadedAgent, host: AcpHost, sessionId: string): Promise<void> {
    const catalog = this.runtimeCatalogs.get(agent.runtime)
    // A fresh ACP session may advertise its baseline as the literal `default`.
    // Catalog metadata intentionally keeps defaultModel concrete, so fall back to
    // that selectable entry when the Agent leaves its model unpinned.
    const model =
      agent.runtimeOverrides?.model ??
      catalog?.defaultModel ??
      catalog?.models.find((candidate) => candidate.id === 'default')?.id
    const effort =
      agent.reasoningEffort ??
      (model ? catalog?.models.find((candidate) => candidate.id === model)?.defaultEffort : undefined)
    const permissionMode = agent.permissionMode ?? catalog?.defaultPermissionMode
    // The console treats an unset fast-mode default as off. Explicitly restore
    // that value so disabling chat authority also revokes a live `fast on`.
    const fastMode = agent.fastMode ?? false
    if (model) await host.setSessionModel(sessionId, model)
    if (effort) await host.setSessionEffort(sessionId, effort)
    if (permissionMode && typeof host.setSessionPermissionMode === 'function') {
      await host.setSessionPermissionMode(sessionId, permissionMode)
    }
    await host.setSessionFastMode(sessionId, fastMode)
  }

  /** Removing chat authority also removes its effect from every live session. This
   *  closes the window where a previously selected full-access mode could otherwise
   *  survive until the next message restores the Agent-level policy. */
  private restoreConfiguredRuntimeSettings(agent: LoadedAgent): void {
    const host = this.hosts.get(agent.id)
    if (!host) return
    for (const session of this.store.listSessions(agent.id)) {
      if (!session.acpSessionId || host.hasSession?.(session.acpSessionId) !== true) continue
      const sessionId = session.acpSessionId
      void this.applyConfiguredRuntimeSettings(agent, host, sessionId)
        .then(() => {
          this.refreshStatusBarForKey(session.key)
        })
        .catch((err) =>
          this.log.warn(`restore configured runtime settings failed for "${session.key}": ${formatErr(err)}`)
        )
    }
  }

  /** Toggle a session's fast mode by its local key — the fast-mode counterpart of
   *  {@link setModelByKey}. Records the sticky override and applies it live when the
   *  current model offers a fast toggle. */
  private setFastByKey(key: string, fastMode: boolean): boolean {
    const rec = this.chatRuntimeSession(key)
    if (!rec) return false
    this.store.setFastModeOverride(key, fastMode)
    this.log.info(`session ${key} fast-mode override → ${fastMode}`)
    const acpSessionId = rec.acpSessionId
    const host = this.hosts.get(rec.agentId)
    if (!acpSessionId || !host?.hasSession(acpSessionId)) {
      this.refreshStatusBarForKey(key)
      return true
    }
    void host
      .setSessionFastMode(acpSessionId, fastMode)
      .then(() => this.refreshStatusBarForKey(key))
      .catch((err) => this.log.warn(`set-fast failed: ${(err as Error).message}`))
    return true
  }

  /** Re-emit the status bar for a session's in-flight turn (if any) so a config change
   *  (model / effort / fast) is reflected. No-op when the session is idle. */
  private refreshStatusBarForKey(key: string): void {
    const rec = this.store.getSession(key)
    const p = rec?.acpSessionId ? this.pending.get(pendingTurnKey(rec.agentId, rec.acpSessionId)) : undefined
    if (p) this.emitStatusBar(p)
  }

  /** Set a session's Slack output verbosity by its local key. Purely daemon-side (no ACP):
   *  the next turn's OutputConverger reads this override, so an in-flight turn keeps its
   *  current verbosity and the change takes effect from the next turn. */
  private setOutputModeByKey(key: string, mode: 'none' | 'minimal' | 'low' | 'medium' | 'high'): boolean {
    if (!this.store.getSession(key)) return false
    this.store.setOutputModeOverride(key, mode)
    this.log.info(`session ${key} output-mode override → "${mode}"`)
    this.refreshStatusBarForKey(key)
    return true // reports whether the override was recorded (nothing else reads it)
  }

  /** Handle a webchat cancel (the relay `cancel` op / status-bar "Cancel"). Interrupts
   *  the conversation's in-flight turn like `!cancel` (no mute; follow-ups still dispatch).
   *  Resolved by conversationId (the op carries no agentId). No-op when idle. */
  private handleWebchatCancel(conversationId: string): void {
    for (const p of this.pending.values()) {
      if (p.webchat?.conversationId === conversationId) {
        this.interruptTurn(p.agentId, p.sessionKey, 'cancel', p.acpSessionId)
        return
      }
    }
    // Cold accepted head: it owns the logical gate but has not reached Pending yet.
    for (const [key, entry] of this.activeGateEntries) {
      if (entry.webchat?.conversationId === conversationId) {
        this.interruptTurn(entry.agentId, key, 'cancel')
        return
      }
    }
    // No live turn — the conversation may still have messages queued behind the gate
    // (§6.9 #390): drain+reject them by their sessionKey so the client's turns settle.
    for (const [key, entries] of this.serialQueue) {
      const hit = entries.find((e) => e.webchat?.conversationId === conversationId)
      if (hit) {
        this.interruptTurn(hit.agentId, key, 'cancel')
        return
      }
    }
    this.log.debug(`webchat cancel: no in-flight turn for conversation ${conversationId}`)
  }

  // Bounded, ephemeral reconnect state keyed by the browser-known turn id.
  private readonly webchatStreams = new Map<string, WebchatTurnStream>()
  // Idempotency cache for the at-least-once rd/* wire. IM deliveries additionally
  // include the authenticated bot assignment: two Slack apps mentioned in one
  // platform message share sessionKey + msgId but must wake independently. Bounded
  // like `seenMsgIds`; a genuine relay retransmit replays the cached ack.
  private readonly relayMsgAcks = new Map<string, RdAck>()
  /** Hook admission crosses an async anchor + durable-inbox barrier. Coalesce a
   * retransmit that arrives before that barrier settles instead of dispatching
   * the same delivery twice. */
  private readonly pendingRelayMsgAcks = new Map<string, Promise<RdAck>>()

  // Admission-idempotency for same-daemon agent→agent (`messageAgent`) delivery, keyed by
  // the stable `deliveryId` (design §6.3) — NOT msgId. A retry (P2) reuses the deliveryId,
  // so a second delivery of the same id returns the cached result WITHOUT a second dispatch
  // (no double-wake). Bounded like `relayMsgAcks`. Local path only; cross-daemon dedup is P2.
  private readonly agentCallDeliveries = new Map<string, MessageAgentResult>()

  // Parent→child links recorded at wake ADMISSION, keyed by the child's logical sessionKey
  // (== the `childSessionId` handed back by `sendMessage`), valued by the waking session's stable
  // acpSessionId. Authorizes `viewSessionStatus` during the window where the child has been
  // admitted but its session row does not exist yet — dispatch is fire-and-forget, so the parent
  // can legitimately poll before the child's first turn reaches SessionManager. Once that row
  // exists its durable `originSessionId` is the authority, so this is a startup shim, not the
  // record: it is in-memory (a restart kills the in-flight wake it covers anyway) and bounded.
  //
  // `rowUpdatedAtAtAdmission` additionally fences a RE-wake of an already-finished child: the row
  // still reads `idle` + the PREVIOUS turn's `lastTurnOutcome` until SessionManager flips it to
  // `prompting`, so a parent polling right after re-delegating would otherwise be handed the old
  // `done`. Comparing the row's own `updatedAt` against its value at admission is clock-source
  // independent (the store stamps `Date.now()`, the daemon reads `this.clock`), so an unchanged
  // value means "has not acted on our wake yet" without comparing two clocks.
  //
  // `remote:true` marks a child admitted on ANOTHER daemon. Its row will never appear in this
  // store, so the link is the only record that the wake happened and who may follow it; the status
  // read for those is routed through the CP (§5.4) instead of the local store.
  private readonly childSessionLinks = new Map<
    string,
    { parentSessionId: string; agentId: string; rowUpdatedAtAtAdmission: number | null; remote?: boolean }
  >()

  // §3.4/§6.8 orchestration deadline timers, keyed by orchestrationId. Held HERE
  // (daemon-owned), NOT in the Scheduler's per-agent map — Scheduler.sync is replace-all
  // and would wipe a per-orchestration one-shot on the next agent reconcile. The durable
  // SoT is the `orchestration.deadline` epoch; this map is just the live in-process timer,
  // re-armed from the store on startup. cancelOrchestration clears the timer idempotently.
  private readonly orchestrationDeadlines = new Map<string, TimerHandle>()

  /**
   * Dispatch one inbound relay item (`rd/msg` — webchat, shared IM/action, or hook) and
   * return the `rd/ack` verdict — the relay-path entry, reusing the SAME turn
   * engine + by-key cores as the (retiring) CP path. The `chat` callback streams
   * a webchat reply back as `rd/chat` over the relay socket the op arrived on
   * (no-op outside webchat; hook outcomes go to the CP as `hook/report`).
   *
   * Deduped by the relay-minted (sessionKey, msgId): the wire is at-least-once, so a
   * retransmitted rd/msg (identical msgId) must NOT run the user's turn a second time —
   * replay the original ack (so the relay settles) without re-dispatching. For hooks
   * the same replay absorbs a GitHub/manual REDELIVERY of the same deliveryKey.
   */
  private handleRelayMsg(msg: RdMsg, chat: (event: RdChatEvent) => void): RdAck | Promise<RdAck> {
    const dedupKey = `${msg.source === 'im' ? `${msg.botId}:` : ''}${msg.sessionKey}:${msg.msgId}`
    const prior = this.relayMsgAcks.get(dedupKey)
    if (prior) {
      this.log.debug(`relay: duplicate rd/msg ${dedupKey} — replaying ack (no re-dispatch)`)
      return prior
    }
    const pending = this.pendingRelayMsgAcks.get(dedupKey)
    if (pending) return pending

    if (msg.source === 'hook') {
      const task = this.dispatchRelayHook(msg)
        .catch((err): RdAck => {
          this.log.error(`hook admission failed for ${dedupKey}: ${formatErr(err)}`)
          return { msgId: msg.msgId, accepted: false, reason: 'durability' }
        })
        .then((ack) => {
          this.pendingRelayMsgAcks.delete(dedupKey)
          if (this.relayMsgAcks.size >= 2000) this.relayMsgAcks.clear()
          this.relayMsgAcks.set(dedupKey, ack)
          return ack
        })
      this.pendingRelayMsgAcks.set(dedupKey, task)
      return task
    }

    const ack =
      msg.source === 'webchat'
        ? this.dispatchRelayOp(msg, chat)
        : msg.source === 'slack_action'
          ? this.handleRelaySlackAction(msg)
          : msg.source === 'feishu_action'
            ? this.handleRelayFeishuAction(msg)
            : this.handleRelayIm(msg)
    if (this.relayMsgAcks.size >= 2000) this.relayMsgAcks.clear() // bound the window
    this.relayMsgAcks.set(dedupKey, ack)
    return ack
  }

  /**
   * An HTTP-bot inbound (`rd/msg` `im`): the relay already arbitrated the target
   * agent + integration, so this is the explicit-agent path — no local routing. The
   * reply flows out-of-band through the agent's send-only provider connection
   * (`replyConnFor`), NOT `rd/chat` (that is webchat-only). The `rd/ack` is a plain
   * receipt; the turn runs async.
   */
  private handleRelayIm(msg: RdMsgIm): RdAck {
    if (!this.agents.get(msg.agentId)) {
      this.log.warn(`relay: rd/msg(im) for unknown agent ${msg.agentId} — dropping`)
      return { msgId: msg.msgId, accepted: false, reason: 'no_agent' }
    }
    const normalized = fromPlatformMessage(msg.payload, this.transportScopeForIntegrationIds([msg.integrationId]))
    // Direct ingress resolves provider ids before onInbound(); HTTP ingress
    // bypasses that callback, but its send-only connection exposes the same API.
    // Mirror the lookup here so session metadata/history can label the sender.
    const conn = this.connByIntegration.get(msg.integrationId)
    if (conn) this.nameResolver?.noteMessage(conn, normalized)
    const feishuConn = this.fsConnByIntegration.get(msg.integrationId)
    if (feishuConn) this.channelNameResolver?.noteMessage(feishuConn, normalized)
    // HTTP-bot ingress is pre-addressed and bypasses onInbound(), so repeat the
    // terminal agent-bot suppression here before commands or model admission.
    if (this.isAgentBotMessage(normalized)) {
      this.log.debug(`relay: consumed AgentConnect bot message ${msg.msgId} without waking ${msg.agentId}`)
      return { msgId: msg.msgId, accepted: true }
    }
    // Relay arbitration normally forwards only enabled routes. A receive-only
    // Feishu relay may also hand the sole gated install an explicitly-addressed
    // Off-conversation event so provider egress remains daemon-owned. Discover it
    // before the last-hop gate drops it; the notice below then uses the send-only
    // Feishu connection without ever exposing the app secret to the relay.
    this.discoverGatedConversations(normalized, [msg.integrationId])
    // Conversation gating (§14) last-hop backstop: the relay arbitrates HTTP-bot
    // routing, but a stale relay route snapshot must not activate a private agent in
    // an Off conversation. Admission = a bindRule scoped to this conversation (the
    // CP ships a gated install's enabled set even in relay-managed mode).
    if (!this.gatedAdmission(msg.integrationId, normalized)) {
      this.maybeGatedNotice(normalized, [msg.integrationId])
      this.log.debug(`relay: dropped ${msg.msgId} for gated integration ${msg.integrationId} (conversation off)`)
      return { msgId: msg.msgId, accepted: true }
    }
    // HTTP-bot IM bypasses onInbound() because the relay already arbitrated the
    // target. It must still intercept control commands before dispatch — especially
    // `!resume`, otherwise an open loop circuit drops the only recovery message.
    const command = parseCommand(normalized.text)
    if (command) {
      if (command.kind === 'resume' && !isTrustedHumanTurn(normalized)) {
        this.log.warn(`loop guard: ignored unauthenticated relay resume for ${loopGuardScope(normalized)}`)
        return { msgId: msg.msgId, accepted: false, reason: 'unauthorized' }
      }
      const target = this.resolveExplicitCommandTarget(msg.agentId, msg.integrationId, normalized)
      if (!target) {
        this.log.warn(`relay: unauthorized command from ${normalized.sender.id} for agent ${msg.agentId}`)
        return { msgId: msg.msgId, accepted: false, reason: 'unauthorized' }
      }
      this.handleCommand(command, normalized, target)
      return { msgId: msg.msgId, accepted: true }
    }
    // HTTP-bot ingress bypasses onInbound(), so repeat its `!stop` thread-mute gate:
    // while muted, implicit routing (thread affinity / keyword / auto / dm) never
    // dispatches — only an explicit @mention does, and it clears the mute. Muted traffic
    // still enters the transcript so the agent catches up when re-activated (§8.5).
    const muteKey = sessionKey(
      normalized.platform,
      normalized.channel,
      normalized.thread ?? normalized.msgId,
      msg.agentId,
      normalized.transportScope
    )
    if (this.isSessionMuted(muteKey)) {
      if (normalized.trigger !== 'mention') {
        this.recordUnrouted(normalized)
        this.log.debug(`relay: dropping ${msg.msgId} for agent "${msg.agentId}" (muted by !stop; awaiting @mention)`)
        return { msgId: msg.msgId, accepted: true }
      }
      this.setSessionMuted(muteKey, false)
      this.log.info(`relay: agent "${msg.agentId}" un-muted in ch=${normalized.channel} (explicit @mention)`)
    }
    void this.dispatch(msg.agentId, normalized, msg.integrationId).catch((err) =>
      this.log.error(`relay im dispatch failed for agent "${msg.agentId}": ${formatErr(err)}`)
    )
    return { msgId: msg.msgId, accepted: true }
  }

  /** Apply one HTTP-bot interaction after relay routing. Re-check every daemon-owned
   *  boundary before opening or mutating anything: the agent, HTTP Slack integration,
   *  local connection, session owner, and (when retained) exact delivery binding must all
   *  still agree. Message shortcuts resolve their channel/thread coordinates here. */
  private handleRelaySlackAction(msg: RdMsgSlackAction): RdAck {
    const agent = this.agents.get(msg.agentId)
    if (!agent) {
      this.log.warn(`relay: Slack action for unknown agent ${msg.agentId} — dropping`)
      return { msgId: msg.msgId, accepted: false, reason: 'no_agent' }
    }
    const integration = agent.integrations.find(
      (candidate) =>
        candidate.id === msg.integrationId && candidate.platform === 'slack' && candidate.slack.mode === 'shared'
    )
    if (!integration) {
      this.log.warn(
        `relay: Slack action for non-shared integration ${msg.integrationId} on agent ${msg.agentId} — dropping`
      )
      return { msgId: msg.msgId, accepted: false, reason: 'not_found' }
    }
    const conn = this.connByIntegration.get(msg.integrationId)
    if (!conn) {
      this.log.warn(`relay: Slack action for unavailable integration ${msg.integrationId} — dropping`)
      return { msgId: msg.msgId, accepted: false, reason: 'unavailable' }
    }
    const payload = msg.payload
    if (payload.kind === 'open-config-for-thread') {
      const routing = integrationRouting(integration)
      const unauthorized =
        (routing.allowedUserIds.length > 0 && (!msg.userId || !routing.allowedUserIds.includes(msg.userId))) ||
        !conversationAdmitted(routing, payload.channelId)
      const transportScope = this.transportScopeForIntegrationIds([integration.id])
      const rec = unauthorized
        ? undefined
        : this.store.latestSessionForTransport(msg.agentId, payload.channelId, transportScope, payload.threadTs)
      const binding = rec ? this.sessionDeliveryBindings.get(rec.key) : undefined
      const validBinding =
        !binding ||
        (binding.agentId === msg.agentId && binding.platform === 'slack' && binding.integrationId === msg.integrationId)
      if (!rec || rec.platform !== 'slack' || !validBinding) {
        void conn.openStatusModal(payload.triggerId)
        return { msgId: msg.msgId, accepted: true }
      }
      const privateMetadata = encodeSharedSlackStatusTarget({
        agentId: msg.agentId,
        integrationId: msg.integrationId,
        sessionKey: rec.key
      })
      void conn.openStatusModal(payload.triggerId, rec.key, privateMetadata)
      return { msgId: msg.msgId, accepted: true }
    }

    const rec = this.store.getSession(msg.sessionKey)
    if (!rec || rec.agentId !== msg.agentId || rec.platform !== 'slack') {
      this.log.warn(`relay: Slack action for stale or foreign session ${msg.sessionKey} — dropping`)
      return { msgId: msg.msgId, accepted: false, reason: 'not_found' }
    }
    const binding = this.sessionDeliveryBindings.get(msg.sessionKey)
    if (
      binding &&
      (binding.agentId !== msg.agentId || binding.platform !== 'slack' || binding.integrationId !== msg.integrationId)
    ) {
      this.log.warn(`relay: Slack action delivery binding mismatch for session ${msg.sessionKey} — dropping`)
      return { msgId: msg.msgId, accepted: false, reason: 'stale' }
    }

    // The relay forwards the tapping user when it knows one; an older relay omits it
    // and the action records as an unknown actor rather than a guessed one.
    const actor = msg.userId ? { userId: msg.userId } : undefined
    if (payload.kind === 'open-config') {
      const privateMetadata = encodeSharedSlackStatusTarget({
        agentId: msg.agentId,
        integrationId: msg.integrationId,
        sessionKey: msg.sessionKey
      })
      // Start views.open immediately while Slack's short-lived trigger_id is valid. The
      // connection catches/logs Web API failures; rd/ack is only the relay receipt.
      void conn.openStatusModal(payload.triggerId, msg.sessionKey, privateMetadata)
    } else if (payload.kind === 'set-model') {
      this.handleStatusAction({ kind: payload.kind, sessionKey: msg.sessionKey, model: payload.model, actor })
    } else if (payload.kind === 'set-effort') {
      this.handleStatusAction({ kind: payload.kind, sessionKey: msg.sessionKey, effort: payload.effort, actor })
    } else if (payload.kind === 'set-permission-mode') {
      this.handleStatusAction({
        kind: payload.kind,
        sessionKey: msg.sessionKey,
        permissionMode: payload.permissionMode,
        actor
      })
    } else if (payload.kind === 'set-fast') {
      this.handleStatusAction({ kind: payload.kind, sessionKey: msg.sessionKey, fastMode: payload.fastMode, actor })
    } else if (payload.kind === 'set-output') {
      this.handleStatusAction({ kind: payload.kind, sessionKey: msg.sessionKey, outputMode: payload.outputMode, actor })
    } else if (payload.kind === 'permission-choice') {
      this.handlePermissionChoice({ ...payload, actor })
    } else if (payload.kind === 'elicitation-choice') {
      this.handleElicitChoice({ requestId: payload.requestId, value: payload.value })
    } else {
      this.handleStatusAction({ kind: 'cancel', sessionKey: msg.sessionKey, actor })
    }
    return { msgId: msg.msgId, accepted: true }
  }

  /** Apply a provider-authenticated HTTP Lark / Feishu card action to the same
   * send-only connection that rendered the card. The connection resolves the
   * message id against daemon-local active-card state, so a stale or forged action
   * cannot name an arbitrary session. */
  private handleRelayFeishuAction(msg: RdMsgFeishuAction): RdAck {
    const agent = this.agents.get(msg.agentId)
    if (!agent) {
      this.log.warn(`relay: Feishu action for unknown agent ${msg.agentId} — dropping`)
      return { msgId: msg.msgId, accepted: false, reason: 'no_agent' }
    }
    const integration = agent.integrations.find(
      (candidate) =>
        candidate.id === msg.integrationId && candidate.platform === 'feishu' && candidate.feishu.mode === 'shared'
    )
    if (!integration) {
      this.log.warn(
        `relay: Feishu action for non-shared integration ${msg.integrationId} on agent ${msg.agentId} — dropping`
      )
      return { msgId: msg.msgId, accepted: false, reason: 'not_found' }
    }
    const conn = this.fsConnByIntegration.get(msg.integrationId)
    if (!conn) {
      this.log.warn(`relay: Feishu action for unavailable integration ${msg.integrationId} — dropping`)
      return { msgId: msg.msgId, accepted: false, reason: 'unavailable' }
    }
    const response = conn.handleCardAction(msg.payload)
    return {
      msgId: msg.msgId,
      accepted: true,
      ...(response ? { feishuCardAction: response } : {})
    }
  }

  // Per-hop dedup (§6.4) for FORWARDED cross-daemon agent-calls, keyed by the stable
  // deliveryId — a relay retransmit of the same deliveryId replays the prior verdict
  // WITHOUT a second dispatch (no double-wake). Bounded like `agentCallDeliveries`.
  private readonly relayAgentMsgAcks = new Map<string, RdAgentMsgAck>()

  /**
   * TARGET side of a cross-daemon `messageAgent` (agent-collaboration §2.3/§6.2, P2) —
   * the mirror of {@link handleRelayIm} for a relay-forwarded `rd/agentmsg/fwd`. The
   * relay already validated the caller and minted a TRUSTED claim
   * (`trustedFromAgentId` + org/channel assertion), but we TERMINAL-VERIFY it against
   * our OWN local snapshot/spec (defense in depth, §2.5 #4) before dispatching — never
   * blindly trusting the relay. The ACK is returned on durable ADMISSION (the P4-gate
   * enqueue), NOT after the model turn (§6.4).
   */
  private async handleRelayAgentMsg(msg: RdAgentMsgFwd): Promise<RdAgentMsgAck> {
    const nak = (reason: RdAgentMsgAck['reason']): RdAgentMsgAck => ({
      deliveryId: msg.deliveryId,
      delivered: false,
      ...(reason ? { reason } : {})
    })

    // Per-hop dedup (§6.4): a retransmitted deliveryId replays the prior verdict.
    // Namespace by the globally-unique caller agentId: `deliveryId` is only unique
    // within one SOURCE daemon process (`String(Date.now())`), so a bare key would let
    // an unrelated call from a different source daemon collide. `trustedFromAgentId` is
    // a global agent UUID, so (trustedFromAgentId, deliveryId) is collision-free across
    // daemons yet still dedups a genuine retransmit from the same caller.
    const dedupKey = `${msg.trustedFromAgentId}:${msg.deliveryId}`
    const prior = this.relayAgentMsgAcks.get(dedupKey)
    if (prior) return prior

    const record = (ack: RdAgentMsgAck): RdAgentMsgAck => {
      if (this.relayAgentMsgAcks.size >= 2000) this.relayAgentMsgAcks.clear()
      this.relayAgentMsgAcks.set(dedupKey, ack)
      return ack
    }

    // Hop cap (§2.4): the relay already incremented; reject over the cap.
    if (msg.hopCount > MAX_AGENT_CALL_HOPS) return record(nak('hop_limit'))

    const { platform, channel, thread } = msg.coords

    // The target must actually be a local agent (the relay resolved it to us, but we
    // don't trust that blindly — this is the placement authority for OUR agents).
    if (!this.agents.get(msg.toAgentId)) return record(nak('not_found'))

    // TERMINAL-VERIFY against the local collaboration snapshot (§2.5 #4), now ORG-scoped
    // rather than (org, channel)-scoped: the relay's asserted org must be the org this
    // daemon's directory records for the target, and the directional call policy must admit
    // caller→target. Channel is only the session coordinate here (A2A is postless, #854), so
    // a caller and target that share no channel — or a target with no IM integration at all —
    // is legitimate. Missing snapshot / unknown agent ⇒ fail closed, as before.
    if (this.cpCollab.orgForAgent(msg.toAgentId) !== msg.orgId) {
      this.log.warn(`relay: rd/agentmsg/fwd terminal-verify failed (no placement) for ${msg.toAgentId} — fail closed`)
      return record(nak('not_allowed'))
    }
    if (!this.cpCollab.admits(msg.trustedFromAgentId, msg.toAgentId)) {
      this.log.info(
        `relay: rd/agentmsg/fwd not_allowed — call policy excludes ${msg.trustedFromAgentId} → ${msg.toAgentId}`
      )
      return record(nak('not_allowed'))
    }
    // COORDINATE INTEGRITY (§2.5 #4), the second half of terminal-verify and the reason
    // dropping channel from the POLICY predicate is not the same as dropping it entirely:
    // `coords` is still the woken peer's SESSION key (see sessionChannel below), so a caller
    // that could assert any channel could compute its way INTO an existing session of the
    // target in a channel the caller has no access to — resuming that conversation and, with
    // `needsReply`, reporting its content back. `coordsDecision` is the single mirrored
    // decision the relay's ingress applies too (see CpCollabRoutes.coordsDecision for the
    // three branches and why the LOOKUP is platform-free while the branch is not).
    const coordsVerdict = this.cpCollab.coordsDecision(msg.orgId, platform, channel, msg.trustedFromAgentId)
    if (coordsVerdict.verdict === 'reject') {
      this.log.warn(
        `relay: rd/agentmsg/fwd not_allowed — ${msg.trustedFromAgentId} may not assert coords ${platform}:${channel}`
      )
      return record(nak('not_allowed'))
    }
    // Branch 3: a channel-free coordinate is admitted but must NOT become the session key —
    // this is where that key is minted, so it is where the substitution belongs (the relay
    // forwards `coords` verbatim, so only one side may rewrite them or the two would disagree
    // about the `childSessionId` this ACK reports). The replacement is derived from the
    // RELAY-MINTED trusted caller, so it cannot alias any existing platform session, and every
    // wake from that caller collapses onto the one pairwise session.
    const sessionChannel = coordsVerdict.verdict === 'synthetic' ? coordsVerdict.channel : channel

    // Build the trusted turn context + NormalizedMessage (source:'agent'), reusing the
    // same shape as the same-daemon path. callFrom = the RELAY-minted trusted caller.
    const callMeta: CallMeta = {
      callFrom: msg.trustedFromAgentId,
      ...(msg.correlationId !== undefined ? { correlationId: msg.correlationId } : {}),
      hopCount: msg.hopCount,
      deliveryId: msg.deliveryId,
      // §5.3: preserve the remote caller's origin lineage so a child woken here can reply
      // back across the relay to a parent session that lives on the caller's daemon.
      ...(msg.originSessionId !== undefined ? { originSessionId: msg.originSessionId } : {}),
      ...(msg.originCoords !== undefined ? { originCoords: msg.originCoords } : {}),
      // §5.4: the remote caller asked this child to report its outcome back. Same gate as the
      // local path — the directive names `originSessionId`, so it is meaningless without one.
      ...(msg.needsReply === true && msg.originSessionId !== undefined ? { needsReply: true } : {}),
      // §5.1: tighten-only. A `true` seals the child's capture gate immediately;
      // a `false`/absent value changes nothing, because the child starts excluded
      // and only the CP may open it.
      ...(msg.parentPrivate === true ? { parentPrivate: true } : {})
    }
    const narrowed = this.narrowPlatform(platform)
    const resolved = this.resolveCpAgent(msg.toAgentId)
    const integrationId = msg.integrationId ?? resolved?.integrationId
    // §5.4: the CANONICAL child session key, computed with the same inputs `dispatch` will use —
    // crucially including the transport scope derived from the reply integration the RELAY chose.
    // The source daemon cannot derive this (it never sees that integration), so we hand it back on
    // the ACK; without it the `childSessionId` the calling agent receives could never match this
    // row. Recording the link here also covers the pre-row window: dispatch is fire-and-forget and
    // we ACK immediately, so a CP status probe can arrive before SessionManager creates the row.
    const childTransportScope =
      integrationId !== undefined ? this.transportScopeForIntegrationIds([integrationId]) : undefined
    // Mirror `transcriptCoords` exactly: an absent thread resolves to the msgId, NOT ''.
    // `sessionChannel` — not the raw asserted `channel` — is the coordinate from here on, so the
    // key, the msgId and the dispatched message all agree on one channel (branches 1 and 2 leave
    // it exactly as asserted; only the channel-free branch 3 substitutes).
    const childMsgId = `agentcall:${sessionChannel}:${msg.deliveryId}`
    const childSessionId = sessionKey(
      narrowed,
      sessionChannel,
      thread ?? childMsgId,
      msg.toAgentId,
      childTransportScope
    )
    if (msg.originSessionId !== undefined) {
      if (this.childSessionLinks.size >= 2000) this.childSessionLinks.clear()
      this.childSessionLinks.set(childSessionId, {
        parentSessionId: msg.originSessionId,
        agentId: msg.toAgentId,
        rowUpdatedAtAtAdmission: this.store.getSession(childSessionId)?.updatedAt ?? null
      })
    }
    const normalized: NormalizedMessage = {
      msgId: childMsgId,
      traceId: msg.deliveryId,
      source: 'agent',
      platform: narrowed,
      channel: sessionChannel,
      ...(thread !== undefined ? { thread } : {}),
      sender: { id: msg.trustedFromAgentId, isBot: true },
      // The forwarded text already names the caller (`@caller: …`, built on the caller's
      // daemon in prepareAgentDelivery) — deliver it as-is. Re-wrapping it here would
      // double-frame it AND leak the caller's raw agentId, which the caller can't resolve
      // for a remote peer anyway.
      text: msg.text,
      mentionedBots: resolved?.botUserId ? [resolved.botUserId] : [],
      isDm: false,
      // A `toAgent`+`channel` wake was preceded by a visible post the SOURCE daemon made; carry
      // its real ts so this turn's transcript row collapses onto the post we fetch from the
      // shared thread (`conversations.replies`) instead of duplicating at the delivery id.
      ...(msg.transcriptTs !== undefined ? { transcriptTs: msg.transcriptTs } : {})
    }

    // Fire-and-forget dispatch (P4-gate admission). delivered:true on ADMISSION — the
    // target processes the turn in its own time (§6.4). dispatch() drops the turn on a
    // pause/drain gate; a reason-typed NAK on those local gates is a follow-up.
    void this.dispatch(msg.toAgentId, normalized, integrationId, undefined, callMeta).catch((err) =>
      this.log.error(`relay agentmsg dispatch failed for agent "${msg.toAgentId}": ${formatErr(err)}`)
    )
    this.log.info(`relay: rd/agentmsg/fwd ${msg.trustedFromAgentId} → ${msg.toAgentId} delivery=${msg.deliveryId}`)
    return record({ deliveryId: msg.deliveryId, delivered: true, childSessionId })
  }

  /** An agent's channel-directory display name, used to name the caller in the
   *  text delivered to a messaged agent. Resolution order:
   *  a LOCAL agent from `this.agents`; else the collab snapshot the CP pushes to every daemon
   *  (`cpCollab`, authoritative + always present, so it resolves a REMOTE peer even in the
   *  reply direction where this daemon never listed the channel); else the name cached from a
   *  `channelAgents` (listAgents) response; else the raw agentId (keeps a cold lookup
   *  from throwing). */
  private agentDisplayLabel(agentId: string): string {
    const local = this.agents.get(agentId)
    if (local) return local.displayName?.trim() || local.name || agentId
    const snap = this.cpCollab.nameOf(agentId)
    if (snap) return snap.displayName?.trim() || snap.name || agentId
    const cached = this.channelAgentNames.get(agentId)
    return cached?.displayName?.trim() || cached?.name || agentId
  }

  /**
   * Prepare an agent→agent delivery: the caller-framed text the target will see
   * plus a stable delivery id and thread. The message is delivered DIRECTLY to
   * the target (which wakes it in its own turn); it is deliberately NOT posted
   * as a visible channel/thread message and is not recorded in the shared
   * transcript. Agent-to-agent coordination (messageAgent / startOrchestration)
   * is no longer surfaced as channel chatter — only the target receives it.
   */
  private prepareAgentDelivery(req: MessageAgentReq): {
    deliveryId: string
    thread: string
    /** The text DELIVERED to the target's turn. Names the caller so an isolated
     *  callee (§6.6), whose only view of the request is this handed text, knows
     *  who to reply to. */
    text: string
  } {
    const callerLabel = this.agentDisplayLabel(req.callerAgentId)
    const deliverText = `@${callerLabel}: ${req.text}`
    const deliveryId = monotonicTs()
    const thread = req.thread ?? deliveryId
    return { deliveryId, thread, text: deliverText }
  }

  /**
   * The channel a DAEMON-INITIATED channel-intro turn is bound to (issue #536), resolved
   * from the turn's trusted `CallMeta` — the same §6.7 active-turn lookup a nested
   * `messageAgent` uses to inherit hop/origin, keyed by the caller's LOGICAL sessionKey.
   * Returns undefined for every ordinary turn, which is what keeps `listAgents` org-wide
   * by default. The coordinates come from the trusted MCP session context, never tool input,
   * so an agent cannot fabricate (or escape) an intro scope.
   */
  private introChannelForTurn(
    agentId: string,
    platform: string,
    coords: { channel?: string; thread?: string; transportScope?: string }
  ): string | undefined {
    if (coords.channel === undefined || coords.thread === undefined) return undefined
    const key = sessionKey(platform, coords.channel, coords.thread, agentId, coords.transportScope)
    return this.activeTurnCallMeta.get(key)?.introChannel
  }

  /**
   * Agent→agent attention routing behind the `messageAgent` MCP tool. The message is
   * delivered directly to the target and wakes it — there is no visible thread event.
   * Trusted `CallMeta` is a separate workflow projection for hop limits and
   * orchestration correlation.
   */
  /**
   * Side-effect-free authorization for a peer wake on the SAME-DAEMON path — the typed reason
   * {@link messageAgent} would reject it with for a LOCALLY-decidable cause, or, when it is
   * admitted, the CHANNEL the woken session may key off. `sendMessage` uses the rejection half
   * as a preflight, so it never leaves a visible channel post for a `toAgent`+`channel` wake
   * that will never be delivered; `messageAgent` uses BOTH halves, which is why they are one
   * method — a coordinate decided twice could be decided differently. MUST stay in sync with
   * the fail-closed guards in {@link messageAgent}: a reason added there but not here would let
   * a doomed wake still post. A remote target's LOCAL agent config is not readable here (that
   * verdict lives on the owning daemon) — but the org-scoped directory below covers a remote
   * target too, because the CP snapshot is org-wide rather than per-daemon.
   *
   * Two independent checks, in order: the directional call POLICY (`admits`, channel-free)
   * and the COORDINATE INTEGRITY of `req.channel` (`coordsDecision`). Dropping channel from
   * the policy predicate did not drop it as a session coordinate, and this is the
   * same-daemon twin of the relay/terminal-verify gate.
   */
  private localWakeDecision(req: MessageAgentReq): { rejection: string } | { rejection: null; channel: string } {
    const caller = this.agents.get(req.callerAgentId)
    if (!caller || (caller.outboundPolicy === 'selected' && !caller.allowedTargetAgentIds.includes(req.toAgentId))) {
      return { rejection: 'not_allowed' }
    }

    // A local id is not sufficient authority: the org-scoped directional call policy must
    // admit caller→target (CpCollabRoutes.admits). Channel membership is NOT consulted —
    // A2A delivery is already postless (#854), so `channel` is only a session coordinate,
    // and a session with no IM integration must still be able to collaborate. Evaluated
    // BEFORE the local-target lookup so it also decides a REMOTE target and an id that is
    // in no directory at all (previously the latter fell through to a misleading
    // 'offline'). Fails closed on an absent/stale snapshot, as before.
    if (!this.cpCollab.admits(req.callerAgentId, req.toAgentId)) return { rejection: 'not_allowed' }

    // COORDINATE INTEGRITY — the SAME decision the relay's ingress and this daemon's
    // `rd/agentmsg` terminal-verify apply, so all three wake paths enforce one rule. Channel
    // stopped AUTHORIZING the call, but `req.channel` (a model-supplied `to.channel`, or the
    // turn's own channel) is still the woken peer's session coordinate, so without this a
    // model could name a channel its agent cannot reach and RESUME a co-located peer's
    // session there. Org comes from the caller's own directory entry, never from the
    // request; `admits` above already proved the entry exists, so undefined is unreachable
    // and fails closed anyway.
    //
    // The platform is the RAW trusted session platform, deliberately NOT `narrowPlatform`'s
    // output: that helper folds `dream` (and any value the NormalizedMessage union does not
    // carry) into 'slack', which would classify a genuinely channel-free session as a
    // persisted IM coordinate and fail it closed. Only the branch-2/branch-3 split reads the
    // platform at all — the row lookup itself stays platform-free — so passing the raw value
    // cannot re-open the platform-relabelling dodge.
    const callerOrg = this.cpCollab.orgForAgent(req.callerAgentId)
    if (callerOrg === undefined) return { rejection: 'not_allowed' }
    const coords = this.cpCollab.coordsDecision(callerOrg, req.platform, req.channel, req.callerAgentId)
    if (coords.verdict === 'reject') return { rejection: 'not_allowed' }

    const target = this.agents.get(req.toAgentId)
    if (target?.callPolicy === 'selected' && !target.allowedCallerAgentIds.includes(req.callerAgentId)) {
      return { rejection: 'not_allowed' }
    }
    // Branch 3 substitutes the coordinate rather than refusing the wake; branch 1 hands back
    // `req.channel` untouched so a wake into a shared channel still lands in the thread a
    // human sees.
    return { rejection: null, channel: coords.verdict === 'synthetic' ? coords.channel : req.channel }
  }

  private wakeRejectionReason(req: MessageAgentReq): string | null {
    const platform = this.narrowPlatform(req.platform)
    if (this.evaluationProfile.collaboration === 'off') return 'capability_disabled'
    if (platform === 'slack' && /^(?:[UW][A-Z0-9]+|<@[UW][A-Z0-9]+>)$/.test(req.toAgentId.trim())) {
      return 'invalid_target'
    }
    if (req.toAgentId === req.callerAgentId) return 'self'
    const callerKey = sessionKey(
      platform,
      req.callerChannel,
      req.callerThread,
      req.callerAgentId,
      req.callerTransportScope
    )
    const inbound = this.activeTurnCallMeta.get(callerKey)
    if (inbound !== undefined && inbound.hopCount >= MAX_AGENT_CALL_HOPS) return 'hop_limit'
    return this.localWakeDecision(req).rejection
  }

  private async messageAgent(req: MessageAgentReq): Promise<MessageAgentResult> {
    const platform = this.narrowPlatform(req.platform)
    const callerKey = sessionKey(
      platform,
      req.callerChannel,
      req.callerThread,
      req.callerAgentId,
      req.callerTransportScope
    )
    const observe = (
      type:
        'collaboration.delivery.admitted' | 'collaboration.delivery.rejected' | 'collaboration.delivery.deduplicated',
      result: MessageAgentResult,
      deliveryId?: string
    ): MessageAgentResult => {
      const caller = this.store.getSession(callerKey)
      const pending = caller?.acpSessionId
        ? this.pending.get(pendingTurnKey(req.callerAgentId, caller.acpSessionId))
        : undefined
      this.emitEvaluation({
        type,
        agentId: req.callerAgentId,
        ...(caller?.acpSessionId ? { sessionId: caller.acpSessionId } : {}),
        ...(pending?.evaluationTurnId ? { turnId: pending.evaluationTurnId } : {}),
        platform,
        channel: req.channel,
        data: {
          toAgentId: req.toAgentId,
          targetSession: result.targetSession,
          ...(deliveryId ? { deliveryId } : {}),
          ...(result.reason ? { reason: result.reason } : {})
        }
      })
      return result
    }
    if (this.evaluationProfile.collaboration === 'off') {
      const thread = req.thread ?? `agentcall:${req.channel}:collaboration-disabled`
      return observe('collaboration.delivery.rejected', {
        delivered: false,
        targetSession: sessionKey(platform, req.channel, thread, req.toAgentId),
        reason: 'capability_disabled'
      })
    }
    // `toAgentId` is an AgentConnect id from listAgents / the trusted agent-call
    // envelope, never a platform member id. In particular, accepting Slack's U…/W… ids
    // here produces a visible `@U…` fallback before the relay can reject the unknown
    // target. Fail before publishing so a model that copied the human-facing Slack
    // mention cannot leave a misleading thread event.
    if (platform === 'slack' && /^(?:[UW][A-Z0-9]+|<@[UW][A-Z0-9]+>)$/.test(req.toAgentId.trim())) {
      const fallbackThread = req.thread ?? `agentcall:${req.channel}:invalid-target`
      return observe('collaboration.delivery.rejected', {
        delivered: false,
        targetSession: sessionKey(platform, req.channel, fallbackThread, req.toAgentId),
        reason: 'invalid_target'
      })
    }
    // Self-message guard (§4.5): an agent waking itself is a loop — reject before publish.
    if (req.toAgentId === req.callerAgentId) {
      const fallbackThread = req.thread ?? `agentcall:${req.channel}:self`
      return observe('collaboration.delivery.rejected', {
        delivered: false,
        targetSession: sessionKey(platform, req.channel, fallbackThread, req.toAgentId),
        reason: 'self'
      })
    }

    // Trusted source-turn metadata is independent from the delivered message. Both
    // local and relay paths inherit reply correlation identically.
    const inbound = this.activeTurnCallMeta.get(callerKey)
    const sourceHopCount = inbound?.hopCount ?? 0
    // session-concept §5.3: capture the CALLER's own session as the woken child's origin, so
    // the child can reply into it via `sendMessage`'s SessionTarget (across thread/platform/
    // daemon). originSessionId is the caller session's stable acpSessionId (mid-turn, so it is
    // already minted); originCoords are its landing coords for cross-daemon reply routing.
    const originSessionId = this.store.getSession(callerKey)?.acpSessionId ?? undefined
    const originCoordPlatform = platform === 'hook' ? 'slack' : platform
    const originCoords: CallMeta['originCoords'] = {
      platform: originCoordPlatform,
      channel: req.callerChannel,
      ...(req.callerThread ? { thread: req.callerThread } : {})
    }
    if (inbound !== undefined && sourceHopCount >= MAX_AGENT_CALL_HOPS) {
      const fallbackThread = req.thread ?? `agentcall:${req.channel}:hop-limit`
      return observe('collaboration.delivery.rejected', {
        delivered: false,
        targetSession: sessionKey(platform, req.channel, fallbackThread, req.toAgentId),
        reason: 'hop_limit'
      })
    }
    const isReply = inbound !== undefined && req.toAgentId === inbound.callFrom
    const correlationId =
      req.correlationId !== undefined ? req.correlationId : isReply ? inbound.correlationId : undefined

    const target = this.agents.get(req.toAgentId)
    const resolved = target ? this.resolveCpAgent(req.toAgentId, platform === 'hook' ? 'slack' : platform) : null
    const integrationId = resolved?.integrationId
    const targetTransportScope =
      integrationId !== undefined ? this.transportScopeForIntegrationIds([integrationId]) : undefined
    // The same side-effect-free authorization sendMessage's preflight ran (caller existence +
    // outbound policy, the org-scoped directional call policy, a local target's inbound policy,
    // and COORDINATE INTEGRITY). It is resolved BEFORE the coordinate is minted because it also
    // decides WHICH channel may be minted: a channel-free coordinate the snapshot knows nothing
    // about is admitted but must not become the session key, so `localWakeDecision` hands back a
    // caller-derived channel (`a2a:<callerAgentId>`) that cannot alias any platform session. The
    // rejection path keeps reporting the ASSERTED channel — nothing was opened, and the reason,
    // not the coordinate, is what the caller acts on.
    const wake = this.localWakeDecision(req)
    const coordChannel = wake.rejection === null ? wake.channel : req.channel
    // A2A delivery is direct and postless (#854): the woken peer receives a caller-framed
    // message and nothing is left in any channel. session-concept case 2c (pure wake) is thus
    // the default — a `sendMessage` with `toAgent` never posts, regardless of `channel`.
    const event = this.prepareAgentDelivery(req)
    const { deliveryId } = event
    const msgId = `agentcall:${coordChannel}:${deliveryId}`
    const targetSession = sessionKey(platform, coordChannel, event.thread, req.toAgentId, targetTransportScope)

    const prior = this.agentCallDeliveries.get(deliveryId)
    if (prior) return observe('collaboration.delivery.deduplicated', prior, deliveryId)
    const record = (result: MessageAgentResult): MessageAgentResult => {
      if (this.agentCallDeliveries.size >= 2000) this.agentCallDeliveries.clear()
      this.agentCallDeliveries.set(deliveryId, result)
      return observe(
        result.delivered ? 'collaboration.delivery.admitted' : 'collaboration.delivery.rejected',
        result,
        deliveryId
      )
    }

    if (wake.rejection !== null) {
      this.log.info(`messageAgent: ${req.callerAgentId} not allowed to call ${req.toAgentId} in ${req.channel}`)
      return record({ delivered: false, targetSession, reason: 'not_allowed' })
    }

    // Local presence: if absent, route the delivery over the relay. The relay
    // decides whether the target is allowed to be woken by this caller.
    if (!target) {
      const coordPlatform = platform === 'hook' ? 'slack' : platform
      const remote = await this.routeAgentMsgCrossDaemon(
        { ...req, text: event.text, thread: event.thread },
        {
          platform: coordPlatform,
          // The ASSERTED coordinate, not `coordChannel`: the relay validates what the caller
          // named, and the OWNING daemon mints the session key (and any channel-free
          // substitution) — we take that canonical key back off the ACK below.
          channel: req.channel,
          thread: event.thread,
          deliveryId,
          targetSession,
          sourceHopCount,
          correlationId,
          ...(originSessionId !== undefined ? { originSessionId } : {}),
          originCoords
        }
      )
      // §5.4: an ADMITTED remote wake is still a child this session may follow — its row lives on
      // the owning daemon, so mark the link remote and let viewSessionStatus route through the CP.
      if (remote.delivered && originSessionId !== undefined) {
        if (this.childSessionLinks.size >= 2000) this.childSessionLinks.clear()
        // Key it by the CANONICAL key the target returned (`remote.targetSession`), not our
        // pre-ACK guess — that canonical value is what we hand the agent, so it is what a later
        // `viewSessionStatus` will look up.
        this.childSessionLinks.set(remote.targetSession, {
          parentSessionId: originSessionId,
          agentId: req.toAgentId,
          rowUpdatedAtAtAdmission: null,
          remote: true
        })
      }
      return record(remote)
    }

    // Trusted call metadata for the target's turn (§3.3a/§6.6/§6.7): kept daemon-private
    // (Pending.callMeta), never in the model-visible prompt. DAEMON-MANAGED auto-inheritance
    // from the CURRENT turn's trusted callMeta (never trusting the agent to hand-copy it):
    //   • hopCount / originId: ALWAYS inherit (current hopCount + 1) for loop protection,
    //     regardless of target. A call made from a plain human/platform turn (no active
    //     callMeta) starts at hopCount 0.
    //   • correlationId: inherit ONLY on a REPLY — i.e. when the worker is messaging back the
    //     agent that tasked it (toAgentId === the current turn's inbound callFrom) AND the
    //     tool caller did not pass one explicitly. An explicit args.correlationId is honored
    //     as a manual override (advanced use); otherwise the auto-inherit-on-reply is what
    //     makes N-of-N orchestration close without the agent ever knowing the id. A message
    //     to a THIRD agent (not the caller) does NOT inherit correlation — it's a fresh call.
    const hopCount = inbound ? inbound.hopCount + 1 : 0
    const callMeta: CallMeta = {
      callFrom: req.callerAgentId,
      ...(correlationId !== undefined ? { correlationId } : {}),
      hopCount,
      deliveryId,
      // §5.3: hand the child its origin so it can reply back with `sendMessage({sessionId})`.
      ...(originSessionId !== undefined ? { originSessionId } : {}),
      originCoords,
      // §5.3: `toAgent.needsReply` — tell the child to report its outcome back to that origin.
      // Meaningless without an origin to reply into, so it rides the same condition.
      ...(req.needsReply === true && originSessionId !== undefined ? { needsReply: true } : {}),
      // §5.1: seal the child's capture gate when the waking session is private.
      // Tighten-only — see CallMeta.parentPrivate.
      ...(originSessionId !== undefined && this.store.isCaptureExcluded(originSessionId) ? { parentPrivate: true } : {})
    }

    const normalized: NormalizedMessage = {
      msgId,
      traceId: deliveryId,
      source: 'agent',
      // `coordChannel`, so the dispatched turn lands on exactly the key `targetSession`
      // reports (identical to `req.channel` outside the channel-free branch).
      platform,
      channel: coordChannel,
      thread: event.thread,
      ...(targetTransportScope !== undefined ? { transportScope: targetTransportScope } : {}),
      sender: { id: req.callerAgentId, isBot: true },
      text: event.text,
      mentionedBots: resolved?.botUserId ? [resolved.botUserId] : [],
      isDm: false,
      // A `toAgent`+`channel` wake was preceded by a visible post; carry its real ts so the
      // wake's transcript row collapses onto the recorded post's (channel, thread, ts) PK
      // (no duplicate hand-off) and the session cursor stays canonical (mirrors the
      // spawnChannelRootSession seed). Absent ⇒ transcriptCoords derives ts from the msgId.
      ...(req.transcriptTs !== undefined ? { transcriptTs: req.transcriptTs } : {}),
      // Self-introduce-on-join (#536): a fan-out from an intro turn wakes each peer
      // HEADLESS so it records the newcomer silently, never posting to the channel.
      ...(inbound?.deliverHeadless ? { headless: true } : {})
    }

    // Fire-and-forget dispatch — mirror handleRelayIm. The wake is async: the tool returns
    // `delivered:true` on ADMISSION (the target processes the turn in its own time), not on
    // the peer's reply. dispatch() drops the turn (returns null) if the target is paused/
    // draining; that still counts as admitted for P1 (a reason-typed NAK on those gates is
    // P2's admission protocol, §6.4).
    // Record the lineage BEFORE the fire-and-forget dispatch, so a parent that polls
    // `viewSessionStatus` the instant sendMessage returns is already authorized.
    if (originSessionId !== undefined) {
      if (this.childSessionLinks.size >= 2000) this.childSessionLinks.clear()
      this.childSessionLinks.set(targetSession, {
        parentSessionId: originSessionId,
        agentId: req.toAgentId,
        // Snapshot the child row as it stands BEFORE the wake runs (null when it has never run),
        // so a re-wake of a finished child can't be reported with its previous turn's outcome.
        rowUpdatedAtAtAdmission: this.store.getSession(targetSession)?.updatedAt ?? null
      })
    }
    void this.dispatch(req.toAgentId, normalized, integrationId, undefined, callMeta).catch((err) =>
      this.log.error(`messageAgent dispatch failed for agent "${req.toAgentId}": ${formatErr(err)}`)
    )
    this.log.info(`messageAgent: ${req.callerAgentId} → ${req.toAgentId} (${targetSession}) delivery=${deliveryId}`)
    return record({ delivered: true, targetSession })
  }

  /**
   * Reply into an existing session addressed by its stable id (session-concept §5.2 —
   * `sendMessage`'s SessionTarget). Unlike `messageAgent` this does NOT create a new session
   * or publish a visible thread event: it inserts a `{type:system, from:<caller>}` message
   * into the ORIGIN session and continues/wakes it.
   *
   * AUTHORIZATION (origin-only, fail-closed, §5.3): the only session a caller may reply into
   * is the origin the CURRENT turn was woken from. The caller identity comes from the trusted
   * session context; `sessionId` is the sole tool input and is validated to equal the turn's
   * `originSessionId`. A root/human turn (no active call metadata) or any other sessionId is
   * refused — an agent can never inject into an arbitrary session.
   */
  private async replyToSession(req: ReplyToSessionReq): Promise<ReplyToSessionResult> {
    const platform = this.narrowPlatform(req.platform)
    const callerKey = sessionKey(
      platform,
      req.callerChannel,
      req.callerThread,
      req.callerAgentId,
      req.callerTransportScope
    )
    const inbound = this.activeTurnCallMeta.get(callerKey)
    const callerRec = this.store.getSession(callerKey)
    // Origin authorization is DURABLE (§5.3): a session spawned by a parent may reply into it on
    // ANY turn, not just the one agent-call turn that woke it. Prefer this turn's trusted CallMeta
    // origin (present on the wake turn), else the origin PERSISTED on the caller session (set once
    // at spawn). A human-triggered follow-up turn carries no CallMeta, so without the persisted
    // fallback the reply would be wrongly refused (`not_authorized`) after the first turn.
    const authorizedOrigin = inbound?.originSessionId ?? callerRec?.originSessionId ?? undefined
    if (!authorizedOrigin || req.sessionId !== authorizedOrigin) {
      return { delivered: false, reason: 'not_authorized' }
    }
    // A reply is an agent-call — bound it by the same hop cap so a reply ping-pong can't run away.
    // A human-triggered turn has no inbound depth, so it starts the chain at 0.
    const sourceHopCount = inbound?.hopCount ?? 0
    if (sourceHopCount >= MAX_AGENT_CALL_HOPS) {
      return { delivered: false, reason: 'hop_limit' }
    }
    // §5.3 step 3: replying into the origin inherits the origin turn's correlationId when present
    // (so a main-agent's orchestration closes without the worker knowing the id). Explicit wins;
    // a human-triggered reply simply has none.
    const correlationId = req.correlationId !== undefined ? req.correlationId : inbound?.correlationId

    const deliveryId = randomUUID()
    // Hand the origin owner a turn whose origin points back at the REPLIER's session, so the
    // origin could reply again (symmetric lineage). callFrom = the replier.
    const replyCoordPlatform = platform === 'hook' ? 'slack' : platform
    const replierSessionId = callerRec?.acpSessionId ?? undefined
    const replyOriginCoords: CallMeta['originCoords'] = {
      platform: replyCoordPlatform,
      channel: req.callerChannel,
      ...(req.callerThread ? { thread: req.callerThread } : {})
    }
    const callMeta: CallMeta = {
      callFrom: req.callerAgentId,
      ...(correlationId !== undefined ? { correlationId } : {}),
      hopCount: sourceHopCount + 1,
      deliveryId,
      ...(replierSessionId !== undefined ? { originSessionId: replierSessionId } : {}),
      originCoords: replyOriginCoords,
      // §5.1: seal the child's capture gate when the waking session is private.
      // Tighten-only — see CallMeta.parentPrivate.
      ...(replierSessionId !== undefined && this.store.isCaptureExcluded(replierSessionId)
        ? { parentPrivate: true }
        : {})
    }

    // Resolve where the origin session lives. Local ⇒ dispatch straight into it through the
    // per-session serial gate (satisfies §5.3 concurrency vs. a running origin turn). Not
    // local ⇒ the origin is on another daemon; route over the relay using the origin coords
    // carried on the inbound turn (the relay has no sessionId→daemon registry).
    const local = this.store.getSessionByAcpId(req.sessionId)
    if (local) {
      const originOwner = local.agentId
      const narrowedLocal = this.narrowPlatform(local.platform)
      // Resolve the reply's output transport by the ORIGIN session's platform, not the
      // agent's default integration. A multi-platform agent (e.g. Slack + Telegram) would
      // otherwise post the reply through integrations[0]'s client, and a Telegram chat id
      // sent via the Slack client fails with channel_not_found (the reply turn runs but its
      // answer never reaches the origin channel).
      const integrationId = this.integrationIdForTransportScope(originOwner, narrowedLocal, local.transportScope)
      if (local.transportScope && !integrationId) {
        return { delivered: false, targetSession: local.key, reason: 'not_found' }
      }
      const resolved = this.resolveCpAgent(originOwner, narrowedLocal)
      const normalized: NormalizedMessage = {
        msgId: `agentcall:${local.channel}:${deliveryId}`,
        traceId: deliveryId,
        source: 'agent',
        platform: narrowedLocal,
        channel: local.channel,
        ...(local.thread ? { thread: local.thread } : {}),
        ...(local.transportScope ? { transportScope: local.transportScope } : {}),
        // A monotonic "now" ts so the reply is ordered as a NEW message in the origin session.
        // Without it, transcriptCoords derives the ts from the msgId's random UUID, which the
        // origin's dedup mis-orders — the parent turn then runs with no new content and the reply
        // never actually lands. (deliveryId stays a UUID for CallMeta/agent-call dedup.)
        transcriptTs: monotonicTs(),
        sender: { id: req.callerAgentId, isBot: true },
        text: req.text,
        mentionedBots: integrationId
          ? this.botUserIds[integrationId]
            ? [this.botUserIds[integrationId]!]
            : []
          : resolved?.botUserId
            ? [resolved.botUserId]
            : [],
        isDm: false
      }
      void this.dispatch(originOwner, normalized, integrationId, undefined, callMeta).catch((err) =>
        this.log.error(`replyToSession dispatch failed for session "${req.sessionId}": ${formatErr(err)}`)
      )
      this.log.info(`replyToSession: ${req.callerAgentId} → ${originOwner} (${local.key}) delivery=${deliveryId}`)
      return { delivered: true, targetSession: local.key }
    }

    // Cross-daemon: the origin lives elsewhere. Route by its coords + owner (inbound.callFrom).
    // Only available from a live agent-call turn's CallMeta; a human-triggered follow-up whose
    // origin is on another daemon has no coords to route by (getSessionByAcpId missed) → not_found.
    const coords = inbound?.originCoords
    if (!coords || !inbound) return { delivered: false, reason: 'not_found' }
    const targetSession = sessionKey(coords.platform, coords.channel, coords.thread ?? '', inbound.callFrom)
    const res = await this.routeAgentMsgCrossDaemon(
      {
        callerAgentId: req.callerAgentId,
        platform: coords.platform,
        callerChannel: req.callerChannel,
        callerThread: req.callerThread,
        toAgentId: inbound.callFrom,
        text: req.text,
        channel: coords.channel,
        ...(coords.thread !== undefined ? { thread: coords.thread } : {}),
        ...(correlationId !== undefined ? { correlationId } : {})
      },
      {
        platform: coords.platform,
        channel: coords.channel,
        ...(coords.thread !== undefined ? { thread: coords.thread } : {}),
        deliveryId,
        targetSession,
        sourceHopCount: inbound.hopCount,
        ...(correlationId !== undefined ? { correlationId } : {}),
        ...(replierSessionId !== undefined ? { originSessionId: replierSessionId } : {}),
        originCoords: replyOriginCoords
      }
    )
    return {
      delivered: res.delivered,
      targetSession: res.targetSession,
      ...(res.reason !== undefined ? { reason: res.reason as ReplyToSessionResult['reason'] } : {})
    }
  }

  /**
   * Read the progress of a session the caller STARTED (backs the `viewSessionStatus` tool). The
   * read counterpart of {@link replyToSession}: a child may reply UP its lineage, a parent may
   * read DOWN it, and neither can reach sideways into an unrelated session.
   *
   * AUTHORIZATION (child-only, fail-closed): `sessionId` must name a session whose parent is the
   * CALLING session. Two sources, in order — the child's DURABLE `originSessionId` (authoritative
   * once the child's row exists), else the in-memory {@link childSessionLinks} entry written at
   * wake admission (covers the window before the child's first turn creates that row). Anything
   * else — an unknown id, a sibling, the caller's own session, a grandchild — returns null, which
   * the tool surfaces as one indistinguishable error so the caller cannot probe for sessions it
   * may not read.
   *
   * The reported `status` collapses the §7.3 lifecycle plus the last turn's outcome: a turn in
   * flight (or admitted-but-not-yet-open) is `in-progress`; otherwise the last completed turn's
   * outcome decides `done` vs `failed`. Note `done` means "its turn ended", not "it reported
   * back" — that is what `needsReply` is for.
   */
  private async viewSessionStatus(req: SessionStatusReq): Promise<SessionStatusResult | null> {
    const platform = this.narrowPlatform(req.platform)
    const callerKey = sessionKey(
      platform,
      req.callerChannel,
      req.callerThread,
      req.callerAgentId,
      req.callerTransportScope
    )
    const callerSessionId = this.store.getSession(callerKey)?.acpSessionId ?? undefined
    // A caller with no session id of its own has no lineage to check against — refuse rather than
    // fall through to a link lookup that could match an `undefined` parent.
    if (!callerSessionId) return null
    // Addressed ONLY by the logical sessionKey `sendMessage` handed back. An ACP-id lookup is
    // deliberately not offered: ACP ids are minted per runtime and are not unique across agents,
    // so `getSessionByAcpId` can return a row belonging to a different agent — an ambiguous status
    // read for no benefit, since the parent always has the key we gave it.
    const child = this.store.getSession(req.sessionId)
    if (!child) {
      // No local row. Either the wake was admitted and dispatch is still in flight, or the child
      // lives on another daemon. Both are only answerable to the parent that actually woke it.
      const link = this.childSessionLinks.get(req.sessionId)
      if (!link || link.parentSessionId !== callerSessionId) return null
      if (link.remote) return await this.remoteChildStatus(req.sessionId, callerSessionId, link.agentId)
      return { sessionId: req.sessionId, agentId: link.agentId, status: 'in-progress', state: 'starting' }
    }
    if (!this.isAuthorizedChildParent(child, callerSessionId)) return null
    // A session cannot be its own child; guard the degenerate case where a caller passes its own
    // id and a stale link would otherwise vouch for it.
    if (child.key === callerKey) return null
    const collapsed = this.collapseChildStatus(child)
    return { sessionId: req.sessionId, ...collapsed }
  }

  /**
   * Collapse one child session row into the coarse §5.4 progress triple. Shared by the local
   * `viewSessionStatus` and the CP-forwarded {@link childSessionStatusProbe} so a parent gets the
   * same answer whichever daemon its child landed on.
   *
   * Work is outstanding when a turn is running, queued behind one, or admitted by a wake the child
   * has not picked up yet (its row has not moved since we admitted it — see the
   * `rowUpdatedAtAtAdmission` note on childSessionLinks). Reporting the previous turn's outcome in
   * any of those windows would tell the parent its NEW delegation had already finished.
   */
  private collapseChildStatus(child: SessionRecord): {
    agentId: string
    status: SessionStatusResult['status']
    state: SessionStatusResult['state']
    updatedAt: number
  } {
    const link = this.childSessionLinks.get(child.key)
    const queuedOrRunning = this.activeGateEntries.has(child.key) || (this.serialQueue.get(child.key)?.length ?? 0) > 0
    const admittedNotStarted = link !== undefined && child.updatedAt === link.rowUpdatedAtAtAdmission
    const inFlight = child.state === 'prompting' || child.state === 'cancelling' || child.state === 'resuming'
    const status: SessionStatusResult['status'] =
      inFlight || queuedOrRunning || admittedNotStarted
        ? 'in-progress'
        : child.lastTurnOutcome === 'failed'
          ? 'failed'
          : child.lastTurnOutcome === 'done'
            ? 'done'
            : // Idle/closed with no recorded outcome: the row exists but its first turn has not
              // finished (or predates outcome tracking) — treat as still working, never as done.
              'in-progress'
    return { agentId: child.agentId, status, state: child.state, updatedAt: child.updatedAt }
  }

  /**
   * §5.4 cross-daemon leg: ask the CP for the status of a child that lives on ANOTHER daemon.
   * The daemon has no way to address another daemon directly (the relay carries message delivery,
   * not queries), and the CP is the placement authority — so it resolves the owning daemon and
   * forwards the lineage pair there. This is a bounded metadata read: no message bodies, and the
   * CP persists nothing.
   *
   * Distinguishes three outcomes for the caller: a status, `null` (unknown / not your child — one
   * indistinguishable verdict, as locally), or a THROWN error for a transport problem, so the tool
   * says "temporarily unavailable" instead of implying the parent has no such child.
   */
  private async remoteChildStatus(
    childSessionId: string,
    parentSessionId: string,
    childAgentId: string
  ): Promise<SessionStatusResult | null> {
    const client = this.cpClient
    // Degraded mode (§ graceful degradation): established sessions keep running with no CP, but a
    // cross-daemon lookup genuinely cannot be answered — say so rather than deny the lineage.
    if (!client)
      throw new Error(
        'the status of a session on another daemon is unavailable while the control plane is disconnected'
      )
    const res = await client.childSessionStatus({ parentSessionId, childSessionId, childAgentId })
    if (res.reason === 'offline') {
      throw new Error(`the daemon running ${childSessionId} is not currently reachable — try again shortly`)
    }
    if (!res.found) return null
    return {
      sessionId: childSessionId,
      agentId: res.agentId ?? childAgentId,
      status: res.status ?? 'in-progress',
      state: res.state ?? 'starting',
      ...(res.updatedAt !== undefined ? { updatedAt: res.updatedAt } : {})
    }
  }

  /**
   * §5.4 owning-daemon leg: answer a CP-forwarded status probe for a child WE own. This is where
   * the real lineage rule is enforced — exactly the same check as the local path, deliberately
   * duplicated here rather than trusted from the CP: the CP proves the asking daemon owns the
   * claimed parent session, and this proves the child is actually that parent's child.
   *
   * Returns the wire shape. `found:false` covers unknown-session AND not-your-child so a caller
   * cannot probe for sessions it may not read.
   */
  childSessionStatusProbe(probe: ChildSessionStatusProbe): ChildSessionStatus {
    const child = this.store.getSession(probe.childSessionId)
    if (!child) {
      // Pre-row window: we ACKed admission immediately and dispatch is fire-and-forget, so a probe
      // can legitimately arrive before SessionManager creates the row. The admission link recorded
      // at ACK time is the only record — and the only authority — until then.
      const link = this.childSessionLinks.get(probe.childSessionId)
      if (!link || link.parentSessionId !== probe.parentSessionId) return { found: false }
      return { found: true, agentId: link.agentId, status: 'in-progress', state: 'starting' }
    }
    if (!this.isAuthorizedChildParent(child, probe.parentSessionId)) return { found: false }
    return { found: true, ...this.collapseChildStatus(child) }
  }

  /**
   * Whether `parentSessionId` is a parent this child may be reported to. A logical child session
   * can be woken by MORE THAN ONE parent over its life, and both are legitimate: the durable
   * first-wins `originSessionId`, and the most recent waker recorded at admission (the one whose
   * `sendMessage` just handed that caller the handle). Accepting only the durable link would deny a
   * second parent the child it just started — the read-side mirror of naming the current waker in
   * the report-back directive.
   */
  private isAuthorizedChildParent(child: SessionRecord, parentSessionId: string): boolean {
    if (child.originSessionId === parentSessionId) return true
    return this.childSessionLinks.get(child.key)?.parentSessionId === parentSessionId
  }

  /**
   * Whether a channel-ROOT post just made by `caller` FORKED a conversation that session is
   * ALREADY part of — its parent's, its own, or neither. Backs `sendMessage`'s root-post notice.
   *
   * Forking, not merely landing on: a post whose thread key IS the conversation's own thread
   * joined it, which is what a root post does on Discord and in Telegram / Feishu DMs (see
   * {@link threadKeyForPost}). Warning there would tell an agent its message went nowhere when
   * the reader has it, and talk it into sending a second copy.
   *
   * Conversation identity is the daemon's to decide, which is why this lives here and not in ops:
   * a channel id is only unique within one physical bot, so two integrations can name the same id
   * and mean different conversations. The comparison therefore includes the transport scope on
   * both sides, and the caller's session key uses its platform string verbatim.
   *
   * The parent link is read from the CURRENT turn's trusted call metadata when present, else from
   * the DURABLE origin on the session row (§5.3) — the load-bearing half, since relaying an answer
   * happens on a later human-triggered turn with no metadata. Coords come from the parent's own
   * row wherever one exists, because only a row records a transport scope; the cross-daemon case
   * and its deliberate imprecision are spelled out at the branch below. This widens nothing — it
   * answers about coordinates the caller itself just named.
   */
  private rootPostRelation(req: {
    callerAgentId: string
    platform: string
    callerTransportScope?: string
    callerChannel: string
    callerThread: string
    targetPlatform: string
    targetChannel: string
    targetThread: string
    targetIntegrationId?: string
  }): { kind: 'parent'; sessionId: string } | { kind: 'self' } | undefined {
    const targetScope = this.transportScopeForIntegrationIds(
      req.targetIntegrationId !== undefined ? [req.targetIntegrationId] : undefined
    )
    // Same conversation AND a different thread: only then did the post FORK it. Where a platform
    // has no separate thread to open — Discord, and Telegram / Feishu DMs, whose post key IS the
    // conversation ({@link threadKeyForPost}) — the message simply landed in it, and there is
    // nothing to warn about.
    const isForkOf = (platform: string, channel: string, thread: string, scope?: string | null): boolean =>
      platform === req.targetPlatform &&
      channel === req.targetChannel &&
      thread !== req.targetThread &&
      (scope ?? undefined) === (targetScope ?? undefined)

    const key = sessionKey(
      req.platform,
      req.callerChannel,
      req.callerThread,
      req.callerAgentId,
      req.callerTransportScope
    )
    const inbound = this.activeTurnCallMeta.get(key)
    const parentSessionId = inbound?.originSessionId ?? this.store.getSession(key)?.originSessionId ?? undefined
    const parent = parentSessionId ? this.store.getSessionByAcpId(parentSessionId) : undefined
    // A LOCAL parent's row records its transport scope, so its identity is exact.
    if (parentSessionId && parent && isForkOf(parent.platform, parent.channel, parent.thread, parent.transportScope)) {
      return { kind: 'parent', sessionId: parentSessionId }
    }
    // A CROSS-DAEMON parent has no row here, and its scope cannot be obtained: the value is
    // derived from the owning daemon's live credential and deliberately never crosses the wire
    // (see the note on the durable scope in protocol telemetry) — it would also rotate with that
    // daemon's tokens, so a forwarded copy could not be compared reliably anyway. Identity here is
    // therefore COORDINATES ONLY, which can over-match where one channel id is reachable through
    // two bots. That trade is deliberate: the cost of over-matching is a hint naming the caller's
    // real parent — where a relayed answer belongs regardless — while staying silent would drop
    // the hint for precisely the escalation shape the relay exists to serve.
    if (parentSessionId && !parent && inbound?.originCoords) {
      const { platform, channel, thread } = inbound.originCoords
      // An origin without a thread (a legacy peer omits it) cannot be shown to have been forked,
      // and the notice's whole claim is that it was — stay silent rather than guess.
      if (thread !== undefined && platform === req.targetPlatform && channel === req.targetChannel) {
        if (thread !== req.targetThread) return { kind: 'parent', sessionId: parentSessionId }
        return undefined
      }
    }
    if (isForkOf(req.platform, req.callerChannel, req.callerThread, req.callerTransportScope)) {
      return { kind: 'self' }
    }
    return undefined
  }

  /**
   * session-concept case 2a: an agent's channel-ROOT post seeds a NEW session owned by the same
   * agent. The post already happened (ops.ts); here the daemon initializes the new-thread session
   * (keyed by the post's ts) so the top-level message starts its own context,
   * with `Parent session` = the origin session. This is initialization only: the root is recorded
   * for replay with the first real reply, but no model turn runs. `headless` remains a transport
   * backstop, and the hop count remains a defense for replay from an older durable inbox row.
   */
  private spawnChannelRootSession(req: {
    agentId: string
    platform: string
    integrationId?: string
    channel: string
    /** The post's session-thread key, already canonicalized by {@link threadKeyForPost} at the
     *  one seam that converts a platform ts into a thread segment — the same key an inbound
     *  reply to this post resolves to, so the reply meets this session instead of opening a
     *  second one. */
    thread: string
    /** The post's RAW platform ts, which on Telegram differs from `thread`. */
    postTs: string
    text: string
    originPlatform?: string
    originTransportScope?: string
    originChannel: string
    originThread: string
  }): boolean {
    const platform = this.narrowPlatform(req.platform)
    // The origin session may live on a DIFFERENT platform than this post (e.g. a Telegram
    // turn posting to Slack). Key the origin lookup by the ORIGIN's platform, not the target's,
    // or the caller session is never found and the new session loses its parent lineage.
    const originPlatform = this.narrowPlatform(req.originPlatform ?? req.platform)
    const originKey = sessionKey(
      originPlatform,
      req.originChannel,
      req.originThread,
      req.agentId,
      req.originTransportScope
    )
    const inbound = this.activeTurnCallMeta.get(originKey)
    // A self-post from a plain human/platform turn (no active callMeta) starts the self-chain at 1.
    const hopCount = inbound ? inbound.hopCount + 1 : 1
    if (hopCount > MAX_AGENT_CALL_HOPS) {
      this.log.info(`channel-root session: hop limit reached for agent "${req.agentId}" — not spawning`)
      return false
    }
    const originSessionId = this.store.getSession(originKey)?.acpSessionId ?? undefined
    const originCoordPlatform = originPlatform === 'hook' ? 'slack' : originPlatform
    const deliveryId = randomUUID()
    const callMeta: CallMeta = {
      callFrom: req.agentId,
      hopCount,
      deliveryId,
      initializeOnly: true,
      ...(originSessionId ? { originSessionId } : {}),
      originCoords: {
        platform: originCoordPlatform,
        channel: req.originChannel,
        ...(req.originThread ? { thread: req.originThread } : {})
      },
      // §5.1: seal the child's capture gate when the waking session is private.
      // Tighten-only — see CallMeta.parentPrivate.
      ...(originSessionId && this.store.isCaptureExcluded(originSessionId) ? { parentPrivate: true } : {})
    }
    const transportScope = this.transportScopeForIntegrationIds(
      req.integrationId !== undefined ? [req.integrationId] : undefined
    )
    const normalized: NormalizedMessage = {
      msgId: `agentcall:${req.channel}:${deliveryId}`,
      traceId: deliveryId,
      source: 'agent',
      platform,
      channel: req.channel,
      thread: req.thread,
      ...(transportScope !== undefined ? { transportScope } : {}),
      // The seed's transcript ts MUST be the post's real ts (the new thread's root), not the
      // random deliveryId — otherwise the session's lastDeliveredTs becomes a non-ts string and
      // a later real reply in this thread is mis-compared and wrongly skipped as already-delivered.
      // On Telegram that raw ts is NOT the thread key, hence the separate field.
      transcriptTs: req.postTs,
      sender: { id: req.agentId, isBot: true },
      text: req.text,
      mentionedBots: [],
      isDm: false,
      // No model turn runs for this seed; headless is retained as a transport backstop.
      headless: true
    }
    const targetSession = sessionKey(platform, req.channel, req.thread, req.agentId, transportScope)
    void this.dispatch(req.agentId, normalized, req.integrationId, undefined, callMeta).catch((err) =>
      this.log.error(`channel-root session spawn failed for agent "${req.agentId}": ${formatErr(err)}`)
    )
    this.log.info(
      `channel-root session: "${req.agentId}" initialized new session ${targetSession} (origin ${originSessionId ?? 'none'}, hop ${hopCount})`
    )
    return true
  }

  /**
   * Route a cross-daemon `messageAgent` over the relay data plane (agent-collaboration
   * §2.3/§6.2/§6.4, P2) and map the relay's typed admission verdict to a
   * {@link MessageAgentResult}. The `claimedFromAgentId` is our trusted caller — the
   * relay re-validates it against our authenticated daemonId (a forged claim is
   * rejected there). `sourceHopCount` is the trusted source turn's depth; the relay
   * increments it (+1, cap 8). The body never touches the CP — only the relay.
   */
  private async routeAgentMsgCrossDaemon(
    req: MessageAgentReq,
    ctx: {
      platform: Exclude<NormalizedMessage['platform'], 'hook'>
      channel: string
      thread?: string
      deliveryId: string
      targetSession: string
      sourceHopCount: number
      correlationId?: string
      /** §5.3: the caller's origin session, forwarded so the remote child can reply back. */
      originSessionId?: string
      originCoords?: CallMeta['originCoords']
    }
  ): Promise<MessageAgentResult> {
    if (!this.relays) {
      return { delivered: false, targetSession: ctx.targetSession, reason: 'not_local' }
    }
    try {
      const ack = await this.relays.sendAgentMsg({
        claimedFromAgentId: req.callerAgentId,
        // Tighten-only privacy hint for the remote child's capture gate (§5.1).
        ...(ctx.originSessionId !== undefined && this.store.isCaptureExcluded(ctx.originSessionId)
          ? { parentPrivate: true }
          : {}),
        toAgentId: req.toAgentId,
        text: req.text,
        coords: {
          platform: ctx.platform,
          channel: ctx.channel,
          ...(ctx.thread !== undefined ? { thread: ctx.thread } : {})
        },
        ...(ctx.correlationId !== undefined ? { correlationId: ctx.correlationId } : {}),
        hopCount: ctx.sourceHopCount,
        deliveryId: ctx.deliveryId,
        // Visible-post ts (if this wake was a `toAgent`+`channel` send) so the remote target
        // dedups the wake against the post it fetches from the shared thread and keeps a
        // canonical read cursor — same guarantee as the same-daemon path.
        ...(req.transcriptTs !== undefined ? { transcriptTs: req.transcriptTs } : {}),
        ...(ctx.originSessionId !== undefined ? { originSessionId: ctx.originSessionId } : {}),
        ...(ctx.originCoords !== undefined ? { originCoords: ctx.originCoords } : {}),
        // §5.4: ask the remote child to report its outcome back into our origin session. Gated on
        // having an origin for exactly the reason the local path is — there is nothing to report to
        // without one, and the target ignores it in that case anyway.
        ...(req.needsReply === true && ctx.originSessionId !== undefined ? { needsReply: true } : {})
      })
      // §5.4: prefer the CANONICAL key the target computed — its transport scope depends on the
      // reply integration the relay chose, which we cannot derive. Fall back to our own guess only
      // for an older target daemon that returns none (it then simply won't be followable).
      if (ack.delivered) return { delivered: true, targetSession: ack.childSessionId ?? ctx.targetSession }
      return { delivered: false, targetSession: ctx.targetSession, ...(ack.reason ? { reason: ack.reason } : {}) }
    } catch (err) {
      // No READY relay / forward failed → undeliverable (offline). Retransmit is a follow-up.
      this.log.warn(`messageAgent: cross-daemon route failed for ${req.toAgentId}: ${formatErr(err)}`)
      return { delivered: false, targetSession: ctx.targetSession, reason: 'offline' }
    }
  }

  /** Narrow the trusted session-context platform string to the NormalizedMessage union;
   *  falls back to 'slack' for an unrecognized value (coords still resolve — the union is
   *  a routing/key detail, not the trust basis). */
  private narrowPlatform(p: string): NormalizedMessage['platform'] {
    // Every caller turns a platform string off a session/orchestration row back into the union, to
    // key a session or synthesize a message. `feishu` was missing from the list long after the
    // platform shipped, so all of them silently produced a `slack:` key for a session ingress
    // records under `feishu:` — a session nothing could then continue.
    return p === 'telegram' || p === 'webchat' || p === 'discord' || p === 'feishu' || p === 'hook' ? p : 'slack'
  }

  // ══════════════════════════ §3.4/§6.8 main-agent orchestration ══════════════════════════

  /**
   * Start an orchestration (§3.4/§6.8). ATOMIC ordering per §3.4:
   *   (a) RECORD-FIRST — persist the orchestration header + every subtask (status
   *       'pending') in one transaction BEFORE any delivery, so a fast worker's reply can
   *       never arrive before the record exists (§3.3 would otherwise drop it);
   *   (b) deliver each subtask via the existing `messageAgent` path, CAS-recording
   *       pending→sending→delivered | pending→sending→(delivered rollback)failed per subtask;
   *   (c) schedule the one-shot, session-anchored, cancelable cron deadline (if requested)
   *       — but only when at least one subtask actually delivered (all-failed ⇒ no wait).
   * The main identity + coords are the TRUSTED SessionContext (never tool input).
   */
  private async startOrchestration(req: StartOrchestrationReq): Promise<StartOrchestrationResult> {
    const orchestrationId = randomUUID()
    const platform = this.narrowPlatform(req.platform)
    // The main's session key is the exact coords its tool call ran under, so a deadline
    // fire and a worker report both key to the SAME session as the caller.
    const mainSessionKey = sessionKey(platform, req.channel, req.thread, req.mainAgentId, req.transportScope)
    const now = this.clock.now()
    const deadline =
      req.deadlineMs !== undefined && req.deadlineMs > 0 ? now + Math.min(req.deadlineMs, 2_147_483_647) : null

    const subtaskRows: SubtaskRow[] = req.subtasks.map((s, idx) => ({
      orchestrationId,
      correlationId: `${orchestrationId}.${idx}`,
      idx,
      toAgentId: s.toAgentId,
      text: s.text,
      status: 'pending',
      updatedAt: monotonicTs()
    }))

    const orch: OrchestrationRow = {
      orchestrationId,
      mainSessionKey,
      mainAgentId: req.mainAgentId,
      platform,
      channel: req.channel,
      thread: req.thread,
      integrationId: req.integrationId ?? null,
      replyTarget: req.replyTarget ?? null,
      deadline, // recorded up front (durable SoT); cleared to null if nothing delivers
      status: 'active',
      createdAt: now,
      updatedAt: now
    }

    // (a) RECORD-FIRST: must fully persist before we deliver anything.
    this.store.createOrchestration(orch, subtaskRows)
    this.emitEvaluation({
      type: 'orchestration.state',
      agentId: req.mainAgentId,
      sessionId: this.store.getSession(mainSessionKey)?.acpSessionId ?? undefined,
      platform,
      channel: req.channel,
      data: {
        orchestrationId,
        state: 'created',
        subtaskCount: subtaskRows.length,
        deadlineConfigured: deadline !== null
      }
    })

    // (b) Deliver each subtask, atomically recording delivered|failed.
    const delivered: string[] = []
    const failed: { correlationId: string; reason: string }[] = []
    for (const s of subtaskRows) {
      this.store.setSubtaskStatus(orchestrationId, s.correlationId, ['pending'], 'sending', monotonicTs())
      let result: MessageAgentResult
      try {
        result = await this.messageAgent({
          callerAgentId: req.mainAgentId,
          platform: req.platform,
          ...(req.integrationId !== undefined ? { callerIntegrationId: req.integrationId } : {}),
          ...(req.transportScope !== undefined ? { callerTransportScope: req.transportScope } : {}),
          callerChannel: req.channel,
          callerThread: req.thread,
          toAgentId: s.toAgentId,
          text: s.text,
          channel: req.channel,
          thread: req.thread,
          correlationId: s.correlationId
        })
      } catch (err) {
        result = { delivered: false, targetSession: '', reason: 'error' }
        this.log.warn(`orchestration ${orchestrationId}: delivery of ${s.correlationId} threw: ${formatErr(err)}`)
      }
      if (result.delivered) {
        this.store.setSubtaskStatus(orchestrationId, s.correlationId, ['sending'], 'delivered', monotonicTs())
        delivered.push(s.correlationId)
      } else {
        const reason = result.reason ?? 'undeliverable'
        // A failed delivery is terminal for this subtask (§3.4): it does NOT occupy a
        // "waiting" slot. Recorded as worker_error with the delivery reason.
        this.store.setSubtaskStatus(orchestrationId, s.correlationId, ['sending'], 'worker_error', monotonicTs(), {
          deliveryReason: reason
        })
        failed.push({ correlationId: s.correlationId, reason })
      }
    }

    // (c) Deadline: only arm when something is actually pending a reply. If everything
    // failed to deliver, there is nothing to wait for — clear the deadline (§3.4).
    if (deadline !== null && delivered.length > 0) {
      this.armOrchestrationDeadline(orchestrationId, deadline)
    } else if (deadline !== null) {
      this.store.setOrchestrationDeadline(orchestrationId, null, this.clock.now())
    }

    this.log.info(
      `orchestration ${orchestrationId}: ${delivered.length} delivered, ${failed.length} failed` +
        (deadline !== null && delivered.length > 0 ? `, deadline in ${deadline - now}ms` : '')
    )
    this.emitEvaluation({
      type: 'orchestration.state',
      agentId: req.mainAgentId,
      sessionId: this.store.getSession(mainSessionKey)?.acpSessionId ?? undefined,
      platform,
      channel: req.channel,
      data: { orchestrationId, state: 'dispatched', delivered: delivered.length, failed: failed.length }
    })
    return { orchestrationId, delivered, failed }
  }

  /** Arm (or re-arm) the one-shot, session-anchored deadline for an orchestration. On fire
   *  it wakes the main's session DIRECTLY (dispatch to mainSessionKey) — NOT via fireTrigger
   *  (which would post a channel anchor / open a new thread). Idempotent: replaces any
   *  existing timer for this id. Clamped to setTimeout's 32-bit ceiling. */
  private armOrchestrationDeadline(orchestrationId: string, deadlineEpoch: number): void {
    const existing = this.orchestrationDeadlines.get(orchestrationId)
    if (existing !== undefined) this.clock.clearTimeout(existing)
    const delay = Math.min(Math.max(0, deadlineEpoch - this.clock.now()), 2_147_483_647)
    const handle = this.clock.setTimeout(() => {
      this.orchestrationDeadlines.delete(orchestrationId)
      this.fireOrchestrationDeadline(orchestrationId)
    }, delay)
    this.orchestrationDeadlines.set(orchestrationId, handle)
  }

  /** Deadline fired (§3.5): mark every still-open subtask timed_out, then WAKE the main's
   *  session so it re-reads getOrchestration and summarizes the partial result. The wake is
   *  a direct dispatch to the stored session coords — no platform post, no new thread. */
  private fireOrchestrationDeadline(orchestrationId: string): void {
    const orch = this.store.getOrchestration(orchestrationId)
    if (!orch || orch.status !== 'active') return // cancelled / completed → nothing to do
    // Mark unreported (delivered but not yet reported, or still sending/pending) as timed_out.
    for (const s of this.store.getSubtasks(orchestrationId)) {
      this.store.setSubtaskStatus(
        orchestrationId,
        s.correlationId,
        ['pending', 'sending', 'delivered'],
        'timed_out',
        monotonicTs()
      )
    }
    this.store.setOrchestrationDeadline(orchestrationId, null, this.clock.now())
    this.emitEvaluation({
      type: 'orchestration.state',
      agentId: orch.mainAgentId,
      sessionId: this.store.getSession(orch.mainSessionKey)?.acpSessionId ?? undefined,
      platform: orch.platform,
      channel: orch.channel,
      data: { orchestrationId, state: 'timed_out' }
    })
    this.wakeOrchestrationMain(orch, `orchestration ${orchestrationId} deadline reached — summarize what you have`)
  }

  /** Wake the orchestration's owning main session with a synthetic agent-source turn keyed
   *  to the exact stored coords (so it lands in the same session that started it). Headless
   *  is NOT set — the main needs its reply transport to post the summary. */
  private wakeOrchestrationMain(orch: OrchestrationRow, text: string): void {
    const platform = this.narrowPlatform(orch.platform)
    const msgId = `orchestration:${orch.orchestrationId}:${monotonicTs()}`
    const msg: NormalizedMessage = {
      msgId,
      traceId: orch.orchestrationId,
      source: 'agent',
      platform,
      channel: orch.channel,
      thread: orch.thread,
      sender: { id: `orchestration:${orch.orchestrationId}`, isBot: true },
      text,
      mentionedBots: [],
      isDm: false
    }
    void this.dispatch(orch.mainAgentId, msg, orch.integrationId ?? undefined).catch((err) =>
      this.log.error(`orchestration ${orch.orchestrationId}: deadline wake dispatch failed: ${formatErr(err)}`)
    )
  }

  /** §3.3 correlation-recording hook, called from dispatchOne when the MAIN receives a
   *  messageAgent turn carrying a correlationId. Records the worker's result into the
   *  orchestration ONLY if ALL four safety checks hold; any failure drops the report
   *  (debug log) and never corrupts completion. Uses ONLY trusted values (callMeta.callFrom,
   *  the receiving session key) — never a frame/prompt field. */
  private recordWorkerReport(receivingSessionKey: string, callMeta: CallMeta, reportText: string): void {
    const correlationId = callMeta.correlationId
    if (correlationId === undefined) return
    // correlationId = "<orchestrationId>.<idx>" — the orchestrationId is everything before
    // the final '.' (a UUID contains no '.', and idx is a trailing integer).
    const dot = correlationId.lastIndexOf('.')
    if (dot <= 0) return
    const orchestrationId = correlationId.slice(0, dot)
    const orch = this.store.getOrchestration(orchestrationId)
    if (!orch) return // (b) unknown orchestration
    // (a) owning session: the report must arrive in the SAME session that owns it.
    if (orch.mainSessionKey !== receivingSessionKey) {
      this.log.debug(`orchestration ${orchestrationId}: report dropped — session mismatch`)
      return
    }
    if (orch.status !== 'active') {
      this.log.debug(`orchestration ${orchestrationId}: report dropped — orchestration ${orch.status}`)
      return
    }
    const sub = this.store.getSubtaskByCorrelation(orchestrationId, correlationId)
    if (!sub) return // (b) correlationId maps to no subtask
    // (c) the reporter IS the tasked worker — TRUSTED callFrom, not a frame field.
    if (callMeta.callFrom !== sub.toAgentId) {
      this.log.debug(
        `orchestration ${orchestrationId}: report for ${correlationId} dropped — ` +
          `reporter "${callMeta.callFrom}" ≠ tasked worker "${sub.toAgentId}"`
      )
      return
    }
    // (d) idempotent: only an OPEN subtask (sending|delivered|timed_out) is recorded. A
    // duplicate report (already succeeded/worker_error) is a no-op. A late report AFTER
    // timeout IS allowed to update the summary (timed_out → succeeded), idempotently.
    const ok = this.store.setSubtaskStatus(
      orchestrationId,
      correlationId,
      ['sending', 'delivered', 'timed_out'],
      'succeeded',
      monotonicTs(),
      { result: reportText }
    )
    if (ok) {
      this.log.info(`orchestration ${orchestrationId}: recorded result for ${correlationId} from ${callMeta.callFrom}`)
      this.emitEvaluation({
        type: 'orchestration.state',
        agentId: orch.mainAgentId,
        sessionId: this.store.getSession(orch.mainSessionKey)?.acpSessionId ?? undefined,
        platform: orch.platform,
        channel: orch.channel,
        data: { orchestrationId, correlationId, state: 'worker_reported', workerAgentId: callMeta.callFrom }
      })
    } else {
      this.log.debug(`orchestration ${orchestrationId}: duplicate/late report for ${correlationId} — no-op`)
    }
  }

  private getOrchestrationForOwner(req: OrchestrationOwnerReq): unknown | null {
    const orch = this.ownedOrchestration(req)
    if (!orch) return null
    return {
      orchestrationId: orch.orchestrationId,
      status: orch.status,
      deadline: orch.deadline ?? null,
      replyTarget: orch.replyTarget ?? null,
      createdAt: orch.createdAt,
      subtasks: this.store.getSubtasks(orch.orchestrationId).map((s) => ({
        correlationId: s.correlationId,
        toAgentId: s.toAgentId,
        status: s.status,
        result: s.result ?? null,
        ...(s.deliveryReason ? { deliveryReason: s.deliveryReason } : {})
      }))
    }
  }

  private cancelOrchestrationForOwner(req: OrchestrationOwnerReq): boolean {
    const orch = this.ownedOrchestration(req)
    if (!orch) return false
    // Idempotent: cancel the deadline timer (if any) + write the cancelled tombstone. The
    // record is KEPT (not deleted). Already-delivered workers aren't recalled — a late report
    // after cancellation is ignored (recordWorkerReport drops on status !== 'active').
    const handle = this.orchestrationDeadlines.get(orch.orchestrationId)
    if (handle !== undefined) {
      this.clock.clearTimeout(handle)
      this.orchestrationDeadlines.delete(orch.orchestrationId)
    }
    this.store.setOrchestrationDeadline(orch.orchestrationId, null, this.clock.now())
    this.store.setOrchestrationStatus(orch.orchestrationId, 'cancelled', this.clock.now())
    this.emitEvaluation({
      type: 'orchestration.state',
      agentId: orch.mainAgentId,
      sessionId: this.store.getSession(orch.mainSessionKey)?.acpSessionId ?? undefined,
      platform: orch.platform,
      channel: orch.channel,
      data: { orchestrationId: orch.orchestrationId, state: 'cancelled' }
    })
    return true
  }

  /** Resolve an orchestration IFF the requesting main+session OWNS it (§3.5a owner check).
   *  Returns undefined on unknown id or any owner mismatch. */
  private ownedOrchestration(req: OrchestrationOwnerReq): OrchestrationRow | undefined {
    const orch = this.store.getOrchestration(req.orchestrationId)
    if (!orch) return undefined
    const requesterKey = sessionKey(
      this.narrowPlatform(req.platform),
      req.channel,
      req.thread,
      req.mainAgentId,
      req.transportScope
    )
    if (orch.mainSessionKey !== requesterKey || orch.mainAgentId !== req.mainAgentId) return undefined
    return orch
  }

  /** Startup re-arm (§3.5): re-arm the one-shot deadline for every still-active orchestration
   *  from the durable `deadline` epoch. A deadline already in the past fires ~immediately.
   *  Mirrors replayInbox's read-active-rows/re-schedule pattern; idempotent. */
  private rearmOrchestrationDeadlines(): void {
    let active: OrchestrationRow[]
    try {
      active = this.store.listActiveOrchestrations()
    } catch (err) {
      this.log.warn(`orchestration: deadline re-arm read failed: ${(err as Error).message}`)
      return
    }
    let armed = 0
    for (const orch of active) {
      if (orch.deadline == null) continue
      this.armOrchestrationDeadline(orch.orchestrationId, orch.deadline)
      armed++
    }
    if (armed) this.log.info(`orchestration: re-armed ${armed} deadline(s) on startup`)
  }

  /**
   * Ack-verdict gate for one hook fire (`rd/msg` hook member) — the mirror of
   * {@link dispatchWebchatTurn}'s synchronous gates: the relay's rc/run-report
   * needs a REASONED rejection now, not a silently dropped fire-and-forget
   * dispatch. Accepted is returned only after {@link onHookFire} has crossed
   * the durable-inbox admission barrier; the model turn itself remains async.
   */
  private async dispatchRelayHook(msg: RdMsgHook): Promise<RdAck> {
    if (!this.agents.has(msg.agentId)) {
      this.log.warn(`hook: no agent "${msg.agentId}" on this daemon — rejecting fire ${msg.msgId}`)
      return { msgId: msg.msgId, accepted: false, reason: 'no_agent' }
    }
    if (this.paused(msg.agentId)) {
      this.log.info(`hook: agent "${msg.agentId}" is paused — rejecting fire ${msg.msgId}`)
      return { msgId: msg.msgId, accepted: false, reason: 'paused' }
    }
    if (this.safetyDrainingAgents.has(msg.agentId)) {
      this.log.info(`hook: agent "${msg.agentId}" is stopping an interrupted turn — rejecting fire ${msg.msgId}`)
      return { msgId: msg.msgId, accepted: false, reason: 'busy' }
    }
    if (this.draining || this.drainingAgents.has(msg.agentId)) {
      this.log.info(`hook: agent "${msg.agentId}" is draining — rejecting fire ${msg.msgId}`)
      return { msgId: msg.msgId, accepted: false, reason: 'draining' }
    }
    const admission = await this.onHookFire(msg)
    return {
      msgId: msg.msgId,
      accepted: admission.accepted,
      ...(admission.reason ? { reason: admission.reason } : {})
    }
  }

  /**
   * A hook fired for `agentId` (explicit target — no routing;
   * webhook-triggers-and-github-events.md). The relay already opened the HookRun
   * row (`rc/run-report accepted`); when the turn ends this closes it with a
   * completion `hook/report` EVT on the control WS (the cron/report pattern).
   * Anchoring rides the shared {@link fireTrigger} path: with a target the
   * trigger text lands in the channel and the session threads under it,
   * without one the fire runs headless.
   */
  private async onHookFire(msg: RdMsgHook): Promise<{ accepted: boolean; reason?: string }> {
    const nmsg = buildHookMessage(msg, randomUUID())
    // The in-memory ACK cache closes same-process retransmits. This durable
    // probe closes the restart window *before* anchorTrigger posts externally:
    // a retained live row will replay, and a terminal row is already complete.
    // In either case the original accepted admission owns this delivery.
    if (this.store.hasInbox(nmsg.msgId)) {
      this.log.debug(`hook: durable duplicate ${nmsg.msgId} — replaying accepted admission`)
      return { accepted: true }
    }
    const snapshot = hookSnapshot(msg)
    const hookContext: HookDispatchContext = {
      hookId: msg.hookId,
      agentId: msg.agentId,
      deliveryKey: msg.deliveryKey,
      firedAt: msg.firedAt,
      ...(msg.event ? { event: msg.event } : {}),
      ...(snapshot ? { snapshot } : {}),
      ...(msg.github ? { github: msg.github } : {})
    }
    // P3 outbound: github fires on a NUMBERED thread publish their completed reply as
    // one comment (always on — design; push fires have no thread and stay silent).
    const c = msg.context
    // A GitHub `deleted` action (the issue/PR/comment was removed) is a teardown
    // signal, not a work request: if this thread never had a session, there is
    // nothing to react to, so don't spin up a brand-new session just to observe
    // the deletion (it would only orphan a session pointing at a gone thread).
    // Fire only when a session already exists for the thread's affinity key. A
    // targeted fire keys a fresh per-delivery session (thread === msgId), so it
    // has no prior session to gate on and is left alone; deleted github fires run
    // headless in practice. The relay already opened the HookRun row, so close it
    // honestly as a no-op success rather than orphaning it.
    if (c?.source === 'github' && c.action === 'deleted' && !msg.target) {
      const key = sessionKey(nmsg.platform, nmsg.channel, nmsg.thread ?? nmsg.msgId, msg.agentId)
      if (!this.store.getSession(key)?.acpSessionId) {
        this.log.info(`hook: skipping github ${c.event ?? 'event'}:deleted fire ${msg.msgId} — no session for ${key}`)
        // Preserve R2a's admission/outbox guarantee even though this teardown
        // event deliberately does not enter the turn engine: persist the stable
        // delivery first, then atomically redact it into a terminal receipt.
        const entry: QueueEntry = {
          agentId: msg.agentId,
          msg: nmsg,
          initAbort: new AbortController(),
          hookContext,
          resolve: () => {},
          reject: () => {}
        }
        const persistence = this.persistInbox(entry, key, { required: true })
        if (persistence !== 'existing') {
          this.emitHookCompletion(hookContext, 'success', { reason: 'deleted: no existing session' }, entry)
        }
        return { accepted: true }
      }
    }
    const trustedInlineTarget =
      c?.source === 'github' &&
      msg.github?.subjectKind === 'pull_request' &&
      msg.github.pullNumber !== undefined &&
      msg.github.reviewThreadRootCommentId !== undefined
        ? {
            hookId: msg.hookId,
            repo: msg.github.repoFullName,
            number: msg.github.pullNumber,
            ...(msg.github.reviewCommentId ? { reviewCommentId: msg.github.reviewCommentId } : {}),
            reviewThreadRootCommentId: msg.github.reviewThreadRootCommentId
          }
        : undefined
    // Inline coordinates and their PR target are one body-free trusted unit.
    // A mixed-version frame without that unit keeps the rolling-compatible
    // ordinary issue/PR comment path derived from HookContext.
    const githubReply =
      trustedInlineTarget ??
      (c?.source === 'github' && c.repo && c.number !== undefined
        ? { hookId: msg.hookId, repo: c.repo, number: c.number }
        : undefined)
    if (githubReply) hookContext.githubReply = githubReply
    const anchored = await this.anchorTrigger(
      msg.agentId,
      nmsg,
      msg.target,
      hookAnchorText(msg),
      `hook "${msg.hookId}"`
    )
    if (!anchored) return { accepted: false, reason: 'dropped' }
    let admission: { accepted: boolean; reason?: string; duplicate?: boolean } | undefined
    const turn = this.dispatch(
      msg.agentId,
      anchored,
      msg.target?.integrationId,
      undefined,
      undefined,
      {
        requireDurable: true,
        onAdmission: (result) => {
          admission = result
        }
      },
      githubReply,
      hookContext
    )
    // dispatch() performs admission synchronously inside its Promise executor.
    // Consume the full-turn promise now, but never make rd/ack wait for the model.
    // Every accepted terminal path is owned by runLoop/dispatchOne and emits its
    // durable receipt there; observing a null here as well used to double-report
    // queued entries that were gate-dropped before their turn began.
    void turn.catch((err) => this.log.error(`hook turn failed for agent "${msg.agentId}": ${formatErr(err)}`))
    if (!admission) throw new Error('hook admission barrier did not settle synchronously')
    if (!admission.accepted) {
      return { accepted: false, reason: admission.reason ?? 'durability' }
    }
    return { accepted: true }
  }

  /** Resolve a PR revision if the webhook omitted it (notably
   * issue_comment), cross the CP hook/start barrier, then return the active
   * review authority. Failure only disables structured effects; the agent turn
   * continues, while ordinary fallback remains governed by durable formal-
   * attempt state. */
  private async prepareGithubTurn(entry: QueueEntry, sessionId: string): Promise<ActiveGithubTurnMeta | undefined> {
    const hook = entry.hookContext
    const snapshot = hook?.snapshot
    const github = hook?.github
    if (
      !hook ||
      !snapshot ||
      !github ||
      github.subjectKind !== 'pull_request' ||
      github.pullNumber === undefined ||
      (snapshot.reviewPolicy === 'off' && snapshot.reportingMode === 'off') ||
      snapshot.gateMode !== 'informational' ||
      snapshot.reportingMode === 'status'
    )
      return undefined
    if (this.cfg.daemonId && snapshot.dispatchDaemonId !== this.cfg.daemonId) {
      this.log.warn(`github review: stale dispatch daemon for ${hook.hookId}:${hook.deliveryKey}`)
      return undefined
    }

    if (!github.headSha || !github.baseSha) {
      try {
        const postToken = await this.gitCreds.getPostToken(hook.agentId, github.repoFullName, hook.hookId)
        const revision = await this.githubReviewClient.getPull(postToken.token, github.repoFullName, github.pullNumber)
        hook.github = {
          ...github,
          headSha: revision.headSha,
          baseSha: revision.baseSha,
          reportSha: revision.headSha,
          isDraft: revision.draft
        }
        this.persistHookState(entry, undefined, true)
      } catch (err) {
        this.log.warn(`github review: unable to resolve PR revision (${formatErr(err)})`)
        return undefined
      }
    }

    const trusted = hook.github!
    if (!trusted.headSha || !trusted.baseSha || trusted.pullNumber === undefined) return undefined
    const client = this.cpClient
    if (!client) return undefined
    const payload = {
      hookId: hook.hookId,
      agentId: hook.agentId,
      deliveryKey: hook.deliveryKey,
      sessionId,
      ...(hook.event ? { event: hook.event } : {}),
      github: { ...trusted, reportSha: trusted.reportSha ?? trusted.headSha },
      ...snapshot
    }
    let started = false
    for (let attempt = 0; attempt < 3 && !started; attempt += 1) {
      try {
        await client.startHook(payload)
        started = true
      } catch (err) {
        if (attempt === 2) {
          this.log.warn(`github review: hook/start rejected (${formatErr(err)})`)
          return undefined
        }
        // The daemon ACK and relay rc/run-report travel on different sockets;
        // let the accepted row land before repeating this idempotent barrier.
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
      }
    }
    if (snapshot.reviewPolicy === 'off' || isGithubReviewCommentHook(hook)) return undefined
    const recoverableAttempt =
      hook.reviewAttemptId !== undefined &&
      hook.reviewRequestedEvent !== undefined &&
      hook.reviewRequestedVerdict !== undefined &&
      (hook.reviewResult === undefined || hook.reviewResult.state === 'ambiguous')
    const active: ActiveGithubTurnMeta = {
      entry,
      hook,
      snapshot,
      repoId: trusted.repoId,
      repoFullName: trusted.repoFullName,
      pullNumber: trusted.pullNumber,
      expectedHeadSha: trusted.headSha,
      expectedBaseSha: trusted.baseSha,
      reportSha: trusted.reportSha ?? trusted.headSha,
      sessionId,
      reviewState: hook.reviewAttemptId === undefined || recoverableAttempt ? 'idle' : 'done'
    }
    if (recoverableAttempt) await this.reconcileGithubReviewAttempt(active)
    return active
  }

  /** Store the immediate and terminal-report copies together so they cannot
   * drift across submit and restart-recovery paths. */
  private persistGithubReviewEffect(
    active: ActiveGithubTurnMeta,
    attemptId: string,
    effect: GithubReviewEffect,
    required = false
  ): HookReviewResult {
    const result = reviewResultForWire(effect)
    active.hook.reviewResult = result
    active.hook.reviewReportAttemptId = attemptId
    active.hook.reviewReportResult = result
    this.persistHookState(active.entry, undefined, required)
    return result
  }

  /** A daemon restart may replay an attempt after an ambiguous POST/list race.
   * Before prompting the model, perform a GET-only marker reconciliation. A
   * still-missing marker remains blocked; only an explicit tool invocation can
   * cross the full reauthorization + revision fence and retry the mutation. */
  private async reconcileGithubReviewAttempt(active: ActiveGithubTurnMeta): Promise<void> {
    const cp = this.cpClient
    const attemptId = active.hook.reviewAttemptId
    const requestedEvent = active.hook.reviewRequestedEvent
    const requestedVerdict = active.hook.reviewRequestedVerdict
    if (!cp || !attemptId || !requestedEvent || !requestedVerdict) return
    try {
      const authorized = await cp.authorizeGithubReview({
        hookId: active.hook.hookId,
        deliveryKey: active.hook.deliveryKey,
        attemptId,
        requestedEvent,
        requestedVerdict,
        snapshot: active.snapshot
      })
      if (!authorizedReviewTargetMatches(active, attemptId, authorized)) {
        this.log.warn('github review: recovery authorization returned a mismatched target')
        return
      }
      const effect = await this.githubReviewClient.reconcile(
        authorizedReviewTarget(active, attemptId, authorized, true),
        requestedEvent,
        requestedVerdict
      )
      // Reconciliation never proves a no-effect result: a visible marker is
      // submitted; a missing/unreadable marker remains ambiguous. Persist and
      // report both so restart completion carries the current attempt outcome
      // and the CP reservation converges to submitted or blocked.
      if (effect.state === 'not_submitted') return
      const result = this.persistGithubReviewEffect(active, attemptId, effect, true)
      await cp.reportGithubReviewResult({
        hookId: active.hook.hookId,
        deliveryKey: active.hook.deliveryKey,
        attemptId,
        snapshot: active.snapshot,
        result
      })
      // Ambiguous keeps the same durable attempt eligible for an explicit
      // marker-first retry; submitted is terminal for this turn.
      active.reviewState = effect.state === 'ambiguous' ? 'idle' : 'done'
    } catch (err) {
      this.log.warn(`github review: replay reconciliation deferred (${formatErr(err)})`)
    }
  }

  private async submitGithubReview(req: SubmitGithubReviewReq): Promise<GithubReviewEffect> {
    const key = sessionKey(req.platform, req.channel, req.thread, req.agentId, req.transportScope)
    const active = this.activeGithubTurnMeta.get(key)
    if (!active || active.hook.agentId !== req.agentId) {
      throw new Error('formal GitHub review is only available during the active PR hook turn')
    }
    if (isGithubReviewCommentHook(active.hook)) {
      throw new Error('formal GitHub review is unavailable for an inline review-comment reply turn')
    }
    if (!reviewPolicyAllows(active.snapshot.reviewPolicy, req.event)) {
      throw new Error(`${req.event} exceeds this hook's ${active.snapshot.reviewPolicy} review policy`)
    }
    if (active.reviewState !== 'idle') {
      throw new Error('this PR hook turn already has a formal review attempt')
    }
    // Synchronous turn-local CAS before the first await.
    active.reviewState = 'submitting'
    const previousReviewState = {
      reviewAttemptId: active.hook.reviewAttemptId,
      reviewRequestedEvent: active.hook.reviewRequestedEvent,
      reviewRequestedVerdict: active.hook.reviewRequestedVerdict,
      reviewResult: active.hook.reviewResult,
      reviewReportAttemptId: active.hook.reviewReportAttemptId,
      reviewReportResult: active.hook.reviewReportResult
    }
    const recovering = active.hook.reviewAttemptId !== undefined
    if (recovering) {
      if (
        active.hook.reviewRequestedEvent === undefined ||
        active.hook.reviewRequestedVerdict === undefined ||
        active.hook.reviewRequestedEvent !== req.event ||
        active.hook.reviewRequestedVerdict !== req.verdict
      ) {
        active.reviewState = 'idle'
        throw new Error('a recovered formal-review attempt must keep its original event and verdict')
      }
    } else {
      if (!githubFallbackAllowed(active.hook)) {
        active.reviewState = 'done'
        throw new Error('a fresh formal-review retry requires the prior attempt to be definitively not_submitted')
      }
      // A prior definite no-effect attempt may have been retained only for the
      // terminal HookReport. A fresh retry supersedes it: clear every unversioned
      // result before the record-first write so a crash cannot mistake the old
      // `not_submitted` outcome for proof that this new attempt had no effect.
      delete active.hook.reviewResult
      delete active.hook.reviewReportAttemptId
      delete active.hook.reviewReportResult
      active.hook.reviewRequestedEvent = req.event
      active.hook.reviewRequestedVerdict = req.verdict
    }
    const attemptId = active.hook.reviewAttemptId ?? randomUUID()
    active.hook.reviewAttemptId = attemptId
    const entry = active.entry
    try {
      // RECORD-FIRST: after this point a crash/replay knows it must reconcile
      // the marker before any possible second POST.
      this.persistHookState(entry, undefined, true)
    } catch (err) {
      if (!recovering) {
        Object.assign(active.hook, previousReviewState)
      }
      active.reviewState = 'idle'
      throw new Error(`formal review durability barrier failed: ${formatErr(err)}`)
    }

    const cp = this.cpClient
    if (!cp) {
      active.reviewState = 'done'
      throw new Error('control plane is not connected; formal review denied')
    }
    let authorized: Awaited<ReturnType<CpClient['authorizeGithubReview']>>
    try {
      authorized = await cp.authorizeGithubReview({
        hookId: active.hook.hookId,
        deliveryKey: active.hook.deliveryKey,
        attemptId,
        requestedEvent: req.event,
        requestedVerdict: req.verdict,
        snapshot: active.snapshot
      })
    } catch (err) {
      active.reviewState = 'done'
      throw err
    }
    if (!authorizedReviewTargetMatches(active, attemptId, authorized)) {
      active.reviewState = 'done'
      throw new Error('control plane returned a mismatched formal-review target')
    }

    const effect = await this.githubReviewClient.submit(
      authorizedReviewTarget(active, attemptId, authorized, recovering),
      req,
      this.agents.get(req.agentId)?.output.showFooter
        ? this.githubCommentAttribution(req.agentId, active.sessionId)
        : undefined
    )
    const result = this.persistGithubReviewEffect(active, attemptId, effect)
    try {
      await cp.reportGithubReviewResult({
        hookId: active.hook.hookId,
        deliveryKey: active.hook.deliveryKey,
        attemptId,
        snapshot: active.snapshot,
        result
      })
      if (effect.state === 'not_submitted') {
        // CP proved/released the no-effect reservation; this turn may correct
        // its input and try again with a fresh attempt id.
        delete active.hook.reviewAttemptId
        delete active.hook.reviewRequestedEvent
        delete active.hook.reviewRequestedVerdict
        delete active.hook.reviewResult
        active.reviewState = 'idle'
        this.persistHookState(entry)
      } else if (effect.state === 'ambiguous') {
        // The reservation and semantic input stay fixed. A later tool call may
        // only reconcile that same marker (and, after a complete no-marker
        // read plus fresh fences, retry the same logical attempt).
        active.reviewState = 'idle'
      } else {
        active.reviewState = 'done'
      }
    } catch (err) {
      // Completion repeats the body-free result. Submitted/definite failures
      // never retry; an ambiguous attempt remains eligible only for the
      // marker-first recovery path above.
      active.reviewState = effect.state === 'ambiguous' ? 'idle' : 'done'
      this.log.warn(`github review: immediate result report failed (${formatErr(err)})`)
    }
    return effect
  }

  /** The op-switch behind {@link handleRelayMsg} (dedup handled by the caller). */
  private dispatchRelayOp(msg: RdMsgWebchat, chat: (event: RdChatEvent) => void): RdAck {
    const sink: WebchatSink = {
      output: (o) => chat({ kind: 'output', output: o }),
      done: (d) => chat({ kind: 'done', done: d })
    }
    const op = msg.payload
    const key = (): string => this.webchatSessionKey(msg.chatId, msg.agentId)
    switch (op.op) {
      case 'turn': {
        const ack = this.dispatchWebchatTurn(
          msg.agentId,
          msg.chatId,
          op.text,
          op.user ?? 'webchat',
          sink,
          op.turnId,
          op.attachments,
          op.runtime,
          msg.delegation
        )
        return {
          msgId: msg.msgId,
          accepted: ack.accepted,
          turnId: ack.turnId,
          ...(ack.reason ? { reason: ack.reason } : {})
        }
      }
      case 'resume': {
        const resumed = this.resumeWebchatStream(msg.agentId, msg.chatId, op.turnId, op.generation, op.afterIndex, sink)
        return {
          msgId: msg.msgId,
          accepted: resumed.accepted,
          ...(resumed.turnId ? { turnId: resumed.turnId } : {}),
          ...(resumed.reason ? { reason: resumed.reason } : {})
        }
      }
      case 'set_model':
        return this.setModelByKey(key(), op.model)
          ? { msgId: msg.msgId, accepted: true }
          : { msgId: msg.msgId, accepted: false, reason: 'runtime changes are disabled in chat' }
      case 'set_effort':
        return this.setEffortByKey(key(), op.effort)
          ? { msgId: msg.msgId, accepted: true }
          : { msgId: msg.msgId, accepted: false, reason: 'runtime changes are disabled in chat' }
      case 'set_permission_mode':
        return this.setPermissionModeByKey(key(), op.permissionMode)
          ? { msgId: msg.msgId, accepted: true }
          : { msgId: msg.msgId, accepted: false, reason: 'runtime changes are disabled in chat' }
      case 'set_fast':
        return this.setFastByKey(key(), op.fastMode)
          ? { msgId: msg.msgId, accepted: true }
          : { msgId: msg.msgId, accepted: false, reason: 'runtime changes are disabled in chat' }
      case 'cancel':
        this.handleWebchatCancel(msg.chatId)
        return { msgId: msg.msgId, accepted: true }
      case 'close':
        this.handleWebchatClose(msg.chatId)
        return { msgId: msg.msgId, accepted: true }
    }
  }

  /** Route a Slack status-bar Block Kit interaction (model / effort / fast select or the
   *  Cancel button) to the shared key-based cores. `sessionKey` rides the block; no-op on
   *  an unknown key. */
  private handleStatusAction(a: {
    kind: 'set-model' | 'set-effort' | 'set-permission-mode' | 'set-fast' | 'set-output' | 'cancel'
    sessionKey: string
    actor?: InteractionActor
    model?: string
    effort?: string
    permissionMode?: string
    fastMode?: boolean
    outputMode?: 'none' | 'minimal' | 'low' | 'medium' | 'high'
  }): void {
    // A status-bar tap carries no author in the transcript, so the operator behind a
    // cancelled turn or a switched model is otherwise unrecoverable. Record it here,
    // at the one point every ingress funnels through — but only when the verb actually
    // applied, so a refused or no-op click never reads as a change someone made.
    let applied = false
    if (a.kind === 'cancel') applied = this.cancelSessionByKey(a.sessionKey)
    else if (a.kind === 'set-model') {
      if (a.model) applied = this.setModelByKey(a.sessionKey, a.model)
    } else if (a.kind === 'set-effort') {
      if (a.effort) applied = this.setEffortByKey(a.sessionKey, a.effort)
    } else if (a.kind === 'set-permission-mode') {
      if (a.permissionMode) applied = this.setPermissionModeByKey(a.sessionKey, a.permissionMode)
    } else if (a.kind === 'set-fast') {
      if (a.fastMode !== undefined) applied = this.setFastByKey(a.sessionKey, a.fastMode)
    } else if (a.kind === 'set-output') {
      if (a.outputMode) applied = this.setOutputModeByKey(a.sessionKey, a.outputMode)
    }
    if (applied) this.logSessionAction(a.kind, a.sessionKey, a.actor)
  }

  /**
   * A tapped Discord select-card button (`/models` `/effort` `/permission`): resolve the
   * session from the button's key, apply the chosen option, and return the re-rendered
   * card so the connection edits the message in place (new current flagged). Undefined
   * when the session is gone or the option index is stale (options changed) — the
   * connection then leaves the card as-is. Mirrors handleTelegramCallback.
   */
  private handleDiscordSelect(a: {
    kind: SelectKind
    index: number
    sessionKey: string
    actor?: InteractionActor
  }): { text: string; components: DiscordComponents } | undefined {
    const rec = this.store.getSession(a.sessionKey)
    if (!rec) return undefined
    const info = this.statusInfoFrom(rec.agentId, a.sessionKey, rec.acpSessionId ?? undefined)
    const { options } = this.selectOptions(a.kind, info)
    const value = options[a.index]
    if (value === undefined) return undefined
    // Recorded only once the choice actually applied — a refused or stale select
    // changes nothing and must not read as though someone had changed it. The card is
    // still re-rendered either way, as before.
    if (this.applySelect(a.kind, a.sessionKey, value)) this.logSessionAction(`select:${a.kind}`, a.sessionKey, a.actor)
    const components = buildDiscordSelectComponents(a.kind, value, options)
    if (!components) return undefined
    return { text: this.selectCardText(a.kind, value), components }
  }

  /** Record an unrouted inbound message into the transcript iff a session is
   *  *recently active* in its thread (§8.5 catch-up). Platform ingresses have already
   *  removed their own echoes. The recency gate bounds
   *  transcript growth to threads with live work — without it, a thread that ever
   *  held a session would record forever (no session-`closed` lifecycle yet). */
  private recordUnrouted(msg: NormalizedMessage): void {
    const { thread, ts } = transcriptCoords(msg)
    const transcriptChannel = transcriptChannelKey(msg.channel, msg.transportScope)
    // Active = a session touched within the idle window OR a turn in flight right
    // now. The in-flight check is load-bearing: session.updatedAt is stamped at
    // turn START, so a single long turn (> idle timeout — common for coding agents)
    // would otherwise look stale and we'd wrongly drop a message that arrives while
    // the agent is still working, defeating the catch-up it's meant to enable.
    const sinceTs = Date.now() - this.cfg.limits.agentIdleTimeoutMs
    const recentlyActive = this.store.activeSessionCountSince(msg.channel, thread, sinceTs, msg.transportScope) > 0
    const inFlight = [...this.pending.values()].some(
      (p) => p.transcriptChannel === transcriptChannel && p.statusThread === thread
    )
    if (!recentlyActive && !inFlight) return
    this.store.appendTranscript({
      channel: transcriptChannel,
      thread,
      ts,
      sender: msg.sender.id,
      kind: 'text',
      text: msg.text
    })
    this.log.debug(`transcript: recorded unrouted msg ch=${msg.channel} thread=${thread} ts=${ts} (live session)`)
  }

  /**
   * Pull real Slack thread history for cold backfill or a warm-turn snapshot
   * (§8.4/§8.5/§9.2), relabeling
   * THIS agent's own past bot frames to its agentId (so the §8.5 own-message filter
   * still suppresses them) and folding any attachment metadata into the text (so
   * cold replay matches the live transcript's `[attached: …]` mention).
   */
  private async fetchThreadHistory(
    agentId: string,
    channel: string,
    threadTs: string,
    cutoffTs?: string,
    afterTs?: string | null
  ): Promise<{ sender: string; ts: string; text: string; trustedAgentBot?: boolean }[]> {
    const conn = this.replyConnFor(agentId) as Partial<SlackConnection> | undefined
    // Only Slack can pull thread history (conversations.replies). Telegram long-poll
    // has no arbitrary-history API, so a cold mid-thread mention just starts fresh.
    // Duck-typed (method presence) so test fakes work as well as a real SlackConnection.
    if (typeof conn?.getThreadReplies !== 'function') return []
    const ours = new Set([conn.botUserId, conn.botId].filter(Boolean))
    const replies = await conn.getThreadReplies(channel, threadTs, 200, {
      ...(afterTs ? { oldest: afterTs } : {}),
      ...(cutoffTs ? { latest: cutoffTs } : {})
    })
    return (
      replies
        .map((reply) => ({
          reply,
          // Slack metadata event names and payloads are app-defined. Trust AgentConnect
          // authorship/chrome only when the provider identity belongs to one of our local
          // bots or to a CP-advertised AgentConnect app in this channel.
          trustedAgentBot: reply.isBot && this.isManagedSlackBotIdentity(channel, reply.sender, reply.appId)
        }))
        // Skip daemon CHROME (status bar, progress/plan/reasoning, notices, cards). It is not
        // conversation and must not be re-ingested as a transcript text row. The legacy
        // status-bar text fallback is provenance-gated too, so another app or a human cannot
        // make ordinary conversation disappear by copying AgentConnect's marker or text.
        .filter(
          ({ reply, trustedAgentBot }) => !trustedAgentBot || (!reply.chrome && !isSlackStatusBarText(reply.text))
        )
        .map(({ reply: r, trustedAgentBot }) => {
          const mention = attachmentMention(r.attachments)
          return {
            // A shareable Slack app gives every agent-authored message the same bot_id.
            // Prefer stable per-message metadata only after verifying the producing app,
            // so an unrelated app cannot impersonate this or a peer Agent and trip the
            // SessionManager own-author filter.
            sender:
              (trustedAgentBot ? r.agentAuthorId : undefined) ?? (r.isBot && ours.has(r.sender) ? agentId : r.sender),
            ts: r.ts,
            text: mention ? `${r.text}\n${mention}`.trim() : r.text,
            ...(trustedAgentBot ? { trustedAgentBot: true } : {})
          }
        })
    )
  }

  // ── §4.3/§6.9 per-sessionKey serial admission gate ────────────────────────────
  // The UNIFIED admission queue (design §6.9 #390): one FIFO per LOGICAL sessionKey
  // (platform:channel:thread:agentId[:transportScope]), NOT per ACP sessionId. `inflight` records the
  // keys a `runLoop` currently OWNS; ownership is claimed synchronously (before any
  // await) in `dispatch()` so two concurrent dispatches for the same key can never both
  // enter `sessions.handle()` and overwrite `pending`. While a key is owned, further
  // arrivals (ordinary inbound AND `!queue`) land in `serialQueue` and are drained in
  // order by the owning `runLoop`, which holds the key across turns and releases it only
  // once the queue is confirmed empty. This is the sole per-session FIFO — the old
  // acpSessionId-keyed `!queue` map is gone; `!queue` is now just admission with a
  // different ACK (see handleCommand's queue branch).
  private inflight = new Set<string>()
  private serialQueue = new Map<string, QueueEntry[]>()
  /** Current head for every owned serial gate, including the cold pre-Pending phase.
   *  Lets pause/loop trip latch cancellation onto work that cannot yet be found through
   *  `pending` and would otherwise revive after a quick reset. */
  private activeGateEntries = new Map<string, QueueEntry>()
  /** §6.9 #353: stable ids of messages currently backed by a durable inbox row (admitted,
   *  not yet terminal). Guards startup replay from re-admitting a row whose entry is already
   *  live in the gate (idempotency — a duplicate/in-flight id is not double-processed). */
  private liveInboxIds = new Set<string>()

  private isSessionMuted(key: string): boolean {
    return this.store.isSessionMuted(key)
  }

  private setSessionMuted(key: string, muted: boolean): void {
    this.store.setSessionMuted(key, muted)
  }

  /**
   * Resolve a command's target from the channel's latest session when the routing ladder
   * couldn't (no mention entity / thread / dm rule matched — e.g. a group `/status@bot`).
   * Picks the agent that owns the most-recent session in the channel and its integration
   * for this platform, enforcing that integration's `allowedUserIds` so a command can't
   * bypass the authz the routing rules would have applied. Null when there's no session,
   * no matching integration, or the sender isn't allowed.
   */
  private resolveCommandTargetFromLatest(
    msg: NormalizedMessage,
    srcIntegrationIds?: readonly string[]
  ): { agentId: string; integrationId: string; via: RouteVia } | null {
    const transportScope = msg.transportScope ?? this.transportScopeForIntegrationIds(srcIntegrationIds)
    const thread = msg.platform === 'slack' ? msg.thread : undefined
    const candidates: Array<{
      agentId: string
      integrationId: string
      updatedAt: number
    }> = []
    for (const [agentId, agent] of this.agents) {
      for (const integration of agent.integrations) {
        if (
          integration.platform !== msg.platform ||
          !this.integrationBelongsToSource(integration.id, srcIntegrationIds) ||
          !this.gatedAdmission(integration.id, msg) ||
          !this.commandSenderAllowed(agentId, integration.id, msg)
        )
          continue
        const latest = this.store.latestSessionForTransport(agentId, msg.channel, transportScope, thread)
        if (latest) candidates.push({ agentId, integrationId: integration.id, updatedAt: latest.updatedAt })
      }
    }
    candidates.sort(
      (a, b) =>
        b.updatedAt - a.updatedAt ||
        a.agentId.localeCompare(b.agentId) ||
        a.integrationId.localeCompare(b.integrationId)
    )
    const latest = candidates[0]
    return latest ? { agentId: latest.agentId, integrationId: latest.integrationId, via: 'thread' } : null
  }

  /** Validate the relay-arbitrated command target against the local agent spec. Shared
   *  bot IMs bypass routeRules' arbitration, but must retain its bot rejection and
   *  per-integration allowedUserIds authorization before executing a control command. */
  private resolveExplicitCommandTarget(
    agentId: string,
    integrationId: string,
    msg: NormalizedMessage
  ): { agentId: string; integrationId: string; via: RouteVia } | null {
    if (!this.commandSenderAllowed(agentId, integrationId, msg)) return null
    return { agentId, integrationId, via: 'thread' }
  }

  /** Recovery path for a channel-wide Slack top-level loop latch. The triggering
   *  message itself was rejected, so its warning thread may have no thread owner or
   *  latest session to route a bare `!resume` through. Select only an integration
   *  that independently authorizes this human, preferring an explicitly mentioned bot. */
  private resolveTopLevelResumeTarget(
    msg: NormalizedMessage,
    srcIntegrationIds?: readonly string[]
  ): { agentId: string; integrationId: string; via: RouteVia } | null {
    if (msg.platform !== 'slack' || msg.isDm || !this.store.isLoopGuardOpen(slackTopLevelLoopGuardScope(msg.channel))) {
      return null
    }
    const candidates: Array<{
      agentId: string
      integrationId: string
      via: RouteVia
      mentioned: boolean
    }> = []
    for (const [agentId, agent] of this.agents) {
      for (const integration of agent.integrations) {
        if (
          integration.platform !== 'slack' ||
          !this.integrationBelongsToSource(integration.id, srcIntegrationIds) ||
          !this.commandSenderAllowed(agentId, integration.id, msg)
        )
          continue
        const mentioned =
          integration.slack.botUserId !== undefined && msg.mentionedBots.includes(integration.slack.botUserId)
        candidates.push({
          agentId,
          integrationId: integration.id,
          via: mentioned ? 'mention' : 'auto',
          mentioned
        })
      }
    }
    candidates.sort(
      (a, b) =>
        Number(b.mentioned) - Number(a.mentioned) ||
        a.agentId.localeCompare(b.agentId) ||
        a.integrationId.localeCompare(b.integrationId)
    )
    return candidates[0] ?? null
  }

  /** Final command authorization at the concrete integration. CP routing rules do not
   *  carry allowedUserIds themselves, so routing success alone is not an auth verdict. */
  private commandSenderAllowed(agentId: string, integrationId: string, msg: NormalizedMessage): boolean {
    if (msg.sender.isBot) return false
    const integration = this.agents
      .get(agentId)
      ?.integrations.find((candidate) => candidate.id === integrationId && candidate.platform === msg.platform)
    if (!integration) return false
    const routing = integrationRouting(integration)
    // Control commands resolve their target OUTSIDE routeRules' scope filter (latest-
    // session fallbacks), so they must repeat the admission check — a channel switched
    // Off, or an Off conversation of a gated integration, takes no commands either.
    if (!conversationAdmitted(routing, msg.channel, msg.parentChannel)) return false
    const allowed = routing.allowedUserIds
    return allowed.length === 0 || allowed.includes(msg.sender.id)
  }

  /**
   * Handle an in-conversation control command. Resolves the target agent via the
   * same routing ladder as a normal message (so thread-affinity + per-integration
   * `allowedUserIds` authz apply), then acts on that agent's session in this
   * (channel, thread).
   */
  private handleCommand(
    command: AgentCommand,
    msg: NormalizedMessage,
    explicitTarget?: { agentId: string; integrationId: string; via: RouteVia },
    srcIntegrationIds?: readonly string[]
  ): boolean {
    let target =
      explicitTarget ??
      routeRules(msg, this.mergedRulesForSource(srcIntegrationIds), (c, t) =>
        this.sessions.threadOwner(c, t, msg.transportScope)
      )
    if (!target) {
      // Routing found no agent — the common group case: a bare `/status@bot` carries no
      // mention entity, no reply, and its fresh thread has no session. Resolve the agent
      // from the channel's latest session so the command still lands on it (subject to
      // that agent's per-integration allowedUserIds authz).
      target = this.resolveCommandTargetFromLatest(msg, srcIntegrationIds)
    }
    if (!target && command.kind === 'resume') target = this.resolveTopLevelResumeTarget(msg, srcIntegrationIds)
    if (!target) {
      this.log.debug(`command: '${command.kind}' in ch=${msg.channel} — no agent resolved, ignoring`)
      return false
    }
    if (!this.commandSenderAllowed(target.agentId, target.integrationId, msg)) {
      this.log.warn(`command: '${command.kind}' rejected for unauthorized sender ${msg.sender.id}`)
      return false
    }
    const conn = this.replyConnFor(target.agentId, target.integrationId)
    // Where the command was sent — the reply lands here (Slack thread_ts; Telegram
    // replies to the command message via tgReplyTo). Kept separate from the session the
    // command ACTS on, resolved just below.
    const replyThread = msg.thread ?? msg.msgId
    // Resolve the session the command acts on. A command that isn't in a session's own
    // thread — notably ANY bare Telegram command, which keys to its own fresh reply
    // thread — falls back to the agent's latest session in this channel, so /stop
    // /cancel /status /fast /models /effort /permission /queue all operate on it rather
    // than on a phantom empty thread. `thread`/`key` follow the resolved session so a
    // `/queue` dispatch continues it and the sticky overrides land on the right key.
    let thread = replyThread
    let key = sessionKey(msg.platform, msg.channel, thread, target.agentId, msg.transportScope)
    let rec = this.store.getSession(key)
    // A cold turn owns its logical key before SessionManager persists the session row.
    // Prefer that exact live gate over the channel's latest historical session; otherwise
    // a `!stop` sent in the cold thread can mute/cancel an older thread and leave the
    // actual turn running. Check all gate representations because commands can race the
    // short hand-offs between them.
    const gateActiveFor = (candidateKey: string): boolean =>
      this.activeGateEntries.has(candidateKey) || (this.serialQueue.get(candidateKey)?.length ?? 0) > 0
    let directGateActive = gateActiveFor(key)
    if (!rec && !directGateActive) {
      const latest = this.store.latestSessionForTransport(target.agentId, msg.channel, msg.transportScope)
      if (latest) {
        rec = latest
        key = latest.key
        thread = latest.thread
        directGateActive = gateActiveFor(key)
      }
    }
    const acpSessionId = rec?.acpSessionId
    // §6.9 #390: liveness is observed on the LOGICAL sessionKey gate (a turn currently
    // owns the key), not just the ACP-id-keyed `pending` — so `!cancel`/`!stop`/`!queue`
    // also see a session that is gate-owned or queued (cold session with no ACP id yet).
    const inflight = directGateActive
    // Post a short control reply on the right surface: Slack threads on `thread_ts`;
    // Telegram replies to the command message (reply-based threading), which is also a
    // non-numeric `tg:`/`dm` thread so it never posts as a forum topic.
    const tgReplyTo = this.telegramReplyTarget(msg)
    const reply = (text: string): void => {
      if (!conn) return
      if (msg.platform === 'telegram')
        void (conn as TelegramConnection).postMessage(msg.channel, text, replyThread, { replyTo: tgReplyTo })
      else void (conn as SlackConnection).postMessage(msg.channel, text, replyThread)
    }

    if (command.kind === 'resume') {
      // Commands sent outside the session thread (notably bare Telegram commands)
      // may have resolved `thread` through latestSession above. Reset the scope the
      // command actually targets, not the fresh command-message thread.
      const directScope =
        thread === replyThread
          ? loopGuardScope(msg)
          : loopGuardScopeFromCoords(msg.platform, msg.channel, thread, msg.isDm, msg.transportScope)
      const topLevelScope = msg.platform === 'slack' && !msg.isDm ? slackTopLevelLoopGuardScope(msg.channel) : undefined
      // A top-level feedback loop posts its warning into the triggering root. A
      // trusted !resume from that warning thread (or elsewhere in the channel)
      // must reset the shared channel circuit, not a never-open per-thread key.
      const scope = topLevelScope && this.store.isLoopGuardOpen(topLevelScope) ? topLevelScope : directScope
      const stillStopping =
        [...this.activeGateEntries.values()].some(
          (entry) => entry.cancelledReason === 'loop protection' && loopGuardScope(entry.msg) === scope
        ) ||
        [...this.pending.values()].some((pending) => {
          return pending.outputSuppressed === 'loop protection' && pending.loopGuardScope === scope
        })
      if (stillStopping) {
        reply('Loop protection is still stopping the previous turn. Try `!resume` again in a moment.')
        return true
      }
      const wasOpen = this.store.isLoopGuardOpen(scope)
      this.store.resetLoopGuard(scope)
      const wasMuted = this.isSessionMuted(key)
      if (wasMuted) this.setSessionMuted(key, false)
      if (wasOpen || wasMuted) {
        this.log.info(`loop guard: explicitly reset ${scope} by ${msg.sender.id}`)
        reply('▶️ Resumed. Loop protection is reset; send a new message to continue.')
      } else {
        reply('Loop protection is not active in this conversation.')
      }
      return true
    }

    if (command.kind === 'stop') {
      // Mute the session's thread whether or not a turn is in flight: `!stop` is an
      // explicit stand-down — implicit routing (thread affinity / keyword / auto)
      // stays off until the user @mentions the agent again (onInbound clears it).
      if (rec || inflight) this.setSessionMuted(key, true)
      const muteNote = 'Muted in this thread — @mention me to resume.'
      if (!inflight) {
        reply(rec ? `🔇 Nothing is running. ${muteNote}` : 'Nothing is running to stop.')
        return true
      }
      this.interruptTurn(target.agentId, key, 'stop', acpSessionId ?? undefined)
      reply(`🛑 Stopped. ${muteNote}`)
      return true
    }

    if (command.kind === 'cancel') {
      // `!cancel` interrupts the in-flight turn but does NOT mute — the session stays
      // live so a follow-up message dispatches normally. No-op (with a note) when idle.
      if (!inflight) {
        reply('Nothing is running to cancel.')
        return true
      }
      this.interruptTurn(target.agentId, key, 'cancel', acpSessionId ?? undefined)
      reply('🛑 Cancelled.')
      return true
    }

    if (command.kind === 'status') {
      // `/status` — the on-demand replacement for Telegram's (removed) status bar:
      // reply with the session's model / context / tokens (the latest session in this
      // channel, per the resolution above). No-op note when there's none.
      if (!rec) {
        reply('No active session here yet — send me a message to start one.')
        return true
      }
      const info = this.statusInfoFrom(target.agentId, key, acpSessionId ?? undefined)
      const link = acpSessionId ? this.sessionLink(acpSessionId) : undefined
      if (msg.platform === 'telegram') {
        // HTML chrome (not recorded) — renders the compact line + a tappable View link.
        void (conn as TelegramConnection | undefined)?.postChrome(msg.channel, renderStatusReply(info, link), {
          parseMode: 'HTML',
          threadTs: replyThread,
          replyTo: tgReplyTo
        })
      } else if (msg.platform === 'discord') {
        // Discord markdown line + a real "View session" link BUTTON (Slack's `<url|text>`
        // link syntax renders literally on Discord).
        void (conn as DiscordConnection | undefined)?.postChrome(
          msg.channel,
          renderStatusText(info),
          link ? { keyboard: buildLinkComponents(link) } : {}
        )
      } else if (msg.platform === 'feishu') {
        // Plain-text status line + a `🔗 <url>` line (v1 has no interactive cards / link buttons).
        void (conn as FeishuConnection | undefined)?.postChrome(msg.channel, renderFeishuStatusReply(info, link))
      } else {
        const text = link ? `${renderStatusBar(info)}  ·  <${link}|View session>` : renderStatusBar(info)
        reply(text)
      }
      return true
    }

    if (
      (command.kind === 'fast' ||
        command.kind === 'model' ||
        command.kind === 'effort' ||
        command.kind === 'permission') &&
      this.agents.get(target.agentId)?.allowRuntimeChangesInChat !== true
    ) {
      reply('Runtime settings can only be changed by an Agent editor from the Agent page.')
      return true
    }

    if (command.kind === 'fast') {
      // `/fast on|off` — toggle the session's fast mode (the control the status-bar
      // Fast button used to offer). Records the sticky override + applies live if warm.
      if (!rec) {
        reply('No active session here to configure.')
        return true
      }
      if (command.enable === null) {
        reply('Usage: `/fast on` or `/fast off`.')
        return true
      }
      this.setFastByKey(key, command.enable)
      reply(command.enable ? '⚡ Fast mode on.' : '🐢 Fast mode off.')
      return true
    }

    if (command.kind === 'model' || command.kind === 'effort' || command.kind === 'permission') {
      // `/models`, `/effort`, `/permission` — on-demand session controls.
      // Telegram status-bar dropdowns. A bare command renders a tappable card on Telegram
      // AND Discord (numbered text list on Slack); an argument selects directly. Records
      // the sticky per-session override + applies it live when the ACP session is warm.
      if (!rec) {
        reply('No active session here to configure.')
        return true
      }
      // Telegram + Discord list via a tappable button card, replied under the command;
      // returns false so handleSelectCommand falls back to a text list (Slack, or when
      // Discord has too many options to fit its 25-button ceiling).
      const renderCard =
        msg.platform === 'telegram' && conn
          ? (kind: SelectKind, current: string | undefined, options: string[]) => {
              const { text, buttons } = this.buildSelectCard(kind, current, options)
              void (conn as TelegramConnection).postCard(msg.channel, text, buttons, {
                threadTs: replyThread,
                replyTo: tgReplyTo
              })
              return true
            }
          : msg.platform === 'discord' && conn
            ? (kind: SelectKind, current: string | undefined, options: string[]) => {
                const components = buildDiscordSelectComponents(kind, current, options)
                if (!components) return false
                // sessionKey = the resolved key, so a tapped button resolves back to it.
                void (conn as DiscordConnection).postChrome(msg.channel, this.selectCardText(kind, current), {
                  keyboard: components,
                  sessionKey: key
                })
                return true
              }
            : undefined
      this.handleSelectCommand(
        command.kind,
        command.value,
        target.agentId,
        key,
        acpSessionId ?? undefined,
        reply,
        renderCard
      )
      return true
    }

    // queue — now just admission through the UNIFIED per-sessionKey gate (§6.9 #390): the
    // gate itself decides run-now vs enqueue-behind-the-turn; `!queue` only differs in the
    // ACK wording and the queue_full reply. Depth cap + queue-full fast-fail live in the
    // gate (dispatch → QueueFullError), so there is no second FIFO here anymore.
    if (!command.text) {
      reply('Usage: `!queue <message>` — runs when the current turn finishes.')
      return true
    }
    // Dispatch/queue into the resolved session's thread (the fallback may have retargeted
    // it from the bare command thread to the channel's latest session).
    const payload: NormalizedMessage = { ...msg, text: command.text, thread }
    // Reject fast (matching the old depth-cap ACK) before admitting so the user sees the
    // "queue full" note rather than a silent drop; the gate would reject identically.
    if (inflight && (this.serialQueue.get(key)?.length ?? 0) >= MAX_QUEUED_PER_SESSION) {
      this.log.warn(`command: queue → agent "${target.agentId}" session ${key} full, rejected`)
      reply(`Queue is full (${MAX_QUEUED_PER_SESSION} pending) — wait for the current turn to finish.`)
      return true
    }
    void this.dispatch(target.agentId, payload, target.integrationId, undefined, undefined, { isQueueCmd: true }).catch(
      (err) => {
        if (err instanceof QueueFullError) return // already reported above; race-safe no-op
        this.log.error(`queued dispatch failed for agent "${target.agentId}": ${(err as Error).stack ?? err}`)
      }
    )
    if (!inflight) {
      this.log.info(`command: queue → agent "${target.agentId}" idle, dispatching now`)
      reply(`▶️ Running now — the session was idle.`)
    } else {
      const depth = this.serialQueue.get(key)?.length ?? 0
      this.log.info(`command: queue → agent "${target.agentId}" session ${key} (depth ${depth})`)
      reply(`📥 Queued (#${depth}) — will run when the current turn finishes.`)
    }
    return true
  }

  private selectLabel(kind: SelectKind): string {
    return kind === 'model' ? 'Model' : kind === 'effort' ? 'Reasoning effort' : 'Permission mode'
  }

  /** Current value + selectable options for a select kind, from a status snapshot. */
  private selectOptions(kind: SelectKind, info: StatusBarInfo): { current?: string; options: string[] } {
    if (kind === 'model') return { current: info.model, options: info.models ?? [] }
    if (kind === 'effort') return { current: info.effort, options: info.efforts ?? [] }
    return { current: info.permissionMode, options: info.permissionModes ?? [] }
  }

  /** Apply a resolved select value to a session key via the matching sticky-override setter. */
  private applySelect(kind: SelectKind, key: string, value: string): boolean {
    if (kind === 'model') return this.setModelByKey(key, value)
    if (kind === 'effort') return this.setEffortByKey(key, value)
    return this.setPermissionModeByKey(key, value)
  }

  /** Display alias for a select value: permission-mode ids read as their Codex
   *  desktop-app names; model/effort values render verbatim. The underlying value
   *  (state, wire, resolution) is unchanged — this is presentation only. */
  private selectDisplay(kind: SelectKind, value: string): string {
    return kind === 'permission' ? permissionModeDisplayLabel(value) : value
  }

  /** Header line for a select card (shared by the Telegram inline-keyboard card and the
   *  Discord button card). */
  private selectCardText(kind: SelectKind, current: string | undefined): string {
    const cur = current ? this.selectDisplay(kind, current) : 'default'
    return `${this.selectLabel(kind)} — tap to switch (current: ${cur}):`
  }

  /** Build a session-control card: a header line + one tappable button per option (the
   *  current one flagged), with `callback_data` = `<kindCode>:<optionIndex>`. */
  private buildSelectCard(
    kind: SelectKind,
    current: string | undefined,
    options: string[]
  ): { text: string; buttons: InlineButton[][] } {
    const code = SELECT_KIND_CODE[kind]
    const buttons = options.map((o, i) => [
      { text: `${o === current ? '✅ ' : ''}${this.selectDisplay(kind, o)}`, callbackData: `${code}:${i}` }
    ])
    return { text: this.selectCardText(kind, current), buttons }
  }

  /**
   * Back the `/models` `/effort` `/permission` commands. A bare command lists the current
   * selectable values — as a tappable inline-keyboard card when `card` is provided
   * (Telegram), else a numbered text list. An argument applies a choice, matched by exact
   * id, unique case-insensitive substring, or 1-based list index. Options come from the
   * live host's config selectors (statusInfoFrom); when the host is cold a given value is
   * accepted optimistically and takes effect on the next turn.
   */
  private handleSelectCommand(
    kind: SelectKind,
    value: string | null,
    agentId: string,
    key: string,
    acpSessionId: string | undefined,
    reply: (text: string) => void,
    renderCard?: (kind: SelectKind, current: string | undefined, options: string[]) => boolean
  ): void {
    const label = this.selectLabel(kind)
    const info = this.statusInfoFrom(agentId, key, acpSessionId)
    const { current, options } = this.selectOptions(kind, info)
    const cmd = kind === 'model' ? 'models' : kind

    const disp = (v: string) => this.selectDisplay(kind, v)

    if (value === null) {
      if (options.length === 0) {
        reply(
          current
            ? `${label}: ${disp(current)} (no other options offered${kind === 'effort' ? ' — the current model may not support effort' : ''}).`
            : `No ${label.toLowerCase()} options available yet — send me a message first, then try /${cmd} again.`
        )
        return
      }
      // A tappable card (Telegram / Discord) when available; false ⇒ fall back to text.
      if (renderCard?.(kind, current, options)) return
      const lines = options.map((o, i) => `${i + 1}. ${disp(o)}${o === current ? '  ✓ (current)' : ''}`)
      reply(`${label} — reply \`/${cmd} <name or number>\`:\n${lines.join('\n')}`)
      return
    }

    // Resolve the chosen value against the offered options (when we have them). Match
    // the raw value OR its display label, so `/permission full access` resolves too.
    let resolved: string | undefined
    if (options.length === 0) {
      resolved = value.trim() // host cold — accept optimistically, applies next turn
    } else {
      const v = value.trim()
      const idx = Number(v)
      if (Number.isInteger(idx) && idx >= 1 && idx <= options.length) resolved = options[idx - 1]
      else {
        const lc = v.toLowerCase()
        const exact = (o: string) => o.toLowerCase() === lc || disp(o).toLowerCase() === lc
        const partial = (o: string) => o.toLowerCase().includes(lc) || disp(o).toLowerCase().includes(lc)
        resolved = options.find(exact) ?? (options.filter(partial).length === 1 ? options.find(partial) : undefined)
      }
    }
    if (!resolved) {
      reply(
        `Unknown ${label.toLowerCase()} "${value.trim()}".${options.length ? ` Options: ${options.map(disp).join(', ')}` : ''}`
      )
      return
    }
    if (!this.applySelect(kind, key, resolved)) {
      reply('Runtime settings can only be changed by an Agent editor from the Agent page.')
      return
    }
    reply(
      options.length === 0
        ? `${label} set to ${disp(resolved)} — applies on your next message.`
        : `✅ ${label} set to ${disp(resolved)}.`
    )
  }

  /**
   * Handle a tapped session-control card button (Telegram inline keyboard). Decodes
   * `<kindCode>:<optionIndex>`, resolves the channel's latest session (with the same
   * allowedUserIds authz as a command), applies the picked value, acks the tap, and
   * re-renders the card with the new current marked. Best-effort throughout — a tap
   * must never throw out of the update pump.
   */
  private handleTelegramCallback(cb: TelegramCallback, conn: TelegramConnection): void {
    const m = /^([mep]):(\d+)$/.exec(cb.data)
    if (!m) {
      void conn.answerCallback(cb.id)
      return
    }
    const kind = SELECT_CODE_KIND[m[1] as keyof typeof SELECT_CODE_KIND]
    const idx = Number(m[2])
    const srcIntegrationIds = this.srcIntegrationIds(conn)
    const session = this.commandSessionForLatest(
      cb.channel,
      cb.userId,
      srcIntegrationIds,
      this.transportScopeForIntegrationIds(srcIntegrationIds)
    )
    if (!session) {
      void conn.answerCallback(cb.id, 'No active session here.')
      return
    }
    if (this.agents.get(session.agentId)?.allowRuntimeChangesInChat !== true) {
      void conn.answerCallback(cb.id, 'Ask an Agent editor to change runtime settings.')
      return
    }
    const info = this.statusInfoFrom(session.agentId, session.key, session.acpSessionId)
    const { options } = this.selectOptions(kind, info)
    const value = options[idx]
    if (value === undefined) {
      void conn.answerCallback(cb.id, 'Options changed — reopen the menu.')
      return
    }
    if (!this.applySelect(kind, session.key, value)) return
    // Telegram names the tapping user on the callback itself; record only the applied
    // change, matching the other funnels.
    this.logSessionAction(`select:${kind}`, session.key, { userId: cb.userId })
    void conn.answerCallback(cb.id, `${this.selectLabel(kind)} → ${value}`)
    const { text, buttons } = this.buildSelectCard(kind, value, options)
    void conn.editCard(cb.channel, cb.messageId, text, buttons)
  }

  /** The channel's latest session for a Telegram command/callback, gated by the agent's
   *  telegram integration allowedUserIds. Null when there's no session, no telegram
   *  integration, or the user isn't allowed. */
  private commandSessionForLatest(
    channel: string,
    userId: string,
    srcIntegrationIds: readonly string[],
    transportScope?: string
  ): { agentId: string; key: string; acpSessionId?: string } | null {
    const candidates: SessionRecord[] = []
    for (const [agentId, agent] of this.agents) {
      for (const integration of agent.integrations) {
        if (
          integration.platform !== 'telegram' ||
          !srcIntegrationIds.includes(integration.id) ||
          (integration.telegram.allowedUserIds.length > 0 && !integration.telegram.allowedUserIds.includes(userId))
        )
          continue
        const routing = integrationRouting(integration)
        if (!conversationAdmitted(routing, channel)) continue
        const session = this.store.latestSessionForTransport(agentId, channel, transportScope)
        if (session) candidates.push(session)
      }
    }
    candidates.sort((a, b) => b.updatedAt - a.updatedAt || a.agentId.localeCompare(b.agentId))
    const latest = candidates[0]
    return latest ? { agentId: latest.agentId, key: latest.key, acpSessionId: latest.acpSessionId ?? undefined } : null
  }

  /** Resolve a direct Slack message shortcut to the newest addressable session in
   *  that exact bot-scoped conversation, retaining routing gates and user allowlists. */
  private slackShortcutSession(
    shortcut: { channel: string; thread: string; userId: string },
    srcIntegrationIds: readonly string[]
  ): string | undefined {
    const transportScope = this.transportScopeForIntegrationIds(srcIntegrationIds)
    const candidates: SessionRecord[] = []
    for (const [agentId, agent] of this.agents) {
      for (const integration of agent.integrations) {
        if (integration.platform !== 'slack' || !srcIntegrationIds.includes(integration.id)) continue
        const routing = integrationRouting(integration)
        if (routing.allowedUserIds.length > 0 && !routing.allowedUserIds.includes(shortcut.userId)) continue
        if (!conversationAdmitted(routing, shortcut.channel)) continue
        const session = this.store.latestSessionForTransport(agentId, shortcut.channel, transportScope, shortcut.thread)
        if (session) candidates.push(session)
      }
    }
    candidates.sort((a, b) => b.updatedAt - a.updatedAt || a.agentId.localeCompare(b.agentId))
    return candidates[0]?.key
  }

  /** Local layer (agent.json) ∪ resolved CP layer; unservable CP rules are dropped + warn-logged. */
  private mergedRules(): RoutingRule[] {
    const local = [...this.agents.values()].flatMap((a) => rulesFromAgent(a, this.botUserIds))
    const cp: RoutingRule[] = []
    for (const cpRule of this.cpRouting?.effectiveRules() ?? []) {
      const resolved = resolveCpRule(cpRule, (agentId) => this.resolveCpAgent(agentId))
      if (resolved) cp.push(resolved)
      else this.log.warn(`cp: routing rule for unknown/Slack-less agent "${cpRule.agentId}" skipped (degraded)`)
    }
    return [...local, ...cp]
  }

  /** Resolve a CP agentId (== local agent.id) to its integration; null if unservable. */
  private resolveCpAgent(
    agentId: string,
    platform?: string
  ): { integrationId: string; botUserId: string; platform: string; mutedChannels: string[] } | null {
    return resolveAgentIntegration(this.agents.get(agentId), this.botUserIds, platform)
  }

  /**
   * agentIds the daemon can't fully serve: CP routing rules with no servable
   * Slack integration. (CP agent specs are now written to disk and create a
   * runnable agent.json, so they no longer contribute a "no base" degraded scope.)
   */
  private cpDegradedScopes(): string[] {
    const out = new Set<string>()
    for (const cpRule of this.cpRouting?.effectiveRules() ?? []) {
      if (!this.resolveCpAgent(cpRule.agentId)) out.add(cpRule.agentId)
    }
    return [...out]
  }

  /**
   * Surface a turn that failed before producing a reply (agent couldn't start,
   * ACP handshake/prompt rejected) to whichever transport owns it. Without this
   * the failure is invisible: Slack keeps its "is thinking…" status with no
   * message, and a webchat client never receives a terminal relay `done` item so
   * its UI spins forever. Best-effort — a dead platform or relay connection just
   * means the (already logged) error goes unshown, never a second throw.
   */
  private surfaceTurnFailure(
    err: unknown,
    ctx: {
      agentId: string
      agentName: string
      iconUrl?: string
      platform: string
      isDm: boolean
      webchat?: WebchatTurnContext
      replyConn?: SlackConnection | TelegramConnection | DiscordConnection | FeishuConnection
      channel: string
      transcriptChannel: string
      thread?: string
      statusThread?: string
    }
  ): void {
    // turnFailureReason digs the runtime's own message out of an ACP RequestError's
    // `data` — codex-acp reports quota exhaustion / auth expiry as a bare
    // "Internal error" with the actionable text buried there.
    const reason = turnFailureReason(err)
    if (ctx.webchat) {
      ctx.webchat.sink.done({
        conversationId: ctx.webchat.conversationId,
        turnId: ctx.webchat.turnId,
        error: reason
      })
      return
    }
    const notice = `⚠️ Agent failed to respond: ${reason}`
    if (ctx.replyConn) {
      // Clear the Slack "is thinking…" status (Telegram's typing hint expires on its own).
      // Duck-typed so test fakes work.
      const slack = ctx.replyConn as Partial<SlackConnection>
      if (ctx.statusThread && typeof slack.setStatus === 'function')
        void slack.setStatus(ctx.channel, ctx.statusThread, '')
      if (ctx.platform === 'slack')
        void (ctx.replyConn as SlackConnection).postMessage(ctx.channel, notice, ctx.thread, {
          ...(this.slackPostOptions(ctx) ?? {}),
          chrome: true
        })
      else void ctx.replyConn.postMessage(ctx.channel, notice, ctx.thread)
    }
    // Record the failure in the transcript too — the direct post above bypasses the
    // recorded apply path, which previously left the console session view showing an
    // empty reply for a failed turn.
    if (ctx.statusThread) {
      this.store.appendTranscript({
        channel: ctx.transcriptChannel,
        thread: ctx.statusThread,
        ts: monotonicTs(),
        sender: ctx.agentId,
        kind: 'text',
        text: notice
      })
    }
  }

  /** Queue user-visible warnings produced while (re)building an agent's host
   *  (config-file secret conflicts / write failures — agents/config-file-env.ts).
   *  Deduplicated; flushed into the next dispatched session by flushSpawnNotices. */
  private queueSpawnNotices(agentId: string, notices: string[]): void {
    if (notices.length === 0) return
    const queued = this.pendingSpawnNotices.get(agentId) ?? []
    for (const notice of notices) {
      if (queued.includes(notice)) continue
      queued.push(notice)
      this.log.warn(`spawn: agent "${agentId}": ${notice}`)
    }
    this.pendingSpawnNotices.set(agentId, queued)
  }

  /** Surface queued spawn warnings into the session whose dispatch booted the
   *  host: the platform thread when one exists (headless/webchat turns have no
   *  reply connection) and always the transcript, so the console session view
   *  records the warning either way. */
  private flushSpawnNotices(
    agentId: string,
    ctx: {
      replyConn?: SlackConnection | TelegramConnection | DiscordConnection | FeishuConnection
      channel: string
      transcriptChannel: string
      thread?: string
      statusThread: string
    }
  ): void {
    const notices = this.pendingSpawnNotices.get(agentId)
    if (!notices || notices.length === 0) return
    this.pendingSpawnNotices.delete(agentId)
    const text = notices.map((notice) => `⚠️ ${notice}`).join('\n')
    if (ctx.replyConn) {
      void ctx.replyConn
        .postMessage(ctx.channel, text, ctx.thread)
        .catch((err) => this.log.warn(`spawn: notice post failed for agent "${agentId}": ${(err as Error).message}`))
    }
    this.store.appendTranscript({
      channel: ctx.transcriptChannel,
      thread: ctx.statusThread,
      ts: monotonicTs(),
      sender: agentId,
      kind: 'text',
      text
    })
  }

  /**
   * §6.9 #353 durable inbox: persist an ADMITTED entry BEFORE its admission ACK/return, so a
   * hard kill / agent move can't lose a message the caller was already told delivered:true.
   * Called ONLY on the two genuine admission branches in dispatch() (claim + enqueue), never
   * on a rejected/gate-dropped admission — a queue-full or paused/draining drop persists
   * nothing. WEBCHAT turns are skipped (§6.9 #367): their `sink` is a live in-memory transport
   * that can't be restored across a restart and a dead browser socket can't be resumed, so a
   * durable row would be un-replayable. Sets `entry.inboxId` so every terminal path can delete
   * the row. Its id is the stable deliveryId or bot-scoped platform message id (§6.3), making
   * same-bot re-appends idempotent without colliding across physical bots.
   */
  private persistInbox(
    entry: QueueEntry,
    key: string,
    options: { required?: boolean; adoptExisting?: boolean; existingId?: string } = {}
  ): 'inserted' | 'adopted' | 'existing' | 'skipped' | 'failed' {
    if (entry.webchat) return 'skipped' // non-persistable live sink — see §6.9 #367
    const id = options.existingId ?? entry.callMeta?.deliveryId ?? stableMessageId(entry.msg)
    try {
      const inserted = this.store.appendInbox({
        id,
        sessionKey: key,
        agentId: entry.agentId,
        msg: JSON.stringify(entry.msg),
        integrationId: entry.integrationId ?? null,
        callMeta: entry.callMeta ? JSON.stringify(entry.callMeta) : null,
        hookContext: entry.hookContext ? JSON.stringify(entry.hookContext) : null,
        posterPublishState: entry.posterPublishState ?? null,
        isQueueCmd: entry.isQueueCmd ? 1 : null,
        // persistInbox runs only after a successful admission. New rows are born
        // replay-neutral; a migrated row's atomic charge already advanced this marker,
        // and appendInbox reasserts it without replacing the original payload/FIFO slot.
        loopGuardCounted: 1,
        enqueuedAt: monotonicTs()
      })
      if (!inserted && !options.adoptExisting) return 'existing'
      entry.inboxId = id
      this.liveInboxIds.add(id)
      return inserted ? 'inserted' : 'adopted'
    } catch (err) {
      if (options.required) throw err
      // Ordinary interactive traffic retains the historic best-effort behavior.
      // Hook admission opts into the strict branch above because its ACK is a
      // cross-system effects barrier.
      this.log.warn(`durable inbox: append failed for ${id}: ${(err as Error).message}`)
      return 'failed'
    }
  }

  private persistHookState(
    entry: QueueEntry,
    posterPublishState?: QueueEntry['posterPublishState'],
    required = false
  ): void {
    if (!entry.inboxId || !entry.hookContext) {
      if (required) throw new Error('hook state has no durable inbox row')
      return
    }
    if (posterPublishState) entry.posterPublishState = posterPublishState
    try {
      const updated = this.store.updateInboxHookState(
        entry.inboxId,
        JSON.stringify(entry.hookContext),
        posterPublishState
      )
      if (!updated) throw new Error('durable inbox row is missing')
    } catch (err) {
      if (required) throw err
      this.log.warn(`durable inbox: hook state update failed for ${entry.inboxId}: ${(err as Error).message}`)
    }
  }

  private emitHookCompletion(
    hook: HookDispatchContext,
    status: 'success' | 'failed',
    extra: { sessionId?: string; reason?: string } = {},
    owner?: HookCompletionOwner
  ): void {
    if (owner?.hookTerminalReceipt) return
    const start = Date.parse(hook.turnStartedAt ?? hook.firedAt)
    const review = githubReviewResultForCompletion(hook)
    const report: HookReport = {
      hookId: hook.hookId,
      agentId: hook.agentId,
      deliveryKey: hook.deliveryKey,
      ...(hook.snapshot ?? {}),
      ...(hook.event ? { event: hook.event } : {}),
      ...(hook.github ? { github: hook.github } : {}),
      status,
      durationMs: Number.isFinite(start) ? Math.max(0, this.clock.now() - start) : 0,
      ...extra,
      ...(review ? { reviewAttemptId: review.attemptId, reviewResult: review.result } : {})
    }
    let reportInboxId: string | undefined
    if (owner?.inboxId) {
      try {
        const completed = this.store.completeHookInbox(owner.inboxId, JSON.stringify(report), this.clock.now())
        if (completed === 'already-terminal') {
          owner.hookTerminalReceipt = true
          this.liveInboxIds.delete(owner.inboxId)
          return
        }
        if (completed === 'missing') {
          this.log.warn(`durable inbox: hook terminal receipt owner is missing for ${owner.inboxId}`)
          this.liveInboxIds.delete(owner.inboxId)
        } else {
          owner.hookTerminalReceipt = true
          this.liveInboxIds.delete(owner.inboxId)
          reportInboxId = owner.inboxId
        }
      } catch (err) {
        // The metadata report is still useful even if the local receipt write
        // failed. The unredacted inbox row remains, so a restart takes the
        // conservative marker-safe replay path instead of losing completion.
        this.log.warn(`durable inbox: hook terminal receipt failed for ${owner.inboxId}: ${formatErr(err)}`)
      }
    }
    // A best-effort report without a durable redaction must not carry the live
    // inbox id: a CP ACK would otherwise clear a row that still owns model work.
    this.sendHookReport(report, reportInboxId)
  }

  /** Send one durable terminal report and release only its outbox payload after
   * the CP's correlated persistence/projection ACK. The stable id receipt stays
   * bounded locally to absorb later relay redelivery. */
  private sendHookReport(report: HookReport, inboxId?: string): void {
    if (!this.cpClient) return
    if (inboxId && this.hookReportInflight.has(inboxId)) return
    if (inboxId && this.hookReportInflight.size >= MAX_HOOK_REPORT_INFLIGHT) {
      // The report is already durable in LocalStore. Leave it there until an
      // active request releases a slot instead of expanding the live ReqRep set.
      this.scheduleHookReportRetry()
      return
    }
    if (inboxId) this.hookReportInflight.add(inboxId)
    const connectionId = this.hookReportConnectionId
    let refillDrainSlot = false
    void Promise.resolve(this.cpClient.emitHookReport(report))
      .then((result) => {
        if (!inboxId) return
        if (result === 'legacy-sent') {
          try {
            if (!this.store.markLegacyHookReportSent(inboxId, connectionId)) {
              throw new Error('durable inbox row is missing')
            }
            refillDrainSlot = true
          } catch (err) {
            this.log.warn(`durable inbox: legacy report stamp failed for ${inboxId}: ${formatErr(err)}`)
            this.scheduleHookReportRetry()
          }
          return
        }
        refillDrainSlot = true
        try {
          this.store.acknowledgeHookInbox(inboxId)
        } catch (err) {
          // An ACKed report may be re-sent if the local GC write fails. CP
          // persistence is idempotent, so retaining it is the safe direction.
          this.log.warn(`durable inbox: hook report ACK cleanup failed for ${inboxId}: ${formatErr(err)}`)
        }
      })
      .catch((err) => {
        const permanentlyRejected =
          typeof err === 'object' && err !== null && 'retryable' in err && err.retryable === false
        if (permanentlyRejected && inboxId) {
          // A dispatch-fence CONFLICT can never become valid. Keep the bounded
          // stable-id receipt for relay dedup, but dead-letter its report body.
          refillDrainSlot = true
          try {
            this.store.acknowledgeHookInbox(inboxId)
          } catch (cleanupError) {
            this.log.warn(`durable inbox: hook report dead-letter failed for ${inboxId}: ${formatErr(cleanupError)}`)
          }
          this.log.warn(`hook report permanently rejected for ${inboxId}: ${formatErr(err)}`)
          return
        }
        this.log.debug(`hook report retained for retry: ${formatErr(err)}`)
        this.scheduleHookReportRetry()
      })
      .finally(() => {
        if (inboxId) this.hookReportInflight.delete(inboxId)
        // Fill the newly released slot promptly after an ACK/dead-letter or a
        // successfully stamped legacy EVT. The per-connection stamp lets a
        // legacy backlog advance without re-sending earlier rows. Transient
        // failures use the 5s backoff instead.
        if (refillDrainSlot) this.scheduleHookReportRetry(250)
      })
  }

  private scheduleHookReportRetry(delayMs = 5_000): void {
    if (this.draining || this.hookReportRetryTimer !== undefined) return
    this.hookReportRetryTimer = this.clock.setTimeout(() => {
      this.hookReportRetryTimer = undefined
      this.replayHookTerminalReports()
    }, delayMs)
  }

  /** Remove an entry's durable inbox row once its turn reaches ANY terminal state (success,
   *  reject/fail-stop, cancel, gate-drop) so it is not replayed on the next startup. No-op
   *  for a non-persisted entry (webchat / never-admitted). NOT called on graceful-shutdown
   *  settle: those admitted-but-unrun rows are intentionally LEFT for startup replay. */
  private removeInbox(entry: QueueEntry): void {
    if (!entry.inboxId) return
    this.liveInboxIds.delete(entry.inboxId)
    // Hook rows become redacted terminal receipts in emitHookCompletion. If
    // that conversion failed (or shutdown deliberately skipped completion),
    // retaining the live row is the only restart-safe choice.
    if (entry.hookContext) return
    try {
      this.store.removeInbox(entry.inboxId)
    } catch (err) {
      this.log.warn(`durable inbox: remove failed for ${entry.inboxId}: ${(err as Error).message}`)
    }
  }

  /** Drop an agent's admitted-but-unrun durable rows so a lifecycle interrupt (pause,
   *  removal, or host respawn) makes that work terminal instead of surviving as restart
   *  replay. `reason` is logged verbatim — a host respawn is NOT a pause, and mislabeling
   *  it "paused" has sent real incidents down the wrong trail. */
  private purgeAgentInbox(agentId: string, reason: TurnInterruptReason = 'pause'): number {
    try {
      const ids = this.store.removeInboxByAgentId(agentId)
      for (const id of ids) this.liveInboxIds.delete(id)
      if (ids.length > 0) this.log.warn(`durable inbox: purged ${ids.length} row(s) for agent "${agentId}" (${reason})`)
      return ids.length
    } catch (err) {
      this.log.error(`durable inbox: failed to purge agent "${agentId}" (${reason}): ${(err as Error).message}`)
      return 0
    }
  }

  /** Inbox rows intentionally keep the complete normalized message instead of a
   *  duplicated conversation column. A loop trip is rare, so scanning this small,
   *  already-bounded backlog keeps the persisted schema compatible while purging every
   *  agent/session in the affected conversation. */
  private purgeLoopScopeInbox(scope: string): number {
    let removed = 0
    try {
      for (const row of this.store.listInboxBySessionKeyFifo()) {
        // Live hook rows have a QueueEntry completion owner; retained terminal
        // reports are an unacknowledged outbox. The interrupt/replay paths below
        // terminalize the former and the CP ACK releases the latter.
        if (row.hookContext || row.terminalReport) continue
        let msg: NormalizedMessage
        try {
          msg = JSON.parse(row.msg) as NormalizedMessage
        } catch {
          continue
        }
        if (loopGuardScope(msg) !== scope) continue
        this.store.removeInbox(row.id)
        this.liveInboxIds.delete(row.id)
        removed++
      }
    } catch (err) {
      this.log.error(`loop guard: failed to purge inbox for ${scope}: ${(err as Error).message}`)
    }
    return removed
  }

  private isLoopGuardOpen(msg: NormalizedMessage, includeHook = false): boolean {
    return (usesLoopGuard(msg) || includeHook) && this.store.isLoopGuardOpen(loopGuardScope(msg))
  }

  /** First-open side effects for a durable conversation circuit: purge restart work,
   *  drop every matching serial queue, cancel live ACP turns across ALL agents sharing
   *  the conversation, and emit exactly one operator-facing warning. */
  private onLoopGuardTripped(
    scope: string,
    reason: string,
    trigger: { agentId: string; msg: NormalizedMessage; integrationId?: string }
  ): void {
    const purged = this.purgeLoopScopeInbox(scope)
    const targets = new Map<string, { agentId: string; acpSessionId?: string }>()
    for (const [key, entry] of this.activeGateEntries) {
      if (loopGuardScope(entry.msg) !== scope) continue
      entry.cancelledReason = 'loop protection'
      targets.set(key, { agentId: entry.agentId })
    }
    for (const pending of this.pending.values()) {
      if (pending.loopGuardScope === scope) {
        targets.set(pending.sessionKey, { agentId: pending.agentId, acpSessionId: pending.acpSessionId })
      }
    }
    for (const [key, queued] of this.serialQueue) {
      const entry = queued.find((candidate) => loopGuardScope(candidate.msg) === scope)
      if (entry && !targets.has(key)) targets.set(key, { agentId: entry.agentId })
    }
    for (const [key, target] of targets) {
      this.interruptTurn(target.agentId, key, 'loop protection', target.acpSessionId, { dropQueued: true })
    }

    this.log.warn(
      `loop guard: OPEN ${scope} reason=${reason}; interrupted=${targets.size}, purgedInbox=${purged}; explicit !resume required`
    )
    if (trigger.msg.headless) return
    const conn = this.replyConnFor(trigger.agentId, trigger.integrationId)
    if (!conn) return
    const warningThread = reason === 'malformed_platform_event' && trigger.msg.isDm ? undefined : trigger.msg.thread
    void conn
      .postMessage(
        trigger.msg.channel,
        '⚠️ Loop protection stopped this conversation and discarded its queued backlog. Send `!resume` when it is safe to continue.',
        warningThread
      )
      .catch((err) => this.log.warn(`loop guard: warning post failed for ${scope}: ${(err as Error).message}`))
  }

  /** Count a genuine admission and run first-open side effects if its fixed-window
   *  budget is exhausted. Returns false when this incoming turn must not enter the
   *  serial gate. */
  private admitLoopGuardTurn(
    agentId: string,
    msg: NormalizedMessage,
    integrationId?: string,
    inboxReplayId?: string
  ): boolean {
    if (!usesLoopGuard(msg)) return true
    const scope = loopGuardScope(msg)
    const limits = {
      windowMs: LOOP_GUARD_WINDOW_MS,
      maxTotal: MAX_TOTAL_TURNS_PER_WINDOW,
      maxAutomatic: MAX_AUTOMATIC_TURNS_PER_WINDOW
    }
    const verdict = inboxReplayId
      ? this.store.recordLoopGuardTurnForInbox(inboxReplayId, scope, this.clock.now(), !isTrustedHumanTurn(msg), limits)
      : this.store.recordLoopGuardTurn(scope, this.clock.now(), !isTrustedHumanTurn(msg), limits)
    if (verdict.allowed) return true
    if (verdict.trippedNow)
      this.onLoopGuardTripped(scope, verdict.reason ?? 'turn_burst', { agentId, msg, integrationId })
    else this.purgeLoopScopeInbox(scope)
    return false
  }

  /**
   * Terminate a QUEUED entry's webchat sink when it is gate-dropped/rejected without ever
   * entering dispatchOne (drain/pause gate-drop, fail-stop of the queued rest, `!cancel`/`!stop`
   * queue drop, shutdown). A webchat turn signals its client via the WebchatSink terminal
   * `done` frame, NOT the dispatch() promise — so settling the promise alone leaves the browser
   * UI spinning forever. Mirrors surfaceTurnFailure's webchat branch. No-op for non-webchat
   * entries. Pass an `error` for reject/cancel/shutdown; omit it for a clean gate-drop.
   */
  private terminateQueuedSink(entry: QueueEntry, error?: string): void {
    if (!entry.webchat || entry.webchat.doneSent) return
    entry.webchat.doneSent = true
    entry.webchat.sink.done({
      conversationId: entry.webchat.conversationId,
      turnId: entry.webchat.turnId,
      ...(error ? { error } : {})
    })
  }

  // shared dispatch for user + cron messages; resolves with the ACP sessionId
  // once THIS message's turn fully ends (null when a gate skipped it), rejects with
  // THIS message's turn error. §4.3/§6.9: admission into the per-sessionKey serial gate.
  // Ownership of the logical sessionKey is claimed synchronously here — before any await —
  // so two concurrent dispatches for the same key can never both enter sessions.handle()
  // and overwrite `pending`. The returned promise is bound to the entry it enqueued and
  // settled by runLoop when that specific message's turn completes (preserving the
  // Promise<string|null> contract onCronFire and tests rely on).
  private dispatch(
    agentId: string,
    msg: NormalizedMessage,
    integrationId?: string,
    webchat?: WebchatTurnContext,
    callMeta?: CallMeta,
    opts?: {
      isQueueCmd?: boolean
      /** Recovery of a row whose loop-guard admission was already counted. */
      replay?: boolean
      /** A startup replay may wait for an interrupt safety drain instead of being dropped. */
      fromInboxReplay?: boolean
      /** Stable row id used to atomically count a migrated pre-loop-guard admission. */
      inboxReplayId?: string
      /** Hook deliveries require a durable row before the relay receives an
       * accepted ACK. Ordinary interactive dispatch keeps best-effort inbox
       * persistence for backward compatibility. */
      requireDurable?: boolean
      /** Startup replay deliberately adopts the row already read from SQLite. */
      adoptExistingInbox?: boolean
      /** Synchronous admission barrier: called after the durable row is owned,
       * or with a rejection before any turn can start. */
      onAdmission?: (result: { accepted: boolean; reason?: string; duplicate?: boolean }) => void
      /** Best-effort notification once the ACP session exists, before prompt. */
      onSessionReady?: (sessionId: string) => void
    },
    githubReply?: GithubReplyTarget,
    hookContext?: HookDispatchContext,
    posterPublishState: QueueEntry['posterPublishState'] = githubReply ? 'not_started' : undefined
  ): Promise<string | null> {
    if (integrationId !== undefined) {
      msg.transportScope ??= this.transportScopeForIntegrationIds([integrationId])
    }
    return new Promise<string | null>((resolve, reject) => {
      let admissionSettled = false
      const settleAdmission = (result: { accepted: boolean; reason?: string; duplicate?: boolean }): void => {
        if (admissionSettled) return
        admissionSettled = true
        if (result.accepted && !result.duplicate && callMeta?.initializeOnly !== true) {
          this.emitEvaluation({
            type: 'turn.accepted',
            agentId,
            turnId: this.evaluationTurnIdFor(agentId, msg),
            platform: msg.platform,
            channel: msg.channel,
            data: { source: msg.source }
          })
        }
        opts?.onAdmission?.(result)
      }
      // Drain gate for the dispatch entry itself — covers cron fires and `!queue`
      // that bypass onInbound's gate (§5.3: a draining unit starts no turn). Applied
      // BEFORE claiming ownership so a queued entry is never admitted for a draining
      // agent. Callers treat null as "gate-dropped, still admitted for P1".
      if (this.draining || this.drainingAgents.has(agentId)) {
        this.log.debug(`dispatch: skipped for agent "${agentId}" (draining)`)
        settleAdmission({ accepted: false, reason: 'draining' })
        resolve(null)
        return
      }
      // Pause gate (#288): a paused agent stays placed/connected but processes no
      // turns — platform, webchat, and cron all funnel through here. Silent drop.
      if (this.paused(agentId)) {
        this.log.info(`dispatch: skipped for agent "${agentId}" (paused)`)
        settleAdmission({ accepted: false, reason: 'paused' })
        resolve(null)
        return
      }
      // An interrupt's force backstop is host-wide, so fresh work must wait until the
      // selected old dispatches fully unwind. Live platform arrivals are intentionally
      // dropped; a DURABLE startup replay cannot be lost/dormant, so retry that same row
      // after the transient drain closes (its inbox id has not been adopted yet).
      if (this.safetyDrainingAgents.has(agentId)) {
        if (opts?.fromInboxReplay) {
          void this.waitForSafetyDrain(agentId)
            .then(() => {
              if (this.draining || !this.agents.has(agentId)) {
                settleAdmission({ accepted: false, reason: 'draining' })
                resolve(null) // durable row remains for next startup/eventual owner
                return
              }
              if (opts.inboxReplayId !== undefined && !this.store.hasInbox(opts.inboxReplayId)) {
                // Pause/loop protection purged it while deferred; it stays terminal.
                settleAdmission({ accepted: false, reason: 'dropped' })
                resolve(null)
                return
              }
              this.dispatch(
                agentId,
                msg,
                integrationId,
                webchat,
                callMeta,
                opts,
                githubReply,
                hookContext,
                posterPublishState
              ).then(resolve, reject)
            })
            .catch(reject)
        } else {
          this.log.info(`dispatch: skipped for agent "${agentId}" (stopping interrupted work)`)
          settleAdmission({ accepted: false, reason: 'busy' })
          resolve(null)
        }
        return
      }
      const key = sessionKey(msg.platform, msg.channel, msg.thread ?? msg.msgId, agentId, msg.transportScope)
      const loopScope = loopGuardScope(msg)
      // A latched circuit is checked at the common dispatch seam, so startup replay,
      // cron/hook turns, webchat, and agent→agent calls cannot bypass it. Purging here
      // also handles rows read from a pre-existing replay snapshot.
      if ((usesLoopGuard(msg) || hookContext !== undefined) && this.store.isLoopGuardOpen(loopScope)) {
        // First-open already purged the live backlog. Only a persisted startup row can
        // predate that purge; fresh spam is not yet in inbox, so avoid an O(inbox) scan
        // on every message while the durable latch is open.
        if (opts?.fromInboxReplay) this.purgeLoopScopeInbox(loopScope)
        this.log.warn(`dispatch: skipped ${msg.msgId}; loop guard is open for ${loopScope}`)
        settleAdmission({ accepted: false, reason: 'loop_protection' })
        resolve(null)
        return
      }
      // Old buggy daemons may have persisted Slack edit/assistant wrappers in the
      // durable inbox. Trip on the first poison row so patched startup is silent rather
      // than replaying even one complete malformed backlog.
      if (isMalformedPlatformTurn(msg)) {
        if (msg.isDm) {
          // A DM channel is one stable recovery scope even if the malformed wrapper
          // lost its thread. Non-DM wrappers may each have a synthetic outer ts, so
          // drop them without creating an unbounded set of permanent latches.
          const verdict = this.store.tripLoopGuard(loopScope, this.clock.now(), 'malformed_platform_event')
          if (verdict.trippedNow)
            this.onLoopGuardTripped(loopScope, verdict.reason ?? 'malformed_platform_event', {
              agentId,
              msg,
              integrationId
            })
          else this.purgeLoopScopeInbox(loopScope)
        } else {
          this.log.warn(`dispatch: dropped malformed Slack platform event ${msg.msgId}`)
        }
        settleAdmission({ accepted: false, reason: 'malformed_platform_event' })
        resolve(null)
        return
      }
      const entry: QueueEntry = {
        agentId,
        msg,
        initAbort: new AbortController(),
        ...(integrationId !== undefined ? { integrationId } : {}),
        ...(webchat ? { webchat } : {}),
        ...(callMeta ? { callMeta } : {}),
        ...(hookContext ? { hookContext } : {}),
        ...(opts?.onSessionReady ? { onSessionReady: opts.onSessionReady } : {}),
        ...(opts?.isQueueCmd ? { isQueueCmd: true } : {}),
        ...(githubReply ? { githubReply } : {}),
        ...(posterPublishState ? { posterPublishState } : {}),
        resolve,
        reject
      }
      // ── atomic claim-or-enqueue (single synchronous tick, no await before add) ──
      if (this.inflight.has(key)) {
        const q = this.serialQueue.get(key) ?? []
        // §4.4 backpressure: per-session queue-depth cap → queue_full fast-fail. The
        // rejected entry settles its OWN promise; nothing is admitted or persisted.
        if (q.length >= MAX_QUEUED_PER_SESSION) {
          this.log.warn(`dispatch: queue full for session ${key} (${q.length}) — rejecting (queue_full)`)
          settleAdmission({ accepted: false, reason: 'queue_full' })
          reject(new QueueFullError(key))
          return
        }
        // Replay is recovery of an admission already counted before shutdown, not a
        // fresh turn signal. Counting it again would let repeated restarts trip the
        // breaker on a valid backlog. Structurally malformed rows are still caught by
        // the unconditional poison check above.
        if (!opts?.replay && !this.admitLoopGuardTurn(agentId, msg, integrationId, opts?.inboxReplayId)) {
          settleAdmission({ accepted: false, reason: 'loop_protection' })
          resolve(null)
          return
        }
        // Genuinely admitted (queued behind an in-flight turn) → persist BEFORE returning,
        // so the caller's delivered:true ACK is backed by a durable row (§6.9 #353).
        let persistence: ReturnType<Daemon['persistInbox']>
        try {
          persistence = this.persistInbox(entry, key, {
            required: opts?.requireDurable,
            adoptExisting: opts?.adoptExistingInbox,
            existingId: opts?.inboxReplayId
          })
        } catch (err) {
          settleAdmission({ accepted: false, reason: 'durability' })
          reject(err)
          return
        }
        if (persistence === 'existing') {
          // The same stable delivery survived a restart and is already being
          // replayed (or awaits replay). Its original accepted ACK remains valid;
          // never create a second in-memory QueueEntry.
          settleAdmission({ accepted: true, duplicate: true })
          resolve(null)
          return
        }
        q.push(entry)
        this.serialQueue.set(key, q)
        settleAdmission({ accepted: true })
        this.log.debug(`dispatch: queued behind in-flight turn for session ${key} (depth ${q.length})`)
        return
      }
      // Claim ownership of the key in the SAME tick as the check, before any await.
      if (!opts?.replay && !this.admitLoopGuardTurn(agentId, msg, integrationId, opts?.inboxReplayId)) {
        settleAdmission({ accepted: false, reason: 'loop_protection' })
        resolve(null)
        return
      }
      // Genuinely admitted (claims the key, runs immediately) → persist BEFORE handing the
      // turn to runLoop, so a hard kill mid-turn leaves a replayable row (§6.9 #353).
      let persistence: ReturnType<Daemon['persistInbox']>
      try {
        persistence = this.persistInbox(entry, key, {
          required: opts?.requireDurable,
          adoptExisting: opts?.adoptExistingInbox,
          existingId: opts?.inboxReplayId
        })
      } catch (err) {
        settleAdmission({ accepted: false, reason: 'durability' })
        reject(err)
        return
      }
      if (persistence === 'existing') {
        settleAdmission({ accepted: true, duplicate: true })
        resolve(null)
        return
      }
      this.inflight.add(key)
      settleAdmission({ accepted: true })
      void this.runLoop(key, entry)
    })
  }

  /**
   * Own a sessionKey's serial gate: run its head turn to completion, settle that entry's
   * own promise, then drain the queue in FIFO order WITHOUT releasing ownership between
   * turns (§6.9 #390 — deleting `inflight` then dequeuing would reopen the FIFO race).
   * Ownership is released only once the queue is confirmed empty in the same synchronous
   * tick. Fail-stop is the default (§6.9 #378): if a turn throws, the rest of the queue is
   * NOT auto-run — each remaining entry is rejected with a notice and the queue cleared,
   * so buffered work never chains onto a broken session.
   */
  private paused(agentId: string): boolean {
    return this.agents.get(agentId)?.pause === true
  }

  /** Await a transient interrupt drain without broadening its target set. The wait set is
   *  additive, so loop until the runner removes the admission latch; a second interrupt
   *  that joins while we wait is therefore included automatically. */
  private async waitForSafetyDrain(agentId: string): Promise<void> {
    while (this.safetyDrainingAgents.has(agentId)) {
      await Promise.all([...(this.safetyDrainWaits.get(agentId) ?? [])])
    }
  }

  /** Gate new work until the selected active dispatches have fully unwound. Waits are
   *  additive: overlapping interrupts on different keys of one agent join the same drain
   *  instead of letting the first completion reopen admission too early. */
  private beginSafetyDrain(agentId: string, reason: TurnInterruptReason, keys?: Iterable<string>): void {
    const selected =
      keys === undefined
        ? [...(this.activeDispatchesByAgent.get(agentId) ?? [])]
        : [...keys]
            .map((key) => this.activeDispatchDoneByKey.get(key))
            .filter((done): done is Promise<void> => done !== undefined)
    if (selected.length === 0) return
    const waits = this.safetyDrainWaits.get(agentId) ?? new Set<Promise<void>>()
    for (const done of selected) waits.add(done)
    this.safetyDrainWaits.set(agentId, waits)
    this.safetyDrainingAgents.add(agentId)
    if (this.safetyDrainRuns.has(agentId)) return
    const token = Symbol(agentId)
    this.safetyDrainRuns.set(agentId, token)
    void (async () => {
      try {
        while (true) {
          const pending = [...(this.safetyDrainWaits.get(agentId) ?? [])]
          if (pending.length === 0) break
          await Promise.all(pending)
          const current = this.safetyDrainWaits.get(agentId)
          for (const done of pending) current?.delete(done)
        }
      } finally {
        // Agent remove/re-add can replace this runner. An old completion must never
        // delete a newer generation's admission gate or wait set.
        if (this.safetyDrainRuns.get(agentId) !== token) return
        this.safetyDrainWaits.delete(agentId)
        this.safetyDrainRuns.delete(agentId)
        this.safetyDrainingAgents.delete(agentId)
        this.log.info(`${reason}: interrupted turns fully stopped for agent "${agentId}"`)
      }
    })()
  }

  private addSafetyDrainWait(agentId: string, wait: Promise<void>): void {
    const waits = this.safetyDrainWaits.get(agentId) ?? new Set<Promise<void>>()
    waits.add(wait)
    this.safetyDrainWaits.set(agentId, waits)
  }

  private dispatchGateReason(entry: QueueEntry): TurnInterruptReason | undefined {
    if (entry.cancelledReason) return entry.cancelledReason
    if (this.paused(entry.agentId)) return 'pause'
    if (this.isLoopGuardOpen(entry.msg, entry.hookContext !== undefined)) return 'loop protection'
    return undefined
  }

  private beginActiveDispatch(agentId: string, key: string): () => void {
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => (resolveDone = resolve))
    const active = this.activeDispatchesByAgent.get(agentId) ?? new Set<Promise<void>>()
    active.add(done)
    this.activeDispatchesByAgent.set(agentId, active)
    this.activeDispatchDoneByKey.set(key, done)
    let released = false
    return () => {
      if (released) return
      released = true
      active.delete(done)
      if (active.size === 0) this.activeDispatchesByAgent.delete(agentId)
      this.clearColdCancelBackstop(key, done)
      if (this.activeDispatchDoneByKey.get(key) === done) this.activeDispatchDoneByKey.delete(key)
      resolveDone()
    }
  }

  private async admitActiveDispatch(agentId: string, key: string): Promise<() => void> {
    while (this.workspaceFileWrites.has(agentId)) await this.workspaceFileWrites.get(agentId)
    return this.beginActiveDispatch(agentId, key)
  }

  private async withWorkspaceFileWrite<T>(agentId: string, write: () => Promise<T>): Promise<T> {
    while (this.workspaceFileWrites.has(agentId)) await this.workspaceFileWrites.get(agentId)
    let release!: () => void
    const done = new Promise<void>((resolve) => (release = resolve))
    this.workspaceFileWrites.set(agentId, done)
    try {
      if (
        this.draining ||
        this.drainingAgents.has(agentId) ||
        this.safetyDrainingAgents.has(agentId) ||
        (this.activeDispatchesByAgent.get(agentId)?.size ?? 0) > 0 ||
        this.agentHasLiveSdkWork(agentId)
      ) {
        throw new WorkspaceConflictError('the agent is working in this workspace; retry when it is idle')
      }
      await this.stopHost(agentId)
      return await write()
    } finally {
      if (this.workspaceFileWrites.get(agentId) === done) this.workspaceFileWrites.delete(agentId)
      release()
    }
  }

  private holdReplyConnection(
    conn: SlackConnection | TelegramConnection | DiscordConnection | FeishuConnection | undefined
  ): () => void {
    if (!conn) return () => {}
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => (resolveDone = resolve))
    const uses = this.activeReplyConnectionUses.get(conn) ?? new Set<Promise<void>>()
    uses.add(done)
    this.activeReplyConnectionUses.set(conn, uses)
    let released = false
    return () => {
      if (released) return
      released = true
      uses.delete(done)
      if (uses.size === 0) this.activeReplyConnectionUses.delete(conn)
      resolveDone()
    }
  }

  private async waitForConnectionUses(
    conn: SlackConnection | TelegramConnection | DiscordConnection | FeishuConnection
  ): Promise<void> {
    // Derived integration mappings are removed before this is called, so no new
    // dispatch can capture `conn`. Loop defensively across the pre-pending lease
    // and Pending.done views until both are empty, then it is safe to stop.
    while (true) {
      const leases = [...(this.activeReplyConnectionUses.get(conn) ?? [])]
      const pending = [...this.pending.values()].filter((turn) => turn.conn === conn).map((turn) => turn.done)
      if (leases.length === 0 && pending.length === 0) return
      await Promise.all([...leases, ...pending])
    }
  }

  private async runLoop(key: string, firstEntry: QueueEntry): Promise<void> {
    let entry: QueueEntry | undefined = firstEntry
    try {
      while (entry) {
        this.activeGateEntries.set(key, entry)
        // Drain/pause gate re-check before EACH turn: while this loop held ownership the
        // agent may have started draining or been paused. Don't auto-run buffered work onto
        // a draining/paused unit — settle the rest as gate-dropped (null, same semantics as
        // dispatch's own gates) and release the key. Queued entries are handled here;
        // dispatchOne separately re-checks the admitted head to close the pause race.
        if (
          entry !== firstEntry &&
          (this.draining || this.drainingAgents.has(entry.agentId) || this.paused(entry.agentId))
        ) {
          this.terminateQueuedSink(entry)
          // Shutdown vs pause/per-agent-drain: on a genuine daemon SHUTDOWN (`this.draining`)
          // these rows are admitted-but-unrun and MUST survive on disk so startup replay
          // recovers them (§6.9 #353) — a caller was told delivered:true. Removing them here
          // (as we do for the pure-pause / per-agent `drainingAgents` gate-drop, whose
          // resolve(null) = intentionally dropped) would silently lose them. So keep on
          // shutdown, remove otherwise.
          if (!this.draining) {
            if (entry.hookContext) this.emitHookCompletion(entry.hookContext, 'failed', { reason: 'dropped' }, entry)
            this.removeInbox(entry)
          }
          entry.resolve(null)
          const rest = this.serialQueue.get(key) ?? []
          this.serialQueue.delete(key)
          for (const e of rest) {
            this.terminateQueuedSink(e)
            if (!this.draining) {
              if (e.hookContext) this.emitHookCompletion(e.hookContext, 'failed', { reason: 'dropped' }, e)
              this.removeInbox(e)
            }
            e.resolve(null)
          }
          this.inflight.delete(key)
          return
        }
        try {
          const releaseDispatch = await this.admitActiveDispatch(entry.agentId, key)
          let sessionId: string | null
          try {
            sessionId = await this.dispatchOne(entry, key)
          } finally {
            releaseDispatch()
          }
          // A turn that genuinely COMPLETED is done — remove its row even during a shutdown
          // drain (it must NOT replay). A cold turn explicitly aborted by shutdown is the
          // exception: it never ran, so retain its admitted row for startup replay.
          if (!(this.draining && entry.cancelledReason === 'shutdown')) this.removeInbox(entry)
          entry.resolve(sessionId)
        } catch (err) {
          // On shutdown (`this.draining`) the throw is the deadline-cancel unwinding a blocked
          // ACP prompt (drainForShutdown → host.cancel → dispatchOne throws). That message was
          // admitted (delivered:true); KEEP its row so startup replay recovers it. Only remove
          // on a genuine (non-shutdown) turn failure. Same for the queued `rest` below.
          if (!this.draining) this.removeInbox(entry)
          entry.reject(err)
          // Fail-stop: do NOT auto-continue draining onto a session whose turn just failed.
          // Reject every queued follow-up with a clear notice (their own promises) and drop
          // them; explicit retry/`!queue`/`!cancel` re-admits fresh. Then release the key.
          const rest = this.serialQueue.get(key) ?? []
          this.serialQueue.delete(key)
          for (const e of rest) {
            const failStop = new FailStopError(key)
            this.terminateQueuedSink(e, failStop.message)
            if (!this.draining) {
              if (e.hookContext) this.emitHookCompletion(e.hookContext, 'failed', { reason: 'fail_stop' }, e)
              this.removeInbox(e)
            }
            e.reject(failStop)
          }
          this.inflight.delete(key)
          return
        }
        // Still holding ownership: take the next queued head (if any) before releasing,
        // so a message arriving in the release window can't jump ahead of the queued head.
        const q = this.serialQueue.get(key)
        entry = q?.shift()
        if (q && q.length === 0) this.serialQueue.delete(key)
      }
      // Queue confirmed empty in this tick → release ownership atomically. A message that
      // arrives after this sees the key idle in dispatch() and claims it itself (in order).
      this.inflight.delete(key)
    } finally {
      this.activeGateEntries.delete(key)
    }
  }

  // The whole single-turn body (design §6.9 #377): sessions.handle() is only step one;
  // host.prompt, render/apply, usage/report and finalize all run here before the sessionId
  // is returned. The initialization-only channel-root path returns after session metadata,
  // before Pending/prompt. runLoop awaits either path so queued work cannot overtake it.
  private async dispatchOne(entry: QueueEntry, key: string): Promise<string | null> {
    const { agentId, msg, integrationId, webchat, callMeta, githubReply, hookContext, onSessionReady } = entry
    const initializeOnly = callMeta?.initializeOnly === true
    const evaluationTurnId = this.evaluationTurnIdFor(agentId, msg)
    let evaluationSessionId: string | undefined = undefined
    let evaluationTerminal = false
    const finishEvaluation = (
      type: 'turn.completed' | 'turn.failed' | 'turn.cancelled' | 'turn.timed_out',
      data: Record<string, unknown> = {}
    ): void => {
      if (initializeOnly) return
      if (evaluationTerminal) return
      evaluationTerminal = true
      this.emitEvaluation({
        type,
        agentId,
        ...(evaluationSessionId ? { sessionId: evaluationSessionId } : {}),
        turnId: evaluationTurnId,
        platform: msg.platform,
        channel: msg.channel,
        data
      })
    }
    const failEvaluation = (error: unknown): void => {
      const code = turnFailureCode(error)
      const timedOut = /tim(?:e|ed)[-_ ]?out/i.test(`${code} ${error instanceof Error ? error.name : ''}`)
      finishEvaluation(timedOut ? 'turn.timed_out' : 'turn.failed', {
        code,
        errorName: error instanceof Error ? error.name : 'UnknownError'
      })
    }
    // Pause/loop protection may race admission after dispatch() checked its gate but
    // before this loop starts. `cancelledReason` also remembers a quick reset.
    const initialGate = this.dispatchGateReason(entry)
    if (initialGate) {
      finishEvaluation('turn.cancelled', { reason: initialGate })
      this.terminateQueuedSink(entry)
      if (hookContext && !this.draining) {
        this.emitHookCompletion(hookContext, 'failed', { reason: initialGate }, entry)
      }
      this.log.info(`dispatch: skipped admitted turn ${msg.msgId} (${initialGate})`)
      return null
    }
    if (hookContext && !hookContext.turnStartedAt) {
      hookContext.turnStartedAt = new Date(this.clock.now()).toISOString()
      try {
        this.persistHookState(entry, undefined, true)
      } catch (err) {
        this.emitHookCompletion(hookContext, 'failed', { reason: 'durability' }, entry)
        throw err
      }
    }
    // §3.3 correlation-recording hook: if this turn is an agent→agent delivery carrying a
    // correlationId, it MAY be a worker reporting back to a main that owns an orchestration.
    // Record the result (owner-checked, trusted-callFrom, idempotent) BEFORE running the
    // turn, so a fast N-th report is already durable when the main re-reads getOrchestration.
    // Safe + additive: a non-matching/failed-check report is silently dropped.
    if (callMeta?.correlationId !== undefined) {
      this.recordWorkerReport(key, callMeta, msg.text)
    }
    const agent = this.agents.get(agentId)!
    let memoryCaptureTarget: PreparedExternalMemoryCapture | undefined
    if (this.evaluationProfile.memory === 'configured') {
      try {
        memoryCaptureTarget = this.memory.captureTargetForBinding(agent.memory)
      } catch (err) {
        // Runtime memory failures are fail-open for the user turn. Keep this
        // body-free; post-delivery capture will report a generic unavailable error.
        this.log.warn(
          `memory capture target unavailable for agent ${agentId}: ${err instanceof Error ? err.name : 'unknown'}`
        )
      }
    }
    const agentName = agent.displayName?.trim() || agent.name
    const iconUrl = agent.iconUrl
    // The recorder captures the full activity log (tool/reasoning) independent of
    // output mode — `conv` (built below, once the session key is known) only decides
    // what reaches Slack, never the transcript.
    const rec = new TranscriptRecorder()
    // Output verbosity for THIS turn: the sticky per-session override (status-bar picker)
    // wins over the agent default. Resolved BEFORE replyConn because `none` is a session-only
    // mode — the converger records the reply into the transcript (via `recordOnly` posts) but
    // delivers nothing to the IM, so it takes the same null-connection seam as headless/webchat.
    const mode = this.store.getOutputModeOverride(key) ?? agent.output.mode
    // Footer visibility is an agent-level delivery choice, snapshotted for this turn
    // alongside output mode. Turning it off removes attribution and session-link chrome
    // on every platform without changing the recorded transcript.
    const showFooter = agent.output.showFooter
    // A headless cron fire has no platform target — leave the connection unset so
    // every apply/status action no-ops (the transcript still records everything).
    // webchat likewise has no Slack connection: its reply streams through the relay
    // reply sink as `rd/chat`, so `conv`'s Slack actions never apply.
    // `none` output mode joins them: no status, status-bar, or reply reaches the channel;
    // only the converger's `recordOnly` body posts land in the transcript.
    const replyConn = msg.headless || webchat || mode === 'none' ? undefined : this.replyConnFor(agentId, integrationId)
    // Capture cold/warm BEFORE sessions.handle(), which boots the host via hostFor().
    const wasRunning = this.hostStarts.has(agentId)
    const statusThread = msg.thread ?? msg.msgId
    const currentTranscriptChannel = () => transcriptChannelKey(msg.channel, msg.transportScope)
    // Daemon-side rendering only (not ACP); a fresh converger is built per turn, so a change
    // applies from the next turn on, not mid-turn (see `mode`, resolved above before replyConn).
    const conv =
      msg.platform === 'telegram'
        ? // The continue-the-topic hint only earns its space in a group, where the reply chain
          // is the ONLY way back into this session; a DM has one implicit thread already.
          // Gated on showFooter, the agent-level switch for delivery chrome.
          new TelegramConverger(mode, { continueHint: showFooter && !msg.isDm })
        : msg.platform === 'discord'
          ? new DiscordConverger(mode)
          : msg.platform === 'feishu'
            ? new FeishuConverger(mode)
            : new OutputConverger(mode)
    const slackStatusOptions = this.slackStatusOptions(msg.platform, agentName, iconUrl)
    this.showActivity(
      replyConn,
      msg.channel,
      statusThread,
      wasRunning ? 'is thinking…' : 'is starting up…',
      slackStatusOptions
    )
    // handle() writes the row to `prompting` before returning; if it throws after
    // that (workspace/attachment failure), the try/finally below is never entered,
    // so reset to `idle` here — otherwise the session stays `prompting` forever and
    // never TTL-closes (the row no-ops if handle threw before creating it).
    const releaseReplyConn = this.holdReplyConnection(replyConn)
    // Install the exact route before session/new|load: adapters may emit metadata
    // (including a restored title) while SessionManager is still initializing.
    const previousDeliveryBinding = this.sessionDeliveryBindings.get(key)
    const deliveryBinding: SessionDeliveryBinding = {
      agentId,
      platform: msg.platform,
      ...(integrationId !== undefined ? { integrationId } : {}),
      isDm: msg.isDm
    }
    this.sessionDeliveryBindings.set(key, deliveryBinding)
    this.sessionInitializationsByAgent.set(agentId, (this.sessionInitializationsByAgent.get(agentId) ?? 0) + 1)
    const restoreDeliveryBinding = () => {
      if (this.sessionDeliveryBindings.get(key) !== deliveryBinding) return
      if (previousDeliveryBinding) this.sessionDeliveryBindings.set(key, previousDeliveryBinding)
      else this.sessionDeliveryBindings.delete(key)
    }
    let handled: {
      sessionId: string
      blocks: import('@agentclientprotocol/sdk').ContentBlock[]
      created: boolean
      skipped?: boolean
      captureInput?: string
      turnId?: string
      initializedOnly?: boolean
    }
    let delegatedHost: DelegatedWebchatHost | undefined
    try {
      // A prior provider post-turn operation is serialized. Managed needs this
      // barrier before reading its index; external recordTurn only durably enqueues.
      await (this.memoryPostTurnChains.get(agentId) ?? Promise.resolve())
      // The delegation is captured only from the validated relay envelope. Bind
      // the private broker cell and start its dedicated ACP process before the
      // first session/new|load so the descriptor and host can never diverge.
      if (webchat?.delegation && this.delegatedWebchatHosts) {
        delegatedHost = await this.delegatedWebchatHosts.startHost({
          agentId,
          conversationId: webchat.conversationId,
          delegationId: webchat.delegation.id,
          generation: webchat.delegation.generation,
          expiresAt: webchat.delegation.expiresAt
        })
        entry.selectedHost = this.selectedDelegatedTurnHost(agentId, webchat.conversationId, delegatedHost)
      }
      // §2.3/§5.3: hand the origin session id to prompt assembly so a child woken by another
      // session's `sendMessage` gets its `Parent session` line (the SessionTarget to reply into).
      handled = await this.sessions.handle(
        agentId,
        msg,
        entry.initAbort.signal,
        integrationId,
        callMeta?.originSessionId,
        agent.allowRuntimeChangesInChat ? webchat?.runtime?.effort : undefined,
        // §5.3: the parent asked to be told how this session ends — prompt assembly turns it into
        // a standing directive naming the origin as the reply target.
        callMeta?.needsReply,
        {
          initializeOnly,
          ...(delegatedHost
            ? {
                host: delegatedHost.host,
                additionalMcpServers: [delegatedHost.adminMcpServer]
              }
            : {})
        }
      )
    } catch (err) {
      this.beginFailedTurnCleanup(agentId, key, entry, entry.selectedHost)
      this.finishSessionInitialization(agentId)
      restoreDeliveryBinding()
      // handle() boots the host (hostFor → ensureHostAsync → host.start()), so a
      // failed agent start / ACP handshake surfaces HERE, before the prompt below.
      const interrupted = this.dispatchGateReason(entry)
      let cleanupOutcome!: TurnLifecycleCleanupOutcome
      try {
        // A force-stop may make session/new|load reject before the delegated
        // manager has released its broker cell and private HOME. Keep this cold
        // dispatch owned and non-idle until that exact cleanup operation settles.
        cleanupOutcome = await this.waitForTurnLifecycleCleanup(entry, key, entry.selectedHost)
        if (!cleanupOutcome.blocked) {
          this.store.setSessionState(key, 'idle', this.clock.now())
          // The turn died during initialization (agent spawn / ACP handshake), so it never reaches
          // the main finally that records an outcome. A parent polling this child must see `failed`,
          // not a session that looks idle-and-fine. An interrupt is not a failure of the work.
          if (!interrupted) this.store.setSessionTurnOutcome(key, 'failed', this.clock.now())
        }
        if (interrupted) {
          this.terminateQueuedSink(entry, interrupted)
          this.showActivity(replyConn, msg.channel, statusThread, '')
        } else
          this.surfaceTurnFailure(err, {
            agentId,
            agentName,
            ...(iconUrl ? { iconUrl } : {}),
            platform: msg.platform,
            isDm: msg.isDm,
            webchat,
            replyConn,
            channel: msg.channel,
            transcriptChannel: currentTranscriptChannel(),
            thread: msg.thread,
            statusThread
          })
      } finally {
        releaseReplyConn()
      }
      if (interrupted) {
        finishEvaluation('turn.cancelled', { reason: interrupted })
        if (hookContext && !this.draining) {
          this.emitHookCompletion(hookContext, 'failed', { reason: interrupted }, entry)
        }
        if (cleanupOutcome.blocked) throw new LifecycleCleanupBlockedError(key, cleanupOutcome.error)
        return null
      }
      failEvaluation(err)
      if (hookContext && !this.draining) {
        this.emitHookCompletion(hookContext, 'failed', { reason: 'session_start_failed' }, entry)
      }
      throw err
    }
    const { sessionId, blocks, created } = handled
    const transcriptChannel = currentTranscriptChannel()
    evaluationSessionId = sessionId
    if (handled.skipped) {
      finishEvaluation('turn.cancelled', { reason: 'already_delivered' })
      this.finishSessionInitialization(agentId)
      restoreDeliveryBinding()
      this.showActivity(replyConn, msg.channel, statusThread, '')
      this.terminateQueuedSink(entry)
      releaseReplyConn()
      this.log.debug(`dispatch: skipped already-delivered Slack event ${msg.msgId}`)
      return null
    }
    // A cold session can spend time booting/materializing inside sessions.handle(). If
    // pause landed in that window, no Pending existed for the transition hook to cancel.
    // Re-check before publishing metadata or prompting, restore the new row to idle, and
    // clear the transient Slack activity indicator.
    const initializedGate = this.dispatchGateReason(entry)
    if (initializedGate) {
      finishEvaluation('turn.cancelled', { reason: initializedGate })
      this.finishSessionInitialization(agentId)
      restoreDeliveryBinding()
      // session/new|load can return after host termination while manager cleanup
      // is still draining the private broker cell. Do not publish idle early.
      const cleanupOutcome = await this.waitForTurnLifecycleCleanup(entry, key, entry.selectedHost)
      if (!cleanupOutcome.blocked) {
        const interruptedSession = this.store.getSession(key)
        if (created && interruptedSession?.acpSessionId === sessionId) {
          // The runtime created this ACP session after the turn was already terminal.
          // Do not let a quick pause→unpause (or loop reset) revive that never-prompted
          // session as if it were valid conversation state.
          this.store.upsertSession({
            ...interruptedSession,
            acpSessionId: null,
            state: 'idle',
            lastDeliveredTs: null,
            updatedAt: this.clock.now()
          })
        } else {
          this.store.setSessionState(key, 'idle', this.clock.now())
        }
      }
      this.showActivity(replyConn, msg.channel, statusThread, '')
      this.terminateQueuedSink(entry)
      releaseReplyConn()
      if (hookContext && !this.draining) {
        this.emitHookCompletion(hookContext, 'failed', { reason: initializedGate }, entry)
      }
      this.log.info(`dispatch: skipped initialized turn ${msg.msgId} (${initializedGate})`)
      if (cleanupOutcome.blocked) throw new LifecycleCleanupBlockedError(key, cleanupOutcome.error)
      return null
    }
    // A cold session can await workspace/host/session initialization while the Agent is
    // reconciled. Persist staged first-turn choices only against the current authority,
    // never the Agent snapshot captured before sessions.handle().
    const initializedAgent = this.agents.get(agentId)
    const stagedRuntime =
      initializedAgent?.allowRuntimeChangesInChat === true && webchat?.runtime ? webchat.runtime : undefined
    if (stagedRuntime?.model !== undefined) this.store.setModelOverride(key, stagedRuntime.model)
    if (stagedRuntime?.effort !== undefined) this.store.setEffortOverride(key, stagedRuntime.effort)
    if (stagedRuntime?.permissionMode !== undefined) {
      this.store.setPermissionModeOverride(key, stagedRuntime.permissionMode)
    }
    if (stagedRuntime?.fastMode !== undefined) this.store.setFastModeOverride(key, stagedRuntime.fastMode)
    // sessions.handle() booted the host — surface any spawn-time config warnings
    // (config-file secret conflicts / write failures) into this session.
    this.flushSpawnNotices(agentId, {
      replyConn,
      channel: msg.channel,
      transcriptChannel,
      thread: msg.thread,
      statusThread
    })
    // First metadata snapshot: enough for the CP's DB-backed session list/detail to
    // resolve this daemon-local session without pulling `session/list` on every view.
    if (created) {
      // Classify for session visibility BEFORE the first milestone: the CP's
      // ingest is first-wins, and the daemon's own capture gate must be closed
      // from turn one for anything that could be private (session-visibility.md
      // §4.1/§5.1). Persisted on the session row so later re-emits — including
      // after a restart, when `msg` is long gone — still carry the same facts.
      this.classifyNewSession(agentId, key, sessionId, msg, callMeta !== undefined, webchat?.evaluation === true)
      this.emitSessionMetadataSnapshot({
        sessionId,
        agentId,
        phase: 'start',
        platform: msg.platform,
        channel: msg.channel,
        thread: statusThread
      })
      // A first-seen Telegram/Discord/Feishu chat widens the observed reachable set
      // (approach-A discovery) — report it after the session row exists so the console
      // cannot miss a name lookup that completed during cold session startup.
      if (msg.platform === 'telegram' || msg.platform === 'discord' || msg.platform === 'feishu') {
        this.refreshObservedChannels()
      }
    }
    this.finishSessionInitialization(agentId, sessionId)
    try {
      onSessionReady?.(sessionId)
    } catch (err) {
      this.log.warn(`dispatch: session-ready notification failed (${formatErr(err)})`)
    }
    if (handled.initializedOnly) {
      this.showActivity(replyConn, msg.channel, statusThread, '')
      releaseReplyConn()
      this.log.info(`dispatch: initialized session ${key} from self-authored channel root without a model turn`)
      return sessionId
    }
    let resolveDone!: () => void
    const done = new Promise<void>((r) => (resolveDone = r))
    // Add the streaming fields onto the SAME webchat object held by QueueEntry. Sharing
    // `doneSent` closes a Pending-vs-gate race where cancel could otherwise terminally
    // signal each copy once.
    const pendingWebchat = webchat ? Object.assign(webchat, { index: 0, replyText: '' }) : undefined
    if (!entry.selectedHost) {
      const ordinaryHost = this.hosts.get(agentId)
      if (ordinaryHost) entry.selectedHost = this.selectedOrdinaryTurnHost(agentId, ordinaryHost)
    }
    const p: Pending = {
      entry,
      conv,
      rec,
      replyText: '',
      builtinSystemToolCallIds: new Set(),
      hiddenSessionTitleToolCallIds: new Set(),
      agentId,
      agentName,
      requesterId: msg.sender.id,
      ...(integrationId !== undefined ? { integrationId } : {}),
      ...(iconUrl ? { iconUrl } : {}),
      platform: msg.platform,
      isDm: msg.isDm,
      loopGuardScope: loopGuardScope(msg),
      sessionKey: key,
      acpSessionId: sessionId,
      ...(entry.selectedHost ? { selectedHost: entry.selectedHost } : {}),
      channel: msg.channel,
      transcriptChannel,
      thread: msg.thread,
      ...(this.telegramReplyTarget(msg) !== undefined ? { tgReplyTo: this.telegramReplyTarget(msg) } : {}),
      statusThread,
      conn: replyConn,
      // Snapshot alongside `conn`: true only when `none` removed THIS turn's Slack permission
      // card surface (not Telegram/Discord/Feishu, webchat, or headless). Frozen for the turn
      // so a mid-turn mode flip can't desync the permission policy from the already-cleared
      // connection (auto-allow regression).
      approvalSurfaceSuppressed: noneSuppressedApprovalSurface(mode, {
        platform: msg.platform,
        webchat,
        headless: msg.headless
      }),
      runtimeCostReported: false,
      usageReportSent: false,
      evaluationTurnId,
      statusCancellable: true,
      applyChain: Promise.resolve(),
      done,
      resolveDone,
      ...(callMeta ? { callMeta } : {}),
      ...(pendingWebchat ? { webchat: pendingWebchat } : {}),
      ...(githubReply && entry.posterPublishState !== 'in_flight' && entry.posterPublishState !== 'settled'
        ? { github: { ...this.makeGithubReply(agentId, githubReply, sessionId), deferredFinalTranscript: false } }
        : {})
    }
    this.pending.set(pendingTurnKey(agentId, sessionId), p)
    // §6.7 active-turn context: expose THIS turn's trusted callMeta by logical sessionKey so
    // a nested messageAgent made during the turn can auto-inherit hop/origin + reply-correlation.
    if (callMeta) this.activeTurnCallMeta.set(key, callMeta)
    const activeGithub = await this.prepareGithubTurn(entry, sessionId).catch((err) => {
      this.log.warn(`github review: turn setup failed (${formatErr(err)})`)
      return undefined
    })
    if (activeGithub) this.activeGithubTurnMeta.set(key, activeGithub)
    let finalPhase: EventSession['phase'] = 'end'
    let turnModel: string | undefined
    let propagatingTurnError = false
    const currentAttributionInfo = (): SlackAttributionInfo => ({
      botName: agent.name,
      botUrl: this.agentLink(agentId),
      runtime: this.runtimeNames[agent.runtime] ?? agent.runtime,
      model: this.buildStatusInfo(p).model ?? turnModel ?? 'default',
      sessionUrl: this.sessionLink(sessionId)
    })
    try {
      if (!p.selectedHost) {
        const ordinaryHost = await this.ensureHostAsync(agentId)
        p.selectedHost = this.selectedOrdinaryTurnHost(agentId, ordinaryHost)
        entry.selectedHost = p.selectedHost
      }
      const host = p.selectedHost.host
      const runtimeAgent = this.agents.get(agentId)
      const allowRuntimeChangesInChat = runtimeAgent?.allowRuntimeChangesInChat === true
      // Re-apply a sticky session model override (set via the console's in-session model
      // switch) before the turn runs — the agent's default model was applied at
      // session/new, so this layers the per-session choice on top each turn. Best-effort.
      const override = allowRuntimeChangesInChat ? this.store.getModelOverride(key) : undefined
      if (override) {
        await host
          .setSessionModel(sessionId, override)
          .catch((err) => this.log.debug(`model override "${override}" not applied: ${(err as Error).message}`))
      }
      // Re-apply the remaining sticky controls. Effort is applied AFTER the model
      // because the offered levels depend on it; `ultracode` rides session `_meta`
      // at new/load instead (setSessionEffort returns false for it). Best-effort.
      const effortOverride = allowRuntimeChangesInChat ? this.store.getEffortOverride(key) : undefined
      if (effortOverride) {
        await host
          .setSessionEffort(sessionId, effortOverride)
          .catch((err) => this.log.debug(`effort override "${effortOverride}" not applied: ${(err as Error).message}`))
      }
      const permissionModeOverride = allowRuntimeChangesInChat ? this.store.getPermissionModeOverride(key) : undefined
      const effectivePermissionMode =
        permissionModeOverride ??
        runtimeAgent?.permissionMode ??
        this.runtimeCatalogs.get(runtimeAgent?.runtime ?? agent.runtime)?.defaultPermissionMode
      // AcpHost provides this method; older injected/embedded hosts may not.
      // Treat the selector as an advertised capability, matching the other
      // optional runtime controls, while real hosts still restore the Agent policy.
      if (effectivePermissionMode && typeof host.setSessionPermissionMode === 'function') {
        await host
          .setSessionPermissionMode(sessionId, effectivePermissionMode)
          .catch((err) =>
            this.log.debug(`permission-mode "${effectivePermissionMode}" not applied: ${(err as Error).message}`)
          )
      }
      const fastOverride = allowRuntimeChangesInChat ? this.store.getFastModeOverride(key) : undefined
      if (fastOverride !== undefined) {
        await host
          .setSessionFastMode(sessionId, fastOverride)
          .catch((err) => this.log.debug(`fast-mode override ${fastOverride} not applied: ${(err as Error).message}`))
      }
      // Runtime setters above await the adapter and can race another reconciliation.
      // Fence immediately before prompt; a revoked permission must be restored
      // synchronously here, not by reconcile's fire-and-forget live-session sweep.
      const promptAgent = this.agents.get(agentId)
      if (webchat?.runtime && promptAgent?.allowRuntimeChangesInChat !== true) {
        this.store.clearRuntimeConfigOverrides(agentId)
        await this.applyConfiguredRuntimeSettings(promptAgent ?? agent, host, sessionId)
      }
      // Pause/loop protection may land while a slow host is starting or sticky
      // overrides are being restored. At this point Pending exists but no prompt has
      // begun; re-check so a cancel that had no live host cannot race into new work.
      const readyGate = this.dispatchGateReason(entry)
      if (readyGate) {
        finishEvaluation('turn.cancelled', { reason: readyGate })
        this.showActivity(replyConn, msg.channel, statusThread, '')
        this.terminateQueuedSink(entry)
        if (readyGate === 'loop protection') finalPhase = 'problem'
        if (hookContext && !this.draining) {
          this.emitHookCompletion(hookContext, 'failed', { sessionId, reason: readyGate }, entry)
        }
        this.log.info(`dispatch: skipped ready turn ${msg.msgId} (${readyGate})`)
        return null
      }
      // Capture the model for THIS session/turn after sticky overrides are applied.
      // AcpHost owns multiple sessions, so its no-arg selector may describe another
      // conversation; the session-scoped lookup avoids pricing with that stale model.
      // Optional call keeps older/test host stubs compatible; real AcpHost always
      // implements the session-scoped selector.
      const modelOptions = host.modelOptions?.(sessionId) ?? null
      const advertisedModel = modelOptions?.current
      // A runtime-owned "default" is not a public billable model id. Only fall
      // back to config when no selector exists at all; otherwise a failed override
      // could make us price a model that did not actually run.
      turnModel =
        modelOptions === null
          ? (override ?? agent.runtimeOverrides?.model)
          : advertisedModel === 'default'
            ? undefined
            : advertisedModel
      // Prepare the linked footer before host.prompt can emit its first chunk. Reply
      // sections then include it in their initial chat.postMessage, where Slack's
      // unfurl controls are supported; onFinal normally observes the same footer and
      // becomes a no-op instead of introducing URLs later through chat.update.
      if (showFooter && p.platform === 'slack') {
        const attribution = buildAttributionBlocks(currentAttributionInfo())
        p.attribution = { blocks: attribution.blocks, key: JSON.stringify(attribution.blocks) }
      }
      // Feishu's answer surface exists before the first ACP token: one CardKit entity
      // starts in a generic Thinking state, then all body updates and the final footer
      // replace that same card. `none` mode returns no start action.
      if (conv instanceof FeishuConverger) {
        for (const action of conv.onStart()) this.enqueueApply(p, action)
      }
      if (!wasRunning) this.showActivity(replyConn, msg.channel, statusThread, 'is thinking…', slackStatusOptions)
      // Post/refresh the session status bar up front — with the model now known (session
      // created) plus any usage carried over from prior turns — so it sits at the top of
      // the thread before the reply streams in.
      this.emitStatusBar(p)
      // Config-file secrets deleted by the idle sweep come back BEFORE the turn
      // reaches the child — synchronous, so the guarantee is ordering, not timing.
      this.rematerializeConfigFiles(agentId)
      const runtimeAgentInfo = host.acpAgentInfo?.()
      const acpVersion = host.acpProtocolVersion?.()
      this.emitEvaluation({
        type: 'turn.started',
        agentId,
        sessionId,
        turnId: evaluationTurnId,
        platform: msg.platform,
        channel: msg.channel,
        data: {
          input: handled.captureInput ?? msg.text,
          created,
          runtime: agent.runtime,
          ...(turnModel ? { model: turnModel } : {}),
          ...(runtimeAgentInfo?.name ? { runtimeProvider: runtimeAgentInfo.name } : {}),
          ...(runtimeAgentInfo?.version ? { runtimeVersion: runtimeAgentInfo.version } : {}),
          ...(acpVersion ? { acpVersion } : {})
        }
      })
      const { stopReason, usage } = await host.prompt(sessionId, blocks)
      // A completed prompt proves the runtime's credentials work — drop any
      // login-required mark (no-op emit unless the flag actually flips).
      this.noteRuntimeAuthFromTurn(agent.runtime, false)
      if (p.outputSuppressed) {
        finishEvaluation('turn.cancelled', { reason: p.outputSuppressed })
        if (p.outputSuppressed === 'loop protection') finalPhase = 'problem'
        if (hookContext && !this.draining) {
          this.emitHookCompletion(hookContext, 'failed', { sessionId, reason: p.outputSuppressed }, entry)
        }
        return null
      }
      if (usage) {
        const counts = {
          totalTokens: usage.totalTokens,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          thoughtTokens: usage.thoughtTokens ?? undefined,
          cachedReadTokens: usage.cachedReadTokens ?? undefined,
          cachedWriteTokens: usage.cachedWriteTokens ?? undefined
        }
        // ACP's Usage is still experimental and adapters disagree on its fold
        // semantics. codex-acp v1.1.x explicitly returns the current turn's
        // `lastTokenUsage`; established adapters in this daemon remain latest-wins.
        if (this.isCodexRuntime(agentId)) {
          this.store.addTokenUsage(key, counts)
          if (!p.runtimeCostReported) {
            const estimate = estimateOpenAiTurnCost(turnModel, counts)
            if (estimate.ok) {
              if (!this.store.addCost(key, estimate.amount, estimate.currency)) {
                this.log.debug(`cost fallback skipped for session ${sessionId}: existing currency differs from USD`)
              }
            } else {
              this.log.debug(
                `cost fallback unavailable for session ${sessionId} model=${turnModel ?? '(unknown)'}: ${estimate.reason}`
              )
            }
          }
        } else {
          this.store.setTokenUsage(key, counts)
        }
      }
      // Turn-end refresh: the token totals only arrive here (the prompt response), so
      // fold them into the bar now.
      this.emitStatusBar(p)
      // Report the session's merged cumulative usage (tokens + the latest cost/
      // context snapshot folded in from usage_update) to the CP for the console's
      // historical dashboard. Fire-and-forget; no-op if the CP is down. Wrapped so
      // a transport hiccup can never abort the turn before the final reply flush.
      this.emitStoredUsageReport(sessionId, agentId, msg.platform, msg.channel, key)
      p.usageReportSent = true
      // turn finished: stop any pending idle-flush, then drain the final actions
      // (remaining body + status clear + optional Web App detail link). A webchat
      // turn skips the Slack renderer entirely — its reply already streamed through
      // the relay reply sink — and closes that `rd/chat` stream with a done event.
      this.clearIdle(p)
      this.clearFeishuStream(p)
      if (p.webchat) {
        // Record the agent's reply as a transcript text row (sender = agentId), so a
        // webchat session reads back with its reply like any Slack session does — the
        // Slack path records this at its `post` boundary, which webchat never hits.
        if (p.webchat.replyText.trim())
          this.store.appendTranscript({
            channel: p.transcriptChannel,
            thread: statusThread,
            // Shares the strictly-monotonic clock with the inbound user message so a fast
            // turn can't stamp both with the same ms and lose the reply to the unique index.
            ts: monotonicTs(),
            sender: agentId,
            kind: 'text',
            text: p.webchat.replyText
          })
        if (!p.webchat.doneSent) {
          p.webchat.doneSent = true
          p.webchat.sink.done({
            conversationId: p.webchat.conversationId,
            turnId: p.webchat.turnId,
            ...(stopReason ? { stopReason } : {}),
            ...(usage?.totalTokens !== undefined ? { usage: { used: usage.totalTokens } } : {})
          })
        }
      } else {
        const link = showFooter ? this.sessionLink(sessionId) : undefined
        const finalAttributionInfo = showFooter ? currentAttributionInfo() : undefined
        // A runtime may only publish its final session-scoped model during prompt.
        // Refresh before enqueueing the final body so any not-yet-sent section is born
        // with the final metadata; an already-sent section is updated in place below.
        if (showFooter && p.platform === 'slack' && finalAttributionInfo) {
          const attribution = buildAttributionBlocks(finalAttributionInfo)
          p.attribution = { blocks: attribution.blocks, key: JSON.stringify(attribution.blocks) }
        }
        // Telegram/Discord keep their existing session-link footer. Slack closes the
        // lifecycle for the compact context already included in the latest reply's
        // initial post and retries any stale-section cleanup.
        const finals =
          conv instanceof FeishuConverger
            ? conv.onFinal(finalAttributionInfo)
            : conv instanceof TelegramConverger || conv instanceof DiscordConverger
              ? conv.onFinal(link)
              : conv.onFinal(finalAttributionInfo)
        for (const action of finals) this.enqueueApply(p, action)
      }
      // …and any trailing reasoning the agent emitted after its last reply.
      for (const ev of rec.onFinal()) this.recordEvent(agentId, transcriptChannel, statusThread, ev)
      await p.applyChain
      // The user-visible reply is now delivered. Enqueue provider work without
      // awaiting it: managed may distill, while external only commits its durable
      // capture outbox. Webchat carries the canonical per-turn id separately from
      // its conversation-stable message id.
      this.queueMemoryPostTurn(
        agentId,
        sessionId,
        p.webchat?.turnId ?? handled.turnId ?? stableTurnId(agentId, msg),
        handled.captureInput ?? msg.text,
        p.replyText,
        agent.memory,
        memoryCaptureTarget,
        evaluationTurnId
      )
      finishEvaluation('turn.completed', {
        ...(stopReason ? { stopReason } : {}),
        output: p.replyText,
        ...(usage
          ? {
              usage: {
                totalTokens: usage.totalTokens,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                thoughtTokens: usage.thoughtTokens,
                cachedReadTokens: usage.cachedReadTokens,
                cachedWriteTokens: usage.cachedWriteTokens
              }
            }
          : {})
      })
    } catch (err) {
      this.beginFailedTurnCleanup(agentId, key, entry, p.selectedHost)
      // The turn failed before yielding a clean stop — the agent couldn't start (spawn
      // failure / ACP handshake), or the prompt itself rejected. Without surfacing
      // it here the failure is invisible: Slack keeps its "is thinking…" status with
      // no message, and a webchat client never gets a relay `done` item so it
      // spins forever. Emit a terminal error to whichever transport owns this turn. The
      // rethrow below propagates to runLoop, which rejects THIS entry's promise and
      // applies fail-stop (§6.9 #378): buffered messages don't chain onto a failure.
      this.clearIdle(p)
      this.clearFeishuStream(p)
      // A live turn can reveal a login problem the probe sweep can't see
      // (claude-agent-acp initializes and opens sessions fine while logged out):
      // ACP -32000 = fresh logged-out credential; a provider_auth_required
      // classification catches the expired/revoked-credential family that
      // adapters surface as -32603 internal errors with auth wording.
      if (isAuthRequiredError(err) || turnFailureCode(err) === HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED)
        this.noteRuntimeAuthFromTurn(agent.runtime, true)
      if (p.outputSuppressed) {
        finishEvaluation('turn.cancelled', { reason: p.outputSuppressed })
        if (p.outputSuppressed === 'loop protection') finalPhase = 'problem'
        if (hookContext && !this.draining) {
          this.emitHookCompletion(hookContext, 'failed', { sessionId, reason: p.outputSuppressed }, entry)
        }
        return null
      }
      // From here this catch owns a genuine turn failure that must remain the
      // outward dispatch error even if the selected host's cleanup also fails.
      // Set this before failure surfacing so finally cannot replace any error
      // raised while preserving/reporting the original failure.
      propagatingTurnError = true
      failEvaluation(err)
      finalPhase = 'problem'
      if (p.webchat) {
        // Reply text (including a runtime's mirrored error text) already streamed to
        // the client via onAcpUpdate; the terminal done frame carries the reason.
        // Record what streamed so the session reads back with it, like the success
        // path does — the sink is a live transport with no post boundary of its own.
        this.surfaceTurnFailure(err, {
          agentId,
          agentName,
          ...(iconUrl ? { iconUrl } : {}),
          platform: msg.platform,
          isDm: msg.isDm,
          webchat,
          replyConn,
          channel: msg.channel,
          transcriptChannel,
          thread: msg.thread,
          statusThread
        })
        if (p.webchat.replyText.trim())
          this.store.appendTranscript({
            channel: p.transcriptChannel,
            thread: statusThread,
            ts: monotonicTs(),
            sender: agentId,
            kind: 'text',
            text: p.webchat.replyText
          })
      } else {
        // Some runtimes narrate their terminal error into the message stream just
        // before rejecting the prompt — codex-acp mirrors quota exhaustion / auth
        // expiry as an agent_message_chunk — and that text is still sitting in the
        // converger buffer (the idle flush never fired). Flush it as the reply so it
        // isn't dropped with the turn, and skip the ⚠️ notice when the flushed text
        // already carries the same message (posting both would say it twice). The
        // notice rides the apply chain as a `post` so it lands after the flushed
        // body and is recorded into the transcript either way.
        const reason = turnFailureReason(err)
        if (p.conv instanceof FeishuConverger) {
          const attribution = showFooter ? currentAttributionInfo() : undefined
          for (const action of p.conv.onFailure(reason, attribution)) this.enqueueApply(p, action)
        } else {
          let covered = false
          for (const action of p.conv.flushBuffered()) {
            covered ||= action.kind === 'post' && action.text.includes(reason)
            this.enqueueApply(p, action)
          }
          if (!covered)
            this.enqueueApply(p, {
              kind: 'post',
              text: `⚠️ Agent failed to respond: ${reason}`,
              attributed: false
            })
        }
        this.showActivity(replyConn, msg.channel, statusThread, '') // clear "is thinking…"
        await p.applyChain
      }
      if (hookContext && !this.draining) {
        this.emitHookCompletion(hookContext, 'failed', { sessionId, reason: turnFailureCode(err) }, entry)
      }
      throw err
    } finally {
      // The ACP prompt is no longer capable of ignoring session/cancel once control
      // reaches cleanup. Clear its host-kill backstop BEFORE awaiting renderer I/O;
      // renderer drain is tracked separately by this dispatch/safety lease.
      this.clearCancelBackstop(agentId, sessionId)
      // Remove Cancel run before releasing the Slack transport. Suppressed turns still
      // allow this one terminal chrome update; ordinary queued output remains blocked.
      this.settleStatusBar(p)
      await p.applyChain.catch(() => {})
      // Success normally retries stale footer removals through the final attribution
      // action. Failure/suppression can bypass that action, so give any retained rows
      // the same terminal retry before releasing the Slack transport.
      if (p.platform === 'slack' && p.conn && p.staleReplyFooters?.length) {
        await this.clearStaleSlackReplyFooters(p.conn as SlackConnection, p)
      }
      // The reply transport is no longer used after the final apply chain / failure
      // notice. Release before local metadata cleanup so even a cleanup exception
      // cannot strand the connection lease forever.
      releaseReplyConn()
      this.clearIdle(p)
      this.clearFeishuStream(p)
      // Backstop: settle any permission / elicitation card still awaiting a tap.
      this.releaseElicits(agentId, sessionId)
      this.releaseChatPermissions(agentId, sessionId)
      this.releaseEditorPermissions(agentId, sessionId)
      // §6.7: this turn's active call context ends with the turn (a nested messageAgent can
      // only inherit while the turn is in flight). Only clear if THIS turn owns the entry —
      // the map is keyed by sessionKey and the gate guarantees one active turn per key.
      if (callMeta) this.activeTurnCallMeta.delete(key)
      if (activeGithub && this.activeGithubTurnMeta.get(key) === activeGithub) this.activeGithubTurnMeta.delete(key)
      // A headless GitHub hook has no platform-send boundary. Explicit final chunks
      // were withheld from OutputConverger above, so persist the collector's one
      // logical final now instead of one row per idle/size flush.
      const githubFinal =
        p.github && !p.outputSuppressed && finalPhase === 'end' ? p.github.collector.finalText(true) : undefined
      if (p.github?.deferredFinalTranscript && githubFinal?.trim()) {
        this.store.appendTranscript({
          channel: p.transcriptChannel,
          thread: p.statusThread,
          ts: monotonicTs(),
          sender: p.agentId,
          kind: 'text',
          text: githubFinal
        })
      }
      const fallbackAllowed = githubFallbackAllowed(hookContext)
      // Anything other than no attempt or a correlated definite no-effect
      // result is fail-closed: GitHub may already own the public response.
      if (githubReply && !fallbackAllowed) {
        try {
          this.persistHookState(entry, 'settled', true)
        } catch (err) {
          // Keep the no-second-write decision fail-closed. Terminal hook completion
          // below makes a second durable settlement attempt while retaining the
          // unredacted inbox row if local persistence is still unavailable.
          this.log.warn(`github poster: formal-review settlement failed (${formatErr(err)})`)
        }
      } else if (p.github && !p.outputSuppressed) {
        // With no formal effect (or a proved not_submitted effect), the ordinary
        // final remains the fallback. publish() is time-bounded and degrading.
        let recordedInFlight = false
        try {
          // A replay of `in_flight` suppresses another comment. If this write
          // cannot be made durable, fail closed and do not perform the POST.
          this.persistHookState(entry, 'in_flight', true)
          recordedInFlight = true
        } catch (err) {
          this.log.warn(`github poster: durability barrier failed; final publish skipped (${formatErr(err)})`)
        }
        if (recordedInFlight) {
          await p.github.poster
            .publish(githubFinal)
            .catch((err) => this.log.warn(`github poster: final publish failed (${formatErr(err)})`))
          this.persistHookState(entry, 'settled')
        }
      }
      // A delegated force-stop can unwind prompt before broker release and HOME
      // removal complete. Pending ownership and the non-idle session state are the
      // final safety fence, so release them only after the exact selected cleanup.
      const cleanupOutcome = await this.waitForTurnLifecycleCleanup(entry, key, p.selectedHost)
      if (!cleanupOutcome.blocked) {
        this.pending.delete(pendingTurnKey(agentId, sessionId))
        // §7.3 prompting/cancelling → idle: the turn is over (cleanly, on error, or
        // cancelled), so the session is idle again. Without this the row stayed
        // `prompting` forever — the thread never went idle and TTL-close never fired.
        this.store.setSessionState(key, 'idle', this.clock.now())
        // Record HOW it ended alongside the state, so a parent polling `viewSessionStatus` can tell
        // a finished child from a broken one. `problem` is the same phase the CP snapshot below
        // reports, so the two never disagree.
        this.store.setSessionTurnOutcome(key, finalPhase === 'problem' ? 'failed' : 'done', this.clock.now())
        this.emitSessionMetadataSnapshot({
          sessionId,
          agentId,
          phase: finalPhase,
          platform: msg.platform,
          channel: msg.channel,
          thread: statusThread
        })
        p.resolveDone()
      } else if (!propagatingTurnError) {
        // Success/cancel has no original error for runLoop to fail-stop on. Use
        // the internal sentinel only in that case; a real prompt error must leave
        // this finally unchanged and continue propagating from the catch above.
        throw new LifecycleCleanupBlockedError(key, cleanupOutcome.error)
      }
    }
    // Turn finished cleanly. Draining the next queued message for this sessionKey is
    // runLoop's job (it holds ownership across turns) — NOT here. On a throw, the catch
    // above rethrows and runLoop applies fail-stop (§6.9 #378).
    if (hookContext) this.emitHookCompletion(hookContext, 'success', { sessionId }, entry)
    return sessionId
  }

  // ── §7.3 force-cancel backstop ──────────────────────────────────────────────

  /** Interrupt a session by its LOGICAL sessionKey (shared by pause, `!stop`, `!cancel`,
   *  and webchat cancel): settle+drop anything queued behind it in the serial gate, then — if
   *  a turn is actually in flight (ACP session live) — release any unanswered cards, mark
   *  it `cancelling`, send ACP `session/cancel`, and arm the force backstop. Works for a
   *  queued-but-not-yet-started or cold session too (§6.9 #390): draining the queue is
   *  enough, no ACP id required. Muting is the CALLER's concern — `!stop` mutes,
   *  `!cancel`/webchat-cancel do not. */
  private interruptTurn(
    agentId: string,
    key: string,
    reason: TurnInterruptReason,
    acpSessionId?: string,
    opts: { dropQueued?: boolean } = {}
  ): void {
    // The force-cancel fallback is host-wide. Hold NEW admissions until this exact
    // dispatch is gone so a quick retry cannot be killed by the old turn's backstop.
    this.beginSafetyDrain(agentId, reason, [key])
    // Latch the current head even during the cold pre-Pending window. A quick reset
    // must not let pre-interrupt work resume once sessions.handle() returns.
    const activeEntry = this.activeGateEntries.get(key)
    if (activeEntry) {
      activeEntry.cancelledReason ??= reason
      // An explicit interrupt makes the head terminal. Delete its durable row now,
      // not only after ACP unwinds, so an immediate daemon stop cannot replay it.
      this.removeInbox(activeEntry)
    }
    // Drop everything buffered behind this turn first (one unified queue) and settle each
    // waiter's own promise, so `!cancel`/`!stop` doesn't leave queued dispatch() promises
    // hanging and the drained queue can't later chain onto the cancelled turn.
    const queued = this.serialQueue.get(key)
    if (queued && queued.length > 0) {
      this.serialQueue.delete(key)
      for (const e of queued) {
        this.terminateQueuedSink(e, opts.dropQueued ? undefined : reason)
        if (e.hookContext) {
          this.emitHookCompletion(e.hookContext, 'failed', { reason: opts.dropQueued ? 'dropped' : 'cancelled' }, e)
        }
        this.removeInbox(e)
        if (opts.dropQueued) e.resolve(null)
        else e.reject(new FailStopError(key))
      }
    }
    const live = acpSessionId
      ? this.pending.get(pendingTurnKey(agentId, acpSessionId))
      : [...this.pending.values()].find((pending) => pending.sessionKey === key)
    const liveSessionId = acpSessionId ?? live?.acpSessionId
    if (live) {
      this.settleStatusBar(live)
      live.outputSuppressed ??= reason
      this.clearIdle(live)
      this.clearFeishuStream(live)
      if (live.platform === 'feishu') {
        this.enqueueApply(live, { kind: 'card-cancel' }, { allowWhenSuppressed: true })
      }
      this.showActivity(live.conn, live.channel, live.statusThread, '')
      if (live.webchat && !live.webchat.doneSent) {
        live.webchat.doneSent = true
        live.webchat.sink.done({
          conversationId: live.webchat.conversationId,
          turnId: live.webchat.turnId,
          error: reason
        })
      }
    } else if (activeEntry) {
      // Cold pre-Pending webchat: there is no Pending sink yet, but the accepted
      // browser turn still needs an immediate terminal frame.
      this.terminateQueuedSink(activeEntry, reason)
      this.showActivity(
        this.replyConnFor(activeEntry.agentId, activeEntry.integrationId),
        activeEntry.msg.channel,
        activeEntry.msg.thread ?? activeEntry.msg.msgId,
        ''
      )
    }
    this.log.info(`command: ${reason} → agent "${agentId}" session ${key}${liveSessionId ? ` (${liveSessionId})` : ''}`)
    // Only a live ACP turn can be cancelled at the host; a purely-queued/cold session has
    // nothing running to cancel (the queue drop above already handled it).
    if (!liveSessionId || !live) {
      // Startup/session initialization can be the thing that is hung. There is no ACP
      // session id to cancel yet, so arm the same deadline against the logical active
      // dispatch and force-stop its host if it still has not yielded.
      const active = this.activeDispatchDoneByKey.get(key)
      if (activeEntry && active) this.armColdCancelBackstop(agentId, key, reason, active)
      return
    }
    // Release any card the user hasn't answered: ACP requires pending permission /
    // elicitation requests to resolve cancelled when a turn is cancelled, and this lets
    // the agent's prompt unwind (it's blocked awaiting our promise) so the finally runs.
    this.releaseElicits(agentId, liveSessionId)
    this.releaseChatPermissions(agentId, liveSessionId)
    this.releaseEditorPermissions(agentId, liveSessionId)
    // §7.3 idle→cancelling: send session/cancel, then arm a force backstop. The turn's
    // dispatch finally clears the timer + writes the terminal idle state when the agent
    // yields; if it never does, the backstop force-stops the host.
    this.store.setSessionState(key, 'cancelling', this.clock.now())
    void (live.selectedHost?.host ?? this.hosts.get(agentId))
      ?.cancel(liveSessionId)
      .catch((err) => this.log.error(`command ${reason}: cancel failed: ${(err as Error).message}`))
    this.armCancelBackstop(agentId, liveSessionId, key, reason)
  }

  /** Interrupt every logical session owned by an agent for a lifecycle gate (pause,
   *  removal, or host respawn). Active ACP turns are cancelled; queued turns are
   *  cleanly gate-dropped. A cold head is latched so it cannot resume after teardown. */
  private interruptAgentTurns(agentId: string, reason: TurnInterruptReason): void {
    this.beginSafetyDrain(agentId, reason)
    // The interruption is terminal for every already-admitted turn. Delete durable
    // rows first so an immediate daemon stop cannot preserve and replay old work.
    this.purgeAgentInbox(agentId, reason)
    const targets = new Map<string, string | undefined>()
    for (const [key, entry] of this.activeGateEntries) {
      if (entry.agentId !== agentId) continue
      entry.cancelledReason = reason
      targets.set(key, undefined)
    }
    for (const p of this.pending.values()) {
      if (p.agentId === agentId) targets.set(p.sessionKey, p.acpSessionId)
    }
    for (const [key, queued] of this.serialQueue) {
      if (queued.some((entry) => entry.agentId === agentId) && !targets.has(key)) {
        targets.set(key, this.store.getSession(key)?.acpSessionId ?? undefined)
      }
    }
    if (targets.size > 0)
      this.log.info(`${reason}: interrupting ${targets.size} active session(s) for agent "${agentId}"`)
    for (const [key, acpSessionId] of targets) {
      this.interruptTurn(agentId, key, reason, acpSessionId, { dropQueued: true })
    }
  }

  /** After an interrupt sends session/cancel, give the agent `cancelBackstopMs` to yield.
   *  If the turn is still in flight when the timer fires, the agent ignored the
   *  cancel — force-stop its host (the only hard kill available) so the session
   *  can't be stuck in `cancelling` forever. dispatch's finally clears this timer
   *  the moment the turn yields on its own. */
  private armCancelBackstop(agentId: string, acpSessionId: string, key: string, reason: string): void {
    this.clearCancelBackstop(agentId, acpSessionId)
    const ms = this.cfg.limits.cancelBackstopMs
    const pendingKey = pendingTurnKey(agentId, acpSessionId)
    this.cancelTimers.set(
      pendingKey,
      this.clock.setTimeout(() => {
        this.cancelTimers.delete(pendingKey)
        if (!this.pending.has(pendingKey)) return // already yielded
        this.log.warn(
          `${reason}: agent "${agentId}" ignored session/cancel for ${ms}ms — force-stopping host (session ${acpSessionId})`
        )
        const turn = this.pending.get(pendingKey)
        if (!turn) return
        // Force-stop reaps the exact selected process. A delegated turn must cross
        // the manager boundary so broker drain/release and private-HOME cleanup
        // finish before dispatch can mark the session idle.
        const cleanup = turn.selectedHost?.stop(0) ?? this.stopHost(agentId, 0)
        const stopped = cleanup.catch((err) => {
          return this.fenceLifecycleCleanupFailure(agentId, key, turn.entry, err)
        })
        this.addSafetyDrainWait(agentId, stopped)
        void stopped.then(() => {
          // The process boundary is now fully gone. This preserves the ordinary
          // host backstop's terminal state even when a test/runtime prompt promise
          // never observes process death; delegated cleanup reaches this point only
          // after broker release and private-HOME removal.
          this.store.setSessionState(key, 'idle', this.clock.now())
        })
      }, ms)
    )
  }

  private clearCancelBackstop(agentId: string, acpSessionId: string): void {
    const key = pendingTurnKey(agentId, acpSessionId)
    const t = this.cancelTimers.get(key)
    if (t !== undefined) {
      this.clock.clearTimeout(t)
      this.cancelTimers.delete(key)
    }
  }

  private armColdCancelBackstop(
    agentId: string,
    key: string,
    reason: TurnInterruptReason,
    active: Promise<void>
  ): void {
    this.clearColdCancelBackstop(key)
    const ms = this.cfg.limits.cancelBackstopMs
    const timer = this.clock.setTimeout(() => {
      const current = this.coldCancelTimers.get(key)
      if (!current || current.active !== active) return
      this.coldCancelTimers.delete(key)
      if (this.activeDispatchDoneByKey.get(key) !== active) return
      const entry = this.activeGateEntries.get(key)
      if (!entry?.cancelledReason) return
      this.log.warn(
        `${reason}: agent "${agentId}" did not finish cold initialization within ${ms}ms — force-stopping host (${key})`
      )
      const cleanup =
        entry.lifecycleCleanup ??
        entry.selectedHost?.stop(0) ??
        (entry.webchat?.delegation && this.delegatedWebchatHosts
          ? this.delegatedWebchatHosts.stopConversationHosts({
              agentId,
              conversationId: entry.webchat.conversationId
            })
          : this.stopHost(agentId, 0))
      entry.lifecycleCleanup ??= cleanup
      const stopped = cleanup.catch((err) => {
        return this.fenceLifecycleCleanupFailure(agentId, key, entry, err)
      })
      // Abort every SessionManager cold await now; keep NEW admission gated until
      // the host-wide stop itself settles, so the old teardown cannot kill fresh work.
      this.addSafetyDrainWait(agentId, stopped)
      void stopped.then(() => {
        entry.initAbort.abort(new Error(reason))
      })
    }, ms)
    this.coldCancelTimers.set(key, { timer, active })
  }

  private clearColdCancelBackstop(key: string, active?: Promise<void>): void {
    const current = this.coldCancelTimers.get(key)
    if (!current || (active !== undefined && current.active !== active)) return
    this.clock.clearTimeout(current.timer)
    this.coldCancelTimers.delete(key)
  }

  /**
   * Apply one converger action against the session's Slack connection:
   *  - set-status → assistant.threads.setStatus (best-effort; '' clears)
   *  - set-title  → assistant.threads.setTitle (best-effort; app DMs only)
   *  - post       → a new thread message born with the linked footer; ALSO recorded
   *    to the transcript as the agent's reply text (sender = agentId), so other agents
   *    replaying the thread see what it said. Keyed on `statusThread` (§8.5).
   *  - notice     → posted to the thread but NOT recorded (system chrome).
   *  - attribution → closes the footer lifecycle and retries stale-section cleanup.
   *  - progress / plan → the single in-place message of that kind, posted once
   *    then chat.update-ed (§9.1 in-place update). The first post's ts is remembered on `p`.
   */
  private slackPostOptions(
    p: Pick<Pending, 'platform' | 'isDm' | 'agentName' | 'iconUrl'>
  ): SlackPostOptions | undefined {
    if (p.platform !== 'slack' || p.isDm) return undefined
    return { username: p.agentName, ...(p.iconUrl ? { icon_url: p.iconUrl } : {}) }
  }

  /** Visual identity for Slack rows owned by the selected agent. Kept separate from
   *  conversational authorship because status/chrome rows must retain their chrome
   *  metadata marker instead of masquerading as transcript messages. */
  private slackAgentIdentityOptions(
    p: Pick<Pending, 'platform' | 'agentName' | 'iconUrl'>
  ): SlackPostOptions | undefined {
    if (p.platform !== 'slack') return undefined
    return { username: p.agentName, ...(p.iconUrl ? { icon_url: p.iconUrl } : {}) }
  }

  /** Agent-authored conversation messages add a stable author id to Slack metadata.
   *  Peer daemons use it during thread backfill, so shared/custom bot ids never replace
   *  the Agent's name and icon in the Console transcript. */
  private slackAgentPostOptions(
    p: Pick<Pending, 'platform' | 'agentId' | 'agentName' | 'iconUrl'>
  ): SlackPostOptions | undefined {
    const identity = this.slackAgentIdentityOptions(p)
    return identity ? { ...identity, agentAuthorId: p.agentId } : undefined
  }

  /** Opaque routing target attached to daemon-rendered interactive Slack blocks when
   * inbound actions belong to the relay instead of this process's Socket Mode edge. */
  private httpSlackSessionTarget(p: Pick<Pending, 'agentId' | 'integrationId' | 'sessionKey'>): string | undefined {
    return p.integrationId && this.isHttpSlackIntegration(p.agentId, p.integrationId)
      ? encodeSharedSlackStatusTarget({
          agentId: p.agentId,
          integrationId: p.integrationId,
          sessionKey: p.sessionKey
        })
      : undefined
  }

  /** Keep Slack's transient loading state visually owned by the same agent as its reply. */
  private slackStatusOptions(platform: string, agentName: string, iconUrl?: string): SlackStatusOptions | undefined {
    if (platform !== 'slack') return undefined
    return { username: agentName, ...(iconUrl ? { icon_url: iconUrl } : {}) }
  }

  /** Remove attribution blocks from older body sections. Slack edits are best-effort,
   *  so retain failed rows for the next body post and the finalization retry. Test fakes
   *  historically return void; only an explicit `false` means the update failed. */
  private async clearStaleSlackReplyFooters(
    conn: SlackConnection,
    p: Pending,
    additional: { ts: string; text: string }[] = []
  ): Promise<void> {
    const pending = [...(p.staleReplyFooters ?? []), ...additional]
    if (pending.length === 0) return
    delete p.staleReplyFooters
    const failed: { ts: string; text: string }[] = []
    for (const reply of new Map(pending.map((item) => [item.ts, item])).values()) {
      try {
        const updated = await conn.updateBlocks(
          p.channel,
          reply.ts,
          [{ type: 'markdown', text: reply.text }],
          undefined,
          false,
          p.agentId
        )
        if (updated === false) failed.push(reply)
      } catch (err) {
        // Real SlackConnection normalizes API/queue failures to false. Keep this guard
        // for duck-typed test/adaptor connections so turn cleanup can never be stranded.
        failed.push(reply)
        this.log.debug(`slack: stale footer cleanup failed (${reply.ts}): ${formatErr(err)}`)
      }
    }
    if (failed.length > 0) p.staleReplyFooters = failed
  }

  /** Append a reply segment to the transcript WITHOUT sending it. Minimal mode keeps
   * earlier narration behind one collapsed live reply; Feishu uses this for every
   * CardKit-delivered body segment. A distinct monotonic ts per call avoids text-row
   * dedup collisions. Platform-agnostic; runs even headless (no conn). */
  private recordReplySegment(p: Pending, text: string): void {
    this.store.appendTranscript({
      channel: p.transcriptChannel,
      thread: p.statusThread,
      ts: monotonicTs(),
      sender: p.agentId,
      kind: 'text',
      text
    })
  }

  /** Shared reply-message boundary for every output mode. The new message is born with
   *  the current footer; only after that post succeeds do we strip the footer from the
   *  previous reply owner and move the pointer. */
  private async postSlackReply(
    conn: SlackConnection,
    p: Pending,
    text: string,
    trackReply = true
  ): Promise<string | undefined> {
    const previous = trackReply ? p.lastReply : undefined
    const attribution = trackReply ? p.attribution : undefined
    const agentPostOptions = this.slackAgentPostOptions(p)
    const options = attribution ? { ...agentPostOptions, trailingBlocks: attribution.blocks } : agentPostOptions
    const ts = await conn.postMessage(p.channel, text, p.thread, options)
    if (ts && trackReply) {
      if (attribution)
        await this.clearStaleSlackReplyFooters(
          conn,
          p,
          previous?.footerKey ? [{ ts: previous.ts, text: previous.text }] : []
        )
      p.lastReply = {
        ts,
        text,
        ...(attribution ? { footerKey: attribution.key } : {})
      }
    }
    return ts
  }

  /** Update minimal mode's live body without dropping its born-in footer. Only record a
   *  footer-key transition after Slack accepts the edit so finalization can retry a failed
   *  metadata refresh. */
  private async updateSlackLiveReply(conn: SlackConnection, p: Pending, text: string): Promise<void> {
    if (!p.liveReplyTs) return
    const attribution = p.attribution
    if (!attribution) {
      await conn.updateMessage(p.channel, p.liveReplyTs, text, false, p.agentId)
      if (p.lastReply?.ts === p.liveReplyTs) {
        p.lastReply.text = text
        delete p.lastReply.footerKey
      }
      return
    }
    const updated = await conn.updateBlocks(
      p.channel,
      p.liveReplyTs,
      [{ type: 'markdown', text }, ...attribution.blocks],
      text,
      false,
      p.agentId
    )
    if (updated !== false && p.lastReply?.ts === p.liveReplyTs) {
      p.lastReply.text = text
      p.lastReply.footerKey = attribution.key
    }
  }

  private async applySlackAction(p: Pending, action: SlackAction): Promise<void> {
    if (action.kind === 'post' && action.recordOnly) {
      this.recordReplySegment(p, action.text)
      return
    }
    // enqueueApply routes here only for non-telegram platforms, so p.conn is a Slack
    // connection (or a test fake with the same shape) — cast rather than instanceof so
    // duck-typed fakes work. Headless (no conn) no-ops.
    const conn = p.conn as SlackConnection | undefined
    if (!conn) {
      // Headless fires have no platform-send boundary, but their agent reply should
      // still be readable in the session transcript.
      if (action.kind === 'post') {
        this.store.appendTranscript({
          channel: p.transcriptChannel,
          thread: p.statusThread,
          ts: monotonicTs(),
          sender: p.agentId,
          kind: 'text',
          text: action.text
        })
      }
      return
    }
    const postOptions = this.slackPostOptions(p)
    const statusBarPostOptions = this.slackAgentIdentityOptions(p)
    // Chrome variant of the post options: marks status/progress/plan/reasoning/notice/card
    // messages so a peer daemon's thread backfill skips them (they are not conversation).
    const chromeOptions: SlackPostOptions = { ...(postOptions ?? {}), chrome: true }
    switch (action.kind) {
      case 'set-status':
        if (p.statusThread)
          await conn.setStatus(
            p.channel,
            p.statusThread,
            action.text,
            action.loadingMessages,
            this.slackStatusOptions(p.platform, p.agentName, p.iconUrl)
          )
        return
      case 'set-title':
        if (p.statusThread) await conn.setTitle(p.channel, p.statusThread, action.text)
        return
      case 'post': {
        const trackReply = action.attributed !== false
        // The latest reply is born with its linked context footer, so unfurls are
        // disabled at the supported chat.postMessage boundary. Once that succeeds,
        // strip the footer from this turn's previous section and move the pointer.
        const ts = await this.postSlackReply(conn, p, action.text, trackReply)
        this.store.appendTranscript({
          channel: p.transcriptChannel,
          thread: p.statusThread,
          ts: ts ?? `local-${Date.now()}`,
          sender: p.agentId,
          kind: 'text',
          text: action.text
        })
        return
      }
      case 'notice':
      case 'tool-output':
        // Both post to the thread but are NOT recorded into the transcript — notices are
        // system chrome, and tool output is captured independently by the recorder.
        await conn.postMessage(p.channel, action.text, p.thread, chromeOptions)
        return
      case 'attribution':
        // Final metadata normally matches the footer already included in the initial post.
        // Minimal mode also keeps that footer through its live updates, so finalization is
        // a no-op unless the runtime published different session metadata during prompt.
        p.attribution = { blocks: action.blocks, key: JSON.stringify(action.blocks) }
        if (action.standalone) {
          if (
            p.liveReplyTs &&
            p.liveReplyText !== undefined &&
            p.lastReply?.ts === p.liveReplyTs &&
            p.lastReply.footerKey !== p.attribution.key
          ) {
            const updated = await conn.updateBlocks(
              p.channel,
              p.liveReplyTs,
              [{ type: 'markdown', text: p.liveReplyText }, ...action.blocks],
              p.liveReplyText,
              false,
              p.agentId
            )
            if (updated !== false) {
              p.lastReply.text = p.liveReplyText
              p.lastReply.footerKey = p.attribution.key
            }
          }
        } else {
          await this.clearStaleSlackReplyFooters(conn, p)
        }
        return
      case 'progress':
        // Post the single progress message exactly once; thereafter edit it in
        // place. If the first post rejects or returns no ts, we mark it attempted
        // and skip subsequent edits rather than posting a duplicate message.
        if (p.progressTs) await conn.updateMessage(p.channel, p.progressTs, action.text, true)
        else if (!p.progressAttempted) {
          p.progressAttempted = true
          p.progressTs = await conn.postMessage(p.channel, action.text, p.thread, chromeOptions)
        }
        return
      case 'plan':
        if (p.planTs) await conn.updateMessage(p.channel, p.planTs, action.text, true)
        else if (!p.planAttempted) {
          p.planAttempted = true
          p.planTs = await conn.postMessage(p.channel, action.text, p.thread, chromeOptions)
        }
        return
      case 'reasoning':
        // The single in-place reasoning block (high mode): post once, then edit — same
        // post-once/edit-thereafter contract as `progress`. Not recorded into the
        // transcript; the TranscriptRecorder captures reasoning rows independently.
        if (p.reasoningTs) await conn.updateMessage(p.channel, p.reasoningTs, action.text, true)
        else if (!p.reasoningAttempted) {
          p.reasoningAttempted = true
          p.reasoningTs = await conn.postMessage(p.channel, action.text, p.thread, chromeOptions)
        }
        return
      case 'live-reply': {
        // minimal mode's single agent reply: post once with its attribution footer, then
        // update body + footer together as the turn streams. Skip an update when the text
        // is unchanged; the paired `recordOnly` posts carry the transcript content.
        if (p.liveReplyReanchor) {
          // A human-input card was posted above this reply; start a FRESH reply below it so
          // the post-answer stream reads after the question (the old reply stays frozen above).
          p.liveReplyReanchor = false
          p.liveReplyTs = undefined
          p.liveReplyAttempted = false
          p.liveReplyText = undefined
        }
        if (p.liveReplyText === action.text) return
        p.liveReplyText = action.text
        if (p.liveReplyTs) await this.updateSlackLiveReply(conn, p, action.text)
        else if (!p.liveReplyAttempted) {
          p.liveReplyAttempted = true
          p.liveReplyTs = await this.postSlackReply(conn, p, action.text)
        }
        return
      }
      case 'final-live-reply': {
        // Slack caps one markdown block at 12k characters. Settle the existing live reply
        // with the first section, then post every overflow section as a continuation so
        // minimal mode never drops the tail of a long final answer. Every successful next
        // section is born with the footer before the prior section loses it, keeping the
        // footer anchored to the last delivered response throughout the handoff.
        const sections = splitIntoSections(action.text)
        const [first, ...rest] = sections
        if (!first) return
        if (p.liveReplyReanchor) {
          p.liveReplyReanchor = false
          p.liveReplyTs = undefined
          p.liveReplyAttempted = false
          p.liveReplyText = undefined
        }
        if (p.liveReplyText !== first) {
          p.liveReplyText = first
          if (p.liveReplyTs) await this.updateSlackLiveReply(conn, p, first)
          else if (!p.liveReplyAttempted) {
            p.liveReplyAttempted = true
            p.liveReplyTs = await this.postSlackReply(conn, p, first)
          }
        }
        for (const section of rest) {
          const ts = await this.postSlackReply(conn, p, section)
          if (ts) {
            p.liveReplyTs = ts
            p.liveReplyText = section
          }
        }
        return
      }
      case 'status-bar': {
        // Session-scoped interactive status line: the first post's ts is stored on the
        // session, and every later turn updates that topmost line in place. Serialized by
        // applyChain; not recorded into the transcript (live chrome).
        let ts = p.statusBarTs ?? this.store.getStatusBarTs(p.sessionKey)
        if (!ts && !p.statusBarAttempted) {
          ts = await this.findExistingSlackStatusBarTs(conn, p)
          if (ts) {
            p.statusBarTs = ts
            this.store.setStatusBarTs(p.sessionKey, ts)
          }
        }
        if (ts) {
          p.statusBarTs = ts
          await conn.updateBlocks(p.channel, ts, action.blocks, action.text, true)
        } else if (!p.statusBarAttempted) {
          p.statusBarAttempted = true
          // The session status line represents the selected agent, so keep its author
          // identity aligned with the native loading state and the eventual reply.
          const posted = await conn.postBlocks(p.channel, action.blocks, action.text, p.thread, {
            ...(statusBarPostOptions ?? {}),
            chrome: true
          })
          if (posted) {
            p.statusBarTs = posted
            this.store.setStatusBarTs(p.sessionKey, posted)
          }
        }
        return
      }
    }
  }

  /** Best-effort adoption path for sessions that already have an older status bar in
   *  Slack before `statusBarTs` was persisted locally. We scan in Slack's thread order
   *  and pick the first bot-authored status fallback, so future turns update the topmost
   *  existing line instead of adding one more duplicate. */
  private async findExistingSlackStatusBarTs(conn: SlackConnection, p: Pending): Promise<string | undefined> {
    const getThreadReplies = (conn as { getThreadReplies?: SlackConnection['getThreadReplies'] }).getThreadReplies
    if (!getThreadReplies) return undefined
    const replies = await getThreadReplies.call(conn, p.channel, p.statusThread)
    return replies.find((m) => m.isBot && isSlackStatusBarText(m.text))?.ts
  }

  /**
   * Apply one converger action against the session's Telegram connection — the
   * Telegram analog of applySlackAction. Reuses the Pending's `*Ts` fields as
   * Telegram message-id strings for the in-place (edit-thereafter) messages.
   *  - post        → a new message (PLAIN text); ALSO recorded to the transcript. A `hint`
   *                  (the continue-the-topic line) is sent but not recorded.
   *  - continue-hint → edits that hint onto the last body message already sent.
   *  - notice / tool-output → posted (HTML) but NOT recorded (chrome).
   *  - typing      → a transient chat-action ("typing…").
   *  - progress / plan / reasoning → the single in-place message of that kind.
   */
  private async applyTelegramAction(p: Pending, action: TelegramAction): Promise<void> {
    // minimal mode records each reply segment WITHOUT sending it — the chat shows only the
    // single `live-reply` (see applySlackAction / recordReplySegment).
    if (action.kind === 'post' && action.recordOnly) {
      this.recordReplySegment(p, action.text)
      return
    }
    // Routed here only for the telegram platform (see enqueueApply), so p.conn is a
    // Telegram connection (or a test fake) — cast, not instanceof. Headless no-ops.
    const conn = p.conn as TelegramConnection | undefined
    if (!conn) return
    switch (action.kind) {
      case 'typing':
        await conn.sendChatAction(p.channel)
        return
      case 'post': {
        // The continue-the-topic hint is chrome: sent with the reply (so it lands on the very
        // message users are told to reply to) but kept out of the recorded text below.
        const sent = action.hint ? `${action.text}\n\n${action.hint}` : action.text
        const id = await conn.postMessage(p.channel, sent, p.thread, { replyTo: p.tgReplyTo })
        // Remember the newest body message so a turn-end `continue-hint` can annotate it.
        if (id) p.tgLastBody = { id, text: sent }
        this.store.appendTranscript({
          channel: p.transcriptChannel,
          thread: p.statusThread,
          ts: id ?? `local-${Date.now()}`,
          sender: p.agentId,
          kind: 'text',
          text: action.text
        })
        return
      }
      case 'continue-hint': {
        // The turn's last body went out earlier (idle flush / tool boundary), so the hint
        // lands by editing that message. Skipped when its id is unknown (a failed send) or
        // when the suffix would not fit — the converger reserves room for it in the body
        // budget, so this guard only fires for text that predates the reservation.
        const last = p.tgLastBody
        if (!last || last.text.endsWith(action.hint)) return
        const sent = `${last.text}\n\n${action.hint}`
        if (sent.length > TELEGRAM_MESSAGE_LIMIT) return
        p.tgLastBody = { id: last.id, text: sent }
        await conn.updateMessage(p.channel, last.id, sent)
        return
      }
      case 'live-reply': {
        // minimal mode's single agent reply: send once (plain text) then edit in place as the
        // turn streams. Skip an update when unchanged; not recorded (the `recordOnly` posts do).
        if (p.liveReplyText === action.text) return
        p.liveReplyText = action.text
        if (p.liveReplyTs) await conn.updateMessage(p.channel, p.liveReplyTs, action.text)
        else if (!p.liveReplyAttempted) {
          p.liveReplyAttempted = true
          p.liveReplyTs = await conn.postMessage(p.channel, action.text, p.thread, { replyTo: p.tgReplyTo })
        }
        return
      }
      case 'notice':
      case 'tool-output':
        // Posted to the chat but NOT recorded — the done footer is chrome, and tool
        // output is captured independently by the recorder.
        await conn.postChrome(p.channel, action.text, {
          parseMode: action.parseMode,
          threadTs: p.thread,
          replyTo: p.tgReplyTo
        })
        return
      case 'progress':
        if (p.progressTs)
          await conn.updateMessage(p.channel, p.progressTs, action.text, { parseMode: action.parseMode })
        else if (!p.progressAttempted) {
          p.progressAttempted = true
          p.progressTs = await conn.postChrome(p.channel, action.text, {
            parseMode: action.parseMode,
            threadTs: p.thread,
            replyTo: p.tgReplyTo
          })
        }
        return
      case 'plan':
        if (p.planTs) await conn.updateMessage(p.channel, p.planTs, action.text, { parseMode: action.parseMode })
        else if (!p.planAttempted) {
          p.planAttempted = true
          p.planTs = await conn.postChrome(p.channel, action.text, {
            parseMode: action.parseMode,
            threadTs: p.thread,
            replyTo: p.tgReplyTo
          })
        }
        return
      case 'reasoning':
        if (p.reasoningTs)
          await conn.updateMessage(p.channel, p.reasoningTs, action.text, { parseMode: action.parseMode })
        else if (!p.reasoningAttempted) {
          p.reasoningAttempted = true
          p.reasoningTs = await conn.postChrome(p.channel, action.text, {
            parseMode: action.parseMode,
            threadTs: p.thread,
            replyTo: p.tgReplyTo
          })
        }
        return
    }
  }

  /**
   * Apply one converger action against the session's Discord connection — the
   * Discord analog of applyTelegramAction (Discord uses native markdown, so there
   * is no parse_mode). Reuses the Pending's `*Ts` fields as Discord message ids for
   * the in-place (edit-thereafter) messages.
   *  - post        → a new message; ALSO recorded to the transcript.
   *  - notice / tool-output → posted but NOT recorded (chrome).
   *  - typing      → a transient channel typing indicator.
   *  - progress / plan / reasoning → the single in-place message of that kind.
   *  - status-bar  → the per-turn status line + button row (Cancel / Fast / View).
   */
  private async applyDiscordAction(p: Pending, action: DiscordAction): Promise<void> {
    // minimal mode records each reply segment WITHOUT sending it — the channel shows only the
    // single `live-reply` (see applySlackAction / recordReplySegment).
    if (action.kind === 'post' && action.recordOnly) {
      this.recordReplySegment(p, action.text)
      return
    }
    // Routed here only for the discord platform (see enqueueApply), so p.conn is a
    // Discord connection (or a test fake) — cast, not instanceof. Headless no-ops.
    const conn = p.conn as DiscordConnection | undefined
    if (!conn) return
    switch (action.kind) {
      case 'typing':
        await conn.sendChatAction(p.channel)
        return
      case 'post': {
        const id = await conn.postMessage(p.channel, action.text, p.thread)
        this.store.appendTranscript({
          channel: p.transcriptChannel,
          thread: p.statusThread,
          ts: id ?? `local-${Date.now()}`,
          sender: p.agentId,
          kind: 'text',
          text: action.text
        })
        return
      }
      case 'live-reply': {
        // minimal mode's single agent reply: send once then edit in place as the turn
        // streams. Skip an update when unchanged; not recorded (the `recordOnly` posts do).
        if (p.liveReplyText === action.text) return
        p.liveReplyText = action.text
        if (p.liveReplyTs) await conn.updateMessage(p.channel, p.liveReplyTs, action.text)
        else if (!p.liveReplyAttempted) {
          p.liveReplyAttempted = true
          p.liveReplyTs = await conn.postMessage(p.channel, action.text, p.thread)
        }
        return
      }
      case 'notice':
      case 'tool-output':
        // Posted to the channel but NOT recorded — the done footer is chrome, and tool
        // output is captured independently by the recorder.
        await conn.postChrome(p.channel, action.text, { threadTs: p.thread })
        return
      case 'progress':
        if (p.progressTs) await conn.updateMessage(p.channel, p.progressTs, action.text)
        else if (!p.progressAttempted) {
          p.progressAttempted = true
          p.progressTs = await conn.postChrome(p.channel, action.text, { threadTs: p.thread })
        }
        return
      case 'plan':
        if (p.planTs) await conn.updateMessage(p.channel, p.planTs, action.text)
        else if (!p.planAttempted) {
          p.planAttempted = true
          p.planTs = await conn.postChrome(p.channel, action.text, { threadTs: p.thread })
        }
        return
      case 'reasoning':
        if (p.reasoningTs) await conn.updateMessage(p.channel, p.reasoningTs, action.text)
        else if (!p.reasoningAttempted) {
          p.reasoningAttempted = true
          p.reasoningTs = await conn.postChrome(p.channel, action.text, { threadTs: p.thread })
        }
        return
      case 'status-bar':
        // Per-turn status line + button row: post once (registering the message →
        // sessionKey so its button interactions resolve), then edit in place.
        if (p.statusBarTs)
          await conn.updateMessage(p.channel, p.statusBarTs, action.text, { keyboard: action.keyboard })
        else if (!p.statusBarAttempted) {
          p.statusBarAttempted = true
          p.statusBarTs = await conn.postChrome(p.channel, action.text, {
            threadTs: p.thread,
            keyboard: action.keyboard,
            sessionKey: p.sessionKey
          })
        }
        return
    }
  }

  /** Apply one Feishu action. Agent body delivery is one CardKit entity for the whole
   * turn; `post(recordOnly)` retains transcript boundaries without duplicate chat
   * messages. Progress/plan/reasoning remain short text chrome edited in place. */
  private async applyFeishuAction(p: Pending, action: FeishuAction): Promise<void> {
    // CardKit owns visible body delivery, so these actions are persistence-only.
    if (action.kind === 'post' && action.recordOnly) {
      this.recordReplySegment(p, action.text)
      return
    }
    // Routed here only for the feishu platform (see enqueueApply), so p.conn is a Feishu
    // connection (or a test fake) — cast, not instanceof. Headless no-ops.
    const conn = p.conn as FeishuConnection | undefined
    if (!conn) return
    switch (action.kind) {
      case 'card-start':
        if (p.feishuCardAttempted) return
        p.feishuCardAttempted = true
        p.feishuCard = await conn.startStreamingCard(p.channel, p.thread, {
          sessionKey: p.sessionKey,
          sessionUrl: this.sessionLink(p.acpSessionId),
          ...(p.integrationId ? { target: { v: 1, agentId: p.agentId, integrationId: p.integrationId } as const } : {})
        })
        return
      case 'card-stream':
        if (p.feishuCard) await conn.updateStreamingCard(p.channel, p.feishuCard, action.text)
        return
      case 'card-final': {
        if (p.feishuCard) {
          const delivered = await conn.finishStreamingCard(p.channel, p.feishuCard, action.text, action.attribution)
          if (delivered) return
          // A final CardKit update failure must not lose the answer. Remove the stale
          // partial card where possible, then fall back to ordinary text.
          await conn.cancelStreamingCard(p.channel, p.feishuCard)
        }
        await conn.postMessage(p.channel, action.text, p.thread)
        return
      }
      case 'card-cancel':
        if (p.feishuCard) await conn.cancelStreamingCard(p.channel, p.feishuCard)
        return
      case 'typing':
        await conn.sendChatAction(p.channel)
        return
      case 'post': {
        const id = await conn.postMessage(p.channel, action.text, p.thread)
        this.store.appendTranscript({
          channel: p.transcriptChannel,
          thread: p.statusThread,
          ts: id ?? `local-${Date.now()}`,
          sender: p.agentId,
          kind: 'text',
          text: action.text
        })
        return
      }
      case 'notice':
      case 'tool-output':
        // Posted to the chat but NOT recorded — the done footer is chrome, and tool
        // output is captured independently by the recorder.
        await conn.postChrome(p.channel, action.text, { threadTs: p.thread })
        return
      case 'progress':
        if (p.progressTs) await conn.updateMessage(p.channel, p.progressTs, action.text)
        else if (!p.progressAttempted) {
          p.progressAttempted = true
          p.progressTs = await conn.postChrome(p.channel, action.text, { threadTs: p.thread })
        }
        return
      case 'plan':
        if (p.planTs) await conn.updateMessage(p.channel, p.planTs, action.text)
        else if (!p.planAttempted) {
          p.planAttempted = true
          p.planTs = await conn.postChrome(p.channel, action.text, { threadTs: p.thread })
        }
        return
      case 'reasoning':
        if (p.reasoningTs) await conn.updateMessage(p.channel, p.reasoningTs, action.text)
        else if (!p.reasoningAttempted) {
          p.reasoningAttempted = true
          p.reasoningTs = await conn.postChrome(p.channel, action.text, { threadTs: p.thread })
        }
        return
    }
  }

  /** Web App console base URL the CP sent on `auth/ok` (its own console origin). A local
   *  `webAppUrl` config overrides it; undefined until auth completes / if neither is set. */
  private cpWebAppUrl?: string

  /** Slug of the org this daemon belongs to, from `auth/ok` — the console is org-scoped, so
   *  it's the `<orgSlug>` segment of a session deep link. Undefined off a CP (local run) or
   *  when the CP couldn't resolve it; then the segment is dropped. */
  private cpOrgSlug?: string

  /** The Web App console URL for a session: `<base>/<orgSlug>/sessions/<id>`, where base is
   *  the explicit local `webAppUrl`, else the CP-provided origin, else the local default
   *  (`DEFAULT_WEB_APP_URL`). The console is org-scoped, so the org slug is inserted when
   *  known; without it the link falls back to `<base>/sessions/<id>`. */
  private sessionLink(acpSessionId: string): string {
    const orgSeg = this.cpOrgSlug ? `/${encodeURIComponent(this.cpOrgSlug)}` : ''
    return `${this.webAppBase()}${orgSeg}/sessions/${encodeURIComponent(acpSessionId)}`
  }

  /** The console deep link to an agent: `<base>/<orgSlug>/agents/<agentId>`. Same
   *  org-segment rule as {@link sessionLink}. */
  private agentLink(agentId: string): string {
    const orgSeg = this.cpOrgSlug ? `/${encodeURIComponent(this.cpOrgSlug)}` : ''
    return `${this.webAppBase()}${orgSeg}/agents/${encodeURIComponent(agentId)}`
  }

  /** Whether this turn's reply rides an HTTP Slack integration. The relay owns that
   *  app's inbound edge, so interactive actions must use relay-recognized ids. */
  private isHttpSlackIntegration(agentId: string, integrationId?: string): boolean {
    if (!integrationId) return false
    const agent = this.agents.get(agentId)
    const int = agent?.integrations.find((i) => i.id === integrationId)
    return int?.platform === 'slack' && int.slack.mode === 'shared'
  }

  /** Whether this turn's Slack bot is SHAREABLE (multi-agent). Only a shareable bot
   *  has another agent to switch to, so the in-thread "Switch agent" control is gated
   *  on this — a single-agent HTTP bot routes the same way but omits the option. */
  private isShareableSlackIntegration(agentId: string, integrationId?: string): boolean {
    if (!integrationId) return false
    const agent = this.agents.get(agentId)
    const int = agent?.integrations.find((i) => i.id === integrationId)
    return int?.platform === 'slack' && int.slack.mode === 'shared' && int.slack.shareable === true
  }

  /** The Web App console origin (trailing slash stripped): the explicit local `webAppUrl`,
   *  else the CP-provided origin, else the local default. Backs both the session deep link
   *  and the per-turn dynamic attribution links. */
  private webAppBase(): string {
    return (this.cfg.webAppUrl ?? this.cpWebAppUrl ?? DEFAULT_WEB_APP_URL).replace(/\/$/, '')
  }

  private sessionListProjection(sessionId: string, agentId: string): SessionListItem | undefined {
    return createSessionReader(this.store, (id) => this.replyConnFor(id)?.workspaceUrl)
      .list({ agentId })
      .sessions.find((s) => s.sessionId === sessionId)
  }

  /**
   * Push the CP's DB-backed session-list metadata from the daemon's canonical
   * local projection. This is still metadata-only: transcript rows and tool bodies
   * remain daemon-local and are fetched via the on-demand session read-back frames.
   */
  private emitSessionMetadataSnapshot(input: {
    sessionId: string
    agentId: string
    phase: EventSession['phase']
    platform: SessionKey['platform']
    channel: string
    thread?: string
    status?: string
    runtime?: string
    model?: string
    permissionMode?: string
  }): void {
    if (!this.cpClient) return
    const now = new Date(this.clock.now()).toISOString()
    const row = this.sessionListProjection(input.sessionId, input.agentId)
    const key = row?.sessionKey
    const event: EventSession = {
      sessionId: input.sessionId,
      agentId: input.agentId,
      phase: input.phase,
      platform: key?.platform ?? input.platform,
      channel: key?.channel ?? input.channel,
      link: this.sessionLink(input.sessionId),
      lastActivityAt: row?.lastActivityAt ?? now,
      ts: now
    }
    if (row?.parentSessionId !== undefined) event.parentSessionId = row.parentSessionId
    // Visibility-classification inputs (session-visibility.md §4.1), read from
    // the session row so every re-emit carries them. Absent fields make the CP
    // fail closed (no owner) rather than guess — never send a placeholder.
    const classification = this.store.getSessionClassification(input.agentId, input.sessionId)
    if (classification?.conversationKind !== undefined) {
      event.conversationKind = classification.conversationKind as EventSession['conversationKind']
    }
    if (classification?.tenantScope !== undefined) event.transportScope = classification.tenantScope
    if (classification?.launchCorrelationId !== undefined) {
      event.launchCorrelationId = classification.launchCorrelationId
    }
    const thread = key?.thread ?? input.thread
    if (thread !== undefined) event.thread = thread
    if (row?.title !== undefined) event.title = row.title
    if (input.status !== undefined) event.status = input.status
    else if (row?.status !== undefined) event.status = row.status
    if (row?.triggeredBy !== undefined) event.triggeredBy = row.triggeredBy
    if (row?.channelName !== undefined) event.channelName = row.channelName
    if (row?.triggeredByName !== undefined) event.triggeredByName = row.triggeredByName
    if (row?.threadUrl !== undefined) event.threadUrl = row.threadUrl
    // Effective execution config: the session's sticky overrides (console/⚙-modal
    // in-session switches) win over the agent's configured values; absent ⇒ the
    // runtime's own default. Snapshotted here so the CP records what this session
    // actually ran with — the agent's config can change later without rewriting history.
    const agent = this.agents.get(input.agentId)
    const allowRuntimeChangesInChat = agent?.allowRuntimeChangesInChat === true
    if (input.runtime !== undefined) event.runtime = input.runtime
    else if (agent?.runtime) event.runtime = agent.runtime
    const storeKey = this.store.getSessionByAcpIdForAgent(input.agentId, input.sessionId)?.key
    const model =
      (allowRuntimeChangesInChat && storeKey ? this.store.getModelOverride(storeKey) : undefined) ??
      agent?.runtimeOverrides?.model
    if (input.model !== undefined) event.model = input.model
    else if (model !== undefined) event.model = model
    const effort =
      (allowRuntimeChangesInChat && storeKey ? this.store.getEffortOverride(storeKey) : undefined) ??
      agent?.reasoningEffort
    if (effort !== undefined) event.effort = effort
    const fastMode =
      (allowRuntimeChangesInChat && storeKey ? this.store.getFastModeOverride(storeKey) : undefined) ?? agent?.fastMode
    if (fastMode !== undefined) event.fastMode = fastMode
    const permissionMode =
      (allowRuntimeChangesInChat && storeKey ? this.store.getPermissionModeOverride(storeKey) : undefined) ??
      agent?.permissionMode
    if (input.permissionMode !== undefined) event.permissionMode = input.permissionMode
    else if (permissionMode !== undefined) event.permissionMode = permissionMode
    const outputMode = (storeKey ? this.store.getOutputModeOverride(storeKey) : undefined) ?? agent?.output?.mode
    if (outputMode !== undefined) event.outputMode = outputMode

    try {
      this.cpClient.emitEventSession(event)
    } catch (err) {
      this.log.debug(`event/session emit failed (session ${input.sessionId}): ${(err as Error).message}`)
    }
  }

  private emitSessionMetadataSnapshotsForDisplayName(id: string): void {
    if (!this.cpClient) return
    for (const row of this.store.listSessions()) {
      if (!row.acpSessionId) continue
      if (row.channel !== id && row.triggeredBy !== id) continue
      this.emitSessionMetadataSnapshot({
        sessionId: row.acpSessionId,
        agentId: row.agentId,
        phase: 'plan',
        platform: row.platform as SessionKey['platform'],
        channel: row.channel,
        thread: row.thread
      })
    }
  }

  /** Assemble a status snapshot from the parts (agent config + host model selector +
   *  folded ACP usage). Shared by `buildStatusInfo` (per-turn Pending) and
   *  `statusInfoForKey` (the ⚙-modal, keyed by session). */
  private statusInfoFrom(
    agentId: string,
    sessionKey: string,
    acpSessionId?: string,
    opts: { breakdown?: boolean } = {}
  ): StatusBarInfo {
    const agent = this.agents.get(agentId)
    const usage = this.store.getUsage(sessionKey)
    // `?.()` guards a host stub without the method (test fakes); real AcpHosts always have it.
    const host = this.hosts.get(agentId)
    const model = host?.modelOptions?.(acpSessionId)
    // A persisted session can outlive the adapter process that created it. In that
    // cold state the exact session selector is unavailable, but the runtime probe has
    // already advertised model choices for that runtime. Keep a live session's
    // explicit lack of a selector authoritative; only fall back when the host does not
    // currently own this session.
    const modelSessionIsLive = acpSessionId !== undefined && host?.hasSession?.(acpSessionId) === true
    const runtimeModels = agent ? this.runtimeModels.get(agent.runtime) : undefined
    const models = model?.models ?? (!modelSessionIsLive ? runtimeModels : undefined)
    const runtimeDefaultModel = agent ? this.runtimeCatalogs.get(agent.runtime)?.defaultModel : undefined
    const fallbackModel =
      !modelSessionIsLive && models?.length
        ? runtimeDefaultModel && models.includes(runtimeDefaultModel)
          ? runtimeDefaultModel
          : models[0]
        : undefined
    const effort = host?.effortOptions?.()
    const permissionMode = host?.permissionModeOptions?.()
    const fast = host?.fastModeOption?.()
    const allowRuntimeChangesInChat = agent?.allowRuntimeChangesInChat === true
    // Current model: live selector, then sticky/session default, then the runtime's
    // advertised default. Effort keeps the sticky override first because it is the
    // only way an `ultracode` value (which never appears in the live select) is reflected.
    const effortOverride = allowRuntimeChangesInChat ? this.store.getEffortOverride(sessionKey) : undefined
    const modelOverride = allowRuntimeChangesInChat ? this.store.getModelOverride(sessionKey) : undefined
    const permissionModeOverride = allowRuntimeChangesInChat
      ? this.store.getPermissionModeOverride(sessionKey)
      : undefined
    const fastOverride = allowRuntimeChangesInChat ? this.store.getFastModeOverride(sessionKey) : undefined
    return {
      model: model?.current ?? modelOverride ?? agent?.runtimeOverrides?.model ?? fallbackModel,
      effort: effortOverride ?? effort?.current ?? agent?.reasoningEffort,
      permissionMode: allowRuntimeChangesInChat
        ? (permissionModeOverride ?? permissionMode?.current ?? agent?.permissionMode)
        : (agent?.permissionMode ?? permissionMode?.current),
      fastMode: fastOverride ?? fast?.current ?? agent?.fastMode,
      contextUsed: usage.contextUsed,
      contextSize: usage.contextSize,
      totalTokens: usage.totalTokens,
      costAmount: usage.costAmount,
      costCurrency: usage.costCurrency,
      // Full token breakdown — ONLY the Slack modal's detail block wants these; kept off
      // the compact line + webchat status payload (which the WebchatStatus schema doesn't carry).
      ...(opts.breakdown
        ? {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            thoughtTokens: usage.thoughtTokens,
            cachedReadTokens: usage.cachedReadTokens,
            cachedWriteTokens: usage.cachedWriteTokens,
            // Slack output verbosity (daemon-side low/medium/high) — modal-only, so it
            // rides the breakdown gate and stays off the compact line + webchat status payload.
            outputMode: this.store.getOutputModeOverride(sessionKey) ?? agent?.output?.mode
          }
        : {}),
      // Selectable models / efforts + whether a fast toggle is offered — the modal's
      // dropdowns + toggle. Plus the session id for the deep link.
      ...(allowRuntimeChangesInChat && models?.length ? { models } : {}),
      ...(allowRuntimeChangesInChat && effort?.efforts?.length ? { efforts: effort.efforts } : {}),
      ...(agent
        ? {
            permissionModes: allowRuntimeChangesInChat && permissionMode?.modes?.length ? permissionMode.modes : []
          }
        : {}),
      ...(allowRuntimeChangesInChat && fast ? { fastModeAvailable: true } : {}),
      ...(acpSessionId ? { sessionId: acpSessionId } : {})
    }
  }

  /** Per-turn status snapshot for the live in-thread line + webchat status payload (no breakdown). */
  private buildStatusInfo(p: Pending): StatusBarInfo {
    return this.statusInfoFrom(p.agentId, p.sessionKey, p.acpSessionId)
  }

  /** Agent identity + status snapshot (WITH the full token breakdown) + deep link for a
   *  session by KEY — the source of truth the Slack connection queries to build the ⚙
   *  controls modal on click. Undefined on unknown key. */
  private statusInfoForKey(
    sessionKey: string
  ): { info: StatusBarInfo; identity: StatusModalIdentity; link?: string; cancellable: boolean } | undefined {
    const rec = this.store.getSession(sessionKey)
    if (!rec) return undefined
    const info = this.statusInfoFrom(rec.agentId, sessionKey, rec.acpSessionId ?? undefined, { breakdown: true })
    const agent = this.agents.get(rec.agentId)
    const name = agent?.displayName?.trim() || agent?.name || rec.agentId
    const sessionTitle = rec.title?.trim()
    const iconUrl = agent?.iconUrl?.trim()
    const identity: StatusModalIdentity = {
      name,
      agentUrl: this.agentLink(rec.agentId),
      ...(iconUrl ? { iconUrl } : {}),
      ...(sessionTitle ? { sessionTitle } : {})
    }
    const link = rec.acpSessionId ? this.sessionLink(rec.acpSessionId) : undefined
    const pending = [...this.pending.values()].find((turn) => turn.sessionKey === sessionKey)
    const cancellable = pending?.statusCancellable ?? this.inflight.has(sessionKey)
    return { info, identity, ...(link ? { link } : {}), cancellable }
  }

  /** Settle the persistent Slack status row without reviving suppressed turn output. */
  private settleStatusBar(p: Pending): void {
    const emitted = p.lastStatusBar !== undefined
    p.statusCancellable = false
    if (p.platform === 'slack' && emitted) this.emitStatusBar(p, true)
  }

  /** Emit/refresh the session's status bar (model / context / tokens / cost). Called at
   *  turn start (model + carried-over usage), on each `usage_update` (live context/cost),
   *  and at turn end (token totals). Deduped against the last snapshot so an unchanged
   *  update is a no-op. Webchat emits a status-only `WebchatOutput` payload through
   *  the relay reply sink; Slack gets the session-scoped in-place `status-bar` action.
   *  Telegram has NO status bar — state is queried on
   *  demand via `/status` (see handleCommand) — so it's skipped here. Headless no-ops in
   *  applyAction (no connection), which is fine. */
  private emitStatusBar(p: Pending, allowWhenSuppressed = false): void {
    if (p.outputSuppressed && !allowWhenSuppressed) return
    const info = this.buildStatusInfo(p)
    const key = JSON.stringify([info, p.platform === 'slack' ? p.statusCancellable : null])
    if (key === p.lastStatusBar) return // unchanged since the last emit — no-op
    if (p.webchat) {
      // Webchat: skip a truly-empty frame (nothing for the web bar to show); the model /
      // usage lands on a later call. `sessionId` is always present, so exclude it.
      if (!Object.entries(info).some(([k, v]) => k !== 'sessionId' && v !== undefined)) return
      p.lastStatusBar = key
      const wc = p.webchat
      wc.sink.output({
        conversationId: wc.conversationId,
        turnId: wc.turnId,
        index: wc.index++,
        status: info
      })
    } else if (p.platform === 'telegram' || p.platform === 'discord' || p.platform === 'feishu') {
      // Telegram/Discord/Feishu have no per-turn status bar — session state is queried on
      // demand via `/status` (handleCommand). Record the dedup key so the shared bookkeeping
      // stays consistent, but emit nothing.
      p.lastStatusBar = key
    } else {
      // Slack: ensure/refresh the status bar from turn START unconditionally — it must be
      // visible as soon as the turn begins, even before the model/usage is known (some
      // runtimes only advertise the model after the first prompt). It fills in via edits
      // as usage_update / turn-end land.
      p.lastStatusBar = key
      const link = this.sessionLink(p.acpSessionId)
      const sessionTarget = this.httpSlackSessionTarget(p)
      const shared =
        sessionTarget && p.integrationId
          ? {
              sessionTarget,
              shareable: this.isShareableSlackIntegration(p.agentId, p.integrationId)
            }
          : undefined
      this.enqueueApply(
        p,
        {
          kind: 'status-bar',
          text: renderStatusBar(info),
          blocks: buildStatusBlocks(info, p.sessionKey, link, shared, p.statusCancellable)
        },
        { allowWhenSuppressed }
      )
    }
  }

  /** Show the transient "working" indicator: Slack's assistant status bar (text; ''
   *  clears) or Telegram's typing chat-action (self-expiring, so a clear is a no-op). */
  private showActivity(
    conn: SlackConnection | TelegramConnection | DiscordConnection | FeishuConnection | undefined,
    channel: string,
    thread: string,
    text: string,
    slackStatusOptions?: SlackStatusOptions
  ): void {
    if (!conn) return
    // Duck-type by method (so test fakes work): Slack has setStatus ('' clears the bar);
    // Telegram/Discord have sendChatAction (a self-expiring "typing…", so a clear is a no-op).
    const slack = conn as Partial<SlackConnection>
    if (typeof slack.setStatus === 'function') {
      if (text && slackStatusOptions) void slack.setStatus(channel, thread, text, undefined, slackStatusOptions)
      else void slack.setStatus(channel, thread, text)
    } else if (text && typeof (conn as Partial<TelegramConnection>).sendChatAction === 'function')
      void (conn as TelegramConnection).sendChatAction(channel)
  }

  /** Serialize action application per session so in-place edits never race on the
   *  remembered message ts (two concurrent `progress` actions both posting). Routes to
   *  the platform's applier by the Pending's platform tag. */
  private enqueueApply(
    p: Pending,
    action: SlackAction | TelegramAction | DiscordAction | FeishuAction,
    opts: { allowWhenSuppressed?: boolean } = {}
  ): void {
    if (p.outputSuppressed && !opts.allowWhenSuppressed) return
    p.applyChain = p.applyChain.then(() => {
      // Check again at execution time: actions queued before an interrupt must not
      // publish later after a backed-up transport queue drains.
      if (p.outputSuppressed && !opts.allowWhenSuppressed) return
      return (
        p.platform === 'telegram'
          ? this.applyTelegramAction(p, action as TelegramAction)
          : p.platform === 'discord'
            ? this.applyDiscordAction(p, action as DiscordAction)
            : p.platform === 'feishu'
              ? this.applyFeishuAction(p, action as FeishuAction)
              : this.applySlackAction(p, action as SlackAction)
      ).catch((err) => this.log.error(`apply failed: ${formatErr(err)}`))
    })
  }

  /** (Re)arm the ~2s idle-flush timer when body text is buffered (§9.1 text-buffer):
   *  a long pure-text stream posts in steps instead of all at turn end. */
  private armIdle(p: Pending): void {
    this.clearIdle(p)
    if (!p.conv.hasBuffered()) return
    p.idleTimer = setTimeout(() => {
      p.idleTimer = undefined
      for (const action of p.conv.flushBuffered()) this.enqueueApply(p, action)
    }, IDLE_FLUSH_MS)
  }

  /** Sample the cumulative Feishu answer independently of transcript flushes.
   * A single timer survives token bursts, so at most one CardKit write is queued per
   * interval while still flushing the newest full snapshot when it fires. */
  private armFeishuStream(p: Pending): void {
    if (
      p.platform !== 'feishu' ||
      p.feishuStreamTimer ||
      !(p.conv instanceof FeishuConverger) ||
      !p.conv.hasStreamingUpdate()
    )
      return
    p.feishuStreamTimer = setTimeout(() => {
      p.feishuStreamTimer = undefined
      for (const action of (p.conv as FeishuConverger).streamUpdate()) this.enqueueApply(p, action)
    }, FEISHU_STREAM_FLUSH_MS)
  }

  private clearFeishuStream(p: Pending): void {
    if (p.feishuStreamTimer) clearTimeout(p.feishuStreamTimer)
    p.feishuStreamTimer = undefined
  }

  private clearIdle(p: Pending): void {
    if (p.idleTimer) clearTimeout(p.idleTimer)
    p.idleTimer = undefined
  }

  /** In-flight rendering state keyed by (agentId, ACP sessionId). */
  private pending = new Map<string, Pending>()

  /**
   * DAEMON-PRIVATE trusted call metadata of the CURRENTLY in-flight turn, keyed by the
   * turn's LOGICAL sessionKey (§6.7). Installed at the start of a `dispatchOne` turn that
   * carries `callMeta` and cleared in its `finally`; the tool is keyed by the static
   * session-level MCP token, so a nested `messageAgent` resolves the caller's sessionKey
   * (from its trusted SessionContext coords + agentId) and reads THIS map to auto-inherit
   * hop/origin (all child calls) and correlationId (replies only) — never trusting the
   * agent to pass them. A plain human/platform turn has no entry, so a `messageAgent` it
   * makes is a fresh call (hopCount 0, no inherited correlation).
   */
  private activeTurnCallMeta = new Map<string, CallMeta>()

  // ── Permission requests (ACP session/request_permission) ─────────────────────
  private pendingEditorPermissions = new Map<
    string,
    | {
        kind: 'permission'
        agentId: string
        sessionId: string
        params: RequestPermissionRequest
        evaluationParams: RequestPermissionRequest
        resolve: (res: RequestPermissionResponse) => void
      }
    | {
        kind: 'elicitation'
        agentId: string
        sessionId: string
        resolve: (res: CreateElicitationResponse) => void
      }
  >()

  private pendingChatPermissions = new Map<
    string,
    {
      agentId: string
      sessionId: string
      params: RequestPermissionRequest
      /** Original ACP object used by the host's final policy observer. */
      evaluationParams: RequestPermissionRequest
      conn: SlackConnection
      channel: string
      ts?: string
      resolve: (res: RequestPermissionResponse) => void
    }
  >()
  /** Decision details discovered inside the platform policy and merged into the
   * single terminal event emitted by AcpHost's policy observer. */
  private readonly permissionEvaluationDetails = new WeakMap<RequestPermissionRequest, Record<string, unknown>>()

  /**
   * Post a chronological boundary message SERIALIZED on the turn's apply chain, returning
   * its id (undefined on a failed post), then mark live chrome to continue below it. A direct
   * post would race the chrome already queued for this turn: those sends and the boundary
   * connection's one send-queue in call order, so a pre-card message whose `applyChain` step
   * hasn't run yet would be sent AFTER — and land BELOW — the boundary. Chaining makes
   * it run only once every earlier step has issued its send, so pre-card chrome stays above
   * the boundary and the following live stream stay in chronological order.
   */
  private async postLiveChromeBoundarySerialized<T>(
    p: Pending,
    messageType: LiveChromeBoundaryMessageType,
    post: (conn: SlackConnection) => Promise<T | undefined>
  ): Promise<T | undefined> {
    const conn = p.conn as SlackConnection
    let result: T | undefined
    const step = p.applyChain.then(async () => {
      result = await post(conn)
      if (result !== undefined && LIVE_CHROME_BOUNDARY_MESSAGE_TYPES.has(messageType)) {
        this.markInPlaceChromeForReanchor(p)
      }
    })
    // Keep the chain alive for later actions (the reanchor, the post-answer stream) even if
    // this post throws — mirrors enqueueApply's per-step error isolation.
    p.applyChain = step.catch(() => {})
    await step
    return result
  }

  private async postCardSerialized(
    p: Pending,
    post: (conn: SlackConnection) => Promise<string | undefined>
  ): Promise<string | undefined> {
    return await this.postLiveChromeBoundarySerialized(p, 'human-input-card', post).catch(() => undefined)
  }

  /**
   * Mark turn-local in-place messages to continue below a newly posted chronological boundary.
   * This covers human-input cards and visible agent-authored `messageAgent` text. Minimal mode's
   * single live reply and the medium/high progress / plan / reasoning messages may now sit ABOVE
   * that message and would keep editing above it, so the newest activity would read as if it came
   * before the boundary. Re-anchor so the next update posts a FRESH message BELOW it (the old one
   * stays frozen above), preserving chat order. The session status bar is deliberately excluded:
   * it is a header for the whole session and stays pinned to its original topmost message.
   *
   * Enqueued on the apply chain so it lands AFTER any segment-close / tool-progress action
   * already queued before the boundary (which belongs above) and BEFORE the following stream
   * (which belongs below). The live reply reanchors lazily on its next action (so an empty tail
   * keeps the old message and its footer); the turn-local progress / plan / reasoning anchors
   * reset directly. Slack-only.
   */
  private reanchorInPlaceChrome(p: Pending): void {
    p.applyChain = p.applyChain.then(() => this.markInPlaceChromeForReanchor(p))
  }

  private markInPlaceChromeForReanchor(p: Pending): void {
    p.liveReplyReanchor = true
    p.progressTs = undefined
    p.progressAttempted = false
    p.planTs = undefined
    p.planAttempted = false
    p.reasoningTs = undefined
    p.reasoningAttempted = false
  }

  /**
   * ACP `session/request_permission` policy (wired as AcpHost.onPermission). Built-in
   * AgentConnect tools are trusted; every other live request waits for an Agent editor by
   * default. An editor may explicitly opt an agent into Slack chat-side decisions.
   */
  /** Copy-on-write mask of an agent's write-only secret values over any JSON-ish
   *  payload about to be rendered, streamed, or persisted (session/secret-mask.ts).
   *  No-op (same reference) for agents without maskable secrets. */
  private maskAgentSecrets<T>(agentId: string, payload: T): T {
    return maskSecretsDeep(payload, maskableSecrets(this.agents.get(agentId)))
  }

  private noteEditorPermissionRequest(
    id: string,
    agentId: string,
    sessionId: string,
    command: string,
    p: Pending,
    notifyChat = true
  ): void {
    const session = this.store.getSessionByAcpIdForAgent(agentId, sessionId)
    const requesterId = p.requesterId ?? session?.triggeredBy ?? null
    const requesterName = requesterId ? (this.store.getDisplayNames([requesterId]).get(requesterId) ?? null) : null
    this.store.createPermissionRequest({
      id,
      agentId,
      sessionId,
      createdAt: this.clock.now(),
      requesterId,
      requesterName,
      command,
      status: 'pending',
      resolvedAt: null
    })

    if (!notifyChat) return
    const text = '🔒 Permission requested. Ask an Agent editor to allow it from the Agent or Session page.'
    try {
      if (p.webchat) {
        p.webchat.sink.output({
          conversationId: p.webchat.conversationId,
          turnId: p.webchat.turnId,
          index: p.webchat.index++,
          event: { kind: 'message', text }
        })
      } else if (p.conn) {
        this.enqueueApply(p, { kind: 'notice', text })
      }
    } catch (err) {
      // The durable editor request is authoritative. A best-effort chat notice
      // must never discard the live resolver or silently fall back to auto-allow.
      this.log.warn(`permission request notice failed for "${p.sessionKey}": ${formatErr(err)}`)
    }
  }

  private resolveStoredPermissionRequest(
    agentId: string,
    requestId: string,
    status: 'allowed' | 'denied' | 'expired'
  ): boolean {
    try {
      return this.store.resolvePermissionRequest(agentId, requestId, status, this.clock.now())
    } catch (err) {
      this.log.error(`permission request "${requestId}" could not be resolved locally: ${formatErr(err)}`)
      return false
    }
  }

  private awaitEditorPermission(
    agentId: string,
    sessionId: string,
    params: RequestPermissionRequest,
    evaluationParams: RequestPermissionRequest,
    p: Pending
  ): Promise<RequestPermissionResponse> {
    const id = randomUUID()
    let resolveResult!: (res: RequestPermissionResponse) => void
    const result = new Promise<RequestPermissionResponse>((resolve) => (resolveResult = resolve))
    this.noteEditorPermissionRequest(id, agentId, sessionId, permissionRequestSummary(params), p)
    this.pendingEditorPermissions.set(id, {
      kind: 'permission',
      agentId,
      sessionId,
      params,
      evaluationParams,
      resolve: resolveResult
    })
    return result
  }

  private awaitEditorElicitation(
    agentId: string,
    sessionId: string,
    params: CreateElicitationRequest,
    p: Pending
  ): Promise<CreateElicitationResponse> {
    const id = randomUUID()
    let resolveResult!: (res: CreateElicitationResponse) => void
    const result = new Promise<CreateElicitationResponse>((resolve) => (resolveResult = resolve))
    this.noteEditorPermissionRequest(id, agentId, sessionId, elicitationApprovalSummary(params), p)
    this.pendingEditorPermissions.set(id, {
      kind: 'elicitation',
      agentId,
      sessionId,
      resolve: resolveResult
    })
    return result
  }

  private async awaitChatPermission(
    agentId: string,
    sessionId: string,
    params: RequestPermissionRequest,
    evaluationParams: RequestPermissionRequest,
    p: Pending
  ): Promise<RequestPermissionResponse> {
    const requestId = randomUUID()
    const conn = p.conn as SlackConnection
    let resolveResult!: (res: RequestPermissionResponse) => void
    const result = new Promise<RequestPermissionResponse>((resolve) => (resolveResult = resolve))
    this.noteEditorPermissionRequest(requestId, agentId, sessionId, permissionRequestSummary(params), p, false)
    this.pendingChatPermissions.set(requestId, {
      agentId,
      sessionId,
      params,
      evaluationParams,
      conn,
      channel: p.channel,
      resolve: resolveResult
    })
    const blocks = buildPermissionCard(requestId, params, this.httpSlackSessionTarget(p))
    const fallback = `Permission requested: ${params.toolCall?.title ?? 'a tool call'}`
    const ts = await this.postCardSerialized(p, (slack) =>
      slack.postBlocks(p.channel, blocks, fallback, p.statusThread, {
        ...(this.slackPostOptions(p) ?? {}),
        chrome: true
      })
    )
    const live = this.pendingChatPermissions.get(requestId)
    if (!live) {
      if (ts) {
        void conn
          .updateBlocks(
            p.channel,
            ts,
            buildPermissionResolvedCard(params, 'Cancelled', undefined),
            'Permission cancelled',
            true
          )
          .catch(() => {})
      }
      return await result
    }
    if (!ts) {
      this.pendingChatPermissions.delete(requestId)
      this.resolveStoredPermissionRequest(agentId, requestId, 'expired')
      this.permissionEvaluationDetails.set(evaluationParams, { reason: 'permission_card_failed' })
      live.resolve({ outcome: { outcome: 'cancelled' } })
      return await result
    }
    live.ts = ts
    return await result
  }

  private decideEditorPermission(req: AgentPermissionDecision): Ack {
    const pending = this.pendingEditorPermissions.get(req.requestId)
    if (!pending || pending.agentId !== req.agentId) {
      const chat = this.pendingChatPermissions.get(req.requestId)
      if (!chat || chat.agentId !== req.agentId) {
        const elicitation = this.pendingElicits.get(req.requestId)
        if (!elicitation?.approval || elicitation.agentId !== req.agentId) {
          return { ok: false, reason: 'permission request is no longer pending' }
        }
        if (
          !this.resolveStoredPermissionRequest(
            req.agentId,
            req.requestId,
            req.decision === 'allow' ? 'allowed' : 'denied'
          )
        ) {
          return { ok: false, reason: 'permission request is no longer pending' }
        }
        this.pendingElicits.delete(req.requestId)
        if (elicitation.ts) {
          const decision =
            req.decision === 'allow'
              ? ':white_check_mark: Allowed by Agent editor'
              : ':no_entry_sign: Denied by Agent editor'
          void elicitation.conn
            .updateBlocks(
              elicitation.channel,
              elicitation.ts,
              buildElicitationResolvedCard(elicitation.params, decision),
              'Permission resolved',
              true
            )
            .catch(() => {})
        }
        elicitation.resolve(req.decision === 'allow' ? { action: 'accept' } : { action: 'cancel' })
        return { ok: true }
      }
      const option =
        req.decision === 'allow'
          ? (chat.params.options.find((candidate) => candidate.kind === 'allow_once') ??
            chat.params.options.find((candidate) => candidate.kind === 'allow_always'))
          : (chat.params.options.find((candidate) => candidate.kind === 'reject_once') ??
            chat.params.options.find((candidate) => candidate.kind === 'reject_always'))
      if (req.decision === 'allow' && !option) return { ok: false, reason: 'runtime did not offer an allow option' }
      if (
        !this.resolveStoredPermissionRequest(
          req.agentId,
          req.requestId,
          req.decision === 'allow' ? 'allowed' : 'denied'
        )
      ) {
        return { ok: false, reason: 'permission request is no longer pending' }
      }
      this.pendingChatPermissions.delete(req.requestId)
      this.permissionEvaluationDetails.set(chat.evaluationParams, { reason: 'agent_editor' })
      if (chat.ts) {
        void chat.conn
          .updateBlocks(
            chat.channel,
            chat.ts,
            buildPermissionResolvedCard(
              chat.params,
              option?.name ?? 'Denied by Agent editor',
              req.decision === 'allow'
            ),
            'Permission resolved',
            true
          )
          .catch(() => {})
      }
      chat.resolve(
        option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } }
      )
      return { ok: true }
    }

    let permissionResponse: RequestPermissionResponse | undefined
    let elicitationResponse: CreateElicitationResponse | undefined
    if (pending.kind === 'permission') {
      const option =
        req.decision === 'allow'
          ? (pending.params.options.find((o) => o.kind === 'allow_once') ??
            pending.params.options.find((o) => o.kind === 'allow_always'))
          : (pending.params.options.find((o) => o.kind === 'reject_once') ??
            pending.params.options.find((o) => o.kind === 'reject_always'))
      if (req.decision === 'allow' && !option) return { ok: false, reason: 'runtime did not offer an allow option' }
      this.permissionEvaluationDetails.set(pending.evaluationParams, { reason: 'agent_editor' })
      permissionResponse = option
        ? { outcome: { outcome: 'selected', optionId: option.optionId } }
        : { outcome: { outcome: 'cancelled' } }
    } else {
      elicitationResponse = req.decision === 'allow' ? { action: 'accept' } : { action: 'cancel' }
    }

    if (
      !this.resolveStoredPermissionRequest(req.agentId, req.requestId, req.decision === 'allow' ? 'allowed' : 'denied')
    ) {
      return { ok: false, reason: 'permission request is no longer pending' }
    }
    this.pendingEditorPermissions.delete(req.requestId)
    if (pending.kind === 'permission') pending.resolve(permissionResponse!)
    else pending.resolve(elicitationResponse!)
    return { ok: true }
  }

  private handlePermissionChoice(input: { requestId: string; optionId: string; actor?: InteractionActor }): void {
    const pending = this.pendingChatPermissions.get(input.requestId)
    if (!pending) return
    if (this.agents.get(pending.agentId)?.allowRuntimeChangesInChat !== true) {
      // Refused, so it decided nothing — recorded as an attempt, never as the decision.
      this.logSessionAction(`permission:${input.optionId} (refused)`, pending.sessionId, input.actor)
      if (pending.ts) {
        void pending.conn
          .updateBlocks(
            pending.channel,
            pending.ts,
            buildPermissionResolvedCard(pending.params, 'Ask an Agent editor to allow it', undefined),
            'Permission requires an Agent editor',
            true
          )
          .catch(() => {})
      }
      return
    }
    const option = pending.params.options.find((candidate) => candidate.optionId === input.optionId)
    if (!option) return
    const allowed = option.kind === 'allow_once' || option.kind === 'allow_always'
    if (!this.resolveStoredPermissionRequest(pending.agentId, input.requestId, allowed ? 'allowed' : 'denied')) return
    // Only now is this click the decision: the guard passed, the option was real, and
    // the request resolved. Logging any earlier would attribute a tool call to someone
    // whose click changed nothing.
    this.logSessionAction(`permission:${allowed ? 'allowed' : 'denied'}`, pending.sessionId, input.actor)
    this.pendingChatPermissions.delete(input.requestId)
    this.permissionEvaluationDetails.set(pending.evaluationParams, { reason: 'chat_user' })
    if (pending.ts) {
      void pending.conn
        .updateBlocks(
          pending.channel,
          pending.ts,
          buildPermissionResolvedCard(pending.params, option.name, allowed),
          'Permission resolved',
          true
        )
        .catch(() => {})
    }
    pending.resolve({ outcome: { outcome: 'selected', optionId: option.optionId } })
  }

  /** Remove stale Allow/Deny controls immediately when an editor disables chat-side
   * runtime controls. The permission requests remain pending for the Agent-page queue. */
  private disableChatPermissionSurfaces(agentId: string): void {
    for (const pending of this.pendingChatPermissions.values()) {
      if (pending.agentId !== agentId || !pending.ts) continue
      void pending.conn
        .updateBlocks(
          pending.channel,
          pending.ts,
          buildPermissionResolvedCard(pending.params, 'Ask an Agent editor to allow it', undefined),
          'Permission requires an Agent editor',
          true
        )
        .catch(() => {})
    }
    for (const pending of this.pendingElicits.values()) {
      if (pending.agentId !== agentId || !pending.approval || !pending.ts) continue
      void pending.conn
        .updateBlocks(
          pending.channel,
          pending.ts,
          buildElicitationResolvedCard(pending.params, ':lock: Ask an Agent editor to allow it'),
          'Permission requires an Agent editor',
          true
        )
        .catch(() => {})
    }
  }

  private releaseChatPermissions(agentId: string, sessionId: string): void {
    for (const [id, pending] of this.pendingChatPermissions) {
      if (pending.agentId !== agentId || pending.sessionId !== sessionId) continue
      this.pendingChatPermissions.delete(id)
      this.resolveStoredPermissionRequest(agentId, id, 'expired')
      this.permissionEvaluationDetails.set(pending.evaluationParams, { reason: 'turn_cancelled' })
      if (pending.ts) {
        void pending.conn
          .updateBlocks(
            pending.channel,
            pending.ts,
            buildPermissionResolvedCard(pending.params, 'Cancelled', undefined),
            'Permission cancelled',
            true
          )
          .catch(() => {})
      }
      pending.resolve({ outcome: { outcome: 'cancelled' } })
    }
  }

  private releaseEditorPermissions(agentId: string, sessionId: string): void {
    for (const [id, pending] of this.pendingEditorPermissions) {
      if (pending.agentId !== agentId || pending.sessionId !== sessionId) continue
      this.pendingEditorPermissions.delete(id)
      this.resolveStoredPermissionRequest(agentId, id, 'expired')
      if (pending.kind === 'permission') {
        this.permissionEvaluationDetails.set(pending.evaluationParams, { reason: 'turn_cancelled' })
        pending.resolve({ outcome: { outcome: 'cancelled' } })
      } else {
        pending.resolve({ action: 'cancel' })
      }
    }
  }

  private onAcpPermissionEvent(
    agentId: string,
    sessionId: string,
    params: RequestPermissionRequest,
    event: AcpPermissionPolicyEvent
  ): void {
    const pending = this.pending.get(pendingTurnKey(agentId, sessionId))
    const context = {
      agentId,
      sessionId,
      ...(pending?.evaluationTurnId ? { turnId: pending.evaluationTurnId } : {})
    }
    const toolCallId = typeof params.toolCall?.toolCallId === 'string' ? params.toolCall.toolCallId : undefined
    if (event.kind === 'requested') {
      this.emitEvaluation({
        type: 'permission.requested',
        ...context,
        data: { ...(toolCallId ? { toolCallId } : {}), optionCount: params.options.length }
      })
      return
    }

    const outcome = event.response.outcome
    const policyDetails = this.permissionEvaluationDetails.get(params)
    this.permissionEvaluationDetails.delete(params)
    const resultData = {
      ...(policyDetails ?? {}),
      source: event.source,
      ...(event.fallbackReason ? { fallbackReason: event.fallbackReason } : {}),
      outcome: outcome.outcome,
      ...('optionId' in outcome ? { optionId: outcome.optionId } : {}),
      ...(toolCallId ? { toolCallId } : {})
    }
    const selectedOption =
      'optionId' in outcome ? params.options.find((option) => option.optionId === outcome.optionId) : undefined
    if (
      event.source === 'fallback' &&
      outcome.outcome === 'selected' &&
      (selectedOption?.kind === 'allow_once' || selectedOption?.kind === 'allow_always')
    ) {
      this.emitEvaluation({ type: 'permission.auto_allowed', ...context, data: resultData })
    }
    this.emitEvaluation({
      type: outcome.outcome === 'cancelled' ? 'permission.cancelled' : 'permission.resolved',
      ...context,
      data: resultData
    })
  }

  private async onAcpPermission(
    agentId: string,
    sessionId: string,
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    try {
      return await this.resolveAcpPermission(agentId, sessionId, params)
    } catch (err) {
      this.permissionEvaluationDetails.set(params, { reason: 'permission_policy_error' })
      this.log.error(`permission policy failed closed for agent "${agentId}": ${formatErr(err)}`)
      return { outcome: { outcome: 'cancelled' } }
    }
  }

  private async resolveAcpPermission(
    agentId: string,
    sessionId: string,
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    const evaluationParams = params
    // The tool title/preview can embed a secret the agent interpolated into a command.
    // Mask before anything renders it (Slack card now, resolved-card edit later via
    // the pending request).
    params = this.maskAgentSecrets(agentId, params)
    // Extraction is a silent background operation: it may never gain side effects
    // merely because the user agent normally runs in an auto-approval mode.
    if (this.memoryExtractionCollectors.has(pendingTurnKey(agentId, sessionId))) {
      this.permissionEvaluationDetails.set(evaluationParams, { reason: 'memory_extraction' })
      return { outcome: { outcome: 'cancelled' } }
    }
    // Platform system tools (this daemon's OWN MCP tools — sendMessage, listAgents,
    // orchestration, memory, …) are always granted: a human should never
    // have to approve them per call. Auto-allow without rendering a card. Non-system tools
    // (incl. the runtime's dangerous built-ins) fall through to the interactive policy below.
    const p = this.pending.get(pendingTurnKey(agentId, sessionId))
    if (isBuiltinSystemTool(params, p?.builtinSystemToolCallIds)) {
      const allow = params.options.find((o) => o.kind === 'allow_always' || o.kind === 'allow_once')
      if (allow) {
        this.permissionEvaluationDetails.set(evaluationParams, { reason: 'agentconnect_system_tool' })
        this.emitEvaluation({
          type: 'permission.auto_allowed',
          agentId,
          sessionId,
          ...(p?.evaluationTurnId ? { turnId: p.evaluationTurnId } : {}),
          data: { reason: 'agentconnect_system_tool', optionId: allow.optionId }
        })
        return { outcome: { outcome: 'selected', optionId: allow.optionId } }
      }
    }
    if (!p || p.outputSuppressed) {
      this.permissionEvaluationDetails.set(evaluationParams, {
        reason: p?.outputSuppressed ?? 'permission_without_live_turn'
      })
      return { outcome: { outcome: 'cancelled' } }
    }
    const chatApprovalEnabled =
      this.agents.get(agentId)?.allowRuntimeChangesInChat === true &&
      p.platform === 'slack' &&
      p.conn instanceof SlackConnection &&
      !p.approvalSurfaceSuppressed &&
      params.options.length > 0
    if (chatApprovalEnabled) {
      return await this.awaitChatPermission(agentId, sessionId, params, evaluationParams, p)
    }
    // Default policy: hold the runtime request and surface only a neutral notice
    // in chat. The bounded, masked request is decided by an Agent editor.
    return await this.awaitEditorPermission(agentId, sessionId, params, evaluationParams, p)
  }

  // ── Interactive elicitations (ACP elicitation/create, form mode) ─────────────
  private elicitSeq = 0
  private pendingElicits = new Map<
    string,
    {
      agentId: string
      sessionId: string
      params: CreateElicitationRequest
      propName: string
      kind: 'enum' | 'boolean'
      approval: boolean
      conn: SlackConnection
      channel: string
      ts?: string
      resolve: (res: CreateElicitationResponse) => void
    }
  >()

  /**
   * ACP `elicitation/create` policy (wired as AcpHost.onElicit). Renders the form's first
   * choice/boolean field as a Slack card and resolves with the user's pick. Returns
   * `undefined` — so the host declines — when there's no live turn, the turn isn't on
   * Slack, or the form has no field we can render inline. Stays pending until the user
   * taps a button (handleElicitChoice) or the turn ends/cancels (releaseElicits).
   */
  private async onAcpElicit(
    agentId: string,
    sessionId: string,
    params: CreateElicitationRequest
  ): Promise<CreateElicitationResponse | undefined> {
    // Same reason as onAcpPermission: the elicitation message/labels are agent-authored
    // text headed for a platform card — mask any embedded secret value first.
    params = this.maskAgentSecrets(agentId, params)
    const p = this.pending.get(pendingTurnKey(agentId, sessionId))
    if (!p) return undefined
    if (p.outputSuppressed) return { action: 'cancel' }
    // Codex maps MCP approval to `elicitation/create` when form support is
    // advertised. Correlate its opaque id with a preceding trusted tool event;
    // never infer trust from the human-facing elicitation message.
    if (isBuiltinSystemToolElicitation(params, p.builtinSystemToolCallIds)) return { action: 'accept' }
    const isApproval = isMcpToolApprovalElicitation(params)
    if (isApproval) {
      const chatApprovalEnabled =
        this.agents.get(agentId)?.allowRuntimeChangesInChat === true &&
        p.platform === 'slack' &&
        p.conn instanceof SlackConnection &&
        !p.approvalSurfaceSuppressed
      if (!chatApprovalEnabled) return await this.awaitEditorElicitation(agentId, sessionId, params, p)
    }
    // A `none` Slack turn has no generic human-input card to answer this request.
    if (p.approvalSurfaceSuppressed) return { action: 'cancel' }
    const conn = p.conn
    if (p.platform !== 'slack' || !(conn instanceof SlackConnection)) return undefined
    const target = elicitTarget(params)
    if (!target) return undefined
    const requestId = isApproval ? randomUUID() : `elicit-${++this.elicitSeq}`
    const blocks = buildElicitationCard(requestId, params, this.httpSlackSessionTarget(p))
    if (!blocks) return undefined
    const fallback = (params as { message?: string }).message ?? 'The agent needs your input'
    let resolveResult!: (res: CreateElicitationResponse) => void
    const result = new Promise<CreateElicitationResponse>((resolve) => (resolveResult = resolve))
    if (isApproval) {
      this.noteEditorPermissionRequest(requestId, agentId, sessionId, elicitationApprovalSummary(params), p, false)
    }
    this.pendingElicits.set(requestId, {
      agentId,
      sessionId,
      params,
      propName: target.propName,
      kind: target.kind,
      approval: isApproval,
      conn,
      channel: p.channel,
      resolve: resolveResult
    })
    const ts = await this.postCardSerialized(p, (sc) =>
      sc.postBlocks(p.channel, blocks, fallback, p.statusThread, {
        ...(this.slackPostOptions(p) ?? {}),
        chrome: true
      })
    )
    const live = this.pendingElicits.get(requestId)
    if (!live) {
      if (ts)
        void conn
          .updateBlocks(p.channel, ts, buildElicitationResolvedCard(params, ':hourglass: Cancelled'), 'Cancelled', true)
          .catch(() => {})
      return await result
    }
    if (!ts) {
      this.pendingElicits.delete(requestId)
      if (isApproval) this.resolveStoredPermissionRequest(agentId, requestId, 'expired')
      live.resolve({ action: 'cancel' })
      return await result
    }
    live.ts = ts
    return await result
  }

  /** A tapped elicitation-card button (SlackDeps.onElicitChoice): resolve the pending ACP
   *  request — `accept` with the chosen value (under the field name), or `decline` for the
   *  Dismiss button (value === null) — and edit the card in place. No-op if already gone. */
  private handleElicitChoice(a: { requestId: string; value: string | null }): void {
    const rec = this.pendingElicits.get(a.requestId)
    if (!rec) return
    if (rec.approval && this.agents.get(rec.agentId)?.allowRuntimeChangesInChat !== true) {
      if (rec.ts) {
        void rec.conn
          .updateBlocks(
            rec.channel,
            rec.ts,
            buildElicitationResolvedCard(rec.params, ':lock: Ask an Agent editor to allow it'),
            'Permission requires an Agent editor',
            true
          )
          .catch(() => {})
      }
      return
    }
    let res: CreateElicitationResponse
    let decision: string
    if (a.value === null) {
      res = { action: 'decline' }
      decision = ':no_entry_sign: Dismissed'
    } else {
      const value = rec.kind === 'boolean' ? a.value === 'true' : a.value
      res = { action: 'accept', content: { [rec.propName]: value } }
      decision = `:white_check_mark: ${rec.kind === 'boolean' ? (value ? 'Yes' : 'No') : a.value}`
    }
    if (rec.approval) {
      if (!this.resolveStoredPermissionRequest(rec.agentId, a.requestId, a.value === null ? 'denied' : 'allowed'))
        return
    }
    this.pendingElicits.delete(a.requestId)
    if (rec.ts)
      void rec.conn
        .updateBlocks(rec.channel, rec.ts, buildElicitationResolvedCard(rec.params, decision), 'Input received', true)
        .catch(() => {})
    rec.resolve(res)
  }

  /** Resolve every outstanding elicitation for a session as `cancel` — ACP's cancellation
   *  contract, and it unblocks a turn whose card the user abandoned. */
  private releaseElicits(agentId: string, sessionId: string): void {
    for (const [id, rec] of this.pendingElicits) {
      if (rec.agentId !== agentId || rec.sessionId !== sessionId) continue
      this.pendingElicits.delete(id)
      if (rec.approval) this.resolveStoredPermissionRequest(agentId, id, 'expired')
      if (rec.ts)
        void rec.conn
          .updateBlocks(
            rec.channel,
            rec.ts,
            buildElicitationResolvedCard(rec.params, ':hourglass: Cancelled'),
            'Cancelled',
            true
          )
          .catch(() => {})
      rec.resolve({ action: 'cancel' })
    }
  }

  /** Emit the daemon's latest merged usage snapshot. Used both at normal turn end
   *  and when a late ACP usage_update corrects an already-reported fallback. */
  private emitStoredUsageReport(
    sessionId: string,
    agentId: string,
    platform: string,
    channel: string,
    key: string,
    late = false
  ): void {
    const usage = this.store.getUsage(key)
    if (Object.keys(usage).length === 0) return
    try {
      this.cpClient?.emitUsageReport({
        sessionId,
        agentId,
        platform,
        channel,
        lastActivityAt: new Date(this.clock.now()).toISOString(),
        usage
      })
    } catch (err) {
      this.log.debug(`${late ? 'late ' : ''}usage report emit failed (session ${sessionId}): ${(err as Error).message}`)
    }
  }

  private bufferEarlySessionMetadata(
    agentId: string,
    sessionId: string,
    update: { sessionUpdate: string; [key: string]: any }
  ): boolean {
    if ((this.sessionInitializationsByAgent.get(agentId) ?? 0) === 0) return false
    const key = pendingTurnKey(agentId, sessionId)
    const entry = this.earlySessionMetadata.get(key) ?? { agentId, sessionId, updates: [] }
    const previous = entry.updates.findIndex((candidate) => candidate.sessionUpdate === update.sessionUpdate)
    if (previous >= 0) entry.updates[previous] = update
    else entry.updates.push(update)
    this.earlySessionMetadata.set(key, entry)
    return true
  }

  /** Complete one SessionManager initialization and replay any metadata the ACP
   *  adapter emitted before its local session row existed. Leftover unknown ids
   *  are discarded once the agent has no other initialization in flight. */
  private finishSessionInitialization(agentId: string, sessionId?: string): void {
    if (sessionId) {
      const key = pendingTurnKey(agentId, sessionId)
      const entry = this.earlySessionMetadata.get(key)
      this.earlySessionMetadata.delete(key)
      if (entry) for (const update of entry.updates) this.onAcpUpdate(agentId, sessionId, update)
    }
    const remaining = Math.max(0, (this.sessionInitializationsByAgent.get(agentId) ?? 1) - 1)
    if (remaining > 0) {
      this.sessionInitializationsByAgent.set(agentId, remaining)
      return
    }
    this.sessionInitializationsByAgent.delete(agentId)
    for (const [key, entry] of this.earlySessionMetadata) {
      if (entry.agentId === agentId) this.earlySessionMetadata.delete(key)
    }
  }

  /** Persist one authoritative title and push the CP metadata projection. */
  private persistSessionTitle(rec: SessionRecord, title: string | null): void {
    this.store.setSessionTitle(rec.key, title)
    if (!rec.acpSessionId) return
    this.emitSessionMetadataSnapshot({
      sessionId: rec.acpSessionId,
      agentId: rec.agentId,
      phase: 'plan',
      platform: rec.platform as SessionKey['platform'],
      channel: rec.channel,
      thread: rec.thread
    })
  }

  /** Rename a Slack app-DM through the exact integration that delivered this
   *  session. The connection lease prevents reconcile from closing it mid-call. */
  private async setSlackTitleForBinding(
    rec: SessionRecord,
    binding: SessionDeliveryBinding,
    title: string
  ): Promise<void> {
    if (
      binding.agentId !== rec.agentId ||
      binding.platform !== 'slack' ||
      rec.platform !== 'slack' ||
      !binding.isDm ||
      !binding.integrationId ||
      !title
    )
      return
    const conn = this.connByIntegration.get(binding.integrationId)
    if (!conn) return
    const release = this.holdReplyConnection(conn)
    try {
      await conn.setTitle(rec.channel, rec.thread, title)
    } catch (err) {
      // SlackConnection.setTitle is already failure-degrading; keep this boundary
      // defensive for test doubles and future gateway implementations.
      this.log.debug(`session title: Slack update failed (${formatErr(err)})`)
    } finally {
      release()
    }
  }

  /** MCP callback for the legacy model-authored title fallback. New sessions no
   *  longer receive the tool (codex-acp >= 1.1.3 emits native titles — issue #659),
   *  but warm ACP sessions created under the old Codex whitelist retain it for
   *  their lifetime. The tool input contains only the title; every coordinate and
   *  delivery route was captured in the trusted SessionContext. */
  private async setSessionTitleFromTool(req: SetSessionTitleReq): Promise<void> {
    const key = sessionKey(req.platform, req.channel, req.thread, req.agentId, req.transportScope)
    const rec = this.store.getSession(key)
    if (!rec?.acpSessionId) throw new Error('the current session is not addressable yet')

    // MCP tokens are session-static, while an integration can rotate between warm
    // turns. Prefer the exact route installed by the current dispatch; use the token
    // binding only as a defensive fallback for non-dispatch callers.
    const binding: SessionDeliveryBinding = this.sessionDeliveryBindings.get(key) ?? {
      agentId: req.agentId,
      platform: req.platform,
      ...(req.integrationId !== undefined ? { integrationId: req.integrationId } : {}),
      isDm: req.isDm
    }
    this.persistSessionTitle(rec, req.title)

    const p = this.pending.get(pendingTurnKey(rec.agentId, rec.acpSessionId))
    if (p && p.sessionKey === key && !p.outputSuppressed) {
      if (p.webchat) {
        this.emitWebchatUpdate(p, { sessionUpdate: 'session_info_update', title: req.title })
      }
      if (p.platform === 'slack' && p.isDm && p.conn) {
        this.enqueueApply(p, { kind: 'set-title', text: req.title })
        await p.applyChain
        return
      }
    }
    await this.setSlackTitleForBinding(rec, binding, req.title)
  }

  private onAcpUpdate(agentId: string, sessionId: string, update: any): void {
    // Write-only secret values (agent runtimeOverrides.secrets) are masked out of the
    // update BEFORE any consumer sees it — memory extraction, the reply accumulator,
    // the GitHub collector, the webchat stream, the platform converger, and the
    // transcript recorder (tool rawInput/rawOutput included) all hang off this entry
    // point, so this one transform keeps a leaked value out of every surface at once.
    update = this.maskAgentSecrets(agentId, update)
    const extractionKey = pendingTurnKey(agentId, sessionId)
    const extraction = this.memoryExtractionCollectors.get(extractionKey)
    if (extraction) {
      if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        extraction.chunks.push(String(update.content.text ?? ''))
      }
      if (extraction.transcript) {
        const { channel, thread, recorder } = extraction.transcript
        for (const ev of recorder.onUpdate(update)) {
          this.recordEvent(agentId, channel, thread, ev)
        }
      }
      // Distillation uses an unlisted cached extractor and therefore has neither
      // sessionKey nor transcript. A Dream has both: retain native usage and the
      // ordinary raw activity timeline while keeping extraction output out of
      // platform delivery and evaluation telemetry.
      if (update?.sessionUpdate === 'usage_update' && extraction.sessionKey) {
        if (update.cost?.amount !== undefined) extraction.runtimeCostReported = true
        this.store.setUsageSnapshot(extraction.sessionKey, {
          contextUsed: update.used,
          contextSize: update.size,
          costAmount: update.cost?.amount ?? undefined,
          costCurrency: update.cost?.currency ?? undefined
        })
      }
      return
    }
    // A runtime can keep streaming after a Dream collector is released. Body-bearing
    // updates no longer have a trustworthy transcript owner and stay quarantined,
    // but a late usage snapshot is safe metadata and must still correct the
    // session's latest-wins accounting.
    const extractionQuarantineOwner = this.memoryExtractionQuarantines.get(extractionKey)
    if (extractionQuarantineOwner) {
      if (extractionQuarantineOwner === agentId && update?.sessionUpdate === 'usage_update') {
        const rec = this.store.getSessionByAcpIdForAgent(agentId, sessionId)
        if (rec?.platform === 'dream') {
          this.store.setUsageSnapshot(rec.key, {
            contextUsed: update.used,
            contextSize: update.size,
            costAmount: update.cost?.amount ?? undefined,
            costCurrency: update.cost?.currency ?? undefined
          })
          this.emitStoredUsageReport(sessionId, agentId, rec.platform, rec.channel, rec.key, true)
        }
      }
      return
    }
    const p = this.pending.get(pendingTurnKey(agentId, sessionId))
    this.emitEvaluation({
      type: 'acp.update',
      agentId,
      sessionId,
      ...(p?.evaluationTurnId ? { turnId: p.evaluationTurnId } : {}),
      ...(p?.platform ? { platform: p.platform } : {}),
      ...(p?.channel ? { channel: p.channel } : {}),
      data: { update }
    })
    if (p?.outputSuppressed) return
    // codex-acp >= 1.1.3 auto-titles an untitled session from its raw prompt text
    // (all first-prompt text blocks joined, unbounded). For runtimes that carry the
    // standing context inline as the first prompt block, that "title" is an echo of
    // internal agent/memory context — drop the whole update before it is buffered,
    // persisted, streamed to webchat, or recorded (issue #659). Real titles (a user
    // rename, a semantic runtime summary) do not start with the agent-meta block.
    if (
      update?.sessionUpdate === 'session_info_update' &&
      typeof update.title === 'string' &&
      isStandingContextTitleEcho(update.title)
    )
      return
    const isEarlyMetadata =
      update?.sessionUpdate === 'usage_update' ||
      (update?.sessionUpdate === 'session_info_update' && update.title !== undefined)
    const detachedRec = !p && isEarlyMetadata ? this.store.getSessionByAcpIdForAgent(agentId, sessionId) : undefined
    if (!p && isEarlyMetadata && !detachedRec && this.bufferEarlySessionMetadata(agentId, sessionId, update)) return
    // Context-window + cost snapshot (latest-wins). Captured for telemetry only;
    // it's dropped from the channel by the renderer. Handle it even after a turn
    // leaves `pending`: a late native cost must replace any fallback we just
    // reported, rather than being silently lost.
    if (update?.sessionUpdate === 'usage_update') {
      const rec = p ? undefined : detachedRec
      const key = p?.sessionKey ?? rec?.key
      if (key) {
        if (p && update.cost?.amount !== undefined) p.runtimeCostReported = true
        this.store.setUsageSnapshot(key, {
          contextUsed: update.used,
          contextSize: update.size,
          costAmount: update.cost?.amount ?? undefined,
          costCurrency: update.cost?.currency ?? undefined
        })
        if (p) {
          // Live context/cost changed — refresh the status bar (deduped if nothing observable
          // moved). Token totals aren't in this stream; they fold in at turn end.
          this.emitStatusBar(p)
          // prompt() may already have returned and emitted the normal CP report while
          // output is still draining. In that window Pending still exists, so send a
          // latest-wins correction instead of waiting for another turn.
          if (p.usageReportSent) {
            this.emitStoredUsageReport(sessionId, p.agentId, p.platform, p.channel, key, true)
          }
        } else if (rec) {
          // The normal report happens at turn end. A notification after that point
          // needs its own correction so the CP's latest-wins row converges too.
          this.emitStoredUsageReport(sessionId, rec.agentId, rec.platform, rec.channel, key, true)
        }
      }
    }
    // Session title pushed by the runtime (e.g. Claude's auto-generated summary or
    // a user `/rename`). Handle it even after the turn has left `pending`: external
    // renames and some adapters can notify out of turn. ACP semantics: string ⇒ set,
    // null ⇒ clear, absent ⇒ no change.
    if (update?.sessionUpdate === 'session_info_update' && update.title !== undefined) {
      const rec = p ? this.store.getSession(p.sessionKey) : detachedRec
      // The callback is agent-bound, but ACP session ids are runtime-controlled. Match
      // both before touching another logical session if two adapters reuse an id.
      if (rec?.agentId === agentId && rec.acpSessionId === sessionId) {
        this.persistSessionTitle(rec, update.title)
        // Slack's Agents feature renders native titles only for app-DM threads. Reuse
        // the runtime's title verbatim (apart from surrounding whitespace); do not
        // invent one from the first-message fallback used by the console session list.
        const slackTitle = typeof update.title === 'string' ? update.title.trim() : ''
        if (p?.platform === 'slack' && p.isDm && slackTitle) {
          this.enqueueApply(p, { kind: 'set-title', text: slackTitle })
        } else if (!p && slackTitle) {
          const binding = this.sessionDeliveryBindings.get(rec.key)
          if (binding) void this.setSlackTitleForBinding(rec, binding, slackTitle)
        }
      }
    }
    if (!p) return
    if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      p.replyText += String(update.content.text ?? '')
    }
    // `setSessionTitle` is daemon housekeeping, not conversational activity. Codex
    // ACP reports it as an ordinary MCP tool_call, followed by title-less updates
    // keyed only by toolCallId. Remember the id from the structured first event and
    // drop the whole burst before any platform renderer, live webchat stream, GitHub
    // collector, or persisted transcript sees it. The tool callback independently
    // persists and streams the resulting session_info_update.
    const toolCallId = typeof update?.toolCallId === 'string' ? update.toolCallId : ''
    if (toolCallId && isBuiltinSystemToolCall(update)) p.builtinSystemToolCallIds.add(toolCallId)
    if (isSessionTitleToolCall(update)) {
      if (toolCallId) p.hiddenSessionTitleToolCallIds.add(toolCallId)
      return
    }
    if (toolCallId && p.hiddenSessionTitleToolCallIds.has(toolCallId)) return
    // Select the complete GitHub final in memory. Do not write any GitHub comment here:
    // the prompt (and every agent-side tool call) must finish before publish() performs
    // the first and only public POST.
    const isHeadlessGithubFinal =
      p.github !== undefined &&
      p.platform === 'hook' &&
      update?.sessionUpdate === 'agent_message_chunk' &&
      update?._meta?.codex?.phase === 'final_answer'
    if (p.github) {
      p.github.collector.onUpdate(update)
      if (isHeadlessGithubFinal) p.github.deferredFinalTranscript = true
    }
    // webchat streams its reply through the sink (→ relay `rd/chat`), one WebchatOutput
    // per mapped chunk, instead of driving the Slack renderer — but still records the
    // full activity log below, so a webchat session reads back like any other.
    if (p.webchat) this.emitWebchatUpdate(p, update)
    else if (!isHeadlessGithubFinal) {
      for (const action of p.conv.onUpdate(update)) this.enqueueApply(p, action)
      this.armIdle(p)
      this.armFeishuStream(p)
    }
    // Full activity log (tool/reasoning), recorded regardless of output mode.
    for (const ev of p.rec.onUpdate(update)) this.recordEvent(p.agentId, p.transcriptChannel, p.statusThread, ev)
  }

  /**
   * Map one ACP SessionUpdate to a WebchatEvent and stream it through the sink (→ relay
   * `rd/chat`, webchat's "send"). Only the streamable chunk kinds map; usage/plan/
   * session_info are handled elsewhere or dropped. A single event whose inline text would
   * blow the 256 KiB frame cap is split across multiple chunks, each with its own `index`.
   */
  private emitWebchatUpdate(p: Pending, update: any): void {
    const wc = p.webchat!
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
          for (const t of chunkText(text)) emit({ kind: 'message', text: t })
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
      case 'tool_call_update':
        emit({
          kind: 'tool_update',
          toolCallId: String(update.toolCallId ?? ''),
          status: String(update.status ?? '')
        })
        return
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
      default:
        return // plan/usage/etc. are not part of the webchat reply stream
    }
  }

  /** Persist one internal activity event (tool/reasoning). Ordered by row `seq`, so its
   *  `ts` is just a wall-clock stamp for display — never used for replay/sorting. */
  private recordEvent(agentId: string, channel: string, thread: string, ev: TranscriptEvent): void {
    if (ev.kind === 'tool') {
      if (ev.op === 'insert') {
        this.store.insertToolCall({
          channel,
          thread,
          ts: String(Date.now()),
          sender: agentId,
          toolCallId: ev.toolCallId,
          title: ev.text,
          body: ev.body
        })
      } else {
        this.store.updateToolCall(channel, thread, agentId, ev.toolCallId, { title: ev.text, body: ev.body })
      }
      return
    }
    this.store.appendTranscript({
      channel,
      thread,
      ts: String(Date.now()),
      sender: agentId,
      kind: ev.kind,
      text: ev.text
    })
  }

  private invalidateHostStart(agentId: string): void {
    this.hostStartGeneration.set(agentId, (this.hostStartGeneration.get(agentId) ?? 0) + 1)
    this.hostStarts.delete(agentId)
    this.hostStartAborts.get(agentId)?.abort(new Error(`host start superseded for ${agentId}`))
    this.hostStartAborts.delete(agentId)
  }

  private async ensureHostAsync(agentId: string, opts: { allowAgentDrain?: boolean } = {}): Promise<AcpHost> {
    const assertStartAllowed = (): void => {
      if (this.draining) throw new Error(`host start blocked while daemon is draining (${agentId})`)
      if (this.workspaceFileWrites.has(agentId)) {
        throw new Error(`host start blocked while a workspace file is being written (${agentId})`)
      }
      // Already-admitted work in another logical session may keep using the warm
      // host while a conversation-scoped interrupt drains. It may not allocate a
      // replacement after that host/start generation has been evicted.
      if (this.safetyDrainingAgents.has(agentId) && !this.hostStarts.has(agentId)) {
        throw new Error(`host start blocked while interrupted turns are stopping (${agentId})`)
      }
      if (!opts.allowAgentDrain && this.drainingAgents.has(agentId)) {
        throw new Error(`host start blocked while agent is draining (${agentId})`)
      }
    }
    // The ordinary dispatch gates are the primary admission boundary; repeat them at
    // the lifecycle resource boundary so an already-admitted cold turn cannot spawn a
    // replacement child after reconcile/stop has begun.
    assertStartAllowed()
    // If this agent's previous host is mid-teardown, wait it out before (re)spawning
    // — otherwise we'd boot a second child while the first is still SIGTERM-ing.
    const stopping = this.hostStopping.get(agentId)
    if (stopping) {
      await stopping
      // A reconcile gate may have been installed while this call waited. Re-check at
      // the exact promise boundary before allocating a new start generation.
      assertStartAllowed()
    }
    let p = this.hostStarts.get(agentId)
    if (!p) {
      const generation = (this.hostStartGeneration.get(agentId) ?? 0) + 1
      this.hostStartGeneration.set(agentId, generation)
      const startAbort = new AbortController()
      this.hostStartAborts.set(agentId, startAbort)
      p = this.startHostWithRetry(agentId, generation, startAbort.signal)
      this.hostStarts.set(agentId, p)
      // A total failure (all attempts exhausted) must NOT poison the cache: without
      // this the rejected promise stays memoized and every later message re-awaits the
      // same rejection, so the agent could never recover. startHostWithRetry already
      // reaped every failed child, so just drop the rejected entry (guarding on
      // identity in case a concurrent stopHost already replaced it).
      void p.then(
        () => {
          if (this.hostStartAborts.get(agentId) === startAbort) this.hostStartAborts.delete(agentId)
        },
        () => {
          if (this.hostStarts.get(agentId) === p) this.hostStarts.delete(agentId)
          if (this.hostStartAborts.get(agentId) === startAbort) this.hostStartAborts.delete(agentId)
        }
      )
    }
    return await p
  }

  /** Launch an agent's ACP host — spawn + the `initialize` handshake — retrying a
   *  failed start up to `agentStartAttempts` times with a fixed backoff. Each attempt
   *  builds a FRESH host; a failed start()'s half-spawned child is reaped before the
   *  next try. On success the started host is left memoized in `this.hosts`; when every
   *  attempt fails the last error is thrown (dispatch surfaces it to the session). */
  private async startHostWithRetry(agentId: string, generation: number, signal: AbortSignal): Promise<AcpHost> {
    const attempts = Math.max(1, this.cfg.limits.agentStartAttempts)
    if (this.hostStartGeneration.get(agentId) !== generation) throw new Error(`host start superseded for ${agentId}`)
    let lastErr: unknown
    for (let i = 1; i <= attempts; i++) {
      if (this.hostStartGeneration.get(agentId) !== generation) {
        throw new Error(`host start superseded for ${agentId}`)
      }
      const host = this.ensureHost(agentId, this.cfg) // constructs + memoizes into this.hosts
      try {
        await host.start()
        if (this.hostStartGeneration.get(agentId) !== generation) {
          throw new Error(`host start superseded for ${agentId}`)
        }
        return host
      } catch (err) {
        lastErr = err
        // Reap the dead child and drop it so the next attempt spawns a fresh one.
        if (this.hosts.get(agentId) === host) this.hosts.delete(agentId)
        await host.stop().catch(() => {})
        if (this.hostStartGeneration.get(agentId) !== generation) throw err
        // The failed attempt's ensureHost already materialized the config-file
        // secrets — remove them so a permanently-failing start doesn't leave them
        // resting on disk. Generation-fenced above, so this can't touch a
        // superseding host's files; the next attempt re-materializes its own.
        const failedSpawnDir = this.hostConfigFiles.get(agentId)?.agentDir
        this.hostConfigFiles.delete(agentId)
        if (failedSpawnDir) {
          const cleanupErr = cleanupConfigFiles(failedSpawnDir)
          if (cleanupErr) this.log.warn(`config-files: cleanup for agent "${agentId}" failed — ${cleanupErr}`)
        }
        if (i < attempts) {
          const backoff = this.cfg.limits.agentStartBackoffMs
          this.log.warn(
            `acp: agent "${agentId}" start attempt ${i}/${attempts} failed (${(err as Error).message}) — retrying in ${backoff}ms`
          )
          await this.sleep(backoff, signal)
        } else {
          this.log.error(`acp: agent "${agentId}" failed to start after ${attempts} attempt(s): ${formatErr(err)}`)
        }
      }
    }
    throw lastErr
  }

  /** Clock-driven delay (so a FakeClock stays deterministic in tests). */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    const delay = Math.min(Math.max(0, ms), 2_147_483_647)
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve()
        return
      }
      const timer = this.clock.setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, delay)
      const onAbort = () => {
        this.clock.clearTimeout(timer)
        resolve()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  // ── Conversation gating (resource-visibility.md §14) ────────────────────────

  /** One-time gating-notice latch, `${integrationId}:${channel}` — per daemon
   *  lifetime (§14.7 open question 2: a restart re-notices, which is acceptable). */
  private readonly gatedNoticesSent = new Set<string>()

  /** agentId → the CP launch correlation awaiting the next session this agent
   *  creates (session-visibility.md §4.4). `agent/launch` only warm-starts a
   *  host — the session arrives later, from the daemon's own ingress — so the
   *  provenance has to be parked here and consumed once. */
  private readonly pendingLaunchCorrelation = new Map<string, string>()

  /** The integration config backing `integrationId`, across all local agents. */
  private integrationConfigById(integrationId: string): Integration | undefined {
    for (const a of this.agents.values()) {
      const int = a.integrations?.find((i) => i.id === integrationId)
      if (int) return int
    }
    return undefined
  }

  /** Stable opaque identity for one physical platform connection. Integrations
   * consolidated onto the same credential receive the same scope, while no raw
   * credential is ever persisted or logged. */
  private transportScopeForIntegration(integration: Integration): string {
    let connectionIdentity: string
    switch (integration.platform) {
      case 'slack':
        connectionIdentity =
          integration.slack.mode === 'shared'
            ? integration.slack.botToken
            : (integration.slack.appToken ?? integration.slack.botToken)
        break
      case 'telegram': {
        // BotFather tokens start with the stable public bot id, which survives a
        // secret rotation. Non-standard test/config tokens fall back to the full
        // high-entropy credential before hashing.
        const botId = integration.telegram.botToken.split(':', 1)[0]
        connectionIdentity = /^\d+$/.test(botId ?? '') ? botId! : integration.telegram.botToken
        break
      }
      case 'discord':
        connectionIdentity = integration.discord.botToken
        break
      case 'feishu':
        connectionIdentity = `${integration.feishu.region}:${integration.feishu.appId}`
        break
    }
    const digest = createHash('sha256')
      .update(`${integration.platform}\0${connectionIdentity}`)
      .digest('hex')
      .slice(0, 24)
    return `${integration.platform}:${digest}`
  }

  /**
   * The DURABLE tenant scope for an integration (session-visibility.md §2) — the
   * middle segment of an IM owner identity `<platform>:<scope>:<uid>`.
   *
   * Deliberately NOT `transportScopeForIntegration`: that one hashes the live
   * credential, so it rotates with tokens and would orphan every historical
   * identity match. This returns a value that survives rotation — the platform's
   * own tenant id where one exists, otherwise a scope minted once per
   * integration and persisted. Undefined ⇒ the CP records no owner (fail closed),
   * never a guessed one.
   */
  private tenantScopeForIntegration(integration: Integration): string | undefined {
    switch (integration.platform) {
      case 'slack': {
        // The workspace id from auth.test, surfaced by the live connection.
        // Optional-call: the connection map holds live SlackConnections in
        // production, but a not-yet-authenticated (or test-substituted) one may
        // not expose the accessor — fall back to a minted scope rather than throw.
        const teamId = this.connByIntegration.get(integration.id)?.workspaceId?.()
        return teamId || this.mintedTenantScope(integration.id)
      }
      case 'telegram': {
        // The public bot id prefix survives a BotFather token rotation.
        const botId = integration.telegram.botToken.split(':', 1)[0]
        return /^\d+$/.test(botId ?? '') ? `bot${botId}` : this.mintedTenantScope(integration.id)
      }
      case 'feishu':
        // App id + region is the tenant anchor Feishu/Lark exposes to us.
        return `${integration.feishu.region}:${integration.feishu.appId}`
      default:
        // Discord (and anything new) exposes no durable tenant id here.
        return this.mintedTenantScope(integration.id)
    }
  }

  /**
   * Seed a new session's visibility facts and its local capture gate (§4.1/§5.1).
   *
   * The gate's first layer is what the daemon can decide alone, with no CP
   * round-trip. It is deliberately conservative: an A2A child ALWAYS starts
   * excluded regardless of any hint it carried, because a delegated prompt may
   * be copied from a private parent and only a CP-confirmed `org` state may open
   * capture. Everything else the CP later confirms or overrides.
   */
  private classifyNewSession(
    agentId: string,
    key: string,
    acpSessionId: string,
    msg: NormalizedMessage,
    isA2aChild: boolean,
    isEvaluation = false
  ): void {
    try {
      this.classifyNewSessionOrThrow(agentId, key, acpSessionId, msg, isA2aChild, isEvaluation)
    } catch (err) {
      // Never let classification break a turn — but fail CLOSED: an unclassified
      // session keeps memory capture excluded until the CP confirms otherwise.
      this.log.warn(`session visibility: classification failed for ${acpSessionId} (${formatErr(err)})`)
      this.store.setLocalCaptureGate(acpSessionId, true)
    }
  }

  private classifyNewSessionOrThrow(
    agentId: string,
    key: string,
    acpSessionId: string,
    msg: NormalizedMessage,
    isA2aChild: boolean,
    isEvaluation: boolean
  ): void {
    const conversationKind = msg.isDm ? 'dm' : msg.isGroupDm ? 'group_dm' : 'channel'
    const integrationId =
      msg.platform === 'webchat'
        ? undefined
        : this.integrationIdForTransportScope(agentId, msg.platform, msg.transportScope)
    const integration = integrationId ? this.integrationConfigById(integrationId) : undefined
    const tenantScope = integration ? this.tenantScopeForIntegration(integration) : undefined
    const launchCorrelationId = this.pendingLaunchCorrelation.get(agentId)
    if (launchCorrelationId) this.pendingLaunchCorrelation.delete(agentId)
    this.store.setSessionClassification(key, {
      conversationKind,
      ...(tenantScope ? { tenantScope } : {}),
      ...(launchCorrelationId ? { launchCorrelationId } : {})
    })
    const locallyPrivate =
      !isEvaluation && (isA2aChild || msg.isDm || msg.platform === 'webchat' || launchCorrelationId !== undefined)
    this.store.setLocalCaptureGate(acpSessionId, locallyPrivate)
  }

  /** The ACP session id behind an MCP tool call, from the caller's trusted
   *  session coords. Undefined when no local row matches — the capture gate
   *  treats that as unknown, i.e. excluded. */
  private acpSessionIdForToolCall(ctx: {
    agentId: string
    platform: string
    channel: string
    thread: string
    transportScope?: string
  }): string | undefined {
    const key = sessionKey(ctx.platform, ctx.channel, ctx.thread, ctx.agentId, ctx.transportScope)
    return this.store.getSession(key)?.acpSessionId ?? undefined
  }

  /** Mint-once, persisted: stable across restarts and credential rotations. */
  private mintedTenantScope(integrationId: string): string {
    return (
      this.store.getMintedTenantScope(integrationId) ??
      this.store.mintTenantScope(integrationId, `mint:${randomUUID().replace(/-/g, '').slice(0, 24)}`)
    )
  }

  /** Source integrations on one live ingress share a physical connection. The
   * combined fallback stays fail-closed if malformed config ever violates that. */
  private transportScopeForIntegrationIds(integrationIds?: readonly string[]): string | undefined {
    if (!integrationIds?.length) return undefined
    const scopes = [
      ...new Set(
        integrationIds
          .map((id) => this.integrationConfigById(id))
          .filter((integration): integration is Integration => integration !== undefined)
          .map((integration) => this.transportScopeForIntegration(integration))
      )
    ].sort()
    if (scopes.length === 0) return undefined
    if (scopes.length === 1) return scopes[0]
    return `mixed:${createHash('sha256').update(scopes.join('\0')).digest('hex').slice(0, 24)}`
  }

  /** Resolve the live integration that owns a persisted bot-scoped session. */
  private integrationIdForTransportScope(
    agentId: string,
    platform: string,
    transportScope?: string | null
  ): string | undefined {
    const candidates = this.agents.get(agentId)?.integrations.filter((integration) => integration.platform === platform)
    if (!candidates?.length) return undefined
    if (!transportScope) return candidates[0]?.id
    return candidates.find((integration) => this.transportScopeForIntegration(integration) === transportScope)?.id
  }

  /** Every integrationId served by `conn` — ingress attribution for gating. A Slack
   *  socket is per app token and may fan out to several integrations. */
  private srcIntegrationIds(conn: unknown): string[] {
    const out: string[] = []
    for (const [id, c] of this.connByIntegration) if (c === conn) out.push(id)
    for (const [id, c] of this.tgConnByIntegration) if (c === conn) out.push(id)
    for (const [id, c] of this.dcConnByIntegration) if (c === conn) out.push(id)
    for (const [id, c] of this.fsConnByIntegration) if (c === conn) out.push(id)
    return out
  }

  /** Direct platform ingress is owned by one physical bot connection. Rules from
   *  another bot on the same platform must never arbitrate that message. Undefined
   *  preserves internal/test callers with no connection attribution; an empty live
   *  source fails closed during the tiny connect→binding window. */
  private integrationBelongsToSource(integrationId: string, srcIntegrationIds?: readonly string[]): boolean {
    return srcIntegrationIds === undefined || srcIntegrationIds.includes(integrationId)
  }

  private mergedRulesForSource(srcIntegrationIds?: readonly string[]): RoutingRule[] {
    return this.mergedRules().filter((rule) => this.integrationBelongsToSource(rule.integrationId, srcIntegrationIds))
  }

  /** Last-hop admission for a pre-addressed (relay) message. The relay arbitrated it,
   *  but its routing snapshot can lag a console edit, so the shipped spec decides
   *  again: an Off channel and (§14) an unenabled conversation of a gated integration
   *  are both refused here rather than trusted to the relay. */
  private gatedAdmission(integrationId: string, msg: NormalizedMessage): boolean {
    const int = this.integrationConfigById(integrationId)
    if (!int) return true // unknown here — agent/integration existence is checked separately
    return conversationAdmitted(integrationRouting(int), msg.channel, msg.parentChannel)
  }

  /**
   * §14: an explicitly-addressed message (a mention of a gated integration's bot, or
   * a DM to it) that routed nowhere gets a ONE-TIME per-conversation notice — the
   * bot must never look silently broken — and the Off conversation is reported to
   * the CP so the console can offer enabling it. Bot senders are never noticed.
   */
  /** §14.3 pending-conversation discovery, report-only: fan an Off DM across every
   *  gated source integration, and report an Off channel when the message explicitly
   *  mentions that integration's bot. This runs before commands/routing so discovery
   *  is independent of which sibling integration ultimately handles the message. */
  private discoverGatedConversations(msg: NormalizedMessage, srcIntegrationIds: string[]): void {
    if (msg.sender.isBot || msg.source !== 'user') return
    const isDm = msg.isDm || (msg.platform === 'slack' && msg.channel.startsWith('D'))
    for (const integrationId of srcIntegrationIds) {
      const int = this.integrationConfigById(integrationId)
      if (!int || int.platform !== msg.platform) continue
      const routing = integrationRouting(int)
      if (!routing.gated) continue
      // Enabled — including a thread of an enabled channel (the rule is scoped to the
      // enclosing channel, which is what the console offers).
      if (routing.bindRules.some((r) => r.channel === msg.channel || r.channel === msg.parentChannel)) continue
      const botUserId = this.botUserIds[integrationId] ?? routing.staticBotUserId ?? ''
      if (!isDm && (botUserId === '' || !msg.mentionedBots.includes(botUserId))) continue
      this.reportGatedConversation(integrationId, msg, isDm)
    }
  }

  private maybeGatedNotice(msg: NormalizedMessage, srcIntegrationIds: string[]): void {
    if (msg.sender.isBot || msg.source !== 'user') return
    // Slack `app_mention` payloads may omit channel_type, so hedge on the D-prefix.
    const isDm = msg.isDm || (msg.platform === 'slack' && msg.channel.startsWith('D'))
    for (const integrationId of srcIntegrationIds) {
      const int = this.integrationConfigById(integrationId)
      if (!int || int.platform !== msg.platform) continue
      const routing = integrationRouting(int)
      if (!routing.gated) continue
      // An ENABLED conversation never gets a report/notice — this guard makes the
      // helper safe from the pre-command call site, which sees every DM. A thread of an
      // enabled channel is enabled too (the rule is scoped to the enclosing channel).
      if (routing.bindRules.some((r) => r.channel === msg.channel || r.channel === msg.parentChannel)) continue
      const botUserId = this.botUserIds[integrationId] ?? routing.staticBotUserId ?? ''
      const addressed = isDm || (botUserId !== '' && msg.mentionedBots.includes(botUserId))
      if (!addressed) continue
      if (isDm) this.reportGatedConversation(integrationId, msg, true)
      const latch = `${integrationId}:${msg.channel}`
      if (this.gatedNoticesSent.has(latch)) return
      this.gatedNoticesSent.add(latch)
      const conn = this.connForIntegration(integrationId)
      if (!conn) return
      const text =
        '🔒 This agent isn’t enabled in this conversation. Ask an admin to enable it in the AgentConnect console.'
      const thread = isDm ? undefined : msg.thread
      // Chrome-marked so peer daemons' thread backfill never re-ingests the notice.
      const post =
        conn instanceof SlackConnection
          ? conn.postMessage(msg.channel, text, thread, { chrome: true })
          : conn.postChrome(msg.channel, text, { threadTs: thread })
      void post.catch((err: unknown) =>
        this.log.warn(`gating: notice post failed in ch=${msg.channel}: ${(err as Error).message}`)
      )
      return // one notice per message even when several integrations share the socket
    }
  }

  /** §14.3: surface an explicitly-addressed Off conversation as a pending row so
   *  the console can enable it. This is an observed/incremental report, not a full
   *  membership snapshot: Telegram cannot enumerate all chats, and the conversation
   *  deliberately creates no session while Off.
   *
   *  Name resolution is best-effort. Telegram/Discord getChat results land through
   *  refreshObservedChannels; Slack DMs retain the existing profile fallback below. */
  private reportGatedConversation(integrationId: string, msg: NormalizedMessage, isDm: boolean): void {
    const cached = this.channelSnapshots.get(integrationId)
    const existing = cached?.channels ?? []
    // A channel row is reported as the ENCLOSING channel when the message arrived in a
    // thread: that is the conversation an operator enables, and the one observed
    // discovery reports (a per-thread row would be a duplicate of it).
    const channel = (!isDm && msg.parentChannel) || msg.channel
    const current = existing.find((c) => c.id === channel)
    // A group DM is neither: reported on observation like a DM, mention-gated like a
    // channel. `app_mention` payloads carry no channel_type, so a row already resolved
    // to 'mpim' must never be downgraded back to 'channel' by a later mention —
    // otherwise the two classifications would fight and re-emit on every message.
    const observed = isDm ? ('im' as const) : msg.isGroupDm ? ('mpim' as const) : ('channel' as const)
    const kind = observed === 'channel' && current?.kind === 'mpim' ? ('mpim' as const) : observed
    const known = this.store.getDisplayNames([channel]).get(channel)
    // Which Discord server the channel belongs to — see spaceFor. Direct rows have none.
    const found = kind === 'channel' && msg.platform === 'discord' ? this.spaceFor(channel) : undefined
    const space = found ? { spaceId: found.id, ...(found.name ? { space: found.name } : {}) } : undefined
    // Compare against what a write would actually change — a partially resolved space
    // (id known, name not yet) must not re-emit the snapshot on every message.
    const merged = current ? { ...current, ...(known ? { name: known } : {}), ...space, kind } : undefined
    if (merged && JSON.stringify(merged) === JSON.stringify(current)) return
    // A previously-observed DM (Telegram/Discord session snapshots are kind-less)
    // is upgraded to 'im' rather than skipped after an org→restricted flip.
    const next = merged
      ? existing.map((c) => (c.id === channel ? merged : c))
      : [...existing, { id: channel, ...(known ? { name: known } : {}), ...space, kind }]
    this.channelSnapshots.set(integrationId, {
      channels: next,
      authoritative: cached?.authoritative ?? false
    })
    this.cpClient?.emitIntegrationChannels({ integrationId, channels: next, authoritative: false })
    const conn = this.connForIntegration(integrationId)
    if (!(conn instanceof SlackConnection)) return
    if (isDm) {
      if (known || current?.name) return
      void conn
        .getUserProfile(msg.sender.id)
        .then((prof) => {
          const name = prof.realName || prof.name
          if (!name) return
          this.refineObservedConversation(integrationId, channel, (c) => (c.name ? null : { ...c, name: `@${name}` }))
        })
        .catch(() => {})
      return
    }
    // Slack "G…" ids are shared by group DMs and legacy private channels, and an
    // `app_mention` payload omits channel_type — so a conversation that reached us
    // only through a mention is classified here rather than guessed from the id. One
    // lookup per conversation: the resolved row short-circuits the next call above.
    if (kind !== 'channel' || msg.platform !== 'slack') return
    void conn
      .getChannelInfo(channel)
      .then((info) => {
        if (!info.isMpim) return
        this.refineObservedConversation(integrationId, channel, (c) => {
          const name = c.name ?? info.name
          if (c.kind === 'mpim' && c.name === name) return null
          return { ...c, kind: 'mpim' as const, ...(name ? { name } : {}) }
        })
      })
      .catch(() => {})
  }

  /** Apply a late-resolved detail (a DM counterpart's name, a group-DM classification)
   *  to one observed conversation row and re-emit the snapshot. The updater returns
   *  null when the row already carries the detail, so a no-op never re-emits. */
  private refineObservedConversation(
    integrationId: string,
    channel: string,
    update: (row: IntegrationChannel) => IntegrationChannel | null
  ): void {
    const cached = this.channelSnapshots.get(integrationId)
    const snap = cached?.channels ?? []
    let changed = false
    const updated = snap.map((c) => {
      if (c.id !== channel) return c
      const next = update(c)
      if (!next) return c
      changed = true
      return next
    })
    if (!changed) return
    this.channelSnapshots.set(integrationId, { channels: updated, authoritative: cached?.authoritative ?? false })
    this.cpClient?.emitIntegrationChannels({ integrationId, channels: updated, authoritative: false })
  }

  /** Re-assert cached reports after a CP reconnect without upgrading a partial
   *  observation (including Slack gated-conversation discovery) to a full snapshot. */
  private replayChannelSnapshots(): void {
    for (const [integrationId, snapshot] of this.channelSnapshots) {
      this.cpClient?.emitIntegrationChannels({
        integrationId,
        channels: snapshot.channels,
        ...(snapshot.authoritative ? {} : { authoritative: false })
      })
    }
  }

  /** The live platform connection serving `integrationId`, any platform. */
  private connForIntegration(
    integrationId: string
  ): SlackConnection | TelegramConnection | DiscordConnection | FeishuConnection | undefined {
    return (
      this.connByIntegration.get(integrationId) ??
      this.tgConnByIntegration.get(integrationId) ??
      this.dcConnByIntegration.get(integrationId) ??
      this.fsConnByIntegration.get(integrationId)
    )
  }

  private replyConnFor(
    agentId: string,
    integrationId?: string
  ): SlackConnection | TelegramConnection | DiscordConnection | FeishuConnection | undefined {
    const intId = integrationId ?? this.agents.get(agentId)?.integrations[0]?.id
    if (!intId) return undefined
    return this.connForIntegration(intId)
  }

  /** The CP-owned cron ids currently on disk (register `localState.crons` — the
   *  CP computes `drop.crons` against this; hand-authored crons are not reported). */
  private cpCronIds(): string[] {
    const out: string[] = []
    for (const a of this.effectiveAgents()) for (const c of a.crons) if (c.origin === 'cp') out.push(c.id)
    return out
  }

  /** Ownership-aware active disk state sent during register. Single-agent mode
   * cannot archive its selected root, so it deliberately opts out of replica
   * pruning while still reporting the older assignment/cron/lease state. */
  private cpLocalState(): RegisterReq['localState'] {
    const agents = this.opts.agentName ? [] : this.effectiveAgents()
    return {
      assignments: [],
      crons: this.cpCronIds(),
      leases: [],
      agents: agents.map((agent) => ({
        agentId: agent.id,
        origin: agent.origin === 'cp' ? 'cp' : 'unknown'
      })),
      integrations: agents.flatMap((agent) =>
        agent.integrations.map((integration) => ({
          integrationId: integration.id,
          origin: integration.origin === 'cp' ? 'cp' : 'unknown'
        }))
      ),
      stagedAgents: this.opts.agentName
        ? []
        : [...this.moveStageMetadata]
            .filter(([, stage]) => stage.state === 'staging')
            .map(([agentId, stage]) => ({
              agentId,
              ...(AgentActivateSchema.shape.moveId.safeParse(stage.moveId).success ? { moveId: stage.moveId } : {})
            }))
            .sort((left, right) => left.agentId.localeCompare(right.agentId))
    }
  }

  // ── lifecycle: host reaping, drain, fleet exit (§2.5/§5.3/§7.2) ──────────────

  /** Stop and evict an ACP adapter child, returning the agent to `provisioned`
   *  (config kept; the next message lazily re-spawns it). Idempotent. The teardown
   *  is registered in `hostStopping` so a concurrent ensureHostAsync waits for it
   *  instead of spawning a second live child. */
  private async stopHost(agentId: string, deadlineMs?: number): Promise<void> {
    this.invalidateHostStart(agentId)
    const alreadyStopping = this.hostStopping.get(agentId)
    if (alreadyStopping) {
      // A second teardown must not report success while the first child is still
      // alive. Once it settles, fence again before taking a fresh host snapshot:
      // an ensureHostAsync waiter may have resumed at the same promise boundary.
      await alreadyStopping
      this.invalidateHostStart(agentId)
    }
    const host = this.hosts.get(agentId)
    this.hosts.delete(agentId)
    this.hostStartedAt.delete(agentId)
    const agentDir = this.hostConfigFiles.get(agentId)?.agentDir
    this.hostConfigFiles.delete(agentId)
    // The adapter (and its in-memory ACP sessions) is going away — drop this agent's
    // background-task leases so they can't leak or wrongly defer a future host.
    for (const [sid, lease] of this.sdkLease) if (lease.agentId === agentId) this.sdkLease.delete(sid)
    const clearDeliveryBindings = () => {
      for (const [key, binding] of this.sessionDeliveryBindings) {
        if (binding.agentId === agentId) this.sessionDeliveryBindings.delete(key)
      }
    }
    const clearMemoryExtractionQuarantines = () => {
      for (const [key, ownerAgentId] of this.memoryExtractionQuarantines) {
        if (ownerAgentId === agentId) this.memoryExtractionQuarantines.delete(key)
      }
    }
    // Once the child (and its process group) is gone, nothing can read the
    // materialized config-file secrets (KUBECONFIG & co.) — remove them so the
    // secret material stops resting on disk between sessions. Safe against the
    // re-spawn race: ensureHostAsync waits out `hostStopping`, and this teardown's
    // continuation runs before any such waiter re-materializes.
    const removeConfigFiles = () => {
      if (!agentDir) return
      const err = cleanupConfigFiles(agentDir)
      if (err) this.log.warn(`config-files: cleanup for agent "${agentId}" failed — ${err}`)
    }
    if (!host) {
      clearDeliveryBindings()
      clearMemoryExtractionQuarantines()
      removeConfigFiles()
      return
    }
    // AcpHost.stop is async, but injected/test adapters may implement a synchronous
    // best-effort stop. Normalize both shapes before registering the teardown fence.
    const stop = Promise.resolve(host.stop(deadlineMs)).finally(() => {
      if (this.hostStopping.get(agentId) === stop) this.hostStopping.delete(agentId)
    })
    this.hostStopping.set(agentId, stop)
    try {
      await stop
    } finally {
      // Keep exact routes alive until the adapter's notification stream has closed;
      // some runtimes flush a final title while session/stop is unwinding.
      clearDeliveryBindings()
      clearMemoryExtractionQuarantines()
      removeConfigFiles()
    }
  }

  /** Recurring idle sweep (§7.2/§7.3): reap idle adapter children and TTL-close
   *  idle sessions. Driven by the injected Clock so a FakeClock advances it in tests. */
  private armIdleSweep(): void {
    const interval = this.cfg.limits.idleSweepMs
    if (interval <= 0) return
    this.idleSweepTimer = this.clock.setTimeout(() => {
      this.idleSweepTimer = undefined
      try {
        this.sweepIdle()
      } catch (err) {
        this.log.error(`idle sweep failed: ${formatErr(err)}`)
      }
      if (!this.draining) this.armIdleSweep()
    }, interval)
  }

  /** Update the background-task lease from a Claude SDK lifecycle message
   *  (`_claude/sdkMessage`, claude-agent-acp ≥ 0.59.0). Defensive: unknown shapes
   *  are ignored so a future event-shape change degrades to plain-TTL behavior
   *  rather than throwing. Field names verified against the adapter (§4.2 of
   *  docs/designs/background-task-aware-reclaim.md). */
  private onSdkLifecycle(agentId: string, acpSessionId: string, message: unknown): void {
    const m = message as {
      type?: unknown
      subtype?: unknown
      state?: unknown
      task_id?: unknown
      subagent_type?: unknown
      description?: unknown
      patch?: { status?: unknown }
      tasks?: unknown
    } | null
    if (!m || m.type !== 'system' || typeof m.subtype !== 'string') return
    // The lease's decisions (reclaim deferral, §5.1 wake) are only as good as this feed, and
    // the feed is the one thing we cannot reproduce offline — log the accepted edges so a
    // stranded session can be diagnosed from the daemon log alone.
    this.log.debug(
      `bg-task lifecycle: ${m.subtype} ${JSON.stringify({
        task: m.task_id,
        state: m.state,
        status: m.patch?.status,
        live: Array.isArray(m.tasks) ? m.tasks.length : undefined
      })} on ${acpSessionId}`
    )
    const leaseKey = sdkLeaseKey(agentId, acpSessionId)
    const lease = this.sdkLease.get(leaseKey) ?? {
      agentId,
      tasks: new Map<string, { description?: string; isSubagent: boolean }>(),
      sdkState: 'idle' as const,
      bgWakes: 0,
      armedWakes: 0,
      deliveringWakes: 0
    }
    // Release a task from the lease and, if it's a real background task (not an
    // internal subagent), announce its completion when the agent is verbose enough
    // and hand the completion back to the model so the work is not stranded.
    const settle = (taskId: string, status?: string) => {
      const rec = lease.tasks.get(taskId)
      if (!rec) return // already settled — dedup the near-simultaneous edges
      lease.tasks.delete(taskId)
      if (rec.isSubagent) return
      this.announceBackgroundTaskDone(agentId, acpSessionId, rec.description, status)
      this.scheduleBackgroundTaskWake(agentId, acpSessionId, taskId, rec.description, status)
    }
    switch (m.subtype) {
      case 'session_state_changed':
        // Top-level Claude cycle. `idle` alone is NOT an end signal — it fires at
        // end_turn while a background task is still running (verified); the lease's
        // task set closes that gap.
        if (m.state === 'idle' || m.state === 'running') lease.sdkState = m.state
        break
      case 'task_started':
        if (typeof m.task_id === 'string')
          lease.tasks.set(m.task_id, {
            description: typeof m.description === 'string' ? m.description : undefined,
            isSubagent: typeof m.subagent_type === 'string' && m.subagent_type.length > 0
          })
        break
      case 'task_notification':
        // The task settled (no status carried) — release + announce as finished.
        if (typeof m.task_id === 'string') settle(m.task_id)
        break
      case 'task_updated': {
        // The terminal patch is guaranteed per transition even if a task_notification
        // is skipped — release + announce on completed/failed/killed too.
        const st = m.patch?.status
        if (typeof m.task_id === 'string' && (st === 'completed' || st === 'failed' || st === 'killed'))
          settle(m.task_id, st)
        break
      }
      case 'background_tasks_changed': {
        // Authoritative full snapshot (REPLACE semantics) — heals any missed start/end
        // edge. Announce tasks that vanished from the set, keep records for survivors.
        if (!Array.isArray(m.tasks)) break
        const live = new Set(
          m.tasks
            .map((t) => (t as { task_id?: unknown } | null)?.task_id)
            .filter((id): id is string => typeof id === 'string')
        )
        for (const taskId of [...lease.tasks.keys()]) if (!live.has(taskId)) settle(taskId)
        break
      }
      default:
        return
    }
    lease.agentId = agentId
    this.sdkLease.set(leaseKey, lease)
  }

  /** Proactively announce a completed background task to its session's channel/thread
   *  (a plain system notice, like the loop-guard warning — not an agent response, so
   *  no attribution footer). Gated on output mode ≥ medium; skipped for closed
   *  sessions, missing bindings, or non-Claude sessions with no lease. */
  private announceBackgroundTaskDone(
    agentId: string,
    acpSessionId: string,
    description?: string,
    status?: string
  ): void {
    const rec = this.store.getSessionByAcpIdForAgent(agentId, acpSessionId)
    if (!rec || rec.state === 'closed') return
    const mode = this.store.getOutputModeOverride(rec.key) ?? this.agents.get(agentId)?.output?.mode ?? 'low'
    const rank = { none: -1, minimal: 0, low: 1, medium: 2, high: 3 }
    if ((rank[mode] ?? 0) < rank.medium) return
    const conn = this.replyConnFor(agentId, this.sessionDeliveryBindings.get(rec.key)?.integrationId)
    if (!conn) return
    const what = description?.trim() || 'background task'
    const text = `🔔 Background task finished: ${what}${status ? ` (${status})` : ''}`
    void Promise.resolve(conn.postMessage(rec.channel, text, rec.thread || undefined)).catch((err) =>
      this.log.warn(`bg-task announce failed for "${agentId}": ${(err as Error).message}`)
    )
  }

  /** Arm the deferred wake for a settled background task. Deliberately NOT immediate: the
   *  runtime re-enters a `running` cycle of its own to drain the completion, and a turn
   *  injected into that window would race it. `attempt` counts the re-arms spent waiting
   *  for that cycle to end (see {@link MAX_BG_TASK_WAKE_REARMS}).
   *
   *  Arming bumps `armedWakes`, which keeps the session out of quiescence for the whole
   *  wait — the task is already gone from `tasks`, so otherwise an idle sweep could close
   *  the session and drop the lease before the timer fires. {@link wakeOnBackgroundTaskDone}
   *  releases the count on every exit path. */
  private scheduleBackgroundTaskWake(
    agentId: string,
    acpSessionId: string,
    taskId: string,
    description?: string,
    status?: string,
    attempt = 0
  ): void {
    if (this.draining) return
    const armed = this.sdkLease.get(sdkLeaseKey(agentId, acpSessionId))
    if (armed) armed.armedWakes += 1
    const handle = this.clock.setTimeout(() => {
      this.bgWakeTimers.delete(handle)
      try {
        this.wakeOnBackgroundTaskDone(agentId, acpSessionId, taskId, description, status, attempt)
      } catch (err) {
        this.log.error(`bg-task wake failed for "${agentId}": ${formatErr(err)}`)
      }
    }, BG_TASK_WAKE_GRACE_MS)
    this.bgWakeTimers.add(handle)
  }

  /**
   * Hand a completed background task back to the model as a fresh turn.
   *
   * The `run_in_background` contract the runtime shows its model ("you will be notified when
   * it completes") is a HARNESS promise, not an SDK one: interactive Claude Code re-invokes
   * the model when the task exits. Under ACP the foreground turn has already returned
   * `end_turn` by then, so without this the completion is stranded — the model reasonably
   * ends its turn expecting a notification that never arrives, and anything it owed (a
   * `needsParentReply` report, a deferred answer) is silently dropped.
   *
   * The runtime's OWN self-drain cycle is not a substitute and must not be waited out
   * indefinitely: it carries no `Pending`, so `onAcpUpdate` drops every chunk, tool render,
   * and transcript row it produces (verified end-to-end — the model answered, the user got
   * nothing). The wake therefore defers to it only for as long as it runs, then delivers
   * anyway. Its MCP tool calls DO land (that socket is not Pending-gated), so the wake text
   * tells the model not to repeat a report it already sent.
   *
   * Everything is re-validated here rather than captured at schedule time, so a session that
   * moved on during the grace window is simply left alone:
   *  - no lease ⇒ the host was reclaimed (leases are dropped in `stopHost`); the ACP session
   *    is gone with it and there is nothing to wake.
   *  - `sdkState === 'running'` ⇒ re-arm and let that cycle finish first (bounded).
   *  - a live task in the lease ⇒ a later completion will carry the session forward; wake on
   *    the last one instead of once per task.
   *  - session missing / not `idle` ⇒ closed, or a real turn is already running (which will
   *    observe the task itself).
   */
  private wakeOnBackgroundTaskDone(
    agentId: string,
    acpSessionId: string,
    taskId: string,
    description?: string,
    status?: string,
    attempt = 0
  ): void {
    if (this.draining) return
    const lease = this.sdkLease.get(sdkLeaseKey(agentId, acpSessionId))
    const what = description?.trim() || 'background task'
    if (!lease) {
      this.log.debug(`bg-task wake skipped (host reclaimed): "${what}" on ${acpSessionId}`)
      return
    }
    // This attempt's timer has fired, so release its slot of the fence — but the fence as a
    // whole must not drop to zero while a delivery is still owed. Every branch below either
    // takes a replacement slot first (re-arm, defer) or hands one to `deliveringWakes`.
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      lease.armedWakes = Math.max(0, lease.armedWakes - 1)
    }
    const skip = (why: string): void => {
      release()
      this.log.debug(`bg-task wake skipped (${why}): "${what}" on ${acpSessionId}`)
    }
    // Another timer still armed ⇒ several tasks settled on the SAME edge (an empty
    // `background_tasks_changed` snapshot settles all of them), arming a timer each. The
    // `tasks.size` guard below cannot catch that, since they are all already out of `tasks`.
    // Coalescing is safe here precisely because NONE of them has run: the last one delivers
    // for all, and it holds the fence meanwhile.
    if (lease.armedWakes > 1) return skip('another wake for this session is still armed')
    if (lease.sdkState === 'running') {
      if (attempt >= MAX_BG_TASK_WAKE_REARMS) {
        release()
        this.log.warn(
          `bg-task wake gave up after ${MAX_BG_TASK_WAKE_REARMS} re-arms — runtime cycle on ` +
            `${acpSessionId} never returned to idle ("${what}")`
        )
        return
      }
      // Take the next attempt's fence BEFORE releasing this one so the count never dips to 0.
      this.scheduleBackgroundTaskWake(agentId, acpSessionId, taskId, description, status, attempt + 1)
      return skip(`runtime cycle still running, re-armed ${attempt + 1}/${MAX_BG_TASK_WAKE_REARMS}`)
    }
    if (lease.tasks.size > 0) return skip('other background tasks still live')
    if (lease.bgWakes >= MAX_BG_TASK_WAKES_PER_SESSION) {
      release()
      this.log.warn(
        `bg-task wake budget exhausted (${MAX_BG_TASK_WAKES_PER_SESSION}) on ${acpSessionId} — ` +
          `not waking for "${what}"`
      )
      return
    }
    const rec = this.store.getSessionByAcpIdForAgent(agentId, acpSessionId)
    if (!rec) return skip('no session row')
    // A turn is in flight for this session. It must NOT absorb this completion: `sdkState` is
    // already idle above, so `host.prompt()` has returned and the model cannot observe the task
    // in-turn, yet the dispatch stays pending through renderer/finalization. Dropping here is
    // how a task started by a wake turn and settling in that cleanup window got lost. Defer
    // instead — retry the same attempt once the active dispatch settles, holding a fence slot
    // across the hand-off. Bounded in aggregate by the wake budget, which caps deliveries.
    const active = this.activeDispatchDoneByKey.get(rec.key)
    if (active) {
      lease.armedWakes += 1 // the deferred retry's slot, taken before this one is released
      const resume = (): void => {
        lease.armedWakes = Math.max(0, lease.armedWakes - 1)
        this.scheduleBackgroundTaskWake(agentId, acpSessionId, taskId, description, status, attempt)
      }
      void active.then(resume, resume)
      return skip('a turn is in flight — deferred until it settles')
    }
    if (rec.state !== 'idle') return skip(`session is ${rec.state}`)

    const platform = this.narrowPlatform(rec.platform)
    // Reply transport resolved from the SESSION's scope, not the agent's default integration —
    // a multi-platform agent would otherwise answer through integrations[0]'s client (mirrors
    // replyToSession). A scoped session whose integration is gone has nowhere to answer.
    const integrationId = this.integrationIdForTransportScope(agentId, platform, rec.transportScope)
    if (rec.transportScope && !integrationId) return skip('integration for the session scope is gone')

    // No CallMeta: this is not an agent call, it carries no hop chain, and it must not look
    // like one. A child woken this way still reaches its parent — `replyToSession` falls back
    // to the origin PERSISTED on the session for exactly this kind of turn (§5.3), and the
    // report-back obligation is sticky on `needsParentReply`.
    const msg: NormalizedMessage = {
      // Stable in the task id so a duplicated settle edge cannot dispatch twice.
      msgId: `bgtask:${rec.channel}:${taskId}`,
      // A monotonic "now" so the wake orders as new content in the session (see replyToSession).
      transcriptTs: monotonicTs(),
      traceId: `bgtask:${taskId}`,
      source: 'agent',
      platform,
      channel: rec.channel,
      ...(rec.thread ? { thread: rec.thread } : {}),
      ...(rec.transportScope ? { transportScope: rec.transportScope } : {}),
      sender: { id: `background-task:${taskId}`, isBot: true },
      text:
        `[background task finished] ${what}${status ? ` — ${status}` : ''}\n\n` +
        `This is a daemon notification, not a message from anyone. A background task you started ` +
        `settled after your turn had already ended, so nothing you said about it reached anyone. Read its ` +
        `output now (its task id is \`${taskId}\`) and finish what you were waiting on it for — this turn ` +
        `is the one that is actually delivered. If you owe a report to another session, send it, unless ` +
        `you already sent it after the task finished; do not report the same result twice. If the result ` +
        `needs no action at all, stay silent.`,
      mentionedBots: integrationId && this.botUserIds[integrationId] ? [this.botUserIds[integrationId]!] : [],
      isDm: false
    }
    lease.bgWakes += 1
    this.log.info(`bg-task wake: "${what}" → agent "${agentId}" session ${acpSessionId} (${rec.key})`)
    // Hand this attempt's fence slot over to `deliveringWakes` before releasing it, so the
    // fence spans async turn initialization: `dispatch()` claims the serial gate synchronously,
    // but `dispatchOne` then awaits thread history, attachments, and managed-memory recall
    // before SessionManager writes `state = 'prompting'`. Released when the promise settles —
    // turn completion, not admission. `finally` covers rejection too, so a failed wake cannot
    // pin the host; a turn that never settles is still bounded by `agentMaxLifetimeMs` (§4).
    lease.deliveringWakes += 1
    release()
    void this.dispatch(agentId, msg, integrationId)
      .catch((err) => this.log.error(`bg-task wake dispatch failed for "${agentId}": ${formatErr(err)}`))
      .finally(() => {
        lease.deliveringWakes = Math.max(0, lease.deliveringWakes - 1)
      })
  }

  /** A session is SDK-quiescent when it has no live background tasks, no armed completion
   *  wake, and the SDK's top-level cycle is idle. Absent lease ⇒ quiescent (plain-TTL
   *  behavior). An armed wake counts: the task it will deliver is already out of `tasks`,
   *  so without it a long-running task's session could be TTL-closed inside the grace
   *  window and the completion lost — the very thing §5.1 exists to prevent. */
  private sessionSdkQuiescent(agentId: string, acpSessionId: string | null | undefined): boolean {
    if (!acpSessionId) return true
    const l = this.sdkLease.get(sdkLeaseKey(agentId, acpSessionId))
    return !l || (l.tasks.size === 0 && l.armedWakes === 0 && l.deliveringWakes === 0 && l.sdkState === 'idle')
  }

  /** Whether any of an agent's sessions has in-flight background work — a live background
   *  task, a completion wake that is armed or delivering, or a running SDK cycle (a
   *  self-initiated followup turn that carries no `this.pending` entry). Gates idle host
   *  reclaim. */
  private agentHasLiveSdkWork(agentId: string): boolean {
    for (const l of this.sdkLease.values())
      if (
        l.agentId === agentId &&
        (l.tasks.size > 0 || l.armedWakes > 0 || l.deliveringWakes > 0 || l.sdkState === 'running')
      )
        return true
    return false
  }

  /** Re-write the agent's materialized config-file secrets (idle-swept below)
   *  before a turn goes out. MUST be called synchronously before host.prompt():
   *  the files are then guaranteed on disk before the child can run its first
   *  tool. The pointer env vars were fixed at spawn and always reference the
   *  same paths, so re-writing content under a warm host is transparent to it.
   *  No-op for agents without materialized config-file secrets. */
  private rematerializeConfigFiles(agentId: string): void {
    const entry = this.hostConfigFiles.get(agentId)
    if (!entry?.childEnv || entry.materialized) return
    const res = materializeConfigFiles(entry.agentDir, entry.childEnv)
    // Mark materialized even on a partial write failure: the idle sweep then
    // still deletes what did land, and the next quiet→turn cycle retries.
    entry.materialized = true
    for (const notice of res.notices) {
      this.log.warn(`config-files: re-materialize for agent "${agentId}" — ${notice}`)
    }
  }

  private sweepIdle(): void {
    const now = this.clock.now()
    // Probe temp roots re-created by a runtime that outlived its adapter (see
    // sweepStaleProbeRoots) must be reclaimed inside THIS process's lifetime — the
    // startup pass alone would let a long-lived daemon accumulate them indefinitely.
    if (now - this.lastProbeRootSweepAt >= PROBE_ROOT_SWEEP_INTERVAL_MS) {
      this.lastProbeRootSweepAt = now
      sweepStaleProbeRoots({ log: this.log })
    }
    const ttl = this.cfg.limits.agentIdleTimeoutMs
    const maxLifetime = this.cfg.limits.agentMaxLifetimeMs
    // §7.3 idle→closed: a thread untouched past the TTL stops catching up — UNLESS it
    // still has in-flight background work (the SDK lease), which keeps it open.
    const closed = this.store.closeIdleSessions(
      now,
      ttl,
      (agentId, acpSessionId) => !this.sessionSdkQuiescent(agentId, acpSessionId)
    )
    if (closed.length) this.log.info(`idle: TTL-closed ${closed.length} session(s) (>${Math.round(ttl / 1000)}s)`)
    for (const row of closed) {
      if (row.platform === 'webchat') {
        void this.closeDelegatedConversation(row.agentId, row.channel, 'session_expired').catch((error) =>
          this.log.warn(`delegated webchat expiry cleanup failed (${formatErr(error)})`)
        )
      }
      if (!row.acpSessionId) continue
      this.sdkLease.delete(sdkLeaseKey(row.agentId, row.acpSessionId)) // the session is gone — drop its lease
      this.emitSessionMetadataSnapshot({
        sessionId: row.acpSessionId,
        agentId: row.agentId,
        phase: 'end',
        platform: row.platform as SessionKey['platform'],
        channel: row.channel,
        thread: row.thread
      })
    }
    // Config-file secrets: delete the materialized files once the agent has gone
    // quiet — same quiescence predicates as host reclaim below (no in-flight turn,
    // no live background work, no recent activity) but a much shorter window. The
    // next turn re-writes them before session/prompt goes out
    // (rematerializeConfigFiles), so a warm host stays fully usable; this only
    // bounds how long the secret material rests on disk while nothing runs.
    const configFilesIdle = this.cfg.limits.configFilesIdleMs
    for (const [agentId, entry] of this.hostConfigFiles) {
      if (!entry.materialized || !entry.childEnv) continue
      if (this.drainingAgents.has(agentId)) continue // stopHost will remove them
      if ([...this.pending.values()].some((p) => p.agentId === agentId)) continue
      const last = Math.max(this.store.agentLastActivityTs(agentId) ?? 0, this.hostStartedAt.get(agentId) ?? 0)
      if (now - last <= configFilesIdle) continue
      // The lease also covers the settle→followup gap of a background task: a
      // task-drain turn flips sdkState to running before any tool can fire.
      if (this.agentHasLiveSdkWork(agentId)) continue
      const err = cleanupConfigFiles(entry.agentDir)
      if (err) {
        this.log.warn(`config-files: idle cleanup for agent "${agentId}" failed — ${err}`)
        continue
      }
      entry.materialized = false
      this.log.info(
        `config-files: removed idle secret files for agent "${agentId}" (quiet ${Math.round((now - last) / 1000)}s)`
      )
    }
    // §7.2 ready→provisioned: reclaim a host whose agent has no recent session
    // activity AND no in-flight turn (a long turn stamps no activity, so the
    // in-flight guard is load-bearing — see recordUnrouted).
    for (const [agentId] of [...this.hosts]) {
      if (this.drainingAgents.has(agentId)) continue
      if ([...this.pending.values()].some((p) => p.agentId === agentId)) continue
      // A just-started host that hasn't served a turn yet has no recorded activity
      // (`agentLastActivityTs` unset ⇒ 0 ⇒ idle≈now), so without this it would be
      // reclaimed on the very next sweep — including WHILE it is still mid-startup
      // (the host object is in `this.hosts` before `start()` resolves), tearing it
      // down underneath its own first dispatch (ACP "connection closed" → "already
      // started" → "Session not found"). Fall back to when the host came up so it
      // gets a full idle window from start, not an instant reclaim.
      const last = Math.max(this.store.agentLastActivityTs(agentId) ?? 0, this.hostStartedAt.get(agentId) ?? 0)
      if (now - last <= ttl) continue
      // Background-task lease: don't reap a host that still has live background work
      // (a running SDK cycle / followup turn or unsettled background tasks) — reaping
      // SIGTERMs the adapter, and `claude` reaps its own background jobs on graceful
      // exit. Bounded by the absolute lifetime ceiling so a wedged / never-ending task
      // can't pin an idle host forever.
      if (this.agentHasLiveSdkWork(agentId)) {
        const age = now - (this.hostStartedAt.get(agentId) ?? now)
        if (age <= maxLifetime) {
          this.log.info(`idle: host "${agentId}" has in-flight background work — deferring reclaim`)
          continue
        }
        this.log.warn(
          `idle: host "${agentId}" over max lifetime (${Math.round(age / 1000)}s) with background work still ` +
            `in flight — force-reclaiming (a wedged/long-lived background task may be terminated)`
        )
      }
      this.log.info(`idle: reclaiming host "${agentId}" (idle ${Math.round((now - last) / 1000)}s) → provisioned`)
      void this.stopHost(agentId).catch((err) =>
        this.log.error(`idle: stop host "${agentId}" failed: ${formatErr(err)}`)
      )
    }
  }

  /** Race `work` against a Clock-driven deadline, always clearing the timer so a
   *  finished drain never leaves a dangling timer holding the process open. */
  private async raceDeadline(work: Promise<unknown>, ms: number): Promise<'done' | 'timeout'> {
    // Clamp to setTimeout's 32-bit ceiling — a far-future drain deadline would
    // otherwise overflow and fire (almost) immediately.
    const delay = Math.min(Math.max(0, ms), 2_147_483_647)
    let handle: TimerHandle | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      handle = this.clock.setTimeout(() => resolve('timeout'), delay)
    })
    try {
      return await Promise.race([work.then(() => 'done' as const), timeout])
    } finally {
      if (handle !== undefined) this.clock.clearTimeout(handle)
    }
  }

  /**
   * §5.3 drain: gate new turns for the scope, await in-flight turns up to
   * `deadlineMs` (emitting `drain/progress` as each yields), then cancel any
   * straggler past the deadline. Returns BOTH the in-scope set (`matched`) and the
   * subset that actually finished (`drained`). The caller decides which to report
   * as released: a session is only safe to release once it is genuinely no longer
   * being served — either it drained, or the caller force-stops its host. Reporting
   * a still-running straggler would let the CP reassign it and double-serve.
   */
  private async drainScope(
    scope: Drain['scope'],
    deadlineMs: number,
    onProgress?: (p: DrainProgress) => void
  ): Promise<{ matched: SessionKey[]; drained: SessionKey[]; targets: Pending[] }> {
    const match = (p: Pending): boolean => {
      if (scope.kind === 'daemon') return true
      if (scope.kind === 'agent') return p.agentId === scope.agentId
      const k = scope.sessionKey
      return (
        p.platform === k.platform && p.channel === k.channel && (k.thread === undefined || p.statusThread === k.thread)
      )
    }
    if (scope.kind === 'daemon') this.draining = true
    else if (scope.kind === 'agent') this.drainingAgents.add(scope.agentId)

    const keyOf = (sk: SessionKey) => `${sk.platform}:${sk.channel}:${sk.thread ?? '-'}`
    const targets = [...this.pending.entries()].filter(([, p]) => match(p))
    const matched = new Map<string, SessionKey>()
    for (const [, p] of targets) matched.set(keyOf(pendingSessionKey(p)), pendingSessionKey(p))
    if (targets.length)
      this.log.info(
        `drain[${scope.kind}]: awaiting ${targets.length} turn(s) (deadline ${Math.round(deadlineMs / 1000)}s)`
      )
    let settled = false
    const drained = new Map<string, SessionKey>()
    let remaining = targets.length
    const work = Promise.all(
      targets.map(([, p]) =>
        p.done.then(() => {
          const sk = pendingSessionKey(p)
          drained.set(keyOf(sk), sk)
          remaining--
          if (!settled) onProgress?.({ remaining, drained: [...drained.values()] })
        })
      )
    )
    const res = await this.raceDeadline(work, deadlineMs)
    settled = true
    if (res === 'timeout') {
      for (const p of this.pending.values()) {
        if (!match(p)) continue
        this.log.warn(`drain[${scope.kind}]: cancelling straggler turn (session ${p.acpSessionId})`)
        await (p.selectedHost?.host ?? this.hosts.get(p.agentId))?.cancel(p.acpSessionId).catch(() => {})
      }
    }
    return { matched: [...matched.values()], drained: [...drained.values()], targets: targets.map(([, p]) => p) }
  }

  /** Handle a CP `daemon/drain` (§5.3). A bare drain is a rebalance: after
   *  releasing sessions the daemon reclaims hosts and re-opens its gate (a teardown
   *  arrives separately via daemon/restart). */
  private async runDrain(drain: Drain, onProgress: (p: DrainProgress) => void): Promise<DrainDone> {
    const deadlineMs = Math.max(0, new Date(drain.deadline).getTime() - this.clock.now())
    const { matched, drained, targets } = await this.drainScope(drain.scope, deadlineMs, onProgress)
    // daemon/agent scope force-stop the host(s), so EVERY matched session is truly
    // no longer served → release all. session scope leaves the shared host running,
    // so only sessions that actually drained are safe to release (a straggler that
    // ignored cancel is still posting; reassigning it would double-serve).
    let released: SessionKey[]
    if (drain.scope.kind === 'daemon') {
      await this.stopSelectedTurnHosts(targets)
      for (const id of [...this.hosts.keys()]) await this.stopHost(id)
      await this.delegatedWebchatHosts?.stopAllHosts?.()
      this.draining = false
      released = matched
    } else if (drain.scope.kind === 'agent') {
      await this.stopSelectedTurnHosts(targets)
      await this.stopHost(drain.scope.agentId)
      await this.delegatedWebchatHosts?.stopAgentHosts?.(drain.scope.agentId)
      this.drainingAgents.delete(drain.scope.agentId)
      released = matched
    } else {
      released = drained
    }
    this.log.info(`drain[${drain.scope.kind}]: done — released ${released.length} session(s)`)
    return { released }
  }

  /** `agent/stop` (§8.2): drain the agent's in-flight turns, stop its host, and
   *  leave it gated so it stays down until a matching `agent/launch` revives it. */
  private async stopAgent(agentId: string): Promise<void> {
    const { targets } = await this.drainScope({ kind: 'agent', agentId }, this.cfg.limits.shutdownDrainMs)
    // Cold heads are not visible to drainScope until session/new|load returns.
    // Latch/abort them now, then destroy both selected cells and any idle private
    // cells before waiting on the dispatch leases.
    this.interruptAgentTurns(agentId, 'stop')
    await this.stopSelectedTurnHosts(targets)
    await this.stopHost(agentId)
    await this.delegatedWebchatHosts?.stopAgentHosts?.(agentId)
    // A dispatch can have passed the gate and captured its reply connection while
    // still inside sessions.handle(), before it appears in `pending`. Wait that
    // whole turn, then stop once more in case it constructed a host after the
    // first stopHost snapshot.
    while (this.activeDispatchesByAgent.get(agentId)?.size) {
      await Promise.all([...this.activeDispatchesByAgent.get(agentId)!])
    }
    await this.stopHost(agentId)
    await this.delegatedWebchatHosts?.stopAgentHosts?.(agentId)
    // gate intentionally left set (drainScope added it): a stopped agent must not
    // auto-respawn on the next message — agent/launch clears the gate.
  }

  /** Await the single-flight reconcile and any coalesced trailing pass. Registry
   *  callbacks fire a background reconcile before lifecycle handlers explicitly
   *  await it, so one plain `await reconcile()` can otherwise observe only the
   *  current pass rather than the queued final-roster pass. */
  private async flushReconcile(): Promise<void> {
    await this.reconcile()
    // Let the owner of a just-finished pass schedule its coalesced rerun, then
    // keep joining until both the run and pending marker are stable/empty.
    await Promise.resolve()
    while (this.reconcileRun || this.reconcilePending) {
      if (this.reconcileRun) await this.reconcileRun
      else await this.reconcile()
      await Promise.resolve()
    }
  }

  private queueAgentMove(
    kind: 'detach' | 'activate',
    agentId: string,
    moveId: string,
    work: () => Promise<Ack>
  ): Promise<Ack> {
    const key = `${kind}:${agentId}:${moveId}`
    const duplicate = this.agentMoveInFlight.get(key)
    if (duplicate) return duplicate

    const prior = this.agentMoveTails.get(agentId) ?? Promise.resolve()
    const run = prior.catch(() => {}).then(work)
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    this.agentMoveInFlight.set(key, run)
    this.agentMoveTails.set(agentId, tail)
    void run.then(
      () => {
        if (this.agentMoveInFlight.get(key) === run) this.agentMoveInFlight.delete(key)
        if (this.agentMoveTails.get(agentId) === tail) this.agentMoveTails.delete(agentId)
      },
      () => {
        if (this.agentMoveInFlight.get(key) === run) this.agentMoveInFlight.delete(key)
        if (this.agentMoveTails.get(agentId) === tail) this.agentMoveTails.delete(agentId)
      }
    )
    return run
  }

  private activationCapabilityError(agent: LoadedAgent): string | undefined {
    const model = agent.runtimeOverrides?.model
    const offeredModels = this.runtimeModels.get(agent.runtime) ?? []
    // A cache-hydrated list is not live knowledge: enforcing it would reject
    // models added while this daemon was down (fail-open like the empty list;
    // the gate turns strict once the first real probe lands).
    const offeredIsLive = this.runtimeModelsSource.get(agent.runtime) !== 'cached'
    if (model && offeredIsLive && offeredModels.length > 0 && !offeredModels.includes(model)) {
      return `model "${model}" is not offered by runtime "${agent.runtime}"`
    }
    const caps = this.runtimeMcpCaps.get(agent.runtime)
    for (const name of agent.mcpServers) {
      if (name === RESERVED_MCP_SERVER_NAME) return `MCP server name "${name}" is reserved`
      const def = this.mcpServerDefs[name]
      if (!def) return `MCP server "${name}" is not configured on this daemon`
      if (def.transport !== 'stdio' && caps && !caps[def.transport]) {
        return `MCP server "${name}" needs unsupported ${def.transport} transport on runtime "${agent.runtime}"`
      }
    }
    if (agent.memory?.provider === 'external') {
      const runtime = this.runtimes[agent.runtime]
      if (!runtime) return `runtime "${agent.runtime}" is unavailable`
      try {
        memoryProviderFor(
          agent,
          runtime,
          { ...agentChildEnv(agent), ...cpRuntimeEnv(agent) },
          this.externalMemoryAdmission()
        ).runtimeEnv()
      } catch (error) {
        return error instanceof Error ? error.message : 'external memory admission failed'
      }
    }
    return undefined
  }

  /** §2.5 SIGTERM / daemon shutdown: gate new turns, then await in-flight turns up
   *  to `shutdownDrainMs`, cancelling stragglers. Safe to call repeatedly. */
  private async drainForShutdown(): Promise<void> {
    this.draining = true
    const active = [...new Set([...this.activeDispatchesByAgent.values()].flatMap((runs) => [...runs]))]
    const pendingKeys = new Set([...this.pending.values()].map((p) => p.sessionKey))
    const coldAgents = new Set<string>()
    // A pre-Pending dispatch has no p.done for the old shutdown drain to observe.
    // Latch + abort its whole SessionManager initialization path immediately, retaining
    // its durable inbox row for startup replay. Stop its host/start generation too.
    for (const [key, entry] of this.activeGateEntries) {
      if (pendingKeys.has(key)) continue
      entry.cancelledReason ??= 'shutdown'
      entry.initAbort.abort(new Error('daemon shutting down'))
      coldAgents.add(entry.agentId)
    }
    const stopFailClosed = (agentId: string): Promise<void> =>
      Promise.all([
        this.stopHost(agentId, 0),
        this.delegatedWebchatHosts?.stopAgentHosts?.(agentId) ?? Promise.resolve()
      ])
        .then(() => undefined)
        .catch((err) => {
          this.log.error(`shutdown: force-stop failed for agent "${agentId}": ${formatErr(err)}`)
          // Never close the store/MCP boundary while a child that failed to stop may
          // still be executing against it. Process termination is the final backstop.
          return new Promise<void>(() => {})
        })
    const coldStops = [...coldAgents].map(stopFailClosed)
    const work = Promise.all([...active, ...coldStops])
    if (active.length > 0 || coldStops.length > 0) {
      const deadlineMs = this.cfg.limits.shutdownDrainMs
      this.log.info(
        `shutdown: draining ${active.length} active dispatch(es) (deadline ${Math.round(deadlineMs / 1000)}s)`
      )
      const res = await this.raceDeadline(work, deadlineMs)
      if (res === 'timeout') {
        this.log.warn(`shutdown: deadline hit with ${this.pending.size} ACP turn(s) still in flight — cancelling`)
        const forceAgents = new Set<string>()
        for (const [, entry] of this.activeGateEntries) {
          entry.cancelledReason ??= 'shutdown'
          entry.initAbort.abort(new Error('daemon shutdown deadline'))
          forceAgents.add(entry.agentId)
        }
        for (const p of this.pending.values()) {
          p.outputSuppressed ??= 'shutdown'
          this.clearIdle(p)
          this.clearFeishuStream(p)
          if (p.platform === 'feishu') {
            this.enqueueApply(p, { kind: 'card-cancel' }, { allowWhenSuppressed: true })
          }
          this.releaseElicits(p.agentId, p.acpSessionId)
          this.releaseChatPermissions(p.agentId, p.acpSessionId)
          this.releaseEditorPermissions(p.agentId, p.acpSessionId)
          void (p.selectedHost?.host ?? this.hosts.get(p.agentId))?.cancel(p.acpSessionId).catch(() => {})
        }
        const forceStops = [...forceAgents].filter((id) => !coldAgents.has(id)).map(stopFailClosed)
        // stopHost is the hard deadline backstop, but closing the store underneath an
        // uncooperative callback is worse than waiting. Abortable cold awaits and a
        // successful host stop make these dispatch leases settle promptly.
        await Promise.all([...active, ...coldStops, ...forceStops])
      }
    }
    // §6.9 #390/#353: any messages still queued behind the gate are admitted-but-unrun.
    // Settle them explicitly (reject with a fail-stop notice) rather than dropping them
    // silently and leaving their dispatch() promises unsettled. (A durable inbox — the
    // follow-up split out of this PR — would additionally persist them for replay.)
    this.settleQueuedForShutdown()
  }

  /** Reject and clear every entry still in the serial gate's queues (shutdown/teardown),
   *  so no admitted-but-unrun message leaves an unsettled dispatch() promise. */
  private settleQueuedForShutdown(): void {
    for (const [key, entries] of this.serialQueue) {
      for (const e of entries) {
        this.terminateQueuedSink(e, 'daemon shutting down')
        e.reject(new FailStopError(key))
      }
    }
    this.serialQueue.clear()
  }

  /**
   * §6.9 #353 startup replay: re-admit durably-persisted admitted-but-not-completed inbox rows
   * through the SAME serial gate (`dispatch`), FIFO-by-sessionKey (rows come back ordered by
   * (sessionKey, enqueuedAt), so order within a sessionKey is preserved and the gate keeps them
   * serial). Runs once on start() after the store is open, agents are loaded into `this.agents`,
   * and platform connections/crons are up (so a re-admitted turn has its reply transport), as
   * normal inbound begins. Idempotency: a row whose id is already live in the gate (`liveInboxIds`)
   * is skipped — dispatch re-appends the same id with INSERT OR IGNORE so no double row is written,
   * and the re-admitted entry adopts the existing row for later removal. Rows for an agent that no
   * longer exists on this daemon are SKIPPED + logged (the simplest choice — another owner/daemon
   * may hold that agent; we neither drop the row nor block on it). Webchat turns were never
   * persisted, so none appear here.
   */
  private replayInbox(): void {
    let rows: InboxRow[]
    try {
      rows = this.store.listInboxBySessionKeyFifo()
    } catch (err) {
      this.log.warn(`durable inbox: replay read failed: ${(err as Error).message}`)
      return
    }
    if (rows.length === 0) return
    let replayed = 0
    const purgedPausedAgents = new Set<string>()
    const purgedLoopScopes = new Set<string>()
    for (const row of rows) {
      // A completed hook row is a redacted durable receipt, not work. It is
      // re-emitted from onReady (when the CP socket is actually writable) and
      // remains here to absorb relay redelivery without another model turn.
      if (row.completedAt !== null && row.completedAt !== undefined) continue
      // Idempotency: a row already backing a live gate entry (re-admitted this startup, or a
      // duplicate id) is not re-dispatched.
      if (this.liveInboxIds.has(row.id)) continue
      // Skip (leave the row) for an agent this daemon doesn't own — another owner may hold it.
      if (!this.agents.has(row.agentId)) {
        this.log.warn(`durable inbox: skipping replay of ${row.id} — unknown agent "${row.agentId}"`)
        continue
      }
      let msg: NormalizedMessage
      let callMeta: CallMeta | undefined
      let hookContext: HookDispatchContext | undefined
      try {
        msg = JSON.parse(row.msg) as NormalizedMessage
        callMeta = row.callMeta ? (JSON.parse(row.callMeta) as CallMeta) : undefined
        hookContext = row.hookContext ? (JSON.parse(row.hookContext) as HookDispatchContext) : undefined
      } catch (err) {
        this.log.warn(`durable inbox: skipping corrupt row ${row.id}: ${(err as Error).message}`)
        continue
      }
      if (msg.source === 'hook' && !hookContext) {
        // A pre-R1 hook row cannot recover its trusted dispatch fence or
        // completion target. Do not silently replay it as a generic turn.
        this.log.warn(`durable inbox: tombstoning legacy hook row ${row.id} without trusted context`)
        this.store.removeInbox(row.id)
        continue
      }
      // A paused agent is an explicit operator stop, not a temporary startup
      // gate. Ordinary rows are discarded once per agent; a retained hook row
      // instead becomes a body-free failed report so its accepted delivery can
      // converge without ever replaying the model after unpause.
      if (this.paused(row.agentId)) {
        if (!purgedPausedAgents.has(row.agentId)) {
          purgedPausedAgents.add(row.agentId)
          this.purgeAgentInbox(row.agentId)
        }
        if (hookContext) this.emitHookCompletion(hookContext, 'failed', { reason: 'pause' }, { inboxId: row.id })
        continue
      }
      if (isMalformedPlatformTurn(msg) && !msg.isDm) {
        this.store.removeInbox(row.id)
        continue
      }
      const loopScope = loopGuardScope(msg)
      // Hooks do not spend the loop budget, but an already-open conversation
      // circuit intentionally interrupts every writer in that scope. A retained
      // hook row therefore needs the same terminal owner on startup instead of
      // being replayed after its triggering user backlog was purged.
      if ((usesLoopGuard(msg) || hookContext !== undefined) && this.store.isLoopGuardOpen(loopScope)) {
        if (!purgedLoopScopes.has(loopScope)) {
          purgedLoopScopes.add(loopScope)
          this.purgeLoopScopeInbox(loopScope)
        }
        if (hookContext) {
          this.emitHookCompletion(hookContext, 'failed', { reason: 'loop protection' }, { inboxId: row.id })
        }
        continue
      }
      const posterPublishState =
        row.posterPublishState === 'in_flight' || row.posterPublishState === 'settled'
          ? row.posterPublishState
          : hookContext?.githubReply
            ? 'not_started'
            : undefined
      // Re-admit through the same gate. The turn's own dispatch() promise is unobserved here
      // (the original caller is gone across the restart); errors are swallowed so a single bad
      // replay can't reject the startup path. dispatch re-adopts the same id (preserving
      // its payload/FIFO slot) and sets entry.inboxId, so a terminal path removes it.
      void this.dispatch(
        row.agentId,
        msg,
        row.integrationId ?? undefined,
        undefined,
        callMeta,
        {
          ...(row.isQueueCmd ? { isQueueCmd: true } : {}),
          fromInboxReplay: true,
          inboxReplayId: row.id,
          // Marker 0 is a pre-loop-guard admission (including rows retained while the
          // agent lived on another daemon). Charge it once; persistInbox advances it to
          // 1 after successful admission. Current-version rows remain replay-neutral.
          replay: row.loopGuardCounted === 1,
          adoptExistingInbox: true,
          ...(hookContext ? { requireDurable: true } : {})
        },
        hookContext?.githubReply,
        hookContext,
        posterPublishState
      ).catch(() => {})
      replayed++
    }
    if (replayed) this.log.info(`durable inbox: replayed ${replayed} admitted message(s) through the serial gate`)
  }

  /** Re-assert retained metadata-only hook completions whenever the CP socket
   * becomes ready. HookRepo applies them idempotently; keeping the receipt also
   * closes the completed-before-restart relay redelivery window. */
  private replayHookTerminalReports(): void {
    let rows: InboxRow[]
    try {
      rows = this.store.listInboxBySessionKeyFifo()
    } catch (err) {
      this.log.warn(`durable inbox: terminal report read failed: ${formatErr(err)}`)
      this.scheduleHookReportRetry()
      return
    }
    const pending = rows.filter(
      (row) =>
        row.terminalReport &&
        row.legacyReportConnection !== this.hookReportConnectionId &&
        !this.hookReportInflight.has(row.id)
    )
    const available = Math.max(0, MAX_HOOK_REPORT_INFLIGHT - this.hookReportInflight.size)
    const batch = pending.slice(0, available)
    let emitted = 0
    for (const row of batch) {
      try {
        const decoded = HookReport.parse(JSON.parse(row.terminalReport!))
        this.sendHookReport(decoded, row.id)
        emitted += 1
      } catch (err) {
        this.log.warn(`durable inbox: corrupt terminal hook receipt ${row.id}: ${formatErr(err)}`)
        try {
          this.store.acknowledgeHookInbox(row.id)
        } catch (cleanupError) {
          this.log.warn(`durable inbox: corrupt receipt cleanup failed for ${row.id}: ${formatErr(cleanupError)}`)
        }
      }
    }
    if (emitted) this.log.info(`durable inbox: re-emitted ${emitted} terminal hook report(s)`)
    // When capacity is exhausted, a settling request schedules the refill. A
    // legacy CP deliberately leaves the retained tail untouched until reconnect
    // negotiates ACK support; scheduling here would hammer legacy EVT delivery.
  }

  /** daemon/restart + daemon/upgrade (§8.3): ack now, then drain + stop + exit so
   *  the supervisor relaunches (the new binary, for upgrade). Refused when no
   *  supervisor is present, since exiting would leave the daemon down (§7.1). */
  private scheduleFleetExit(kind: 'restart' | 'upgrade', targetVersion?: string): DaemonControlAck {
    const supervisor = this.opts.supervisor
    if (supervisor !== 'cli' && supervisor !== 'service') {
      const reason = `no supervisor (AGENTCONNECT_SUPERVISOR=${supervisor ?? 'unset'}) — a bare \`run\` cannot ${kind}; use the CLI or an installed service`
      this.log.warn(`cp: ${kind} refused — ${reason}`)
      return { accepted: false, reason }
    }
    if (this.lifecycleInFlight) {
      const reason = 'another lifecycle operation is already in progress'
      this.log.warn(`cp: ${kind} refused — ${reason}`)
      return { accepted: false, reason }
    }

    const root = resolveRoot(this.opts.root)

    // An upgrade must locate the CLI (the out-of-band installer, §7.1) up front, so
    // an unreachable CLI is refused now rather than silently downgraded to a restart.
    let cliEntry: string | undefined
    if (kind === 'upgrade') {
      cliEntry = this.readCliEntry(root)
      if (!cliEntry) {
        const reason = `cannot locate the CLI (${cliEntryPointer(root)} missing or invalid) to run the upgrade`
        this.log.warn(`cp: upgrade refused — ${reason}`)
        return { accepted: false, reason }
      }
      if (!targetVersion) {
        return { accepted: false, reason: 'upgrade requires a targetVersion' }
      }
    }

    this.lifecycleInFlight = true
    // restart drains on a predictable timer; upgrade's install runs FIRST and its
    // duration is unbounded, so `willDrainUntil` would be misleading — omit it (§7.1).
    const willDrainUntil =
      kind === 'restart' ? new Date(this.clock.now() + this.cfg.limits.shutdownDrainMs).toISOString() : undefined
    this.log.info(`cp: ${kind}${targetVersion ? ` → ${targetVersion}` : ''} accepted`)

    void (async () => {
      // §7.1 ②: for upgrade, swap `current` via the CLI BEFORE draining. On failure
      // the daemon stays up, fully intact — no drain, no exit, `current` untouched.
      if (kind === 'upgrade') {
        const ok = await this.runCliUpgrade(cliEntry!, targetVersion!, root)
        if (!ok) {
          this.log.error(`cp: upgrade to ${targetVersion} aborted — daemon continues on the current version`)
          this.lifecycleInFlight = false
          return
        }
      }
      // §7.1 ③: drain then exit with the reserved code so the supervisor relaunches
      // (the new bundle via <root>/current for upgrade).
      try {
        await this.stop()
      } catch (err) {
        this.log.error(`cp: ${kind} shutdown failed: ${formatErr(err)}`)
      } finally {
        this.requestExit(RESERVED_RESTART_CODE)
      }
    })()

    return { accepted: true, willDrainUntil }
  }

  /** Read the CLI entry path the CLI self-heals into `<root>/cli-entry` (§3). */
  private readCliEntry(root: string): string | undefined {
    try {
      const entry = readFileSync(cliEntryPointer(root), 'utf8').trim()
      return entry && existsSync(entry) ? entry : undefined
    } catch {
      return undefined
    }
  }

  /** Run `agentconnect upgrade --to <v> --root <root>` (no --restart; the daemon's
   *  own exit + supervisor relaunch applies it). Resolves true iff it exits 0. */
  private async runCliUpgrade(cliEntry: string, targetVersion: string, root: string): Promise<boolean> {
    const { spawn } = await import('node:child_process')
    this.log.info(`cp: installing daemon ${targetVersion} via ${cliEntry}`)
    return await new Promise<boolean>((resolve) => {
      const child = spawn(process.execPath, [cliEntry, 'upgrade', '--to', targetVersion, '--root', root], {
        stdio: 'inherit'
      })
      child.on('exit', (code) => {
        if (code === 0) this.log.info(`cp: daemon ${targetVersion} installed and activated`)
        else this.log.error(`cp: CLI upgrade exited ${code ?? 'via signal'}`)
        resolve(code === 0)
      })
      child.on('error', (err) => {
        this.log.error(`cp: could not launch CLI upgrade: ${formatErr(err)}`)
        resolve(false)
      })
    })
  }

  // ── ConfigApply seam (CP changes config, never live routing) ──
  private cpConfigApply(): ConfigApply {
    return {
      applyConfigPush: (keys) => {
        const { applied, ignored } = mergeConfigPush(this.cfg, keys)
        if (applied.includes('logging.level')) this.log = makeLogger(this.cfg.logging.level)
        if (applied.length) this.log.info(`cp: applied config keys: ${applied.join(', ')}`)
        if (ignored.length) this.log.warn(`cp: ignored config keys: ${ignored.join(', ')}`)
      },
      applyReconcileSnapshot: (snap: RegisterOk) => {
        this.gitCommitIdentity = snap.gitCommitIdentity
        // Registry FIRST: an AgentSpec may reference one of these definitions,
        // and static admission must never observe the new agent before at least
        // a probing (fail-closed) connection entry exists.
        this.memoryConnections?.converge(snap.memoryConnections ?? [])
        // Apply only the ownership-aware, CP-authorized drop set. Roster absence
        // by itself is not destructive because this daemon may also host purely
        // local hand-authored agents/integrations.
        for (const integrationId of snap.drop.integrations ?? []) this.cpIntegrations?.remove(integrationId)
        for (const { agentId, action } of snap.drop.agents ?? []) {
          // Gate and revoke before either disk mutation: the old platform socket
          // closes in queued reconcile, so no message may enter in that window.
          this.drainingAgents.add(agentId)
          this.cpDroppedAgents.add(agentId)
          this.gitCreds?.remove(agentId)
          this.gitCredServer?.revoke(agentId)
          if (action === 'remove') {
            this.cpAgents?.remove(agentId)
            this.moveStageMetadata.delete(agentId)
            this.moveStagedAgents.delete(agentId)
            continue
          }
          // A missed move is a cold detach: preserve workspace/memory/local
          // files, but scrub platform credentials and stop serving immediately.
          this.cpAgents?.detach(agentId)
        }

        // A staged move is a durable tombstone. A register snapshot racing after
        // source detach (but before placement CAS) must not restore its archive or
        // rehydrate credentials. Only the ACKed atomic activate bundle may do so.
        const desiredAgents = (snap.agents ?? []).filter((agent) => !this.moveStagedAgents.has(agent.agentId))
        for (const { agentId } of desiredAgents) {
          if (!this.cpDroppedAgents.delete(agentId)) continue
          this.drainingAgents.delete(agentId)
          this.gitCreds?.clearDenied(agentId)
        }
        this.cpAgents?.converge(desiredAgents)
        this.cpIntegrations?.converge(
          (snap.integrations ?? []).filter((integration) => !this.moveStagedAgents.has(integration.agentId))
        )
        // MCP defs: full-replace the CP set from the per-daemon snapshot (memory-only, so a
        // provider removed while disconnected is pruned on reconnect). Reserved name stripped.
        // The subsequent onReady/register emit re-derives the facts from these defs.
        this.cpMcpDefs?.converge(
          (snap.mcpServers ?? [])
            .filter((s) => s.name !== RESERVED_MCP_SERVER_NAME)
            .map(({ name, ...def }) => [name, def])
        )
        this.mcpServerDefs = this.cpMcpDefs?.effective() ?? this.mcpServerDefs
        this.convergeRelays(snap.relays) // set-converge relay dial-out sockets (DOES prune) + persist for boot re-dial
        this.cpCollab.replace(snap.collabRoutes) // baseline collaboration routing snapshot (P2 terminal-verify)
        // crons AFTER agents: a cron def lands in its owning agent.json, which the
        // roster may have just created. drop.crons prunes the stale CP entries.
        for (const id of snap.drop.crons) this.cpCrons?.remove(id)
        this.cpCrons?.converge((snap.crons ?? []).filter((cron) => !this.moveStagedAgents.has(cron.agentId)))
        this.cpRouting?.converge({
          routingEpoch: snap.routingEpoch,
          assignments: snap.assignments,
          drop: { assignments: snap.drop.assignments }
        })
        if (snap.leases.length) this.log.debug(`cp: ${snap.leases.length} lease(s) noted (secrets handled later)`)
        if (snap.assignments.length) this.log.debug(`cp: converged ${snap.assignments.length} assignment(s)`)
        if (snap.agents.length) this.log.debug(`cp: converged ${snap.agents.length} agent spec(s)`)
        if (snap.integrations?.length) this.log.debug(`cp: converged ${snap.integrations.length} integration(s)`)
      },
      applyAgentUpsert: async ({ agentId, spec }): Promise<Ack> => {
        if (this.moveStagedAgents.has(agentId)) return { ok: false, reason: 'agent is staged for a move' }
        if (!this.cpAgents) return { ok: false, reason: 'agent registry is not ready' }
        if (this.cpDroppedAgents.delete(agentId)) this.drainingAgents.delete(agentId)
        // A replicated spec change may re-enable gitcred for a previously denied agent.
        this.gitCreds?.clearDenied(agentId)
        this.cpAgents.upsert(agentId, spec)
        await this.flushReconcile()
        return { ok: true }
      },
      applyAgentRemove: (agentId: string) => {
        // Drop the cached bearer token WITH the agent dir — an orphaned credential
        // would stay valid network-wide for up to an hour.
        this.drainingAgents.add(agentId)
        this.cpDroppedAgents.add(agentId)
        this.gitCreds?.remove(agentId)
        this.gitCredServer?.revoke(agentId)
        this.cpAgents?.remove(agentId)
        // Clear fail-closed gates only after destructive disk removal succeeds;
        // otherwise an old active root could become servable again on failure.
        this.moveStageMetadata.delete(agentId)
        this.moveStagedAgents.delete(agentId)
      },
      applyAgentDetach: (detach: AgentDetach): Promise<Ack> => {
        const { agentId, moveId } = detach
        return this.queueAgentMove('detach', agentId, moveId, async () => {
          if (this.opts.agentName) {
            return { ok: false, reason: 'agent move is unavailable in --agent single-agent mode' }
          }
          const previous = this.moveStageMetadata.get(agentId)
          // A delayed duplicate detach after this same operation committed must
          // not take the newly-live agent back down. Its original detach did finish.
          if (previous?.moveId === moveId && previous.state === 'committed') return { ok: true }

          // Seed the materialization marker while the current definition is
          // still live. A later workspace activation uses it to distinguish a
          // permission/subdirectory edit from a destructive mode/repo/branch
          // replacement, including after an ACK-loss retry.
          const currentWorkspace = this.agents.get(agentId)
          if (currentWorkspace) ensureWorkspaceMaterialization(currentWorkspace)

          // This is also the destination staging gate. An absent agent is expected:
          // ACK after arming the gate so the atomic activate bundle cannot serve early.
          stageAgentMove(this.agentsDir, agentId, moveId, detach.requireEmptyWorkspace)
          this.cpDroppedAgents.delete(agentId)
          this.moveStageMetadata.set(agentId, {
            moveId,
            state: 'staging',
            ...(detach.requireEmptyWorkspace ? { requireEmptyWorkspace: true } : {})
          })
          this.moveStagedAgents.add(agentId)
          this.drainingAgents.add(agentId)
          // Detach is the authority boundary. Capture/revoke each immutable
          // delegation fence while manager records still exist, then stop the
          // ordinary host and any cold dispatches behind the same agent gate.
          await this.closeDelegatedAgent(agentId)
          await this.stopAgent(agentId)
          const fence = this.moveStageMetadata.get(agentId)
          if (fence?.moveId !== moveId || fence.state !== 'staging') {
            return { ok: false, reason: 'agent/detach: move was superseded' }
          }
          if (detach.requireEmptyWorkspace) {
            const current = this.agents.get(agentId)
            const reason = !current
              ? `agent ${agentId} is not active on this daemon`
              : current.workspace.mode !== 'from-scratch'
                ? 'workspace is no longer scratch'
                : !isWorkspaceEmpty(current)
                  ? 'scratch workspace is not empty; remove or move its files before converting'
                  : undefined
            if (reason) {
              // The root was never archived, so roll the temporary lifecycle
              // fence back and let the stopped host restart lazily on demand.
              clearAgentMoveStage(this.agentsDir, agentId)
              this.moveStageMetadata.delete(agentId)
              this.moveStagedAgents.delete(agentId)
              this.drainingAgents.delete(agentId)
              await this.flushReconcile()
              return { ok: false, reason: `agent/detach: ${reason}` }
            }
          }
          this.gitCreds?.remove(agentId)
          this.gitCredServer?.revoke(agentId)
          this.cpAgents?.detach(agentId)
          await this.flushReconcile()
          // Retry the strict close even when a previous detach pass already removed
          // the agent but failed while stopping its final socket.
          await this.closeUnusedPlatformConnections()
          const finalFence = this.moveStageMetadata.get(agentId)
          if (finalFence?.moveId !== moveId || finalFence.state !== 'staging') {
            return { ok: false, reason: 'agent/detach: move was superseded' }
          }
          return { ok: true }
        })
      },
      applyAgentActivate: (activate: AgentActivate): Promise<Ack> => {
        const { agentId } = activate
        return this.queueAgentMove('activate', agentId, activate.moveId, async () => {
          if (this.opts.agentName) {
            return { ok: false, reason: 'agent move is unavailable in --agent single-agent mode' }
          }
          const stage = this.moveStageMetadata.get(agentId)
          if (stage?.moveId === activate.moveId && stage.state === 'committed') return { ok: true }
          if (
            stage?.moveId !== activate.moveId ||
            stage.state !== 'staging' ||
            !this.moveStagedAgents.has(agentId) ||
            !this.drainingAgents.has(agentId)
          ) {
            return { ok: false, reason: 'agent/activate: staging fence is missing or superseded' }
          }
          const capacityUsed = this.agents.size + this.activatingAgents.size
          if (this.cfg.limits.maxAgents > 0 && capacityUsed >= this.cfg.limits.maxAgents) {
            return {
              ok: false,
              reason: `agent/activate: daemon capacity ${capacityUsed}/${this.cfg.limits.maxAgents} is full`
            }
          }
          this.activatingAgents.add(agentId)
          if (activate.prepareWorkspace || activate.reconcileWorkspace) this.preparingWorkspaces.add(agentId)
          try {
            if (activate.integrations.some((integration) => integration.agentId !== agentId)) {
              return { ok: false, reason: 'agent/activate: integration bundle contains a different agentId' }
            }
            if (activate.crons.some((cron) => cron.agentId !== agentId)) {
              return { ok: false, reason: 'agent/activate: cron bundle contains a different agentId' }
            }
            // Apply the complete authoritative bundle synchronously while the staged
            // agent is still excluded from effectiveAgents. Every write either lands
            // before the ACK or throws; retries remain safe behind the same gate.
            this.gitCreds?.clearDenied(agentId)
            this.cpAgents?.upsert(agentId, activate.spec)
            for (const integration of activate.integrations) this.cpIntegrations?.upsert(integration)
            for (const cron of activate.crons) this.cpCrons?.upsert(cron)
            const activation =
              this.cpAgents?.activate(agentId, {
                integrationIds: activate.integrations.map((integration) => integration.integrationId),
                cronIds: activate.crons.map((cron) => cron.cronId)
              }) ?? 'missing'
            if (activation === 'missing') {
              return { ok: false, reason: `agent/activate: unknown agent ${agentId}` }
            }
            // Dependents were pruned while the agent was still invisible. Publish the
            // exact-set config now, but keep the dispatch gate until the host proves ready.
            this.moveStagedAgents.delete(agentId)
            try {
              await this.flushReconcile()
            } catch (err) {
              this.moveStagedAgents.add(agentId)
              await this.stopHost(agentId).catch(() => {})
              await this.flushReconcile().catch(() => {})
              throw err
            }
            const agent = this.agents.get(agentId)
            if (!agent) {
              this.moveStagedAgents.add(agentId)
              await this.flushReconcile()
              return { ok: false, reason: `agent/activate: agent ${agentId} did not reconcile` }
            }
            if (!this.runtimes[agent.runtime]) {
              this.moveStagedAgents.add(agentId)
              await this.flushReconcile()
              return { ok: false, reason: `agent/activate: runtime "${agent.runtime}" is unavailable` }
            }
            const capabilityError = this.activationCapabilityError(agent)
            if (capabilityError) {
              this.moveStagedAgents.add(agentId)
              await this.flushReconcile()
              return { ok: false, reason: `agent/activate: ${capabilityError}` }
            }
            let rollbackPreparedWorkspace: (() => void) | undefined
            if (activate.prepareWorkspace || activate.reconcileWorkspace) {
              try {
                rollbackPreparedWorkspace = await prepareWorkspaceForActivation(agent, {
                  allowExistingCheckout: stage.requireEmptyWorkspace !== true,
                  reconcileMaterialization: activate.reconcileWorkspace === true
                })
              } catch (err) {
                this.moveStagedAgents.add(agentId)
                await this.stopHost(agentId).catch(() => {})
                await this.flushReconcile().catch(() => {})
                return { ok: false, reason: `agent/activate: workspace preparation failed: ${(err as Error).message}` }
              }
            }
            // Prove the target can actually initialize ACP while the staging gate is
            // still closed. Workspace reconciliation happens first so the spawned
            // runtime and its sandbox bind the new directory, never an unlinked old one.
            try {
              await this.ensureHostAsync(agentId, { allowAgentDrain: true })
            } catch (err) {
              this.moveStagedAgents.add(agentId)
              await this.stopHost(agentId).catch(() => {})
              try {
                rollbackPreparedWorkspace?.()
              } catch (rollbackErr) {
                this.log.error(
                  `agent/activate: failed to roll workspace back for "${agentId}": ${formatErr(rollbackErr)}`
                )
              }
              await this.flushReconcile().catch(() => {})
              return { ok: false, reason: `agent/activate: ${(err as Error).message}` }
            }
            try {
              commitAgentMove(this.agentsDir, agentId, activate.moveId)
            } catch (err) {
              await this.stopHost(agentId).catch(() => {})
              try {
                rollbackPreparedWorkspace?.()
              } catch (rollbackErr) {
                this.log.error(
                  `agent/activate: failed to roll workspace back for "${agentId}": ${formatErr(rollbackErr)}`
                )
              }
              this.moveStagedAgents.add(agentId)
              await this.flushReconcile().catch(() => {})
              return { ok: false, reason: `agent/activate: failed to commit staging fence: ${(err as Error).message}` }
            }
            this.moveStageMetadata.set(agentId, { moveId: activate.moveId, state: 'committed' })
            this.drainingAgents.delete(agentId)
            return { ok: true }
          } finally {
            this.preparingWorkspaces.delete(agentId)
            this.activatingAgents.delete(agentId)
          }
        })
      },
      listAgentPermissionRequests: ({ agentId, limit }: AgentPermissionRequestList): AgentPermissionRequestPage => ({
        agentId,
        requests: this.store.listPermissionRequests(agentId, limit).map((request) => ({
          id: request.id,
          agentId: request.agentId,
          sessionId: request.sessionId,
          createdAt: new Date(request.createdAt).toISOString(),
          requesterId: request.requesterId,
          requesterName: request.requesterName,
          command: request.command,
          status: request.status,
          resolvedAt: request.resolvedAt === null ? null : new Date(request.resolvedAt).toISOString()
        }))
      }),
      decideAgentPermission: (req: AgentPermissionDecision): Ack => this.decideEditorPermission(req),
      applyIntegrationUpsert: (spec) => {
        if (!this.moveStagedAgents.has(spec.agentId)) this.cpIntegrations?.upsert(spec)
      },
      applyIntegrationRemove: (integrationId) => this.cpIntegrations?.remove(integrationId),
      applyMcpServerUpsert: (spec) => {
        if (spec.name === RESERVED_MCP_SERVER_NAME) {
          this.log.warn(`mcp: ignoring CP push for reserved server name "${spec.name}"`)
          return
        }
        const { name, ...def } = spec
        if (this.cpMcpDefs?.upsert(name, def)) {
          this.onMcpDefsChanged()
          // NEVER log def values — an http proxy def's headers carry the bearer grant key.
          this.log.info(`mcp: applied CP server def "${name}" (${Object.keys(this.mcpServerDefs).length} effective)`)
        }
      },
      applyMcpServerRemove: (name) => {
        if (this.cpMcpDefs?.remove(name)) {
          this.onMcpDefsChanged()
          this.log.info(`mcp: removed CP server def "${name}"`)
        }
      },
      applyMemoryConnectionUpsert: async (spec) => {
        if (!this.memoryConnections) return { ok: false, reason: 'memory connection registry is unavailable' }
        if (!this.memoryConnections.upsert(spec)) {
          return { ok: false, reason: 'memory connection definition is stale or conflicts at the same revision' }
        }
        const reason = await this.memoryConnections.waitForAdmission(spec.connectionId)
        return reason ? { ok: false, reason } : { ok: true }
      },
      applyMemoryConnectionRemove: (connectionId) => this.memoryConnections?.remove(connectionId),
      upsertCron: (cron: CronUpsert) => {
        if (!this.moveStagedAgents.has(cron.agentId)) this.cpCrons!.upsert(cron)
      },
      removeCron: (cronId: string) => this.cpCrons!.remove(cronId),
      runCron: (cronId: string) => this.runCronNow(cronId),
      applyRouteAssign: (a: RouteAssign) => this.cpRouting?.upsertAssign(a),
      applyRouteUpdate: (u: RouteUpdate) => this.cpRouting?.applyUpdate(u),
      applyRelayRoster: (relays: RelayRosterEntry[]) => this.convergeRelays(relays),
      applyCollabRoutes: (snap) => this.cpCollab.replace(snap),
      // ── lifecycle control (§5.3/§8) ──
      applyAgentLaunch: async (launch: AgentLaunch): Promise<AgentLaunched> => {
        if (this.moveStagedAgents.has(launch.agentId)) {
          throw new Error(`agent/launch: agent ${launch.agentId} is staged for a daemon move`)
        }
        const agent = this.agents.get(launch.agentId)
        if (!agent) throw new Error(`agent/launch: unknown agent ${launch.agentId}`)
        // Revive a stopped agent (clear any gate) and warm-start its host. The
        // launchId is a fresh fence value; per-turn mode + launchId-scoped prompt
        // fencing are out of scope (the daemon prompts from its own ingress).
        this.drainingAgents.delete(launch.agentId)
        // Park the CP's launch provenance for the next session this agent
        // creates, so ingest can attribute it to the launching user (§4.4).
        if (launch.launchCorrelationId) {
          this.pendingLaunchCorrelation.set(launch.agentId, launch.launchCorrelationId)
        }
        await this.ensureHostAsync(launch.agentId)
        return {
          agentId: launch.agentId,
          launchId: randomUUID(),
          startedAt: new Date(this.clock.now()).toISOString(),
          runtime: agent.runtime
        }
      },
      applyAgentStop: async (stop: AgentStop): Promise<Ack> => {
        await this.stopAgent(stop.agentId)
        return { ok: true }
      },
      applyDaemonDrain: (drain: Drain, onProgress: (p: DrainProgress) => void): Promise<DrainDone> =>
        this.runDrain(drain, onProgress),
      applyDaemonRestart: (_req: DaemonRestart): DaemonControlAck => this.scheduleFleetExit('restart'),
      applyDaemonUpgrade: (req: DaemonUpgrade): DaemonControlAck =>
        this.scheduleFleetExit('upgrade', req.targetVersion),
      // The CP is the authority on effective visibility (§4.3 changes, §4.5
      // settlements and cascades); the daemon only enforces the resulting
      // capture gate. Ordering is by the CP's durable revision, so retransmits
      // and out-of-order delivery are safe.
      applySessionVisibility: (p: SessionVisibilityPush): 'applied' | 'superseded' =>
        this.store.applyCpCaptureGate(p.sessionId, p.visibility === 'private', p.visibilityRev)
    }
  }

  /**
   * Converge the relay dial-out set AND persist the roster to config.json (whole-set,
   * CP-owned) so a boot with the CP unreachable can re-dial the same relays. The disk
   * write is skipped when the roster is unchanged — register/ok re-sends it on every
   * (re)connect, and we don't want to rewrite config.json on each identical snapshot.
   */
  private convergeRelays(relays: RelayRosterEntry[]): void {
    // A pre-relay CP's snapshot omits the field; the frame codec defaults it, but a
    // hand-built snapshot may not — normalize so a missing roster reads as "no relays".
    const next = relays ?? []
    this.relays?.converge(next)
    const cur = this.cfg.relays ?? []
    const same =
      cur.length === next.length && next.every((r) => cur.some((c) => c.relayId === r.relayId && c.url === r.url))
    if (!same) {
      this.cfg.relays = next
      persistRelays(this.root, next, this.opts.configPath)
    }
  }

  /**
   * Shared fire path for the non-message trigger sources (cron, hook — both
   * name their agent; no routing). With a target channel, `anchorText` is
   * posted there as a real ANCHOR message (through the target integration's
   * platform connection — Slack/Telegram/Discord alike) and the session
   * threads its replies under it — equivalent to a user posting the trigger
   * in-channel. Without one (or when the anchor can't be posted) the turn
   * still runs; a `headless` msg additionally suppresses all platform output
   * in dispatch. Resolves with dispatch's sessionId (null = gate-dropped).
   */
  private async anchorTrigger(
    agentId: string,
    msg: NormalizedMessage,
    target: { channel?: string; integrationId?: string } | undefined,
    anchorText: string,
    label: string
  ): Promise<NormalizedMessage | null> {
    // Gate BEFORE the anchor side effect. Cron scheduling remains registered while an
    // agent is paused, but a paused/draining/safety-stopping agent must publish nothing
    // and start no turn.
    if (
      this.draining ||
      this.drainingAgents.has(agentId) ||
      this.paused(agentId) ||
      this.safetyDrainingAgents.has(agentId)
    ) {
      this.log.info(`${label}: skipped for agent "${agentId}" (paused or draining)`)
      return null
    }
    if (target?.channel) {
      const conn = this.replyConnFor(agentId, target.integrationId)
      if (!conn) {
        this.log.warn(`${label}: agent "${agentId}" has no live platform connection — running without output`)
      } else {
        try {
          let ts: string | undefined
          if (msg.platform === 'slack') {
            const agent = this.agents.get(agentId)
            const options = agent
              ? this.slackAgentPostOptions({
                  platform: msg.platform,
                  agentId,
                  agentName: agent.displayName?.trim() || agent.name,
                  ...(agent.iconUrl ? { iconUrl: agent.iconUrl } : {})
                })
              : undefined
            ts = await (conn as SlackConnection).postMessage(target.channel, anchorText, undefined, options)
          } else {
            ts = await conn.postMessage(target.channel, anchorText)
          }
          // The posted anchor is both the thread root and the authoritative
          // transcript/read cursor. Keep the synthetic msgId as the durable turn id.
          if (ts) msg = { ...msg, thread: ts, transcriptTs: ts }
        } catch (err) {
          this.log.warn(
            `${label}: failed to post trigger to ${target.channel} (${formatErr(err)}) — running without anchor`
          )
        }
      }
    }
    return msg
  }

  private async fireTrigger(
    agentId: string,
    msg: NormalizedMessage,
    target: { channel?: string; integrationId?: string } | undefined,
    anchorText: string,
    label: string,
    onSessionReady?: (sessionId: string) => void
  ): Promise<string | null> {
    const anchored = await this.anchorTrigger(agentId, msg, target, anchorText, label)
    if (!anchored) return null
    // Same integration for the session's replies as for the anchor.
    return this.dispatch(
      agentId,
      anchored,
      target?.integrationId,
      undefined,
      undefined,
      onSessionReady ? { onSessionReady } : undefined
    )
  }

  /** Build the per-turn GitHub final-answer selector and poster, tokened
   *  via the repo-targeted gitcred mint (issues/PR write, no contents — never
   *  enters agent env). Attribution is resolved at publish time so the completed
   *  comment carries the session's final runtime/model selection. */
  private makeGithubReply(
    agentId: string,
    ref: GithubReplyTarget,
    sessionId: string
  ): { poster: GithubFinalPoster; collector: GithubReplyCollector } {
    return {
      collector: new GithubReplyCollector(),
      poster: new GithubFinalPoster(
        {
          token: async () => (await this.gitCreds.getPostToken(agentId, ref.repo, ref.hookId)).token,
          invalidateToken: (token) => this.gitCreds.invalidatePost(agentId, ref.repo, token),
          log: { warn: (m: string) => this.log.warn(m) }
        },
        ref.repo,
        ref.number,
        () =>
          this.agents.get(agentId)?.output.showFooter ? this.githubCommentAttribution(agentId, sessionId) : undefined,
        ref.reviewThreadRootCommentId
      )
    }
  }

  private githubCommentAttribution(agentId: string, sessionId: string): GithubCommentAttribution {
    const agent = this.agents.get(agentId)
    const runtime = agent?.runtime
    return {
      agentName: agent?.displayName?.trim() || agent?.name || agentId,
      agentUrl: this.agentLink(agentId),
      runtime: runtime ? (this.runtimeNames[runtime] ?? runtime) : 'unknown',
      model: this.hosts.get(agentId)?.modelOptions?.(sessionId)?.current ?? agent?.runtimeOverrides?.model ?? 'default',
      sessionUrl: this.sessionLink(sessionId),
      // Same CP-resolved public avatar Slack uses for icon_url; GitHub renders it
      // inline ahead of the footer sentence.
      ...(agent?.iconUrl ? { iconUrl: agent.iconUrl } : {})
    }
  }

  /**
   * A dream schedule fired for `agentId` (docs/designs/memory-dreaming.md §9).
   * Deliberately NOT a turn: no synthetic message, no transcript row, no inbox
   * entry — just the background job, exactly as a manual `dream/start` would.
   *
   * Refusals here are ordinary operating states, not errors: a tick that lands
   * while the previous dream is still running is SKIPPED (dreams are not queued
   * — a backlog of stale consolidations helps nobody), and a policy switched off
   * between the reconcile and the tick simply does nothing.
   */
  private onDreamScheduleFire(agentId: string): void {
    // Lifecycle gates first — a scheduled dream is background work that spawns a
    // runtime host and burns model tokens, so it obeys the same operator stops as
    // any other scheduled trigger. The cron stays REGISTERED throughout: these are
    // skips, not deregistrations, so the schedule resumes by itself on unpause.
    if (this.paused(agentId)) {
      this.log.info(`scheduled dream skipped for agent "${agentId}": agent is paused`)
      return
    }
    if (this.safetyDrainingAgents.has(agentId)) {
      this.log.info(`scheduled dream skipped for agent "${agentId}": interrupted turns are still stopping`)
      return
    }
    if (this.draining || this.drainingAgents.has(agentId)) {
      this.log.info(`scheduled dream skipped for agent "${agentId}": draining`)
      return
    }
    void this.dreamRunner()
      .start(agentId, { trigger: 'schedule' })
      .then((dream) => this.log.info(`dream ${dream.dreamId} started on schedule for agent "${agentId}"`))
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        if (err instanceof DreamStateError) {
          this.log.info(`scheduled dream skipped for agent "${agentId}": ${message}`)
          return
        }
        this.log.error(`scheduled dream failed to start for agent "${agentId}": ${message}`)
      })
  }

  /**
   * A cron fired for `agentId` (§8.6 bypass). The fire is stamped into D11
   * first (the daemon owns last-run, protocol §5.4); the anchor+dispatch ride
   * the shared {@link fireTrigger} path.
   */
  private async onCronFire(agentId: string, msg: NormalizedMessage, cron: CronDef): Promise<void> {
    const firedAt = this.clock.now()
    const firedAtIso = new Date(firedAt).toISOString()
    const report = (update: Omit<CronReport, 'cronId' | 'agentId' | 'firedAt'> = {}): void => {
      if (cron.origin === 'cp')
        this.cpClient?.emitCronReport({ cronId: cron.id, agentId, firedAt: firedAtIso, ...update })
    }
    this.store.setCronLastRun(`${agentId}:${cron.id}`, firedAt)
    // CP-owned crons report the fire, attach the session as soon as it exists,
    // then close the run when the turn ends. Hand-authored crons stay local.
    report()
    let readySessionId: string | undefined
    try {
      const sessionId = await this.fireTrigger(
        agentId,
        msg,
        cron.target,
        `⏰ ${cron.trigger}`,
        `cron "${cron.id}"`,
        cron.origin === 'cp'
          ? (sessionId) => {
              readySessionId = sessionId
              report({ sessionId })
            }
          : undefined
      )
      if (sessionId !== null)
        report({
          status: 'success',
          durationMs: Math.max(0, this.clock.now() - firedAt),
          sessionId
        })
    } catch (err) {
      report({
        status: 'failed',
        durationMs: Math.max(0, this.clock.now() - firedAt),
        ...(readySessionId ? { sessionId: readySessionId } : {}),
        reason: (err as Error).message?.slice(0, 300) || 'dispatch failed'
      })
      throw err
    }
  }

  /** Console "Run now" (`cron/run` REQ): fire one CP cron immediately. The fire
   *  runs asynchronously — the ack only says whether the cron exists here; the
   *  outcome arrives as normal `cron/report`s. */
  private runCronNow(cronId: string): { ok: boolean; reason?: string } {
    for (const a of this.effectiveAgents()) {
      const cron = a.crons.find((c) => c.id === cronId && c.origin === 'cp')
      if (!cron) continue
      const { msg } = buildSyntheticMessage(a.id, cron, randomUUID())
      void this.onCronFire(a.id, msg, cron).catch((err) =>
        this.log.error(`cron/run dispatch failed for agent "${a.id}": ${formatErr(err)}`)
      )
      return { ok: true }
    }
    return { ok: false, reason: 'unknown cron' }
  }

  /** Coalesce hot transcript writes into body-free, per-session invalidations. */
  private scheduleSessionActivity(mutation: TranscriptMutation): void {
    const ts = new Date(this.clock.now()).toISOString()
    for (const agentId of mutation.agentIds) {
      for (const sessionId of this.store.sessionIdsForTranscript(agentId, mutation.channel, mutation.thread)) {
        const key = `${agentId}\0${sessionId}`
        const existing = this.transcriptActivityTimers.get(key)
        if (existing) {
          existing.activity.revision = String(mutation.revision)
          existing.activity.ts = ts
          continue
        }
        const activity: SessionActivity = {
          sessionId,
          agentId,
          revision: String(mutation.revision),
          ts
        }
        const timer = this.clock.setTimeout(() => {
          const pending = this.transcriptActivityTimers.get(key)
          if (!pending || pending.timer !== timer) return
          this.transcriptActivityTimers.delete(key)
          this.cpClient?.emitSessionActivity(pending.activity)
        }, 250)
        this.transcriptActivityTimers.set(key, { timer, activity })
      }
    }
  }

  private startCpClient(root: string): void {
    const cp = this.cfg.controlPlane
    if (!cp?.enabled || !cp.url || !cp.key) {
      this.log.info('cp: not connecting (disabled or missing url/token) — running local')
      return
    }
    // Start host-load sampling only now — the snapshot exists solely to feed the CP
    // heartbeat below (no CP ⇒ no sampler, so CP-less runs never probe the system).
    this.metrics = new SystemMetrics({ clock: this.clock, log: this.log })
    this.metrics.start()
    // The token's `sub` is the authoritative daemonId: the CP returns it in
    // auth/ok and we adopt + persist it (token-only onboarding). So we
    // echo a daemonId in the auth frame ONLY when the operator explicitly pinned
    // one via --daemon-id. A config-persisted id (e.g. a UUID minted by a prior
    // flagless local `run`, or an id adopted from a previous CP) must NOT be
    // echoed: if it differs from the token's `sub` the CP rejects auth (4401),
    // and if it matches it is redundant anyway.
    const echoDaemonId = this.opts.overrides?.daemonId
    const url = cp.url
    const cpKey = cp.key // narrowed to string by the guard above

    // Relay dial-out manager: the CP publishes the roster (register/ok.relays + the
    // relay/roster EVT) and this set-converges an rd/* connection to each relay. Built
    // on the shared connection package (the daemon's first consumer). `daemonId` is read
    // lazily — auth/ok adopts it before the roster ever converges. Constructed before
    // cpClient.start() so applyReconcileSnapshot has a live manager during the handshake.
    this.relays = new RelayManager({
      apiKey: () => cpKey,
      daemonId: () => this.cfg.daemonId,
      clock: systemClock,
      connect: (relayUrl) =>
        ClientTransport.dial(relayUrl, {
          subprotocol: RELAY_DAEMON_SUBPROTOCOL,
          path: RELAY_DAEMON_WS_PATH
        }),
      log: this.log,
      // Bridge an inbound relay webchat op onto the shared turn engine (webchat, PR 3).
      onRelayMsg: (msg, chat) => this.handleRelayMsg(msg, chat),
      // A forwarded cross-daemon agent-call — terminal-verify + dispatch (P2).
      onRelayAgentMsg: (msg) => this.handleRelayAgentMsg(msg)
    })
    // Boot-dial the persisted roster before the CP is even reachable: it survives a
    // CP outage in config.json, so webchat ingress keeps working across a daemon
    // restart while the CP is down (graceful degradation). register/ok re-converges
    // authoritatively — and prunes any relay the CP has since dropped — once connected.
    if (this.cfg.relays.length) this.relays.converge(this.cfg.relays)

    this.cpClient = new CpClient({
      url,
      token: cp.key,
      ...(echoDaemonId ? { daemonId: echoDaemonId } : {}),
      onDaemonId: (id) => {
        this.cfg.daemonId = id
        persistDaemonId(root, id, this.opts.configPath)
        this.log.info(`cp: adopted daemonId ${id} from auth/ok`)
      },
      onWebAppUrl: (url) => {
        this.cpWebAppUrl = url
        if (url) this.log.debug(`cp: web app url ${url} (session deep links)`)
      },
      onOrgSlug: (slug) => {
        this.cpOrgSlug = slug
        if (slug) this.log.debug(`cp: org slug "${slug}" (session deep links)`)
      },
      agentVersion: DAEMON_VERSION,
      host: hostname(),
      heartbeatDefaultMs: cp.heartbeatMs,
      maxAgents: this.cfg.limits.maxAgents,
      capabilities: () => ({
        platforms: ['slack', 'telegram', 'discord', 'feishu'],
        // Report the human-facing tool name (e.g. "Claude Agent"), not the
        // registry id ("claude-acp"); fall back to the id for user-defined or
        // unnamed runtimes.
        runtimes: this.admittedRuntimeIds().map((id) => this.runtimeNames[id] ?? id),
        acp: true,
        features: this.registrationFeatures()
      }),
      // Observed runtime profiles, sent as one `facts/daemon-runtimes` snapshot on
      // each register. Keyed by the registry id (the launch key), so the console can
      // offer a runtime whose value round-trips back to `this.runtimes[agent.runtime]`
      // at launch. `models` comes from the background probe sweep (empty until it
      // completes on first connect); the picker falls back to "Runtime default" while
      // empty. Includes auth-required curated candidates (reported, not admitted).
      runtimeProfiles: (): FactsRuntimeProfile[] => this.reportedRuntimeIds().map((id) => this.runtimeProfileFor(id)),
      // Daemon-configured MCP servers, derived from the effective def set (no
      // probing), riding the same facts frame with replace-on-register semantics.
      mcpServerFacts: (): FactsMcpServer[] => this.mcpServerFactsFromDefs(),
      // On (re)connect, probe runtimes in the background and push refreshed profiles,
      // and re-assert each integration's cached channel-membership snapshot (the CP
      // may have missed emits while we were disconnected; latest-wins upsert).
      onReady: () => {
        void this.probeRuntimesAndEmit()
        this.cpClient?.emitMemoryConnectionFacts(this.memoryConnections?.facts() ?? [])
        this.hookReportConnectionId = randomUUID()
        this.replayHookTerminalReports()
        this.replayChannelSnapshots()
        // ...and each CP cron's stored last-run stamp — fires while the CP was
        // unreachable would otherwise never land (latest-wins upsert, so
        // re-asserting an already-known stamp is a no-op).
        for (const a of this.effectiveAgents())
          for (const c of a.crons) {
            if (c.origin !== 'cp') continue
            const at = this.store.getCronLastRun(`${a.id}:${c.id}`)
            if (at !== undefined)
              this.cpClient?.emitCronReport({ cronId: c.id, agentId: a.id, firedAt: new Date(at).toISOString() })
          }
      },
      localState: () => this.cpLocalState(),
      loadSnapshot: () => ({
        // 0..1 utilization fractions sampled in the background by SystemMetrics
        // (systeminformation): real busy-time CPU across cores + active memory,
        // read synchronously here so the heartbeat send never blocks on a probe.
        ...(this.metrics?.snapshot() ?? { cpu: 0, mem: 0 }),
        agents: this.hosts.size
      }),
      activeSessions: () => this.pending.size,
      degradedScopes: () => this.cpDegradedScopes(),
      configApply: this.cpConfigApply(),
      sessionRead: createSessionReader(this.store, (agentId) => this.replyConnFor(agentId)?.workspaceUrl),
      // §5.4: serve a CP-forwarded status probe for a child session we own. Authorization is
      // re-done here (the lineage rule lives where the session lives), not trusted from the CP.
      childSessionStatusProbe: (probe) => this.childSessionStatusProbe(probe),
      workspaceRead: createWorkspaceReader(
        (id) => {
          const workspace = this.agents.get(id)?.workspace
          return workspace ? { root: workspace.path, scratch: workspace.mode === 'from-scratch' } : undefined
        },
        (id, write) => this.withWorkspaceFileWrite(id, write)
      ),
      workspaceGit: createWorkspaceGit(
        (id) => this.agents.get(id)?.workspace.path,
        (id) => {
          const workspace = this.agents.get(id)?.workspace
          return workspace?.mode === 'git-repo' && workspace.gitCredential === 'github-app' ? gitCredentialEnv(id) : {}
        },
        (id) => {
          const workspace = this.agents.get(id)?.workspace
          return workspace?.mode === 'git-repo' && workspace.gitRepo
            ? {
                repo: workspace.gitRepo,
                branch: workspace.gitBranch,
                githubApp: workspace.gitCredential === 'github-app'
              }
            : undefined
        }
      ),
      memoryReader: createMemoryReader((id) => this.agents.get(id)?.dir, this.memory),
      dreamReader: createDreamReader(this.dreamRunner()),
      // webchat is no longer a CP control-WS integration (milestone A4) — it rides the
      // relay's rd/* wire, wired through RelayManager.onRelayMsg below.
      clock: systemClock,
      connect: () => ClientTransport.dial(url, { subprotocol: CP_SUBPROTOCOL, path: CP_WS_PATH }),
      log: this.log
    })
    this.initializeDelegatedMcp(root, url, this.cpClient)
    this.cpClient.start()
    this.log.info(`cp: connecting to ${url}…`)
  }

  /** Build the current profile entry for a runtime (one element of the
   *  `facts/daemon-runtimes` snapshot), folding in any models learned by the
   *  probe sweep. */
  private runtimeProfileFor(id: string): FactsRuntimeProfile {
    return {
      runtime: id,
      // Prefer the probed adapter version (the actual running release, learned at the
      // last probe's `initialize`) over the registry's declared version; fall back to
      // the declared version when a runtime hasn't been probed / reported none.
      version: this.runtimeProbedVersions.get(id) || this.runtimeVersions[id] || '',
      models: this.runtimeModels.get(id) ?? [],
      acpSupport: 'full',
      acpProtocolVersion: this.runtimeAcpVersions.get(id),
      toolCalling: true,
      mcpCapabilities: this.runtimeMcpCaps.get(id),
      modelsSource: this.runtimeModelsSource.get(id),
      // Capability matrix rides every frame it exists for — including probe-failure
      // rounds where models[] empties (advertisement ≠ capability knowledge).
      modelCatalog: this.runtimeCatalogs.get(id),
      ...(this.runtimeAuthRequired.has(id) || this.runtimeAuthRequiredLive.has(id) ? { authRequired: true } : {})
    }
  }

  /** Fold a live turn's auth outcome into the facts state. A turn rejected with
   *  ACP -32000 marks the agent's runtime login-required; a completed turn is
   *  the definitive "logged in" signal and clears both the live mark and any
   *  stale probe-derived one (the user logged in between sweeps). Re-emits the
   *  facts snapshot only when the reported flag actually flips. Called from the
   *  dispatch hot path (right after prompt / inside its failure handler), so
   *  the telemetry emit is best-effort like emitStoredUsageReport — it must
   *  never affect message delivery. */
  private noteRuntimeAuthFromTurn(runtimeId: string, authRequired: boolean): void {
    let changed: boolean
    if (authRequired) {
      changed = !this.runtimeAuthRequiredLive.has(runtimeId) && !this.runtimeAuthRequired.has(runtimeId)
      this.runtimeAuthRequiredLive.add(runtimeId)
    } else {
      changed = this.runtimeAuthRequiredLive.delete(runtimeId)
      if (this.runtimeAuthRequired.delete(runtimeId)) changed = true
    }
    if (!changed) return
    try {
      this.cpClient?.emitDaemonRuntimes?.(
        this.reportedRuntimeIds().map((id) => this.runtimeProfileFor(id)),
        this.mcpServerFactsFromDefs()
      )
    } catch (err) {
      this.log.debug(`runtime auth facts emit failed (${runtimeId}): ${(err as Error).message}`)
    }
  }

  /** Synchronously pre-fill the in-memory runtime maps from the SQLite last-good
   *  catalog cache (design runtime-model-catalog.md §4): the register-time facts
   *  snapshot then carries cached models + matrix instead of an empty REPLACE
   *  that would wipe the CP's learned state until the sweep completes. Rows for
   *  runtimes not in the installed catalog are ignored (kept on disk — the
   *  runtime may only be temporarily unresolved); rows older than 30 days are
   *  garbage-collected. */
  private hydrateRuntimeCatalogCache(): void {
    try {
      this.store.gcRuntimeCatalog(this.clock.now() - 30 * 24 * 3600_000)
      for (const meta of this.store.listRuntimeCatalogMetas()) {
        if (!this.runtimeCatalog.entries[meta.runtimeId]) continue
        this.rebuildRuntimeCatalog(meta.runtimeId)
        const cachedModels = this.store.listRuntimeModelCaps(meta.runtimeId).map((r) => r.modelId)
        if (cachedModels.length > 0 && (this.runtimeModels.get(meta.runtimeId) ?? []).length === 0) {
          this.runtimeModels.set(meta.runtimeId, cachedModels)
          this.runtimeModelsSource.set(meta.runtimeId, 'cached')
        }
      }
    } catch (err) {
      this.log.warn(`catalog: cache hydrate failed: ${formatErr(err)}`)
    }
  }

  /** Rebuild one runtime's report-shape catalog from the cache: raw stored caps
   *  plus daemon-side synthetic effort levels (Claude max/ultracode) so the
   *  console vocabulary always matches the live-session pickers. */
  private rebuildRuntimeCatalog(id: string): void {
    const meta = this.store.getRuntimeCatalogMeta(id)
    if (!meta) {
      this.runtimeCatalogs.delete(id)
      return
    }
    const rt = this.runtimeCatalog.entries[id]?.runtime
    const claude = rt ? isClaudeRuntimeDef(rt) : false
    const models = this.store.listRuntimeModelCaps(id).map((r) => ({
      id: r.modelId,
      ...(r.caps.name ? { name: r.caps.name } : {}),
      ...(r.caps.efforts !== undefined
        ? { efforts: claude ? augmentEffortOptions(r.caps.efforts) : r.caps.efforts }
        : {}),
      ...(r.caps.defaultEffort ? { defaultEffort: r.caps.defaultEffort } : {}),
      ...(r.caps.fastMode !== undefined ? { fastMode: r.caps.fastMode } : {})
    }))
    this.runtimeCatalogs.set(id, {
      models: models.slice(0, 128),
      ...(meta.defaultModel ? { defaultModel: meta.defaultModel } : {}),
      ...(meta.permissionModes ? { permissionModes: meta.permissionModes } : {}),
      ...(meta.defaultPermissionMode ? { defaultPermissionMode: meta.defaultPermissionMode } : {}),
      source: meta.source,
      observedAt: new Date(meta.observedAt).toISOString()
    })
  }

  private refreshAdmittedRuntimes(): void {
    this.runtimes = this.curatedRuntimeAdmission.filterCatalog(this.runtimeCatalog).runtimes
  }

  private admittedRuntimeIds(): string[] {
    this.refreshAdmittedRuntimes()
    return Object.keys(this.runtimes)
  }

  /** Runtime ids the facts snapshot reports: the admitted set PLUS curated
   *  candidates whose fresh probe was an auth-required rejection. Those are
   *  installed but logged out — they must be visible to the console (with the
   *  login warning) even though admission keeps them unlaunchable until a
   *  probe succeeds. */
  private reportedRuntimeIds(): string[] {
    const ids = this.admittedRuntimeIds()
    const admitted = new Set(ids)
    return [
      ...ids,
      ...this.curatedRuntimeAdmission.authRequiredIds(this.runtimeCatalog).filter((id) => !admitted.has(id))
    ]
  }

  /** How long a completed probe sweep stays fresh — reconnects within this window
   *  re-emit the cached profiles instead of re-spawning every agent. */
  private static readonly PROBE_TTL_MS = 5 * 60_000

  /** Admission freshness must not depend on CP reconnects: a CP-disabled or
   * continuously connected daemon rechecks curated winners on the same TTL. */
  private armRuntimeProbeRefresh(): void {
    if (this.draining || this.runtimeProbeTimer !== undefined) return
    if (!Object.values(this.runtimeCatalog.entries).some((entry) => entry.source === 'curated')) return
    this.runtimeProbeTimer = this.clock.setTimeout(() => {
      this.runtimeProbeTimer = undefined
      if (this.draining) return
      void this.probeRuntimesAndEmit(false).finally(() => this.armRuntimeProbeRefresh())
    }, Daemon.PROBE_TTL_MS)
  }

  /**
   * Probe every installed runtime in the background (launch → initialize →
   * session/new → read models → tear down), then emit one `facts/daemon-runtimes`
   * snapshot once the sweep completes so the CP replaces its runtime list. The
   * daemon-configured MCP-server list rides the same frame, derived from config
   * (no probing — see `mcpServerFactsFromDefs`).
   *
   * Triggered on each CP (re)connect. Deduped while in flight; skipped (with a
   * cached re-emit) when the last sweep is still fresh, so a reconnect storm can't
   * spawn a fleet of agent subprocesses. Never throws — probing is best-effort and
   * must not affect the CP connection.
   */
  private async probeRuntimesAndEmit(includeOrdinary = true): Promise<void> {
    // With a hostFactory (unit tests use fake in-memory hosts) we don't spawn real
    // subprocesses unless a probe seam is injected.
    if (this.opts.hostFactory && !this.opts.probeRuntimes) return
    if (this.probing) {
      if (includeOrdinary) this.ordinaryProbePending = true
      else this.curatedProbePending = true
      return
    }

    const fresh = this.lastProbeAtMs > 0 && this.clock.now() - this.lastProbeAtMs < Daemon.PROBE_TTL_MS
    const curatedCandidates = this.curatedRuntimeAdmission.probeCandidates(this.runtimeCatalog)
    if (fresh && Object.keys(curatedCandidates).length === 0) {
      // Recent results still valid — just re-assert the snapshot to the (new) connection.
      const ids = this.reportedRuntimeIds()
      this.cpClient?.emitDaemonRuntimes?.(
        ids.map((id) => this.runtimeProfileFor(id)),
        this.mcpServerFactsFromDefs()
      )
      return
    }

    const ordinaryRuntimes =
      !includeOrdinary || fresh
        ? {}
        : Object.fromEntries(
            Object.entries(this.runtimeCatalog.entries)
              .filter(([, entry]) => entry.source !== 'curated')
              .map(([id, entry]) => [id, entry.runtime])
          )
    const probeCount = Object.keys(ordinaryRuntimes).length + Object.keys(curatedCandidates).length
    if (probeCount === 0) return

    this.probing = true
    const probeIds = [...Object.keys(ordinaryRuntimes), ...Object.keys(curatedCandidates)]
    this.log.info(`probe: sweeping ${probeCount} runtime(s): ${probeIds.join(', ') || '(none)'}`)
    try {
      const probe = this.opts.probeRuntimes ?? probeAllRuntimes
      const batches: Array<Promise<RuntimeProbeResult[]>> = []
      if (Object.keys(ordinaryRuntimes).length > 0) {
        batches.push(
          probe(ordinaryRuntimes, {
            log: this.log,
            isolateAccountApps: this.cfg.security.isolateAccountApps,
            launchFor: (id, runtime, scopeDir, cwd) =>
              prepareRuntimeLaunch({
                runtimeId: id,
                runtime,
                scopeDir,
                cwd,
                runInSandbox: this.sandboxMechanism !== undefined,
                daemonRoot: this.root,
                agentsRoot: this.cfg.agentsDir,
                trustedRuntimeReadRoots:
                  this.sandboxMechanism !== undefined
                    ? runtimeSandboxReadRoots(runtime, process.env).readRoots
                    : undefined,
                explicitEnv: Object.fromEntries(runtime.env.map((entry) => [entry.name, entry.value])),
                sandboxMechanism: this.sandboxMechanism,
                maskedReadRoots:
                  this.sandboxMechanism === 'bwrap'
                    ? [delegatedMcpBrokerRoot(this.root), delegatedMcpRuntimeHomeRoot(this.root)]
                    : undefined
              })
          })
        )
      }
      if (Object.keys(curatedCandidates).length > 0) {
        batches.push(
          probe(curatedCandidates, {
            curated: true,
            log: this.log,
            isolateAccountApps: this.cfg.security.isolateAccountApps,
            runInSandbox: this.sandboxMechanism !== undefined,
            daemonRoot: this.root,
            agentsRoot: this.cfg.agentsDir,
            sandboxMechanism: this.sandboxMechanism,
            mcpSocketPath: mcpSocketPath(this.root),
            maskedReadRoots:
              this.sandboxMechanism === 'bwrap'
                ? [delegatedMcpBrokerRoot(this.root), delegatedMcpRuntimeHomeRoot(this.root)]
                : undefined,
            hostEnv: process.env
          })
        )
      }
      const results = (await Promise.all(batches)).flat()
      for (const result of results) {
        if (this.runtimeCatalog.entries[result.runtime]?.source === 'curated') {
          this.curatedRuntimeAdmission.record(result)
        }
      }
      this.refreshAdmittedRuntimes()
      // Overwrite unconditionally: a runtime that went from reachable → unreachable
      // must drop its previously-cached models rather than keep advertising stale ones.
      for (const r of results) {
        this.runtimeModels.set(r.runtime, r.ok ? r.models : [])
        // Either way this is now live knowledge — the cached-provenance leniency
        // (activation/move model gates) ends with the first real probe.
        this.runtimeModelsSource.set(r.runtime, 'probed')
        if (r.ok && r.acpProtocolVersion !== undefined) this.runtimeAcpVersions.set(r.runtime, r.acpProtocolVersion)
        else this.runtimeAcpVersions.delete(r.runtime)
        if (r.ok && r.probedVersion) this.runtimeProbedVersions.set(r.runtime, r.probedVersion)
        else this.runtimeProbedVersions.delete(r.runtime)
        // Same overwrite rule: an unreachable runtime falls back to "not probed"
        // (⇒ session resolution turns optimistic again rather than trusting stale caps).
        if (r.ok && r.mcpCapabilities) this.runtimeMcpCaps.set(r.runtime, r.mcpCapabilities)
        else this.runtimeMcpCaps.delete(r.runtime)
        // Login state is live knowledge from this probe only: set on an ACP
        // auth-required rejection, cleared on success or any OTHER failure kind
        // (a timeout says nothing about credentials).
        if (!r.ok && r.authRequired) this.runtimeAuthRequired.add(r.runtime)
        else this.runtimeAuthRequired.delete(r.runtime)
      }
      // Phase 1 of catalog discovery (design runtime-model-catalog.md §3.3): the
      // probe session's config options are already in hand — seed the cache with
      // the default model's caps + runtime-level permission modes, then let the
      // discovery gate decide whether a full phase-2 discovery is due. Failures
      // deliberately skip this block: the last-good catalog is never cleared.
      for (const r of results) {
        if (!r.ok) continue
        const entry = this.runtimeCatalog.entries[r.runtime]
        if (!entry || this.runtimes[r.runtime] === undefined) continue // curated candidates pre-admission stay out
        try {
          const fp = catalogFingerprint(r.runtime, r.probedVersion, entry.runtime)
          if (r.configOptions) {
            const caps = capsFromConfigOptions(r.configOptions)
            const existing = this.store.getRuntimeCatalogMeta(r.runtime)
            // Phase 1 must not flip a driver-built catalog back to 'acp'.
            const source = existing && existing.fingerprint === fp ? existing.source : 'acp'
            // The probe session sits on `currentModel` — which may be the literal
            // "default" a runtime advertises. Seed that model's caps under its real
            // id (so selecting "default" shows the runtime's own effort/fast), but
            // keep meta.defaultModel to a CONCRETE resolved id (never "default") —
            // it feeds the console's preselection + "Default (…)" hint, and a
            // native driver may still overwrite it with a concrete default.
            const seedModel = caps.currentModel
            const defaultModel = seedModel && seedModel !== 'default' ? seedModel : undefined
            this.store.recordRuntimeCatalogMeta({
              runtimeId: r.runtime,
              fingerprint: fp,
              source,
              ...(defaultModel ? { defaultModel } : {}),
              ...(caps.permissionModes ? { permissionModes: caps.permissionModes } : {}),
              ...(caps.currentPermissionMode ? { defaultPermissionMode: caps.currentPermissionMode } : {}),
              observedAt: this.clock.now()
            })
            if (seedModel) {
              this.store.upsertRuntimeModelCap({
                runtimeId: r.runtime,
                modelId: seedModel,
                fingerprint: fp,
                caps: {
                  efforts: caps.efforts,
                  ...(caps.defaultEffort ? { defaultEffort: caps.defaultEffort } : {}),
                  fastMode: caps.fastMode
                },
                observedAt: this.clock.now()
              })
            }
            this.rebuildRuntimeCatalog(r.runtime)
          }
          this.modelCatalogSvc?.noteProbe({
            runtimeId: r.runtime,
            rt: entry.runtime,
            probedVersion: r.probedVersion,
            models: r.models
          })
        } catch (err) {
          this.log.warn(`catalog: phase-1 seed for ${r.runtime} failed: ${formatErr(err)}`)
        }
      }
      if (Object.keys(ordinaryRuntimes).length > 0) this.lastProbeAtMs = this.clock.now()
      const okCount = results.filter((r) => r.ok).length
      this.log.info(`probe: sweep complete — ${okCount}/${results.length} runtime(s) reachable`)
      // Emit only once the sweep is done, so the CP sees a consistent snapshot.
      // `facts/daemon-runtimes` replaces the CP's runtime + MCP-server lists wholesale,
      // so entries removed since the last report are pruned rather than left stale.
      const ids = this.reportedRuntimeIds()
      this.cpClient?.emitDaemonRuntimes?.(
        ids.map((id) => this.runtimeProfileFor(id)),
        this.mcpServerFactsFromDefs()
      )
    } catch (err) {
      this.log.warn(`probe: sweep failed: ${formatErr(err)}`)
    } finally {
      this.probing = false
      if (this.ordinaryProbePending || this.curatedProbePending) {
        const includePendingOrdinary = this.ordinaryProbePending
        this.ordinaryProbePending = false
        this.curatedProbePending = false
        void this.probeRuntimesAndEmit(includePendingOrdinary)
      }
    }
  }

  /** Daemon-configured MCP servers as `{name, transport}` for `facts/daemon-runtimes`,
   *  derived from the effective def set (config + CP-pushed). The daemon does NOT
   *  connect to the servers — metadata only, for the console's server list. */
  private mcpServerFactsFromDefs(): FactsMcpServer[] {
    return Object.entries(this.mcpServerDefs).map(([name, def]) => ({ name, transport: def.transport }))
  }

  /**
   * A CP-pushed MCP def changed (mcpserver/upsert|remove): recompute the effective
   * map and re-emit `facts/daemon-runtimes` so its MCP-server list (REPLACE-based)
   * converges with the new provider set.
   */
  private onMcpDefsChanged(): void {
    this.mcpServerDefs = this.cpMcpDefs?.effective() ?? this.mcpServerDefs
    this.cpClient?.emitDaemonRuntimes?.(
      this.reportedRuntimeIds().map((id) => this.runtimeProfileFor(id)),
      this.mcpServerFactsFromDefs()
    )
  }

  private externalMemoryAdmission(): { assertReady(connectionId: string): void } {
    return {
      assertReady: (connectionId) => {
        const reason = this.memoryConnections
          ? this.memoryConnections.admissionError(connectionId)
          : 'external memory connection registry is not ready'
        if (reason) throw new MemoryProviderUnavailableError(reason)
      }
    }
  }

  /** A definition/grant/ABI change fences every host that captured it. Pure
   * recall/capture policy changes live on AgentSpec and use the normal agent
   * signature; connection changes always rebuild before the next turn. */
  private onMemoryConnectionDefinitionChange(connectionId: string): void {
    for (const agent of this.agents.values()) {
      if (agent.memory?.provider !== 'external' || agent.memory.connectionId !== connectionId) continue
      void this.stopHost(agent.id).catch((error) =>
        this.log.warn(`memory: failed to fence host "${agent.id}" after connection change: ${formatErr(error)}`)
      )
    }
  }

  async stop(): Promise<void> {
    // Set the drain gate FIRST: it both blocks new turns and stops the idle sweep
    // from re-arming itself (its callback re-arms only `if (!this.draining)`), so a
    // sweep firing during the awaits below can't leave a dangling timer behind.
    this.draining = true
    clearTimeout(this.debounceTimer)
    if (this.idleSweepTimer !== undefined) {
      this.clock.clearTimeout(this.idleSweepTimer)
      this.idleSweepTimer = undefined
    }
    if (this.runtimeProbeTimer !== undefined) {
      this.clock.clearTimeout(this.runtimeProbeTimer)
      this.runtimeProbeTimer = undefined
    }
    for (const t of this.bgWakeTimers) this.clock.clearTimeout(t)
    this.bgWakeTimers.clear()
    // Cancel in-flight catalog discoveries and kill their child processes.
    await this.modelCatalogSvc?.stop().catch(() => {})
    for (const t of this.cancelTimers.values()) this.clock.clearTimeout(t)
    this.cancelTimers.clear()
    for (const { timer } of this.coldCancelTimers.values()) this.clock.clearTimeout(timer)
    this.coldCancelTimers.clear()
    for (const t of this.slackRetryTimers.values()) this.clock.clearTimeout(t)
    this.slackRetryTimers.clear()
    if (this.hookReportRetryTimer !== undefined) {
      this.clock.clearTimeout(this.hookReportRetryTimer)
      this.hookReportRetryTimer = undefined
    }
    // Clear any live orchestration deadline timers so they don't hold the process open
    // (the durable `orchestration.deadline` epoch re-arms them on the next startup).
    for (const t of this.orchestrationDeadlines.values()) this.clock.clearTimeout(t)
    this.orchestrationDeadlines.clear()
    this.metrics?.stop()
    await this.watcher?.close()
    // §2.5: gate new turns and let in-flight ones finish (deadline-bounded) BEFORE
    // tearing the hosts down — a hard kill mid-turn loses the reply + transcript.
    await this.drainForShutdown()
    this.store.setTranscriptMutationListener()
    for (const { timer } of this.transcriptActivityTimers.values()) this.clock.clearTimeout(timer)
    this.transcriptActivityTimers.clear()
    const errors: unknown[] = []
    this.scheduler?.stop()
    this.dreamScheduler?.stop()
    await Promise.resolve(this.cpClient?.stop()).catch((e) => errors.push(e))
    // Stop the body-bearing capture pump before closing its verified clients or
    // SQLite store. Unfinished operations remain durable for restart recovery.
    await Promise.resolve(this.memoryOutbox?.stop()).catch((e) => errors.push(e))
    await Promise.resolve(this.memoryConnections?.close()).catch((e) => errors.push(e))
    await Promise.resolve(this.relays?.stop()).catch((e) => errors.push(e))
    for (const run of [...this.slackRetryRuns.values()]) await Promise.resolve(run.promise).catch((e) => errors.push(e))
    for (const c of this.connections) await Promise.resolve(c.stop()).catch((e) => errors.push(e))
    for (const c of this.httpSlackConns.values()) await Promise.resolve(c.stop()).catch((e) => errors.push(e))
    for (const c of this.telegramConns) await Promise.resolve(c.stop()).catch((e) => errors.push(e))
    for (const c of this.discordConns) await Promise.resolve(c.stop()).catch((e) => errors.push(e))
    for (const c of this.feishuConns) await Promise.resolve(c.stop()).catch((e) => errors.push(e))
    // Capture startup promises before stopHost invalidates their cache entries. Every
    // teardown goes through the same generation fence/hostStopping path, and no async
    // starter is allowed to outlive the store/MCP boundary below.
    const hostStarts = [...this.hostStarts.values()]
    const hostIds = new Set([...this.hosts.keys(), ...this.hostStarts.keys(), ...this.hostStopping.keys()])
    for (const agentId of hostIds) await this.stopHost(agentId).catch((e) => errors.push(e))
    await Promise.allSettled(hostStarts)
    // Dedicated hosts must leave their private bridges before the broker closes.
    // Daemon shutdown clears local cells only; SessionMcpBroker.stop deliberately
    // does not revoke CP delegation so a restart can reattach on the next rd/msg.
    await Promise.resolve(this.delegatedWebchatHosts?.stop()).catch((e) => errors.push(e))
    await Promise.resolve(this.delegatedMcpBroker?.stop()).catch((e) => errors.push(e))
    // After the hosts (and thus their spawned mcp-bridge subprocesses) are gone,
    // so server.close() isn't left waiting on a live bridge connection.
    await Promise.resolve(this.mcp?.stop()).catch((e) => errors.push(e))
    this.gitCredServer?.stop()
    this.store?.close()
    if (errors.length) throw new AggregateError(errors, 'stop: partial failure')
  }
}
