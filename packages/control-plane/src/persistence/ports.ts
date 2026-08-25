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
  AgentMemoryBinding,
  ApprovalsReviewer,
  DecimalAmount,
  CodeHostNoteState,
  GithubPublishedComment,
  OrganizationSuggestionInfo,
  CodeHostReviewLeasePhase,
  CodeHostReviewOpKind,
  CodeHostReviewOpMethod,
  CodeHostReviewOpOutcome,
  CodeHostReviewOpState,
  CodeHostReviewState,
  CodeHostProvider,
  HookKind
} from '@agentconnect.md/protocol'
import type {
  CodeHostReviewLockReason,
  CodeHostReviewOpRefusal,
  CodeHostReviewTransferCondition
} from '../domain/code-host-review.js'
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
import type { DutyMemberKey, DutyReconcilePlan, DutyEdge, AgentSeed } from '../domain/duty.js'
import type { PlacementKind, PlacementRef, PlacementTarget } from '../domain/placement.js'
import type {
  OrganizationEnvironmentAudience,
  OrganizationEnvironmentKind,
  OrganizationEnvironmentValues
} from '../orchestrator/organizationEnvironment.js'

export type {
  OrganizationEnvironmentAudience,
  OrganizationEnvironmentKind,
  OrganizationEnvironmentValues
} from '../orchestrator/organizationEnvironment.js'

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

/** The visibility-bearing fields every shareable resource carries. Selected
 *  resources store their complete current-member audience in `sharedWith`. */
export interface Shareable {
  visibility: ResourceVisibility
  sharedWith: string[]
}
export type AssignmentState = 'active' | 'draining' | 'released' | 'frozen'
export type SessionPhase = 'start' | 'plan' | 'problem' | 'end'
export type ActivityState = 'thinking' | 'tool_call' | 'awaiting_permission' | 'idle'
/** Per-session visibility tier (session-visibility.md §1). Distinct from
 *  `ResourceVisibility` — sessions have no `restricted`/`sharedWith` tier. */
export type SessionVisibility = 'private' | 'org' | 'external'
export type ExternalResolution = 'pending' | 'settled' | 'invalid'
export type ExternalAccessPolicyState = 'disabled' | 'enabling' | 'enabled' | 'degraded'
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

/** What `auth` carries that the persistence layer needs (§3.3). */
export interface AuthReqInput {
  daemonId: DaemonId
  orgId: OrgId | null
  agentVersion: AuthReq['agentVersion']
  machineId?: string
  tokenFp?: string
}

/** What `register` carries (§3.3). */
export interface RegisterReqInput {
  host: RegisterReq['host']
  capabilities: RegisterReq['capabilities']
  maxAgents: RegisterReq['maxAgents']
  /** Rollout generation (pod-template hash); absent ⇒ stored null. */
  generation?: RegisterReq['generation']
}

export interface DaemonRecord {
  id: DaemonId
  /** Null only for an install-wide pool member. */
  orgId: OrgId | null
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
  visibility: ResourceVisibility
  sharedWith: string[] // complete app_user.id audience when visibility='restricted'
  /** Console-set finished-session retention window ('never' | '7d' | '30d' | '90d'). */
  sessionRetention: string
  lastModifiedAt: Date // last human edit (provision/rename); defaults to createdAt
  lastModifiedBy: AgentCreator | null // WebUI user who last edited it; null ⇒ never edited by a human
  /** The member set this daemon is in (daemon-groups.md §2); null ⇒ it owns its agents outright. */
  memberSetId: string | null
}

export interface DaemonRepo {
  /**
   * Insert a fresh daemon row in `provisioned` status at `sessionEpoch = 0` (schema
   * default) — the FK anchor an `ApiKey` points at, created at onboarding (§4.1). First
   * `auth` then takes `upsertOnAuth`'s increment branch → epoch 1, identical to before.
   * `createdByUserId` stamps the WebUI principal who provisioned it (console "Created" row).
   */
  provision(daemonId: DaemonId, orgId: OrgId, createdByUserId?: string): Promise<DaemonRecord>
  /** Resolve one install-wide pool member by its reviewed ServiceAccount subject and Pod UID. */
  resolvePoolClusterIdentity(clusterIdentity: string, clusterPodUid: string): Promise<DaemonRecord>
  /**
   * Idempotent on `daemonId`. Bumps `sessionEpoch` (the fencing root) in ONE
   * transaction and sets status `authenticating`. Returns the new strictly-
   * increasing epoch. First call for a daemon creates the row.
   */
  upsertOnAuth(input: AuthReqInput): Promise<{ daemon: DaemonRecord; sessionEpoch: bigint }>
  /**
   * Undo the automatic pool enrollment for a connection that registered as an OBSERVER, and
   * backdate its liveness so the pool-member reaper retires the row on its next sweep. An
   * observer holds no membership, so `claimVacant`'s eligibility gate can never reach it.
   */
  withdrawObserver(daemonId: DaemonId): Promise<void>
  /** Also records `generation`, stamping `generationSince` only when the value changes. */
  applyRegister(daemonId: DaemonId, reg: RegisterReqInput, now: Date): Promise<DaemonRecord>
  /** Full-replace the stored capabilities from a mid-connection `capabilities/update`. */
  setCapabilities(daemonId: DaemonId, capabilities: RegisterReqInput['capabilities']): Promise<void>
  /** Replace the daemon-level MCP-server list (`facts/daemon-runtimes.mcpServers`) wholesale. */
  setMcpServers(daemonId: DaemonId, servers: FactsMcpServer[]): Promise<void>
  touchHeartbeat(daemonId: DaemonId, hb: Heartbeat, at: Date): Promise<void>
  markUnreachable(daemonId: DaemonId, at: Date): Promise<void>
  /** Set the console-assigned display name (a human edit — stamps last-modified
   *  audit). `byUserId` is the editing WebUI principal (absent under devAuth).
   *  Org-fenced (docs/designs/org-scoped-data-layer.md §3): a cross-org id
   *  throws the same missing-row error as an absent row. */
  rename(orgId: OrgId, daemonId: DaemonId, name: string, byUserId?: string): Promise<DaemonRecord>
  /** Set the console's finished-session retention window (a human edit — stamps
   *  last-modified audit). Org-fenced like {@link DaemonRepo.rename}. */
  setSessionRetention(
    orgId: OrgId,
    daemonId: DaemonId,
    sessionRetention: string,
    byUserId?: string
  ): Promise<DaemonRecord>
  /** Set the visibility + share set (the dedicated `/sharing` write path). Stamps
   *  the last-modified audit; `byUserId` is the editing WebUI principal (absent
   *  under devAuth). Org-fenced like {@link DaemonRepo.rename}. */
  setSharing(
    orgId: OrgId,
    daemonId: DaemonId,
    sharing: { visibility: ResourceVisibility; sharedWith: string[] },
    byUserId?: string
  ): Promise<DaemonRecord>
  /**
   * Hard-delete a daemon (DELETE /daemons/:id). FK referential actions cascade its
   * api-keys / leases / launches / runtime-profiles and null out agents/assignments
   * (those become unplaced). Org-fenced: a cross-org id throws Prisma P2025
   * exactly like an absent row (→ 404).
   */
  delete(orgId: OrgId, daemonId: DaemonId): Promise<void>
  /**
   * Install-wide pool members nothing has been heard from since `cutoff` — the rows left
   * behind by replaced Pods, which no org's DELETE can reach because no org owns them
   * (k8s-daemon-pool.md §3 "Identity is per Pod, not per org": a replacement Pod gets a new
   * daemon ID). System-tier and deliberately fleet-wide, like
   * {@link DaemonRepo.findReassignable}. Never-connected rows are judged by `createdAt`.
   */
  findRetiredPoolMembers(cutoff: Date): Promise<DaemonRecord[]>
  /**
   * Retire ONE install-wide pool member: the fenced delete (cascading exactly like
   * {@link DaemonRepo.delete}) plus the database-side settlement of every agent it hosted, in
   * one transaction — so no crash can leave an agent unplaced but still `active`.
   *
   * A compare-and-delete, not a delete: the whole fence rides one statement — the org-less
   * pool shape (so it cannot touch an org's own daemon), the same `retiredBefore` cutoff the
   * worklist selected on, and the `sessionEpoch` observed there, which a (re)auth bumps before
   * the first heartbeat moves `lastSeenAt`. A row that stopped matching yields
   * `deleted: false`, having written nothing, so nothing downstream runs for a member that
   * came back. `settled` is the agents this call actually unplaced — the audience for the
   * out-of-database pushes that follow, excluding any a concurrent writer had already moved.
   */
  retirePoolMember(
    daemonId: DaemonId,
    fence: { retiredBefore: Date; sessionEpoch: bigint }
  ): Promise<{ deleted: boolean; settled: { id: AgentId; orgId: OrgId }[] }>
  /** Bump THIS daemon's `routingEpoch` atomically; returns the new value (§4.11).
   *  System-tier: the orchestrator drives it from a routing decision it already
   *  resolved, so an org parameter would be tautological (§3.4). */
  bumpRoutingEpoch(daemonId: DaemonId): Promise<bigint>
  /** Daemons unreachable for longer than `graceSec` — reassignment candidates (§4.9).
   *  System-tier: the watchdog's worklist is deliberately fleet-wide. */
  findReassignable(graceSec: number, now: Date): Promise<DaemonRecord[]>
  /** Org-owned point read; shared pool members are deliberately absent. */
  get(orgId: OrgId, daemonId: DaemonId): Promise<DaemonRecord | null>
  /** Placement/display read admitting both org-owned daemons and install-wide pool members. */
  getAvailable(orgId: OrgId, daemonId: DaemonId): Promise<DaemonRecord | null>
  /** Tenancy-UNSCOPED read for internal trust domains — WS handlers resolving
   *  their own connection's daemon, orchestration/placement resolving a daemon
   *  from a routing row, the watchdog. Never call this from the HTTP surface;
   *  lint enforces it (org-scoped-data-layer.md §6). */
  getUnscoped(daemonId: DaemonId): Promise<DaemonRecord | null>
  /** Owned fleet, optionally filtered to one org; undefined is the internal fleet-wide read. */
  list(orgId?: OrgId, viewer?: ViewCtx): Promise<DaemonRecord[]>
  /** Display/placement fleet including install-wide pool members. */
  listAvailable(orgId: OrgId, viewer?: ViewCtx): Promise<DaemonRecord[]>
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
  /** Kill switch: set `revokedAt` (+ reason). Checked on every auth.
   *  System-tier (docs/designs/org-scoped-data-layer.md §3.4): this one method
   *  revokes daemon, user, oauth AND relay keys, and relay keys are org-less
   *  deployment infrastructure by design (§7 non-goals). Each caller proves
   *  ownership on a STRONGER axis first — the org-fenced daemon roster
   *  ({@link ApiKeyRepo.listForDaemon}) or the caller's own key list
   *  ({@link ApiKeyRepo.listForUser}) — so an org parameter here would be both
   *  wrong for relay keys and weaker than the fence already in place. */
  revoke(id: string, reason: string, at: Date): Promise<ApiKeyRecord>
  /** Revoke every live oauth access token minted under a grant — the "disconnect"
   *  cascade so a Profile revoke kills outstanding tokens now, not in ≤1h. Returns count. */
  revokeByOAuthGrant(grantId: string, reason: string, at: Date): Promise<number>
  /** All keys (including revoked) for a daemon — the console key list, and the
   *  ownership proof the revoke route binds a raw key id against. Org-fenced
   *  (§3): a daemon outside `orgId` yields no keys at all, so that proof cannot
   *  admit a cross-tenant kill even if a route forgot to resolve the daemon. */
  listForDaemon(orgId: OrgId, daemonId: DaemonId): Promise<ApiKeyRecord[]>
  /** A user's personal keys (all their orgs, active-only by default), joined with each
   *  key's org label — the profile "API keys" list, newest first.
   *  System-tier: fenced by the caller's own identity, which spans organizations
   *  by design (a personal key list is per-user, not per-org). */
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
  /** Advertised relay features (rc/register.features), refreshed on register. */
  features: string[]
  lastSeenAt: Date | null
  createdAt: Date
}

export interface RelayRepo {
  /** Upsert by the unique `name` (the relay's stable identity): create with a fresh
   *  id or reclaim the existing row, refreshing `daemonUrl` + `lastSeenAt` to `at`.
   *  Atomic on the unique name so a restart racing the sweeper can't duplicate a pod. */
  upsertByName(name: string, daemonUrl: string, at: Date, features?: string[]): Promise<RelayRecord>
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
export type WorkspaceIsolation = 'shared' | 'session'
export type AgentWorkspace =
  | { mode: 'scratch'; isolation?: WorkspaceIsolation }
  | {
      mode: 'github'
      isolation?: WorkspaceIsolation
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
  | {
      /** A managed GitLab project binding is the workspace (gitlab-com-integration.md
       *  §13): credentials come from the binding's purpose-separated PATs, never a
       *  per-agent installation. `workspaceRepoId` holds the numeric project id. */
      mode: 'gitlab'
      isolation?: WorkspaceIsolation
      gitRepo: string
      gitBranch?: string
      agentDir?: string
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
  showStatusBar?: boolean // render Slack's persistent session status row (default false)
  fastMode?: boolean // runtime fast mode toggle
  permissionMode?: string // runtime permission/approval mode
  approvalsReviewer?: ApprovalsReviewer // who reviews eligible Codex approval requests
  allowRuntimeChangesInChat?: boolean // explicit opt-in; default false
  pause?: boolean // operational message-processing toggle (#288); true ⇒ daemon skips all turns
  introduceOnJoin?: boolean // #536: self-introduce to peers on a genuine channel join (absent ⇒ DB default false)
  runInSandbox?: boolean // #642: request an OS sandbox (absent ⇒ DB default false)
  env?: Record<string, string> // extra env injected into the runtime (AgentSpec.env)
  // NOTE: write-only secret env vars are NOT part of the agent row — they live behind
  // the AgentSecretStore seam (routes write them there after create).
  mcpServers?: string[] // daemon-configured MCP server names to attach at session/new (AgentSpec.mcpServers)
  skills?: string[] // enabled skills, "<sourceName>/<skillName>" or "<sourceName>/*" (shared-skills.md)
  managedSkills?: string[] // accepted managed_skill ids, explicitly enabled
  memory?: AgentMemoryBinding // memory backend
  icon?: AgentIcon // console avatar; absent ⇒ the repo assigns a random glyph+color combo
  /** Placement at create time: `set` needs `setId`, `daemon` needs `daemonId`. Absent ⇒ unplaced. */
  placementKind?: PlacementKind
  daemonId?: DaemonId // the owning machine, if chosen at create time
  setId?: string // the owning member set, if placed on one at create time
  workspace?: AgentWorkspace // absent ⇒ scratch
  /** Rename-proof numeric identity of the github workspace repository. This is
   *  control-plane metadata only and never rides AgentWorkspace on the wire. */
  workspaceRepoId?: bigint
  capabilities?: string[]
  createdByUserId?: string // WebUI principal who created it (audit); null ⇒ daemon/CLI-created
  /** Initial visibility (absent ⇒ DB default 'org', visible to all org members). */
  visibility?: ResourceVisibility
  /** Initial complete audience (app_user.id); only meaningful with visibility='restricted'. */
  sharedWith?: string[]
  /** Initial agent-call policy (absent ⇒ the organization's default). */
  callPolicy?: AgentCallPolicy
  /** Initial caller allow-list (agent.id set); only meaningful with callPolicy='selected'. */
  allowedCallerAgentIds?: string[]
  /** Initial outbound policy (absent ⇒ the organization's default). */
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
  showStatusBar?: boolean
  fastMode?: boolean | null
  permissionMode?: string | null
  approvalsReviewer?: ApprovalsReviewer | null
  allowRuntimeChangesInChat?: boolean
  pause?: boolean | null // operational message-processing toggle (#288); null clears
  introduceOnJoin?: boolean // #536: self-introduce to peers on a genuine channel join
  runInSandbox?: boolean // #642: request an OS sandbox for this agent
  /** Widen an existing App-backed GitHub workspace from read to write. */
  gitAccess?: 'write'
  /** GitHub workspace-relative ACP cwd; null restores repository root. */
  agentDir?: string | null
  env?: Record<string, string> | null // replaced wholesale when provided; null clears
  // NOTE: write-only secrets are NOT a repo patch field — the PATCH route merges
  // them through the AgentSecretStore seam (key-by-key; see AgentSecretStore.merge).
  mcpServers?: string[] | null // replaced wholesale when provided; null clears
  skills?: string[] | null // enabled skills; replaced wholesale when provided; null clears
  managedSkills?: string[] | null // accepted managed_skill ids; replaced wholesale when provided; null clears
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
  showStatusBar: boolean // from runtimeOverrides.showStatusBar (default false)
  fastMode: boolean | null // from runtimeOverrides.fastMode (null ⇒ runtime default)
  permissionMode: string | null // from runtimeOverrides.permissionMode (null ⇒ runtime default)
  approvalsReviewer: ApprovalsReviewer | null // from runtimeOverrides.approvalsReviewer
  allowRuntimeChangesInChat: boolean // from runtimeOverrides (default false)
  pause: boolean | null // from runtimeOverrides.pause (null ⇒ not paused) (#288)
  env: Record<string, string> // from runtimeOverrides.env ({} when unset)
  // NOTE: write-only secret env vars are deliberately NOT on the record (accidental-
  // serialization guard, like BotSecret): key names come from AgentSecretStore.keys,
  // values only from AgentSecretStore.get on the wire-projection paths.
  mcpServers: string[] // from runtimeOverrides.mcpServers ([] when unset ⇒ none attached)
  skills: string[] // from runtimeOverrides.skills — enabled "<source>/<skill>" / "<source>/*" ([] ⇒ none)
  managedSkills: string[] // accepted managed_skill ids ([] ⇒ none)
  memory: AgentMemoryBinding | null // runtimeOverrides.memory
  status: 'active' | 'inactive' | 'paused'
  /** What placement NAMES (domain/placement.ts): `daemon` resolves through `daemonId`, `set`
   *  resolves through `setId`. Never branch on it directly. */
  placementKind: PlacementKind
  /** The `daemon`-kind ref, and null for every other kind — placement, never "who serves it now".
   *  Ask {@link PlacementResolver} for that. */
  daemonId: DaemonId | null
  /** The `set`-kind ref, null for a `daemon` placement. Which MEMBER serves it is the ledger's. */
  setId: string | null
  workspace: AgentWorkspace
  /** Nullable on scratch/anonymous and pre-R2a rows; action-time authorization
   *  fails closed until a legacy github workspace is lazily repaired. */
  workspaceRepoId?: bigint
  capabilities: string[]
  createdAt: Date
  createdBy: AgentCreator | null // null for daemon/CLI-created agents (no WebUI principal)
  /** Raw immutable creator FK scalar, independent of joined `createdBy`. */
  createdByUserId: string | null
  visibility: ResourceVisibility
  sharedWith: string[] // complete app_user.id audience when visibility='restricted'
  callPolicy: AgentCallPolicy
  allowedCallerAgentIds: string[] // agent.id set; meaningful only when callPolicy='selected'
  outboundPolicy: AgentCallPolicy
  allowedTargetAgentIds: string[] // agent.id set; meaningful only when outboundPolicy='selected'
  introduceOnJoin: boolean // #536: self-introduce to peers on a genuine channel join (default false)
  runInSandbox: boolean // #642: persisted per-agent sandbox preference (default false)
  lastModifiedAt: Date // last human edit (create/PATCH); defaults to createdAt
  lastModifiedBy: AgentCreator | null // WebUI user who last edited it; null ⇒ never edited by a human
  /**
   * Monotonic revision of this agent's fully resolved CP-owned configuration
   * (organization-secrets-and-variables.md §5). ONE ordering domain per agent:
   * every durable mutation that can change a field assembled into `AgentSpec`
   * bumps it through {@link bumpAgentConfigRevisions}, so an organization-derived
   * change and an ordinary agent edit cannot mint competing revisions. The daemon
   * refuses a snapshot older than the greatest it applied, which is what makes
   * full-map env/secret replacement safe.
   */
  configRevision: bigint
}

/**
 * The skill-source fence an agent write carries when its submitted enable-list
 * references shared-skills sources. Inside the write's transaction the repo
 * takes the (orgId, name) advisory scope of every named source (sorted — see
 * persistence/skill-source-lock.ts), reads the viewer-visible source names
 * under those scopes, and calls `authorize` with the agent's committed
 * enable-list — so the visibility decision, the reference it authorizes, and
 * the row write cannot be separated by a concurrent source delete, same-name
 * create, or sharing flip, across control-plane instances. A throw aborts the
 * transaction.
 */
export interface AgentSkillSourceFence {
  orgId: OrgId
  /** Source names the submitted refs point at (deduplication is the repo's job). */
  names: readonly string[]
  /** Visibility principal for the in-scope source read; undefined ⇒ unfiltered. */
  viewer?: ViewCtx
  authorize: (committedHeld: readonly string[], visibleSourceNames: ReadonlySet<string>) => void
}

export interface AgentUpdateOpts {
  authorizeMcpServers?: (currentlyHeld: readonly string[]) => void
  skillSources?: AgentSkillSourceFence
}

export interface AgentCreateOpts {
  skillSources?: AgentSkillSourceFence
}

export interface AgentRepo {
  /** `opts.skillSources` fences the initial enable-list inside the create
   *  transaction (see {@link AgentSkillSourceFence}). A create binding external
   *  memory also try-locks that connection's advisory mutation scope and
   *  re-verifies the connection inside the transaction — MemoryConnectionBusy /
   *  MemoryConnectionMissing abort it. */
  create(input: CreateAgentInput, opts?: AgentCreateOpts): Promise<AgentRecord>
  /** Org-fenced point read (docs/designs/org-scoped-data-layer.md §3): a
   *  cross-org id reads as absent, exactly like a missing row. This is the
   *  only agent read the HTTP/MCP surface may use. */
  get(orgId: OrgId, agentId: AgentId): Promise<AgentRecord | null>
  /** Tenancy-UNSCOPED read for internal trust domains — orchestration,
   *  reconciliation, WS handlers, platform machinery — which resolve an agent
   *  from system state (a run row, an integration row, signed claims) and
   *  derive the org from the returned record. Never call this from the HTTP
   *  surface; lint enforces it (org-scoped-data-layer.md §6). */
  getUnscoped(agentId: AgentId): Promise<AgentRecord | null>
  /** `opts.authorizeMcpServers` / `opts.skillSources.authorize` (only
   *  meaningful when the patch includes `mcpServers` / `skills`) run INSIDE the
   *  row-locked transaction, right after the committed runtimeOverrides read,
   *  with the agent's currently-held MCP list / skill-ref list — the one atomic
   *  point where an enable-list authorization decision and the write it guards
   *  cannot be separated by a concurrent removal. A throw aborts the
   *  transaction. A patch touching the external-memory binding additionally
   *  try-locks the old+new connections' advisory mutation scopes and
   *  re-verifies a newly bound connection inside the transaction
   *  (MemoryConnectionBusy / MemoryConnectionMissing).
   *
   *  Org-fenced: throws {@link AgentMissing} when `agentId` does not exist in
   *  `orgId` — a cross-org id is indistinguishable from a missing row. */
  update(orgId: OrgId, agentId: AgentId, patch: UpdateAgentInput, opts?: AgentUpdateOpts): Promise<AgentRecord>
  /** Compare-and-set a workspace edit. The caller has already drained/proved
   *  an owning daemon when one exists. Org-fenced: a cross-org id misses the
   *  CAS exactly like a stale expectation (null). */
  setWorkspace(
    orgId: OrgId,
    agentId: AgentId,
    expectedLastModifiedAt: Date,
    expectedMode: AgentWorkspace['mode'],
    workspace: AgentWorkspace,
    workspaceRepoId?: bigint,
    byUserId?: string
  ): Promise<AgentRecord | null>
  /** Compensation for a daemon NACK whose non-activation is known.
   *  Org-fenced like {@link AgentRepo.setWorkspace}; the orchestrator passes
   *  the org of the record it holds. */
  restoreWorkspace(
    orgId: OrgId,
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
  /** Converge everything a gitlab project path is replicated into after a binding
   *  path refresh (rename): gitlab-workspace clone URLs AND every explicit
   *  authorization's display path, which is how the daemon maps a named project
   *  back to its numeric id. Bumps configRevision once per agent so the fenced
   *  spec push replicates. Returns the affected agent ids. `cloneUrl` is the
   *  provider's own value (§24.1) — omitted ⇒ only display paths converge. */
  refreshGitlabProjectPath(orgId: OrgId, projectId: bigint, projectPath: string, cloneUrl?: string): Promise<AgentId[]>
  /** Set the visibility + share set (the dedicated `/sharing` write path, kept
   *  separate from content `update`). An org→restricted transition atomically
   *  closes known direct-conversation rows. Stamps the last-modified audit;
   *  `byUserId` is the editing WebUI principal (absent under devAuth).
   *  Org-fenced: a cross-org id surfaces as the missing-row error. */
  setSharing(
    orgId: OrgId,
    agentId: AgentId,
    sharing: { visibility: ResourceVisibility; sharedWith: string[] },
    byUserId?: string
  ): Promise<AgentRecord>
  /** Set both directions of the agent-call policy. Stamps last-modified audit
   *  because it is a human configuration edit. Org-fenced: a cross-org id
   *  surfaces as the missing-row error. */
  setCallPolicy(
    orgId: OrgId,
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
  setPlacement(agentId: AgentId, target: PlacementTarget): Promise<void>
  /**
   * Atomically move an agent only when its current placement still matches `expected` — the whole
   * target, so moving between a set and a machine is fenced exactly like moving between two
   * machines. Returns the updated row, or null when another move won the compare-and-set race. A
   * real move revokes active webchat MCP authority in the same transaction. This is the
   * persistence fence for the explicit cold placement-switch action.
   */
  movePlacement(
    agentId: AgentId,
    expected: PlacementTarget,
    target: PlacementTarget,
    byUserId?: string
  ): Promise<AgentRecord | null>
  /** Atomically enumerate the agent's HookDefs, tombstone their durable review
   *  projections, and delete the Agent (cascading the HookDefs). The returned
   *  snapshots let the route remove the corresponding relay rules.
   *  Org-fenced: a cross-org id preserves the missing-row error semantics. */
  delete(orgId: OrgId, agentId: AgentId): Promise<HookRecord[]>
  /** The org's agents. Every supplied human principal is resource-filtered;
   *  undefined is reserved for unfiltered internal reads
   *  (authorization/policy.ts#visibilityWhere). */
  list(orgId: OrgId, viewer?: ViewCtx): Promise<AgentRecord[]>
  /** Agents placed on a specific daemon — the reconcile roster (`register/ok.agents`).
   *  A daemon only ever receives the specs of the agents it owns (1 agent : 1 machine). */
  listForDaemon(daemonId: DaemonId): Promise<AgentRecord[]>
  /** Unscoped batch read by id — the duty half of the reconcile roster, whose
   *  agents are named by the ledger rather than by placement. */
  listByIds(agentIds: readonly AgentId[]): Promise<AgentRecord[]>
  /** The current `configRevision` of each agent — the freshness signal stamped
   *  onto a duty grant's agent members (orchestrator/dutyLease.ts). */
  configRevisions(agentIds: readonly AgentId[]): Promise<Map<string, bigint>>
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
  /** The placement columns, so a consumer can resolve the serving daemon (domain/placement.ts). */
  placementKind: PlacementKind
  daemonId: string | null
  setId: string | null
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
  // Effective execution-config snapshot. `model: null` is an explicit runtime
  // observation of an opaque/default model; absent keeps the prior value for
  // mixed-version refreshes.
  runtime?: string
  model?: string | null
  effort?: string
  fastMode?: boolean
  permissionMode?: string
  outputMode?: string
  workspaceIsolation?: 'shared' | 'session'
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
  /** Validated supported shared input. Presence is the durable candidate marker;
   *  an unresolved binding stays pending/invalid rather than falling back to a
   *  direct session. */
  externalCandidate?: {
    provider: string
    resolution: ExternalResolution
    scope?: {
      realmKey: string
      resourceKind: string
      resourceKey: string
      credentialKind?: string
      credentialId?: string
    }
  }
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
  orgId: OrgId
  agentId: AgentId
  sessionId: SessionId
  visibility: SessionVisibility
  sharedMemoryExcluded: boolean
  visibilityRev: number
}

export interface ExternalScopeRecord {
  id: string
  orgId: OrgId
  provider: string
  realmKey: string
  resourceKind: string
  resourceKey: string
  credentialKind: string | null
  credentialId: string | null
  aclRevision: bigint
  revokedAt: Date | null
}

export interface SessionExternalAccessPolicyRecord {
  orgId: OrgId
  provider: string
  state: ExternalAccessPolicyState
  currentRev: bigint
  readFenceRev: bigint | null
}

/** One request-local external authorization snapshot. Scope allows are tied to
 *  the exact ACL revision observed during provider resolution. */
export interface SessionExternalAccessSnapshot {
  policies: Array<{ provider: string; readFenceRev: bigint | null }>
  allowedScopes: Array<{ id: string; aclRevision: bigint }>
  decisionAt: Date
}

export interface SessionMetaRecord {
  id: SessionId
  parentSessionId: SessionId | null
  agentId: AgentId
  launchId: LaunchId | null
  platform: Platform | null
  channel: string | null
  thread: string | null
  /** Durable workspace/tenant scope (merged-conversation-view.md §5.1). */
  tenantScope: string | null
  phase: SessionPhase
  link: string | null
  summary: string | null
  title: string | null
  status: string | null
  lastActivityAt: Date
  triggeredBy: string | null
  channelName: string | null
  triggeredByName: string | null
  /** Creation-time hook-kind snapshot, so a deleted hook cannot rewrite this session's
   *  source. Null on rows written before the column; those resolve through the live hook. */
  hookKind: HookKind | null
  threadUrl: string | null
  runtime: string | null
  model: string | null
  effort: string | null
  fastMode: boolean | null
  permissionMode: string | null
  outputMode: string | null
  daemonId: DaemonId | null
  /** The member set whose shared store holds this session's content; null ⇒ the recorder kept a
   *  private one. Session-bound provenance that outlives `daemonId` (domain/session-content.ts). */
  contentSetId: string | null
  workspaceIsolation: 'shared' | 'session' | null
  activityState: ActivityState
  // ── session visibility (session-visibility.md §3) ──
  orgId: OrgId // denormalized from agent.orgId at ingest
  visibility: SessionVisibility
  ownerIdentity: string | null // §2 namespaced identity; null for automation/legacy/unresolved-owner rows (NOT a §2 owner-orphan, whose tuple is stored but unmatched)
  visibilitySource: VisibilitySource
  visibilityRev: number // bumped in the same tx as any visibility change (§5.1)
  visibilityAckedRev: number // daemon-ack watermark; 'applied' once >= visibilityRev
  externalProvider: string | null
  externalScopeId: string | null
  externalResolution: ExternalResolution | null
  /** Already unresolved when THIS org enabled the policy — expected history
   *  rather than a live failure, and inherited with the audience by A2A
   *  descendants. "legacy" is relative to the enable, not to any release: every
   *  enable re-stamps from scratch, so this stays live for as long as an org can
   *  turn external access on. */
  legacyUnresolved: boolean
  classifiedPolicyRev: bigint | null
  /** Retention GC (#485): when the owning daemon deleted this session's local
   *  content. Non-null ⇒ the transcript is gone for good and `/messages` has
   *  nothing left to proxy; the metadata here is the whole remaining record. */
  contentPurgedAt: Date | null
  contentPurgedReason: string | null
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
  integration?: Platform | CodeHostProvider
  triggeredBy?: string
  /** Code-host hook ids keyed by provider: each provider is promoted out of the generic
   *  hook bucket into its own integration, and `integration: 'hook'` excludes them all.
   *  Keyed rather than one field per host, so a new provider needs no new field here. */
  codeHostHookIds?: Partial<Record<CodeHostProvider, HookId[]>>
  hookTriggerIds?: HookId[]
  /** Agents whose sessions count as conversation MEMBERS, when the caller may see
   *  more than the filter returns. Absent ⇒ `agentIds`, i.e. membership and row
   *  scope are the same set. Only widens membership — which conversations qualify,
   *  their order, and the rows returned all stay on `agentIds`.
   *
   *  It widens EXTERNAL SCOPE resolution with it. A member visible only through a
   *  provider audience is authorized by a scope the caller's viewer snapshot has
   *  to carry; resolving scopes over the narrower set would leave the membership
   *  query unable to authorize the very rows it was widened to find, and drop
   *  them again for a reason that has nothing to do with visibility. */
  memberAgentIds?: AgentId[]
  /** Conversation-participant filter: keep only rows whose CONVERSATION
   *  (merged-conversation-view.md §5.1 key) carries a visible session for every
   *  listed agent. `agentIds` still decides which rows come back; this decides
   *  which conversations qualify at all, which is the only way to ask for a
   *  thread several agents worked in — no single row is owned by all of them.
   *  Fewer than two ids is a no-op: one participant is already implied by the
   *  row's own `agentId`. */
  conversationAgentIds?: AgentId[]
  /** Session-visibility predicate inputs (session-visibility.md §5): human
   *  viewers see baseline `org`, identity-owned `private`, and request-resolved
   *  provider `external` rows. Absent ⇒ no session predicate — the internal
   *  fail-open, mirroring `visibilityWhere(undefined)`. */
  viewer?: {
    role: OrgMemberRole
    identitySet: string[]
    externalAccess?: SessionExternalAccessSnapshot
  }
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

/** One conversation grouping key (merged-conversation-view.md §5.1). Legacy
 *  NULL-platform rows read as 'slack'. A row with a NULL channel or thread
 *  never groups — it is its own singleton conversation, and its key carries
 *  the null through. */
export interface ConversationKey {
  platform: string
  tenantScope: string | null
  channel: string | null
  thread: string | null
}

export interface ConversationRecord {
  key: ConversationKey
  /** Current member sessions, newest-first under the page's total order and
   *  collapsed to ONE row per agentId (superseded ACP session rows are
   *  history, not members). The first entry is the conversation's
   *  representative — the caller's newest visible member row. */
  sessions: SessionListRecord[]
  /** The same collapse over every member the caller may see, ids only — the
   *  members an agent filter kept out of `sessions` included. Who took part is a
   *  property of the conversation, not of the filter reading it. */
  memberSessionIds: string[]
}

export interface ConversationPageRecord {
  conversations: ConversationRecord[]
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
  /** Creation-time hook-kind snapshot; null on rows written before it existed. */
  hookKind: HookKind | null
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
  /** Stamp the retention-GC receipt (#485) on rows the REPORTING agent owns: the
   *  daemon deleted their local content, so the metadata row is now all that is
   *  left of them. Idempotent and first-wins — an at-least-once re-report keeps
   *  the original `contentPurgedAt`, so the console never shows a moving date.
   *  Rows bound to another agent are skipped, not rejected: a session id is only
   *  a purge claim for the agent it is bound to. Returns the ids actually
   *  stamped by THIS call (already-purged and foreign ids are absent). */
  markContentPurged(
    agentId: AgentId,
    sessionIds: SessionId[],
    reason: string,
    at: Date
  ): Promise<{ marked: SessionId[]; alreadyPurged: number }>
  /** Filter, keyset-page, and order in Postgres; usage is hydrated only for the
   *  returned page. `total` is computed only when explicitly requested. */
  listPage(q: SessionPageQuery): Promise<SessionPageRecord>
  /** The grouped list (merged-conversation-view.md §5.2): one row per
   *  conversation, newest-first, emit-at-max pagination — a scanned row yields
   *  its conversation only when it is the newest same-key row under the full
   *  (lastActivityAt, startedAt, id) order AND the caller's own predicate.
   *  Cursor semantics match `listPage` (the cursor is the previous page's last
   *  representative row). */
  listConversationPage(q: SessionPageQuery): Promise<ConversationPageRecord>
  /** Bounded key-addressed member resolution for a direct conversation load
   *  (merged-conversation-view.md §5.2): every visible row matching the key,
   *  collapsed to the current session per agent. Grouped keys only — callers
   *  resolve singletons through the ordinary session detail route. */
  listConversationMembers(q: SessionFacetQuery, key: ConversationKey): Promise<SessionListRecord[]>
  /** Org-level "any session exists" — a bare boolean over the org's FULL session set
   *  (no visibility predicate), safe to return to any org member: it reveals nothing
   *  about sessions the caller can't see. Drives the getting-started conversation step. */
  orgHasAny(orgId: OrgId): Promise<boolean>
  /** The most recently active session of one agent, org-fenced. For the shared-checkout PR link: an
   *  agent with one checkout has one branch, so that branch only speaks for the session using it now
   *  (webchat-side-panels.md §12.6). Rides `session_meta_agent_activity_page_idx`. */
  latestSessionIdForAgent(orgId: OrgId, agentId: AgentId): Promise<SessionId | null>
  /** One latest representative per distinct facet value after applying every
   *  other active facet. The database reduces the full history before returning
   *  this compact index to the HTTP layer. */
  listFacets(q: SessionFacetQuery): Promise<SessionFacetIndex>
  list(q: SessionQuery): Promise<SessionListRecord[]>
  /** Org-fenced point read (docs/designs/org-scoped-data-layer.md §3): a
   *  cross-org id reads as absent, exactly like a missing row. The only session
   *  read the HTTP/MCP surface may use. Visibility (`canViewSession`, the
   *  identity set, the external-access policy) stays at the route — the fence
   *  here is tenancy only (§8). */
  get(orgId: OrgId, id: SessionId): Promise<SessionMetaRecord | null>
  /** Tenancy-UNSCOPED read for internal trust domains — a daemon proving it owns
   *  the parent of a child session it is reporting. Never call this from the
   *  HTTP surface; lint enforces it (§6). */
  getUnscoped(id: SessionId): Promise<SessionMetaRecord | null>
  /** Fail-closed proof that the durable webchat session for this conversation
   * remains private before a remote administrative MCP invocation executes.
   * System-tier (§3.4): fenced by the conversation's own `agentId`, which the
   * MCP authority has already bound to the delegated agent. */
  hasPrivateWebchatSession(conversationId: string, agentId: AgentId): Promise<boolean>
  /** Distinct settled scopes referenced by external rows matching the non-page
   *  filters. Called before ORDER/LIMIT so membership filtering is pagination-safe. */
  listExternalScopes(q: SessionFilterQuery): Promise<ExternalScopeRecord[]>
  getExternalScopes(ids: string[]): Promise<ExternalScopeRecord[]>
  getExternalAccessPolicy(orgId: OrgId, provider: string): Promise<SessionExternalAccessPolicyRecord | null>
  countExternalUnresolved(orgId: OrgId, provider: string): Promise<number>
  /** Owner-only HTTP route calls this transactional transition. Enabling places
   *  the read fence before classifying legacy candidates; unresolved history stays
   *  hidden and is adopted as `legacyUnresolved` rather than reported as a fault.
   *  Disabling never widens historical rows. */
  setExternalAccessEnabled(
    orgId: OrgId,
    provider: string,
    enabled: boolean
  ): Promise<{
    policy: SessionExternalAccessPolicyRecord
    hiddenSessions: number
    affected: SessionMetaRecord[]
  }>
  /** Visible-child lookup for the session detail page. Parent ids are opaque and
   *  deliberately not foreign-keyed, so this remains a metadata query. `viewer`
   *  applies the same session predicate as the list (absent ⇒ internal fail-open).
   *  System-tier (§3.4): `agentIds` is the caller's own org roster, so the query
   *  is already org-fenced on a stronger axis than the parent id. */
  listChildren(
    parentSessionId: SessionId,
    agentIds: AgentId[],
    viewer?: SessionFilterQuery['viewer']
  ): Promise<SessionMetaRecord[]>
  /** §4.3 reclassification. Widening touches only the target row; tightening
   *  cascades to every descendant (transitively, `explicit` ones included —
   *  privacy wins) under the lock-then-scan-to-fixpoint protocol of §4.5. Every
   *  rewritten row's `visibilityRev` is bumped in the same transaction. */
  setVisibility(
    orgId: OrgId,
    sessionId: SessionId,
    visibility: SessionVisibility,
    /** Re-checked against the LOCKED row, closing the gap between the route's
     *  authorization read and this write: a concurrent ancestor cascade can
     *  re-own the session in between. Denied ⇒ `forbidden`, nothing written. */
    authorize?: (row: {
      visibility: SessionVisibility
      ownerIdentity: string | null
      externalProvider: string | null
    }) => boolean
  ): Promise<SessionVisibilityChange>
  /** Raise the daemon-ack watermark (§5.1). Monotonic: a late ack for an older
   *  revision never lowers it, so the tighten stays `applied`. */
  recordVisibilityAck(sessionId: SessionId, visibilityRev: number): Promise<void>
  /** The §5.1 register-time gate snapshot for a daemon, keyed on the AGENTS it serves (the
   *  caller resolves that set): the current `(sessionId, visibility, visibilityRev)` set,
   *  unacked first then newest-active, and bounded. A snapshot, not a diff. */
  visibilitySnapshotForAgents(
    agentIds: readonly string[],
    limit: number,
    includeExternal?: boolean
  ): Promise<SessionVisibilityState[]>
  /** How many of those agents' sessions still owe an ack — used to report when a
   *  bounded snapshot could not carry them all (never a silent truncation). */
  countUnackedVisibilityForAgents(agentIds: readonly string[], includeExternal?: boolean): Promise<number>
  /** Every currently-PRIVATE session of those agents, ordered by id and cursored on `afterId`.
   *  Deliberately blind to `visibilityAckedRev`: that watermark is per session, not per daemon, so
   *  a previous holder's ack cannot prove this member ever received the gate. */
  privateVisibilityPage(
    agentIds: readonly string[],
    limit: number,
    includeExternal?: boolean,
    afterId?: string
  ): Promise<SessionVisibilityState[]>
  /** A session plus every descendant — the set a tightening cascade rewrote, so
   *  the detail view's cutover state covers the whole subtree, not just the root.
   *  System-tier: driven by the visibility-push orchestrator from a row it holds. */
  visibilitySubtree(sessionId: SessionId, limit: number): Promise<SessionMetaRecord[]>
  /** Resolve the agent that owns a bot's `(channel, thread)` — the most-recently-active session
   *  keyed there whose agent still has an active integration for that bot. Backstop for
   *  shared-bot thread-affinity lookup: a daemon-created session (e.g. an agent's own channel-root
   *  post, session-concept §7.2 case 2a) never goes through the relay's mention/switch REPORT leg,
   *  so no `thread-assign` seeds the affinity store — this lets `lookupThread` still find the
   *  owner. Null when none. Placement is deliberately NOT a predicate here: which daemon serves
   *  the agent is {@link PlacementResolver}'s answer, and a pool agent names no machine. */
  findThreadOwner(botId: BotId, channel: string, thread: string): Promise<{ agentId: string } | null>
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

/** One roster row of a (possibly multi-agent) webchat conversation, in pick order. */
export interface WebchatParticipant {
  agentId: AgentId
  role: 'primary' | 'member'
}

/** What a resume mint authorizes against: the owner, and the sessions the conversation currently stands on. */
export interface WebchatResumeBinding {
  primaryAgentId: AgentId
  ownerUserId: string
  /** One slot per roster participant — null until that participant has a session (a partial roster is normal: a
   *  targeted turn or a refused delivery leaves peers unmaterialized); the conversation's own pointer on a pre-roster row. */
  currentSessionIds: Array<SessionId | null>
}

export interface WebchatConversationRepo {
  /** Register a server-allocated conversation before its first relay dial.
   *  `binding.agentId` is the PRIMARY; `memberAgentIds` are the remaining
   *  roster picks in order (webchat-multi-agents.md §3.1 — the roster is fixed
   *  at creation). Conversation + participant rows commit atomically. */
  create(binding: WebchatConversationBinding, memberAgentIds?: AgentId[]): Promise<void>
  /** The conversation's full roster (primary first, then pick order). Empty
   *  for an unknown conversation — callers fail closed. Org-fenced
   *  (org-scoped-data-layer.md §3): a cross-org conversation id yields the same
   *  empty roster as an unknown one, so it fails closed identically. */
  participants(orgId: OrgId, conversationId: string): Promise<WebchatParticipant[]>
  /** Append one member to an existing conversation's roster (mid-conversation
   *  join, webchat-multi-agents.md §3.1). Idempotent — re-adding an existing
   *  participant is a no-op. Authorization (owner, canView, capability, cap)
   *  belongs to the caller. */
  addParticipant(orgId: OrgId, conversationId: string, agentId: AgentId, addedByUserId: string): Promise<void>
  /** The owning console user of a conversation, for session-visibility ingest
   *  (§4.2). Scoped to a PARTICIPANT agent (any roster role); unknown and
   *  foreign bindings both return null (the caller fails closed). */
  findOwner(conversationId: string, agentId: AgentId): Promise<string | null>
  /* ^ System-tier (§3.4): fenced by the participant `agentId`, which session
   *   ingest has already bound to the reporting daemon's own agent. */
  /** Exact owner check for resume via the legacy per-agent mint path (the
   *  asserted agent must be the conversation's primary). Unknown and foreign
   *  bindings both return false. */
  owns(binding: WebchatConversationBinding): Promise<boolean>
  /** Owner check for the conversation-scoped mint path: returns the primary
   *  agent when (conversationId, orgId, userId) matches, else null. */
  ownedBy(conversationId: string, orgId: OrgId, userId: string): Promise<{ primaryAgentId: AgentId } | null>
  /** The resume-authorization subject of a conversation (null = unknown/foreign): its owner plus the
   *  current session of every participant, which the `session.continue` policy is applied to for
   *  anyone who is not the owner. */
  resumeBinding(conversationId: string, orgId: OrgId): Promise<WebchatResumeBinding | null>
  /** Session-targeted continuation (webchat-cross-integration-continuation.md
   *  §6.2): find-or-create the caller's ONE conversation adopting
   *  `targetSessionId` — concurrent mints converge on the
   *  `(userId, targetSessionId)` unique row. Creation atomically installs the
   *  adopted session as `currentSessionId` and the single primary participant. */
  upsertSessionTargeted(
    binding: Omit<WebchatConversationBinding, 'conversationId'>,
    targetSessionId: string
  ): Promise<{ conversationId: string }>
  /** The conversation's continuation target (null target = ordinary webchat
   *  conversation; null return = unknown/foreign conversation). */
  target(conversationId: string): Promise<{ targetSessionId: string | null } | null>
}

// ───────────────────────────────────────────────────────────────────────────
// Webchat MCP authority — durable delegation + invocation idempotency
// ───────────────────────────────────────────────────────────────────────────

export interface EstablishWebchatMcpDelegationInput {
  conversationId: string
  userId: string
  orgId: OrgId
  agentId: AgentId
  /** The placement the caller resolved its live authority against, re-checked under the agent row
   *  lock so a concurrent move cannot slip a delegation past the revocation that move performs. */
  expectedPlacement: PlacementRef
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
   * An already-expired row rotates its generation, as does a placement change,
   * which revokes the live row where it lands. A foreign/unknown conversation
   * binding or a moved placement returns null without mutating the current generation.
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
  /** Revoke live delegations of agents nothing serves any more; returns how many were revoked. */
  revokeUnplaced(now: Date): Promise<number>
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
  now: Date
}

export interface RevokeWebchatMcpGrantsInput {
  authorityId: string
  authorityGeneration: number
  conversationId: string
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

/** The token/cost snapshot carried by a `usage/report` EVT (protocol `SessionUsage`).
 *  Read shape: `costAmount` is a number because the session views only display it. */
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

/** What the store ACCEPTS: the same counts, with the cost already normalized to the
 *  exact decimal string by the ingress adapter. Nothing past an adapter writes money
 *  as a float, so the write path cannot reintroduce one. */
export type NormalizedUsageCounts = Omit<SessionUsageCounts, 'costAmount'> & { costAmount?: DecimalAmount }

/** Which authenticated ingress metered the session — stamped by the adapter that
 *  accepted the report, never self-reported by the payload. */
export type UsageSource = 'daemon' | 'gateway'

/** One usage report: the session's cumulative usage snapshot (latest-wins upsert). */
export interface SessionUsageInput {
  sessionId: string // ACP session id (agent-assigned; NOT a wire UUID)
  agentId: AgentId
  platform?: string | null
  channel?: string | null
  /** Model observed for this cumulative report's delta; null/absent ⇒ unknown. */
  model?: string | null
  source: UsageSource
  lastActivityAt: Date
  usage: NormalizedUsageCounts
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
  costAmount: DecimalAmount
}

/** Per-model rollup over a time window. `null` is usage whose daemon did not
 *  report an effective model (legacy/runtime-owned default). */
export interface ModelUsageAggregate {
  model: string | null
  sessions: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  thoughtTokens: number
  cachedReadTokens: number
  cachedWriteTokens: number
  costAmount: DecimalAmount
}

/** One spend-over-time bucket: total cost of sessions whose last activity fell in
 *  `[start, start + one bucket)`. `start` is a UTC-aligned ISO instant.
 *  `byAgent`/`byModel` split the same total for the console's grouped/stacked
 *  chart (model key ''=unreported); only non-zero deltas get a key. */
export interface SpendBucket {
  start: string
  costAmount: DecimalAmount
  byAgent: Record<string, DecimalAmount>
  byModel: Record<string, DecimalAmount>
}

/** Per-ingress rollup over a window — the same shape as the agent rollup, keyed by
 *  which authenticated ingress metered the sessions instead of by agent. */
export interface SourceUsageAggregate extends Omit<AgentUsageAggregate, 'agentId'> {
  source: UsageSource
}

/** A half-open window, `[from, to)`, in UTC. Both ends are the CALLER's choice: the
 *  console turns its presets into one, and a billing period is another. */
export interface UsageWindow {
  from: Date
  to: Date
}

/** How wide a usage window may be. The series allocates one bucket per day (or per hour
 *  under two days), so an unbounded span is an unbounded allocation driven by a query
 *  string — year 0 to year 9999 is ~3.65M buckets. 400 days covers a calendar year with
 *  slack, which is what a billing period or a dashboard actually asks for; anything
 *  larger is a paging concern, not a single response. */
export const MAX_USAGE_WINDOW_DAYS = 400

/** Org-wide usage aggregate for a window: workspace totals + agent/model/source
 *  breakdowns.
 *  Every amount is an exact decimal string — the aggregate is what billing reads,
 *  so no step of the roll-up may go through a float.
 *  `costCurrency` is the single distinct currency across the window, or null when
 *  none/mixed (amounts are summed as-is).
 *  `series` is the spend-over-time chart data: cost bucketed by hour (a window of two
 *  days or less) or day, with empty buckets filled to 0 across the whole window. */
export interface UsageAggregate {
  /** The ORG's figures, whoever is reading. A total that omitted the rows a viewer may
   *  not read would be wrong in the direction that costs someone money, and the org's own
   *  spend is published to every member by the billing ledger anyway. */
  totals: { sessions: number; totalTokens: number; costAmount: DecimalAmount; costCurrency: string | null }
  agents: AgentUsageAggregate[]
  models: ModelUsageAggregate[]
  sources: SourceUsageAggregate[]
  /** What `totals` holds that the reader may not attribute, as one id-less rollup — so
   *  `Σ agents + unattributed = totals` and `Σ models + unattributed = totals`. Absent
   *  when the reader could attribute everything (which is every read with no `viewer`).
   *
   *  Withheld by EITHER predicate: a restricted agent, or another user's private session
   *  on an agent the reader can see. So it is unattributable usage, not hidden agents.
   *
   *  Aggregated independently, never `totals` minus the visible rows: a subtraction is a
   *  plug figure that would absorb any attribution bug and leave the caller adding up
   *  perfectly, where an independent sum makes the equality a checkable invariant. */
  unattributed?: Omit<AgentUsageAggregate, 'agentId'>
  /** Viewer-scoped, splits and per-bucket total alike, so a bucket never hands over
   *  withheld spend resolved in time. It therefore does NOT sum to `totals` — see
   *  `unattributed`. This is a convenience boundary, NOT a security one: `from`/`to` are
   *  the caller's, so consecutive narrow windows reconstruct the residual timeline anyway. */
  series: { bucket: 'hour' | 'day'; points: SpendBucket[] }
}

export interface SessionUsageRepo {
  /** Upsert a session's cumulative usage (idempotent on `(agentId, sessionId)`).
   *  A LATE report still writes its own timeline checkpoint idempotently, but never
   *  rolls the snapshot back to an older `lastActivityAt`. */
  record(input: SessionUsageInput): Promise<void>
  /** Read one session's latest cumulative usage snapshot. */
  get(agentId: AgentId, sessionId: string): Promise<SessionUsageCounts | null>
  /** Aggregate usage for an org over the half-open window `[from, to)`.
   *  `source` scopes the whole answer — totals, every breakdown, and the series — to
   *  one ingress; omitted, it counts both.
   *  `viewer`/`sessionViewer` scope ATTRIBUTION, not the sums: see `UsageAggregate`.
   *  When a `viewer` is supplied, sessions of restricted agents they can't see keep their
   *  place in `totals` but are folded into `unattributed` instead of into their agent's
   *  row (derived visibility, via the `agent` relation — undefined alone attributes all).
   *  `tzOffsetMin` (UTC − local, as `getTimezoneOffset()` reports) aligns the spend
   *  `series` buckets to the viewer's local day/hour; 0 (default) ⇒ UTC. */
  aggregate(
    orgId: OrgId,
    window: UsageWindow,
    viewer?: ViewCtx,
    tzOffsetMin?: number,
    sessionViewer?: SessionFilterQuery['viewer'],
    source?: UsageSource
  ): Promise<UsageAggregate>
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
  visibility: ResourceVisibility
  sharedWith: string[] // complete app_user.id audience when visibility='restricted'
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
  /** Create-or-edit by the CLIENT-MINTED `cronId`. Org-fenced inside the
   *  transaction (docs/designs/org-scoped-data-layer.md §3): an id that already
   *  exists in ANOTHER organization throws {@link CronMissing} rather than
   *  letting the update branch rewrite that row (and its `orgId`) — the one
   *  place in this port where a missing route check was a takeover, not a leak. */
  upsert(input: UpsertCronInput): Promise<CronRecord>
  /** Set the visibility + share set (the dedicated `/sharing` write path, kept
   *  separate from the content `upsert` which needs the full definition). Stamps
   *  the last-modified audit; `byUserId` is the editing WebUI principal.
   *  Org-fenced: a cross-org id throws the same P2025 as a missing row. */
  setSharing(
    orgId: OrgId,
    cronId: CronId,
    sharing: { visibility: ResourceVisibility; sharedWith: string[] },
    byUserId?: string
  ): Promise<CronRecord>
  /** Org-fenced: a cross-org id throws the same P2025 as a missing row. */
  remove(orgId: OrgId, cronId: CronId): Promise<void>
  /** Console list (org-wide, orphans included). Every supplied human principal
   *  is resource-filtered; undefined is reserved for unfiltered internal reads
   *  (authorization/policy.ts#visibilityWhere). */
  listForOrg(orgId: OrgId, viewer?: ViewCtx): Promise<CronRecord[]>
  /** Every cron definition owned by one agent (cold placement-move snapshot).
   *  System-tier (§3.4): agent-fenced, orchestration-only. */
  listForAgent(agentId: AgentId): Promise<CronRecord[]>
  /** Apply a daemon `cron/report`. The reporting daemon's authority is settled by the caller
   *  against the placement resolver (placement ∪ live duty holders), never by a join here.
   *  `lastRunAt` is latest-wins (re-asserts / out-of-order reports never
   *  regress it); the run row upserts on (cronId, firedAt) — the fire report
   *  opens it `running`, a progress report can attach its session, and the
   *  completion report closes it. Returns whether the report was accepted
   *  (false ⇒ unknown cron, dropped). */
  recordReport(cronId: CronId, report: CronReportInput): Promise<boolean>
  /** Run history for the console detail page, newest first. Run rows carry
   *  their own `orgId`, so the fence rides this query directly rather than only
   *  through the parent cron (§3.6). */
  listRuns(orgId: OrgId, cronId: CronId, limit?: number): Promise<CronRunRecord[]>
  /** Reconcile orphaned runs: close every row still `running` whose `startedAt`
   *  is before `staleBefore` to `failed` with a marker reason (its completion
   *  report was lost — daemon offline / drained at turn end). Non-destructive: a
   *  late completion report still overwrites the outcome (the run-row upsert is
   *  last-writer-wins). Returns the number of rows reaped. Org-wide (a global
   *  maintenance sweep, not scoped to one daemon). System-tier by construction. */
  reapStaleRuns(staleBefore: Date): Promise<number>
  /** The cron set THIS daemon should run — crons of agents placed on it
   *  (`register/ok.crons[]`, same scope rule as integrations §3.11).
   *  System-tier: daemon-fenced. */
  listForDaemon(daemonId: DaemonId): Promise<CronRecord[]>
  /** The crons of these agents — the duty half of the reconcile roster, whose
   *  agents are named by the ledger, not by placement. */
  listForAgents(agentIds: readonly string[]): Promise<CronRecord[]>
  /** Org-fenced point read (§3): a cross-org id reads as absent, exactly like a
   *  missing row. Also the `cron/report` fence's read — it needs the cron's OWNING AGENT before
   *  it can ask the resolver who serves it, fenced on the frame's org like every WS read. */
  get(orgId: OrgId, cronId: CronId): Promise<CronRecord | null>
}

// ───────────────────────────────────────────────────────────────────────────
// HookRepo — inbound-webhook triggers (webhook-triggers-and-github-events.md)
//   Definitions + run metadata only. The relay is the ingress: the CP compiles
//   HookDef rows into rc/hook-assign rules; event payloads never land here.
// ───────────────────────────────────────────────────────────────────────────

/** Re-exported so the repository layer keeps one hook-kind vocabulary with the wire contract. */
export type { HookKind }
export type HookSessionMode = 'perDelivery' | 'perThread' | 'shared'
export type GithubCommentFamily = 'issues' | 'pull_request'
/** The stored comment-family vocabulary across code hosts; rows carry one host's subset. */
export type HookCommentFamily = GithubCommentFamily | 'merge_request'
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
  /** REQUIRED for kind=gitlab: the instance `repoId` names, joining the §24.1
   *  axis fence inside the insert transaction. Omitting it on a gitlab hook is
   *  refused, because a disabled hook takes no binding lease of any kind. */
  axisBaseUrl?: string
  /** Generic-endpoint routing key — minted server-side on CREATE, immutable
   *  after (the capability URL must survive edits). */
  urlToken?: string
  // ── kind=github (P2) — resolved server-side from repoFullName at create/update ──
  /** GitHub numeric repo id — the relay match key (rename-immune, decision 6). */
  repoId?: bigint
  repoFullName?: string
  events?: string[]
  /** Empty preserves the published API's legacy repo-wide issue_comment semantics. */
  commentFamilies?: HookCommentFamily[]
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
  commentFamilies: HookCommentFamily[]
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
  /** Organization captured with the accepted delivery. */
  orgId: OrgId
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
  publishedCommentKind: GithubPublishedComment['kind'] | null
  publishedCommentId: string | null
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
  publishedComment?: GithubPublishedComment
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
  /** Create-or-edit. `hookId` is minted server-side on create, so the update
   *  branch is only ever reached with an id the route already resolved — but the
   *  fence is structural anyway (docs/designs/org-scoped-data-layer.md §3): an id
   *  that exists in ANOTHER organization throws {@link HookMissing} inside the
   *  same transaction rather than letting the update rewrite that row's `orgId`. */
  upsert(input: UpsertHookInput): Promise<HookRecord>
  /** Org-fenced: a cross-org id throws the same missing-row error as an absent
   *  one. `expectedAgentId` is the independent owner CAS (a rebind loser), kept. */
  remove(orgId: OrgId, hookId: HookId, expectedAgentId?: AgentId): Promise<void>
  /** Org-fenced point read (§3): a cross-org id reads as absent, exactly like a
   *  missing row. The only hook read the HTTP/MCP surface may use. */
  get(orgId: OrgId, hookId: HookId): Promise<HookRecord | null>
  /** Tenancy-UNSCOPED read for internal trust domains — the GitHub review broker
   *  and rerequest machinery resolving the hook behind a run/projection row, and
   *  WS handlers resolving the hook a reporting daemon named. Never call this
   *  from the HTTP surface; lint enforces it (§6). */
  getUnscoped(hookId: HookId): Promise<HookRecord | null>
  /** Org-fenced batch read: ids outside `orgId` are simply absent from the
   *  result, exactly like unknown ids. */
  getMany(orgId: OrgId, hookIds: HookId[]): Promise<HookRecord[]>
  /** Tenancy-UNSCOPED batch read for the GitHub machinery: the comment-authorization
   *  fences and the rerequest resolver address hooks by ids carried on durable
   *  run/projection rows, which already fix the organization. Never call this
   *  from the HTTP surface; lint enforces it (§6). */
  getManyUnscoped(hookIds: HookId[]): Promise<HookRecord[]>
  /** Every enabled hook, all orgs — the relay-register full-replay source.
   *  System-tier: the relay pool is deployment-level infrastructure. */
  listEnabled(): Promise<HookRecord[]>
  /** A hook is subordinate to one agent and is only ever listed under it (the
   *  console detail page); access is gated by the AGENT's visibility, so no
   *  viewer-filter here. Also the re-compile source on a placement change.
   *  System-tier (§3.4): agent-fenced, and HTTP callers reach it only with an
   *  agent id resolved through the org-fenced `AgentRepo.get`. */
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
   * observation. Returns changed hooks for relay convergence, plus every agent whose
   * spec the rename edited — App-backed workspaces and additional-repository grant
   * owners alike — for daemon config convergence. */
  refreshGithubRepoFullName(
    sourceHookId: HookId,
    repoId: bigint,
    repoFullName: string,
    observedAt: Date
  ): Promise<GithubRepoFullNameRefreshResult>
  /** System-tier: the run row behind a relay/daemon report or a durable
   *  projection, always reached from system state that already fixes the org. */
  getRun(hookId: HookId, deliveryKey: string): Promise<HookRunRecord | null>
  /** Direct lookup for projection-owned metadata such as the terminal session deep link. */
  getRunById(runId: string): Promise<HookRunRecord | null>
  /** Org-fenced: the pull-request run owning one session, for the console's PR panel. */
  latestPullRequestRunForSession(orgId: OrgId, sessionId: string): Promise<HookRunRecord | null>
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
  /** Apply a daemon `hook/report` completion. Scoped: the REPORTING daemon must be the run's
   *  accepted dispatch target or serve its agent now. Last-writer-wins; a completion with
   *  no prior delivery row (rc/run-report lost) still creates one, with
   *  `startedAt` estimated as `at − durationMs`. Returns acceptance. */
  recordReport(hookId: HookId, reportingDaemonId: DaemonId, input: HookReportInput, at: Date): Promise<boolean>
  /** Run history for the console detail page, newest first. Run rows carry their
   *  own `orgId`, so the fence rides this query directly rather than only through
   *  the parent hook (§3.6). */
  listRuns(orgId: OrgId, hookId: HookId, limit?: number): Promise<HookRunRecord[]>
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
  /** Latest external-PR run per hook/PR, preserving shared-head ambiguity. */
  listReviewRequestRequiredRuns(repoId: bigint, headSha: string, pullNumber?: number): Promise<HookRunRecord[]>
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
  /** Release a projection that has nothing left to publish, clearing its due time so the
   *  bounded claim stops returning it. Any later work re-arms `nextAttemptAt`. */
  settleReviewProjection(projectionId: string, generation: bigint, leaseOwner: string): Promise<boolean>
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

// ───────────────────────────────────────────────────────────────────────────
// CodeHostRunProjectionRepo — the provider-neutral informational run projection
// (gitlab-com-integration.md §16). One row per (hook, project, MR IID, head
// SHA, projection epoch). It ports the GitHub Checks writer's generation,
// lease, pending-intent, write-marker, tombstone, and out-of-order rules, but
// inverts the writer: the OWNING DAEMON is the only provider writer, so
// `leaseOwner` is a daemon id and an offline one leaves the row pending.
// ───────────────────────────────────────────────────────────────────────────

export interface CodeHostRunProjectionRecord {
  id: string
  provider: string
  hookId: HookId
  orgId: OrgId
  agentId: AgentId
  agentName: string | null
  projectId: bigint
  projectPath: string
  mergeRequestIid: number
  headSha: string
  projectionEpoch: bigint
  generation: bigint
  /** (hookId, deliveryKey) is the hook-run identity, so the delivery key IS the owning run. */
  currentDeliveryKey: string | null
  currentRunAt: Date | null
  /** Hidden stable marker the daemon reconciles its note by; stable across generations. */
  externalId: string
  noteId: string | null
  desiredState: CodeHostNoteState
  observedState: CodeHostNoteState | null
  reason: string | null
  /** Terminal-authority watermark, separate from `generation`: it orders AUTHORITY, not writes. */
  sealedThrough: bigint
  queuedAt: Date | null
  startedAt: Date | null
  completedAt: Date | null
  sessionId: string | null
  credentialEpoch: bigint
  configRevision: bigint | null
  dispatchRevision: bigint | null
  dispatchDaemonId: string | null
  reviewPolicySnapshot: HookReviewPolicy | null
  reportingModeSnapshot: HookReportingMode | null
  gateModeSnapshot: HookGateMode | null
  /** The daemon that currently holds the write, not a Control-Plane worker. */
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

export interface UpsertCodeHostRunProjectionInput {
  provider: string
  hookId: HookId
  orgId: OrgId
  agentId: AgentId
  agentName: string
  projectId: bigint
  projectPath: string
  mergeRequestIid: number
  headSha: string
  projectionEpoch: bigint
  desiredState: CodeHostNoteState
  reason?: string
  currentDeliveryKey: string
  /** Relay ingest / report time of this edge — the total order an older edge loses against. */
  currentRunAt: Date
  sessionId?: string
  credentialEpoch?: bigint
  configRevision?: bigint
  dispatchRevision?: bigint
  dispatchDaemonId?: string
  reviewPolicySnapshot?: HookReviewPolicy
  reportingModeSnapshot?: HookReportingMode
  gateModeSnapshot?: HookGateMode
  queuedAt?: Date
  startedAt?: Date
  completedAt?: Date
  nextAttemptAt: Date
}

export interface CodeHostProjectionWriteResultInput {
  projectionId: string
  generation: bigint
  leaseOwner: string
  writeMarker: string
  observedState: CodeHostNoteState
  noteId?: string
  settledErrorCode?: string
  /** Keeps a changed desired state due after the older write reconciled. */
  recheckAt?: Date
}

export interface CodeHostRunProjectionRepo {
  /** Record or advance the desired generation for one natural key. A tombstoned row is never
   *  revived, an older run never takes the row from a newer one, and an edge that lands while a
   *  provider mutation is in flight is parked as `pendingIntent` instead of moving the generation.
   *  Null ⇒ the owner is retired: creation is refused under the owner-lifecycle fence. */
  upsert(input: UpsertCodeHostRunProjectionInput): Promise<CodeHostRunProjectionRecord | null>
  /** Move the desired state within one generation. A non-terminal edge loses to `sealedThrough`. */
  setDesired(
    projectionId: string,
    generation: bigint,
    desiredState: CodeHostNoteState,
    nextAttemptAt: Date,
    reason?: string
  ): Promise<boolean>
  /** A newer head preempted every older generation on the same merge request (§16). */
  supersede(
    hookId: HookId,
    projectId: bigint,
    mergeRequestIid: number,
    currentHeadSha: string,
    at: Date
  ): Promise<number>
  /** Take the write for one generation on behalf of `leaseOwner` (a daemon id) and arm the mutex.
   *  Refused while another mutation is in flight — ownership may not move mid-write. */
  beginWrite(
    projectionId: string,
    generation: bigint,
    leaseOwner: string,
    writeMarker: string,
    writePhase: string,
    startedAt: Date,
    leaseUntil: Date
  ): Promise<boolean>
  /** Settle the daemon's reported outcome. Fenced on generation ∧ lease owner ∧ marker, so an
   *  older generation's result can never regress a newer desired state. */
  completeWrite(input: CodeHostProjectionWriteResultInput): Promise<boolean>
  /** A deterministic no-effect failure releases the mutex AND the lease; an ambiguous one keeps both
   *  (`keepWriteMutex`) so only that daemon's reconciliation, never a replay, may follow. Fenced on
   *  the echoed marker so a late duplicate of an older attempt settles nothing. */
  failWrite(
    projectionId: string,
    generation: bigint,
    leaseOwner: string,
    writeMarker: string,
    errorCode: string,
    nextAttemptAt: Date,
    keepWriteMutex?: boolean
  ): Promise<boolean>
  /** Drain a parked intent into a fresh generation once no mutation is in flight. */
  advancePending(
    projectionId: string,
    generation: bigint,
    fallbackNextAttemptAt: Date
  ): Promise<CodeHostRunProjectionRecord | null>
  get(projectionId: string): Promise<CodeHostRunProjectionRecord | null>
}

/** Per-hook HMAC signing key — read ONLY here, NEVER joined into a DTO
 *  (BotSecretStore discipline). */
/**
 * The per-hook HMAC secret. Rows are keyed by `hookId` alone and carry no org of
 * their own, so this store fences through its parent (§3.6): `put` runs on the
 * create path with a server-minted id, and `get`/`delete` belong to the relay
 * hook-compile and lifecycle machinery. A route reaching a secret for an
 * existing hook must resolve that hook through the org-fenced
 * {@link HookRepo.get} first.
 */
/** Child of `HookDef`, so the parent's fence already covers tenancy
 *  (org-scoped-data-layer.md §3.6). `orgId` is here because it now selects the
 *  at-rest KEY (per-org-secret-encryption.md §4); the extra fence is a bonus. */
export interface HookSecretStore {
  put(orgId: OrgId, hookId: HookId, hmacSecret: string): Promise<void>
  get(orgId: OrgId, hookId: HookId): Promise<string | null>
  delete(orgId: OrgId, hookId: HookId): Promise<void>
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
  /** Bot scopes the platform REPORTED as granted for the credential being
   *  stored (Slack: the `x-oauth-scopes` header of the install's `auth.test`).
   *  Omit when the platform did not report one — absence is "unknown", never a
   *  short grant. */
  grantedScopes?: string[]
  createdByUserId?: string
}

/** Tenant sentinel for NEW rows of tenantless platforms (D6/§11): a real value —
 *  unlike NULL — participates in the composite unique, so it is what makes
 *  `(platform, externalAppId)` enforceable. NULL stays reserved for legacy rows. */
export const TENANTLESS_SENTINEL = '-'

/**
 * The GENERIC identity columns of a `bot` row (D6/§11) — the platform-neutral
 * home for what used to live only in per-platform columns.
 *
 *  - `externalAppId` / `externalTenantId` are the composite-unique pair the D6
 *    fence enforces. A platform with no tenant axis writes
 *    {@link TENANTLESS_SENTINEL} rather than leaving the tenant NULL, because a
 *    NULL never participates in a composite unique and would silently disable
 *    the fence. NULL is reserved for LEGACY rows written before D6.
 *  - `platformConfig` is the generic bag for a platform's public row metadata
 *    (its console-link app id, its gateway region), carried so the legacy
 *    per-platform columns can eventually be dropped.
 *
 * Every value here is PUBLIC metadata — no token or secret ever belongs in it.
 */
export interface BotIdentityColumns {
  externalAppId?: string
  externalTenantId?: string
  platformConfig?: Record<string, string>
}

/**
 * How {@link BotRepo.create} learns a new row's {@link BotIdentityColumns}
 * (audit F13).
 *
 * WHY A PORT AND NOT A `switch (input.platform)`. Which columns carry a bot's
 * demux identity — and which platform has no tenant axis and so writes the
 * sentinel — is per-platform knowledge, and it sat in shared persistence as a
 * four-arm switch that a fifth platform would have had to edit
 * (integration-plugin-architecture.md §12). It is now
 * `CpPlatformProvider.projectBotIdentity`, wired in at the composition root;
 * persistence keeps the WRITE (and therefore the §11 invariant that every new
 * row gets its generic pair) and names no platform.
 *
 * Total by contract: a platform that declares nothing projects `{}`, which is
 * what a platform with no external app identity at all (Telegram — a bot token
 * and nothing else) legitimately has.
 */
export type BotIdentityProjector = (input: CreateBotInput) => BotIdentityColumns

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
  /** Bot scopes the platform reported as granted for the CURRENT credential
   *  (Slack: `x-oauth-scopes`, persisted at install / refresh verification).
   *  `null` means never observed — an UNKNOWN grant, not an empty one — so a
   *  capability read may treat the bot as eligible-but-unproven, never as
   *  short. Advisory metadata; never an authorization fence by itself. */
  grantedScopes: string[] | null
  /** Generic demux identity (D6): the platform's app-scoped id. Dual-written beside
   *  the legacy per-platform columns; NULL on legacy rows. */
  externalAppId: string | null
  /** Tenant half of the demux identity (Slack team id). `'-'` sentinel on new rows
   *  of tenantless platforms; NULL on legacy rows (NULLs-distinct semantics). */
  externalTenantId: string | null
  /** Display-only per-platform bag (discordAppId / feishuAppId / feishuRegion fold
   *  here when reads switch). */
  platformConfig: Record<string, unknown> | null
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
  /** Org-fenced point read (docs/designs/org-scoped-data-layer.md §3): a
   *  cross-org id reads as absent, exactly like a missing row. The only bot read
   *  the HTTP/MCP surface may use. */
  get(orgId: OrgId, id: BotId): Promise<BotRecord | null>
  /** Tenancy-UNSCOPED read for internal trust domains — the shared-bot
   *  orchestrator converging a relay assignment, integration/placement push
   *  resolving the bot behind an integration row, WS-reported credential
   *  lifecycle. Never call this from the HTTP surface; lint enforces it (§6). */
  getUnscoped(id: BotId): Promise<BotRecord | null>
  listForOrg(orgId: OrgId): Promise<BotRecord[]>
  /** Record workspace metadata learned from OAuth/auth.test. A missing name
   *  preserves the last known label. Org-fenced: a cross-org id writes nothing
   *  (the row is filtered out of the update). */
  setWorkspaceMetadata(orgId: OrgId, id: BotId, workspaceId: string, workspaceName: string | null): Promise<void>
  /** Record the granted bot scopes an install/refresh verification OBSERVED for
   *  the bot's current credential. Callers pass only a non-empty observed set —
   *  "the platform reported nothing" keeps the last known set rather than
   *  overwriting knowledge with silence. Org-fenced: a cross-org id writes
   *  nothing. */
  setGrantedScopes(orgId: OrgId, id: BotId, scopes: readonly string[]): Promise<void>
  /** Slack bots missing public app/workspace/member identity metadata.
   *  System-tier: the identity reconciler's worklist is deliberately fleet-wide. */
  listSlackMissingIdentity(): Promise<BotRecord[]>
  /** Backfill only a missing id; never replace an established Slack app identity.
   *  System-tier: reconciler-only, driven off {@link BotRepo.listSlackMissingIdentity}
   *  and fenced by its own `slackAppId IS NULL` CAS predicate, so an org
   *  parameter re-derived from that worklist would be tautological (§3.4). */
  setSlackAppIdIfMissing(id: BotId, slackAppId: string): Promise<boolean>
  /** Backfill only a missing Slack member id; never replace an established identity.
   *  System-tier like {@link BotRepo.setSlackAppIdIfMissing}. */
  setSlackBotUserIdIfMissing(id: BotId, botUserId: string): Promise<boolean>
  /** Stamp the freed-bot display hints when its LAST integration is removed.
   *  Org-fenced: a cross-org id writes nothing. */
  markFreed(orgId: OrgId, id: BotId, at: Date, lastAgentName: string | null): Promise<void>
  /** Flip the shared-bot (multi-agent) opt-in (console toggle). Serialized on the
   *  bot row with {@link IntegrationRepo.addBotMembership}; disabling recounts the
   *  ACTIVE installs under that lock and throws `BotStillShared` when >1 remain,
   *  so a concurrent admission can never slip past the route's optimistic check.
   *  Org-fenced: the lock read is filtered, so a cross-org id throws the same
   *  missing-row error ({@link BotMissing}) as an absent one. */
  setShareable(orgId: OrgId, id: BotId, shareable: boolean): Promise<void>
  /** Every http-transport bot with ≥1 active integration, across all orgs — the
   *  shared-bot orchestrator's convergence worklist (relay register / failover).
   *  System-tier: fleet-wide by design. */
  listHttpActive(): Promise<BotRecord[]>
  /** Workspace-claim admission predicate (ingress-tenant-fence.md §5): does a
   *  DIFFERENT organization already hold a bot for this app+workspace? The
   *  question is deliberately cross-org — one app installed into one workspace
   *  by two orgs shares its inbound-verification secret AND its tenant, which
   *  the relay's delivery-time fence cannot tell apart — but the answer is a
   *  boolean, so no foreign row crosses the persistence seam. Revoked rows
   *  still claim (workspace transfer is an explicit delete-then-reinstall,
   *  never a silent capture). A DIFFERENT app in the same workspace is not a
   *  claim: distinct apps carry distinct secrets, so nothing is ambiguous. */
  workspaceClaimedElsewhere(orgId: OrgId, platform: string, appId: string, workspaceId: string): Promise<boolean>
  /** CROSS-ORG lookup by the generic demux identity (D6). Pass
   *  {@link TENANTLESS_SENTINEL} as `externalTenantId` for tenantless platforms —
   *  the same value {@link BotIdentityProjector} writes. Legacy rows (NULL
   *  identity) are unreachable here by design. */
  getByExternalIdentity(platform: string, externalAppId: string, externalTenantId: string): Promise<BotRecord | null>
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
   *
   * System-tier (§3.4): reached only through {@link BotCredentialWriter}, whose
   * install arm runs after the platform callback has resolved the row by its
   * external demux identity — a deliberately cross-org lookup that already
   * settles which organization owns the credential.
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
   *
   * System-tier (§3.4): relay-reported lifecycle, already fenced by the
   * credential generation CAS above — a stronger axis than the owning org.
   */
  revokeIfCurrent(id: BotId, at: Date, fence: { revision?: number; eventAt?: Date }): Promise<boolean>
  /** Callers must refuse while the bot is installed (FK Restrict backstops).
   *  Org-fenced: a cross-org id throws the same Prisma P2025 as an absent row. */
  delete(orgId: OrgId, id: BotId): Promise<void>
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
  /** Claim/update by GitHub installation id. The setup callback is the only
   * path allowed to create a claim; refresh paths pass the durable claim's org. */
  upsertFromGithub(orgId: OrgId, facts: GithubInstallationFacts): Promise<GithubInstallationRecord>
  /** Org-fenced point read (org-scoped-data-layer.md §3): a cross-org id reads
   *  as absent, exactly like a missing row. The claim row IS the tenancy record
   *  for an installation, so this is the read the HTTP surface must use. */
  get(orgId: OrgId, id: string): Promise<GithubInstallationRecord | null>
  /** Live (non-revoked) installations claimed by the org — the picker's first level. */
  listForOrg(orgId: OrgId): Promise<GithubInstallationRecord[]>
  /** Every durable claim for an org, including revoked rows. Sync refreshes
   * exactly this set, so it never assigns an unclaimed or foreign installation. */
  listClaimsForOrg(orgId: OrgId): Promise<GithubInstallationRecord[]>
  /** Mint-time resolution: the live installation covering `accountLogin` in this org. */
  liveByOrgAndAccount(orgId: OrgId, accountLogin: string): Promise<GithubInstallationRecord | null>
  /** Doorbell lookup by GITHUB-side id (revoked rows included — the claim row is
   *  what maps the poke to an org; unknown ⇒ no org claim yet, ignore).
   *  System-tier and deliberately CROSS-ORG: resolving the owning organization
   *  is the whole point of this read, so it cannot take one. */
  getByInstallationId(installationId: bigint): Promise<GithubInstallationRecord | null>
  /** Doorbell revoke: GitHub answered 404/410 for this installation (never delete).
   *  System-tier: GitHub-driven, keyed by the same cross-org external id. */
  markRevokedByInstallationId(installationId: bigint): Promise<void>
}

/** One-shot install-state nonces (`github_install_state`): put on mint, consume-once on callback. */
export interface GithubInstallStateStore {
  put(nonce: string, orgId: OrgId, expiresAt: Date): Promise<void>
  /** True iff the nonce existed (it is deleted atomically) — false ⇒ replay/unknown. */
  consume(nonce: string): Promise<boolean>
}

// ───────────────────────────────────────────────────────────────────────────
// CodeHostRepositoryRepo — the provider-qualified repository catalog
// (gitlab-com-integration.md §8.1). Readers-first: writers converge referenced
// repos into it while legacy github columns stay the read path; GitLab readers
// join it from day one.
// ───────────────────────────────────────────────────────────────────────────

export interface CodeHostRepositoryRecord {
  id: string
  orgId: string
  provider: string // 'github' | 'gitlab' — app-layer closed set
  externalId: bigint // numeric repo/project id — the rename-immune match key
  displayPath: string // mutable display hint, never matched on
  cloneUrl: string | null
  defaultBranch: string | null
}

export interface CodeHostRepositoryRepo {
  /** Convergent catalog write: insert or refresh the mutable hints for one referenced repo. */
  upsert(input: {
    orgId: string
    provider: string
    externalId: bigint
    displayPath: string
    cloneUrl?: string
    defaultBranch?: string
  }): Promise<CodeHostRepositoryRecord>
  byExternalId(orgId: string, provider: string, externalId: bigint): Promise<CodeHostRepositoryRecord | null>
  listForOrg(orgId: string): Promise<CodeHostRepositoryRecord[]>
}

// ───────────────────────────────────────────────────────────────────────────
// GitLab.com OAuth connections (gitlab-com-integration.md §8.2, §9) — the
// administration identity. Sealed token material lives ONLY behind
// GitlabConnectionSecretStore; DTO reads never join it.
// ───────────────────────────────────────────────────────────────────────────

export type GitlabConnectionState = 'connected' | 'reauth_required' | 'disconnected'

export interface GitlabConnectionRecord {
  id: string
  orgId: string
  userId: string | null
  gitlabUserId: bigint
  gitlabUsername: string
  scopes: string[]
  accessExpiresAt: Date | null
  state: GitlabConnectionState
  tokenVersion: bigint
  lastSyncAt: Date | null
  createdAt: Date
}

/** A sealed (SecretCipher representation) access+refresh pair. */
export interface GitlabSealedTokenPair {
  accessToken: string
  refreshToken: string
}

export interface GitlabConnectionRepo {
  /** Callback upsert (§9.2), atomic with its sealed pair: a reader can never
   *  observe the new version/expiry with an old or missing pair. Reconnect
   *  advances the version, so any in-flight refresh CAS loses. */
  upsertOnCallback(input: {
    orgId: string
    userId: string
    gitlabUserId: bigint
    gitlabUsername: string
    scopes: string[]
    accessExpiresAt: Date | null
    sealedPair: GitlabSealedTokenPair
    /** The instance this pair was minted on; the write joins the §24.1 axis fence with it. */
    axisBaseUrl: string
  }): Promise<GitlabConnectionRecord>
  get(orgId: string, connectionId: string): Promise<GitlabConnectionRecord | null>
  listForOrg(orgId: string): Promise<GitlabConnectionRecord[]>
  /** Refresh single-writer (§9.3): claim a short lease iff free/expired/own. */
  claimRefreshLease(connectionId: string, owner: string, until: Date, now: Date): Promise<boolean>
  releaseRefreshLease(connectionId: string, owner: string): Promise<void>
  /** One atomic refresh commit: the tokenVersion CAS and the sealed pair land in
   *  the same transaction, or not at all. False ⇒ the caller lost (reconnect,
   *  disconnect, or another writer advanced the version) and must not retry. */
  commitRefresh(
    connectionId: string,
    expectedVersion: bigint,
    accessExpiresAt: Date | null,
    sealedPair: GitlabSealedTokenPair
  ): Promise<boolean>
  /** Version-fenced failure transition: a stale refresh outcome (older version)
   *  can never overwrite newer user intent such as a completed reconnect. */
  markReauthRequired(connectionId: string, expectedVersion: bigint): Promise<boolean>
  /** Atomic disconnect: state flip, version bump (defeats in-flight refresh CAS),
   *  and sealed-pair deletion in one transaction. The row stays as history. */
  disconnect(orgId: string, connectionId: string): Promise<boolean>
  /** Drop an already-released row (§9.4). Locks the row, re-checks the state and
   *  the assigned-binding count, and deletes — all in one transaction, because
   *  `installerConnectionId` is ON DELETE SET NULL: an unfenced delete would
   *  silently DETACH a binding a racing create had just attached. */
  remove(orgId: string, connectionId: string): Promise<GitlabConnectionRemoval>
}

/** Why a connection removal did or did not happen — the route maps it to a status. */
export type GitlabConnectionRemoval =
  | { outcome: 'removed' }
  | { outcome: 'blocked'; assignedProjects: number }
  | { outcome: 'not_disconnected' }
  | { outcome: 'missing' }

/** Sealed OAuth pair reads (per-org key scope). Writes ride the connection
 *  repo's atomic transitions; never joined by DTO queries. */
export interface GitlabConnectionSecretStore {
  get(orgId: string, connectionId: string): Promise<{ accessToken: string; refreshToken: string } | null>
}

export interface GitlabOauthStateRecord {
  nonce: string
  orgId: string
  userId: string
  browserHash: string | null
  returnPath: string
  verifier: string // sealed PKCE verifier
  expiresAt: Date
}

/** The deployment-level observed instance facts (§24.2), keyed on the normalized
 *  base URL so a re-targeted axis never inherits another instance's version. */
export interface GitlabInstanceStateRecord {
  baseUrl: string
  version: string
  enterprise: boolean
  observedAt: Date
}

export interface GitlabInstanceStateRepo {
  /** Last-observation-wins upsert: the authenticated version read at first
   *  credentialed contact, and every reconciliation refresh after it. */
  record(input: GitlabInstanceStateRecord): Promise<void>
  get(baseUrl: string): Promise<GitlabInstanceStateRecord | null>
}

export type GitlabBindingState = 'provisioning' | 'ready' | 'admin_degraded' | 'runtime_degraded' | 'cleanup_pending'

export interface GitlabProjectBindingRecord {
  id: string
  orgId: string
  projectId: bigint
  projectPath: string
  defaultBranch: string | null
  installerConnectionId: string | null
  webhookId: bigint | null
  desiredEventsHash: string | null
  credentialEpoch: bigint
  /** Set when a convergence lost a fence and wrote nothing; a sweep re-drives it. */
  convergeOwedAt: Date | null
  state: GitlabBindingState
  stateReason: string | null
  createdAt: Date
}

export interface GitlabProjectBindingRepo {
  /** §10.2 desired-state transaction: acquire the deployment-global claim, upsert
   *  the catalog row, and create the `provisioning` binding — atomically. A claim
   *  uniqueness loser throws GitlabProjectClaimConflict and mutates nothing. */
  createWithClaim(input: {
    orgId: string
    projectId: bigint
    projectPath: string
    defaultBranch?: string
    cloneUrl?: string
    installerConnectionId: string
    /** The instance these host-relative ids came from; joins the §24.1 axis fence. */
    axisBaseUrl: string
  }): Promise<GitlabProjectBindingRecord>
  get(orgId: string, bindingId: string): Promise<GitlabProjectBindingRecord | null>
  byProject(orgId: string, projectId: bigint): Promise<GitlabProjectBindingRecord | null>
  listForOrg(orgId: string): Promise<GitlabProjectBindingRecord[]>
  /** How many bindings each connection still administers, keyed by connection id
   *  (§7.1): a connection with any is not released and cannot be removed. */
  countByInstaller(orgId: string): Promise<Record<string, number>>
  /** Saga/reconciler facts (service account, webhook, path refresh, lifecycle). */
  update(
    orgId: string,
    bindingId: string,
    patch: Partial<{
      projectPath: string
      defaultBranch: string | null
      installerConnectionId: string | null
      webhookId: bigint | null
      desiredEventsHash: string | null
      convergeOwedAt: Date | null
      state: GitlabBindingState
      stateReason: string | null
    }>
  ): Promise<GitlabProjectBindingRecord | null>
  /** Record that a contended pass still owes convergence — but ONLY while the
   *  claim is still provisionable. A repair that loses to cleanup must not arm
   *  an obligation nothing can satisfy; one statement, so either order is safe. */
  markConvergeOwed(orgId: string, bindingId: string, at: Date): Promise<void>
  /** Bindings a contended convergence still owes work, oldest first (§10.2). */
  listConvergeOwed(before: Date, limit: number): Promise<GitlabProjectBindingRecord[]>
  /** Purge fence: every rotation/revocation/disconnect bumps it (§7.4/§19.4). */
  bumpCredentialEpoch(orgId: string, bindingId: string): Promise<bigint | null>
  /** §10.2 EXCLUSIVE run-owned provisioning lease, CAS-acquired before the
   *  first provider write: free, same-owner, or expired only — a live foreign
   *  lease refuses, so two runs can never both write. False also when the claim
   *  is gone, detached, or in cleanup. */
  markProviderMutationStarted(
    orgId: string,
    bindingId: string,
    projectId: bigint,
    owner: string,
    until: Date,
    now: Date
  ): Promise<boolean>
  /** Releases ONLY the owning run's lease. */
  endProviderMutation(orgId: string, bindingId: string, projectId: bigint, owner: string): Promise<void>
  /** Per-step ATOMIC renewal before every provider mutation: still attached,
   *  `active`, and owned by this run — and the lease is extended so it cannot
   *  expire while the provider request is in flight. */
  renewProviderLease(orgId: string, bindingId: string, projectId: bigint, owner: string, until: Date): Promise<boolean>
  /** Cleanup entry — mutually exclusive with a LIVE lease: false while one is
   *  held (cleanup retries later); flips the attached claim to `cleanup_pending`. */
  beginCleanup(orgId: string, bindingId: string, projectId: bigint, now: Date): Promise<boolean>
  /** Verified-complete cleanup only (§10.2/§19.4): the binding, its cascaded
   *  local rows, and the deployment-global claim are removed in ONE
   *  transaction. Anything short of verified cleanup keeps both. */
  removeWithClaim(orgId: string, bindingId: string, projectId: bigint): Promise<boolean>
}

// ───────────────────────────────────────────────────────────────────────────
// Per-agent runtime identity (§7.2, §8.2): one group service account per
// (organization, agent, top-level group), its project memberships, and the
// purpose-separated PATs it issues. Account and PAT lifecycle mutations run
// under the account's own mutation lease; membership and webhook work stays
// under the binding's provisioning lease.
// ───────────────────────────────────────────────────────────────────────────

/** §24.3: the instance withdrew the authority to create service accounts or their
 *  tokens. Its OWN state, never `admin_degraded`, because an account already
 *  provisioned keeps serving its unexpired credentials while authority is away. */
export const GITLAB_CREATION_FORBIDDEN_STATE = 'service_account_creation_forbidden'

/** Account rows reuse the binding lifecycle vocabulary and Console translations
 *  (§8.2), plus the one authority state a binding has no equivalent of (§24.3). */
export type GitlabAccountState = GitlabBindingState | typeof GITLAB_CREATION_FORBIDDEN_STATE

/** The generation fence a membership insert commits against (§7.2). */
export type GitlabAccountLifecycle = 'active' | 'retiring'

/** One recorded service-account creation attempt. `knownServiceAccountUserIds`
 *  is the root group's own service accounts at the moment the attempt opened,
 *  so an account absent from it is one this attempt created — the window a
 *  provider that reports no creation time for a service account still gives. */
export interface GitlabAccountCreateAttempt {
  id: string
  openedAt: Date
  knownServiceAccountUserIds: bigint[]
}

export interface GitlabAgentAccountRecord {
  id: string
  orgId: string
  agentId: string
  rootGroupId: bigint
  serviceAccountUserId: bigint | null
  username: string
  displayName: string | null
  avatarFingerprint: string | null
  /** The open, record-first service-account create window (§7.2), or null. */
  createAttempt: GitlabAccountCreateAttempt | null
  credentialEpoch: bigint
  administeringConnectionId: string | null
  generation: bigint
  lifecycle: GitlabAccountLifecycle
  state: GitlabAccountState
  stateReason: string | null
}

export interface GitlabAccountMembershipRecord {
  accountId: string
  accountGeneration: bigint
  bindingId: string
  accessLevel: number
}

/** One agent that binds a project, with the access level its authorization derives. */
export interface GitlabAccountConsumer {
  agentId: string
  accessLevel: number
}

/** One consumer, addressed by the project it consumes — the desired membership set convergence
 *  is judged against, across the whole organization rather than a project at a time. */
export interface GitlabProjectConsumer extends GitlabAccountConsumer {
  projectId: bigint
}

export interface GitlabAgentAccountRepo {
  /** Find-or-create the (org, agent, root) row; an existing row keeps its state. */
  ensure(input: {
    orgId: string
    agentId: string
    rootGroupId: bigint
    username: string
    administeringConnectionId: string | null
    /** The instance this root group id came from; joins the §24.1 axis fence. */
    axisBaseUrl: string
  }): Promise<GitlabAgentAccountRecord>
  get(accountId: string): Promise<GitlabAgentAccountRecord | null>
  byAgentRoot(orgId: string, agentId: string, rootGroupId: bigint): Promise<GitlabAgentAccountRecord | null>
  /** The account serving one agent on one project — the membership IS the resolution. */
  forAgentBinding(orgId: string, agentId: string, bindingId: string): Promise<GitlabAgentAccountRecord | null>
  /** Every account holding a membership on the binding (§12.1 veto set, DTO). */
  listForBinding(bindingId: string): Promise<GitlabAgentAccountRecord[]>
  listForAgent(orgId: string, agentId: string): Promise<GitlabAgentAccountRecord[]>
  /** Retirement sweep worklist (§19.4): every account whose retirement is still
   *  owed external cleanup, untouched since `before`. Keyed on the lifecycle, not
   *  on a reason — a row must not fall out of the sweep by failing differently. */
  listUnfinishedRetirements(before: Date, limit: number): Promise<GitlabAgentAccountRecord[]>
  /** Detach a membership as part of a binding's removal, recording in the SAME
   *  transaction that the removal now owes this account's retirement when the
   *  detach empties it. Durable before any provider write: a crash after the
   *  detach would otherwise lose the only link between the two. */
  detachMembershipForRemoval(accountId: string, bindingId: string): Promise<void>
  /** The retirements that removal is still owed evidence for. */
  listRetiringForBinding(bindingId: string): Promise<GitlabAgentAccountRecord[]>
  /** Every account the organization owns — the console's bot roster (§18.1). */
  listForOrg(orgId: string): Promise<GitlabAgentAccountRecord[]>
  update(
    accountId: string,
    patch: Partial<{
      serviceAccountUserId: bigint | null
      /** Cosmetic username convergence (§7.2) — the numeric user id stays the key. */
      username: string
      displayName: string | null
      avatarFingerprint: string | null
      administeringConnectionId: string | null
      state: GitlabAccountState
      stateReason: string | null
    }>
  ): Promise<GitlabAgentAccountRecord | null>
  /** §7.2 record-first create window: persisted BEFORE the provider write, so a
   *  crash between GitLab creating the account and the row committing its
   *  numeric id can still recover that account instead of refusing it. */
  openCreateAttempt(input: {
    accountId: string
    attemptId: string
    openedAt: Date
    knownServiceAccountUserIds: bigint[]
  }): Promise<GitlabAgentAccountRecord | null>
  /** §7.2: the resolved provider account becomes durable. The numeric user id,
   *  the username it actually carries, and the closed window commit in ONE
   *  write, so no exit can leave the row holding neither the id nor a window
   *  while the account exists at the provider. */
  commitServiceAccount(input: {
    accountId: string
    serviceAccountUserId: bigint
    username: string
    administeringConnectionId: string
  }): Promise<GitlabAgentAccountRecord | null>
  /** §7.2 mutation lease, CAS-acquired: free, same-owner, or expired only. */
  claimLease(accountId: string, owner: string, until: Date, now: Date): Promise<boolean>
  renewLease(accountId: string, owner: string, until: Date): Promise<boolean>
  releaseLease(accountId: string, owner: string): Promise<void>
  /** Generation-fenced membership insert: commits only while the row is `active`
   *  at exactly `generation`. False ⇒ a retirement won; the caller re-provisions. */
  attachMembership(input: {
    accountId: string
    generation: bigint
    bindingId: string
    accessLevel: number
  }): Promise<boolean>
  detachMembership(accountId: string, bindingId: string): Promise<void>
  membershipsForBinding(bindingId: string): Promise<GitlabAccountMembershipRecord[]>
  /** The account's own bound projects — agent deletion removes each membership
   *  at the provider before the account may retire (§19.4). */
  membershipsOfAccount(accountId: string): Promise<Array<{ bindingId: string; projectId: bigint }>>
  countMemberships(accountId: string): Promise<number>
  /** §7.2 retirement CAS: `active`→`retiring` in the SAME transaction that
   *  verifies the membership set is empty. False ⇒ a bind landed first. */
  beginRetirement(accountId: string): Promise<boolean>
  /** Verified-complete retirement: the row and its cascaded credentials go. */
  finishRetirement(accountId: string): Promise<void>
  /** The agents consuming a project: gitlab-workspace agents and enabled gitlab
   *  hooks, each with the access level its authorization derives (§7.2). */
  consumers(orgId: string, projectId: bigint): Promise<GitlabAccountConsumer[]>
  /** Every consumer in the organization, in two queries — the desired membership set the
   *  console's convergence signal is judged against, and the reasons it names on a row (§18.1). */
  consumersForOrg(orgId: string): Promise<GitlabProjectConsumer[]>
}

export type GitlabCredentialPurpose = 'read' | 'git_write' | 'effect'

export interface GitlabProjectCredentialRecord {
  id: string
  accountId: string
  purpose: GitlabCredentialPurpose
  externalTokenId: bigint
  scopes: string[]
  providerExpiresAt: Date
  generation: bigint
}

export interface GitlabProjectCredentialRepo {
  /** One atomic rotation commit per (account, purpose): credential metadata and
   *  generation, the SEALED value, and the account's credential-epoch purge
   *  fence land in the same transaction, or not at all (§7.4). */
  commitRotation(input: {
    accountId: string
    purpose: GitlabCredentialPurpose
    externalTokenId: bigint
    scopes: string[]
    providerExpiresAt: Date
    sealedToken: string
  }): Promise<GitlabProjectCredentialRecord>
  get(accountId: string, purpose: GitlabCredentialPurpose): Promise<GitlabProjectCredentialRecord | null>
  listForAccount(accountId: string): Promise<GitlabProjectCredentialRecord[]>
  /** Rotation worklist (§7.4): credentials whose provider expiry is before the horizon. */
  listExpiring(before: Date): Promise<Array<{ credential: GitlabProjectCredentialRecord; orgId: string }>>
  remove(accountId: string, purpose: GitlabCredentialPurpose): Promise<void>
}

/** Sealed PAT value reads (per-org key scope); writes ride the rotation commit. */
export interface GitlabProjectCredentialSecretStore {
  get(orgId: string, credentialId: string): Promise<string | null>
}

/** Sealed webhook signing key (whsec_ form); relay-only secret. */
export interface GitlabWebhookSecretStore {
  put(orgId: string, bindingId: string, signingKey: string): Promise<void>
  get(orgId: string, bindingId: string): Promise<string | null>
  delete(orgId: string, bindingId: string): Promise<void>
}

export interface GitlabOauthStateStore {
  put(input: Omit<GitlabOauthStateRecord, 'browserHash'>): Promise<void>
  /** Begin hop: stamp the browser-binding hash exactly once (null → value). */
  bindBrowser(nonce: string, browserHash: string, now: Date): Promise<GitlabOauthStateRecord | null>
  /** Callback: atomically delete and return the row — single use; null ⇒ replay/unknown/expired. */
  consume(nonce: string, now: Date): Promise<GitlabOauthStateRecord | null>
}

// ───────────────────────────────────────────────────────────────────────────
// CodeHostReviewLeaseRepo — the formal-review publication lease, its single-use
// operation ledger, and the body-free attempt outcome store
// (gitlab-com-integration.md §15.1, §15.2). Every durable transition here is a
// compare-and-swap under the subject's advisory lock; the transfer rules
// themselves are pure (`domain/code-host-review.ts`).
// ───────────────────────────────────────────────────────────────────────────

/** The provider-side subject a lease serializes: one merge request, one publisher. */
export interface CodeHostReviewSubject {
  provider: string
  projectExternalId: bigint
  mergeRequestIid: number
  serviceAccountExternalId: bigint
}

export interface CodeHostReviewLeaseRecord extends CodeHostReviewSubject {
  id: string
  orgId: string
  fence: bigint
  attemptId: string | null
  ownerDaemonId: DaemonId | null
  agentId: AgentId | null
  hookId: HookId | null
  deliveryKey: string | null
  event: string | null
  verdict: string | null
  headSha: string | null
  phase: CodeHostReviewLeasePhase
  leaseUntil: Date | null
  lockedReason: CodeHostReviewLockReason | null
}

export interface CodeHostReviewAcquireInput {
  subject: CodeHostReviewSubject
  orgId: string
  attemptId: string
  daemonId: DaemonId
  agentId: AgentId
  hookId: HookId
  deliveryKey: string
  event: string
  verdict: string
  headSha: string
  leaseUntil: Date
  now: Date
}

/** `held` is ordinary contention; `locked` is the indefinite fail-closed state. */
export type CodeHostReviewAcquireResult =
  | { outcome: 'acquired'; lease: CodeHostReviewLeaseRecord; condition: CodeHostReviewTransferCondition | 'fresh' }
  | { outcome: 'idempotent'; lease: CodeHostReviewLeaseRecord }
  | { outcome: 'held'; lease: CodeHostReviewLeaseRecord }
  | { outcome: 'locked'; lease: CodeHostReviewLeaseRecord; lock: CodeHostReviewLockReason | null }

export interface CodeHostReviewOperationRecord {
  id: string
  leaseId: string
  orgId: string
  attemptId: string
  fence: bigint
  ordinal: number
  kind: CodeHostReviewOpKind
  method: CodeHostReviewOpMethod
  target: string
  state: CodeHostReviewOpState
  startToken: string | null
  responseStatus: number | null
  responseExternalId: string | null
  resultCode: string | null
}

export interface CodeHostReviewIssueInput {
  attemptId: string
  orgId: string
  fence: bigint
  daemonId: DaemonId
  kind: CodeHostReviewOpKind
  method: CodeHostReviewOpMethod
  target: string
  ordinal: number
  now: Date
}

export interface CodeHostReviewAdvanceInput {
  attemptId: string
  orgId: string
  fence: bigint
  daemonId: DaemonId
  recordId: string
  now: Date
}

/** Every ledger refusal is terminal for that record; none of them is a retry hint. */
export type CodeHostReviewOpFailure =
  | { failure: 'no_lease' }
  | { failure: 'not_owner' }
  | { failure: 'stale_fence' }
  | { failure: 'lease_closed' }
  | { failure: 'no_record' }
  | { failure: 'permit_conflict' }
  | { failure: 'transition'; reason: CodeHostReviewOpRefusal }

export type CodeHostReviewOpResult =
  { outcome: 'ok'; record: CodeHostReviewOperationRecord; phase: CodeHostReviewLeasePhase } | CodeHostReviewOpFailure

/** The lease is resolved by `attemptId`; every other field is re-checked against it. */
export interface CodeHostReviewOutcomeInput {
  attemptId: string
  orgId: string
  hookId: HookId
  deliveryKey: string
  provider: string
  projectExternalId: bigint
  mergeRequestIid: number
  daemonId: DaemonId
  event: string
  verdict: string
  headSha: string
  state: CodeHostReviewState
  /** Already encoded as `"<kind>:<numeric id>"`; the repository refuses anything else. */
  externalIds: string[]
  now: Date
}

export type CodeHostReviewOutcomeResult =
  | { outcome: 'recorded'; phase: CodeHostReviewLeasePhase }
  | { outcome: 'idempotent'; phase: CodeHostReviewLeasePhase }
  | { outcome: 'not_owner' }
  | { outcome: 'conflict' }

export interface CodeHostReviewLeaseRepo {
  /** CAS acquisition under the subject's advisory lock; bumps the fence on every win. */
  acquire(input: CodeHostReviewAcquireInput): Promise<CodeHostReviewAcquireResult>
  /** Owner-only extension; a stale fence or a foreign daemon renews nothing. */
  renew(input: {
    attemptId: string
    orgId: string
    fence: bigint
    daemonId: DaemonId
    leaseUntil: Date
  }): Promise<CodeHostReviewLeaseRecord | null>
  byAttempt(attemptId: string): Promise<CodeHostReviewLeaseRecord | null>
  bySubject(subject: CodeHostReviewSubject): Promise<CodeHostReviewLeaseRecord | null>
  issueOperation(input: CodeHostReviewIssueInput): Promise<CodeHostReviewOpResult>
  startOperation(input: CodeHostReviewAdvanceInput & { startToken: string }): Promise<CodeHostReviewOpResult>
  settleOperation(
    input: CodeHostReviewAdvanceInput & { outcome: CodeHostReviewOpOutcome }
  ): Promise<CodeHostReviewOpResult>
  returnOperationUnused(input: CodeHostReviewAdvanceInput): Promise<CodeHostReviewOpResult>
  /** Persist the terminal classification and release or lock the lease with it. */
  recordOutcome(input: CodeHostReviewOutcomeInput): Promise<CodeHostReviewOutcomeResult>
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
  provider: CodeHostProvider // the host that numbers `repoId` — identity is (provider, repoId)
  repoId: bigint
  repoFullName: string // "owner/repo" as GitHub cases it, or a GitLab namespaced project path; refreshed on rename detection
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
    provider: CodeHostProvider
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
    provider: CodeHostProvider,
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
  put(orgId: OrgId, botId: BotId, material: BotSecretMaterial): Promise<void>
  get(orgId: OrgId, botId: BotId): Promise<BotSecretMaterial | null>
  delete(orgId: OrgId, botId: BotId): Promise<void>
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
    orgId: OrgId,
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
  merge(orgId: OrgId, agentId: AgentId, patch: Record<string, string | null>): Promise<void>
  /** Every secret of one agent ({} when none) — the wire-projection read
   *  (agent/upsert, register/ok roster, agent/activate). NEVER DTO this. */
  get(orgId: OrgId, agentId: AgentId): Promise<Record<string, string>>
  /** Key names only (sorted), batched for list DTOs — never touches values. */
  keys(orgId: OrgId, agentIds: readonly AgentId[]): Promise<Map<string, string[]>>
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
  /** Create the agent row + its initial secret rows in one transaction
   *  (fenced per {@link AgentRepo.create}). */
  create(input: CreateAgentInput, secrets?: Record<string, string>, opts?: AgentCreateOpts): Promise<AgentRecord>
  /** Apply a PATCH: secret merge (see {@link AgentSecretStore.merge} semantics)
   *  + row update in one transaction (fenced per {@link AgentRepo.update},
   *  including its org fence). */
  update(
    orgId: OrgId,
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
  upsertParticipant(botId: BotId, sessionKey: string, agentId: AgentId, daemonId: DaemonId): Promise<void>
  participants(botId: BotId, sessionKey: string): Promise<Array<{ agentId: AgentId; daemonId: DaemonId }>>
  participantsForBot(botId: BotId): Promise<Array<{ sessionKey: string; agentId: AgentId; daemonId: DaemonId }>>
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
  get(orgId: OrgId, id: string): Promise<SlackInstallRecord | null>
  /** The OAuth callback resolves a pending install by its unforgeable `state`
   *  before any org context exists — the state token is the authority there
   *  (org-scoped-data-layer.md §4). Callers take the org from the row. */
  getUnscoped(id: string): Promise<SlackInstallRecord | null>
  /** Backfill the OAuth-obtained bot token (xoxb) on the callback. False ⇒ row gone. */
  setBotToken(orgId: OrgId, id: string, botToken: string): Promise<boolean>
  delete(orgId: OrgId, id: string): Promise<void>
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
  /** Required bot scopes the workspace authorization did not grant, when
   *  `failureReason` is 'missing_scopes'. Empty on every other outcome. */
  missingScopes: string[]
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
    outcome:
      | { status: 'completed'; botId?: string }
      // `missingScopes` accompanies the 'missing_scopes' reason so the console's
      // poll can name the permissions rather than just the failure.
      | { status: 'failed'; failureReason: string; missingScopes?: readonly string[] }
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

/**
 * The route-facing read is org-scoped; everything below it is SYSTEM-TIER
 * (org-scoped-data-layer.md §3.4). The polling/finalization methods are fenced
 * by the claim-token lease or the target reservation — a stronger axis than an
 * org — and run in a background worker that serves no tenant, so they take the
 * at-rest key scope from the row they just claimed rather than from a caller.
 */
export interface FeishuAppRegistrationStore {
  create(input: CreateFeishuAppRegistrationInput): Promise<FeishuAppRegistrationRecord>
  get(orgId: OrgId, id: string): Promise<FeishuAppRegistrationRecord | null>
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
  /** Org-fenced point read (docs/designs/org-scoped-data-layer.md §3): a
   *  cross-org id reads as absent, exactly like a missing row. The only
   *  integration read the HTTP/MCP surface may use — and, because
   *  {@link IntegrationChannelRepo}'s rows carry no org of their own, the read
   *  every route path to a channel row is required to pass through (§3.6). */
  get(orgId: OrgId, id: IntegrationId): Promise<IntegrationRecord | null>
  /** Tenancy-UNSCOPED read for internal trust domains — a daemon reporting the
   *  external origin of a session it already proved it owns. Never call this
   *  from the HTTP surface; lint enforces it (§6). */
  getUnscoped(id: IntegrationId): Promise<IntegrationRecord | null>
  /** Every integration in the org. When a human principal is supplied,
   *  integrations whose parent agent is restricted away from them are filtered
   *  out; undefined alone keeps internal reads unfiltered. */
  listForOrg(orgId: OrgId, viewer?: ViewCtx): Promise<IntegrationRecord[]>
  /** Every active integration owned by one agent (cold placement-move snapshot).
   *  System-tier (§3.4): agent-fenced, and its only callers are orchestration
   *  (placement move, spec push) and the dedicated-bot icon converger. */
  listForAgent(agentId: AgentId): Promise<IntegrationRecord[]>
  /**
   * Active integrations whose owning agent is placed on `daemonId` — the
   * per-daemon `register/ok.integrations[]` set. FILTERED to this daemon (never
   * org-wide) since the delivered spec carries plaintext tokens.
   */
  activeForDaemon(daemonId: DaemonId): Promise<IntegrationRecord[]>
  /** Active integrations of these agents — the duty half of the reconcile roster,
   *  whose agents are named by the ledger, not by placement. Token-bearing once
   *  projected, so callers pass only the agents that daemon is entitled to. */
  activeForAgents(agentIds: readonly string[]): Promise<IntegrationRecord[]>
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
   *  earliest is the group's default agent). System-tier: bot-fenced, and a bot
   *  belongs to exactly one org — HTTP callers reach it only with a bot id that
   *  came through the org-fenced {@link BotRepo.get}. */
  listForBot(botId: BotId): Promise<IntegrationRecord[]>
  /** Flip every ACTIVE integration of `botId` to `revoked` (workspace uninstall /
   *  token revocation), recording the credential generation that owned it.
   *  Returns the affected integration ids. System-tier: relay-reported lifecycle,
   *  fenced by the credential generation. */
  markRevokedForBot(botId: BotId, credentialRevision: number): Promise<IntegrationId[]>
  /** Restore memberships revoked with exactly `credentialRevision`. Historical
   *  revoked rows and deliberately deleted/free memberships stay untouched.
   *  System-tier like {@link IntegrationRepo.markRevokedForBot}. */
  restoreRevokedForBot(botId: BotId, credentialRevision: number): Promise<number>
  /** Org-fenced: a cross-org id throws the same Prisma P2025 as an absent row. */
  delete(orgId: OrgId, id: IntegrationId): Promise<void>
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
  /** `Agent.daemonId` verbatim — a MACHINE placement, null for a `set` (pool) one, which names
   *  a member set instead. Not the routing answer: `buildCollabSnapshot` takes that from the
   *  resolved directory, because only the duty ledger knows which member holds a pool agent. */
  daemonId: string | null
  integrationId: IntegrationId
  /** Public platform app identity used to recognize messages from another
   *  AgentConnect-managed bot. Currently populated for Slack (`A…`). */
  botAppId?: string
  /** Public member id this agent's bot posts as (Slack `U…`). Together with the
   *  complete channel placement set and `name`, this lets the snapshot builder derive
   *  an exact conversation-scoped `@mention` (send-message-routing-rework.md §8.5). */
  botUserId?: string
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
 *  Slack group DM. Observation creates a visible row for each bot membership. */
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
  /** Repeated across shared-bot sibling rows; per-integration for non-shared bots. */
  trigger: ChannelTrigger
  /** The 1:1 DM counterpart's platform member id (§14.8); null on rooms and on rows
   *  discovered before the reporter carried it. */
  dmUserId: string | null
  /** True once a HUMAN chose this trigger — the one thing that tells an operator's Off
   *  apart from a default nobody has decided yet (§14.8). */
  triggerChosen: boolean
  /** Per-conversation owner for a shared bot (§10.1); null on sibling non-owner rows. */
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
  /** The 1:1 DM counterpart's platform member id — reported for `kind:'im'` only. */
  dmUserId?: string
}

/**
 * Conversation rows carry NO `orgId` of their own: every method here is
 * addressed by the owning `integrationId` (or `botId`), and fences through that
 * parent (docs/designs/org-scoped-data-layer.md §3.6). The structural
 * requirement this places on callers: an integration id that came from the HTTP
 * surface must have been resolved through the org-fenced
 * {@link IntegrationRepo.get} — the tenant-isolation contract suite asserts a
 * foreign integration's conversations stay unreachable that way. Everything
 * else here is the daemon/relay report path and the shared-bot route compiler,
 * both internal trust domains (§4).
 */
export interface IntegrationChannelRepo {
  /**
   * Converge to the daemon's channel report (latest-wins): upsert every reported
   * conversation (refreshing name/isPrivate, PRESERVING the stored trigger).
   * Authoritative membership snapshots delete kind='channel' rows the bot is no
   * longer a member of; non-authoritative observed-conversation reports retain
   * missing rows because platforms such as Telegram cannot enumerate all chats.
   * Direct rows are always retained. `defaultTrigger` seeds NEW rows only ('off'
   * for a gated integration); otherwise a 1:1 DM starts On and a room starts on
   * Mention. Existing rows keep their trigger.
   *
   * `removed` names conversations to DELETE outright, whatever the report's kind.
   * It is how a non-authoritative reporter retires a row at all — its omissions
   * mean nothing — and it deletes DM rows too, since it states a fact about the
   * conversation rather than inferring one from an incomplete listing. Applied
   * after the upsert, so a conversation in both lists ends up deleted.
   */
  replaceSnapshot(
    integrationId: IntegrationId,
    channels: ReportedChannel[],
    opts?: {
      defaultTrigger?: ChannelTrigger
      /** Per-conversation seed overriding `defaultTrigger` on a NEW row (§14.8: a gated
       *  agent's DM with a member of its own audience). Existing rows are unaffected. */
      defaultTriggerByChannel?: ReadonlyMap<string, ChannelTrigger>
      authoritative?: boolean
      removed?: string[]
    }
  ): Promise<void>
  /** Forget one conversation row. Console-driven cleanup for a conversation the bot
   *  is no longer in on a platform that cannot say so itself; returns whether a row
   *  was actually removed. Metadata only — sessions and transcripts are untouched. */
  deleteChannel(integrationId: IntegrationId, channelId: string): Promise<boolean>
  listForIntegration(integrationId: IntegrationId): Promise<IntegrationChannelRecord[]>
  /** Incremental conversation upsert (§14.3, direct rows): create the row (kind,
   *  name, `defaultTrigger`) when absent; when it exists refresh metadata while
   *  preserving the operator-owned trigger. */
  upsertConversation(
    integrationId: IntegrationId,
    conversation: ReportedChannel,
    opts?: { defaultTrigger?: ChannelTrigger }
  ): Promise<IntegrationChannelRecord>
  /** Conversations across EVERY integration of a shared bot — the route compiler's
   *  ownership source. */
  listForBot(botId: BotId): Promise<IntegrationChannelRecord[]>
  /** Per-conversation trigger choice; returns null when the row doesn't exist.
   *  `chosen` records that a HUMAN picked this value (§14.8) — omitted leaves the flag
   *  as it was, so orchestration mirroring a trigger never fabricates a decision. */
  setTrigger(
    integrationId: IntegrationId,
    channelId: string,
    trigger: ChannelTrigger,
    opts?: { chosen?: boolean }
  ): Promise<IntegrationChannelRecord | null>
  /** Set or clear this integration row's owner marker. The orchestrator keeps
   *  exactly one row marked per shared conversation. Returns null when missing. */
  setAgent(
    integrationId: IntegrationId,
    channelId: string,
    agentId: AgentId | null
  ): Promise<IntegrationChannelRecord | null>
  /** Set the conversation's owning agent, CREATING the row if absent. A shared bot's
   *  ingest is on the relay, so the daemon never reports its conversations — the config
   *  modal must be able to name a conversation the CP has never seen. `defaultTrigger`
   *  seeds a CREATED row only ('off' for a gated owner, §14); an existing row
   *  keeps its trigger. `kind` preserves observed DM/group-DM rows on backfill. */
  upsertAgent(
    integrationId: IntegrationId,
    channelId: string,
    agentId: AgentId,
    opts?: { defaultTrigger?: ChannelTrigger; kind?: ConversationKind }
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

/** The five resource kinds that carry a Selected member audience. */
export type VisibilityResourceKind = 'agent' | 'daemon' | 'cron' | 'mcpProvider' | 'skillSource'

/**
 * What removing one member would do, read before the fact (resource-visibility.md
 * §8.2). The console shows it in the leave/remove confirmation so repairing a
 * Selected audience that would otherwise become empty is predictable.
 */
export interface MemberRemovalPreview {
  /** The member added to any Selected audience that would otherwise become
   *  empty; null when removal would be refused (the final organization owner). */
  replacement: OrgMemberRecord | null
  /** Per-kind counts of restricted resources that explicitly select the
   *  departing member; kinds with no matches are omitted. */
  resources: Array<{
    kind: VisibilityResourceKind
    selected: number
    /** The subset whose audience has no other current member and therefore gets
     *  `replacement` added during removal. */
    reassigned: number
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
  /** Default applied to both directional policies of newly created agents. */
  defaultAgentVisibility: AgentCallPolicy
  /** The asking user's role in it. */
  role: OrgMemberRole
  memberCount: number
  /** Registered daemons (any status) — the console's cross-org onboarding signal. */
  daemonCount: number
  createdAt: Date
  /** Last update — the icon endpoint's `?v=` cache-buster for an uploaded org icon. */
  updatedAt: Date
}

/** One org's footprint, for the per-org gauges (observability/org-metrics.ts). */
export interface OrgTelemetryRow {
  /** What the gauge labels the series with. The slug is deliberately NOT read here: it is mutable,
   *  and an org's is chosen by whoever created it. */
  orgId: string
  /** Daemons registered to the org, any status. An install-wide pool member belongs to NO org
   *  (`daemon.orgId IS NULL`) and is counted for none of them — a pool-backed org reads zero here
   *  however much of the pool it occupies, which `duty_group` is the ledger for. */
  daemons: number
  /** Agents defined in the org, any status — including inactive and unplaced ones. A brand-new org
   *  reads 1, not 0: `provisionPresetAgents` gives every org the `agentconnect` preset at creation
   *  unless the install sets `PRESET_AGENTS_ENABLED=false`. */
  agents: number
  /** Sessions the org has ever started. `session_meta` has no retention sweep, so this is a
   *  lifetime total that only grows; the windows below are what carry a trend. */
  sessionsTotal: number
  /** Sessions STARTED in the last 30 days / 24 hours — a rate, not an occupancy: a long-running
   *  session is counted once, in the window it began. */
  sessions30d: number
  sessions24h: number
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
   * email-only row is claimed by setting its `oidcSubject`). NO organization is
   * created here — org membership is only ever explicit (accepting an invite, or
   * creating one from org onboarding), so a fresh account legitimately belongs to
   * none. Later calls are a cheap idempotent fetch (plus the synthetic-email
   * upgrade). Authorization remains per-request (`resolveOrgContext`); the last
   * console choice is only a preference on the user's membership.
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
   * Let a member leave, or let an owner remove another member. Prunes the
   * departing member from Selected audiences and adds a deterministic replacement
   * only where the audience would otherwise become empty. Rechecks membership
   * and, when removing another member, the acting owner's role. Refuses to remove
   * the final owner before committing.
   */
  removeMember(orgId: string, userId: string, actingUserId: string): Promise<void>

  /**
   * Dry-run of `removeMember` for the confirmation dialog: the same replacement
   * rule, plus which Selected audiences include that member. Racy by nature
   * (nothing is locked) — advisory display only, never an authorization input.
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
  /** Every org the user belongs to, with their role — most recently selected
   * first, then insertion order for memberships without a selection. */
  listForUser(userId: string): Promise<OrgRecord[]>
  /** Remember this member's active organization. Throws P2025 when the
   * membership no longer exists. */
  selectForUser(orgId: string, userId: string, selectedAt: Date): Promise<void>
  /** Create an org with `ownerUserId` as its first owner (one transaction). */
  create(input: {
    name: string | null
    slug: string
    ownerUserId: string
    /** Optional deployment quota; checked atomically against orgs created by this user. */
    maxOrgsPerUser?: number
  }): Promise<OrgRecord>
  /** Update org settings. Throws P2025 when absent, P2002 on a slug collision. */
  update(
    orgId: string,
    patch: {
      name?: string | null
      slug?: string
      icon?: AgentIcon | null
      defaultAgentVisibility?: AgentCallPolicy
    }
  ): Promise<{ id: string; name: string | null; slug: string }>
  /** Set the org's console icon descriptor (the upload/delete path). Bumps `updatedAt`
   *  so the icon endpoint's `?v=` cache-buster changes. Throws P2025 when absent. */
  setIcon(orgId: string, icon: AgentIcon | null): Promise<{ id: string; updatedAt: Date }>
  /** The org's icon descriptor + last-update time, by id — the public icon endpoint's
   *  read (no membership needed). Null when the org is absent. */
  iconById(orgId: string): Promise<{ icon: AgentIcon | null; updatedAt: Date } | null>
  /** The user's role in the org; null when not a member. */
  roleOf(orgId: string, userId: string): Promise<OrgMemberRole | null>

  /** Default directional policy for newly created agents; null when the org is absent. */
  defaultAgentVisibility(orgId: string): Promise<AgentCallPolicy | null>

  /** The org's slug (its URL segment in the console), or null when the org is absent.
   *  Used to build org-scoped session deep links (`<webAppUrl>/<slug>/sessions/<id>`). */
  slugById(orgId: string): Promise<string | null>

  /** Per-org daemon/agent/session counts, for the org gauges (observability/org-metrics.ts).
   *  EVERY org is returned, including one holding nothing: a series that vanishes on the way to
   *  zero is invisible on a dashboard, so the zeros have to be stated. `now` fixes the window
   *  boundaries at the caller's clock rather than the database's. */
  orgTelemetry(now: Date): Promise<OrgTelemetryRow[]>

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
   * `User.activatedAt` and stamps `redeemed*` (including
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

/** Domain view of an `mcp_provider` row. A Shareable (visibility + complete
 *  Selected audience), so the same OSS authorization policy as agents applies.
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
  sharedWith?: string[] // complete app_user.id audience when visibility='restricted'
  createdByUserId?: string
}

export interface UpdateMcpProviderInput {
  name?: string
  url?: string
  transport?: McpTransport
}

export interface McpProviderRepo {
  create(input: CreateMcpProviderInput): Promise<McpProviderRecord>
  /** Org-fenced point read (docs/designs/org-scoped-data-layer.md §3): a
   *  cross-org id reads as absent, exactly like a missing row. This port has no
   *  `getUnscoped` — the daemon and relay reach providers through
   *  {@link McpProviderRepo.listForOrg} and {@link McpProviderRepo.listAll}, so no
   *  internal trust domain needs an id-addressed escape hatch. */
  get(orgId: OrgId, id: string): Promise<McpProviderRecord | null>
  /** The org's providers, filtered to what a supplied human principal may see
   *  (org-visible OR owned-by-them OR shared-with-them). Undefined is reserved
   *  for unfiltered internal reads. */
  listForOrg(orgId: OrgId, viewer?: ViewCtx): Promise<McpProviderRecord[]>
  /** Set visibility + share set (console access only; never crosses the wire).
   *  Org-fenced: a cross-org id throws the same P2025 as a missing row. */
  setSharing(
    orgId: OrgId,
    id: string,
    sharing: { visibility: ResourceVisibility; sharedWith: string[] },
    byUserId?: string
  ): Promise<McpProviderRecord>
  /** Org-fenced: a cross-org id throws the same P2025 as a missing row. */
  update(orgId: OrgId, id: string, patch: UpdateMcpProviderInput): Promise<McpProviderRecord>
  /** Org-fenced: a cross-org id throws the same P2025 as a missing row. */
  delete(orgId: OrgId, id: string): Promise<void>
  /** EVERY provider across all orgs — the pool-wide set replayed to a relay that just
   *  (re)registered (its in-memory binding table starts empty; bindings are pool-wide,
   *  like bots/hooks). System-tier: deployment-level infrastructure by design. */
  listAll(): Promise<McpProviderRecord[]>
}

/** One `{name, value}` upstream auth header (same shape as the wire NameValueList). */
export interface McpHeader {
  name: string
  value: string
}

/** The ONLY read/write path for `mcp_provider_secret` (upstream auth headers).
 *  Store-only: NEVER in a DTO, NEVER pushed to a daemon (relay-only, via rc/mcp-assign).
 *  Same seam/discipline as {@link BotSecretStore}.
 *
 *  Rows are keyed by `providerId` alone and carry no org, so this store fences
 *  through its parent (org-scoped-data-layer.md §3.6): a route reaching a
 *  secret must have resolved its provider through the org-fenced
 *  {@link McpProviderRepo.get} (or just created it) first. */
/** Child of `McpProvider` — see {@link HookSecretStore} for why `orgId` is here. */
export interface McpProviderSecretStore {
  put(orgId: OrgId, providerId: string, headers: McpHeader[]): Promise<void>
  get(orgId: OrgId, providerId: string): Promise<McpHeader[] | null>
  delete(orgId: OrgId, providerId: string): Promise<void>
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

/** Grants hang off one provider and carry no org of their own — they fence
 *  through {@link McpProviderRepo} exactly like {@link McpProviderSecretStore}
 *  (org-scoped-data-layer.md §3.6). */
export interface McpGrantRepo {
  /** Mint a fresh active grant (generates a new plaintext key) for a provider.
   *  v1 keeps exactly one active grant per provider — the caller revokes any prior
   *  active grant first (shared org identity). Returns the row WITH the plaintext. */
  mintFor(orgId: OrgId, providerId: string): Promise<McpGrantRecord>
  /** The provider's active grants (v1: 0 or 1). Carries plaintext — internal use only. */
  activeForProvider(orgId: OrgId, providerId: string): Promise<McpGrantRecord[]>
  /** Mark a grant revoked (idempotent). No value is opened, so no scope needed. */
  revoke(grantId: string): Promise<void>
}

// ───────────────────────────────────────────────────────────────────────────
// Shared skills registry (docs/designs/shared-skills.md)
//   SkillSource = the org-level record of a bounded public GitHub source. The CP
//   stores ONLY source metadata and the numeric repository binding; content is
//   acquired and installed daemon-side. One port (no secret store / no grant).
//   Shareable, so the same visibility policy as agents/MCP.
// ───────────────────────────────────────────────────────────────────────────

/** Domain view of a `skill_source` row. Shareable (visibility + complete
 *  Selected audience). Nothing here is secret. */
export interface SkillSourceRecord extends Shareable {
  id: string
  orgId: OrgId
  name: string // reference key (unique per org); the agent enable-list keys on it
  source: string // bounded GitHub acquisition input; never handed remotely to the CLI
  githubRepoId: bigint | null // nullable only for rolling migration; unbound rows do not project
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
  /** Register a source under the name-capture guard. The (orgId, name) advisory
   *  scope, the agent-reference scan, and the insert share one transaction;
   *  null ⇒ an agent still enables skills under this name (caller answers 409). */
  create(input: CreateSkillSourceInput): Promise<SkillSourceRecord | null>
  /** Org-fenced point read (docs/designs/org-scoped-data-layer.md §3): a
   *  cross-org id reads as absent, exactly like a missing row. This port has no
   *  `getUnscoped` — internal readers resolve a source by its org-unique NAME
   *  through {@link SkillSourceRepo.getByName}, which is already org-carrying. */
  get(orgId: OrgId, id: string): Promise<SkillSourceRecord | null>
  /** The org's sources, filtered by the OSS resource-visibility policy for a
   *  supplied human principal; undefined is reserved for internal reads. */
  listForOrg(orgId: OrgId, viewer?: ViewCtx): Promise<SkillSourceRecord[]>
  /** Look up a source by its org-unique name (used to resolve an agent's enable-list). */
  getByName(orgId: OrgId, name: string): Promise<SkillSourceRecord | null>
  /** Holds the (orgId, name) advisory scope for the write: agent enable-list
   *  writes authorize visibility under the same scope, so a flip cannot land
   *  between their check and their commit. Org-fenced: a cross-org id throws
   *  the same P2025 as a missing row, before that scope is taken. */
  setSharing(
    orgId: OrgId,
    id: string,
    sharing: { visibility: ResourceVisibility; sharedWith: string[] },
    byUserId?: string
  ): Promise<SkillSourceRecord>
  /** Org-fenced: a cross-org id throws the same P2025 as a missing row. */
  update(orgId: OrgId, id: string, patch: UpdateSkillSourceInput): Promise<SkillSourceRecord>
  /** Delete under the referenced-guard, in one transaction with the reference
   *  scan ('referenced' ⇒ caller answers 409; missing row ⇒ 'deleted').
   *  Org-fenced: a cross-org id is 'deleted' — the same answer as an unknown id,
   *  and (unlike 'referenced') one that discloses nothing about the foreign row. */
  delete(orgId: OrgId, id: string): Promise<'deleted' | 'referenced'>
}

// ───────────────────────────────────────────────────────────────────────────
// Organization Knowledge + immutable managed Agent Skills revisions
// (docs/designs/organization-knowledge.md)
// ───────────────────────────────────────────────────────────────────────────

export type OrganizationArtifactSource = 'manual' | 'dream'
export type OrganizationSuggestionKind = 'knowledge' | 'skill'
export type OrganizationSuggestionOperation = 'create' | 'update'
export type OrganizationSuggestionState = 'pending' | 'accepted' | 'rejected'

export interface OrganizationKnowledgeRecord {
  id: string
  orgId: OrgId
  title: string
  currentRevision: number
  archivedAt: Date | null
  archivedByUserId: string | null
  createdAt: Date
  updatedAt: Date
  content: string
  summary: string | null
  tags: string[]
  digest: string
  source: OrganizationArtifactSource
  sourceAgentId: string | null
  sourceDreamId: string | null
  sourceCandidateId: string | null
  sourceSessionIds: string[]
  createdByUserId: string | null
  reviewedByUserId: string | null
  revisionCreatedAt: Date
}

export interface OrganizationKnowledgeRevisionRecord {
  knowledgeId: string
  revision: number
  content: string
  summary: string | null
  tags: string[]
  digest: string
  source: OrganizationArtifactSource
  sourceAgentId: string | null
  sourceDreamId: string | null
  sourceCandidateId: string | null
  sourceSessionIds: string[]
  createdByUserId: string | null
  reviewedByUserId: string | null
  createdAt: Date
}

export interface ManagedSkillRecord {
  id: string
  orgId: OrgId
  name: string
  description: string
  currentRevision: number
  archivedAt: Date | null
  archivedByUserId: string | null
  createdAt: Date
  updatedAt: Date
  digest: string
  compressedBytes: number
  expandedBytes: number
  fileCount: number
  manifest: Record<string, unknown>
}

export interface ManagedSkillRevisionRecord {
  managedSkillId: string
  revision: number
  archive: Uint8Array
  digest: string
  compressedBytes: number
  expandedBytes: number
  fileCount: number
  manifest: Record<string, unknown>
  source: OrganizationArtifactSource
  sourceAgentId: string | null
  sourceDreamId: string | null
  sourceCandidateId: string | null
  sourceSessionIds: string[]
  createdByUserId: string | null
  reviewedByUserId: string | null
  createdAt: Date
}

export interface OrganizationSuggestionRecord {
  id: string
  orgId: OrgId
  sourceAgentId: string
  sourceDaemonId: string | null
  dreamId: string
  candidateId: string
  kind: OrganizationSuggestionKind
  operation: OrganizationSuggestionOperation
  targetArtifactId: string | null
  targetRevision: number | null
  title: string
  summary: string | null
  tags: string[]
  digest: string
  contentBytes: number
  sessionIds: string[]
  state: OrganizationSuggestionState
  reviewedByUserId: string | null
  reviewedAt: Date | null
  reviewReason: string | null
  acceptedArtifactId: string | null
  acceptedArtifactRevision: number | null
  createdAt: Date
  updatedAt: Date
}

export interface OrganizationArtifactProvenance {
  source: OrganizationArtifactSource
  sourceAgentId?: string
  sourceDreamId?: string
  sourceCandidateId?: string
  sourceSessionIds?: string[]
  createdByUserId?: string
  reviewedByUserId?: string
}

export type AcceptOrganizationSuggestionResult =
  | { outcome: 'accepted'; suggestion: OrganizationSuggestionRecord }
  | { outcome: 'not_pending'; suggestion: OrganizationSuggestionRecord }
  | { outcome: 'metadata_changed'; suggestion: OrganizationSuggestionRecord }
  | { outcome: 'stale_target'; suggestion: OrganizationSuggestionRecord }
  | { outcome: 'target_missing'; suggestion: OrganizationSuggestionRecord }
  | { outcome: 'name_conflict'; suggestion: OrganizationSuggestionRecord }

/**
 * Knowledge entries, managed skills and dream suggestions are all org-owned rows
 * addressed by id, so every point read and mutation here is org-fenced
 * (docs/designs/org-scoped-data-layer.md §3). Their REVISION tables carry no
 * `orgId` of their own and fence through the parent (§3.6) — each revision read
 * sits behind the fenced `getKnowledge` / `getManagedSkill` that admitted it.
 * Nothing in this port needs a `getUnscoped`: the daemon-facing reads
 * (`managed-skill/read`, knowledge search) resolve the org from the requesting
 * agent, which the WS handler has already proved is placed on the connection.
 */
export interface OrganizationKnowledgeRepo {
  listKnowledge(orgId: OrgId, includeArchived?: boolean): Promise<OrganizationKnowledgeRecord[]>
  getKnowledge(orgId: OrgId, id: string): Promise<OrganizationKnowledgeRecord | null>
  /** Fences through {@link OrganizationKnowledgeRepo.getKnowledge} (§3.6). */
  listKnowledgeRevisions(id: string): Promise<OrganizationKnowledgeRevisionRecord[]>
  searchKnowledge(
    orgId: OrgId,
    input: { query: string; tags?: string[]; limit: number }
  ): Promise<OrganizationKnowledgeRecord[]>
  createKnowledge(
    orgId: OrgId,
    input: { title: string; content: string; summary?: string; tags?: string[] },
    provenance: OrganizationArtifactProvenance
  ): Promise<OrganizationKnowledgeRecord>
  /** Org-fenced: a cross-org id misses the revision CAS exactly like a stale
   *  `expectedRevision` (null), so it discloses nothing the CAS did not already. */
  updateKnowledge(
    orgId: OrgId,
    id: string,
    expectedRevision: number,
    input: { title: string; content: string; summary?: string; tags?: string[] },
    provenance: OrganizationArtifactProvenance
  ): Promise<OrganizationKnowledgeRecord | null>
  /** Org-fenced: a cross-org id throws the same P2025 as a missing row. */
  setKnowledgeArchived(
    orgId: OrgId,
    id: string,
    archived: boolean,
    byUserId?: string
  ): Promise<OrganizationKnowledgeRecord>

  listManagedSkills(orgId: OrgId, includeArchived?: boolean): Promise<ManagedSkillRecord[]>
  /** Org-fenced: a cross-org id reads as absent. Every caller previously
   *  post-filtered on `row.orgId !== …`; the fence replaces that check. */
  getManagedSkill(orgId: OrgId, id: string): Promise<ManagedSkillRecord | null>
  /** Fences through {@link OrganizationKnowledgeRepo.getManagedSkill} (§3.6). */
  getManagedSkillRevision(id: string, revision: number): Promise<ManagedSkillRevisionRecord | null>
  /** Fences through {@link OrganizationKnowledgeRepo.getManagedSkill} (§3.6). */
  listManagedSkillRevisions(id: string): Promise<ManagedSkillRevisionRecord[]>
  /** Org-fenced: a cross-org id throws the same P2025 as a missing row. */
  setManagedSkillArchived(orgId: OrgId, id: string, archived: boolean, byUserId?: string): Promise<ManagedSkillRecord>

  syncSuggestions(
    orgId: OrgId,
    sourceDaemonId: string,
    suggestions: (OrganizationSuggestionInfo & { sourceAgentId: string; dreamId: string })[]
  ): Promise<OrganizationSuggestionRecord[]>
  listSuggestions(
    orgId: OrgId,
    filters?: { kind?: OrganizationSuggestionKind; state?: OrganizationSuggestionState; query?: string }
  ): Promise<OrganizationSuggestionRecord[]>
  /** Org-fenced: a cross-org id reads as absent. */
  getSuggestion(orgId: OrgId, id: string): Promise<OrganizationSuggestionRecord | null>
  /** Org-fenced: a cross-org id throws the same missing-row error as an
   *  unknown one, and the pending-state CAS is unchanged. */
  rejectSuggestion(
    orgId: OrgId,
    id: string,
    reviewedByUserId: string | undefined,
    reason?: string
  ): Promise<OrganizationSuggestionRecord>
  /** Org-fenced on the row-locked read that opens the transaction, before the
   *  snapshot-token comparison — so a cross-org id can never answer "stale
   *  snapshot" and confirm the foreign suggestion exists. */
  acceptKnowledgeSuggestion(
    orgId: OrgId,
    id: string,
    body: { title: string; content: string; summary: string | null; tags: string[] },
    expectedSnapshotToken: string,
    reviewedByUserId?: string
  ): Promise<AcceptOrganizationSuggestionResult>
  /** Org-fenced like {@link OrganizationKnowledgeRepo.acceptKnowledgeSuggestion}. */
  acceptSkillSuggestion(
    orgId: OrgId,
    id: string,
    body: {
      archive: Uint8Array
      /** Digest advertised by the daemon for the staged candidate tree. */
      candidateDigest: string
      /** Digest of the canonical `.skill` ZIP persisted centrally. */
      digest: string
      compressedBytes: number
      expandedBytes: number
      fileCount: number
      manifest: Record<string, unknown>
      /** Manifest metadata read from the exact staged tree. Both fields fence a
       * concurrent suggestion-inventory refresh before executable content lands. */
      name: string
      description: string
    },
    expectedSnapshotToken: string,
    reviewedByUserId?: string
  ): Promise<AcceptOrganizationSuggestionResult>
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
  /** Org-fenced point read (org-scoped-data-layer.md §3): a cross-org id reads
   *  as absent, exactly like a missing row. No `getUnscoped` — the daemon and
   *  relay reach connections through `listForOrg` / `listAll`, never by id. */
  get(orgId: OrgId, id: string): Promise<ExternalMemoryConnectionRecord | null>
  listForOrg(orgId: OrgId): Promise<ExternalMemoryConnectionRecord[]>
  /** System-tier: the pool-wide set replayed to a relay that just (re)registered. */
  listAll(): Promise<ExternalMemoryConnectionRecord[]>
  /** Org-fenced: a cross-org id throws the same P2025 as a missing row. */
  update(orgId: OrgId, id: string, patch: { config?: Record<string, unknown> }): Promise<ExternalMemoryConnectionRecord>
  /** Org-fenced: a cross-org id throws the same P2025 as a missing row. */
  delete(orgId: OrgId, id: string): Promise<void>
  /** Revision-fenced probe fact update; stale daemon facts are ignored.
   *  System-tier: daemon-reported, fenced by the revision CAS. */
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

/** Secret values keyed by manifest logical field name. Values never enter DTOs.
 *  Rows are keyed by `connectionId` alone and carry no org, so this store fences
 *  through its parent (org-scoped-data-layer.md §3.6) — a route reaching a
 *  connection's secrets must resolve it through the org-fenced
 *  {@link ExternalMemoryConnectionRepo.get} first. */
/** Child of `ExternalMemoryConnection` — see {@link HookSecretStore} for why
 *  `orgId` is here. `keys` touches no value but keeps the fence for symmetry. */
export interface ExternalMemoryConnectionSecretStore {
  put(orgId: OrgId, connectionId: string, values: Record<string, string>): Promise<void>
  get(orgId: OrgId, connectionId: string): Promise<Record<string, string> | null>
  keys(orgId: OrgId, connectionId: string): Promise<string[]>
  delete(orgId: OrgId, connectionId: string): Promise<void>
}

export interface ExternalMemoryGrantRecord {
  id: string
  connectionId: string
  key: string
  status: 'active' | 'revoked'
  createdAt: Date
}

/** Grants hang off one connection and fence through it, exactly like
 *  {@link ExternalMemoryConnectionSecretStore} (§3.6). */
export interface ExternalMemoryGrantRepo {
  mintFor(orgId: OrgId, connectionId: string): Promise<ExternalMemoryGrantRecord>
  activeForConnection(orgId: OrgId, connectionId: string): Promise<ExternalMemoryGrantRecord[]>
  /** No value is opened, so no scope needed. */
  revoke(grantId: string): Promise<void>
}

/**
 * Transactional unit-of-work for external-memory definition/grant mutations.
 *
 * Each method runs its check-then-write pair in ONE transaction that
 * try-acquires the advisory mutation scope(s) of the resources it touches
 * (persistence/memory-connection-lock.ts) — the cross-instance replacement for
 * the process-local ExclusiveMutationGate. `busy` means another mutation holds
 * a scope; callers answer 409 and let the operator retry (fail-fast, never
 * queued). Agent writes that bind/unbind a connection take the same scopes
 * inside their own transactions (see {@link AgentRepo}), which closes the
 * check-then-delete race around the FK-less JSON agent binding.
 *
 * Secret and grant-key values pass through the configured SecretCipher BEFORE
 * a transaction opens (an encrypting provider may make network calls; a
 * transaction must never wait on one). Daemon/relay pushes stay OUTSIDE,
 * post-commit — best-effort, with reconnect snapshots as the convergence
 * backstop (docs/designs/agent-memory.md).
 */
export interface MemoryConnectionWriter {
  /** Installation existence check + connection row + sealed secret row
   *  (+ minted grant when `mintGrant`) in one transaction under the
   *  installation's scope, so it cannot interleave with the installation
   *  DELETE's reference scan. The minted grant key rides back exactly once. */
  createConnection(
    input: {
      id: string
      orgId: OrgId
      installationId: string
      config: Record<string, unknown>
      createdByUserId?: string
    },
    secrets: Record<string, string>,
    mintGrant: boolean
  ): Promise<
    | { outcome: 'created'; connection: ExternalMemoryConnectionRecord; grantKey?: string }
    | { outcome: 'installation_missing' }
    | { outcome: 'busy' }
  >
  /** Full secret replacement (when supplied) + config/revision update in one
   *  transaction under the connection's scope — a failure can no longer leave
   *  new secrets beside an old definition, so there is no compensation pair.
   *  `secrets` is the snapshot read INSIDE that transaction: the projection
   *  payload for exactly the committed revision. Pushing anything read outside
   *  the transaction can pair an older credential with a newer revision, which
   *  the relay's revision gate then pins until reconnect. */
  updateConnection(
    id: string,
    orgId: OrgId,
    patch: { config?: Record<string, unknown>; secrets?: Record<string, string> }
  ): Promise<
    | { outcome: 'updated'; connection: ExternalMemoryConnectionRecord; secrets: Record<string, string> }
    | { outcome: 'not_found' }
    | { outcome: 'busy' }
  >
  /** The rotation's durable first half: revision bump + fresh-grant mint (or
   *  newest reuse after a failed earlier rotation) under the connection's
   *  scope. The active-grant set is re-read in the transaction and compared
   *  against the caller-observed snapshot — concurrent grant churn resolves to
   *  `busy`. `secrets` is the in-transaction snapshot for the overlap push.
   *  The overlap push itself stays at the route; retirement goes through
   *  {@link finalizeGrantRotation}. */
  prepareGrantRotation(
    id: string,
    orgId: OrgId
  ): Promise<
    | {
        outcome: 'prepared'
        connection: ExternalMemoryConnectionRecord
        fresh: ExternalMemoryGrantRecord
        retiring: ExternalMemoryGrantRecord[]
        secrets: Record<string, string>
      }
    | { outcome: 'not_found' }
    | { outcome: 'busy' }
  >
  /** The rotation's durable second half, after the overlap push fully acked:
   *  revoke the retiring grants AND bump the revision in one transaction under
   *  the connection's scope. The relay honors a whole-list assign only at a
   *  strictly newer revision (and a per-hash unassign only at the exact current
   *  one), so retirement must own a revision greater than every assignment that
   *  could still carry the retired hash — the caller republishes the
   *  post-retirement allowlist under the returned connection's revision, and a
   *  delayed pre-retirement assign can no longer reintroduce the revoked grant. */
  finalizeGrantRotation(
    id: string,
    orgId: OrgId,
    retiringGrantIds: readonly string[]
  ): Promise<
    | { outcome: 'retired'; connection: ExternalMemoryConnectionRecord; secrets: Record<string, string> }
    | { outcome: 'not_found' }
    | { outcome: 'busy' }
  >
  /** Agent-binding scan + row drop (secret/grant rows cascade) in one
   *  transaction under the connection's scope, so a concurrent agent bind
   *  either commits first (⇒ 'bound') or re-verifies after and is refused.
   *  `tombstoneRevision` (current revision + 1, read under the scope) is what
   *  the caller must publish as the relay tombstone — a pre-transaction
   *  revision can be outrun by a completed rotation, and the relay ignores a
   *  tombstone at or below the revision it already holds. */
  deleteConnection(
    id: string,
    orgId: OrgId
  ): Promise<
    | { outcome: 'deleted'; tombstoneRevision: number }
    | { outcome: 'bound' }
    | { outcome: 'not_found' }
    | { outcome: 'busy' }
  >
  /** Connection-reference scan + row drop under the installation's scope (the
   *  FK is Restrict, so this converts a constraint failure into a clean 409). */
  deleteInstallation(id: string, orgId: OrgId): Promise<'deleted' | 'referenced' | 'not_found' | 'busy'>
}

// ───────────────────────────────────────────────────────────────────────────
// Organization environment registry (organization-secrets-and-variables.md).
// An organization-owned variable or secret defined once and assigned to all or
// selected agents. The Control Plane resolves assigned entries together with each
// agent's local entries before building `AgentSpec.env` / `AgentSpec.secrets`, so
// nothing new appears on the wire and no registry exists on the daemon.
// ───────────────────────────────────────────────────────────────────────────

/** Human metadata for one entry: may carry `variableValue`, NEVER a secret value. */
export interface OrganizationEnvironmentEntryRecord {
  id: string
  orgId: OrgId
  key: string
  kind: OrganizationEnvironmentKind
  /** Non-null only for `kind: 'variable'`. */
  variableValue: string | null
  /** For a secret: whether its value row exists. Derived WITHOUT reading it. */
  secretConfigured: boolean
  audience: OrganizationEnvironmentAudience
  /** Editor-conflict fence; PATCH sends it back as `expectedVersion`. */
  version: number
  /** Every explicit binding. Routes filter this to agents the caller can view. */
  agentIds: string[]
  createdByUserId: string | null
  lastModifiedByUserId: string | null
  createdAt: Date
  updatedAt: Date
}

/**
 * The authorization seam every binding-creating write passes through, evaluated
 * INSIDE the writer's transaction (design §3.4/§4).
 *
 * `all` is an automatic-enrollment policy, never an authorization bypass: the
 * writer asks this for the agent ids the ACTOR may edit and binds exactly those.
 * Restricted agents the actor cannot see are neither enumerated nor changed.
 * `viewer: undefined` is reserved for internal callers and means unfiltered.
 */
export interface OrganizationEnvironmentActor {
  actorUserId?: string
  viewer?: ViewCtx
}

/** Why an organization-environment write was refused without any value leaking. */
export type OrganizationEnvironmentWriteFailure =
  /** `expectedVersion` did not match — a competing editor already changed it. */
  | { outcome: 'version_conflict' }
  /** The entry (or the org-scoped view of it) does not exist. */
  | { outcome: 'not_found' }
  /** An agent target is invisible, non-editable, foreign, or absent. Deliberately
   *  indistinguishable from `not_found` at the API edge. */
  | { outcome: 'agent_not_found' }
  /** Would place an organization variable over an agent secret (§3.2). The keys
   *  are safe to name: they are names, not values. */
  | { outcome: 'cross_kind_conflict'; keys: string[] }
  /** An affected agent's resolved AgentSpec would exceed the wire admission budget. */
  | { outcome: 'too_large'; agentIds: string[] }
  /** The key already exists in this organization's single keyspace. */
  | { outcome: 'duplicate_key' }
  /** The endpoint is only valid while the entry has `selected` audience. */
  | { outcome: 'not_selected' }

export type OrganizationEnvironmentWriteResult =
  | {
      outcome: 'ok'
      entry: OrganizationEnvironmentEntryRecord
      /** Agents whose resolved configuration changed — the fan-out set (§7). */
      affectedAgentIds: string[]
    }
  | OrganizationEnvironmentWriteFailure

export interface CreateOrganizationEnvironmentEntryInput {
  key: string
  kind: OrganizationEnvironmentKind
  /** A variable's plain value; ignored for a secret. */
  variableValue?: string
  /** An ALREADY-SEALED secret value (sealing happens before the transaction). */
  sealedSecret?: string
  audience: OrganizationEnvironmentAudience
  /** Initial explicit selection; `selected` audience only. */
  agentIds?: readonly string[]
  /** Agents to SKIP from `all` enrollment — placed on a daemon that cannot yet
   *  apply organization entries safely (§10 step 3). Computed at the HTTP edge
   *  from the live daemon registry; ignored for `selected` audience. A skipped
   *  agent enrolls on a later authorized configuration write. */
  excludeAgentIds?: readonly string[]
}

export interface UpdateOrganizationEnvironmentEntryInput {
  /** Replacement plain value for a variable. Omitted ⇒ unchanged. */
  variableValue?: string
  /** Replacement ALREADY-SEALED secret value. Omitted ⇒ unchanged. */
  sealedSecret?: string
  /** Retarget. Omitted ⇒ unchanged. */
  audience?: OrganizationEnvironmentAudience
  /** Agents to SKIP when a retarget to `all` enrolls new bindings — same
   *  daemon-compatibility skip as on create. Never removes an existing binding. */
  excludeAgentIds?: readonly string[]
}

/**
 * Metadata + binding CRUD. Every writer takes the design §5 fence — the parent
 * `Org` row `FOR UPDATE`, then the affected `Agent` rows in stable id order —
 * re-reads local names and assigned metadata under those locks, validates the
 * complete resolved spec, and increments each affected agent's `configRevision`
 * in the SAME transaction. Concurrent entry, binding, and agent-local writes
 * therefore serialize before final validation instead of each validating against
 * an obsolete partial state.
 */
export interface OrganizationEnvironmentRepo {
  /** Metadata for the Settings registry. Never joins the secret table. */
  list(orgId: OrgId): Promise<OrganizationEnvironmentEntryRecord[]>
  get(orgId: OrgId, entryId: string): Promise<OrganizationEnvironmentEntryRecord | null>
  create(
    orgId: OrgId,
    input: CreateOrganizationEnvironmentEntryInput,
    actor: OrganizationEnvironmentActor
  ): Promise<OrganizationEnvironmentWriteResult>
  /** Replace a value and/or retarget the audience under `expectedVersion`. */
  update(
    orgId: OrgId,
    entryId: string,
    expectedVersion: number,
    input: UpdateOrganizationEnvironmentEntryInput,
    actor: OrganizationEnvironmentActor
  ): Promise<OrganizationEnvironmentWriteResult>
  /** Exercise the authority each binding already delegated and remove the entry
   *  globally. Returns the agents that were receiving it so the caller can
   *  fan out; it does not disclose them to any human response. */
  delete(
    orgId: OrgId,
    entryId: string
  ): Promise<{ outcome: 'ok'; affectedAgentIds: string[] } | { outcome: 'not_found' }>
  /** Idempotent per-agent binding add/remove. `selected` audience only; both
   *  require a `resource.edit` decision for the target. */
  bind(
    orgId: OrgId,
    entryId: string,
    agentId: AgentId,
    actor: OrganizationEnvironmentActor
  ): Promise<OrganizationEnvironmentWriteResult>
  unbind(
    orgId: OrgId,
    entryId: string,
    agentId: AgentId,
    actor: OrganizationEnvironmentActor
  ): Promise<OrganizationEnvironmentWriteResult>
}

/**
 * The ONLY value-reading seam for organization secrets — the exact discipline
 * {@link AgentSecretStore} uses. It receives the same mandatory SecretCipher, so
 * at-rest encryption stays a wiring change, and metadata/DTO queries never join
 * the value table.
 */
export interface OrganizationEnvironmentSecretStore {
  /** Seal one value for a create/replacement, under the owning org's key. Runs
   *  OUTSIDE any transaction — a real cipher may make network calls and a
   *  transaction must never wait on one. */
  seal(orgId: OrgId, value: string): Promise<string>
  /** Decrypted values for the given entry ids, keyed by entry id. Missing rows
   *  are simply absent; the resolver turns that into a tombstone (§9). */
  values(orgId: OrgId, entryIds: readonly string[]): Promise<Map<string, string>>
}

/**
 * Resolves the organization contribution to one agent's (or a batch of agents')
 * effective environment. Injected into `AgentSpecAssembler`, which stays the
 * single producer of CP→daemon specs. The batch form exists so list-agent
 * endpoints do not become one query per agent.
 */
export interface OrganizationEnvironmentResolver {
  forAgent(orgId: OrgId, agentId: AgentId): Promise<OrganizationEnvironmentValues>
  forAgents(orgId: OrgId, agentIds: readonly AgentId[]): Promise<Map<string, OrganizationEnvironmentValues>>
  /**
   * Metadata-only projection for human DTOs: assigned variable values and secret
   * KEY NAMES, with no secret decryption at all.
   */
  metadataForAgents(orgId: OrgId, agentIds: readonly AgentId[]): Promise<Map<string, AssignedOrganizationMetadata>>
}

/** What an agent DTO may show about the entries assigned to that agent. */
export interface AssignedOrganizationMetadata {
  variables: Array<{ key: string; value: string }>
  secretKeys: string[]
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

// ───────────────────────────────────────────────────────────────────────────
// MemberSetRepo — the sets a duty may be claimed within (daemon-groups.md §2)
// ───────────────────────────────────────────────────────────────────────────

/** A member set. `orgId` null means CROSS-ORG (the install-wide pool), never "unassigned". */
export interface MemberSetRecord {
  id: string
  orgId: string | null
  name: string
}

export interface MemberSetRepo {
  /** The install-wide pool: the one org-less row. Null only before the migration that mints it. */
  crossOrgSetId(): Promise<string | null>
  get(setId: string): Promise<MemberSetRecord | null>
  /** Which set this daemon is a member of — the claim scope of its connection (§3). */
  setIdOf(daemonId: DaemonId): Promise<string | null>
  /** That set whole — what `auth/ok` announces, so the daemon is told a name and not just an id. */
  setOf(daemonId: DaemonId): Promise<MemberSetRecord | null>
  /** The set's members, sorted. The read path for "who could serve a `set`-placed agent". */
  memberIdsOf(setId: string): Promise<string[]>
  /** The set's members, sorted, but ONLY for a set whose members share one content store — the
   *  org-less install-wide pool. An org set answers `[]`: its machines may keep private stores, so
   *  none of them can stand in for another's transcripts (domain/session-content.ts). */
  sharedStoreMemberIdsOf(setId: string): Promise<string[]>
  /** Record a membership under the set's tenancy invariant; throws MemberSetTenancyMismatch.
   *  The automatic path (a pool Pod on auth) — no operator precondition. */
  enroll(setId: string, daemonId: DaemonId): Promise<void>
  /** The operator path: the same row, written under the per-daemon fence so two enrolments into
   *  different sets cannot both report success (§3). Agents pinned to the machine are untouched —
   *  it stays their only eligible holder. Throws `DaemonAlreadyInSet`. */
  enrollOperator(setId: string, daemonId: DaemonId): Promise<void>
  /** One org's sets, by name. The org-less pool is never among them — it belongs to no org. */
  listForOrg(orgId: string): Promise<MemberSetRecord[]>
  /** Agents placed on each of these sets, in one query — the list read must not be N+1. Sets with
   *  no agents are absent from the map, not zero-valued. */
  agentCountsOf(setIds: readonly string[]): Promise<Map<string, number>>
  /** Create an org's set. The org-less pool is minted by migration and never through this. */
  createForOrg(orgId: string, name: string): Promise<MemberSetRecord>
  /** Rename one of an org's sets. Null ⇒ no such set in that org. */
  renameForOrg(orgId: string, setId: string, name: string): Promise<MemberSetRecord | null>
  /** Drop one of an org's sets. Refused while anything still points at it: throws
   *  `MemberSetInUse` when it has members or `set`-placed agents. False ⇒ no such set. */
  deleteForOrg(orgId: string, setId: string): Promise<boolean>
  /** Drop a membership row, refusing (`DaemonHoldsDuty`) while the daemon holds a live lease at
   *  `now` — §3's stop-and-confirm, taken with the delete under the per-daemon fence so the
   *  ledger cannot grant it one in between. */
  withdraw(daemonId: DaemonId, now: Date): Promise<void>
}

// DutyGroupRepo (k8s daemons) — the CP-hosted duty ledger

/** One entry of a member's heartbeat duty digest: the group, at the term it believes it holds. */
export interface DutyDigestEntry {
  groupId: string
  term: bigint
}

/** A ledger row plus its derived membership projection. */
export interface DutyGroupRecord {
  groupId: string
  orgId: OrgId
  holder: DaemonId | null
  /** Monotonic per group; bumped on EVERY grant — the fencing token duty-scoped actions carry. */
  term: bigint
  /** Renewal horizon; past (or null with a holder never granted) ⇒ vacant and grantable. */
  expiresAt: Date | null
  members: DutyMemberKey[]
}

/** One freshly granted group as returned by a claim. */
export interface DutyGrantRecord {
  groupId: string
  orgId: OrgId
  term: bigint
  members: DutyMemberKey[]
}

export interface AgentHomeClaim {
  granted: boolean
  /** Absent only when the claim was refused before any group was read or minted — an ineligible
   *  claimant, which has no group to name and must not learn of one. */
  groupId?: string
  term?: bigint
  /** The live holder — the caller when granted, the incumbent for a `not_holder` answer otherwise. */
  holder: DaemonId | null
}

/** Pure plan callback run inside the reconcile transaction's org snapshot (orchestrator/dutyGroup.ts). */
export type DutyReconcilePlanner = (existing: DutyGroupRecord[]) => DutyReconcilePlan

/** One member set's capacity and unmet demand, as {@link DutyGroupRepo.poolTelemetry} reads it. */
export interface PoolTelemetryRow {
  setId: string
  setName: string
  /** The org-less set — the install-wide pool. */
  installWide: boolean
  /** Members seen within the lease horizon. */
  liveMembers: number
  /** Of those, the ones running UNBOUNDED (`maxAgents <= 0`, the daemon's sentinel for no ceiling).
   *  Non-zero means this set has no finite budget, so capacity and headroom are not defined for it. */
  unboundedMembers: number
  /** Σ `maxAgents` over the BOUNDED members — the duty budget the pool can currently spend.
   *  Meaningless while {@link PoolTelemetryRow.unboundedMembers} is non-zero. */
  capacityAgents: number
  /** Distinct agents covered by unexpired leases those members hold — the budget spent. */
  dutyAgents: number
  /** Vacant groups this set is eligible to claim and CAN deliver — unmet demand. */
  vacantGroups: number
  /** Vacant, eligible, but over the wire's member cap: never claimable at any pool size (D16). */
  oversizedVacantGroups: number
  /** Age of the oldest {@link PoolTelemetryRow.vacantGroups} entry. Sustained ⇒ nothing could take it. */
  oldestVacancySec: number
}

export interface DutyGroupRepo {
  /** Recompute input + console/introspection read. */
  listForOrg(orgId: OrgId): Promise<DutyGroupRecord[]>
  /** Everything one member currently holds (heartbeat digest reconciliation). */
  listHeldBy(holder: DaemonId): Promise<DutyGroupRecord[]>
  /** Point reads for digest classification: which of these ids still exist. */
  getByIds(groupIds: string[]): Promise<DutyGroupRecord[]>
  /** Snapshot → `planner` → apply, in ONE transaction under a per-org advisory
   *  scope, so concurrent recomputes serialize CP-instance-wide. Composition
   *  changes on held groups re-grant the same holder at a bumped term; the
   *  returned plan carries the supersessions the caller must deliver. */
  applyReconcile(
    orgId: OrgId,
    planner: DutyReconcilePlanner,
    opts: { now: Date; leaseMs: number }
  ): Promise<DutyReconcilePlan>
  /** "Grant me up to `max` vacant groups": first valid claim wins (SKIP LOCKED),
   *  each grant bumps the term. Capacity gating is the caller's.
   *  `maxMembers` excludes undeliverable (oversized) groups at the claim
   *  boundary, so they never churn or starve the vacancies behind them.
   *  Eligibility is read from the HOLDER's own set membership (domain/placement.ts), never
   *  asserted by the caller: a group is claimable only when the claimant may hold EVERY agent in
   *  it, which is what keeps a pool member off the agents a local daemon is already serving.
   *  `excludeGroupIds` carries the caller's refusal backoff. */
  claimVacant(
    holder: DaemonId,
    max: number,
    now: Date,
    leaseMs: number,
    opts?: { maxMembers?: number; excludeGroupIds?: readonly string[] }
  ): Promise<DutyGrantRecord[]>
  /** The group-computation inputs for one org: every agent as a node, plus
   *  active integrations on daemon-held (socket, unrevoked) bots as edges. */
  computeInputs(orgId: OrgId): Promise<{ edges: DutyEdge[]; agents: AgentSeed[] }>
  /** Keyset rotation over orgs that can need a recompute — any org owning an
   *  agent or an existing duty group. */
  listDutyOrgs(afterOrgId: string | null, limit: number): Promise<string[]>
  /** Per-set capacity and unmet demand, for the pool gauges (observability/pool-metrics.ts).
   *  Read-only and derived entirely from the ledger, so it states what the claim paths would
   *  decide rather than a second opinion about it: `liveMs` is the same liveness horizon
   *  {@link DutyGroupRepo.newerGenerationLive} uses, `maxMembers` the same deliverability cap
   *  {@link DutyGroupRepo.claimVacant} gates on. */
  poolTelemetry(now: Date, liveMs: number, maxMembers: number): Promise<PoolTelemetryRow[]>
  /** The placement fence, re-derived from the eligibility predicate: vacate every held group its
   *  holder may no longer hold — an agent moved off a set onto a machine, or off one machine
   *  onto another. Same rule as {@link DutyGroupRepo.claimVacant}, read from the holder's side, so
   *  a lease can never outlive the placement that justified it. Returns the vacated groupIds. */
  vacateIneligible(orgId: OrgId): Promise<string[]>
  /** Batched renewal — one write per heartbeat covering every held group.
   *  Term-preserving; a reassigned group simply stops matching. Returns the
   *  renewed groupIds for digest comparison. */
  renewHeld(holder: DaemonId, now: Date, leaseMs: number): Promise<string[]>
  /** Explicit vacate (drain): holder-conditional, immediate, term kept. */
  release(holder: DaemonId, groupIds: string[]): Promise<void>
  /** First-trigger claim for a botless agent: creates the singleton home if none
   *  exists ("claiming creates the lease"), grants if vacant, otherwise names
   *  the incumbent. Idempotent for the current holder (no term churn). Gated by
   *  the SAME eligibility predicate as {@link DutyGroupRepo.claimVacant}, read
   *  inside the transaction — the rendezvous is a claim path too, and a member
   *  must not reach through it for an agent it may not hold. */
  claimAgentHome(orgId: OrgId, agentId: AgentId, holder: DaemonId, now: Date, leaseMs: number): Promise<AgentHomeClaim>
  /** Does `holder` currently hold an unexpired lease on a group covering this
   *  agent? The authorization for `duty/fetch`: a member may pull exactly the
   *  agent definitions it has won, and nothing else. */
  holdsAgent(holder: DaemonId, agentId: AgentId, now: Date): Promise<boolean>
  /** The rollout barrier (k8s-daemon-pool.md §12): is there a LIVE member of the claimant's set — one
   *  seen within `liveMs` — whose generation is different and NEWER than the claimant's? Generations
   *  are ordered by the earliest live member's `generationSince`. A claimant with a null generation,
   *  or in no set, is never held back; that is what keeps local daemons and older pods unaffected. */
  newerGenerationLive(holder: DaemonId, now: Date, liveMs: number): Promise<boolean>
  /** Record the holds this member reports in its heartbeat digest, returning the ones that became
   *  confirmed on THIS beat. A grant is applied daemon-side only after its install succeeds
   *  (#972), so the digest IS the proof that the member is serving — the same signal the
   *  self-fence and CP renewal already ride, not a new one.
   *
   *  Scoped to the exact grant: an entry only confirms while its `term` still matches the row's,
   *  so a beat that crossed a re-grant confirms nothing. */
  confirmHeld(holder: DaemonId, reported: readonly DutyDigestEntry[]): Promise<string[]>
  /** {@link DutyGroupRepo.holdersOf} restricted to CONFIRMED holds — who INGRESS may be addressed
   *  at. A holder that is still installing is a live lease and not yet a route. */
  confirmedHoldersOf(agentId: AgentId, now: Date): Promise<DaemonId[]>
  /** Every member currently holding an unexpired lease on a group covering this
   *  agent — the delivery half of {@link DutyGroupRepo.holdsAgent}, so a live
   *  update reaches whoever serves the agent rather than only where it is placed
   *  (orchestrator/agentDelivery.ts). Deliberately membership-only: the agent row
   *  may already be gone (a delete replicates AFTER the cascade). */
  holdersOf(agentId: AgentId, now: Date): Promise<DaemonId[]>
  /** Every agent covered by the unexpired leases `holder` holds — the duty half
   *  of the `register/ok` reconcile roster, which is `pinned-to-me ∪ held-by-me`. */
  heldAgentIds(holder: DaemonId, now: Date): Promise<AgentId[]>
}
