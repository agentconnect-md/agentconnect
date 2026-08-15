// The two placement axes must never disagree (real Postgres).
//
// `servedAgents(daemon)` is member→agents; `PlacementResolver.servingDaemons(agent)` is
// agent→members. Neither is expressible as the other without scanning the opposite side, so both
// exist — and #989 and this change introduced them independently. What keeps them honest is that
// each half reads ONE predicate from its own side: the placement half is `listForDaemon`
// (`placementKind:'daemon'` + `daemonId`) against `domain/placement.ts#placementTargets`, and the
// duty half is the same live-lease join read from either end.
//
// This pins the biconditional over a fixture that mixes every placement kind. It is the test that
// fails if someone widens one side's SQL without the other — the drift the pair exists to prevent.
import { describe, it, expect } from 'vitest'
import { prisma } from '../setup.db.js'
import { PgAgentRepo, PgDutyGroupRepo } from '../../src/persistence/index.js'
import { servedAgents } from '../../src/orchestrator/servedAgents.js'
import { PlacementResolver } from '../../src/orchestrator/placementResolver.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { DaemonId } from '../../src/domain/ids.js'
import { FakeClock } from '../fakes/fake-clock.js'

const LOCAL = DaemonId('d1111111-1111-4111-8111-111111111111')
const MEMBER_A = DaemonId('d2222222-2222-4222-8222-222222222222')
const MEMBER_B = DaemonId('d3333333-3333-4333-8333-333333333333')

const ON_LOCAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const ON_POOL_HELD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const ON_POOL_VACANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'
const UNPLACED_AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4'
const GROUP = '00000000-0000-4000-8000-000000000001'

const LEASE_MS = 120_000

async function seedFixture(now: Date): Promise<void> {
  await prisma.daemon.createMany({
    data: [
      { id: LOCAL, orgId: DEFAULT_ORG_ID, maxAgents: 8, status: 'ready' },
      { id: MEMBER_A, orgId: null, maxAgents: 8, status: 'ready' },
      { id: MEMBER_B, orgId: null, maxAgents: 8, status: 'ready' }
    ]
  })
  await prisma.agent.createMany({
    data: [
      { id: ON_LOCAL, orgId: DEFAULT_ORG_ID, name: 'on-local', runtime: 'claude', daemonId: LOCAL },
      { id: ON_POOL_HELD, orgId: DEFAULT_ORG_ID, name: 'pool-held', runtime: 'claude', placementKind: 'pool' },
      { id: ON_POOL_VACANT, orgId: DEFAULT_ORG_ID, name: 'pool-vacant', runtime: 'claude', placementKind: 'pool' },
      { id: UNPLACED_AGENT, orgId: DEFAULT_ORG_ID, name: 'unplaced', runtime: 'claude' }
    ]
  })
  // MEMBER_A holds the one pool agent that is actually served.
  await prisma.dutyGroup.create({
    data: {
      id: GROUP,
      orgId: DEFAULT_ORG_ID,
      holder: MEMBER_A,
      term: 1n,
      expiresAt: new Date(now.getTime() + LEASE_MS)
    }
  })
  await prisma.dutyGroupMember.create({
    data: { kind: 'agent', refId: ON_POOL_HELD, groupId: GROUP, orgId: DEFAULT_ORG_ID }
  })
}

describe('the two placement axes agree (real Postgres)', () => {
  it('D ∈ servingDaemons(A) ⟺ A ∈ servedAgents(D) for every agent and every daemon', async () => {
    const clock = new FakeClock(1_700_000_000_000)
    const now = new Date(clock.now())
    await seedFixture(now)
    const agents = new PgAgentRepo(prisma)
    const duties = new PgDutyGroupRepo(prisma)
    const resolver = new PlacementResolver({ duties, clock })

    const daemons = [LOCAL, MEMBER_A, MEMBER_B]
    const agentIds = [ON_LOCAL, ON_POOL_HELD, ON_POOL_VACANT, UNPLACED_AGENT]

    const memberSide = new Map<string, Set<string>>()
    for (const daemonId of daemons) {
      const served = await servedAgents(daemonId, { agents, duties, now })
      memberSide.set(daemonId, new Set(served.agents.map((a) => a.id)))
    }

    for (const agentId of agentIds) {
      const agent = (await agents.getUnscoped(agentId as never))!
      const serving = new Set(await resolver.servingDaemons(agent))
      for (const daemonId of daemons) {
        expect(
          { agentId, daemonId, agentSide: serving.has(daemonId) },
          `agent→member and member→agent disagree for ${agentId} / ${daemonId}`
        ).toEqual({ agentId, daemonId, agentSide: memberSide.get(daemonId)!.has(agentId) })
      }
    }

    // And the fixture actually exercises each arm, so the biconditional above is not vacuous.
    expect(memberSide.get(LOCAL)).toEqual(new Set([ON_LOCAL]))
    expect(memberSide.get(MEMBER_A)).toEqual(new Set([ON_POOL_HELD]))
    expect(memberSide.get(MEMBER_B)).toEqual(new Set())
  })

  it('the placement half is keyed on the KIND, not on the ref being non-null', async () => {
    // Today a pool row carries `daemonId = null`, so `where: { daemonId }` alone would already
    // exclude it — the two sides agree by accident of the encoding, not by rule. This seeds the
    // state that accident does not cover and the next placement kind WILL produce: a ref stored
    // under a non-`daemon` kind. `placementColumns` never writes it, so it goes in through raw
    // SQL, which is the point — the test is about what the query promises, not about what today's
    // writer happens to produce.
    const clock = new FakeClock(1_700_000_000_000)
    await seedFixture(new Date(clock.now()))
    await prisma.$executeRaw`UPDATE "agent" SET "daemonId" = ${MEMBER_A}::uuid WHERE id = ${ON_POOL_HELD}::uuid`
    const agents = new PgAgentRepo(prisma)

    // The member side must still not call it placed — its duty is the only way it reaches a
    // member, and counting it twice is exactly the double-service the ledger exists to prevent.
    for (const daemonId of [LOCAL, MEMBER_A, MEMBER_B]) {
      expect((await agents.listForDaemon(daemonId)).map((a) => a.id)).not.toContain(ON_POOL_HELD)
    }
    // And the agent side agrees: placement names no machine for it, whatever the column says.
    const resolver = new PlacementResolver({ duties: new PgDutyGroupRepo(prisma), clock })
    const agent = (await agents.getUnscoped(ON_POOL_HELD as never))!
    expect(await resolver.servingDaemons(agent)).toEqual([MEMBER_A])
  })
})
