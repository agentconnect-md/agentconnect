/**
 * Repository ports — the Red-Green seam (design §3.14 / §2.3).
 *
 * Services (C3/C4/C5) and edges depend on these INTERFACES, never on
 * `PrismaClient`. Methods are shaped around the frame handlers so tests drive
 * them with protocol payloads. The only implementors are
 * `persistence/repositories/*.repo.ts`.
 *
 * Record types are lightweight, domain-facing shapes (NOT raw Prisma models) so
 * nothing above this layer imports `@prisma/client`.
 */
import type {
  AuthReq,
  RegisterReq,
  Heartbeat,
  FactsRuntimeProfile,
  FactsMcpServer,
  RuntimeModelCatalog,
  SecretsRequest,
  CronUpsert,
  Platform,
  FeishuRegion,
  BindRule,
  AgentIcon,
  AgentMemoryBinding
} from '@agentconnect.md/protocol'
import type {
  DaemonId,
  AgentId,
  LaunchId,
  LeaseId,
  CronId,
  HookId,
  IntegrationId,
  BotId,
  SessionId,
  OrgId
} from '../domain/ids.js'
import type { SessionKey } from '../domain/sessionKey.js'

// ───────────────────────────────────────────────────────────────────────────
// Shared enums (string unions mirroring the Prisma enums; kept transport-free)
// ───────────────────────────────────────────────────────────────────────────

export type DaemonStatus = 'provisioned' | 'authenticating' | 'ready' | 'draining' | 'unreachable' | 'disabled'
export type HealthState = 'ok' | 'degraded'
/** Per-resource visibility (docs/designs/resource-visibility.md). Mirrors the
 *  Prisma `ResourceVisibility` enum. */
export type ResourceVisibility = 'org' | 'restricted'
/** Which peers may call a target agent as a sub-agent. */
export type AgentCallPolicy = 'all' | 'selected'

/** Cross-process critical section for one Logto user's social-identity mutations. */
export interface SocialIdentityMutationGate {
  runExclusive<T>(oidcSubject: string, mutation: () => Promise<T>): Promise<T>
}

/** The caller identity the OSS authorization policy needs: their id + org role.
 *  Built from `req.orgCtx` by `http/rbac.ts#ctxOf`. */
export interface ViewCtx {
  userId: string
  role: OrgMemberRole
}

/** The visibility-bearing fields every shareable resource carries.
 *  Ownership is independent from immutable creation attribution and may move
 *  when a member leaves the organization. */
export interface Shareable {
  ownerUserId: string | null
  visibility: ResourceVisibility
  sharedWith: string[]
}
export type AssignmentState = 'active' | 'draining' | 'released' | 'frozen'
export type SessionPhase = 'start' | 'plan' | 'problem' | 'end'
export type ActivityState = 'thinking' | 'tool_call' | 'awaiting_permission' | 'idle'
/** Per-session visibility tier (session-visibility.md §1). Distinct from
 *  `ResourceVisibility` — sessions have no `restricted`/`sharedWith` tier. */
export type SessionVisibility = 'private' | 'org'
/** How a session's visibility was determined — the §4.5 A2A reconciliation
 *  state marker; `explicit` pins the row against settlement (not cascades). */
export type VisibilitySource = 'default' | 'inherited_pending' | 'inherited' | 'explicit'
/** Daemon-reported conversation shape (session-visibility.md §4.1) — the
 *  ingest classification input. NOT the Slack-flavored `ConversationKind`
 *  ('channel'|'im'|'mpim') used by integration-channel rows. */
export type SessionConversationKind = 'dm' | 'group_dm' | 'channel'
export type LaunchMode = 'long_lived' | 'per_turn'
export type LaunchStatus = 'launching' | 'running' | 'stopped' | 'crashed'
export type LeaseStatus = 'active' | 'expired' | 'revoked'
export type AcpSupport = 'full' | 'partial' | 'none'
export type AuditKind =
  | 'daemon_auth'
  | 'daemon_register'
  | 'daemon_unreachable'
  | 'route_assign'
  | 'route_release'
  | 'drain'
  | 'agent_launch'
  | 'agent_stop'
  | 'scope_denied'
  | 'secret_grant'
  | 'secret_revoke'
  | 'cron_change'
  | 'hook_change'
  | 'agent_repo_change'
  | 'org_invite_change'
  | 'protocol_error'
  | 'api_key_create'
  | 'api_key_rotate'
  | 'api_key_revoke'
  | 'mcp_tool_call'

// ───────────────────────────────────────────────────────────────────────────
// DaemonRepo (C4) — fleet registry & fencing root (§3.3)
// ───────────────────────────────────────────────────────────────────────────

/** What `auth` carries that the persistence layer needs (§3.3). `orgId` anchors a fresh row. */
export interface AuthReqInput {
  daemonId: DaemonId
  orgId: OrgId
  agentVersion: AuthReq['agentVersion']
  machineId?: string
  tokenFp?: string
}

/** What `register` carries (§3.3). */
export interface RegisterReqInput {
  host: RegisterReq['host']
  capabilities: RegisterReq['capabilities']
  maxAgents: RegisterReq['maxAgents']
}

export interface DaemonRecord {
  id: DaemonId
  orgId: OrgId
  host: string | null
  /** Human-assigned display name (console-set); null until a user names it. */
  name: string | null
  agentVersion: string | null
  capabilities: unknown
  /** Stored `facts/daemon-runtimes.mcpServers` snapshot (FactsMcpServer[] as JSON; `[]` until reported). */
  mcpServers: unknown
  maxAgents: number
  sessionEpoch: bigint
  routingEpoch: bigint
  status: DaemonStatus
  health: HealthState
  /** Last reported `Heartbeat.load` {cpu,mem,agents}; null before the first beat. */
  load: unknown
  activeSessions: number
  degradedScopes: string[]
  lastSeenAt: Date | null
  unreachableAt: Date | null
  createdAt: Date
  createdBy: AgentCreator | null // null for CLI/self-registered daemons (no WebUI principal)
  /** Raw immutable creator FK scalar, independent of joined `createdBy`. */
  createdByUserId: string | null
  /** Current resource owner used by restricted visibility. */
  ownerUserId: string | null
  visibility: ResourceVisibility
  sharedWith: string[] // app_user.id set; meaningful only when visibility='restricted'
  lastModifiedAt: Date // last human edit (provision/rename); defaults to createdAt
  lastModifiedBy: AgentCreator | null // WebUI user who last edited it; null ⇒ never edited by a human
}

export interface DaemonRepo {
  /**
   * Insert a fresh daemon row in `provisioned` status at `sessionEpoch = 0` (schema
   * default) — the FK anchor an `ApiKey` points at, created at onboarding (§4.1). First
   * `auth` then takes `upsertOnAuth`'s increment branch → epoch 1, identical to before.
   * `createdByUserId` stamps the WebUI principal who provisioned it (console "Created" row).
   */
  provision(daemonId: DaemonId, orgId: OrgId, createdByUserId?: string): Promise<DaemonRecord>
  /**
   * Idempotent on `daemonId`. Bumps `sessionEpoch` (the fencing root) in ONE
   * transaction and sets status `authenticating`. Returns the new strictly-
   * increasing epoch. First call for a daemon creates the row.
   */
  upsertOnAuth(input: AuthReqInput): Promise<{ daemon: DaemonRecord; sessionEpoch: bigint }>
  applyRegister(daemonId: DaemonId, reg: RegisterReqInput): Promise<DaemonRecord>
  /** Replace the daemon-level MCP-server list (`facts/daemon-runtimes.mcpServers`) wholesale. */
  setMcpServers(daemonId: DaemonId, servers: FactsMcpServer[]): Promise<void>
  touchHeartbeat(daemonId: DaemonId, hb: Heartbeat, at: Date): Promise<void>
  markUnreachable(daemonId: DaemonId, at: Date): Promise<void>
  /** Set the console-assigned display name (a human edit — stamps last-modified
   *  audit). `byUserId` is the editing WebUI principal (absent under devAuth).
   *  Throws if the daemon row is absent. */
  rename(daemonId: DaemonId, name: string, byUserId?: string): Promise<DaemonRecord>
  /** Set the visibility + share set (the dedicated `/sharing` write path). Stamps
   *  the last-modified audit; `byUserId` is the editing WebUI principal (absent
   *  under devAuth). Throws if the daemon row is absent. */
  setSharing(
    daemonId: DaemonId,
    sharing: { visibility: ResourceVisibility; sharedWith: string[] },
    byUserId?: string
  ): Promise<DaemonRecord>
  /**
   * Hard-delete a daemon (DELETE /daemons/:id). FK referential actions cascade its
   * api-keys / leases / launches / runtime-profiles and null out agents/assignments
   * (those become unplaced). Throws Prisma P2025 if the row is absent (→ 404).
   */
  delete(daemonId: DaemonId): Promise<void>
  /** Bump THIS daemon's `routingEpoch` atomically; returns the new value (§4.11). */
  bumpRoutingEpoch(daemonId: DaemonId): Promise<bigint>
  /** Daemons unreachable for longer than `graceSec` — reassignment candidates (§4.9). */
  findReassignable(graceSec: number, now: Date): Promise<DaemonRecord[]>
  get(daemonId: DaemonId): Promise<DaemonRecord | null>
  /** The fleet, optionally filtered to one org (console reads pass the org). Every
   *  supplied human principal is resource-filtered; undefined is reserved for
   *  unfiltered internal reads (authorization/policy.ts#visibilityWhere). */
  list(orgId?: OrgId, viewer?: ViewCtx): Promise<DaemonRecord[]>
}

// ───────────────────────────────────────────────────────────────────────────
// DaemonLifecycleOpRepo — CP-commanded restart/upgrade tracking (cli-daemon-split.md §7)
// ───────────────────────────────────────────────────────────────────────────

export type DaemonLifecycleOpType = 'restart' | 'upgrade'
export type DaemonLifecycleOpStatus = 'pending' | 'succeeded' | 'failed'

export interface OpenLifecycleOpInput {
  daemonId: DaemonId
  op: DaemonLifecycleOpType
  /** The version the daemon must reach for an upgrade to close `succeeded`; omit for restart. */
  targetVersion?: string
  /** app_user.id that commanded it (audit); absent under devAuth / system. */
  initiator?: string
  /** The daemon `sessionEpoch` at command-send time. The op settles only on a READY at a
   *  STRICTLY GREATER epoch (a re-auth after drain+relaunch), never a same-epoch reconnect. */
  commandEpoch: bigint
  /** When a still-`pending` op is considered failed (drain + relaunch budget). */
  deadline: Date
}

export interface DaemonLifecycleOpRecord {
  id: string
  daemonId: DaemonId
  op: DaemonLifecycleOpType
  targetVersion: string | null
  initiator: string | null
  status: DaemonLifecycleOpStatus
  commandEpoch: bigint
  /** Set once the daemon ACKs `accepted:true` — the op is "armed". A READY before this
   *  must not settle it (the command hadn't been accepted/executed yet). */
  acceptedAt: Date | null
  startedAt: Date
  deadline: Date
  outcome: string | null
  settledAt: Date | null
}

export interface DaemonLifecycleOpRepo {
  /** Open a `pending` op. Throws Prisma P2002 (the partial unique index) when the
   *  daemon already has one in flight — the route maps that to 409. */
  open(input: OpenLifecycleOpInput): Promise<DaemonLifecycleOpRecord>
  /** Arm an op once the daemon ACKed `accepted:true`: set `acceptedAt` AND overwrite
   *  `commandEpoch` with the epoch the command was ACTUALLY sent on (the live connection's
   *  epoch at send time, from the ControlSender), replacing the pre-send estimate. Only an
   *  armed op may settle on a subsequent READY. No-op if the row is no longer pending. */
  markAccepted(id: string, at: Date, commandEpoch: bigint): Promise<void>
  /** Fetch one op by id — the console's poll-by-id endpoint (survives a newer op becoming
   *  the daemon's latest). Null when absent. */
  getById(id: string): Promise<DaemonLifecycleOpRecord | null>
  /** The single pending op for a daemon, or null. */
  pendingForDaemon(daemonId: DaemonId): Promise<DaemonLifecycleOpRecord | null>
  /** The most recent op for a daemon (ANY status), or null — the fleet DTO reads this so
   *  a terminal (succeeded/failed) op is still observable by the console after it settles. */
  latestForDaemon(daemonId: DaemonId): Promise<DaemonLifecycleOpRecord | null>
  /** The most recent op per daemon across a set (ANY status) — the batched fleet read (no N+1). */
  latestForDaemons(daemonIds: DaemonId[]): Promise<DaemonLifecycleOpRecord[]>
  /** Fail every `pending` op past its `deadline` (optionally scoped to one daemon) — the
   *  clock-driven expiry that unblocks a daemon whose command was accepted but which never
   *  re-registered. Returns the number expired. */
  expireOverdue(now: Date, daemonId?: DaemonId): Promise<number>
  /** Close an op to a terminal status with an optional detail. Transitions ONLY a row
   *  still `pending` (so a late register can't reopen one a decline already failed).
   *  Returns whether a row was transitioned. */
  settle(id: string, status: 'succeeded' | 'failed', outcome: string | null, at: Date): Promise<boolean>
}

// ───────────────────────────────────────────────────────────────────────────
// ApiKeyRepo (C4) — long-lived, revocable daemon/user credential (§3.3a)
// ───────────────────────────────────────────────────────────────────────────

export type PrincipalType = 'daemon' | 'user' | 'relay' | 'oauth'

export interface CreateApiKeyInput {
  principalType: PrincipalType
  /** Org for daemon/user/oauth keys; null for relay keys (deployment-level infra, not tenant-scoped). */
  orgId: OrgId | null
  daemonId?: DaemonId
  userId?: string
  /** `HMAC-SHA256(secret, pepper)` hex — the unique lookup key. Plaintext is never stored. */
  hash: string
  displayTail: string
  name?: string
  scopes?: string[]
  createdByUserId?: string
  /** Set iff principalType='oauth' — links the access token to its OAuthGrant. */
  oauthGrantId?: string
  /** null = non-expiring (daemon default); a Date for user/oauth keys. */
  expiresAt?: Date | null
}

/** Domain view of an `api_key` row. NEVER carries the hash or any secret material. */
export interface ApiKeyRecord {
  id: string
  principalType: PrincipalType
  orgId: OrgId | null // null iff principalType='relay'
  daemonId: DaemonId | null
  userId: string | null
  displayTail: string
  name: string | null
  scopes: string[]
  oauthGrantId: string | null // set iff principalType='oauth'
  createdAt: Date
  lastUsedAt: Date | null
  expiresAt: Date | null
  revokedAt: Date | null
}

/** A personal (`principalType='user'`) key joined with its org's display fields —
 *  the profile "API keys" list, where one row can belong to any of the user's orgs. */
export interface UserApiKeyRecord extends ApiKeyRecord {
  orgId: OrgId // user keys are always org-scoped — narrowed from the nullable base
  orgSlug: string
  orgName: string | null
}

export interface ApiKeyRepo {
  create(input: CreateApiKeyInput): Promise<ApiKeyRecord>
  /** Indexed point-lookup by the unique peppered hash — the credential verification site. */
  findByHash(hash: string): Promise<ApiKeyRecord | null>
  /** Throttled liveness write on successful auth. */
  touchLastUsed(id: string, at: Date): Promise<void>
  /** Kill switch: set `revokedAt` (+ reason). Checked on every auth. */
  revoke(id: string, reason: string, at: Date): Promise<ApiKeyRecord>
  /** Revoke every live oauth access token minted under a grant — the "disconnect"
   *  cascade so a Profile revoke kills outstanding tokens now, not in ≤1h. Returns count. */
  revokeByOAuthGrant(grantId: string, reason: string, at: Date): Promise<number>
  /** All keys (including revoked) for a daemon — the console key list. */
  listForDaemon(daemonId: DaemonId): Promise<ApiKeyRecord[]>
  /** A user's personal keys (all their orgs, active-only by default), joined with each
   *  key's org label — the profile "API keys" list, newest first. */
  listForUser(userId: string, opts?: { includeRevoked?: boolean }): Promise<UserApiKeyRecord[]>
}

// ───────────────────────────────────────────────────────────────────────────
// OAuthRepo — the embedded OAuth 2.1 AS's protocol state (agent-assistant.md §7)
// ───────────────────────────────────────────────────────────────────────────

export interface OAuthClientRecord {
  clientId: string
  clientName: string | null
  redirectUris: string[]
  grantTypes: string[]
  createdAt: Date
  expiresAt: Date
}

export interface CreateOAuthClientInput {
  clientId: string
  clientName?: string
  redirectUris: string[]
  grantTypes: string[]
  expiresAt: Date
}

export interface CreateOAuthCodeInput {
  codeHash: string
  clientId: string
  redirectUri: string
  userId: string
  orgId: OrgId
  scopes: string[]
  codeChallenge: string
  codeChallengeMethod: string
  resource?: string | null
  expiresAt: Date
}

export interface OAuthCodeRecord {
  codeHash: string
  clientId: string
  redirectUri: string
  userId: string
  orgId: string
  scopes: string[]
  codeChallenge: string
  codeChallengeMethod: string
  resource: string | null
  expiresAt: Date
  consumedAt: Date | null
}

export interface CreateOAuthGrantInput {
  userId: string
  orgId: OrgId
  clientId: string
  scopes: string[]
  resource?: string | null
  rtHash: string
  rtExpiresAt: Date
}

export interface OAuthGrantRecord {
  id: string
  userId: string
  orgId: string
  clientId: string
  scopes: string[]
  resource: string | null
  rtHash: string | null
  prevRtHash: string | null
  rtExpiresAt: Date | null
  createdAt: Date
  lastUsedAt: Date | null
  revokedAt: Date | null
}

export interface OAuthRepo {
  createClient(input: CreateOAuthClientInput): Promise<OAuthClientRecord>
  getClient(clientId: string): Promise<OAuthClientRecord | null>
  createCode(input: CreateOAuthCodeInput): Promise<void>
  /** Non-consuming read of a code by hash — the AS reads the PKCE challenge before
   *  the exchange consumes it (SDK `challengeForAuthorizationCode`). */
  getCode(codeHash: string): Promise<OAuthCodeRecord | null>
  /** Atomically consume an unexpired, unconsumed code — returns the row ONLY to the
   *  single caller that won the single-use race (else null). */
  consumeCode(codeHash: string, now: Date): Promise<OAuthCodeRecord | null>
  createGrant(input: CreateOAuthGrantInput): Promise<OAuthGrantRecord>
  /** Match a live grant by its current OR previous refresh-token hash (two-generation window). */
  findGrantByRefreshHash(rtHash: string): Promise<OAuthGrantRecord | null>
  /** CAS rotate: advance the refresh token only if the grant's current hash still equals
   *  `expectedCurrentRtHash` and it isn't revoked. Returns the updated row, or null on miss. */
  rotateGrant(
    id: string,
    expectedCurrentRtHash: string | null,
    next: { rtHash: string; prevRtHash: string | null; rtExpiresAt: Date; lastUsedAt: Date }
  ): Promise<OAuthGrantRecord | null>
  getGrant(id: string): Promise<OAuthGrantRecord | null>
  /** A user's active (non-revoked) grants — the Profile "Connected AI tools" list. */
  listGrantsForUser(userId: string): Promise<OAuthGrantRecord[]>
  /** Revoke a grant (idempotent) — returns the row, or null if it isn't the user's / doesn't exist. */
  revokeGrant(id: string, at: Date): Promise<OAuthGrantRecord | null>
}

// ───────────────────────────────────────────────────────────────────────────
// RelayRepo (shared-bot-relay.md §6) — the DB-less relay's durable identity
//   A `relay` row is upserted by its unique `name` on `rc/register` (the
//   stateless relay reclaims the same row + relayId after a restart), bumped by
//   `rc/heartbeat`, and swept when its heartbeat lapses. No org, no FKs, no
//   secret material — deployment infra serving every tenant.
// ───────────────────────────────────────────────────────────────────────────

/** Domain view of a `relay` row. */
export interface RelayRecord {
  id: string
  name: string
  /** Per-instance-routable address daemons dial (never a pool LB — design §5). */
  daemonUrl: string
  lastSeenAt: Date | null
  createdAt: Date
}

export interface RelayRepo {
  /** Upsert by the unique `name` (the relay's stable identity): create with a fresh
   *  id or reclaim the existing row, refreshing `daemonUrl` + `lastSeenAt` to `at`.
   *  Atomic on the unique name so a restart racing the sweeper can't duplicate a pod. */
  upsertByName(name: string, daemonUrl: string, at: Date): Promise<RelayRecord>
  /** Bump `lastSeenAt` on `rc/heartbeat` (liveness for the failover sweeper). Returns
   *  false when the row is gone (already swept) — the caller forces a re-register so a
   *  relay swept during a stall doesn't linger connected-but-absent from the roster. */
  touchLastSeen(id: string, at: Date): Promise<boolean>
  /** Relays seen at/after `since` — the roster source (`register/ok.relays` + `relay/roster`). */
  listAlive(since: Date): Promise<RelayRecord[]>
  /** Delete relays not seen since `staleBefore` (or never seen and older than it) — the
   *  failover sweeper. Returns the number swept. */
  sweepStale(staleBefore: Date): Promise<number>
}

// ───────────────────────────────────────────────────────────────────────────
// AgentRepo (C6/C4) — agent definition + inline workspace (§3.6, §3.5)
// ───────────────────────────────────────────────────────────────────────────

/** Where the agent runs (inline on the agent; path is daemon-generated). */
export type AgentWorkspace =
  | { mode: 'scratch' }
  | {
      mode: 'github'
      gitRepo: string
      gitBranch?: string
      agentDir?: string
      /** github-app credential mode: the GithubInstallation row id picked at create.
       *  A PROVENANCE HINT only — minting re-resolves the live installation by repo
       *  owner, so uninstall→reinstall self-heals. Absent ⇒ anonymous git. */
      installationId?: string
      /** Ceiling for minted tokens (contents read|write); absent ⇒ 'write'. */
      gitAccess?: 'read' | 'write'
    }
export type GithubAgentWorkspace = Extract<AgentWorkspace, { mode: 'github' }>

export interface CreateAgentInput {
  id: AgentId
  orgId: OrgId
  name: string // slug (unique per org)
  displayName?: string // human-readable original
  description?: string
  /** Absent ⇒ deferred exec config (preset-agents.md §3.2): the agent is created
   *  unplaced with no runtime; choosing one happens at placement. The public
   *  create route still requires a runtime — only preset provisioning defers. */
  runtime?: string
  model?: string
  reasoningEffort?: string
  outputMode?: string // platform output verbosity: low | medium | high
  showFooter?: boolean // render platform attribution/session footers (default true)
  fastMode?: boolean // runtime fast mode toggle
  permissionMode?: string // runtime permission/approval mode
  allowRuntimeChangesInChat?: boolean // explicit opt-in; default false
  pause?: boolean // operational message-processing toggle (#288); true ⇒ daemon skips all turns
  introduceOnJoin?: boolean // #536: self-introduce to peers on a genuine channel join (absent ⇒ DB default false)
  restrictFileAccess?: boolean // #642: request an OS sandbox (absent ⇒ DB default false)
  env?: Record<string, string> // extra env injected into the runtime (AgentSpec.env)
  // NOTE: write-only secret env vars are NOT part of the agent row — they live behind
  // the AgentSecretStore seam (routes write them there after create).
  mcpServers?: string[] // daemon-configured MCP server names to attach at session/new (AgentSpec.mcpServers)
  skills?: string[] // enabled skills, "<sourceName>/<skillName>" or "<sourceName>/*" (shared-skills.md)
  memory?: AgentMemoryBinding // memory backend
  icon?: AgentIcon // console avatar; absent ⇒ the repo assigns a random glyph+color combo
  daemonId?: DaemonId // the owning machine, if chosen at create time
  workspace?: AgentWorkspace // absent ⇒ scratch
  /** Rename-proof numeric identity of the github workspace repository. This is
   *  control-plane metadata only and never rides AgentWorkspace on the wire. */
  workspaceRepoId?: bigint
  capabilities?: string[]
  createdByUserId?: string // WebUI principal who created it (audit); null ⇒ daemon/CLI-created
  /** Initial resource owner; defaults to `createdByUserId` when omitted. */
  ownerUserId?: string
  /** Initial visibility (absent ⇒ DB default 'org', visible to all org members). */
  visibility?: ResourceVisibility
  /** Initial share set (app_user.id); only meaningful with visibility='restricted'. */
  sharedWith?: string[]
  /** Initial agent-call policy (absent ⇒ DB default 'all', any org peer may call it). */
  callPolicy?: AgentCallPolicy
  /** Initial caller allow-list (agent.id set); only meaningful with callPolicy='selected'. */
  allowedCallerAgentIds?: string[]
  /** Initial outbound policy (absent ⇒ DB default 'all', it may call any org peer). */
  outboundPolicy?: AgentCallPolicy
  /** Initial target allow-list (agent.id set); only meaningful with outboundPolicy='selected'. */
  allowedTargetAgentIds?: string[]
}

export interface UpdateAgentInput {
  // NOTE: `name` (the slug) is intentionally NOT here — it is immutable after create.
  displayName?: string | null
  icon?: AgentIcon | null // console avatar; null clears back to the runtime-mark default
  description?: string | null
  runtime?: string
  capabilities?: string[]
  model?: string | null
  reasoningEffort?: string | null
  outputMode?: string | null
  showFooter?: boolean
  fastMode?: boolean | null
  permissionMode?: string | null
  allowRuntimeChangesInChat?: boolean
  pause?: boolean | null // operational message-processing toggle (#288); null clears
  introduceOnJoin?: boolean // #536: self-introduce to peers on a genuine channel join
  restrictFileAccess?: boolean // #642: request an OS sandbox for this agent
  /** Widen an existing App-backed GitHub workspace from read to write. */
  gitAccess?: 'write'
  /** GitHub workspace-relative ACP cwd; null restores repository root. */
  agentDir?: string | null
  env?: Record<string, string> | null // replaced wholesale when provided; null clears
  // NOTE: write-only secrets are NOT a repo patch field — the PATCH route merges
  // them through the AgentSecretStore seam (key-by-key; see AgentSecretStore.merge).
  mcpServers?: string[] | null // replaced wholesale when provided; null clears
  skills?: string[] | null // enabled skills; replaced wholesale when provided; null clears
  memory?: AgentMemoryBinding | null // memory backend
  // Workspace repository identity is not a generic PATCH field. The dedicated
  // cold editor drains the daemon and reconciles its local materialization;
  // gitAccess above remains the contextual integration-upgrade shortcut.
  /** WebUI user performing this edit → stamps the last-modified audit (absent under devAuth). */
  lastModifiedByUserId?: string
}

/** Display info for a WebUI user attached to a resource (creator or last-modifier;
 *  joined from `app_user`). Shared by agent / daemon / cron records. */
export interface AgentCreator {
  userId: string
  displayName: string | null
  email: string
}

export interface AgentRecord {
  id: AgentId
  orgId: OrgId
  name: string
  displayName: string | null
  // True when a preset_agent row references this agent (preset-agents.md §3):
  // a built-in preset — labeled "builtin" in the console and protected from delete.
  builtin: boolean
  icon: AgentIcon | null // console avatar descriptor; null ⇒ legacy default (runtime mark)
  description: string | null
  runtime: string | null // null ⇒ deferred exec config (unplaced preset; set at placement)
  model: string | null // from runtimeOverrides.model
  reasoningEffort: string | null // from runtimeOverrides.reasoningEffort
  outputMode: string | null // from runtimeOverrides.outputMode
  showFooter: boolean // from runtimeOverrides.showFooter (default true)
  fastMode: boolean | null // from runtimeOverrides.fastMode (null ⇒ runtime default)
  permissionMode: string | null // from runtimeOverrides.permissionMode (null ⇒ runtime default)
  allowRuntimeChangesInChat: boolean // from runtimeOverrides (default false)
  pause: boolean | null // from runtimeOverrides.pause (null ⇒ not paused) (#288)
  env: Record<string, string> // from runtimeOverrides.env ({} when unset)
  // NOTE: write-only secret env vars are deliberately NOT on the record (accidental-
  // serialization guard, like BotSecret): key names come from AgentSecretStore.keys,
  // values only from AgentSecretStore.get on the wire-projection paths.
  mcpServers: string[] // from runtimeOverrides.mcpServers ([] when unset ⇒ none attached)
  skills: string[] // from runtimeOverrides.skills — enabled "<source>/<skill>" / "<source>/*" ([] ⇒ none)
  memory: AgentMemoryBinding | null // runtimeOverrides.memory
  status: 'active' | 'inactive' | 'paused'
  daemonId: DaemonId | null
  workspace: AgentWorkspace
  /** Nullable on scratch/anonymous and pre-R2a rows; action-time authorization
   *  fails closed until a legacy github workspace is lazily repaired. */
  workspaceRepoId?: bigint
  capabilities: string[]
  createdAt: Date
  createdBy: AgentCreator | null // null for daemon/CLI-created agents (no WebUI principal)
  /** Raw immutable creator FK scalar, independent of joined `createdBy`. */
  createdByUserId: string | null
  /** Current resource owner used by restricted visibility. */
  ownerUserId: string | null
  visibility: ResourceVisibility
  sharedWith: string[] // app_user.id set; meaningful only when visibility='restricted'
  callPolicy: AgentCallPolicy
  allowedCallerAgentIds: string[] // agent.id set; meaningful only when callPolicy='selected'
  outboundPolicy: AgentCallPolicy
  allowedTargetAgentIds: string[] // agent.id set; meaningful only when outboundPolicy='selected'
  introduceOnJoin: boolean // #536: self-introduce to peers on a genuine channel join (default false)
  restrictFileAccess: boolean // #642: persisted per-agent sandbox preference (default false)
  lastModifiedAt: Date // last human edit (create/PATCH); defaults to createdAt
  lastModifiedBy: AgentCreator | null // WebUI user who last edited it; null ⇒ never edited by a human
}

export interface AgentUpdateOpts {
  authorizeMcpServers?: (currentlyHeld: readonly string[]) => void
  authorizeSkills?: (currentlyHeld: readonly string[]) => void
}

export interface AgentRepo {
  create(input: CreateAgentInput): Promise<AgentRecord>
  get(agentId: AgentId): Promise<AgentRecord | null>
  /** `opts.authorizeMcpServers` / `opts.authorizeSkills` (only meaningful when
   *  the patch includes `mcpServers` / `skills`) run INSIDE the row-locked
   *  transaction, right after the committed runtimeOverrides read, with the
   *  agent's currently-held MCP list / skill-ref list — the one atomic point
   *  where an enable-list authorization decision and the write it guards cannot
   *  be separated by a concurrent removal. A throw aborts the transaction. */
  update(agentId: AgentId, patch: UpdateAgentInput, opts?: AgentUpdateOpts): Promise<AgentRecord>
  /** Compare-and-set a workspace edit. The caller has already drained/proved
   *  an owning daemon when one exists. */
  setWorkspace(
    agentId: AgentId,
    expectedLastModifiedAt: Date,
    expectedMode: AgentWorkspace['mode'],
    workspace: AgentWorkspace,
    workspaceRepoId?: bigint,
    byUserId?: string
  ): Promise<AgentRecord | null>
  /** Compensation for a daemon NACK whose non-activation is known. */
  restoreWorkspace(
    agentId: AgentId,
    expectedLastModifiedAt: Date,
    expectedWorkspace: AgentWorkspace,
    expectedWorkspaceRepoId: bigint | undefined,
    workspace: AgentWorkspace,
    workspaceRepoId?: bigint,
    byUserId?: string
  ): Promise<AgentRecord | null>
  /** Lazy rename-proof identity repair after resolving the configured workspace
   *  through GitHub. Atomically removes a legacy additional grant for the same
   *  numeric repo without tombstoning projections: workspace authority remains
   *  live. A concurrently deleted or differently repaired agent is a no-op. */
  setWorkspaceRepoId(agentId: AgentId, repoId: bigint): Promise<boolean>
  /** Set the visibility + share set (the dedicated `/sharing` write path, kept
   *  separate from content `update`). Stamps the last-modified audit; `byUserId`
   *  is the editing WebUI principal (absent under devAuth). */
  setSharing(
    agentId: AgentId,
    sharing: { visibility: ResourceVisibility; sharedWith: string[] },
    byUserId?: string
  ): Promise<AgentRecord>
  /** Set both directions of the agent-call policy. Stamps last-modified audit
   *  because it is a human configuration edit. */
  setCallPolicy(
    agentId: AgentId,
    policy: {
      callPolicy: AgentCallPolicy
      allowedCallerAgentIds: string[]
      outboundPolicy?: AgentCallPolicy
      allowedTargetAgentIds?: string[]
    },
    byUserId?: string
  ): Promise<AgentRecord>
  /** Serialize on the Agent row. A real placement change atomically revokes all
   *  active webchat MCP delegations; a same-placement write does not. */
  setPlacement(agentId: AgentId, daemonId: DaemonId | null): Promise<void>
  /**
   * Atomically move an agent only when its current owner still matches
   * `expectedDaemonId`. Returns the updated row, or null when another move won
   * the compare-and-set race. A real move revokes active webchat MCP authority
   * in the same transaction. This is the persistence fence for the explicit
   * cold daemon-switch action.
   */
  movePlacement(
    agentId: AgentId,
    expectedDaemonId: DaemonId | null,
    daemonId: DaemonId | null,
    byUserId?: string
  ): Promise<AgentRecord | null>
  /** Atomically enumerate the agent's HookDefs, tombstone their durable review
   *  projections, and delete the Agent (cascading the HookDefs). The returned
   *  snapshots let the route remove the corresponding relay rules. */
  delete(agentId: AgentId): Promise<HookRecord[]>
  /** The org's agents. Every supplied human principal is resource-filtered;
   *  undefined is reserved for unfiltered internal reads
   *  (authorization/policy.ts#visibilityWhere). */
  list(orgId: OrgId, viewer?: ViewCtx): Promise<AgentRecord[]>
  /** Agents placed on a specific daemon — the reconcile roster (`register/ok.agents`).
   *  A daemon only ever receives the specs of the agents it owns (1 agent : 1 machine). */
  listForDaemon(daemonId: DaemonId): Promise<AgentRecord[]>
  /**
   * The org's PEER directory: every agent, with only the fields the collaboration
   * roster filter needs. This is the channel-free discovery/authorization input —
   * an agent with no IM integration (webchat, hook, dream, memory-only) reaches
   * peers through this list and appears in NO channel-keyed structure at all.
   *
   * Deliberately NOT {@link AgentRepo.list}: that applies `visibilityWhere(viewer)`.
   * `ResourceVisibility` governs HUMAN console access only — a `restricted` agent is
   * still discoverable and callable by its peers. The only gate here is the
   * directional agent-call policy, applied by the caller over the returned rows.
   */
  orgDirectory(orgId: OrgId): Promise<OrgAgentRecord[]>
}

/** One agent in the org peer directory — {@link ChannelAgentRecord} (so the roster
 *  filter is literally the same code in both the org-wide and channel-filtered
 *  scopes) plus the owning daemon, which the flat `CollabRoutesSnapshot.agents[]`
 *  entry routes on. `daemonId` is null for an unplaced agent (not routable). */
export interface OrgAgentRecord extends ChannelAgentRecord {
  daemonId: string | null
}

// ───────────────────────────────────────────────────────────────────────────
// AssignmentRepo (C3) — the routing table (§3.7)
// ───────────────────────────────────────────────────────────────────────────

export interface AssignmentRecord {
  id: string
  platform: Platform
  channel: string
  thread: string | null
  agentId: AgentId
  daemonId: DaemonId | null
  workspaceId: string
  assignedEpoch: bigint
  assignedSeq: bigint | null
  routingEpoch: bigint
  state: AssignmentState
  bindRules: unknown
}

export interface AssignmentRepo {
  /**
   * Claim a session for `(agentId,daemonId)` under `epoch`. Throws
   * {@link OwnerConflict} when the partial-unique index rejects a second active
   * owner for the same sessionKey (§3.7). A `released` row does NOT collide.
   */
  assign(
    key: SessionKey,
    agentId: AgentId,
    daemonId: DaemonId,
    workspaceId: string,
    epoch: bigint,
    routingEpoch: bigint,
    bindRules?: BindRule[]
  ): Promise<AssignmentRecord>
  /** The active set for a daemon — the `register/ok` reconcile snapshot (§3.3). */
  activeForDaemon(daemonId: DaemonId): Promise<AssignmentRecord[]>
  /** The active owner of a sessionKey, if any. */
  ownerOf(key: SessionKey): Promise<AssignmentRecord | null>
  /** drain/done → mark released (becomes reassignable under a NEW epoch). */
  release(key: SessionKey, at: Date): Promise<void>
  /** Cold agent move → release every old-owner affinity in one update. */
  releaseForAgent(agentId: AgentId, daemonId: DaemonId, at: Date): Promise<SessionKey[]>
  /** watchdog → freeze a daemon's active assignments (no reassignment yet, §4.9). */
  freeze(daemonId: DaemonId): Promise<void>
}

// ───────────────────────────────────────────────────────────────────────────
// SessionRepo (C6) — converged milestones, NO bodies (§3.8)
// ───────────────────────────────────────────────────────────────────────────

/** From `event/session` (§3.8). Metadata-only list/detail snapshot plus sessionKey echo. */
export interface EventSessionInput {
  sessionId: SessionId
  parentSessionId?: SessionId
  agentId: AgentId
  launchId?: LaunchId // absent for Slack/Discord-created sessions (no CP launch fence)
  phase: SessionPhase
  link?: string
  summary?: string
  title?: string
  status?: string
  lastActivityAt?: Date
  triggeredBy?: string
  channelName?: string
  triggeredByName?: string
  threadUrl?: string
  // Effective execution-config snapshot (what the session actually ran with);
  // an absent value ⇒ the runtime's own default (never overwritten on update).
  runtime?: string
  model?: string
  effort?: string
  fastMode?: boolean
  permissionMode?: string
  outputMode?: string
  // The daemon that reported the milestone — stamped by the WS handler from the
  // authenticated connection, never taken from the frame payload.
  daemonId?: DaemonId
  platform?: Platform
  channel?: string
  thread?: string
  // ── visibility classification inputs (session-visibility.md §4.1) ──
  // All optional ⇒ old daemons stay compatible: absent conversationKind means
  // channel behavior ('org'); absent transportScope/launchCorrelationId means
  // no owner is recorded (fail closed).
  conversationKind?: SessionConversationKind
  transportScope?: string // durable tenant scope for ownerIdentity (§2), NOT the credential-derived hash
  launchCorrelationId?: string // Web API launch provenance (§4.4)
  /** The §4.2 verdict the ingest handler computed (its ownership lookups are
   *  already resolved). Absent ⇒ the row is classified `org` with no owner —
   *  the pre-visibility behavior, kept for internal callers and fixtures. */
  classification?: SessionClassification
  at: Date
}

/** A settled §4.2 classification, or the marker that the row inherits from its
 *  parent — which the repo resolves under a row lock (§4.5). Structurally
 *  identical to `domain/session-visibility.ts#SessionClassification`; declared
 *  here so the port layer does not depend on the domain module. */
export type SessionClassification =
  | { inherit: true }
  | { inherit?: false; visibility: SessionVisibility; ownerIdentity: string | null; source: VisibilitySource }

/** What one `event/session` upsert changed. `recorded: false` means the session
 *  id is already bound to a different agent (nothing was written). `settled`
 *  carries the A2A children this milestone resolved out of `inherited_pending`
 *  (§4.5) — the CP owes each of them a §5.1 gate push. */
export interface SessionMilestoneResult {
  recorded: boolean
  session: SessionMetaRecord | null
  settled: SessionMetaRecord[]
}

/** Outcome of a §4.3 visibility change: the target row plus every descendant a
 *  tightening cascade rewrote. Empty `affected` ⇒ the request was a no-op. */
export interface SessionVisibilityChange {
  affected: SessionMetaRecord[]
  /** The lock-time re-authorization refused the change (§4.3 ownership moved). */
  forbidden?: boolean
}

/** One entry of the §5.1 register-time gate snapshot. */
export interface SessionVisibilityState {
  sessionId: SessionId
  visibility: SessionVisibility
  visibilityRev: number
}

export interface SessionMetaRecord {
  id: SessionId
  parentSessionId: SessionId | null
  agentId: AgentId
  launchId: LaunchId | null
  platform: Platform | null
  channel: string | null
  thread: string | null
  phase: SessionPhase
  link: string | null
  summary: string | null
  title: string | null
  status: string | null
  lastActivityAt: Date
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
  daemonId: DaemonId | null
  activityState: ActivityState
  // ── session visibility (session-visibility.md §3) ──
  orgId: OrgId // denormalized from agent.orgId at ingest
  visibility: SessionVisibility
  ownerIdentity: string | null // §2 namespaced identity; null for automation/legacy/unresolved-owner rows (NOT a §2 owner-orphan, whose tuple is stored but unmatched)
  visibilitySource: VisibilitySource
  visibilityRev: number // bumped in the same tx as any visibility change (§5.1)
  visibilityAckedRev: number // daemon-ack watermark; 'applied' once >= visibilityRev
  startedAt: Date
  endedAt: Date | null
}

export interface SessionListRecord extends SessionMetaRecord {
  usage: SessionUsageCounts | null
}

export interface SessionQuery {
  agentId?: AgentId
  agentIds?: AgentId[]
  platform?: Platform
  channel?: string
  limit?: number
  cursor?: { activityMs: number; startedMs: number; id: string }
}

export interface SessionFilterQuery extends SessionQuery {
  integration?: Platform | 'github'
  triggeredBy?: string
  githubHookIds?: HookId[]
  hookTriggerIds?: HookId[]
  /** Session-visibility predicate inputs (session-visibility.md §5): human
   *  viewers see `org` rows plus `private` rows whose ownerIdentity is in their
   *  identity set. Absent ⇒ no session predicate — the internal fail-open,
   *  mirroring `visibilityWhere(undefined)`. */
  viewer?: { role: OrgMemberRole; identitySet: string[] }
}

export interface SessionPageQuery extends SessionFilterQuery {
  limit: number
  includeTotal: boolean
}

export type SessionFacetQuery = Omit<SessionFilterQuery, 'cursor' | 'limit'>

export interface SessionPageRecord {
  sessions: SessionListRecord[]
  total: number | null
  hasMore: boolean
}

export interface SessionFacetRecord {
  id: SessionId
  agentId: AgentId
  platform: Platform | null
  channel: string | null
  triggeredBy: string | null
  channelName: string | null
  triggeredByName: string | null
  lastActivityAt: Date
  startedAt: Date
}

export interface SessionFacetIndex {
  agents: AgentId[]
  integrations: SessionFacetRecord[]
  channels: SessionFacetRecord[]
  triggers: SessionFacetRecord[]
}

export interface SessionRepo {
  /** Upsert the converged milestone for a session (advance `phase`; NO message body).
   *  `recorded: false` means the global session id is already bound to a different
   *  agent. Classification is first-wins: an existing row keeps the visibility it
   *  was ingested with (§4.2), and an A2A child resolves its parent under a shared
   *  row lock, settling any `inherited_pending` children of its own (§4.5). */
  recordMilestone(ev: EventSessionInput): Promise<SessionMilestoneResult>
  /** Filter, keyset-page, and order in Postgres; usage is hydrated only for the
   *  returned page. `total` is computed only when explicitly requested. */
  listPage(q: SessionPageQuery): Promise<SessionPageRecord>
  /** Org-level "any session exists" — a bare boolean over the org's FULL session set
   *  (no visibility predicate), safe to return to any org member: it reveals nothing
   *  about sessions the caller can't see. Drives the getting-started conversation step. */
  orgHasAny(orgId: OrgId): Promise<boolean>
  /** One latest representative per distinct facet value after applying every
   *  other active facet. The database reduces the full history before returning
   *  this compact index to the HTTP layer. */
  listFacets(q: SessionFacetQuery): Promise<SessionFacetIndex>
  list(q: SessionQuery): Promise<SessionListRecord[]>
  get(id: SessionId): Promise<SessionMetaRecord | null>
  /** Fail-closed proof that the durable webchat session for this conversation
   * remains private before a remote administrative MCP invocation executes. */
  hasPrivateWebchatSession(conversationId: string, agentId: AgentId): Promise<boolean>
  /** Visible-child lookup for the session detail page. Parent ids are opaque and
   *  deliberately not foreign-keyed, so this remains a metadata query. `viewer`
   *  applies the same session predicate as the list (absent ⇒ internal fail-open). */
  listChildren(
    parentSessionId: SessionId,
    agentIds: AgentId[],
    viewer?: { role: OrgMemberRole; identitySet: string[] }
  ): Promise<SessionMetaRecord[]>
  /** §4.3 reclassification. Widening touches only the target row; tightening
   *  cascades to every descendant (transitively, `explicit` ones included —
   *  privacy wins) under the lock-then-scan-to-fixpoint protocol of §4.5. Every
   *  rewritten row's `visibilityRev` is bumped in the same transaction. */
  setVisibility(
    sessionId: SessionId,
    visibility: SessionVisibility,
    /** Re-checked against the LOCKED row, closing the gap between the route's
     *  authorization read and this write: a concurrent ancestor cascade can
     *  re-own the session in between. Denied ⇒ `forbidden`, nothing written. */
    authorize?: (row: { visibility: SessionVisibility; ownerIdentity: string | null }) => boolean
  ): Promise<SessionVisibilityChange>
  /** Raise the daemon-ack watermark (§5.1). Monotonic: a late ack for an older
   *  revision never lowers it, so the tighten stays `applied`. */
  recordVisibilityAck(sessionId: SessionId, visibilityRev: number): Promise<void>
  /** The §5.1 register-time gate snapshot for one daemon: the current
   *  `(sessionId, visibility, visibilityRev)` set for the sessions it reported,
   *  newest first and bounded. A snapshot, not a diff. */
  visibilitySnapshotForDaemon(daemonId: DaemonId, limit: number): Promise<SessionVisibilityState[]>
  /** How many of a daemon's sessions still owe an ack — used to report when a
   *  bounded snapshot could not carry them all (never a silent truncation). */
  countUnackedVisibility(daemonId: DaemonId): Promise<number>
  /** A session plus every descendant — the set a tightening cascade rewrote, so
   *  the detail view's cutover state covers the whole subtree, not just the root. */
  visibilitySubtree(sessionId: SessionId, limit: number): Promise<SessionMetaRecord[]>
  /** Resolve the agent that owns a bot's `(channel, thread)` — the most-recently-active session
   *  keyed there whose agent still has an active integration for that bot and a current daemon
   *  placement. Backstop for shared-bot thread-affinity lookup: a daemon-created session (e.g.
   *  an agent's own channel-root post, session-concept §7.2 case 2a) never goes through the
   *  relay's mention/switch REPORT leg, so no `thread-assign` seeds the affinity store — this
   *  lets `lookupThread` still find the owner. Null when none. */
  findThreadOwner(botId: BotId, channel: string, thread: string): Promise<{ agentId: string; daemonId: string } | null>
}

// ───────────────────────────────────────────────────────────────────────────
// WebchatConversationRepo — browser conversation ownership metadata
// ───────────────────────────────────────────────────────────────────────────

export interface WebchatConversationBinding {
  conversationId: string
  orgId: OrgId
  agentId: AgentId
  userId: string
}

export interface WebchatConversationRepo {
  /** Register a server-allocated conversation before its first relay dial. */
  create(binding: WebchatConversationBinding): Promise<void>
  /** The owning console user of a conversation, for session-visibility ingest
   *  (§4.2). Scoped to the agent the conversation was minted against; unknown
   *  and foreign bindings both return null (the caller fails closed). */
  findOwner(conversationId: string, agentId: AgentId): Promise<string | null>
  /** Exact owner check for resume. Unknown and foreign bindings both return false. */
  owns(binding: WebchatConversationBinding): Promise<boolean>
}

// ───────────────────────────────────────────────────────────────────────────
// Webchat MCP authority — durable delegation + invocation idempotency
// ───────────────────────────────────────────────────────────────────────────

export interface EstablishWebchatMcpDelegationInput {
  conversationId: string
  userId: string
  orgId: OrgId
  agentId: AgentId
  daemonId: DaemonId
  now: Date
  expiresAt: Date
}

export interface WebchatMcpDelegationRecord {
  id: string
  conversationId: string
  generation: number
  userId: string
  orgId: string
  agentId: string
  daemonId: string
  createdAt: Date
  expiresAt: Date
  revokedAt: Date | null
  revokedReason: string | null
}

export interface RevokeWebchatMcpDelegationInput {
  delegationId: string
  conversationId: string
  generation: number
  userId: string
  orgId: OrgId
  agentId: AgentId
  daemonId: DaemonId
  revokedAt: Date
  reason: string
}

export interface ReapWebchatMcpDelegationsResult {
  deleted: number
  expired: number
}

export interface WebchatMcpDelegationRepo {
  /**
   * Serialize on the durable conversation owner. Reconnects reuse matching,
   * unexpired authority without extending it. An earlier requested expiry
   * atomically shortens the reused row without rotating its generation.
   * An already-expired row or a placement change rotates its generation.
   * A foreign/unknown conversation binding, wrong daemon, or unplaced agent
   * returns null without mutating the current generation.
   */
  establish(input: EstablishWebchatMcpDelegationInput): Promise<WebchatMcpDelegationRecord | null>
  /** Conditional, generation-fenced revocation. An already-revoked exact match is idempotently true. */
  revoke(input: RevokeWebchatMcpDelegationInput): Promise<boolean>
  get(delegationId: string): Promise<WebchatMcpDelegationRecord | null>
  /** Return only a row whose generation still equals its durable conversation generation. */
  getCurrent(delegationId: string): Promise<WebchatMcpDelegationRecord | null>
  /**
   * Delete expired delegations only after their invocation ledger is empty.
   * `expired` counts deleted rows whose natural expiry transition had not yet
   * been observed, including rows marked expired during reconnect rotation.
   */
  reapExpired(expiredBefore: Date): Promise<ReapWebchatMcpDelegationsResult>
}

export type WebchatMcpGrantStatus = 'pending' | 'active' | 'revoked' | 'expired'

export interface WebchatMcpAccessGrantRecord {
  id: string
  authorityId: string
  descriptorInstanceId: string
  grantRevision: number
  tokenHash: string
  status: WebchatMcpGrantStatus
  pendingExpiresAt: Date
  expiresAt: Date
  activatedAt: Date | null
  revokedAt: Date | null
  revokedReason: string | null
  createdAt: Date
}

export interface IssueWebchatMcpGrantInput {
  authorityId: string
  authorityGeneration: number
  conversationId: string
  descriptorInstanceId: string
  authenticatedDaemonId: string
  tokenHash: string
  now: Date
  pendingExpiresAt: Date
  expiresAt: Date
}

export interface AcceptWebchatMcpGrantInput {
  grantId: string
  authorityId: string
  authorityGeneration: number
  conversationId: string
  descriptorInstanceId: string
  grantRevision: number
  authenticatedDaemonId: string
  now: Date
}

export interface RevokeWebchatMcpGrantsInput {
  authorityId: string
  authorityGeneration: number
  conversationId: string
  authenticatedDaemonId: string
  now: Date
  reason: string
}

export interface WebchatMcpAccessGrantRepo {
  issue(input: IssueWebchatMcpGrantInput): Promise<WebchatMcpAccessGrantRecord | null>
  accept(input: AcceptWebchatMcpGrantInput): Promise<WebchatMcpAccessGrantRecord | null>
  revokeAuthority(input: RevokeWebchatMcpGrantsInput): Promise<boolean>
  getByTokenHash(tokenHash: string): Promise<WebchatMcpAccessGrantRecord | null>
}

export type WebchatMcpOperationStatus =
  'awaiting_confirmation' | 'executing' | 'completed' | 'failed' | 'ambiguous' | 'stale'

export interface WebchatMcpOperationRecord {
  id: string
  conversationId: string
  createdAuthorityGeneration: number
  sourceGrantId: string
  userId: string
  toolName: string
  canonicalArguments: unknown
  intentHash: string
  status: WebchatMcpOperationStatus
  executionAttemptId: string | null
  claimedAt: Date | null
  recoveryDeadline: Date | null
  boundedResponse: Uint8Array | null
  createdAt: Date
  confirmationExpiresAt: Date
  completedAt: Date | null
}

export interface CreateWebchatMcpOperationInput {
  conversationId: string
  grantId: string
  authorityGeneration: number
  userId: string
  jsonRpcRequestId: string
  requestHash: string
  toolName: string
  canonicalArguments: unknown
  intentHash: string
  confirmationExpiresAt: Date
  now: Date
}

export type CreateWebchatMcpOperationResult =
  | { kind: 'created' | 'replayed' | 'coalesced'; operation: WebchatMcpOperationRecord }
  | { kind: 'denied' }
  | { kind: 'conflict' }

export const WEBCHAT_MCP_OPERATION_MAX_PAYLOAD_BYTES = 64 * 1024
export const WEBCHAT_MCP_OPERATION_MAX_RESPONSE_BYTES = 256 * 1024

export interface CompleteWebchatMcpOperationInput {
  operationId: string
  executionAttemptId: string
  status: 'completed' | 'failed'
  boundedResponse: Uint8Array
  completedAt: Date
}

export interface ReapWebchatMcpOperationsResult {
  markedAmbiguous: number
  markedStale: number
  evictedResponses: number
}

export interface WebchatMcpOperationRepo {
  createOrReplay(input: CreateWebchatMcpOperationInput): Promise<CreateWebchatMcpOperationResult>
  get(operationId: string): Promise<WebchatMcpOperationRecord | null>
  listPending(conversationId: string, userId: string, now: Date): Promise<WebchatMcpOperationRecord[]>
  claimForApproval(input: {
    operationId: string
    conversationId: string
    userId: string
    executionAttemptId: string
    claimedAt: Date
    recoveryDeadline: Date
  }): Promise<WebchatMcpOperationRecord | null>
  complete(input: CompleteWebchatMcpOperationInput): Promise<boolean>
  markAmbiguous(operationId: string, executionAttemptId: string, completedAt: Date): Promise<boolean>
  deny(operationId: string, conversationId: string, userId: string, completedAt: Date): Promise<boolean>
  reap(now: Date): Promise<ReapWebchatMcpOperationsResult>
}

// ───────────────────────────────────────────────────────────────────────────
// SessionUsageRepo (C6) — per-session token accounting for the usage dashboard
// ───────────────────────────────────────────────────────────────────────────

/** The token/cost snapshot carried by a `usage/report` EVT (protocol `SessionUsage`). */
export interface SessionUsageCounts {
  /** Daemon timestamp of the cumulative snapshot; orders competing list/detail reads. */
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

/** One `usage/report`: the session's cumulative usage snapshot (latest-wins upsert). */
export interface SessionUsageInput {
  sessionId: string // ACP session id (agent-assigned; NOT a wire UUID)
  agentId: AgentId
  platform?: string | null
  channel?: string | null
  lastActivityAt: Date
  usage: SessionUsageCounts
}

/** Per-agent rollup over a time window (summed tokens/cost + session count). */
export interface AgentUsageAggregate {
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

/** One spend-over-time bucket: total cost of sessions whose last activity fell in
 *  `[start, start + one bucket)`. `start` is a UTC-aligned ISO instant. */
export interface SpendBucket {
  start: string
  costAmount: number
}

/** Org-wide usage aggregate for a range: workspace totals + the per-agent breakdown.
 *  `costCurrency` is the single distinct currency across the range, or null when
 *  none/mixed (amounts are summed as-is).
 *  `series` is the spend-over-time chart data: cost bucketed by hour (d1) or day
 *  (longer ranges), with empty buckets filled to 0 across the whole window. */
export interface UsageAggregate {
  totals: { sessions: number; totalTokens: number; costAmount: number; costCurrency: string | null }
  agents: AgentUsageAggregate[]
  series: { bucket: 'hour' | 'day'; points: SpendBucket[] }
}

export interface SessionUsageRepo {
  /** Upsert a session's cumulative usage (idempotent on `(agentId, sessionId)`). */
  record(input: SessionUsageInput): Promise<void>
  /** Read one session's latest cumulative usage snapshot. */
  get(agentId: AgentId, sessionId: string): Promise<SessionUsageCounts | null>
  /** Aggregate usage for an org over sessions active at/after `since` (range window).
   *  When a `viewer` is supplied, sessions of restricted agents they can't see are
   *  excluded from both the totals and the per-agent breakdown (derived visibility,
   *  via the `agent` relation — undefined alone is unfiltered).
   *  `tzOffsetMin` (UTC − local, as `getTimezoneOffset()` reports) aligns the spend
   *  `series` buckets to the viewer's local day/hour; 0 (default) ⇒ UTC. */
  aggregate(orgId: OrgId, since: Date, viewer?: ViewCtx, tzOffsetMin?: number): Promise<UsageAggregate>
}

// ───────────────────────────────────────────────────────────────────────────
// LaunchRepo (C3) — launch fencing (§3.9)
// ───────────────────────────────────────────────────────────────────────────

export interface RecordLaunchInput {
  launchId: LaunchId
  agentId: AgentId
  daemonId: DaemonId
  runtime: string
  acpSessionId?: string
  activeCapabilities?: string[]
  mode?: LaunchMode
  epoch: bigint
  startedAt?: Date
  /** Web API launch provenance (session-visibility.md §4.4): the CP-minted
   *  correlation id the daemon echoes on the session's `event/session` frame,
   *  and the principal that requested the launch. Distinct from `launchId`,
   *  which is the agent-runtime fence. */
  correlationId?: string
  createdByUserId?: string
}

export interface LaunchRecord {
  id: LaunchId
  agentId: AgentId
  daemonId: DaemonId
  runtime: string
  mode: LaunchMode
  acpSessionId: string | null
  status: LaunchStatus
  launchEpoch: bigint
}

export interface LaunchRepo {
  record(input: RecordLaunchInput): Promise<LaunchRecord>
  /** The current (most recent running/launching) launch for an agent — the fence (§4.8). */
  currentLaunch(agentId: AgentId): Promise<LaunchId | undefined>
  /** The user a launch correlation belongs to (session-visibility.md §4.4);
   *  null when the correlation is unknown, so ingest fails closed. */
  ownerByCorrelationId(correlationId: string): Promise<string | null>
  markStopped(launchId: LaunchId, status: 'stopped' | 'crashed', at: Date): Promise<void>
}

// ───────────────────────────────────────────────────────────────────────────
// SecretLeaseRepo (C5) — lease metadata, NO plaintext (§3.10)
// ───────────────────────────────────────────────────────────────────────────

export interface CreateLeaseInput {
  leaseId: LeaseId
  daemonId: DaemonId
  scope: SecretsRequest['scope']
  ref: string
  ttlSec: number
  renewBeforeSec?: number
  issuedAt: Date
  expiresAt: Date
}

export interface LeaseRecord {
  id: LeaseId
  daemonId: DaemonId
  scopePlatform: Platform
  scopeWorkspaceId: string
  ref: string
  ttlSec: number
  renewBeforeSec: number
  status: LeaseStatus
  issuedAt: Date
  expiresAt: Date
}

export interface SecretLeaseRepo {
  create(input: CreateLeaseInput): Promise<LeaseRecord>
  /** Advance `expiresAt` on renew. */
  renew(leaseId: LeaseId, expiresAt: Date, at: Date): Promise<LeaseRecord>
  revoke(leaseId: LeaseId, reason: string): Promise<void>
  /** Active leases a daemon holds — `register/ok.leases[]` (§3.10). */
  activeForDaemon(daemonId: DaemonId): Promise<LeaseRecord[]>
  get(leaseId: LeaseId): Promise<LeaseRecord | null>
}

// ───────────────────────────────────────────────────────────────────────────
// CronRepo (C6/C3) — cron definitions (§3.11)
// ───────────────────────────────────────────────────────────────────────────

export interface UpsertCronInput {
  cronId: CronId
  orgId: OrgId
  /** The agent this cron drives — required at the API (§3.11); the column is
   *  nullable only for the agent-delete SetNull path. */
  agentId: AgentId
  /** Console display name — pure console metadata, never on the daemon wire. */
  name?: string
  schedule: CronUpsert['schedule']
  timezone: CronUpsert['timezone']
  targetPlatform?: Platform
  /** Optional output routing; absent ⇒ headless fire. */
  targetChannel?: string
  /** The agent integration whose connection posts the anchor (validated against
   *  the cron's agent at the API); absent ⇒ daemon falls back to the first. */
  targetIntegrationId?: IntegrationId
  trigger: CronUpsert['trigger']
  enabled?: boolean
  /** Creator (WebUI user) — stamped on CREATE only; an edit through the same
   *  upsert never reassigns it. */
  createdByUserId?: string
  /** Initial resource owner; defaults to `createdByUserId` on create. */
  ownerUserId?: string
  /** WebUI user performing THIS upsert → stamps the last-modified audit on both
   *  create and edit (absent under devAuth). */
  lastModifiedByUserId?: string
  /** Initial visibility + share set — written ONLY on create (a fresh cronId);
   *  the update branch never touches sharing (that goes through setSharing). */
  visibility?: ResourceVisibility
  sharedWith?: string[]
}

export interface CronRecord {
  id: CronId
  orgId: OrgId
  agentId: AgentId | null // null ⇒ orphaned by agent delete — inert, never pushed
  name: string | null // console display name; null for legacy/CLI rows
  schedule: string
  timezone: string
  targetPlatform: Platform
  targetChannel: string | null
  targetIntegrationId: IntegrationId | null // null ⇒ legacy / integration uninstalled (SetNull)
  trigger: string
  enabled: boolean
  lastRunAt: Date | null
  /** Creator, joined for the console (audit); null for CLI/legacy rows. */
  createdBy: { userId: string; displayName: string | null; email: string } | null
  /** Raw immutable creator FK scalar, independent of joined `createdBy`. */
  createdByUserId: string | null
  /** Current resource owner used by restricted visibility. */
  ownerUserId: string | null
  visibility: ResourceVisibility
  sharedWith: string[] // app_user.id set; meaningful only when visibility='restricted'
  createdAt: Date
  /** Last human edit (create/upsert); defaults to createdAt. */
  lastModifiedAt: Date
  /** WebUI user who last edited it; null ⇒ never edited by a human. */
  lastModifiedBy: { userId: string; displayName: string | null; email: string } | null
}

/** One daemon-reported fire of a schedule (console run history). */
export interface CronRunRecord {
  id: string
  cronId: CronId
  startedAt: Date
  status: 'running' | 'success' | 'failed'
  durationMs: number | null
  sessionId: string | null // ACP session id (console deep-link)
  reason: string | null // short failure text
}

/** The payload of one `cron/report` EVT (fire/session progress when `status`
 *  is absent, completion when present). */
export interface CronReportInput {
  firedAt: Date
  status?: 'success' | 'failed'
  durationMs?: number
  sessionId?: string
  reason?: string
}

export interface CronRepo {
  upsert(input: UpsertCronInput): Promise<CronRecord>
  /** Set the visibility + share set (the dedicated `/sharing` write path, kept
   *  separate from the content `upsert` which needs the full definition). Stamps
   *  the last-modified audit; `byUserId` is the editing WebUI principal. */
  setSharing(
    cronId: CronId,
    sharing: { visibility: ResourceVisibility; sharedWith: string[] },
    byUserId?: string
  ): Promise<CronRecord>
  remove(cronId: CronId): Promise<void>
  /** Console list (org-wide, orphans included). Every supplied human principal
   *  is resource-filtered; undefined is reserved for unfiltered internal reads
   *  (authorization/policy.ts#visibilityWhere). */
  listForOrg(orgId: OrgId, viewer?: ViewCtx): Promise<CronRecord[]>
  /** Every cron definition owned by one agent (cold placement-move snapshot). */
  listForAgent(agentId: AgentId): Promise<CronRecord[]>
  /** Apply a daemon `cron/report`. Scoped: the cron's owning agent must be
   *  placed on the REPORTING daemon (a daemon can never write another daemon's
   *  cron). `lastRunAt` is latest-wins (re-asserts / out-of-order reports never
   *  regress it); the run row upserts on (cronId, firedAt) — the fire report
   *  opens it `running`, a progress report can attach its session, and the
   *  completion report closes it. Returns whether the report was accepted
   *  (false ⇒ unknown/foreign cron, dropped). */
  recordReport(cronId: CronId, reportingDaemonId: DaemonId, report: CronReportInput): Promise<boolean>
  /** Run history for the console detail page, newest first. */
  listRuns(cronId: CronId, limit?: number): Promise<CronRunRecord[]>
  /** Reconcile orphaned runs: close every row still `running` whose `startedAt`
   *  is before `staleBefore` to `failed` with a marker reason (its completion
   *  report was lost — daemon offline / drained at turn end). Non-destructive: a
   *  late completion report still overwrites the outcome (the run-row upsert is
   *  last-writer-wins). Returns the number of rows reaped. Org-wide (a global
   *  maintenance sweep, not scoped to one daemon). */
  reapStaleRuns(staleBefore: Date): Promise<number>
  /** The cron set THIS daemon should run — crons of agents placed on it
   *  (`register/ok.crons[]`, same scope rule as integrations §3.11). */
  listForDaemon(daemonId: DaemonId): Promise<CronRecord[]>
  get(cronId: CronId): Promise<CronRecord | null>
}

// ───────────────────────────────────────────────────────────────────────────
// HookRepo — inbound-webhook triggers (webhook-triggers-and-github-events.md)
//   Definitions + run metadata only. The relay is the ingress: the CP compiles
//   HookDef rows into rc/hook-assign rules; event payloads never land here.
// ───────────────────────────────────────────────────────────────────────────

export type HookKind = 'webhook' | 'github'
export type HookSessionMode = 'perDelivery' | 'perThread' | 'shared'
export type GithubCommentFamily = 'issues' | 'pull_request'
export type HookReviewPolicy = 'off' | 'comment' | 'request_changes' | 'full'
export type HookReportingMode = 'off' | 'check' | 'status'
export type HookGateMode = 'informational' | 'required'
export type HookProjectionIntent = 'none' | 'revision_event' | 'review_action_only'
export type HookReviewEvent = 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE'
export type HookReviewVerdict = 'pass' | 'fail' | 'neutral'

export interface UpsertHookInput {
  hookId: HookId
  /** Present on update: the owner observed by the route. Repository mutation
   *  becomes update-only and cannot recreate a hook deleted with that agent. */
  expectedAgentId?: AgentId
  orgId: OrgId
  /** The agent this hook fires — required at the API; the column stays nullable
   *  only to tolerate legacy inert rows. Agent deletes cascade hooks. */
  agentId: AgentId
  kind: HookKind
  name: string
  /** Trigger text (control metadata, same as CronDef.trigger). */
  sessionMode: HookSessionMode
  enabled?: boolean
  /** Generic-endpoint routing key — minted server-side on CREATE, immutable
   *  after (the capability URL must survive edits). */
  urlToken?: string
  // ── kind=github (P2) — resolved server-side from repoFullName at create/update ──
  /** GitHub numeric repo id — the relay match key (rename-immune, decision 6). */
  repoId?: bigint
  repoFullName?: string
  events?: string[]
  /** Empty preserves the published API's legacy repo-wide issue_comment semantics. */
  commentFamilies?: GithubCommentFamily[]
  labelFilter?: string[]
  mentionOnly?: boolean
  reviewPolicy?: HookReviewPolicy
  reportingMode?: HookReportingMode
  gateMode?: HookGateMode
  requiredAcknowledgedAt?: Date | null
  requiredAcknowledgedByUserId?: string | null
  requiredAcknowledgedConfigRevision?: bigint | null
  targetPlatform?: Platform
  /** Optional output anchoring; absent ⇒ headless fire. */
  targetChannel?: string
  targetIntegrationId?: IntegrationId
  createdByUserId?: string
  lastModifiedByUserId?: string
}

export interface HookRecord {
  id: HookId
  orgId: OrgId
  agentId: AgentId | null // null ⇒ legacy inert row — never compiled
  kind: HookKind
  name: string
  enabled: boolean
  sessionMode: HookSessionMode
  urlToken: string | null // webhook kind only; capability URL — surfaced to canEdit only
  /** Whether a signing secret exists (the secret itself NEVER rides a record). */
  hmacConfigured: boolean
  // ── kind=github (P2) ──
  repoId: bigint | null
  repoFullName: string | null
  /** Immutable relay session namespace. Existing rows retain their historical
   * owner/repo prefix; new rows use the numeric repository identity. */
  githubSessionKey?: string | null
  events: string[]
  /** Empty = legacy repo-wide comments; non-empty scopes comments to these subjects. */
  commentFamilies: GithubCommentFamily[]
  labelFilter: string[]
  mentionOnly: boolean
  configRevision: bigint
  dispatchRevision: bigint
  /** Review lifecycle/binding generation; never reusable across disable,
   * retarget, reassignment, or reporting-mode transitions. */
  projectionEpoch: bigint
  reviewPolicy: HookReviewPolicy
  reportingMode: HookReportingMode
  gateMode: HookGateMode
  requiredAcknowledgedAt: Date | null
  requiredAcknowledgedByUserId: string | null
  requiredAcknowledgedConfigRevision: bigint | null
  // ── output anchoring ──
  targetPlatform: Platform
  targetChannel: string | null
  targetIntegrationId: IntegrationId | null
  lastFiredAt: Date | null // advisory; bumped on rc/run-report
  createdBy: { userId: string; displayName: string | null; email: string } | null
  createdByUserId: string | null
  createdAt: Date
  lastModifiedAt: Date
  lastModifiedBy: { userId: string; displayName: string | null; email: string } | null
}

/** One delivery's run row (console run history; metadata only, never payloads). */
export interface HookRunRecord {
  id: string
  hookId: HookId
  deliveryKey: string
  event: string | null
  agentId: AgentId | null
  configRevision: bigint | null
  dispatchRevision: bigint | null
  /** CP-owned review lifecycle/binding epoch captured with the accepted run. */
  projectionEpoch: bigint | null
  dispatchDaemonId: DaemonId | null
  reviewPolicySnapshot: HookReviewPolicy | null
  reportingModeSnapshot: HookReportingMode | null
  gateModeSnapshot: HookGateMode | null
  projectionIntent: HookProjectionIntent | null
  repoId: bigint | null
  repoFullName: string | null
  sourceInstallationId: bigint | null
  subjectKind: string | null
  pullNumber: number | null
  headSha: string | null
  baseSha: string | null
  reportSha: string | null
  isDraft: boolean | null
  baseChanged: boolean | null
  startedAt: Date
  turnStartedAt: Date | null
  completedAt: Date | null
  orphanedAt: Date | null
  projectionId: string | null
  projectionGeneration: bigint | null
  reviewAttemptId: string | null
  reviewAttemptState: string | null
  reviewErrorCode: string | null
  reviewId: string | null
  reviewEvent: HookReviewEvent | null
  verdict: HookReviewVerdict | null
  reviewCommitId: string | null
  status: 'running' | 'success' | 'failed'
  durationMs: number | null
  sessionId: string | null
  reason: string | null
  redeliveryAttempts: number
  redeliveryLastRequestedAt: Date | null
  redeliveryNextAttemptAt: Date | null
}

/** The relay's delivery-stage verdict (`rc/run-report`): `accepted` opens the
 *  row `running`, `failed` records a failed row outright. */
export interface HookDeliveryInput {
  deliveryKey: string
  firedAt: Date
  event?: string
  status: 'accepted' | 'failed'
  reason?: string
  /** Exact accepted dispatch snapshot. All fields are optional only for rolling
   *  compatibility; a row lacking the full tuple cannot authorize R1/R2a. */
  agentId?: AgentId
  configRevision?: bigint
  dispatchRevision?: bigint
  dispatchDaemonId?: DaemonId
  reviewPolicySnapshot?: HookReviewPolicy
  reportingModeSnapshot?: HookReportingMode
  gateModeSnapshot?: HookGateMode
  projectionIntent?: HookProjectionIntent
  repoId?: bigint
  repoFullName?: string
  sourceInstallationId?: bigint
  subjectKind?: string
  pullNumber?: number
  headSha?: string
  baseSha?: string
  reportSha?: string
  isDraft?: boolean
  baseChanged?: boolean
}

export interface HookDeliveryRecordResult {
  accepted: boolean
  /** True only when this delivery key created its HookRun. Reopened or
   * idempotently repeated deliveries must not refresh mutable source facts. */
  newlyObserved: boolean
}

export interface GithubRepoFullNameRefreshResult {
  hooks: HookRecord[]
  /** App-backed workspaces whose persisted clone URL changed. */
  agentIds: AgentId[]
}

/** Metadata barrier emitted when the daemon actually dequeues an accepted turn. */
export interface HookStartInput {
  deliveryKey: string
  agentId: AgentId
  sessionId?: string
  configRevision: bigint
  dispatchRevision: bigint
  dispatchDaemonId: DaemonId
  /** Present on current daemons. Required when this start must recover a
   * claimed delivery whose Relay accepted report was lost. */
  reviewPolicySnapshot?: HookReviewPolicy
  reportingModeSnapshot?: HookReportingMode
  gateModeSnapshot?: HookGateMode
  startedAt: Date
  projectionIntent?: HookProjectionIntent
  repoId?: bigint
  repoFullName?: string
  sourceInstallationId?: bigint
  subjectKind?: string
  pullNumber?: number
  headSha?: string
  baseSha?: string
  reportSha?: string
  isDraft?: boolean
  baseChanged?: boolean
}

export interface HookReviewAttemptInput {
  deliveryKey: string
  attemptId: string
  agentId: AgentId
  configRevision: bigint
  dispatchRevision: bigint
  dispatchDaemonId: DaemonId
  requestedEvent: HookReviewEvent
  requestedVerdict: HookReviewVerdict
}

export type HookReviewAttemptResult = 'reserved' | 'idempotent' | 'rejected'

export interface HookReviewResultInput {
  deliveryKey: string
  attemptId: string
  /** `released` is safe only when the daemon proved no GitHub mutation occurred;
   *  `blocked` keeps an ambiguous durable reservation pinned. */
  state: 'submitted' | 'released' | 'blocked'
  code?: string
  reviewId?: string
  event?: HookReviewEvent
  verdict?: HookReviewVerdict
  commitId?: string
}

/** The daemon's completion report (`hook/report` EVT) closing the row. */
export interface HookReportInput {
  deliveryKey: string
  event?: string
  status: 'success' | 'failed'
  durationMs?: number
  sessionId?: string
  reason?: string
  agentId?: AgentId
  configRevision?: bigint
  dispatchRevision?: bigint
  dispatchDaemonId?: DaemonId
  reviewPolicySnapshot?: HookReviewPolicy
  reportingModeSnapshot?: HookReportingMode
  gateModeSnapshot?: HookGateMode
  projectionIntent?: HookProjectionIntent
  repoId?: bigint
  repoFullName?: string
  sourceInstallationId?: bigint
  subjectKind?: string
  pullNumber?: number
  headSha?: string
  baseSha?: string
  reportSha?: string
  isDraft?: boolean
  baseChanged?: boolean
  reviewAttemptId?: string
  reviewAttemptState?: 'submitted' | 'released' | 'blocked'
  reviewErrorCode?: string
  reviewId?: string
  reviewEvent?: HookReviewEvent
  verdict?: HookReviewVerdict
  reviewCommitId?: string
  /** Optional reporter convergence folded into the same transaction as the
   *  terminal HookRun update; applied only through the bound generation CAS. */
  projectionDesiredState?: string
  projectionNextAttemptAt?: Date
}

export interface HookReviewProjectionRecord {
  id: string
  hookId: HookId
  orgId: OrgId
  agentId: AgentId
  /** Stable agent slug snapshotted for owner-independent Check cleanup. */
  agentName: string | null
  lastResolvedInstallationId: bigint | null
  repoId: bigint
  repoFullName: string
  /** Source PR head revision used only for live commit -> PR association. */
  headSha: string
  /** Check target revision (may be a PR test-merge SHA in later phases). */
  reportSha: string
  /** Hook review lifecycle/binding epoch; part of the durable natural key. */
  projectionEpoch: bigint
  generation: bigint
  currentHookRunId: string | null
  externalId: string
  checkRunId: string | null
  mode: HookReportingMode
  gateMode: HookGateMode
  desiredState: string
  observedState: string | null
  sealedThrough: bigint
  /** Generation for which commit -> current PR association was last read from
   * GitHub. A value different from `generation` must be re-evaluated before a
   * terminal Check mutation. */
  subjectSyncGeneration: bigint
  /** Normalized fail-closed reason for the synchronized generation. Raw
   * GitHub response text is never persisted. */
  subjectSyncErrorCode: string | null
  leaseOwner: string | null
  leaseUntil: Date | null
  nextAttemptAt: Date | null
  attempts: number
  lastErrorCode: string | null
  pendingIntent: unknown | null
  writeMarker: string | null
  writePhase: string | null
  writeStartedAt: Date | null
  tombstonedAt: Date | null
  updatedAt: Date
}

export interface HookReviewSubjectRecord {
  projectionId: string
  pullNumber: number
  headSha: string
  baseSha: string | null
  isOpen: boolean
  updatedAt: Date
}

export interface UpsertHookReviewProjectionInput {
  hookId: HookId
  orgId: OrgId
  agentId: AgentId
  /** Stable agent slug copied into the durable projection. */
  agentName: string
  repoId: bigint
  repoFullName: string
  headSha: string
  reportSha: string
  projectionEpoch: bigint
  mode: HookReportingMode
  gateMode: HookGateMode
  desiredState: string
  currentHookRunId?: string
  nextAttemptAt: Date
  pendingIntent?: unknown
}

export interface ProjectionWriteResultInput {
  projectionId: string
  generation: bigint
  leaseOwner: string
  writeMarker: string
  observedState: string
  checkRunId?: string
  lastResolvedInstallationId?: bigint
  /** A terminal association failure is intentionally projected as a
   * non-passing Check while the canonical desired intent remains unchanged. */
  settledErrorCode?: string
  /** Worker clock used to keep a changed desired state / pending intent due
   *  after reconciling the older external write. */
  recheckAt?: Date
}

export interface HookRepo {
  upsert(input: UpsertHookInput): Promise<HookRecord>
  remove(hookId: HookId, expectedAgentId?: AgentId): Promise<void>
  get(hookId: HookId): Promise<HookRecord | null>
  getMany(hookIds: HookId[]): Promise<HookRecord[]>
  /** Every enabled hook, all orgs — the relay-register full-replay source. */
  listEnabled(): Promise<HookRecord[]>
  /** A hook is subordinate to one agent and is only ever listed under it (the
   *  console detail page); access is gated by the AGENT's visibility, so no
   *  viewer-filter here. Also the re-compile source on a placement change. */
  listForAgent(agentId: AgentId): Promise<HookRecord[]>
  /** Distinct kinds of ENABLED hooks per agent, org-wide in one query — feeds
   *  the agents-list read model (each agent's own row; no org hook list). */
  kindsByAgent(orgId: OrgId): Promise<Map<string, HookRecord['kind'][]>>
  /** All of one org's hooks of one kind (enabled or not) — the doorbell-driven
   *  github recompile source: broadcast() converges each to assign-or-remove. */
  listForOrgKind(orgId: OrgId, kind: HookKind): Promise<HookRecord[]>
  /** Compact classifier input for historical session filtering. */
  listIdsForOrgKind(orgId: OrgId, kind: HookKind): Promise<HookId[]>
  /** Apply a relay `rc/run-report`. Upsert on (hookId, deliveryKey): a duplicate
   *  report (redelivery, reconcile re-post) lands on the existing row and never
   *  resets it. Bumps `lastFiredAt` latest-wins. Unknown hookId ⇒ false (drop). */
  recordDelivery(hookId: HookId, input: HookDeliveryInput): Promise<boolean>
  /** Detailed variant used by source-fact convergence, which must distinguish a
   * newly observed delivery from an accepted reopening of an existing run. */
  recordDeliveryResult(hookId: HookId, input: HookDeliveryInput): Promise<HookDeliveryRecordResult>
  /** Refresh mutable GitHub endpoint/display names after a newly observed,
   * accepted delivery, but only while it remains the org/repo's newest
   * observation. Returns changed hooks for relay convergence and changed
   * App-backed workspaces for daemon config convergence. */
  refreshGithubRepoFullName(
    sourceHookId: HookId,
    repoId: bigint,
    repoFullName: string,
    observedAt: Date
  ): Promise<GithubRepoFullNameRefreshResult>
  getRun(hookId: HookId, deliveryKey: string): Promise<HookRunRecord | null>
  /** Direct lookup for projection-owned metadata such as the terminal session deep link. */
  getRunById(runId: string): Promise<HookRunRecord | null>
  /** Latest current revisions whose durable Check projection is absent or
   * stale. Used by the periodic R2a crash-repair loop. */
  listRunsNeedingReviewProjection(limit?: number): Promise<HookRunRecord[]>
  /** Action/start authority uses the persisted accepted tuple, not current placement. */
  recordStart(hookId: HookId, reportingDaemonId: DaemonId, input: HookStartInput): Promise<boolean>
  reserveReviewAttempt(
    hookId: HookId,
    reportingDaemonId: DaemonId,
    input: HookReviewAttemptInput
  ): Promise<HookReviewAttemptResult>
  recordReviewResult(hookId: HookId, reportingDaemonId: DaemonId, input: HookReviewResultInput): Promise<boolean>
  /** Apply a daemon `hook/report` completion. Scoped: the hook's owning agent
   *  must be placed on the REPORTING daemon. Last-writer-wins; a completion with
   *  no prior delivery row (rc/run-report lost) still creates one, with
   *  `startedAt` estimated as `at − durationMs`. Returns acceptance. */
  recordReport(hookId: HookId, reportingDaemonId: DaemonId, input: HookReportInput, at: Date): Promise<boolean>
  /** Run history for the console detail page, newest first. */
  listRuns(hookId: HookId, limit?: number): Promise<HookRunRecord[]>
  /** Which of `deliveryKeys` already have a run row (any hook) — the redelivery
   *  reconciler's "did this GUID land at all" probe. */
  existingDeliveryKeys(deliveryKeys: string[]): Promise<Set<string>>
  /** Atomically reserve one GitHub redelivery when a metadata-only
   * `review_request_required` fan-out landed for only a strict subset of the
   * hooks that matched the delivery. The one-shot claim is safe because no
   * original agent turn existed and duplicate rows are idempotent. */
  claimReviewRequestRequiredFanoutRedelivery(
    deliveryKey: string,
    expectedHookIds: readonly HookId[],
    requestedAt: Date
  ): Promise<boolean>
  /** Atomically reserve the single safe durable GitHub redelivery for every
   * due delivery-stage row sharing `deliveryKey`. Returns false after the first
   * external claim or for nonretryable/effectful rows. */
  claimRetryableDeliveryRedelivery(
    deliveryKey: string,
    expectedHookIds: readonly HookId[],
    requestedAt: Date,
    backoffMs: readonly number[]
  ): Promise<boolean>
  /** Retire retry gates that exhausted their durable budget or aged beyond the
   * GitHub delivery lookup horizon, independent of whether the GUID remains in
   * the current API page. Cleared rows are terminal and cannot be reopened. */
  settleRetryableDeliveryRedeliveries(requestedAt: Date, expiredBefore: Date, maxAttempts: number): Promise<number>
  /** Close `running` rows older than `staleBefore` to failed(orphaned) — the
   *  HookRunReaper sweep; a late completion still overwrites (see CronRepo). */
  reapStaleRuns(staleBefore: Date): Promise<number>
  /** Durable projection/outbox operations (R2a). */
  upsertReviewProjection(input: UpsertHookReviewProjectionInput): Promise<HookReviewProjectionRecord>
  bindRunProjection(hookId: HookId, deliveryKey: string, projectionId: string, generation: bigint): Promise<boolean>
  setProjectionDesired(
    projectionId: string,
    generation: bigint,
    desiredState: string,
    nextAttemptAt: Date,
    currentHookRunId?: string
  ): Promise<boolean>
  upsertReviewSubject(input: Omit<HookReviewSubjectRecord, 'updatedAt'>): Promise<void>
  /** Atomically replace the complete live set of open PR subjects (closing
   * stale rows) and mark the association result for one projection generation.
   * `subjects: null` records an incomplete pagination result without treating
   * the partial page set as authoritative. */
  synchronizeReviewSubjects(
    projectionId: string,
    generation: bigint,
    subjects: readonly Omit<HookReviewSubjectRecord, 'projectionId' | 'updatedAt' | 'isOpen'>[] | null,
    errorCode: string | null
  ): Promise<boolean>
  listReviewSubjects(projectionId: string): Promise<HookReviewSubjectRecord[]>
  getReviewProjection(projectionId: string): Promise<HookReviewProjectionRecord | null>
  findReviewProjectionByExternalId(externalId: string): Promise<HookReviewProjectionRecord | null>
  /** Reverse-map a GitHub `check_run.rerequested` action to the projection this
   *  App created. The remote id is opaque and stored as text. */
  findReviewProjectionByCheckRunId(checkRunId: string): Promise<HookReviewProjectionRecord | null>
  /** Infer the current Check Runs covered by an App-owned suite rerequest. GitHub
   * groups one App's runs by repository revision; installation identity prevents
   * an old or replacement App installation from crossing that boundary. */
  listReviewProjectionsForSuiteRerequest(
    repoId: bigint,
    headSha: string,
    installationId: bigint
  ): Promise<HookReviewProjectionRecord[]>
  listReviewProjectionsForAgentRepo(agentId: AgentId, repoId: bigint): Promise<HookReviewProjectionRecord[]>
  wakeReviewProjectionsForInstallation(installationId: bigint, at: Date): Promise<number>
  wakeReviewProjectionsForOrg(orgId: OrgId, at: Date): Promise<number>
  refreshReviewProjectionTarget(
    projectionId: string,
    generation: bigint,
    repoFullName: string,
    installationId: bigint
  ): Promise<boolean>
  claimDueReviewProjections(
    leaseOwner: string,
    now: Date,
    leaseUntil: Date,
    limit?: number
  ): Promise<HookReviewProjectionRecord[]>
  beginProjectionWrite(
    projectionId: string,
    generation: bigint,
    leaseOwner: string,
    writeMarker: string,
    writePhase: string,
    startedAt: Date
  ): Promise<boolean>
  completeProjectionWrite(input: ProjectionWriteResultInput): Promise<boolean>
  /** Fold a durable pending intent after the previous external write has been
   *  reconciled and its mutex cleared. */
  advancePendingReviewProjection(
    projectionId: string,
    generation: bigint,
    fallbackNextAttemptAt: Date
  ): Promise<HookReviewProjectionRecord | null>
  retryProjectionWrite(
    projectionId: string,
    generation: bigint,
    leaseOwner: string,
    nextAttemptAt: Date,
    errorCode: string,
    keepWriteMutex?: boolean
  ): Promise<boolean>
  blockProjection(
    projectionId: string,
    generation: bigint,
    errorCode: string,
    keepWriteMutex?: boolean
  ): Promise<boolean>
  /** Permanently tombstone every durable Check owned by one agent/repository
   * grant before that grant is revoked. The reporter may subsequently use only
   * its cleanup capability; delayed HookRun repair must never revive the row. */
  tombstoneReviewProjectionsForAgentRepo(
    agentId: AgentId,
    repoId: bigint,
    at: Date,
    desiredState: string
  ): Promise<number>
  tombstoneReviewProjections(hookIds: HookId[], at: Date, desiredState: string): Promise<number>
}

/** Per-hook HMAC signing key — read ONLY here, NEVER joined into a DTO
 *  (BotSecretStore discipline). */
export interface HookSecretStore {
  put(hookId: HookId, hmacSecret: string): Promise<void>
  get(hookId: HookId): Promise<string | null>
  delete(hookId: HookId): Promise<void>
}

// ───────────────────────────────────────────────────────────────────────────
// BotRepo (C6) — durable platform bot identities (NO tokens)
// A bot outlives the integration installing it: uninstall FREES the bot so the
// console can offer it for reuse instead of forcing a re-create.
// ───────────────────────────────────────────────────────────────────────────

/** IM inbound transport axis (mirrors the historical Prisma `SlackTransport`
 *  enum). `socket` ⇒ daemon-owned long connection; `http` ⇒ relay-pool callback
 *  ingress with a send-only daemon spec. */
export type SlackTransport = 'socket' | 'http'

export interface CreateBotInput {
  id: BotId
  orgId: OrgId
  platform: Platform // 'slack'
  name: string
  prebuilt?: boolean
  /** Slack app id (A…), parsed from the pasted xapp token. Public metadata, NOT a secret. */
  slackAppId?: string
  /** Slack workspace id (T…), from the platform app's OAuth exchange. Together with
   *  `slackAppId` it is the relay demux key for a distributed app. Public metadata. */
  teamId?: string
  /** Display-only external workspace metadata; never used for routing/admission. */
  workspaceId?: string
  workspaceName?: string
  /** Slack bot user id, from the OAuth exchange (`bot_user_id`). Public metadata. */
  botUserId?: string
  /** Discord application (client) id, decoded from the bot token. Public metadata, NOT a secret. */
  discordAppId?: string
  /** Feishu/Lark app id (`cli_…`). Public metadata used for the developer-console link. */
  feishuAppId?: string
  /** Feishu/Lark gateway region; only set for platform 'feishu'. Durable home for the
   *  region so a freed bot reinstalls against the same gateway. */
  feishuRegion?: FeishuRegion
  /** Opt into shared-bot mode at create (shared-bot-relay.md §4.1). Default false. */
  shareable?: boolean
  /** Inbound transport. Default 'socket'. */
  transport?: SlackTransport
  createdByUserId?: string
}

/** Domain view of a `bot` row + its current installs (joined). NEVER carries tokens. */
export interface BotRecord {
  id: BotId
  orgId: OrgId
  platform: Platform
  name: string
  prebuilt: boolean
  /** Slack app id (A…) — deep-links the console to the app's Slack settings page. */
  slackAppId: string | null
  /** Slack workspace id (T…); non-null only for platform-app installs, where
   *  (slackAppId, teamId) is the relay demux key. */
  teamId: string | null
  /** Display-only external workspace metadata; unlike teamId, this never changes
   *  routing or install admission. */
  workspaceId: string | null
  workspaceName: string | null
  /** Slack bot user id, persisted from the OAuth exchange; null for legacy bots. */
  botUserId: string | null
  /** Stamped when the workspace uninstalled the app / revoked its tokens
   *  (`rc/bot-revoked`); a platform-app re-install clears it. */
  revokedAt: Date | null
  /** Install generation of the CURRENT credential — advanced on every (re)install.
   *  Echoed through rc/bot-assign → rc/bot-revoked so a revocation observed under
   *  an older generation cannot kill a newer one (Slack does not order lifecycle
   *  events). */
  credentialRevision: number
  /** When the current credential landed; null for bots created before the fence
   *  (their revocations skip the timestamp check and rely on the revision). */
  credentialInstalledAt: Date | null
  /** Discord application (client) id — lets the console offer a ready-made invite URL. */
  discordAppId: string | null
  /** Feishu/Lark app id — lets the console deep-link to this app's developer settings. */
  feishuAppId: string | null
  /** Feishu/Lark gateway region for this bot; null for non-feishu bots (and feishu bots
   *  created before the column — treated as 'feishu'). Durable across uninstall. */
  feishuRegion: FeishuRegion | null
  /** Shared-bot opt-in (§4.1): true ⇒ may serve MANY agents (http transport only). */
  shareable: boolean
  /** Inbound transport: 'http' ⇒ relay callbacks; 'socket' ⇒ daemon long connection. */
  transport: SlackTransport
  /** Creator (WebUI user), joined for the console picker; null for prebuilt/CLI. */
  createdBy: { userId: string; displayName: string | null; email: string } | null
  /** Stamped when the bot's integration is removed ("last used 12d ago"). */
  lastUsedAt: Date | null
  /** Agent the bot was last freed from ("freed from support-bot"). */
  lastAgentName: string | null
  /** Every agent currently installed on the bot (empty ⇒ free). A classic bot has
   *  ≤1; a shareable bot fans out to many. */
  agentIds: AgentId[]
  /** Blocking occupancy for a CLASSIC bot: the single agent it is installed on, or
   *  null. ALWAYS null for a shareable bot — sharing lifts the 1-install cap, so a
   *  shareable bot is never "in use" in the reuse-blocking sense. */
  inUseByAgentId: AgentId | null
  createdAt: Date
}

export interface BotRepo {
  create(input: CreateBotInput): Promise<BotRecord>
  get(id: BotId): Promise<BotRecord | null>
  listForOrg(orgId: OrgId): Promise<BotRecord[]>
  /** Record workspace metadata learned from OAuth/auth.test. A missing name
   *  preserves the last known label. */
  setWorkspaceMetadata(id: BotId, workspaceId: string, workspaceName: string | null): Promise<void>
  /** Slack bots missing public app/workspace identity metadata. */
  listSlackMissingIdentity(): Promise<BotRecord[]>
  /** Backfill only a missing id; never replace an established Slack app identity. */
  setSlackAppIdIfMissing(id: BotId, slackAppId: string): Promise<boolean>
  /** Stamp the freed-bot display hints when its LAST integration is removed. */
  markFreed(id: BotId, at: Date, lastAgentName: string | null): Promise<void>
  /** Flip the shared-bot (multi-agent) opt-in (console toggle). Serialized on the
   *  bot row with {@link IntegrationRepo.addBotMembership}; disabling recounts the
   *  ACTIVE installs under that lock and throws `BotStillShared` when >1 remain,
   *  so a concurrent admission can never slip past the route's optimistic check. */
  setShareable(id: BotId, shareable: boolean): Promise<void>
  /** Every http-transport bot with ≥1 active integration, across all orgs — the
   *  shared-bot orchestrator's convergence worklist (relay register / failover). */
  listHttpActive(): Promise<BotRecord[]>
  /** The Bot backing one workspace install of a distributed app — CROSS-ORG lookup
   *  by the composite demux key (a workspace binds to exactly one org). */
  getBySlackAppTeam(slackAppId: string, teamId: string): Promise<BotRecord | null>
  /**
   * A fresh credential landed on an EXISTING bot (platform re-install / token
   * rotation): advance the install generation, stamp when it landed, and clear
   * any revocation in ONE statement. Returns the new revision so the caller can
   * log/broadcast it. Anything that observed the previous credential is now
   * stale by construction.
   *
   * This is also the ONLY way to un-revoke a bot — there is deliberately no bare
   * `setRevoked(id, null)`: reviving a credential without advancing its
   * generation would leave a delayed uninstall from the dead one able to kill it.
   */
  bumpCredential(id: BotId, at: Date): Promise<number>
  /**
   * Compare-and-set revocation. Callers go through {@link BotCredentialWriter},
   * which pairs this with the integration flip in one transaction — on its own
   * it settles only the bot row.
   * Refuses (returns false, writing nothing) when the reported generation is no
   * longer current, so a delayed uninstall from a prior install cannot kill the
   * credential that replaced it:
   *  - `revision` — the generation the reporting relay held. A mismatch means a
   *    re-install has happened since; refuse.
   *  - `eventAt` — when Slack says the event HAPPENED. Refuse if the current
   *    credential was installed at-or-after it (covers the common case where the
   *    relay already received the newer assignment and would echo its revision).
   * Both are optional: a report carrying neither still applies (fail-open — an
   * uninstall must eventually take effect).
   */
  revokeIfCurrent(id: BotId, at: Date, fence: { revision?: number; eventAt?: Date }): Promise<boolean>
  /** Callers must refuse while the bot is installed (FK Restrict backstops). */
  delete(id: BotId): Promise<void>
}

// ───────────────────────────────────────────────────────────────────────────
// GithubInstallationRepo — installations of the deployment GitHub App
// (github-app workspaces). Infrastructure-class in the visibility taxonomy
// (like Bot): always org-visible, never restricted. Rows are only ever MARKED
// dead (`revokedAt`) — agents keep provenance pointers, and minting resolves
// the LIVE installation by account login, so uninstall→reinstall self-heals.
// ───────────────────────────────────────────────────────────────────────────

/** As reported by GitHub (`GET /app/installations` / the setup callback verify). */
export interface GithubInstallationFacts {
  installationId: bigint
  accountLogin: string
  accountType: string // "Organization" | "User"
  repositorySelection: string // "all" | "selected"
  suspendedAt: Date | null
  /** Installation-effective GitHub permissions. Missing/unknown is represented
   *  by `{}` and must fail closed at effect authorization sites. */
  permissions: Record<string, string>
}

export interface GithubInstallationRecord extends GithubInstallationFacts {
  id: string // our row id (uuid) — what agents reference as provenance
  orgId: OrgId
  revokedAt: Date | null
  createdAt: Date
}

export interface GithubInstallationRepo {
  /** Claim/update by GitHub installation id (idempotent for setup-callback + sync). */
  upsertFromGithub(orgId: OrgId, facts: GithubInstallationFacts): Promise<GithubInstallationRecord>
  get(id: string): Promise<GithubInstallationRecord | null>
  /** Live (non-revoked) installations claimed by the org — the picker's first level. */
  listForOrg(orgId: OrgId): Promise<GithubInstallationRecord[]>
  /** Mint-time resolution: the live installation covering `accountLogin` in this org. */
  liveByOrgAndAccount(orgId: OrgId, accountLogin: string): Promise<GithubInstallationRecord | null>
  /** Doorbell lookup by GITHUB-side id (revoked rows included — the claim row is
   *  what maps the poke to an org; unknown ⇒ no org claim yet, ignore). */
  getByInstallationId(installationId: bigint): Promise<GithubInstallationRecord | null>
  /** Doorbell revoke: GitHub answered 404/410 for this installation (never delete). */
  markRevokedByInstallationId(installationId: bigint): Promise<void>
  /** Sync reconciliation: mark the org's rows NOT in `liveInstallationIds` revoked (never delete). */
  markRevokedExcept(orgId: OrgId, liveInstallationIds: bigint[]): Promise<void>
}

/** One-shot install-state nonces (`github_install_state`): put on mint, consume-once on callback. */
export interface GithubInstallStateStore {
  put(nonce: string, orgId: OrgId, expiresAt: Date): Promise<void>
  /** True iff the nonce existed (it is deleted atomically) — false ⇒ replay/unknown. */
  consume(nonce: string): Promise<boolean>
}

// ───────────────────────────────────────────────────────────────────────────
// AgentRepoAuthorizationRepo — explicit repo grants per agent
// (issue #457, agent-multi-repo-authorization.md). Anchored on the AGENT, never
// derived from hooks; `repoId` is the rename-immune match key. Subordinate to
// the agent in the visibility taxonomy (like HookDef): no visibility columns —
// access is gated by the owning agent's canView on the console surface, and the
// mint path reads it viewer-free (data-plane exemption, vis §9).
// ───────────────────────────────────────────────────────────────────────────

/** Three tiers (vs GitAccess's two): `comment` = contents:read + issues/PR:write,
 *  the hook write-back shape — see the clamp matrix in the design doc. */
export type RepoAccess = 'read' | 'comment' | 'write'

export interface AgentRepoAuthorizationRecord {
  id: string
  agentId: AgentId
  repoId: bigint
  repoFullName: string // "owner/repo" as GitHub cases it; refreshed on rename detection
  access: RepoAccess
  createdAt: Date
  createdBy: AgentCreator | null // audit: who authorized (identity-assertion subject)
}

export interface AgentRepoAuthorizationRepo {
  /** Insert a grant. Serialized with workspace-id repair and projection cleanup;
   *  App-backed workspaces reject an implicit workspace match, while manual
   *  GitHub workspaces may explicitly grant that repo and scratch workspaces
   *  may grant any covered repo. */
  create(input: {
    agentId: AgentId
    repoId: bigint
    repoFullName: string
    access: RepoAccess
    createdByUserId?: string
  }): Promise<AgentRepoAuthorizationRecord>
  get(id: string): Promise<AgentRepoAuthorizationRecord | null>
  /** The agent's grants — the console card AND the mint-gate read (viewer-free). */
  listForAgent(agentId: AgentId): Promise<AgentRepoAuthorizationRecord[]>
  /** Raise a grant's capability tier after the caller's GitHub access is re-checked. */
  updateAccess(id: string, access: RepoAccess): Promise<AgentRepoAuthorizationRecord | null>
  /** Best-effort display refresh when the mint gate detects a rename (repoId match
   *  through the slow path); never fails the mint. */
  updateFullName(id: string, repoFullName: string): Promise<void>
  remove(id: string): Promise<void>
  /** Atomically tombstone every durable Check for this numeric repository and
   * remove the grant under the same projection lifecycle lock. If the numeric
   * repo is now the workspace, remove only the redundant grant: workspace
   * authority remains live, so its projections must not be tombstoned. */
  removeWithReviewProjectionCleanup(
    id: string,
    agentId: AgentId,
    repoId: bigint,
    at: Date,
    desiredState: string
  ): Promise<void>
}

// ───────────────────────────────────────────────────────────────────────────
// BotSecretStore (C5) — the ONLY read/write path for token material.
// Every value passes through the configured SecretCipher: `none` stores
// plaintext, while an encrypting provider stores ciphertext without changing
// routes, protocol, or the daemon.
// ───────────────────────────────────────────────────────────────────────────

/** Secret material for one bot. `appToken` is Slack Socket Mode's app-level token
 *  or a Feishu/Lark App ID paired with `botToken`'s App Secret. Feishu HTTP callback
 *  credentials are optional for compatibility with existing platform rows. Every
 *  value is stored through the same cipher boundary. */
export interface BotSecretMaterial {
  botToken: string
  appToken: string | null
  signingSecret: string | null
  verificationToken?: string | null
  encryptKey?: string | null
}

export interface BotSecretStore {
  put(botId: BotId, material: BotSecretMaterial): Promise<void>
  get(botId: BotId): Promise<BotSecretMaterial | null>
  delete(botId: BotId): Promise<void>
}

/** Outcome of a fenced revocation: `applied: false` ⇒ the report was stale and
 *  NOTHING was written, so the caller must skip its external effects too. */
export interface RevokeBotResult {
  applied: boolean
  /** Installs this revocation flipped (empty when refused or already revoked) —
   *  the worklist for pulling send-only specs off member daemons. */
  integrationIds: IntegrationId[]
}

/**
 * The two credential-lifecycle transitions of a shared bot, each ATOMIC and
 * mutually serialized (preset-agents.md §5.3). Both span two tables and are
 * fenced by `bot.credentialRevision`; committing their halves separately opens
 * windows the fence cannot see (a fresh token under a stale generation; a
 * revocation flipping an install a concurrent re-install just activated). Both
 * write the `bot` row, so its row lock also orders install against revoke.
 *
 * Callers use THIS port, not `BotSecretStore.put` + `BotRepo.bumpCredential` /
 * `revokeIfCurrent` in sequence.
 */
export interface BotCredentialWriter {
  /** A fresh credential landed (platform re-install / rotation): store it and
   *  advance the generation as one step. A bot-bound Settings reinstall may
   *  also restore only memberships revoked with the credential being replaced;
   *  all three writes remain one transaction. Returns the new revision. */
  install(
    botId: BotId,
    material: BotSecretMaterial,
    at: Date,
    options?: { restoreRevokedMemberships?: boolean }
  ): Promise<number>
  /** Apply `rc/bot-revoked` behind its generation fence, flipping the bot and
   *  its active installs together. */
  revoke(botId: BotId, at: Date, fence: { revision?: number; eventAt?: Date }): Promise<RevokeBotResult>
}

// ───────────────────────────────────────────────────────────────────────────
// AgentSecretStore — the ONLY read/write path for an agent's write-only secret
// env vars (`agent_secret`, row-per-key). Same seam/discipline as BotSecretStore:
// values never ride the AgentRecord (accidental-serialization guard) and every
// value passes through the configured SecretCipher. `none` is identity storage;
// an encrypting provider supplies at-rest encryption.
// ───────────────────────────────────────────────────────────────────────────

export interface AgentSecretStore {
  /** PATCH-merge, key-by-key: a string value sets/replaces that secret, `null`
   *  deletes it, an omitted key is left untouched (the client never holds values).
   *  This is the standalone row primitive — REST create/PATCH go through
   *  {@link AgentConfigWriter} so the agent row and its secrets commit atomically. */
  merge(agentId: AgentId, patch: Record<string, string | null>): Promise<void>
  /** Every secret of one agent ({} when none) — the wire-projection read
   *  (agent/upsert, register/ok roster, agent/activate). NEVER DTO this. */
  get(agentId: AgentId): Promise<Record<string, string>>
  /** Key names only (sorted), batched for list DTOs — never touches values. */
  keys(agentIds: readonly AgentId[]): Promise<Map<string, string[]>>
}

/**
 * Transactional unit-of-work for an agent's durable configuration: the agent
 * row mutation and its secret-row mutations commit atomically, so a failure
 * between them can never leave a partially-updated definition for reconcile to
 * replicate. Values pass through the configured SecretCipher BEFORE the
 * transaction opens; the prepared stored form is plaintext under `none` and
 * ciphertext under an encrypting provider.
 */
export interface AgentConfigWriter {
  /** Create the agent row + its initial secret rows in one transaction. */
  create(input: CreateAgentInput, secrets?: Record<string, string>): Promise<AgentRecord>
  /** Apply a PATCH: secret merge (see {@link AgentSecretStore.merge} semantics)
   *  + row update in one transaction. */
  update(
    agentId: AgentId,
    patch: UpdateAgentInput,
    secrets?: Record<string, string | null>,
    opts?: AgentUpdateOpts
  ): Promise<AgentRecord>
}

// ───────────────────────────────────────────────────────────────────────────
// ThreadAffinityStore (slack-http-mode §10) — durable per-sessionKey thread
// affinity for http-transport shared bots. Epoch-free, multi-relay (NOT the
// fencing-heavy Assignment table): (botId, sessionKey)→{agentId, daemonId}. The
// CP is the single writer; relays report via rc/thread-assign and pull on miss
// via rc/thread-lookup.
// ───────────────────────────────────────────────────────────────────────────

export interface ThreadAffinityStore {
  upsert(botId: BotId, sessionKey: string, agentId: AgentId, daemonId: DaemonId): Promise<void>
  get(botId: BotId, sessionKey: string): Promise<{ agentId: AgentId; daemonId: DaemonId } | null>
  listForBot(botId: BotId): Promise<{ sessionKey: string; agentId: AgentId; daemonId: DaemonId }[]>
}

// ───────────────────────────────────────────────────────────────────────────
// SlackInstallStore (C5/C6) — short-lived pending rows for the config-token
// auto-install funnel (docs/designs/slack-install-smoothing.md §Tier B). Holds the
// manifest-created app's client credentials + the OAuth-obtained bot token until
// `finalize`; `clientSecret`/`botToken` are read ONLY here, NEVER in a DTO. The
// row `id` doubles as the unforgeable OAuth `state`.
// ───────────────────────────────────────────────────────────────────────────

export interface CreateSlackInstallInput {
  id: string // == OAuth state (random uuid)
  orgId: OrgId
  agentId: AgentId
  appId: string
  clientId: string
  clientSecret: string
  name?: string
  /** Which finalize path this install takes (default socket). */
  transport?: SlackTransport
  /** http: the signing secret captured from apps.manifest.create; null for socket. */
  signingSecret?: string | null
  createdByUserId?: string
}

/** Domain view of a `slack_install` row. Carries secret material — never DTO'd. */
export interface SlackInstallRecord {
  id: string
  orgId: OrgId
  agentId: AgentId
  appId: string
  clientId: string
  clientSecret: string
  botToken: string | null // xoxb-…, backfilled by the OAuth callback
  name: string | null
  transport: SlackTransport // socket|http — chooses the finalize path
  signingSecret: string | null // http: captured at app-create; used at finalize
  createdByUserId: string | null
  createdAt: Date
}

export interface SlackInstallStore {
  create(input: CreateSlackInstallInput): Promise<SlackInstallRecord>
  get(id: string): Promise<SlackInstallRecord | null>
  /** Backfill the OAuth-obtained bot token (xoxb) on the callback. False ⇒ row gone. */
  setBotToken(id: string, botToken: string): Promise<boolean>
  delete(id: string): Promise<void>
  /** TTL sweep: delete pending rows created before `staleBefore`; returns the count. */
  reapExpired(staleBefore: Date): Promise<number>
}

// ───────────────────────────────────────────────────────────────────────────
// SlackPlatformInstallStore — pending installs of the PLATFORM-published
// (distributed) Slack app (preset-agents.md §5.3). No credentials here — those
// are deployment env config; the row only binds the OAuth `state` to tenancy.
// The `id` doubles as the unforgeable OAuth `state`; rows are TTL-reaped
// alongside slack_install.
// ───────────────────────────────────────────────────────────────────────────

export type SlackPlatformInstallStatus = 'pending' | 'completed' | 'failed'

export interface SlackPlatformInstallRecord {
  id: string // == OAuth state (random uuid)
  orgId: OrgId
  /** Generic-install bind target. Null for bot-bound Settings reauthorization,
   *  which preserves the bot's current (possibly empty) membership set. */
  agentId: AgentId | null
  /** Terminal state of the OAuth round trip — the console's completion signal. */
  status: SlackPlatformInstallStatus
  /** Short code (same note the callback's close page shows) when `failed`. */
  failureReason: string | null
  /** Expected Bot fence for Settings reauthorization, or the resulting Bot once
   *  a generic install completes. */
  botId: string | null
  createdByUserId: string | null
  createdAt: Date
  settledAt: Date | null
}

export interface SlackPlatformInstallStore {
  create(input: {
    id: string
    orgId: OrgId
    agentId?: AgentId
    /** Bind OAuth to an existing platform Bot/workspace without changing membership. */
    botId?: BotId
    createdByUserId?: string
  }): Promise<SlackPlatformInstallRecord>
  get(id: string): Promise<SlackPlatformInstallRecord | null>
  /**
   * Record the terminal outcome of the OAuth round trip. Deliberately NOT a
   * delete: the row is the signal the console polls, and a successful
   * RE-authorization creates no new integration, so "an integration appeared"
   * cannot distinguish success from a still-open tab. Only ever settles a
   * `pending` row (a double callback keeps the first outcome).
   */
  settle(
    id: string,
    outcome: { status: 'completed'; botId?: string } | { status: 'failed'; failureReason: string }
  ): Promise<void>
  delete(id: string): Promise<void>
  /** TTL sweep: delete rows created before `staleBefore` (settled or not — a
   *  settled row has already been observed, or the tab is long gone). */
  reapExpired(staleBefore: Date): Promise<number>
}

// ───────────────────────────────────────────────────────────────────────────
// FeishuAppRegistrationStore — resumable one-click app registration. Device
// cursor and provisional App Secret are encrypted behind the implementation;
// terminal settlement clears both. A short claim leases provider/finalize work
// to one CP replica at a time.
// ───────────────────────────────────────────────────────────────────────────

export type FeishuAppRegistrationStatus = 'pending' | 'authorized' | 'completed' | 'failed'

export interface FeishuAppRegistrationRecord {
  id: string
  targetKey: string | null
  orgId: OrgId
  agentId: AgentId
  requestedName: string | null
  fallbackRegion: FeishuRegion
  transport: SlackTransport
  authorizationUrl: string
  providerDomain: string
  deviceCode: string | null
  intervalMs: number
  nextPollAt: Date
  expiresAt: Date
  status: FeishuAppRegistrationStatus
  failureReason: string | null
  appId: string | null
  appSecret: string | null
  resolvedRegion: FeishuRegion | null
  botId: BotId
  integrationId: IntegrationId
  createdByUserId: string | null
  claimToken: string | null
  claimedUntil: Date | null
  createdAt: Date
  settledAt: Date | null
}

export interface CreateFeishuAppRegistrationInput {
  id: string
  targetKey: string
  orgId: OrgId
  agentId: AgentId
  requestedName?: string
  fallbackRegion: FeishuRegion
  transport: SlackTransport
  authorizationUrl: string
  providerDomain: string
  deviceCode: string
  intervalMs: number
  nextPollAt: Date
  expiresAt: Date
  botId: BotId
  integrationId: IntegrationId
  createdByUserId: string
}

export interface FeishuAppRegistrationStore {
  create(input: CreateFeishuAppRegistrationInput): Promise<FeishuAppRegistrationRecord>
  get(id: string): Promise<FeishuAppRegistrationRecord | null>
  getActiveTarget(targetKey: string): Promise<FeishuAppRegistrationRecord | null>
  /** Atomically fail an expired open row and release its target reservation. */
  expire(id: string, now: Date): Promise<void>
  /** Clear an expired target reservation before a new begin call. */
  expireTarget(targetKey: string, now: Date): Promise<void>
  /** Lease due provider/finalization work to one replica. */
  claim(id: string, claimToken: string, now: Date, claimedUntil: Date): Promise<FeishuAppRegistrationRecord | null>
  release(
    id: string,
    claimToken: string,
    update: { providerDomain?: string; intervalMs: number; nextPollAt: Date }
  ): Promise<void>
  authorize(
    id: string,
    claimToken: string,
    input: { appId: string; appSecret: string; region: FeishuRegion }
  ): Promise<FeishuAppRegistrationRecord | null>
  /** Release a finalized-credential claim for a short-lived placement retry. */
  releaseAuthorized(id: string, claimToken: string): Promise<void>
  settle(
    id: string,
    claimToken: string,
    outcome: { status: 'completed' } | { status: 'failed'; failureReason: string }
  ): Promise<void>
  /** Delete terminal/expired rows whose secret-bearing window is over. */
  reapExpired(staleBefore: Date): Promise<number>
}

// ───────────────────────────────────────────────────────────────────────────
// PresetAgentStore — per-org preset provisioning state (preset-agents.md §3.2).
// Rows are WRITTEN by the org-creation seam / the one-time backfill / the
// settle-stamp anchors (persistence-internal); this port is the READ surface for
// routes (the platform Slack install's default bind target) and, later, the
// onboarding checklist.
// ───────────────────────────────────────────────────────────────────────────

// The ONLY preset: the dedicated assistant preset was cancelled — assistant/admin
// capabilities are planned to fold into the general agent's webapp sessions instead.
export type PresetAgentKind = 'general'

export interface PresetAgentRecord {
  orgId: OrgId
  preset: PresetAgentKind
  /** Null once the preset agent was deleted (SetNull), or for a `skipped` row. */
  agentId: AgentId | null
  status: 'created' | 'skipped'
  /** First placement of any kind — or an explicit opt-out — stamps this; M1
   *  auto-placement only ever considers an unplaced, UNSTAMPED preset. */
  placementSettledAt: Date | null
  createdAt: Date
}

export interface PresetAgentStore {
  get(orgId: OrgId, preset: PresetAgentKind): Promise<PresetAgentRecord | null>
}

// ───────────────────────────────────────────────────────────────────────────
// SlackUserConfigStore (C5) — one user's stored App Configuration Token, scoped
// to an org (docs/designs/slack-install-smoothing.md §Tier B). PER-USER: the app
// `apps.manifest.create` builds belongs to whoever's token created it, so each
// initiator stores their own. Carries secret material behind the same seam as
// bot_secret; the tokens are read ONLY here, never in a DTO.
// ───────────────────────────────────────────────────────────────────────────

/** The token material + its rotation clock. Written on save and on each rotate. */
export interface SlackUserConfigMaterial {
  accessToken: string // xoxe.xoxp-…
  refreshToken: string | null // xoxe-… — null ⇒ access-only (no auto-rotate; re-enter after it expires)
  accessExpiresAt: Date // when accessToken expires (drives rotation / re-entry)
}

export interface SlackUserConfigRecord extends SlackUserConfigMaterial {
  orgId: OrgId
  userId: string
  updatedAt: Date
}

export interface SlackUserConfigStore {
  get(orgId: OrgId, userId: string): Promise<SlackUserConfigRecord | null>
  /** Upsert the caller's config (save from the console, or overwrite with a rotated pair). */
  put(orgId: OrgId, userId: string, material: SlackUserConfigMaterial): Promise<void>
  delete(orgId: OrgId, userId: string): Promise<void>
}

// ───────────────────────────────────────────────────────────────────────────
// IntegrationRepo (C6) — platform integration metadata (NO tokens)
// ───────────────────────────────────────────────────────────────────────────

export type IntegrationStatus = 'active' | 'revoked'

export interface CreateIntegrationInput {
  id: IntegrationId
  orgId: OrgId
  agentId: AgentId // owner ⇒ delivery daemon (agent.daemonId)
  botId: BotId // the identity this install runs as (1 bot : ≤1 install)
  platform: Platform // 'slack'
  name: string
  feishuRegion?: FeishuRegion // feishu/lark gateway; only set for platform 'feishu'
  createdByUserId?: string
}

/** Domain view of an `integration` row. NEVER carries token material. */
export interface IntegrationRecord {
  id: IntegrationId
  orgId: OrgId
  agentId: AgentId
  botId: BotId
  platform: Platform
  name: string
  status: IntegrationStatus
  /** Feishu/Lark gateway region; undefined for non-feishu integrations (and for
   *  feishu rows created before the region column — treated as 'feishu'). */
  feishuRegion?: FeishuRegion
  createdAt: Date
}

export interface IntegrationRepo {
  create(input: CreateIntegrationInput): Promise<IntegrationRecord>
  /**
   * Atomic bot-membership admission — EVERY multi-agent bot admission (the
   * platform "Add to Slack" re-install and the generic `POST /integrations`
   * reuse, preset-agents.md §5.5) funnels here: locks the bot row, re-reads
   * `shareable` + `revokedAt` and the ACTIVE membership set inside the SAME
   * transaction as the insert, and admits at most one active row per
   * (bot, agent) — `'exists'` returns the winner's row as the idempotent
   * success for a duplicate concurrent admission, `'not_shareable'` is the
   * §5.5 refusal (another agent holds a non-shared bot), `'revoked'` refuses
   * admission onto a dead credential (a revoke that won the lock flipped every
   * install; zero-active must not read as "free"). Serialized with
   * {@link BotRepo.setShareable} and {@link BotCredentialWriter.revoke} on the
   * same bot-row lock.
   */
  addBotMembership(
    input: CreateIntegrationInput
  ): Promise<
    | { outcome: 'added' | 'exists'; integration: IntegrationRecord }
    | { outcome: 'not_shareable' }
    | { outcome: 'revoked' }
  >
  get(id: IntegrationId): Promise<IntegrationRecord | null>
  /** Every integration in the org. When a human principal is supplied,
   *  integrations whose parent agent is restricted away from them are filtered
   *  out; undefined alone keeps internal reads unfiltered. */
  listForOrg(orgId: OrgId, viewer?: ViewCtx): Promise<IntegrationRecord[]>
  /** Every active integration owned by one agent (cold placement-move snapshot). */
  listForAgent(agentId: AgentId): Promise<IntegrationRecord[]>
  /**
   * Active integrations whose owning agent is placed on `daemonId` — the
   * per-daemon `register/ok.integrations[]` set. FILTERED to this daemon (never
   * org-wide) since the delivered spec carries plaintext tokens.
   */
  activeForDaemon(daemonId: DaemonId): Promise<IntegrationRecord[]>
  /**
   * The agents present in a channel (agent-collaboration directory, §channel).
   * Joins the channel's active integrations to their agents, ACROSS all daemons
   * (the CP is the only authority for the full roster). Metadata only. Deduped
   * by agent (an agent could reach a channel via more than one integration).
   */
  agentsInChannel(orgId: OrgId, platform: Platform, channelId: string): Promise<ChannelAgentRecord[]>
  /**
   * The bot-AGNOSTIC collaboration placement snapshot for one org (agent-collaboration
   * §2.3/§6.2): every `(platform, channelId)` an active integration reaches, mapped to
   * its agents' placement plus inbound and outbound collaboration policies.
   * Unlike {@link IntegrationRepo.agentsInChannel} this carries the DEFINITE
   * `daemonId`/`integrationId` the relay routes on. Metadata only — no tokens.
   */
  channelPlacements(orgId: OrgId): Promise<ChannelPlacementRecord[]>
  /** Every ACTIVE integration installed on `botId` (all agents sharing a shared
   *  bot). The shared-bot route compiler's member set. Ordered by createdAt (the
   *  earliest is the group's default agent). */
  listForBot(botId: BotId): Promise<IntegrationRecord[]>
  /** Flip every ACTIVE integration of `botId` to `revoked` (workspace uninstall /
   *  token revocation), recording the credential generation that owned it.
   *  Returns the affected integration ids. */
  markRevokedForBot(botId: BotId, credentialRevision: number): Promise<IntegrationId[]>
  /** Restore memberships revoked with exactly `credentialRevision`. Historical
   *  revoked rows and deliberately deleted/free memberships stay untouched. */
  restoreRevokedForBot(botId: BotId, credentialRevision: number): Promise<number>
  delete(id: IntegrationId): Promise<void>
}

/** One agent visible in a channel — the collaboration directory entry (metadata only). */
export interface ChannelAgentRecord {
  agentId: AgentId
  name: string
  displayName: string | null
  description: string | null
  status: 'active' | 'inactive' | 'paused'
  /** Call authorization — lets the directory lookup filter out peers the requester
   *  is not allowed to call (§2.5/§6.1), so non-callable peers aren't even discovered. */
  callPolicy: AgentCallPolicy
  allowedCallerAgentIds: string[]
  /** Caller-side discovery/call authorization. */
  outboundPolicy: AgentCallPolicy
  allowedTargetAgentIds: string[]
}

/** One agent's DEFINITE placement in a channel — the bot-agnostic collaboration
 *  routing/authorization record (agent-collaboration §2.3/§6.2). */
export interface ChannelPlacementRecord {
  platform: Platform
  channelId: string
  agentId: AgentId
  /** Owning daemon (may be null if the agent is not yet placed — such rows are
   *  dropped from the routable snapshot). */
  daemonId: string | null
  integrationId: IntegrationId
  /** Public platform app identity used to recognize messages from another
   *  AgentConnect-managed bot. Currently populated for Slack (`A…`). */
  botAppId?: string
  callPolicy: AgentCallPolicy
  allowedCallerAgentIds: string[]
  outboundPolicy: AgentCallPolicy
  allowedTargetAgentIds: string[]
  /** Directory name (slug) + optional human display name — carried into the collab
   *  snapshot so any daemon can label this agent by name in a visible agent-call post. */
  name: string
  displayName?: string
}

// ───────────────────────────────────────────────────────────────────────────
// IntegrationChannelRepo (C6) — daemon-reported conversation membership + the
// per-conversation trigger choice ('off' / '@-mention' / 'any message'). Names
// and ids are control metadata, never message content.
// ───────────────────────────────────────────────────────────────────────────

export type ChannelTrigger = 'off' | 'mention' | 'any'

/** Member channel vs direct conversation (resource-visibility.md §14.3). `mpim` is a
 *  Slack group DM: observed like an `im`, mention-gated like a channel. */
export type ConversationKind = 'channel' | 'im' | 'mpim'

/** A conversation the bot was never invited to and that is never enumerated — a DM or a
 *  Slack group DM. Its row exists only because observation created it, which is why a
 *  preserved one is inert for a non-gated owner: there is no console control over it. */
export function isDirectConversationKind(kind: ConversationKind | undefined): boolean {
  return kind === 'im' || kind === 'mpim'
}

/** One conversation the integration's bot participates in, as reported by the daemon. */
export interface IntegrationChannelRecord {
  integrationId: IntegrationId
  channelId: string
  name: string | null
  /** Enclosing space (Discord guild) — `spaceId` is the identity (two guilds may
   *  share a name), `space` the display label. Null on single-container platforms,
   *  on DM rows, and until the daemon has resolved them. */
  spaceId: string | null
  space: string | null
  isPrivate: boolean
  kind: ConversationKind
  /** Repeated across shared-channel sibling rows; integration-scoped for DMs. */
  trigger: ChannelTrigger
  /** Per-channel owner for a shared bot (§10.1); null on sibling non-owner rows. */
  agentId: AgentId | null
}

/** Daemon-reported conversation (no trigger — that is operator-owned CP state). */
export interface ReportedChannel {
  id: string
  name?: string
  /** Enclosing Discord guild — id (the identity) and display name. Absent on other
   *  platforms and until resolved. */
  spaceId?: string
  space?: string
  isPrivate?: boolean
  /** Absent = 'channel' (wire compatibility). */
  kind?: ConversationKind
}

export interface IntegrationChannelRepo {
  /**
   * Converge to the daemon's channel report (latest-wins): upsert every reported
   * conversation (refreshing name/isPrivate, PRESERVING the stored trigger).
   * Authoritative membership snapshots delete kind='channel' rows the bot is no
   * longer a member of; non-authoritative observed-conversation reports retain
   * missing rows because platforms such as Telegram cannot enumerate all chats.
   * DM (kind='im') rows are always retained. `defaultTrigger` seeds NEW rows only
   * ('off' for a gated integration, 'mention' otherwise); existing rows keep
   * their trigger.
   */
  replaceSnapshot(
    integrationId: IntegrationId,
    channels: ReportedChannel[],
    opts?: { defaultTrigger?: ChannelTrigger; authoritative?: boolean }
  ): Promise<void>
  listForIntegration(integrationId: IntegrationId): Promise<IntegrationChannelRecord[]>
  /** Incremental conversation upsert (§14.3, DM rows): create the row (kind, name,
   *  `agentId`, `defaultTrigger`) when absent; when it exists refresh only the name
   *  — trigger and agentId are operator-owned once created. */
  upsertConversation(
    integrationId: IntegrationId,
    conversation: ReportedChannel,
    opts?: { agentId?: AgentId | null; defaultTrigger?: ChannelTrigger }
  ): Promise<IntegrationChannelRecord>
  /** Channels across EVERY integration of a shared bot — the route compiler's
   *  channel-ownership source. */
  listForBot(botId: BotId): Promise<IntegrationChannelRecord[]>
  /** Per-channel trigger choice; returns null when the channel row doesn't exist. */
  setTrigger(
    integrationId: IntegrationId,
    channelId: string,
    trigger: ChannelTrigger
  ): Promise<IntegrationChannelRecord | null>
  /** Set or clear this integration row's owner marker. The orchestrator keeps
   *  exactly one row marked per shared channel. Returns null when missing. */
  setAgent(
    integrationId: IntegrationId,
    channelId: string,
    agentId: AgentId | null
  ): Promise<IntegrationChannelRecord | null>
  /** Set the channel's owning agent, CREATING the row if absent. A shared bot's
   *  ingest is on the relay, so the daemon never reports its channels — the config
   *  modal must be able to name a channel the CP has never seen. `defaultTrigger`
   *  seeds a CREATED row only ('off' for a gated owner, §14); an existing row
   *  keeps its trigger. */
  upsertAgent(
    integrationId: IntegrationId,
    channelId: string,
    agentId: AgentId,
    opts?: { defaultTrigger?: ChannelTrigger }
  ): Promise<IntegrationChannelRecord>
}

// ───────────────────────────────────────────────────────────────────────────
// RuntimeProfileRepo (C4) — observed runtime capabilities (§3.4)
// ───────────────────────────────────────────────────────────────────────────

export interface RuntimeProfileRecord {
  id: string
  daemonId: DaemonId
  runtime: string
  version: string
  models: string[]
  contextWindow: number | null
  acpSupport: AcpSupport
  acpProtocolVersion: number | null
  toolCalling: boolean
  /** MCP transports advertised at ACP initialize; null ⇒ not probed / older daemon (assume stdio-only). */
  mcpCapabilities: { http: boolean; sse: boolean } | null
  /** Discovered model × config capability matrix (runtime-model-catalog.md §5);
   *  null ⇒ the daemon reported no catalog for this runtime. */
  modelCatalog: RuntimeModelCatalog | null
  /** Provenance of `models[]`: 'cached' = hydrated last-good (capability gates
   *  treat it as permissive), 'probed' = confirmed live; null ⇒ older daemon
   *  (probed semantics). */
  modelsSource: 'cached' | 'probed' | null
  /** The daemon's last probe was rejected with the ACP auth-required error
   *  (-32000): installed but needing a login on the daemon host. */
  authRequired: boolean
  /** When the daemon last reported this profile. */
  observedAt: Date
}

export interface RuntimeProfileRepo {
  /** Upsert on `(daemonId, runtime)` from `facts/runtime-profile`. */
  record(daemonId: DaemonId, f: FactsRuntimeProfile, at: Date): Promise<RuntimeProfileRecord>
  /**
   * Reconcile the daemon's stored runtimes to exactly `runtimes[]` (from
   * `facts/daemon-runtimes`): upsert every entry, delete the rest — so runtimes
   * uninstalled from the machine stop being offered by the console. When `seq`
   * is given, the replace is fenced by the daemon's stored snapshot ordinal (a
   * CAS inside the same transaction): a stale snapshot writes nothing. Returns
   * whether the snapshot was applied (false ⇒ dropped as stale).
   */
  replaceAll(daemonId: DaemonId, runtimes: FactsRuntimeProfile[], at: Date, seq?: number): Promise<boolean>
  forDaemon(daemonId: DaemonId): Promise<RuntimeProfileRecord[]>
  /** Batch variant for the fleet read model (`GET /daemons`) — avoids an N+1 per daemon. */
  forDaemons(daemonIds: DaemonId[]): Promise<RuntimeProfileRecord[]>
}

// ───────────────────────────────────────────────────────────────────────────
// AuditRepo (C6/C7) — append-only events feed (§3.12)
// ───────────────────────────────────────────────────────────────────────────

export interface AuditInput {
  kind: AuditKind
  orgId?: OrgId
  daemonId?: DaemonId
  agentId?: AgentId
  sessionId?: SessionId
  actorUserId?: string
  frameType?: string
  frameCorr?: string
  message?: string
  details?: Record<string, unknown>
}

export interface AuditRecord {
  id: bigint
  kind: AuditKind
  daemonId: DaemonId | null
  agentId: AgentId | null
  message: string | null
  details: unknown
  createdAt: Date
}

export interface AuditRepo {
  append(input: AuditInput): Promise<AuditRecord>
  recent(limit: number): Promise<AuditRecord[]>
}

// ───────────────────────────────────────────────────────────────────────────
// UserRepo (C2) — WebUI identity, JIT-provisioned from a verified OIDC `sub`
// ───────────────────────────────────────────────────────────────────────────

/** Domain suffix for the placeholder email synthesized when a token carried no
 *  `email` claim. Read paths treat such addresses as "no email" (never displayed). */
export const SYNTHETIC_EMAIL_SUFFIX = '@oidc.local'

/** True for a synthesized placeholder email (no real `email` claim was present). */
export function isSyntheticEmail(email: string | null | undefined): boolean {
  return !!email && email.endsWith(SYNTHETIC_EMAIL_SUFFIX)
}

/** What the human-auth plane needs to resolve a verified token to a local user. */
export interface ProvisionOidcUserInput {
  /** The verified OIDC `sub` claim — the stable external identity key. */
  oidcSubject: string
  /**
   * The user's email. Absent ⇒ a synthetic placeholder is stored, upgraded to
   * the real email once a verified one is known.
   */
  email?: string
  /**
   * True only when `email` came from a VERIFIED source (a signed token claim —
   * see `http/plugins/auth.ts`). Only a verified email may claim invited member
   * rows, upgrade a synthetic placeholder, or be stored as the user's address;
   * an unverified one could squat someone else's identity and inherit their
   * invited memberships.
   */
  emailVerified?: boolean
  /** Display name from the token (`name` claim), stored on first sight. */
  displayName?: string
  /** Avatar URL from the `picture` claim. Display-only (no verification gate);
   *  stored on first sight and refreshed on later sign-ins when it changes. */
  picture?: string
}

/** A membership's role — mirrors the Prisma `OrgRole` enum (§3.2). */
export type OrgMemberRole = 'owner' | 'collaborator' | 'viewer'

/** One workspace member for the console Settings page: the `membership` row
 *  joined with its `app_user`. Never exposes `oidcSubject`. */
export interface OrgMemberRecord {
  userId: string
  /** The user's real email; null when only a synthetic placeholder is stored. */
  email: string | null
  displayName: string | null
  /** Avatar URL from the OIDC `picture` claim; null until they've signed in with one. */
  picture: string | null
  /** Set when this member selected an uploaded profile photo. */
  profilePictureUpdatedAt: Date | null
  role: OrgMemberRole
  /** When this user joined THIS org (`membership.createdAt`). */
  joinedAt: Date
}

/** The five resource kinds whose ownership transfers when a member leaves. */
export type OwnedResourceKind = 'agent' | 'daemon' | 'cron' | 'mcpProvider' | 'skillSource'

/**
 * What removing one member would do, read before the fact (resource-visibility.md
 * §8.2). The console shows it in the leave/remove confirmation so the transfer is
 * predictable rather than discovered afterwards: a restricted resource is reached
 * through its ownership arm OR an explicit share, so where the arm lands decides
 * who can still find the ones nobody else was given.
 */
export interface MemberRemovalPreview {
  /** The member who inherits ownership; null when removal would be refused
   *  (the departing member is the last owner). */
  transferTo: OrgMemberRecord | null
  /** Per-kind counts of the departing member's owned resources; kinds they own
   *  nothing of are omitted. */
  resources: Array<{
    kind: OwnedResourceKind
    owned: number
    /** Not org-visible: reachable only via ownership or `sharedWith`. */
    restricted: number
    /** The subset of `restricted` that `transferTo` alone would be able to see —
     *  no remaining member holds a share. This, not `restricted`, is what
     *  disappears from everyone else's console, so it is the number the dialog
     *  warns about. Counted against CURRENT membership: a `sharedWith` id that
     *  is no longer a member cannot see anything either. */
    recipientOnly: number
  }>
}

/** The caller's own profile (the console `/me` surface). */
export interface UserProfileRecord {
  userId: string
  /** The user's real email; null when only a synthetic placeholder is stored.
   *  Deliberately NOT updatable — the OIDC provider owns it (plus the
   *  invite-claim logic in `provisionOidcUser`). */
  email: string | null
  displayName: string | null
  /** Avatar URL from the OIDC `picture` claim; it remains the fallback when the
   *  user removes their uploaded profile photo. */
  picture: string | null
  /** Set when this user selected an uploaded profile photo. */
  profilePictureUpdatedAt: Date | null
}

/** One org from the caller's perspective (the console org picker / Settings). */
export interface OrgRecord {
  id: string
  /** Optional display name; null falls back to `slug` in the console. */
  name: string | null
  slug: string
  /** Console avatar descriptor (protocol AgentIcon); null ⇒ generated default. */
  icon: AgentIcon | null
  /** The asking user's role in it. */
  role: OrgMemberRole
  memberCount: number
  /** Registered daemons (any status) — the console's cross-org onboarding signal. */
  daemonCount: number
  createdAt: Date
  /** Last update — the icon endpoint's `?v=` cache-buster for an uploaded org icon. */
  updatedAt: Date
}

export interface OrgDeleteResult {
  status: 'deleted' | 'review_cleanup_pending' | 'daemons_present'
  /** Hook rules made inert by the same transaction; callers remove them from
   * the relay pool after commit. */
  removedHookIds: string[]
}

export interface UserRepo {
  /**
   * Just-in-time provision (or fetch) the local user behind a verified OIDC `sub`.
   * First sight of a subject = signup: the user row is created (or an invited,
   * email-only row is claimed by setting its `oidcSubject`) AND a personal org is
   * created with the user as its `owner` — so everyone lands in a workspace they
   * own. Later calls are a cheap idempotent fetch (plus the synthetic-email
   * upgrade). Org selection is per-request (`resolveOrgContext`), not stored here.
   */
  provisionOidcUser(input: ProvisionOidcUserInput): Promise<{ userId: string }>

  /**
   * Does this user row still exist? The human-auth plane asks per authenticated
   * request, because an admin can delete an account out from under a live browser
   * session (and under the auth plane's `sub → userId` memo). False ⇒ the caller's
   * identity is gone: the session is rejected so the client signs out, rather than
   * silently re-provisioning a new account behind the old session.
   */
  exists(userId: string): Promise<boolean>

  /**
   * Record that `oidcSubject`'s local account was found deleted at `cutoffAt`, so
   * the decision outlives this process (a restart would forget an in-memory one, and
   * a restart is exactly when a live pre-deletion session would slip through and
   * re-provision). `expiresAt` keeps it expiry-limited — a boundary, not a ban.
   * Idempotent: a later cutoff wins; an earlier one never moves the boundary back.
   * Also prunes expired rows.
   */
  recordDeletedIdentity(oidcSubject: string, cutoffAt: Date, expiresAt: Date): Promise<void>

  /**
   * The recorded cutoff for `oidcSubject`, or null when there is none or it has
   * expired at `now`. Read once per subject per process (first sight), never on the
   * hot path.
   */
  deletedIdentityCutoff(oidcSubject: string, now: Date): Promise<Date | null>

  /**
   * Restore a membership-less user's personal org (an interrupted signup must
   * not brick the account). No-op when the user already owns an org or the
   * user row is gone. `GET /orgs` calls this when the list comes back empty.
   */
  healPersonalOrg(userId: string): Promise<void>

  /** The org's members (oldest first) for the console Settings page. */
  listMembers(orgId: string): Promise<OrgMemberRecord[]>

  /**
   * Change one member's role under the organization owner-transition lock.
   * Rechecks that the actor is still an owner and refuses to demote the final
   * owner before committing.
   */
  setMemberRole(orgId: string, userId: string, role: OrgMemberRole, actingUserId: string): Promise<OrgMemberRecord>

  /**
   * Add a member directly by email (no email is sent). An existing user gains a
   * membership immediately; an unknown email creates an invited user row (no
   * `oidcSubject`) that its owner claims on first SSO sign-in. Throws Prisma
   * P2002 (→ 409) when the user is already a member.
   */
  addMemberByEmail(orgId: string, email: string, role: OrgMemberRole): Promise<OrgMemberRecord>

  /**
   * Let a member leave, or let an owner remove another member. Chooses the
   * transfer recipient, transfers all resource ownership, and prunes share
   * grants atomically. Rechecks membership and, when removing another member,
   * the acting owner's role. Refuses to remove the final owner before committing.
   */
  removeMember(orgId: string, userId: string, actingUserId: string): Promise<void>

  /**
   * Dry-run of `removeMember` for the confirmation dialog: the same recipient
   * rule, plus what that member currently owns. Racy by nature (nothing is
   * locked) — advisory display only, never an authorization input.
   */
  previewMemberRemoval(orgId: string, userId: string, actingUserId: string): Promise<MemberRemovalPreview>

  /** Attach a known user to an org. */
  addMember(orgId: string, userId: string, role: OrgMemberRole): Promise<void>

  /** The caller's own profile (`GET /me`); null when the row is gone. */
  getProfile(userId: string): Promise<UserProfileRecord | null>

  /** Self-service display-name edit (`PATCH /me`). Email remains immutable here;
   * profile-photo bytes have their own validated upload route. Throws P2025 (→ 404)
   * when the row is gone. */
  updateProfile(userId: string, patch: { displayName: string }): Promise<UserProfileRecord>

  /** Mark an uploaded profile photo as active. The object-store write happens at
   * the HTTP edge before this durable pointer is changed. */
  setProfilePicture(userId: string, updatedAt: Date): Promise<UserProfileRecord>
  /** Remove the custom-photo marker so the OIDC picture becomes visible again. */
  clearProfilePicture(userId: string): Promise<UserProfileRecord>

  /**
   * The user's OIDC `sub` — the ONLY place it leaves persistence, feeding the
   * github user-authz identity assertion (Logto Mgmt lookup). Null for rows
   * without one (invited-not-yet-signed-in, seeded dev users) — callers treat
   * that as "no identity", never as a pass.
   */
  getOidcSubject(userId: string): Promise<string | null>
}

export interface OrgRepo {
  /** Every org the user belongs to, with their role — insertion order. */
  listForUser(userId: string): Promise<OrgRecord[]>
  /** Create an org with `ownerUserId` as its first owner (one transaction). */
  create(input: { name: string | null; slug: string; ownerUserId: string }): Promise<OrgRecord>
  /** Rename / re-slug / re-icon an org. Throws P2025 when absent, P2002 on a slug collision. */
  update(
    orgId: string,
    patch: { name?: string | null; slug?: string; icon?: AgentIcon | null }
  ): Promise<{ id: string; name: string | null; slug: string }>
  /** Set the org's console icon descriptor (the upload/delete path). Bumps `updatedAt`
   *  so the icon endpoint's `?v=` cache-buster changes. Throws P2025 when absent. */
  setIcon(orgId: string, icon: AgentIcon | null): Promise<{ id: string; updatedAt: Date }>
  /** The org's icon descriptor + last-update time, by id — the public icon endpoint's
   *  read (no membership needed). Null when the org is absent. */
  iconById(orgId: string): Promise<{ icon: AgentIcon | null; updatedAt: Date } | null>
  /** The user's role in the org; null when not a member. */
  roleOf(orgId: string, userId: string): Promise<OrgMemberRole | null>

  /** The org's slug (its URL segment in the console), or null when the org is absent.
   *  Used to build org-scoped session deep links (`<webAppUrl>/<slug>/sessions/<id>`). */
  slugById(orgId: string): Promise<string | null>

  /**
   * Hard-delete an org. Cascades memberships, agents, crons, integrations,
   * bots and api-keys via the schema's referential actions; the Daemon FK is
   * RESTRICT on purpose (physical machines) — callers refuse deletion while
   * the org still has daemons. Throws P2025 when absent.
   */
  delete(orgId: string): Promise<OrgDeleteResult>
}

// ───────────────────────────────────────────────────────────────────────────
// OrgInviteLinkRepo — one fixed collaborator invite per org
// ───────────────────────────────────────────────────────────────────────────

export interface OrgInviteLinkRecord {
  id: string
  orgId: string
  tokenHash: string
  displayTail: string
  expiresAt: Date
  revokedAt: Date | null
  createdByUserId: string | null
  createdAt: Date
}

export interface OrgInviteAcceptOrg {
  id: string
  slug: string
  name: string | null
}

export type OrgInviteAcceptResult =
  { status: 'accepted' | 'already_member'; org: OrgInviteAcceptOrg } | { status: 'unavailable' }

// ───────────────────────────────────────────────────────────────────────────
// WaitlistRepo — closed-beta admission
//   The CP-side surface only: read a user's admission state, let a signed-in user
//   add THEMSELVES (pending), and redeem an admin-minted join link (the ONLY writer
//   of the redemption columns + User.activatedAt). Approval / minting / admin auth
//   live in the external admin app and are NOT represented here.
// ───────────────────────────────────────────────────────────────────────────

export type WaitlistEntryStatus = 'pending' | 'approved' | 'rejected'

/** Everything `/me/access` needs, read from trusted persistence by userId (§5/§8):
 *  never from a client-supplied header. `email` is null for a synthetic placeholder
 *  address (never a real verified email — treated as "no email"), in which case
 *  `entryStatus` is not looked up (stays null). */
export interface WaitlistAccessState {
  /** User.activatedAt != null — a formal user. */
  activated: boolean
  /** How many orgs the user is a member of (>0 ⇒ an invited member passes the gate). */
  orgCount: number
  /** The user's real verified email, or null when only a synthetic placeholder exists. */
  email: string | null
  /** The user's waitlist entry status keyed by `email`; null when no entry (or no email). */
  entryStatus: WaitlistEntryStatus | null
}

export type WaitlistRedeemResult =
  | { status: 'activated' } // the user is now formal (idempotent on repeat)
  | { status: 'invalid' } // unknown / not-approved / revoked / expired token, or redeemed by another
  | { status: 'email_mismatch'; expectedEmail: string } // link was minted for a different email

export interface WaitlistRepo {
  /** Read the caller's admission state by their (trusted) user id. */
  accessState(userId: string): Promise<WaitlistAccessState>
  /**
   * Idempotently add the caller's OWN verified email as a `pending` entry. A
   * pre-existing entry is left UNCHANGED (a `rejected` one stays rejected — §11 —
   * and an approved/pending one is not disturbed); returns the resulting status.
   * `note` is the applicant's self-submitted intake (opaque JSON string, written
   * only on the CREATE path) — context for the admin app, never the email source.
   * `name` is the intake display name, mirrored into the `name` column on CREATE.
   */
  addSelf(email: string, note?: string, name?: string): Promise<WaitlistEntryStatus>
  /**
   * Redeem an admin-minted join link for a signed-in user (single transaction,
   * row-level `FOR UPDATE`, waitlist-and-login.md §6). On success sets
   * `User.activatedAt`, creates the personal org, and stamps `redeemed*` (including
   * `redeemedEmail`). Conditional email binding: a BOUND entry (email set) must match
   * `verifiedEmail` (already normalized) or the redeem fails `email_mismatch`; a
   * BEARER entry (email null) skips the match and any verified identity may redeem it
   * once — except an ALREADY-ACTIVATED account, which is admitted WITHOUT consuming
   * the link (nothing to grant, so the one-time invite stays available).
   * Idempotent: a repeat by the SAME user returns `activated`.
   */
  redeem(tokenHash: string, userId: string, verifiedEmail: string, now: Date): Promise<WaitlistRedeemResult>
}

// ───────────────────────────────────────────────────────────────────────────
// MCP provider registry (docs/designs/centralized-tool-management.md §5-§7)
//   McpProvider = the org-level definition of an upstream MCP server. The CP
//   proxies it through a relay: agents get a proxy URL + grant key, never the
//   upstream url/credential. Three ports mirror the Bot/Integration precedent:
//   - McpProviderRepo       — metadata (NEVER selects secret material)
//   - McpProviderSecretStore — upstream auth headers (store-only, like BotSecretStore)
//   - McpGrantRepo          — bearer grant keys (store returns plaintext; persisted
//                             values pass through SecretCipher)
// ───────────────────────────────────────────────────────────────────────────

/** v1 accepts `http` only (`sse` rejected at the API edge; `stdio` never applies). */
export type McpTransport = 'http' | 'sse'

/** How the provider row was created: an operator-entered upstream (`custom`) or a
 *  connection provisioned through the open-connector integration (`open_connector`).
 *  Display + create-flow discriminator only — the relay/daemon wire is identical. */
export type McpProviderKind = 'custom' | 'open_connector'

/** Domain view of an `mcp_provider` row. A Shareable (owner + visibility +
 *  sharedWith), so the same OSS authorization policy as agents applies.
 *  `url` is the non-secret upstream endpoint (may appear in DTOs); the upstream auth
 *  headers live in McpProviderSecretStore, the grant keys in McpGrantRepo — NEITHER
 *  ever rides this record. */
export interface McpProviderRecord extends Shareable {
  id: string // uuid — rides the wire as rc/mcp-assign.providerId
  orgId: OrgId
  name: string // reference key (unique per org); the agent enable-list keys on it
  kind: McpProviderKind
  transport: McpTransport
  url: string
  createdByUserId: string | null
  createdAt: Date
  updatedAt: Date
}

export interface CreateMcpProviderInput {
  orgId: OrgId
  name: string
  url: string
  kind?: McpProviderKind // default 'custom'
  transport?: McpTransport // default 'http'
  visibility?: ResourceVisibility // default 'org'
  sharedWith?: string[] // app_user.id set (only meaningful when visibility='restricted')
  createdByUserId?: string
  ownerUserId?: string // defaults to createdByUserId
}

export interface UpdateMcpProviderInput {
  name?: string
  url?: string
  transport?: McpTransport
}

export interface McpProviderRepo {
  create(input: CreateMcpProviderInput): Promise<McpProviderRecord>
  get(id: string): Promise<McpProviderRecord | null>
  /** The org's providers, filtered to what a supplied human principal may see
   *  (org-visible OR owned-by-them OR shared-with-them). Undefined is reserved
   *  for unfiltered internal reads. */
  listForOrg(orgId: OrgId, viewer?: ViewCtx): Promise<McpProviderRecord[]>
  /** Set visibility + share set (console access only; never crosses the wire). */
  setSharing(
    id: string,
    sharing: { visibility: ResourceVisibility; sharedWith: string[] },
    byUserId?: string
  ): Promise<McpProviderRecord>
  update(id: string, patch: UpdateMcpProviderInput): Promise<McpProviderRecord>
  delete(id: string): Promise<void>
  /**
   * Providers that should be pushed to `daemonId`: an org provider whose `name` is
   * enabled (in `runtimeOverrides.mcpServers`) by some agent placed on the daemon.
   * Mirrors {@link IntegrationRepo.activeForDaemon} but org-scoped (v1 visibility='org'):
   * a daemon receives the proxy def only when one of its agents opted the provider in.
   */
  activeForDaemon(daemonId: DaemonId): Promise<McpProviderRecord[]>
  /** EVERY provider across all orgs — the pool-wide set replayed to a relay that just
   *  (re)registered (its in-memory binding table starts empty; bindings are pool-wide,
   *  like bots/hooks). */
  listAll(): Promise<McpProviderRecord[]>
}

/** One `{name, value}` upstream auth header (same shape as the wire NameValueList). */
export interface McpHeader {
  name: string
  value: string
}

/** The ONLY read/write path for `mcp_provider_secret` (upstream auth headers).
 *  Store-only: NEVER in a DTO, NEVER pushed to a daemon (relay-only, via rc/mcp-assign).
 *  Same seam/discipline as {@link BotSecretStore}. */
export interface McpProviderSecretStore {
  put(providerId: string, headers: McpHeader[]): Promise<void>
  get(providerId: string): Promise<McpHeader[] | null>
  delete(providerId: string): Promise<void>
}

/** Domain view of an `mcp_grant` row. `key` is the PLAINTEXT bearer grant key —
 *  handed to daemons in the proxy def header, hashed (sha256) before it reaches a
 *  relay. Store-only secret: NEVER in a DTO, NEVER logged. */
export interface McpGrantRecord {
  id: string
  mcpProviderId: string
  key: string
  status: 'active' | 'revoked'
  createdAt: Date
}

export interface McpGrantRepo {
  /** Mint a fresh active grant (generates a new plaintext key) for a provider.
   *  v1 keeps exactly one active grant per provider — the caller revokes any prior
   *  active grant first (shared org identity). Returns the row WITH the plaintext. */
  mintFor(providerId: string): Promise<McpGrantRecord>
  /** The provider's active grants (v1: 0 or 1). Carries plaintext — internal use only. */
  activeForProvider(providerId: string): Promise<McpGrantRecord[]>
  /** Mark a grant revoked (idempotent). */
  revoke(grantId: string): Promise<void>
}

// ───────────────────────────────────────────────────────────────────────────
// Shared skills registry (docs/designs/shared-skills.md)
//   SkillSource = the org-level record of a skills source (repo / git URL / tree
//   path). The CP stores ONLY the source metadata; content is fetched daemon-side
//   by `npx skills`. One port (no secret store / no grant — skills carry no
//   upstream credential). Shareable, so the same visibility policy as agents/MCP.
// ───────────────────────────────────────────────────────────────────────────

/** Domain view of a `skill_source` row. Shareable (owner + visibility +
 *  sharedWith). Nothing here is secret. */
export interface SkillSourceRecord extends Shareable {
  id: string
  orgId: OrgId
  name: string // reference key (unique per org); the agent enable-list keys on it
  source: string // fed to `npx skills add`
  githubRepoId: bigint | null
  ref: string | null
  subDir: string | null
  skills: string[] // empty ⇒ install every skill; else only these
  createdByUserId: string | null
  createdAt: Date
  updatedAt: Date
}

export interface CreateSkillSourceInput {
  orgId: OrgId
  name: string
  source: string
  githubRepoId?: bigint | null
  ref?: string | null
  subDir?: string | null
  skills?: string[]
  visibility?: ResourceVisibility // default 'org'
  sharedWith?: string[]
  createdByUserId?: string
  ownerUserId?: string // defaults to createdByUserId
}

export interface UpdateSkillSourceInput {
  name?: string
  source?: string
  githubRepoId?: bigint | null
  ref?: string | null
  subDir?: string | null
  skills?: string[]
}

export interface SkillSourceRepo {
  create(input: CreateSkillSourceInput): Promise<SkillSourceRecord>
  get(id: string): Promise<SkillSourceRecord | null>
  /** The org's sources, filtered by the OSS resource-visibility policy for a
   *  supplied human principal; undefined is reserved for internal reads. */
  listForOrg(orgId: OrgId, viewer?: ViewCtx): Promise<SkillSourceRecord[]>
  /** Look up a source by its org-unique name (used to resolve an agent's enable-list). */
  getByName(orgId: OrgId, name: string): Promise<SkillSourceRecord | null>
  setSharing(
    id: string,
    sharing: { visibility: ResourceVisibility; sharedWith: string[] },
    byUserId?: string
  ): Promise<SkillSourceRecord>
  update(id: string, patch: UpdateSkillSourceInput): Promise<SkillSourceRecord>
  delete(id: string): Promise<void>
}

// ── External-memory plugin control plane (memory-evolution M-5A) ──

export type MemoryPluginTransport = 'streamable-http' | 'stdio'
export type ExternalMemoryConnectionStatus = 'probing' | 'ready' | 'degraded' | 'invalid'

export interface MemoryPluginSecretHeader {
  name: string
  header: string
  required: boolean
}

export interface MemoryPluginInstallationRecord {
  id: string
  orgId: OrgId
  pluginId: string
  transport: MemoryPluginTransport
  endpoint: string | null
  commandRef: string | null
  pinnedProfileMajor: 1
  expectedManifestDigest: string | null
  secretHeaders: MemoryPluginSecretHeader[]
  createdByUserId: string | null
  createdAt: Date
  updatedAt: Date
}

export interface MemoryPluginInstallationRepo {
  create(input: {
    orgId: OrgId
    pluginId: string
    transport: MemoryPluginTransport
    endpoint?: string
    commandRef?: string
    pinnedProfileMajor: 1
    expectedManifestDigest?: string
    secretHeaders: MemoryPluginSecretHeader[]
    createdByUserId?: string
  }): Promise<MemoryPluginInstallationRecord>
  get(id: string): Promise<MemoryPluginInstallationRecord | null>
  listForOrg(orgId: OrgId): Promise<MemoryPluginInstallationRecord[]>
  delete(id: string): Promise<void>
}

export interface ExternalMemoryConnectionRecord {
  id: string
  orgId: OrgId
  installationId: string
  config: Record<string, unknown>
  status: ExternalMemoryConnectionStatus
  revision: number
  probedRevision: number | null
  pluginVersion: string | null
  profile: string | null
  manifestDigest: string | null
  capabilities: Record<string, unknown> | null
  declaredEgressHosts: string[]
  reasonCode: string | null
  createdByUserId: string | null
  createdAt: Date
  updatedAt: Date
}

export interface ExternalMemoryConnectionRepo {
  create(input: {
    id?: string
    orgId: OrgId
    installationId: string
    config: Record<string, unknown>
    createdByUserId?: string
  }): Promise<ExternalMemoryConnectionRecord>
  get(id: string): Promise<ExternalMemoryConnectionRecord | null>
  listForOrg(orgId: OrgId): Promise<ExternalMemoryConnectionRecord[]>
  listAll(): Promise<ExternalMemoryConnectionRecord[]>
  update(id: string, patch: { config?: Record<string, unknown> }): Promise<ExternalMemoryConnectionRecord>
  delete(id: string): Promise<void>
  /** Connections referenced by an external-memory agent placed on this daemon. */
  activeForDaemon(daemonId: DaemonId): Promise<ExternalMemoryConnectionRecord[]>
  /** Revision-fenced probe fact update; stale daemon facts are ignored. */
  updateProbeFact(
    id: string,
    revision: number,
    fact: {
      status: ExternalMemoryConnectionStatus
      pluginVersion?: string
      profile?: string
      manifestDigest?: string
      capabilities?: Record<string, unknown>
      declaredEgressHosts?: string[]
      reasonCode?: string
    }
  ): Promise<boolean>
}

/** Secret values keyed by manifest logical field name. Values never enter DTOs. */
export interface ExternalMemoryConnectionSecretStore {
  put(connectionId: string, values: Record<string, string>): Promise<void>
  get(connectionId: string): Promise<Record<string, string> | null>
  keys(connectionId: string): Promise<string[]>
  delete(connectionId: string): Promise<void>
}

export interface ExternalMemoryGrantRecord {
  id: string
  connectionId: string
  key: string
  status: 'active' | 'revoked'
  createdAt: Date
}

export interface ExternalMemoryGrantRepo {
  mintFor(connectionId: string): Promise<ExternalMemoryGrantRecord>
  activeForConnection(connectionId: string): Promise<ExternalMemoryGrantRecord[]>
  revoke(grantId: string): Promise<void>
}

export interface OrgInviteLinkRepo {
  /** The org's single link slot, including expired/revoked state. */
  getForOrg(orgId: string): Promise<OrgInviteLinkRecord | null>
  /** Create when empty, or replace an expired/revoked slot. Active ⇒ null. */
  createReplacingInactive(
    input: {
      orgId: string
      tokenHash: string
      displayTail: string
      expiresAt: Date
      createdByUserId: string
    },
    now: Date
  ): Promise<OrgInviteLinkRecord | null>
  /** Idempotently revoke + audit in one transaction. False means the id is not in that org. */
  revoke(orgId: string, inviteLinkId: string, at: Date, actorUserId: string): Promise<boolean>
  /** Validate + grant collaborator + persist redemption and its audit atomically. */
  accept(tokenHash: string, userId: string, now: Date): Promise<OrgInviteAcceptResult>
}
