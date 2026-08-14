/**
 * Cross-component ports (design §2.3) — the C2↔C3↔C4↔C5 seams.
 *
 * Services implement these; edges and other services consume ONLY the interface.
 * This file grows phase-by-phase: Phase 2 lands the C4 ports (`DaemonAuth`,
 * `DaemonRegistry`); the C3 `Orchestrator` / C5 `SecretsBroker` ports and the
 * `DaemonChannel` firewall join in Phase 3 as their services are built.
 */
import type {
  AuthReq,
  AuthOk,
  RegisterReq,
  Heartbeat,
  FactsRuntimeProfile,
  FactsMcpServer,
  McpTransportCapabilities,
  RuntimeModelCatalog,
  SecretsRequest,
  SecretsGrant
} from '@agentconnect.md/protocol'
import type { DaemonId, LeaseId, OrgId } from './domain/ids.js'
import type { DaemonStatus, HealthState, AcpSupport, ResourceVisibility, ViewCtx } from './persistence/ports.js'

/** Per-connection client context handed to auth (protocol §3, audit). */
export interface ClientCtx {
  remoteAddr: string
  subprotocol: string
}

/** Outcome of `DaemonAuth.authenticate` (design §2.3). */
export type AuthResult =
  | { ok: true; daemonId: DaemonId; orgId: OrgId | null; okFrame: AuthOk }
  | { ok: false; closeCode: 4401 | 4409 | 1011; reason: string }

/**
 * C4 — daemon authentication. `authenticate` verifies the presented credential — an opaque
 * `<secret><crc>` API key looked up by its peppered hash, or an in-cluster daemon's projected
 * ServiceAccount token — and, on success, mints the next monotonic `sessionEpoch` (the global
 * fencing token, §3.1).
 */
export interface DaemonAuth {
  authenticate(req: AuthReq, ctx: ClientCtx): Promise<AuthResult>
}

/** The daemon record a verified Kubernetes identity, including a cloud Pod UID, resolves to. */
export type VerifiedClusterDaemon =
  { daemonId: DaemonId; scope: 'org'; orgId: OrgId } | { daemonId: DaemonId; scope: 'install' }

/**
 * Verifier for an in-cluster daemon's projected ServiceAccount token. Null ⇒ the token is
 * not a usable in-cluster daemon identity, for any reason: the auth path answers one coarse
 * `AUTH_FAILED` either way, so the caller never learns which check refused it.
 *
 * A claimed daemon id is only an echo used by the relay hop; the reviewed identity and Pod UID decide.
 */
export interface ClusterDaemonIdentity {
  verify(token: string, claim?: { daemonId?: string }): Promise<VerifiedClusterDaemon | null>
}

/** A freshly minted key — the one-time plaintext returned to the operator. */
export interface MintedKeyView {
  apiKeyId: string
  /** Full `ac_<role>_<secret><crc>` plaintext; shown exactly once, never retrievable. */
  token: string
  displayTail: string
}

/** Onboarding result: a new (provisioned) daemon identity + its first key. */
export interface ProvisionedDaemon extends MintedKeyView {
  daemonId: DaemonId
}

/** Console view of an `api_key` — NEVER the secret or hash. */
export interface ApiKeyView {
  id: string
  displayTail: string
  name: string | null
  createdAt: Date
  lastUsedAt: Date | null
  expiresAt: Date | null
  revokedAt: Date | null
}

/** A personal key as shown on the profile "API keys" list — the console view plus
 *  the org the key acts in (a user's keys span all their orgs). */
export interface UserApiKeyView extends ApiKeyView {
  orgId: string
  orgSlug: string
  orgName: string | null
}

/** A verified personal key resolved from an `Authorization: Bearer <key>` header —
 *  the identity + the org the key is bound to (daemon-api-key-auth.md §8). */
export interface UserKeyPrincipal {
  userId: string
  orgId: string
  apiKeyId: string
  /** The key's granted scopes. EMPTY = unrestricted (a personal key carries the user's
   *  full RBAC). Non-empty = confined to these (an OAuth access token: `mcp:read` /
   *  `mcp:write`) — the enforcement point is the org-scope guard (agent-assistant.md §6.3). */
  scopes: string[]
}

/**
 * C4 — API-key lifecycle (onboarding / rotation / revocation). Minting persists the
 * hash only and returns the plaintext exactly once.
 */
export interface ApiKeyAdmin {
  /** Provision a new daemon (provisioned row + first key) in `orgId` — the onboarding flow. */
  provisionDaemon(opts: { orgId: string; createdByUserId?: string }): Promise<ProvisionedDaemon>
  /** Mint an additional key for an existing daemon (rotate / regenerate).
   *  Org-fenced (docs/designs/org-scoped-data-layer.md §3): the daemon is
   *  resolved inside `orgId`, so minting an enrolment credential for another
   *  organization's daemon fails as a missing row rather than relying on the
   *  route's pre-check. */
  mintForDaemon(orgId: OrgId, daemonId: DaemonId, opts?: { createdByUserId?: string }): Promise<MintedKeyView>
  /** Mint a relay key (`principalType='relay'`, org-less deployment infra, non-expiring)
   *  — the per-relay `rc/auth` `method:'apikey'` credential (shared-bot-relay.md §8).
   *  Plaintext is returned exactly once; minting a relay key is granting relay trust. */
  mintForRelay(opts?: { name?: string; createdByUserId?: string }): Promise<MintedKeyView>
  /** List a daemon's keys (incl. revoked) for the console. Org-fenced
   *  (docs/designs/org-scoped-data-layer.md §3): a daemon outside `orgId` yields
   *  no keys, which is also what makes the revoke route's ownership check on
   *  this list structural rather than conventional. */
  listForDaemon(orgId: OrgId, daemonId: DaemonId): Promise<ApiKeyView[]>
  /** Revoke a key by id (kill switch). */
  revoke(apiKeyId: string, reason: string): Promise<ApiKeyView>
  /** Mint a personal key for `userId`, scoped to `orgId` (default 90-day expiry;
   *  `expiresInDays: null` mints a non-expiring key).
   *  Plaintext is returned exactly once. Callers verify the user's membership in `orgId` first. */
  mintForUser(input: {
    userId: string
    orgId: string
    name?: string
    expiresInDays?: number | null
  }): Promise<MintedKeyView>
  /** A user's personal keys across all their orgs, active-only by default for the profile list. */
  listForUser(userId: string, opts?: { includeRevoked?: boolean }): Promise<UserApiKeyView[]>
  /** Mint an OAuth access token (`principalType='oauth'`) for a consented grant — a
   *  short-lived (default 1h) `api_key` row linked to `oauthGrantId`, carrying the
   *  granted scopes. Plaintext returned once; used by the embedded AS's /token endpoint. */
  mintOauthAccess(input: {
    userId: string
    orgId: string
    scopes: string[]
    oauthGrantId: string
    ttlSeconds?: number
  }): Promise<MintedKeyView>
  /** Revoke every live access token minted under an OAuth grant — the "disconnect"
   *  cascade so revoking a grant kills its outstanding tokens now. Returns the count. */
  revokeOauthGrantTokens(oauthGrantId: string): Promise<number>
  /** Verify an opaque `Authorization: Bearer <key>` presented to the REST plane:
   *  resolves a live `principalType='user'` key to its identity + bound org, or
   *  `null` when malformed / unknown / revoked / expired / not a user key. Throws
   *  only on a transient store error (→ the caller maps that to 5xx, not 401). */
  authenticateUser(token: string): Promise<UserKeyPrincipal | null>
}

/** Daemon-wide capabilities uploaded on `register` (protocol §7.1). */
export interface DaemonCapabilities {
  platforms: string[]
  runtimes: string[]
  acp: boolean
  features: string[]
}

/** Last reported `Heartbeat.load`. */
export interface DaemonLoad {
  cpu: number
  mem: number
  agents: number
}

/**
 * Observed runtime capability surfaced in the daemon read model — the trimmed
 * `facts/runtime-profile` projection (no persistence ids). `models` is the set of
 * model identifiers the daemon's installed runtime can drive; the console reads it
 * to populate the model picker per (machine, runtime).
 */
export interface DaemonRuntimeProfile {
  runtime: string
  version: string
  models: string[]
  contextWindow: number | null
  acpSupport: AcpSupport
  acpProtocolVersion: number | null
  toolCalling: boolean
  /** MCP transports the runtime advertised at ACP initialize; null ⇒ not probed
   *  / older daemon (assume stdio-only). */
  mcpCapabilities: McpTransportCapabilities | null
  /** Discovered model × config capability matrix (runtime-model-catalog.md §5);
   *  null ⇒ the daemon has no catalog for this runtime. */
  modelCatalog: RuntimeModelCatalog | null
  /** Provenance of `models[]`: 'cached' lists are permissive for capability
   *  gates, exactly like empty ones; null ⇒ older daemon (probed semantics). */
  modelsSource: 'cached' | 'probed' | null
  /** The daemon's last probe was rejected with the ACP auth-required error
   *  (-32000): the runtime is installed but needs a login on the daemon host.
   *  Drives the console's per-runtime login warning. */
  authRequired: boolean
  /** When the daemon last reported this profile. */
  observedAt: Date
}

/** Read model for `GET /daemons` (C2). */
export interface DaemonView {
  daemonId: DaemonId
  /** Null only for install-wide infrastructure shared by all organizations. */
  orgId: OrgId | null
  host: string | null
  /** Human-assigned display name (console-set); null until named. */
  name: string | null
  agentVersion: string | null
  status: DaemonStatus
  health: HealthState
  capabilities: DaemonCapabilities
  /** Observed runtime profiles (per installed runtime); empty until the daemon reports any. */
  runtimeProfiles: DaemonRuntimeProfile[]
  /** Daemon-configured MCP servers (`facts/daemon-runtimes.mcpServers`);
   *  empty until the daemon reports any. */
  mcpServers: FactsMcpServer[]
  load: DaemonLoad | null
  sessionEpoch: bigint
  maxAgents: number
  activeSessions: number
  lastSeenAt: Date | null
  createdAt: Date
  /** WebUI user who provisioned the daemon; null for CLI/self-registered. */
  createdBy: { userId: string; displayName: string | null; email: string } | null
  /** Last human edit (provision/rename); defaults to createdAt. */
  lastModifiedAt: Date
  /** WebUI user who last edited the daemon; null ⇒ never edited by a human. */
  lastModifiedBy: { userId: string; displayName: string | null; email: string } | null
  /** Raw immutable creator FK scalar, independent of joined `createdBy`. */
  createdByUserId: string | null
  /** Per-resource visibility (docs/designs/resource-visibility.md). */
  visibility: ResourceVisibility
  /** Complete app_user.id audience when `visibility === 'restricted'`. */
  sharedWith: string[]
  /** Console-set finished-session retention window ('never' | '7d' | '30d' | '90d'). */
  sessionRetention: string
}

/**
 * Live (in-memory) connection liveness the C2 read model overlays on the durable
 * registry. The durable `DaemonView.status` is a lifecycle marker that is NOT
 * downgraded when a daemon disconnects, so "is it connected right now" must come
 * from the live connection index (`ConnectionRegistry`, satisfied structurally).
 * An absent entry means the daemon is not currently connected.
 */
export interface DaemonLiveness {
  /** `sessionEpoch` is the LIVE connection's fencing epoch — the epoch a control frame
   *  sent right now would ride. Lifecycle commands capture it as the settlement baseline. */
  get(daemonId: string): { state: string; reachable: boolean; sessionEpoch: number } | undefined
  /** Close the same non-READY epoch so an auth-time bootstrap directive cannot be missed. */
  reconnectForBootstrap?(daemonId: string, sessionEpoch: number): boolean
}

/**
 * C4 — daemon registry & health. Records capabilities/heartbeats/runtime
 * profiles and exposes the read model. (Reconcile snapshot computation lives in
 * the C3 `Orchestrator`, not here.)
 */
export interface DaemonRegistry {
  upsertOnRegister(daemonId: DaemonId, req: RegisterReq): Promise<void>
  /** Persist a mid-connection `capabilities/update` full-replace (the durable
   *  sibling of the ConnectionRegistry's live copy). */
  updateCapabilities(daemonId: DaemonId, capabilities: RegisterReq['capabilities']): Promise<void>
  /** Close a pending CP-commanded restart/upgrade op once the daemon has ACTUALLY
   *  reached READY (called post-reconcile, cli-daemon-split.md §7). Best-effort. */
  settleLifecycleOpOnReady(daemonId: DaemonId): Promise<void>
  recordHeartbeat(daemonId: DaemonId, hb: Heartbeat): Promise<void>
  recordRuntimeProfile(daemonId: DaemonId, f: FactsRuntimeProfile): Promise<void>
  /** Reconcile the daemon's runtime list AND its MCP-server snapshot to the
   *  `facts/daemon-runtimes` frame (both replace semantics — stale rows pruned,
   *  the server list rewritten whole). `seq` is the frame's per-connection
   *  snapshot ordinal: a snapshot older than the last applied one is dropped
   *  whole (absent ⇒ latest-commit-wins, older daemons). */
  replaceRuntimeProfiles(
    daemonId: DaemonId,
    runtimes: FactsRuntimeProfile[],
    mcpServers: FactsMcpServer[],
    seq?: number
  ): Promise<void>
  markUnreachable(daemonId: DaemonId): Promise<void>
  /** Set the console-assigned display name; returns the updated read-model row.
   *  `byUserId` is the editing WebUI principal → stamps last-modified audit.
   *  Org-fenced in the repository (docs/designs/org-scoped-data-layer.md §3). */
  rename(orgId: OrgId, daemonId: DaemonId, name: string, byUserId?: string): Promise<DaemonView>
  /** Set the console's finished-session retention window ("Expire sessions");
   *  returns the updated read-model row. `byUserId` stamps the last-modified audit.
   *  Org-fenced like {@link DaemonRegistry.rename}. */
  setSessionRetention(
    orgId: OrgId,
    daemonId: DaemonId,
    sessionRetention: string,
    byUserId?: string
  ): Promise<DaemonView>
  /** Set the daemon's visibility + share set (the dedicated `/sharing` write path);
   *  returns the updated read-model row. `byUserId` stamps the last-modified audit.
   *  Org-fenced like {@link DaemonRegistry.rename}. */
  setSharing(
    orgId: OrgId,
    daemonId: DaemonId,
    sharing: { visibility: ResourceVisibility; sharedWith: string[] },
    byUserId?: string
  ): Promise<DaemonView>
  /** Hard-delete a daemon from the fleet (DELETE /daemons/:id). Org-fenced:
   *  throws for an absent row and for a cross-org id alike. */
  remove(orgId: OrgId, daemonId: DaemonId): Promise<void>
  /** Hard-delete one install-wide cloud member — the row a replaced cloud Pod left behind
   *  (`orchestrator/cloudDaemonReaper.ts`). No org owns it, so {@link DaemonRegistry.remove}
   *  cannot reach it; the org-less-cloud shape is the fence instead, and false means the row
   *  no longer matched rather than an error. */
  removeCloudMember(daemonId: DaemonId): Promise<boolean>
  /** The org-owned fleet; shared cloud members are deliberately absent. */
  list(orgId: OrgId, viewer?: ViewCtx): Promise<DaemonView[]>
  /** The display/placement fleet, including install-wide cloud members. */
  listAvailable(orgId: OrgId, viewer?: ViewCtx): Promise<DaemonView[]>
  /** One org-owned daemon; shared and foreign ids are indistinguishable from missing. */
  get(orgId: OrgId, daemonId: DaemonId): Promise<DaemonView | null>
  /** One daemon available for this org's display or placement. */
  getAvailable(orgId: OrgId, daemonId: DaemonId): Promise<DaemonView | null>
  /** Tenancy-UNSCOPED read model for internal trust domains: WS handlers reading
   *  their own connection's daemon, and daemon-derived platform capability
   *  checks. Never call this from the HTTP surface; lint enforces it (§6). */
  getUnscoped(daemonId: DaemonId): Promise<DaemonView | null>
}

/**
 * C5 — Secrets proxy. A lease broker ONLY: it requests/renews/revokes leases and
 * returns a {@link SecretsGrant} that carries a Vault/KMS **ref** + TTL, NEVER the
 * plaintext secret (§3.10). The grant also seeds `register/ok.leases[]`.
 */
export interface SecretsBroker {
  request(daemonId: DaemonId, req: SecretsRequest): Promise<SecretsGrant>
  renew(daemonId: DaemonId, leaseId: LeaseId): Promise<SecretsGrant>
  revoke(leaseId: LeaseId, reason: string): Promise<void>
}
