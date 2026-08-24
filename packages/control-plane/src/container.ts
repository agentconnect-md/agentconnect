/**
 * `container.ts` — the composition root (design §2.4).
 *
 * Manual DI, no framework: `buildContainer(config, clock, secretsProvider)`
 * constructs the whole graph bottom-up — repos → services (C3/C4/C5) → the two
 * edges (C2 HTTP, daemon WS) — and returns the wired pieces `app.ts` exposes.
 * Explicit wiring keeps the eventual Go-split boundary visible and every arg
 * swappable for a fake (the test harnesses in `test/fakes/*` assemble the SAME
 * graph with the `Prisma`/`Clock`/`Transport`/`SecretsProvider` seams faked).
 *
 * This is the ONLY place outside `persistence/` aware of the concrete repo
 * classes; services and edges below it see only ports.
 */
import type { FastifyInstance, FastifyServerOptions } from 'fastify'
import type { PrismaClient } from './generated/prisma/client.js'
import type { WebSocketServer } from 'ws'
import {
  DUTY_GRANT_MEMBERS_MAX,
  HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED,
  WORKSPACE_SESSION_READ_FEATURE
} from '@agentconnect.md/protocol'

import { type AppConfig, resolveWebAppUrl } from './config/env.js'
import { resolveGithubAppConfig } from './github/config.js'
import { resolveGitlabAppConfig } from './gitlab/config.js'
import { GitlabApiClient, type FetchLike as GitlabFetchLike } from './gitlab/api.js'
import { GitlabOauthService } from './gitlab/oauth.service.js'
import { DELETION_PENDING_REASON, GitlabAccountService } from './gitlab/account.service.js'
import { GitlabProvisioner } from './gitlab/provisioner.js'
import { GitlabGitcredService } from './gitlab/gitcred.service.js'
import { GitlabCredentialRotator } from './gitlab/rotator.js'
import { GitlabRetirementSweeper } from './gitlab/retirement-sweeper.js'
import { GitlabConvergeSweeper } from './gitlab/converge-sweeper.js'
import { GitlabMembershipAuthzService } from './gitlab/membership-authz.service.js'
import { GitlabHookRerunService } from './gitlab/hook-rerun.service.js'
import { CodeHostReviewBrokerService } from './codehost/review-lease.service.js'
import { unionGitlabWebhookEvents } from './gitlab/webhook-events.js'
import { resolveSlackPlatformAppConfig } from './config/slack-platform.js'
import { resolveFeishuPlatformApps } from './config/feishu-platform.js'
import type { FetchLike } from './github/api.js'
import { ConnectorsClient, parseBlocklist, parseWhitelist } from './connectors/index.js'
import { GithubService } from './github/service.js'
import { GithubInstallationDoorbell } from './github/installation-doorbell.service.js'
import { GithubCommentAuthzService } from './github/comment-authz.service.js'
import { GithubRerequestService } from './github/rerequest.service.js'
import { GithubReviewBrokerService } from './github/review-broker.service.js'
import { PullRequestViewService } from './github/pull-request-view.service.js'
import { SessionPullRequestLinkService } from './github/session-pull-request-link.service.js'
import { GithubRunCoordinator, GithubRunReporter } from './github/run-reporter.js'
import { CodeHostNoteProjectionService } from './codehost/note-projection.service.js'
import { githubProjectionIntent } from './github/projection-intent.js'
import { HookRedeliveryReconciler } from './orchestrator/hookRedeliveryReconciler.js'
import { LogtoIdentityService, resolveLogtoMgmtConfig } from './github/logto-identity.js'
import { GithubUserAuthzService } from './github/user-authz.js'
import { type Clock, systemClock } from './domain/clock.js'
import { K8sHttp } from '@agentconnect.md/k8s-client'
import { ClusterDaemonIdentityService, ClusterWorkloadIdentityService, loadClusterAccess } from './cluster/index.js'

import {
  PgDaemonRepo,
  PgDaemonLifecycleOpRepo,
  PgApiKeyRepo,
  PgOAuthRepo,
  PgRelayRepo,
  PgAgentRepo,
  PgAgentSecretStore,
  PgAgentConfigWriter,
  PgMemoryConnectionWriter,
  PgAssignmentRepo,
  PgSessionRepo,
  PgSessionUsageRepo,
  PgWebchatConversationRepo,
  PgWebchatMcpDelegationRepo,
  PgWebchatMcpAccessGrantRepo,
  PgWebchatMcpOperationRepo,
  PgLaunchRepo,
  PgSecretLeaseRepo,
  PgIntegrationRepo,
  PgIntegrationChannelRepo,
  PgBotRepo,
  PgBotSecretStore,
  PgBotCredentialWriter,
  PgMcpProviderRepo,
  PgMcpProviderSecretStore,
  PgMcpGrantRepo,
  PgSkillSourceRepo,
  PgOrganizationKnowledgeRepo,
  PgOrganizationEnvironmentRepo,
  PgOrganizationEnvironmentResolver,
  PgOrganizationEnvironmentSecretStore,
  PgMemoryPluginInstallationRepo,
  PgExternalMemoryConnectionRepo,
  PgExternalMemoryConnectionSecretStore,
  PgExternalMemoryGrantRepo,
  PgThreadAffinityStore,
  PgSlackInstallStore,
  PgSlackPlatformInstallStore,
  PgFeishuAppRegistrationStore,
  PgSlackUserConfigStore,
  PgPresetAgentStore,
  PresetAgentBackfill,
  PgGithubInstallationRepo,
  PgGithubInstallStateStore,
  PgAgentRepoAuthorizationRepo,
  PgCodeHostRepositoryRepo,
  PgCodeHostRunProjectionRepo,
  PgGitlabConnectionRepo,
  PgGitlabAgentAccountRepo,
  PgGitlabProjectBindingRepo,
  PgGitlabConnectionSecretStore,
  PgGitlabProjectCredentialRepo,
  PgGitlabProjectCredentialSecretStore,
  PgGitlabWebhookSecretStore,
  PgGitlabInstanceStateStore,
  PgGitlabOauthStateStore,
  PgCodeHostReviewLeaseRepo,
  PgSocialIdentityMutationGate,
  PgCronRepo,
  PgDutyGroupRepo,
  PgMemberSetRepo,
  PgHookRepo,
  PgHookSecretStore,
  PgRuntimeProfileRepo,
  PgAuditRepo,
  PgUserRepo,
  PgOrgRepo,
  PgOrgInviteLinkRepo,
  PgWaitlistRepo
} from './persistence/index.js'
import type { PresetPoolPlacement } from './persistence/index.js'

import { EpochService } from './orchestrator/epoch.js'
import { ControlSender, NoConnection } from './orchestrator/outbound.js'
import { SessionVisibilityPushService } from './orchestrator/visibilityPush.js'
import { AgentSpecAssembler } from './orchestrator/agentSpecAssembler.js'
import { Placement } from './orchestrator/placement.js'
import { Watchdog } from './orchestrator/watchdog.js'
import { CronRunReaper } from './orchestrator/cronRunReaper.js'
import {
  PoolMemberReaper,
  POOL_MEMBER_REAP_AFTER_MS,
  POOL_MEMBER_REAP_INTERVAL_MS
} from './orchestrator/poolMemberReaper.js'
import { RelaySweeper } from './orchestrator/relaySweeper.js'
import { RelayRoster } from './orchestrator/relayRoster.js'
import { WebchatMcpOperationReaper } from './orchestrator/webchatMcpOperationReaper.js'
import { HttpBotOrchestrator } from './orchestrator/httpBot.js'
import { gatedDmSeeds, type GatedDmSeedResolver } from './orchestrator/linkedDm.js'
import { convergeIntegrationGating } from './orchestrator/integrationPush.js'
import { SlackBotIdentityReconciler } from './orchestrator/slackBotIdentityReconciler.js'
import { slackConfigApi } from './http/slack-config-api.js'
import { findTool } from './http/mcp/tools.js'

import { ApiKeyCodec } from './registry/apiKey.js'
import { DaemonAuthService } from './registry/authService.js'
import { ApiKeyService } from './registry/apiKeyService.js'
import { OAuthService } from './registry/oauthService.js'
import { WebchatTokenService } from './registry/webchatToken.js'
import { createWebchatTokenVerifier } from './registry/webchatVerification.js'
import { WebchatRemoteMcpService } from './registry/webchatRemoteMcpService.js'
import { WebchatMcpGrantTokenCodec } from './registry/webchatMcpGrantToken.js'
import { OrgInviteLinkCodec } from './registry/orgInviteLink.js'
import { OrgInviteLinkService } from './registry/orgInviteLinkService.js'
import { WaitlistService } from './registry/waitlistService.js'
import { AgentId, DaemonId, HookId, OrgId } from './domain/ids.js'
import { HookService } from './hooks/hook.service.js'
import { RelayAuthService } from './registry/relayAuthService.js'
import { DaemonRegistryService } from './registry/registryService.js'
import { DaemonReleaseResolver } from './registry/daemonRelease.js'

import { InMemorySessionEventSink } from './events/sink.js'
import { SessionUsageWriter } from './usage/writer.js'
import { createIconStore } from './icons/icon-store.js'
import { createGitlabAccountAvatarRenderer } from './http/gitlab-account-avatar.js'
import type { IconUrlBases } from './agents/agent-icon.js'

import type { SecretsProvider } from './secrets/providers/provider.js'
import { makeSecretsProvider } from './secrets/providers/memory.js'
import { SecretsBrokerService } from './secrets/secretsBroker.js'
import { makeSecretCipher, type SecretCipher } from './secrets/cipher.js'
import { effectiveOrgKeyPrefix } from './secrets/scope.js'
import type { DeploymentConfigRuntime } from './persistence/deployment-config.js'

import { ConnectionRegistry } from './ws/registry.js'
import { RelayRegistry } from './ws/relay-registry.js'
import { RelayControlSender } from './orchestrator/relayControl.js'
import { replayMcpTo } from './orchestrator/mcpReplay.js'
import { replayMemoryConnectionsTo, syncMemoryConnectionsToDaemons } from './orchestrator/memoryConnectionReplay.js'
import { relayHttpOrigin } from './orchestrator/mcpProvider.js'
import { CollabRoutesService } from './orchestrator/collabRoutes.service.js'
import { DutyLeaseService, DUTY_LEASE_DEFAULTS } from './orchestrator/dutyLease.js'
import { registerPoolMetrics } from './observability/pool-metrics.js'
import { registerOrgMetrics } from './observability/org-metrics.js'
import { AgentDelivery } from './orchestrator/agentDelivery.js'
import { AgentRoutingConverger } from './orchestrator/agentRouting.js'
import { PlacementResolver, type ResolvableAgent } from './orchestrator/placementResolver.js'
import { DutyRecomputeSweep } from './orchestrator/dutyRecompute.js'
import { AgentMutationGate } from './orchestrator/agentMutationGate.js'
import { AgentMoveService } from './orchestrator/agentMove.js'
import { createDaemonWsServer } from './ws/gateway.js'
import type { DaemonWsServerDeps } from './ws/gateway.js'
import { createRelayWsServer } from './ws/relay-gateway.js'
import type { RelayWsServerDeps } from './ws/relay-gateway.js'

import { buildHttpServer } from './http/server.js'
import type { HttpDeps } from './http/deps.js'
import { createReadiness, type Readiness } from './http/readiness.js'
import { retirePoolMember } from './http/daemon-removal.js'
import { McpRateLimiter } from './http/mcp/rate-limit.js'
import { RemoteGrantAuthenticator } from './http/mcp/remote-grant-authenticator.js'
import { InternalInvocationAuth } from './http/mcp/internal-invocation-auth.js'
import { webchatMcpDescriptorUrl } from './http/oauth/base.js'
import { defaultWebchatMcpMetrics } from './observability/webchat-mcp.js'
import { pingDb } from './persistence/prisma.js'
import { runWithSharedTx, withSharedTxRouting } from './persistence/ambient-tx.js'
import { verifySlackBot, verifySlackAppToken } from './http/slack-identity.js'
import { verifyTelegramBot } from './http/telegram-identity.js'
import { searchSkillRegistry } from './http/skills-registry.js'
import { createPublicRepoResolver } from './github/public-repo.js'
import { createTelegramBotIconSyncer } from './http/telegram-bot-profile.js'
import { ensureDiscordMessageContentIntent, verifyDiscordBot } from './http/discord-identity.js'
import { createDiscordBotProfileSyncer } from './http/discord-bot-profile.js'
import type { CpPlatformRegistry } from './platforms/provider.js'
import { buildCpPlatformRegistry } from './platforms/registry.js'
import { botIdentityProjector } from './platforms/bot-identity.js'
import { buildPendingInstallReapers, platformBackgroundLoops } from './platforms/lifecycle.js'
import { createTelegramCpProvider } from './platforms/telegram/provider.js'
import { createDiscordCpProvider } from './platforms/discord/provider.js'
import { createSlackCpProvider, createSlackToolingCredentials } from './platforms/slack/provider.js'
import { createFeishuCpProvider } from './platforms/feishu/provider.js'
import { slackInstallRoutes, slackConfigRoutes, slackOauthCallbackRoutes } from './http/routes/slack-install.js'
import { slackPlatformInstallRoutes, slackPlatformCallbackRoutes } from './http/routes/slack-platform-install.js'
import { feishuRegistrationRoutes } from './http/routes/feishu-registration.js'
import { slackBotRefreshRoutes } from './http/routes/slack-bot-refresh.js'
import { telegramCheckRoutes } from './http/routes/telegram-check.js'
import type { FeishuRouteSeams, SlackRouteSeams, TelegramRouteSeams } from './http/platform-route-seams.js'
import { createFeishuAppTenantGuard, verifyFeishuBot } from './http/feishu-identity.js'
import { createFeishuAppIconSyncer } from './http/feishu-app-icon.js'
import { FeishuAppRegistrationService } from './http/feishu-registration.js'
import { configureFeishuHttpApp } from './http/feishu-app-config.js'
import { SlackSessionAccessService } from './http/slack-session-access.js'
import { GithubSessionAccessService } from './http/github-session-access.js'
import { FeishuSessionAccessService } from './http/feishu-session-access.js'
import { SessionAccessWarmer } from './http/session-access-warmer.js'
import type { ExternalScopeRecord } from './persistence/ports.js'

import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from './config/defaults.js'

/** The wired application graph returned by the composition root. */
export interface Container {
  /** The C2 BFF Fastify instance (also hosts `/health`). */
  http: FastifyInstance
  /** Mount the daemon WS gateway on the live `http.Server` (call after `listen`). */
  wsGateway(app: FastifyInstance): WebSocketServer
  /** Mount the relay control WS gateway (`rc/*`) on the live `http.Server` (call after `listen`). */
  relayGateway(app: FastifyInstance): WebSocketServer
  /** The single-tenant anchors the devAuth stub injects. */
  readonly defaults: { orgId: string; ownerId: string }
  /** §9 platform-provider registry (S3) — all four platforms (Telegram,
   *  Discord, Slack, Feishu). Composed here so the graph is whole, and now the
   *  authority for route mounting, the create body + its live credential check,
   *  the pending-install reapers and the background convergence loops. Spec
   *  assembly and `rc/bot-assign` adopt it in a follow-up PR. */
  readonly platforms: CpPlatformRegistry
  /** The process readiness gate — the bootstrap flips it at SIGTERM (`/readyz`). */
  readonly readiness: Readiness
  /** Live webchat preset entitlement + one-time assertion minting. Transport
   *  handlers consume this seam without reconstructing authority checks. */
  readonly webchatRemoteMcp: WebchatRemoteMcpService
  /** Route-only remote-grant claim seam for the standard MCP route. */
  readonly remoteGrantAuth: RemoteGrantAuthenticator
  /** One-time async-local nonce seam for nested MCP REST requests. */
  readonly internalInvocationAuth: InternalInvocationAuth
  /** Arm the Clock-driven background loops (the cron-run reaper). Prod calls this
   *  after `listen`; tests never do, so no live timer arms under a `FakeClock`. */
  startBackground(): void
  /** Graceful teardown: stop background loops, disconnect Prisma. */
  shutdown(): Promise<void>
}

/** Extra knobs the composition root accepts (mostly for tests). */
export interface ContainerOpts {
  /** Fastify server options for the HTTP edge (e.g. `{ logger: true }`). */
  fastify?: FastifyServerOptions
  /** GitHub REST fetch override — integration tests stub the API without network. */
  githubFetch?: FetchLike
  /** GitLab HTTP edge stub for tests (mirrors githubFetch). */
  gitlabFetch?: GitlabFetchLike
  /** Slack Web API fetch override for Session membership checks. */
  slackFetch?: FetchLike
  /** Feishu/Lark Open Platform fetch override for Session membership checks. */
  feishuFetch?: FetchLike
  /** npm dist-tags fetch override for the daemon "latest version" resolver — tests
   *  stub it (absent under NODE_ENV=test ⇒ the resolver is inert, no network). */
  daemonReleaseFetch?: FetchLike
  /** open-connector admin API fetch override — integration tests stub it without
   *  network (absent under NODE_ENV=test ⇒ the connectors client is not assembled). */
  connectorsFetch?: FetchLike
  /** The at-rest transform every persisted secret VALUE passes through. Absent ⇒
   *  selected from `config.SECRET_CIPHER` (none → identity, vault-transit → Vault). */
  secretCipher?: SecretCipher
  /** Immutable DB-backed desired state loaded by the process bootstrap. */
  deploymentConfig?: DeploymentConfigRuntime
}

/**
 * Assemble the graph from an explicit `PrismaClient` (the only Prisma touch in
 * the app is the repo classes here), a `Clock`, and a `SecretsProvider`.
 */
export function buildContainer(
  config: AppConfig,
  prisma: PrismaClient,
  clock: Clock = systemClock,
  secretsProvider: SecretsProvider = makeSecretsProvider(config),
  opts: ContainerOpts = {}
): Container {
  // The ONE cipher every secret store seals/opens through — the SECRET_CIPHER
  // config flips at-rest encryption for all of them together.
  const secretCipher = opts.secretCipher ?? makeSecretCipher(config)

  // Repositories see the shared-transaction router: outside `runWithSharedTx`
  // it is the root client verbatim; inside it (CP-db-only delegated MCP
  // operations, §8) every repo call joins one transaction. Transaction OPENING
  // (and ping/disconnect) stays on the root client.
  const rootPrisma = prisma
  prisma = withSharedTxRouting(prisma)

  // The single value-reading seam for organization secrets. Named before the repo
  // map because both the registry repo's resolver and the assembler share ONE
  // instance — and therefore the one configured cipher.
  const organizationEnvironmentSecrets = new PgOrganizationEnvironmentSecretStore(prisma, secretCipher)

  // LATE-BOUND platform registry (§9). The providers are constructed FAR below —
  // they close over `httpDeps`, whose own route plugins do not exist yet — but
  // holders built here (the bot repo's D6 identity projection, the orchestrators'
  // spec assembly and `rc/bot-assign`) already need to reach them. `platforms` is
  // a stable façade every holder can capture now; it forwards to the composed
  // registry, and every read runs at write / reconcile / sync / request time,
  // long after `buildContainer` has assigned it.
  let composedPlatforms: CpPlatformRegistry | undefined = undefined
  const requirePlatforms = (): CpPlatformRegistry => {
    if (!composedPlatforms) throw new Error('platform registry read before composition')
    return composedPlatforms
  }
  const platforms: CpPlatformRegistry = {
    get: (platformId) => requirePlatforms().get(platformId),
    all: () => requirePlatforms().all(),
    ids: () => requirePlatforms().ids()
  }

  // Pool-born preset agents (preset-agents.md §3.2): on an install with a daemon
  // pool, a new org's preset is placed on it at creation with the pool's runtime.
  // An empty runtime is the opt-out, and an install with no pool member ignores it.
  const presetPool: PresetPoolPlacement | null =
    config.PRESET_AGENTS_ENABLED && config.PRESET_AGENT_POOL_RUNTIME
      ? {
          runtime: config.PRESET_AGENT_POOL_RUNTIME,
          ...(config.PRESET_AGENT_POOL_MODEL ? { model: config.PRESET_AGENT_POOL_MODEL } : {})
        }
      : null

  // ── C6 repositories (the ONLY @prisma/client importers) ───────────────────
  const repos = {
    daemon: new PgDaemonRepo(prisma),
    daemonLifecycleOp: new PgDaemonLifecycleOpRepo(prisma),
    apiKey: new PgApiKeyRepo(prisma),
    oauth: new PgOAuthRepo(prisma),
    relay: new PgRelayRepo(prisma),
    agent: new PgAgentRepo(prisma),
    assignment: new PgAssignmentRepo(prisma),
    session: new PgSessionRepo(prisma),
    sessionUsage: new PgSessionUsageRepo(prisma),
    webchatConversation: new PgWebchatConversationRepo(prisma),
    webchatMcpDelegation: new PgWebchatMcpDelegationRepo(prisma, defaultWebchatMcpMetrics),
    webchatMcpAccessGrant: new PgWebchatMcpAccessGrantRepo(prisma),
    webchatMcpOperation: new PgWebchatMcpOperationRepo(prisma),
    launch: new PgLaunchRepo(prisma),
    lease: new PgSecretLeaseRepo(prisma),
    integration: new PgIntegrationRepo(prisma),
    integrationChannel: new PgIntegrationChannelRepo(prisma),
    // §11 D6: which values carry this bot's demux identity is the provider's
    // declaration, read at write time through the façade above.
    bot: new PgBotRepo(prisma, botIdentityProjector(platforms)),
    botSecret: new PgBotSecretStore(prisma, secretCipher),
    // Owns its transaction: install/revoke each write two tables behind the
    // credential-generation fence, and serialize on the bot row (§5.3).
    botCredential: new PgBotCredentialWriter(prisma, secretCipher),
    agentSecret: new PgAgentSecretStore(prisma, secretCipher),
    agentConfig: new PgAgentConfigWriter(prisma, secretCipher),
    mcpProvider: new PgMcpProviderRepo(prisma),
    mcpProviderSecret: new PgMcpProviderSecretStore(prisma, secretCipher),
    mcpGrant: new PgMcpGrantRepo(prisma, secretCipher),
    skillSource: new PgSkillSourceRepo(prisma),
    organizationKnowledge: new PgOrganizationKnowledgeRepo(prisma),
    // Owns its transactions: every organization-environment write runs the design
    // §5 fence (org row → agent rows → re-read → validate → persist + bump
    // configRevision), so it must be the transaction owner, not a composed repo.
    organizationEnvironment: new PgOrganizationEnvironmentRepo(prisma),
    organizationEnvironmentSecret: organizationEnvironmentSecrets,
    organizationEnvironmentResolver: new PgOrganizationEnvironmentResolver(prisma, organizationEnvironmentSecrets),
    memoryPluginInstallation: new PgMemoryPluginInstallationRepo(prisma),
    externalMemoryConnection: new PgExternalMemoryConnectionRepo(prisma),
    externalMemoryConnectionSecret: new PgExternalMemoryConnectionSecretStore(prisma, secretCipher),
    externalMemoryGrant: new PgExternalMemoryGrantRepo(prisma, secretCipher),
    // Owns its transactions: every external-memory check-then-write pair runs
    // under the advisory mutation scopes, so it stays serialized across CP
    // instances (rolling updates included).
    memoryConnectionWriter: new PgMemoryConnectionWriter(prisma, secretCipher),
    threadAffinity: new PgThreadAffinityStore(prisma),
    slackInstall: new PgSlackInstallStore(prisma, secretCipher),
    slackPlatformInstall: new PgSlackPlatformInstallStore(prisma),
    feishuAppRegistration: new PgFeishuAppRegistrationStore(prisma, secretCipher),
    slackUserConfig: new PgSlackUserConfigStore(prisma, secretCipher),
    presetAgent: new PgPresetAgentStore(prisma),
    cron: new PgCronRepo(prisma),
    dutyGroup: new PgDutyGroupRepo(prisma),
    memberSet: new PgMemberSetRepo(prisma),
    // Fenced hook writes ask "may this daemon act for the hook's agent" — placement ∪ live duty
    // holders, which a join on `agent.daemonId` cannot express. Lazy over `placementResolver`
    // (assigned below; only ever called at report time).
    hook: new PgHookRepo(prisma, {
      servingDaemons: (agent: ResolvableAgent): Promise<string[]> => placementResolver.servingDaemons(agent),
      routableDaemon: (agent: ResolvableAgent): Promise<DaemonId | null> => placementResolver.routableDaemon(agent)
    }),
    hookSecret: new PgHookSecretStore(prisma, secretCipher),
    runtimeProfile: new PgRuntimeProfileRepo(prisma),
    audit: new PgAuditRepo(prisma),
    // Under WAITLIST_MODE, JIT signup does NOT mint a personal org — that happens
    // only on join-link redemption (waitlist-and-login.md §6/§8), so "login ⇒ has
    // an org" can't bypass the admission gate. Every org-creating repo carries the
    // preset-agent seam flag (preset-agents.md §3.2).
    user: new PgUserRepo(prisma, !config.WAITLIST_MODE, config.PRESET_AGENTS_ENABLED, presetPool),
    org: new PgOrgRepo(prisma, config.PRESET_AGENTS_ENABLED, presetPool, (orgId) => ({
      mount: config.VAULT_TRANSIT_MOUNT,
      keyName: `${effectiveOrgKeyPrefix(config.VAULT_TRANSIT_KEY, config.VAULT_TRANSIT_ORG_KEY_PREFIX)}${orgId}`
    })),
    orgInviteLink: new PgOrgInviteLinkRepo(prisma),
    waitlist: new PgWaitlistRepo(prisma, config.PRESET_AGENTS_ENABLED, presetPool),
    githubInstallation: new PgGithubInstallationRepo(prisma),
    githubInstallState: new PgGithubInstallStateStore(prisma),
    agentRepoAuth: new PgAgentRepoAuthorizationRepo(prisma),
    codeHostRepository: new PgCodeHostRepositoryRepo(prisma),
    gitlabConnection: new PgGitlabConnectionRepo(prisma),
    gitlabProjectBinding: new PgGitlabProjectBindingRepo(prisma),
    gitlabAgentAccount: new PgGitlabAgentAccountRepo(prisma),
    gitlabOauthState: new PgGitlabOauthStateStore(prisma),
    gitlabInstanceState: new PgGitlabInstanceStateStore(prisma)
  }

  // ── C3/C4/C5 services ─────────────────────────────────────────────────────
  const epoch = new EpochService(repos.daemon, clock)

  const codec = new ApiKeyCodec({ API_KEY_PEPPER: config.API_KEY_PEPPER })
  const webAppUrl = resolveWebAppUrl(config)
  // In-cluster Kubernetes access: assembled ONLY when the daemon pool is enabled. Hoisted
  // above the auth service because an in-cluster daemon authenticates against this client.
  const clusterAccess = loadClusterAccess(config)
  const clusterHttp = clusterAccess ? new K8sHttp(clusterAccess) : undefined
  // The in-cluster daemon's token path; undefined ⇒ this deployment only accepts API keys.
  // Shared by both doors a daemon can knock on — the CP socket and, through `rc/verify`,
  // the relay — so the relay hop can never be the weaker one.
  const clusterIdentity =
    clusterAccess && clusterHttp
      ? new ClusterDaemonIdentityService(clusterHttp, repos.daemon, clusterAccess.namespace)
      : undefined
  // The same review for workloads that are NOT daemons — today the usage collector.
  // Undefined ⇒ those callers fall back to their own shared secret, or do not exist.
  const clusterWorkloadIdentity =
    clusterAccess && clusterHttp ? new ClusterWorkloadIdentityService(clusterHttp, clusterAccess.namespace) : undefined
  const auth = new DaemonAuthService(
    codec,
    repos.apiKey,
    epoch,
    clock,
    {
      HEARTBEAT_SEC: config.HEARTBEAT_SEC,
      // Single-sourced from the lease service's own horizon: the daemon derives its duty
      // self-fence from this, so the two halves of `T_reassign > T_fence` cannot drift.
      DUTY_LEASE_MS: DUTY_LEASE_DEFAULTS.leaseMs,
      // Web console origin for daemon-built session deep links: explicit PUBLIC_WEB_URL, else
      // a concrete CORS_ORIGIN (the browser console origin a two-origin deploy already lists),
      // else PUBLIC_CP_URL for single-origin deploys. All unset ⇒ no webAppUrl sent (daemon
      // uses its own config). See resolveWebAppUrl.
      WEB_APP_URL: webAppUrl
    },
    // Resolves the daemon's org slug for the org-scoped deep link (`…/<orgSlug>/sessions/…`).
    repos.org,
    // The set `auth/ok` announces — the daemon's duty-enforcement predicate (daemon-groups.md §3).
    repos.memberSet,
    clusterIdentity
  )
  const apiKeys = new ApiKeyService(codec, repos.apiKey, repos.daemon, repos.audit, clock)
  const oauth = new OAuthService(repos.oauth, apiKeys, codec, clock)
  const inviteLinks = new OrgInviteLinkService(
    new OrgInviteLinkCodec(config.API_KEY_PEPPER),
    repos.orgInviteLink,
    clock
  )
  // Closed-beta admission (waitlist-and-login.md). The join-token codec shares the
  // API_KEY_PEPPER (its own domain-separated HMAC) — the external admin app injects
  // the SAME pepper to mint links the CP can verify (§6).
  const waitlist = new WaitlistService(config.API_KEY_PEPPER, repos.waitlist, clock)

  // Relay↔CP `rc/auth` dual-mode verifier (§8): shared RELAY_TOKEN and/or per-relay
  // ApiKey. RELAY_TOKEN unset ⇒ token mode is off; org-less relay keys reuse the
  // pepper-hash mechanism (no epoch — relays carry no fencing state).
  const relayAuth = new RelayAuthService(
    codec,
    repos.apiKey,
    clock,
    {
      ...(config.RELAY_TOKEN ? { RELAY_TOKEN: config.RELAY_TOKEN } : {}),
      HEARTBEAT_SEC: config.HEARTBEAT_SEC
    },
    clusterIdentity
  )
  const relayStaleMs = config.RELAY_STALE_SEC * 1000

  // Uploaded-icon object store (docs/designs/icon-uploads.md): a neutral S3-compatible
  // target. Assembled ONLY when the FULL S3_* group is
  // present; any missing ⇒ undefined, so the upload routes aren't mounted and the console
  // hides Upload (icons stay glyph-only). This is deliberately forgiving, not fail-fast:
  // secret keys (access key id / secret) may roll out independently from non-secret
  // config, so a partial group leaves the feature off rather
  // than crash-looping the CP.
  const iconStore =
    config.S3_ENDPOINT &&
    config.S3_ACCESS_KEY_ID &&
    config.S3_SECRET_ACCESS_KEY &&
    config.S3_BUCKET &&
    config.S3_PUBLIC_BASE_URL
      ? createIconStore({
          endpoint: config.S3_ENDPOINT,
          accessKeyId: config.S3_ACCESS_KEY_ID,
          secretAccessKey: config.S3_SECRET_ACCESS_KEY,
          bucket: config.S3_BUCKET,
          region: config.S3_REGION,
          publicBaseUrl: config.S3_PUBLIC_BASE_URL
        })
      : undefined
  // Bases the reconcile roster + DTOs resolve avatar URLs against: `cp` for the
  // glyph/runtime PNG endpoint, `store` for uploaded `image` icons.
  const iconBases: IconUrlBases = {
    ...(config.PUBLIC_CP_URL ? { cp: config.PUBLIC_CP_URL } : {}),
    ...(config.S3_PUBLIC_BASE_URL ? { store: config.S3_PUBLIC_BASE_URL } : {})
  }

  // GitLab OAuth app config, resolved before the spec assembler because the host axis
  // rides every projected spec with a GitLab consumer (§24.4); absent ⇒ gitlab disabled.
  const gitlabAppCfg = resolveGitlabAppConfig(config)

  // The ONE assembler of CP→daemon AgentSpecs — owns secret loading (the only
  // AgentSecretStore VALUE reader) + icon bases, shared by every emission path:
  // reconcile roster, agent/upsert replicate, icon refresh, move activation.
  const agentSpecs = new AgentSpecAssembler(
    repos.agentSecret,
    iconBases,
    repos.skillSource,
    repos.organizationKnowledge,
    (agentId, invalid) =>
      http.log.warn(
        {
          agentId,
          skillSourceId: invalid.sourceId,
          skillSourceName: invalid.sourceName,
          issues: invalid.issues
        },
        'omitting an invalid historical skill source from the daemon projection'
      ),
    repos.organizationEnvironmentResolver,
    // Key names only — a tombstone means the key left BOTH wire maps, which also
    // suppresses any same-key agent fallback (organization-secrets-and-variables.md §9).
    (agentId, keys) =>
      http.log.error(
        { agentId, keys },
        'organization environment keys resolved to nothing and were removed from the agent projection'
      ),
    // The additional-repository allowlist the workspace projection mirrors.
    repos.agentRepoAuth,
    // §24.4 host carriage: the axis, and the hook read that reveals the one GitLab
    // consumer neither the workspace nor the allowlist does.
    gitlabAppCfg?.baseUrl,
    repos.hook
  )

  // Browser webchat token mint/verify (§10, A4): a short-lived HS256 JWT bound to
  // {userId, user, agentId, orgId, conversationId}. The relay delegates verification
  // here via rc/verify(webchat-token); the CP re-resolves the agent's CURRENT placement.
  const webchatTokens = new WebchatTokenService(config.API_KEY_PEPPER)

  const registry = new DaemonRegistryService(repos.daemon, repos.runtimeProfile, repos.daemonLifecycleOp, clock)
  // Resolves the latest daemon version in the deployment's npm channel (the pinned
  // `DAEMON_DIST_TAG`, default `latest`) for the console's "update available" hint.
  // Inert under NODE_ENV=test unless a fetch is injected, so suites stay offline.
  const daemonReleaseFetch = opts.daemonReleaseFetch ?? (config.NODE_ENV === 'test' ? undefined : globalThis.fetch)
  const daemonRelease = daemonReleaseFetch
    ? new DaemonReleaseResolver(config.DAEMON_DIST_TAG || 'latest', clock, daemonReleaseFetch)
    : undefined

  // open-connector integration (docs: connectors). Assembled only when the URL is
  // configured AND a fetch is available (inert under NODE_ENV=test unless injected,
  // so suites stay offline). Absent ⇒ the connectors routes 404.
  const connectorsFetch = opts.connectorsFetch ?? (config.NODE_ENV === 'test' ? undefined : globalThis.fetch)
  const connectors =
    config.OPEN_CONNECTOR_URL && connectorsFetch
      ? new ConnectorsClient({
          baseUrl: config.OPEN_CONNECTOR_URL,
          fetch: connectorsFetch,
          whitelist: parseWhitelist(config.OPEN_CONNECTOR_PROVIDER_WHITELIST),
          blocklist: parseBlocklist(config.OPEN_CONNECTOR_PROVIDER_BLOCKLIST)
        })
      : undefined

  const events = new InMemorySessionEventSink()

  // ONE usage report interface for both authenticated ingresses (the daemon EVT and
  // the service batch endpoint), so neither can drift into its own storage semantics.
  const usageWriter = new SessionUsageWriter(repos.sessionUsage)

  // C5 lease broker (ref-only, no plaintext).
  const secrets = new SecretsBrokerService(secretsProvider, repos.lease, clock)
  void secrets // wired into the WS secrets handler in a later phase; constructed now so the graph is whole.

  // The derived in-memory connection index every hot lookup hits.
  const connReg = new ConnectionRegistry()

  // The ONE answer to "which daemons serve this agent" — what its placement names, plus every
  // current duty holder (orchestrator/placementResolver.ts).
  const placementResolver = new PlacementResolver({
    duties: repos.dutyGroup,
    // The set's members ready to take a trigger. Only the rendezvous fallback reads this: a set
    // agent whose lease lapsed has no holder, and any member can claim it on receipt.
    liveMembers: async (setId) => {
      const members = new Set(await repos.memberSet.memberIdsOf(setId))
      return connReg
        .reachableDaemons()
        .filter((d) => d.state === 'READY' && members.has(d.daemonId))
        .map((d) => d.daemonId)
    },
    clock
  })

  // Built-in general-preset webchat entitlement and short-lived access grants.
  const webchatMcpGrantToken = new WebchatMcpGrantTokenCodec(config.API_KEY_PEPPER)
  const webchatRemoteMcp = new WebchatRemoteMcpService({
    clock,
    tokenCodec: webchatMcpGrantToken,
    conversations: repos.webchatConversation,
    orgs: repos.org,
    agents: repos.agent,
    presets: repos.presetAgent,
    daemons: connReg,
    placement: placementResolver,
    authorities: repos.webchatMcpDelegation,
    grants: repos.webchatMcpAccessGrant,
    // The daemon installs this verbatim into the adapter's `agentconnect-admin`
    // descriptor: the canonical PUBLIC resource URL, never the internal `/api/v1` mount.
    mcpUrl: webchatMcpDescriptorUrl(config)
  })
  const remoteGrantAuth = new RemoteGrantAuthenticator({
    clock,
    tokenCodec: webchatMcpGrantToken,
    conversations: repos.webchatConversation,
    orgs: repos.org,
    agents: repos.agent,
    presets: repos.presetAgent,
    daemons: connReg,
    placement: placementResolver,
    grants: repos.webchatMcpAccessGrant,
    authorities: repos.webchatMcpDelegation,
    sessions: repos.session,
    isCuratedTool: (toolName) => findTool(toolName) !== undefined
  })
  const internalInvocationAuth = new InternalInvocationAuth()

  // The relay analogue — relayId → live relay socket, so the CP can push
  // rc/daemon-revoke to connected relays (§9). Roster still comes from the DB.
  const relayReg = new RelayRegistry()
  const relayControl = new RelayControlSender(relayReg)

  // github-app config resolved early: the hook compiler stamps the App broadcast
  // slug beside each agent's targeted slug, the GithubService comes later.
  const githubAppCfg = resolveGithubAppConfig(config)

  // Platform-published Slack app (preset-agents.md §5.3) — undefined ⇒ feature
  // absent (routes 404, console hides "Add to Slack"); partial set ⇒ fail-fast.
  const slackPlatformApp = resolveSlackPlatformAppConfig(config)

  // Regional Login Apps mirrored from Logto. Their credentials are the stable
  // deployment tenant anchor used to admit Bot Apps from the same organization.
  const feishuPlatformApps = resolveFeishuPlatformApps(config)

  // Hook compiler/converger (webhook-triggers-and-github-events.md): CRUD routes
  // broadcast through it, and a (re)registering relay gets the full-set replay.
  // The installation repo feeds the github-kind compile (installationIds gate).
  // §24.1: the resolved instance base, bound once here. Every GitLab URL in the
  // process is composed from this client, so nothing can address another host.
  const gitlabApi = gitlabAppCfg ? new GitlabApiClient(gitlabAppCfg.baseUrl, opts.gitlabFetch) : undefined
  const gitlabWebhookSecretStore = gitlabAppCfg ? new PgGitlabWebhookSecretStore(prisma, secretCipher) : undefined
  const hookService = new HookService(
    repos.hook,
    repos.hookSecret,
    repos.agent,
    relayControl,
    placementResolver,
    githubAppCfg ? repos.githubInstallation : undefined,
    githubAppCfg?.slug,
    undefined,
    gitlabAppCfg ? repos.gitlabProjectBinding : undefined,
    gitlabWebhookSecretStore,
    gitlabAppCfg ? repos.gitlabAgentAccount : undefined,
    gitlabAppCfg?.baseUrl,
    async (daemonId) => (await registry.getUnscoped(DaemonId(daemonId)))?.capabilities.features
  )

  // The single fencing site (allocates seq, stamps epoch/launchId on C→D frames).
  const sender = new ControlSender(connReg, repos.launch)

  // Per-session memory-capture gate convergence (session-visibility.md §5.1):
  // the CP is the authority on effective visibility; daemons only enforce it.
  const visibilityPush = new SessionVisibilityPushService({
    repos: { session: repos.session, agent: repos.agent },
    control: sender,
    connReg,
    placement: placementResolver,
    // The replay's inverse half: a reconnecting member's served set, not the recorded column.
    duties: repos.dutyGroup,
    clock,
    // Lazy over `http.log` (assigned below; only ever called at push time).
    log: { warn: (o, m) => http.log.warn(o, m) }
  })

  // Bot-agnostic collaboration routing snapshot fan-out (agent-collaboration
  // §2.3/§6.2): relays get the all-org table; daemons get their org-scoped copy.
  const collabRoutes = new CollabRoutesService(
    repos.daemon,
    repos.integration,
    repos.agent,
    relayControl,
    sender,
    placementResolver,
    repos.dutyGroup,
    clock
  )

  // The fan-out that rides the resolver (orchestrator/agentDelivery.ts).
  const agentDelivery = new AgentDelivery({
    control: sender,
    specs: agentSpecs,
    placement: placementResolver,
    // §17.3 projection gate: live advertised features; unknown daemon reads fail-closed.
    daemonFeatures: (daemonId) => connReg.get(daemonId)?.capabilities?.features
  })

  // The projections that BAKE IN the serving daemon — hook rules, HTTP-bot assignment, the
  // collaboration snapshot. A duty grant or release moves who serves an agent exactly as a
  // placement move does, so both go through this one fan-out rather than two copies of the list.
  const agentRouting = new AgentRoutingConverger({
    hooks: hookService,
    collabRoutes,
    // Lazy over `httpBot` (assigned below; only ever called at convergence time), the same
    // late-binding the logger wrappers use.
    httpBot: { syncBot: (botId: string) => httpBot.syncBot(botId) },
    agents: repos.agent,
    integrations: repos.integration,
    bots: repos.bot,
    clock,
    delayMs: 250,
    log: { warn: (o, m) => http.log.warn(o, m) }
  })

  // Duty lease exchange riding the heartbeat (k8s daemons; orchestrator/dutyLease.ts).
  // The revision reader stamps each granted agent member with the CP's current
  // spec revision, so a member that already has the agent can tell frozen from current.
  const dutyLease = new DutyLeaseService(
    repos.dutyGroup,
    clock,
    undefined,
    { warn: (o, m) => http.log.warn(o, m) },
    repos.agent,
    agentRouting,
    visibilityPush
  )
  // Duty-group projection: derived from Integration/CronDef rows on a rotation;
  // deltas reach daemons via the heartbeat lease exchange, never from the sweep.
  const dutyRecompute = new DutyRecomputeSweep(
    repos.dutyGroup,
    clock,
    {
      intervalMs: 30_000,
      orgsPerTick: 25,
      leaseMs: DUTY_LEASE_DEFAULTS.leaseMs,
      kickDelayMs: 250
    },
    { warn: (o, m) => http.log.warn(o, m), error: (o, m) => http.log.error(o, m) },
    agentRouting
  )
  // Pool capacity gauges (observability/pool-metrics.ts) — the §12 "alarm on vacant-duty age",
  // reading the same lease horizon and deliverability cap the claim paths gate on.
  const poolMetrics = registerPoolMetrics({
    repo: repos.dutyGroup,
    clock,
    liveMs: DUTY_LEASE_DEFAULTS.leaseMs,
    maxMembers: DUTY_GRANT_MEMBERS_MAX,
    log: { warn: (o, m) => http.log.warn(o, m) }
  })
  // Per-org footprint gauges (observability/org-metrics.ts) — daemons/agents/sessions per org, the
  // "who is using this install, and how much" read the pool gauges deliberately do not answer.
  const orgMetrics = registerOrgMetrics({ repo: repos.org, clock, log: { warn: (o, m) => http.log.warn(o, m) } })
  const agentMutations = new AgentMutationGate()

  // Relay roster (shared-bot-relay.md §5): computed from the durable `relay` table
  // (alive within the failover window), fed into `register/ok.relays` and fanned to
  // daemons on register/sweep via the `relay/roster` EVT (sender is the broadcaster).
  const relayRoster = new RelayRoster(repos.relay, sender, clock, relayStaleMs)

  // §14.8 (resource-visibility.md): which of a gated install's reported DMs open to the
  // ordinary DM default because their counterpart is already in the agent's audience.
  // Lazy over `logtoIdentity` and `http.log` for the same reason as the logger below —
  // both are assigned further down and this only runs at report time.
  const gatedDmSeedResolver: GatedDmSeedResolver = (channels, agent, bot) =>
    gatedDmSeeds(channels, agent, bot, {
      users: repos.user,
      ...(logtoIdentity ? { identity: logtoIdentity } : {}),
      log: { debug: (o, m) => http.log.debug(o, m), warn: (o, m) => http.log.warn(o, m) }
    })

  // HTTP-bot assignment + attributed-route compilation (shared-bot-relay.md §4.2/§10).
  // Its logger is lazy (a wrapper over `http.log`, which is created below) — only ever
  // invoked at request/sweep time, well after `http` is assigned, so no TDZ hazard.
  const httpBot = new HttpBotOrchestrator(
    repos.bot,
    repos.botSecret,
    repos.botCredential,
    repos.integration,
    repos.integrationChannel,
    repos.agent,
    relayReg,
    sender,
    repos.threadAffinity,
    repos.session,
    {
      info: (o, m) => http.log.info(o, m),
      warn: (o, m) => http.log.warn(o, m),
      debug: (o, m) => http.log.debug(o, m)
    },
    platforms,
    agentDelivery,
    placementResolver,
    gatedDmSeedResolver
  )
  const stagedAgentMoves = new AgentMoveService({
    agents: repos.agent,
    assignments: repos.assignment,
    integrations: repos.integration,
    integrationChannels: repos.integrationChannel,
    bots: repos.bot,
    botSecrets: repos.botSecret,
    platforms,
    specs: agentSpecs,
    crons: repos.cron,
    // The `duty/fetch` bundle's MCP + external-memory projections (same seams the
    // reconcile roster below is given, same projector).
    mcp: { providers: repos.mcpProvider, grants: repos.mcpGrant, relayRoster },
    memory: {
      connections: repos.externalMemoryConnection,
      installations: repos.memoryPluginInstallation,
      secrets: repos.externalMemoryConnectionSecret,
      grants: repos.externalMemoryGrant,
      relayRoster
    },
    control: sender,
    hooks: hookService,
    httpBot,
    collabRoutes,
    mutations: agentMutations,
    sessionOwners: connReg,
    placement: placementResolver,
    memberSets: repos.memberSet,
    liveness: connReg,
    recomputeDuties: (orgId: string) => dutyRecompute.kick(orgId),
    log: { warn: (o, m) => http.log.warn(o, m) }
  })

  // C3 orchestrator with the live placement/rebalance surface fully wired.
  const orchestrator = new Placement(
    repos.daemon,
    repos.agent,
    repos.assignment,
    repos.cron,
    repos.lease,
    repos.integration,
    repos.botSecret,
    agentSpecs,
    repos.integrationChannel,
    repos.bot,
    platforms,
    {
      registry: connReg,
      sender,
      epoch,
      clock,
      config: {
        REASSIGN_GRACE_SEC: config.REASSIGN_GRACE_SEC,
        ACK_TIMEOUT_MS: config.ACK_TIMEOUT_MS
      },
      // MCP-proxy reconcile bundle (centralized-tool-management.md §7): the org providers
      // a daemon's agents enabled + their grant keys + the relay roster to proxy through.
      mcp: { providers: repos.mcpProvider, grants: repos.mcpGrant, relayRoster },
      memory: {
        connections: repos.externalMemoryConnection,
        installations: repos.memoryPluginInstallation,
        secrets: repos.externalMemoryConnectionSecret,
        grants: repos.externalMemoryGrant,
        relayRoster
      },
      // The duty half of the reconcile roster: pinned-to-me ∪ held-by-me.
      duties: repos.dutyGroup,
      placement: placementResolver,
      log: { warn: (o, m) => http.log.warn(o, m) } // lazy over http.log (assigned below; called at reconcile time)
    }
  )

  // Watchdog: missed-beats → freeze → reassign-grace → rebalance (Clock-driven).
  const watchdog = new Watchdog(connReg, clock, orchestrator, {
    HEARTBEAT_SEC: config.HEARTBEAT_SEC,
    MISSED_BEATS: config.MISSED_BEATS,
    REASSIGN_GRACE_SEC: config.REASSIGN_GRACE_SEC
  })
  void watchdog // armed by the auth/heartbeat handlers as that wiring lands; constructed now so the graph is whole.

  // ── C2 HTTP edge ──────────────────────────────────────────────────────────
  // Readiness gate: `/readyz` pings the DB and reports 503 once shutdown begins
  // (issue #240). Owned here (has `prisma` for the ping); the bootstrap flips it.
  const readiness = createReadiness(() => pingDb(rootPrisma))
  // Best-effort, but never detached: shutdown must not disconnect Prisma while
  // these projection wakeups are still running.
  const wakeGithubReviewProjections = async (installationId: bigint, orgId: OrgId): Promise<void> => {
    const at = new Date(clock.now())
    const results = await Promise.allSettled([
      repos.hook.wakeReviewProjectionsForInstallation(installationId, at),
      repos.hook.wakeReviewProjectionsForOrg(orgId, at)
    ])
    for (const [scope, result] of [
      ['installation', results[0]],
      ['org', results[1]]
    ] as const) {
      if (result.status === 'rejected') {
        http.log.warn(
          { err: result.reason, installationId: installationId.toString(), orgId, scope },
          'github: review projection wake failed'
        )
      }
    }
  }
  // github-app workspaces (opt-in): assembled only when GITHUB_APP_* is fully
  // configured; absent ⇒ routes 404 and the WS gitcred handler denies.
  const github = githubAppCfg
    ? new GithubService({
        cfg: githubAppCfg,
        clock,
        installations: repos.githubInstallation,
        installState: repos.githubInstallState,
        repoAuths: repos.agentRepoAuth,
        agents: repos.agent,
        onInstallationFactsChanged: wakeGithubReviewProjections,
        pepper: config.API_KEY_PEPPER,
        log: { warn: (message) => http.log.warn(message) },
        ...(opts.githubFetch ? { fetchImpl: opts.githubFetch } : {})
      })
    : undefined
  // GitLab.com OAuth administration (opt-in, gitlab-com-integration.md §9):
  // assembled only when GITLAB_CLIENT_ID/SECRET are configured AND the public
  // origin is known (the begin/callback URLs derive from it); absent ⇒ routes 404.
  if (gitlabAppCfg && !config.PUBLIC_CP_URL) {
    // A deploy mistake, not a mode: the begin/callback URLs derive from the public origin.
    throw new Error('GITLAB_CLIENT_ID/SECRET are set but PUBLIC_CP_URL is not — set it or unset both')
  }
  const gitlabWebAppUrl = resolveWebAppUrl(config)
  const gitlabOauthService =
    gitlabAppCfg && config.PUBLIC_CP_URL
      ? new GitlabOauthService({
          cfg: gitlabAppCfg,
          connections: repos.gitlabConnection,
          secrets: new PgGitlabConnectionSecretStore(prisma, secretCipher),
          states: repos.gitlabOauthState,
          instanceState: repos.gitlabInstanceState,
          cipher: secretCipher,
          clock,
          publicCpUrl: config.PUBLIC_CP_URL,
          ...(gitlabWebAppUrl ? { webAppUrl: gitlabWebAppUrl } : {}),
          api: gitlabApi!,
          log: { warn: (obj, msg) => http.log.warn(obj, msg) }
        })
      : undefined
  // Late-bound, like the other orchestrator refs here: the account service is
  // built before the provisioner that owns the removal saga it resumes.
  const gitlabRef: { current?: { provisioner: GitlabProvisioner } } = {}
  // §7.2 identity: per-agent accounts, their PATs, and their memberships. Its
  // mutation lease is the account row's, never a binding's.
  const gitlabAccountService = gitlabOauthService
    ? new GitlabAccountService({
        oauth: gitlabOauthService,
        accounts: repos.gitlabAgentAccount,
        credentials: new PgGitlabProjectCredentialRepo(prisma),
        credentialSecrets: new PgGitlabProjectCredentialSecretStore(prisma, secretCipher),
        agents: repos.agent,
        instanceState: repos.gitlabInstanceState,
        cipher: secretCipher,
        clock,
        avatarPng: createGitlabAccountAvatarRenderer(iconStore),
        // A removal that stopped at a pending deletion finishes once the sweep
        // proves the account gone; nothing else would revisit that binding.
        onRetired: (orgId) => {
          void (async () => {
            for (const binding of await repos.gitlabProjectBinding.listForOrg(orgId)) {
              if (binding.state !== 'cleanup_pending' || binding.stateReason !== DELETION_PENDING_REASON) continue
              await gitlabRef.current?.provisioner.disconnect(orgId, binding.id)
            }
          })().catch((err) => http.log.warn({ err, orgId }, 'gitlab removal resume after retirement failed'))
        },
        api: gitlabApi!,
        log: { warn: (obj, msg) => http.log.warn(obj, msg) }
      })
    : undefined
  const gitlab = gitlabOauthService
    ? {
        api: gitlabApi!,
        oauth: gitlabOauthService,
        // The Console "Run again" action (§16.1) — fences here, dispatch on the relay.
        hookRerun: new GitlabHookRerunService({
          hooks: repos.hook,
          agents: repos.agent,
          bindings: repos.gitlabProjectBinding,
          accounts: repos.gitlabAgentAccount,
          credentials: new PgGitlabProjectCredentialRepo(prisma),
          credentialSecrets: new PgGitlabProjectCredentialSecretStore(prisma, secretCipher),
          hookService,
          relayControl,
          api: gitlabApi!
        }),
        accounts: gitlabAccountService!,
        provisioner: new GitlabProvisioner({
          oauth: gitlabOauthService,
          bindings: repos.gitlabProjectBinding,
          accounts: gitlabAccountService!,
          webhookSecrets: gitlabWebhookSecretStore!,
          catalog: repos.codeHostRepository,
          instanceState: repos.gitlabInstanceState,
          clock,
          ...(config.PUBLIC_RELAY_URL ? { publicRelayUrl: config.PUBLIC_RELAY_URL } : {}),
          // §11.1: the union every enabled gitlab hook on the project wants.
          desiredWebhookEvents: async (orgId, projectId) =>
            unionGitlabWebhookEvents(await repos.hook.listForOrgKind(OrgId(orgId), 'gitlab'), projectId),
          // Awaited under the run lease (§17.3 round 3): the durable clone-URL
          // convergence rides the saga; only the daemon fan-out stays async.
          syncWorkspacePaths: async (orgId, projectId, projectPath, cloneUrl) => {
            const agentIds = await repos.agent.refreshGitlabProjectPath(OrgId(orgId), projectId, projectPath, cloneUrl)
            for (const agentId of agentIds) {
              void repos.agent
                .getUnscoped(agentId)
                .then(
                  (agent) =>
                    agent &&
                    agentDelivery.upsert(agent, (err, daemonId) =>
                      http.log.warn(
                        { err, agentId, daemonId },
                        'gitlab rename: agent/upsert failed (backstop: reconnect)'
                      )
                    )
                )
                .catch((err) => http.log.warn({ err, agentId }, 'gitlab rename: agent refresh fan-out failed'))
            }
          },
          // Rules embed binding/webhook facts — recompile the project's hooks
          // after every run that may have changed them (assign or remove).
          onConverged: (orgId, projectId) => {
            void (async () => {
              // Rules embed binding/webhook facts — recompile the project's hooks.
              for (const row of await repos.hook.listForOrgKind(OrgId(orgId), 'gitlab')) {
                if (row.repoId === projectId) await hookService.broadcast(row)
              }
            })().catch((err) => http.log.warn({ err }, 'gitlab converge fan-out failed'))
          },
          api: gitlabApi!,
          log: { warn: (obj, msg) => http.log.warn(obj, msg) }
        })
      }
    : undefined
  if (gitlab) gitlabRef.current = gitlab

  // §7.4 PAT-rotation sweep; armed only by startBackground().
  const gitlabRotator = gitlab
    ? new GitlabCredentialRotator({
        accounts: gitlab.accounts,
        clock,
        log: { warn: (obj, msg) => http.log.warn(obj, msg) }
      })
    : undefined

  // §19.4 retirement sweep: GitLab deletes a user asynchronously, so the run
  // that asked cannot witness it — this loop does. Armed by startBackground().
  const gitlabRetirementSweeper = gitlab
    ? new GitlabRetirementSweeper({
        accounts: gitlab.accounts,
        clock,
        log: { warn: (obj, msg) => http.log.warn(obj, msg) }
      })
    : undefined

  // §10.2 convergence sweep: re-drives what a contended pass still owes, the
  // half of that obligation which survives a restart. Armed by startBackground().
  const gitlabConvergeSweeper = gitlab
    ? new GitlabConvergeSweeper({
        provisioner: gitlab.provisioner,
        clock,
        log: { warn: (obj, msg) => http.log.warn(obj, msg) }
      })
    : undefined

  // The GitLab arm of rc/codehost-membership-authz (§12.2): live effective
  // membership through the binding's read PAT. Absent configuration fails closed.
  const gitlabMembershipAuthz = gitlab
    ? new GitlabMembershipAuthzService({
        hooks: repos.hook,
        bindings: repos.gitlabProjectBinding,
        accounts: repos.gitlabAgentAccount,
        credentials: new PgGitlabProjectCredentialRepo(prisma),
        credentialSecrets: new PgGitlabProjectCredentialSecretStore(prisma, secretCipher),
        clock,
        api: gitlabApi!
      })
    : undefined

  // §16 informational run projection: the CP records the desired generation, the OWNING DAEMON
  // writes the note. Assembled with the GitLab administration surface, since the ledger's
  // credential fence comes from the acting agent's account on a project binding.
  const codeHostNoteProjection = gitlab
    ? new CodeHostNoteProjectionService({
        projections: new PgCodeHostRunProjectionRepo(prisma),
        runs: repos.hook,
        agents: repos.agent,
        bindings: repos.gitlabProjectBinding,
        accounts: repos.gitlabAgentAccount,
        orgs: repos.org,
        clock,
        ...(gitlabWebAppUrl ? { webAppUrl: gitlabWebAppUrl } : {}),
        sender: {
          daemonFeatures: (daemonId) => connReg.get(daemonId)?.capabilities?.features,
          send: (daemonId, desired, orgId) => {
            try {
              sender.codeHostNoteDesired(daemonId, desired, orgId)
            } catch (err) {
              // An offline daemon leaves the desired generation pending — never an error path.
              http.log.debug({ err, daemonId }, 'note projection: desired frame not sent — daemon offline')
            }
          }
        },
        log: { warn: (obj, msg) => http.log.warn(obj, msg) }
      })
    : undefined

  // The console PR panel's read projection — long-lived so its short TTL cache actually absorbs mounts.
  const pullRequestView = github ? new PullRequestViewService(github.tokens, clock, opts.githubFetch) : undefined
  // §12.6's second identity source for that panel: the PR a session's own head branch has, for the
  // sessions no pull-request run owns. Long-lived for the same reason — its TTL absorbs panel mounts.
  const sessionPullRequestLink =
    github && pullRequestView
      ? new SessionPullRequestLinkService({
          clock,
          github,
          tokens: github.tokens,
          readSessionBranch: async (agent, session, scope) => {
            // Through the PLACEMENT, like every workspace route (`getServingAgent`): a pool- or
            // cluster-placed agent has no `agent.daemonId` at all, so reading that column instead
            // resolved no branch for exactly the deployments where every agent is placed that way.
            const daemonId = (await placementResolver.servingDaemon(agent)) ?? agent.daemonId
            if (!daemonId) return null
            const daemon = await registry.getAvailable(agent.orgId, daemonId)
            if (!daemon) return null
            // An older daemon drops an unknown frame silently, so the REQ would burn its retransmit
            // budget and then read as an offline daemon — refuse first, exactly as the workspace
            // routes do. Only the session-worktree read needs it; the primary checkout is the read
            // every daemon has always answered.
            if (scope === 'session' && !daemon.capabilities.features.includes(WORKSPACE_SESSION_READ_FEATURE)) {
              return null
            }
            try {
              const status = await sender.workspaceGitStatus(daemonId, {
                agentId: agent.id,
                ...(scope === 'session' ? { sessionId: session.id } : {})
              })
              return status.isRepo ? (status.branch ?? null) : null
            } catch {
              // An offline daemon, a REQ timeout and a non-repo workspace are one answer here: no
              // branch to resolve a PR through. The panel keeps its own no-PR state for all of them.
              return null
            }
          },
          latestSessionIdOfAgent: (agent) => repos.session.latestSessionIdForAgent(agent.orgId, agent.id),
          log: { warn: (obj, message) => http.log.warn(obj, message) },
          ...(opts.githubFetch ? { fetchImpl: opts.githubFetch } : {})
        })
      : undefined
  const githubReviewBroker = github
    ? new GithubReviewBrokerService({
        hook: repos.hook,
        agent: repos.agent,
        github,
        clock,
        placement: placementResolver
      })
    : undefined
  // Provider-neutral formal reviews (§15.1/§15.2). The publishing identity is the
  // project binding's service account, so today the broker exists only where GitLab
  // administration is configured; the frames themselves name no provider.
  const codeHostReviewBroker = gitlabAppCfg
    ? new CodeHostReviewBrokerService({
        leases: new PgCodeHostReviewLeaseRepo(prisma),
        hook: repos.hook,
        agent: repos.agent,
        clock,
        placement: placementResolver,
        publisher: async (orgId, provider, projectExternalId, agentId) => {
          if (provider !== 'gitlab') return null
          const binding = await repos.gitlabProjectBinding.byProject(orgId, projectExternalId)
          if (!binding) return null
          // A binding being repaired or torn down publishes nothing.
          if (binding.state !== 'ready' && binding.state !== 'admin_degraded') return null
          // §7.2: the ACTING agent's own account is the coordinator's subject key.
          const account = await repos.gitlabAgentAccount.forAgentBinding(orgId, agentId, binding.id)
          if (!account || account.serviceAccountUserId === null) return null
          return { serviceAccountExternalId: account.serviceAccountUserId, projectPath: binding.projectPath }
        }
      })
    : undefined
  const githubCommentAuthz = github
    ? new GithubCommentAuthzService({
        hooks: repos.hook,
        installations: repos.githubInstallation,
        github
      })
    : undefined
  const githubRerequest = githubAppCfg
    ? new GithubRerequestService({ hooks: repos.hook, appId: githubAppCfg.appId })
    : undefined
  const githubRunReporterRef: { current?: GithubRunReporter } = {}
  const githubRunCoordinator = github
    ? new GithubRunCoordinator({
        hooks: repos.hook,
        agents: repos.agent,
        clock,
        kick: () => githubRunReporterRef.current?.kick()
      })
    : undefined
  const githubRunReporter = github
    ? new GithubRunReporter({
        hooks: repos.hook,
        agents: repos.agent,
        orgs: repos.org,
        ...(webAppUrl ? { webAppUrl } : {}),
        ...(githubAppCfg?.slug ? { appSlug: githubAppCfg.slug } : {}),
        github,
        clock,
        ...(githubRunCoordinator ? { repair: () => githubRunCoordinator.repair() } : {}),
        ...(opts.githubFetch ? { fetchImpl: opts.githubFetch } : {}),
        log: {
          info: (o, m) => http.log.info(o, m),
          warn: (o, m) => http.log.warn(o, m),
          error: (o, m) => http.log.error(o, m)
        }
      })
    : undefined
  if (githubRunReporter) githubRunReporterRef.current = githubRunReporter
  // Per-user repo authorization (identity assertion, design open question #7): needs the
  // github module, the Logto Mgmt coupling AND real OIDC auth — devAuth
  // principals have no identities to assert, so the gate stays off with the
  // org-level model (installation coverage) as before.
  // Installation doorbell (webhook-triggers decision 11): the relay's verified
  // `installation*` pokes trigger an App-JWT re-pull + github-hook recompile.
  // Logger is lazy over `http.log` (HttpBotOrchestrator precedent — pokes only
  // arrive over the relay WS, long after `http` exists).
  const installationDoorbell = github
    ? new GithubInstallationDoorbell({
        github,
        installations: repos.githubInstallation,
        recompileOrg: (orgId) => hookService.rebroadcastGithubForOrg(orgId),
        onFactsChanged: async (installationId, orgId) => {
          github.tokens.invalidateInstallation(installationId)
          pullRequestView?.invalidateInstallation(installationId)
          github.invalidateRepositoryRoster(installationId)
          await wakeGithubReviewProjections(installationId, orgId)
          githubRunReporter?.kick()
        },
        clock,
        log: {
          debug: (o, m) => http.log.debug(o, m),
          info: (o, m) => http.log.info(o, m),
          warn: (o, m) => http.log.warn(o, m)
        }
      })
    : undefined

  const logtoMgmtCfg = resolveLogtoMgmtConfig(config)
  const logtoIdentity =
    logtoMgmtCfg && config.OIDC_ISSUER
      ? new LogtoIdentityService(
          logtoMgmtCfg,
          clock,
          new PgSocialIdentityMutationGate(prisma),
          undefined,
          {
            // Lazy over `http.log` (assigned below; only ever called at lookup time).
            debug: (o, m) => http.log.debug(o, m),
            info: (o, m) => http.log.info(o, m)
          },
          { identityTtlMs: config.SESSION_ACCESS_IDENTITY_TTL_SEC * 1000 }
        )
      : undefined
  const githubUserAuthz =
    github && logtoIdentity
      ? new GithubUserAuthzService({
          identity: logtoIdentity,
          github,
          users: repos.user,
          clock
        })
      : undefined
  // The §2.3 session-access cache-policy knobs (session-access-cold-visit.md),
  // shared by every plugin holding a resource-fact cache.
  const sessionAccessTtls = {
    recheckMs: config.SESSION_ACCESS_RECHECK_SEC * 1000,
    publicTtlMs: config.SESSION_ACCESS_PUBLIC_TTL_SEC * 1000
  }
  const slackSessionAccess = new SlackSessionAccessService({
    bots: repos.bot,
    botSecrets: repos.botSecret,
    clock,
    ...sessionAccessTtls,
    ...(logtoIdentity ? { identity: logtoIdentity } : {}),
    ...(opts.slackFetch ? { fetchImpl: opts.slackFetch } : {}),
    // Lazy over `http.log` (assigned below; only ever called at resolve time).
    log: { warn: (o, m) => http.log.warn(o, m), debug: (o, m) => http.log.debug(o, m) }
  })
  const githubSessionAccess = new GithubSessionAccessService({
    installations: repos.githubInstallation,
    ...(github ? { github } : {}),
    ...(githubUserAuthz ? { userAuthz: githubUserAuthz } : {}),
    clock,
    ...sessionAccessTtls,
    identityTtlMs: config.SESSION_ACCESS_IDENTITY_TTL_SEC * 1000,
    // Lazy over `http.log` (assigned below; only ever called at resolve time).
    log: { warn: (o, m) => http.log.warn(o, m), debug: (o, m) => http.log.debug(o, m) }
  })
  const feishuSessionAccess = new FeishuSessionAccessService({
    bots: repos.bot,
    botSecrets: repos.botSecret,
    clock,
    ...(logtoIdentity ? { identity: logtoIdentity } : {}),
    ...(opts.feishuFetch ? { fetchImpl: opts.feishuFetch } : {}),
    // Lazy over `http.log` (assigned below; only ever called at resolve time).
    log: { warn: (o, m) => http.log.warn(o, m) }
  })

  // Built once and shared between the route deps (the live paths) and the
  // platform providers below — one closure per platform, not two.
  const syncTelegramBotIcon = createTelegramBotIconSyncer(iconStore)
  const syncDiscordBotProfile = createDiscordBotProfileSyncer(iconStore)
  const syncFeishuAppIcon = createFeishuAppIconSyncer(iconStore)

  const httpDeps: HttpDeps = {
    runtimeConfig: opts.deploymentConfig
      ? {
          deploymentRevision: opts.deploymentConfig.revision,
          publicRuntimeConfig: {
            auth:
              opts.deploymentConfig.values.auth.mode === 'oidc' && config.OIDC_ISSUER
                ? {
                    endpoint: new URL(config.OIDC_ISSUER).origin,
                    issuer: config.OIDC_ISSUER,
                    appId: opts.deploymentConfig.values.auth.browserClient.appId,
                    apiResource: opts.deploymentConfig.values.auth.browserClient.apiResource,
                    socialProviders: opts.deploymentConfig.values.auth.socialProviders
                  }
                : null
          }
        }
      : {},
    maxOrgsPerNonAdminUser: opts.deploymentConfig?.values.features.maxOrgsPerNonAdminUser ?? 1,
    clock,
    // The same late-bound façade the orchestrators above hold (see its
    // definition): the providers below are constructed WITH `httpDeps` — their
    // funnel plugins are route factories pre-bound to this very bundle — so the
    // registry cannot exist before this object does. Every reader runs at
    // Fastify `ready()` time or later, by which point it has been assigned.
    platforms,
    repos: {
      agent: repos.agent,
      assignment: repos.assignment,
      memberSet: repos.memberSet,
      dutyGroup: repos.dutyGroup,
      daemonLifecycleOp: repos.daemonLifecycleOp,
      cron: repos.cron,
      hook: repos.hook,
      hookSecret: repos.hookSecret,
      relay: repos.relay,
      session: repos.session,
      sessionUsage: repos.sessionUsage,
      webchatConversation: repos.webchatConversation,
      user: repos.user,
      org: repos.org,
      waitlist: repos.waitlist,
      integration: repos.integration,
      integrationChannel: repos.integrationChannel,
      bot: repos.bot,
      botSecret: repos.botSecret,
      botCredential: repos.botCredential,
      agentSecret: repos.agentSecret,
      agentConfig: repos.agentConfig,
      mcpProvider: repos.mcpProvider,
      mcpProviderSecret: repos.mcpProviderSecret,
      mcpGrant: repos.mcpGrant,
      skillSource: repos.skillSource,
      organizationKnowledge: repos.organizationKnowledge,
      organizationEnvironment: repos.organizationEnvironment,
      organizationEnvironmentSecret: repos.organizationEnvironmentSecret,
      organizationEnvironmentResolver: repos.organizationEnvironmentResolver,
      memoryPluginInstallation: repos.memoryPluginInstallation,
      externalMemoryConnection: repos.externalMemoryConnection,
      externalMemoryConnectionSecret: repos.externalMemoryConnectionSecret,
      externalMemoryGrant: repos.externalMemoryGrant,
      memoryConnectionWriter: repos.memoryConnectionWriter,
      slackInstall: repos.slackInstall,
      slackPlatformInstall: repos.slackPlatformInstall,
      feishuAppRegistration: repos.feishuAppRegistration,
      slackUserConfig: repos.slackUserConfig,
      presetAgent: repos.presetAgent,
      githubInstallation: repos.githubInstallation,
      agentRepoAuth: repos.agentRepoAuth,
      codeHostRepository: repos.codeHostRepository,
      gitlabConnection: repos.gitlabConnection,
      gitlabProjectBinding: repos.gitlabProjectBinding,
      gitlabAgentAccount: repos.gitlabAgentAccount,
      gitlabInstanceState: repos.gitlabInstanceState,
      audit: repos.audit,
      webchatMcpOperation: repos.webchatMcpOperation,
      oauth: repos.oauth
    },
    registry,
    agentSpecs,
    ...(daemonRelease ? { daemonRelease } : {}),
    // The live connection index doubles as the read model's liveness overlay
    // (structurally a `DaemonLiveness`): it knows who is connected RIGHT NOW.
    liveness: connReg,
    daemonConns: connReg,
    control: sender,
    agentDelivery,
    placementResolver,
    visibilityPush,
    relayControl,
    httpBot,
    collabRoutes,
    agentMutations,
    sessionOwners: connReg,
    hooks: hookService,
    ...(githubRunReporter ? { kickGithubRunReporter: () => githubRunReporter.kick() } : {}),
    recomputeDuties: (orgId: string) => dutyRecompute.kick(orgId),
    auth,
    apiKeys,
    oauth,
    webchatTokens,
    inviteLinks,
    waitlist,
    usageWriter,
    ...(clusterWorkloadIdentity ? { clusterWorkloadIdentity } : {}),
    events,
    mcpRateLimit: new McpRateLimiter(clock),
    remoteGrantAuth,
    internalInvocationAuth,
    // §8 CP-db-only operation atomicity: run `fn` with every repository call —
    // including those made by nested app.inject routes — joined to ONE
    // transaction (see persistence/ambient-tx.ts). Opened on the root client.
    sharedTx: <T>(fn: () => Promise<T>) => rootPrisma.$transaction((tx) => runWithSharedTx(tx, fn)),
    webchatMcpMetrics: defaultWebchatMcpMetrics,
    readiness,
    searchSkillRegistry,
    resolvePublicRepo: createPublicRepoResolver(),
    ...(github ? { github } : {}),
    ...(gitlab ? { gitlab } : {}),
    ...(pullRequestView ? { pullRequestView } : {}),
    ...(sessionPullRequestLink ? { sessionPullRequestLink } : {}),
    ...(githubUserAuthz ? { githubUserAuthz } : {}),
    ...(logtoIdentity ? { logtoIdentity } : {}),
    sessionAccessPlugins: [slackSessionAccess, githubSessionAccess, feishuSessionAccess],
    ...(iconStore ? { iconStore } : {}),
    ...(connectors ? { connectors } : {}),
    config: httpServerConfigFrom(config, { DEFAULT_OWNER_ID, relayStaleMs })
  }
  const http = buildHttpServer(httpDeps, opts.fastify)

  // Reconciler for orphaned schedule runs: fails `running` cron_run rows whose
  // completion report was lost so the console self-heals (design §3.14). Built
  // here so the graph is whole; armed only by `startBackground()` (never in
  // tests). Uses the Fastify logger, hence constructed after `http`.
  const cronRunReaper = new CronRunReaper(
    repos.cron,
    clock,
    { ttlMs: config.CRON_RUN_TTL_SEC * 1000, intervalMs: config.CRON_RUN_REAP_INTERVAL_SEC * 1000 },
    http.log
  )

  // Same reconciler, hook runs: closes `running` hook_run rows whose completion
  // report was lost (daemon offline at turn end / relay report dropped). The
  // two-report lifecycle matches crons exactly, so the class is reused verbatim.
  const hookRunReaper = new CronRunReaper(
    repos.hook,
    clock,
    {
      ttlMs: config.CRON_RUN_TTL_SEC * 1000,
      intervalMs: config.CRON_RUN_REAP_INTERVAL_SEC * 1000,
      label: 'hook-run-reaper'
    },
    http.log
  )

  // Durable one-time assertion recovery. Invocation rows are reaped before
  // expired delegations so a parent is never removed while cached/recoverable
  // invocation state still depends on it.
  const webchatMcpOperationReaper = new WebchatMcpOperationReaper(
    repos.webchatMcpOperation,
    repos.webchatMcpDelegation,
    clock,
    http.log,
    defaultWebchatMcpMetrics
  )

  // Retires the daemon rows replaced pool member Pods leave behind (a pool member is bound to
  // its Pod UID, so a new Pod means a new record). Org-less rows no `DELETE /daemons/:id`
  // can reach, which is why they accumulate in every org's fleet. Only where cluster tokens
  // are accepted at all: nowhere else can a pool member exist.
  const poolMemberReaper = clusterIdentity
    ? new PoolMemberReaper(
        repos.daemon,
        repos.webchatMcpDelegation,
        (member, retiredBefore) => retirePoolMember(httpDeps, member, retiredBefore, http.log),
        connReg,
        clock,
        { retireAfterMs: POOL_MEMBER_REAP_AFTER_MS, intervalMs: POOL_MEMBER_REAP_INTERVAL_MS },
        http.log
      )
    : undefined

  // Redelivery reconciliation (webhook-triggers P2.5): recovers github events
  // lost to a relay-pool outage by asking GitHub to redeliver GUIDs that never
  // produced a HookRun. Only exists when the App is configured; same lifecycle
  // as the cron reaper.
  const hookRedeliveryReconciler = github
    ? new HookRedeliveryReconciler(
        github,
        repos.hook,
        repos.relay,
        clock,
        {
          intervalMs: 10 * 60 * 1000,
          windowMs: 30 * 60 * 1000,
          graceMs: 2 * 60 * 1000,
          relayStaleMs
        },
        http.log
      )
    : undefined

  // One-time preset backfill (preset-agents.md §3.2): existing orgs receive the
  // `agentconnect` general preset; the preset_agent row is the per-org marker, so
  // the sweep converges to a no-op after its first complete run.
  const presetBackfill = config.PRESET_AGENTS_ENABLED ? new PresetAgentBackfill(prisma, http.log) : undefined

  // Relay failover sweep (shared-bot-relay.md §5): deletes `relay` rows whose
  // heartbeat lapsed and re-fans the shrunk roster to daemons. Same lifecycle as
  // the cron reaper (armed by startBackground, never in tests).
  const relaySweeper = new RelaySweeper(
    repos.relay,
    clock,
    { staleMs: relayStaleMs, intervalMs: config.RELAY_REAP_INTERVAL_SEC * 1000 },
    // On a reap: re-fan the shrunk roster to daemons. Whole-pool ingress means a dead
    // relay strands no bot (the manifest request_url is a stable LB; the CP broadcasts
    // to whoever is connected), so no per-bot re-placement is needed here.
    async () => {
      await relayRoster.broadcast()
      // §14.3: a reaped relay may have held notice authorities — re-stamp survivors.
      await httpBot.reconcileAll().catch((err) => http.log.error({ err }, 'relay sweep: HTTP-bot reconcile failed'))
      const selected = (await relayRoster.entries())[0]
      if (selected) {
        await syncMemoryConnectionsToDaemons(relayHttpOrigin(selected.url), {
          connections: repos.externalMemoryConnection,
          installations: repos.memoryPluginInstallation,
          secrets: repos.externalMemoryConnectionSecret,
          grants: repos.externalMemoryGrant,
          agents: repos.agent,
          delivery: agentDelivery,
          control: sender,
          log: http.log
        })
      }
    },
    http.log
  )

  // Older Slack installs discarded some public app/workspace identity metadata.
  // Repair those rows off the request path so Settings can render links and
  // workspace groups without turning GET /bots into a Slack API fan-out.
  const slackBotIdentityReconciler = new SlackBotIdentityReconciler(
    repos.bot,
    repos.botSecret,
    async (botToken) => {
      const result = await verifySlackBot(botToken)
      return result.status === 'ok'
        ? {
            appId: result.appId,
            botUserId: result.botUserId,
            workspaceId: result.teamId,
            workspaceName: result.teamName
          }
        : null
    },
    clock,
    {
      intervalMs: 15 * 60 * 1000,
      onMentionIdentityChanged: (orgId) => collabRoutes.broadcast(orgId)
    },
    http.log
  )

  // The per-platform INJECTION seams the provider-contributed route plugins take
  // as their second argument (`http/platform-route-seams.ts`) — what used to be
  // twelve platform-named fields on `httpDeps`. Built here, once, and shared with
  // the providers below so the routes and the registry cannot hold different
  // clients. The tooling-credential facet is a single instance for the same
  // reason: the funnel start, the config status route, the Settings→Bots refresh
  // and `provider.providerToolingCredentials` are all this one object.
  const slackSeams: SlackRouteSeams = {
    configApi: slackConfigApi,
    verifyBot: verifySlackBot,
    verifyAppToken: verifySlackAppToken,
    ...(slackPlatformApp ? { platformApp: slackPlatformApp } : {}),
    // Named arguments, NOT `httpDeps`: the bundle no longer carries a Slack API
    // client, and passing it here type-checked while making every production
    // resolution `unreachable`.
    toolingCredentials: createSlackToolingCredentials({
      configApi: slackConfigApi,
      store: repos.slackUserConfig
    })
  }
  const telegramSeams: TelegramRouteSeams = { verifyBot: verifyTelegramBot }
  const feishuTenantGuard = createFeishuAppTenantGuard((region) => feishuPlatformApps[region])
  const feishuSeams: FeishuRouteSeams = {
    verifyBot: verifyFeishuBot,
    tenantGuard: feishuTenantGuard,
    configureHttpApp: configureFeishuHttpApp,
    registrations: new FeishuAppRegistrationService(repos.feishuAppRegistration)
  }

  // §9 platform-provider registry (S3): the behavioral CpPlatformProvider
  // instances — all four platforms — constructed with the SAME verify/sync
  // functions, route-dep bundle, funnel stores, and background-loop instances
  // the live paths use (one implementation; the providers add no second code
  // path). The Slack/Feishu funnel plugins are handed in PRE-BOUND to
  // `httpDeps` — the very factories `server.ts` mounts — keeping provider
  // construction one-directional (a provider never reaches back for a route
  // factory). That is also why every holder captures the late-bound `platforms`
  // façade defined near the top rather than this value directly.
  //
  // ADOPTED SO FAR: route mounting (`server.ts` asks each provider for its
  // plugins per scope), the `POST /integrations` create body + its live
  // `validateConfig` + `buildNewBotInstall` tail, the pending-install reapers and
  // the background loops below, `loadConfig`'s env fold (through the static
  // `platforms/env.ts` declaration — `loadConfig` runs before this registry can
  // exist, since providers are constructed FROM the parsed config), (§9) ALL
  // wire projection — `IntegrationSpec.config` on every spec-assembly path and
  // both `rc/bot-assign` bags — the agent-icon fan-out's capability probe, the
  // `rc/bot-assign` completeness gate, and the per-user tooling credentials. The
  // twelve platform-named `httpDeps` slots this used to populate are gone: what
  // core ASKS is answered by the registry, and what tests INJECT is the seams
  // above.
  composedPlatforms = buildCpPlatformRegistry([
    createTelegramCpProvider({
      verifyBot: verifyTelegramBot,
      syncBotIcon: syncTelegramBotIcon,
      funnelRoutes: { org: [telegramCheckRoutes(httpDeps, telegramSeams)], publicCallback: [] }
    }),
    createDiscordCpProvider({
      verifyBot: verifyDiscordBot,
      ensureMessageContentIntent: ensureDiscordMessageContentIntent,
      syncBotProfile: syncDiscordBotProfile
    }),
    createSlackCpProvider({
      verifyBot: verifySlackBot,
      verifyAppToken: verifySlackAppToken,
      funnelRoutes: {
        org: [
          slackInstallRoutes(httpDeps, slackSeams),
          slackPlatformInstallRoutes(httpDeps, slackSeams),
          slackConfigRoutes(httpDeps, slackSeams),
          slackBotRefreshRoutes(httpDeps, slackSeams)
        ],
        publicCallback: [
          slackOauthCallbackRoutes(httpDeps, slackSeams),
          slackPlatformCallbackRoutes(httpDeps, slackSeams)
        ]
      },
      ...(slackSeams.toolingCredentials ? { toolingCredentials: slackSeams.toolingCredentials } : {}),
      pendingInstalls: {
        installs: repos.slackInstall,
        platformInstalls: repos.slackPlatformInstall,
        ttlMs: config.SLACK_INSTALL_TTL_SEC * 1000,
        intervalMs: config.SLACK_INSTALL_REAP_INTERVAL_SEC * 1000
      },
      identityReconciler: slackBotIdentityReconciler
    }),
    createFeishuCpProvider({
      verifyBot: verifyFeishuBot,
      tenantGuard: feishuTenantGuard,
      funnelRoutes: { org: [feishuRegistrationRoutes(httpDeps, feishuSeams)], publicCallback: [] },
      syncAppIcon: syncFeishuAppIcon,
      pendingInstalls: {
        registrations: repos.feishuAppRegistration,
        intervalMs: config.SLACK_INSTALL_REAP_INTERVAL_SEC * 1000
      }
    })
  ])

  // Pending-install TTL reapers + provider-owned convergence loops, from the
  // providers' §9 declarations (`platforms/lifecycle.ts`) instead of the four
  // hand-listed instances this used to hold. Same lifecycle as the cron reaper:
  // built here so the graph is whole, armed only by `startBackground()`.
  const pendingInstallReapers = buildPendingInstallReapers(platforms, clock, http.log)
  const backgroundLoops = platformBackgroundLoops(platforms)

  // §4 session-access warmer (session-access-cold-visit.md, Phase 3): keeps the
  // resource facts behind ACTIVE external scopes leased so a cold console visit
  // skips the per-resource provider sweep. Poked from `event/session` ingest;
  // observes only through the plugins' classifying warm entries (§4.2(3)).
  // Built here so the graph is whole, armed only by `startBackground()`.
  const sessionAccessWarmer = new SessionAccessWarmer({
    sessions: repos.session,
    targets: new Map([
      ['slack', (scope: ExternalScopeRecord) => slackSessionAccess.warmAudience(scope)],
      ['github', (scope: ExternalScopeRecord) => githubSessionAccess.warmShape(scope)]
    ]),
    clock,
    publicTtlMs: sessionAccessTtls.publicTtlMs,
    log: {
      debug: (o, m) => http.log.debug(o, m),
      info: (o, m) => http.log.info(o, m),
      warn: (o, m) => http.log.warn(o, m)
    }
  })

  // ── daemon WS edge (mounted on the live http.Server after listen) ──────────
  const wsDeps: DaemonWsServerDeps = {
    log: { error: (o, m) => http.log.error(o, m) },
    auth,
    placementResolver,
    lifecycleOps: repos.daemonLifecycleOp,
    registry,
    orchestrator,
    connReg,
    session: repos.session,
    webchatConversation: repos.webchatConversation,
    webchatRemoteMcp,
    launch: repos.launch,
    visibilityPush,
    events,
    usageWriter,
    integration: repos.integration,
    bot: repos.bot,
    githubInstallation: repos.githubInstallation,
    integrationChannel: repos.integrationChannel,
    slackSessionAccess,
    gatedDmSeeds: gatedDmSeedResolver,
    // §14.8: the report path can now create an ENABLED row, so it needs the same
    // re-converge a visibility flip performs — the reporter's own bindRules predate it.
    integrationConverge: (agent) =>
      convergeIntegrationGating({ repos, agentDelivery, httpBot, platforms }, agent, {
        warn: (o, m) => http.log.warn(o as Record<string, unknown>, m)
      }),
    sessionAccessWarmer,
    agentMutations,
    recoverStagedAgent: (agentId, daemonId, moveId) => stagedAgentMoves.recoverStaged(agentId, daemonId, moveId),
    collabRoutes,
    dutyLease,
    memberSets: repos.memberSet,
    agentBundle: (agent) => stagedAgentMoves.bundleFor(agent),
    cron: repos.cron,
    hook: repos.hook,
    agent: repos.agent,
    organizationKnowledge: repos.organizationKnowledge,
    externalMemoryConnection: repos.externalMemoryConnection,
    ...(github ? { github } : {}),
    // gitcred v2 (§13.1): the gitlab arm serves the agent's own account PATs; absent ⇒ disabled.
    ...(gitlab
      ? {
          gitlabGitcred: new GitlabGitcredService({
            bindings: repos.gitlabProjectBinding,
            accounts: repos.gitlabAgentAccount,
            credentials: new PgGitlabProjectCredentialRepo(prisma),
            credentialSecrets: new PgGitlabProjectCredentialSecretStore(prisma, secretCipher),
            repoAuths: repos.agentRepoAuth,
            clock,
            baseUrl: gitlab.api.baseUrl
          })
        }
      : {}),
    ...(githubReviewBroker ? { githubReviewBroker } : {}),
    ...(codeHostReviewBroker ? { codeHostReviewBroker } : {}),
    ...(githubRunCoordinator ? { githubRunCoordinator } : {}),
    ...(codeHostNoteProjection ? { codeHostNoteProjection } : {}),
    relayRoster: () => relayRoster.entries(),
    clock,
    config: {
      HEARTBEAT_SEC: config.HEARTBEAT_SEC,
      ACK_TIMEOUT_MS: config.ACK_TIMEOUT_MS,
      WS_PATH: config.WS_PATH
    }
  }

  // ── relay control WS edge (rc/*) — the third gateway on the shared http.Server ─
  // Register fan-out is deliberately asynchronous with respect to
  // `rc/registered`, but it still belongs to this process lifecycle. Track the
  // guarded promises so shutdown cannot disconnect Prisma while a just-opened
  // relay is still reading the roster/rules baseline (and tests cannot race
  // their database cleanup against that work).
  const relayRegistrationTasks = new Set<Promise<void>>()
  const trackRelayRegistrationTask = (task: Promise<void>): void => {
    relayRegistrationTasks.add(task)
    void task.then(
      () => relayRegistrationTasks.delete(task),
      () => relayRegistrationTasks.delete(task)
    )
  }

  const relayWsDeps: RelayWsServerDeps = {
    auth: relayAuth,
    relays: repos.relay,
    relayReg,
    clock,
    ...(opts.deploymentConfig
      ? {
          deploymentConfig: {
            revision: opts.deploymentConfig.revision,
            ...(opts.deploymentConfig.values.github && opts.deploymentConfig.secrets['github.webhookSecret']
              ? { githubWebhookSecret: opts.deploymentConfig.secrets['github.webhookSecret'] }
              : {})
          }
        }
      : {}),
    // rc/verify(webchat-token): validate the token, then re-resolve the agent's CURRENT
    // placement (agent.daemonId + connReg READY) — placement can move between mint + dial.
    verifyWebchatToken: createWebchatTokenVerifier({
      tokens: webchatTokens,
      agents: repos.agent,
      daemons: connReg,
      conversations: repos.webchatConversation,
      sessions: repos.session,
      memberSets: repos.memberSet,
      orgs: repos.org,
      remoteMcp: webchatRemoteMcp,
      placement: placementResolver
    }),
    // Current-permission fallback for GitHub comment webhooks whose
    // author_association snapshot is stale or inconsistent across event types.
    // Missing GitHub configuration fails closed.
    authorizeGithubComment: async (req) => (githubCommentAuthz ? githubCommentAuthz.allowed(req) : false),
    authorizeGithubRerequest: async (req) => (githubRerequest ? githubRerequest.resolve(req) : { allowed: false }),
    authorizeCodeHostMembership: async (req) => (gitlabMembershipAuthz ? gitlabMembershipAuthz.allowed(req) : false),
    // A relay just (re)registered — refresh every daemon's roster, (re)assign every
    // HTTP bots' ingress + routes (§5, idempotent), AND replay the compiled hook
    // rules to the fresh connection (its table is a memory copy). All fire-and-forget,
    // so the DB reads MUST NOT reject unhandled (that would crash the CP under Node's
    // throw-on-unhandled-rejection): swallow + log, mirroring the sweeper's guarded
    // `relaySweeper.tick` path.
    onRegistered: (ch) => {
      trackRelayRegistrationTask(
        relayRoster.broadcast().catch((err) => http.log.error({ err }, 'relay: roster sync on register failed'))
      )
      // Seed ONLY the fresh relay with every http bot's assign + persisted thread
      // affinity (per-relay replay — no re-broadcast to the whole pool)…
      trackRelayRegistrationTask(
        httpBot.replayTo(ch).catch((err) => http.log.error({ err }, 'relay: HTTP-bot replay on register failed'))
      )
      // …then converge the WHOLE pool: a joined relay changes the connected roster,
      // which moves §14.3 notice authorities — existing relays must learn the new
      // assignment or two pods could both (or neither) believe they hold it.
      trackRelayRegistrationTask(
        httpBot.reconcileAll().catch((err) => http.log.error({ err }, 'relay: HTTP-bot reconcile on register failed'))
      )
      trackRelayRegistrationTask(
        hookService.replayTo(ch).catch((err) => http.log.error({ err }, 'relay: hook-rule replay on register failed'))
      )
      // Seed the fresh relay with every MCP provider binding (its table starts empty;
      // bindings are pool-wide, so a later-joining relay must be replayed or requests 401).
      trackRelayRegistrationTask(
        replayMcpTo(ch, {
          providers: repos.mcpProvider,
          secrets: repos.mcpProviderSecret,
          grants: repos.mcpGrant,
          log: http.log
        }).catch((err) => http.log.error({ err }, 'relay: mcp binding replay on register failed'))
      )
      trackRelayRegistrationTask(
        (async () => {
          const memoryDeps = {
            connections: repos.externalMemoryConnection,
            installations: repos.memoryPluginInstallation,
            secrets: repos.externalMemoryConnectionSecret,
            grants: repos.externalMemoryGrant,
            log: http.log
          }
          // The relay binding must exist before a daemon is pointed at it.
          await replayMemoryConnectionsTo(ch, memoryDeps)
          const selected = (await relayRoster.entries())[0]
          if (!selected) return
          await syncMemoryConnectionsToDaemons(relayHttpOrigin(selected.url), {
            ...memoryDeps,
            agents: repos.agent,
            delivery: agentDelivery,
            control: sender
          })
        })().catch(() => http.log.error('relay: memory binding/daemon sync on register failed'))
      )
      // Ship the collaboration routing snapshot baseline to the fresh relay (§6.5
      // reconnect baseline). Fire-and-forget + guarded like the others.
      trackRelayRegistrationTask(
        collabRoutes
          .broadcastTo(ch)
          .catch((err) => http.log.error({ err }, 'relay: collab-routes baseline on register failed'))
      )
    },
    // Delivery-stage HookRun bookkeeping (`rc/run-report` EVT): `accepted` opens
    // the row running, `failed` records the delivery failure. Unknown hooks drop.
    onRunReport: async (report) => {
      const firedAt = new Date(report.firedAt)
      if (Number.isNaN(firedAt.getTime())) return
      const projectionIntent = githubProjectionIntent(report.event, report.github, report.reviewPolicy)
      const delivery = await repos.hook.recordDeliveryResult(HookId(report.hookId), {
        deliveryKey: report.deliveryKey,
        firedAt,
        status: report.status,
        agentId: AgentId(report.agentId),
        ...(report.configRevision !== undefined ? { configRevision: BigInt(report.configRevision) } : {}),
        ...(report.dispatchRevision !== undefined ? { dispatchRevision: BigInt(report.dispatchRevision) } : {}),
        ...(report.dispatchDaemonId !== undefined
          ? { dispatchDaemonId: DaemonId(report.dispatchDaemonId) }
          : report.daemonId
            ? { dispatchDaemonId: DaemonId(report.daemonId) }
            : {}),
        ...(report.reviewPolicy !== undefined ? { reviewPolicySnapshot: report.reviewPolicy } : {}),
        ...(report.reportingMode !== undefined ? { reportingModeSnapshot: report.reportingMode } : {}),
        ...(report.gateMode !== undefined ? { gateModeSnapshot: report.gateMode } : {}),
        projectionIntent,
        ...(report.github
          ? {
              repoId: BigInt(report.github.repoId),
              repoFullName: report.github.repoFullName,
              sourceInstallationId: BigInt(report.github.sourceInstallationId),
              subjectKind: report.github.subjectKind,
              ...(report.github.pullNumber !== undefined ? { pullNumber: report.github.pullNumber } : {}),
              ...(report.github.headSha ? { headSha: report.github.headSha } : {}),
              ...(report.github.baseSha ? { baseSha: report.github.baseSha } : {}),
              ...(report.github.reportSha ? { reportSha: report.github.reportSha } : {}),
              ...(report.github.isDraft !== undefined ? { isDraft: report.github.isDraft } : {}),
              ...(report.github.baseChanged !== undefined ? { baseChanged: report.github.baseChanged } : {})
            }
          : {}),
        ...(report.event ? { event: report.event } : {}),
        ...(report.reason ? { reason: report.reason } : {})
      })
      if (delivery.accepted && report.status === 'accepted') {
        if (report.github && delivery.newlyObserved) {
          void repos.hook
            .refreshGithubRepoFullName(
              HookId(report.hookId),
              BigInt(report.github.repoId),
              report.github.repoFullName,
              firedAt
            )
            .then(({ hooks, agentIds }) =>
              Promise.all([
                ...hooks.map((hook) => hookService.broadcast(hook)),
                ...agentIds.map(async (agentId) => {
                  const agent = await repos.agent.getUnscoped(agentId)
                  if (!agent) return
                  await agentDelivery.upsert(agent, (err, daemonId) => {
                    if (err instanceof NoConnection) {
                      http.log.debug({ agentId, daemonId }, 'github rename: agent/upsert skipped — daemon offline')
                    } else {
                      http.log.warn(
                        { err, agentId, daemonId },
                        'github rename: agent/upsert failed (backstop: reconnect roster)'
                      )
                    }
                  })
                })
              ])
            )
            .catch((err) =>
              http.log.warn({ err, hookId: report.hookId }, 'github ingress: repository rename convergence failed')
            )
        }
        void githubRunCoordinator
          ?.afterAccepted(HookId(report.hookId), report.deliveryKey)
          .catch((err) => http.log.warn({ err, hookId: report.hookId }, 'github check: accepted convergence failed'))
      } else if (
        delivery.accepted &&
        report.status === 'failed' &&
        report.reason === HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED
      ) {
        void githubRunCoordinator
          ?.afterReport(HookId(report.hookId), report.deliveryKey)
          .catch((err) =>
            http.log.warn({ err, hookId: report.hookId }, 'github check: manual-request convergence failed')
          )
      }
      // §16 delivery-stage edge: an accepted gitlab MR fire opens `queued`, a delivery failure
      // reads `skipped`. Fire-and-forget like the Check convergence above — the desired generation
      // is durable, so a lost projection edge is repaired by the next one.
      if (delivery.accepted && codeHostNoteProjection && report.gitlab) {
        void (async () => {
          const hook = await repos.hook.getUnscoped(HookId(report.hookId))
          if (hook?.kind !== 'gitlab') return
          const edge = {
            hookId: report.hookId,
            agentId: report.agentId,
            deliveryKey: report.deliveryKey,
            orgId: hook.orgId,
            state: 'queued' as const,
            reason: report.reason ?? null,
            gitlab: report.gitlab,
            snapshot: report,
            at: firedAt
          }
          if (report.status === 'accepted') await codeHostNoteProjection.afterAccepted(edge)
          else await codeHostNoteProjection.afterDeliveryFailed(edge)
        })().catch((err) =>
          http.log.warn({ err, hookId: report.hookId }, 'note projection: delivery convergence failed')
        )
      }
    },
    // The in-Slack config modal picked a channel's default agent — persist + recompile
    // the bot's routes. Swallow+log: a store error must not close the shared relay link.
    onSetChannelAgent: async (m) => {
      try {
        await httpBot.setChannelAgent(m.botId, m.channelId, m.agentId)
      } catch (err) {
        http.log.error({ err, botId: m.botId }, 'relay: set-channel-agent failed')
      }
    },
    // HTTP Slack ingest observed the bot itself join/leave a channel and re-listed
    // its complete membership. Persist across every install and refresh relay routes.
    onBotChannels: async (m) => {
      try {
        await httpBot.replaceChannels(m.botId, m.channels)
      } catch (err) {
        http.log.error({ err, botId: m.botId }, 'relay: bot-channels snapshot failed')
      }
    },
    // A closed relay socket shrinks the connected roster — re-stamp §14.3 notice
    // authorities on the survivors (fire-and-forget; errors logged).
    onRelayGone: () => {
      void httpBot
        .reconcileAll()
        .catch((err) => http.log.error({ err }, 'relay: HTTP-bot reconcile on disconnect failed'))
    },
    // A workspace uninstalled the app / revoked its tokens — mark the Bot + its
    // installs revoked and release the bot from the pool, unless the report is
    // stale (the fence fields; Slack does not order lifecycle events). Swallow+log.
    // ACKNOWLEDGED: the relay keeps retrying until this resolves, so a failure
    // must PROPAGATE (the connection answers a retryable error) rather than be
    // swallowed — swallowing would look like success and lose the only signal a
    // dead credential ever produces.
    onBotRevoked: async (m) =>
      httpBot.revokeBot(m.botId, m.reason, {
        ...(m.credentialRevision !== undefined ? { revision: m.credentialRevision } : {}),
        ...(m.eventAtMs !== undefined ? { eventAtMs: m.eventAtMs } : {})
      }),
    // A relay delivered a §14.3 DM gating notice — record + re-stamp the pool's
    // latch. Swallow+log.
    onNoticePosted: async (m) => {
      try {
        await httpBot.recordNoticePosted(m)
      } catch (err) {
        http.log.error({ err, botId: m.botId }, 'relay: notice-posted record failed')
      }
    },
    // Incremental direct-conversation report: surface a configurable row on every
    // install, with its visibility-appropriate default. Swallow+log.
    onBotConversation: async (m) => {
      try {
        await httpBot.reportConversation(m.botId, m.conversation)
      } catch (err) {
        http.log.error({ err, botId: m.botId }, 'relay: bot-conversation report failed')
      }
    },
    // Durable thread-affinity REPORT leg — persist + broadcast (rc/assign). Swallow+log:
    // a store error must not close the shared relay link.
    onThreadAssign: async (m) => {
      try {
        await httpBot.recordThreadAssign(m)
      } catch (err) {
        http.log.error({ err, botId: m.botId }, 'relay: thread-assign failed')
      }
    },
    // Durable room membership is independent of compatibility owner affinity.
    onThreadParticipant: async (m) => {
      try {
        await httpBot.recordThreadParticipant(m)
      } catch (err) {
        http.log.error({ err, botId: m.botId }, 'relay: thread-participant failed')
      }
    },
    // Pull-on-miss BACKSTOP leg — may throw → the handler answers a retryable error.
    threadLookup: (m) => httpBot.lookupThread(m),
    // Installation doorbell poke — fire-and-forget into the throttled re-pull
    // (the doorbell owns single-flight/cooldown and swallows its own errors).
    onGithubInstallation: async (m) => {
      if (!installationDoorbell) {
        http.log.debug({ installationId: m.installationId }, 'relay: doorbell ignored — GITHUB_APP_* not configured')
        return
      }
      installationDoorbell.poke(m)
    },
    config: {
      RELAY_WS_PATH: config.RELAY_WS_PATH,
      HEARTBEAT_SEC: config.HEARTBEAT_SEC
    }
  }

  return {
    http,
    wsGateway: (app: FastifyInstance) => createDaemonWsServer(app, wsDeps),
    relayGateway: (app: FastifyInstance) => createRelayWsServer(app, relayWsDeps),
    defaults: { orgId: DEFAULT_ORG_ID, ownerId: DEFAULT_OWNER_ID },
    platforms,
    readiness,
    webchatRemoteMcp,
    remoteGrantAuth,
    internalInvocationAuth,
    startBackground() {
      cronRunReaper.start()
      hookRunReaper.start()
      poolMemberReaper?.start()
      webchatMcpOperationReaper.start()
      githubRunReporter?.start()
      hookRedeliveryReconciler?.start()
      gitlabRotator?.start()
      gitlabRetirementSweeper?.start()
      gitlabConvergeSweeper?.start()
      for (const reaper of pendingInstallReapers) reaper.start()
      relaySweeper.start()
      dutyRecompute.start()
      sessionAccessWarmer.start()
      for (const loop of backgroundLoops) loop.start()
      // One-shot (not a re-arming loop): the worklist empties itself; a partially
      // failed boot resumes on the next one. Never blocks listen.
      void presetBackfill?.run().catch((err) => http.log.error({ err }, 'preset-backfill: sweep failed'))
    },
    async shutdown() {
      cronRunReaper.stop()
      hookRunReaper.stop()
      poolMemberReaper?.stop()
      const webchatMcpOperationSettled = webchatMcpOperationReaper.stopAndSettle()
      githubRunReporter?.stop()
      hookRedeliveryReconciler?.stop()
      gitlabRotator?.stop()
      gitlabRetirementSweeper?.stop()
      gitlabConvergeSweeper?.stop()
      installationDoorbell?.stop()
      for (const reaper of pendingInstallReapers) reaper.stop()
      relaySweeper.stop()
      dutyRecompute.stop()
      poolMetrics.stop()
      orgMetrics.stop()
      sessionAccessWarmer.stop()
      for (const loop of backgroundLoops) loop.stop()
      visibilityPush.stop()
      await Promise.allSettled([
        webchatMcpOperationSettled,
        ...relayRegistrationTasks,
        visibilityPush.settle(),
        sessionAccessWarmer.settle(),
        dutyRecompute.settle(),
        ...(installationDoorbell ? [installationDoorbell.settle()] : [])
      ])
      await rootPrisma.$disconnect()
    }
  }
}

/**
 * Project the validated environment onto the HTTP layer's config slice.
 *
 * Extracted and exported so this seam is testable on its own: it is an explicit
 * field list, tests elsewhere hand-build `HttpDeps`, and a variable forgotten
 * here therefore reads as unset in production while every focused test still
 * passes. That has happened.
 */
export function httpServerConfigFrom(
  config: AppConfig,
  extras: { DEFAULT_OWNER_ID: string; relayStaleMs: number }
): HttpDeps['config'] {
  const { DEFAULT_OWNER_ID, relayStaleMs } = extras
  return {
    DEFAULT_OWNER_ID,
    NODE_ENV: config.NODE_ENV,
    WS_PATH: config.WS_PATH,
    HOST: config.HOST,
    PORT: config.PORT,
    // Reconnect grace for the daemon read model: mirror the watchdog's freeze
    // threshold (missed-beats × heartbeat) so a CP restart shows daemons as
    // `connecting` for the few seconds they take to re-handshake, not `offline`.
    DAEMON_OFFLINE_GRACE_MS: config.HEARTBEAT_SEC * config.MISSED_BEATS * 1000,
    ...(config.PUBLIC_CP_URL ? { PUBLIC_CP_URL: config.PUBLIC_CP_URL } : {}),
    ...(config.PUBLIC_MCP_URL ? { PUBLIC_MCP_URL: config.PUBLIC_MCP_URL } : {}),
    ...(config.DAEMON_DIST_TAG ? { DAEMON_DIST_TAG: config.DAEMON_DIST_TAG } : {}),
    ...(config.OIDC_ISSUER ? { OIDC_ISSUER: config.OIDC_ISSUER } : {}),
    ...(config.LOGTO_MGMT_ENDPOINT ? { OIDC_UPSTREAM: config.LOGTO_MGMT_ENDPOINT } : {}),
    ...(config.OIDC_AUDIENCE ? { OIDC_AUDIENCE: config.OIDC_AUDIENCE } : {}),
    WAITLIST_MODE: config.WAITLIST_MODE,
    ...(config.CORS_ORIGIN !== undefined ? { CORS_ORIGIN: config.CORS_ORIGIN } : {}),
    ...(config.PUBLIC_WEB_URL ? { PUBLIC_WEB_URL: config.PUBLIC_WEB_URL } : {}),
    ...(config.PUBLIC_RELAY_URL ? { PUBLIC_RELAY_URL: config.PUBLIC_RELAY_URL } : {}),
    ...(config.USAGE_INGEST_TOKEN ? { USAGE_INGEST_TOKEN: config.USAGE_INGEST_TOKEN } : {}),
    USAGE_COLLECTOR_SERVICE_ACCOUNT: config.USAGE_COLLECTOR_SERVICE_ACCOUNT,
    ...(config.S3_PUBLIC_BASE_URL ? { S3_PUBLIC_BASE_URL: config.S3_PUBLIC_BASE_URL } : {}),
    RELAY_STALE_MS: relayStaleMs
  }
}
