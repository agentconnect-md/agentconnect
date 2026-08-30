/**
 * Reconnect state as a combined multi-org snapshot (k8s-daemon-pool.md M4).
 *
 * A pool member serves several organizations over ONE install-wide connection, so
 * its reconnect story must converge every org it serves without `subscribe(org)`,
 * an org room, or an org-specific socket. The mechanism is three existing pieces
 * on the same wire, and this suite pins each one end to end over real Postgres:
 *
 *  1. `register/ok` — the combined snapshot: ONE install-wide frame (no envelope
 *     org) whose payload entries each carry their own org, covering every org the
 *     member serves — including edits and deletes that landed while it was away.
 *  2. The register-time visibility replay — org-scoped `session/visibility/snapshot`
 *     frames on the same connection, one bucket per org, acked per revision.
 *  3. The duty exchange's reconnect crossing point — a stale digest term is
 *     answered by re-issuing the grant at the current term, stamped with each
 *     org's current `Agent.configRevision`, on install-wide `duty/grant` frames.
 */
import { describe, it, expect } from 'vitest'
import { isFrame, SESSION_VISIBILITY_FEATURE } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildWsHarness, type WsHarness } from '../fakes/build-ws.js'
import type { CapturedFrame, InMemoryDaemonStub } from '../fakes/daemon-stub.js'
import { poolSetId } from '../fakes/member-set.js'
import { seedAgent, seedDutyGroup, seedSessionMeta } from '../fixtures/seed.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { PgAgentRepo, PgDutyGroupRepo, PgLaunchRepo, PgSessionRepo } from '../../src/persistence/index.js'
import { ControlSender } from '../../src/orchestrator/outbound.js'
import { PlacementResolver } from '../../src/orchestrator/placementResolver.js'
import { SessionVisibilityPushService } from '../../src/orchestrator/visibilityPush.js'
import { OrgId, SessionId } from '../../src/domain/ids.js'

const MEMBER = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1'
const ORG_B = 'org-b-multi-reconnect'
const AGENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab1'
const AGENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
const GROUP_A = '00000000-0000-4000-8000-00000000a0a1'
const GROUP_B = '00000000-0000-4000-8000-00000000b0b2'
const CRON_A = '00000000-0000-4000-8000-00000000c0a1'
const CRON_B = '00000000-0000-4000-8000-00000000c0b2'

const LEASE_MS = 120_000

/** Both orgs' agents duty-held by MEMBER: one live group per org (components are per org). */
async function seedTwoOrgHoldings(h: WsHarness): Promise<void> {
  await prisma.org.create({ data: { id: ORG_B, slug: ORG_B } })
  const setId = await poolSetId(prisma)
  await seedAgent(prisma, AGENT_A, { setId, name: 'agent-a' })
  await seedAgent(prisma, AGENT_B, { setId, name: 'agent-b', orgId: ORG_B })
  const expiresAt = new Date(h.clock.now() + LEASE_MS)
  await seedDutyGroup(prisma, GROUP_A, MEMBER, [AGENT_A], { expiresAt })
  await seedDutyGroup(prisma, GROUP_B, MEMBER, [AGENT_B], { expiresAt, orgId: ORG_B })
}

async function connectAndAuth(h: WsHarness, saToken: string) {
  const { conn, stub } = h.connect()
  stub.inject('auth', { serviceAccountToken: saToken, daemonId: MEMBER, agentVersion: '1.4.0' })
  await stub.expectFrame('auth/ok')
  return { conn, stub }
}

async function register(
  stub: InMemoryDaemonStub,
  localState: {
    crons?: string[]
    agents?: { agentId: string; origin: 'cp' | 'unknown' }[]
  } = {},
  features: string[] = []
): Promise<CapturedFrame> {
  stub.inject('register', {
    host: 'member-1',
    capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true, features },
    maxAgents: 8,
    localState: {
      assignments: [],
      crons: localState.crons ?? [],
      leases: [],
      agents: localState.agents ?? [],
      integrations: [],
      stagedAgents: []
    }
  })
  return stub.expectFrame('register/ok')
}

async function seedCron(id: string, orgId: string, agentId: string): Promise<void> {
  await prisma.cronDef.create({
    data: { id, orgId, agentId, schedule: '0 9 * * *', timezone: 'UTC', trigger: 'daily check-in', enabled: true }
  })
}

describe('reconnect state as a combined multi-org snapshot (M4)', () => {
  it('one install-wide register/ok converges two orgs edited and deleted while the member was away', async () => {
    const h = buildWsHarness(prisma)
    const saToken = await h.mintPoolMember(MEMBER)
    const first = await connectAndAuth(h, saToken)
    await seedTwoOrgHoldings(h)
    await seedCron(CRON_A, DEFAULT_ORG_ID, AGENT_A)
    await seedCron(CRON_B, ORG_B, AGENT_B)

    // The pre-disconnect snapshot already combines both orgs on one org-free envelope.
    const ok1 = await register(first.stub)
    if (!isFrame('register/ok')(ok1)) throw new Error('expected register/ok')
    expect(ok1.orgId).toBeUndefined()
    const byAgent = new Map(ok1.payload.agents.map((a) => [a.agentId, a]))
    expect(byAgent.get(AGENT_A)?.orgId).toBe(DEFAULT_ORG_ID)
    expect(byAgent.get(AGENT_B)?.orgId).toBe(ORG_B)
    expect(new Map(ok1.payload.crons.map((c) => [c.cronId, c.orgId]))).toEqual(
      new Map([
        [CRON_A, DEFAULT_ORG_ID],
        [CRON_B, ORG_B]
      ])
    )
    const revisionBefore = BigInt(byAgent.get(AGENT_A)!.configRevision!)

    // The link drops; both orgs mutate while the member is away.
    first.stub.close(1000, 'link lost')
    await prisma.agent.update({
      where: { id: AGENT_A },
      data: { name: 'renamed-while-away', configRevision: { increment: 1n } }
    })
    await prisma.agent.delete({ where: { id: AGENT_B } }) // duty membership and the local replica outlive the row

    // Reconnect claiming both replicas: ONE snapshot converges both orgs.
    const second = await connectAndAuth(h, saToken)
    const ok2 = await register(second.stub, {
      crons: [CRON_A, CRON_B],
      agents: [
        { agentId: AGENT_A, origin: 'cp' },
        { agentId: AGENT_B, origin: 'cp' }
      ]
    })
    if (!isFrame('register/ok')(ok2)) throw new Error('expected register/ok')
    expect(ok2.orgId).toBeUndefined()

    // The edited org converges through the revision fence; the deleted org through the drop set.
    const agentA = ok2.payload.agents.find((a) => a.agentId === AGENT_A)
    expect(agentA).toMatchObject({ orgId: DEFAULT_ORG_ID, name: 'renamed-while-away' })
    expect(BigInt(agentA!.configRevision!)).toBe(revisionBefore + 1n)
    expect(ok2.payload.agents.map((a) => a.agentId)).not.toContain(AGENT_B)
    expect(ok2.payload.drop.agents).toEqual([{ agentId: AGENT_B, action: 'remove' }])
    expect(ok2.payload.crons.map((c) => c.cronId)).toEqual([CRON_A])
    expect(ok2.payload.drop.crons).toEqual([CRON_B])
  })

  it('register-time visibility replay reaches both orgs as org-scoped snapshots on the same connection', async () => {
    const h = buildWsHarness(prisma)
    const saToken = await h.mintPoolMember(MEMBER)
    await seedTwoOrgHoldings(h)

    // Both orgs tightened a session while the member was away.
    const sessions = new PgSessionRepo(prisma)
    const sessionA = await seedSessionMeta(prisma, `s-a-${MEMBER.slice(0, 8)}`, AGENT_A)
    const sessionB = await seedSessionMeta(prisma, `s-b-${MEMBER.slice(0, 8)}`, AGENT_B, { orgId: ORG_B })
    await sessions.setVisibility(OrgId(DEFAULT_ORG_ID), SessionId(sessionA), 'private')
    await sessions.setVisibility(OrgId(ORG_B), SessionId(sessionB), 'private')

    // The replay service as the container wires it, over the harness's live registry.
    h.deps.visibilityPush = new SessionVisibilityPushService({
      repos: { session: sessions, agent: new PgAgentRepo(prisma) },
      control: new ControlSender(h.deps.connReg, new PgLaunchRepo(prisma)),
      connReg: h.deps.connReg,
      placement: new PlacementResolver({ duties: new PgDutyGroupRepo(prisma), clock: h.clock }),
      duties: new PgDutyGroupRepo(prisma),
      clock: h.clock
    })

    const { stub } = await connectAndAuth(h, saToken)
    // Frame mode: the ack must carry the org of the snapshot it answers.
    stub.respondTo('session/visibility/snapshot', (req) => ({
      type: 'ack',
      payload: { ok: true },
      ...(req.orgId ? { orgId: req.orgId } : {})
    }))
    const ok = await register(stub, {}, [SESSION_VISIBILITY_FEATURE])
    expect(isFrame('register/ok')(ok)).toBe(true)
    await stub.settled()

    // One org-scoped snapshot per org, entries never mixed across orgs.
    const snapshots = stub.sent.filter((f) => f.type === 'session/visibility/snapshot')
    const byOrg = new Map(
      snapshots.map((f) => [
        f.orgId,
        (f.payload as { entries: { sessionId: string; visibilityRev: number }[] }).entries
      ])
    )
    expect([...byOrg.keys()].sort()).toEqual([DEFAULT_ORG_ID, ORG_B].sort())
    expect(byOrg.get(DEFAULT_ORG_ID)).toEqual([
      expect.objectContaining({ sessionId: sessionA, agentId: AGENT_A, visibility: 'private', visibilityRev: 1 })
    ])
    expect(byOrg.get(ORG_B)).toEqual([
      expect.objectContaining({ sessionId: sessionB, agentId: AGENT_B, visibility: 'private', visibilityRev: 1 })
    ])

    // The acks landed as watermarks: nothing is left unconverged in either org.
    expect(await sessions.countUnackedVisibilityForAgents([AGENT_A])).toBe(0)
    expect(await sessions.countUnackedVisibilityForAgents([AGENT_B])).toBe(0)
  })

  it('a stale digest re-issues both orgs at current terms and revisions on install-wide duty frames', async () => {
    const h = buildWsHarness(prisma)
    const saToken = await h.mintPoolMember(MEMBER)
    await seedTwoOrgHoldings(h)
    // Both orgs' terms and specs moved while the member was away.
    await prisma.dutyGroup.updateMany({ where: { id: { in: [GROUP_A, GROUP_B] } }, data: { term: 2n } })
    await prisma.agent.update({ where: { id: AGENT_A }, data: { configRevision: { increment: 1n } } })
    await prisma.agent.update({ where: { id: AGENT_B }, data: { configRevision: { increment: 1n } } })
    const currentRevision = async (id: string) =>
      (await prisma.agent.findUniqueOrThrow({ where: { id }, select: { configRevision: true } })).configRevision

    const { stub } = await connectAndAuth(h, saToken)
    await register(stub)

    // The reconnect crossing point: the digest still carries the pre-disconnect terms.
    stub.inject('heartbeat', {
      load: { cpu: 0.1, mem: 0.1, agents: 2 },
      health: 'ok',
      activeSessions: 0,
      duties: {
        held: [
          { groupId: GROUP_A, term: '1' },
          { groupId: GROUP_B, term: '1' }
        ],
        headroom: 0
      }
    })
    await stub.settled()

    const grants = stub.sent.filter((f) => f.type === 'duty/grant')
    expect(grants).toHaveLength(1)
    expect(grants[0]!.orgId).toBeUndefined() // duty frames are install-wide; the org rides each entry
    if (!isFrame('duty/grant')(grants[0]!)) throw new Error('expected duty/grant')
    expect(grants[0]!.payload.grants).toEqual([
      {
        groupId: GROUP_A,
        orgId: DEFAULT_ORG_ID,
        term: '2',
        members: [
          {
            kind: 'agent',
            refId: AGENT_A,
            configRevision: (await currentRevision(AGENT_A)).toString(),
            placement: 'set'
          }
        ]
      },
      {
        groupId: GROUP_B,
        orgId: ORG_B,
        term: '2',
        members: [
          {
            kind: 'agent',
            refId: AGENT_B,
            configRevision: (await currentRevision(AGENT_B)).toString(),
            placement: 'set'
          }
        ]
      }
    ])
    // Nothing was revoked, and the renewal confirmation closed the exchange.
    expect(stub.sent.filter((f) => f.type === 'duty/revoke')).toEqual([])
    const order = stub.sent.map((f) => f.type)
    expect(order.indexOf('duty/renewed')).toBeGreaterThan(order.indexOf('duty/grant'))
  })
})
