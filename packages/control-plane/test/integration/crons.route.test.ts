/**
 * Cron replication CP→daemon over the C2 REST surface (§3.11).
 *
 * A cron drives ONE agent, so its definition replicates to the OWNING AGENT'S
 * daemon (same placement scope as integrations): live (`cron/upsert` /
 * `cron/remove`) and eventually (the per-daemon register reconcile snapshot,
 * covered by the register handler test). Push is best-effort: an unplaced
 * agent or offline daemon never fails the request.
 *
 * Also covered: `agentId` is required and must reference a real agent (400);
 * `targetChannel` is optional (headless fire — pushed without `target`);
 * `schedule` must parse as a croner expression (400, not persisted); each
 * write appends a `cron_change` audit row (§3.12).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedDaemon, seedAgent, seedDutyGroup } from '../fixtures/seed.js'
import { seedPoolMember } from '../fakes/member-set.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import type { CronUpsert, CronRemove } from '@agentconnect.md/protocol'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

// Console routes are org-scoped: /orgs/:orgId/… (devAuth = seeded owner of the default org).
const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`

let running: HttpApp | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
})

/** A ControlSender spy recording the cron pushes the route makes. */
class SpyControl {
  readonly upserts: Array<{ daemonId: string; u: CronUpsert }> = []
  readonly removes: Array<{ daemonId: string; r: CronRemove; orgId?: string }> = []
  async cronUpsert(daemonId: string, u: CronUpsert): Promise<{ ok: boolean }> {
    this.upserts.push({ daemonId, u })
    return { ok: true }
  }
  // `orgId` is recorded because a removal payload is a bare cronId: the send
  // cannot derive an org on an install-wide connection, so dropping it is the bug.
  async cronRemove(daemonId: string, r: CronRemove, orgId?: string): Promise<{ ok: boolean }> {
    this.removes.push({ daemonId, r, orgId })
    return { ok: true }
  }
  // POST /integrations (used to seed a target integration) pushes these too.
  async integrationUpsert(): Promise<void> {}
  async integrationRemove(): Promise<void> {}
  // Console "Run now" — the tests flip `runAck` to exercise the rejection path.
  runAck: { ok: boolean; reason?: string } = { ok: true }
  readonly runs: Array<{ daemonId: string; cronId: string }> = []
  async cronRun(daemonId: string, r: { cronId: string }): Promise<{ ok: boolean; reason?: string }> {
    this.runs.push({ daemonId, cronId: r.cronId })
    return this.runAck
  }
}

const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'

function withSpy(): { app: HttpApp; spy: SpyControl } {
  const spy = new SpyControl()
  const app = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
  running = app
  return { app, spy }
}

const body = (agentId: string, over: Record<string, unknown> = {}) => ({
  agentId,
  schedule: '0 9 * * 1-5',
  timezone: 'Asia/Singapore',
  targetPlatform: 'slack',
  targetChannel: 'C123',
  trigger: 'post the standup summary',
  enabled: true,
  ...over
})

describe('cron replication CP→daemon (REST → cron/upsert·remove)', () => {
  it('PUT /crons/:id pushes cron/upsert (with agentId) to the owning agent’s daemon', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    const cronId = randomUUID()
    const { app, spy } = withSpy()

    const put = await app.app.inject({ method: 'PUT', url: `${ORG}/crons/${cronId}`, payload: body(agentId) })
    expect(put.statusCode).toBe(200)

    expect(spy.upserts).toHaveLength(1)
    expect(spy.upserts[0]!.daemonId).toBe(DAEMON)
    expect(spy.upserts[0]!.u).toEqual({
      cronId,
      orgId: DEFAULT_ORG_ID,
      agentId,
      schedule: '0 9 * * 1-5',
      timezone: 'Asia/Singapore',
      target: { platform: 'slack', channel: 'C123' },
      trigger: 'post the standup summary',
      enabled: true
    })
  })

  // A schedule fires by its timezone, so the server never picks one: it used to inherit the CP
  // PROCESS's zone, which is UTC in a container and the developer's laptop zone in a test — so an
  // omission put the schedule on a clock nobody chose, and it varied with where the CP ran.
  it('creates an omitted timezone as UTC rather than the control-plane process zone, and rejects invalid IANA names', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    const { app, spy } = withSpy()
    const defaultedId = randomUUID()

    const defaulted = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/crons/${defaultedId}`,
      payload: body(agentId, { timezone: undefined })
    })
    expect(defaulted.statusCode).toBe(200)
    expect((defaulted.json() as { timezone: string }).timezone).toBe('UTC')
    expect(spy.upserts[0]!.u.timezone).toBe('UTC')
    expect((await prisma.cronDef.findUnique({ where: { id: defaultedId } }))?.timezone).toBe('UTC')

    for (const timezone of ['Mars/Olympus_Mons', '+01:00']) {
      const invalidId = randomUUID()
      const invalid = await app.app.inject({
        method: 'PUT',
        url: `${ORG}/crons/${invalidId}`,
        payload: body(agentId, { timezone })
      })
      expect(invalid.statusCode).toBe(400)
      expect(await prisma.cronDef.findUnique({ where: { id: invalidId } })).toBeNull()
    }
    expect(spy.upserts).toHaveLength(1)
  })

  // An edit that omits the zone used to REPLACE the stored one with the process zone, quietly moving
  // a live schedule off the clock it was authored on. Omitting it now means "leave it alone".
  it('an edit that omits the timezone keeps the one the schedule was created with', async () => {
    const agentId = randomUUID()
    await seedAgent(prisma, agentId)
    const cronId = randomUUID()
    const { app } = withSpy()

    const created = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/crons/${cronId}`,
      payload: body(agentId, { timezone: 'America/New_York' })
    })
    expect(created.statusCode).toBe(200)

    const edited = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/crons/${cronId}`,
      payload: body(agentId, { timezone: undefined, trigger: 'a different prompt' })
    })
    expect(edited.statusCode).toBe(200)
    expect((edited.json() as { timezone: string }).timezone).toBe('America/New_York')
    expect((await prisma.cronDef.findUnique({ where: { id: cronId } }))?.timezone).toBe('America/New_York')
  })

  it('stamps creator + createdAt on create; an edit never reassigns the creator but advances last-modified', async () => {
    const agentId = randomUUID()
    await seedAgent(prisma, agentId)
    const cronId = randomUUID()
    const { app } = withSpy()

    const put = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/crons/${cronId}`,
      payload: body(agentId, { name: 'weekly-deploy-report' })
    })
    const dto = put.json() as {
      name: string | null
      createdBy: string | null
      createdAt: string
      lastModifiedBy: string | null
      lastModifiedAt: string
    }
    expect(dto.name).toBe('weekly-deploy-report') // console metadata — echoed, never on the wire
    expect(dto.createdBy).toBe('usr_owner000000000000000000') // devAuth = seeded owner userId
    expect(Date.parse(dto.createdAt)).not.toBeNaN()
    expect(dto.lastModifiedBy).toBe(dto.createdBy)
    expect(dto.lastModifiedAt).toBe(dto.createdAt)

    // On create the last-modifier == creator, stamped at the creation instant.
    const before = await prisma.cronDef.findUnique({ where: { id: cronId } })
    expect(before?.lastModifiedByUserId).toBe(before?.createdByUserId)
    expect(before?.lastModifiedAt).toEqual(before?.createdAt)

    // Re-upsert (an edit) keeps the original creator row untouched, but advances
    // the last-modified audit (who + when). Bracket with a same-process (Node)
    // timestamp — the repo stamps lastModifiedAt with `new Date()` in THIS
    // process, so `>= t0` proves a fresh re-stamp without comparing across the
    // Node vs Postgres (DB-sourced createdAt) clocks.
    const t0 = Date.now()
    const edit = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/crons/${cronId}`,
      payload: body(agentId, { trigger: 'edited' })
    })
    const editedDto = edit.json() as { createdBy: string | null; lastModifiedBy: string | null; lastModifiedAt: string }
    expect(editedDto.lastModifiedBy).toBe(editedDto.createdBy)
    expect(Date.parse(editedDto.lastModifiedAt)).not.toBeNaN()
    const after = await prisma.cronDef.findUnique({ where: { id: cronId } })
    expect(after?.createdByUserId).toBe(before?.createdByUserId)
    expect(after?.createdAt).toEqual(before?.createdAt)
    expect(after?.lastModifiedByUserId).toBe(before?.createdByUserId) // same editor here (devAuth owner)
    expect(after!.lastModifiedAt.getTime()).toBeGreaterThanOrEqual(t0) // re-stamped at edit time
  })

  it('a channel-less cron round-trips as headless: no target on the wire, null in the DTO', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    const cronId = randomUUID()
    const { app, spy } = withSpy()

    const put = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/crons/${cronId}`,
      payload: body(agentId, { targetChannel: undefined })
    })
    expect(put.statusCode).toBe(200)
    expect((put.json() as { targetChannel: string | null }).targetChannel).toBeNull()
    expect(spy.upserts[0]!.u.target).toBeUndefined()
  })

  it('a targetIntegrationId of the cron’s agent is accepted: platform derives from it, the wire target carries it', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    const cronId = randomUUID()
    const { app, spy } = withSpy()

    const install = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { name: 'acme-bot', platform: 'slack', agentId, slack: { botToken: 'xoxb-1', appToken: 'xapp-1' } }
    })
    expect(install.statusCode).toBe(201)
    const integrationId = (install.json() as { id: string }).id
    spy.upserts.length = 0 // drop the integration push — we assert the cron push

    const put = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/crons/${cronId}`,
      payload: body(agentId, { targetIntegrationId: integrationId })
    })
    expect(put.statusCode).toBe(200)
    expect((put.json() as { targetIntegrationId: string | null }).targetIntegrationId).toBe(integrationId)
    expect(spy.upserts[0]!.u.target).toEqual({ platform: 'slack', channel: 'C123', integrationId })
  })

  it('rejects a targetIntegrationId that is not an integration of the cron’s agent (400); headless drops it', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    const otherAgent = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    await seedAgent(prisma, otherAgent, { daemonId: DAEMON })
    const { app } = withSpy()

    // Integration belongs to OTHER agent — a cron for `agentId` cannot ride it.
    const install = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: {
        name: 'other-bot',
        platform: 'slack',
        agentId: otherAgent,
        slack: { botToken: 'xoxb-2', appToken: 'xapp-2' }
      }
    })
    const foreign = (install.json() as { id: string }).id

    const bad = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/crons/${randomUUID()}`,
      payload: body(agentId, { targetIntegrationId: foreign })
    })
    expect(bad.statusCode).toBe(400)

    // Headless (no channel): the integrationId is meaningless — stored null, not validated.
    const headless = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/crons/${randomUUID()}`,
      payload: body(agentId, { targetChannel: undefined, targetIntegrationId: foreign })
    })
    expect(headless.statusCode).toBe(200)
    expect((headless.json() as { targetIntegrationId: string | null }).targetIntegrationId).toBeNull()
  })

  it('DELETE /crons/:id pushes cron/remove to the owning daemon; unknown id → 404', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    const cronId = randomUUID()
    const { app, spy } = withSpy()

    await app.app.inject({ method: 'PUT', url: `${ORG}/crons/${cronId}`, payload: body(agentId) })
    const del = await app.app.inject({ method: 'DELETE', url: `${ORG}/crons/${cronId}` })
    expect(del.statusCode).toBe(204)
    // The org rides every removal now: the payload is a bare cronId, so the send
    // has nothing else to scope on when the connection is install-wide.
    expect(spy.removes).toEqual([{ daemonId: DAEMON, r: { cronId }, orgId: DEFAULT_ORG_ID }])

    expect((await app.app.inject({ method: 'DELETE', url: `${ORG}/crons/${cronId}` })).statusCode).toBe(404)
  })

  it('an UNPLACED agent (no daemonId) pushes nothing — reconcile is the backstop', async () => {
    const agentId = randomUUID()
    await seedAgent(prisma, agentId) // unplaced
    const cronId = randomUUID()
    const { app, spy } = withSpy()

    const put = await app.app.inject({ method: 'PUT', url: `${ORG}/crons/${cronId}`, payload: body(agentId) })
    expect(put.statusCode).toBe(200)
    const del = await app.app.inject({ method: 'DELETE', url: `${ORG}/crons/${cronId}` })
    expect(del.statusCode).toBe(204)

    expect(spy.upserts).toHaveLength(0)
    expect(spy.removes).toHaveLength(0)
  })

  it('rejects an unknown agentId (400) and a schedule croner cannot parse (400) — nothing persisted', async () => {
    const agentId = randomUUID()
    await seedAgent(prisma, agentId)
    const cronId = randomUUID()
    const { app, spy } = withSpy()

    const badAgent = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/crons/${cronId}`,
      payload: body(randomUUID()) // no such agent
    })
    expect(badAgent.statusCode).toBe(400)

    const badSchedule = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/crons/${cronId}`,
      payload: body(agentId, { schedule: 'not-a-cron' })
    })
    expect(badSchedule.statusCode).toBe(400)

    expect(await prisma.cronDef.findUnique({ where: { id: cronId } })).toBeNull()
    expect(spy.upserts).toHaveLength(0)
  })

  it('POST /crons/:id/run fires on the owning daemon (202); unplaced agent → 503; daemon nack → 400', async () => {
    await seedDaemon(prisma, DAEMON)
    const placed = randomUUID()
    const unplaced = randomUUID()
    await seedAgent(prisma, placed, { daemonId: DAEMON })
    await seedAgent(prisma, unplaced)
    const cronId = randomUUID()
    const orphanCron = randomUUID()
    const { app, spy } = withSpy()

    await app.app.inject({ method: 'PUT', url: `${ORG}/crons/${cronId}`, payload: body(placed) })
    await app.app.inject({ method: 'PUT', url: `${ORG}/crons/${orphanCron}`, payload: body(unplaced) })

    const run = await app.app.inject({ method: 'POST', url: `${ORG}/crons/${cronId}/run` })
    expect(run.statusCode).toBe(202)
    expect(spy.runs).toEqual([{ daemonId: DAEMON, cronId }])

    expect((await app.app.inject({ method: 'POST', url: `${ORG}/crons/${orphanCron}/run` })).statusCode).toBe(503)

    spy.runAck = { ok: false, reason: 'unknown cron' }
    const nack = await app.app.inject({ method: 'POST', url: `${ORG}/crons/${cronId}/run` })
    expect(nack.statusCode).toBe(400)

    expect((await app.app.inject({ method: 'POST', url: `${ORG}/crons/${randomUUID()}/run` })).statusCode).toBe(404)
  })

  it('GET /crons/:id/runs returns the daemon-reported history, newest first', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    const cronId = randomUUID()
    const { app } = withSpy()
    await app.app.inject({ method: 'PUT', url: `${ORG}/crons/${cronId}`, payload: body(agentId) })

    await prisma.cronRun.createMany({
      data: [
        {
          cronId,
          orgId: DEFAULT_ORG_ID,
          startedAt: new Date('2026-07-01T09:00:00Z'),
          status: 'success',
          durationMs: 4200,
          sessionId: 'ses_1'
        },
        { cronId, orgId: DEFAULT_ORG_ID, startedAt: new Date('2026-07-02T09:00:00Z'), status: 'failed', reason: 'boom' }
      ]
    })

    const res = await app.app.inject({ method: 'GET', url: `${ORG}/crons/${cronId}/runs` })
    expect(res.statusCode).toBe(200)
    const runs = res.json() as Array<{
      startedAt: string
      status: string
      sessionId: string | null
      reason: string | null
    }>
    expect(runs.map((r) => r.status)).toEqual(['failed', 'success']) // newest first
    expect(runs[1]).toMatchObject({ sessionId: 'ses_1', reason: null })

    expect((await app.app.inject({ method: 'GET', url: `${ORG}/crons/${randomUUID()}/runs` })).statusCode).toBe(404)
  })

  it('PUT and DELETE append cron_change audit rows (§3.12)', async () => {
    const agentId = randomUUID()
    await seedAgent(prisma, agentId)
    const cronId = randomUUID()
    const { app } = withSpy()

    await app.app.inject({ method: 'PUT', url: `${ORG}/crons/${cronId}`, payload: body(agentId) })
    await app.app.inject({ method: 'DELETE', url: `${ORG}/crons/${cronId}` })

    // Both appends are fire-and-forget: order is not guaranteed, and a prior test's row can outlive the sweep.
    await vi.waitFor(async () => {
      const rows = await prisma.auditEvent.findMany({
        where: { kind: 'cron_change', details: { path: ['cronId'], equals: cronId } }
      })
      expect(rows.sort((x, y) => (x.frameType ?? '').localeCompare(y.frameType ?? ''))).toMatchObject([
        { frameType: 'cron/remove', agentId },
        { frameType: 'cron/upsert', agentId }
      ])
    })
  })
})

/**
 * A cron follows the DUTY HOLDER too (#973): it drives the agent, so it belongs
 * wherever the agent is served. A holder left on a stale schedule (or still
 * holding one the operator deleted) fires the wrong work, and a cron mutation
 * does not advance `Agent.configRevision`, so nothing makes it refetch either.
 */
describe('cron updates follow the duty holder', () => {
  const HOLDER = 'd8888888-8888-4888-8888-888888888888'
  const GROUP = '00000000-0000-4000-8000-0000000009c1'

  it('a cron upsert reaches a holder that is NOT the placement, carrying the new schedule', async () => {
    await seedDaemon(prisma, HOLDER)
    const agentId = randomUUID()
    // Placed nowhere: the duty is the only reason this cron reaches a daemon.
    await seedAgent(prisma, agentId)
    await seedDutyGroup(prisma, GROUP, HOLDER, [agentId])
    const cronId = randomUUID()
    const { app, spy } = withSpy()

    const put = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/crons/${cronId}`,
      payload: body(agentId, { schedule: '30 6 * * *' })
    })
    expect(put.statusCode).toBe(200)

    expect(spy.upserts.map((u) => u.daemonId)).toEqual([HOLDER])
    // Current without a reconnect: the definition that arrived is the edited one.
    expect(spy.upserts[0]!.u).toMatchObject({ cronId, agentId, schedule: '30 6 * * *' })
    // `CronUpsert.orgId` is OPTIONAL on the wire, so the guarantee is that
    // `cronToUpsert` always stamps the row's org. Pin it: a producer that omits
    // it hands the upsert path exactly the removal bug.
    expect(spy.upserts[0]!.u.orgId).toBe(DEFAULT_ORG_ID)
  })

  it('a cron removal reaches the holder', async () => {
    await seedDaemon(prisma, HOLDER)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId)
    await seedDutyGroup(prisma, GROUP, HOLDER, [agentId])
    const cronId = randomUUID()
    const { app, spy } = withSpy()

    await app.app.inject({ method: 'PUT', url: `${ORG}/crons/${cronId}`, payload: body(agentId) })
    const del = await app.app.inject({ method: 'DELETE', url: `${ORG}/crons/${cronId}` })
    expect(del.statusCode).toBe(204)

    // The org is the assertion, not an incidental: `cron/remove` carries only a
    // cronId, and this holder never registered the cron (it would have arrived
    // through `duty/fetch`), so a send without the org is SCOPE_DENIED before it
    // leaves the process — the daemon would keep firing a deleted schedule.
    expect(spy.removes).toEqual([{ daemonId: HOLDER, r: { cronId }, orgId: DEFAULT_ORG_ID }])
  })

  it('a placement AND a holder each get the cron exactly once', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedDaemon(prisma, HOLDER)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    await seedDutyGroup(prisma, GROUP, HOLDER, [agentId])
    const { app, spy } = withSpy()

    await app.app.inject({ method: 'PUT', url: `${ORG}/crons/${randomUUID()}`, payload: body(agentId) })

    expect(spy.upserts.map((u) => u.daemonId)).toEqual([DAEMON, HOLDER])
  })

  // #1026: "Run now" resolved the serving member and then wrote it onto the observed record, so
  // the mutation refresh compared a synthetic value against a NULL column and 409'd every time.
  it('fires a POOL agent’s cron on the member holding its duty (#1026)', async () => {
    const setId = await seedPoolMember(prisma, HOLDER)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { setId })
    await seedDutyGroup(prisma, GROUP, HOLDER, [agentId])
    const cronId = randomUUID()
    const { app, spy } = withSpy()

    expect(
      (await app.app.inject({ method: 'PUT', url: `${ORG}/crons/${cronId}`, payload: body(agentId) })).statusCode
    ).toBe(200)
    const run = await app.app.inject({ method: 'POST', url: `${ORG}/crons/${cronId}/run` })
    expect({ status: run.statusCode, runs: spy.runs }).toEqual({
      status: 202,
      runs: [{ daemonId: HOLDER, cronId }]
    })
  })

  it('a POOL agent nothing is serving still refuses the run with 503', async () => {
    const setId = await seedPoolMember(prisma, HOLDER)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { setId })
    const cronId = randomUUID()
    const { app, spy } = withSpy()

    await app.app.inject({ method: 'PUT', url: `${ORG}/crons/${cronId}`, payload: body(agentId) })
    const run = await app.app.inject({ method: 'POST', url: `${ORG}/crons/${cronId}/run` })
    expect({ status: run.statusCode, runs: spy.runs }).toEqual({ status: 503, runs: [] })
  })

  it('an EXPIRED lease is not a holding — the cron goes nowhere', async () => {
    await seedDaemon(prisma, HOLDER)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId)
    await seedDutyGroup(prisma, GROUP, HOLDER, [agentId], { expiresAt: new Date(Date.now() - 1000) })
    const { app, spy } = withSpy()

    await app.app.inject({ method: 'PUT', url: `${ORG}/crons/${randomUUID()}`, payload: body(agentId) })

    expect(spy.upserts).toHaveLength(0)
  })
})
