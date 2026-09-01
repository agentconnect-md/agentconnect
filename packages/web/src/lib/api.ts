// Control Plane (C2 BFF) HTTP client for the console.
// Talks to the Fastify REST API in packages/control-plane (`/agents`, `/sessions`,
// `/daemons`, …). DTOs here mirror packages/control-plane/src/http/dto. The
// mappers translate the lean wire DTOs into the richer UI shapes from `./data`,
// filling fields the API does not (yet) expose with placeholders.

import type {
  Agent,
  AgentCallPolicy,
  ConnectionStatusKey,
  DaemonRow,
  ResourceVisibility,
  Session,
  SessionImage,
  Workspace,
  PlacementKindValue
} from '@/lib/data'
import { isSelfSender, lifecycleStatus, MOCK_MODE, placementValueOf, poolLabel } from '@/lib/data'
import type { HookKind } from '@agentconnect.md/protocol'
import { hookKindFromIntegration, hookSourceLabel } from '@/lib/session-trigger'
import type { AgentIcon } from '@/lib/agent-icon'
import { withIconUrl } from '@/lib/agent-icon'
import {
  getToken,
  getIdTokenRaw,
  getUser,
  redirectExpiredSession,
  refreshTokenAfterUnauthorized,
  signOutDeletedAccount
} from '@/lib/auth'
import { track } from '@/lib/analytics'
import { createSseParser } from '@/lib/sse'
import { isUpgradeAvailable } from '@/lib/version'
import type { SocialLoginTarget } from '@/lib/social-login-providers'

/** A non-2xx CP response. `status` lets callers branch without parsing strings;
 *  `code` carries the CP's machine-readable denial reason when the endpoint
 *  provides one (e.g. github user-authz: GITHUB_IDENTITY_REQUIRED). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /** The CP's parsed error body, for the few denials that carry structured
     *  detail a message can't render well (Slack's `missingScopes` list). Read
     *  it behind a `code` check and narrow it — nothing here is guaranteed. */
    readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

// The CP's **versioned API base** — origin + version path (e.g.
// `https://api.example.test/v1`, or direct-to-CP `http://cp.example.com:8080/api/v1`).
// REST calls, including the webchat token mint, append resource paths to this.
// The browser then dials the relay URL returned by that mint.
//
// The CP always serves its routes under `/api/v1` (see
// `packages/control-plane/src/http/version.ts`); WHERE that surfaces publicly is a
// DEPLOY/ingress choice — a subdomain can rewrite `/v1/*` → CP `/api/v1/*`. So the
// version segment lives HERE in CP_URL, not hard-coded in the client, and the
// deployment fully controls the public URL shape. See docs/designs/api-versioning.md.
// (`/health` and the daemon `/daemon/ws` channel stay unversioned and are never
// reached from the console.)
//
// Resolved at RUNTIME (not build time) so one prebuilt image can target any CP via
// plain container env: the server injects CP_URL into window.__AC_ENV in the root
// layout (see lib/public-env), mirroring the Logto config. NEXT_PUBLIC_CP_URL is a
// build-time fallback for local dev/SSR. api.ts runs client-side, so __AC_ENV is set.
// NOTE: an overriding CP_URL MUST include the version path — a bare origin 404s.
function cpBase(): string {
  const runtime = typeof window !== 'undefined' ? window.__AC_ENV?.CP_URL : process.env.CP_URL
  return (runtime || process.env.NEXT_PUBLIC_CP_URL || 'http://localhost:8080/api/v1').replace(/\/+$/, '')
}

/** The CP REST base (`http(s)://…/api/v1`). Exposed so the API tab can show the exact
 *  mint endpoint the console calls. */
export function cpRestBase(): string {
  return cpBase()
}
// Static bearer token (e.g. CI/service token). When OIDC is configured the live
// per-user token from `@/lib/auth` takes precedence; with both unset the CP runs
// its zero-config devAuth stub (admits all) — the OSS no-auth default.
const TOKEN = process.env.NEXT_PUBLIC_CP_TOKEN

/** CP-minted webchat token + the relay ingress the browser should dial (shared-bot-relay §10). */
export interface WebchatTokenDto {
  token: string
  relayUrl: string
  conversationId: string
}

export interface WebchatMcpOperationDto {
  operationId: string
  toolName: string
  arguments: unknown
  status: 'awaiting_confirmation' | 'executing' | 'completed' | 'failed' | 'ambiguous' | 'stale'
  createdAt: string
  confirmationExpiresAt: string
  completedAt: string | null
  result?: unknown
}

const webchatMcpOperationPath = (orgId: string, agentId: string, conversationId: string) =>
  `/orgs/${encodeURIComponent(orgId)}/agents/${encodeURIComponent(agentId)}/webchat/${encodeURIComponent(conversationId)}/mcp-operations`

export function listWebchatMcpOperations(
  orgId: string,
  agentId: string,
  conversationId: string
): Promise<WebchatMcpOperationDto[]> {
  return apiGet<WebchatMcpOperationDto[]>(webchatMcpOperationPath(orgId, agentId, conversationId))
}

export function getWebchatMcpOperation(
  orgId: string,
  agentId: string,
  conversationId: string,
  operationId: string
): Promise<WebchatMcpOperationDto> {
  return apiGet<WebchatMcpOperationDto>(
    `${webchatMcpOperationPath(orgId, agentId, conversationId)}/${encodeURIComponent(operationId)}`
  )
}

export function decideWebchatMcpOperation(
  orgId: string,
  agentId: string,
  conversationId: string,
  operationId: string,
  decision: 'approve' | 'deny'
): Promise<WebchatMcpOperationDto> {
  return apiPost<WebchatMcpOperationDto>(
    `${webchatMcpOperationPath(orgId, agentId, conversationId)}/${encodeURIComponent(operationId)}/decision`,
    { decision }
  )
}

/**
 * Mint a short-lived webchat token for an agent (POST …/agents/:id/webchat/token).
 * The browser presents it to the relay pool to open a playground session; the relay
 * verifies it with the CP (`rc/verify(webchat-token)`) and bridges to the agent's daemon.
 * Throws `ApiError(503)` when the CP has no relay pool configured (`PUBLIC_RELAY_URL`).
 */
export function mintWebchatToken(orgId: string, agentId: string, conversationId?: string): Promise<WebchatTokenDto> {
  return apiPost<WebchatTokenDto>(
    `/orgs/${encodeURIComponent(orgId)}/agents/${encodeURIComponent(agentId)}/webchat/token`,
    conversationId ? { conversationId } : {}
  )
}

/**
 * Add a participant agent to an existing conversation (mid-conversation join,
 * webchat-multi-agents.md §3.1). Owner-only; 409 when the roster is full or a
 * participant's daemon lacks multi-agent webchat support. Idempotent.
 */
export function addWebchatConversationAgent(
  orgId: string,
  conversationId: string,
  agentId: string
): Promise<{ participants: Array<{ agentId: string; primary?: boolean }> }> {
  return apiPost(
    `/orgs/${encodeURIComponent(orgId)}/webchat/conversations/${encodeURIComponent(conversationId)}/agents`,
    { agentId }
  )
}

/**
 * Conversation-scoped mint (webchat-multi-agents.md §6.2): pass `agentIds` (first
 * entry = primary) to CREATE a conversation — the roster is fixed at creation — or
 * `conversationId` to resume one. Creating with more than one agent requires every
 * selected agent's daemon to support multi-agent webchat (409 otherwise).
 */
export function mintWebchatConversationToken(
  orgId: string,
  body: { conversationId?: string; agentIds?: string[] }
): Promise<WebchatTokenDto> {
  return apiPost<WebchatTokenDto>(`/orgs/${encodeURIComponent(orgId)}/webchat/conversations/token`, body)
}

/**
 * Session-targeted mint (webchat-cross-integration-continuation.md §6.5): mint a
 * token whose conversation adopts an existing chat-origin session, so the console
 * composer can continue it. 403/409 per the server-computed continuation gates.
 */
export function mintWebchatSessionToken(orgId: string, sessionId: string): Promise<WebchatTokenDto> {
  return apiPost<WebchatTokenDto>(
    `/orgs/${encodeURIComponent(orgId)}/sessions/${encodeURIComponent(sessionId)}/webchat/token`,
    {}
  )
}

/** `webchatWsUrl` for a session continuation: mint the session-target token, dial the relay. */
export async function webchatSessionWsUrl(orgId: string, sessionId: string): Promise<string> {
  const minted = await mintWebchatSessionToken(orgId, sessionId)
  const base = minted.relayUrl.replace(/^http/, 'ws').replace(/\/+$/, '')
  const params = new URLSearchParams({ token: minted.token, conversation_id: minted.conversationId })
  return `${base}/webchat?${params.toString()}`
}

/**
 * Build the client-facing webchat WebSocket URL for an agent (milestone A4: the relay
 * pool is the ONLY webchat path — the CP is never on the message hot path). Mint a
 * CP token, then dial `${relayUrl}/webchat?token=…&conversation_id=…`; content never
 * touches the CP. Throws `ApiError(503)` when no relay pool is configured.
 *
 * Pass `conversationId` to RESUME an existing conversation owned by the current user:
 * the CP authorizes that binding, and the relay lands the socket on the same daemon
 * session. Omit it to start fresh (the CP allocates and binds the id, echoed back in the
 * `ready` frame).
 */
export async function webchatWsUrl(
  orgId: string,
  agentId: string,
  conversationId?: string,
  agentIds?: string[]
): Promise<string> {
  // A multi-agent create (roster fixed at creation) goes through the
  // conversation-scoped mint. A RESUME also prefers it — the legacy per-agent
  // path authorizes only the conversation's PRIMARY agent, and a resume opened
  // from a member participant's session row would 404 there — falling back to
  // the legacy mint when the CP predates the conversation route.
  const minted =
    agentIds && agentIds.length > 1 && !conversationId
      ? await mintWebchatConversationToken(orgId, { agentIds })
      : conversationId
        ? await mintWebchatConversationToken(orgId, { conversationId }).catch((err) => {
            if (err instanceof ApiError && err.status === 404) return mintWebchatToken(orgId, agentId, conversationId)
            throw err
          })
        : await mintWebchatToken(orgId, agentId, conversationId)
  const base = minted.relayUrl.replace(/^http/, 'ws').replace(/\/+$/, '') // http→ws, https→wss
  const params = new URLSearchParams({ token: minted.token, conversation_id: minted.conversationId })
  return `${base}/webchat?${params.toString()}`
}

// ── wire DTOs (subset we consume) ───────────────────────────────────────────

// Who vouches for the workspace repository (git-workspace-model.md §5, read
// shape): provenance persisted at the last workspace write. Absent ⇒ anonymous.
export type AgentWorkspaceCredentialDto =
  { provider: 'github'; access: 'read' | 'write' } | { provider: 'gitlab'; access: 'read' | 'write'; projectId: string }

export type AgentWorkspaceDto =
  | { mode: 'scratch' }
  | {
      mode: 'git'
      worktree?: boolean
      gitRepo: string
      gitBranch?: string
      agentDir?: string
      credential?: AgentWorkspaceCredentialDto
    }

export interface ExternalMemoryRecallPolicy {
  mode: 'auto' | 'tool-only'
  topK: number
  maxBytes: number
  timeoutMs: number
}

/** Offline consolidation policy for the managed store (docs/designs/memory-dreaming.md). */
export interface MemoryDreamingConfig {
  enabled: boolean
  sessionWindow?: number // recent sessions to mine (1–100)
  schedule?: string // cron expression for scheduled dreams
  timezone?: string // IANA zone the schedule is evaluated in (absent ⇒ daemon local)
  instructions?: string // operator steering text (≤4096 chars)
  mineSkills?: boolean // also mine reusable procedures (D-3)
  autoAdopt?: boolean // adopt automatically without content review; absent defaults off
}

/** Managed-memory partitioning: `agent` (default) is one store per agent;
 *  `channel` gives each channel its own memory folder (#653). */
export type ManagedMemoryScope = 'agent' | 'channel'

export type AgentMemoryConfig =
  | { provider: 'managed'; autoDistill?: boolean; dreaming?: MemoryDreamingConfig; scope?: ManagedMemoryScope }
  | { provider: 'native' | 'none'; autoDistill?: boolean }
  | {
      provider: 'external'
      connectionId: string
      recall?: ExternalMemoryRecallPolicy
      capture?: { mode: 'turn' | 'manual' }
    }

export interface AgentDto {
  id: string
  orgId: string
  name: string // slug — lowercase [a-z0-9-], unique per org
  displayName: string | null // human-readable label; null when the slug is the only name
  builtin: boolean // built-in preset agent — labeled "builtin", not deletable
  icon: AgentIcon | null // console avatar; null ⇒ legacy default (runtime mark)
  iconUrl: string | null // resolved URL for an uploaded `image` icon; null otherwise
  description: string | null
  runtime: string | null // null ⇒ deferred exec config (an unplaced preset; set at placement)
  model: string | null
  reasoningEffort: string | null
  outputMode: string | null // platform output verbosity: low | medium | high; null when unset
  showFooter: boolean // render attribution/session footer; defaults true
  showStatusBar: boolean // render Slack's persistent session status row; defaults false
  fastMode: boolean | null // runtime fast mode; null when never set (runtime default)
  permissionMode: string | null // runtime permission/approval mode; null when never set
  allowRuntimeChangesInChat: boolean // explicit opt-in; defaults false
  pause: boolean | null // operational message-processing toggle; true ⇒ agent skips all messages; null ⇒ not paused
  env: Record<string, string> // the agent's OWN variables
  secretKeys: string[] // names of the agent's write-only secret env vars (values never returned)
  // Organization-owned rows assigned to THIS agent (organization-secrets-and-variables.md
  // §6). Absent on an older CP. Read-only in the agent surfaces; organization
  // variable values are ordinary config, organization secrets contribute names only.
  organizationVariables?: Array<{ key: string; value: string }>
  organizationSecretKeys?: string[]
  status: string
  // Placement is a TARGET: `set` names a member set through `setId` and carries no member id.
  placementKind?: PlacementKindValue
  placementReady?: boolean
  daemonId: string | null
  daemonName: string | null
  setId?: string | null
  workspace: AgentWorkspaceDto
  workspaceRepoId?: string | null
  capabilities: string[]
  mcpServers: string[] // daemon-configured MCP server names attached at session/new; empty ⇒ none
  skills: string[] // enabled shared-skills "<source>/<skill>" / "<source>/*"; empty ⇒ none
  managedSkills?: string[] // enabled centrally accepted immutable skill ids; absent on older CPs
  memory: AgentMemoryConfig | null // memory backend; null ⇒ managed default
  createdAt: string // ISO-8601
  createdBy: string | null // creator's userId (resolved to a name / "You" in the UI); null for daemon/CLI-created
  lastModifiedAt: string // ISO-8601
  lastModifiedBy: string | null // editor's userId (resolved to a name / "You" in the UI); null for daemon/CLI-created
  visibility: ResourceVisibility // 'org' = all members; 'restricted' = the complete sharedWith audience
  sharedWith: string[] // complete app_user.id audience when restricted
  canEdit: boolean // whether the caller may change non-sharing agent settings
  canManageSharing: boolean // whether the caller may change this resource's sharing
  callPolicy: AgentCallPolicy // which peer agents may call this agent as a sub-agent
  allowedCallerAgentIds: string[] // agent.id set, meaningful when callPolicy='selected'
  outboundPolicy: AgentCallPolicy // which peer agents this agent may discover/call
  allowedTargetAgentIds: string[] // agent.id set, meaningful when outboundPolicy='selected'
  introduceOnJoin: boolean // #536: self-introduce to peers on a genuine channel join
  runInSandbox: boolean // #642: persisted per-agent Run in sandbox preference
  sandboxSupported: boolean // #642: whether the placed daemon can provide an OS sandbox
  sandboxRequired: boolean // #642: whether daemon policy forces the effective value on
  hookKinds: HookKind[] // distinct kinds of enabled inbound triggers (list-view marks)
}

/** The `PUT /{agents,daemons,crons}/:id/sharing` request body. */
export interface SharingInput {
  visibility: ResourceVisibility
  sharedWith: string[] // app_user.id set (intersected with current org members server-side)
}

/** `PUT /agents/:id/call-policy` request body. */
export interface AgentCallPolicyInput {
  callPolicy: AgentCallPolicy
  allowedCallerAgentIds: string[]
  outboundPolicy: AgentCallPolicy
  allowedTargetAgentIds: string[]
}

// `/sessions` list row. The CP stores metadata snapshots reported by daemons
// (`event/session`) plus usage telemetry; the transcript is a separate on-demand
// daemon pull.
// Per-session token accounting (protocol `SessionUsage`). Token counts are
// session-cumulative; context/cost are the latest snapshot. All fields optional —
// a runtime that reports no usage yields absent fields.
export interface SessionUsageDto {
  reportedAt?: string
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

// Session-level visibility (docs/designs/session-visibility.md): 'private' rows are
// visible only to the session owner (no role override, org owners included); 'org'
// to every organization member. It is independent from the owning Agent's Team
// visibility and deliberately NOT ResourceVisibility ('org' | 'restricted').
export type SessionVisibility = 'private' | 'org' | 'external'
export type MutableSessionVisibility = 'private' | 'org'

export interface SessionDto {
  sessionId: string
  sessionKey: { platform: string; channel: string; thread?: string }
  agentId: string
  /** Session-scoped display projection; does not imply Agent access. */
  agentName?: string | null
  title: string | null
  status: string | null
  lastActivityAt: string | null
  usage: SessionUsageDto | null
  // Absent/null on a CP that predates session visibility — treated as 'org'
  // (matching the server-side backfill of legacy rows).
  visibility?: SessionVisibility | null
  externalProvider?: string | null
  externalResolution?: 'pending' | 'settled' | 'invalid' | null
  triggeredBy: string | null
  hookKind?: HookKind | null
  // Daemon-resolved display names; null until the daemon has resolved them.
  channelName: string | null
  triggeredByName: string | null
  // Platform-native deep link back to the source message/thread, captured or
  // derived by the daemon; null when unavailable.
  threadUrl: string | null
  // Execution-config snapshot the session actually ran with (daemon-reported;
  // daemonId is CP-stamped from the reporting WS connection). null ⇒ never
  // reported (legacy row): the console falls back to the owning agent's
  // current config. A null value on a reported row ⇒ the runtime's own default.
  runtime: string | null
  model: string | null
  effort: string | null
  fastMode: boolean | null
  permissionMode: string | null // effective session preset; Codex Auto is composite
  outputMode: string | null
  daemonId: string | null
  /** The shared-store pool set holding the rows; null ⇒ the recorder's private store. Absent on older CPs. */
  contentSetId?: string | null
  /** Retention GC (#485): when the owning daemon deleted this session's local
   *  content. Non-null ⇒ the transcript is gone for good. Absent on a CP that
   *  predates the field. */
  contentPurgedAt?: string | null
  workspaceIsolation?: 'shared' | 'session' | null
}

export interface SessionFacetsDto {
  agents: string[]
  /** Session-scoped labels keyed by facet Agent id; absent on older CPs. */
  agentNames?: Record<string, string>
  integrations: string[]
  channels: Array<{
    value: string
    platform: string
    integration: string
    name: string | null
    triggeredByName: string | null
  }>
  triggers: Array<{
    value: string
    integration: string
    name: string | null
    hookKind: HookKind | null
    githubRepoId: string | null
  }>
}

/** One grouped-list row (merged-conversation-view.md §5.2). */
export interface ConversationDto {
  /** §5.1 encoded key — null for singleton conversations. */
  key: string | null
  platform: string | null
  channel: string | null
  thread: string | null
  /** Current member sessions, representative (newest visible) first. Narrowed by
   *  an `agentId` filter — these are the rows the query asked for, not the
   *  conversation's membership. */
  sessions: SessionDto[]
  /** Every visible member's session id, the ones an `agentId` filter kept out of
   *  `sessions` included. Absent on a CP that predates the field, where the
   *  filtered rows are the best membership available. */
  memberSessionIds?: string[]
}

/** Why a provider failed closed — a CAUSE, never a target (no channel, user or
 *  workspace id ever appears here). `authorization` is the VIEWER's own linked
 *  identity; `app_authorization` is the installed app's grant, which only an
 *  administrator can restore. A CP that predates a variant simply never sends
 *  it, and an unrecognized one falls back to the generic notification. */
export interface SessionAccessIssue {
  provider: string
  region?: string
  reason: 'authorization' | 'app_authorization' | 'quota' | 'unavailable'
}

export interface SessionListPageDto {
  /** Present on `view=flat` responses (and older CPs). */
  sessions?: SessionDto[]
  /** Present on default (grouped) responses. */
  conversations?: ConversationDto[]
  total: number | null
  nextCursor: string | null
  /** Org-level "any session exists" boolean (first page only) — a bare boolean so the
   *  getting-started conversation step can be org-wide without exposing hidden rows. */
  orgHasSessions?: boolean
  accessSyncDegraded?: boolean
  accessIssues?: SessionAccessIssue[]
}

export interface SessionListFilters {
  /** One agent scopes to that agent's sessions; several ask for the conversations
   *  all of them took part in, and return each of their sessions in those threads. */
  agentId?: string | string[]
  platform?: string
  integration?: string
  channel?: string
  triggeredBy?: string
  githubRepoId?: string
}

export interface SessionFacets {
  agentIds: string[]
  agentNames: Record<string, string>
  integrations: string[]
  channels: Array<{ value: string; label: string; platform: string }>
  triggers: Array<{
    value: string
    name?: string
    platform: string
    hookKind?: HookKind
    githubRepoId?: string
  }>
}

export interface SessionListPage {
  sessions: Session[]
  total: number | null
  nextCursor: string | null
  orgHasSessions?: boolean
  accessSyncDegraded?: boolean
  accessIssues?: SessionAccessIssue[]
}

export interface SessionRelationDto {
  id: string
  agentId: string
  /** Session-scoped display projection; absent on older Control Planes. */
  agentName?: string | null
  platform: string
  title: string | null
}

export interface SessionDetailDto {
  id: string
  parentSession: SessionRelationDto | null
  /** Absent on a Control Plane that predates sibling navigation. */
  siblingSessions?: SessionRelationDto[]
  childSessions: SessionRelationDto[]
  agentId: string
  /** Session-scoped display projection; absent on older Control Planes. */
  agentName?: string | null
  platform: string | null
  channel: string | null
  thread: string | null
  title: string | null
  status: string | null
  lastActivityAt: string
  usage: SessionUsageDto | null
  triggeredBy: string | null
  /** Stable source kind for hook-backed sessions. Absent on older Control Planes. */
  hookKind?: HookKind | null
  channelName: string | null
  triggeredByName: string | null
  threadUrl: string | null
  runtime: string | null
  model: string | null
  effort: string | null
  fastMode: boolean | null
  permissionMode: string | null // effective session preset; Codex Auto is composite
  outputMode: string | null
  daemonId: string | null
  /** The shared-store pool set holding the rows; null ⇒ the recorder's private store. Absent on older CPs. */
  contentSetId?: string | null
  workspaceIsolation?: 'shared' | 'session' | null
  // Session visibility (docs/designs/session-visibility.md §5/§6). All three are
  // absent on a CP that predates the feature. `visibilityState` is the §5.1
  // tighten cutover: 'pending' until every affected daemon acked the change,
  // then 'applied'. `canChangeVisibility` is server-computed (the
  // identity-matched session owner only — roles grant nothing) — the client
  // never re-derives it.
  visibility?: SessionVisibility | null
  visibilityState?: 'pending' | 'applied' | null
  canChangeVisibility?: boolean | null
  /** Server-computed continuation gate (webchat-cross-integration-continuation.md
   *  §6.5): whether THIS caller may continue the session from the console
   *  composer. Absent on a CP that predates the feature (⇒ read-only). */
  canContinue?: boolean | null
  continuationUnavailableReason?:
    'unauthorized' | 'content_purged' | 'unsupported_platform' | 'agent_moved' | 'daemon_offline' | 'unavailable' | null
  externalProvider?: string | null
  externalResolution?: 'pending' | 'settled' | 'invalid' | null
  /** Actual source gateway for Feishu/Lark external sessions. Absent on older CPs. */
  feishuRegion?: 'feishu' | 'lark' | null
  accessSyncDegraded?: boolean
  accessIssues?: SessionAccessIssue[]
  /** Multi-agent webchat conversation roster, in pick order. Null for single-agent
   *  conversations and other platforms; absent on a CP that predates the feature.
   *  `name` is null only when no Agent display record can be resolved. */
  participants?: Array<{ agentId: string; name: string | null; primary: boolean }> | null
  /** Durable workspace/tenant scope (merged-conversation-view.md §5.1) — part of
   *  the conversation key. Absent on a CP that predates the feature. */
  tenantScope?: string | null
  /** Retention GC (#485): when the owning daemon deleted this session's local
   *  content (and any per-session worktree), with the reason it reported. Non-null
   *  ⇒ `/messages` has nothing left to return, ever. Absent on older CPs. */
  contentPurgedAt?: string | null
  contentPurgedReason?: string | null
}

// The full ACP tool body (protocol `ToolBody`), transported as a JSON STRING in
// `SessionMessageDto.body`. Mirrors the protocol schema; free-form fields stay
// opaque (`unknown`) — no reshaping. Kept structural so web needn't depend on
// the protocol package's zod runtime.
export interface ToolBody {
  toolCallId: string
  kind?: string // ACP ToolKind: read|edit|delete|move|search|execute|think|fetch|switch_mode|other
  status?: string // ACP ToolCallStatus: pending|in_progress|completed|failed
  rawInput?: unknown
  rawOutput?: unknown
  content?: unknown[] // ACP ToolCallContent[] (content|diff|terminal blocks)
  locations?: { path: string; line?: number }[]
  truncated?: boolean // daemon capped the stored body at write time
}

// The agent's task list for one turn (protocol `PlanBody`), transported as a JSON
// STRING in `SessionMessageDto.body` on a `kind === 'plan'` row. An ACP plan update
// carries the whole list every time, so one row per turn holds the latest snapshot.
export interface PlanBody {
  entries: { content: string; status: string; priority?: string }[]
}

// One transcript message (`GET /sessions/:id/messages`, proxied live from the
// owning daemon). `kind` is the daemon transcript kind: text | tool | reasoning | plan.
// `body` carries a ToolBody on a tool row and a PlanBody on a plan row; it is absent
// on text/reasoning rows, and on plan rows from a daemon or CP predating them.
export interface SessionMessageDto {
  seq: number
  sender: string
  senderName?: string // daemon-resolved display name; absent if unknown
  senderAvatarUrl?: string // public provider-hosted profile image
  trustedAgentBot?: boolean // daemon-verified AgentConnect Slack bot provenance
  ts: string
  /** Normalized chronological coordinate (epoch µs) from the daemon's event-time
   *  axis — provider-authoritative when the platform supplied its send time. */
  eventTimeUs?: number
  /** Canonical webchat post identity (merged-conversation-view.md §6) — identical
   *  on every participant's copy; absent on non-webchat and pre-upgrade rows. */
  postId?: string
  kind: string
  text: string
  attachments?: SessionImage[]
  toolCallId?: string // ties the row to its full body (session/tool-body key)
  toolStatus?: string // ACP ToolCallStatus — drives the console status badge
  toolKind?: string // ACP ToolKind — drives the console icon
  body?: string // JSON.stringify(ToolBody); may be a truncated-but-VALID-JSON preview
  bodyTruncated?: boolean // preview was shrunk for the frame; full body via fetchToolBody
  bodyBytes?: number // full (untruncated) body byte length
}

export interface SessionHistoryDto {
  sessionId: string
  messages: SessionMessageDto[]
  nextCursor: string | null
  liveCursor: string | null
  liveMore: boolean
}

// A scheduled trigger (`/crons`): every `schedule` tick the owning agent is
// prompted with `trigger`. The CP owns the definition; the daemon fires it.
// `targetChannel` is optional output routing (the trigger is posted there and
// the agent replies in its thread); null ⇒ headless fire. `agentId` is only
// null when the agent was deleted (orphaned — inert until re-assigned).
export interface CronDto {
  id: string
  orgId: string
  agentId: string | null
  name: string | null // console display name; null for legacy/CLI rows
  schedule: string
  timezone: string
  targetPlatform: string // §6.8 open id — derived from the anchor integration
  targetChannel: string | null
  targetIntegrationId: string | null // null ⇒ legacy row / integration uninstalled
  trigger: string
  enabled: boolean
  lastRunAt: string | null
  createdBy: string | null // creator's userId (resolved to a name / "You" in the UI); null for CLI/legacy
  createdAt: string // ISO-8601
  lastModifiedBy: string | null // editor's userId (resolved to a name / "You" in the UI); null for CLI/legacy
  lastModifiedAt: string // ISO-8601
  visibility: ResourceVisibility
  sharedWith: string[]
  canEdit: boolean
  canManageSharing: boolean
}

// PUT /crons/:id body (idempotent upsert keyed on the cron UUID).
export interface UpsertCronInput {
  agentId: string // the agent this cron drives — required
  name?: string // console display name
  schedule: string
  timezone?: string // omitted ⇒ UTC on create, the schedule's existing zone on an edit
  targetPlatform: string // §6.8 open id — derived from the anchor integration
  targetChannel?: string // optional — absent ⇒ headless fire
  targetIntegrationId?: string // the agent integration posting the anchor (platform derives from it)
  trigger: string
  enabled: boolean
  visibility?: ResourceVisibility // initial visibility — honored only on create (a fresh id)
  sharedWith?: string[] // initial share set (create only; intersected with members server-side)
}

// POST /integrations body — install a Slack connection from the console. Bound to
// one owning agent (`agentId`); that agent's daemon opens the Socket Mode socket.
// The bot identity comes one of two ways: reuse an existing FREE bot (`botId` —
// the CP already holds its tokens), or register a new bot from pasted tokens
// (`slack`). The CP stores the tokens (currently plaintext-in-PG behind the
// BotSecret store seam) and pushes them to the daemon — the console posts them
// once and never gets them back. Socket Mode needs only the bot token (xoxb-) +
// app-level token (xapp-); no signing secret / app id. The owning agent must
// already be placed on a daemon (the CP replies 409 otherwise).
// Fields shared by every platform's create/reuse request.
interface CreateIntegrationBase {
  // Optional: you're connecting a bot that already has a name, so the console
  // doesn't force one. When omitted the CP derives it from the platform (Slack
  // auth.test / Telegram getMe / Discord). Ignored when reusing an existing bot.
  name?: string
  agentId: string
  /** Reuse an existing bot. A classic bot must be free; a SHAREABLE bot may already
   *  serve other agents (exclusive with the token block only for a fresh bot). */
  botId?: string
  /** Opt the (new or reused) bot into shared mode — many agents, inbound via a relay. */
  shareable?: boolean
}

// Register/reuse a platform integration. Discriminated on `platform`: each platform
// carries its own credential block. Slack and Feishu additionally carry a `transport`:
//   - `socket` — Socket Mode; the credential block is bot token (xoxb-) + app-level
//     token (xapp-) for Slack, or Long Connection for Feishu. The daemon opens it.
//   - `http` — Events API via the relay; the credential block is bot token (xoxb-) +
//     signing secret (no xapp-) for Slack, or callback verification values for Feishu.
// The CP maps socket→IntegrationSlackConfig.mode:'direct', http→'shared' for the
// daemon. Telegram/Discord each take a single bot token — no transport concept.
export type CreateIntegrationInput =
  | (CreateIntegrationBase & {
      platform: 'slack'
      transport: 'socket' | 'http'
      slack?: { botToken: string; appToken: string } | { botToken: string; signingSecret: string }
    })
  | (CreateIntegrationBase & { platform: 'telegram'; telegram?: { botToken: string } })
  | (CreateIntegrationBase & { platform: 'discord'; discord?: { botToken: string } })
  | (CreateIntegrationBase & {
      platform: 'feishu'
      transport?: 'socket' | 'http'
      feishu?: {
        appId: string
        appSecret: string
        region?: 'feishu' | 'lark'
        verificationToken?: string
        encryptKey?: string
      }
    })
  // Linear carries no credential block from the console: a workspace bot only ever
  // exists after the OAuth callback minted it, so the only create shape here is
  // "add this agent as a member of a connected workspace" (linear-integration.md §7.1).
  | (CreateIntegrationBase & { platform: 'linear'; transport?: 'http'; botId: string })

export interface TelegramBotCheckDto {
  status: 'ready' | 'privacy_enabled' | 'invalid' | 'unreachable'
}

// ── Slack config-token auto-install funnel (docs/designs/slack-install-smoothing.md §Tier B) ──
// The CP creates the Slack app from a manifest (using the operator's App
// Configuration Token), the user approves an OAuth install in the browser, and
// the CP obtains the bot token itself — so the operator pastes only the
// app-level token (still UI-minted; no Slack API for it) at the end.

/** `POST /integrations/slack/app` body — start the auto-install. The config token
 *  is the CALLER's own stored one, resolved server-side, not passed here. */
export interface StartSlackInstallInput {
  agentId: string
  name?: string
  // Which transport to build the auto-created app for. `http` sets
  // socket_mode_enabled:false + the relay request_urls server-side; `socket`
  // keeps the Socket Mode shape (and the app-level-token paste step).
  transport: 'socket' | 'http'
  // (The `shareable` choice is sent to finalize, not here.)
}
/** Response — the new app id + the browser OAuth install link (no tokens). */
export interface SlackInstallStartDto {
  installId: string
  appId: string
  installUrl: string
  // The transport the app was created as — the modal pins its later steps to this.
  transport: 'socket' | 'http'
}
/** `GET /integrations/slack/app/:id` — funnel progress (no tokens). */
export interface SlackInstallStatusDto {
  installId: string
  appId: string
  status: 'awaiting_oauth' | 'bot_ready'
}

/** Feishu/Lark one-click self-built app registration. The browser receives only
 * the provider authorization URL; App ID/Secret are finalized server-side. */
export interface StartFeishuRegistrationInput {
  agentId: string
  name?: string
  region?: 'feishu' | 'lark'
  transport?: 'socket' | 'http'
}
export interface FeishuRegistrationStartDto {
  id: string
  authorizationUrl: string
  expiresAt: string
  transport: 'socket' | 'http'
}
export interface FeishuRegistrationStatusDto {
  id: string
  status: 'pending' | 'completed' | 'failed'
  failureReason:
    'denied' | 'expired' | 'agent_unavailable' | 'invalid_credentials' | 'org_mismatch' | 'setup_failed' | null
  integrationId: string | null
  expiresAt: string
}

/** `GET /slack/config` — the CALLER's own stored-config status (drives the create
 *  modal's forced auto/manual mode). Per-user. NEVER carries the token. */
export interface SlackConfigDto {
  configured: boolean // the signed-in caller has stored their own token
  durable: boolean // a refresh token is stored ⇒ the pair auto-rotates and never expires
  funnelEnabled: boolean // this deployment supports auto-install (public callback)
  autoAvailable: boolean // funnelEnabled AND the stored token is usable right now
  accessExpiresAt: string | null // ISO expiry of the stored access token (drives the expires/expired copy)
  // The sole signal the console has for the "http default vs socket-only" rule:
  relayAvailable: boolean // PUBLIC_RELAY_URL set AND ≥1 relay connected
  relayPublicUrl: string | null // https(s) LB URL for the http manifest request_url; null when unavailable
  // The platform-published "Add to Slack" app is installable on this deployment
  // (SLACK_PLATFORM_* + public callback + relay). Missing (older CP) ⇒ false.
  platformInstallAvailable?: boolean
  updatedAt: string | null
}

/** `POST /integrations/slack/platform-install` — a pending platform-app install:
 *  the state id + the slack.com authorize URL the console opens in a popup. */
export interface SlackPlatformInstallDto {
  id: string
  installUrl: string
}
/** `GET /integrations/slack/platform-install/:id` — the completion signal the modal
 *  polls while the authorize tab is open. */
export interface SlackPlatformInstallStatusDto {
  id: string
  status: 'pending' | 'completed' | 'failed'
  failureReason: string | null
  /** The required bot scopes Slack withheld, when `failureReason` is
   *  'missing_scopes'. Empty on every other outcome. */
  missingScopes: string[]
  botId: string | null
}
/** `PUT /slack/config` body — the caller's own Slack App Configuration token. The
 *  access (config) token is required; the refresh token is optional (adds durability). */
export interface SlackConfigInput {
  accessToken: string // xoxe.xoxp-…
  refreshToken?: string // xoxe-… — optional; omit to store an access-only (expiring) token
}

// How the bot activates in one conversation: not at all ('off' — conversation
// gating for restricted agents), only when @-mentioned, or on any message.
export type ChannelTrigger = 'off' | 'mention' | 'any'

// One conversation the integration's bot is in (daemon-reported) + its trigger
// choice. kind 'im' rows are DM conversations and 'mpim' rows are Slack group DMs;
// both are observed rather than enumerable and appear for every agent visibility.
export interface IntegrationChannelDto {
  channelId: string
  name: string | null // "deploys" without the hash (or DM counterpart); null if lookup failed
  spaceId: string | null // enclosing Discord server id — the identity (names are not unique)
  space: string | null // that server's display name; null elsewhere and until resolved
  isPrivate: boolean
  kind: 'channel' | 'im' | 'mpim'
  trigger: ChannelTrigger
  agentId: string | null // effective shared-conversation owner; null before convergence / when not applicable
}

// `/integrations` list/create row — control-plane metadata only, NEVER tokens.
export interface IntegrationDto {
  id: string
  name: string
  platform: string
  agentId: string
  botId: string
  status: string
  region?: 'feishu' | 'lark' // feishu integrations only: which open-platform gateway
  createdAt: string // ISO-8601
  channels: IntegrationChannelDto[]
}

// `/bots` row — a durable bot identity. It outlives the integration installing
// it: uninstall frees it, and the Add-integration picker offers it for reuse.
// Metadata only, NEVER tokens.
export interface BotDto {
  id: string
  name: string
  platform: string
  prebuilt: boolean
  slackAppId: string | null // Slack app id (A…) — deep-links to api.slack.com/apps/{id}
  discordAppId: string | null // Discord application (client) id — builds the "Add to Discord" invite URL
  feishuAppId?: string | null // Lark/Feishu app id (cli_…) — optional while older control planes roll out
  feishuRegion?: 'feishu' | 'lark' | null // matching developer-console region; legacy null ⇒ Feishu
  createdBy: string | null // creator's userId (resolved to a name / "You" in the UI); null for prebuilt/CLI
  // Inbound transport: 'socket' = daemon-owned long connection, 'http' = public
  // callbacks. Only a Slack http bot may be shared. Missing (older CP) ⇒ socket.
  transport: 'socket' | 'http'
  shareable: boolean // shared-bot opt-in — when true it may serve many agents at once
  inUseByAgentId: string | null // classic-bot occupancy; ALWAYS null for a shareable bot
  agentIds: string[] // every agent currently installed on the bot (a shared bot may have many)
  lastUsedAt: string | null // ISO-8601; stamped when last freed; null ⇒ never used
  freedFromAgent: string | null // agent it was last freed from ("freed from support-bot")
  teamId?: string | null // Slack workspace id (T…) — platform-app installs only
  workspaceId?: string | null // external workspace identity used only for Console grouping
  workspaceName?: string | null // human-readable external workspace label
  revokedAt?: string | null // workspace uninstalled the app / revoked tokens; null ⇒ live
  createdAt: string // ISO-8601
}

export interface SlackBotRefreshDto {
  manifest: 'synced' | 'manual_update_required' | 'unknown'
  authorization: 'current' | 'reinstall_required' | 'invalid' | 'app_mismatch' | 'unknown'
  missingScopes: string[]
  settingsUrl: string
  manifestUrl: string
  /** Slack's OAuth & Permissions editor for changing requested scopes. */
  permissionsUrl: string
  /** Slack's direct install/reinstall flow for the app. */
  reinstallUrl: string
}

// PATCH /agents/:id body — at least one field. `null` clears description/model/displayName.
export interface UpdateAgentInput {
  name?: string // slug — the CP rejects anything but ^[a-z0-9]+(-[a-z0-9]+)*$
  displayName?: string | null
  icon?: AgentIcon | null // null clears back to the runtime-mark default
  description?: string | null
  runtime?: string
  model?: string | null
  reasoningEffort?: string | null
  outputMode?: string | null
  showFooter?: boolean
  showStatusBar?: boolean
  fastMode?: boolean | null
  permissionMode?: string | null
  allowRuntimeChangesInChat?: boolean
  /** Operational message-processing toggle; true ⇒ agent skips all messages; null clears. */
  pause?: boolean | null
  /** #536: self-introduce to peers on a genuine channel join (default off). */
  introduceOnJoin?: boolean
  /** #642: confine the agent process to its agent dir via an OS sandbox (default off). */
  runInSandbox?: boolean
  /** Widen an existing App-backed GitHub workspace from read to write. */
  gitAccess?: 'write'
  /** Repository-relative ACP working directory; null selects the repository root. */
  agentDir?: string | null
  /** Replaced wholesale when provided; null clears all variables. */
  env?: Record<string, string> | null
  /** Write-only secrets, merged key-by-key: a string sets/replaces a secret, null
   *  deletes it, an omitted key is left untouched. Values are never returned. */
  secrets?: Record<string, string | null>
  capabilities?: string[]
  /** Replaced wholesale when provided; [] clears all servers. */
  mcpServers?: string[]
  /** Enabled shared-skills; replaced wholesale when provided; [] clears all. */
  skills?: string[]
  /** Enabled centrally accepted managed skill ids; replaced wholesale. */
  managedSkills?: string[]
  /** Memory backend; null clears (revert to managed default). */
  memory?: AgentMemoryConfig | null
}

/** The ONE workspace input shape, shared verbatim by agent creation and workspace
 *  replacement (git-workspace-model.md §5). Provenance is server-derived from the
 *  address; `access` is a request (absent takes the highest tier the target carries:
 *  write where credentials are minted for it, read for an anonymous checkout). */
export type AgentWorkspaceInput =
  | { mode: 'scratch' }
  | {
      mode: 'git'
      /** Full cloneable https/ssh address; bare `owner/repo` is GitHub-only sugar. */
      gitRepo: string
      /** Absent lets the server use the target's current default branch. */
      gitBranch?: string
      agentDir?: string
      worktree?: boolean
      access?: 'read' | 'write'
    }

export type SetAgentWorkspaceInput = AgentWorkspaceInput

export interface DaemonCapabilitiesDto {
  platforms: string[]
  runtimes: string[]
  acp: boolean
  features: string[]
}

// A runtime's discovered model × config capability matrix (protocol
// `RuntimeModelCatalog` — one shape on the wire, in the CP's JSONB column, and
// here). `efforts: []` = the model has no effort selector; absent = not yet
// discovered. `fastMode` mirrors whether the fast toggle appears for the model.
export interface RuntimeModelCatalogDto {
  models: Array<{
    id: string
    name?: string
    efforts?: Array<{ value: string; name?: string; description?: string }>
    defaultEffort?: string
    fastMode?: boolean
  }>
  defaultModel?: string
  permissionModes?: Array<{ value: string; name?: string; description?: string }>
  defaultPermissionMode?: string
  source: 'native' | 'acp'
  observedAt: string
}

// Observed runtime capability the daemon reports (`facts/runtime-profile`). `models`
// is the list the console offers per (machine, runtime) in the create-agent picker.
export interface RuntimeProfileDto {
  runtime: string
  version: string
  models: string[]
  contextWindow: number | null
  acpSupport: string
  acpProtocolVersion: number | null
  toolCalling: boolean
  // MCP transports the runtime accepts at session/new (from ACP initialize);
  // null ⇒ not probed (older daemon) ⇒ assume stdio-only.
  mcpCapabilities: { http: boolean; sse: boolean } | null
  // Provenance of `models[]`: 'cached' = hydrated from the daemon's last-good
  // local cache (no live probe this process yet); 'probed' = confirmed live.
  // null/absent (older daemon) ⇒ probed semantics.
  modelsSource?: 'cached' | 'probed' | null
  // Discovered model × config capability matrix; null/absent ⇒ this daemon has
  // no catalog for the runtime — the console falls back to its static tables.
  modelCatalog?: RuntimeModelCatalogDto | null
  // The daemon's last probe was rejected with the ACP auth-required error: the
  // runtime is installed but needs a login on the daemon host. Absent (older
  // CP) ⇒ no warning.
  authRequired?: boolean
}

// One daemon-configured MCP server (name + transport), reported in the
// facts/daemon-runtimes snapshot (protocol `FactsMcpServer`). Derived from
// daemon config — not probed.
export interface McpServerDto {
  name: string
  transport: 'stdio' | 'http' | 'sse'
}

/** `GET /daemons` — the liveness half, without anything that only moves on connect/upgrade. */
export type DaemonFleetDto = Omit<DaemonViewDto, 'capabilities' | 'runtimeProfiles' | 'mcpServers'>

/** `GET /daemons/capabilities` — what each daemon can run. Each catalog keeps its
 *  runtime-level answers (`defaultModel`, `permissionModes`) so the read-only model and
 *  permission labels resolve for every agent, but its `models` matrix is empty: that part
 *  is 75% of a catalog and only a surface configuring one daemon reads it. */
export interface DaemonCapabilityDto {
  daemonId: string
  capabilities: DaemonCapabilitiesDto
  runtimeProfiles: RuntimeProfileDto[]
  mcpServers: McpServerDto[]
}

/** `GET /daemons/:id` — both halves, catalog included. */
export interface DaemonViewDto {
  daemonId: string
  host: string | null
  name: string | null
  agentVersion: string | null
  /** Deployment's daemon release channel (npm dist-tag, e.g. `latest`/`rc`). */
  releaseChannel: string
  /** Latest daemon version published in `releaseChannel`; null when unresolved. */
  latestVersion: string | null
  /** Every published dist-tag version (upgrade picker options), newest-first. */
  availableVersions: string[]
  /** The most recent CP-commanded restart/upgrade op (cli-daemon-split.md §7), or null.
   *  `status` is expiry-projected server-side. The console tracks its OWN command by `id`. */
  lifecycleOp: DaemonLifecycleOpDto | null
  status: string
  /** An install-wide pool member — managed infrastructure shared by every org, one row
   *  per pool member Pod. Absent from an older CP ⇒ treat as a plain daemon. */
  cloud?: boolean
  /** The member set this daemon is in, or null when it owns its agents outright. */
  memberSetId?: string | null
  health: string
  capabilities: DaemonCapabilitiesDto
  runtimeProfiles: RuntimeProfileDto[]
  mcpServers: McpServerDto[]
  load: { cpu: number; mem: number; agents: number } | null
  sessionEpoch: number
  maxAgents: number
  activeSessions: number
  lastSeenAt: string | null
  createdAt: string // ISO-8601
  createdBy: string | null // creator's userId (resolved to a name / "You" in the UI); null for CLI/self-registered
  lastModifiedAt: string // ISO-8601
  lastModifiedBy: string | null // editor's userId (resolved to a name / "You" in the UI); null for CLI/self-registered
  /** How long the daemon keeps FINISHED sessions in its local store before its
   *  retention sweep deletes them ("Expire sessions"); 'never' disables the sweep. */
  sessionRetention: DaemonSessionRetention
  visibility: ResourceVisibility
  sharedWith: string[]
  canEdit: boolean
  canManageSharing: boolean
  /** Whether the caller may command restart/upgrade on this daemon (org owner only). */
  canManageLifecycle: boolean
}

/** The console-settable "Expire sessions" window (PATCH /daemons/:id):
 *  'never' disables the sweep, otherwise an integer day count as '<n>d'. */
export type DaemonSessionRetention = 'never' | `${number}d`

/** A CP-commanded daemon restart/upgrade (cli-daemon-split.md §7). Returned by the
 *  upgrade/restart POSTs and embedded in each daemon's read model as its latest op. */
export interface DaemonLifecycleOpDto {
  id: string
  op: 'restart' | 'upgrade'
  status: 'pending' | 'succeeded' | 'failed'
  targetVersion: string | null
  outcome: string | null
}

export interface CreateAgentInput {
  /** The placement TARGET. `pool` is the API sugar for the install-wide member set; `set` names
   *  one of the org's own groups through `setId`; omitting both pins the agent to `daemonId`. */
  placementKind?: 'pool' | 'set'
  /** The group a `set` placement names (daemon-groups.md §2). */
  setId?: string
  name: string // slug — the CP rejects anything but ^[a-z0-9]+(-[a-z0-9]+)*$
  displayName?: string
  icon?: AgentIcon // absent ⇒ the CP assigns a random glyph+color
  runtime: string
  description?: string
  model?: string
  reasoningEffort?: string
  outputMode?: string // platform output verbosity: low | medium | high
  showFooter?: boolean
  showStatusBar?: boolean
  fastMode?: boolean // runtime fast mode toggle
  permissionMode?: string // runtime permission/approval mode
  allowRuntimeChangesInChat?: boolean
  pause?: boolean // operational message-processing toggle; true ⇒ agent skips all messages
  env?: Record<string, string>
  secrets?: Record<string, string> // write-only secret env vars (initial set)
  /** The owning daemon, if chosen at create. */
  daemonId?: string
  /** Where it runs; absent ⇒ the CP defaults to scratch. Immutable after create. */
  workspace?: AgentWorkspaceInput
  capabilities?: string[]
  /** Daemon-configured MCP server names to attach at session/new; absent ⇒ none. */
  mcpServers?: string[]
  /** Enabled shared-skills "<source>/<skill>" / "<source>/*"; absent ⇒ none. */
  skills?: string[]
  /** Enabled centrally accepted managed skill ids; absent ⇒ none. */
  managedSkills?: string[]
  /** Memory backend; absent ⇒ managed default. */
  memory?: AgentMemoryConfig
  /** Request an OS sandbox for this agent; absent ⇒ false unless daemon policy requires it. */
  runInSandbox?: boolean
  /** Initial visibility (absent ⇒ 'org'); sharedWith is intersected with org members. */
  visibility?: ResourceVisibility
  sharedWith?: string[]
  /** Initial agent-call policy (absent ⇒ the organization's default); allowedCallerAgentIds is
   *  intersected with visible same-org peers and only bites when 'selected'. */
  callPolicy?: AgentCallPolicy
  allowedCallerAgentIds?: string[]
  /** Outbound half (absent ⇒ the organization's default); intersected with visible peers server-side. */
  outboundPolicy?: AgentCallPolicy
  allowedTargetAgentIds?: string[]
}

// Response of `POST /daemons/token`: a fresh daemon identity + its one-time API key
// and the copy-paste command that starts a daemon pointed at this CP. The full
// `apiKey` is returned exactly once (not retrievable later); `displayTail` is the
// non-secret label. The console polls `GET /daemons` for `daemonId` to confirm the
// daemon came online.
export interface DaemonConnectDto {
  daemonId: string
  apiKey: string
  displayTail: string
  command: string
}

// One org member (`/members`) — the membership joined with its user. Members
// appear via JIT provisioning at first OIDC sign-in, or when an owner adds
// them by email (POST /members — claimed at their first sign-in).
export type MemberRole = 'owner' | 'collaborator' | 'viewer'

export interface MemberDto {
  userId: string
  email: string | null // real email; null while the CP only knows a synthetic placeholder
  name: string | null // displayName
  picture: string | null // custom uploaded profile photo, or the OIDC `picture` fallback
  role: MemberRole
  isCurrentUser: boolean
  joinedAt: string // ISO-8601 — when they joined THIS org
}

// What leaving / removing a member would do to Selected audiences.
export type VisibilityResourceKind = 'agent' | 'daemon' | 'cron' | 'mcpProvider' | 'skillSource'

export interface MemberRemovalPreviewDto {
  replacement: MemberDto | null // null only when removal is refused (final organization owner)
  resources: { kind: VisibilityResourceKind; selected: number; reassigned: number }[]
}

export interface OrgInviteLinkDto {
  id: string
  displayTail: string
  status: 'active' | 'expired' | 'revoked'
  expiresAt: string
  revokedAt: string | null
  createdAt: string
}

export interface CreatedOrgInviteLinkDto extends OrgInviteLinkDto {
  /** One-time plaintext used to assemble `/join/<token>` in the current browser. */
  token: string
}

export interface AcceptedOrgInviteLinkDto {
  status: 'accepted' | 'already_member'
  org: { id: string; slug: string; name: string | null }
}

export const ROLE_LABELS: Record<MemberRole, string> = {
  owner: 'Owner',
  collaborator: 'Collaborator',
  viewer: 'Viewer'
}

// One org from the caller's perspective (`/orgs`) — the console picker/Settings.
export interface OrgDto {
  id: string
  /** Optional display name; null ⇒ show `slug` instead. */
  name: string | null
  slug: string
  /** Console avatar descriptor; null ⇒ generated default. `image` carries no url —
   *  reassemble via withIconUrl(o.icon, o.iconUrl) at render sites. */
  icon: AgentIcon | null
  /** Resolved URL for an uploaded `image` org icon; null otherwise. */
  iconUrl: string | null
  /** Default applied to both directional policies of newly created agents. */
  defaultAgentVisibility?: AgentCallPolicy
  /** Whether the object store is configured — the console shows Upload only when true. */
  iconUploadEnabled: boolean
  /** The signed-in user's role in this org. */
  role: MemberRole
  memberCount: number
  /** Registered daemons in this org (any status); undefined on older CPs. */
  daemonCount?: number
  /** Onboarding wizard done (finish OR skip); undefined on older CPs ⇒ treat as done. */
  onboardingCompleted?: boolean
  /** Getting-started tutorial position: checklist steps passed (completed or skipped). */
  gettingStartedStep?: number
  createdAt: string // ISO-8601
}

// ── active org ────────────────────────────────────────────────────────────────
// The CP API is path-scoped: every org resource lives under `/orgs/{orgId}/…`.
// The OrgProvider resolves the URL's org slug to an id and hands it here; the
// endpoint helpers below prefix their paths with it.
let apiOrgId: string | null = null

/** Set by the OrgProvider whenever the active org (from the URL) resolves. */
export function setApiOrgId(orgId: string | null): void {
  if (apiOrgId !== orgId) invalidateGithubRepoRosterCache()
  apiOrgId = orgId
}

/** The active org's API prefix. Org-scoped calls before the org resolves are a
 *  programming error (data pulls wait for the org context) — fail loudly. */
function orgBase(orgId?: string): string {
  const resolved = orgId ?? apiOrgId
  if (!resolved) throw new ApiError('no active organization', 0)
  return `/orgs/${encodeURIComponent(resolved)}`
}

// A daemon's API key in the console list (never the secret or hash).
export interface ApiKeyDto {
  id: string
  displayTail: string
  name: string | null
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
}

// `POST /daemons/:id/keys` response: the one-time plaintext + a ready-to-run command.
export interface MintedKeyDto {
  apiKeyId: string
  apiKey: string
  displayTail: string
  command: string
}

// A personal (user) API key in the profile list — carries the org it acts in
// (a user's keys span every org they belong to). Never the secret or hash.
export interface UserApiKeyDto {
  id: string
  displayTail: string
  name: string | null
  orgId: string
  orgSlug: string
  orgName: string | null // null ⇒ fall back to the slug
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
}

// `POST /me/keys` response: the one-time plaintext (shown once, never retrievable).
export interface MintedUserKeyDto {
  apiKeyId: string
  apiKey: string
  displayTail: string
}

// ── fetch helpers ───────────────────────────────────────────────────────────
async function authHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
  const h: Record<string, string> = { ...extra }
  // Live OIDC token (when configured) wins; otherwise fall back to the static one.
  const token = (await getToken()) ?? TOKEN
  if (token) h.authorization = `Bearer ${token}`
  // Forward the signed-in user's real email. The CP verifies a resource access
  // token that omits the email claim, so it uses this display-only hint to record
  // (and upgrade) the creator's email on the user row — which the members list then
  // resolves to a display name (creator rows key on userId, not this email).
  const email = (await getUser())?.email
  if (email) h['x-ac-user-email'] = email
  // The signed id token — a VERIFIABLE identity hint. Logto access tokens for an
  // API resource omit the email claim, so the CP checks this token's signature
  // (same issuer) and takes email/name from it for JIT provisioning; the plain
  // x-ac-user-email header above stays display-only.
  const idToken = await getIdTokenRaw()
  if (idToken) h['x-ac-id-token'] = idToken
  return h
}

function bearerToken(headers: Record<string, string>): string | undefined {
  return headers.authorization?.replace(/^Bearer\s+/i, '')
}

async function responseCode(response: Response): Promise<string | undefined> {
  const body = (await response
    .clone()
    .json()
    .catch(() => ({}))) as Record<string, unknown>
  return typeof body.code === 'string' ? body.code : undefined
}

/** Retry one CP request with a forced Logto token refresh. A second 401 means
 * the browser session cannot recover, so send it back through sign-in instead
 * of leaving individual panels on a Retry button that replays the same token. */
async function authenticatedFetch(
  path: string,
  init: Omit<RequestInit, 'headers'> = {},
  extraHeaders?: Record<string, string>
): Promise<Response> {
  const url = `${cpBase()}${path}`
  const firstHeaders = await authHeaders(extraHeaders)
  const first = await fetch(url, { ...init, headers: firstHeaders })
  if (first.status !== 401 || (await responseCode(first)) === 'ACCOUNT_GONE') return first

  const refreshed = await refreshTokenAfterUnauthorized(bearerToken(firstHeaders))
  if (!refreshed) {
    await redirectExpiredSession()
    return first
  }

  const retried = await fetch(url, { ...init, headers: await authHeaders(extraHeaders) })
  if (retried.status === 401 && (await responseCode(retried)) !== 'ACCOUNT_GONE') await redirectExpiredSession()
  return retried
}

async function apiGet<T>(path: string, init?: Omit<RequestInit, 'headers'>): Promise<T> {
  const res = await authenticatedFetch(path, { cache: 'no-store', ...init })
  // Parse the denial body like the write helpers do: reads carry machine-readable
  // `code`s too (e.g. DAEMON_FEATURE_MISSING on a capability-gated route), and a
  // status-only ApiError silently drops them.
  if (!res.ok) throw await apiErrorFromResponse('GET', path, res)
  return (await res.json()) as T
}

export interface SessionActivityDto {
  sessionId: string
  agentId: string
  revision: string
  ts: string
}

export interface SessionEventHandlers {
  onConnect: () => void
  onSession: () => void
  onActivity: (activity: SessionActivityDto) => void
}

// Reopen the stream periodically so each cycle asks the SDK for a current OIDC
// resource token without forcing a refresh while the cached token is valid.
const SESSION_STREAM_REAUTH_MS = 5 * 60_000

function waitBeforeReconnect(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    if (signal.aborted) finish()
    else signal.addEventListener('abort', finish, { once: true })
  })
}

async function readSessionEventStream(
  orgId: string,
  signal: AbortSignal,
  handlers: SessionEventHandlers,
  recoverGap: boolean
): Promise<'ended' | 'reauth'> {
  const request = new AbortController()
  let reauth = false
  const abort = () => request.abort(signal.reason)
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
  const reauthTimer = setTimeout(() => {
    reauth = true
    request.abort()
  }, SESSION_STREAM_REAUTH_MS)
  const path = `/orgs/${encodeURIComponent(orgId)}/stream`
  try {
    const res = await authenticatedFetch(
      path,
      { cache: 'no-store', signal: request.signal },
      { accept: 'text/event-stream' }
    )
    if (!res.ok) throw new ApiError(`GET ${path} → ${res.status} ${res.statusText}`, res.status)
    if (!res.body) throw new Error('session event stream is not readable')

    // The sink has no replay/event ids, so an initial or recovered connection
    // invalidates cached reads once. Planned token rotation is not a gap recovery.
    if (recoverGap) handlers.onConnect()

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    const parser = createSseParser((event) => {
      if (event.event === 'session') {
        handlers.onSession()
        return
      }
      if (event.event !== 'session-activity') return
      try {
        const activity = (JSON.parse(event.data) as { activity?: SessionActivityDto }).activity
        if (
          activity &&
          typeof activity.sessionId === 'string' &&
          typeof activity.agentId === 'string' &&
          /^\d+$/.test(activity.revision) &&
          typeof activity.ts === 'string'
        )
          handlers.onActivity(activity)
      } catch {
        // A malformed optional invalidation is ignored; reconnect/focus refresh heals it.
      }
    })

    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        parser.push(decoder.decode(value, { stream: true }))
      }
      parser.push(decoder.decode())
    } finally {
      reader.releaseLock()
    }
    return 'ended'
  } catch (error) {
    if (reauth && !signal.aborted) return 'reauth'
    throw error
  } finally {
    clearTimeout(reauthTimer)
    signal.removeEventListener('abort', abort)
  }
}

/**
 * Subscribe to the org's session SSE feed with the same auth headers as REST.
 * Lifecycle events invalidate lists; activity events identify the transcript
 * that should pull its daemon-local tail. Returns an abort cleanup.
 */
export function subscribeSessionEvents(
  orgId: string,
  handlers: SessionEventHandlers,
  onError?: (error: unknown) => void
): () => void {
  const ctrl = new AbortController()
  let retryMs = 1000
  let recoverGap = true

  void (async () => {
    while (!ctrl.signal.aborted) {
      try {
        const ended = await readSessionEventStream(orgId, ctrl.signal, handlers, recoverGap)
        retryMs = 1000
        if (ended === 'reauth') {
          recoverGap = false
          continue
        }
      } catch (error) {
        if (ctrl.signal.aborted) return
        onError?.(error)
      }
      recoverGap = true
      if (ctrl.signal.aborted) return
      await waitBeforeReconnect(retryMs, ctrl.signal)
      retryMs = Math.min(retryMs * 2, 30_000)
    }
  })()

  return () => ctrl.abort()
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await authenticatedFetch(
    path,
    {
      method: 'POST',
      body: JSON.stringify(body)
    },
    { 'content-type': 'application/json' }
  )
  if (!res.ok) throw await apiErrorFromResponse('POST', path, res)
  return (await res.json()) as T
}

async function apiErrorFromResponse(method: string, path: string, res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  const message =
    typeof body.message === 'string' && body.message.length > 0
      ? body.message
      : `${method} ${path} → ${res.status} ${res.statusText}`
  const code = typeof body.code === 'string' ? body.code : undefined
  // The token is still valid but its account was deleted (admin action): nothing in
  // the console can work, and no retry helps, so sign out instead of surfacing the
  // failure on every panel. The error is still thrown for the in-flight caller.
  if (res.status === 401 && code === 'ACCOUNT_GONE') void signOutDeletedAccount()
  return new ApiError(message, res.status, code, body)
}

async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await authenticatedFetch(
    path,
    {
      method: 'PATCH',
      body: JSON.stringify(body)
    },
    { 'content-type': 'application/json' }
  )
  if (!res.ok) {
    // Surface the CP's human-readable denial (e.g. the shared-bot 409s: "no relay
    // is connected…") instead of a bare status line.
    throw await apiErrorFromResponse('PATCH', path, res)
  }
  return (await res.json()) as T
}

async function apiPut<T>(path: string, body?: unknown): Promise<T> {
  const res = await authenticatedFetch(
    path,
    {
      method: 'PUT',
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    },
    body === undefined ? undefined : { 'content-type': 'application/json' }
  )
  if (!res.ok) throw await apiErrorFromResponse('PUT', path, res)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

async function apiDelete<T>(path: string, body?: unknown): Promise<T> {
  const res = await authenticatedFetch(
    path,
    {
      method: 'DELETE',
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    },
    body === undefined ? undefined : { 'content-type': 'application/json' }
  )
  if (!res.ok) throw await apiErrorFromResponse('DELETE', path, res)
  // Some deletes reply 204 No Content (daemon delete); others 200 with a body
  // (key revoke). Parse a body only when there is one.
  if (res.status === 204) return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

// ── OAuth consent (agent-assistant.md §7.3) ─────────────────────────────────
// The consent page (app/oauth/consent) renders the approval screen for a remote
// MCP client's browser login and mints the authorization code via these.

export interface OAuthConsentContext {
  clientId: string
  clientName: string | null
  scopes: string[]
  organizations: { id: string; slug: string; name: string | null; role: string }[]
}

/** Approval-screen data for a pending /authorize request: who's asking, for what
 *  scopes, and which of the caller's orgs they can bind the grant to. */
export function getOAuthConsentContext(clientId: string, scope?: string): Promise<OAuthConsentContext> {
  const qs = new URLSearchParams({ client_id: clientId, ...(scope ? { scope } : {}) })
  return apiGet<OAuthConsentContext>(`/oauth/consent/context?${qs.toString()}`)
}

export interface OAuthConsentInput {
  clientId: string
  redirectUri: string
  codeChallenge: string
  codeChallengeMethod: string
  scope?: string
  state?: string
  resource?: string
  orgId: string
  decision: 'allow' | 'deny'
  grantedScopes?: string[]
}

/** Submit the user's decision; returns the URL to bounce the browser back to the
 *  MCP client (carrying `code` on approve, or `error=access_denied` on deny). */
export function postOAuthConsent(input: OAuthConsentInput): Promise<{ redirectUrl: string }> {
  return apiPost<{ redirectUrl: string }>('/oauth/consent', input)
}

// ── DTO → UI mappers ────────────────────────────────────────────────────────
const PLACEHOLDER = '—'

function toStatusKey(raw: string): ConnectionStatusKey {
  const s = (raw || '').toLowerCase()
  if (['online', 'running', 'active', 'ready', 'live', 'working', 'connected', 'idle', 'completed'].includes(s))
    return 'online'
  if (['paused', 'draining', 'awaiting', 'blocked', 'prompting', 'resuming', 'cancelling'].includes(s)) return 'paused'
  if (
    [
      'waiting',
      'connecting',
      'authenticating',
      'registering',
      'inactive',
      'offline',
      'stopped',
      'error',
      'dead',
      'failed',
      'disconnected',
      'unreachable',
      'pending',
      'provisioned',
      'key-reaped'
    ].includes(s)
  )
    return 'offline'
  return 'offline'
}

function fmtTime(iso: string | null): string {
  if (!iso) return PLACEHOLDER
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return PLACEHOLDER
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return time

  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`

  const date =
    d.getFullYear() === now.getFullYear()
      ? d.toLocaleDateString([], { month: 'short', day: 'numeric' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
  return `${date}, ${time}`
}

// Absolute calendar date for "Created"/"Member since" rows, e.g. "Mar 4, 2026".
export function fmtDate(iso: string | null): string {
  if (!iso) return PLACEHOLDER
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return PLACEHOLDER
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

function fmtSeen(iso: string | null): string {
  if (!iso) return PLACEHOLDER
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return PLACEHOLDER
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

// `gitRepo` is STORED as a full cloneable address (e.g. https://github.com/acme/infra
// or git@github.com:acme/infra.git); pre-normalization rows may still carry the bare
// "org/repo" shorthand. Split either form into host + org/repo path — the UI shows
// only the short path and links to the browsable https URL.
function repoParts(gitRepo: string): { host: string; path: string } | null {
  const s = gitRepo
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
  // scheme URLs: https://github.com/acme/infra, ssh://git@github.com/acme/infra
  let m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(s)
  if (m) return { host: m[1]!, path: m[2]! }
  // scp-like ssh: git@github.com:acme/infra
  m = /^[\w.-]+@([\w.-]+):(.+)$/.exec(s)
  if (m) return { host: m[1]!, path: m[2]!.replace(/^\/+/, '') }
  const seg = s.split('/')
  // host-prefixed shorthand: github.com/acme/infra
  if (seg.length >= 3 && seg[0]!.includes('.')) return { host: seg[0]!, path: seg.slice(1).join('/') }
  // bare org/repo (legacy shorthand)
  if (seg.length === 2) return { host: 'github.com', path: s }
  return null
}

/** Short `org/repo` display form of a stored git address. */
export function repoLabel(gitRepo: string): string {
  return repoParts(gitRepo)?.path ?? gitRepo
}

/** Browsable https URL of a stored git address (undefined when unparsable). */
export function repoWebUrl(gitRepo: string): string | undefined {
  const p = repoParts(gitRepo)
  return p ? `https://${p.host}/${p.path}` : undefined
}

// Map the wire workspace (gitRepo/gitBranch/agentDir) into the richer UI shape.
// The CP does not surface git state (commit/pull/dirty/files), so those render
// as placeholders / empty until a daemon read model exists.
function workspaceFromDto(w: AgentWorkspaceDto, workspaceRepoId?: string | null): Workspace {
  if (w.mode === 'git') {
    return {
      mode: 'git',
      worktree: w.worktree === true,
      gitRepo: w.gitRepo,
      repo: repoLabel(w.gitRepo),
      ...(repoWebUrl(w.gitRepo) ? { repoUrl: repoWebUrl(w.gitRepo) } : {}),
      ...(w.credential !== undefined ? { provider: w.credential.provider, gitAccess: w.credential.access } : {}),
      ...(workspaceRepoId ? { repoId: workspaceRepoId } : {}),
      branch: w.gitBranch || 'main',
      agentDir: w.agentDir || '/',
      lastPull: PLACEHOLDER,
      commit: PLACEHOLDER,
      commitMsg: '',
      commitTime: '',
      clean: true,
      files: []
    }
  }
  return { mode: 'scratch', created: PLACEHOLDER, size: PLACEHOLDER, files: [] }
}

// A member's display name: their CP displayName, else the email local-part. The CP
// stores displayName null for social accounts with no profile name (a GitHub account
// with Name unset carries no `name` claim) — the common case — so the local-part is the
// real label. Shared with the Members list (SettingsView) so "Created by" and the roster
// never drift.
export function memberDisplayName(m: Pick<MemberDto, 'name' | 'email'>): string {
  return m.name || m.email?.split('@')[0] || 'Member'
}

// Org-member directory (userId → display name), populated by the console data layer from
// GET /orgs/:id/members. A module-level cache so creatorLabel stays a plain call the
// render sites can use; consumers re-render when the members context value lands and
// re-run the lookup.
let memberNamesByUserId = new Map<string, string>()

/** Refresh the userId→name directory creatorLabel consults. Called on each members pull. */
export function setMemberDirectory(members: MemberDto[]): void {
  const next = new Map<string, string>()
  for (const m of members) next.set(m.userId, memberDisplayName(m))
  memberNamesByUserId = next
}

// The CP returns a creator's userId (or null). Turn it into a human label, resolved
// UNIFORMLY with session senders (see isSelfSender): "You" for the signed-in viewer, else
// the org member's name (via the directory above), else the em-dash placeholder — used
// both for no-creator (CLI/daemon) rows and a creator the directory doesn't know (e.g. a
// member who has since left the org). `me` is the CP /me record — pass it from
// useProfile() at the call site. Exported so render sites (bots, schedules, daemon/agent
// detail) resolve at paint time and re-run once the member directory has loaded.
export function creatorLabel(userId: string | null, me: MeDto | null): string {
  if (!userId) return PLACEHOLDER
  if (isSelfSender(userId, me)) return 'You'
  // Mock/demo rows carry a display name here (not a real userId), so show it verbatim;
  // real data shows "—" for an unknown id rather than leaking a raw `usr_…`.
  return memberNamesByUserId.get(userId) ?? (MOCK_MODE ? userId : PLACEHOLDER)
}

export function agentFromDto(d: AgentDto): Agent {
  const ws = workspaceFromDto(d.workspace, d.workspaceRepoId)
  return {
    id: d.id,
    name: d.name,
    ...(d.displayName ? { displayName: d.displayName } : {}),
    ...(d.builtin ? { builtin: true } : {}),
    icon: withIconUrl(d.icon, d.iconUrl),
    // Blank when the agent has no explicit model — the UI shows "Default" (runtime
    // default). Never fall back to the runtime id: that would fabricate a model.
    model: d.model ?? '',
    // Blank when the runtime is deferred (an unplaced preset) — mirrors the
    // daemon '—' coalesce below; display sites render '—' for an empty runtime.
    runtime: d.runtime ?? '',
    desc: d.description ?? PLACEHOLDER,
    // '—' when the CP has no explicit value: the daemon then falls back to the
    // local agent.json (default 'low'). Session count is derived in the view from
    // the fetched `/sessions` list, so it's not a field here.
    outputMode: d.outputMode ?? PLACEHOLDER,
    showFooter: d.showFooter ?? true,
    showStatusBar: d.showStatusBar ?? false,
    reasoning: d.reasoningEffort ?? '',
    // Unset (null) reads as "Off" — the runtime default.
    fastMode: d.fastMode ?? false,
    // Unset (null) reads as not paused.
    pause: d.pause ?? false,
    // Memory backend (unset ⇒ managed default).
    memoryProvider: d.memory?.provider ?? 'managed',
    memoryAutoDistill: d.memory?.provider === 'managed' ? (d.memory.autoDistill ?? false) : false,
    ...(d.memory?.provider === 'managed' && d.memory.scope === 'channel' ? { memoryScope: 'channel' as const } : {}),
    ...(d.memory?.provider === 'managed' && d.memory.dreaming ? { memoryDreaming: d.memory.dreaming } : {}),
    ...(d.memory?.provider === 'external'
      ? {
          memoryConnectionId: d.memory.connectionId,
          memoryRecall: d.memory.recall,
          memoryCaptureMode: d.memory.capture?.mode ?? 'manual'
        }
      : {}),
    permissionMode: d.permissionMode ?? '',
    allowRuntimeChangesInChat: d.allowRuntimeChangesInChat ?? false,
    env: Object.entries(d.env ?? {}).map(([k, v]) => ({ k, v })),
    secretKeys: d.secretKeys ?? [],
    // Inherited organization rows. Empty on an older CP, which renders exactly as
    // the pre-feature console did.
    organizationVariables: (d.organizationVariables ?? []).map((e) => ({ k: e.key, v: e.value })),
    organizationSecretKeys: d.organizationSecretKeys ?? [],
    // A `pool` placement names no member, on purpose: whichever member holds the agent's duty
    // serves it, so the row carries the KIND and a server-computed readiness instead of a Pod id
    // that a rollout invalidates.
    placementKind: d.placementKind ?? 'daemon',
    placementReady: d.placementReady ?? false,
    // The set id rides along: `daemon` alone cannot tell the pool from one of the org's own groups,
    // and only a caller holding the org's set list can (daemon-groups.md §2).
    setId: d.setId ?? null,
    daemon: placementValueOf(d) ?? PLACEHOLDER,
    ...(d.daemonName ? { daemonName: d.daemonName } : {}),
    region: PLACEHOLDER,
    repo: ws.mode !== 'scratch' ? ws.repo : PLACEHOLDER,
    workdir: ws.mode !== 'scratch' ? ws.agentDir : PLACEHOLDER,
    // A paused agent reads as "paused" regardless of placement — pause is a deliberate
    // operator state, orthogonal to online/offline. Gives the "Paused" filter tab meaning.
    status: d.pause ? 'paused' : toStatusKey(d.status),
    tokens: PLACEHOLDER,
    cost: PLACEHOLDER,
    createdBy: d.createdBy ?? '', // creator userId; creatorLabel resolves it to a name / "You" at render
    createdAt: fmtDate(d.createdAt),
    lastModifiedBy: d.lastModifiedBy ?? '', // editor userId; creatorLabel resolves it to a name / "You" at render
    lastModifiedAt: fmtDate(d.lastModifiedAt),
    visibility: d.visibility,
    sharedWith: d.sharedWith,
    canEdit: d.canEdit,
    canManageSharing: d.canManageSharing,
    callPolicy: d.callPolicy ?? 'all',
    allowedCallerAgentIds: d.allowedCallerAgentIds ?? [],
    outboundPolicy: d.outboundPolicy ?? 'all',
    allowedTargetAgentIds: d.allowedTargetAgentIds ?? [],
    // Unset (older CP) reads as off — the product default.
    introduceOnJoin: d.introduceOnJoin ?? false,
    // Missing policy fields fail closed; the removed legacy field is not read.
    runInSandbox: d.runInSandbox ?? false,
    sandboxSupported: d.sandboxSupported ?? false,
    sandboxRequired: d.sandboxRequired ?? false,
    hookKinds: d.hookKinds ?? [],
    integrations: [],
    workspace: ws
  }
}

// Compact count: 1_240_000 → "1.24M", 92_000 → "92K".
export function fmtCountCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return PLACEHOLDER
  // Strip trailing zeros only AFTER a decimal point — never the integer part.
  // A bare `/\.?0+$/` would turn "10" → "1", rendering 10M as "1M".
  const trim = (s: string) => (s.includes('.') ? s.replace(/\.?0+$/, '') : s)
  // Group the integer part — "B" is the largest unit, so past 1000B the digits keep going.
  const fmt = (v: number, digits: number) =>
    trim(v.toFixed(digits)).replace(/^-?\d+/, (i) => Number(i).toLocaleString('en-US'))
  if (n >= 1_000_000_000) return fmt(n / 1_000_000_000, n >= 10_000_000_000 ? 0 : 2) + 'B'
  if (n >= 1_000_000) return fmt(n / 1_000_000, n >= 10_000_000 ? 0 : 2) + 'M'
  if (n >= 1_000) return fmt(n / 1_000, n >= 10_000 ? 0 : 1) + 'K'
  return n.toLocaleString('en-US')
}

// Format the daemon-metered session cost. Currency is an ISO code (e.g. "USD");
// fall back to prefixing the raw code when it isn't one we render with a symbol.
export function fmtCost(amount: number | undefined, currency: string | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return PLACEHOLDER
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(amount)
  } catch {
    return `${currency ? currency + ' ' : ''}${amount}`
  }
}

function sessionChannelLabel(
  platform: string,
  rawChannel: string,
  channelName: string | null,
  triggeredByName: string | null,
  hookKind: HookKind | null | undefined
): string {
  // webchat's `channel` is the conversationId (a UUID) — never a human channel. Show the
  // "Playground" label (matching platName + the live playground session), and keep the raw
  // id in channelId so the detail view can RESUME it (reconnect with `?conversation_id=`).
  const isWebchat = platform === 'webchat'
  const isDream = platform === 'dream'
  // A headless webhook's `channel` is the hook id (and `thread` may be the delivery key),
  // so render the CP-enriched hook name when present and otherwise hide the raw UUID.
  const isHook = platform === 'hook'
  // An unnamed hook still names its SOURCE — a GitLab delivery is "GitLab", not "Webhook".
  const hookLabel = channelName?.trim() || hookSourceLabel(hookKind)
  // Name-first display: "#general" when the daemon resolved a channel name, or the
  // DM counterpart verbatim ("@Dana Reyes" — already @-prefixed by the daemon). A
  // Slack DM ("D…" im id) the daemon hasn't labeled yet falls back to the
  // triggering user so the raw id never shows as the channel.
  const isSlackDm = platform === 'slack' && /^D/.test(rawChannel)
  const dmFallback = isSlackDm ? (triggeredByName ? `@${triggeredByName}` : 'DM') : null
  return isWebchat
    ? 'Playground'
    : isDream
      ? 'Memory'
      : isHook
        ? hookLabel
        : channelName
          ? channelName.startsWith('@')
            ? channelName
            : `#${channelName}`
          : (dmFallback ?? (rawChannel || PLACEHOLDER))
}

export function sessionFromDto(d: SessionDto): Session {
  const usage = d.usage ?? undefined
  const rawChannel = d.sessionKey.channel
  const platform = d.sessionKey.platform || 'slack'
  const isWebchat = platform === 'webchat'
  const isHook = platform === 'hook'
  const isDream = platform === 'dream'
  const channel = sessionChannelLabel(platform, rawChannel, d.channelName, d.triggeredByName, d.hookKind)
  const isSlackDm = platform === 'slack' && /^D/.test(rawChannel)
  const dmFallback = isSlackDm ? (d.triggeredByName ? `@${d.triggeredByName}` : 'DM') : null
  const user = isDream
    ? d.triggeredBy === 'schedule'
      ? 'Scheduled'
      : d.triggeredBy === 'auto'
        ? 'Automatic'
        : 'Manual'
    : d.triggeredByName ||
      (isHook && d.triggeredBy?.startsWith('hook:') ? hookSourceLabel(d.hookKind) : d.triggeredBy) ||
      PLACEHOLDER
  return {
    id: d.sessionId,
    title: d.title || `Session ${d.sessionId.slice(0, 8)}`,
    lastActivityAt: d.lastActivityAt,
    time: fmtTime(d.lastActivityAt),
    status: toStatusKey(d.status || ''),
    platform,
    channel,
    ...((isWebchat || isHook || d.channelName || dmFallback) && rawChannel ? { channelId: rawChannel } : {}),
    ...(d.threadUrl ? { threadUrl: d.threadUrl } : {}),
    user,
    ...(d.triggeredBy ? { triggeredBy: d.triggeredBy } : {}),
    ...(d.hookKind ? { hookKind: d.hookKind } : {}),
    // Absent on legacy/pre-feature rows — the views treat undefined as 'org'.
    ...(d.visibility != null ? { visibility: d.visibility } : {}),
    duration: PLACEHOLDER,
    tokens: fmtCountCompact(usage?.totalTokens),
    cost: fmtCost(usage?.costAmount, usage?.costCurrency),
    toolCount: PLACEHOLDER,
    statusLabel: d.status || PLACEHOLDER,
    ...(usage ? { usage } : {}),
    // The transcript is a separate on-demand pull (fetchSessionMessages); the
    // list row carries no bodies, so steps start empty.
    steps: [],
    agentId: d.agentId,
    ...(d.agentName?.trim() ? { agentName: d.agentName.trim() } : {}),
    // Session-recorded execution config (what this session actually ran with).
    // Omitted on legacy rows — data-context then falls back to the agent's
    // current config when flattening. `daemon` carries the daemonId (the views
    // resolve it to the daemon's display name, as with the agent's placement).
    ...(d.runtime !== null && d.runtime !== undefined ? { runtime: d.runtime } : {}),
    ...(d.model !== null && d.model !== undefined ? { model: d.model } : {}),
    ...(d.effort !== null && d.effort !== undefined ? { effort: d.effort } : {}),
    ...(d.fastMode !== null && d.fastMode !== undefined ? { fastMode: d.fastMode } : {}),
    ...(d.permissionMode !== null && d.permissionMode !== undefined ? { permissionMode: d.permissionMode } : {}),
    ...(d.outputMode !== null && d.outputMode !== undefined ? { outputMode: d.outputMode } : {}),
    ...(d.daemonId !== null && d.daemonId !== undefined ? { daemon: d.daemonId } : {}),
    // Retention GC (#485): only ever set, never cleared to a falsy marker — the
    // views treat "absent" as "content is still there".
    ...(d.contentPurgedAt ? { contentPurgedAt: d.contentPurgedAt } : {}),
    ...(d.workspaceIsolation !== null && d.workspaceIsolation !== undefined
      ? { workspaceIsolation: d.workspaceIsolation }
      : {})
  }
}

/** Hydrate a session detail that was not present in the currently loaded list
 *  pages. Detail carries its own latest usage snapshot so a direct link can show
 *  this session's token/cost accounting without depending on list pagination. */
export function sessionFromDetailDto(d: SessionDetailDto): Session {
  // The adopted-session composer/header needs the conversation roster before any
  // relay socket exists; short-id fallback mirrors the provider's ready-frame path.
  const participants = d.participants?.length
    ? d.participants.map((p) => ({
        agentId: p.agentId,
        name: p.name ?? p.agentId.slice(0, 8),
        ...(p.primary ? { primary: true } : {})
      }))
    : undefined
  const base = sessionFromDto({
    sessionId: d.id,
    sessionKey: {
      platform: d.platform ?? 'slack',
      channel: d.channel ?? '',
      ...(d.thread !== null ? { thread: d.thread } : {})
    },
    agentId: d.agentId,
    agentName: d.agentName ?? null,
    title: d.title,
    status: d.status,
    lastActivityAt: d.lastActivityAt,
    usage: d.usage,
    triggeredBy: d.triggeredBy,
    ...(d.hookKind !== undefined ? { hookKind: d.hookKind } : {}),
    channelName: d.channelName,
    triggeredByName: d.triggeredByName,
    threadUrl: d.threadUrl,
    ...(d.visibility != null ? { visibility: d.visibility } : {}),
    runtime: d.runtime,
    model: d.model,
    effort: d.effort,
    fastMode: d.fastMode,
    permissionMode: d.permissionMode,
    outputMode: d.outputMode,
    daemonId: d.daemonId,
    contentPurgedAt: d.contentPurgedAt ?? null,
    workspaceIsolation: d.workspaceIsolation
  })
  return participants ? { ...base, participants } : base
}

/** Keep local/live session fields while refreshing usage from the independently
 *  polled detail endpoint. This closes the race where the list row arrived just
 *  before the daemon's final cumulative usage report.
 *
 *  The retention-purge mark (#485) rides along on every path, including the early
 *  returns: the detail endpoint refreshes faster than the list, so a cached
 *  pre-purge row would otherwise keep the transcript view showing an unexplained
 *  empty (or "daemon offline") state until a separate list refresh replaced it.
 *  It is monotonic — the mark is only ever set, never cleared by a detail response
 *  that predates it. */
export function mergeSessionDetailUsage(local: Session, detail: Session | null): Session {
  const withPurge = (session: Session): Session =>
    detail?.contentPurgedAt && !session.contentPurgedAt
      ? { ...session, contentPurgedAt: detail.contentPurgedAt }
      : session
  if (!detail?.usage) return withPurge(local)
  if (local.usage) {
    const localReportedAt = local.usage.reportedAt ? Date.parse(local.usage.reportedAt) : Number.NaN
    const detailReportedAt = detail.usage.reportedAt ? Date.parse(detail.usage.reportedAt) : Number.NaN
    // A live session can have usage without a persisted timestamp. Preserve that
    // state unless the detail snapshot proves it is newer; never let a cached
    // detail response move cumulative token/cost totals backward.
    if (!Number.isFinite(detailReportedAt)) return withPurge(local)
    if (!Number.isFinite(localReportedAt) || detailReportedAt <= localReportedAt) return withPurge(local)
  }
  return withPurge({
    ...local,
    usage: detail.usage,
    tokens: detail.tokens,
    cost: detail.cost
  })
}

/** What a liveness row knows before its capability read lands: nothing yet. Views gate on
 *  `daemonsLoading` rather than reading this as "the daemon can do nothing". */
const EMPTY_DAEMON_CAPS: DaemonCapabilitiesDto = { platforms: [], runtimes: [], acp: false, features: [] }

/** Stitch a capability row onto its liveness row. The catalog arrives with an empty
 *  `models` list — `modelCapability()` then reads as "not discovered" and falls back to the
 *  static tables, which is exactly what a surface that has not read one daemon should see. */
export function withDaemonCapability(row: DaemonRow, cap: DaemonCapabilityDto | undefined): DaemonRow {
  if (!cap) return row
  return {
    ...row,
    caps: cap.capabilities,
    runtimeModels: cap.runtimeProfiles.map((p) => ({
      runtime: p.runtime,
      version: p.version,
      models: p.models,
      acpProtocolVersion: p.acpProtocolVersion,
      mcpCapabilities: p.mcpCapabilities ?? null,
      modelCatalog: p.modelCatalog ?? null,
      authRequired: p.authRequired ?? false
    })),
    mcpServers: cap.mcpServers
  }
}

export function daemonFromDto(
  d: DaemonFleetDto & Partial<Pick<DaemonViewDto, 'capabilities' | 'runtimeProfiles' | 'mcpServers'>>
): DaemonRow {
  // `cloud` is the CP DTO's field name (a REST contract); the console's own word is `pool`.
  const pool = d.cloud ?? false
  return {
    daemonId: d.daemonId,
    pool,
    memberSetId: d.memberSetId ?? null,
    // Display label: the daemon name (the CP seeds it from the hostname on first
    // register, so a connected daemon always has one), else a short id for a
    // provisioned-but-never-connected row. Never the raw hostname. A pool member's
    // name is its Pod, which is meaningless outside the cluster and changes on every
    // roll — the pool is one managed thing everywhere it is named, so use that label.
    name: pool ? poolLabel() : d.name || d.daemonId.slice(0, 8),
    version: d.agentVersion || PLACEHOLDER,
    latestVersion: d.latestVersion,
    releaseChannel: d.releaseChannel,
    availableVersions: d.availableVersions ?? [],
    lifecycleOp: d.lifecycleOp ?? null,
    lifecycleStatus: lifecycleStatus(d.lifecycleOp) ?? null,
    canManageLifecycle: d.canManageLifecycle ?? false,
    // Flag an available upgrade only when both versions parse and latest > running.
    upgradeAvailable: isUpgradeAvailable(d.agentVersion, d.latestVersion),
    // Keep connection/readiness operational. Presentation surfaces combine this
    // with lifecycleStatus without changing onboarding or reconnect decisions.
    status: toStatusKey(d.status),
    host: d.host ?? PLACEHOLDER,
    // `load.{cpu,mem}` are 0..1 fractions; surface them as percentages.
    cpu: d.load ? Math.round(d.load.cpu * 100) : 0,
    mem: d.load ? Math.round(d.load.mem * 100) : 0,
    loadAgents: d.load?.agents ?? 0,
    caps: d.capabilities ?? EMPTY_DAEMON_CAPS,
    // Per-runtime available models, observed from the daemon's runtime profiles.
    runtimeModels: (d.runtimeProfiles ?? []).map((p) => ({
      runtime: p.runtime,
      version: p.version,
      models: p.models,
      acpProtocolVersion: p.acpProtocolVersion,
      mcpCapabilities: p.mcpCapabilities ?? null,
      modelCatalog: p.modelCatalog ?? null,
      authRequired: p.authRequired ?? false
    })),
    mcpServers: d.mcpServers ?? [],
    activeSessions: String(d.activeSessions),
    conns: String(d.maxAgents),
    uptime: fmtSeen(d.lastSeenAt),
    createdBy: d.createdBy ?? '', // creator userId; creatorLabel resolves it to a name / "You" at render
    createdAt: fmtDate(d.createdAt),
    lastModifiedBy: d.lastModifiedBy ?? '', // editor userId; creatorLabel resolves it to a name / "You" at render
    lastModifiedAt: fmtDate(d.lastModifiedAt),
    sessionRetention: d.sessionRetention ?? '7d', // absent from an older CP ⇒ the daemon-side default
    visibility: d.visibility,
    sharedWith: d.sharedWith,
    canEdit: d.canEdit,
    canManageSharing: d.canManageSharing
  }
}

// ── endpoints ───────────────────────────────────────────────────────────────
export async function fetchAgents(orgId?: string): Promise<Agent[]> {
  return (await apiGet<AgentDto[]>(`${orgBase(orgId)}/agents`)).map(agentFromDto)
}

// Delete an agent: drops the CP spec and tells the owning daemon to tear down its
// local replica (agent/remove, best-effort). 204 on success, 404 if already gone.
export async function deleteAgent(agentId: string): Promise<void> {
  await apiDelete<void>(`${orgBase()}/agents/${encodeURIComponent(agentId)}`)
  track('agent_deleted', { org_id: apiOrgId, agent_id: agentId })
}

export async function fetchSessions(
  cursor?: string,
  limit = 50,
  orgId?: string,
  filters: SessionListFilters = {}
): Promise<SessionListPage> {
  // The CP's default response shape is the GROUPED conversation list
  // (merged-conversation-view.md §5.2); this fetcher serves the flat-row
  // consumers (rails, agent pages), so it pins the escape hatch explicitly.
  const q = new URLSearchParams({ limit: String(limit), view: 'flat' })
  if (cursor) q.set('cursor', cursor)
  appendSessionFilters(q, filters)
  const page = await apiGet<SessionListPageDto>(`${orgBase(orgId)}/sessions?${q.toString()}`)
  return {
    sessions: (page.sessions ?? []).map(sessionFromDto),
    total: page.total,
    nextCursor: page.nextCursor,
    ...(page.orgHasSessions !== undefined ? { orgHasSessions: page.orgHasSessions } : {}),
    ...(page.accessSyncDegraded !== undefined ? { accessSyncDegraded: page.accessSyncDegraded } : {}),
    ...(page.accessIssues !== undefined ? { accessIssues: page.accessIssues } : {})
  }
}

/** What the key-addressed resolver answered for one conversation. */
export interface ConversationResolution {
  /** The conversation's currently visible member sessions, or null when the
   *  caller can see none of them. */
  conversation: ConversationDto | null
  /** Whether an external access check could not be completed for this answer.
   *  The CP fails those CLOSED — a member whose visibility it could not
   *  determine is omitted — so a degraded empty answer means "we could not
   *  check", NOT "you cannot see it". Dropping this flag is what made a Slack
   *  API blip read as a permanent authorization verdict. */
  accessSyncDegraded: boolean
  accessIssues: SessionAccessIssue[]
}

/** Resolve one conversation's current visible member sessions by its §5.1 key
 *  (the bounded key-addressed resolver). An empty answer is only a real
 *  "nothing here you can see" when `accessSyncDegraded` is false — see above;
 *  a caller that reports absence must consult it. */
export async function fetchConversationByKey(key: string, orgId?: string): Promise<ConversationResolution> {
  const q = new URLSearchParams({ conversationKey: key })
  const page = await apiGet<SessionListPageDto>(`${orgBase(orgId)}/sessions?${q.toString()}`)
  return {
    conversation: page.conversations?.[0] ?? null,
    accessSyncDegraded: page.accessSyncDegraded === true,
    accessIssues: page.accessIssues ?? []
  }
}

/** The grouped sessions list (merged-conversation-view.md §5.2): one row per
 *  conversation. Each conversation is projected onto its REPRESENTATIVE member
 *  session (the newest visible one) so the list pipeline renders it exactly
 *  like a session row; multi-participant conversations additionally carry
 *  `participants` (one per member agent, representative first) and the §5.1
 *  `conversationKey`. */
export async function fetchConversations(
  cursor?: string,
  limit = 50,
  orgId?: string,
  filters: SessionListFilters = {}
): Promise<SessionListPage> {
  const q = new URLSearchParams({ limit: String(limit) })
  if (cursor) q.set('cursor', cursor)
  appendSessionFilters(q, filters)
  const page = await apiGet<SessionListPageDto>(`${orgBase(orgId)}/sessions?${q.toString()}`)
  const sessions = (page.conversations ?? []).map((conversation) => {
    const members = conversation.sessions.map(sessionFromDto)
    const rep = members[0]!
    // Conversation IDENTITY rides along whatever the member count. Filtering to a
    // single participant still returns the conversation, only with fewer rows, and
    // a row that dropped its key there could not be recognised as the same
    // conversation the reader has open. Membership comes from `memberSessionIds`,
    // which the CP reports over everything the caller can see — `sessions` is
    // narrowed by the filter, so counting it would lose a participant exactly when
    // the filter is what made the row ambiguous. An older CP omits it; its
    // filtered rows are then the best membership on offer.
    const memberSessionIds = conversation.memberSessionIds ?? members.map((member) => member.id)
    // Retention GC (#485): the purge mark belongs to the MEMBERS, not to the
    // representative, so projecting only `rep` would hide a purged peer entirely.
    // Earliest wins — the row states when this conversation's history first started
    // going away. Visible only for the members the filter returned, the same limit
    // `participants` carries.
    const purgedAt = members
      .map((member) => member.contentPurgedAt)
      .filter((at): at is string => !!at)
      .sort()[0]
    const purge = purgedAt
      ? {
          contentPurgedAt: purgedAt,
          // Whether SOME of the row's history survives decides the wording: a
          // partial purge must not read as "this whole conversation is gone".
          ...(members.some((member) => !member.contentPurgedAt) ? { contentPurgedPartial: true } : {})
        }
      : {}
    const identity = {
      ...(conversation.key !== null ? { conversationKey: conversation.key } : {}),
      memberSessionIds
    }
    if (memberSessionIds.length <= 1) return { ...rep, ...identity, ...purge }
    return {
      ...rep,
      ...identity,
      ...purge,
      // The members the FILTER returned, which is what the row can name. Each
      // Session DTO carries a safe display projection even when the owning Agent
      // itself is hidden from the caller.
      participants: members.map((member, i) => ({
        agentId: member.agentId ?? '',
        name: member.agentName ?? member.agentId ?? '',
        ...(i === 0 ? { primary: true } : {})
      }))
    }
  })
  return {
    sessions,
    total: page.total,
    nextCursor: page.nextCursor,
    ...(page.orgHasSessions !== undefined ? { orgHasSessions: page.orgHasSessions } : {}),
    ...(page.accessSyncDegraded !== undefined ? { accessSyncDegraded: page.accessSyncDegraded } : {}),
    ...(page.accessIssues !== undefined ? { accessIssues: page.accessIssues } : {})
  }
}

function appendSessionFilters(q: URLSearchParams, filters: SessionListFilters): void {
  // Repeated `agentId` is the multi-agent form the CP reads as a conversation
  // participant filter; a lone id serializes identically to the old single form.
  for (const agentId of typeof filters.agentId === 'string' ? [filters.agentId] : (filters.agentId ?? [])) {
    if (agentId) q.append('agentId', agentId)
  }
  if (filters.platform) q.set('platform', filters.platform)
  if (filters.integration) q.set('integration', filters.integration)
  if (filters.channel) q.set('channel', filters.channel)
  if (filters.triggeredBy) q.set('triggeredBy', filters.triggeredBy)
  if (filters.githubRepoId) q.set('githubRepoId', filters.githubRepoId)
}

export async function fetchSessionFacets(orgId?: string, filters: SessionListFilters = {}): Promise<SessionFacets> {
  const q = new URLSearchParams()
  appendSessionFilters(q, filters)
  const query = q.toString()
  const suffix = query ? `?${query}` : ''
  const facets = await apiGet<SessionFacetsDto>(`${orgBase(orgId)}/sessions/facets${suffix}`)
  return {
    agentIds: facets.agents,
    agentNames: facets.agentNames ?? {},
    integrations: facets.integrations,
    channels: facets.channels.map((channel) => ({
      value: channel.value,
      label: sessionChannelLabel(
        channel.platform,
        channel.value,
        channel.name,
        channel.triggeredByName,
        hookKindFromIntegration(channel.integration)
      ),
      platform: channel.integration
    })),
    triggers: facets.triggers.map((trigger) => ({
      value: trigger.value,
      ...(trigger.name ? { name: trigger.name } : {}),
      platform: trigger.integration,
      ...(trigger.hookKind ? { hookKind: trigger.hookKind } : {}),
      ...(trigger.githubRepoId ? { githubRepoId: trigger.githubRepoId } : {})
    }))
  }
}

/** CP-stored detail metadata used for session-family navigation. The linked
 *  rows are already filtered by each Session's audience on the server. */
export function fetchSessionDetail(sessionId: string, orgId?: string): Promise<SessionDetailDto> {
  return apiGet<SessionDetailDto>(`${orgBase(orgId)}/sessions/${encodeURIComponent(sessionId)}`)
}

// PUT /sessions/:id/visibility response. `state` is the §5.1 cutover: 'pending'
// until every affected daemon has acked the new `visibilityRev`, then 'applied'.
export interface SessionVisibilityResultDto {
  id: string
  visibility: SessionVisibility
  visibilityRev: number
  state: 'pending' | 'applied'
}

// Set a session's visibility (PUT /sessions/:id/visibility). Gated server-side to
// the identity-matched session owner only (`canChangeVisibility` in the detail
// DTO); invisible sessions 404 — never 403 (no existence oracle).
export async function putSessionVisibility(
  sessionId: string,
  visibility: MutableSessionVisibility
): Promise<SessionVisibilityResultDto> {
  return apiPut<SessionVisibilityResultDto>(`${orgBase()}/sessions/${encodeURIComponent(sessionId)}/visibility`, {
    visibility
  })
}

export type SessionAccessProvider = 'slack' | 'github' | 'feishu'
export type SessionProfileProvider = SessionAccessProvider | 'lark'

export interface SessionExternalAccessDto {
  provider: SessionAccessProvider
  available: boolean
  enabled: boolean
  state: 'disabled' | 'enabling' | 'enabled' | 'degraded'
  currentRevision: string
  readFenceRevision: string | null
  /** Owner-only migration diagnostic. */
  hiddenSessions?: number
}

export function fetchSessionExternalAccess(
  provider: SessionAccessProvider,
  orgId?: string
): Promise<SessionExternalAccessDto> {
  return apiGet<SessionExternalAccessDto>(`${orgBase(orgId)}/session-access/${provider}`)
}

export function putSessionExternalAccess(
  provider: SessionAccessProvider,
  enabled: boolean,
  orgId?: string
): Promise<SessionExternalAccessDto> {
  return apiPut<SessionExternalAccessDto>(`${orgBase(orgId)}/session-access/${provider}`, { enabled })
}

// One page of a session's transcript, proxied live from the daemon recorded on
// SessionMeta. Content ownership stays pinned there when the agent moves.
export async function fetchSessionMessages(
  sessionId: string,
  options: { cursor?: string; after?: string; limit?: number; signal?: AbortSignal } = {}
): Promise<SessionHistoryDto> {
  const q = new URLSearchParams({ limit: String(options.limit ?? 50) })
  if (options.cursor) q.set('cursor', options.cursor)
  if (options.after) q.set('after', options.after)
  return apiGet<SessionHistoryDto>(
    `${orgBase()}/sessions/${encodeURIComponent(sessionId)}/messages?${q.toString()}`,
    options.signal ? { signal: options.signal } : undefined
  )
}

// One frame-budgeted byte slice of a tool call's FULL ToolBody JSON (mirrors the
// protocol `SessionToolBodyChunk`). `nextOffset` absent ⇒ this was the last chunk.
export interface SessionToolBodyChunkDto {
  sessionId: string
  toolCallId: string
  data: string // UTF-8-boundary-safe byte slice of the full ToolBody JSON
  totalBytes: number
  nextOffset?: number | null
}

// Pull a tool call's FULL (untruncated) ToolBody JSON, proxied live from the
// owning daemon. The inline `SessionMessageDto.body` preview is capped at 32 KiB;
// when `bodyTruncated` the console pages the whole body back through
// `GET /sessions/:id/tool-body` by offset, concatenating the byte slices into the
// complete JSON string (the caller JSON.parse's the result). 503 if the owning
// daemon is offline / the agent is unplaced (same resolution as the messages route).
export async function fetchToolBody(sessionId: string, toolCallId: string): Promise<string> {
  let out = ''
  let offset = 0
  // Guard against a daemon that never advances `nextOffset` (defensive bound).
  for (;;) {
    const q = new URLSearchParams({ toolCallId, offset: String(offset) })
    const chunk = await apiGet<SessionToolBodyChunkDto>(
      `${orgBase()}/sessions/${encodeURIComponent(sessionId)}/tool-body?${q.toString()}`
    )
    out += chunk.data
    if (chunk.nextOffset == null || chunk.nextOffset <= offset) break
    offset = chunk.nextOffset
  }
  return out
}

// Fetch one agent's raw spec (GET /agents/:id). Returns the wire DTO (not the
// lean UI `Agent`) because the edit form needs fields the UI shape drops — notably
// `description`.
export async function fetchAgentDto(agentId: string): Promise<AgentDto> {
  return apiGet<AgentDto>(`${orgBase()}/agents/${encodeURIComponent(agentId)}`)
}

// ── workspace file browsing ─────────────────────────────────────────────────
// One entry of a workspace directory listing (`GET /agents/:id/workspace/files`).
export interface WorkspaceEntryDto {
  name: string
  type: 'dir' | 'file' | 'symlink' | 'other'
  size: number | null
  mtime: string | null // ISO-8601
}

export interface WorkspaceListingDto {
  path: string
  exists: boolean
  entries: WorkspaceEntryDto[]
  nextCursor: string | null
}

// One slice of a workspace file (`GET /agents/:id/workspace/file`).
// `encoding: 'none'` means binary — the daemon withholds the bytes.
export interface WorkspaceFileDto {
  path: string
  exists: boolean
  type: 'file' | 'dir' | null // what the path IS; 'dir' ⇒ no content to show (null from an older daemon)
  size: number | null
  mtime: string | null
  encoding: 'utf8' | 'none' | null
  content: string | null
  offset: number | null
  nextOffset: number | null // byte offset to request next; do NOT recompute from content
  truncated: boolean | null
}

/** Mirrors the daemon wire ceiling; base64 expansion still fits one control frame. */
export const MAX_WORKSPACE_EDIT_BYTES = 180_000

// One page of a workspace directory listing (GET /agents/:id/workspace/files),
// proxied live from the agent's owning daemon — the CP never stores workspace
// bytes (body-locality). 503 when that daemon is offline / the agent is unplaced.
// `repo` names one of the agent's authorized additional repositories, browsing that
// secondary root instead of the primary workspace; 404 when it authorizes no such repo.
export async function fetchWorkspaceFiles(
  agentId: string,
  opts: { path: string; cursor?: string; limit?: number; sessionId?: string; repo?: string }
): Promise<WorkspaceListingDto> {
  const q = new URLSearchParams({ path: opts.path })
  if (opts.sessionId) q.set('sessionId', opts.sessionId)
  if (opts.repo) q.set('repo', opts.repo)
  if (opts.cursor) q.set('cursor', opts.cursor)
  if (opts.limit) q.set('limit', String(opts.limit))
  return apiGet<WorkspaceListingDto>(
    `${orgBase()}/agents/${encodeURIComponent(agentId)}/workspace/files?${q.toString()}`
  )
}

// ── local skill inventory ───────────────────────────────────────────────────
export type LocalSkillOrigin = 'dream-accepted' | 'managed' | 'git-source' | 'repo'

// One skill the agent's workspace can load (GET /agents/:id/skills/local).
export interface LocalSkillDto {
  name: string
  description: string | null
  origin: LocalSkillOrigin
  path: string
}

// The agent's workspace skill inventory. `materialized` is false when the
// workspace has not been prepared yet, so an empty list then means "unknown",
// not "no skills". Proxied live from the owning daemon; 503 when offline.
export interface LocalSkillsDto {
  materialized: boolean
  skills: LocalSkillDto[]
}

export async function fetchAgentLocalSkills(agentId: string): Promise<LocalSkillsDto> {
  return apiGet<LocalSkillsDto>(`${orgBase()}/agents/${encodeURIComponent(agentId)}/skills/local`)
}

// ── runtime slash commands ──────────────────────────────────────────────────
// One command the agent's ACP runtime advertised it can be asked to run
// (GET /agents/:id/commands) — skills, plugin skills and the harness's own
// built-ins arrive in one list, so this is what the runtime actually exposes
// rather than what a workspace scan finds.
export interface RuntimeCommandDto {
  name: string
  description: string
  /** Argument hint, or null when the command takes no argument. */
  hint: string | null
  /** Record-time skill classification (daemon-side, pre-truncation); absent on older daemons. */
  skill?: boolean
}

// `reported:false` means no session has advertised a list yet, so an empty list
// then means "unknown", not "no commands". Proxied live from the owning daemon;
// 409 when the daemon predates this read, 503 when it is offline.
export interface RuntimeCommandsDto {
  reported: boolean
  updatedAt?: string
  sessionId?: string
  commands: RuntimeCommandDto[]
}

export async function fetchAgentRuntimeCommands(agentId: string): Promise<RuntimeCommandsDto> {
  return apiGet<RuntimeCommandsDto>(`${orgBase()}/agents/${encodeURIComponent(agentId)}/commands`)
}

// One slice of a workspace file (GET /agents/:id/workspace/file), proxied live
// from the owning daemon like the listing — file bytes never touch the CP store.
// 503 when the daemon is offline / the agent is unplaced.
export async function fetchWorkspaceFile(
  agentId: string,
  opts: { path: string; offset?: number; limit?: number; sessionId?: string; repo?: string }
): Promise<WorkspaceFileDto> {
  const q = new URLSearchParams({ path: opts.path })
  if (opts.sessionId) q.set('sessionId', opts.sessionId)
  if (opts.repo) q.set('repo', opts.repo)
  if (opts.offset) q.set('offset', String(opts.offset))
  if (opts.limit) q.set('limit', String(opts.limit))
  return apiGet<WorkspaceFileDto>(`${orgBase()}/agents/${encodeURIComponent(agentId)}/workspace/file?${q.toString()}`)
}

/** Read one workspace text file whole before editing it. Every slice must describe
 * the same mtime so a multi-page load cannot assemble two agent revisions. */
export async function fetchWorkspaceFileFull(
  agentId: string,
  path: string,
  opts: { repo?: string } = {}
): Promise<WorkspaceFileDto> {
  let offset = 0
  let content = ''
  let mtime: string | null | undefined
  for (let page = 0; page < 16; page++) {
    const slice = await fetchWorkspaceFile(agentId, { path, offset, ...(opts.repo ? { repo: opts.repo } : {}) })
    if (!slice.exists || slice.encoding !== 'utf8') return slice
    if ((slice.size ?? 0) > MAX_WORKSPACE_EDIT_BYTES) {
      throw new Error('Files larger than 180 KB cannot be edited here.')
    }
    if (mtime === undefined) mtime = slice.mtime
    else if (slice.mtime !== mtime) throw new Error('The file changed while it was loading. Open it again to edit.')
    content += slice.content ?? ''
    if (!slice.truncated) {
      return { ...slice, content, offset: 0, nextOffset: slice.size, truncated: false }
    }
    if (slice.nextOffset == null || slice.nextOffset <= offset) break
    offset = slice.nextOffset
  }
  throw new Error('The workspace file is too large to load safely.')
}

export function writeWorkspaceFile(
  agentId: string,
  path: string,
  body: { content: string; ifMatchMtime?: string }
): Promise<{ path: string; size: number; mtime: string }> {
  return apiPut<{ path: string; size: number; mtime: string }>(
    `${orgBase()}/agents/${encodeURIComponent(agentId)}/workspace/file?path=${encodeURIComponent(path)}`,
    body
  )
}

export function deleteWorkspaceFile(agentId: string, path: string, ifMatchMtime: string): Promise<{ path: string }> {
  const q = new URLSearchParams({ path, ifMatchMtime })
  return apiDelete<{ path: string }>(
    `${orgBase()}/agents/${encodeURIComponent(agentId)}/workspace/file?${q.toString()}`
  )
}

// One slice of an agent's memory file (GET /agents/:id/memory) — a single markdown
// file at the agent root, proxied live from the owning daemon (never stored on the
// CP). A not-yet-created file is data (exists:false). 503 when unplaced / offline.
export interface AgentMemoryDto {
  path: string
  exists: boolean
  size: number | null
  mtime: string | null
  content: string | null
  offset: number | null
  nextOffset: number | null // byte offset to request next; do NOT recompute from content
  truncated: boolean | null
}

// One file in the memory dir (the index or a topic file).
export interface MemoryFileEntry {
  name: string
  size: number
  mtime: string
}
export interface MemoryFilesDto {
  exists: boolean
  files: MemoryFileEntry[]
}

// List the files in the agent's memory dir (MEMORY.md index + topic files).
/** A channel that has its own memory folder (channel-scoped agents, #653). */
export interface MemoryChannelDto {
  channelKey: string
  channel: string | null
  transportScope: string | null
}
export interface MemoryChannelsDto {
  channels: MemoryChannelDto[]
}

/** List the channels that have their own memory folder (empty for agent scope). */
export async function fetchAgentMemoryChannels(agentId: string): Promise<MemoryChannelsDto> {
  return apiGet<MemoryChannelsDto>(`${orgBase()}/agents/${encodeURIComponent(agentId)}/memory/channels`)
}

export async function listAgentMemory(agentId: string, channelKey?: string): Promise<MemoryFilesDto> {
  const q = channelKey ? `?channelKey=${encodeURIComponent(channelKey)}` : ''
  return apiGet<MemoryFilesDto>(`${orgBase()}/agents/${encodeURIComponent(agentId)}/memory/files${q}`)
}

// Read one memory file (`path` defaults to the MEMORY.md index).
export async function fetchAgentMemory(
  agentId: string,
  opts: { path?: string; offset?: number; limit?: number; channelKey?: string } = {}
): Promise<AgentMemoryDto> {
  const q = new URLSearchParams()
  if (opts.channelKey) q.set('channelKey', opts.channelKey)
  if (opts.path) q.set('path', opts.path)
  if (opts.offset) q.set('offset', String(opts.offset))
  if (opts.limit) q.set('limit', String(opts.limit))
  const qs = q.toString()
  // …/memory/file?path=… for a named topic; …/memory (the index) otherwise.
  const base = `${orgBase()}/agents/${encodeURIComponent(agentId)}/memory${opts.path ? '/file' : ''}`
  return apiGet<AgentMemoryDto>(`${base}${qs ? `?${qs}` : ''}`)
}

// Read a memory file WHOLE — pages every slice until the daemon reports no more.
// The console edits by PUTting the whole file, so it must load the whole file first
// (a partial read would let Save clobber the tail). Returns { exists, content }.
export async function fetchAgentMemoryFull(
  agentId: string,
  path?: string,
  channelKey?: string
): Promise<{ exists: boolean; content: string; mtime: string | null }> {
  let offset = 0
  let content = ''
  let exists = false
  let mtime: string | null = null
  // Bounded loop: nextOffset strictly advances while truncated, so this terminates.
  for (let guard = 0; guard < 4096; guard++) {
    const slice = await fetchAgentMemory(agentId, {
      offset,
      ...(path ? { path } : {}),
      ...(channelKey ? { channelKey } : {})
    })
    exists = slice.exists
    mtime = slice.mtime
    if (!slice.exists) break
    content += slice.content ?? ''
    if (!slice.truncated || slice.nextOffset == null || slice.nextOffset <= offset) break
    offset = slice.nextOffset
  }
  return { exists, content, mtime }
}

// Replace one memory file (`path` defaults to the MEMORY.md index); returns the
// written path/size/mtime. Requires edit permission on the agent (403 otherwise).
// `ifMatchMtime` is optimistic concurrency — the write 409s if the file changed.
export async function updateAgentMemory(
  agentId: string,
  content: string,
  path?: string,
  ifMatchMtime?: string | null,
  channelKey?: string
): Promise<{ path: string; size: number; mtime: string }> {
  const q = new URLSearchParams()
  if (channelKey) q.set('channelKey', channelKey)
  if (path) q.set('path', path)
  const qs = q.toString()
  return apiPut<{ path: string; size: number; mtime: string }>(
    `${orgBase()}/agents/${encodeURIComponent(agentId)}/memory/file${qs ? `?${qs}` : ''}`,
    ifMatchMtime ? { content, ifMatchMtime } : { content }
  )
}

export interface MemoryFileHistoryEventDto {
  id?: string
  path: string
  event: 'add' | 'update' | 'delete'
  before?: string
  after: string
  at: string
  scope: 'agent'
  source: 'tool' | 'console' | 'distill' | 'dream'
  truncated?: boolean
}

export interface MemoryFileHistoryPageDto {
  events: MemoryFileHistoryEventDto[]
  nextCursor: string | null
}

// Page one managed memory file's provenance, newest first. The hidden sidecar
// remains daemon-owned; only these bounded rows transit the API.
export async function listMemoryFileHistory(
  agentId: string,
  path: string,
  opts: { cursor?: string; limit?: number; channelKey?: string } = {}
): Promise<MemoryFileHistoryPageDto> {
  const query = new URLSearchParams({ path })
  if (opts.channelKey) query.set('channelKey', opts.channelKey)
  if (opts.cursor) query.set('cursor', opts.cursor)
  if (opts.limit) query.set('limit', String(opts.limit))
  return apiGet<MemoryFileHistoryPageDto>(
    `${orgBase()}/agents/${encodeURIComponent(agentId)}/memory/history?${query.toString()}`
  )
}

// ── memory dreaming (docs/designs/memory-dreaming.md §10) — offline consolidation jobs ──

export type DreamStatus =
  'pending' | 'running' | 'completed' | 'failed' | 'canceled' | 'adopted' | 'discarded' | 'superseded'

export interface DreamDto {
  dreamId: string
  agentId: string
  status: DreamStatus
  trigger: 'manual' | 'schedule' | 'auto'
  sessionIds: string[]
  snapshotDigest: string
  executionSessionId: string | null
  runtime: string | null
  model: string | null
  stopReason: string | null
  instructions: string | null
  skills: { name: string; description: string; state: 'proposed' | 'accepted' | 'dismissed' }[] | null
  usage: (SessionUsageDto & { inputBytes: number; outputBytes: number }) | null
  error: { type: string; message: string } | null
  createdAt: string
  endedAt: string | null
}

export interface DreamFilesDto {
  exists: boolean
  files: MemoryFileEntry[]
  /** Same-bytes review fence token (task #36 Phase B); present only when `exists`. */
  reviewToken?: string
}

/** A dream is terminal (won't change) once it reaches one of these states. */
export function isDreamTerminal(status: DreamStatus): boolean {
  return status !== 'pending' && status !== 'running'
}

const dreamBase = (agentId: string) => `${orgBase()}/agents/${encodeURIComponent(agentId)}/memory/dreams`

/** Start a manual dream (per-run overrides of the agent's dreaming policy). */
export async function startDream(
  agentId: string,
  opts: { sessionWindow?: number; instructions?: string } = {}
): Promise<DreamDto> {
  return apiPost<DreamDto>(dreamBase(agentId), opts)
}

export async function listDreams(
  agentId: string,
  limit?: number,
  opts: { pendingSkills?: boolean } = {}
): Promise<DreamDto[]> {
  const params = new URLSearchParams()
  if (limit) params.set('limit', String(limit))
  if (opts.pendingSkills) params.set('pendingSkills', '1')
  const q = params.toString() ? `?${params.toString()}` : ''
  return (await apiGet<{ dreams: DreamDto[] }>(`${dreamBase(agentId)}${q}`)).dreams
}

export async function getDream(agentId: string, dreamId: string): Promise<DreamDto> {
  return apiGet<DreamDto>(`${dreamBase(agentId)}/${encodeURIComponent(dreamId)}`)
}

export async function cancelDream(agentId: string, dreamId: string): Promise<DreamDto> {
  return apiPost<DreamDto>(`${dreamBase(agentId)}/${encodeURIComponent(dreamId)}/cancel`, {})
}

/** Adopt a completed dream's staged store. `force` overrides the snapshot fence. */
export async function adoptDream(
  agentId: string,
  dreamId: string,
  force = false,
  reviewToken?: string
): Promise<DreamDto> {
  // Echo the review token from listDreamFiles so the daemon binds adoption to the
  // exact bytes reviewed (task #36 Phase B same-bytes fence).
  return apiPost<DreamDto>(`${dreamBase(agentId)}/${encodeURIComponent(dreamId)}/adopt`, {
    ...(force ? { force } : {}),
    ...(reviewToken ? { reviewToken } : {})
  })
}

export interface DreamSkillContentDto {
  name: string
  exists: boolean
  skill: string | null
  scripts: { path: string; content: string }[]
  /** Same-bytes review fence token (task #36 Phase B); present only when `exists`. */
  reviewToken?: string
}

/** Read a candidate's FULL staged body — what accepting would install. */
export async function fetchDreamSkill(agentId: string, dreamId: string, name: string): Promise<DreamSkillContentDto> {
  return apiGet<DreamSkillContentDto>(
    `${dreamBase(agentId)}/${encodeURIComponent(dreamId)}/skills/${encodeURIComponent(name)}`
  )
}

/** Accept one mined skill candidate — installs it for this agent (design §7). */
export async function acceptDreamSkill(
  agentId: string,
  dreamId: string,
  name: string,
  reviewToken?: string
): Promise<DreamDto> {
  // Echo the review token from fetchDreamSkill so the daemon binds publication to
  // the exact reviewed bytes (task #36 Phase B same-bytes fence).
  return apiPost<DreamDto>(
    `${dreamBase(agentId)}/${encodeURIComponent(dreamId)}/skills/${encodeURIComponent(name)}/accept`,
    reviewToken ? { reviewToken } : {}
  )
}

/** Dismiss one mined skill candidate — drops its staging and records the call. */
export async function dismissDreamSkill(agentId: string, dreamId: string, name: string): Promise<DreamDto> {
  return apiPost<DreamDto>(
    `${dreamBase(agentId)}/${encodeURIComponent(dreamId)}/skills/${encodeURIComponent(name)}/dismiss`,
    {}
  )
}

export async function discardDream(agentId: string, dreamId: string): Promise<DreamDto> {
  return apiPost<DreamDto>(`${dreamBase(agentId)}/${encodeURIComponent(dreamId)}/discard`, {})
}

/** List a dream's staged output files (the review surface). */
export async function listDreamFiles(agentId: string, dreamId: string): Promise<DreamFilesDto> {
  return apiGet<DreamFilesDto>(`${dreamBase(agentId)}/${encodeURIComponent(dreamId)}/files`)
}

/** Read a staged dream file WHOLE (pages every slice, like fetchAgentMemoryFull). */
export async function fetchDreamFileFull(
  agentId: string,
  dreamId: string,
  path: string
): Promise<{ exists: boolean; content: string }> {
  let offset = 0
  let content = ''
  let exists = false
  for (let guard = 0; guard < 4096; guard++) {
    const q = new URLSearchParams({ path, offset: String(offset) })
    const slice = await apiGet<AgentMemoryDto>(
      `${dreamBase(agentId)}/${encodeURIComponent(dreamId)}/file?${q.toString()}`
    )
    exists = slice.exists
    if (!slice.exists) break
    content += slice.content ?? ''
    if (!slice.truncated || slice.nextOffset == null || slice.nextOffset <= offset) break
    offset = slice.nextOffset
  }
  return { exists, content }
}

export type MemoryRecordCapability = 'recall' | 'capture' | 'list' | 'get' | 'create' | 'update' | 'delete' | 'history'

export interface MemoryAdminSurfaceDto {
  shape: 'files' | 'records' | 'none'
  capabilities: MemoryRecordCapability[]
}

export interface CanonicalMemoryRecordDto {
  id: string
  text: string
  score?: number
  scope: { kind: 'agent' | 'user' | 'session' | 'shared'; key: string }
  metadata?: Record<string, unknown>
  createdAt?: string
  updatedAt?: string
  provenance?: { pluginId: string; backendId?: string }
  version?: string
}

export interface MemoryRecordPageDto {
  records: CanonicalMemoryRecordDto[]
  nextCursor: string | null
}

export interface MemoryRecordHistoryEventDto {
  id: string
  event: 'create' | 'update' | 'delete'
  at: string
  record?: CanonicalMemoryRecordDto
}

export async function fetchMemoryAdminSurface(agentId: string): Promise<MemoryAdminSurfaceDto> {
  return apiGet<MemoryAdminSurfaceDto>(`${orgBase()}/agents/${encodeURIComponent(agentId)}/memory/surface`)
}

export async function listMemoryRecords(
  agentId: string,
  opts: { cursor?: string; limit?: number } = {}
): Promise<MemoryRecordPageDto> {
  const query = new URLSearchParams()
  if (opts.cursor) query.set('cursor', opts.cursor)
  if (opts.limit) query.set('limit', String(opts.limit))
  const suffix = query.size ? `?${query.toString()}` : ''
  return apiGet<MemoryRecordPageDto>(`${orgBase()}/agents/${encodeURIComponent(agentId)}/memory/records${suffix}`)
}

export async function searchMemoryRecords(
  agentId: string,
  queryText: string,
  opts: { topK?: number; maxBytes?: number } = {}
): Promise<MemoryRecordPageDto> {
  return apiPost<MemoryRecordPageDto>(`${orgBase()}/agents/${encodeURIComponent(agentId)}/memory/records/search`, {
    query: queryText,
    ...(opts.topK ? { topK: opts.topK } : {}),
    ...(opts.maxBytes ? { maxBytes: opts.maxBytes } : {})
  })
}

export async function getMemoryRecord(agentId: string, recordId: string): Promise<CanonicalMemoryRecordDto | null> {
  const result = await apiGet<{ record: CanonicalMemoryRecordDto | null }>(
    `${orgBase()}/agents/${encodeURIComponent(agentId)}/memory/records/${encodeURIComponent(recordId)}`
  )
  return result.record
}

export async function createMemoryRecord(
  agentId: string,
  input: { text: string; metadata?: Record<string, unknown> }
): Promise<CanonicalMemoryRecordDto> {
  const result = await apiPost<{ record: CanonicalMemoryRecordDto }>(
    `${orgBase()}/agents/${encodeURIComponent(agentId)}/memory/records`,
    input
  )
  return result.record
}

export async function updateMemoryRecord(
  agentId: string,
  recordId: string,
  input: { text: string; metadata?: Record<string, unknown>; version?: string }
): Promise<CanonicalMemoryRecordDto> {
  const result = await apiPut<{ record: CanonicalMemoryRecordDto }>(
    `${orgBase()}/agents/${encodeURIComponent(agentId)}/memory/records/${encodeURIComponent(recordId)}`,
    input
  )
  return result.record
}

export async function deleteMemoryRecord(
  agentId: string,
  recordId: string,
  version?: string
): Promise<{ id: string; deleted: boolean }> {
  return apiDelete<{ id: string; deleted: boolean }>(
    `${orgBase()}/agents/${encodeURIComponent(agentId)}/memory/records/${encodeURIComponent(recordId)}`,
    { ...(version ? { version } : {}) }
  )
}

export async function listMemoryRecordHistory(
  agentId: string,
  recordId: string,
  opts: { cursor?: string; limit?: number } = {}
): Promise<{ events: MemoryRecordHistoryEventDto[]; nextCursor: string | null }> {
  const query = new URLSearchParams()
  if (opts.cursor) query.set('cursor', opts.cursor)
  if (opts.limit) query.set('limit', String(opts.limit))
  const suffix = query.size ? `?${query.toString()}` : ''
  return apiGet<{ events: MemoryRecordHistoryEventDto[]; nextCursor: string | null }>(
    `${orgBase()}/agents/${encodeURIComponent(agentId)}/memory/records/${encodeURIComponent(recordId)}/history${suffix}`
  )
}

// One changed path in a git status. `index`/`workingDir` are git's per-file XY
// status chars (' ', 'M', 'A', 'D', 'R', 'C', 'U', '?', …).
export interface WorkspaceGitFileDto {
  path: string
  index: string
  workingDir: string
  // `git diff HEAD --numstat` — this file's change against HEAD, staged and unstaged
  // together. null ⇒ untracked, a binary change, or a daemon too old to count: a
  // count of 0 is a different fact (a file changed in the other direction only).
  additions: number | null
  deletions: number | null
}

// The HEAD commit of the workspace checkout.
export interface WorkspaceGitCommitDto {
  sha: string
  shortSha: string
  subject: string
  committedAt: string // RFC3339
}

// git status of an agent's workspace (GET /agents/:id/workspace/gitstatus).
// `isRepo:false` ⇒ a from-scratch workspace (git ops N/A). `repo`/`agentDir` come
// from the agent config; branch/commit/clean are live from the owning daemon's
// checkout. Proxied live; 503 when the daemon is offline / the agent is unplaced.
export interface WorkspaceGitStatusDto {
  isRepo: boolean
  clean: boolean
  repo: string | null // full remote address (github mode)
  agentDir: string | null // subdir within the repo the agent runs in
  branch: string | null
  tracking: string | null
  ahead: number | null
  behind: number | null
  files: WorkspaceGitFileDto[]
  truncated: boolean // true ⇒ the files list was capped
  lastCommit: WorkspaceGitCommitDto | null // null ⇒ no commits yet
  lastFetchAt: string | null // RFC3339; when the checkout last fetched/pulled
}

// Outcome of a forced ff-only pull (POST /agents/:id/workspace/gitpull). A pull
// that can't fast-forward is `ok:false` + `detail` (data), not an HTTP error.
export interface WorkspaceGitPullDto {
  isRepo: boolean
  ok: boolean
  detail: string | null
  changed: number | null
  insertions: number | null
  deletions: number | null
}

// Report whether the agent's workspace checkout is clean. Read-only; proxied live
// from the owning daemon (no CP storage). 503 when the daemon is offline.
export async function fetchWorkspaceGitStatus(
  agentId: string,
  sessionId?: string,
  repo?: string
): Promise<WorkspaceGitStatusDto> {
  const q = new URLSearchParams()
  if (sessionId) q.set('sessionId', sessionId)
  if (repo) q.set('repo', repo)
  const query = q.size ? `?${q.toString()}` : ''
  return apiGet<WorkspaceGitStatusDto>(`${orgBase()}/agents/${encodeURIComponent(agentId)}/workspace/gitstatus${query}`)
}

// Which side of the index one diff read describes. A closed vocabulary rather than a
// boolean, because the CP's querystring `staged=false` would coerce to `true`.
export type WorkspaceDiffScope = 'unstaged' | 'staged'

// One path's unified diff (GET /agents/:id/workspace/gitdiff). Every degraded answer
// is data: `isRepo:false` a from-scratch workspace, `exists:false` a path this
// checkout does not have, `diff:null` a path with no changes in this scope,
// `binary:true` a change git has no text for, `truncated` a diff cut to the frame cap.
export interface WorkspaceGitDiffDto {
  path: string
  isRepo: boolean
  exists: boolean
  diff: string | null // unified-diff text exactly as git emits it
  binary: boolean
  truncated: boolean
}

// One commit of the checked-out branch (GET /agents/:id/workspace/gitlog).
export interface WorkspaceGitLogCommitDto {
  sha: string
  shortSha: string
  subject: string
  author: string
  committedAt: string // RFC3339
  pushed: boolean // true ⇒ the branch's upstream ref already contains it
}

// The newest commits of the workspace checkout, newest first. An empty repo is data
// (`commits: []`); `tracking:null` means the branch tracks nothing, so every `pushed`
// reads false and the console must not draw unpushed markers from it. `base` names the
// ref the listing EXCLUDES — a session branch lists `<base>..HEAD`, its own work — and is
// null when the checkout sits on that base branch, where the list is its full history.
export interface WorkspaceGitLogDto {
  isRepo: boolean
  commits: WorkspaceGitLogCommitDto[]
  truncated: boolean // true ⇒ this range has more commits than the requested limit
  tracking: string | null
  base: string | null
}

// One path's unified diff, proxied live from the owning daemon (no CP storage). 409
// `DAEMON_FEATURE_MISSING` ⇒ that daemon is too old for git review reads; 400 with a
// `WORKSPACE_*` code ⇒ the daemon rejected the path; 503 ⇒ offline or unplaced.
export async function fetchWorkspaceGitDiff(
  agentId: string,
  opts: { path: string; scope?: WorkspaceDiffScope; sessionId?: string }
): Promise<WorkspaceGitDiffDto> {
  const q = new URLSearchParams({ path: opts.path })
  if (opts.sessionId) q.set('sessionId', opts.sessionId)
  if (opts.scope) q.set('scope', opts.scope)
  return apiGet<WorkspaceGitDiffDto>(
    `${orgBase()}/agents/${encodeURIComponent(agentId)}/workspace/gitdiff?${q.toString()}`
  )
}

// The newest commits of the checkout, proxied live from the owning daemon. Same
// failure surface as the diff read above. `limit` is capped at 50 by the CP (the
// wire's MAX_WORKSPACE_LOG_COMMITS); past that the request is a 400.
export async function fetchWorkspaceGitLog(
  agentId: string,
  opts: { limit?: number; sessionId?: string } = {}
): Promise<WorkspaceGitLogDto> {
  const q = new URLSearchParams()
  if (opts.sessionId) q.set('sessionId', opts.sessionId)
  if (opts.limit) q.set('limit', String(opts.limit))
  const query = q.size ? `?${q.toString()}` : ''
  return apiGet<WorkspaceGitLogDto>(`${orgBase()}/agents/${encodeURIComponent(agentId)}/workspace/gitlog${query}`)
}

// Force the owning daemon to `git pull` (fast-forward only) the agent's workspace
// now. A pull that can't fast-forward returns `ok:false`; 503 when daemon offline.
export async function workspaceGitPull(agentId: string, opts: { repo?: string } = {}): Promise<WorkspaceGitPullDto> {
  const query = opts.repo ? `?repo=${encodeURIComponent(opts.repo)}` : ''
  return apiPost<WorkspaceGitPullDto>(
    `${orgBase()}/agents/${encodeURIComponent(agentId)}/workspace/gitpull${query}`,
    {}
  )
}

// ── workspace git writes (executed only on the owning daemon; the CP stores nothing) ──
// Why a git write did not do what was asked, as a closed vocabulary: the console offers a
// different next action for each (stage something, pull before pushing, commit from the
// agent instead). Mirrors the wire's `WorkspaceGitWriteReason`; `null` when `ok`.
export type WorkspaceGitWriteReason =
  | 'not-a-repo'
  | 'nothing-staged'
  | 'empty-message'
  | 'no-identity'
  | 'detached-head'
  | 'no-upstream'
  | 'unsafe-origin'
  | 'unsafe-config'
  | 'diverged'
  | 'rejected'
  | 'failed'

// Outcome of one commit (POST /agents/:id/workspace/gitcommit). Nothing staged, a blank
// message, a daemon with no registered commit identity and a git refusal are all
// `ok:false` + `reason` (data), never HTTP errors.
export interface WorkspaceGitCommitResultDto {
  isRepo: boolean
  ok: boolean
  sha: string | null // full hash of the new commit; null unless ok
  detail: string | null // daemon-written summary or refusal (host paths stripped)
  reason: WorkspaceGitWriteReason | null
}

// Outcome of one push (POST /agents/:id/workspace/gitpush). A diverged branch, a detached
// HEAD, a branch with no upstream and a remote rejection are all `ok:false` + `reason`;
// a push with nothing to send is `ok:true` with `ahead:0`.
export interface WorkspaceGitPushResultDto {
  isRepo: boolean
  ok: boolean
  detail: string | null
  ahead: number | null // commits STILL ahead of the upstream (0 once pushed)
  reason: WorkspaceGitWriteReason | null
}

// A commit message drafted on the AGENT's own runtime (POST /agents/:id/workspace/gitmessage).
// The CP never calls a model provider (§2), so every way the draft can fail to appear is data:
// nothing staged, a runtime that declines or answers prose, a timeout.
export interface WorkspaceGitMessageResultDto {
  ok: boolean
  message: string | null // conventional-commit subject + optional body
  detail: string | null
}

// Move the named paths INTO the index of the agent's checkout (or of an authorized session
// worktree). Answers with the FRESH git status, so the caller draws the result of its own
// action without a second read. 409 ⇒ the agent is busy in that workspace, or the daemon is
// too old (`DAEMON_FEATURE_MISSING`); 403 ⇒ no edit access; 503 ⇒ offline or unplaced.
export async function stageWorkspacePaths(
  agentId: string,
  opts: { paths: string[]; sessionId?: string }
): Promise<WorkspaceGitStatusDto> {
  const q = new URLSearchParams()
  if (opts.sessionId) q.set('sessionId', opts.sessionId)
  const query = q.size ? `?${q.toString()}` : ''
  return apiPost<WorkspaceGitStatusDto>(
    `${orgBase()}/agents/${encodeURIComponent(agentId)}/workspace/gitstage${query}`,
    { paths: opts.paths }
  )
}

// The same, out of the index. The working tree is never touched, so nothing the agent wrote
// is lost. Same fresh-status answer and same failure surface as staging.
export async function unstageWorkspacePaths(
  agentId: string,
  opts: { paths: string[]; sessionId?: string }
): Promise<WorkspaceGitStatusDto> {
  const q = new URLSearchParams()
  if (opts.sessionId) q.set('sessionId', opts.sessionId)
  const query = q.size ? `?${q.toString()}` : ''
  return apiPost<WorkspaceGitStatusDto>(
    `${orgBase()}/agents/${encodeURIComponent(agentId)}/workspace/gitunstage${query}`,
    { paths: opts.paths }
  )
}

// Commit whatever is staged, attributed to the identity the daemon registered at handshake —
// never to the console user. A refusal is `ok:false` + `reason`, not an HTTP error.
export async function commitWorkspace(
  agentId: string,
  opts: { message: string; sessionId?: string }
): Promise<WorkspaceGitCommitResultDto> {
  const q = new URLSearchParams()
  if (opts.sessionId) q.set('sessionId', opts.sessionId)
  const query = q.size ? `?${q.toString()}` : ''
  return apiPost<WorkspaceGitCommitResultDto>(
    `${orgBase()}/agents/${encodeURIComponent(agentId)}/workspace/gitcommit${query}`,
    { message: opts.message }
  )
}

// Push the checked-out branch to the remote the owning daemon authorizes. The daemon derives
// the refspec and never forces, so every rejection comes back as data.
export async function pushWorkspace(
  agentId: string,
  opts: { sessionId?: string } = {}
): Promise<WorkspaceGitPushResultDto> {
  const q = new URLSearchParams()
  if (opts.sessionId) q.set('sessionId', opts.sessionId)
  const query = q.size ? `?${q.toString()}` : ''
  return apiPost<WorkspaceGitPushResultDto>(
    `${orgBase()}/agents/${encodeURIComponent(agentId)}/workspace/gitpush${query}`,
    {}
  )
}

// Ask the owning daemon to draft a commit message from the staged diff, on the agent's own
// runtime. It spends model tokens, so it is only ever sent for an explicit press (§5.1) and
// writes nothing — the reader edits the draft and commits it separately.
export async function draftWorkspaceCommitMessage(
  agentId: string,
  opts: { sessionId?: string } = {}
): Promise<WorkspaceGitMessageResultDto> {
  const q = new URLSearchParams()
  if (opts.sessionId) q.set('sessionId', opts.sessionId)
  const query = q.size ? `?${q.toString()}` : ''
  return apiPost<WorkspaceGitMessageResultDto>(
    `${orgBase()}/agents/${encodeURIComponent(agentId)}/workspace/gitmessage${query}`,
    {}
  )
}

// ── session background tasks (proxied live from the owning daemon's lease) ────
// What the daemon can know about a task, and nothing more. No `queued`: the runtime lifecycle
// feed's only start edge is `task_started`, so a task is either live in the lease or gone. `done`
// means "settled with no reported failure" rather than "reported successful", because most settle
// edges carry no status at all — `detail` carries one when the runtime named it.
export type AgentTaskState = 'running' | 'done' | 'failed'

// One background task of one ACP session. `subagent` is the runtime's own internal Task
// invocation; the wire carries those rather than filtering them, because the same records fence
// host reclaim — so this panel shows them marked instead of hiding them (webchat-side-panels.md §3.5).
export interface AgentTaskDto {
  id: string
  description: string | null // null ⇒ the runtime named none
  state: AgentTaskState
  subagent: boolean
  startedAt: string // RFC3339
  endedAt: string | null // RFC3339; null ⇒ still running
  detail: string | null // the terminal status the runtime reported, when it named one
}

// GET /agents/:id/tasks?sessionId=… — live tasks first, then the daemon's bounded settled
// history. `tracked:false` means that daemon holds no lease for the session (a runtime that
// reports no task lifecycle, or one that has not yet), which is a different answer from an empty
// list and the panel says so.
export interface AgentTasksDto {
  sessionId: string
  tracked: boolean
  tasks: AgentTaskDto[]
  truncated: boolean // true ⇒ the daemon held more tasks than this page carries
}

// Read one ACP session's background tasks. `sessionId` is REQUIRED, unlike the workspace reads:
// the lease is per (agent, ACP session) and there is no per-agent aggregate to answer with. There
// is no cancel counterpart — no agent-protocol primitive can address a single background task.
// POST /agents/:id/wake — bring a cluster agent's sandbox to Running WITHOUT a turn, so a Files read that
// refused with the sandbox-asleep code has something to press. What the daemon observed, never a promise:
// `starting` means poll the read; `unsupported` means there was nothing to wake (a machine-placed agent).
export type AgentWakeState = 'running' | 'starting' | 'unsupported'
export interface AgentWakeDto {
  state: AgentWakeState
}

export async function wakeAgent(agentId: string): Promise<AgentWakeDto> {
  return apiPost<AgentWakeDto>(`${orgBase()}/agents/${encodeURIComponent(agentId)}/wake`, {})
}

export async function fetchAgentTasks(agentId: string, sessionId: string): Promise<AgentTasksDto> {
  const q = new URLSearchParams({ sessionId })
  return apiGet<AgentTasksDto>(`${orgBase()}/agents/${encodeURIComponent(agentId)}/tasks?${q.toString()}`)
}

// ── session pull request (identity from the CP's own records; live state proxied from GitHub, never stored) ──
// One check on the PR's head commit, over one vocabulary regardless of which kind of check reported it.
export interface SessionPullRequestCheckDto {
  name: string
  state: 'success' | 'failure' | 'pending' | 'skipped' | 'neutral'
  detail: string | null // GitHub's own word for it, verbatim
  startedAt: string | null
  completedAt: string | null
  url: string | null
}

// One reviewer's CURRENT review, not one review event; `isBot` ⇒ a GitHub App identity, not a person.
export interface SessionPullRequestReviewDto {
  author: string
  state: 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending'
  isBot: boolean
}

// One UNRESOLVED review thread. Bodies are user content: proxied through the CP, never persisted.
export interface SessionPullRequestThreadDto {
  location: string // `path:line`, the path alone, or a PR-level thread
  body: string
  author: string
  isOutdated: boolean
}

// GET /sessions/:id/pull-request — the PR this session was dispatched for. `degraded` makes a GitHub
// failure DATA: identity survives, the live lists come back empty, and the nullable fields fall back
// to what the CP already knows (or null). A session with NO linked run 404s, which hides the tab.
export interface SessionPullRequestDto {
  repoFullName: string
  pullNumber: number
  title: string
  body: string // the PR description as plain text; empty while degraded
  state: 'open' | 'closed' | 'merged' | null // null only degraded with no stored fact
  isDraft: boolean | null
  url: string
  headRef: string
  baseRef: string
  additions: number | null // null while degraded — no stored line counts to fall back on
  deletions: number | null
  reviewDecision: 'approved' | 'changes_requested' | 'review_required' | null
  checks: SessionPullRequestCheckDto[]
  checksTruncated: boolean
  reviews: SessionPullRequestReviewDto[]
  threads: SessionPullRequestThreadDto[]
  unresolvedCount: number // a floor when `threadsTruncated`
  threadsTruncated: boolean
  /** Whether a merge-when-ready watcher is armed at the EDGE right now; null ⇒ nobody could be asked (no live daemon, or one too old to serve the read), which the panel draws as unknown rather than as "off". */
  autoMergeArmed: boolean | null
  /** Where that watcher runs, and so how long it lives: `sandbox` dies with the agent's pod, `daemon` with the daemon process. Null when nothing is armed. */
  autoMergePlacement?: 'sandbox' | 'daemon' | null
  /** The watcher's own last verdict — "checks running: build", "changes requested", "conflicts with the base branch". */
  autoMergeWaitingOn?: string | null
  /** A GitHub refusal or unreachable GitHub on the last tick. The watcher stays armed through it. */
  autoMergeError?: string | null
  canArmAutoMerge: boolean // the owning agent's clamp allows the write; false renders a disabled control
  degraded: boolean
  degradedReason: 'rate_limited' | 'denied' | 'unreachable' | null
  /** The agent's own recorded review, present ONLY on a degraded answer — the one review state the deployment knows without GitHub. */
  agentReview: 'approved' | 'changes_requested' | 'commented' | null
  /** Which source named this PR: the owning review run, or this session's own head branch. Optional — a CP that predates the branch source sends neither this nor the two fields below. */
  linkedBy?: 'run' | 'head-branch'
  /** The head branch a `head-branch` link resolved through; null for a run-linked PR. */
  linkBranch?: string | null
  /** Whose checkout that branch was read from: this session's own worktree, or the agent's `shared` primary tree, where every session on the agent works. */
  linkScope?: 'session' | 'shared' | null
  /** true ⇒ that branch has more than one OPEN pull request and this is the first of them. */
  linkAmbiguous?: boolean
}

// Read the session's PR projection. `refresh` bypasses the CP's short TTL but not its in-flight
// coalescing, so a double press is still one GitHub read; plain reads ride the cache.
export async function fetchSessionPullRequest(
  sessionId: string,
  opts: { refresh?: boolean } = {}
): Promise<SessionPullRequestDto> {
  const query = opts.refresh ? '?refresh=true' : ''
  return apiGet<SessionPullRequestDto>(`${orgBase()}/sessions/${encodeURIComponent(sessionId)}/pull-request${query}`)
}

/** The edge watcher's state after an arm/disarm. */
export interface SessionPullRequestAutoMergeDto {
  armed: boolean
  placement: 'sandbox' | 'daemon' | null
  waitingOn: string | null
  error: string | null
}

// Arm/disarm merge-when-ready on the session's PR. The watcher runs at the EDGE — in the agent's
// sandbox, or its daemon's process — and squash-merges once the PR is open, undrafted, conflict-free,
// with no failing or running check and no requested changes. Deliberately NOT GitHub's own
// auto-merge, which refuses every PR that is not BLOCKED and so can never be armed on a repository
// without required checks. Nothing is persisted: the armed set is in memory at the edge, so a
// reclaimed sandbox or a restarted daemon reads back unchecked. 409 ⇒ no daemon, or an image with no
// watcher; 503 ⇒ the daemon is offline.
export async function setSessionPullRequestAutoMerge(
  sessionId: string,
  enabled: boolean
): Promise<SessionPullRequestAutoMergeDto> {
  return apiPost<SessionPullRequestAutoMergeDto>(
    `${orgBase()}/sessions/${encodeURIComponent(sessionId)}/pull-request/auto-merge`,
    { enabled }
  )
}

/** What the edge is holding this session's sandbox for, and for how long. */
export interface SessionSandboxKeepAliveDto {
  held: boolean
  reasons: Array<'uncommitted-files' | 'auto-merge-armed'>
  ttlMs: number | null
  placement: 'sandbox' | 'daemon' | null
  asleep: boolean
}

// Renew this page's lease on the session agent's sandbox pod, so the idle sweep does not suspend work
// the page is watching. The DAEMON decides whether to hold — uncommitted files in this session's
// worktree, or an armed merge-when-ready watcher, which for a cluster agent lives inside that very pod.
// A lease, not a flag: there is nothing to release, and it lapses within one TTL once this stops being
// called (page closed, tab backgrounded, machine asleep). Never wakes a suspended pod.
export async function keepSessionSandboxAlive(sessionId: string): Promise<SessionSandboxKeepAliveDto> {
  return apiPost<SessionSandboxKeepAliveDto>(
    `${orgBase()}/sessions/${encodeURIComponent(sessionId)}/sandbox-keep-alive`,
    {}
  )
}

// Merge the session's PR (squash) now, under the owning agent's clamped grant. A 409 relays GitHub
// declining the merge (not mergeable, checks failing); an already-merged PR succeeds idempotently.
export async function mergeSessionPullRequest(sessionId: string): Promise<{ merged: boolean }> {
  return apiPost<{ merged: boolean }>(`${orgBase()}/sessions/${encodeURIComponent(sessionId)}/pull-request/merge`, {})
}

// ── usage dashboard (GET /usage) — real historical aggregates from the CP's
// persisted per-session usage store, summed over a window this client computes. ──
/** The console's window presets. The ROUTE takes an explicit `[from, to)`; these are
 *  purely this client's shorthand, resolved at fetch time. */
export type UsageRange = 'd1' | 'd7' | 'd30' | 'd90'
const RANGE_DAYS: Record<UsageRange, number> = { d1: 1, d7: 7, d30: 30, d90: 90 }

/** Which authenticated ingress metered a session. */
export type UsageSource = 'daemon' | 'gateway'

export interface UsageAgentDto {
  agentId: string
  sessions: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  thoughtTokens: number
  cachedReadTokens: number
  cachedWriteTokens: number
  /** Exact decimal string — the CP never rounds a cost. Format it; add with
   *  `sumAmounts` from `lib/amount` rather than as a float. */
  costAmount: string
}

export interface UsageModelDto extends Omit<UsageAgentDto, 'agentId'> {
  model: string | null
}

export interface UsageSourceDto extends Omit<UsageAgentDto, 'agentId'> {
  source: UsageSource
}

export interface UsageDto {
  /** The window the CP aggregated, echoed back. */
  from: string
  to: string
  accessSyncDegraded?: boolean
  accessIssues?: SessionAccessIssue[]
  totals: { sessions: number; totalTokens: number; costAmount: string; costCurrency: string | null }
  agents: UsageAgentDto[]
  models: UsageModelDto[]
  sources: UsageSourceDto[]
  /** What `totals` holds that this caller may not attribute to an agent, as one rollup
   *  with no id — so `Σ agents + unattributed = totals`, and the same for `models`.
   *  Withheld by EITHER predicate: a restricted agent, or another user's private session
   *  on an agent this caller CAN see. So a UI names it for the USAGE, never for agents.
   *  Absent (never zeroed) when the caller could attribute every row, and it carries no
   *  count. Optional on the wire for a CP that predates it. */
  unattributed?: Omit<UsageAgentDto, 'agentId'>
  // Spend-over-time chart: cost bucketed by hour (a window of two days or less) or day,
  // empty buckets filled to 0. `start` is a UTC-aligned ISO instant. `byAgent`/
  // `byModel` split each bucket's total for the grouped/stacked view (model key
  // ''=unreported); optional so a CP predating them degrades to flat bars.
  //
  // Viewer-scoped, per-bucket total included, so a bucket never hands over withheld spend
  // resolved in time. So it does NOT sum to `totals` when `unattributed` is present, and
  // anything showing both has to say which is which.
  series: {
    bucket: 'hour' | 'day'
    points: {
      start: string
      costAmount: string
      byAgent?: Record<string, string>
      byModel?: Record<string, string>
    }[]
  }
}

/** Resolve a preset to the half-open window the route wants. Exported for the tests
 *  that pin the preset → window arithmetic. */
export function usageWindow(range: UsageRange, now: Date = new Date()): { from: string; to: string } {
  const to = now
  const from = new Date(to.getTime() - RANGE_DAYS[range] * 24 * 60 * 60 * 1000)
  return { from: from.toISOString(), to: to.toISOString() }
}

// The agents this viewer may see gateway spend attributed to, for one explicit window.
//
// `/usage` intersects Agent visibility with the request-time Session predicate, so an id in its
// `agents` list is one the Analytics page ALREADY names to this viewer for this window — that
// membership is the billing ledger's naming gate. Per the billing exception in
// `session-visibility.md` §5, a named agent's per-charge amount may include spend the projection
// itself withholds; accepted there deliberately, so do not "fix" it back to a period-completeness
// gate — that shape blanked every org with any private session (#1498 follow-up). An id absent
// from the list stays id-less on every billing row.
//
// `source=gateway` because that is the ingress a billing charge settles from (see the route's
// own note): unscoped, a readable DAEMON session could qualify an agent whose gateway spend is
// entirely private.
export async function fetchGatewayAttribution(from: string, to: string, orgId?: string): Promise<Set<string>> {
  const query = new URLSearchParams({ from, to, source: 'gateway' })
  const usage = await apiGet<UsageDto>(`${orgBase(orgId)}/usage?${query.toString()}`)
  return new Set(usage.agents.map((a) => a.agentId))
}

export async function fetchUsage(range: UsageRange, orgId?: string, source?: UsageSource): Promise<UsageDto> {
  // Send the viewer's tz offset so the CP buckets the spend series to local
  // day/hour (getTimezoneOffset ⇒ UTC − local; stable per client, not in the key).
  const tz = new Date().getTimezoneOffset()
  const { from, to } = usageWindow(range)
  const query = new URLSearchParams({ from, to, tz: String(tz), ...(source ? { source } : {}) })
  return apiGet<UsageDto>(`${orgBase(orgId)}/usage?${query.toString()}`)
}

// Edit an agent's spec (PATCH /agents/:id). The CP persists it and hot-syncs the
// owning daemon's replica.
export async function updateAgent(agentId: string, patch: UpdateAgentInput): Promise<Agent> {
  const agent = agentFromDto(await apiPatch<AgentDto>(`${orgBase()}/agents/${encodeURIComponent(agentId)}`, patch))
  track('agent_updated', { org_id: apiOrgId, agent_id: agent.id, runtime: agent.runtime, model: agent.model ?? null })
  return agent
}

export interface AgentPermissionRequestDto {
  id: string
  agentId: string
  sessionId?: string
  createdAt: string
  requesterId: string | null
  requesterName: string | null
  command: string
  status: 'pending' | 'allowed' | 'denied' | 'expired'
  resolvedAt: string | null
  resolvedBy?: string | null
  resolvedByName?: string | null
}

/** Live daemon-owned approval queue. The CP proxies it and never persists the rows. */
export async function fetchAgentPermissionRequests(agentId: string): Promise<AgentPermissionRequestDto[]> {
  const page = await apiGet<{ requests: AgentPermissionRequestDto[] }>(
    `${orgBase()}/agents/${encodeURIComponent(agentId)}/permission-requests`
  )
  return page.requests
}

export async function decideAgentPermissionRequest(
  agentId: string,
  requestId: string,
  decision: 'allow' | 'deny'
): Promise<void> {
  await apiPost<{ ok: true }>(
    `${orgBase()}/agents/${encodeURIComponent(agentId)}/permission-requests/${encodeURIComponent(requestId)}/decision`,
    { decision }
  )
}

/** The icon upload/delete result — the new descriptor + resolved display URL. */
export interface IconResult {
  icon: AgentIcon | null
  iconUrl: string | null
}

// Raw image/* PUT (docs/designs/icon-uploads.md): the CP proxies the upload to the
// object store, so we send the resized blob directly (not JSON). Returns the new
// icon descriptor + resolved store URL, reassembled into {kind:'image',url} for callers.
async function putIconBlob(path: string, blob: Blob): Promise<IconResult> {
  const res = await authenticatedFetch(
    path,
    { method: 'PUT', body: blob },
    { 'content-type': blob.type || 'application/octet-stream' }
  )
  if (!res.ok) throw await apiErrorFromResponse('PUT', path, res)
  const d = (await res.json()) as IconResult
  return { icon: withIconUrl(d.icon, d.iconUrl), iconUrl: d.iconUrl }
}

async function deleteIcon(path: string): Promise<IconResult> {
  const res = await authenticatedFetch(path, { method: 'DELETE' })
  if (!res.ok) throw await apiErrorFromResponse('DELETE', path, res)
  const d = (await res.json()) as IconResult
  return { icon: withIconUrl(d.icon, d.iconUrl), iconUrl: d.iconUrl }
}

export function uploadAgentIcon(agentId: string, blob: Blob): Promise<IconResult> {
  return putIconBlob(`${orgBase()}/agents/${encodeURIComponent(agentId)}/icon`, blob)
}
export function deleteAgentIcon(agentId: string): Promise<IconResult> {
  return deleteIcon(`${orgBase()}/agents/${encodeURIComponent(agentId)}/icon`)
}
export function uploadOrgIcon(blob: Blob, orgId?: string): Promise<IconResult> {
  return putIconBlob(`${orgBase(orgId)}/icon`, blob)
}
export function deleteOrgIcon(orgId?: string): Promise<IconResult> {
  return deleteIcon(`${orgBase(orgId)}/icon`)
}

/** Acknowledged cold workspace edit. */
export async function setAgentWorkspace(agentId: string, input: SetAgentWorkspaceInput): Promise<Agent> {
  return agentFromDto(await apiPut<AgentDto>(`${orgBase()}/agents/${encodeURIComponent(agentId)}/workspace`, input))
}

// Hard-cut an agent over to another daemon. A normal move coordinates an
// acknowledged source fence/cancel and destination activation; `force` is the
// explicit recovery path when the source cannot ACK. This stays separate from
// the ordinary spec PATCH because placement changes have runtime side effects.
/** A move target: one machine, the pool as a whole (submitted as the `pool` sugar), or one of the
 *  org's own groups. Both set kinds name the SET — whichever member holds the duty serves it. */
export type AgentPlacementTarget =
  { kind: 'daemon'; daemonId: string } | { kind: 'pool' } | { kind: 'set'; setId: string }

export async function moveAgent(
  agentId: string,
  target: AgentPlacementTarget,
  options: { force?: boolean } = {}
): Promise<Agent> {
  const moved = agentFromDto(
    await apiPut<AgentDto>(`${orgBase()}/agents/${encodeURIComponent(agentId)}/daemon`, {
      ...(target.kind === 'pool'
        ? { placementKind: 'pool' }
        : target.kind === 'set'
          ? { placementKind: 'set', setId: target.setId }
          : { daemonId: target.daemonId }),
      ...(options.force ? { force: true } : {})
    })
  )
  track('agent_moved', {
    org_id: apiOrgId,
    agent_id: moved.id,
    to_daemon_id: target.kind === 'pool' ? 'pool' : target.kind === 'set' ? `set:${target.setId}` : target.daemonId,
    force: options.force === true
  })
  return moved
}

// Set an agent's visibility + share set (PUT /agents/:id/sharing). Separate from the
// content PATCH; gated server-side by canManageSharing.
export async function updateAgentSharing(agentId: string, body: SharingInput): Promise<Agent> {
  return agentFromDto(await apiPut<AgentDto>(`${orgBase()}/agents/${encodeURIComponent(agentId)}/sharing`, body))
}

// Set both directions of agent-to-agent visibility/call authorization. Uses the
// normal agent edit gate (`canEdit` in the DTO).
export async function updateAgentCallPolicy(agentId: string, body: AgentCallPolicyInput): Promise<Agent> {
  return agentFromDto(await apiPut<AgentDto>(`${orgBase()}/agents/${encodeURIComponent(agentId)}/call-policy`, body))
}

// The fleet reads split by change rate: `/daemons` is polled for liveness, `/daemons/
// capabilities` moves only when a daemon connects/upgrades/re-probes, and a runtime's
// model catalog is read one daemon at a time. `DaemonRow` is stitched back together in
// the data context, so views still see one object.
export async function fetchDaemons(orgId?: string): Promise<DaemonRow[]> {
  return (await apiGet<DaemonFleetDto[]>(`${orgBase(orgId)}/daemons`)).map(daemonFromDto)
}

/** Fleet-wide capability, keyed by daemon id — merged onto the liveness rows. */
export async function fetchDaemonCapabilities(orgId?: string): Promise<Map<string, DaemonCapabilityDto>> {
  const rows = await apiGet<DaemonCapabilityDto[]>(`${orgBase(orgId)}/daemons/capabilities`)
  return new Map(rows.map((r) => [r.daemonId, r]))
}

/** One daemon in full — the only read that carries each runtime's model catalog. */
export async function fetchDaemon(daemonId: string): Promise<DaemonRow> {
  return daemonFromDto(await apiGet<DaemonViewDto>(`${orgBase()}/daemons/${encodeURIComponent(daemonId)}`))
}

// Assign a human-friendly display name to a connected daemon.
export async function renameDaemon(daemonId: string, name: string): Promise<DaemonRow> {
  return daemonFromDto(await apiPatch<DaemonViewDto>(`${orgBase()}/daemons/${encodeURIComponent(daemonId)}`, { name }))
}

// Set how long the daemon keeps finished sessions before deleting them ("Expire
// sessions"). The CP hot-pushes the window to a connected daemon.
export async function updateDaemonSessionRetention(
  daemonId: string,
  sessionRetention: DaemonSessionRetention
): Promise<DaemonRow> {
  return daemonFromDto(
    await apiPatch<DaemonViewDto>(`${orgBase()}/daemons/${encodeURIComponent(daemonId)}`, { sessionRetention })
  )
}

// Set a daemon's visibility + share set (PUT /daemons/:id/sharing).
export async function updateDaemonSharing(daemonId: string, body: SharingInput): Promise<DaemonRow> {
  return daemonFromDto(
    await apiPut<DaemonViewDto>(`${orgBase()}/daemons/${encodeURIComponent(daemonId)}/sharing`, body)
  )
}

export async function createAgent(input: CreateAgentInput): Promise<Agent> {
  const agent = agentFromDto(await apiPost<AgentDto>(`${orgBase()}/agents`, { capabilities: [], ...input }))
  track('agent_created', {
    org_id: apiOrgId,
    agent_id: agent.id,
    runtime: agent.runtime,
    model: agent.model ?? null,
    has_workspace: agent.workspace?.mode !== 'scratch'
  })
  return agent
}

// Provision a NEW daemon (a `provisioned` row + its first API key) and render the
// start command. The daemon flips to `ready` in `fetchDaemons()` once it authenticates.
export async function provisionDaemon(): Promise<DaemonConnectDto> {
  return apiPost<DaemonConnectDto>(`${orgBase()}/daemons/token`, {})
}

// List a daemon's API keys (never the secret/hash) for the console.
export async function fetchDaemonKeys(daemonId: string): Promise<ApiKeyDto[]> {
  return apiGet<ApiKeyDto[]>(`${orgBase()}/daemons/${encodeURIComponent(daemonId)}/keys`)
}

// Mint an additional key for an existing daemon (rotate / "Regenerate"). Returns the
// one-time plaintext + a ready-to-run command.
export async function mintDaemonKey(daemonId: string): Promise<MintedKeyDto> {
  const minted = await apiPost<MintedKeyDto>(`${orgBase()}/daemons/${encodeURIComponent(daemonId)}/keys`, {})
  track('api_key_issued', { org_id: apiOrgId, daemon_id: daemonId })
  return minted
}

// Revoke a key (kill switch). The next reconnect with it fails closed (4401).
export async function revokeDaemonKey(daemonId: string, keyId: string): Promise<ApiKeyDto> {
  const view = await apiDelete<ApiKeyDto>(
    `${orgBase()}/daemons/${encodeURIComponent(daemonId)}/keys/${encodeURIComponent(keyId)}`
  )
  track('api_key_revoked', { org_id: apiOrgId, daemon_id: daemonId, key_id: keyId })
  return view
}

// Remove a daemon from the fleet. The CP refuses (409) while it is online — only an
// offline daemon can be deleted (mirrors the console's offline-only delete action).
export async function deleteDaemon(daemonId: string): Promise<void> {
  await apiDelete<void>(`${orgBase()}/daemons/${encodeURIComponent(daemonId)}`)
}

// Command a daemon to drain + relaunch on the SAME version (supervisor restart). Returns
// the opened lifecycle op (with its id) — the 202 only means the daemon accepted; success
// shows up as that op reaching `succeeded` in the fleet read model's lifecycleOp. Owner-only;
// 503 offline, 409 in-flight/declined.
export async function restartDaemon(daemonId: string): Promise<DaemonLifecycleOpDto> {
  return apiPost<DaemonLifecycleOpDto>(`${orgBase()}/daemons/${encodeURIComponent(daemonId)}/restart`, {})
}

// Command a daemon to install `version` via its CLI, then drain + relaunch onto it.
// Returns the opened op; same track-by-id contract as restart above.
export async function upgradeDaemon(daemonId: string, version: string): Promise<DaemonLifecycleOpDto> {
  return apiPost<DaemonLifecycleOpDto>(`${orgBase()}/daemons/${encodeURIComponent(daemonId)}/upgrade`, { version })
}

// Poll a specific lifecycle op by id (status expiry-projected). The modal tracks the
// op it commanded through THIS, not the fleet read model's single latest-op slot — so a
// newer op from another client can't strand its polling. 404 ⇒ null (unknown/foreign id).
export async function getDaemonLifecycleOp(daemonId: string, opId: string): Promise<DaemonLifecycleOpDto | null> {
  try {
    return await apiGet<DaemonLifecycleOpDto>(
      `${orgBase()}/daemons/${encodeURIComponent(daemonId)}/lifecycle/${encodeURIComponent(opId)}`
    )
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null
    throw e
  }
}

// ── integrations ──────────────────────────────────────────────────────────────
export async function fetchIntegrations(orgId?: string): Promise<IntegrationDto[]> {
  return apiGet<IntegrationDto[]>(`${orgBase(orgId)}/integrations`)
}

// Install a platform connection (`POST /integrations`). The response is metadata only
// (never the tokens); the CP delivers the tokens to the owning agent's daemon.
export async function createIntegration(input: CreateIntegrationInput): Promise<IntegrationDto> {
  return apiPost<IntegrationDto>(`${orgBase()}/integrations`, input)
}

/** Validate a pasted Telegram token and its Group Privacy Mode without storing it. */
export async function checkTelegramBot(botToken: string): Promise<TelegramBotCheckDto> {
  return apiPost<TelegramBotCheckDto>(`${orgBase()}/integrations/telegram/check`, { botToken })
}

// ── Feishu/Lark one-click app registration ──
// Start the official device flow and receive a normal browser deeplink. The CP
// keeps polling and installs the returned credentials without exposing them here.
export async function startFeishuRegistration(
  input: StartFeishuRegistrationInput
): Promise<FeishuRegistrationStartDto> {
  return apiPost<FeishuRegistrationStartDto>(`${orgBase()}/integrations/feishu/app`, input)
}
export async function getFeishuRegistration(id: string): Promise<FeishuRegistrationStatusDto> {
  return apiGet<FeishuRegistrationStatusDto>(`${orgBase()}/integrations/feishu/app/${encodeURIComponent(id)}`)
}

// ── Slack auto-install funnel ──
// Start the funnel: the CP creates the app from a manifest and returns the OAuth
// install URL. Throws ApiError(404) when the server hasn't enabled the funnel
// (no PUBLIC_CP_URL) — the modal falls back to the manual manifest flow.
export async function startSlackInstall(input: StartSlackInstallInput): Promise<SlackInstallStartDto> {
  return apiPost<SlackInstallStartDto>(`${orgBase()}/integrations/slack/app`, input)
}
// Poll funnel progress while the user approves the install in the other tab.
export async function getSlackInstall(installId: string): Promise<SlackInstallStatusDto> {
  return apiGet<SlackInstallStatusDto>(`${orgBase()}/integrations/slack/app/${encodeURIComponent(installId)}`)
}
// Finalize the auto-install. Socket: hand the CP the pasted app-level token, which
// it combines with the OAuth-obtained bot token to create the bot + integration.
// Http: no app-level token — the CP reads the app's signing secret via the caller's
// config token, so finalize is fully automatic. Metadata only back.
export async function finalizeSlackInstall(
  installId: string,
  opts?: { appToken?: string; shareable?: boolean }
): Promise<IntegrationDto> {
  return apiPost<IntegrationDto>(`${orgBase()}/integrations/slack/app/${encodeURIComponent(installId)}/finalize`, {
    ...(opts?.appToken ? { appToken: opts.appToken } : {}),
    ...(opts?.shareable ? { shareable: true } : {})
  })
}

// ── Platform-published "Add to Slack" app (preset-agents.md §5.3) ──
// Mint a pending install of the deployment's distributed Slack app and get the
// slack.com authorize URL to open. A generic install may select an agent (the CP
// otherwise defaults to the org preset); Settings supplies `botId` to fence a
// reauthorization to the bot's existing workspace. The callback finishes the
// install server-side; the console polls the row below to learn when it landed.
export async function startSlackPlatformInstall(
  input: { agentId?: string; botId?: string } = {}
): Promise<SlackPlatformInstallDto> {
  return apiPost<SlackPlatformInstallDto>(`${orgBase()}/integrations/slack/platform-install`, input)
}

// Poll one platform-app install to completion. The ROW's terminal state is the
// signal, deliberately not "did a new integration appear": re-authorizing a
// workspace the agent already has only rotates the token, creating no
// integration, so list growth would never fire on that path.
export async function getSlackPlatformInstall(id: string): Promise<SlackPlatformInstallStatusDto> {
  return apiGet<SlackPlatformInstallStatusDto>(`${orgBase()}/integrations/slack/platform-install/${id}`)
}

// ── Slack org config token (Settings) ──
// The org's stored App Configuration token. Present ⇒ the create modal forces the
// auto-install flow; absent ⇒ manual. GET never returns the token.
export async function fetchSlackConfig(): Promise<SlackConfigDto> {
  return apiGet<SlackConfigDto>(`${orgBase()}/slack/config`)
}
export async function saveSlackConfig(input: SlackConfigInput): Promise<SlackConfigDto> {
  return apiPut<SlackConfigDto>(`${orgBase()}/slack/config`, input)
}
export async function deleteSlackConfig(): Promise<void> {
  await apiDelete<void>(`${orgBase()}/slack/config`)
}

// ── Linear workspace connect funnel (linear-integration.md §7.1, §7.4) ──
// A Linear bot IS one connected workspace, and agents are members of it. The
// funnel mints a one-shot OAuth state bound to this org and the workspace's chosen
// default agent; no bot or integration row exists until the callback completes.

/** A started connect round trip: the funnel row id (which IS the OAuth `state`)
 *  and the linear.app authorize URL to open. */
export interface LinearConnectStartDto {
  id: string
  connectUrl: string
}

/** Poll answer for one connect round trip. `failureReason` is a short server code
 *  (`denied` / `expired` / `workspace_taken` / `wrong_workspace` /
 *  `default_agent_required` / `agent_missing` / `error`), never prose. */
export interface LinearConnectStatusDto {
  id: string
  status: 'pending' | 'completed' | 'failed'
  failureReason: string | null
  botId: string | null
}

// Start connecting a workspace. `agentId` becomes its default agent — the member a
// bare delegation starts a session with. Throws ApiError(404) when the deployment
// has no Linear app, which is the console's only signal that it is unconfigured.
export async function startLinearConnect(agentId: string): Promise<LinearConnectStartDto> {
  return apiPost<LinearConnectStartDto>(`${orgBase()}/integrations/linear/connect`, { agentId })
}

// Poll one connect row while the user authorizes in the other tab. The ROW's
// terminal state is the signal: the OAuth tab is a throwaway, so a tail refusal
// (workspace claimed elsewhere, wrong workspace) has no other channel back.
export async function getLinearConnect(id: string): Promise<LinearConnectStatusDto> {
  return apiGet<LinearConnectStatusDto>(`${orgBase()}/integrations/linear/connect/${encodeURIComponent(id)}`)
}

// Restart the funnel against an already-connected workspace whose grant died. The
// nonce is bound to this bot, so authorizing a different workspace is refused.
export async function reconnectLinearWorkspace(botId: string): Promise<LinearConnectStartDto> {
  return apiPost<LinearConnectStartDto>(`${orgBase()}/bots/${encodeURIComponent(botId)}/linear/reconnect`, {})
}

// Disconnect a workspace for the whole organization: every membership and then the bot
// itself, in ONE call. The console must NOT loop `deleteIntegration` here — the list it
// would loop over is visibility-filtered, so a member on an agent outside the caller's
// audience is invisible to it and the workspace would be left half unlinked.
export async function disconnectLinearWorkspace(botId: string): Promise<void> {
  await apiPost<void>(`${orgBase()}/bots/${encodeURIComponent(botId)}/linear/disconnect`, {})
}

// Uninstall an integration (`DELETE /integrations/:id`): drops the CP record and
// tells the owning daemon to close the connection. The BOT survives (freed) — it
// shows up in the Add-integration picker for reuse.
export async function deleteIntegration(id: string): Promise<void> {
  await apiDelete<void>(`${orgBase()}/integrations/${encodeURIComponent(id)}`)
}

// ── Hooks (inbound webhook triggers — webhook-triggers-and-github-events.md) ──

// A hook definition row. `url` is the full public ingress URL (relay-pool based),
// a capability URL the CP surfaces only to callers with edit rights.
// The hook-kind vocabulary is the shared wire contract's, not a copy: a new code
// host widens it there and every mapping over it in the console must be extended.
export type { HookKind }
export type GithubCommentFamily = 'issues' | 'pull_request'
/** GitLab's own note families — the merge-request counterpart of a pull request. */
export type GitlabCommentFamily = 'issues' | 'merge_request'
/** The subject family ONE code-host row covers: a row is `(agent, repo, family)`,
 *  each with its own cadence and mention gate, and the family is immutable. */
export type GithubHookFamily = 'pull_request' | 'issues' | 'push'
export type GitlabHookFamily = 'merge_request' | 'issues' | 'push'
/** The stored union across code hosts; each row carries only its own host's subset. */
export type HookCommentFamily = GithubCommentFamily | GitlabCommentFamily
export type HookReviewPolicy = 'off' | 'comment' | 'request_changes' | 'full'
// R2a intentionally exposes informational Checks only. `status` is R3.
export type HookReportingMode = 'off' | 'check'
// `required` remains server-rejected until the R2b acceptance gates pass.
export type HookGateMode = 'informational'

export interface HookDto {
  id: string
  agentId: string | null // null ⇒ orphaned by agent delete (inert)
  kind: HookKind
  name: string
  sessionMode: 'perDelivery' | 'perThread' | 'shared'
  enabled: boolean
  url: string | null
  hmacConfigured: boolean
  // ── code-host kinds ── repo/project + subscription (empty/null on webhook kind)
  repoId?: string | null // GitHub numeric repo id, or the GitLab numeric project id
  repoFullName: string | null // owner/repo as GitHub cases it, or the GitLab project path
  family: string | null // the one subject family this row covers; null on webhook kind and legacy-inert rows
  events: string[] // 'issues:*' / 'issue_comment:created' / 'merge_request:*' / …
  commentFamilies: HookCommentFamily[] // thread kinds whose replies may fire this hook
  labelFilter: string[]
  mentionOnly: boolean // P3: authored event text must @-mention the agent or App
  configRevision: string // BigInt JSON/wire form; CP-owned, monotonic
  reviewPolicy: HookReviewPolicy
  reportingMode: HookReportingMode
  gateMode: HookGateMode
  lastFiredAt: string | null
  createdBy: string | null
  createdAt: string
}

/** Create response: the DTO plus the ONE-TIME signing-secret echo — never
 *  retrievable again after this response. */
export interface CreatedHookDto extends HookDto {
  hmacSecret: string | null
}

// One delivery's run row. `running` = the relay accepted the dispatch and the
// daemon's completion report hasn't landed yet.
export interface HookRunDto {
  id: string
  deliveryKey: string
  event: string | null
  startedAt: string
  status: 'running' | 'success' | 'failed'
  durationMs: number | null
  sessionId: string | null // ACP session id — deep-links into the session view
  reason: string | null
}

export interface CreateHookInput {
  agentId: string
  name: string
  /** Add X-AC-Signature verification on top of the capability URL. */
  hmac?: boolean
}

// github kind: the repo must sit inside one of the org's GitHub App
// installations — the CP resolves it to the numeric match key server-side.
export interface CreateGithubHookInput {
  agentId: string
  name: string
  enabled?: boolean
  repoFullName: string
  family: GithubHookFamily // one row per family; every event pattern must belong to it
  events: string[] // 'issues:*' etc — at least one
  commentFamilies?: GithubCommentFamily[]
  labelFilter?: string[]
  mentionOnly?: boolean // require authored event text to @-mention the agent or App
  reviewPolicy?: HookReviewPolicy
  reportingMode?: HookReportingMode
  // R1/R2a callers can only send the informational literal.
  gateMode?: HookGateMode
}

// gitlab kind: the project must already be a managed binding in the org — the CP
// validates the numeric id against its own row and derives the path from it.
export interface CreateGitlabHookInput {
  agentId: string
  name: string
  enabled?: boolean
  projectId: string // numeric GitLab project id
  family: GitlabHookFamily // one row per family; every event pattern must belong to it
  events: string[] // 'issues:*' / 'merge_request:*' / 'push:*' — at least one
  commentFamilies?: GitlabCommentFamily[]
  mentionOnly?: boolean
  reviewPolicy?: HookReviewPolicy
  // 'check' publishes the merge-request run note; no gateMode — GitLab has no required gate.
  reportingMode?: HookReportingMode
}

// The family is immutable, so no update body carries it — changing a row's
// family is a delete plus a create.
export type UpdateGithubHookInput = Omit<CreateGithubHookInput, 'family'>
export type UpdateGitlabHookInput = Omit<CreateGitlabHookInput, 'family'>

// A hook is subordinate to its agent (like an Integration), so there is no
// org-wide hook list — you fetch ONE agent's hooks, gated server-side by that
// agent's visibility (404 for an agent you can't see).
export async function fetchAgentHooks(agentId: string, orgId?: string): Promise<HookDto[]> {
  return apiGet<HookDto[]>(`${orgBase(orgId)}/agents/${encodeURIComponent(agentId)}/hooks`)
}

// The capability URL is sufficient by default. HMAC is an optional second
// factor, with its signing secret revealed once by the create response.
export async function createHook(input: CreateHookInput): Promise<CreatedHookDto> {
  const hook = await apiPost<CreatedHookDto>(`${orgBase()}/hooks`, { kind: 'webhook', ...input })
  track('hook_created', { org_id: apiOrgId, agent_id: hook.agentId, hook_kind: hook.kind, hook_id: hook.id })
  return hook
}

// GitHub subscription — no URL, no secret (the App webhook signs deliveries
// pool-wide); events ride through the relay to this agent, one session per
// issue/PR thread.
export async function createGithubHook(input: CreateGithubHookInput): Promise<CreatedHookDto> {
  const hook = await apiPost<CreatedHookDto>(`${orgBase()}/hooks`, { kind: 'github', ...input })
  track('hook_created', { org_id: apiOrgId, agent_id: hook.agentId, hook_kind: hook.kind, hook_id: hook.id })
  return hook
}

// Update a github hook's subscription (event pills / labels / repo re-target).
// The body re-sends the full github block — PUT is whole-definition.
export async function updateGithubHook(id: string, input: UpdateGithubHookInput): Promise<HookDto> {
  return apiPut<HookDto>(`${orgBase()}/hooks/${encodeURIComponent(id)}`, { kind: 'github', ...input })
}

// GitLab subscription — no URL, no secret: the managed project webhook signs its
// own deliveries. Events ride through the relay, one session per issue/MR thread.
export async function createGitlabHook(input: CreateGitlabHookInput): Promise<CreatedHookDto> {
  const hook = await apiPost<CreatedHookDto>(`${orgBase()}/hooks`, { kind: 'gitlab', ...input })
  track('hook_created', { org_id: apiOrgId, agent_id: hook.agentId, hook_kind: hook.kind, hook_id: hook.id })
  return hook
}

// Update a gitlab hook's subscription. Whole-definition PUT, like the github one.
export async function updateGitlabHook(id: string, input: UpdateGitlabHookInput): Promise<HookDto> {
  return apiPut<HookDto>(`${orgBase()}/hooks/${encodeURIComponent(id)}`, { kind: 'gitlab', ...input })
}

export async function deleteHook(id: string): Promise<void> {
  await apiDelete<void>(`${orgBase()}/hooks/${encodeURIComponent(id)}`)
  track('hook_deleted', { org_id: apiOrgId, hook_id: id })
}

export async function fetchHookRuns(id: string, orgId?: string): Promise<HookRunDto[]> {
  return apiGet<HookRunDto[]>(`${orgBase(orgId)}/hooks/${encodeURIComponent(id)}/runs`)
}

/** One rerun subject — the two GitLab thread kinds a session can be keyed to. */
export interface GitlabRerunSubject {
  kind: 'merge_request' | 'issue'
  iid: number
}

export interface HookRerunDto {
  accepted: true
  deliveryKey: string
  event: string
  /** The merge request's current head, read live by the CP; null for an issue. */
  headSha: string | null
}

// The "Run again" action for a GitLab trigger thread (gitlab-com-integration.md
// §16.1). The caller names only the subject: the Control Plane reads its current
// state and head itself, so the console can never re-run a stale revision.
export async function rerunGitlabHook(
  hookId: string,
  subject: GitlabRerunSubject,
  orgId?: string
): Promise<HookRerunDto> {
  return apiPost<HookRerunDto>(`${orgBase(orgId)}/hooks/${encodeURIComponent(hookId)}/rerun`, { subject })
}

// Per-conversation trigger choice (`PATCH /integrations/:id/channels/:channelId`). The CP
// persists it and pushes the integration's recomputed bind rules to the owning daemon.
export async function updateIntegrationChannel(
  integrationId: string,
  channelId: string,
  patch: { trigger?: ChannelTrigger; agentId?: string }
): Promise<IntegrationChannelDto> {
  return apiPatch<IntegrationChannelDto>(
    `${orgBase()}/integrations/${encodeURIComponent(integrationId)}/channels/${encodeURIComponent(channelId)}`,
    patch
  )
}

/** Forget a conversation row (DELETE …/channels/:channelId). Cleanup only — the bot
 *  is not touched on the platform, and the row returns on the next authoritative
 *  listing if it is still a member there. */
export async function forgetIntegrationChannel(integrationId: string, channelId: string): Promise<void> {
  await apiDelete<void>(
    `${orgBase()}/integrations/${encodeURIComponent(integrationId)}/channels/${encodeURIComponent(channelId)}`
  )
}

/** Withdraw the bot from a conversation, or (Discord) a whole server, at the PLATFORM.
 *  Rejects with the platform's own message when it refuses — a missing scope, a
 *  last-member channel — which the caller shows verbatim. */
export async function leaveIntegrationConversation(
  integrationId: string,
  target: { kind: 'conversation'; channel: string } | { kind: 'space'; spaceId: string }
): Promise<void> {
  await apiPost<void>(`${orgBase()}/integrations/${encodeURIComponent(integrationId)}/leave`, { target })
}

/** Flip a bot's shared-bot opt-in (PATCH /bots/:id). */
export async function updateBot(id: string, shareable: boolean): Promise<BotDto> {
  return apiPatch<BotDto>(`${orgBase()}/bots/${encodeURIComponent(id)}`, { shareable })
}

/** Sync one user-managed Slack app's manifest and re-check the scopes granted to
 *  its current workspace installation. Token material stays inside the CP. */
export async function refreshSlackBot(id: string): Promise<SlackBotRefreshDto> {
  return apiPost<SlackBotRefreshDto>(`${orgBase()}/bots/${encodeURIComponent(id)}/slack/refresh`, {})
}

// ── members ───────────────────────────────────────────────────────────────────
// The active org's members for the Settings page (GET /members).
export async function fetchMembers(orgId?: string): Promise<MemberDto[]> {
  return apiGet<MemberDto[]>(`${orgBase(orgId)}/members`)
}

// Change one member's role (PATCH /members/:id, owner-only). Multiple owners are
// allowed; demoting the last owner is refused (409).
export async function updateMemberRole(userId: string, role: MemberRole): Promise<MemberDto> {
  return apiPatch<MemberDto>(`${orgBase()}/members/${encodeURIComponent(userId)}`, { role })
}

// Add a member directly by email (POST /members, owner-only). No email is sent —
// an unknown address becomes an invited row, claimed at their first SSO sign-in.
export async function addMember(email: string, role: MemberRole): Promise<MemberDto> {
  const member = await apiPost<MemberDto>(`${orgBase()}/members`, { email, role })
  track('member_added', { org_id: apiOrgId, role })
  return member
}

// What that removal would do, for the confirmation dialog (GET
// /members/:id/removal-preview). Same authorization as the removal itself.
export async function fetchMemberRemovalPreview(userId: string): Promise<MemberRemovalPreviewDto> {
  return apiGet<MemberRemovalPreviewDto>(`${orgBase()}/members/${encodeURIComponent(userId)}/removal-preview`)
}

// Remove a membership. Any member can remove themselves; only owners can remove
// another member. Removing the last owner is refused (409).
export async function removeMember(userId: string): Promise<void> {
  await apiDelete<void>(`${orgBase()}/members/${encodeURIComponent(userId)}`)
  track('member_removed', { org_id: apiOrgId, removed_user_id: userId })
}

// ── organization invite link ─────────────────────────────────────────────────
// One fixed collaborator link, valid for seven days and usable by unlimited
// distinct accounts. Only the create response contains the plaintext token.
export async function fetchOrgInviteLink(orgId?: string): Promise<OrgInviteLinkDto | null> {
  return apiGet<OrgInviteLinkDto | null>(`${orgBase(orgId)}/invite-links`)
}

export async function createOrgInviteLink(orgId?: string): Promise<CreatedOrgInviteLinkDto> {
  const created = await apiPost<CreatedOrgInviteLinkDto>(`${orgBase(orgId)}/invite-links`, {})
  track('invite_link_created', { org_id: orgId ?? apiOrgId })
  return created
}

export async function revokeOrgInviteLink(id: string, orgId?: string): Promise<void> {
  await apiDelete<void>(`${orgBase(orgId)}/invite-links/${encodeURIComponent(id)}`)
}

/** Root-scoped because the signed-in caller is not a member of the target org yet. */
export async function acceptOrgInviteLink(token: string): Promise<AcceptedOrgInviteLinkDto> {
  return apiPost<AcceptedOrgInviteLinkDto>('/invite-links/accept', { token })
}

// ── me (the caller's own profile) ─────────────────────────────────────────────
// The signed-in user's CP profile (GET /me — root-scoped like /orgs). The console
// overlays it on the id-token claims (see lib/profile): profile edits land here,
// and the token stays stale until the next sign-in.
export interface MeDto {
  userId: string
  email: string | null // immutable on this surface — the OIDC provider owns it
  name: string | null // displayName
  picture: string | null // custom uploaded profile photo, or the OIDC `picture` fallback
  pictureCustom: boolean
  pictureUploadEnabled: boolean
}

export async function fetchMe(): Promise<MeDto> {
  return apiGet<MeDto>('/me')
}

// Edit the display name (PATCH /me). Name only — the CP's strict schema 400s a
// request carrying `email` (or anything else). Profile photos use their own raw
// image endpoint so arbitrary URLs never enter the user record.
export async function updateMe(patch: { name: string }): Promise<MeDto> {
  return apiPatch<MeDto>('/me', patch)
}

// The account's linked sign-in methods (GET /me/social-identities). Served by the
// CP rather than read from the identity provider in the browser: the CP caches the
// upstream lookup and makes it from next to the provider, which is worth ~2s on a
// cold profile load. Already narrowed for rendering — no connector `rawData` here.
export interface MySocialIdentityDto {
  target: string
  userId: string
  name?: string
  email?: string
  avatar?: string
  /** Where this account lives at its provider, when that is addressable. */
  profileUrl?: string
  /** Slack only. `url` is absent when Slack sent no domain — the `T…` id alone
   *  does not address a workspace, so the label renders as plain text. */
  workspace?: { teamId: string; name?: string; domain?: string; url?: string }
}

export interface MySocialAccountDto {
  identities: MySocialIdentityDto[]
  /** Drives whether linking has to collect an ownership code first; Logto
   *  answers 403 to an identity change the caller has not re-proven. */
  hasSecurityVerificationMethod: boolean
  primaryEmail?: string
}

export async function fetchMySocialAccount(): Promise<MySocialAccountDto> {
  return apiGet<MySocialAccountDto>('/me/social-identities')
}

export type MySlackIdentityDto =
  | { linked: false }
  | {
      linked: true
      teamId: string
      userId: string
      teamName?: string
      teamDomain?: string
    }

/** Narrow linked/not-linked status used by supported provider profile-linking hints. */
export async function fetchMySessionIdentity(provider: SessionProfileProvider): Promise<{ linked: boolean }> {
  if (provider === 'slack') return apiGet<MySlackIdentityDto>('/me/social-identities/slack')
  const account = await fetchMySocialAccount()
  return { linked: account.identities.some((identity) => identity.target === provider) }
}

// Linking runs browser→provider, so the CP never sees that write and its cached
// copy would hide the new identity. Say so once, right after a link lands.
export async function refreshMySocialIdentities(): Promise<void> {
  await apiPost('/me/social-identities/refresh', {})
  // Repository rosters are identity-filtered. A successful GitHub link must
  // not leave the public-only result cached when the user reopens a picker.
  invalidateGithubRepoRosterCache()
}

async function putMyProfilePicture(blob: Blob): Promise<MeDto> {
  const path = '/me/picture'
  const res = await authenticatedFetch(
    path,
    { method: 'PUT', body: blob },
    { 'content-type': blob.type || 'application/octet-stream' }
  )
  if (!res.ok) throw await apiErrorFromResponse('PUT', path, res)
  return (await res.json()) as MeDto
}

export function uploadMyProfilePicture(blob: Blob): Promise<MeDto> {
  return putMyProfilePicture(blob)
}

export async function deleteMyProfilePicture(): Promise<MeDto> {
  return apiDelete<MeDto>('/me/picture')
}

// ── my social sign-in methods ────────────────────────────────────────────────
// The tenant's connector id for a provider target. Only the CP can resolve this
// (it holds the Logto Management credential, which never reaches the browser);
// the authorization itself is then driven browser-side against the Account API,
// because the Management API gives the connector no session — see
// lib/logto-account.ts#createSocialVerification.
export function resolveMySocialConnectorId(target: SocialLoginTarget): Promise<{ connectorId: string }> {
  return apiGet(`/me/social-identities/connectors/${encodeURIComponent(target)}`)
}

/** How this provider must be linked, decided by the CP asking Logto — never by
 *  the console keeping a list of which connectors need a session. */
export type MySocialAuthorizationDto =
  { mode: 'direct'; connectorId: string; authorizationUri: string } | { mode: 'verified'; connectorId: string }

export function createMySocialIdentityAuthorization(
  target: SocialLoginTarget,
  state: string
): Promise<MySocialAuthorizationDto> {
  return apiPost('/me/social-identities/authorization-uri', { target, state })
}

/** Complete a `direct` link server-side. No ownership proof: the CP's own
 *  credential is the authority on this path. */
export async function linkMySocialIdentity(connectorId: string, connectorData: Record<string, string>): Promise<void> {
  await apiPost('/me/social-identities', { connectorId, connectorData })
}

export async function unlinkMySocialIdentity(target: string): Promise<void> {
  await apiDelete(`/me/social-identities/${encodeURIComponent(target)}`)
}

// ── closed-beta admission (waitlist-and-login.md) ─────────────────────────────
// The signed-in user's app-admission state (GET /me/access — root-scoped like /me).
// `status` drives post-login routing: `active` ⇒ enter the console; anything else
// ⇒ the /waitlist page. When `waitlistMode` is false the status is always `active`,
// so the console behaves exactly as before.
export interface MeAccessDto {
  waitlistMode: boolean
  status: 'active' | 'approved' | 'pending' | 'none'
  activated: boolean
  orgCount: number
  email: string | null
}

export function getMyAccess(): Promise<MeAccessDto> {
  return apiGet<MeAccessDto>('/me/access')
}

/** Applicant intake stored alongside the waitlist entry. Name / company / team-size /
 *  at least one platform are required (only the use-case is optional), matching the
 *  server contract. The email is NEVER taken from here — it always comes from the
 *  verified identity server-side. */
export interface WaitlistIntake {
  name: string
  company: string
  platform: ('slack' | 'telegram' | 'discord')[]
  teamSize: string
  useCase?: string
}

/** Add the signed-in user's own verified email to the waitlist (POST /waitlist).
 *  `intake` is stored as applicant context; the email is server-derived. */
export function joinWaitlist(intake: WaitlistIntake): Promise<{ status: 'pending' | 'approved' | 'rejected' }> {
  return apiPost<{ status: 'pending' | 'approved' | 'rejected' }>('/waitlist', intake)
}

/** Redeem a waitlist activation link (POST /waitlist/redeem) → become a formal user.
 *  Root-scoped: the caller may not belong to any org yet. `expectSubject` asserts
 *  WHICH signed-in identity the caller means: the CP refuses (409 IDENTITY_CHANGED)
 *  if the verified bearer belongs to someone else, so a tab that switched accounts
 *  mid-flow cannot get its own account activated by this link. */
export function redeemWaitlistLink(token: string, expectSubject?: string): Promise<{ activated: true }> {
  return apiPost<{ activated: true }>('/waitlist/redeem', { token, ...(expectSubject ? { expectSubject } : {}) })
}

// ── personal API keys (the caller's own credentials; identity-scoped `/me/keys`) ──
// Active keys the signed-in user owns, across all their orgs.
export async function fetchMyApiKeys(): Promise<UserApiKeyDto[]> {
  return apiGet<UserApiKeyDto[]>('/me/keys')
}

// Mint a personal key in one of the caller's orgs (default 90-day expiry; pass
// `expiresInDays: null` for a non-expiring key). The plaintext comes back exactly
// once — never retrievable afterward.
export async function createMyApiKey(input: {
  orgId: string
  name?: string
  expiresInDays?: number | null
}): Promise<MintedUserKeyDto> {
  return apiPost<MintedUserKeyDto>('/me/keys', input)
}

// Revoke one of the caller's own keys (kill switch).
export async function revokeMyApiKey(id: string): Promise<UserApiKeyDto> {
  return apiDelete<UserApiKeyDto>(`/me/keys/${encodeURIComponent(id)}`)
}

// ── orgs ──────────────────────────────────────────────────────────────────────
// Every org the signed-in user belongs to (GET /orgs) — the picker + Settings.
export async function fetchOrgs(): Promise<OrgDto[]> {
  return apiGet<OrgDto[]>('/orgs')
}

// Persist the caller's active org on their membership. The browser cookie is
// only a stale-link fallback; this preference restores bare entries after
// sign-out and on other devices.
export async function selectOrg(orgId: string): Promise<void> {
  await apiPut<void>(`/orgs/${encodeURIComponent(orgId)}/selection`)
}

// Create an org (POST /orgs); the caller becomes its first owner. The display
// name is optional — omit it to fall back to the slug.
export async function createOrg(input: { name?: string; slug: string }): Promise<OrgDto> {
  const org = await apiPost<OrgDto>('/orgs', input)
  track('organization_created', { org_id: org.id, org_slug: org.slug })
  return org
}

// Update org settings (PATCH /orgs/:id, owner of that org only).
export async function updateOrg(
  orgId: string,
  patch: {
    name?: string
    slug?: string
    icon?: AgentIcon | null
    defaultAgentVisibility?: AgentCallPolicy
    /** One-way — the onboarding wizard sets it on finish or skip. */
    onboardingCompleted?: true
    /** Getting-started tutorial position — advanced by the console drawer. */
    gettingStartedStep?: number
  }
): Promise<OrgDto> {
  return apiPatch<OrgDto>(`/orgs/${encodeURIComponent(orgId)}`, patch)
}

// Delete an org (DELETE /orgs/:id, owner-only). Refused (409) while it still
// has daemons; agents/crons/integrations/bots/keys/memberships cascade.
export async function deleteOrg(orgId: string): Promise<void> {
  await apiDelete<void>(`/orgs/${encodeURIComponent(orgId)}`)
}

// ── bots ──────────────────────────────────────────────────────────────────────
// The durable bot identities (freed + in-use) — the Add-integration picker and
// the Settings "Bots" card both read this roster.
export async function fetchBots(orgId?: string): Promise<BotDto[]> {
  return apiGet<BotDto[]>(`${orgBase(orgId)}/bots`)
}

// Forget a bot: drops the CP record + its stored tokens. The CP refuses (409)
// while the bot is installed on an agent — uninstall the integration first. The
// Slack app itself keeps existing on Slack's side.
export async function deleteBot(id: string): Promise<void> {
  await apiDelete<void>(`${orgBase()}/bots/${encodeURIComponent(id)}`)
}

// ── external-memory plugin connections (memory-evolution M-5A) ──────────────
// Installation is the owner-reviewed code/endpoint trust decision. Connection
// is one org account/config on that installation. Secret VALUES are write-only;
// reads expose only logical key names and body-free probe facts.
export interface MemoryPluginSecretHeaderDto {
  name: string
  header: string
  required: boolean
}

export interface MemoryPluginInstallationDto {
  id: string
  pluginId: string
  transport: 'streamable-http' | 'stdio'
  endpoint: string | null
  commandRef: string | null
  pinnedProfileMajor: 1
  expectedManifestDigest: string | null
  secretHeaders: MemoryPluginSecretHeaderDto[]
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export interface ExternalMemoryConnectionDto {
  id: string
  installationId: string
  config: Record<string, unknown>
  secretKeys: string[]
  status: 'probing' | 'ready' | 'degraded' | 'invalid'
  revision: number
  probedRevision: number | null
  pluginVersion: string | null
  profile: string | null
  manifestDigest: string | null
  capabilities: Record<string, unknown> | null
  declaredEgressHosts: string[]
  reasonCode: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

interface CreateMemoryPluginInstallationInputBase {
  pluginId: string
  expectedManifestDigest?: string
  secretHeaders: MemoryPluginSecretHeaderDto[]
}

export type CreateMemoryPluginInstallationInput = CreateMemoryPluginInstallationInputBase &
  (
    | { transport: 'streamable-http'; endpoint: string; commandRef?: never }
    | { transport: 'stdio'; commandRef: string; endpoint?: never }
  )

export interface CreateExternalMemoryConnectionInput {
  installationId: string
  config: Record<string, unknown>
  secrets: Record<string, string>
}

export async function fetchMemoryPluginInstallations(orgId?: string): Promise<MemoryPluginInstallationDto[]> {
  return apiGet<MemoryPluginInstallationDto[]>(`${orgBase(orgId)}/memory-plugin-installations`)
}

export function createMemoryPluginInstallation(
  input: CreateMemoryPluginInstallationInput
): Promise<MemoryPluginInstallationDto> {
  return apiPost<MemoryPluginInstallationDto>(`${orgBase()}/memory-plugin-installations`, input)
}

export async function deleteMemoryPluginInstallation(id: string): Promise<void> {
  await apiDelete<void>(`${orgBase()}/memory-plugin-installations/${encodeURIComponent(id)}`)
}

export async function fetchExternalMemoryConnections(orgId?: string): Promise<ExternalMemoryConnectionDto[]> {
  return apiGet<ExternalMemoryConnectionDto[]>(`${orgBase(orgId)}/external-memory-connections`)
}

export function createExternalMemoryConnection(
  input: CreateExternalMemoryConnectionInput
): Promise<ExternalMemoryConnectionDto> {
  return apiPost<ExternalMemoryConnectionDto>(`${orgBase()}/external-memory-connections`, input)
}

export function updateExternalMemoryConnection(
  id: string,
  patch: { config?: Record<string, unknown>; secrets?: Record<string, string> }
): Promise<ExternalMemoryConnectionDto> {
  return apiPatch<ExternalMemoryConnectionDto>(
    `${orgBase()}/external-memory-connections/${encodeURIComponent(id)}`,
    patch
  )
}

export function rotateExternalMemoryConnectionGrant(id: string): Promise<ExternalMemoryConnectionDto> {
  return apiPost<ExternalMemoryConnectionDto>(
    `${orgBase()}/external-memory-connections/${encodeURIComponent(id)}/grant/rotate`,
    {}
  )
}

export async function deleteExternalMemoryConnection(id: string): Promise<void> {
  await apiDelete<void>(`${orgBase()}/external-memory-connections/${encodeURIComponent(id)}`)
}

// ── MCP providers (centralized-tool-management.md §4-§7) ─────────────────────
// Org-level upstream MCP servers the CP proxies to agents through a relay. Read
// DTOs expose header NAMES only — the upstream header VALUES and the bearer grant
// key are secrets that go in on create/update and never come back (the grant key
// is echoed exactly once by createMcpProvider).
export interface McpProviderDto {
  id: string
  name: string
  /** 'custom' = operator-entered upstream; 'open_connector' = an open-connector connection. */
  kind: string
  transport: string
  /** Open-connector service slug (e.g. "stripe") for kind='open_connector' — used to
   *  resolve the provider's catalog icon. Absent for custom providers. */
  service?: string
  visibility: ResourceVisibility // 'org' = everyone; 'restricted' = the complete sharedWith audience
  sharedWith: string[] // complete app_user.id audience when restricted
  createdBy: string | null // immutable creator audit
  canEdit: boolean // whether THIS caller may change non-sharing provider settings
  canManageSharing: boolean // whether THIS caller may change the provider's sharing
  url: string
  /** Upstream auth header keys; values are secret and never returned. */
  headerNames: string[]
  createdAt: string // ISO-8601
}

// POST /mcp-providers response: the provider plus its freshly-minted bearer grant
// key, returned EXACTLY ONCE (like a personal API key) and never retrievable after.
export interface McpProviderCreatedDto extends McpProviderDto {
  grantKey: string
}

// One upstream auth header the CP injects on the relay's outbound call. The value
// is a secret (apikey/bearer/…) — write-only.
export interface McpHeaderInput {
  name: string
  value: string
}

export interface CreateMcpProviderInput {
  name: string
  url: string
  headers: McpHeaderInput[]
  // Initial visibility; absent ⇒ 'org'. `sharedWith` only bites when 'restricted'.
  visibility?: ResourceVisibility
  sharedWith?: string[]
}

// PATCH body — every field optional (the CP requires at least one). `headers`
// REPLACES the stored set wholesale; omit it to keep the current headers. Name is
// immutable (agents bind by name; no atomic rename) — recreate to rename.
export interface UpdateMcpProviderInput {
  url?: string
  headers?: McpHeaderInput[]
}

export async function fetchMcpProviders(orgId?: string): Promise<McpProviderDto[]> {
  return apiGet<McpProviderDto[]>(`${orgBase(orgId)}/mcp-providers`)
}

// Register an upstream MCP server; the response carries the one-time grant key.
export async function createMcpProvider(input: CreateMcpProviderInput): Promise<McpProviderCreatedDto> {
  const provider = await apiPost<McpProviderCreatedDto>(`${orgBase()}/mcp-providers`, input)
  track('mcp_provider_created', {
    org_id: apiOrgId,
    provider_id: provider.id,
    provider_name: provider.name,
    transport: provider.transport
  })
  return provider
}

export async function updateMcpProvider(id: string, patch: UpdateMcpProviderInput): Promise<McpProviderDto> {
  return apiPatch<McpProviderDto>(`${orgBase()}/mcp-providers/${encodeURIComponent(id)}`, patch)
}

export async function deleteMcpProvider(id: string): Promise<void> {
  await apiDelete<void>(`${orgBase()}/mcp-providers/${encodeURIComponent(id)}`)
}

// Set a provider's visibility + share set (PUT /mcp-providers/:id/sharing). Separate
// from the content PATCH; gated server-side by canManageSharing.
export async function updateMcpProviderSharing(id: string, body: SharingInput): Promise<McpProviderDto> {
  return apiPut<McpProviderDto>(`${orgBase()}/mcp-providers/${encodeURIComponent(id)}/sharing`, body)
}

// ── shared-skills sources (docs/designs/shared-skills.md) ────────────────────
// Org-level skills sources the daemon installs via `npx skills`. Pure metadata —
// nothing secret. The daemon fetches content directly from the source.
export interface SkillSourceDto {
  id: string
  name: string
  source: string // the string fed to `npx skills add`
  githubRepoId: string | null // BigInt rendered as string
  ref: string | null // branch/tag/commit
  subDir: string | null
  skills: string[] // the source's own skill filter ([] ⇒ install all)
  visibility: ResourceVisibility
  sharedWith: string[]
  createdBy: string | null
  canEdit: boolean
  canManageSharing: boolean
  createdAt: string // ISO-8601
}

export interface CreateSkillSourceInput {
  name: string
  source: string
  githubRepoId?: string
  ref?: string
  subDir?: string
  skills?: string[]
  visibility?: ResourceVisibility
  sharedWith?: string[]
}

// PATCH body — at least one field. `skills` REPLACES the stored filter wholesale.
// Name is immutable (agents bind by name; recreate to rename).
export interface UpdateSkillSourceInput {
  source?: string
  githubRepoId?: string | null
  ref?: string | null
  subDir?: string | null
  skills?: string[]
}

// POST /skill-sources/preview body + response — a best-effort GitHub scan for the
// import dialog (branch/tag choices + the SKILL.md manifest).
export interface PreviewSkillSourceInput {
  installationId: string
  owner: string
  repo: string
  ref?: string
}
export interface SkillSourcePreviewDto {
  branches: string[]
  tags: string[]
  skills: Array<{ name: string; dirPath: string }>
}

// ── member sets (docs/designs/daemon-groups.md) ──────────────────────────────
// A named set of the organization's own daemons within which an agent's duty may be claimed:
// point an agent at the set instead of one machine and it survives losing any single member.
// The install-wide pool is the ORG-LESS set and is never listed here — the console renders it as
// AgentConnect Cloud from the daemon fleet, not from this endpoint.

export interface MemberSetDto {
  setId: string
  name: string
  /** Daemon ids currently enrolled. A daemon is in at most one set. */
  memberDaemonIds: string[]
  /** Agents placed on the set — the count shown beside Cloud's and a cluster's. */
  agentCount: number
}

export async function fetchMemberSets(orgId?: string): Promise<MemberSetDto[]> {
  return apiGet<MemberSetDto[]>(`${orgBase(orgId)}/member-sets`)
}

export async function createMemberSet(name: string): Promise<MemberSetDto> {
  return apiPost<MemberSetDto>(`${orgBase()}/member-sets`, { name })
}

export async function renameMemberSet(setId: string, name: string): Promise<MemberSetDto> {
  return apiPatch<MemberSetDto>(`${orgBase()}/member-sets/${encodeURIComponent(setId)}`, { name })
}

export async function deleteMemberSet(setId: string): Promise<void> {
  await apiDelete<void>(`${orgBase()}/member-sets/${encodeURIComponent(setId)}`)
}

/** Enroll a daemon. Agents pinned to it stay pinned and keep running — a pin narrows to exactly
 *  one machine, so joining changes how it holds them, not who serves them. 409 only when it is
 *  already in another set. */
export async function enrollDaemonInMemberSet(setId: string, daemonId: string): Promise<MemberSetDto> {
  return apiPut<MemberSetDto>(
    `${orgBase()}/member-sets/${encodeURIComponent(setId)}/members/${encodeURIComponent(daemonId)}`
  )
}

/** Withdraw a daemon. 409 while it still holds a live duty lease — drain it first. */
export async function withdrawDaemonFromMemberSet(setId: string, daemonId: string): Promise<MemberSetDto> {
  return apiDelete<MemberSetDto>(
    `${orgBase()}/member-sets/${encodeURIComponent(setId)}/members/${encodeURIComponent(daemonId)}`
  )
}

export async function fetchSkillSources(orgId?: string): Promise<SkillSourceDto[]> {
  return apiGet<SkillSourceDto[]>(`${orgBase(orgId)}/skill-sources`)
}

// A source's discovered SKILL.md manifest for the agent editor's per-skill picker.
// `resolvable:false` (empty skills) ⇒ the source isn't a scannable GitHub repo, so
// the UI offers whole-source enablement only.
export interface SkillSourceSkillsDto {
  resolvable: boolean
  skills: Array<{ name: string; dirPath: string }>
}
export async function fetchSkillSourceSkills(id: string): Promise<SkillSourceSkillsDto> {
  return apiGet<SkillSourceSkillsDto>(`${orgBase()}/skill-sources/${encodeURIComponent(id)}/skills`)
}

// The sources an agent's enable-list references, resolved server-side from the refs.
// Gated on viewing the AGENT, so a source that sharing hides from the org registry
// list still resolves here — the agent card can show what it actually installs
// instead of a bare name. Sources that no longer exist are simply omitted.
export interface AgentSkillSourceDto {
  id: string
  name: string
  source: string
  ref: string | null
  subDir: string | null
  skills: string[]
}
export async function fetchAgentSkillSources(agentId: string): Promise<AgentSkillSourceDto[]> {
  return apiGet<AgentSkillSourceDto[]>(`${orgBase()}/agents/${encodeURIComponent(agentId)}/skill-sources`)
}

// One hit from the public skills.sh index (GET /skill-sources/registry/search).
// The CP proxies the lookup — skills.sh sends no CORS headers — and normalizes each
// row into the two strings a source create needs: `source` (owner/repo) and `name`
// (the skill dir, which becomes a one-entry `skills` filter). `reachable:false`
// means the index could not be read, NOT that nothing matched.
export interface SkillRegistryHitDto {
  id: string // registry slug `<owner>/<repo>/<skill>` — the skills.sh page
  name: string
  source: string
  installs: number | null
}
export interface SkillRegistrySearchDto {
  reachable: boolean
  skills: SkillRegistryHitDto[]
}

export async function searchSkillRegistry(q: string, owner?: string): Promise<SkillRegistrySearchDto> {
  const params = new URLSearchParams({ q })
  if (owner) params.set('owner', owner)
  return apiGet<SkillRegistrySearchDto>(`${orgBase()}/skill-sources/registry/search?${params.toString()}`)
}

export async function previewSkillSource(input: PreviewSkillSourceInput): Promise<SkillSourcePreviewDto> {
  return apiPost<SkillSourcePreviewDto>(`${orgBase()}/skill-sources/preview`, input)
}

export async function createSkillSource(input: CreateSkillSourceInput): Promise<SkillSourceDto> {
  return apiPost<SkillSourceDto>(`${orgBase()}/skill-sources`, input)
}

export async function updateSkillSource(id: string, patch: UpdateSkillSourceInput): Promise<SkillSourceDto> {
  return apiPatch<SkillSourceDto>(`${orgBase()}/skill-sources/${encodeURIComponent(id)}`, patch)
}

export async function deleteSkillSource(id: string): Promise<void> {
  await apiDelete<void>(`${orgBase()}/skill-sources/${encodeURIComponent(id)}`)
}

export async function updateSkillSourceSharing(id: string, body: SharingInput): Promise<SkillSourceDto> {
  return apiPut<SkillSourceDto>(`${orgBase()}/skill-sources/${encodeURIComponent(id)}/sharing`, body)
}

// ── organization variables & secrets (organization-secrets-and-variables.md) ──
// Owner-only registry. A secret VALUE is write-only: it is accepted on create and
// on replace, and no response ever carries it back.

export type OrganizationEnvironmentKind = 'variable' | 'secret'
/** UI labels: 'all' = "All agents", 'selected' = "Selected agents". */
export type OrganizationEnvironmentAudience = 'all' | 'selected'

export interface OrganizationEnvironmentEntryDto {
  id: string
  key: string
  kind: OrganizationEnvironmentKind
  /** Present only for variables. */
  variableValue?: string
  /** Present only for secrets: whether material is stored. Never the value. */
  secretConfigured?: boolean
  audience: OrganizationEnvironmentAudience
  /**
   * Bindings whose agents the CALLER can view. Assignments to other private
   * agents are neither listed nor removed when this selection is edited, and
   * whether any exist is deliberately not disclosed.
   */
  visibleAgentIds: string[]
  /** Editor-conflict fence — echo it as `expectedVersion` on the next save. */
  version: number
  createdAt: string
  updatedAt: string
}

export interface CreateOrganizationEnvironmentEntryInput {
  key: string
  kind: OrganizationEnvironmentKind
  value: string
  audience: OrganizationEnvironmentAudience
  /** Initial selection; `selected` audience only. */
  agentIds?: string[]
}

export interface UpdateOrganizationEnvironmentEntryInput {
  expectedVersion: number
  /** Omit to leave the value unchanged — how "Replace value" keeps an existing secret. */
  value?: string
  audience?: OrganizationEnvironmentAudience
}

export async function fetchOrganizationEnvironment(orgId?: string): Promise<OrganizationEnvironmentEntryDto[]> {
  return apiGet<OrganizationEnvironmentEntryDto[]>(`${orgBase(orgId)}/environment`)
}

export async function createOrganizationEnvironmentEntry(
  input: CreateOrganizationEnvironmentEntryInput
): Promise<OrganizationEnvironmentEntryDto> {
  return apiPost<OrganizationEnvironmentEntryDto>(`${orgBase()}/environment`, input)
}

export async function updateOrganizationEnvironmentEntry(
  entryId: string,
  patch: UpdateOrganizationEnvironmentEntryInput
): Promise<OrganizationEnvironmentEntryDto> {
  return apiPatch<OrganizationEnvironmentEntryDto>(`${orgBase()}/environment/${encodeURIComponent(entryId)}`, patch)
}

export async function deleteOrganizationEnvironmentEntry(entryId: string): Promise<void> {
  await apiDelete<void>(`${orgBase()}/environment/${encodeURIComponent(entryId)}`)
}

/** Idempotent per-agent binding. Bindings are edited one agent at a time so two
 *  owners adding different agents cannot overwrite each other's work. */
export async function assignOrganizationEnvironmentEntry(
  entryId: string,
  agentId: string
): Promise<OrganizationEnvironmentEntryDto> {
  return apiPut<OrganizationEnvironmentEntryDto>(
    `${orgBase()}/environment/${encodeURIComponent(entryId)}/agents/${encodeURIComponent(agentId)}`
  )
}

export async function unassignOrganizationEnvironmentEntry(
  entryId: string,
  agentId: string
): Promise<OrganizationEnvironmentEntryDto> {
  return apiDelete<OrganizationEnvironmentEntryDto>(
    `${orgBase()}/environment/${encodeURIComponent(entryId)}/agents/${encodeURIComponent(agentId)}`
  )
}

// ── open-connector connectors (docs: connectors integration) ─────────────────
// The CP brokers every open-connector call; the web only ever hits these CP routes.
// A created connection is recorded as an `open_connector` McpProvider (above).
export interface ConnectorAuthDefinition {
  type: 'no_auth' | 'api_key' | 'custom_credential' | 'oauth2'
  [key: string]: unknown
}
export interface ConnectorProviderDto {
  service: string
  displayName: string
  description?: string
  categories: string[]
  authTypes: string[]
  auth: ConnectorAuthDefinition[]
  homepageUrl?: string
  iconUrl?: string
}
export interface CreateConnectorConnectionInput {
  service: string
  connectionName: string
  authType: ConnectorAuthDefinition['type']
  values?: Record<string, string>
  // Initial console visibility of the recorded open_connector provider (absent ⇒ 'org').
  visibility?: ResourceVisibility
  sharedWith?: string[]
}
// Response extends the created MCP provider (grant key once) with an optional OAuth
// popup URL (present iff authType is oauth2).
export interface ConnectorConnectionCreatedDto extends McpProviderCreatedDto {
  authorizationUrl?: string
}

// Whether the open-connector integration is configured on the CP (gates the menu).
export async function fetchConnectorsConfig(orgId?: string): Promise<{ enabled: boolean }> {
  return apiGet<{ enabled: boolean }>(`${orgBase(orgId)}/connectors/config`)
}

export async function fetchConnectorCatalog(orgId?: string): Promise<{ providers: ConnectorProviderDto[] }> {
  return apiGet<{ providers: ConnectorProviderDto[] }>(`${orgBase(orgId)}/connectors/catalog`)
}

export async function createConnectorConnection(
  input: CreateConnectorConnectionInput
): Promise<ConnectorConnectionCreatedDto> {
  return apiPost<ConnectorConnectionCreatedDto>(`${orgBase()}/connectors/connections`, input)
}

// Re-run authorization (oauth2) or re-save credentials (api-key/custom) for an existing
// open_connector connection — its provider row / grant / relay binding are untouched, so
// only the auth material rides here. oauth2 returns an authorizationUrl to open in a popup.
export interface ReconnectConnectorConnectionInput {
  authType: ConnectorAuthDefinition['type']
  values?: Record<string, string>
}
export interface ReconnectConnectorConnectionResult {
  authorizationUrl?: string
}
export async function reconnectConnectorConnection(
  id: string,
  input: ReconnectConnectorConnectionInput
): Promise<ReconnectConnectorConnectionResult> {
  return apiPost<ReconnectConnectorConnectionResult>(
    `${orgBase()}/connectors/connections/${encodeURIComponent(id)}/reconnect`,
    input
  )
}

// ── github app (github-app workspaces) ───────────────────────────────────────
// The deployment GitHub App powering the Add-agent repo picker + credential-free
// daemon git. Feature is deployment-config opt-in: when the CP has no GITHUB_APP_*
// env its routes aren't registered at all and every call 404s — mapped to
// `enabled: false` here so callers get a clean tri-state instead of throws.

export interface GithubInstallationDto {
  id: string // CP row id — what an agent workspace references as `installationId`
  installationId: number // GitHub-side id
  accountLogin: string // e.g. "example-org"
  accountType: string // "Organization" | "User"
  repositorySelection: string // "all" | "selected"
  suspended: boolean
  permissionsStatus: 'current' | 'outdated' | 'unknown'
  pullRequestsPermission: 'read' | 'write' | 'missing' | 'unknown'
  checksPermission: 'write' | 'missing' | 'unknown'
  settingsUrl: string // canonical GitHub page for reviewing/updating this installation
  createdAt: string
}

export interface GithubRepoDto {
  repoId?: string // GitHub numeric id as a lossless wire string (absent on an older CP)
  fullName: string // owner/repo
  private: boolean
  defaultBranch: string // preselect this in the branch picker — never assume 'main'
  description: string | null
  updatedAt: string | null // last push — the picker row's "updated 3d ago"
}

export type GithubInstalledRepoDto = GithubRepoDto & { installationId: string }

/** Installations list doubles as the enabled-probe: it is viewer-readable (the
 *  install-link route is not — minting a state is a write), and 404 ⇒ the
 *  feature is off on this deployment. */
export async function fetchGithubInstallations(): Promise<{
  enabled: boolean
  installations: GithubInstallationDto[]
}> {
  try {
    const installations = await apiGet<GithubInstallationDto[]>(`${orgBase()}/github/installations`)
    return { enabled: true, installations }
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return { enabled: false, installations: [] }
    throw e
  }
}

/** One-shot org-bound install deep link (mints a signed state — viewer gets 403).
 *  Fetch fresh per click; a stored URL's state may already be consumed/expired. */
export async function fetchGithubInstallUrl(): Promise<string | null> {
  try {
    const app = await apiGet<{ enabled: boolean; slug: string | null; installUrl: string | null }>(
      `${orgBase()}/github/app`
    )
    return app.installUrl
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 403)) return null
    throw e
  }
}

/** Refresh the organization's existing claims from GitHub. Unknown App-wide
 * installations are never assigned by this endpoint. */
export async function syncGithubInstallations(): Promise<GithubInstallationDto[]> {
  const installations = await apiPost<GithubInstallationDto[]>(`${orgBase()}/github/installations/sync`, {})
  invalidateGithubRepoRosterCache()
  return installations
}

/** Remove the GitHub App from one account and revoke this installation's
 *  repository access. Owner-only; the CP also retires the local installation. */
export async function uninstallGithubInstallation(id: string): Promise<void> {
  await apiDelete<void>(`${orgBase()}/github/installations/${encodeURIComponent(id)}`)
  invalidateGithubRepoRosterCache(id)
}

// Smaller pages make the first permission-filtered results visible sooner;
// later pages stream in under the shared request limiter.
const GITHUB_REPO_PAGE_SIZE = 50
const GITHUB_REPO_REQUEST_CONCURRENCY = 4
const GITHUB_REPO_ROSTER_CACHE_MS = 5 * 60_000
// GitHub-side 5xx/429 blips are common during incidents; a page read gets two
// quick retries so a transient failure heals before the picker surfaces it.
const GITHUB_REPO_RETRY_DELAYS_MS = [250, 750] as const

type GithubRepoRequestWaiter = {
  resolve: () => void
  reject: (reason?: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
}

let activeGithubRepoRequests = 0
const githubRepoRequestWaiters: GithubRepoRequestWaiter[] = []
type GithubRepoPage = {
  repos: GithubRepoDto[]
  totalCount: number
  privateReposHidden: boolean
}

type GithubRepoRoster = {
  repos: GithubRepoDto[]
  privateReposHidden: boolean
}

const githubRepoRosterCache = new Map<string, GithubRepoRoster & { expiresAt: number }>()

export function invalidateGithubRepoRosterCache(installationId?: string): void {
  if (installationId) githubRepoRosterCache.delete(installationId)
  else githubRepoRosterCache.clear()
}

function githubRepoAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

/** Abort-aware sleep between repository-page retry attempts. */
function githubRepoRetryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(githubRepoAbortReason(signal))
    const onAbort = () => {
      clearTimeout(timer)
      reject(githubRepoAbortReason(signal!))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function acquireGithubRepoRequest(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw githubRepoAbortReason(signal)
  if (activeGithubRepoRequests < GITHUB_REPO_REQUEST_CONCURRENCY) {
    activeGithubRepoRequests += 1
    return
  }

  await new Promise<void>((resolve, reject) => {
    const waiter: GithubRepoRequestWaiter = { resolve, reject, signal }
    if (signal) {
      waiter.onAbort = () => {
        const index = githubRepoRequestWaiters.indexOf(waiter)
        if (index < 0) return
        githubRepoRequestWaiters.splice(index, 1)
        reject(githubRepoAbortReason(signal))
      }
      signal.addEventListener('abort', waiter.onAbort, { once: true })
    }
    githubRepoRequestWaiters.push(waiter)
  })
}

function releaseGithubRepoRequest(): void {
  activeGithubRepoRequests -= 1
  const next = githubRepoRequestWaiters.shift()
  if (!next) return
  if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort)
  activeGithubRepoRequests += 1
  next.resolve()
}

async function withGithubRepoRequestLimit<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  await acquireGithubRepoRequest(signal)
  try {
    if (signal?.aborted) throw githubRepoAbortReason(signal)
    return await run()
  } finally {
    releaseGithubRepoRequest()
  }
}

/** One page of installation repositories. GitHub offers no server-side search
 *  on this listing; picker components should normally use
 *  fetchGithubRepoRoster. */
export async function fetchGithubRepos(
  installationId: string,
  page = 1,
  signal?: AbortSignal
): Promise<GithubRepoPage> {
  // Not apiGet: rolling deployments can still return the former machine-coded
  // identity denial, which the aggregate below degrades to the same explicit
  // private-repositories-hidden state.
  const path = `${orgBase()}/github/installations/${encodeURIComponent(installationId)}/repositories?page=${page}&perPage=${GITHUB_REPO_PAGE_SIZE}`
  return withGithubRepoRequestLimit(async () => {
    for (let attempt = 0; ; attempt++) {
      const res = await authenticatedFetch(path, { cache: 'no-store', signal })
      if (res.ok) {
        const body = (await res.json()) as Omit<GithubRepoPage, 'privateReposHidden'> & {
          privateReposHidden?: boolean
        }
        return { ...body, privateReposHidden: body.privateReposHidden ?? false }
      }
      const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string }
      // Only upstream trouble (5xx, rate-limit) is worth retrying — a 4xx
      // verdict (403 identity gate, 404) would just repeat.
      const retryDelay = res.status === 429 || res.status >= 500 ? GITHUB_REPO_RETRY_DELAYS_MS[attempt] : undefined
      if (retryDelay === undefined) {
        throw new ApiError(body.message ?? `GET ${path} → ${res.status}`, res.status, body.code)
      }
      await githubRepoRetryDelay(retryDelay, signal)
    }
  }, signal)
}

function mergeGithubRepoPages(pages: Array<GithubRepoPage | undefined>): GithubRepoDto[] {
  const unique = new Map<string, GithubRepoDto>()
  for (const repo of pages.flatMap((page) => page?.repos ?? [])) {
    const key = repo.fullName.toLowerCase()
    if (!unique.has(key)) unique.set(key, repo)
  }
  return [...unique.values()]
}

/** Load the complete App-visible repository roster for client-side searching.
 *  Page 1 and every later page are published as soon as they arrive, while the
 *  completed roster is cached across picker components for five minutes. */
export async function fetchAllGithubRepos(
  installationId: string,
  signal?: AbortSignal,
  onProgress?: (repos: GithubRepoDto[]) => void
): Promise<GithubRepoRoster> {
  const cached = githubRepoRosterCache.get(installationId)
  if (cached && cached.expiresAt > Date.now()) {
    onProgress?.(cached.repos)
    return { repos: cached.repos, privateReposHidden: cached.privateReposHidden }
  }
  if (cached) githubRepoRosterCache.delete(installationId)

  const first = await fetchGithubRepos(installationId, 1, signal)
  const pageCount = Math.ceil(first.totalCount / GITHUB_REPO_PAGE_SIZE)
  const pages: Array<GithubRepoPage | undefined> = Array.from({
    length: Math.max(1, pageCount)
  })
  pages[0] = first
  onProgress?.(mergeGithubRepoPages(pages))
  await Promise.all(
    Array.from({ length: Math.max(0, pageCount - 1) }, (_, index) =>
      fetchGithubRepos(installationId, index + 2, signal).then((page) => {
        pages[index + 1] = page
        onProgress?.(mergeGithubRepoPages(pages))
      })
    )
  )

  const repos = mergeGithubRepoPages(pages)
  const privateReposHidden = pages.some((page) => page?.privateReposHidden)
  githubRepoRosterCache.set(installationId, {
    repos,
    privateReposHidden,
    expiresAt: Date.now() + GITHUB_REPO_ROSTER_CACHE_MS
  })
  return { repos, privateReposHidden }
}

function mergeGithubInstallationRosters(
  installations: readonly Pick<GithubInstallationDto, 'id'>[],
  rosters: ReadonlyMap<string, GithubRepoDto[]>
): GithubInstalledRepoDto[] {
  const unique = new Map<string, GithubInstalledRepoDto>()
  for (const installation of installations) {
    for (const repo of rosters.get(installation.id) ?? []) {
      const key = repo.fullName.toLowerCase()
      if (!unique.has(key)) unique.set(key, { ...repo, installationId: installation.id })
    }
  }
  return [...unique.values()]
}

/** Merge every installation while retaining partial pages and per-installation
 * failures. Pickers can render the first available page instead of waiting for
 * the slowest organization. */
export async function fetchGithubRepoRoster(
  installations: readonly Pick<GithubInstallationDto, 'id'>[],
  signal?: AbortSignal,
  onProgress?: (repos: GithubInstalledRepoDto[]) => void
): Promise<{ repos: GithubInstalledRepoDto[]; privateReposHidden: boolean; failed: boolean }> {
  const rosters = new Map<string, GithubRepoDto[]>()
  const hiddenByInstallation = new Map<string, boolean>()
  const publish = (installationId: string, repos: GithubRepoDto[]) => {
    rosters.set(installationId, repos)
    onProgress?.(mergeGithubInstallationRosters(installations, rosters))
  }
  const errors = await Promise.all(
    installations.map(async (installation) => {
      try {
        const result = await fetchAllGithubRepos(installation.id, signal, (partial) =>
          publish(installation.id, partial)
        )
        hiddenByInstallation.set(installation.id, result.privateReposHidden)
        publish(installation.id, result.repos)
        return null
      } catch (error) {
        return error
      }
    })
  )
  return {
    repos: mergeGithubInstallationRosters(installations, rosters),
    privateReposHidden:
      [...hiddenByInstallation.values()].some(Boolean) ||
      errors.some((error) => error instanceof ApiError && error.code === 'GITHUB_IDENTITY_REQUIRED'),
    failed: errors.some(
      (error) => error !== null && !(error instanceof ApiError && error.code === 'GITHUB_IDENTITY_REQUIRED')
    )
  }
}

/** Resolve one repository through an App installation. Unlike the paged roster,
 * this reaches private repositories and repositories beyond the first 100 rows. */
export async function fetchGithubInstallationRepo(
  installationId: string,
  owner: string,
  repo: string,
  signal?: AbortSignal
): Promise<GithubRepoDto> {
  const path = `${orgBase()}/github/installations/${encodeURIComponent(installationId)}/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  return withGithubRepoRequestLimit(async () => {
    const res = await authenticatedFetch(path, { cache: 'no-store', signal })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string }
      throw new ApiError(body.message ?? `GET ${path} → ${res.status}`, res.status, body.code)
    }
    return (await res.json()) as GithubRepoDto
  }, signal)
}

export async function fetchGithubBranches(installationId: string, owner: string, repo: string): Promise<string[]> {
  const rows = await apiGet<Array<{ name: string }>>(
    `${orgBase()}/github/installations/${encodeURIComponent(installationId)}/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`
  )
  return rows.map((r) => r.name)
}

/** The caller's OWN effective access to a picked repo (per-user authz gate).
 *  `gated: false` ⇒ this deployment has no per-user gating (the route 404s) —
 *  the picker behaves as before. A 403 carries the CP's machine `code`
 *  (GITHUB_IDENTITY_REQUIRED | USER_NO_ACCESS) so the modal can word the note. */
export interface GithubRepoAccess {
  gated: boolean
  canRead: boolean
  canWrite: boolean
  identityRequired: boolean
  denied?: string
  message?: string
}

export async function fetchGithubRepoAccess(
  installationId: string,
  owner: string,
  repo: string
): Promise<GithubRepoAccess> {
  const path = `${orgBase()}/github/installations/${encodeURIComponent(installationId)}/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/access`
  const res = await authenticatedFetch(path, { cache: 'no-store' })
  if (res.status === 404) return { gated: false, canRead: true, canWrite: true, identityRequired: false }
  if (res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string }
    return {
      gated: true,
      canRead: false,
      canWrite: false,
      identityRequired: body.code === 'GITHUB_IDENTITY_REQUIRED',
      denied: body.code ?? 'USER_NO_ACCESS',
      ...(body.message ? { message: body.message } : {})
    }
  }
  if (!res.ok) throw new ApiError(`GET ${path} → ${res.status} ${res.statusText}`, res.status)
  const body = (await res.json()) as { canRead: boolean; canWrite: boolean; identityRequired?: boolean }
  return {
    gated: true,
    canRead: body.canRead,
    canWrite: body.canWrite,
    identityRequired: body.identityRequired ?? false
  }
}

// ── gitlab.com connections and project bindings ──────────────────────────────
// The org's GitLab.com OAuth connections and the projects they manage
// (gitlab-com-integration.md §18.2). Deployment-config opt-in like the GitHub
// App: without a GitLab OAuth application the CP registers none of these routes
// and every call 404s — mapped to `enabled: false` so callers get a tri-state
// instead of throws. No token material crosses this surface, ever.

/** One organization GitLab.com connection — the administration identity only. */
export interface GitlabConnectionDto {
  id: string
  gitlabUserId: string // numeric GitLab.com user id, losslessly as a string
  gitlabUsername: string
  state: 'connected' | 'reauth_required' | 'disconnected'
  scopes: string[]
  connectedBy: string | null // AgentConnect user id; null after user deletion
  /** Whether this connection is the CALLER's own: takeover and reconnect act on
   *  their own GitLab account, and the CP answers so the console compares no ids. */
  mine: boolean
  accessExpiresAt: string | null
  assignedProjects: number // managed projects this connection still administers
  /** The instance this deployment talks to — the same on every connection, because
   *  one deployment has exactly one host axis. Never secret. */
  instanceUrl: string
  /** What that instance last reported, and whether it clears the floor the CP
   *  enforces. Both null until the first credentialed contact. */
  instanceVersion: string | null
  instanceVersionSupported: boolean | null
  instanceVersionFloor: string
  createdAt: string
}

/** Deleting a connection twice means two things: the first call releases it and
 *  returns the retained row, the second removes the row entirely. */
export interface GitlabConnectionDeleteDto {
  removed: boolean
  connection: GitlabConnectionDto | null
}

/** One accessible project in the picker — metadata only, never installability. */
export interface GitlabProjectDto {
  projectId: string // numeric id, losslessly as a string
  path: string // current namespaced path — display only, renames are expected
  defaultBranch: string | null
  lastActivityAt: string | null
}

/** The managed webhook's state. `not_needed` is a normal resting state — a project with no
 *  enabled trigger wants no ingress — not a condition anyone has to act on. */
export type GitlabWebhookState = 'not_needed' | 'installed' | 'repairing' | 'failed'

export type GitlabProjectBindingState =
  'provisioning' | 'ready' | 'admin_degraded' | 'runtime_degraded' | 'cleanup_pending'

/** One managed project — its lifecycle state and non-secret external identity. */
/** A bot account's own health: the binding vocabulary plus the one state only an
 *  account can be in — the instance withdrew authority to create service accounts. */
export type GitlabAgentAccountState = GitlabProjectBindingState | 'service_account_creation_forbidden'

/** One agent's GitLab identity on a managed project. */
export interface GitlabProjectAccountDto {
  agentId: string
  username: string
  displayName: string | null
  userId: string | null
  /** The account's OWN health: an agent's identity can be broken on a ready project. */
  state: GitlabAgentAccountState
  stateReason: string | null
}

export interface GitlabProjectBindingDto {
  id: string
  projectId: string
  projectPath: string
  defaultBranch: string | null
  state: GitlabProjectBindingState
  stateReason: string | null
  /** The connection administering this project; null once it was removed. A
   *  project whose administering connection is not connected can neither be
   *  repaired nor removed — it is reconnected or transferred first. */
  installerConnectionId: string | null
  /** The per-agent service accounts bound to this project: each agent acts on
   *  GitLab as its own user, so a project has a member list, not one bot. */
  accounts: GitlabProjectAccountDto[]
  webhookState: GitlabWebhookState
  credentialEpoch: string
  createdAt: string
}

/** Removing a project can leave external cleanup unfinished; the binding then
 *  stays listed as `cleanup_pending` instead of disappearing (§19.4). */
export interface GitlabProjectRemovalDto {
  removed: boolean
  state?: GitlabProjectBindingState
  stateReason?: string | null
}

/** The connection list doubles as the enabled-probe: it is viewer-readable (the
 *  OAuth start route is not — minting a state is a write), and 404 ⇒ the feature
 *  is off on this deployment. */
export async function fetchGitlabConnections(): Promise<{ enabled: boolean; connections: GitlabConnectionDto[] }> {
  try {
    const body = await apiGet<{ connections: GitlabConnectionDto[] }>(`${orgBase()}/gitlab/connections`)
    return { enabled: true, connections: body.connections }
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return { enabled: false, connections: [] }
    throw e
  }
}

/** One-shot org-bound authorization URL. Mints a state the begin hop consumes,
 *  so fetch it fresh per click; `returnPath` is where the callback lands back. */
export function startGitlabOauth(returnPath?: string): Promise<string> {
  return apiPost<{ url: string }>(`${orgBase()}/gitlab/oauth/start`, returnPath ? { returnPath } : {}).then(
    (r) => r.url
  )
}

/** Two-step release. On a live connection this revokes the OAuth grant, drops the
 *  stored tokens, and keeps the row so its projects can still be listed; on an
 *  already-disconnected one that administers nothing it removes the row. Removal
 *  is refused (409) while any project is still assigned to the connection. */
export function disconnectGitlabConnection(id: string): Promise<GitlabConnectionDeleteDto> {
  return apiDelete<GitlabConnectionDeleteDto>(`${orgBase()}/gitlab/connections/${encodeURIComponent(id)}`)
}

/** Server-side paginated project search. `nextPage` is null on the last page. */
export function searchGitlabProjects(
  connectionId: string,
  input: { search?: string; page?: number } = {}
): Promise<{ projects: GitlabProjectDto[]; nextPage: number | null }> {
  const params = new URLSearchParams()
  if (input.search?.trim()) params.set('search', input.search.trim())
  if (input.page) params.set('page', String(input.page))
  const query = params.toString()
  return apiGet<{ projects: GitlabProjectDto[]; nextPage: number | null }>(
    `${orgBase()}/gitlab/connections/${encodeURIComponent(connectionId)}/projects${query ? `?${query}` : ''}`
  )
}

export function fetchGitlabProjects(orgId?: string): Promise<GitlabProjectBindingDto[]> {
  return apiGet<{ bindings: GitlabProjectBindingDto[] }>(`${orgBase(orgId)}/gitlab/projects`).then((r) => r.bindings)
}

/** Bind a project. The server re-fetches it and requires current Maintainer or
 *  Owner access, so the returned binding — not the picked row — is the truth. */
export function createGitlabProject(input: {
  connectionId: string
  projectId: string
}): Promise<GitlabProjectBindingDto> {
  return apiPost<GitlabProjectBindingDto>(`${orgBase()}/gitlab/projects`, input)
}

/** Re-run provisioning: identity, service account, credentials, and webhook. */
export function repairGitlabProject(id: string): Promise<GitlabProjectBindingDto> {
  return apiPost<GitlabProjectBindingDto>(`${orgBase()}/gitlab/projects/${encodeURIComponent(id)}/repair`, {})
}

/** Take over a project whose administering account can no longer act: the CP
 *  re-verifies the caller's own Maintainer-or-Owner access live, through the
 *  caller's own connection, and re-runs provisioning under it. Refusals carry a
 *  `GITLAB_*` code on the ApiError. */
export function transferGitlabProject(id: string): Promise<GitlabProjectBindingDto> {
  return apiPost<GitlabProjectBindingDto>(`${orgBase()}/gitlab/projects/${encodeURIComponent(id)}/transfer`, {})
}

export function deleteGitlabProject(id: string): Promise<GitlabProjectRemovalDto> {
  return apiDelete<GitlabProjectRemovalDto>(`${orgBase()}/gitlab/projects/${encodeURIComponent(id)}`)
}

/** One organization bot for the Integrations card: the service account an agent acts as, one per
 *  top-level group it has a bound project in, with the projects it is a member of. A project bound
 *  to two agents therefore appears under both bots, once per membership. */
export interface GitlabOrgAccountDto {
  id: string
  agentId: string
  rootGroupId: string // numeric top-level group id, losslessly as a string
  rootGroupPath: string | null // that group's current path, read off a bound project
  username: string
  displayName: string | null
  userId: string | null // numeric GitLab user id; null until the account exists
  state: GitlabAgentAccountState
  stateReason: string | null
  lifecycle: 'active' | 'retiring'
  /** The bound projects this account is a member of — which, not how: a project is managed
   *  where it is used, and this only tells a held binding from an orphaned one. */
  bindingIds: string[]
}

/** The organization's bots, plus whether account convergence still owes it work — the console
 *  cannot judge that itself, so it asks again only while the answer is yes.
 *  Same enabled-probe shape as the connection list: 404 ⇒ no GitLab app. */
export async function fetchGitlabAccounts(
  orgId?: string
): Promise<{ enabled: boolean; accounts: GitlabOrgAccountDto[]; converging: boolean }> {
  try {
    const body = await apiGet<{ accounts: GitlabOrgAccountDto[]; converging: boolean }>(
      `${orgBase(orgId)}/gitlab/accounts`
    )
    return { enabled: true, accounts: body.accounts, converging: body.converging }
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return { enabled: false, accounts: [], converging: false }
    throw e
  }
}

// ── agent repository authorizations (agent-multi-repo-authorization.md) ──────
// Explicit non-workspace repo grants on an agent — the detail page's
// Repositories card. The workspace repo is implicit and never listed here; the
// CP mints per-repo tokens at the tier's capability levels. No tokens on this
// surface, ever.

/** Access tier of one grant: `comment` = contents:read + issues/PR:write (the
 *  hook write-back shape); `read`/`write` are uniform across capabilities. */
export type RepoAccess = 'read' | 'comment' | 'write'

export interface AgentRepoAuthDto {
  id: string
  /** Which host numbers `repoId`. Absent on an older CP, where every grant is GitHub. */
  provider?: 'github' | 'gitlab'
  repoId?: string // rename-proof numeric repository/project id (absent on an older CP)
  repoFullName: string // owner/repo as GitHub cases it, or the GitLab project path (refreshed on rename)
  access: RepoAccess
  createdBy: string | null // authorizer's userId (resolved to a name / "You" in the UI); null for key-created
  createdAt: string // ISO-8601
}

/** Which host a grant row names — an older CP omits the field and means GitHub. */
export function repoAuthProvider(row: AgentRepoAuthDto): 'github' | 'gitlab' {
  return row.provider ?? 'github'
}

// Gated by the agent's visibility server-side (404 for an agent you can't see) —
// same contract as fetchAgentHooks.
export async function fetchAgentRepos(agentId: string, orgId?: string): Promise<AgentRepoAuthDto[]> {
  return apiGet<AgentRepoAuthDto[]>(`${orgBase(orgId)}/agents/${encodeURIComponent(agentId)}/repos`)
}

// Not apiPost: the denial body carries the CP's human-readable message (400
// repo-not-covered / 409 duplicate-or-workspace) and, for the per-user
// identity-assertion gate, a machine `code` (GITHUB_IDENTITY_REQUIRED |
// USER_NO_ACCESS) that the add-repo modal words inline.
export async function createAgentRepo(
  agentId: string,
  // One arm per host: a GitHub repository by full name, a GitLab project by its
  // numeric id (the namespaced path is never a match key).
  input: { repoFullName: string; access: RepoAccess } | { provider: 'gitlab'; projectId: string; access: RepoAccess }
): Promise<AgentRepoAuthDto> {
  const path = `${orgBase()}/agents/${encodeURIComponent(agentId)}/repos`
  const res = await authenticatedFetch(
    path,
    { method: 'POST', body: JSON.stringify(input) },
    { 'content-type': 'application/json' }
  )
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string }
    throw new ApiError(body.message ?? `POST ${path} → ${res.status} ${res.statusText}`, res.status, body.code)
  }
  return (await res.json()) as AgentRepoAuthDto
}

export async function updateAgentRepo(
  agentId: string,
  repoAuthId: string,
  input: { access: RepoAccess }
): Promise<AgentRepoAuthDto> {
  const path = `${orgBase()}/agents/${encodeURIComponent(agentId)}/repos/${encodeURIComponent(repoAuthId)}`
  const res = await authenticatedFetch(
    path,
    { method: 'PATCH', body: JSON.stringify(input) },
    { 'content-type': 'application/json' }
  )
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string }
    throw new ApiError(body.message ?? `PATCH ${path} → ${res.status} ${res.statusText}`, res.status, body.code)
  }
  return (await res.json()) as AgentRepoAuthDto
}

// Revoke a grant (204). Already-minted tokens live out their ≤1h expiry; the
// next credential request for the repo is denied.
export async function deleteAgentRepo(agentId: string, repoAuthId: string): Promise<void> {
  await apiDelete<void>(`${orgBase()}/agents/${encodeURIComponent(agentId)}/repos/${encodeURIComponent(repoAuthId)}`)
}

// ── crons ─────────────────────────────────────────────────────────────────────
export async function fetchCrons(orgId?: string): Promise<CronDto[]> {
  return apiGet<CronDto[]>(`${orgBase(orgId)}/crons`)
}

// Create-or-update a cron. `PUT /crons/:id` is an idempotent upsert keyed on the
// UUID, so a create just mints a fresh id client-side (see data-context).
export async function upsertCron(id: string, body: UpsertCronInput): Promise<CronDto> {
  return apiPut<CronDto>(`${orgBase()}/crons/${encodeURIComponent(id)}`, body)
}

// Set a cron's visibility + share set (PUT /crons/:id/sharing).
export async function updateCronSharing(id: string, body: SharingInput): Promise<CronDto> {
  return apiPut<CronDto>(`${orgBase()}/crons/${encodeURIComponent(id)}/sharing`, body)
}

export async function deleteCron(id: string): Promise<void> {
  await apiDelete<void>(`${orgBase()}/crons/${encodeURIComponent(id)}`)
}

// One daemon-reported fire (detail-page run history). `running` = fire seen,
// completion not yet (or lost while the CP was down — display-only).
export interface CronRunDto {
  id: string
  startedAt: string // ISO-8601
  status: 'running' | 'success' | 'failed'
  durationMs: number | null
  sessionId: string | null // ACP session id — deep-links to the session page
  reason: string | null // short failure text
}

export async function fetchCronRuns(id: string, orgId?: string): Promise<CronRunDto[]> {
  return apiGet<CronRunDto[]>(`${orgBase(orgId)}/crons/${encodeURIComponent(id)}/runs`)
}

// Console "Run now" — the daemon fires the cron immediately; 202 only means it
// accepted, the outcome lands in the run history asynchronously.
export async function runCronNow(id: string): Promise<void> {
  await apiPost<null>(`${orgBase()}/crons/${encodeURIComponent(id)}/run`, {})
}

// ── organization knowledge + managed skills ─────────────────────────────────

export interface OrganizationKnowledgeDto {
  id: string
  title: string
  content: string
  summary: string | null
  tags: string[]
  currentRevision: number
  digest: string
  source: 'manual' | 'dream'
  sourceAgentId: string | null
  sourceDreamId: string | null
  sourceSessionIds: string[]
  createdByUserId: string | null
  reviewedByUserId: string | null
  archivedAt: string | null
  createdAt: string
  updatedAt: string
  revisionCreatedAt: string
  canManage: boolean
}

export interface OrganizationKnowledgeRevisionDto {
  knowledgeId: string
  revision: number
  content: string
  summary: string | null
  tags: string[]
  digest: string
  source: 'manual' | 'dream'
  sourceAgentId: string | null
  sourceDreamId: string | null
  sourceSessionIds: string[]
  createdByUserId: string | null
  reviewedByUserId: string | null
  createdAt: string
}

export interface ManagedSkillDto {
  id: string
  name: string
  description: string
  currentRevision: number
  digest: string
  compressedBytes: number
  expandedBytes: number
  fileCount: number
  manifest: {
    name?: string
    description?: string
    files?: Array<{ path: string; bytes: number; digest: string }>
    [key: string]: unknown
  }
  archivedAt: string | null
  createdAt: string
  updatedAt: string
  canManage: boolean
}

export interface ManagedSkillRevisionDto {
  managedSkillId: string
  revision: number
  digest: string
  compressedBytes: number
  expandedBytes: number
  fileCount: number
  manifest: ManagedSkillDto['manifest']
  source: 'manual' | 'dream'
  sourceAgentId: string | null
  sourceDreamId: string | null
  sourceSessionIds: string[]
  createdByUserId: string | null
  reviewedByUserId: string | null
  createdAt: string
}

export interface OrganizationSuggestionDto {
  id: string
  sourceAgentId: string
  sourceAgentName: string | null
  sourceDaemonId: string | null
  dreamId: string
  candidateId: string
  kind: 'knowledge' | 'skill'
  operation: 'create' | 'update'
  targetArtifactId: string | null
  targetRevision: number | null
  title: string
  summary: string | null
  tags: string[]
  digest: string
  contentBytes: number
  sessionIds: string[]
  state: 'pending' | 'accepted' | 'rejected'
  contentAvailable: boolean
  reviewedAt: string | null
  reviewReason: string | null
  acceptedArtifactId: string | null
  acceptedArtifactRevision: number | null
  createdAt: string
  updatedAt: string
}

export type OrganizationSuggestionContentDto =
  | {
      kind: 'knowledge'
      digest: string
      snapshotToken: string
      content: string
      summary: string | null
      tags: string[]
    }
  | {
      kind: 'skill'
      digest: string
      snapshotToken: string
      files: Array<{ path: string; encoding: 'utf8' | 'base64'; content: string }>
    }

export function listOrganizationKnowledge(includeArchived = false): Promise<OrganizationKnowledgeDto[]> {
  return apiGet<OrganizationKnowledgeDto[]>(
    `${orgBase()}/knowledge?includeArchived=${includeArchived ? 'true' : 'false'}`
  )
}

export function listOrganizationKnowledgeRevisions(id: string): Promise<OrganizationKnowledgeRevisionDto[]> {
  return apiGet<OrganizationKnowledgeRevisionDto[]>(`${orgBase()}/knowledge/${encodeURIComponent(id)}/revisions`)
}

export function createOrganizationKnowledge(input: {
  title: string
  content: string
  summary?: string
  tags?: string[]
}): Promise<OrganizationKnowledgeDto> {
  return apiPost<OrganizationKnowledgeDto>(`${orgBase()}/knowledge`, input)
}

export function updateOrganizationKnowledge(
  id: string,
  input: { title: string; content: string; summary?: string; tags?: string[]; expectedRevision: number }
): Promise<OrganizationKnowledgeDto> {
  return apiPatch<OrganizationKnowledgeDto>(`${orgBase()}/knowledge/${encodeURIComponent(id)}`, input)
}

export function setOrganizationKnowledgeArchived(id: string, archived: boolean): Promise<OrganizationKnowledgeDto> {
  return apiPost<OrganizationKnowledgeDto>(`${orgBase()}/knowledge/${encodeURIComponent(id)}/archive`, { archived })
}

export function listManagedSkills(includeArchived = false, orgId?: string): Promise<ManagedSkillDto[]> {
  return apiGet<ManagedSkillDto[]>(
    `${orgBase(orgId)}/managed-skills?includeArchived=${includeArchived ? 'true' : 'false'}`
  )
}

export function listManagedSkillRevisions(id: string): Promise<ManagedSkillRevisionDto[]> {
  return apiGet<ManagedSkillRevisionDto[]>(`${orgBase()}/managed-skills/${encodeURIComponent(id)}/revisions`)
}

export function setManagedSkillArchived(id: string, archived: boolean): Promise<ManagedSkillDto> {
  return apiPost<ManagedSkillDto>(`${orgBase()}/managed-skills/${encodeURIComponent(id)}/archive`, { archived })
}

export function listOrganizationSuggestions(
  filters: {
    kind?: 'knowledge' | 'skill'
    state?: 'pending' | 'accepted' | 'rejected'
    query?: string
  } = {}
): Promise<OrganizationSuggestionDto[]> {
  const params = new URLSearchParams()
  if (filters.kind) params.set('kind', filters.kind)
  if (filters.state) params.set('state', filters.state)
  if (filters.query?.trim()) params.set('query', filters.query.trim())
  const query = params.toString()
  return apiGet<OrganizationSuggestionDto[]>(`${orgBase()}/knowledge-suggestions${query ? `?${query}` : ''}`)
}

export function fetchOrganizationSuggestionContent(id: string): Promise<OrganizationSuggestionContentDto> {
  return apiGet<OrganizationSuggestionContentDto>(
    `${orgBase()}/knowledge-suggestions/${encodeURIComponent(id)}/content`
  )
}

export function reviewOrganizationSuggestion(
  id: string,
  decision: 'accept',
  snapshotToken: string
): Promise<OrganizationSuggestionDto>
export function reviewOrganizationSuggestion(
  id: string,
  decision: 'reject',
  reason?: string
): Promise<OrganizationSuggestionDto>
export function reviewOrganizationSuggestion(
  id: string,
  decision: 'accept' | 'reject',
  detail?: string
): Promise<OrganizationSuggestionDto> {
  return apiPost<OrganizationSuggestionDto>(`${orgBase()}/knowledge-suggestions/${encodeURIComponent(id)}/review`, {
    decision,
    ...(decision === 'accept' ? { snapshotToken: detail } : detail?.trim() ? { reason: detail.trim() } : {})
  })
}
