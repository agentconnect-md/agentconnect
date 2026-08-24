/**
 * `buildHttpApp` — the C2 BFF composition root for tests (design §5.3, §6 Phase 4).
 *
 * Wires the real C6 repos (over the shared Testcontainers `PrismaClient`) to the
 * `DaemonRegistryService`, the `DaemonAuthService`, and an
 * `InMemorySessionEventSink`, then assembles the Fastify instance via the SAME
 * `buildHttpServer(deps)` production uses. The `humanAuth` plane runs the devAuth
 * stub (no `OIDC_ISSUER`). Tests drive it with `app.inject` — DB-backed, NO socket.
 */
import type { FastifyInstance } from 'fastify'
import type { PrismaClient } from '../../src/generated/prisma/client.js'
import {
  PgAgentRepo,
  PgAssignmentRepo,
  PgCronRepo,
  PgHookRepo,
  PgHookSecretStore,
  PgRelayRepo,
  PgSessionRepo,
  PgSessionUsageRepo,
  PgWebchatConversationRepo,
  PgWebchatMcpDelegationRepo,
  PgWebchatMcpAccessGrantRepo,
  PgWebchatMcpOperationRepo,
  PgDaemonRepo,
  PgDaemonLifecycleOpRepo,
  PgApiKeyRepo,
  PgOAuthRepo,
  PgAuditRepo,
  PgRuntimeProfileRepo,
  PgLaunchRepo,
  PgUserRepo,
  PgGithubInstallationRepo,
  PgAgentRepoAuthorizationRepo,
  PgCodeHostRepositoryRepo,
  PgGitlabConnectionRepo,
  PgGitlabAgentAccountRepo,
  PgGitlabInstanceStateStore,
  PgGitlabProjectBindingRepo,
  PgGitlabProjectCredentialRepo,
  PgGitlabProjectCredentialSecretStore,
  PgGitlabWebhookSecretStore,
  PgOrgRepo,
  PgOrgInviteLinkRepo,
  PgWaitlistRepo,
  PgIntegrationRepo,
  PgBotRepo,
  PgBotSecretStore,
  PgBotCredentialWriter,
  PgAgentSecretStore,
  PgAgentConfigWriter,
  PgMemoryConnectionWriter,
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
  PgSlackInstallStore,
  PgSlackPlatformInstallStore,
  PgFeishuAppRegistrationStore,
  PgThreadAffinityStore,
  PgSlackUserConfigStore,
  PgPresetAgentStore,
  PgIntegrationChannelRepo,
  PgDutyGroupRepo
} from '../../src/persistence/index.js'
import { PgMemberSetRepo } from '../../src/persistence/repositories/member-set.repo.js'
import { PlaintextSecretCipher } from '../../src/secrets/cipher.js'
import { runWithSharedTx, withSharedTxRouting } from '../../src/persistence/ambient-tx.js'
import { AgentSpecAssembler } from '../../src/orchestrator/agentSpecAssembler.js'
import { DaemonRegistryService } from '../../src/registry/registryService.js'
import { DaemonAuthService } from '../../src/registry/authService.js'
import { ApiKeyCodec } from '../../src/registry/apiKey.js'
import { ApiKeyService } from '../../src/registry/apiKeyService.js'
import { OAuthService } from '../../src/registry/oauthService.js'
import { WebchatTokenService } from '../../src/registry/webchatToken.js'
import { WebchatMcpGrantTokenCodec } from '../../src/registry/webchatMcpGrantToken.js'
import { OrgInviteLinkCodec } from '../../src/registry/orgInviteLink.js'
import { OrgInviteLinkService } from '../../src/registry/orgInviteLinkService.js'
import { WaitlistService } from '../../src/registry/waitlistService.js'
import { EpochService } from '../../src/orchestrator/epoch.js'
import { DUTY_LEASE_DEFAULTS } from '../../src/orchestrator/dutyLease.js'
import { ControlSender } from '../../src/orchestrator/outbound.js'
import { AgentDelivery } from '../../src/orchestrator/agentDelivery.js'
import { PlacementResolver } from '../../src/orchestrator/placementResolver.js'
import { RelayControlSender } from '../../src/orchestrator/relayControl.js'
import { HttpBotOrchestrator } from '../../src/orchestrator/httpBot.js'
import { CollabRoutesService } from '../../src/orchestrator/collabRoutes.service.js'
import { AgentMutationGate } from '../../src/orchestrator/agentMutationGate.js'
import { ConnectionRegistry } from '../../src/ws/registry.js'
import { RelayRegistry } from '../../src/ws/relay-registry.js'
import { InMemorySessionEventSink } from '../../src/events/sink.js'
import { SessionUsageWriter } from '../../src/usage/writer.js'
import { HookService } from '../../src/hooks/hook.service.js'
import { GitlabHookRerunService } from '../../src/gitlab/hook-rerun.service.js'
import { buildHttpServer } from '../../src/http/server.js'
import type { HttpDeps } from '../../src/http/deps.js'
import { buildCpPlatformRegistry } from '../../src/platforms/registry.js'
import { botIdentityProjector } from '../../src/platforms/bot-identity.js'
import type { CpPlatformRegistry } from '../../src/platforms/provider.js'
import { createTelegramCpProvider } from '../../src/platforms/telegram/provider.js'
import { createDiscordCpProvider } from '../../src/platforms/discord/provider.js'
import { createSlackCpProvider, createSlackToolingCredentials } from '../../src/platforms/slack/provider.js'
import { createFeishuCpProvider } from '../../src/platforms/feishu/provider.js'
import { slackInstallRoutes, slackConfigRoutes, slackOauthCallbackRoutes } from '../../src/http/routes/slack-install.js'
import {
  slackPlatformInstallRoutes,
  slackPlatformCallbackRoutes
} from '../../src/http/routes/slack-platform-install.js'
import { feishuRegistrationRoutes } from '../../src/http/routes/feishu-registration.js'
import { slackBotRefreshRoutes } from '../../src/http/routes/slack-bot-refresh.js'
import { telegramCheckRoutes } from '../../src/http/routes/telegram-check.js'
import type { FeishuRouteSeams, SlackRouteSeams, TelegramRouteSeams } from '../../src/http/platform-route-seams.js'
import type { SlackConfigApi } from '../../src/http/slack-config-api.js'
import type { SlackBotVerifier, SlackAppTokenVerifier } from '../../src/http/slack-identity.js'
import type { SlackPlatformAppConfig } from '../../src/config/slack-platform.js'
import type { TelegramBotVerifier } from '../../src/http/telegram-identity.js'
import type { TelegramBotIconSyncer } from '../../src/http/telegram-bot-profile.js'
import type { DiscordBotVerifier, DiscordMessageContentIntentEnsurer } from '../../src/http/discord-identity.js'
import type { DiscordBotProfileSyncer } from '../../src/http/discord-bot-profile.js'
import type { FeishuAppTenantGuard, FeishuBotVerifier } from '../../src/http/feishu-identity.js'
import type { FeishuHttpAppConfigurator } from '../../src/http/feishu-app-config.js'
import type { FeishuAppIconSyncer } from '../../src/http/feishu-app-icon.js'
import { createReadiness } from '../../src/http/readiness.js'
import { McpRateLimiter } from '../../src/http/mcp/rate-limit.js'
import { RemoteGrantAuthenticator } from '../../src/http/mcp/remote-grant-authenticator.js'
import { InternalInvocationAuth } from '../../src/http/mcp/internal-invocation-auth.js'
import { findTool } from '../../src/http/mcp/tools.js'
import { pingDb } from '../../src/persistence/prisma.js'
import type { DaemonLiveness } from '../../src/ports.js'
import { systemClock } from '../../src/domain/clock.js'
import { DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { FeishuAppRegistrationService } from '../../src/http/feishu-registration.js'

export const TEST_API_KEY_PEPPER = 'test-api-key-pepper-0123456789abcdef'

/**
 * The per-platform provider seams a suite may stub — the offline injectability
 * that used to live as twelve platform-named fields on `HttpDeps` before the §9
 * DI collapse. It is a TEST-COMPOSITION bag, not a production type: prod builds
 * the same values in `container.ts` and hands them straight to the route
 * factories and the providers.
 *
 * MUTABLE AND READ THROUGH, deliberately. Suites swap members AFTER `buildApp`
 * (`app.platformStubs.verifySlackBot = …`), so every provider/route seam below
 * closes over THIS OBJECT and dereferences the member per call — never captures
 * the function. That is the same late-binding discipline the `platforms`
 * registry façade uses, and it is what the DI collapse had to preserve.
 */
export interface PlatformStubs {
  verifySlackBot?: SlackBotVerifier
  verifySlackAppToken?: SlackAppTokenVerifier
  slackConfigApi?: SlackConfigApi
  slackPlatformApp?: SlackPlatformAppConfig
  verifyTelegramBot: TelegramBotVerifier
  syncTelegramBotIcon?: TelegramBotIconSyncer
  verifyDiscordBot?: DiscordBotVerifier
  ensureDiscordMessageContentIntent: DiscordMessageContentIntentEnsurer
  syncDiscordBotProfile?: DiscordBotProfileSyncer
  verifyFeishuBot?: FeishuBotVerifier
  feishuAppTenantGuard: FeishuAppTenantGuard
  configureFeishuHttpApp: FeishuHttpAppConfigurator
  syncFeishuAppIcon?: FeishuAppIconSyncer
  feishuAppRegistration: FeishuAppRegistrationService
}

/** The keys `buildHttpApp` peels out of its overrides bag into
 *  {@link PlatformStubs} — everything else stays a core dep override. */
const PLATFORM_STUB_KEYS = [
  'verifySlackBot',
  'verifySlackAppToken',
  'slackConfigApi',
  'slackPlatformApp',
  'verifyTelegramBot',
  'syncTelegramBotIcon',
  'verifyDiscordBot',
  'ensureDiscordMessageContentIntent',
  'syncDiscordBotProfile',
  'verifyFeishuBot',
  'feishuAppTenantGuard',
  'configureFeishuHttpApp',
  'syncFeishuAppIcon',
  'feishuAppRegistration'
] as const satisfies readonly (keyof PlatformStubs)[]

export interface HttpApp {
  app: FastifyInstance
  deps: HttpDeps
  /** Swap a platform seam here — before or AFTER the app is built. */
  platformStubs: PlatformStubs
  events: InMemorySessionEventSink
  /** The relay registry — a test can `add` a fake {@link RelayChannel} so
   *  `hasConnectedRelay()` is true (e.g. to exercise the http-transport paths). */
  relayReg: RelayRegistry
  close(): Promise<void>
}

/** Empty liveness: no daemon is "connected right now" unless a test overrides it. */
const NO_LIVENESS: DaemonLiveness = { get: () => undefined }

/** Stable per-name repo id for the offline GitHub stand-in — distinct names get
 *  distinct ids, and one name keeps its id across calls and across apps. */
function fakeRepoId(fullName: string): bigint {
  let h = 2166136261n
  for (const ch of fullName) h = ((h ^ BigInt(ch.codePointAt(0)!)) * 16777619n) & 0xffffffffn
  return h + 1n
}

export function buildHttpApp(
  prisma: PrismaClient,
  configOverrides?: Partial<HttpDeps['config']>,
  liveness: DaemonLiveness = NO_LIVENESS,
  control?: ControlSender,
  // TOP-LEVEL deps and/or platform stubs (e.g. slackConfigApi, verifySlack*) —
  // the platform keys are peeled into `platformStubs` and the rest merged last, so
  // a test can register funnel routes that gate on these at plugin-registration
  // time. Nested config goes through `configOverrides`, not here.
  // The gitlab seam's rerun authorizer is filled in below from the same repos,
  // so a suite wires only `{ oauth, provisioner, fetchImpl }`.
  depsOverrides?: Partial<Omit<HttpDeps, 'gitlab'>> &
    Partial<PlatformStubs> & {
      gitlab?: Omit<NonNullable<HttpDeps['gitlab']>, 'hookRerun'> & { hookRerun?: GitlabHookRerunService }
    }
): HttpApp {
  const clock = systemClock
  // Mirror the prod graph: WAITLIST_MODE gates JIT personal-org creation and drives
  // the admission checks (waitlist-and-login.md §6/§8). Read from the test's overrides.
  const waitlistMode = configOverrides?.WAITLIST_MODE ?? false

  // Mirror the composition root's shared-transaction seam (§8): repos see the
  // router; transaction OPENING stays on the root client.
  const rootPrisma = prisma
  prisma = withSharedTxRouting(prisma)

  const daemonRepo = new PgDaemonRepo(prisma)
  const daemonLifecycleOpRepo = new PgDaemonLifecycleOpRepo(prisma)
  const apiKeyRepo = new PgApiKeyRepo(prisma)
  const oauthRepo = new PgOAuthRepo(prisma)
  const auditRepo = new PgAuditRepo(prisma)
  const codec = new ApiKeyCodec({ API_KEY_PEPPER: TEST_API_KEY_PEPPER })
  const epoch = new EpochService(daemonRepo, clock)
  const apiKeyService = new ApiKeyService(codec, apiKeyRepo, daemonRepo, auditRepo, clock)
  const inviteLinks = new OrgInviteLinkService(
    new OrgInviteLinkCodec(TEST_API_KEY_PEPPER),
    new PgOrgInviteLinkRepo(prisma),
    clock
  )
  const waitlistRepo = new PgWaitlistRepo(prisma)
  const waitlist = new WaitlistService(TEST_API_KEY_PEPPER, waitlistRepo, clock)

  const events = new InMemorySessionEventSink()

  // Default: an empty connection registry ⇒ every agent/upsert|remove throws
  // NoConnection (swallowed by the route). Tests that assert the emit inject a
  // spy `control` instead.
  const connReg = new ConnectionRegistry()
  const sender = control ?? new ControlSender(connReg, new PgLaunchRepo(prisma))

  const dutyGroupRepo = new PgDutyGroupRepo(prisma)
  const memberSets = new PgMemberSetRepo(prisma)

  const cipher = new PlaintextSecretCipher()
  const agentSecretStore = new PgAgentSecretStore(prisma, cipher)
  const integrationRepo = new PgIntegrationRepo(prisma)
  // The D6 identity projection reads the registry at bot-row WRITE time; the
  // façade it reads through is bound further down (see the LATE-BOUND note), so
  // the extra arrow defers the `platforms` reference past its declaration.
  const botRepo = new PgBotRepo(prisma, (input) => botIdentityProjector(platforms)(input))
  const botSecretStore = new PgBotSecretStore(prisma, cipher)
  const botCredentialWriter = new PgBotCredentialWriter(prisma, cipher)
  const feishuAppRegistrationStore = new PgFeishuAppRegistrationStore(prisma, cipher)
  const slackUserConfigStore = new PgSlackUserConfigStore(prisma, cipher)
  const integrationChannelRepo = new PgIntegrationChannelRepo(prisma)
  const agentRepo = new PgAgentRepo(prisma)
  const orgRepo = new PgOrgRepo(prisma)
  const webchatConversationRepo = new PgWebchatConversationRepo(prisma)
  const webchatMcpDelegationRepo = new PgWebchatMcpDelegationRepo(prisma)
  const webchatMcpAccessGrantRepo = new PgWebchatMcpAccessGrantRepo(prisma)
  const webchatMcpOperationRepo = new PgWebchatMcpOperationRepo(prisma)
  const sessionRepo = new PgSessionRepo(prisma)
  const sessionUsageRepo = new PgSessionUsageRepo(prisma)
  const skillSourceRepo = new PgSkillSourceRepo(prisma)
  const organizationKnowledgeRepo = new PgOrganizationKnowledgeRepo(prisma)
  // The organization environment registry + its ONE cipher seam, shared by the
  // resolver and the spec assembler exactly as the production graph wires them.
  const organizationEnvironmentSecretStore = new PgOrganizationEnvironmentSecretStore(prisma, cipher)
  const organizationEnvironmentRepo = new PgOrganizationEnvironmentRepo(prisma)
  const organizationEnvironmentResolver = new PgOrganizationEnvironmentResolver(
    prisma,
    organizationEnvironmentSecretStore
  )
  const presetAgentRepo = new PgPresetAgentStore(prisma)
  const hookRepo = new PgHookRepo(prisma)
  const registryService = new DaemonRegistryService(
    daemonRepo,
    new PgRuntimeProfileRepo(prisma),
    daemonLifecycleOpRepo,
    clock
  )
  const hookSecretStore = new PgHookSecretStore(prisma, cipher)
  const githubInstallationRepo = new PgGithubInstallationRepo(prisma)
  const agentRepoAuthRepo = new PgAgentRepoAuthorizationRepo(prisma)
  // An empty relay registry ⇒ multi-agent installs 409 (no relay) and hook broadcasts are
  // no-ops — exactly the prod graph with no relay dialed in, unless a test wires one up.
  const relayReg = new RelayRegistry()
  const relayControl = new RelayControlSender(relayReg)
  // Same graph as prod: every replicate site resolves its targets here, so the
  // duty ledger is a real repo and a holder actually receives the pushes.
  const placementResolver = new PlacementResolver({
    duties: dutyGroupRepo,
    liveMembers: async (setId) => {
      const members = new Set(await memberSets.memberIdsOf(setId))
      return connReg
        .reachableDaemons()
        .filter((d) => d.state === 'READY' && members.has(d.daemonId))
        .map((d) => d.daemonId)
    },
    clock
  })
  const remoteGrantAuth =
    depsOverrides?.remoteGrantAuth ??
    new RemoteGrantAuthenticator({
      clock,
      tokenCodec: new WebchatMcpGrantTokenCodec(TEST_API_KEY_PEPPER),
      conversations: webchatConversationRepo,
      orgs: orgRepo,
      agents: agentRepo,
      presets: presetAgentRepo,
      daemons: liveness,
      placement: placementResolver,
      grants: webchatMcpAccessGrantRepo,
      authorities: webchatMcpDelegationRepo,
      sessions: sessionRepo,
      isCuratedTool: (toolName) => findTool(toolName) !== undefined
    })
  const internalInvocationAuth = depsOverrides?.internalInvocationAuth ?? new InternalInvocationAuth()

  const agentSpecs = new AgentSpecAssembler(
    agentSecretStore,
    {},
    skillSourceRepo,
    organizationKnowledgeRepo,
    undefined,
    organizationEnvironmentResolver,
    undefined,
    agentRepoAuthRepo,
    depsOverrides?.gitlab?.api.baseUrl,
    hookRepo
  )
  const agentDelivery = new AgentDelivery({ control: sender, specs: agentSpecs, placement: placementResolver })

  // LATE-BOUND exactly as `buildContainer` binds it (§9): the providers below are
  // constructed WITH this dep bundle, because their funnel plugins are route
  // factories pre-bound to it, so the registry cannot exist before the object
  // does. `platforms` is the same stable façade the container hands to the
  // orchestrators, which take the registry BY VALUE at construction — every read
  // through it runs at request / reconcile time, long after assignment. The
  // providers' verify seams READ THROUGH to `platformStubs` on every call instead
  // of capturing it: suites routinely swap `app.platformStubs.verifySlackBot` (and
  // friends) AFTER the app is built, and an absent stub is passed through as the
  // provider-unreachable outcome — which every provider treats exactly as the
  // old route treated "no verifier injected" (inconclusive: no 400, no derived
  // identity).
  let platformRegistry: CpPlatformRegistry | undefined = undefined
  const requirePlatforms = (): CpPlatformRegistry => {
    if (!platformRegistry) throw new Error('platform registry read before composition')
    return platformRegistry
  }
  const platforms: CpPlatformRegistry = {
    get: (platformId) => requirePlatforms().get(platformId),
    all: () => requirePlatforms().all(),
    ids: () => requirePlatforms().ids()
  }

  // Peel the platform seams out of the overrides bag: they are no longer core
  // deps (§9 DI collapse), but suites still hand them in at build time so the
  // funnel plugins that gate on them register.
  const coreOverrides: Partial<HttpDeps> = { ...depsOverrides } as Partial<HttpDeps>
  for (const key of PLATFORM_STUB_KEYS) delete (coreOverrides as Record<string, unknown>)[key]
  const platformStubs: PlatformStubs = {
    verifyTelegramBot: async () => ({ status: 'ok', name: null, privacyModeDisabled: true }),
    ensureDiscordMessageContentIntent: async () => 'ready',
    configureFeishuHttpApp: async () => {},
    feishuAppTenantGuard: {
      loginAppStatus: async () => 'ok',
      checkApp: async () => 'ok'
    },
    feishuAppRegistration: new FeishuAppRegistrationService(feishuAppRegistrationStore),
    ...Object.fromEntries(
      PLATFORM_STUB_KEYS.filter((key) => depsOverrides && key in depsOverrides).map((key) => [
        key,
        (depsOverrides as Record<string, unknown>)[key]
      ])
    )
  }

  const hookService = new HookService(
    hookRepo,
    hookSecretStore,
    agentRepo,
    relayControl,
    placementResolver,
    githubInstallationRepo,
    'agentconnect-test',
    undefined,
    depsOverrides?.gitlab ? new PgGitlabProjectBindingRepo(prisma) : undefined,
    depsOverrides?.gitlab ? new PgGitlabWebhookSecretStore(prisma, cipher) : undefined,
    depsOverrides?.gitlab ? new PgGitlabAgentAccountRepo(prisma) : undefined,
    // §24.4: the axis the fake GitLab edge serves rides every compiled gitlab rule, and the
    // hook agent's spec is re-projected in the same ordered sequence production uses.
    depsOverrides?.gitlab?.api.baseUrl,
    async (orgId, agentId) => {
      const agent = await agentRepo.get(orgId, agentId)
      if (!agent) return
      await (depsOverrides?.agentDelivery ?? agentDelivery).upsert(agent, () => {})
    }
  )
  // The §16.1 rerun authorizer rides the gitlab seam; a suite may still override it.
  if (coreOverrides.gitlab && !coreOverrides.gitlab.hookRerun) {
    coreOverrides.gitlab = {
      ...coreOverrides.gitlab,
      hookRerun: new GitlabHookRerunService({
        hooks: hookRepo,
        agents: agentRepo,
        bindings: new PgGitlabProjectBindingRepo(prisma),
        accounts: new PgGitlabAgentAccountRepo(prisma),
        credentials: new PgGitlabProjectCredentialRepo(prisma),
        credentialSecrets: new PgGitlabProjectCredentialSecretStore(prisma, cipher),
        hookService,
        relayControl,
        api: coreOverrides.gitlab.api
      })
    }
  }

  const deps: HttpDeps = {
    runtimeConfig: {},
    maxOrgsPerNonAdminUser: 1,
    clock,
    repos: {
      agent: agentRepo,
      assignment: new PgAssignmentRepo(prisma),
      memberSet: memberSets,
      dutyGroup: dutyGroupRepo,
      daemonLifecycleOp: daemonLifecycleOpRepo,
      cron: new PgCronRepo(prisma),
      hook: hookRepo,
      hookSecret: hookSecretStore,
      relay: new PgRelayRepo(prisma),
      session: sessionRepo,
      sessionUsage: sessionUsageRepo,
      webchatConversation: webchatConversationRepo,
      user: new PgUserRepo(prisma, !waitlistMode),
      org: orgRepo,
      waitlist: waitlistRepo,
      githubInstallation: githubInstallationRepo,
      agentRepoAuth: agentRepoAuthRepo,
      codeHostRepository: new PgCodeHostRepositoryRepo(prisma),
      gitlabConnection: new PgGitlabConnectionRepo(prisma),
      gitlabProjectBinding: new PgGitlabProjectBindingRepo(prisma),
      gitlabAgentAccount: new PgGitlabAgentAccountRepo(prisma),
      gitlabInstanceState: new PgGitlabInstanceStateStore(prisma),
      integration: integrationRepo,
      bot: botRepo,
      botSecret: botSecretStore,
      botCredential: botCredentialWriter,
      agentSecret: agentSecretStore,
      agentConfig: new PgAgentConfigWriter(prisma, cipher),
      mcpProvider: new PgMcpProviderRepo(prisma),
      mcpProviderSecret: new PgMcpProviderSecretStore(prisma, cipher),
      mcpGrant: new PgMcpGrantRepo(prisma, cipher),
      skillSource: skillSourceRepo,
      organizationKnowledge: organizationKnowledgeRepo,
      organizationEnvironment: organizationEnvironmentRepo,
      organizationEnvironmentSecret: organizationEnvironmentSecretStore,
      organizationEnvironmentResolver,
      memoryPluginInstallation: new PgMemoryPluginInstallationRepo(prisma),
      externalMemoryConnection: new PgExternalMemoryConnectionRepo(prisma),
      externalMemoryConnectionSecret: new PgExternalMemoryConnectionSecretStore(prisma, cipher),
      externalMemoryGrant: new PgExternalMemoryGrantRepo(prisma, cipher),
      memoryConnectionWriter: new PgMemoryConnectionWriter(prisma, cipher),
      slackInstall: new PgSlackInstallStore(prisma, cipher),
      slackPlatformInstall: new PgSlackPlatformInstallStore(prisma),
      feishuAppRegistration: feishuAppRegistrationStore,
      slackUserConfig: slackUserConfigStore,
      presetAgent: presetAgentRepo,
      integrationChannel: integrationChannelRepo,
      audit: auditRepo,
      webchatMcpOperation: webchatMcpOperationRepo,
      oauth: oauthRepo
    },
    registry: registryService,
    platforms,
    agentSpecs,
    liveness,
    // Capability reads share the liveness fake: a test that needs a capable
    // daemon overrides `liveness` with one whose entries carry `capabilities`.
    daemonConns: liveness as HttpDeps['daemonConns'],
    control: sender,
    agentDelivery,
    placementResolver,
    relayControl,
    httpBot: new HttpBotOrchestrator(
      botRepo,
      botSecretStore,
      botCredentialWriter,
      integrationRepo,
      integrationChannelRepo,
      agentRepo,
      relayReg,
      sender,
      new PgThreadAffinityStore(prisma),
      new PgSessionRepo(prisma),
      { info() {}, warn() {}, debug() {} },
      platforms,
      agentDelivery,
      placementResolver
    ),
    collabRoutes: new CollabRoutesService(
      daemonRepo,
      integrationRepo,
      agentRepo,
      relayControl,
      sender,
      placementResolver,
      dutyGroupRepo
    ),
    agentMutations: new AgentMutationGate(),
    sessionOwners: connReg,
    // The installations repo feeds the github-kind compile — same graph as prod.
    // gitlab-kind compile sources appear exactly when the test wires a gitlab seam.
    hooks: hookService,
    auth: new DaemonAuthService(
      codec,
      apiKeyRepo,
      epoch,
      clock,
      { HEARTBEAT_SEC: 15, DUTY_LEASE_MS: DUTY_LEASE_DEFAULTS.leaseMs },
      new PgOrgRepo(prisma),
      memberSets
    ),
    apiKeys: apiKeyService,
    oauth: new OAuthService(oauthRepo, apiKeyService, codec, clock),
    webchatTokens: new WebchatTokenService(TEST_API_KEY_PEPPER),
    inviteLinks,
    waitlist,
    usageWriter: new SessionUsageWriter(sessionUsageRepo),
    events,
    mcpRateLimit: new McpRateLimiter(clock),
    sharedTx: <T>(fn: () => Promise<T>) => rootPrisma.$transaction((tx) => runWithSharedTx(tx, fn)),
    readiness: createReadiness(() => pingDb(prisma)),
    // Offline stand-in for the anonymous GitHub read that binds a skill source's
    // numeric identity: every repo resolves, to a deterministic id per owner/repo.
    // Suites that care about the unbindable paths override this dep.
    resolvePublicRepo: async (owner: string, repo: string) => ({
      repoId: fakeRepoId(`${owner}/${repo}`),
      fullName: `${owner}/${repo}`,
      private: false,
      defaultBranch: 'main'
    }),
    config: { DEFAULT_OWNER_ID, ...configOverrides },
    sessionAccessPlugins: [
      { provider: 'slack', available: false, resolve: async () => ({ allowedScopes: [], degraded: false }) },
      { provider: 'github', available: false, resolve: async () => ({ allowedScopes: [], degraded: false }) },
      {
        provider: 'feishu',
        available: false,
        resolve: async () => ({ allowedScopes: [], degraded: false })
      }
    ],
    ...coreOverrides,
    remoteGrantAuth,
    internalInvocationAuth
  }

  // The per-platform route seams, mirroring `buildContainer`'s — but every member
  // reads THROUGH the mutable `platformStubs` bag rather than capturing its value,
  // so a suite that swaps a stub after `buildApp` is still observed. `configApi`
  // and `platformApp` are getters for exactly that reason: the funnel plugins read
  // them once at plugin-registration time to decide whether to register at all
  // (that IS the feature flag, so they must be set before the app is built), while
  // the manifest-refresh handler reads `configApi` per REQUEST — which is what it
  // did when it was core code reading `deps.slackConfigApi`.
  //
  // ANTI-DRIFT (learned the hard way in review): this harness once handed the
  // tooling facet an API client the container had stopped passing, so every suite
  // was green against a composition production did not have. Both roots now call
  // {@link createSlackToolingCredentials} with the SAME two named arguments, and
  // the API client here comes from ONE source shared with `slackSeams.configApi`
  // — the harness cannot give the facet a client the routes do not see. The
  // container graph itself is exercised in
  // `test/integration/slack-tooling-credentials.route.test.ts`.
  const slackConfigApiSeam = () => platformStubs.slackConfigApi
  const slackSeams: SlackRouteSeams = {
    get configApi() {
      return slackConfigApiSeam()
    },
    get platformApp() {
      return platformStubs.slackPlatformApp
    },
    verifyBot: async (token) =>
      platformStubs.verifySlackBot ? platformStubs.verifySlackBot(token) : { status: 'unreachable' },
    verifyAppToken: async (token) =>
      platformStubs.verifySlackAppToken ? platformStubs.verifySlackAppToken(token) : ('unreachable' as const),
    toolingCredentials: createSlackToolingCredentials({
      get configApi() {
        return slackConfigApiSeam()
      },
      store: slackUserConfigStore
    })
  }
  const telegramSeams: TelegramRouteSeams = { verifyBot: (token) => platformStubs.verifyTelegramBot(token) }
  const feishuSeams: FeishuRouteSeams = {
    verifyBot: async (appId, appSecret, region) =>
      platformStubs.verifyFeishuBot
        ? platformStubs.verifyFeishuBot(appId, appSecret, region)
        : { status: 'unreachable' },
    tenantGuard: platformStubs.feishuAppTenantGuard,
    configureHttpApp: (input) => platformStubs.configureFeishuHttpApp(input),
    registrations: platformStubs.feishuAppRegistration
  }

  // The same four providers `buildContainer` registers, so the create route
  // parses/validates exactly the deployed shapes and `server.ts` mounts exactly
  // the deployed funnel routes. Two deliberate test-composition traits:
  //
  //  - the verify/sync seams READ THROUGH to `platformStubs` on every call
  //    instead of capturing it — tests routinely swap
  //    `app.platformStubs.verifySlackBot` (and friends) AFTER the app is built.
  //    An absent stub is passed through as the provider-unreachable outcome,
  //    which every provider treats exactly as today's route treated "no verifier
  //    injected" (inconclusive: no 400, no derived identity);
  //  - the route plugins are pre-bound to `deps` + the seams above, mirroring
  //    prod. Each still self-disables on absent config (no `slackConfigApi` /
  //    `PUBLIC_CP_URL` ⇒ those routes 404), so a suite that wants them injects
  //    the config.
  platformRegistry = buildCpPlatformRegistry([
    createTelegramCpProvider({
      verifyBot: (token) => platformStubs.verifyTelegramBot(token),
      syncBotIcon: async (token, agent) => platformStubs.syncTelegramBotIcon?.(token, agent),
      funnelRoutes: { org: [telegramCheckRoutes(deps, telegramSeams)], publicCallback: [] }
    }),
    createDiscordCpProvider({
      verifyBot: async (token) =>
        platformStubs.verifyDiscordBot ? platformStubs.verifyDiscordBot(token) : { status: 'unreachable' },
      ensureMessageContentIntent: (token) => platformStubs.ensureDiscordMessageContentIntent(token),
      syncBotProfile: async (token, agent) => platformStubs.syncDiscordBotProfile?.(token, agent)
    }),
    createSlackCpProvider({
      verifyBot: slackSeams.verifyBot!,
      verifyAppToken: slackSeams.verifyAppToken!,
      funnelRoutes: {
        org: [
          slackInstallRoutes(deps, slackSeams),
          slackPlatformInstallRoutes(deps, slackSeams),
          slackConfigRoutes(deps, slackSeams),
          slackBotRefreshRoutes(deps, slackSeams)
        ],
        publicCallback: [slackOauthCallbackRoutes(deps, slackSeams), slackPlatformCallbackRoutes(deps, slackSeams)]
      },
      toolingCredentials: slackSeams.toolingCredentials!
    }),
    createFeishuCpProvider({
      verifyBot: feishuSeams.verifyBot!,
      tenantGuard: feishuSeams.tenantGuard,
      funnelRoutes: { org: [feishuRegistrationRoutes(deps, feishuSeams)], publicCallback: [] },
      syncAppIcon: async (appId, appSecret, region, agent) =>
        platformStubs.syncFeishuAppIcon?.(appId, appSecret, region, agent)
    })
  ])

  const app = buildHttpServer(deps)

  return {
    app,
    deps,
    platformStubs,
    events,
    relayReg,
    close: async () => {
      await app.close()
    }
  }
}
