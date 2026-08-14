// DutyRecomputeSweep + the soak-phase incumbent grant policy (real Postgres):
// the sweep derives duty groups from Integration/CronDef rows, and claimVacant's
// incumbent gate pins grants to the member the group's agents already live on.
import { describe, it, expect } from 'vitest'
import { prisma } from '../setup.db.js'
import { PgDutyGroupRepo } from '../../src/persistence/index.js'
import { DutyRecomputeSweep } from '../../src/orchestrator/dutyRecompute.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { DaemonId } from '../../src/domain/ids.js'
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

function sweep(clock = new FakeClock(1_700_000_000_000)) {
  const repo = new PgDutyGroupRepo(prisma)
  return {
    repo,
    clock,
    sweep: new DutyRecomputeSweep(repo, clock, { intervalMs: 30_000, orgsPerTick: 25, leaseMs: LEASE_MS })
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
  it('derives groups from socket integrations and enabled crons; http-only agents get none', async () => {
    await seedDaemons()
    await seedAgent(AGENT, 'agent-1', M1)
    await seedAgent(AGENT2, 'agent-2', M1)
    await seedBot(BOT, 'socket')
    await seedBot(HTTP_BOT, 'http')
    await seedIntegration(INTEG, AGENT, BOT)
    await seedIntegration(INTEG2, AGENT2, HTTP_BOT) // relay-ingress: no edge
    const { repo, sweep: s } = sweep()

    expect(await s.tick()).toBe(1)
    const groups = await repo.listForOrg(DEFAULT_ORG_ID as Parameters<typeof repo.listForOrg>[0])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.members).toEqual([
      { kind: 'agent', refId: AGENT },
      { kind: 'bot', refId: BOT }
    ])
    expect(groups[0]!.holder).toBeNull()
  })

  it('an enabled cron seeds a claimable singleton; disabling it removes the group', async () => {
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
    let groups = await repo.listForOrg(DEFAULT_ORG_ID as Parameters<typeof repo.listForOrg>[0])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.members).toEqual([{ kind: 'agent', refId: AGENT }])

    await prisma.cronDef.update({ where: { id: CRON }, data: { enabled: false } })
    await s.tick()
    groups = await repo.listForOrg(DEFAULT_ORG_ID as Parameters<typeof repo.listForOrg>[0])
    expect(groups).toEqual([])
  })

  it('a repeated tick over unchanged rows writes nothing (idempotent rotation)', async () => {
    await seedDaemons()
    await seedAgent(AGENT, 'agent-1', M1)
    await seedBot(BOT, 'socket')
    await seedIntegration(INTEG, AGENT, BOT)
    const { repo, sweep: s } = sweep()

    await s.tick()
    const before = await repo.listForOrg(DEFAULT_ORG_ID as Parameters<typeof repo.listForOrg>[0])
    await s.tick()
    const after = await repo.listForOrg(DEFAULT_ORG_ID as Parameters<typeof repo.listForOrg>[0])
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
