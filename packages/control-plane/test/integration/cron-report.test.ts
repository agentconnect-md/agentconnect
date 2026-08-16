/**
 * `cron/report` (D→C EVT) → `lastRunAt` convergence, end to end on the CP side:
 *
 *  - A report from a daemon that SERVES the cron's agent stamps `lastRunAt` — its
 *    placement, or a duty it currently holds (a pool agent names no machine).
 *  - Fenced: a report from a daemon that serves neither drops silently (a daemon
 *    can never stamp another daemon's cron).
 *  - Latest-wins: an older `firedAt` (reconnect re-assert, out-of-order
 *    delivery) never regresses the stored stamp; a newer one advances it.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedDaemon, seedAgent, seedDutyGroup } from '../fixtures/seed.js'
import { poolSetId, seedPoolMember } from '../fakes/member-set.js'
import { PgCronRepo } from '../../src/persistence/repositories/cron.repo.js'
import { PgAgentRepo } from '../../src/persistence/repositories/agent.repo.js'
import { PgDutyGroupRepo } from '../../src/persistence/repositories/duty-group.repo.js'
import { PlacementResolver } from '../../src/orchestrator/placementResolver.js'
import { systemClock } from '../../src/domain/clock.js'
import { handleCronReport } from '../../src/ws/handlers/index.js'
import { AgentId, CronId, OrgId } from '../../src/domain/ids.js'
import type { DaemonConnection } from '../../src/ws/connection.js'
import type { DaemonWsDeps } from '../../src/ws/deps.js'
import type { AnyFrame } from '@agentconnect.md/protocol'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const OTHER_DAEMON = 'd2d2d2d2-dddd-4ddd-8ddd-dddddddddddd'
const POOL_MEMBER = 'd3d3d3d3-dddd-4ddd-8ddd-dddddddddddd'

/** Dispatch a hand-built `cron/report` EVT through the real handler. */
async function report(
  daemonId: string,
  cronId: string,
  agentId: string,
  firedAt: string,
  outcome: Record<string, unknown> = {}
): Promise<void> {
  const frame = {
    v: 1,
    id: randomUUID(),
    ts: new Date().toISOString(),
    type: 'cron/report',
    // An install-wide member carries many orgs on one socket, so the org rides the FRAME — both
    // reads the fence makes are scoped to it (`frameOrgId`).
    orgId: DEFAULT_ORG_ID,
    payload: { cronId, agentId, firedAt, ...outcome }
  } as AnyFrame
  // The same graph production wires: the fence is the resolver's, over a real duty ledger.
  const deps = {
    cron: new PgCronRepo(prisma),
    agent: new PgAgentRepo(prisma),
    placementResolver: new PlacementResolver({ duties: new PgDutyGroupRepo(prisma), clock: systemClock })
  } as unknown as DaemonWsDeps
  await handleCronReport(frame, { daemonId } as DaemonConnection, deps)
}

async function seedCron(agentId: string): Promise<string> {
  const cronId = randomUUID()
  await new PgCronRepo(prisma).upsert({
    cronId: CronId(cronId),
    orgId: OrgId(DEFAULT_ORG_ID),
    agentId: AgentId(agentId),
    schedule: '0 9 * * *',
    timezone: 'UTC',
    trigger: 'daily report'
  })
  return cronId
}

describe('cron/report EVT → lastRunAt convergence', () => {
  it('stamps lastRunAt from the owning daemon; a foreign daemon’s report is dropped', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedDaemon(prisma, OTHER_DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    const cronId = await seedCron(agentId)
    const firedAt = '2026-07-03T09:00:00.000Z'

    await report(OTHER_DAEMON, cronId, agentId, firedAt) // not this daemon's cron
    expect((await new PgCronRepo(prisma).get(OrgId(DEFAULT_ORG_ID), CronId(cronId)))!.lastRunAt).toBeNull()

    await report(DAEMON, cronId, agentId, firedAt)
    expect((await new PgCronRepo(prisma).get(OrgId(DEFAULT_ORG_ID), CronId(cronId)))!.lastRunAt).toEqual(
      new Date(firedAt)
    )
  })

  it('stamps lastRunAt from the pool member holding the agent’s duty (#1027)', async () => {
    await seedPoolMember(prisma, POOL_MEMBER)
    await seedDaemon(prisma, OTHER_DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { setId: await poolSetId(prisma) })
    const cronId = await seedCron(agentId)
    const firedAt = '2026-07-03T09:00:00.000Z'
    const repo = new PgCronRepo(prisma)

    // Nothing holds the duty yet: the member serves the agent no more than any other daemon does.
    await report(POOL_MEMBER, cronId, agentId, firedAt)
    expect((await repo.get(OrgId(DEFAULT_ORG_ID), CronId(cronId)))!.lastRunAt).toBeNull()

    await seedDutyGroup(prisma, randomUUID(), POOL_MEMBER, [agentId])
    // A member that holds no duty for it still cannot stamp it.
    await report(OTHER_DAEMON, cronId, agentId, firedAt)
    expect((await repo.get(OrgId(DEFAULT_ORG_ID), CronId(cronId)))!.lastRunAt).toBeNull()

    await report(POOL_MEMBER, cronId, agentId, firedAt)
    expect((await repo.get(OrgId(DEFAULT_ORG_ID), CronId(cronId)))!.lastRunAt).toEqual(new Date(firedAt))
    expect(await repo.listRuns(OrgId(DEFAULT_ORG_ID), CronId(cronId))).toHaveLength(1)
  })

  it('latest-wins: an older firedAt never regresses the stamp; a newer one advances it', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    const cronId = await seedCron(agentId)
    const repo = new PgCronRepo(prisma)

    await report(DAEMON, cronId, agentId, '2026-07-03T09:00:00.000Z')
    await report(DAEMON, cronId, agentId, '2026-07-02T09:00:00.000Z') // reconnect re-assert of an older fire
    expect((await repo.get(OrgId(DEFAULT_ORG_ID), CronId(cronId)))!.lastRunAt).toEqual(
      new Date('2026-07-03T09:00:00.000Z')
    )

    await report(DAEMON, cronId, agentId, '2026-07-04T09:00:00.000Z')
    expect((await repo.get(OrgId(DEFAULT_ORG_ID), CronId(cronId)))!.lastRunAt).toEqual(
      new Date('2026-07-04T09:00:00.000Z')
    )
  })

  it('an unknown cronId drops silently — never an error', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    await expect(report(DAEMON, randomUUID(), agentId, '2026-07-03T09:00:00.000Z')).resolves.toBeUndefined()
  })

  it('attaches the session while running; the completion report closes it with outcome', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    const cronId = await seedCron(agentId)
    const repo = new PgCronRepo(prisma)
    const firedAt = '2026-07-03T09:00:00.000Z'

    await report(DAEMON, cronId, agentId, firedAt) // fire → running
    let runs = await repo.listRuns(OrgId(DEFAULT_ORG_ID), CronId(cronId))
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ status: 'running', durationMs: null, sessionId: null })

    await report(DAEMON, cronId, agentId, firedAt, { sessionId: 'ses_1' })
    runs = await repo.listRuns(OrgId(DEFAULT_ORG_ID), CronId(cronId))
    expect(runs[0]).toMatchObject({ status: 'running', durationMs: null, sessionId: 'ses_1' })

    // A reconnect re-assert of the plain FIRE report preserves the live link.
    await report(DAEMON, cronId, agentId, firedAt)
    expect((await repo.listRuns(OrgId(DEFAULT_ORG_ID), CronId(cronId)))[0]).toMatchObject({
      status: 'running',
      sessionId: 'ses_1'
    })

    // A terminal report from a rolling-compatible daemon may omit the session;
    // omission preserves the association already recorded by the progress report.
    await report(DAEMON, cronId, agentId, firedAt, { status: 'success', durationMs: 4200 })
    runs = await repo.listRuns(OrgId(DEFAULT_ORG_ID), CronId(cronId))
    expect(runs).toHaveLength(1) // same (cronId, firedAt) key — closed, not duplicated
    expect(runs[0]).toMatchObject({ status: 'success', durationMs: 4200, sessionId: 'ses_1' })

    // Another FIRE re-assert never reopens the closed run.
    await report(DAEMON, cronId, agentId, firedAt)
    expect((await repo.listRuns(OrgId(DEFAULT_ORG_ID), CronId(cronId)))[0]!.status).toBe('success')
  })

  it('a completion without a prior fire report (CP was down) still creates the run — failed + reason', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    const cronId = await seedCron(agentId)
    const repo = new PgCronRepo(prisma)

    await report(DAEMON, cronId, agentId, '2026-07-03T10:00:00.000Z', {
      status: 'failed',
      durationMs: 900,
      reason: 'dispatch failed'
    })
    const runs = await repo.listRuns(OrgId(DEFAULT_ORG_ID), CronId(cronId))
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ status: 'failed', reason: 'dispatch failed' })
    // ...and the lastRunAt stamp still lands via the completion report.
    expect((await repo.get(OrgId(DEFAULT_ORG_ID), CronId(cronId)))!.lastRunAt).toEqual(
      new Date('2026-07-03T10:00:00.000Z')
    )
  })
})
