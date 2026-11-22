// `session/admit` over the real daemon WS edge and real Postgres (org-session-policy.md, Admission).
import { describe, it, expect } from 'vitest'
import { isFrame, SESSION_ADMIT_FEATURE } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildWsHarness, type WsHarness } from '../fakes/build-ws.js'
import { InMemoryDaemonStub } from '../fakes/daemon-stub.js'
import { DEF_ORG, seedAgent, seedDaemon } from '../fixtures/seed.js'
import { AgentMutationGate } from '../../src/orchestrator/agentMutationGate.js'

const DAEMON = 'dddddddd-dddd-4ddd-8ddd-dddddddddd01'
const OTHER_DAEMON = 'dddddddd-dddd-4ddd-8ddd-dddddddddd02'
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01'
const OTHER_AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02'
const UNKNOWN_AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03'
const FOREIGN_ORG = 'example-foreign-org'
const FOREIGN_AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa04'

async function ready(h: WsHarness, daemonId: string) {
  const token = await h.mintToken(daemonId, { approved: true })
  const stub = new InMemoryDaemonStub()
  h.connect(stub)
  stub.inject('auth', { apiKey: token, daemonId, agentVersion: '1.4.0' })
  await stub.expectFrame('auth/ok')
  stub.inject('register', {
    host: 'daemon-1',
    capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true, features: [] },
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
    expect(first).toEqual({ reply: { admitted: true, counted: true }, error: undefined })
    const again = await answerTo(stub, stub.inject('session/admit', { agentId: AGENT, sessionId: 's-1' }))
    expect(again).toEqual({ reply: { admitted: true, counted: true }, error: undefined })
    expect(await used()).toBe(1)
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
    expect(after.reply).toEqual({ admitted: true, counted: true })
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
