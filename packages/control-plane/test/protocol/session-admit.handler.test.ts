// `session/admit` over the real daemon WS edge and real Postgres (org-session-policy.md, Admission).
import { describe, it, expect } from 'vitest'
import {
  isFrame,
  SESSION_ADMIT_FEATURE,
  SESSION_ADMIT_REFUSAL_FEATURE,
  SESSION_LIMIT_REACHED
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildWsHarness, type WsHarness } from '../fakes/build-ws.js'
import { InMemoryDaemonStub } from '../fakes/daemon-stub.js'
import { DEF_ORG, seedAgent, seedDaemon } from '../fixtures/seed.js'
import { AgentMutationGate } from '../../src/orchestrator/agentMutationGate.js'
import { PgOrgSessionPolicyRepo } from '../../src/persistence/repositories/org-session-policy.repo.js'

const DAEMON = 'dddddddd-dddd-4ddd-8ddd-dddddddddd01'
const OTHER_DAEMON = 'dddddddd-dddd-4ddd-8ddd-dddddddddd02'
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01'
const OTHER_AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02'
const UNKNOWN_AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03'
const FOREIGN_ORG = 'example-foreign-org'
const FOREIGN_AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa04'

async function ready(h: WsHarness, daemonId: string, features: string[] = []) {
  const token = await h.mintToken(daemonId, { approved: true })
  const stub = new InMemoryDaemonStub()
  h.connect(stub)
  stub.inject('auth', { apiKey: token, daemonId, agentVersion: '1.4.0' })
  await stub.expectFrame('auth/ok')
  stub.inject('register', {
    host: 'daemon-1',
    capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true, features },
    maxAgents: 4,
    localState: { assignments: [], crons: [], leases: [], agents: [], integrations: [], stagedAgents: [] }
  })
  const ok = await stub.expectFrame('register/ok')
  if (!isFrame('register/ok')(ok)) throw new Error('expected register/ok')
  return { stub, serverFeatures: ok.payload.serverFeatures ?? [] }
}

async function answerTo(stub: InMemoryDaemonStub, id: string) {
  await stub.settled()
  const reply = stub.sent.find((f) => f.corr === id && f.type === 'session/admit/result')
  const error = stub.sent.find((f) => f.corr === id && f.type === 'error')
  return {
    reply: reply && isFrame('session/admit/result')(reply) ? reply.payload : undefined,
    error: error && isFrame('error')(error) ? error.payload : undefined
  }
}

async function used(orgId: string = DEF_ORG): Promise<number> {
  const rows = await prisma.orgSessionMonth.findMany({ where: { orgId } })
  return rows.reduce((sum, row) => sum + row.used, 0)
}

async function seedPlaced(): Promise<void> {
  await seedDaemon(prisma, DAEMON)
  await seedAgent(prisma, AGENT, { daemonId: DAEMON })
}

describe('session/admit over the daemon WS edge', () => {
  it('admits a new session for the serving daemon once, after advertising the feature', async () => {
    await seedPlaced()
    const h = buildWsHarness(prisma)
    const { stub, serverFeatures } = await ready(h, DAEMON)
    expect(serverFeatures).toContain(SESSION_ADMIT_FEATURE)

    const first = await answerTo(stub, stub.inject('session/admit', { agentId: AGENT, sessionId: 's-1' }))
    expect(first).toEqual({ reply: { admitted: true, counted: true, enforcing: false }, error: undefined })
    const again = await answerTo(stub, stub.inject('session/admit', { agentId: AGENT, sessionId: 's-1' }))
    expect(again).toEqual({ reply: { admitted: true, counted: true, enforcing: false }, error: undefined })
    expect(await used()).toBe(1)
  })

  it('exempts a memory dream only for an agent whose stored config runs dreaming on managed memory', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const disabled = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa05'
    const unmanaged = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa06'
    await seedAgent(prisma, disabled, {
      daemonId: DAEMON,
      runtimeOverrides: { memory: { provider: 'managed', dreaming: { enabled: false } } }
    })
    await seedAgent(prisma, unmanaged, { daemonId: DAEMON, runtimeOverrides: { memory: { provider: 'none' } } })
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h, DAEMON)
    const dream = (agentId: string, sessionId: string) =>
      answerTo(stub, stub.inject('session/admit', { agentId, sessionId, purpose: 'memory-dream' }))

    expect(await dream(AGENT, 'd-1')).toEqual({
      reply: { admitted: true, counted: false, enforcing: false },
      error: undefined
    })
    expect(await used()).toBe(0)
    expect((await dream(disabled, 'd-2')).reply).toEqual({ admitted: true, counted: true, enforcing: false })
    expect((await dream(unmanaged, 'd-3')).reply).toEqual({ admitted: true, counted: true, enforcing: false })
    expect(await used()).toBe(2)
    const rows = await prisma.orgSessionAdmission.findMany({ orderBy: { sessionId: 'asc' } })
    expect(rows.map((r) => [r.sessionId, r.maintenance])).toEqual([
      ['d-1', 'memory-dream'],
      ['d-2', null],
      ['d-3', null]
    ])
  })

  it('refuses a daemon the agent is not placed on, and writes nothing', async () => {
    await seedPlaced()
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h, OTHER_DAEMON)

    const { reply, error } = await answerTo(stub, stub.inject('session/admit', { agentId: AGENT, sessionId: 's-1' }))
    expect(reply).toBeUndefined()
    expect(error).toMatchObject({ code: 'SCOPE_DENIED', retryable: false })
    expect(await prisma.orgSessionAdmission.count()).toBe(0)
    expect(await used()).toBe(0)
  })

  it('refuses an unknown agent and another organization’s agent', async () => {
    await seedPlaced()
    await prisma.org.create({ data: { id: FOREIGN_ORG, slug: FOREIGN_ORG } })
    await seedAgent(prisma, FOREIGN_AGENT, { orgId: FOREIGN_ORG, daemonId: DAEMON })
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h, DAEMON)

    const unknown = await answerTo(stub, stub.inject('session/admit', { agentId: UNKNOWN_AGENT, sessionId: 's-1' }))
    expect(unknown.error).toMatchObject({ code: 'SCOPE_DENIED', message: 'this daemon does not serve that agent' })
    const foreign = await answerTo(stub, stub.inject('session/admit', { agentId: FOREIGN_AGENT, sessionId: 's-2' }))
    expect(foreign.reply).toBeUndefined()
    expect(foreign.error).toMatchObject({ code: 'SCOPE_DENIED', retryable: false })
    expect(await prisma.orgSessionAdmission.count()).toBe(0)
  })

  it('refuses a session id another agent holds', async () => {
    await seedPlaced()
    await seedAgent(prisma, OTHER_AGENT, { daemonId: DAEMON })
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h, DAEMON)

    await answerTo(stub, stub.inject('session/admit', { agentId: AGENT, sessionId: 's-1' }))
    const { reply, error } = await answerTo(
      stub,
      stub.inject('session/admit', { agentId: OTHER_AGENT, sessionId: 's-1' })
    )
    expect(reply).toBeUndefined()
    expect(error).toMatchObject({
      code: 'SCOPE_DENIED',
      message: 'that session id belongs to another agent',
      retryable: false
    })
    expect(await used()).toBe(1)
  })

  it('answers retryably while the agent’s placement is mutating', async () => {
    await seedPlaced()
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h, DAEMON)
    const releaseMove = (h.deps.agentMutations as AgentMutationGate).tryBeginMove(AGENT)
    expect(releaseMove).not.toBeNull()

    const held = await answerTo(stub, stub.inject('session/admit', { agentId: AGENT, sessionId: 's-1' }))
    expect(held.error).toMatchObject({ code: 'INTERNAL', retryable: true })
    releaseMove!()
    const after = await answerTo(stub, stub.inject('session/admit', { agentId: AGENT, sessionId: 's-1' }))
    expect(after.reply).toEqual({ admitted: true, counted: true, enforcing: false })
  })

  it('neither advertises nor answers without an admission store', async () => {
    await seedPlaced()
    const h = buildWsHarness(prisma)
    delete h.deps.sessionAdmission
    const { stub, serverFeatures } = await ready(h, DAEMON)
    expect(serverFeatures).not.toContain(SESSION_ADMIT_FEATURE)

    const { error } = await answerTo(stub, stub.inject('session/admit', { agentId: AGENT, sessionId: 's-1' }))
    expect(error).toMatchObject({ code: 'SCOPE_DENIED', retryable: false })
  })
})

describe('session/admit under an enforced monthly session limit', () => {
  const enforce = (monthlySessionLimit: number) =>
    new PgOrgSessionPolicyRepo(prisma).apply(DEF_ORG, {
      revision: 1,
      monthlySessionLimit,
      historyRetentionDays: null,
      enforce: true
    })

  it('refuses at the limit with the refusal variant to a daemon that reads it', async () => {
    await seedPlaced()
    await enforce(1)
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h, DAEMON, [SESSION_ADMIT_REFUSAL_FEATURE])

    const first = await answerTo(stub, stub.inject('session/admit', { agentId: AGENT, sessionId: 's-1' }))
    expect(first.reply).toEqual({ admitted: true, counted: true, enforcing: true })
    const refused = await answerTo(stub, stub.inject('session/admit', { agentId: AGENT, sessionId: 's-2' }))
    expect(refused.reply).toEqual({
      admitted: false,
      reason: SESSION_LIMIT_REACHED,
      limit: 1,
      used: 1,
      resetsAt: expect.any(String),
      enforcing: true
    })
    expect(Date.parse((refused.reply as { resetsAt: string }).resetsAt)).toBeGreaterThan(Date.now())
    expect(await used()).toBe(1)
  })

  it('answers an older daemon with a definite error instead of a variant it cannot decode', async () => {
    await seedPlaced()
    await enforce(0)
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h, DAEMON)

    const { reply, error } = await answerTo(stub, stub.inject('session/admit', { agentId: AGENT, sessionId: 's-1' }))
    expect(reply).toBeUndefined()
    expect(error).toMatchObject({
      code: 'RATE_LIMITED',
      retryable: false,
      details: { reason: SESSION_LIMIT_REACHED, limit: 0, used: 0 }
    })
  })

  it('admits exactly one of two daemons on two Control Plane replicas racing for the last slot', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedDaemon(prisma, OTHER_DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await seedAgent(prisma, OTHER_AGENT, { daemonId: OTHER_DAEMON })
    await enforce(1)
    const a = await ready(buildWsHarness(prisma), DAEMON, [SESSION_ADMIT_REFUSAL_FEATURE])
    const b = await ready(buildWsHarness(prisma), OTHER_DAEMON, [SESSION_ADMIT_REFUSAL_FEATURE])

    const idA = a.stub.inject('session/admit', { agentId: AGENT, sessionId: 's-a' })
    const idB = b.stub.inject('session/admit', { agentId: OTHER_AGENT, sessionId: 's-b' })
    const answers = await Promise.all([answerTo(a.stub, idA), answerTo(b.stub, idB)])
    expect(answers.filter((x) => x.reply?.admitted === true)).toHaveLength(1)
    expect(answers.filter((x) => x.reply?.admitted === false)).toHaveLength(1)
    expect(await used()).toBe(1)
    expect(await prisma.orgSessionAdmission.count()).toBe(1)
  })

  it('admits a never-admitted snapshot under the limit, and refuses one at it or drops the one-way frame', async () => {
    await seedPlaced()
    await enforce(1)
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h, DAEMON, [SESSION_ADMIT_REFUSAL_FEATURE])
    const snapshot = (sessionId: string) => ({
      sessionId,
      agentId: AGENT,
      phase: 'start',
      platform: 'slack',
      channel: 'C1',
      thread: sessionId,
      ts: new Date().toISOString()
    })

    const lateId = stub.inject('event/session-sync', snapshot('s-late'))
    await stub.settled()
    expect(stub.sent.find((f) => f.corr === lateId)).toMatchObject({ type: 'ack', payload: { ok: true } })
    expect(await prisma.sessionMeta.count({ where: { id: 's-late' } })).toBe(1)
    expect(await used()).toBe(1)

    const fullId = stub.inject('event/session-sync', snapshot('s-full'))
    await stub.settled()
    expect(stub.sent.find((f) => f.corr === fullId)).toMatchObject({
      type: 'error',
      payload: {
        code: 'RATE_LIMITED',
        retryable: false,
        details: { reason: SESSION_LIMIT_REACHED, limit: 1, used: 1, resetsAt: expect.any(String) }
      }
    })
    stub.inject('event/session', snapshot('s-legacy'))
    await stub.settled()
    expect(await prisma.sessionMeta.count()).toBe(1)
    expect(await used()).toBe(1)
  })
})
