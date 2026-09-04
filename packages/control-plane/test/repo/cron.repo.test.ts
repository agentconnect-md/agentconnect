/**
 * CronRepo — cron definitions (design §3.11, §6 Phase 1).
 *
 * The CP owns the cron DEFINITION (schedule/target/trigger); the daemon owns
 * firing + authoritative last-run. `upsert` is keyed on cronId (idempotent, so
 * `cron/upsert` re-apply is safe); `listForOrg` feeds `register/ok.crons[]`.
 */
import { describe, it, expect } from 'vitest'
import { prisma } from '../setup.db.js'
import { PgCronRepo } from '../../src/persistence/repositories/cron.repo.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { AgentId, CronId, DaemonId, OrgId } from '../../src/domain/ids.js'

const CRON = 'c1111111-1111-4111-8111-111111111111'
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DAEMON = 'd1111111-1111-4111-8111-111111111111'

function upsertInput(extra: Record<string, unknown> = {}) {
  return {
    cronId: CronId(CRON),
    orgId: OrgId(DEFAULT_ORG_ID),
    agentId: AgentId(AGENT),
    schedule: '0 9 * * *',
    timezone: 'Asia/Singapore',
    targetPlatform: 'slack' as const,
    targetChannel: 'C1',
    trigger: 'daily standup',
    enabled: true,
    ...extra
  }
}

async function fixtures(): Promise<void> {
  await seedDaemon(prisma, DAEMON)
  await seedAgent(prisma, AGENT)
}

describe('CronRepo — cron definitions (real Postgres)', () => {
  it('creates a cron definition', async () => {
    await fixtures()
    const repo = new PgCronRepo(prisma)

    const cron = await repo.upsert(upsertInput())
    expect(cron.id).toBe(CRON)
    expect(cron.schedule).toBe('0 9 * * *')
    expect(cron.timezone).toBe('Asia/Singapore')
    expect(cron.targetChannel).toBe('C1')
    expect(cron.trigger).toBe('daily standup')
    expect(cron.enabled).toBe(true)
    expect(cron.agentId).toBe(AGENT)
  })

  it('upsert is idempotent on cronId — re-apply updates in place', async () => {
    await fixtures()
    const repo = new PgCronRepo(prisma)

    await repo.upsert(upsertInput())
    await repo.upsert(
      upsertInput({ schedule: '0 18 * * *', timezone: 'America/New_York', trigger: 'evening', enabled: false })
    )

    const all = await repo.listForOrg(OrgId(DEFAULT_ORG_ID))
    expect(all).toHaveLength(1) // not appended — updated
    expect(all[0]?.schedule).toBe('0 18 * * *')
    expect(all[0]?.timezone).toBe('America/New_York')
    expect(all[0]?.trigger).toBe('evening')
    expect(all[0]?.enabled).toBe(false)
  })

  it('remove deletes the cron', async () => {
    await fixtures()
    const repo = new PgCronRepo(prisma)
    await repo.upsert(upsertInput())

    expect(await repo.remove(OrgId(DEFAULT_ORG_ID), CronId(CRON), AgentId(AGENT))).toBe(true)
    expect(await repo.get(OrgId(DEFAULT_ORG_ID), CronId(CRON))).toBeNull()
    expect(await repo.listForOrg(OrgId(DEFAULT_ORG_ID))).toHaveLength(0)
  })

  it('defaults targetPlatform to slack and enabled to true; targetChannel is optional (headless)', async () => {
    await fixtures()
    const repo = new PgCronRepo(prisma)
    const cron = await repo.upsert({
      cronId: CronId(CRON),
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId: AgentId(AGENT),
      schedule: '* * * * *',
      timezone: 'UTC',
      trigger: 't'
    })
    expect(cron.targetPlatform).toBe('slack')
    expect(cron.enabled).toBe(true)
    expect(cron.targetChannel).toBeNull() // headless fire
  })

  it('listForDaemon returns only crons whose owning agent is placed on that daemon', async () => {
    await fixtures()
    const OTHER_AGENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    await seedAgent(prisma, OTHER_AGENT) // unplaced (no daemonId)
    await prisma.agent.update({ where: { id: AGENT }, data: { daemonId: DAEMON } })

    const repo = new PgCronRepo(prisma)
    await repo.upsert(upsertInput()) // AGENT → placed on DAEMON
    const UNPLACED = 'c2222222-2222-4222-8222-222222222222'
    await repo.upsert(upsertInput({ cronId: CronId(UNPLACED), agentId: AgentId(OTHER_AGENT) }))

    const forDaemon = await repo.listForDaemon(DaemonId(DAEMON))
    expect(forDaemon.map((c) => c.id)).toEqual([CRON]) // unplaced agent's cron excluded
    expect(await repo.listForOrg(OrgId(DEFAULT_ORG_ID))).toHaveLength(2) // console still sees both
  })

  it('reapStaleRuns closes only running rows older than the cutoff → failed (orphaned)', async () => {
    await fixtures()
    const repo = new PgCronRepo(prisma)
    await repo.upsert(upsertInput())

    const at = (iso: string) => new Date(iso)
    // stale running (before cutoff) → reaped
    await prisma.cronRun.create({
      data: { cronId: CRON, orgId: DEFAULT_ORG_ID, startedAt: at('2026-01-01T00:00:00Z'), status: 'running' }
    })
    // fresh running (after cutoff) → untouched
    await prisma.cronRun.create({
      data: { cronId: CRON, orgId: DEFAULT_ORG_ID, startedAt: at('2026-01-01T01:00:00Z'), status: 'running' }
    })
    // old but already terminal → untouched
    await prisma.cronRun.create({
      data: {
        cronId: CRON,
        orgId: DEFAULT_ORG_ID,
        startedAt: at('2026-01-01T00:10:00Z'),
        status: 'success',
        durationMs: 1234,
        sessionId: 's1'
      }
    })

    const n = await repo.reapStaleRuns(at('2026-01-01T00:30:00Z'))
    expect(n).toBe(1) // only the stale running row

    const byStart = Object.fromEntries(
      (await repo.listRuns(OrgId(DEFAULT_ORG_ID), CronId(CRON))).map((r) => [r.startedAt.toISOString(), r])
    )
    expect(byStart['2026-01-01T00:00:00.000Z']?.status).toBe('failed')
    expect(byStart['2026-01-01T00:00:00.000Z']?.reason).toMatch(/completion/i)
    expect(byStart['2026-01-01T01:00:00.000Z']?.status).toBe('running') // fresh, untouched
    expect(byStart['2026-01-01T00:10:00.000Z']?.status).toBe('success') // terminal, untouched
  })

  it('a late completion report overwrites a reaped run with the real outcome', async () => {
    await fixtures()
    await prisma.agent.update({ where: { id: AGENT }, data: { daemonId: DAEMON } })
    const repo = new PgCronRepo(prisma)
    await repo.upsert(upsertInput())

    const firedAt = new Date('2026-01-01T00:00:00Z')
    await prisma.cronRun.create({
      data: { cronId: CRON, orgId: DEFAULT_ORG_ID, startedAt: firedAt, status: 'running' }
    })
    expect(await repo.reapStaleRuns(new Date('2026-01-01T00:30:00Z'))).toBe(1)

    // The daemon's completion finally arrives (the handler already fenced it) and
    // re-closes the reaped row with the real outcome — the reaper is non-destructive.
    const ok = await repo.recordReport(CronId(CRON), {
      firedAt,
      status: 'success',
      durationMs: 999,
      sessionId: 'late'
    })
    expect(ok).toBe(true)

    const [run] = await repo.listRuns(OrgId(DEFAULT_ORG_ID), CronId(CRON))
    expect(run?.status).toBe('success')
    expect(run?.sessionId).toBe('late')
    expect(run?.reason).toBeNull() // the orphaned marker was cleared
  })
})
