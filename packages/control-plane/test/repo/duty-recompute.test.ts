// DutyRecomputeSweep + the soak-phase incumbent grant policy (real Postgres):
// the sweep derives one duty group per agent (merged by shared socket bots), and
// claimVacant's incumbent gate pins grants to the member its agents live on.
import { describe, it, expect, vi } from 'vitest'
import { prisma } from '../setup.db.js'
import { PgDutyGroupRepo } from '../../src/persistence/index.js'
import { DutyRecomputeSweep } from '../../src/orchestrator/dutyRecompute.js'
import type { DutyReconcilePlan } from '../../src/domain/duty.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { AgentId, DaemonId, OrgId } from '../../src/domain/ids.js'
import { FakeClock } from '../fakes/fake-clock.js'

const M1 = DaemonId('d1111111-1111-4111-8111-111111111111')
const M2 = DaemonId('d2222222-2222-4222-8222-222222222222')
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const AGENT2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const BOT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
const HTTP_BOT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
const CRON = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'
const INTEG = '11111111-1111-4111-8111-11111111111a'
const INTEG2 = '11111111-1111-4111-8111-11111111111b'

const LEASE_MS = 120_000

const ORG = OrgId(DEFAULT_ORG_ID)

// Records every applied plan and every warning, so a test can assert what the
// sweep DID — "no revoke was planned" is not observable from the rows alone.
function sweep(clock = new FakeClock(1_700_000_000_000)) {
  const repo = new PgDutyGroupRepo(prisma)
  const plans: DutyReconcilePlan[] = []
  const warns: unknown[] = []
  const recording = {
    listDutyOrgs: repo.listDutyOrgs.bind(repo),
    computeInputs: repo.computeInputs.bind(repo),
    applyReconcile: async (...args: Parameters<typeof repo.applyReconcile>) => {
      const plan = await repo.applyReconcile(...args)
      plans.push(plan)
      return plan
    },
    vacateNonIncumbent: repo.vacateNonIncumbent.bind(repo)
  }
  return {
    repo,
    clock,
    plans,
    warns,
    sweep: new DutyRecomputeSweep(
      recording,
      clock,
      {
        intervalMs: 30_000,
        orgsPerTick: 25,
        leaseMs: LEASE_MS,
        incumbentFence: true,
        kickDelayMs: 0
      },
      { warn: (o) => void warns.push(o), error: () => undefined }
    )
  }
}

async function seedDaemons(): Promise<void> {
  await prisma.daemon.createMany({
    data: [
      { id: M1, orgId: DEFAULT_ORG_ID, maxAgents: 8, status: 'ready' },
      { id: M2, orgId: DEFAULT_ORG_ID, maxAgents: 8, status: 'ready' }
    ]
  })
}

async function seedAgent(id: string, name: string, daemonId?: string): Promise<void> {
  await prisma.agent.create({
    data: { id, orgId: DEFAULT_ORG_ID, name, runtime: 'claude', ...(daemonId ? { daemonId } : {}) }
  })
}

async function seedBot(id: string, transport: 'socket' | 'http'): Promise<void> {
  await prisma.bot.create({ data: { id, orgId: DEFAULT_ORG_ID, platform: 'telegram', name: `bot-${id}`, transport } })
}

async function seedIntegration(id: string, agentId: string, botId: string): Promise<void> {
  await prisma.integration.create({
    data: { id, orgId: DEFAULT_ORG_ID, agentId, botId, platform: 'telegram', name: `integ-${id}` }
  })
}

describe('duty recompute sweep (real Postgres)', () => {
  it('joins an agent to its socket bot and leaves a relay-ingress agent its own singleton', async () => {
    await seedDaemons()
    await seedAgent(AGENT, 'agent-1', M1)
    await seedAgent(AGENT2, 'agent-2', M1)
    await seedBot(BOT, 'socket')
    await seedBot(HTTP_BOT, 'http')
    await seedIntegration(INTEG, AGENT, BOT)
    await seedIntegration(INTEG2, AGENT2, HTTP_BOT) // relay-ingress: no edge, but still ownable
    const { repo, sweep: s } = sweep()

    expect(await s.tick()).toBe(1)
    // listForOrg orders by the minted (random) groupId, so compare as a set.
    const groups = await repo.listForOrg(ORG)
    expect(groups.map((g) => g.members).sort((a, b) => a[0]!.refId.localeCompare(b[0]!.refId))).toEqual([
      [
        { kind: 'agent', refId: AGENT },
        { kind: 'bot', refId: BOT }
      ],
      [{ kind: 'agent', refId: AGENT2 }]
    ])
    expect(groups.every((g) => g.holder === null)).toBe(true)
  })

  it('a cron adds nothing of its own — the agent already owns a singleton, enabled or not', async () => {
    await seedDaemons()
    await seedAgent(AGENT, 'agent-1', M1)
    await prisma.cronDef.create({
      data: {
        id: CRON,
        orgId: DEFAULT_ORG_ID,
        agentId: AGENT,
        schedule: '0 9 * * *',
        timezone: 'UTC',
        targetPlatform: 'telegram',
        trigger: 'daily',
        enabled: true
      }
    })
    const { repo, sweep: s } = sweep()

    await s.tick()
    const [group] = await repo.listForOrg(ORG)
    expect(group!.members).toEqual([{ kind: 'agent', refId: AGENT }])

    await prisma.cronDef.update({ where: { id: CRON }, data: { enabled: false } })
    await s.tick()
    expect(await repo.listForOrg(ORG)).toEqual([group])
  })

  it('an agent with no integration and no cron converges to a stable held group', async () => {
    await seedDaemons()
    await seedAgent(AGENT, 'agent-1', M1) // webchat / A2A only: no edge, no seed
    const { repo, clock, plans, warns, sweep: s } = sweep()

    await s.tick()
    const [created] = await repo.listForOrg(ORG)
    expect(created!.members).toEqual([{ kind: 'agent', refId: AGENT }])
    const [grant] = await repo.claimVacant(M1, 1, new Date(clock.now()), LEASE_MS, { incumbentOnly: true })
    expect(grant).toBeDefined()

    // The flap this test exists for: sweep 2 and 3 must plan no delete and no
    // supersession, and must leave the term exactly where the grant put it.
    plans.length = 0
    await s.tick()
    await s.tick()
    expect(plans).toHaveLength(2)
    for (const plan of plans) {
      expect(plan.deletes).toEqual([])
      expect(plan.superseded).toEqual([])
      expect(plan.creates).toEqual([])
      expect(plan.writes).toEqual([])
      expect(plan.unchanged).toEqual([created!.groupId])
    }
    const [held] = await repo.listHeldBy(M1)
    expect(held!.groupId).toBe(created!.groupId)
    expect(held!.term).toBe(grant!.term)
    expect(warns).toEqual([])
  })

  it('a rendezvous claim survives the next sweep with the same holder and term', async () => {
    await seedDaemons()
    await seedAgent(AGENT, 'agent-1', M1)
    const { repo, clock, warns, sweep: s } = sweep()

    // The design's fallback path: the trigger arrives before the sweep ran.
    const claim = await repo.claimAgentHome(ORG, AgentId(AGENT), M1, new Date(clock.now()), LEASE_MS)
    expect(claim.granted).toBe(true)

    await s.tick()
    const [held] = await repo.listHeldBy(M1)
    expect(held!.groupId).toBe(claim.groupId)
    expect(held!.term).toBe(claim.term)
    expect(held!.members).toEqual([{ kind: 'agent', refId: AGENT }])
    expect(warns).toEqual([])
  })

  it('an unplaced agent’s rendezvous claim is not vacated — nothing moved away', async () => {
    await seedDaemons()
    await seedAgent(AGENT, 'agent-1') // no placement: the fence has no rival incumbent
    const { repo, clock, warns, sweep: s } = sweep()

    const claim = await repo.claimAgentHome(ORG, AgentId(AGENT), M1, new Date(clock.now()), LEASE_MS)
    await s.tick()

    const [held] = await repo.listHeldBy(M1)
    expect(held!.groupId).toBe(claim.groupId)
    expect(held!.term).toBe(claim.term)
    expect(warns).toEqual([])
  })

  it('reaps the group of an agent whose row is gone', async () => {
    await seedDaemons()
    await seedAgent(AGENT, 'agent-1', M1)
    const { repo, plans, sweep: s } = sweep()

    await s.tick()
    const [created] = await repo.listForOrg(ORG)
    await prisma.agent.delete({ where: { id: AGENT } })

    plans.length = 0
    await s.tick()
    expect(plans[0]!.deletes).toEqual([created!.groupId])
    expect(await repo.listForOrg(ORG)).toEqual([])
  })

  it('an agent gaining its first integration merges into its singleton instead of duplicating', async () => {
    await seedDaemons()
    await seedAgent(AGENT, 'agent-1', M1)
    const { repo, clock, sweep: s } = sweep()

    await s.tick()
    const [singleton] = await repo.listForOrg(ORG)
    await repo.claimVacant(M1, 1, new Date(clock.now()), LEASE_MS, { incumbentOnly: true })

    await seedBot(BOT, 'socket')
    await seedIntegration(INTEG, AGENT, BOT)
    await s.tick()

    const groups = await repo.listForOrg(ORG)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.groupId).toBe(singleton!.groupId)
    expect(groups[0]!.holder).toBe(M1)
    expect(groups[0]!.members).toEqual([
      { kind: 'agent', refId: AGENT },
      { kind: 'bot', refId: BOT }
    ])
  })

  it('two agents sharing a socket bot land in one group, not one each', async () => {
    await seedDaemons()
    await seedAgent(AGENT, 'agent-1', M1)
    await seedAgent(AGENT2, 'agent-2', M1)
    await seedBot(BOT, 'socket')
    await seedIntegration(INTEG, AGENT, BOT)
    await seedIntegration(INTEG2, AGENT2, BOT)
    const { repo, sweep: s } = sweep()

    await s.tick()
    const groups = await repo.listForOrg(ORG)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.members).toHaveLength(3)
  })

  it('a repeated tick over unchanged rows writes nothing (idempotent rotation)', async () => {
    await seedDaemons()
    await seedAgent(AGENT, 'agent-1', M1)
    await seedBot(BOT, 'socket')
    await seedIntegration(INTEG, AGENT, BOT)
    const { repo, sweep: s } = sweep()

    await s.tick()
    const before = await repo.listForOrg(ORG)
    await s.tick()
    const after = await repo.listForOrg(ORG)
    expect(after).toEqual(before)
  })

  it('an added integration merges the held group and re-grants the incumbent at a new term', async () => {
    await seedDaemons()
    await seedAgent(AGENT, 'agent-1', M1)
    await seedBot(BOT, 'socket')
    await seedIntegration(INTEG, AGENT, BOT)
    const { repo, clock, sweep: s } = sweep()

    await s.tick()
    await repo.claimVacant(M1, 1, new Date(clock.now()), LEASE_MS)

    // A second agent joins the same daemon-held bot: the group widens.
    await seedAgent(AGENT2, 'agent-2', M1)
    await seedIntegration(INTEG2, AGENT2, BOT)
    await s.tick()

    const [group] = await repo.listHeldBy(M1)
    expect(group!.holder).toBe(M1)
    expect(group!.term).toBe(2n)
    expect(group!.members).toHaveLength(3)
  })
})

describe('incumbent placement fence (real Postgres)', () => {
  it('a full placement move-away vacates the lease so the new incumbent can claim', async () => {
    await seedDaemons()
    await seedAgent(AGENT, 'agent-1', M1)
    await seedBot(BOT, 'socket')
    await seedIntegration(INTEG, AGENT, BOT)
    const { repo, clock, sweep: s } = sweep()
    await s.tick()
    await repo.claimVacant(M1, 1, new Date(clock.now()), LEASE_MS, { incumbentOnly: true })

    // The agent moves to M2: the next tick vacates M1's lease, and only M2 can claim.
    await prisma.agent.update({ where: { id: AGENT }, data: { daemonId: M2 } })
    await s.tick()
    expect(await repo.listHeldBy(M1)).toEqual([])
    const now = new Date(clock.now())
    expect(await repo.claimVacant(M1, 5, now, LEASE_MS, { incumbentOnly: true })).toEqual([])
    const grants = await repo.claimVacant(M2, 5, now, LEASE_MS, { incumbentOnly: true })
    expect(grants).toHaveLength(1)
    expect(grants[0]!.term).toBe(2n)
  })

  it('partial occupancy keeps the lease — a split group never flaps', async () => {
    await seedDaemons()
    await seedAgent(AGENT, 'agent-1', M1)
    await seedAgent(AGENT2, 'agent-2', M1)
    await seedBot(BOT, 'socket')
    await seedIntegration(INTEG, AGENT, BOT)
    await seedIntegration(INTEG2, AGENT2, BOT)
    const { repo, clock, sweep: s } = sweep()
    await s.tick()
    await repo.claimVacant(M1, 1, new Date(clock.now()), LEASE_MS, { incumbentOnly: true })

    // Only one of the two agents moves: M1 still hosts AGENT, so the lease stays.
    await prisma.agent.update({ where: { id: AGENT2 }, data: { daemonId: M2 } })
    await s.tick()
    const [held] = await repo.listHeldBy(M1)
    expect(held!.holder).toBe(M1)
    expect(held!.term).toBe(1n)
  })
})

describe('incumbent grant policy (real Postgres)', () => {
  it('incumbentOnly pins a vacancy to the member its agent is placed on', async () => {
    await seedDaemons()
    await seedAgent(AGENT, 'agent-1', M1)
    await seedBot(BOT, 'socket')
    await seedIntegration(INTEG, AGENT, BOT)
    const { repo, clock, sweep: s } = sweep()
    await s.tick()
    const now = new Date(clock.now())

    // M2 is not the incumbent: nothing to claim under the policy.
    expect(await repo.claimVacant(M2, 5, now, LEASE_MS, { incumbentOnly: true })).toEqual([])
    // M1 is: the grant flows.
    const grants = await repo.claimVacant(M1, 5, now, LEASE_MS, { incumbentOnly: true })
    expect(grants).toHaveLength(1)
    expect(grants[0]!.members).toContainEqual({ kind: 'agent', refId: AGENT })
  })

  it('an unplaced agent’s group is claimable by nobody under the policy, anybody without it', async () => {
    await seedDaemons()
    await seedAgent(AGENT, 'agent-1') // no placement
    await prisma.cronDef.create({
      data: {
        id: CRON,
        orgId: DEFAULT_ORG_ID,
        agentId: AGENT,
        schedule: '0 9 * * *',
        timezone: 'UTC',
        targetPlatform: 'telegram',
        trigger: 'daily',
        enabled: true
      }
    })
    const { repo, clock, sweep: s } = sweep()
    await s.tick()
    const now = new Date(clock.now())

    expect(await repo.claimVacant(M1, 5, now, LEASE_MS, { incumbentOnly: true })).toEqual([])
    expect(await repo.claimVacant(M1, 5, now, LEASE_MS)).toHaveLength(1)
  })
})

describe('duty recompute kick (real Postgres)', () => {
  it('a kick recomputes one org immediately instead of waiting for its slice', async () => {
    await seedDaemons()
    await seedAgent(AGENT, 'agent-1', M1)
    await seedBot(BOT, 'socket')
    await seedIntegration(INTEG, AGENT, BOT)
    const { repo, clock, sweep: s } = sweep()

    s.kick(DEFAULT_ORG_ID)
    clock.advance(1)
    await vi.waitFor(async () => {
      const groups = await repo.listForOrg(ORG)
      expect(groups).toHaveLength(1)
    })
  })

  it('a burst against one org collapses into a single recompute', async () => {
    await seedDaemons()
    await seedAgent(AGENT, 'agent-1', M1)
    const repo = new PgDutyGroupRepo(prisma)
    const clock = new FakeClock(1_700_000_000_000)
    const recomputes: string[] = []
    const spy = {
      listDutyOrgs: repo.listDutyOrgs.bind(repo),
      computeInputs: async (orgId: Parameters<typeof repo.computeInputs>[0]) => {
        recomputes.push(orgId)
        return repo.computeInputs(orgId)
      },
      applyReconcile: repo.applyReconcile.bind(repo),
      vacateNonIncumbent: repo.vacateNonIncumbent.bind(repo)
    }
    const s = new DutyRecomputeSweep(spy, clock, {
      intervalMs: 30_000,
      orgsPerTick: 25,
      leaseMs: LEASE_MS,
      incumbentFence: true,
      kickDelayMs: 10
    })

    s.kick(DEFAULT_ORG_ID)
    s.kick(DEFAULT_ORG_ID)
    s.kick(DEFAULT_ORG_ID)
    clock.advance(10)
    await vi.waitFor(() => expect(recomputes).toEqual([DEFAULT_ORG_ID]))
  })

  it('stop() cancels a pending kick', async () => {
    await seedDaemons()
    await seedAgent(AGENT, 'agent-1', M1)
    await seedBot(BOT, 'socket')
    await seedIntegration(INTEG, AGENT, BOT)
    const { repo, clock, sweep: s } = sweep()

    s.kick(DEFAULT_ORG_ID)
    s.stop()
    clock.advance(1_000)
    await new Promise((r) => setTimeout(r, 20))
    expect(await repo.listForOrg(ORG)).toEqual([])
  })
})
