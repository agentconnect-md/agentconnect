/**
 * `POST /agents/:id/wake` — the console's "start this agent's sandbox" (#1070). The CP authorizes
 * the agent like every other agent write, resolves the DISPATCH daemon (a pool agent nobody serves
 * reaches a live member, which claims it the way a turn would), forwards ONE `agent/wake` per
 * debounce window, and answers with what the daemon observed. A GET never wakes anything.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AGENT_WAKE_FEATURE } from '@agentconnect.md/protocol'
import type { AgentWakeOk, AgentWakeReq, AgentWakeState } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { joinPool, poolSetId } from '../fakes/member-set.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { NoConnection, type ControlSender } from '../../src/orchestrator/outbound.js'
import { PlacementResolver } from '../../src/orchestrator/placementResolver.js'
import { PgDutyGroupRepo } from '../../src/persistence/repositories/duty-group.repo.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { systemClock } from '../../src/domain/clock.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import type { OrgMemberRole } from '../../src/persistence/ports.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const MACHINE = 'd5d5d5d5-dddd-4ddd-8ddd-ddddddddddd1'
const HOLDER = 'd5d5d5d5-dddd-4ddd-8ddd-ddddddddddd2'
const MEMBER = 'd5d5d5d5-dddd-4ddd-8ddd-ddddddddddd3'
const AGENT = 'a5a5a5a5-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const CAPS = { platforms: ['slack'], runtimes: ['claude'], acp: true, features: [AGENT_WAKE_FEATURE] }

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()))
})

/** The one seam under test, recording every forwarded REQ. */
class WakeSpy {
  calls: Array<{ daemonId: string; req: AgentWakeReq; orgId: string }> = []
  state: AgentWakeState = 'starting'
  failure: Error | null = null

  async agentWake(daemonId: string, req: AgentWakeReq, orgId: string): Promise<AgentWakeOk> {
    this.calls.push({ daemonId, req, orgId })
    if (this.failure) throw this.failure
    return { agentId: req.agentId, state: this.state }
  }
}

/** The prod resolver shape with the pool's live members pinned, since no member dials in here. */
function resolver(liveMembers: string[]): PlacementResolver {
  return new PlacementResolver({
    duties: new PgDutyGroupRepo(prisma),
    liveMembers: async () => liveMembers,
    clock: systemClock
  })
}

function app(control: WakeSpy, opts: { userId?: string; liveMembers?: string[] } = {}): HttpApp {
  const running = buildHttpApp(
    prisma,
    opts.userId ? { DEFAULT_OWNER_ID: opts.userId } : undefined,
    undefined,
    control as unknown as ControlSender,
    { placementResolver: resolver(opts.liveMembers ?? []) }
  )
  opened.push(running)
  return running
}

async function makeUser(sub: string, role: OrgMemberRole): Promise<string> {
  const users = new PgUserRepo(prisma)
  const email = `${sub}@acme.dev`
  const { userId } = await users.provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await users.addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

/** An install-wide pool member that advertises the wake: an org-less row enrolled in the pool. */
async function poolMember(daemonId: string): Promise<void> {
  await seedDaemon(prisma, daemonId, { capabilities: CAPS })
  await prisma.daemon.update({ where: { id: daemonId }, data: { orgId: null, clusterIdentity: `cluster/${daemonId}` } })
  await joinPool(prisma, daemonId)
}

/** A live, CONFIRMED duty lease over one agent — what makes a member serve it. */
async function grantDuty(holder: string, agentId: string): Promise<void> {
  const groupId = randomUUID()
  await prisma.dutyGroup.create({
    data: {
      id: groupId,
      orgId: DEFAULT_ORG_ID,
      holder,
      term: 1n,
      confirmedTerm: 1n,
      confirmedHolder: holder,
      expiresAt: new Date(Date.now() + 600_000)
    }
  })
  await prisma.dutyGroupMember.create({ data: { kind: 'agent', refId: agentId, groupId, orgId: DEFAULT_ORG_ID } })
}

async function seedPoolAgent(): Promise<void> {
  await seedAgent(prisma, AGENT, { setId: await poolSetId(prisma) })
}

const wake = (running: HttpApp, id = AGENT) => running.app.inject({ method: 'POST', url: `${ORG}/agents/${id}/wake` })

describe('POST /agents/:id/wake', () => {
  it('forwards to the member SERVING a pool agent, org-scoped, and answers 202 with its state', async () => {
    await poolMember(HOLDER)
    await seedPoolAgent()
    await grantDuty(HOLDER, AGENT)
    const control = new WakeSpy()

    const res = await wake(app(control))
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ state: 'starting' })
    expect(control.calls).toEqual([{ daemonId: HOLDER, req: { agentId: AGENT }, orgId: DEFAULT_ORG_ID }])
  })

  it('a pool agent NOBODY serves reaches a live member — the wake is the trigger that gives it a holder', async () => {
    await poolMember(MEMBER)
    await seedPoolAgent()
    const control = new WakeSpy()
    control.state = 'running'

    const res = await wake(app(control, { liveMembers: [MEMBER] }))
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ state: 'running' })
    expect(control.calls.map((c) => c.daemonId)).toEqual([MEMBER])
  })

  it('503s a pool agent with no holder and no live member — nothing can be woken', async () => {
    await seedPoolAgent()
    const control = new WakeSpy()

    const res = await wake(app(control))
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ message: 'agent has no live daemon' })
    expect(control.calls).toHaveLength(0)
  })

  it('answers 200 unsupported for a machine-placed agent, and sends its daemon nothing', async () => {
    await seedDaemon(prisma, MACHINE)
    await seedAgent(prisma, AGENT, { daemonId: MACHINE })
    const control = new WakeSpy()

    const res = await wake(app(control))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ state: 'unsupported' })
    expect(control.calls).toHaveLength(0)
  })

  it('debounces per agent: a second call joins the first wake instead of sending another frame', async () => {
    await poolMember(HOLDER)
    await seedPoolAgent()
    await grantDuty(HOLDER, AGENT)
    const control = new WakeSpy()
    const running = app(control)

    const first = await wake(running)
    const second = await wake(running)
    expect(first.statusCode).toBe(202)
    expect(second.statusCode).toBe(202)
    expect(second.json()).toEqual({ state: 'starting' })
    expect(control.calls).toHaveLength(1)

    // Another agent is another wake.
    const other = randomUUID()
    await seedAgent(prisma, other, { setId: await poolSetId(prisma) })
    await grantDuty(HOLDER, other)
    expect((await wake(running, other)).statusCode).toBe(202)
    expect(control.calls.map((c) => c.req.agentId)).toEqual([AGENT, other])
  })

  it('503s when the serving member cannot be reached, without caching the failure', async () => {
    await poolMember(HOLDER)
    await seedPoolAgent()
    await grantDuty(HOLDER, AGENT)
    const control = new WakeSpy()
    control.failure = new NoConnection(HOLDER)
    const running = app(control)

    expect((await wake(running)).statusCode).toBe(503)
    control.failure = null
    expect((await wake(running)).statusCode).toBe(202)
    expect(control.calls).toHaveLength(2)
  })

  it('is an agent WRITE: viewers are refused, and a restricted agent the caller cannot see is absent', async () => {
    await poolMember(HOLDER)
    await seedPoolAgent()
    await grantDuty(HOLDER, AGENT)
    const control = new WakeSpy()

    const viewer = await makeUser(`wake-viewer-${randomUUID()}`, 'viewer')
    expect((await wake(app(control, { userId: viewer }))).statusCode).toBe(403)

    const outsider = await makeUser(`wake-outsider-${randomUUID()}`, 'collaborator')
    const restricted = randomUUID()
    await seedAgent(prisma, restricted, {
      setId: await poolSetId(prisma),
      visibility: 'restricted',
      sharedWith: [DEFAULT_OWNER_ID]
    })
    expect((await wake(app(control, { userId: outsider }), restricted)).statusCode).toBe(404)
    expect((await wake(app(control), randomUUID())).statusCode).toBe(404)
    expect(control.calls).toHaveLength(0)
  })
})
