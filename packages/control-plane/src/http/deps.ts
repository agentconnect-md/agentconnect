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
  McpProviderSecretStore,
  McpGrantRepo,
  SkillSourceRepo,
  MemoryPluginInstallationRepo,
  ExternalMemoryConnectionRepo,
  ExternalMemoryConnectionSecretStore,
  ExternalMemoryGrantRepo,
  SlackInstallStore,
  SlackPlatformInstallStore,
  FeishuAppRegistrationStore,
  SlackUserConfigStore,
  PresetAgentStore,
  GithubInstallationRepo,
  AgentRepoAuthorizationRepo,
  DaemonLifecycleOpRepo,
  OAuthRepo,
  WebchatMcpOperationRepo
} from '../persistence/ports.js'
import type { Clock } from '../domain/clock.js'
import type { OAuthService } from '../registry/oauthService.js'
import type { GithubService } from '../github/service.js'
import type { GithubUserAuthzService } from '../github/user-authz.js'
import type { LogtoIdentityService } from '../github/logto-identity.js'
import type { HookService } from '../hooks/hook.service.js'
import type { DaemonRegistry, DaemonAuth, ApiKeyAdmin, DaemonLiveness } from '../ports.js'
import type { DaemonReleaseResolver } from '../registry/daemonRelease.js'
import type { WebchatTokenService } from '../registry/webchatToken.js'
import type { OrgInviteLinkService } from '../registry/orgInviteLinkService.js'
import type { WaitlistService } from '../registry/waitlistService.js'
import type { ControlSender } from '../orchestrator/outbound.js'
import type { SessionVisibilityPushService } from '../orchestrator/visibilityPush.js'
import type { AgentSpecAssembler } from '../orchestrator/agentSpecAssembler.js'
import type { RelayControlSender } from '../orchestrator/relayControl.js'
import type { HttpBotOrchestrator } from '../orchestrator/httpBot.js'
import type { CollabRoutesService } from '../orchestrator/collabRoutes.service.js'
import type { AgentMutationGate } from '../orchestrator/agentMutationGate.js'
import type { ExclusiveMutationGate } from '../orchestrator/exclusiveMutationGate.js'
import type { SessionEventSink } from '../events/sink.js'
import type { HumanAuthConfig } from './plugins/auth.js'
import type { SlackBotVerifier, SlackAppTokenVerifier } from './slack-identity.js'
import type { SlackPlatformAppConfig } from '../config/slack-platform.js'
import type { SlackConfigApi } from './slack-config-api.js'
import type { TelegramBotVerifier } from './telegram-identity.js'
import type { TelegramBotIconSyncer } from './telegram-bot-profile.js'
import type { DiscordBotVerifier, DiscordMessageContentIntentEnsurer } from './discord-identity.js'
import type { DiscordBotProfileSyncer } from './discord-bot-profile.js'
import type { FeishuBotVerifier } from './feishu-identity.js'
import type { FeishuAppIconSyncer } from './feishu-app-icon.js'
import type { FeishuAppRegistrationService } from './feishu-registration.js'
import type { FeishuHttpAppConfigurator } from './feishu-app-config.js'
import type { Readiness } from './readiness.js'
import type { McpRateLimiter } from './mcp/rate-limit.js'
import type { RemoteGrantAuthenticator } from './mcp/remote-grant-authenticator.js'
import type { InternalInvocationAuth } from './mcp/internal-invocation-auth.js'
import type { WebchatMcpMetrics } from '../observability/webchat-mcp.js'
import type { SessionKey } from '../domain/sessionKey.js'
import type { IconStore } from '../icons/icon-store.js'
import type { ConnectorsClient } from '../connectors/client.js'

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
}

export interface HttpDeps {
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
    /** Daemon-reported channel membership + the per-channel trigger choice. */
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
    /** Org-level MCP provider metadata (never upstream header values / grant keys). */
    mcpProvider: McpProviderRepo
    /** The ONLY read/write path for upstream MCP auth headers (store-only, never DTO'd). */
    mcpProviderSecret: McpProviderSecretStore
    /** Plaintext bearer grant keys for MCP providers (store-only, echoed once on create). */
    mcpGrant: McpGrantRepo
    /** Org-level shared-skills sources (metadata only; content stays daemon-side). */
    skillSource: SkillSourceRepo
    /** Owner-reviewed external-memory plugin installations (metadata only). */
    memoryPluginInstallation: MemoryPluginInstallationRepo
    /** Org external-memory connections and revision-fenced probe state. */
    externalMemoryConnection: ExternalMemoryConnectionRepo
    /** The only decrypting path for connection secret values. */
    externalMemoryConnectionSecret: ExternalMemoryConnectionSecretStore
    /** Daemon-private purpose-specific relay grants. */
    externalMemoryGrant: ExternalMemoryGrantRepo
    /** Pending config-token auto-install sessions (§Tier B); holds secret material, never DTO'd. */
    slackInstall: SlackInstallStore
    /** Pending platform-app installs (preset-agents.md §5.3): OAuth state → tenancy, no secrets. */
    slackPlatformInstall: SlackPlatformInstallStore
    /** Durable, encrypted Feishu/Lark one-click device registrations. */
    feishuAppRegistration: FeishuAppRegistrationStore
    /** One org's stored Slack App Configuration token (§Tier B); holds secret material, never DTO'd. */
    slackUserConfig: SlackUserConfigStore
    /** Per-org preset provisioning state (preset-agents.md §3.2) — read surface
     *  (the platform Slack install's default bind target; later, the checklist). */
    presetAgent: PresetAgentStore
    /** Deployment GitHub App installations (github-app workspaces); org-level infrastructure. */
    githubInstallation: GithubInstallationRepo
    /** Explicit non-workspace repo grants per agent (issue #457) — the agent
     *  Repositories card + the github-hook watch-repo gate. */
    agentRepoAuth: AgentRepoAuthorizationRepo
    /** Append-only events feed (§3.12) — WebUI CRUD writes land here (`cron_change`, …). */
    audit: AuditRepo
    /** Durable browser-confirmed delegated MCP operation ledger. */
    webchatMcpOperation: WebchatMcpOperationRepo
    /** Embedded OAuth AS protocol state (agent-assistant.md §7): clients, codes, grants. */
    oauth: OAuthRepo
  }
  registry: DaemonRegistry
  /** The ONE assembler of CP→daemon AgentSpecs (owns secret loading + icon bases) —
   *  every spec emission (upsert replicate, icon refresh, move activation) uses it. */
  agentSpecs: AgentSpecAssembler
  /** Resolves the latest daemon version in the deployment's npm release channel for
   *  the console's "update available" hint. Absent ⇒ no hint (test/offline). */
  daemonRelease?: DaemonReleaseResolver
  /** Live connection index the daemon read model overlays for real-time status. */
  liveness: DaemonLiveness
  /** The fencing site for C→D control. REST agent CRUD pushes `agent/upsert`/
   *  `agent/remove` through it to replicate config to the owning daemon. */
  control: ControlSender
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
  /** Process-local exclusive connection mutation vs agent bind/unbind gate. */
  memoryConnectionMutations: ExclusiveMutationGate
  /** Hot assignment-owner index paired with the durable AssignmentRepo. */
  sessionOwners: { releaseSession(key: SessionKey): void }
  /** Compiles hooks into relay rules and keeps the pool converged — hook CRUD
   *  and agent placement changes call through it (fire-and-forget). */
  hooks: HookService
  /** Best-effort latency kick for durable GitHub projection cleanup. */
  kickGithubRunReporter?: () => void
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
  events: SessionEventSink
  /** Per-credential sliding-window limits for MCP tool calls (agent-assistant.md
   *  §6.5). ONE instance per composition root — the MCP plugin is mounted twice
   *  (`/api/v1/mcp` + `/v1` alias) and both mounts must share a budget. */
  mcpRateLimit: McpRateLimiter
  /** Route-only remote-grant verifier and idempotency claimant. */
  remoteGrantAuth: RemoteGrantAuthenticator
  /** In-process principal propagation for MCP's nested REST injections. */
  internalInvocationAuth: InternalInvocationAuth
  /** Low-cardinality delegated MCP observations. Optional for focused route tests. */
  webchatMcpMetrics?: Pick<WebchatMcpMetrics, 'invocation' | 'requestDuration'>
  /** Process readiness gate for `/readyz` (rolling-update drain, issue #240). */
  readiness: Readiness
  /** Validates a pasted Slack bot token against `auth.test` (and derives the bot name
   *  from it when the install omits one). Optional/injectable so tests stay offline
   *  (absent ⇒ no validation, route falls back to the agent name). */
  verifySlackBot?: SlackBotVerifier
  /** Validates a pasted Slack app-level token against `apps.connections.open`.
   *  Optional/injectable (absent ⇒ no app-token validation). */
  verifySlackAppToken?: SlackAppTokenVerifier
  /** Slack App-management + OAuth calls for the config-token auto-install funnel
   *  (§Tier B). Optional/injectable; absent (with PUBLIC_CP_URL) ⇒ the funnel routes
   *  404 and the console falls back to the manual manifest flow. */
  slackConfigApi?: SlackConfigApi
  /** Validates a Telegram token, derives its bot name, and checks that Group Privacy
   *  Mode is disabled before the integration is installed. */
  verifyTelegramBot: TelegramBotVerifier
  /** Applies an Agent icon to a Telegram bot profile.
   *  Cosmetic and best-effort: install/icon updates survive a sync failure. */
  syncTelegramBotIcon?: TelegramBotIconSyncer
  /** Validates a pasted Discord bot token against `GET /users/@me` (and derives the bot
   *  name from it when the install omits one). Optional/injectable so tests stay offline
   *  (absent ⇒ no validation, route falls back to the agent name). */
  verifyDiscordBot?: DiscordBotVerifier
  /** Ensures the Discord application has Message Content enabled before credentials
   *  are stored. Test composition injects an offline success stub. */
  ensureDiscordMessageContentIntent: DiscordMessageContentIntentEnsurer
  /** Applies an Agent icon and description to the Discord bot/application profile.
   *  Cosmetic and best-effort: install/icon updates survive a sync failure. */
  syncDiscordBotProfile?: DiscordBotProfileSyncer
  /** Validates a pasted Feishu appId + appSecret via the tenant-access-token exchange
   *  (and derives the bot name from `bot/v3/info` when the install omits one).
   *  Optional/injectable so tests stay offline (absent ⇒ no validation, route falls
   *  back to the agent name). */
  verifyFeishuBot?: FeishuBotVerifier
  /** Applies the sensitive delivery URL and verification keys that the official
   *  one-click registration deeplink intentionally cannot carry. */
  configureFeishuHttpApp: FeishuHttpAppConfigurator
  /** Applies an Agent icon to a self-built Feishu/Lark app and submits the
   *  updated application version. Cosmetic and best-effort. */
  syncFeishuAppIcon?: FeishuAppIconSyncer
  /** Owns the short-lived official Feishu/Lark device-registration poll. The
   *  browser sees only a deeplink + opaque id; credentials are finalized through
   *  BotSecretStore before the session becomes completed. */
  feishuAppRegistration: FeishuAppRegistrationService
  /** github-app workspaces façade; absent ⇒ feature disabled (GITHUB_APP_* unset) and
   *  every github route 404s. */
  github?: GithubService
  /** Per-user repo authorization (identity assertion, open question #7); absent ⇒ the
   *  org-level model (installation coverage only) and the permission route 404s. */
  githubUserAuthz?: GithubUserAuthzService
  /** Server-side Logto identity management for the signed-in user's Profile.
   *  Absent ⇒ LOGTO_MGMT_* or real OIDC auth is not configured. */
  logtoIdentity?: LogtoIdentityService
  /** Uploaded-icon object store (docs/designs/icon-uploads.md); absent ⇒ S3_* unset,
   *  the icon upload/delete routes are not mounted and the console hides Upload. */
  iconStore?: IconStore
  /** open-connector integration client (docs: connectors); absent ⇒ OPEN_CONNECTOR_URL
   *  unset, the connectors routes 404 and the console hides "Add connectors". */
  connectors?: ConnectorsClient
  /** Platform-published (distributed) Slack app credentials (preset-agents.md §5.3);
   *  absent ⇒ SLACK_PLATFORM_* unset, the install routes 404 and the console hides
   *  "Add to Slack". Secret material — NEVER log or DTO. */
  slackPlatformApp?: SlackPlatformAppConfig
  config: HttpServerConfig
}
