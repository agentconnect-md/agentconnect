// Session admission and its coexistence with the first-milestone count (org-session-policy.md, Admission).
import { describe, it, expect, vi } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEF_ORG, seedAgent } from '../fixtures/seed.js'
import { PgSessionRepo } from '../../src/persistence/repositories/session.repo.js'
import { PgOrgSessionPolicyRepo } from '../../src/persistence/repositories/org-session-policy.repo.js'
import { AgentId, SessionId } from '../../src/domain/ids.js'

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_AGENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OTHER_ORG = 'org-session-admission-other'

function ev(sessionId: string, phase: 'start' | 'end' = 'start', agentId: string = AGENT) {
  return {
    sessionId: SessionId(sessionId),
    agentId: AgentId(agentId),
    phase,
    platform: 'slack' as const,
    channel: 'C1',
    thread: sessionId,
    at: new Date()
  }
}

async function dbMonthStart(): Promise<Date> {
  const rows = await prisma.$queryRaw<Array<{ m: Date }>>`
    SELECT date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS "m"`
  return rows[0]!.m
}

async function used(orgId: string = DEF_ORG): Promise<number> {
  const rows = await prisma.orgSessionMonth.findMany({ where: { orgId } })
  return rows.reduce((sum, row) => sum + row.used, 0)
}

const admit = (sessionId: string, agentId: string = AGENT, orgId: string = DEF_ORG) =>
  new PgOrgSessionPolicyRepo(prisma).admit(orgId, agentId, sessionId)

/** Wait until a backend queues on a session lineage fence, the overlap the race tests are written for. */
async function awaitLineageLockWaiter(): Promise<void> {
  await vi.waitFor(
    async () => {
      const rows = await prisma.$queryRaw<Array<{ waiting: number }>>`
        SELECT count(*)::int AS "waiting"
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND cardinality(pg_blocking_pids(pid)) > 0
          AND query ILIKE '%pg_advisory_xact_lock%'
      `
      expect(rows[0]?.waiting ?? 0).toBeGreaterThanOrEqual(1)
    },
    { timeout: 20_000, interval: 10 }
  )
}

describe('PgOrgSessionPolicyRepo.admit', () => {
  it('counts a new session once, and answers a re-sent admit the same without counting again', async () => {
    await seedAgent(prisma, AGENT)
    expect(await admit('s-new')).toEqual({ admitted: true, counted: true })
    expect(await used()).toBe(1)
    expect(await admit('s-new')).toEqual({ admitted: true, counted: true })
    expect(await used()).toBe(1)
    const row = await prisma.orgSessionAdmission.findUniqueOrThrow({ where: { sessionId: 's-new' } })
    expect(row).toMatchObject({ orgId: DEF_ORG, agentId: AGENT, counted: true })
  })

  it('does not count again when the admitted session’s first milestone arrives', async () => {
    await seedAgent(prisma, AGENT)
    await admit('s-admitted')
    const repo = new PgSessionRepo(prisma)
    expect((await repo.recordMilestone(ev('s-admitted'))).recorded).toBe(true)
    expect(await prisma.sessionMeta.count({ where: { id: 's-admitted' } })).toBe(1)
    await repo.recordMilestone(ev('s-admitted', 'end'))
    expect(await used()).toBe(1)
  })

  it('admits a session the CP already recorded without counting it', async () => {
    await seedAgent(prisma, AGENT)
    await new PgSessionRepo(prisma).recordMilestone(ev('s-known'))
    expect(await used()).toBe(1)
    expect(await admit('s-known')).toEqual({ admitted: true, counted: false })
    expect(await admit('s-known')).toEqual({ admitted: true, counted: false })
    expect(await used()).toBe(1)
  })

  it('keeps counting a session no daemon admitted on its first milestone', async () => {
    await seedAgent(prisma, AGENT)
    const repo = new PgSessionRepo(prisma)
    await repo.recordMilestone(ev('s-unadmitted'))
    await repo.recordMilestone(ev('s-unadmitted', 'end'))
    expect(await used()).toBe(1)
    expect(await prisma.orgSessionAdmission.count()).toBe(0)
  })

  it('refuses an id another agent admitted or recorded, and writes nothing for it', async () => {
    await seedAgent(prisma, AGENT)
    await seedAgent(prisma, OTHER_AGENT)
    await admit('s-admitted')
    expect(await admit('s-admitted', OTHER_AGENT)).toEqual({ admitted: false, conflict: 'other_agent' })
    await new PgSessionRepo(prisma).recordMilestone(ev('s-recorded'))
    expect(await admit('s-recorded', OTHER_AGENT)).toEqual({ admitted: false, conflict: 'other_agent' })
    expect(await prisma.orgSessionAdmission.count({ where: { sessionId: 's-recorded' } })).toBe(0)
    expect(await used()).toBe(2)
  })

  it('counts under the database clock’s UTC month, for the org it was given', async () => {
    await prisma.org.create({ data: { id: OTHER_ORG, slug: OTHER_ORG } })
    await seedAgent(prisma, OTHER_AGENT, { orgId: OTHER_ORG })
    await admit('s-month', OTHER_AGENT, OTHER_ORG)
    const monthStart = (await dbMonthStart()).toISOString()
    const months = await prisma.orgSessionMonth.findMany({ where: { orgId: OTHER_ORG } })
    expect(months.map((m) => [m.monthStart.toISOString(), m.used])).toEqual([[monthStart, 1]])
    const row = await prisma.orgSessionAdmission.findUniqueOrThrow({ where: { sessionId: 's-month' } })
    expect(row.monthStart.toISOString()).toBe(monthStart)
    expect(await used(DEF_ORG)).toBe(0)
    await prisma.org.delete({ where: { id: OTHER_ORG } })
    expect(await prisma.orgSessionAdmission.count({ where: { orgId: OTHER_ORG } })).toBe(0)
  })

  it('counts once when an admit holds the fence while the first milestone waits', async () => {
    await seedAgent(prisma, AGENT)
    let racing: Promise<{ recorded: boolean }> | undefined
    await prisma.$transaction(async (tx) => {
      expect(await new PgOrgSessionPolicyRepo(tx).admit(DEF_ORG, AGENT, 's-race')).toEqual({
        admitted: true,
        counted: true
      })
      racing = new PgSessionRepo(prisma).recordMilestone(ev('s-race'))
      await awaitLineageLockWaiter()
    })
    expect((await racing!).recorded).toBe(true)
    expect(await used()).toBe(1)
  })

  it('counts once when the first milestone holds the fence while an admit waits', async () => {
    await seedAgent(prisma, AGENT)
    let racing: ReturnType<typeof admit> | undefined
    await prisma.$transaction(async (tx) => {
      expect((await new PgSessionRepo(tx).recordMilestone(ev('s-race'))).recorded).toBe(true)
      racing = admit('s-race')
      await awaitLineageLockWaiter()
    })
    expect(await racing!).toEqual({ admitted: true, counted: false })
    expect(await used()).toBe(1)
  })
})
