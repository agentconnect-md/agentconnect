// `capability/request`, `capability/decide` and `session/capability-settled` over the real daemon WS edge and real Postgres.
import { describe, expect, it } from 'vitest'
import { CAPABILITY_REQUESTS_FEATURE, CAPABILITY_REQUESTS_V2_FEATURE, isFrame } from '@agentconnect.md/protocol'
import type { CapabilityFacts } from '../../src/capability/capability-wording.js'
import { prisma } from '../setup.db.js'
import { buildWsHarness, type WsHarness } from '../fakes/build-ws.js'
import { InMemoryDaemonStub } from '../fakes/daemon-stub.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { CapabilityRequestService } from '../../src/capability/capability-request.service.js'
import { ControlSender } from '../../src/orchestrator/outbound.js'
import { PgAgentRepo, PgCapabilityRequestRepo, PgLaunchRepo } from '../../src/persistence/index.js'
import { PgMcpProviderRepo } from '../../src/persistence/repositories/mcp.repo.js'
import { PgOrgRepo } from '../../src/persistence/repositories/org.repo.js'

const DAEMON = 'dddddddd-dddd-4ddd-8ddd-dddddddddd21'
const OTHER_DAEMON = 'dddddddd-dddd-4ddd-8ddd-dddddddddd22'
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa21'

function harness(facts: { current: CapabilityFacts } = { current: {} }) {
  const h = buildWsHarness(prisma)
  const sender = new ControlSender(h.deps.connReg, new PgLaunchRepo(prisma))
  const service = new CapabilityRequestService({
    clock: h.clock,
    requests: new PgCapabilityRequestRepo(prisma),
    agents: new PgAgentRepo(prisma),
    mcpProviders: new PgMcpProviderRepo(prisma),
    skillSources: { getByName: async () => null },
    orgs: new PgOrgRepo(prisma),
    webAppUrl: 'https://console.example.test',
    placement: h.placement,
    daemon: (daemonId) => h.deps.connReg.get(daemonId),
    sendSettled: (daemonId, orgId, wake) => sender.capabilitySettled(daemonId, orgId, wake),
    sendReopened: (daemonId, orgId, frame) => sender.capabilityReopened(daemonId, orgId, frame),
    sendForward: (daemonId, orgId, frame) => sender.capabilityForward(daemonId, orgId, frame),
    sendMcpRebound: (daemonId, orgId, frame) => sender.agentMcpRebound(daemonId, orgId, frame),
    facts: { load: async () => facts.current, unknownTarget: async () => undefined },
    log: { debug: () => {}, warn: () => {} }
  })
  h.deps.capabilityRequests = service
  return { h, service }
}

async function ready(h: WsHarness, daemonId: string, features: string[]) {
  const token = await h.mintToken(daemonId)
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

async function answerTo(stub: InMemoryDaemonStub, id: string, type: string) {
  await stub.settled()
  const reply = stub.sent.find((f) => f.corr === id && f.type === type)
  const error = stub.sent.find((f) => f.corr === id && f.type === 'error')
  return { reply: reply?.payload as Record<string, unknown> | undefined, error: error?.payload }
}

const request = {
  agentId: AGENT,
  sessionId: 's1',
  sessionKey: 'slack:C1:1.0',
  ask: { kind: 'agent-settings', want: { model: 'big' } },
  reason: 'the task needs a stronger model',
  askers: { people: [{ kind: 'member', platform: 'slack', integrationId: 'i-1', userId: 'U1' }], nobody: false },
  platform: 'slack'
}

describe('capability requests over the daemon WS edge', () => {
  it('opens a request, settles a chat decline by generation and wakes the origin', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const { h, service } = harness()
    const { stub, serverFeatures } = await ready(h, DAEMON, [CAPABILITY_REQUESTS_FEATURE])
    expect(serverFeatures).toContain(CAPABILITY_REQUESTS_FEATURE)

    const opened = await answerTo(stub, stub.inject('capability/request', request), 'capability/request/result')
    expect(opened.error).toBeUndefined()
    expect(opened.reply).toMatchObject({ status: 'pending', generation: 1, summary: 'set the model to "big"' })
    const requestId = opened.reply!.requestId as string

    const by = { kind: 'member', platform: 'slack', integrationId: 'i-1', userId: 'U2', name: 'Ben' }
    const stale = await answerTo(
      stub,
      stub.inject('capability/decide', { agentId: AGENT, requestId, generation: 2, decision: 'decline', by }),
      'capability/decide/result'
    )
    expect(stale.reply).toEqual({ result: 'already_settled' })
    const decided = await answerTo(
      stub,
      stub.inject('capability/decide', { agentId: AGENT, requestId, generation: 1, decision: 'decline', by }),
      'capability/decide/result'
    )
    expect(decided.reply).toEqual({ result: 'settled' })

    service.start()
    h.clock.advance(0)
    const wake = await stub.expectFrame('session/capability-settled')
    expect(wake.payload).toMatchObject({
      agentId: AGENT,
      sessionId: 's1',
      requestId,
      generation: 1,
      status: 'declined',
      by: { name: 'Ben' },
      askers: request.askers,
      reload: false
    })
    stub.reply(wake.id, 'session/capability-settled/result', { accepted: true })
    await service.settle()
    service.stop()
    expect(await prisma.capabilityRequestOrigin.findFirst({ where: { requestId } })).toMatchObject({
      wakeState: 'delivered'
    })
  })

  it('refuses a daemon that does not advertise capability requests, or does not serve the agent', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const { h } = harness()
    const plain = await ready(h, DAEMON, [])
    const unadvertised = await answerTo(
      plain.stub,
      plain.stub.inject('capability/request', request),
      'capability/request/result'
    )
    expect(unadvertised.error).toMatchObject({ code: 'SCOPE_DENIED', retryable: false })
    const other = await ready(h, OTHER_DAEMON, [CAPABILITY_REQUESTS_FEATURE])
    const foreign = await answerTo(
      other.stub,
      other.stub.inject('capability/request', request),
      'capability/request/result'
    )
    expect(foreign.error).toMatchObject({ code: 'SCOPE_DENIED' })
    expect(await prisma.capabilityRequest.count()).toBe(0)
  })

  it('refuses the Phase 2 kinds from a daemon without them, and rebinds a v2 daemon when the server connects', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON, runtimeOverrides: { mcpServers: ['Linear'] } })
    const facts = { current: {} as CapabilityFacts }
    const { h, service } = harness(facts)
    const oauth = { ...request, ask: { kind: 'connection', want: { type: 'mcp-oauth', server: 'Linear' } } }

    const v1 = await ready(h, DAEMON, [CAPABILITY_REQUESTS_FEATURE])
    expect(v1.serverFeatures).toContain(CAPABILITY_REQUESTS_V2_FEATURE)
    const refused = await answerTo(v1.stub, v1.stub.inject('capability/request', oauth), 'capability/request/result')
    expect(refused.reply).toMatchObject({ status: 'refused', refused: 'unsupported' })

    const v2 = await ready(h, DAEMON, [CAPABILITY_REQUESTS_FEATURE, CAPABILITY_REQUESTS_V2_FEATURE])
    const opened = await answerTo(v2.stub, v2.stub.inject('capability/request', oauth), 'capability/request/result')
    expect(opened.reply).toMatchObject({ status: 'pending', summary: 'connect the MCP server "Linear"' })

    facts.current = { mcpProvider: { providerId: null, connected: true, headerPresent: false } }
    const org = (await prisma.agent.findUniqueOrThrow({ where: { id: AGENT } })).orgId
    await service.orgChanged(org as never, { kind: 'mcp-oauth', server: 'Linear' }, null)
    const rebound = await v2.stub.expectFrame('agent/mcp-rebound')
    expect(rebound.payload).toEqual({ agentId: AGENT, server: 'Linear' })

    service.start()
    h.clock.advance(0)
    const wake = await v2.stub.expectFrame('session/capability-settled')
    expect(wake.payload).toMatchObject({ status: 'completed', reload: true })
    v2.stub.reply(wake.id, 'session/capability-settled/result', { accepted: true })
    await service.settle()
    service.stop()
  })
})
