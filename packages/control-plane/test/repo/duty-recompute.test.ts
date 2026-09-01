// DutyRecomputeSweep + the placement eligibility gate (real Postgres): the sweep derives one
// duty group per agent (merged by shared socket bots), and claimVacant grants only what the
// claimant may hold — every agent in the group placed on it, or placed on the pool it belongs to.
import { describe, it, expect, vi } from 'vitest'
import { prisma } from '../setup.db.js'
import { PgDutyGroupRepo } from '../../src/persistence/index.js'
import { DutyRecomputeSweep } from '../../src/orchestrator/dutyRecompute.js'
import type { DutyReconcilePlan } from '../../src/domain/duty.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { DEFAULT_DAEMON_CAPABILITIES } from '../fixtures/seed.js'
import { joinPool, poolSetId } from '../fakes/member-set.js'
import { AgentId, DaemonId, OrgId } from '../../src/domain/ids.js'
import { FakeClock } from '../fakes/fake-clock.js'

const M1 = DaemonId('d1111111-1111-4111-8111-111111111111')
const M2 = DaemonId('d2222222-2222-4222-8222-222222222222')
const POOL_A = DaemonId('d3333333-3333-4333-8333-333333333333')
const POOL_B = DaemonId('d4444444-4444-4444-8444-444444444444')
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
    vacateIneligible: repo.vacateIneligible.bind(repo),
    getByIds: repo.getByIds.bind(repo)
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
        kickDelayMs: 0
      },
      { warn: (o) => void warns.push(o), error: () => undefined }
    )
  }
}

// Registered stock daemons: the capability list is load-bearing now, because the claim paths gate
// on it — a member advertising no platform may claim nothing whose integrations name one.
async function seedDaemons(): Promise<void> {
  await prisma.daemon.createMany({
    data: [
      { id: M1, orgId: DEFAULT_ORG_ID, maxAgents: 8, status: 'ready', capabilities: DEFAULT_DAEMON_CAPABILITIES },
      { id: M2, orgId: DEFAULT_ORG_ID, maxAgents: 8, status: 'ready', capabilities: DEFAULT_DAEMON_CAPABILITIES }
    ]
  })
}

async function seedAgent(id: string, name: string, daemonId?: string): Promise<void> {
  await prisma.agent.create({
    data: { id, orgId: DEFAULT_ORG_ID, name, runtime: 'claude', ...(daemonId ? { daemonId } : {}) }
  })
}

/** An agent placed on the POOL: kind `set` pointing at the org-less set, no member id at all. */
async function seedPoolAgent(id: string, name: string): Promise<void> {
  await prisma.agent.create({
    data: { id, orgId: DEFAULT_ORG_ID, name, runtime: 'claude', placementKind: 'set', setId: await poolSetId(prisma) }
  })
}

/** Install-wide pool members: org-less rows enrolled in the org-less set, as `upsertOnAuth` does. */
async function seedMembers(): Promise<void> {
  await prisma.daemon.createMany({
    data: [
      { id: POOL_A, orgId: null, maxAgents: 8, status: 'ready', capabilities: DEFAULT_DAEMON_CAPABILITIES },
      { id: POOL_B, orgId: null, maxAgents: 8, status: 'ready', capabilities: DEFAULT_DAEMON_CAPABILITIES }
    ]
  })
  await joinPool(prisma, POOL_A, POOL_B)
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
    const [grant] = await repo.claimVacant(M1, 1, new Date(clock.now()), LEASE_MS)
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

  it('an unplaced agent’s home cannot be claimed at all, so there is no lease to fence', async () => {
    // The old fence had to make an exception for this case — the rendezvous minted a lease for an
    // unplaced agent and vacating it every sweep would churn. Eligibility removes the exception at
    // the source: nothing may serve an unplaced agent, so nothing claims one.
    await seedDaemons()
    await seedAgent(AGENT, 'agent-1') // no placement
    const { repo, clock, warns, sweep: s } = sweep()

    const claim = await repo.claimAgentHome(ORG, AgentId(AGENT), M1, new Date(clock.now()), LEASE_MS)
    expect(claim.granted).toBe(false)
    await s.tick()

    expect(await repo.listHeldBy(M1)).toEqual([])
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
    await repo.claimVacant(M1, 1, new Date(clock.now()), LEASE_MS)

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
    await repo.claimVacant(M1, 1, new Date(clock.now()), LEASE_MS)

    // The agent moves to M2: the next tick vacates M1's lease, and only M2 can claim.
    await prisma.agent.update({ where: { id: AGENT }, data: { daemonId: M2 } })
    await s.tick()
    expect(await repo.listHeldBy(M1)).toEqual([])
    const now = new Date(clock.now())
    expect(await repo.claimVacant(M1, 5, now, LEASE_MS)).toEqual([])
    const grants = await repo.claimVacant(M2, 5, now, LEASE_MS)
    expect(grants).toHaveLength(1)
    expect(grants[0]!.term).toBe(2n)
  })

  it('a PARTIAL move-away now vacates the lease, because the holder is no longer eligible for all of it', async () => {
    // The old fence kept the lease while the holder still hosted ANY of the group's agents, to
    // stop a split group flapping between two partial incumbents. Eligibility is FORALL, so it
    // vacates instead — and that is the point: under the old rule M1 kept SERVING an agent that
    // had moved to M2, which is the duplicate service the ledger exists to prevent. The group is
    // unclaimable until the next recompute splits it, which is the safe direction.
    await seedDaemons()
    await seedAgent(AGENT, 'agent-1', M1)
    await seedAgent(AGENT2, 'agent-2', M1)
    await seedBot(BOT, 'socket')
    await seedIntegration(INTEG, AGENT, BOT)
    await seedIntegration(INTEG2, AGENT2, BOT)
    const { repo, clock, sweep: s } = sweep()
    await s.tick()
    await repo.claimVacant(M1, 1, new Date(clock.now()), LEASE_MS)
    expect(await repo.listHeldBy(M1)).toHaveLength(1)

    await prisma.agent.update({ where: { id: AGENT2 }, data: { daemonId: M2 } })
    await s.tick()
    expect(await repo.listHeldBy(M1)).toEqual([])
  })
})

describe('placement eligibility gate (real Postgres)', () => {
  it('a machine-placed agent’s group is claimable only by that machine', async () => {
    await seedDaemons()
    await seedAgent(AGENT, 'agent-1', M1)
    await seedBot(BOT, 'socket')
    await seedIntegration(INTEG, AGENT, BOT)
    const { repo, clock, sweep: s } = sweep()
    await s.tick()
    const now = new Date(clock.now())

    // Another machine may not take it, and neither may an install-wide member.
    expect(await repo.claimVacant(M2, 5, now, LEASE_MS)).toEqual([])
    const grants = await repo.claimVacant(M1, 5, now, LEASE_MS)
    expect(grants).toHaveLength(1)
    expect(grants[0]!.members).toContainEqual({ kind: 'agent', refId: AGENT })
  })

  // THE load-bearing tenancy invariant of the whole change: dropping the incumbent gate must not
  // let the pool reach the agents a local daemon is already serving.
  it('NO pool member ever claims an agent placed on a local daemon', async () => {
    await seedDaemons()
    await seedMembers()
    await seedAgent(AGENT, 'agent-1', M1)
    const { repo, clock, sweep: s } = sweep()
    await s.tick()
    const now = new Date(clock.now())

    expect(await repo.claimVacant(POOL_A, 5, now, LEASE_MS)).toEqual([])
    expect(await repo.claimVacant(POOL_B, 5, now, LEASE_MS)).toEqual([])
    // And the rendezvous is the same gate, not a second one: a trigger reaching the wrong member
    // is not authority to serve an agent that member may not hold.
    const claim = await repo.claimAgentHome(ORG, AgentId(AGENT), POOL_A, now, LEASE_MS)
    expect(claim.granted).toBe(false)
    expect(await repo.listHeldBy(POOL_A)).toEqual([])
  })

  it('a pool agent’s group is claimable by ANY live member, and by no machine', async () => {
    await seedDaemons()
    await seedMembers()
    await seedPoolAgent(AGENT, 'pool-agent')
    const { repo, clock, sweep: s } = sweep()
    await s.tick()
    const now = new Date(clock.now())

    // A machine-scoped claimant is never install-wide, so the pool's work stays out of reach.
    expect(await repo.claimVacant(M1, 5, now, LEASE_MS)).toEqual([])
    const grants = await repo.claimVacant(POOL_B, 5, now, LEASE_MS)
    expect(grants).toHaveLength(1)
    expect(grants[0]!.members).toContainEqual({ kind: 'agent', refId: AGENT })
  })

  it('a group mixing a pool agent with a machine-placed one is claimable by neither', async () => {
    // Two agents sharing one socket bot merge into one component. Serving it as a unit would mean
    // one member running an agent the other side already runs, so the gate is FORALL, not EXISTS.
    await seedDaemons()
    await seedMembers()
    await seedAgent(AGENT, 'agent-1', M1)
    await seedPoolAgent(AGENT2, 'pool-agent')
    await seedBot(BOT, 'socket')
    await seedIntegration(INTEG, AGENT, BOT)
    await seedIntegration(INTEG2, AGENT2, BOT)
    const { repo, clock, sweep: s } = sweep()
    await s.tick()
    expect(await repo.listForOrg(ORG)).toHaveLength(1)
    const now = new Date(clock.now())

    expect(await repo.claimVacant(M1, 5, now, LEASE_MS)).toEqual([])
    expect(await repo.claimVacant(POOL_A, 5, now, LEASE_MS)).toEqual([])
  })

  it('an unplaced agent’s group is claimable by nobody, and its rendezvous claim is refused', async () => {
    await seedDaemons()
    await seedMembers()
    await seedAgent(AGENT, 'agent-1') // no placement
    const { repo, clock, sweep: s } = sweep()
    await s.tick()
    const now = new Date(clock.now())

    expect(await repo.claimVacant(POOL_A, 5, now, LEASE_MS)).toEqual([])
    expect(await repo.claimVacant(M1, 5, now, LEASE_MS)).toEqual([])
    expect((await repo.claimAgentHome(ORG, AgentId(AGENT), POOL_A, now, LEASE_MS)).granted).toBe(false)
  })

  it('the backoff list excludes named groups from a claim without disturbing the rest', async () => {
    await seedDaemons()
    await seedMembers()
    await seedPoolAgent(AGENT, 'pool-agent')
    await seedPoolAgent(AGENT2, 'pool-agent-2')
    const { repo, clock, sweep: s } = sweep()
    await s.tick()
    const now = new Date(clock.now())
    const [first, second] = (await repo.listForOrg(ORG)).map((g) => g.groupId)

    const grants = await repo.claimVacant(POOL_A, 5, now, LEASE_MS, {
      excludeGroupIds: [first!]
    })
    expect(grants.map((g) => g.groupId)).toEqual([second])
  })
})

describe('the placement fence (real Postgres)', () => {
  it('vacates a lease whose holder may no longer hold it — a pool agent moved onto a machine', async () => {
    await seedDaemons()
    await seedMembers()
    await seedPoolAgent(AGENT, 'pool-agent')
    const { repo, clock, sweep: s, warns } = sweep()
    await s.tick()
    const [granted] = await repo.claimVacant(POOL_A, 5, new Date(clock.now()), LEASE_MS)
    expect(granted).toBeDefined()

    // Moved off the pool onto a machine: the member holding it is no longer eligible.
    await prisma.agent.update({ where: { id: AGENT }, data: { placementKind: 'daemon', daemonId: M1 } })
    await s.tick()

    expect(await repo.listHeldBy(POOL_A)).toEqual([])
    expect(warns).not.toEqual([])
  })

  it('keeps a lease whose holder is still eligible', async () => {
    await seedDaemons()
    await seedMembers()
    await seedPoolAgent(AGENT, 'pool-agent')
    const { repo, clock, sweep: s } = sweep()
    await s.tick()
    await repo.claimVacant(POOL_A, 5, new Date(clock.now()), LEASE_MS)
    await s.tick()
    expect(await repo.listHeldBy(POOL_A)).toHaveLength(1)
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
    // The recompute's tail outlives the assertion; settle it here, not into the next test's database.
    await s.settle()
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
      vacateIneligible: repo.vacateIneligible.bind(repo),
      getByIds: repo.getByIds.bind(repo)
    }
    const s = new DutyRecomputeSweep(spy, clock, {
      intervalMs: 30_000,
      orgsPerTick: 25,
      leaseMs: LEASE_MS,
      kickDelayMs: 10
    })

    s.kick(DEFAULT_ORG_ID)
    s.kick(DEFAULT_ORG_ID)
    s.kick(DEFAULT_ORG_ID)
    clock.advance(10)
    await vi.waitFor(() => expect(recomputes).toEqual([DEFAULT_ORG_ID]))
    // `recomputes` is pushed on ENTRY: settle the still-pending writes here, not into the next test.
    await s.settle()
  })

  it('stop() cancels a pending kick', async () => {
    await seedDaemons()
    await seedAgent(AGENT, 'agent-1', M1)
    await seedBot(BOT, 'socket')
    await seedIntegration(INTEG, AGENT, BOT)
    const { repo, clock, sweep: s } = sweep()

    s.kick(DEFAULT_ORG_ID)
    s.stop()
    // The cancellation itself, asserted directly: the pending kick is the only timer this sweep armed.
    expect(clock.pendingTimers()).toBe(0)
    clock.advance(1_000)
    // Settles nothing when stop() held — and awaits the recompute it missed when it did not.
    await s.settle()
    expect(await repo.listForOrg(ORG)).toEqual([])
  })
})
