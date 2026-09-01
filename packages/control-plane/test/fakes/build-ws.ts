/**
 * `buildWsHarness` — the protocol-layer composition root for tests (design §5.3).
 *
 * Wires the real C6 repos (over the shared Testcontainers `PrismaClient`) to the
 * C4 auth/registry services, the C3 reconcile service, the `ConnectionRegistry`
 * and the `FrameRouter`, then hands back a factory that opens a
 * `DaemonConnection` over an `InMemoryDaemonStub`. This is the same graph the
 * production `buildApp(deps)` assembles, but with the `Transport` and `Clock`
 * seams swapped for fakes — so `auth`/`register`/`heartbeat` go red-green with no
 * real socket.
 */
import type { PrismaClient } from '../../src/generated/prisma/client.js'
import type { CollabRoutesSnapshot, RelayRosterEntry } from '@agentconnect.md/protocol'
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
  PgSessionUsageRepo,
  PgLaunchRepo,
  PgMemoryPluginInstallationRepo,
  PgExternalMemoryConnectionRepo,
  PgOrganizationKnowledgeRepo,
  PgExternalMemoryConnectionSecretStore,
  PgExternalMemoryGrantRepo,
  PgMcpProviderRepo,
  PgMcpGrantRepo,
  PgDutyGroupRepo,
  PgHookSecretStore
} from '../../src/persistence/index.js'
import { PgMemberSetRepo } from '../../src/persistence/repositories/member-set.repo.js'
import { PgAgentRepoAuthorizationRepo } from '../../src/persistence/repositories/agent-repo-auth.repo.js'
import { PlaintextSecretCipher } from '../../src/secrets/cipher.js'
import { EpochService } from '../../src/orchestrator/epoch.js'
import { Placement } from '../../src/orchestrator/placement.js'
import { PlacementResolver } from '../../src/orchestrator/placementResolver.js'
import { ControlSender } from '../../src/orchestrator/outbound.js'
import { AgentSpecAssembler } from '../../src/orchestrator/agentSpecAssembler.js'
import { ApiKeyCodec } from '../../src/registry/apiKey.js'
import { DaemonAuthService } from '../../src/registry/authService.js'
import { DaemonRegistryService } from '../../src/registry/registryService.js'
import { ConnectionRegistry } from '../../src/ws/registry.js'
import { AgentMutationGate } from '../../src/orchestrator/agentMutationGate.js'
import { CollabRoutesService } from '../../src/orchestrator/collabRoutes.service.js'
import { DutyLeaseService, type DutyLeaseConfig } from '../../src/orchestrator/dutyLease.js'
import { RelayControlSender } from '../../src/orchestrator/relayControl.js'
import { HookService } from '../../src/hooks/hook.service.js'
import { AgentRoutingConverger } from '../../src/orchestrator/agentRouting.js'
import { FrameRouter } from '../../src/ws/handlers/index.js'
import { DaemonConnection } from '../../src/ws/connection.js'
import type { DaemonWsDeps } from '../../src/ws/deps.js'
import { InMemorySessionEventSink } from '../../src/events/sink.js'
import { SessionUsageWriter } from '../../src/usage/writer.js'
import { DaemonId, OrgId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { FakeClock } from './fake-clock.js'
import { InMemoryDaemonStub } from './daemon-stub.js'
import { buildCpPlatformRegistry } from '../../src/platforms/registry.js'
import { botIdentityProjector } from '../../src/platforms/bot-identity.js'
import { createSlackCpProvider } from '../../src/platforms/slack/provider.js'
import { createTelegramCpProvider } from '../../src/platforms/telegram/provider.js'
import { createDiscordCpProvider } from '../../src/platforms/discord/provider.js'
import { createFeishuCpProvider } from '../../src/platforms/feishu/provider.js'
import { createLinearCpProvider } from '../../src/platforms/linear/provider.js'
import { PgLinearTokenStore } from '../../src/persistence/repositories/linear.repo.js'

/** The deployment Linear app this harness composes — a test seeds a bot identity matching it. */
export const TEST_LINEAR_APP = {
  clientId: 'lin_client_id',
  clientSecret: 'lin_client_secret',
  signingSecret: 'lin_signing_secret'
}

export const TEST_API_KEY_PEPPER = 'test-api-key-pepper-0123456789abcdef'

export interface WsHarness {
  deps: DaemonWsDeps
  clock: FakeClock
  /** Compiled hook rules the relay would have received, in order — the routing projection that
   *  addresses a daemon, so "ingress follows the holder" is assertable on it directly. */
  hookAssigns: CapturedHookRule[]
  hookRemovals: string[]
  /** Daemons the duty exchange asked for a session-visibility replay, in order. */
  visibilityReplays: string[]
  /** Every relay-facing collab-routes push, in order — the peer directory as a relay would hold it. */
  collabSnapshots: CollabRoutesSnapshot[]
  /** The resolver the projections read through — lets a test ask what the peer directory would
   *  publish right now without reaching through the orchestrator. */
  placement: PlacementResolver
  codec: ApiKeyCodec
  /** Provision a daemon row + mint an API key for `daemonId`; returns the plaintext `apiKey`. */
  mintToken(daemonId: string): Promise<string>
  /** Provision an org-less (install-wide, frame-mode) daemon row + a fake cluster
   *  ServiceAccount token for it; auth with `{ serviceAccountToken }`. */
  mintPoolMember(daemonId: string): Promise<string>
  /** Open a fresh connection (started) over a new stub. */
  connect(stub?: InMemoryDaemonStub): { conn: DaemonConnection; stub: InMemoryDaemonStub }
}

export interface HarnessOpts {
  heartbeatSec?: number
  ackTimeoutMs?: number
  startMs?: number
  /** Org provisioned daemons are anchored to. Point at a non-existent id to exercise the FK failure path. */
  orgId?: string
  /** Relay roster exposed in register snapshots (including memory-plugin proxy specs). */
  relays?: RelayRosterEntry[]
  /** Duty lease knobs (defaults suit tests; recoveryGraceMs 0 so grants flow immediately). */
  dutyLease?: Partial<DutyLeaseConfig>
  /** The §24.1 GitLab host axis this control plane serves; absent ⇒ GitLab unconfigured. */
  gitlabBaseUrl?: string
}

/** One compiled hook rule as the relay would receive it — the routing projection under test. */
export interface CapturedHookRule {
  hookId: string
  agentId: string
  daemonId: string
}

export function buildWsHarness(prisma: PrismaClient, opts: HarnessOpts = {}): WsHarness {
  const clock = new FakeClock(opts.startMs ?? 1_700_000_000_000)

  const cipher = new PlaintextSecretCipher()
  // §9: reconcile projects every `IntegrationSpec.config` through the platform registry, so the WS
  // fake composes the same providers prod registers. Their verify seams are offline stubs — the
  // projectors call none of them — but Linear's projector DOES read its own store, so it gets the
  // real one over this harness's Postgres.
  const PLATFORMS = buildCpPlatformRegistry([
    createSlackCpProvider({}),
    createTelegramCpProvider({ verifyBot: async () => ({ status: 'unreachable' }) }),
    createDiscordCpProvider({ ensureMessageContentIntent: async () => 'ready' }),
    createFeishuCpProvider({}),
    createLinearCpProvider({ app: TEST_LINEAR_APP, tokens: new PgLinearTokenStore(prisma, cipher) })
  ])
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
    sessionUsage: new PgSessionUsageRepo(prisma),
    launch: new PgLaunchRepo(prisma),
    memoryPluginInstallation: new PgMemoryPluginInstallationRepo(prisma),
    externalMemoryConnection: new PgExternalMemoryConnectionRepo(prisma),
    organizationKnowledge: new PgOrganizationKnowledgeRepo(prisma),
    externalMemoryConnectionSecret: new PgExternalMemoryConnectionSecretStore(prisma, cipher),
    externalMemoryGrant: new PgExternalMemoryGrantRepo(prisma, cipher),
    mcpProvider: new PgMcpProviderRepo(prisma),
    mcpGrant: new PgMcpGrantRepo(prisma, cipher)
  }

  const codec = new ApiKeyCodec({ API_KEY_PEPPER: TEST_API_KEY_PEPPER })

  // One horizon for both halves: auth/ok tells the daemon exactly what the lease service uses.
  const dutyLeaseMs = opts.dutyLease?.leaseMs ?? 120_000

  const epoch = new EpochService(repos.daemon, clock)
  const memberSets = new PgMemberSetRepo(prisma)
  // Fake in-cluster identity: token → install-wide daemon, no TokenReview.
  const poolTokens = new Map<string, string>()
  const auth = new DaemonAuthService(
    codec,
    repos.apiKey,
    epoch,
    clock,
    { HEARTBEAT_SEC: opts.heartbeatSec ?? 15, DUTY_LEASE_MS: dutyLeaseMs },
    new PgOrgRepo(prisma),
    memberSets,
    {
      verify: async (token: string) => {
        const daemonId = poolTokens.get(token)
        return daemonId ? { daemonId: DaemonId(daemonId), scope: 'install' as const } : null
      }
    }
  )
  const registry = new DaemonRegistryService(repos.daemon, repos.runtimeProfile, repos.daemonLifecycleOp, clock)
  const connReg = new ConnectionRegistry()
  const sender = new ControlSender(connReg, repos.launch)
  const relays = opts.relays ?? []
  const dutyGroupRepo = new PgDutyGroupRepo(prisma)
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
  // The relay-facing collab pushes are captured, not sent: `collabSnapshots` is literally the
  // directory a relay would route a peer wake through, latest last. Wired like prod — resolver +
  // duty ledger — so a pool member's held agents put their org into the snapshot.
  const collabSnapshots: CollabRoutesSnapshot[] = []
  const collabRoutes = new CollabRoutesService(
    repos.daemon,
    repos.integration,
    repos.agent,
    {
      collabRoutes: (snapshot: CollabRoutesSnapshot) => void collabSnapshots.push(snapshot),
      collabRoutesTo: (_ch: unknown, snapshot: CollabRoutesSnapshot) => void collabSnapshots.push(snapshot)
    } as unknown as RelayControlSender,
    sender,
    placementResolver,
    dutyGroupRepo,
    clock
  )
  const orchestrator = new Placement(
    repos.daemon,
    repos.agent,
    repos.assignment,
    repos.cron,
    repos.lease,
    repos.integration,
    repos.botSecret,
    new AgentSpecAssembler(
      repos.agentSecret,
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new PgAgentRepoAuthorizationRepo(prisma),
      opts.gitlabBaseUrl,
      repos.hook
    ),
    repos.integrationChannel,
    repos.bot,
    PLATFORMS,
    {
      registry: connReg,
      sender,
      epoch,
      clock,
      config: {
        REASSIGN_GRACE_SEC: 60,
        ACK_TIMEOUT_MS: opts.ackTimeoutMs ?? 5000
      },
      mcp: { providers: repos.mcpProvider, grants: repos.mcpGrant, relayRoster: { entries: async () => relays } },
      memory: {
        connections: repos.externalMemoryConnection,
        installations: repos.memoryPluginInstallation,
        secrets: repos.externalMemoryConnectionSecret,
        grants: repos.externalMemoryGrant,
        relayRoster: { entries: async () => relays }
      },
      duties: dutyGroupRepo,
      placement: placementResolver
    }
  )

  // A REAL HookService over a capturing relay sender: `hookAssigns` is literally what a relay
  // would dispatch on, so a test can assert that ingress follows a holder change rather than
  // asserting that some internal seam was called.
  const hookAssigns: CapturedHookRule[] = []
  const hookRemovals: string[] = []
  const hookService = new HookService(
    repos.hook,
    new PgHookSecretStore(prisma, cipher),
    repos.agent,
    {
      hookAssign: (rule: { hookId: string; agentId: string; daemonId: string }) => void hookAssigns.push(rule),
      hookRemove: (hookId: string) => void hookRemovals.push(hookId)
    } as unknown as RelayControlSender,
    placementResolver
  )
  const agentRouting = new AgentRoutingConverger({
    hooks: hookService,
    collabRoutes,
    httpBot: { syncBot: async () => {} },
    agents: repos.agent,
    integrations: repos.integration,
    bots: repos.bot,
    clock,
    delayMs: 0
  })

  // Members the exchange asked for a capture-gate replay, in order. The snapshot's CONTENT is
  // pinned in `session-visibility.route.test.ts`; what belongs here is that a confirmed grant
  // triggers one at all — a member registers before it holds anything.
  const visibilityReplays: string[] = []
  const dutyLease = new DutyLeaseService(
    dutyGroupRepo,
    clock,
    {
      leaseMs: dutyLeaseMs,
      recoveryGraceMs: opts.dutyLease?.recoveryGraceMs ?? 0,
      grantMaxPerTick: opts.dutyLease?.grantMaxPerTick ?? 32,
      grantsPerFrame: opts.dutyLease?.grantsPerFrame ?? 50,
      grantMembersPerFrame: opts.dutyLease?.grantMembersPerFrame ?? 2000,
      revocationsPerFrame: opts.dutyLease?.revocationsPerFrame ?? 500,
      refusalsBeforeRelease: opts.dutyLease?.refusalsBeforeRelease ?? 3,
      refusalBackoffMs: opts.dutyLease?.refusalBackoffMs ?? 300_000,
      doubleMoveWindowMs: opts.dutyLease?.doubleMoveWindowMs ?? 600_000
    },
    undefined,
    repos.agent,
    agentRouting,
    { replayTo: async (daemonId) => void visibilityReplays.push(daemonId) }
  )

  const deps: DaemonWsDeps = {
    log: { error: () => undefined },
    auth,
    memberSets,
    lifecycleOps: repos.daemonLifecycleOp,
    registry,
    orchestrator,
    connReg,
    agent: repos.agent,
    placementResolver,
    session: repos.session,
    events: new InMemorySessionEventSink(),
    usageWriter: new SessionUsageWriter(repos.sessionUsage),
    integration: repos.integration,
    integrationChannel: repos.integrationChannel,
    agentMutations: new AgentMutationGate(),
    recoverStagedAgent: async () => {},
    collabRoutes,
    dutyLease,
    cron: repos.cron,
    hook: repos.hook,
    externalMemoryConnection: repos.externalMemoryConnection,
    organizationKnowledge: repos.organizationKnowledge,
    relayRoster: async () => relays,
    clock,
    config: {
      HEARTBEAT_SEC: opts.heartbeatSec ?? 15,
      ACK_TIMEOUT_MS: opts.ackTimeoutMs ?? 5000
    }
  }

  const router = new FrameRouter()

  const org = OrgId(opts.orgId ?? DEFAULT_ORG_ID)
  return {
    deps,
    clock,
    hookAssigns,
    hookRemovals,
    visibilityReplays,
    collabSnapshots,
    placement: placementResolver,
    codec,
    mintPoolMember: async (daemonId: string) => {
      await prisma.daemon.create({ data: { id: daemonId, orgId: null, maxAgents: 8, status: 'ready' } })
      const token = `fake-sa-token-${daemonId}`
      poolTokens.set(token, daemonId)
      return token
    },
    mintToken: async (daemonId: string) => {
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
    connect: (stub = new InMemoryDaemonStub()) => {
      const conn = new DaemonConnection(stub, deps, router)
      conn.start()
      return { conn, stub }
    }
  }
}
