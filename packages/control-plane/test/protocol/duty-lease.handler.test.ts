// The duty lease exchange over the WS edge (frames/duty.ts): a heartbeat's
// `duties` field renews held groups and is answered — only when there is
// something to say — with duty/grant and duty/revoke EVTs; duty/release
// vacates explicitly. A heartbeat without `duties` keeps the path dormant.
import { describe, it, expect, vi } from 'vitest'
import { isFrame } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildWsHarness } from '../fakes/build-ws.js'
import type { InMemoryDaemonStub } from '../fakes/daemon-stub.js'
import { PgDutyGroupRepo, PgLaunchRepo } from '../../src/persistence/index.js'
import { ControlSender } from '../../src/orchestrator/outbound.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { DaemonId, OrgId } from '../../src/domain/ids.js'

const DAEMON = 'd1111111-1111-4111-8111-111111111111'
const OTHER = 'd2222222-2222-4222-8222-222222222222'
const GROUP = '00000000-0000-4000-8000-000000000001'
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const AGENT2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const GROUP2 = '00000000-0000-4000-8000-000000000002'
const AUTH_ID = '99999999-9999-4999-8999-999999999999'
const REG_ID = '88888888-8888-4888-8888-888888888888'
const REL_ID = '77777777-7777-4777-8777-777777777777'

const LEASE_MS = 120_000

async function seedGroup(opts: { holder?: string; term?: bigint; expiresAt?: Date | null } = {}): Promise<void> {
  await prisma.dutyGroup.create({
    data: {
      id: GROUP,
      orgId: DEFAULT_ORG_ID,
      holder: opts.holder ?? null,
      term: opts.term ?? 0n,
      expiresAt: opts.expiresAt ?? null
    }
  })
  await prisma.dutyGroupMember.create({
    data: { kind: 'agent', refId: AGENT, groupId: GROUP, orgId: DEFAULT_ORG_ID }
  })
}

async function ready(h: ReturnType<typeof buildWsHarness>, opts: { orgScoped?: boolean } = {}) {
  const { conn, stub } = h.connect()
  if (opts.orgScoped) {
    const token = await h.mintToken(DAEMON)
    stub.inject('auth', { apiKey: token, daemonId: DAEMON, agentVersion: '1.4.0' }, { id: AUTH_ID })
  } else {
    const saToken = await h.mintCloudDaemon(DAEMON)
    stub.inject('auth', { serviceAccountToken: saToken, daemonId: DAEMON, agentVersion: '1.4.0' }, { id: AUTH_ID })
  }
  await stub.expectFrame('auth/ok')
  stub.inject(
    'register',
    {
      host: 'member-1',
      capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true },
      maxAgents: 8,
      localState: { assignments: [], crons: [], leases: [], agents: [], integrations: [], stagedAgents: [] }
    },
    { id: REG_ID }
  )
  await stub.expectFrame('register/ok')
  return { conn, stub }
}

/** Inject one beat and wait for ITS renewal confirmation. `expectFrame` resolves from a frame
 *  already sent, so a multi-beat test has to count instead — otherwise the next inject races the
 *  running exchange and the lane drops it. */
async function beat(
  stub: InMemoryDaemonStub,
  duties: { held: { groupId: string; term: string }[]; headroom: number }
): Promise<void> {
  const before = stub.sent.filter((f) => f.type === 'duty/renewed').length
  stub.inject('heartbeat', heartbeat(duties))
  await vi.waitFor(() => expect(stub.sent.filter((f) => f.type === 'duty/renewed').length).toBe(before + 1))
}

function heartbeat(duties?: { held: { groupId: string; term: string }[]; headroom: number }) {
  return {
    load: { cpu: 0.1, mem: 0.1, agents: 0 },
    health: 'ok',
    activeSessions: 0,
    ...(duties ? { duties } : {})
  }
}

describe('duty lease exchange (protocol level, real Postgres)', () => {
  it('a heartbeat without duties stays dormant — no duty frames', async () => {
    await seedGroup()
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat())
    stub.inject('heartbeat', heartbeat()) // second beat: the first has fully dispatched by now
    await new Promise((r) => setTimeout(r, 25))
    expect(stub.sent.filter((f) => f.type.startsWith('duty/'))).toEqual([])
  })

  it('headroom claims a vacant group and the grant EVT carries org, term, members', async () => {
    await seedGroup()
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat({ held: [], headroom: 4 }))
    const grant = await stub.expectFrame('duty/grant')
    if (!isFrame('duty/grant')(grant)) throw new Error('expected duty/grant')
    expect(grant.payload.grants).toEqual([
      { groupId: GROUP, orgId: DEFAULT_ORG_ID, term: '1', members: [{ kind: 'agent', refId: AGENT }] }
    ])

    const row = await prisma.dutyGroup.findUniqueOrThrow({ where: { id: GROUP } })
    expect(row.holder).toBe(DAEMON)
    expect(row.term).toBe(1n)
  })

  it("a granted agent member carries the CP's current configRevision — presence is not freshness", async () => {
    // Without it a member that already has the agent skips the fetch on `has()`
    // alone and keeps serving a bundle the CP has edited since (#973).
    await seedGroup()
    await prisma.agent.create({
      data: {
        id: AGENT,
        orgId: DEFAULT_ORG_ID,
        name: 'stamped',
        runtime: 'claude',
        placementKind: 'pool',
        configRevision: 9n
      }
    })
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat({ held: [], headroom: 4 }))
    const grant = await stub.expectFrame('duty/grant')
    if (!isFrame('duty/grant')(grant)) throw new Error('expected duty/grant')
    expect(grant.payload.grants[0]?.members).toEqual([{ kind: 'agent', refId: AGENT, configRevision: '9' }])
  })

  it('zero headroom claims nothing', async () => {
    await seedGroup()
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat({ held: [], headroom: 0 }))
    await new Promise((r) => setTimeout(r, 25))
    expect(stub.sent.filter((f) => f.type === 'duty/grant')).toEqual([])
  })

  it('within the recovery grace no vacancy grant flows; after it, grants resume', async () => {
    await seedGroup()
    const h = buildWsHarness(prisma, { dutyLease: { recoveryGraceMs: 60_000 } })
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat({ held: [], headroom: 4 }))
    await new Promise((r) => setTimeout(r, 25))
    expect(stub.sent.filter((f) => f.type === 'duty/grant')).toEqual([])

    h.clock.advance(60_001)
    stub.inject('heartbeat', heartbeat({ held: [], headroom: 4 }))
    await stub.expectFrame('duty/grant')
  })

  it('renewal is the heartbeat: the held digest refreshes expiresAt without a term bump', async () => {
    const h = buildWsHarness(prisma)
    const start = new Date(h.clock.now())
    await seedGroup({ holder: DAEMON, term: 1n, expiresAt: new Date(start.getTime() + 5_000) })
    const { stub } = await ready(h)

    h.clock.advance(1_000)
    stub.inject('heartbeat', heartbeat({ held: [{ groupId: GROUP, term: '1' }], headroom: 0 }))
    await new Promise((r) => setTimeout(r, 25))

    const row = await prisma.dutyGroup.findUniqueOrThrow({ where: { id: GROUP } })
    expect(row.term).toBe(1n)
    expect(row.expiresAt).toEqual(new Date(h.clock.now() + LEASE_MS))
    // Nothing to grant and nothing to revoke — only the confirmation that the renewal happened,
    // which is what the member anchors its self-fence on.
    expect(stub.sent.filter((f) => f.type.startsWith('duty/')).map((f) => f.type)).toEqual(['duty/renewed'])
  })

  it('every processed duty beat is answered with the renewal horizon it just wrote', async () => {
    const h = buildWsHarness(prisma, { dutyLease: { leaseMs: 90_000 } })
    const start = new Date(h.clock.now())
    await seedGroup({ holder: DAEMON, term: 1n, expiresAt: new Date(start.getTime() + 5_000) })
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat({ held: [{ groupId: GROUP, term: '1' }], headroom: 0 }))
    const renewed = await stub.expectFrame('duty/renewed')
    if (!isFrame('duty/renewed')(renewed)) throw new Error('expected duty/renewed')
    // Relative, never a timestamp: the member measures from receipt on its own clock.
    expect(renewed.payload).toEqual({ leaseMs: 90_000 })
    const row = await prisma.dutyGroup.findUniqueOrThrow({ where: { id: GROUP } })
    expect(row.expiresAt).toEqual(new Date(h.clock.now() + 90_000))
  })

  it('the renewal confirmation comes LAST, after the revocation it must never outrun', async () => {
    // The member's fence is global while renewal is per-group, so a delivered PREFIX of this
    // exchange must not extend the countdown without the revocation that makes it safe. Here
    // `renewHeld` renews nothing the member reported — the group belongs to OTHER now — and one
    // socket delivers in order, so a confirmation implies the supersession arrived first.
    const h = buildWsHarness(prisma)
    const start = new Date(h.clock.now())
    await seedGroup({ holder: OTHER, term: 2n, expiresAt: new Date(start.getTime() + LEASE_MS) })
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat({ held: [{ groupId: GROUP, term: '1' }], headroom: 0 }))
    await stub.expectFrame('duty/renewed')

    expect(stub.sent.filter((f) => f.type.startsWith('duty/')).map((f) => f.type)).toEqual([
      'duty/revoke',
      'duty/renewed'
    ])
  })

  it('a digest entry the ledger granted elsewhere is revoked as superseded', async () => {
    const h = buildWsHarness(prisma)
    const start = new Date(h.clock.now())
    await seedGroup({ holder: OTHER, term: 2n, expiresAt: new Date(start.getTime() + LEASE_MS) })
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat({ held: [{ groupId: GROUP, term: '1' }], headroom: 0 }))
    const revoke = await stub.expectFrame('duty/revoke')
    if (!isFrame('duty/revoke')(revoke)) throw new Error('expected duty/revoke')
    expect(revoke.payload.revocations).toEqual([{ groupId: GROUP, reason: 'superseded' }])
  })

  it('a digest entry whose group no longer exists is revoked as gone', async () => {
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat({ held: [{ groupId: GROUP, term: '1' }], headroom: 0 }))
    const revoke = await stub.expectFrame('duty/revoke')
    if (!isFrame('duty/revoke')(revoke)) throw new Error('expected duty/revoke')
    expect(revoke.payload.revocations).toEqual([{ groupId: GROUP, reason: 'gone' }])
  })

  it('a stale digest term is answered by re-issuing the grant at the current term', async () => {
    const h = buildWsHarness(prisma)
    const start = new Date(h.clock.now())
    await seedGroup({ holder: DAEMON, term: 3n, expiresAt: new Date(start.getTime() + LEASE_MS) })
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat({ held: [{ groupId: GROUP, term: '2' }], headroom: 0 }))
    const grant = await stub.expectFrame('duty/grant')
    if (!isFrame('duty/grant')(grant)) throw new Error('expected duty/grant')
    expect(grant.payload.grants[0]).toMatchObject({ groupId: GROUP, term: '3' })
  })

  it('the re-issue carries the CURRENT composition — the retry for a member that could not install it', async () => {
    // A member that refused a replacement keeps the group at its OLD term after applying only the
    // removals, so this is the branch its digest lands in every beat until the install succeeds:
    // stale-term, not missing, so it costs nothing against the reported headroom.
    const h = buildWsHarness(prisma)
    const start = new Date(h.clock.now())
    await seedGroup({ holder: DAEMON, term: 2n, expiresAt: new Date(start.getTime() + LEASE_MS) })
    await prisma.dutyGroupMember.create({
      data: { kind: 'agent', refId: AGENT2, groupId: GROUP, orgId: DEFAULT_ORG_ID }
    })
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat({ held: [{ groupId: GROUP, term: '1' }], headroom: 0 }))
    const grant = await stub.expectFrame('duty/grant')
    if (!isFrame('duty/grant')(grant)) throw new Error('expected duty/grant')
    expect(grant.payload.grants).toHaveLength(1)
    expect(grant.payload.grants[0]?.term).toBe('2')
    expect(grant.payload.grants[0]?.members.map((m) => m.refId).sort()).toEqual([AGENT, AGENT2].sort())
    expect(stub.sent.filter((f) => f.type === 'duty/revoke')).toEqual([])
  })

  it('a held group missing from the digest is re-granted (lost grant EVT recovery)', async () => {
    const h = buildWsHarness(prisma)
    const start = new Date(h.clock.now())
    await seedGroup({ holder: DAEMON, term: 1n, expiresAt: new Date(start.getTime() + LEASE_MS) })
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat({ held: [], headroom: 0 }))
    const grant = await stub.expectFrame('duty/grant')
    if (!isFrame('duty/grant')(grant)) throw new Error('expected duty/grant')
    expect(grant.payload.grants[0]).toMatchObject({ groupId: GROUP, term: '1' })
  })

  it('duty/release acks and vacates immediately, keeping the term', async () => {
    const h = buildWsHarness(prisma)
    const start = new Date(h.clock.now())
    await seedGroup({ holder: DAEMON, term: 2n, expiresAt: new Date(start.getTime() + LEASE_MS) })
    const { stub } = await ready(h)

    stub.inject('duty/release', { groupIds: [GROUP] }, { id: REL_ID })
    const ack = await stub.expectFrame('ack')
    expect(ack.corr).toBe(REL_ID)

    const row = await prisma.dutyGroup.findUniqueOrThrow({ where: { id: GROUP } })
    expect(row.holder).toBeNull()
    expect(row.expiresAt).toBeNull()
    expect(row.term).toBe(2n)

    // Immediately grantable by a survivor at a bumped term.
    const repo = new PgDutyGroupRepo(prisma)
    const grants = await repo.claimVacant(DaemonId(OTHER), 1, new Date(h.clock.now()), LEASE_MS, {
      scope: 'install-wide'
    })
    expect(grants[0]).toMatchObject({ groupId: GROUP, orgId: OrgId(DEFAULT_ORG_ID), term: 3n })
  })
})

/**
 * The reconnect roster is `pinned-to-me ∪ agents in the duties I hold` (#973).
 * Before this it was `listForDaemon(daemonId)` alone, so a duty-installed agent
 * was absent from the desired set on reconnect — a stale-replica candidate whose
 * CP row names another daemon, i.e. a `detach` that undid the install entirely.
 */
describe('the reconnect roster follows the duty holder', () => {
  /** Register while claiming a local replica of `AGENT`, and read the snapshot back. */
  async function reconnectHolding(h: ReturnType<typeof buildWsHarness>) {
    const { stub } = h.connect()
    const saToken = await h.mintCloudDaemon(DAEMON)
    stub.inject('auth', { serviceAccountToken: saToken, daemonId: DAEMON, agentVersion: '1.4.0' }, { id: AUTH_ID })
    await stub.expectFrame('auth/ok')
    stub.inject(
      'register',
      {
        host: 'member-1',
        capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true },
        maxAgents: 8,
        localState: {
          assignments: [],
          crons: [],
          leases: [],
          agents: [{ agentId: AGENT, origin: 'cp' }],
          integrations: [],
          stagedAgents: []
        }
      },
      { id: REG_ID }
    )
    const ok = await stub.expectFrame('register/ok')
    if (!isFrame('register/ok')(ok)) throw new Error('expected register/ok')
    return ok.payload
  }

  it('a duty-held agent is IN the roster and is never a prune candidate', async () => {
    const h = buildWsHarness(prisma)
    // Placed on ANOTHER daemon — exactly the row that used to read as "moved away".
    await prisma.daemon.create({ data: { id: OTHER, orgId: DEFAULT_ORG_ID, maxAgents: 4, status: 'ready' } })
    await prisma.agent.create({
      data: { id: AGENT, orgId: DEFAULT_ORG_ID, name: 'held', runtime: 'claude', daemonId: OTHER }
    })
    await seedGroup({ holder: DAEMON, term: 1n, expiresAt: new Date(h.clock.now() + LEASE_MS) })

    const ok = await reconnectHolding(h)

    expect(ok.agents.map((a) => a.agentId)).toContain(AGENT)
    expect(ok.drop.agents).toEqual([])
  })

  it('an EXPIRED lease is not a holding — the replica goes back to being a prune candidate', async () => {
    const h = buildWsHarness(prisma)
    await prisma.daemon.create({ data: { id: OTHER, orgId: DEFAULT_ORG_ID, maxAgents: 4, status: 'ready' } })
    await prisma.agent.create({
      data: { id: AGENT, orgId: DEFAULT_ORG_ID, name: 'lapsed', runtime: 'claude', daemonId: OTHER }
    })
    await seedGroup({ holder: DAEMON, term: 1n, expiresAt: new Date(h.clock.now() - 1_000) })

    const ok = await reconnectHolding(h)

    expect(ok.agents.map((a) => a.agentId)).not.toContain(AGENT)
    // Detach, never remove: the CP row still proves the agent lives elsewhere.
    expect(ok.drop.agents).toEqual([{ agentId: AGENT, action: 'detach' }])
  })

  /**
   * The definitions the roster's AgentSpecs only NAME (#979). Before this they
   * were resolved from `activeForDaemon(daemonId)` — placement — so a holder with
   * no agent PLACED on it received an agent whose MCP servers and memory backend
   * it had no definitions for, and both silently did not work.
   */
  const RELAY = [{ relayId: '00000000-0000-4000-8000-0000000000a1', url: 'wss://relay.example.test' }]

  async function seedProvider(name: string, key: string): Promise<string> {
    const provider = await prisma.mcpProvider.create({
      data: { orgId: DEFAULT_ORG_ID, name, url: 'https://upstream.example.test/mcp' }
    })
    await prisma.mcpGrant.create({ data: { mcpProviderId: provider.id, key } })
    return provider.id
  }

  async function seedStdioConnection(): Promise<string> {
    const installation = await prisma.memoryPluginInstallation.create({
      data: {
        orgId: DEFAULT_ORG_ID,
        pluginId: 'ai.example.memory',
        transport: 'stdio',
        commandRef: 'operator-mem0',
        expectedManifestDigest: `sha256:${'a'.repeat(64)}`,
        secretHeaders: []
      }
    })
    const connection = await prisma.externalMemoryConnection.create({
      data: { orgId: DEFAULT_ORG_ID, installationId: installation.id, config: {} }
    })
    return connection.id
  }

  it('the snapshot carries the MCP defs and memory connection its DUTY-HELD agent references', async () => {
    const h = buildWsHarness(prisma, { relays: RELAY })
    await prisma.daemon.create({ data: { id: OTHER, orgId: DEFAULT_ORG_ID, maxAgents: 4, status: 'ready' } })
    const providerId = await seedProvider('docs', 'oct_docs')
    const connectionId = await seedStdioConnection()
    await prisma.agent.create({
      data: {
        id: AGENT,
        orgId: DEFAULT_ORG_ID,
        name: 'held',
        runtime: 'claude',
        daemonId: OTHER,
        runtimeOverrides: { mcpServers: ['docs'], memory: { provider: 'external', connectionId } }
      }
    })
    await seedGroup({ holder: DAEMON, term: 1n, expiresAt: new Date(h.clock.now() + LEASE_MS) })

    const ok = await reconnectHolding(h)

    // Content, not arrival: the proxy def must carry the grant key the holder calls with.
    expect(ok.mcpServers).toEqual([
      expect.objectContaining({
        name: 'docs',
        url: `https://relay.example.test/mcp/${providerId}`,
        headers: [{ name: 'Authorization', value: 'Bearer oct_docs' }]
      })
    ])
    expect(ok.memoryConnections.map((c) => c.connectionId)).toEqual([connectionId])
  })

  it('a member holding NO duty covering the agent receives neither definition', async () => {
    const h = buildWsHarness(prisma, { relays: RELAY })
    await prisma.daemon.create({ data: { id: OTHER, orgId: DEFAULT_ORG_ID, maxAgents: 4, status: 'ready' } })
    await seedProvider('docs', 'oct_docs')
    const connectionId = await seedStdioConnection()
    await prisma.agent.create({
      data: {
        id: AGENT,
        orgId: DEFAULT_ORG_ID,
        name: 'not-mine',
        runtime: 'claude',
        daemonId: OTHER,
        runtimeOverrides: { mcpServers: ['docs'], memory: { provider: 'external', connectionId } }
      }
    })
    // The group exists but is held by ANOTHER member — same org, same registry.
    await seedGroup({ holder: OTHER, term: 1n, expiresAt: new Date(h.clock.now() + LEASE_MS) })

    const ok = await reconnectHolding(h)

    expect(ok.agents).toEqual([])
    expect(ok.mcpServers).toEqual([])
    expect(ok.memoryConnections).toEqual([])
  })

  it('an EXPIRED lease takes the definitions away with the agent', async () => {
    const h = buildWsHarness(prisma, { relays: RELAY })
    await prisma.daemon.create({ data: { id: OTHER, orgId: DEFAULT_ORG_ID, maxAgents: 4, status: 'ready' } })
    await seedProvider('docs', 'oct_docs')
    const connectionId = await seedStdioConnection()
    await prisma.agent.create({
      data: {
        id: AGENT,
        orgId: DEFAULT_ORG_ID,
        name: 'lapsed',
        runtime: 'claude',
        daemonId: OTHER,
        runtimeOverrides: { mcpServers: ['docs'], memory: { provider: 'external', connectionId } }
      }
    })
    await seedGroup({ holder: DAEMON, term: 1n, expiresAt: new Date(h.clock.now() - 1_000) })

    const ok = await reconnectHolding(h)

    expect(ok.mcpServers).toEqual([])
    expect(ok.memoryConnections).toEqual([])
  })
})

/**
 * A dependent REMOVAL carries a bare resource id, so on an install-wide
 * connection the org can only come from the explicit argument or from the id→org
 * map `register` built. A holder that acquired the resource through `duty/fetch`
 * never registered it, so the map has nothing — and the send raises SCOPE_DENIED
 * before the frame leaves the process (integration delete 500s after the row is
 * already gone; cron delete logs and returns success; either way the holder goes
 * on serving a deleted resource). Same class as #965, so the same fix: the org is
 * explicit and local to the send.
 */
describe('a dependent removal to a holder that never registered the resource', () => {
  const INTEGRATION = 'ffffffff-ffff-4fff-8fff-fffffffffff1'
  const CRON = 'ffffffff-ffff-4fff-8fff-fffffffffff2'

  /** An install-wide connection registered with EMPTY local state — exactly the
   *  member that installed through `duty/fetch` and has no id→org map entries. */
  async function readyWithNoRegisteredResources(h: ReturnType<typeof buildWsHarness>) {
    const { stub } = await ready(h)
    const state = h.deps.connReg.get(DaemonId(DAEMON))
    expect(state?.orgByIntegration?.size).toBe(0)
    expect(state?.orgByCron?.size).toBe(0)
    return { stub, sender: new ControlSender(h.deps.connReg, new PgLaunchRepo(prisma)) }
  }

  it('integration/remove rides the explicit org, and is refused without it', async () => {
    const h = buildWsHarness(prisma)
    const { stub, sender } = await readyWithNoRegisteredResources(h)

    await sender.integrationRemove(DAEMON, { integrationId: INTEGRATION }, DEFAULT_ORG_ID)
    const sent = stub.sent.find((f) => f.type === 'integration/remove')
    expect(sent?.orgId).toBe(DEFAULT_ORG_ID)

    // The regression pin: without it the frame never leaves. This is what made
    // the delete fail after the row was already gone.
    await expect(sender.integrationRemove(DAEMON, { integrationId: INTEGRATION })).rejects.toThrow(/organization/i)
    expect(stub.sent.filter((f) => f.type === 'integration/remove')).toHaveLength(1)
  })

  it('cron/remove rides the explicit org, and is refused without it', async () => {
    const h = buildWsHarness(prisma)
    const { stub, sender } = await readyWithNoRegisteredResources(h)

    // REQ→ack: the stub never answers, so assert on what was SENT, not the reply.
    void sender.cronRemove(DAEMON, { cronId: CRON }, DEFAULT_ORG_ID)
    await vi.waitFor(() => expect(stub.sent.some((f) => f.type === 'cron/remove')).toBe(true))
    expect(stub.sent.find((f) => f.type === 'cron/remove')?.orgId).toBe(DEFAULT_ORG_ID)

    await expect(sender.cronRemove(DAEMON, { cronId: CRON })).rejects.toThrow(/organization/i)
    expect(stub.sent.filter((f) => f.type === 'cron/remove')).toHaveLength(1)
  })
})

describe('duty lease exchange — scope gate and allocation coherence', () => {
  it('an org-scoped daemon sending duties is ignored: no frames, no ledger writes', async () => {
    await seedGroup()
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h, { orgScoped: true })

    stub.inject('heartbeat', heartbeat({ held: [], headroom: 4 }))
    await new Promise((r) => setTimeout(r, 25))
    expect(stub.sent.filter((f) => f.type.startsWith('duty/'))).toEqual([])
    const row = await prisma.dutyGroup.findUniqueOrThrow({ where: { id: GROUP } })
    expect(row.holder).toBeNull()
  })

  it('an org-scoped daemon calling duty/release gets SCOPE_DENIED and vacates nothing', async () => {
    const h = buildWsHarness(prisma)
    const start = new Date(h.clock.now())
    await seedGroup({ holder: DAEMON, term: 1n, expiresAt: new Date(start.getTime() + LEASE_MS) })
    const { stub } = await ready(h, { orgScoped: true })

    stub.inject('duty/release', { groupIds: [GROUP] }, { id: REL_ID })
    const err = await stub.expectFrame('error')
    if (!isFrame('error')(err)) throw new Error('expected error')
    expect(err.corr).toBe(REL_ID)
    expect(err.payload.code).toBe('SCOPE_DENIED')
    const row = await prisma.dutyGroup.findUniqueOrThrow({ where: { id: GROUP } })
    expect(row.holder).toBe(DAEMON)
  })

  it('missing-from-digest regrants are charged against headroom before fresh claims', async () => {
    // The ledger already holds GROUP for this member; a second group sits vacant.
    const h = buildWsHarness(prisma)
    const start = new Date(h.clock.now())
    await seedGroup({ holder: DAEMON, term: 1n, expiresAt: new Date(start.getTime() + LEASE_MS) })
    await prisma.dutyGroup.create({ data: { id: GROUP2, orgId: DEFAULT_ORG_ID, term: 0n } })
    await prisma.dutyGroupMember.create({
      data: { kind: 'agent', refId: AGENT2, groupId: GROUP2, orgId: DEFAULT_ORG_ID }
    })
    const { stub } = await ready(h)

    // Restart shape: empty digest, headroom 1 — the missing regrant consumes the slot.
    stub.inject('heartbeat', heartbeat({ held: [], headroom: 1 }))
    const grant = await stub.expectFrame('duty/grant')
    if (!isFrame('duty/grant')(grant)) throw new Error('expected duty/grant')
    expect(grant.payload.grants).toHaveLength(1)
    expect(grant.payload.grants[0]).toMatchObject({ groupId: GROUP, term: '1' })
    const vacant = await prisma.dutyGroup.findUniqueOrThrow({ where: { id: GROUP2 } })
    expect(vacant.holder).toBeNull()
  })

  it('a vacant digest group re-claimed in the same beat is granted, never also revoked', async () => {
    // The member believes it holds GROUP, but the lease lapsed (e.g. a long partition).
    const h = buildWsHarness(prisma)
    await seedGroup({ holder: DAEMON, term: 1n, expiresAt: new Date(h.clock.now() - 1) })
    // renewHeld would refresh a still-holder row; simulate a release-then-nobody state instead.
    await prisma.dutyGroup.update({ where: { id: GROUP }, data: { holder: null, expiresAt: null } })
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat({ held: [{ groupId: GROUP, term: '1' }], headroom: 1 }))
    const grant = await stub.expectFrame('duty/grant')
    if (!isFrame('duty/grant')(grant)) throw new Error('expected duty/grant')
    expect(grant.payload.grants).toEqual([
      { groupId: GROUP, orgId: DEFAULT_ORG_ID, term: '2', members: [{ kind: 'agent', refId: AGENT }] }
    ])
    await new Promise((r) => setTimeout(r, 25))
    expect(stub.sent.filter((f) => f.type === 'duty/revoke')).toEqual([])
  })
})

describe('duty lease exchange — wire safety', () => {
  it('reconnect regrants are chunked so no duty/grant frame exceeds the emission budget', async () => {
    const h = buildWsHarness(prisma, { dutyLease: { grantsPerFrame: 2 } })
    const start = new Date(h.clock.now())
    const horizon = new Date(start.getTime() + LEASE_MS)
    for (let i = 0; i < 3; i++) {
      const gid = `00000000-0000-4000-8000-00000000001${i}`
      await prisma.dutyGroup.create({
        data: { id: gid, orgId: DEFAULT_ORG_ID, holder: DAEMON, term: 1n, expiresAt: horizon }
      })
      await prisma.dutyGroupMember.create({
        data: { kind: 'agent', refId: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa1${i}`, groupId: gid, orgId: DEFAULT_ORG_ID }
      })
    }
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat({ held: [], headroom: 3 }))
    const first = await stub.expectFrame('duty/grant')
    if (!isFrame('duty/grant')(first)) throw new Error('expected duty/grant')
    await vi.waitFor(() => {
      const frames = stub.sent.filter((f) => f.type === 'duty/grant')
      expect(frames).toHaveLength(2)
    })
    const sizes = stub.sent
      .filter((f) => f.type === 'duty/grant')
      .map((f) => (f.payload as { grants: unknown[] }).grants.length)
      .sort()
    expect(sizes).toEqual([1, 2])
  })

  it('an oversized vacancy is never claimed and never starves the valid one behind it', async () => {
    // 1001 members exceeds DutyGrantEntry.members.max — excluded at the claim
    // boundary. GROUP sorts BEFORE GROUP2, so without the size gate it would
    // consume the claim budget every beat.
    await prisma.dutyGroup.create({ data: { id: GROUP, orgId: DEFAULT_ORG_ID, term: 0n } })
    await prisma.dutyGroupMember.createMany({
      data: Array.from({ length: 1001 }, (_, i) => ({
        kind: 'agent' as const,
        refId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`,
        groupId: GROUP,
        orgId: DEFAULT_ORG_ID
      }))
    })
    await prisma.dutyGroup.create({ data: { id: GROUP2, orgId: DEFAULT_ORG_ID, term: 0n } })
    await prisma.dutyGroupMember.create({
      data: { kind: 'agent', refId: AGENT2, groupId: GROUP2, orgId: DEFAULT_ORG_ID }
    })
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat({ held: [], headroom: 1 }))
    const grant = await stub.expectFrame('duty/grant')
    if (!isFrame('duty/grant')(grant)) throw new Error('expected duty/grant')
    expect(grant.payload.grants).toHaveLength(1)
    expect(grant.payload.grants[0]).toMatchObject({ groupId: GROUP2 })
    const oversized = await prisma.dutyGroup.findUniqueOrThrow({ where: { id: GROUP } })
    expect(oversized.holder).toBeNull()
    expect(oversized.term).toBe(0n)
  })

  it('an oversized lease the member does not serve vacates instead of renewing forever', async () => {
    const h = buildWsHarness(prisma)
    const start = new Date(h.clock.now())
    await prisma.dutyGroup.create({
      data: {
        id: GROUP,
        orgId: DEFAULT_ORG_ID,
        holder: DAEMON,
        term: 1n,
        expiresAt: new Date(start.getTime() + LEASE_MS)
      }
    })
    await prisma.dutyGroupMember.createMany({
      data: Array.from({ length: 1001 }, (_, i) => ({
        kind: 'agent' as const,
        refId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`,
        groupId: GROUP,
        orgId: DEFAULT_ORG_ID
      }))
    })
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat({ held: [], headroom: 0 }))
    await new Promise((r) => setTimeout(r, 100))
    expect(stub.sent.filter((f) => f.type === 'duty/grant')).toEqual([])
    const row = await prisma.dutyGroup.findUniqueOrThrow({ where: { id: GROUP } })
    expect(row.holder).toBeNull()
    expect(row.expiresAt).toBeNull()
    expect(row.term).toBe(1n)
  })

  it('a held group grown past the cap at a stale term is superseded and vacated, not renewed', async () => {
    const h = buildWsHarness(prisma)
    const start = new Date(h.clock.now())
    await prisma.dutyGroup.create({
      data: {
        id: GROUP,
        orgId: DEFAULT_ORG_ID,
        holder: DAEMON,
        term: 2n,
        expiresAt: new Date(start.getTime() + LEASE_MS)
      }
    })
    await prisma.dutyGroupMember.createMany({
      data: Array.from({ length: 1001 }, (_, i) => ({
        kind: 'agent' as const,
        refId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`,
        groupId: GROUP,
        orgId: DEFAULT_ORG_ID
      }))
    })
    const { stub } = await ready(h)

    // The daemon still serves the pre-growth composition at term 1.
    stub.inject('heartbeat', heartbeat({ held: [{ groupId: GROUP, term: '1' }], headroom: 0 }))
    const revoke = await stub.expectFrame('duty/revoke')
    if (!isFrame('duty/revoke')(revoke)) throw new Error('expected duty/revoke')
    expect(revoke.payload.revocations).toEqual([{ groupId: GROUP, reason: 'superseded' }])
    expect(stub.sent.filter((f) => f.type === 'duty/grant')).toEqual([])
    const row = await prisma.dutyGroup.findUniqueOrThrow({ where: { id: GROUP } })
    expect(row.holder).toBeNull()
    expect(row.expiresAt).toBeNull()
  })

  it('an overlapping beat cannot double-spend headroom (single-flight per daemon)', async () => {
    // Two vacant groups, headroom 1: back-to-back beats dispatched without
    // awaiting must yield at most one grant — the second beat is dropped.
    await seedGroup()
    await prisma.dutyGroup.create({ data: { id: GROUP2, orgId: DEFAULT_ORG_ID, term: 0n } })
    await prisma.dutyGroupMember.create({
      data: { kind: 'agent', refId: AGENT2, groupId: GROUP2, orgId: DEFAULT_ORG_ID }
    })
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat({ held: [], headroom: 1 }))
    stub.inject('heartbeat', heartbeat({ held: [], headroom: 1 }))
    await stub.expectFrame('duty/grant')
    await new Promise((r) => setTimeout(r, 50))

    const grantedTotal = stub.sent
      .filter((f) => f.type === 'duty/grant')
      .reduce((n, f) => n + (f.payload as { grants: unknown[] }).grants.length, 0)
    expect(grantedTotal).toBe(1)
    const holders = await prisma.dutyGroup.findMany({ where: { holder: DAEMON } })
    expect(holders).toHaveLength(1)
  })
})

describe('duty lease exchange — drain barrier', () => {
  it('a release behind a granting beat queues: the grant reaches the wire before the ack', async () => {
    // The daemon holds GROUP; a beat that grants GROUP2 is immediately followed
    // by its drain's duty/release for GROUP. Lane order is frame order (the
    // lane is reserved synchronously at dispatch), so this is deterministic:
    // the exchange's grant is emitted BEFORE the release's ack, GROUP is
    // vacated, and GROUP2 is coherently held — never a grant after the ack.
    const h = buildWsHarness(prisma)
    const start = new Date(h.clock.now())
    await seedGroup({ holder: DAEMON, term: 1n, expiresAt: new Date(start.getTime() + LEASE_MS) })
    await prisma.dutyGroup.create({ data: { id: GROUP2, orgId: DEFAULT_ORG_ID, term: 0n } })
    await prisma.dutyGroupMember.create({
      data: { kind: 'agent', refId: AGENT2, groupId: GROUP2, orgId: DEFAULT_ORG_ID }
    })
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat({ held: [{ groupId: GROUP, term: '1' }], headroom: 1 }))
    stub.inject('duty/release', { groupIds: [GROUP] }, { id: REL_ID })
    const ack = await stub.expectFrame('ack')
    expect(ack.corr).toBe(REL_ID)

    const grantIdx = stub.sent.findIndex((f) => f.type === 'duty/grant')
    const ackIdx = stub.sent.findIndex((f) => f.type === 'ack')
    expect(grantIdx).toBeGreaterThanOrEqual(0)
    expect(grantIdx).toBeLessThan(ackIdx)

    const released = await prisma.dutyGroup.findUniqueOrThrow({ where: { id: GROUP } })
    expect(released.holder).toBeNull()
    const granted = await prisma.dutyGroup.findUniqueOrThrow({ where: { id: GROUP2 } })
    expect(granted.holder).toBe(DAEMON)
  })
})

describe('duty/claim — the activation rendezvous (real Postgres)', () => {
  const CLAIM_ID = '66666666-6666-4666-8666-666666666666'

  // Placed on the POOL: the rendezvous applies the same eligibility gate as the heartbeat claim,
  // so an install-wide member may only claim an agent whose placement is the pool.
  async function seedAgentRow(): Promise<void> {
    await prisma.agent.create({
      data: { id: AGENT, orgId: DEFAULT_ORG_ID, name: 'agent-1', runtime: 'claude', placementKind: 'pool' }
    })
  }

  it('an unheld agent is claimed on the spot and the grant comes back installable', async () => {
    await seedAgentRow()
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h)

    stub.inject('duty/claim', { agentId: AGENT }, { id: CLAIM_ID })
    const ok = await stub.expectFrame('duty/claim/ok')
    if (!isFrame('duty/claim/ok')(ok)) throw new Error('expected duty/claim/ok')
    expect(ok.corr).toBe(CLAIM_ID)
    expect(ok.payload.granted).toBe(true)
    expect(ok.payload.grant).toMatchObject({
      orgId: DEFAULT_ORG_ID,
      term: '1',
      members: [{ kind: 'agent', refId: AGENT }]
    })

    const row = await prisma.dutyGroup.findUniqueOrThrow({ where: { id: ok.payload.grant!.groupId } })
    expect(row.holder).toBe(DAEMON)
  })

  it('a claim lost to a live incumbent names the winner instead', async () => {
    await seedAgentRow()
    const h = buildWsHarness(prisma)
    const start = new Date(h.clock.now())
    await prisma.dutyGroup.create({
      data: {
        id: GROUP,
        orgId: DEFAULT_ORG_ID,
        holder: OTHER,
        term: 4n,
        expiresAt: new Date(start.getTime() + LEASE_MS)
      }
    })
    await prisma.dutyGroupMember.create({
      data: { kind: 'agent', refId: AGENT, groupId: GROUP, orgId: DEFAULT_ORG_ID }
    })
    const { stub } = await ready(h)

    stub.inject('duty/claim', { agentId: AGENT }, { id: CLAIM_ID })
    const ok = await stub.expectFrame('duty/claim/ok')
    if (!isFrame('duty/claim/ok')(ok)) throw new Error('expected duty/claim/ok')
    expect(ok.payload).toEqual({ granted: false, holder: OTHER })
  })

  it('re-claiming what this member already holds is idempotent — no term churn', async () => {
    await seedAgentRow()
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h)

    stub.inject('duty/claim', { agentId: AGENT }, { id: CLAIM_ID })
    const first = await stub.expectFrame('duty/claim/ok')
    if (!isFrame('duty/claim/ok')(first)) throw new Error('expected duty/claim/ok')
    const groupId = first.payload.grant!.groupId

    stub.inject('duty/claim', { agentId: AGENT }, { id: REL_ID })
    const second = await stub.expectFrame('duty/claim/ok')
    if (!isFrame('duty/claim/ok')(second)) throw new Error('expected duty/claim/ok')
    expect(second.payload.granted).toBe(true)
    expect(second.payload.grant).toMatchObject({ groupId, term: '1' })
  })

  it('an unknown agent is refused without naming anyone', async () => {
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h)

    stub.inject('duty/claim', { agentId: AGENT }, { id: CLAIM_ID })
    const ok = await stub.expectFrame('duty/claim/ok')
    if (!isFrame('duty/claim/ok')(ok)) throw new Error('expected duty/claim/ok')
    expect(ok.payload).toEqual({ granted: false })
  })

  it('an org-scoped connection cannot claim at all', async () => {
    await seedAgentRow()
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h, { orgScoped: true })

    stub.inject('duty/claim', { agentId: AGENT }, { id: CLAIM_ID })
    const err = await stub.expectFrame('error')
    if (!isFrame('error')(err)) throw new Error('expected error')
    expect(err.payload.code).toBe('SCOPE_DENIED')
    expect(await prisma.dutyGroup.count()).toBe(0)
  })
})

describe('proactive healing after a rollout (protocol level, real Postgres)', () => {
  // The live failure this whole change exists to end: a member is replaced by a rollout, its lease
  // lapses, the group becomes a claimable vacancy — and under the incumbent policy NOTHING claimed
  // it, because the vacancy's agents named a Pod that no longer exists. Healing waited for a
  // trigger, and for webchat the trigger could not even be sent (#987).
  //
  // Mutation check: restoring the incumbent gate (only groups with an agent whose `daemonId` is
  // the claimant) makes this fail — a pool agent has no `daemonId` at all, so no member qualifies.
  it('re-grants a lapsed holder’s group to a live member with no trigger involved', async () => {
    const start = 1_700_000_000_000
    const h = buildWsHarness(prisma)
    // The replaced Pod: it held the group, and its lease ran out 1ms ago.
    await seedGroup({ holder: OTHER, term: 4n, expiresAt: new Date(start - 1) })
    await prisma.agent.create({
      data: { id: AGENT, orgId: DEFAULT_ORG_ID, name: 'webchat-only', runtime: 'claude', placementKind: 'pool' }
    })
    const { stub } = await ready(h)

    // A plain heartbeat. No rd/msg, no duty/claim, no console send — nothing but the beat.
    stub.inject('heartbeat', heartbeat({ held: [], headroom: 4 }))
    const grant = await stub.expectFrame('duty/grant')
    if (!isFrame('duty/grant')(grant)) throw new Error('expected duty/grant')
    expect(grant.payload.grants[0]).toMatchObject({ groupId: GROUP, term: '5' })

    const row = await prisma.dutyGroup.findUniqueOrThrow({ where: { id: GROUP } })
    expect(row.holder).toBe(DAEMON)
  })

  it('a member at capacity does not claim, however healable the vacancy is', async () => {
    const start = 1_700_000_000_000
    const h = buildWsHarness(prisma)
    await seedGroup({ holder: OTHER, term: 4n, expiresAt: new Date(start - 1) })
    await prisma.agent.create({
      data: { id: AGENT, orgId: DEFAULT_ORG_ID, name: 'webchat-only', runtime: 'claude', placementKind: 'pool' }
    })
    const { stub } = await ready(h)

    stub.inject('heartbeat', heartbeat({ held: [], headroom: 0 }))
    await stub.expectFrame('duty/renewed')
    expect(stub.sent.filter((f) => f.type === 'duty/grant')).toEqual([])
    const row = await prisma.dutyGroup.findUniqueOrThrow({ where: { id: GROUP } })
    expect(row.holder).toBe(OTHER)
  })

  it('bounds a group one member cannot install: the lease is handed back and not re-offered to it', async () => {
    // A refused grant is invisible on the wire — the member simply never reports the group — and
    // `renewHeld` renews by holder alone, so without this the group would sit on the one member
    // that cannot serve it for as long as it keeps beating. Counting consecutive absences is what
    // turns "wedged forever" into "rotated to a member that can".
    const h = buildWsHarness(prisma, { dutyLease: { refusalsBeforeRelease: 3, refusalBackoffMs: 300_000 } })
    const start = new Date(h.clock.now())
    await seedGroup({ holder: DAEMON, term: 1n, expiresAt: new Date(start.getTime() + LEASE_MS) })
    await prisma.agent.create({
      data: { id: AGENT, orgId: DEFAULT_ORG_ID, name: 'uninstallable', runtime: 'claude', placementKind: 'pool' }
    })
    const { stub } = await ready(h)

    // Two beats: an install may legitimately straddle one, so these are re-offers, not refusals.
    for (let n = 0; n < 2; n += 1) {
      await beat(stub, { held: [], headroom: 4 })
      expect((await prisma.dutyGroup.findUniqueOrThrow({ where: { id: GROUP } })).holder).toBe(DAEMON)
    }
    expect(stub.sent.filter((f) => f.type === 'duty/grant')).toHaveLength(2)

    // The third consecutive absence is a refusal: the lease goes back.
    await beat(stub, { held: [], headroom: 4 })
    expect((await prisma.dutyGroup.findUniqueOrThrow({ where: { id: GROUP } })).holder).toBeNull()

    // And it is NOT handed straight back to the member that just refused it — that rotation is
    // exactly what would spin every beat.
    await beat(stub, { held: [], headroom: 4 })
    expect((await prisma.dutyGroup.findUniqueOrThrow({ where: { id: GROUP } })).holder).toBeNull()
    expect(stub.sent.filter((f) => f.type === 'duty/grant')).toHaveLength(2)

    // A different member takes it immediately — the point of handing it back.
    const repo = new PgDutyGroupRepo(prisma)
    const grants = await repo.claimVacant(DaemonId(OTHER), 1, new Date(h.clock.now()), LEASE_MS, {
      scope: 'install-wide'
    })
    expect(grants.map((g) => g.groupId)).toEqual([GROUP])
  })

  it('reporting the group at any point clears the count — that is convergence, not refusal', async () => {
    const h = buildWsHarness(prisma, { dutyLease: { refusalsBeforeRelease: 2 } })
    const start = new Date(h.clock.now())
    await seedGroup({ holder: DAEMON, term: 1n, expiresAt: new Date(start.getTime() + LEASE_MS) })
    const { stub } = await ready(h)

    await beat(stub, { held: [], headroom: 0 })
    await beat(stub, { held: [{ groupId: GROUP, term: '1' }], headroom: 0 })
    // The count restarts, so this absence is the FIRST, not the threshold-crossing second.
    await beat(stub, { held: [], headroom: 0 })

    expect((await prisma.dutyGroup.findUniqueOrThrow({ where: { id: GROUP } })).holder).toBe(DAEMON)
  })
})
