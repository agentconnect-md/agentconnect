/**
 * `buildDaemonApp` — the Phase 3 mount harness (design §6 Phase 3 "Mount").
 *
 * Assembles a real Fastify instance with the daemon WS gateway
 * (`createDaemonWsServer`) mounted on its `http.Server`, wired to the same C4/C3
 * services + C6 repos as `build-ws.ts` but over a LIVE socket (a `SystemClock`,
 * real `ws`). It is the minimal precursor to the Phase 5 `app.ts:buildApp`,
 * scoped to what the `ws-handshake` integration test needs: `listen()`, a token
 * minter, and `close()`.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import type { PrismaClient } from '../../src/generated/prisma/client.js'
import {
  PgDaemonRepo,
  PgDaemonLifecycleOpRepo,
  PgApiKeyRepo,
  PgOrgRepo,
  PgAgentRepo,
  PgAgentSecretStore,
  PgAssignmentRepo,
  PgCronRepo,
  PgHookRepo,
  PgSecretLeaseRepo,
  PgIntegrationRepo,
  PgBotRepo,
  PgBotSecretStore,
  PgIntegrationChannelRepo,
  PgRuntimeProfileRepo,
  PgSessionRepo,
  PgSessionUsageRepo
} from '../../src/persistence/index.js'
import { PlaintextSecretCipher } from '../../src/secrets/cipher.js'
import { EpochService } from '../../src/orchestrator/epoch.js'
import { DUTY_LEASE_DEFAULTS } from '../../src/orchestrator/dutyLease.js'
import { Placement } from '../../src/orchestrator/placement.js'
import { AgentSpecAssembler } from '../../src/orchestrator/agentSpecAssembler.js'
import { buildCpPlatformRegistry } from '../../src/platforms/registry.js'
import { botIdentityProjector } from '../../src/platforms/bot-identity.js'
import { createSlackCpProvider } from '../../src/platforms/slack/provider.js'
import { createTelegramCpProvider } from '../../src/platforms/telegram/provider.js'
import { createDiscordCpProvider } from '../../src/platforms/discord/provider.js'
import { createFeishuCpProvider } from '../../src/platforms/feishu/provider.js'
import { AgentMutationGate } from '../../src/orchestrator/agentMutationGate.js'
import { ApiKeyCodec } from '../../src/registry/apiKey.js'
import { DaemonAuthService } from '../../src/registry/authService.js'
import { DaemonRegistryService } from '../../src/registry/registryService.js'
import { ConnectionRegistry } from '../../src/ws/registry.js'
import { createDaemonWsServer } from '../../src/ws/gateway.js'
import type { DaemonWsDeps } from '../../src/ws/deps.js'
import { InMemorySessionEventSink } from '../../src/events/sink.js'
import { systemClock } from '../../src/domain/clock.js'
import { DaemonId, OrgId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

export const TEST_API_KEY_PEPPER = 'test-api-key-pepper-0123456789abcdef'
const WS_PATH = '/daemon/ws'

export interface DaemonApp {
  app: FastifyInstance
  /** Listen on an ephemeral port; returns the base http URL (e.g. http://127.0.0.1:54321). */
  listen(): Promise<string>
  mintToken(daemonId: string): Promise<string>
  close(): Promise<void>
}

// §9: reconcile projects every `IntegrationSpec.config` through the platform
// registry, and the bot repo projects every new row's D6 identity through it,
// so compose the same four providers prod registers. Their verify seams are
// offline stubs — neither projector calls one.
const PLATFORMS = buildCpPlatformRegistry([
  createSlackCpProvider({}),
  createTelegramCpProvider({ verifyBot: async () => ({ status: 'unreachable' }) }),
  createDiscordCpProvider({ ensureMessageContentIntent: async () => 'ready' }),
  createFeishuCpProvider({})
])

export function buildDaemonApp(prisma: PrismaClient): DaemonApp {
  const clock = systemClock
  const app = Fastify({ logger: false })
  app.get('/health', async () => ({ status: 'ok' }))

  const cipher = new PlaintextSecretCipher()
  const repos = {
    daemon: new PgDaemonRepo(prisma),
    daemonLifecycleOp: new PgDaemonLifecycleOpRepo(prisma),
    apiKey: new PgApiKeyRepo(prisma),
    agent: new PgAgentRepo(prisma),
    agentSecret: new PgAgentSecretStore(prisma, cipher),
    assignment: new PgAssignmentRepo(prisma),
    cron: new PgCronRepo(prisma),
    hook: new PgHookRepo(prisma),
    lease: new PgSecretLeaseRepo(prisma),
    integration: new PgIntegrationRepo(prisma),
    bot: new PgBotRepo(prisma, botIdentityProjector(PLATFORMS)),
    botSecret: new PgBotSecretStore(prisma, cipher),
    integrationChannel: new PgIntegrationChannelRepo(prisma),
    runtimeProfile: new PgRuntimeProfileRepo(prisma),
    session: new PgSessionRepo(prisma),
    sessionUsage: new PgSessionUsageRepo(prisma)
  }

  const codec = new ApiKeyCodec({ API_KEY_PEPPER: TEST_API_KEY_PEPPER })
  const epoch = new EpochService(repos.daemon, clock)
  const auth = new DaemonAuthService(
    codec,
    repos.apiKey,
    epoch,
    clock,
    { HEARTBEAT_SEC: 15, DUTY_LEASE_MS: DUTY_LEASE_DEFAULTS.leaseMs },
    new PgOrgRepo(prisma)
  )
  const registry = new DaemonRegistryService(repos.daemon, repos.runtimeProfile, repos.daemonLifecycleOp, clock)
  const orchestrator = new Placement(
    repos.daemon,
    repos.agent,
    repos.assignment,
    repos.cron,
    repos.lease,
    repos.integration,
    repos.botSecret,
    new AgentSpecAssembler(repos.agentSecret),
    repos.integrationChannel,
    repos.bot,
    PLATFORMS
  )
  const connReg = new ConnectionRegistry()

  // Mount the daemon WS gateway once the HTTP server exists (after `listen`).
  let listening = false
  const mount = (): void => {
    if (listening) return
    listening = true
    createDaemonWsServer(app, {
      auth,
      lifecycleOps: repos.daemonLifecycleOp,
      registry,
      orchestrator,
      connReg,
      agent: repos.agent,
      session: repos.session,
      events: new InMemorySessionEventSink(),
      sessionUsage: repos.sessionUsage,
      integration: repos.integration,
      integrationChannel: repos.integrationChannel,
      agentMutations: new AgentMutationGate(),
      recoverStagedAgent: async () => {},
      collabRoutes: { broadcast: async () => undefined } as unknown as DaemonWsDeps['collabRoutes'],
      dutyLease: {
        onHeartbeat: async () => undefined,
        release: async () => undefined
      } as unknown as DaemonWsDeps['dutyLease'],
      cron: repos.cron,
      hook: repos.hook,
      relayRoster: async () => [],
      clock,
      config: { HEARTBEAT_SEC: 15, ACK_TIMEOUT_MS: 5000, WS_PATH }
    })
  }

  return {
    app,
    async listen() {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      mount() // app.server is available now
      return address
    },
    mintToken: async (daemonId: string) => {
      const org = OrgId(DEFAULT_ORG_ID)
      if (!(await repos.daemon.getUnscoped(DaemonId(daemonId)))) await repos.daemon.provision(DaemonId(daemonId), org)
      const minted = codec.mint()
      await repos.apiKey.create({
        principalType: 'daemon',
        orgId: org,
        daemonId: DaemonId(daemonId),
        hash: minted.hash,
        displayTail: minted.displayTail,
        expiresAt: null
      })
      return minted.token
    },
    close: async () => {
      await app.close()
    }
  }
}
