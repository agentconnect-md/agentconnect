// The Cloud-compute standing gate on agent placement, wake and keep-alive (key-server.md §2.3): only Cloud is gated.
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AGENT_WAKE_FEATURE, SANDBOX_KEEP_ALIVE_FEATURE } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon, seedSessionMeta } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { joinPool, poolSetId } from '../fakes/member-set.js'
import { FakeOrgStanding, SUSPENDED, SUSPENDED_MESSAGE, UNAVAILABLE } from '../fakes/org-standing.js'
import type { DaemonLiveness } from '../../src/ports.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { PlacementResolver } from '../../src/orchestrator/placementResolver.js'
import { PgDutyGroupRepo } from '../../src/persistence/repositories/duty-group.repo.js'
import { systemClock } from '../../src/domain/clock.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const SOURCE = 'e1e1e1e1-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const TARGET = 'e1e1e1e1-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
const MEMBER = 'e1e1e1e1-cccc-4ccc-8ccc-ccccccccccc3'
const ORG_MEMBER = 'e1e1e1e1-dddd-4ddd-8ddd-ddddddddddd4'
const AGENT = 'e2e2e2e2-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const CAPS = {
  platforms: ['slack'],
  runtimes: ['Claude Code', 'claude'],
  acp: true,
  features: ['agent-move-v1', AGENT_WAKE_FEATURE, SANDBOX_KEEP_ALIVE_FEATURE]
}

const live: DaemonLiveness = {
  get: (id) =>
    [SOURCE, TARGET, MEMBER, ORG_MEMBER].includes(id) ? { state: 'READY', reachable: true, sessionEpoch: 1 } : undefined
}

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()))
})

/** Every daemon-bound call the routes make, answered as a healthy daemon would. */
function controlSpy() {
  const calls: string[] = []
  const control = new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (prop === 'then') return undefined
        return async (...args: unknown[]) => {
          calls.push(prop)
          if (prop === 'agentWake') return { agentId: (args[1] as { agentId: string }).agentId, state: 'starting' }
          if (prop === 'sandboxKeepAlive') return { agentId: AGENT, held: true, reasons: [], placement: 'sandbox' }
          return { ok: true }
        }
      }
    }
  )
  return { control: control as ControlSender, calls }
}

function app(standing: FakeOrgStanding | undefined, control: ControlSender, liveMembers: string[] = []): HttpApp {
  const running = buildHttpApp(prisma, undefined, live, control, {
    ...(standing ? { orgStanding: standing } : {}),
    placementResolver: new PlacementResolver({
      duties: new PgDutyGroupRepo(prisma),
      liveMembers: async () => liveMembers,
      clock: systemClock
    })
  })
  opened.push(running)
  return running
}

async function seedPoolMember(): Promise<void> {
  await prisma.daemon.create({
    data: { id: MEMBER, orgId: null, maxAgents: 8, status: 'ready', capabilities: CAPS }
  })
  await joinPool(prisma, MEMBER)
}

/** A self-hosted cluster: an org-owned member set with one of the org's own daemons in it. */
async function seedOrgSet(): Promise<string> {
  const setId = randomUUID()
  await prisma.memberSet.create({ data: { id: setId, orgId: DEFAULT_ORG_ID, name: 'self-hosted cluster' } })
  await seedDaemon(prisma, ORG_MEMBER, { capabilities: CAPS })
  await prisma.memberSetMember.create({ data: { setId, daemonId: ORG_MEMBER } })
  return setId
}

const createOnPool = (running: HttpApp, name: string) =>
  running.app.inject({
    method: 'POST',
    url: `${ORG}/agents`,
    payload: { name, runtime: 'Claude Code', placementKind: 'pool' }
  })

describe('POST /agents — Cloud placement needs an org that may run it', () => {
  it('refuses a pool create for a suspended org with 402 and the key server’s message, creating nothing', async () => {
    await seedPoolMember()
    const standing = new FakeOrgStanding(SUSPENDED)
    const res = await createOnPool(app(standing, controlSpy().control), 'cloud-agent')
    expect(res.statusCode).toBe(402)
    expect(res.json()).toEqual({
      error: 'Payment Required',
      statusCode: 402,
      message: SUSPENDED_MESSAGE,
      code: 'ORG_SUSPENDED'
    })
    expect(standing.asked).toEqual([DEFAULT_ORG_ID])
    expect(await prisma.agent.findFirst({ where: { name: 'cloud-agent' } })).toBeNull()
  })

  it('fails closed with 503 when the standing cannot be confirmed', async () => {
    await seedPoolMember()
    const res = await createOnPool(app(new FakeOrgStanding(UNAVAILABLE), controlSpy().control), 'cloud-agent')
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ code: 'ORG_STANDING_UNAVAILABLE' })
    expect(res.json().message).not.toContain('fetch failed')
    expect(await prisma.agent.findFirst({ where: { name: 'cloud-agent' } })).toBeNull()
  })

  it('creates on the pool when the org is allowed, and with no gate configured at all', async () => {
    await seedPoolMember()
    const standing = new FakeOrgStanding()
    expect((await createOnPool(app(standing, controlSpy().control), 'allowed-agent')).statusCode).toBe(201)
    expect(standing.asked).toEqual([DEFAULT_ORG_ID])
    expect((await createOnPool(app(undefined, controlSpy().control), 'ungated-agent')).statusCode).toBe(201)
  })

  it('never gates a self-hosted daemon placement', async () => {
    await seedDaemon(prisma, SOURCE, { capabilities: CAPS })
    const standing = new FakeOrgStanding(SUSPENDED)
    const res = await app(standing, controlSpy().control).app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'machine-agent', runtime: 'Claude Code', daemonId: SOURCE }
    })
    expect(res.statusCode).toBe(201)
    expect(standing.asked).toEqual([])
  })
})

describe('PUT /agents/:id/daemon — a move onto Cloud needs an org that may run it', () => {
  const move = (running: HttpApp, payload: Record<string, unknown>) =>
    running.app.inject({ method: 'PUT', url: `${ORG}/agents/${AGENT}/daemon`, payload })

  it('refuses a move onto the pool for a suspended org, leaving the agent where it was', async () => {
    await seedDaemon(prisma, SOURCE, { capabilities: CAPS })
    await seedPoolMember()
    await seedAgent(prisma, AGENT, { daemonId: SOURCE, runtime: 'Claude Code' })
    const spy = controlSpy()
    const res = await move(app(new FakeOrgStanding(SUSPENDED), spy.control), { placementKind: 'pool' })
    expect(res.statusCode).toBe(402)
    expect(res.json()).toMatchObject({ code: 'ORG_SUSPENDED', message: SUSPENDED_MESSAGE })
    expect(await prisma.agent.findUnique({ where: { id: AGENT } })).toMatchObject({
      placementKind: 'daemon',
      daemonId: SOURCE
    })
    expect(spy.calls).toEqual([])
  })

  it('places onto the pool when the org is allowed', async () => {
    await seedPoolMember()
    // Unplaced, so it has no daemon-home memory tree to strand on the pool.
    await seedAgent(prisma, AGENT, { runtime: 'Claude Code' })
    const res = await move(app(new FakeOrgStanding(), controlSpy().control), { placementKind: 'pool' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ placementKind: 'set', setId: await poolSetId(prisma) })
  })

  it('never gates a move onto a self-hosted daemon', async () => {
    await seedDaemon(prisma, SOURCE, { capabilities: CAPS })
    await seedDaemon(prisma, TARGET, { capabilities: CAPS })
    await seedAgent(prisma, AGENT, { daemonId: SOURCE, runtime: 'Claude Code' })
    const standing = new FakeOrgStanding(SUSPENDED)
    const res = await move(app(standing, controlSpy().control), { daemonId: TARGET })
    expect(res.statusCode).toBe(200)
    expect(standing.asked).toEqual([])
  })
})

describe('POST /agents/:id/wake — waking a Cloud sandbox needs an org that may run it', () => {
  const wake = (running: HttpApp) => running.app.inject({ method: 'POST', url: `${ORG}/agents/${AGENT}/wake` })

  it('refuses a pool agent’s wake for a suspended org before any member is asked', async () => {
    await seedPoolMember()
    await seedAgent(prisma, AGENT, { setId: await poolSetId(prisma) })
    const spy = controlSpy()
    const res = await wake(app(new FakeOrgStanding(SUSPENDED), spy.control, [MEMBER]))
    expect(res.statusCode).toBe(402)
    expect(res.json()).toMatchObject({ code: 'ORG_SUSPENDED', message: SUSPENDED_MESSAGE })
    expect(spy.calls).toEqual([])
  })

  it('503s when the standing cannot be confirmed, and wakes once the org is allowed', async () => {
    await seedPoolMember()
    await seedAgent(prisma, AGENT, { setId: await poolSetId(prisma) })
    const spy = controlSpy()
    const standing = new FakeOrgStanding(UNAVAILABLE)
    const running = app(standing, spy.control, [MEMBER])
    expect((await wake(running)).statusCode).toBe(503)
    expect(spy.calls).toEqual([])
    standing.verdict = { allowed: true }
    expect((await wake(running)).statusCode).toBe(202)
    expect(spy.calls).toEqual(['agentWake'])
  })

  it('never gates a machine-placed agent or one on the org’s own cluster', async () => {
    await seedDaemon(prisma, SOURCE, { capabilities: CAPS })
    await seedAgent(prisma, AGENT, { daemonId: SOURCE })
    const standing = new FakeOrgStanding(SUSPENDED)
    expect((await wake(app(standing, controlSpy().control))).statusCode).toBe(202)

    const setId = await seedOrgSet()
    await prisma.agent.update({ where: { id: AGENT }, data: { placementKind: 'set', setId, daemonId: null } })
    expect((await wake(app(standing, controlSpy().control, [ORG_MEMBER]))).statusCode).toBe(202)
    expect(standing.asked).toEqual([])
  })
})

describe('POST /sessions/:id/sandbox-keep-alive — holding a Cloud pod needs an org that may run it', () => {
  const keepAlive = (running: HttpApp, sessionId: string) =>
    running.app.inject({ method: 'POST', url: `${ORG}/sessions/${sessionId}/sandbox-keep-alive`, payload: {} })

  it('refuses to hold a pool member’s pod for a suspended org, and holds it once allowed', async () => {
    await seedPoolMember()
    await seedAgent(prisma, AGENT, { daemonId: MEMBER })
    const session = await seedSessionMeta(prisma, randomUUID(), AGENT, { daemonId: MEMBER })
    const spy = controlSpy()
    const standing = new FakeOrgStanding(SUSPENDED)
    const running = app(standing, spy.control)
    const res = await keepAlive(running, session)
    expect(res.statusCode).toBe(402)
    expect(res.json()).toMatchObject({ code: 'ORG_SUSPENDED' })
    expect(spy.calls).toEqual([])
    standing.verdict = { allowed: true }
    expect((await keepAlive(running, session)).statusCode).toBe(200)
    expect(spy.calls).toEqual(['sandboxKeepAlive'])
  })

  it('never gates a self-hosted daemon’s sandbox', async () => {
    await seedDaemon(prisma, SOURCE, { capabilities: CAPS })
    await seedAgent(prisma, AGENT, { daemonId: SOURCE })
    const session = await seedSessionMeta(prisma, randomUUID(), AGENT, { daemonId: SOURCE })
    const standing = new FakeOrgStanding(SUSPENDED)
    expect((await keepAlive(app(standing, controlSpy().control), session)).statusCode).toBe(200)
    expect(standing.asked).toEqual([])
  })
})
