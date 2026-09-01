/**
 * `http/deps.ts` — the dependency bundle the C2 BFF routes receive (design §2.1,
 * §2.4). Routes consume repository **ports** and cross-component services, never
 * `@prisma/client`. Assembled by the composition root and handed to
 * `buildHttpServer`.
 */
import type {
  AgentRepo,
  AssignmentRepo,
  AuditRepo,
  CronRepo,
  HookRepo,
  HookSecretStore,
  RelayRepo,
  SessionRepo,
  SessionUsageRepo,
  WebchatConversationRepo,
  UserRepo,
  OrgRepo,
  WaitlistRepo,
  IntegrationRepo,
  IntegrationChannelRepo,
  BotRepo,
  BotSecretStore,
  BotCredentialWriter,
  AgentSecretStore,
  AgentConfigWriter,
  McpProviderRepo,
  MemberSetRepo,
  DutyGroupRepo,
  McpProviderSecretStore,
  McpGrantRepo,
  SkillSourceRepo,
  OrganizationEnvironmentRepo,
  OrganizationEnvironmentResolver,
  OrganizationEnvironmentSecretStore,
  OrganizationKnowledgeRepo,
  MemoryPluginInstallationRepo,
  ExternalMemoryConnectionRepo,
  ExternalMemoryConnectionSecretStore,
  ExternalMemoryGrantRepo,
  MemoryConnectionWriter,
  SlackInstallStore,
  SlackPlatformInstallStore,
  FeishuAppRegistrationStore,
  SlackUserConfigStore,
  LinearTokenStore,
  LinearInstallStateStore,
  PresetAgentStore,
  GithubInstallationRepo,
  AgentRepoAuthorizationRepo,
  CodeHostRepositoryRepo,
  GitlabConnectionRepo,
  GitlabAgentAccountRepo,
  GitlabInstanceStateRepo,
  GitlabProjectBindingRepo,
  DaemonLifecycleOpRepo,
  OAuthRepo,
  WebchatMcpOperationRepo
} from '../persistence/ports.js'
import type { Clock } from '../domain/clock.js'
import type { OAuthService } from '../registry/oauthService.js'
import type { GithubService } from '../github/service.js'
import type { GitlabOauthService } from '../gitlab/oauth.service.js'
import type { GitlabApiClient } from '../gitlab/api.js'
import type { GitlabAccountService } from '../gitlab/account.service.js'
import type { GitlabProvisioner } from '../gitlab/provisioner.js'
import type { GitlabHookRerunService } from '../gitlab/hook-rerun.service.js'
import type { PullRequestViewService } from '../github/pull-request-view.service.js'
import type { SessionPullRequestLinkService } from '../github/session-pull-request-link.service.js'
import type { GithubUserAuthzService } from '../github/user-authz.js'
import type { LogtoIdentityService } from '../github/logto-identity.js'
import type { HookService } from '../hooks/hook.service.js'
import type { DaemonRegistry, DaemonAuth, ApiKeyAdmin, DaemonLiveness, ClusterWorkloadIdentity } from '../ports.js'
import type { CpPlatformRegistry } from '../platforms/provider.js'
import type { DaemonReleaseResolver } from '../registry/daemonRelease.js'
import type { WebchatTokenService } from '../registry/webchatToken.js'
import type { OrgInviteLinkService } from '../registry/orgInviteLinkService.js'
import type { WaitlistService } from '../registry/waitlistService.js'
import type { ControlSender } from '../orchestrator/outbound.js'
import type { AgentDelivery } from '../orchestrator/agentDelivery.js'
import type { PlacementResolver } from '../orchestrator/placementResolver.js'
import type { SessionVisibilityPushService } from '../orchestrator/visibilityPush.js'
import type { AgentSpecAssembler } from '../orchestrator/agentSpecAssembler.js'
import type { RelayControlSender } from '../orchestrator/relayControl.js'
import type { HttpBotOrchestrator } from '../orchestrator/httpBot.js'
import type { CollabRoutesService } from '../orchestrator/collabRoutes.service.js'
import type { AgentMutationGate } from '../orchestrator/agentMutationGate.js'
import type { SessionEventSink } from '../events/sink.js'
import type { UsageWriter } from '../usage/writer.js'
import type { HumanAuthConfig } from './plugins/auth.js'
import type { SkillRegistrySearcher } from './skills-registry.js'
import type { PublicRepoResolver } from '../github/public-repo.js'
import type { Readiness } from './readiness.js'
import type { McpRateLimiter } from './mcp/rate-limit.js'
import type { RemoteGrantAuthenticator } from './mcp/remote-grant-authenticator.js'
import type { InternalInvocationAuth } from './mcp/internal-invocation-auth.js'
import type { WebchatMcpMetrics } from '../observability/webchat-mcp.js'
import type { SessionKey } from '../domain/sessionKey.js'
import type { IconStore } from '../icons/icon-store.js'
import type { ConnectorsClient } from '../connectors/client.js'
import type { SessionAccessPlugin } from './session-access-plugin.js'
import type { RuntimeConfigRouteDeps } from './routes/runtime-config.js'

export interface HttpServerConfig extends HumanAuthConfig {
  /** Drives browser CORS for the Web UI (see `buildHttpServer`). */
  NODE_ENV?: 'development' | 'test' | 'production'
  CORS_ORIGIN?: string
  /** Externally-reachable CP origin used to render the daemon start command
   *  (onboarding). Unset ⇒ fall back to `HOST:PORT`. */
  PUBLIC_CP_URL?: string
  /** The MCP endpoint's dedicated public origin (e.g.
   *  https://mcp.example.test). Set ⇒ the canonical MCP resource URL is this
   *  origin (root resource) and discovery uses the origin-root PRM. Unset ⇒
   *  `<public base>/v1/mcp`. */
  PUBLIC_MCP_URL?: string
  /** npm dist-tag (or version) the onboarding command pins for `npx`, e.g. `rc`
   *  on the test CP ⇒ `npx @agentconnect.md/daemon@rc …`. Unset ⇒ `@latest`. */
  DAEMON_DIST_TAG?: string
  /** Daemon WebSocket path (mirrors `AppConfig.WS_PATH`); default `/daemon/ws`. */
  WS_PATH?: string
  /** Console origin the github setup callback 302s back to (resolveWebAppUrl input). */
  PUBLIC_WEB_URL?: string
  /** The relay pool's public ingress origin, returned by the webchat-token mint so the
   *  browser knows where to dial. Unset ⇒ the mint endpoint 503s (§10, A4). */
  PUBLIC_RELAY_URL?: string
  HOST?: string
  PORT?: number
  /** Grace window (ms) after a daemon's last heartbeat during which a disconnected
   *  daemon still reads `connecting` instead of `offline` — absorbs the reconnect
   *  gap after a CP restart. Unset/0 ⇒ disabled. Set from HEARTBEAT_SEC×MISSED_BEATS. */
  DAEMON_OFFLINE_GRACE_MS?: number
  /** The relay liveness window (RELAY_STALE_SEC×1000) — hook creation's
   *  "has a live relay" gate reads `relay.listAlive(now − this)`. */
  RELAY_STALE_MS?: number
  /** S3_PUBLIC_BASE_URL — the object store's public origin for uploaded `image`
   *  icons. Set ⇒ resolvers build `image` icon URLs here. Unset ⇒ no upload store. */
  S3_PUBLIC_BASE_URL?: string
  /** Closed-beta admission gate (waitlist-and-login.md §3). When true, `/me/access`
   *  enforces the gate and `POST /orgs` requires an activated user; false ⇒ the OSS
   *  behavior (everyone is `active`). */
  WAITLIST_MODE?: boolean
  /** Deployment-shared service secret for the batch usage ingress. Unset ⇒ that
   *  route is not registered and the daemon EVT is the only usage ingress. */
  USAGE_INGEST_TOKEN?: string
  /** ServiceAccount the usage collector presents on that ingress — the deployment names its
   *  collector workload and says so here. Unset ⇒ the protocol default. */
  USAGE_COLLECTOR_SERVICE_ACCOUNT?: string
}

export interface HttpDeps {
  /** Secret-free startup snapshot served to the prebuilt browser image. */
  runtimeConfig: RuntimeConfigRouteDeps
  /** Deployment quota for non-ADMIN organization creation; absent defaults to one. */
  maxOrgsPerNonAdminUser?: number
  /** Shared process clock: delegated MCP execution uses the same timer seam as its reaper. */
  clock: Clock
  repos: {
    agent: AgentRepo
    assignment: AssignmentRepo
    /** CP-commanded daemon restart/upgrade tracking (cli-daemon-split.md §7) — the
     *  upgrade/restart routes open a pending op; the fleet DTO overlays it. */
    daemonLifecycleOp: DaemonLifecycleOpRepo
    cron: CronRepo
    /** Inbound-webhook trigger definitions + run metadata (never payloads). */
    hook: HookRepo
    /** Per-hook HMAC key — written on create, echoed exactly once, never DTO'd. */
    hookSecret: HookSecretStore
    /** Relay liveness reads — gates hook creation on "the pool exists" (409). */
    relay: RelayRepo
    session: SessionRepo
    /** Per-session token usage → the `/usage` dashboard aggregates. */
    sessionUsage: SessionUsageRepo
    /** Ownership-only metadata that authorizes browser conversation resumes. */
    webchatConversation: WebchatConversationRepo
    /** WebUI human identity — JIT-provisions the user behind a verified OIDC token. */
    user: UserRepo
    /** The caller's orgs (picker, create, owner-gated rename). */
    org: OrgRepo
    /** Closed-beta admission state + join-link redemption (waitlist-and-login.md). */
    waitlist: WaitlistRepo
    /** Platform integration metadata (never tokens). */
    integration: IntegrationRepo
    /** Daemon-reported conversation membership + the per-conversation trigger choice. */
    integrationChannel: IntegrationChannelRepo
    /** Durable bot identities — outlive their integration, reusable after uninstall. */
    bot: BotRepo
    /** The ONLY token read/write path (values pass the SecretCipher seam). */
    botSecret: BotSecretStore
    botCredential: BotCredentialWriter
    /** The ONLY read/write path for agent write-only secret env vars — key names
     *  via `keys` for DTOs, values via `get` for wire projection only. */
    agentSecret: AgentSecretStore
    /** Transactional agent-row + secret-row writer — REST create/PATCH go through
     *  this so a failure between the two writes can't leave a partial definition. */
    agentConfig: AgentConfigWriter
    /** The sets a duty may be claimed within — the console resolves a placement target to one. */
    memberSet: MemberSetRepo
    /** The duty ledger, read-only here: a membership change must not take a live lease away from
     *  a machine that could still be serving it (daemon-groups.md §3). */
    dutyGroup: Pick<DutyGroupRepo, 'listHeldBy'>
    /** Org-level MCP provider metadata (never upstream header values / grant keys). */
    mcpProvider: McpProviderRepo
    /** The ONLY read/write path for upstream MCP auth headers (store-only, never DTO'd). */
    mcpProviderSecret: McpProviderSecretStore
    /** Plaintext bearer grant keys for MCP providers (store-only, echoed once on create). */
    mcpGrant: McpGrantRepo
    /** Org-level shared-skills sources (metadata only; content stays daemon-side). */
    skillSource: SkillSourceRepo
    /** Accepted organization Knowledge, managed-skill revisions, and pending suggestion metadata. */
    organizationKnowledge?: OrganizationKnowledgeRepo
    /** Organization-owned variables/secrets + their per-agent bindings (metadata and
     *  binding CRUD only; secret VALUES go through `organizationEnvironmentSecret`). */
    organizationEnvironment: OrganizationEnvironmentRepo
    /** The only sealing/decrypting path for organization secret values. */
    organizationEnvironmentSecret: OrganizationEnvironmentSecretStore
    /** Resolves the organization entries assigned to an agent — the internal
     *  effective-config read for wire assembly, and the metadata-only twin the
     *  agent DTO uses (which never decrypts). */
    organizationEnvironmentResolver: OrganizationEnvironmentResolver
    /** Owner-reviewed external-memory plugin installations (metadata only). */
    memoryPluginInstallation: MemoryPluginInstallationRepo
    /** Org external-memory connections and revision-fenced probe state. */
    externalMemoryConnection: ExternalMemoryConnectionRepo
    /** The only decrypting path for connection secret values. */
    externalMemoryConnectionSecret: ExternalMemoryConnectionSecretStore
    /** Daemon-private purpose-specific relay grants. */
    externalMemoryGrant: ExternalMemoryGrantRepo
    /** Transactional check-then-write pairs for external-memory mutations,
     *  serialized cross-instance via advisory mutation scopes ('busy' ⇒ 409). */
    memoryConnectionWriter: MemoryConnectionWriter
    /** Pending config-token auto-install sessions (§Tier B); holds secret material, never DTO'd. */
    slackInstall: SlackInstallStore
    /** Pending platform-app installs (preset-agents.md §5.3): OAuth state → tenancy, no secrets. */
    slackPlatformInstall: SlackPlatformInstallStore
    /** Durable, encrypted Feishu/Lark one-click device registrations. */
    feishuAppRegistration: FeishuAppRegistrationStore
    /** One org's stored Slack App Configuration token (§Tier B); holds secret material, never DTO'd. */
    slackUserConfig: SlackUserConfigStore
    /** Connected Linear workspaces' rotating OAuth grants, keyed by connection identity; secret material. */
    linearToken: LinearTokenStore
    /** Pending Linear workspace connects: the OAuth state nonce + chosen default agent, no secrets. */
    linearInstallState: LinearInstallStateStore
    /** Per-org preset provisioning state (preset-agents.md §3.2) — read surface
     *  (the platform Slack install's default bind target; later, the checklist). */
    presetAgent: PresetAgentStore
    /** Deployment GitHub App installations (github-app workspaces); org-level infrastructure. */
    githubInstallation: GithubInstallationRepo
    /** Explicit non-workspace repo grants per agent (issue #457) — the agent
     *  Repositories card + the github-hook watch-repo gate. */
    agentRepoAuth: AgentRepoAuthorizationRepo
    /** Provider-qualified repository catalog (gitlab-com-integration.md §8.1) — readers-first write side. */
    codeHostRepository: CodeHostRepositoryRepo
    /** GitLab.com OAuth connection metadata (§8.2); token pair lives behind its secret store. */
    gitlabConnection: GitlabConnectionRepo
    /** Managed GitLab project bindings (§8.2/§10). */
    gitlabProjectBinding: GitlabProjectBindingRepo
    /** Per-agent GitLab service accounts and their memberships (§7.2/§8.2). */
    gitlabAgentAccount: GitlabAgentAccountRepo
    /** Deployment-level observed instance version (§24.2). */
    gitlabInstanceState: GitlabInstanceStateRepo
    /** Append-only events feed (§3.12) — WebUI CRUD writes land here (`cron_change`, …). */
    audit: AuditRepo
    /** Durable browser-confirmed delegated MCP operation ledger. */
    webchatMcpOperation: WebchatMcpOperationRepo
    /** Embedded OAuth AS protocol state (agent-assistant.md §7): clients, codes, grants. */
    oauth: OAuthRepo
  }
  registry: DaemonRegistry
  /**
   * §9 platform-provider registry — the single platform-set authority, and the
   * ONLY per-platform member of this bundle. `server.ts` mounts each provider's
   * `installRoutes(scope)` (so no core file imports a funnel-route factory); the
   * create route folds each provider's `credentialBodySchema` /
   * `refineCreateBody` into its request schema, dispatches the live credential
   * check through `validateConfig`, and writes its rows from
   * `buildNewBotInstall`; the agent-icon fan-out probes
   * `sideEffects.syncBotProfileIcon`; the Slack routes read the caller's stored
   * App Configuration token through `providerToolingCredentials`; and
   * `orchestrator/httpBot.ts` gates an `rc/bot-assign` on
   * `secretShape.httpAssignRequires`. So no route file names a platform.
   *
   * The twelve platform-named slots this bundle used to carry (`verifySlackBot`,
   * `slackConfigApi`, `verifyTelegramBot`, `syncTelegramBotIcon`,
   * `verifyDiscordBot`, `ensureDiscordMessageContentIntent`,
   * `syncDiscordBotProfile`, `verifyFeishuBot`, `configureFeishuHttpApp`,
   * `syncFeishuAppIcon`, `feishuAppRegistration`, `verifySlackAppToken`, plus
   * `slackPlatformApp`) are gone: the CAPABILITY questions they were probed for
   * are answered here, and the INJECTION they provided moved to
   * `http/platform-route-seams.ts`, which each provider's route factories take
   * as a second argument. Everything is read THROUGH this registry at call time
   * — never captured at construction — because the composition root publishes it
   * late (a provider is built FROM this very bundle).
   */
  platforms: CpPlatformRegistry
  /** The ONE assembler of CP→daemon AgentSpecs (owns secret loading + icon bases) —
   *  every spec emission (upsert replicate, icon refresh, move activation) uses it. */
  agentSpecs: AgentSpecAssembler
  /** Resolves the latest daemon version in the deployment's npm release channel for
   *  the console's "update available" hint. Absent ⇒ no hint (test/offline). */
  daemonRelease?: DaemonReleaseResolver
  /** Live connection index the daemon read model overlays for real-time status. */
  liveness: DaemonLiveness
  /** Live daemon connection reads (state + advertised feature capabilities) —
   *  gates multi-agent webchat conversation CREATION on every selected agent's
   *  daemon advertising `webchat_multi_agent_v1` (webchat-multi-agents.md §6.3).
   *  Backed by the ConnectionRegistry. */
  daemonConns: { get(daemonId: string): { state: string; capabilities?: { features: string[] } } | undefined }
  /** The fencing site for C→D control. REST agent CRUD pushes `agent/upsert`/
   *  `agent/remove` through it to replicate config to the owning daemon. */
  control: ControlSender
  /** Resolves an agent's delivery set — placement ∪ current duty holders — and
   *  fans `agent/upsert`/`agent/remove` out over it. EVERY replicate site routes
   *  through this; none of them reads `agent.daemonId` to decide delivery. */
  agentDelivery: AgentDelivery
  /** The ONE answer to "which daemons serve this agent" (placement ∪ duty holders). Routes ask it
   *  instead of reading `agent.daemonId`, which stopped naming a machine when a member set became
   *  a placement target. */
  placementResolver: PlacementResolver
  /** Pushes the per-session memory-capture gate to the owning daemons after a
   *  §4.3 visibility change, and answers the pending/applied cutover state
   *  (session-visibility.md §5.1). Absent ⇒ changes converge on register. */
  visibilityPush?: SessionVisibilityPushService
  /** CP→relay control fan-out — pushes `rc/daemon-revoke` to connected relays when a
   *  daemon key is revoked / a daemon is removed (shared-bot-relay.md §9). */
  relayControl: RelayControlSender
  /** HTTP-bot assignment + attributed-route compilation (shared-bot-relay.md §4.2/§10).
   *  Install / uninstall / toggle / channel-owner changes call it to (re)assign a
   *  HTTP bot's ingest to the relay pool and push its routes + send-only daemon specs. */
  httpBot: HttpBotOrchestrator
  /** Rebuilds placement-dependent collaboration routes after an agent cold move. */
  collabRoutes: CollabRoutesService
  /** Process-local exclusive move vs shared CRUD gate; valid with one active CP writer. */
  agentMutations: AgentMutationGate
  /** Hot assignment-owner index paired with the durable AssignmentRepo. */
  sessionOwners: { releaseSession(key: SessionKey): void }
  /** Compiles hooks into relay rules and keeps the pool converged — hook CRUD
   *  and agent placement changes call through it (fire-and-forget). */
  hooks: HookService
  /** Best-effort latency kick for durable GitHub projection cleanup. */
  kickGithubRunReporter?: () => void
  /** Recompute an org's duty groups now that their inputs changed (integrations,
   *  cron enablement, bot credentials, placement). Fire-and-forget: the periodic
   *  rotation is the backstop, so this only buys latency. */
  recomputeDuties?: (orgId: string) => void
  auth: DaemonAuth
  /** API-key lifecycle (onboarding / rotation / revocation). */
  apiKeys: ApiKeyAdmin
  /** Embedded OAuth 2.1 AS logic (agent-assistant.md §7): DCR, PKCE code exchange, refresh. */
  oauth: OAuthService
  /** Mints the short-lived browser webchat token (§10, A4). */
  webchatTokens: WebchatTokenService
  /** One fixed seven-day collaborator invite link per organization. */
  inviteLinks: OrgInviteLinkService
  /** Closed-beta admission: `/me/access` status, self-join, join-link redeem (waitlist-and-login.md). */
  waitlist: WaitlistService
  /** The shared usage report interface — this plane is its `gateway`-source adapter. */
  usageWriter: UsageWriter
  /** Reviews a projected ServiceAccount token for an in-cluster workload. Absent ⇒ this
   *  deployment has no cluster to review against and only shared secrets authenticate. */
  clusterWorkloadIdentity?: ClusterWorkloadIdentity
  events: SessionEventSink
  /** Per-credential sliding-window limits for MCP tool calls (agent-assistant.md
   *  §6.5). ONE instance per composition root — the MCP plugin is mounted twice
   *  (`/api/v1/mcp` + `/v1` alias) and both mounts must share a budget. */
  mcpRateLimit: McpRateLimiter
  /** Route-only remote-grant verifier and idempotency claimant. */
  remoteGrantAuth: RemoteGrantAuthenticator
  /** In-process principal propagation for MCP's nested REST injections. */
  internalInvocationAuth: InternalInvocationAuth
  /** §8 CP-db-only operation atomicity: run `fn` with every repository call
   *  (including nested app.inject routes) joined to one shared transaction, so
   *  a CP-database mutation and its operation's terminal transition commit
   *  together. A thrown error rolls the whole unit back. */
  sharedTx<T>(fn: () => Promise<T>): Promise<T>
  /** Low-cardinality delegated MCP observations. Optional for focused route tests. */
  webchatMcpMetrics?: Pick<WebchatMcpMetrics, 'invocation' | 'requestDuration'>
  /** Process readiness gate for `/readyz` (rolling-update drain, issue #240). */
  readiness: Readiness
  /** Reads the public skills.sh index for the Skills library's "Install from
   *  skills.sh" search. Optional/injectable so tests stay offline (absent ⇒ the
   *  search route reports the index unreachable and the console offers the GitHub
   *  import path instead). */
  searchSkillRegistry?: SkillRegistrySearcher
  /** Anonymous GitHub repo lookup that binds a skill source's numeric identity when
   *  no org installation covers the owner (the skills.sh case). Optional/injectable
   *  so tests stay offline; absent ⇒ only the installation path can bind. */
  resolvePublicRepo?: PublicRepoResolver
  /** github-app workspaces façade; absent ⇒ feature disabled (GITHUB_APP_* unset) and
   *  every github route 404s. */
  github?: GithubService
  /** GitLab OAuth surface (gitlab-com-integration.md §9); absent ⇒ routes 404.
   *  `api` is the base-bound GitLab edge the admin routes share with the service. */
  gitlab?: {
    oauth: GitlabOauthService
    provisioner: GitlabProvisioner
    /** §7.2 per-agent accounts: convergence, retirement, and PAT rotation. */
    accounts: GitlabAccountService
    /** The §16.1 Console rerun authorizer; the route 404s without the GitLab app. */
    hookRerun: GitlabHookRerunService
    api: GitlabApiClient
  }
  /** The PR panel's read projection; absent like {@link github} ⇒ the route 404s, hiding the tab. */
  pullRequestView?: PullRequestViewService
  /** The panel's second identity source: the PR a session's own head branch has, for the sessions no
   *  pull-request run owns (§12.6). Absent ⇒ only run-linked sessions resolve a PR, as before. */
  sessionPullRequestLink?: SessionPullRequestLinkService
  /** Per-user repo authorization (identity assertion, open question #7); absent ⇒ the
   *  org-level model (installation coverage only) and the permission route 404s. */
  githubUserAuthz?: GithubUserAuthzService
  /** Server-side Logto identity management for the signed-in user's Profile.
   *  Absent ⇒ LOGTO_MGMT_* or real OIDC auth is not configured. */
  logtoIdentity?: LogtoIdentityService
  /** Provider-owned identity + current-scope checks for Session visibility. */
  sessionAccessPlugins?: readonly SessionAccessPlugin[]
  /** Uploaded-icon object store (docs/designs/icon-uploads.md); absent ⇒ S3_* unset,
   *  the icon upload/delete routes are not mounted and the console hides Upload. */
  iconStore?: IconStore
  /** open-connector integration client (docs: connectors); absent ⇒ OPEN_CONNECTOR_URL
   *  unset, the connectors routes 404 and the console hides "Add connectors". */
  connectors?: ConnectorsClient
  config: HttpServerConfig
}
