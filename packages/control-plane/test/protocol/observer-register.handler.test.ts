/**
 * Observer registration (`register.observer`) — the connection the `reconcile --once` CronJob
 * opens. It authenticates on the same projected pool identity a member does, so the CP admits it
 * and answers its reads, but it must never become a pool member: no membership row, so the duty
 * ledger's eligibility gate can never reach it, and a row the pool-member reaper takes at once.
 */
import { describe, it, expect } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { buildWsHarness } from '../fakes/build-ws.js'
import { poolSetId } from '../fakes/member-set.js'
import { PgDaemonRepo } from '../../src/persistence/index.js'

const OBSERVER = 'd0b5e4be-0000-4000-8000-000000000001'
const MEMBER = 'd0b5e4be-0000-4000-8000-000000000002'
const AGENT = 'a0b5e4be-0000-4000-8000-000000000003'
const GROUP = '00000000-0000-4000-8000-0000000000a1'
const AUTH_ID = '11111111-1111-4111-8111-000000000001'
const REG_ID = '22222222-2222-4222-8222-000000000002'

function registerPayload(observer?: boolean) {
  return {
    host: observer ? 'reconcile' : 'member-1',
    ...(observer ? { observer: true } : {}),
    capabilities: { platforms: [], runtimes: [], acp: false, features: [] },
    maxAgents: observer ? 0 : 8,
    localState: { assignments: [], crons: [], leases: [], agents: [], integrations: [], stagedAgents: [] }
  }
}

/** Auth a pool Pod identity, then register — as an observer or as an ordinary member. */
async function connect(h: ReturnType<typeof buildWsHarness>, daemonId: string, observer?: boolean) {
  const { stub } = h.connect()
  const token = await h.mintPoolMember(daemonId)
  stub.inject('auth', { serviceAccountToken: token, daemonId, agentVersion: '1.4.0' }, { id: AUTH_ID })
  await stub.expectFrame('auth/ok')
  stub.inject('register', registerPayload(observer), { id: REG_ID })
  await stub.settled()
  return stub
}

/** A vacant duty group over one set-placed agent — the only thing a pool member could be granted. */
async function seedVacantDuty(): Promise<void> {
  await prisma.agent.create({
    data: {
      id: AGENT,
      orgId: DEFAULT_ORG_ID,
      name: 'agent-1',
      runtime: 'claude',
      placementKind: 'set',
      setId: await poolSetId(prisma)
    }
  })
  await prisma.dutyGroup.create({ data: { id: GROUP, orgId: DEFAULT_ORG_ID, holder: null, term: 0n } })
  await prisma.dutyGroupMember.create({
    data: { kind: 'agent', refId: AGENT, groupId: GROUP, orgId: DEFAULT_ORG_ID }
  })
}

const heartbeat = { load: { cpu: 0.1, mem: 0.1, agents: 0 }, health: 'ok', activeSessions: 0 }

describe('observer registration (protocol level, real Postgres)', () => {
  it('admits the identity but enrolls no member, so the ledger never grants it a group', async () => {
    await seedVacantDuty()
    const h = buildWsHarness(prisma)
    const stub = await connect(h, OBSERVER, true)
    expect(stub.lastSent('register/ok')).toBeDefined()

    // `upsertOnAuth` enrolls every org-less row; the observer's registration takes it back out.
    expect(await prisma.memberSetMember.findUnique({ where: { daemonId: OBSERVER } })).toBeNull()

    stub.inject('heartbeat', { ...heartbeat, duties: { held: [], headroom: 8 } })
    await stub.settled()
    expect(stub.sent.filter((f) => f.type === 'duty/grant')).toEqual([])
    expect((await prisma.dutyGroup.findUniqueOrThrow({ where: { id: GROUP } })).holder).toBeNull()
  })

  it('leaves an ordinary member of the same pool claiming that group — the difference IS the flag', async () => {
    await seedVacantDuty()
    const h = buildWsHarness(prisma)
    const stub = await connect(h, MEMBER)
    expect(await prisma.memberSetMember.findUnique({ where: { daemonId: MEMBER } })).not.toBeNull()

    stub.inject('heartbeat', { ...heartbeat, duties: { held: [], headroom: 8 } })
    await stub.settled()
    expect((await prisma.dutyGroup.findUniqueOrThrow({ where: { id: GROUP } })).holder).toBe(MEMBER)
  })

  it('answers an observer connection’s agent/exists read — the one thing the sweep connects for', async () => {
    await seedVacantDuty()
    const h = buildWsHarness(prisma)
    const stub = await connect(h, OBSERVER, true)
    const gone = 'a0b5e4be-0000-4000-8000-00000000dead'

    stub.inject('agent/exists', { agentIds: [AGENT, gone] })
    await stub.settled()
    expect(stub.lastSent('agent/exists/ok')?.payload).toEqual({ existing: [AGENT] })
  })

  it('backdates the row so the pool-member reaper retires it on its next sweep', async () => {
    const h = buildWsHarness(prisma)
    const stub = await connect(h, OBSERVER, true)
    expect(stub.lastSent('register/ok')).toBeDefined()
    // What makes the row a POOL member row, which is the only shape the reaper may touch.
    await prisma.daemon.update({
      where: { id: OBSERVER },
      data: { clusterIdentity: 'system:serviceaccount:pool:daemon', clusterPodUid: 'pod-observer' }
    })

    const retired = await new PgDaemonRepo(prisma).findRetiredPoolMembers(new Date(h.clock.now()))
    expect(retired.map((row) => row.id)).toEqual([OBSERVER])
  })

  it('refuses the flag on an org-scoped connection, which is a daemon key and not a job identity', async () => {
    const h = buildWsHarness(prisma)
    const { stub } = h.connect()
    const key = await h.mintToken(MEMBER)
    stub.inject('auth', { apiKey: key, daemonId: MEMBER, agentVersion: '1.4.0' }, { id: AUTH_ID })
    await stub.expectFrame('auth/ok')

    stub.inject('register', registerPayload(true), { id: REG_ID })
    await stub.settled()
    expect(stub.lastSent('register/ok')).toBeUndefined()
    expect(stub.lastSent('error')?.payload).toMatchObject({ code: 'SCOPE_DENIED' })
  })
})
