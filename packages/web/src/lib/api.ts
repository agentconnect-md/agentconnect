// Control Plane (C2 BFF) HTTP client for the console.
// Talks to the Fastify REST API in packages/control-plane (`/agents`, `/sessions`,
// `/daemons`, …). DTOs here mirror packages/control-plane/src/http/dto. The
// mappers translate the lean wire DTOs into the richer UI shapes from `./data`,
// filling fields the API does not (yet) expose with placeholders.

import type { Agent, AgentCallPolicy, DaemonRow, ResourceVisibility, Session, StatusKey, Workspace } from '@/lib/data'
import { isSelfSender, MOCK_MODE } from '@/lib/data'
import type { AgentIcon } from '@/lib/agent-icon'
import { withIconUrl } from '@/lib/agent-icon'
import { getToken, getIdTokenRaw, getUser } from '@/lib/auth'
import { track } from '@/lib/analytics'
import { createSseParser } from '@/lib/sse'
import { isUpgradeAvailable } from '@/lib/version'

/** A non-2xx CP response. `status` lets callers branch without parsing strings;
 *  `code` carries the CP's machine-readable denial reason when the endpoint
 *  provides one (e.g. github user-authz: GITHUB_IDENTITY_REQUIRED). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
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
 * Build the client-facing webchat WebSocket URL for an agent (milestone A4: the relay
 * pool is the ONLY webchat path — the CP is never on the message hot path). Mint a
 * CP token, then dial `${relayUrl}/webchat?token=…&conversation_id=…`; content never
 * touches the CP. Throws `ApiError(503)` when no relay pool is configured.
 *
 * Pass `conversationId` to RESUME an existing conversation: the relay re-resolves the
 * agent's live placement and lands the socket on that same daemon session so the console
 * can continue a session opened from the list. Omit it to start fresh (the CP mints the
 * id, echoed back in the `ready` frame).
 */
export async function webchatWsUrl(orgId: string, agentId: string, conversationId?: string): Promise<string> {
  const minted = await mintWebchatToken(orgId, agentId, conversationId)
  const base = minted.relayUrl.replace(/^http/, 'ws').replace(/\/+$/, '') // http→ws, https→wss
  const params = new URLSearchParams({ token: minted.token, conversation_id: minted.conversationId })
  return `${base}/webchat?${params.toString()}`
}

// ── wire DTOs (subset we consume) ───────────────────────────────────────────

// Where the agent runs — inline two-mode workspace (CP `AgentWorkspaceBody`,
// protocol `AgentWorkspace`). The path is daemon-generated; github mode carries
// the repo/branch/subdir the daemon clones.
export type AgentWorkspaceDto =
  | { mode: 'scratch' }
  | {
      mode: 'github'
      gitRepo: string
      gitBranch?: string
      agentDir?: string
      // github-app credential mode: the GithubInstallation picked in the repo
      // picker. Absent ⇒ anonymous git — the daemon host is assumed to have its
      // own GitHub access (the pre-picker behavior, still the manual-URL path).
      installationId?: string
      gitAccess?: 'read' | 'write'
    }

export interface ExternalMemoryRecallPolicy {
  mode: 'auto' | 'tool-only'
  topK: number
  maxBytes: number
  timeoutMs: number
}

export type AgentMemoryConfig =
  | { provider: 'managed'; autoDistill?: boolean }
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
  icon: AgentIcon | null // console avatar; null ⇒ legacy default (runtime mark)
  iconUrl: string | null // resolved URL for an uploaded `image` icon; null otherwise
  description: string | null
  runtime: string
  model: string | null
  reasoningEffort: string | null
  outputMode: string | null // platform output verbosity: low | medium | high; null when unset
  showFooter: boolean // render attribution/session footer; defaults true
  fastMode: boolean | null // runtime fast mode; null when never set (runtime default)
  permissionMode: string | null // runtime permission/approval mode; null when never set
  allowRuntimeChangesInChat: boolean // explicit opt-in; defaults false
  pause: boolean | null // operational message-processing toggle; true ⇒ agent skips all messages; null ⇒ not paused
  env: Record<string, string> // extra env injected into the runtime
  secretKeys: string[] // names of the agent's write-only secret env vars (values never returned)
  status: string
  daemonId: string | null
  workspace: AgentWorkspaceDto
  workspaceRepoId?: string | null
  capabilities: string[]
  mcpServers: string[] // daemon-configured MCP server names attached at session/new; empty ⇒ none
  skills: string[] // enabled shared-skills "<source>/<skill>" / "<source>/*"; empty ⇒ none
  memory: AgentMemoryConfig | null // memory backend; null ⇒ managed default
  createdAt: string // ISO-8601
  createdBy: string | null // creator's userId (resolved to a name / "You" in the UI); null for daemon/CLI-created
  lastModifiedAt: string // ISO-8601
  lastModifiedBy: string | null // editor's userId (resolved to a name / "You" in the UI); null for daemon/CLI-created
  visibility: ResourceVisibility // 'org' = all members; 'restricted' = creator + owners + sharedWith
  sharedWith: string[] // app_user.id set (only meaningful when restricted)
  canManageSharing: boolean // whether the caller may change this resource's sharing (= canEdit)
  callPolicy: AgentCallPolicy // which peer agents may call this agent as a sub-agent
  allowedCallerAgentIds: string[] // agent.id set, meaningful when callPolicy='selected'
  outboundPolicy: AgentCallPolicy // which peer agents this agent may discover/call
  allowedTargetAgentIds: string[] // agent.id set, meaningful when outboundPolicy='selected'
  introduceOnJoin: boolean // #536: self-introduce to peers on a genuine channel join
  restrictFileAccess: boolean // #642: persisted per-agent Run in sandbox preference
  sandboxSupported: boolean // #642: whether the placed daemon can provide an OS sandbox
  sandboxRequired: boolean // #642: whether daemon policy forces the effective value on
  hookKinds: ('webhook' | 'github')[] // distinct kinds of enabled inbound triggers (list-view marks)
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

export interface SessionDto {
  sessionId: string
  sessionKey: { platform: string; channel: string; thread?: string }
  agentId: string
  title: string | null
  status: string | null
  lastActivityAt: string | null
  usage: SessionUsageDto | null
  triggeredBy: string | null
  hookKind?: 'webhook' | 'github' | null
  // Daemon-resolved display names; null until the daemon has resolved them.
  channelName: string | null
  triggeredByName: string | null
  // Platform-native deep link back to the source thread (e.g. a Slack archives
  // permalink), built by the daemon; null when unavailable.
  threadUrl: string | null
  // Execution-config snapshot the session actually ran with (daemon-reported;
  // daemonId is CP-stamped from the reporting WS connection). null ⇒ never
  // reported (legacy row): the console falls back to the owning agent's
  // current config. A null value on a reported row ⇒ the runtime's own default.
  runtime: string | null
  model: string | null
  effort: string | null
  fastMode: boolean | null
  permissionMode: string | null
  outputMode: string | null
  daemonId: string | null
}

export interface SessionFacetsDto {
  agents: string[]
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
    hookKind: 'webhook' | 'github' | null
    githubRepoId: string | null
  }>
}

export interface SessionListPageDto {
  sessions: SessionDto[]
  total: number | null
  nextCursor: string | null
}

export interface SessionListFilters {
  agentId?: string
  platform?: string
  integration?: string
  channel?: string
  triggeredBy?: string
  githubRepoId?: string
}

export interface SessionFacets {
  agentIds: string[]
  integrations: string[]
  channels: Array<{ value: string; label: string; platform: string }>
  triggers: Array<{
    value: string
    name?: string
    platform: string
    hookKind?: 'webhook' | 'github'
    githubRepoId?: string
  }>
}

export interface SessionListPage {
  sessions: Session[]
  total: number | null
  nextCursor: string | null
}

export interface SessionRelationDto {
  id: string
  agentId: string
  title: string | null
}

export interface SessionDetailDto {
  id: string
  parentSession: SessionRelationDto | null
  childSessions: SessionRelationDto[]
  agentId: string
  platform: string | null
  channel: string | null
  thread: string | null
  title: string | null
  status: string | null
  lastActivityAt: string
  triggeredBy: string | null
  channelName: string | null
  triggeredByName: string | null
  threadUrl: string | null
  runtime: string | null
  model: string | null
  effort: string | null
  fastMode: boolean | null
  permissionMode: string | null
  outputMode: string | null
  daemonId: string | null
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

// One transcript message (`GET /sessions/:id/messages`, proxied live from the
// owning daemon). `kind` is the daemon transcript kind: text | tool | reasoning.
// The tool-body fields are present only on `kind === 'tool'` rows from a daemon
// that captures bodies (all optional ⇒ old daemons / text rows omit them).
export interface SessionMessageDto {
  seq: number
  sender: string
  senderName?: string // daemon-resolved display name; absent if unknown
  ts: string
  kind: string
  text: string
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
  targetPlatform: 'slack' | 'telegram'
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
  canManageSharing: boolean
}

// PUT /crons/:id body (idempotent upsert keyed on the cron UUID).
export interface UpsertCronInput {
  agentId: string // the agent this cron drives — required
  name?: string // console display name
  schedule: string
  timezone?: string // omitted on create ⇒ control-plane process timezone
  targetPlatform: 'slack' | 'telegram'
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
// carries its own credential block. Slack additionally carries a `transport`:
//   - `socket` — Socket Mode; the credential block is bot token (xoxb-) + app-level
//     token (xapp-). The daemon opens the socket directly (this agent only).
//   - `http` — Events API via the relay; the credential block is bot token (xoxb-) +
//     signing secret (no xapp-). Required to SHARE one bot across agents.
// The CP maps socket→IntegrationSlackConfig.mode:'direct', http→'shared' for the
// daemon. Telegram/Discord each take a single bot token — no transport concept;
// Feishu takes an appId + appSecret pair (no app-level token / OAuth).
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
      feishu?: { appId: string; appSecret: string; region?: 'feishu' | 'lark' }
    })

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
  updatedAt: string | null
}
/** `PUT /slack/config` body — the caller's own Slack App Configuration token. The
 *  access (config) token is required; the refresh token is optional (adds durability). */
export interface SlackConfigInput {
  accessToken: string // xoxe.xoxp-…
  refreshToken?: string // xoxe-… — optional; omit to store an access-only (expiring) token
}

// How the bot activates in one channel: only when @-mentioned, or on any message.
export type ChannelTrigger = 'mention' | 'any'

// One channel the integration's bot is in (daemon-reported) + its trigger choice.
export interface IntegrationChannelDto {
  channelId: string
  name: string | null // "deploys" without the hash; null if lookup failed
  isPrivate: boolean
  trigger: ChannelTrigger
  agentId: string | null // per-channel default agent for a shared bot; null ⇒ unset
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
  createdBy: string | null // creator's userId (resolved to a name / "You" in the UI); null for prebuilt/CLI
  // Inbound transport (Slack): 'socket' = Socket Mode (this agent only), 'http' =
  // Events API via the relay. Only an http bot may be shared. Missing (older CP)
  // ⇒ treat as 'socket'.
  transport: 'socket' | 'http'
  shareable: boolean // shared-bot opt-in — when true it may serve many agents at once
  inUseByAgentId: string | null // classic-bot occupancy; ALWAYS null for a shareable bot
  agentIds: string[] // every agent currently installed on the bot (a shared bot may have many)
  lastUsedAt: string | null // ISO-8601; stamped when last freed; null ⇒ never used
  freedFromAgent: string | null // agent it was last freed from ("freed from support-bot")
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
  fastMode?: boolean | null
  permissionMode?: string | null
  allowRuntimeChangesInChat?: boolean
  /** Operational message-processing toggle; true ⇒ agent skips all messages; null clears. */
  pause?: boolean | null
  /** #536: self-introduce to peers on a genuine channel join (default off). */
  introduceOnJoin?: boolean
  /** #642: confine the agent process to its agent dir via an OS sandbox (default on). */
  restrictFileAccess?: boolean
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
  /** Memory backend; null clears (revert to managed default). */
  memory?: AgentMemoryConfig | null
}

export type SetAgentWorkspaceInput =
  | { mode: 'scratch' }
  | {
      mode: 'github'
      repoFullName: string
      /** Absent lets the server use GitHub's current default branch. */
      gitBranch?: string
      agentDir?: string
      gitAccess: 'read' | 'write'
    }

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
  visibility: ResourceVisibility
  sharedWith: string[]
  canManageSharing: boolean
  /** Whether the caller may command restart/upgrade on this daemon (org owner only). */
  canManageLifecycle: boolean
}

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
  name: string // slug — the CP rejects anything but ^[a-z0-9]+(-[a-z0-9]+)*$
  displayName?: string
  icon?: AgentIcon // absent ⇒ the CP assigns a random glyph+color
  runtime: string
  description?: string
  model?: string
  reasoningEffort?: string
  outputMode?: string // platform output verbosity: low | medium | high
  showFooter?: boolean
  fastMode?: boolean // runtime fast mode toggle
  permissionMode?: string // runtime permission/approval mode
  allowRuntimeChangesInChat?: boolean
  pause?: boolean // operational message-processing toggle; true ⇒ agent skips all messages
  env?: Record<string, string>
  secrets?: Record<string, string> // write-only secret env vars (initial set)
  /** The owning daemon, if chosen at create. */
  daemonId?: string
  /** Where it runs; absent ⇒ the CP defaults to scratch. Immutable after create. */
  workspace?: AgentWorkspaceDto
  capabilities?: string[]
  /** Daemon-configured MCP server names to attach at session/new; absent ⇒ none. */
  mcpServers?: string[]
  /** Enabled shared-skills "<source>/<skill>" / "<source>/*"; absent ⇒ none. */
  skills?: string[]
  /** Memory backend; absent ⇒ managed default. */
  memory?: AgentMemoryConfig
  /** Request an OS sandbox for this agent; absent ⇒ false unless daemon policy requires it. */
  restrictFileAccess?: boolean
  /** Initial visibility (absent ⇒ 'org'); sharedWith is intersected with org members. */
  visibility?: ResourceVisibility
  sharedWith?: string[]
  /** Initial agent-call policy (absent ⇒ 'all'); allowedCallerAgentIds is
   *  intersected with visible same-org peers and only bites when 'selected'. */
  callPolicy?: AgentCallPolicy
  allowedCallerAgentIds?: string[]
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
  joinedAt: string // ISO-8601
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
  /** Whether the object store is configured — the console shows Upload only when true. */
  iconUploadEnabled: boolean
  /** The signed-in user's role in this org. */
  role: MemberRole
  memberCount: number
  createdAt: string // ISO-8601
}

// ── active org ────────────────────────────────────────────────────────────────
// The CP API is path-scoped: every org resource lives under `/orgs/{orgId}/…`.
// The OrgProvider resolves the URL's org slug to an id and hands it here; the
// endpoint helpers below prefix their paths with it.
let apiOrgId: string | null = null

/** Set by the OrgProvider whenever the active org (from the URL) resolves. */
export function setApiOrgId(orgId: string | null): void {
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

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${cpBase()}${path}`, { headers: await authHeaders(), cache: 'no-store' })
  if (!res.ok) throw new ApiError(`GET ${path} → ${res.status} ${res.statusText}`, res.status)
  return (await res.json()) as T
}

type SessionInvalidationHandler = () => void

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
  onInvalidate: SessionInvalidationHandler
): Promise<void> {
  const path = `/orgs/${encodeURIComponent(orgId)}/stream`
  const res = await fetch(`${cpBase()}${path}`, {
    headers: await authHeaders({ accept: 'text/event-stream' }),
    cache: 'no-store',
    signal
  })
  if (!res.ok) throw new ApiError(`GET ${path} → ${res.status} ${res.statusText}`, res.status)
  if (!res.body) throw new Error('session event stream is not readable')

  // The sink has no replay/event ids, so every successful (re)connect invalidates
  // the list once. This closes both a disconnect gap and the initial GET→subscribe
  // race without requiring a polling cache layer.
  onInvalidate()

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const parser = createSseParser((event) => {
    if (event.event === 'session') onInvalidate()
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
}

/**
 * Subscribe to the org's session-milestone SSE feed with the same auth headers
 * as REST calls. The callback is an invalidation signal (on connect and on each
 * session event), not an authoritative event payload. Returns an abort cleanup.
 */
export function subscribeSessionEvents(
  orgId: string,
  onInvalidate: SessionInvalidationHandler,
  onError?: (error: unknown) => void
): () => void {
  const ctrl = new AbortController()
  let retryMs = 1000

  void (async () => {
    while (!ctrl.signal.aborted) {
      try {
        await readSessionEventStream(orgId, ctrl.signal, onInvalidate)
        retryMs = 1000
      } catch (error) {
        if (ctrl.signal.aborted) return
        onError?.(error)
      }
      if (ctrl.signal.aborted) return
      await waitBeforeReconnect(retryMs, ctrl.signal)
      retryMs = Math.min(retryMs * 2, 30_000)
    }
  })()

  return () => ctrl.abort()
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${cpBase()}${path}`, {
    method: 'POST',
    headers: await authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body)
  })
  if (!res.ok) throw await apiErrorFromResponse('POST', path, res)
  return (await res.json()) as T
}

async function apiErrorFromResponse(method: string, path: string, res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => ({}))) as { code?: unknown; message?: unknown }
  const message =
    typeof body.message === 'string' && body.message.length > 0
      ? body.message
      : `${method} ${path} → ${res.status} ${res.statusText}`
  return new ApiError(message, res.status, typeof body.code === 'string' ? body.code : undefined)
}

async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${cpBase()}${path}`, {
    method: 'PATCH',
    headers: await authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    // Surface the CP's human-readable denial (e.g. the shared-bot 409s: "no relay
    // is connected…") instead of a bare status line.
    throw await apiErrorFromResponse('PATCH', path, res)
  }
  return (await res.json()) as T
}

async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${cpBase()}${path}`, {
    method: 'PUT',
    headers: await authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body)
  })
  if (!res.ok) throw await apiErrorFromResponse('PUT', path, res)
  return (await res.json()) as T
}

async function apiDelete<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${cpBase()}${path}`, {
    method: 'DELETE',
    headers: await authHeaders(body === undefined ? undefined : { 'content-type': 'application/json' }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
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

function toStatusKey(raw: string): StatusKey {
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
  if (w.mode === 'github') {
    return {
      mode: 'github',
      ...(workspaceRepoId ? { repoId: workspaceRepoId } : {}),
      repo: repoLabel(w.gitRepo),
      ...(repoWebUrl(w.gitRepo) ? { repoUrl: repoWebUrl(w.gitRepo) } : {}),
      ...(w.installationId ? { installationId: w.installationId } : {}),
      ...(w.gitAccess ? { gitAccess: w.gitAccess } : {}),
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
    icon: withIconUrl(d.icon, d.iconUrl),
    // Blank when the agent has no explicit model — the UI shows "Default" (runtime
    // default). Never fall back to the runtime id: that would fabricate a model.
    model: d.model ?? '',
    runtime: d.runtime,
    desc: d.description ?? PLACEHOLDER,
    // '—' when the CP has no explicit value: the daemon then falls back to the
    // local agent.json (default 'low'). Session count is derived in the view from
    // the fetched `/sessions` list, so it's not a field here.
    outputMode: d.outputMode ?? PLACEHOLDER,
    showFooter: d.showFooter ?? true,
    reasoning: d.reasoningEffort ?? '',
    // Unset (null) reads as "Off" — the runtime default.
    fastMode: d.fastMode ?? false,
    // Unset (null) reads as not paused.
    pause: d.pause ?? false,
    // Memory backend (unset ⇒ managed default).
    memoryProvider: d.memory?.provider ?? 'managed',
    memoryAutoDistill: d.memory?.provider === 'managed' ? (d.memory.autoDistill ?? false) : false,
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
    daemon: d.daemonId ?? PLACEHOLDER,
    region: PLACEHOLDER,
    repo: ws.mode === 'github' ? ws.repo : PLACEHOLDER,
    workdir: ws.mode === 'github' ? ws.agentDir : PLACEHOLDER,
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
    canManageSharing: d.canManageSharing,
    callPolicy: d.callPolicy,
    allowedCallerAgentIds: d.allowedCallerAgentIds,
    outboundPolicy: d.outboundPolicy ?? 'all',
    allowedTargetAgentIds: d.allowedTargetAgentIds ?? [],
    // Unset (older CP) reads as off — the product default.
    introduceOnJoin: d.introduceOnJoin ?? false,
    // Older CPs omit the policy fields; the safe UI fallback is unavailable/off.
    restrictFileAccess: d.restrictFileAccess ?? false,
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
  if (n >= 1_000_000) return trim((n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 2)) + 'M'
  if (n >= 1_000) return trim((n / 1_000).toFixed(n >= 10_000 ? 0 : 1)) + 'K'
  return String(n)
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
  triggeredByName: string | null
): string {
  // webchat's `channel` is the conversationId (a UUID) — never a human channel. Show the
  // "Playground" label (matching platName + the live playground session), and keep the raw
  // id in channelId so the detail view can RESUME it (reconnect with `?conversation_id=`).
  const isWebchat = platform === 'webchat'
  // A headless webhook's `channel` is the hook id (and `thread` may be the delivery key),
  // so render the CP-enriched hook name when present and otherwise hide the raw UUID.
  const isHook = platform === 'hook'
  const hookLabel = channelName?.trim() || 'Webhook'
  // Name-first display: "#general" when the daemon resolved a channel name, or the
  // DM counterpart verbatim ("@Dana Reyes" — already @-prefixed by the daemon). A
  // Slack DM ("D…" im id) the daemon hasn't labeled yet falls back to the
  // triggering user so the raw id never shows as the channel.
  const isSlackDm = platform === 'slack' && /^D/.test(rawChannel)
  const dmFallback = isSlackDm ? (triggeredByName ? `@${triggeredByName}` : 'DM') : null
  return isWebchat
    ? 'Playground'
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
  const channel = sessionChannelLabel(platform, rawChannel, d.channelName, d.triggeredByName)
  const isSlackDm = platform === 'slack' && /^D/.test(rawChannel)
  const dmFallback = isSlackDm ? (d.triggeredByName ? `@${d.triggeredByName}` : 'DM') : null
  const user =
    d.triggeredByName || (isHook && d.triggeredBy?.startsWith('hook:') ? 'Webhook' : d.triggeredBy) || PLACEHOLDER
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
    ...(d.daemonId !== null && d.daemonId !== undefined ? { daemon: d.daemonId } : {})
  }
}

/** Hydrate a session detail that was not present in the currently loaded list
 *  pages. Usage stays unknown until its list page is loaded, but navigation and
 *  transcript pull have the same metadata as an ordinary list-derived session. */
export function sessionFromDetailDto(d: SessionDetailDto): Session {
  return sessionFromDto({
    sessionId: d.id,
    sessionKey: {
      platform: d.platform ?? 'slack',
      channel: d.channel ?? '',
      ...(d.thread !== null ? { thread: d.thread } : {})
    },
    agentId: d.agentId,
    title: d.title,
    status: d.status,
    lastActivityAt: d.lastActivityAt,
    usage: null,
    triggeredBy: d.triggeredBy,
    channelName: d.channelName,
    triggeredByName: d.triggeredByName,
    threadUrl: d.threadUrl,
    runtime: d.runtime,
    model: d.model,
    effort: d.effort,
    fastMode: d.fastMode,
    permissionMode: d.permissionMode,
    outputMode: d.outputMode,
    daemonId: d.daemonId
  })
}

export function daemonFromDto(d: DaemonViewDto): DaemonRow {
  return {
    daemonId: d.daemonId,
    // Display label: the daemon name (the CP seeds it from the hostname on first
    // register, so a connected daemon always has one), else a short id for a
    // provisioned-but-never-connected row. Never the raw hostname.
    name: d.name || d.daemonId.slice(0, 8),
    version: d.agentVersion || PLACEHOLDER,
    latestVersion: d.latestVersion,
    releaseChannel: d.releaseChannel,
    availableVersions: d.availableVersions ?? [],
    lifecycleOp: d.lifecycleOp ?? null,
    canManageLifecycle: d.canManageLifecycle ?? false,
    // Flag an available upgrade only when both versions parse and latest > running.
    upgradeAvailable: isUpgradeAvailable(d.agentVersion, d.latestVersion),
    status: toStatusKey(d.status),
    host: d.host ?? PLACEHOLDER,
    // `load.{cpu,mem}` are 0..1 fractions; surface them as percentages.
    cpu: d.load ? Math.round(d.load.cpu * 100) : 0,
    mem: d.load ? Math.round(d.load.mem * 100) : 0,
    caps: d.capabilities,
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
    visibility: d.visibility,
    sharedWith: d.sharedWith,
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
  const q = new URLSearchParams({ limit: String(limit) })
  if (cursor) q.set('cursor', cursor)
  appendSessionFilters(q, filters)
  const page = await apiGet<SessionListPageDto>(`${orgBase(orgId)}/sessions?${q.toString()}`)
  return {
    sessions: page.sessions.map(sessionFromDto),
    total: page.total,
    nextCursor: page.nextCursor
  }
}

function appendSessionFilters(q: URLSearchParams, filters: SessionListFilters): void {
  if (filters.agentId) q.set('agentId', filters.agentId)
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
    integrations: facets.integrations,
    channels: facets.channels.map((channel) => ({
      value: channel.value,
      label: sessionChannelLabel(channel.platform, channel.value, channel.name, channel.triggeredByName),
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
 *  rows are already filtered by the caller's agent visibility on the server. */
export function fetchSessionDetail(sessionId: string, orgId?: string): Promise<SessionDetailDto> {
  return apiGet<SessionDetailDto>(`${orgBase(orgId)}/sessions/${encodeURIComponent(sessionId)}`)
}

// One page of a session's transcript, proxied live from the owning daemon. The
// `agentId` (carried by the list row) resolves that daemon on the CP; 503 if it
// is offline / the agent is unplaced.
export async function fetchSessionMessages(
  sessionId: string,
  agentId: string,
  cursor?: string,
  limit = 50
): Promise<SessionHistoryDto> {
  const q = new URLSearchParams({ agentId, limit: String(limit) })
  if (cursor) q.set('cursor', cursor)
  return apiGet<SessionHistoryDto>(`${orgBase()}/sessions/${encodeURIComponent(sessionId)}/messages?${q.toString()}`)
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
export async function fetchToolBody(sessionId: string, agentId: string, toolCallId: string): Promise<string> {
  let out = ''
  let offset = 0
  // Guard against a daemon that never advances `nextOffset` (defensive bound).
  for (;;) {
    const q = new URLSearchParams({ agentId, toolCallId, offset: String(offset) })
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
  size: number | null
  mtime: string | null
  encoding: 'utf8' | 'none' | null
  content: string | null
  offset: number | null
  nextOffset: number | null // byte offset to request next; do NOT recompute from content
  truncated: boolean | null
}

// One page of a workspace directory listing (GET /agents/:id/workspace/files),
// proxied live from the agent's owning daemon — the CP never stores workspace
// bytes (body-locality). 503 when that daemon is offline / the agent is unplaced.
export async function fetchWorkspaceFiles(
  agentId: string,
  opts: { path: string; cursor?: string; limit?: number }
): Promise<WorkspaceListingDto> {
  const q = new URLSearchParams({ path: opts.path })
  if (opts.cursor) q.set('cursor', opts.cursor)
  if (opts.limit) q.set('limit', String(opts.limit))
  return apiGet<WorkspaceListingDto>(
    `${orgBase()}/agents/${encodeURIComponent(agentId)}/workspace/files?${q.toString()}`
  )
}

// One slice of a workspace file (GET /agents/:id/workspace/file), proxied live
// from the owning daemon like the listing — file bytes never touch the CP store.
// 503 when the daemon is offline / the agent is unplaced.
export async function fetchWorkspaceFile(
  agentId: string,
  opts: { path: string; offset?: number; limit?: number }
): Promise<WorkspaceFileDto> {
  const q = new URLSearchParams({ path: opts.path })
  if (opts.offset) q.set('offset', String(opts.offset))
  if (opts.limit) q.set('limit', String(opts.limit))
  return apiGet<WorkspaceFileDto>(`${orgBase()}/agents/${encodeURIComponent(agentId)}/workspace/file?${q.toString()}`)
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
export async function listAgentMemory(agentId: string): Promise<MemoryFilesDto> {
  return apiGet<MemoryFilesDto>(`${orgBase()}/agents/${encodeURIComponent(agentId)}/memory/files`)
}

// Read one memory file (`path` defaults to the MEMORY.md index).
export async function fetchAgentMemory(
  agentId: string,
  opts: { path?: string; offset?: number; limit?: number } = {}
): Promise<AgentMemoryDto> {
  const q = new URLSearchParams()
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
  path?: string
): Promise<{ exists: boolean; content: string; mtime: string | null }> {
  let offset = 0
  let content = ''
  let exists = false
  let mtime: string | null = null
  // Bounded loop: nextOffset strictly advances while truncated, so this terminates.
  for (let guard = 0; guard < 4096; guard++) {
    const slice = await fetchAgentMemory(agentId, path ? { path, offset } : { offset })
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
  ifMatchMtime?: string | null
): Promise<{ path: string; size: number; mtime: string }> {
  const q = path ? `?path=${encodeURIComponent(path)}` : ''
  return apiPut<{ path: string; size: number; mtime: string }>(
    `${orgBase()}/agents/${encodeURIComponent(agentId)}/memory/file${q}`,
    ifMatchMtime ? { content, ifMatchMtime } : { content }
  )
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
export async function fetchWorkspaceGitStatus(agentId: string): Promise<WorkspaceGitStatusDto> {
  return apiGet<WorkspaceGitStatusDto>(`${orgBase()}/agents/${encodeURIComponent(agentId)}/workspace/gitstatus`)
}

// Force the owning daemon to `git pull` (fast-forward only) the agent's workspace
// now. A pull that can't fast-forward returns `ok:false`; 503 when daemon offline.
export async function workspaceGitPull(agentId: string): Promise<WorkspaceGitPullDto> {
  return apiPost<WorkspaceGitPullDto>(`${orgBase()}/agents/${encodeURIComponent(agentId)}/workspace/gitpull`, {})
}

// ── usage dashboard (GET /usage) — real historical aggregates from the CP's
// persisted per-session usage store, summed over the selected range. ──
export type UsageRange = 'd1' | 'd7' | 'd30' | 'd90'

export interface UsageAgentDto {
  agentId: string
  sessions: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  thoughtTokens: number
  cachedReadTokens: number
  cachedWriteTokens: number
  costAmount: number
}

export interface UsageDto {
  range: UsageRange
  totals: { sessions: number; totalTokens: number; costAmount: number; costCurrency: string | null }
  agents: UsageAgentDto[]
}

export async function fetchUsage(range: UsageRange, orgId?: string): Promise<UsageDto> {
  return apiGet<UsageDto>(`${orgBase(orgId)}/usage?range=${range}`)
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
  createdAt: string
  requesterId: string | null
  requesterName: string | null
  command: string
  status: 'pending' | 'allowed' | 'denied' | 'expired'
  resolvedAt: string | null
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
  const res = await fetch(`${cpBase()}${path}`, {
    method: 'PUT',
    headers: await authHeaders({ 'content-type': blob.type || 'application/octet-stream' }),
    body: blob
  })
  if (!res.ok) throw await apiErrorFromResponse('PUT', path, res)
  const d = (await res.json()) as IconResult
  return { icon: withIconUrl(d.icon, d.iconUrl), iconUrl: d.iconUrl }
}

async function deleteIcon(path: string): Promise<IconResult> {
  const res = await fetch(`${cpBase()}${path}`, { method: 'DELETE', headers: await authHeaders() })
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

// Cold-move an agent to another daemon. The CP coordinates an acknowledged
// source detach and destination activation; this is deliberately separate from
// the ordinary spec PATCH because placement changes have runtime side effects.
export async function moveAgent(agentId: string, daemonId: string): Promise<Agent> {
  const moved = agentFromDto(
    await apiPut<AgentDto>(`${orgBase()}/agents/${encodeURIComponent(agentId)}/daemon`, { daemonId })
  )
  track('agent_moved', { org_id: apiOrgId, agent_id: moved.id, to_daemon_id: daemonId })
  return moved
}

// Set an agent's visibility + share set (PUT /agents/:id/sharing). Separate from the
// content PATCH; gated server-side by canManageSharing (=== canEdit).
export async function updateAgentSharing(agentId: string, body: SharingInput): Promise<Agent> {
  return agentFromDto(await apiPut<AgentDto>(`${orgBase()}/agents/${encodeURIComponent(agentId)}/sharing`, body))
}

// Set both directions of agent-to-agent visibility/call authorization. Uses the
// same edit gate as agent sharing (`canManageSharing` in the DTO).
export async function updateAgentCallPolicy(agentId: string, body: AgentCallPolicyInput): Promise<Agent> {
  return agentFromDto(await apiPut<AgentDto>(`${orgBase()}/agents/${encodeURIComponent(agentId)}/call-policy`, body))
}

export async function fetchDaemons(orgId?: string): Promise<DaemonRow[]> {
  return (await apiGet<DaemonViewDto[]>(`${orgBase(orgId)}/daemons`)).map(daemonFromDto)
}

// Assign a human-friendly display name to a connected daemon.
export async function renameDaemon(daemonId: string, name: string): Promise<DaemonRow> {
  return daemonFromDto(await apiPatch<DaemonViewDto>(`${orgBase()}/daemons/${encodeURIComponent(daemonId)}`, { name }))
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

// Uninstall an integration (`DELETE /integrations/:id`): drops the CP record and
// tells the owning daemon to close the connection. The BOT survives (freed) — it
// shows up in the Add-integration picker for reuse.
export async function deleteIntegration(id: string): Promise<void> {
  await apiDelete<void>(`${orgBase()}/integrations/${encodeURIComponent(id)}`)
}

// ── Hooks (inbound webhook triggers — webhook-triggers-and-github-events.md) ──

// A hook definition row. `url` is the full public ingress URL (relay-pool based),
// a capability URL the CP surfaces only to callers with edit rights.
export type GithubCommentFamily = 'issues' | 'pull_request'
export type HookReviewPolicy = 'off' | 'comment' | 'request_changes' | 'full'
// R2a intentionally exposes informational Checks only. `status` is R3.
export type HookReportingMode = 'off' | 'check'
// `required` remains server-rejected until the R2b acceptance gates pass.
export type HookGateMode = 'informational'

export interface HookDto {
  id: string
  agentId: string | null // null ⇒ orphaned by agent delete (inert)
  kind: 'webhook' | 'github'
  name: string
  sessionMode: 'perDelivery' | 'perThread' | 'shared'
  enabled: boolean
  url: string | null
  hmacConfigured: boolean
  // ── github kind ── repo + subscription (empty/null on webhook kind)
  repoId?: string | null
  repoFullName: string | null // canonical owner/repo as GitHub cases it
  events: string[] // 'issues:*' / 'issue_comment:created' / …
  commentFamilies: GithubCommentFamily[] // thread kinds whose replies may fire this hook
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
}

// github kind: the repo must sit inside one of the org's GitHub App
// installations — the CP resolves it to the numeric match key server-side.
export interface CreateGithubHookInput {
  agentId: string
  name: string
  enabled?: boolean
  repoFullName: string
  events: string[] // 'issues:*' etc — at least one
  commentFamilies?: GithubCommentFamily[]
  labelFilter?: string[]
  mentionOnly?: boolean // require authored event text to @-mention the agent or App
  reviewPolicy?: HookReviewPolicy
  reportingMode?: HookReportingMode
  // R1/R2a callers can only send the informational literal.
  gateMode?: HookGateMode
}

// A hook is subordinate to its agent (like an Integration), so there is no
// org-wide hook list — you fetch ONE agent's hooks, gated server-side by that
// agent's visibility (404 for an agent you can't see).
export async function fetchAgentHooks(agentId: string, orgId?: string): Promise<HookDto[]> {
  return apiGet<HookDto[]>(`${orgBase(orgId)}/agents/${encodeURIComponent(agentId)}/hooks`)
}

// Always mints a signing secret (`hmac: true`) — the create modal reveals it once.
export async function createHook(input: CreateHookInput): Promise<CreatedHookDto> {
  const hook = await apiPost<CreatedHookDto>(`${orgBase()}/hooks`, { kind: 'webhook', hmac: true, ...input })
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
export async function updateGithubHook(id: string, input: CreateGithubHookInput): Promise<HookDto> {
  return apiPut<HookDto>(`${orgBase()}/hooks/${encodeURIComponent(id)}`, { kind: 'github', ...input })
}

export async function deleteHook(id: string): Promise<void> {
  await apiDelete<void>(`${orgBase()}/hooks/${encodeURIComponent(id)}`)
  track('hook_deleted', { org_id: apiOrgId, hook_id: id })
}

export async function fetchHookRuns(id: string, orgId?: string): Promise<HookRunDto[]> {
  return apiGet<HookRunDto[]>(`${orgBase(orgId)}/hooks/${encodeURIComponent(id)}/runs`)
}

// Per-channel trigger choice (`PATCH /integrations/:id/channels/:channelId`). The CP
// persists it and pushes the integration's recomputed bind rules to the owning daemon.
export async function updateIntegrationChannel(
  integrationId: string,
  channelId: string,
  patch: { trigger?: ChannelTrigger; agentId?: string | null }
): Promise<IntegrationChannelDto> {
  return apiPatch<IntegrationChannelDto>(
    `${orgBase()}/integrations/${encodeURIComponent(integrationId)}/channels/${encodeURIComponent(channelId)}`,
    patch
  )
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

// Remove a member (DELETE /members/:id, owner-only). Removing the last owner is
// refused (409). Removal sticks — sign-in does not re-add them.
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

async function putMyProfilePicture(blob: Blob): Promise<MeDto> {
  const path = '/me/picture'
  const res = await fetch(`${cpBase()}${path}`, {
    method: 'PUT',
    headers: await authHeaders({ 'content-type': blob.type || 'application/octet-stream' }),
    body: blob
  })
  if (!res.ok) throw await apiErrorFromResponse('PUT', path, res)
  return (await res.json()) as MeDto
}

export function uploadMyProfilePicture(blob: Blob): Promise<MeDto> {
  return putMyProfilePicture(blob)
}

export async function deleteMyProfilePicture(): Promise<MeDto> {
  return apiDelete<MeDto>('/me/picture')
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
 *  Root-scoped: the caller may not belong to any org yet. */
export function redeemWaitlistLink(token: string): Promise<{ activated: true }> {
  return apiPost<{ activated: true }>('/waitlist/redeem', { token })
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

// Create an org (POST /orgs); the caller becomes its first owner. The display
// name is optional — omit it to fall back to the slug.
export async function createOrg(input: { name?: string; slug: string }): Promise<OrgDto> {
  const org = await apiPost<OrgDto>('/orgs', input)
  track('organization_created', { org_id: org.id, org_slug: org.slug })
  return org
}

// Rename / re-slug an org (PATCH /orgs/:id, owner of that org only).
export async function updateOrg(
  orgId: string,
  patch: { name?: string; slug?: string; icon?: AgentIcon | null }
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
  visibility: ResourceVisibility // 'org' = everyone; 'restricted' = creator + owners + sharedWith
  sharedWith: string[] // app_user.id set (only meaningful when restricted)
  createdBy: string | null // creator userId (pins the non-removable share chip)
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
// from the content PATCH; gated server-side by canManageSharing (=== canEdit).
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

/** Reconcile claims against GitHub — the fallback for a lost setup callback /
 *  pending admin approval. Returns the refreshed list. */
export async function syncGithubInstallations(): Promise<GithubInstallationDto[]> {
  return apiPost<GithubInstallationDto[]>(`${orgBase()}/github/installations/sync`, {})
}

/** Remove the GitHub App from one account and revoke this installation's
 *  repository access. Owner-only; the CP also retires the local installation. */
export async function uninstallGithubInstallation(id: string): Promise<void> {
  await apiDelete<void>(`${orgBase()}/github/installations/${encodeURIComponent(id)}`)
}

const GITHUB_REPO_PAGE_SIZE = 100
const GITHUB_REPO_REQUEST_CONCURRENCY = 4
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
 *  on this listing, so picker callers should normally use fetchAllGithubRepos. */
export async function fetchGithubRepos(
  installationId: string,
  page = 1,
  signal?: AbortSignal
): Promise<{ repos: GithubRepoDto[]; totalCount: number }> {
  // Not apiGet: a per-user-gate denial (403) carries a machine `code` in the
  // body that the picker branches on (GITHUB_IDENTITY_REQUIRED ⇒ "sign in with
  // GitHub" note instead of a silently empty list).
  const path = `${orgBase()}/github/installations/${encodeURIComponent(installationId)}/repositories?page=${page}&perPage=${GITHUB_REPO_PAGE_SIZE}`
  return withGithubRepoRequestLimit(async () => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${cpBase()}${path}`, { headers: await authHeaders(), cache: 'no-store', signal })
      if (res.ok) return (await res.json()) as { repos: GithubRepoDto[]; totalCount: number }
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

/** Load the complete App-visible repository roster for client-side searching.
 *  GitHub exposes only pagination here, so fetch the remaining pages after the
 *  first response reveals the installation's total repository count. */
export async function fetchAllGithubRepos(installationId: string, signal?: AbortSignal): Promise<GithubRepoDto[]> {
  const first = await fetchGithubRepos(installationId, 1, signal)
  const pageCount = Math.ceil(first.totalCount / GITHUB_REPO_PAGE_SIZE)
  const pages = [
    first,
    ...(await Promise.all(
      Array.from({ length: Math.max(0, pageCount - 1) }, (_, index) =>
        fetchGithubRepos(installationId, index + 2, signal)
      )
    ))
  ]

  // The roster can change between page requests. Keep the first occurrence so
  // callers never render duplicate rows if page boundaries shift mid-fetch.
  const unique = new Map<string, GithubRepoDto>()
  for (const repo of pages.flatMap((page) => page.repos)) {
    const key = repo.fullName.toLowerCase()
    if (!unique.has(key)) unique.set(key, repo)
  }
  return [...unique.values()]
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
    const res = await fetch(`${cpBase()}${path}`, {
      headers: await authHeaders(),
      cache: 'no-store',
      signal
    })
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
  denied?: string
  message?: string
}

export async function fetchGithubRepoAccess(
  installationId: string,
  owner: string,
  repo: string
): Promise<GithubRepoAccess> {
  const path = `${orgBase()}/github/installations/${encodeURIComponent(installationId)}/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/access`
  const res = await fetch(`${cpBase()}${path}`, { headers: await authHeaders(), cache: 'no-store' })
  if (res.status === 404) return { gated: false, canRead: true, canWrite: true }
  if (res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string }
    return {
      gated: true,
      canRead: false,
      canWrite: false,
      denied: body.code ?? 'USER_NO_ACCESS',
      ...(body.message ? { message: body.message } : {})
    }
  }
  if (!res.ok) throw new ApiError(`GET ${path} → ${res.status} ${res.statusText}`, res.status)
  const body = (await res.json()) as { canRead: boolean; canWrite: boolean }
  return { gated: true, canRead: body.canRead, canWrite: body.canWrite }
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
  repoId?: string // rename-proof GitHub numeric id (absent on an older CP)
  repoFullName: string // owner/repo as GitHub cases it (refreshed on rename)
  access: RepoAccess
  createdBy: string | null // authorizer's userId (resolved to a name / "You" in the UI); null for key-created
  createdAt: string // ISO-8601
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
  input: { repoFullName: string; access: RepoAccess }
): Promise<AgentRepoAuthDto> {
  const path = `${orgBase()}/agents/${encodeURIComponent(agentId)}/repos`
  const res = await fetch(`${cpBase()}${path}`, {
    method: 'POST',
    headers: await authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(input)
  })
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
  const res = await fetch(`${cpBase()}${path}`, {
    method: 'PATCH',
    headers: await authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(input)
  })
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
