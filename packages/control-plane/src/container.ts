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
import { HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED } from '@agentconnect.md/protocol'

import { type AppConfig, resolveWebAppUrl } from './config/env.js'
import { resolveGithubAppConfig } from './github/config.js'
import type { FetchLike } from './github/api.js'
import { ConnectorsClient, parseWhitelist } from './connectors/index.js'
import { GithubService } from './github/service.js'
import { GithubInstallationDoorbell } from './github/installation-doorbell.service.js'
import { GithubCommentAuthzService } from './github/comment-authz.service.js'
import { GithubRerequestService } from './github/rerequest.service.js'
import { GithubReviewBrokerService } from './github/review-broker.service.js'
import { GithubRunCoordinator, GithubRunReporter } from './github/run-reporter.js'
import { githubProjectionIntent } from './github/projection-intent.js'
import { HookRedeliveryReconciler } from './orchestrator/hookRedeliveryReconciler.js'
import { LogtoIdentityService, resolveLogtoMgmtConfig } from './github/logto-identity.js'
import { GithubUserAuthzService } from './github/user-authz.js'
import { type Clock, systemClock } from './domain/clock.js'

import {
  PgDaemonRepo,
  PgDaemonLifecycleOpRepo,
  PgApiKeyRepo,
  PgOAuthRepo,
  PgRelayRepo,
  PgAgentRepo,
  PgAgentSecretStore,
  PgAgentConfigWriter,
  PgAssignmentRepo,
  PgSessionRepo,
  PgSessionUsageRepo,
  PgWebchatConversationRepo,
  PgLaunchRepo,
  PgSecretLeaseRepo,
  PgIntegrationRepo,
  PgIntegrationChannelRepo,
  PgBotRepo,
  PgBotSecretStore,
  PgMcpProviderRepo,
  PgMcpProviderSecretStore,
  PgMcpGrantRepo,
  PgSkillSourceRepo,
  PgMemoryPluginInstallationRepo,
  PgExternalMemoryConnectionRepo,
  PgExternalMemoryConnectionSecretStore,
  PgExternalMemoryGrantRepo,
  PgThreadAffinityStore,
  PgSlackInstallStore,
  PgSlackUserConfigStore,
  PgGithubInstallationRepo,
  PgGithubInstallStateStore,
  PgAgentRepoAuthorizationRepo,
  PgCronRepo,
  PgHookRepo,
  PgHookSecretStore,
  PgRuntimeProfileRepo,
  PgAuditRepo,
  PgUserRepo,
  PgOrgRepo,
  PgOrgInviteLinkRepo,
  PgWaitlistRepo
} from './persistence/index.js'

import { EpochService } from './orchestrator/epoch.js'
import { ControlSender, NoConnection } from './orchestrator/outbound.js'
import { AgentSpecAssembler } from './orchestrator/agentSpecAssembler.js'
import { Placement } from './orchestrator/placement.js'
import { Watchdog } from './orchestrator/watchdog.js'
import { CronRunReaper } from './orchestrator/cronRunReaper.js'
import { SlackInstallReaper } from './orchestrator/slackInstallReaper.js'
import { RelaySweeper } from './orchestrator/relaySweeper.js'
import { RelayRoster } from './orchestrator/relayRoster.js'
import { SharedBotOrchestrator } from './orchestrator/sharedBot.js'
import { SlackBotIdentityReconciler } from './orchestrator/slackBotIdentityReconciler.js'
import { slackConfigApi } from './http/slack-config-api.js'

import { ApiKeyCodec } from './registry/apiKey.js'
import { DaemonAuthService } from './registry/authService.js'
import { ApiKeyService } from './registry/apiKeyService.js'
import { OAuthService } from './registry/oauthService.js'
import { WebchatTokenService } from './registry/webchatToken.js'
import { OrgInviteLinkCodec } from './registry/orgInviteLink.js'
import { OrgInviteLinkService } from './registry/orgInviteLinkService.js'
import { WaitlistService } from './registry/waitlistService.js'
import { AgentId, DaemonId, HookId } from './domain/ids.js'
import { HookService } from './hooks/hook.service.js'
import { RelayAuthService } from './registry/relayAuthService.js'
import { DaemonRegistryService } from './registry/registryService.js'
import { DaemonReleaseResolver } from './registry/daemonRelease.js'

import { InMemorySessionEventSink } from './events/sink.js'
import { createIconStore } from './icons/icon-store.js'
import type { IconUrlBases } from './agents/agent-icon.js'

import type { SecretsProvider } from './secrets/providers/provider.js'
import { makeSecretsProvider } from './secrets/providers/memory.js'
import { SecretsBrokerService } from './secrets/secretsBroker.js'
import { makeSecretCipher, type SecretCipher } from './secrets/cipher.js'

import { ConnectionRegistry } from './ws/registry.js'
import { RelayRegistry } from './ws/relay-registry.js'
import { RelayControlSender } from './orchestrator/relayControl.js'
import { replayMcpTo } from './orchestrator/mcpReplay.js'
import { replayMemoryConnectionsTo, syncMemoryConnectionsToDaemons } from './orchestrator/memoryConnectionReplay.js'
import { relayHttpOrigin } from './orchestrator/mcpProvider.js'
import { CollabRoutesService } from './orchestrator/collabRoutes.service.js'
import { AgentMutationGate } from './orchestrator/agentMutationGate.js'
import { AgentMoveService } from './orchestrator/agentMove.js'
import { ExclusiveMutationGate } from './orchestrator/exclusiveMutationGate.js'
import { createDaemonWsServer } from './ws/gateway.js'
import type { DaemonWsServerDeps } from './ws/gateway.js'
import { createRelayWsServer } from './ws/relay-gateway.js'
import type { RelayWsServerDeps } from './ws/relay-gateway.js'

import { buildHttpServer } from './http/server.js'
import type { HttpDeps } from './http/deps.js'
import { createReadiness, type Readiness } from './http/readiness.js'
import { McpRateLimiter } from './http/mcp/rate-limit.js'
import { pingDb } from './persistence/prisma.js'
import { verifySlackBot, verifySlackAppToken } from './http/slack-identity.js'
import { resolveTelegramBotName } from './http/telegram-identity.js'
import { verifyDiscordBot } from './http/discord-identity.js'
import { verifyFeishuBot } from './http/feishu-identity.js'

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
  /** The process readiness gate — the bootstrap flips it at SIGTERM (`/readyz`). */
  readonly readiness: Readiness
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
  /** npm dist-tags fetch override for the daemon "latest version" resolver — tests
   *  stub it (absent under NODE_ENV=test ⇒ the resolver is inert, no network). */
  daemonReleaseFetch?: FetchLike
  /** open-connector admin API fetch override — integration tests stub it without
   *  network (absent under NODE_ENV=test ⇒ the connectors client is not assembled). */
  connectorsFetch?: FetchLike
  /** The at-rest transform every persisted secret VALUE passes through. Absent ⇒
   *  selected from `config.SECRET_CIPHER` (none → identity, vault-transit → Vault). */
  secretCipher?: SecretCipher
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
    launch: new PgLaunchRepo(prisma),
    lease: new PgSecretLeaseRepo(prisma),
    integration: new PgIntegrationRepo(prisma),
    integrationChannel: new PgIntegrationChannelRepo(prisma),
    bot: new PgBotRepo(prisma),
    botSecret: new PgBotSecretStore(prisma, secretCipher),
    agentSecret: new PgAgentSecretStore(prisma, secretCipher),
    agentConfig: new PgAgentConfigWriter(prisma, secretCipher),
    mcpProvider: new PgMcpProviderRepo(prisma),
    mcpProviderSecret: new PgMcpProviderSecretStore(prisma, secretCipher),
    mcpGrant: new PgMcpGrantRepo(prisma, secretCipher),
    skillSource: new PgSkillSourceRepo(prisma),
    memoryPluginInstallation: new PgMemoryPluginInstallationRepo(prisma),
    externalMemoryConnection: new PgExternalMemoryConnectionRepo(prisma),
    externalMemoryConnectionSecret: new PgExternalMemoryConnectionSecretStore(prisma, secretCipher),
    externalMemoryGrant: new PgExternalMemoryGrantRepo(prisma, secretCipher),
    threadAffinity: new PgThreadAffinityStore(prisma),
    slackInstall: new PgSlackInstallStore(prisma, secretCipher),
    slackUserConfig: new PgSlackUserConfigStore(prisma, secretCipher),
    cron: new PgCronRepo(prisma),
    hook: new PgHookRepo(prisma),
    hookSecret: new PgHookSecretStore(prisma, secretCipher),
    runtimeProfile: new PgRuntimeProfileRepo(prisma),
    audit: new PgAuditRepo(prisma),
    // Under WAITLIST_MODE, JIT signup does NOT mint a personal org — that happens
    // only on join-link redemption (waitlist-and-login.md §6/§8), so "login ⇒ has
    // an org" can't bypass the admission gate.
    user: new PgUserRepo(prisma, !config.WAITLIST_MODE),
    org: new PgOrgRepo(prisma),
    orgInviteLink: new PgOrgInviteLinkRepo(prisma),
    waitlist: new PgWaitlistRepo(prisma),
    githubInstallation: new PgGithubInstallationRepo(prisma),
    githubInstallState: new PgGithubInstallStateStore(prisma),
    agentRepoAuth: new PgAgentRepoAuthorizationRepo(prisma)
  }

  // ── C3/C4/C5 services ─────────────────────────────────────────────────────
  const epoch = new EpochService(repos.daemon, clock)

  const codec = new ApiKeyCodec({ API_KEY_PEPPER: config.API_KEY_PEPPER })
  const webAppUrl = resolveWebAppUrl(config)
  const auth = new DaemonAuthService(
    codec,
    repos.apiKey,
    epoch,
    clock,
    {
      HEARTBEAT_SEC: config.HEARTBEAT_SEC,
      // Web console origin for daemon-built session deep links: explicit PUBLIC_WEB_URL, else
      // a concrete CORS_ORIGIN (the browser console origin a two-origin deploy already lists),
      // else PUBLIC_CP_URL for single-origin deploys. All unset ⇒ no webAppUrl sent (daemon
      // uses its own config). See resolveWebAppUrl.
      WEB_APP_URL: webAppUrl
    },
    // Resolves the daemon's org slug for the org-scoped deep link (`…/<orgSlug>/sessions/…`).
    repos.org
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
  const relayAuth = new RelayAuthService(codec, repos.apiKey, clock, {
    ...(config.RELAY_TOKEN ? { RELAY_TOKEN: config.RELAY_TOKEN } : {}),
    HEARTBEAT_SEC: config.HEARTBEAT_SEC
  })
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

  // The ONE assembler of CP→daemon AgentSpecs — owns secret loading (the only
  // AgentSecretStore VALUE reader) + icon bases, shared by every emission path:
  // reconcile roster, agent/upsert replicate, icon refresh, move activation.
  const agentSpecs = new AgentSpecAssembler(repos.agentSecret, iconBases, repos.skillSource)

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
          whitelist: parseWhitelist(config.OPEN_CONNECTOR_PROVIDER_WHITELIST)
        })
      : undefined

  const events = new InMemorySessionEventSink()

  // C5 lease broker (ref-only, no plaintext).
  const secrets = new SecretsBrokerService(secretsProvider, repos.lease, clock)
  void secrets // wired into the WS secrets handler in a later phase; constructed now so the graph is whole.

  // The derived in-memory connection index every hot lookup hits.
  const connReg = new ConnectionRegistry()

  // The relay analogue — relayId → live relay socket, so the CP can push
  // rc/daemon-revoke to connected relays (§9). Roster still comes from the DB.
  const relayReg = new RelayRegistry()
  const relayControl = new RelayControlSender(relayReg)

  // github-app config resolved early: the hook compiler stamps the App broadcast
  // slug beside each agent's targeted slug, the GithubService comes later.
  const githubAppCfg = resolveGithubAppConfig(config)

  // Hook compiler/converger (webhook-triggers-and-github-events.md): CRUD routes
  // broadcast through it, and a (re)registering relay gets the full-set replay.
  // The installation repo feeds the github-kind compile (installationIds gate).
  const hookService = new HookService(
    repos.hook,
    repos.hookSecret,
    repos.agent,
    relayControl,
    repos.githubInstallation,
    githubAppCfg?.slug
  )

  // The single fencing site (allocates seq, stamps epoch/launchId on C→D frames).
  const sender = new ControlSender(connReg, repos.launch)

  // Bot-agnostic collaboration routing snapshot fan-out (agent-collaboration
  // §2.3/§6.2): relays get the all-org table; daemons get their org-scoped copy.
  const collabRoutes = new CollabRoutesService(repos.daemon, repos.integration, relayControl, sender)
  const agentMutations = new AgentMutationGate()
  const memoryConnectionMutations = new ExclusiveMutationGate()

  // Relay roster (shared-bot-relay.md §5): computed from the durable `relay` table
  // (alive within the failover window), fed into `register/ok.relays` and fanned to
  // daemons on register/sweep via the `relay/roster` EVT (sender is the broadcaster).
  const relayRoster = new RelayRoster(repos.relay, sender, clock, relayStaleMs)

  // Shared-bot placement + attributed-route compilation (shared-bot-relay.md §4.2/§10).
  // Its logger is lazy (a wrapper over `http.log`, which is created below) — only ever
  // invoked at request/sweep time, well after `http` is assigned, so no TDZ hazard.
  const sharedBot = new SharedBotOrchestrator(
    repos.bot,
    repos.botSecret,
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
    }
  )
  const stagedAgentMoves = new AgentMoveService({
    agents: repos.agent,
    assignments: repos.assignment,
    integrations: repos.integration,
    integrationChannels: repos.integrationChannel,
    bots: repos.bot,
    botSecrets: repos.botSecret,
    specs: agentSpecs,
    crons: repos.cron,
    control: sender,
    hooks: hookService,
    sharedBot,
    collabRoutes,
    mutations: agentMutations,
    sessionOwners: connReg,
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
  const readiness = createReadiness(() => pingDb(prisma))
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
        onInstallationFactsChanged: (installationId, orgId) => {
          const at = new Date(clock.now())
          void repos.hook.wakeReviewProjectionsForInstallation(installationId, at)
          void repos.hook.wakeReviewProjectionsForOrg(orgId, at)
        },
        pepper: config.API_KEY_PEPPER,
        log: { warn: (message) => http.log.warn(message) },
        ...(opts.githubFetch ? { fetchImpl: opts.githubFetch } : {})
      })
    : undefined
  const githubReviewBroker = github
    ? new GithubReviewBrokerService({ hook: repos.hook, agent: repos.agent, github, clock })
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
  // Logger is lazy over `http.log` (SharedBotOrchestrator precedent — pokes only
  // arrive over the relay WS, long after `http` exists).
  const installationDoorbell = github
    ? new GithubInstallationDoorbell({
        github,
        installations: repos.githubInstallation,
        recompileOrg: (orgId) => hookService.rebroadcastGithubForOrg(orgId),
        onFactsChanged: (installationId, orgId) => {
          github.tokens.invalidateInstallation(installationId)
          void repos.hook.wakeReviewProjectionsForInstallation(installationId, new Date(clock.now()))
          void repos.hook.wakeReviewProjectionsForOrg(orgId, new Date(clock.now()))
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
  const githubUserAuthz =
    github && logtoMgmtCfg && config.OIDC_ISSUER
      ? new GithubUserAuthzService({
          identity: new LogtoIdentityService(logtoMgmtCfg, clock),
          github,
          users: repos.user,
          clock
        })
      : undefined

  const httpDeps: HttpDeps = {
    repos: {
      agent: repos.agent,
      assignment: repos.assignment,
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
      agentSecret: repos.agentSecret,
      agentConfig: repos.agentConfig,
      mcpProvider: repos.mcpProvider,
      mcpProviderSecret: repos.mcpProviderSecret,
      mcpGrant: repos.mcpGrant,
      skillSource: repos.skillSource,
      memoryPluginInstallation: repos.memoryPluginInstallation,
      externalMemoryConnection: repos.externalMemoryConnection,
      externalMemoryConnectionSecret: repos.externalMemoryConnectionSecret,
      externalMemoryGrant: repos.externalMemoryGrant,
      slackInstall: repos.slackInstall,
      slackUserConfig: repos.slackUserConfig,
      githubInstallation: repos.githubInstallation,
      agentRepoAuth: repos.agentRepoAuth,
      audit: repos.audit,
      oauth: repos.oauth
    },
    registry,
    agentSpecs,
    ...(daemonRelease ? { daemonRelease } : {}),
    // The live connection index doubles as the read model's liveness overlay
    // (structurally a `DaemonLiveness`): it knows who is connected RIGHT NOW.
    liveness: connReg,
    control: sender,
    relayControl,
    sharedBot,
    collabRoutes,
    agentMutations,
    memoryConnectionMutations,
    sessionOwners: connReg,
    hooks: hookService,
    ...(githubRunReporter ? { kickGithubRunReporter: () => githubRunReporter.kick() } : {}),
    auth,
    apiKeys,
    oauth,
    webchatTokens,
    inviteLinks,
    waitlist,
    events,
    mcpRateLimit: new McpRateLimiter(clock),
    readiness,
    verifySlackBot,
    verifySlackAppToken,
    slackConfigApi,
    resolveTelegramBotName,
    verifyDiscordBot,
    verifyFeishuBot,
    ...(github ? { github } : {}),
    ...(githubUserAuthz ? { githubUserAuthz } : {}),
    ...(iconStore ? { iconStore } : {}),
    ...(connectors ? { connectors } : {}),
    config: {
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
      ...(config.OIDC_AUDIENCE ? { OIDC_AUDIENCE: config.OIDC_AUDIENCE } : {}),
      WAITLIST_MODE: config.WAITLIST_MODE,
      ...(config.CORS_ORIGIN !== undefined ? { CORS_ORIGIN: config.CORS_ORIGIN } : {}),
      ...(config.PUBLIC_WEB_URL ? { PUBLIC_WEB_URL: config.PUBLIC_WEB_URL } : {}),
      ...(config.PUBLIC_RELAY_URL ? { PUBLIC_RELAY_URL: config.PUBLIC_RELAY_URL } : {}),
      ...(config.S3_PUBLIC_BASE_URL ? { S3_PUBLIC_BASE_URL: config.S3_PUBLIC_BASE_URL } : {}),
      RELAY_STALE_MS: relayStaleMs
    }
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

  // Sweeps abandoned Slack auto-install sessions (§Tier B) so a client secret + bot
  // token never lingers past the funnel. Same lifecycle as the cron reaper.
  const slackInstallReaper = new SlackInstallReaper(
    repos.slackInstall,
    clock,
    { ttlMs: config.SLACK_INSTALL_TTL_SEC * 1000, intervalMs: config.SLACK_INSTALL_REAP_INTERVAL_SEC * 1000 },
    http.log
  )

  // Relay failover sweep (shared-bot-relay.md §5): deletes `relay` rows whose
  // heartbeat lapsed and re-fans the shrunk roster to daemons. Same lifecycle as
  // the cron reaper (armed by startBackground, never in tests).
  const relaySweeper = new RelaySweeper(
    repos.relay,
    clock,
    { staleMs: relayStaleMs, intervalMs: config.RELAY_REAP_INTERVAL_SEC * 1000 },
    // On a reap: re-fan the shrunk roster to daemons. Whole-pool ingress means a dead
    // relay strands no bot (the manifest request_url is a stable LB; the CP broadcasts
    // to whoever is connected), so no shared-bot re-placement is needed here.
    async () => {
      await relayRoster.broadcast()
      // §14.3: a reaped relay may have held notice authorities — re-stamp survivors.
      await sharedBot.reconcileAll().catch((err) => http.log.error({ err }, 'relay sweep: shared-bot reconcile failed'))
      const selected = (await relayRoster.entries())[0]
      if (selected) {
        await syncMemoryConnectionsToDaemons(relayHttpOrigin(selected.url), {
          connections: repos.externalMemoryConnection,
          installations: repos.memoryPluginInstallation,
          secrets: repos.externalMemoryConnectionSecret,
          grants: repos.externalMemoryGrant,
          daemons: repos.daemon,
          control: sender,
          log: http.log
        })
      }
    },
    http.log
  )

  // Older HTTP Slack installs discarded the public app id even though the OAuth
  // funnel / bot-token verification knew it. Repair those rows off the request
  // path so the Settings roster can render app-specific links immediately after
  // convergence. Unresolved rows remain null and retry every 15 minutes.
  const slackBotIdentityReconciler = new SlackBotIdentityReconciler(
    repos.bot,
    repos.botSecret,
    async (botToken) => {
      const result = await verifySlackBot(botToken)
      return result.status === 'ok' ? result.appId : null
    },
    clock,
    { intervalMs: 15 * 60 * 1000 },
    http.log
  )

  // ── daemon WS edge (mounted on the live http.Server after listen) ──────────
  const wsDeps: DaemonWsServerDeps = {
    auth,
    registry,
    orchestrator,
    connReg,
    session: repos.session,
    events,
    sessionUsage: repos.sessionUsage,
    integration: repos.integration,
    integrationChannel: repos.integrationChannel,
    agentMutations,
    recoverStagedAgent: (agentId, daemonId, moveId) => stagedAgentMoves.recoverStaged(agentId, daemonId, moveId),
    collabRoutes,
    cron: repos.cron,
    hook: repos.hook,
    agent: repos.agent,
    externalMemoryConnection: repos.externalMemoryConnection,
    ...(github ? { github } : {}),
    ...(githubReviewBroker ? { githubReviewBroker } : {}),
    ...(githubRunCoordinator ? { githubRunCoordinator } : {}),
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
    // rc/verify(webchat-token): validate the token, then re-resolve the agent's CURRENT
    // placement (agent.daemonId + connReg READY) — placement can move between mint + dial.
    verifyWebchatToken: async (token) => {
      const claims = await webchatTokens.verify(token)
      if (!claims) return { ok: false, reason: 'invalid token' }
      const agent = await repos.agent.get(AgentId(claims.agentId))
      if (!agent || agent.orgId !== claims.orgId) return { ok: false, reason: 'invalid token' }
      if (!agent.daemonId) return { ok: false, reason: 'agent unplaced' }
      if (connReg.get(agent.daemonId)?.state !== 'READY') return { ok: false, reason: 'daemon offline' }
      return {
        ok: true,
        userId: claims.userId,
        user: claims.user,
        agentId: claims.agentId,
        daemonId: agent.daemonId,
        orgId: claims.orgId,
        conversationId: claims.conversationId
      }
    },
    // Current-permission fallback for GitHub comment webhooks whose
    // author_association snapshot is stale or inconsistent across event types.
    // Missing GitHub configuration fails closed.
    authorizeGithubComment: async (req) => (githubCommentAuthz ? githubCommentAuthz.allowed(req) : false),
    authorizeGithubRerequest: async (req) => (githubRerequest ? githubRerequest.resolve(req) : { allowed: false }),
    // A relay just (re)registered — refresh every daemon's roster, (re)assign every
    // shared bot's ingest + routes (§5, idempotent), AND replay the compiled hook
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
        sharedBot.replayTo(ch).catch((err) => http.log.error({ err }, 'relay: shared-bot replay on register failed'))
      )
      // …then converge the WHOLE pool: a joined relay changes the connected roster,
      // which moves §14.3 notice authorities — existing relays must learn the new
      // assignment or two pods could both (or neither) believe they hold it.
      trackRelayRegistrationTask(
        sharedBot
          .reconcileAll()
          .catch((err) => http.log.error({ err }, 'relay: shared-bot reconcile on register failed'))
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
            daemons: repos.daemon,
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
                  const agent = await repos.agent.get(agentId)
                  if (!agent?.daemonId) return
                  try {
                    await sender.agentUpsert(agent.daemonId, {
                      agentId: agent.id,
                      spec: await agentSpecs.assemble(agent)
                    })
                  } catch (err) {
                    if (err instanceof NoConnection) {
                      http.log.debug(
                        { agentId, daemonId: agent.daemonId },
                        'github rename: workspace agent/upsert skipped — daemon offline'
                      )
                    } else {
                      http.log.warn(
                        { err, agentId, daemonId: agent.daemonId },
                        'github rename: workspace agent/upsert failed (backstop: reconnect roster)'
                      )
                    }
                  }
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
    },
    // The in-Slack config modal picked a channel's default agent — persist + recompile
    // the bot's routes. Swallow+log: a store error must not close the shared relay link.
    onSetChannelAgent: async (m) => {
      try {
        await sharedBot.setChannelAgent(m.botId, m.channelId, m.agentId)
      } catch (err) {
        http.log.error({ err, botId: m.botId }, 'relay: set-channel-agent failed')
      }
    },
    // HTTP Slack ingest observed the bot itself join/leave a channel and re-listed
    // its complete membership. Persist across every install and refresh relay routes.
    onBotChannels: async (m) => {
      try {
        await sharedBot.replaceChannels(m.botId, m.channels)
      } catch (err) {
        http.log.error({ err, botId: m.botId }, 'relay: bot-channels snapshot failed')
      }
    },
    // A closed relay socket shrinks the connected roster — re-stamp §14.3 notice
    // authorities on the survivors (fire-and-forget; errors logged).
    onRelayGone: () => {
      void sharedBot
        .reconcileAll()
        .catch((err) => http.log.error({ err }, 'relay: shared-bot reconcile on disconnect failed'))
    },
    // A relay delivered a §14.3 DM gating notice — record + re-stamp the pool's
    // latch. Swallow+log.
    onNoticePosted: async (m) => {
      try {
        await sharedBot.recordNoticePosted(m)
      } catch (err) {
        http.log.error({ err, botId: m.botId }, 'relay: notice-posted record failed')
      }
    },
    // Incremental DM-conversation report (§14.3): surface a kind:'im' row (Off) on
    // the bot's gated installs so console editors can enable the DM. Swallow+log.
    onBotConversation: async (m) => {
      try {
        await sharedBot.reportConversation(m.botId, m.conversation)
      } catch (err) {
        http.log.error({ err, botId: m.botId }, 'relay: bot-conversation report failed')
      }
    },
    // Durable thread-affinity REPORT leg — persist + broadcast (rc/assign). Swallow+log:
    // a store error must not close the shared relay link.
    onThreadAssign: async (m) => {
      try {
        await sharedBot.recordThreadAssign(m)
      } catch (err) {
        http.log.error({ err, botId: m.botId }, 'relay: thread-assign failed')
      }
    },
    // Pull-on-miss BACKSTOP leg — may throw → the handler answers a retryable error.
    threadLookup: (m) => sharedBot.lookupThread(m),
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
    readiness,
    startBackground() {
      cronRunReaper.start()
      hookRunReaper.start()
      githubRunReporter?.start()
      hookRedeliveryReconciler?.start()
      slackInstallReaper.start()
      relaySweeper.start()
      slackBotIdentityReconciler.start()
    },
    async shutdown() {
      cronRunReaper.stop()
      hookRunReaper.stop()
      githubRunReporter?.stop()
      hookRedeliveryReconciler?.stop()
      installationDoorbell?.stop()
      slackInstallReaper.stop()
      relaySweeper.stop()
      slackBotIdentityReconciler.stop()
      await Promise.allSettled([...relayRegistrationTasks])
      await prisma.$disconnect()
    }
  }
}
