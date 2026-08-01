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
  PgOrgRepo,
  PgOrgInviteLinkRepo,
  PgWaitlistRepo,
  PgIntegrationRepo,
  PgBotRepo,
  PgBotSecretStore,
  PgBotCredentialWriter,
  PgAgentSecretStore,
  PgAgentConfigWriter,
  PgMcpProviderRepo,
  PgMcpProviderSecretStore,
  PgMcpGrantRepo,
  PgSkillSourceRepo,
  PgOrganizationKnowledgeRepo,
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
  PgIntegrationChannelRepo
} from '../../src/persistence/index.js'
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
import { ControlSender } from '../../src/orchestrator/outbound.js'
import { RelayControlSender } from '../../src/orchestrator/relayControl.js'
import { HttpBotOrchestrator } from '../../src/orchestrator/httpBot.js'
import { CollabRoutesService } from '../../src/orchestrator/collabRoutes.service.js'
import { AgentMutationGate } from '../../src/orchestrator/agentMutationGate.js'
import { ExclusiveMutationGate } from '../../src/orchestrator/exclusiveMutationGate.js'
import { ConnectionRegistry } from '../../src/ws/registry.js'
import { RelayRegistry } from '../../src/ws/relay-registry.js'
import { InMemorySessionEventSink } from '../../src/events/sink.js'
import { HookService } from '../../src/hooks/hook.service.js'
import { buildHttpServer } from '../../src/http/server.js'
import type { HttpDeps } from '../../src/http/deps.js'
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

export interface HttpApp {
  app: FastifyInstance
  deps: HttpDeps
  events: InMemorySessionEventSink
  /** The relay registry — a test can `add` a fake {@link RelayChannel} so
   *  `hasConnectedRelay()` is true (e.g. to exercise the http-transport paths). */
  relayReg: RelayRegistry
  close(): Promise<void>
}

/** Empty liveness: no daemon is "connected right now" unless a test overrides it. */
const NO_LIVENESS: DaemonLiveness = { get: () => undefined }

export function buildHttpApp(
  prisma: PrismaClient,
  configOverrides?: Partial<HttpDeps['config']>,
  liveness: DaemonLiveness = NO_LIVENESS,
  control?: ControlSender,
  // TOP-LEVEL deps only (e.g. slackConfigApi, verifySlack*) — merged last so a
  // test can register funnel routes that gate on these at plugin-registration time.
  // Nested config goes through `configOverrides`, not here.
  depsOverrides?: Partial<HttpDeps>
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

  const cipher = new PlaintextSecretCipher()
  const agentSecretStore = new PgAgentSecretStore(prisma, cipher)
  const integrationRepo = new PgIntegrationRepo(prisma)
  const botRepo = new PgBotRepo(prisma)
  const botSecretStore = new PgBotSecretStore(prisma, cipher)
  const botCredentialWriter = new PgBotCredentialWriter(prisma, cipher)
  const feishuAppRegistrationStore = new PgFeishuAppRegistrationStore(prisma, cipher)
  const integrationChannelRepo = new PgIntegrationChannelRepo(prisma)
  const agentRepo = new PgAgentRepo(prisma)
  const orgRepo = new PgOrgRepo(prisma)
  const webchatConversationRepo = new PgWebchatConversationRepo(prisma)
  const webchatMcpDelegationRepo = new PgWebchatMcpDelegationRepo(prisma)
  const webchatMcpAccessGrantRepo = new PgWebchatMcpAccessGrantRepo(prisma)
  const webchatMcpOperationRepo = new PgWebchatMcpOperationRepo(prisma)
  const sessionRepo = new PgSessionRepo(prisma)
  const skillSourceRepo = new PgSkillSourceRepo(prisma)
  const organizationKnowledgeRepo = new PgOrganizationKnowledgeRepo(prisma)
  const presetAgentRepo = new PgPresetAgentStore(prisma)
  const hookRepo = new PgHookRepo(prisma)
  const hookSecretStore = new PgHookSecretStore(prisma, cipher)
  const githubInstallationRepo = new PgGithubInstallationRepo(prisma)
  // An empty relay registry ⇒ multi-agent installs 409 (no relay) and hook broadcasts are
  // no-ops — exactly the prod graph with no relay dialed in, unless a test wires one up.
  const relayReg = new RelayRegistry()
  const relayControl = new RelayControlSender(relayReg)
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
      grants: webchatMcpAccessGrantRepo,
      authorities: webchatMcpDelegationRepo,
      sessions: sessionRepo,
      isCuratedTool: (toolName) => findTool(toolName) !== undefined
    })
  const internalInvocationAuth = depsOverrides?.internalInvocationAuth ?? new InternalInvocationAuth()

  const deps: HttpDeps = {
    clock,
    repos: {
      agent: agentRepo,
      assignment: new PgAssignmentRepo(prisma),
      daemonLifecycleOp: daemonLifecycleOpRepo,
      cron: new PgCronRepo(prisma),
      hook: hookRepo,
      hookSecret: hookSecretStore,
      relay: new PgRelayRepo(prisma),
      session: sessionRepo,
      sessionUsage: new PgSessionUsageRepo(prisma),
      webchatConversation: webchatConversationRepo,
      user: new PgUserRepo(prisma, !waitlistMode),
      org: orgRepo,
      waitlist: waitlistRepo,
      githubInstallation: githubInstallationRepo,
      agentRepoAuth: new PgAgentRepoAuthorizationRepo(prisma),
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
      memoryPluginInstallation: new PgMemoryPluginInstallationRepo(prisma),
      externalMemoryConnection: new PgExternalMemoryConnectionRepo(prisma),
      externalMemoryConnectionSecret: new PgExternalMemoryConnectionSecretStore(prisma, cipher),
      externalMemoryGrant: new PgExternalMemoryGrantRepo(prisma, cipher),
      slackInstall: new PgSlackInstallStore(prisma, cipher),
      slackPlatformInstall: new PgSlackPlatformInstallStore(prisma),
      feishuAppRegistration: feishuAppRegistrationStore,
      slackUserConfig: new PgSlackUserConfigStore(prisma, cipher),
      presetAgent: presetAgentRepo,
      integrationChannel: integrationChannelRepo,
      audit: auditRepo,
      webchatMcpOperation: webchatMcpOperationRepo,
      oauth: oauthRepo
    },
    registry: new DaemonRegistryService(daemonRepo, new PgRuntimeProfileRepo(prisma), daemonLifecycleOpRepo, clock),
    agentSpecs: new AgentSpecAssembler(agentSecretStore, {}, skillSourceRepo, organizationKnowledgeRepo),
    liveness,
    control: sender,
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
      { info() {}, warn() {}, debug() {} }
    ),
    collabRoutes: new CollabRoutesService(daemonRepo, integrationRepo, agentRepo, relayControl, sender),
    agentMutations: new AgentMutationGate(),
    memoryConnectionMutations: new ExclusiveMutationGate(),
    sessionOwners: connReg,
    // The installations repo feeds the github-kind compile — same graph as prod.
    hooks: new HookService(
      hookRepo,
      hookSecretStore,
      agentRepo,
      relayControl,
      githubInstallationRepo,
      'agentconnect-test'
    ),
    auth: new DaemonAuthService(codec, apiKeyRepo, epoch, clock, { HEARTBEAT_SEC: 15 }, new PgOrgRepo(prisma)),
    apiKeys: apiKeyService,
    oauth: new OAuthService(oauthRepo, apiKeyService, codec, clock),
    webchatTokens: new WebchatTokenService(TEST_API_KEY_PEPPER),
    inviteLinks,
    waitlist,
    events,
    mcpRateLimit: new McpRateLimiter(clock),
    sharedTx: <T>(fn: () => Promise<T>) => rootPrisma.$transaction((tx) => runWithSharedTx(tx, fn)),
    readiness: createReadiness(() => pingDb(prisma)),
    verifyTelegramBot: async () => ({ status: 'ok', name: null, privacyModeDisabled: true }),
    ensureDiscordMessageContentIntent: async () => 'ready',
    configureFeishuHttpApp: async () => {},
    feishuAppRegistration: new FeishuAppRegistrationService(feishuAppRegistrationStore),
    config: { DEFAULT_OWNER_ID, ...configOverrides },
    ...depsOverrides,
    remoteGrantAuth,
    internalInvocationAuth
  }

  const app = buildHttpServer(deps)

  return {
    app,
    deps,
    events,
    relayReg,
    close: async () => {
      await app.close()
    }
  }
}
