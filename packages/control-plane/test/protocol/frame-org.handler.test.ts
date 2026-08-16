// The frame-scoped organization contract over the real WS edge (k8s-daemon-pool.md M4): on an
// install-wide (frame-mode) member every org-scoped frame names its org and the CP checks that
// org against the resource the frame targets; install-wide frames name none; a correlated reply
// carries the org of the request it answers. An org-scoped (API-key) connection keeps its
// connection-bound behavior throughout.
import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { isFrame, type FrameType } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildWsHarness } from '../fakes/build-ws.js'
import type { InMemoryDaemonStub } from '../fakes/daemon-stub.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { AgentId, HookId, OrgId } from '../../src/domain/ids.js'
import { PgHookRepo } from '../../src/persistence/repositories/hook.repo.js'

const DAEMON = 'd1111111-1111-4111-8111-111111111111'
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const FOREIGN_ORG = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const FOREIGN_AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const AUTH_ID = '99999999-9999-4999-8999-999999999999'
const REG_ID = '88888888-8888-4888-8888-888888888888'

/** One agent of the default org pinned to the daemon under test, plus a second org with its own agent. */
async function seedTwoOrgs(): Promise<void> {
  await prisma.org.create({ data: { id: FOREIGN_ORG, slug: 'foreign-org' } })
  await prisma.agent.create({
    data: { id: FOREIGN_AGENT, orgId: FOREIGN_ORG, name: 'foreign', runtime: 'claude', status: 'active' }
  })
}

async function ready(h: ReturnType<typeof buildWsHarness>, mode: 'frame' | 'connection'): Promise<InMemoryDaemonStub> {
  const { stub } = h.connect()
  if (mode === 'frame') {
    const saToken = await h.mintPoolMember(DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    stub.inject('auth', { serviceAccountToken: saToken, daemonId: DAEMON, agentVersion: '1.4.0' }, { id: AUTH_ID })
  } else {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const token = await h.mintToken(DAEMON)
    stub.inject('auth', { apiKey: token, daemonId: DAEMON, agentVersion: '1.4.0' }, { id: AUTH_ID })
  }
  await stub.expectFrame('auth/ok')
  stub.inject(
    'register',
    {
      host: 'member-1',
      capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true, features: [] },
      maxAgents: 8,
      localState: { assignments: [], crons: [], leases: [], agents: [], integrations: [], stagedAgents: [] }
    },
    { id: REG_ID }
  )
  await stub.expectFrame('register/ok')
  return stub
}

/** The org-scoped D→C families, each with the smallest valid payload naming the pinned agent. */
const ORG_SCOPED: Array<{ type: FrameType; payload: unknown }> = [
  { type: 'usage/report', payload: usageReport() },
  { type: 'event/session-activity', payload: { sessionId: 's1', agentId: AGENT, revision: '1', ts: now() } },
  { type: 'event/session-purged', payload: { agentId: AGENT, sessionIds: ['s1'], reason: 'retention', ts: now() } },
  { type: 'cron/report', payload: { cronId: randomUUID(), agentId: AGENT, firedAt: now() } },
  { type: 'channel/agents', payload: { platform: 'slack', requesterAgentId: AGENT } },
  { type: 'gitcred/request', payload: { agentId: AGENT } },
  { type: 'duty/fetch', payload: { agentId: AGENT } },
  { type: 'knowledge/search', payload: { requesterAgentId: AGENT, query: 'q' } },
  { type: 'session/child-status', payload: { parentSessionId: 'p', childSessionId: 'c', childAgentId: AGENT } },
  { type: 'hook/report', payload: { hookId: randomUUID(), agentId: AGENT, deliveryKey: 'd', status: 'success' } }
]

function now(): string {
  return new Date().toISOString()
}

function usageReport() {
  return {
    sessionId: 's1',
    agentId: AGENT,
    lastActivityAt: now(),
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
  }
}

function heartbeat() {
  return { load: { cpu: 0, mem: 0, agents: 0 }, health: 'ok', activeSessions: 0 }
}

async function errorFor(stub: InMemoryDaemonStub, id: string) {
  await stub.settled()
  const err = stub.sent.find((f) => f.type === 'error' && f.corr === id)
  return err && isFrame('error')(err) ? err.payload : undefined
}

describe('frame-scoped organization on the daemon WS edge', () => {
  it('frame mode: every org-scoped family is refused without an org, and with the wrong one', async () => {
    await seedTwoOrgs()
    const h = buildWsHarness(prisma)
    const stub = await ready(h, 'frame')
    for (const { type, payload } of ORG_SCOPED) {
      const unscoped = stub.inject(type, payload)
      expect({ type, error: await errorFor(stub, unscoped) }).toMatchObject({
        type,
        error: { code: 'SCOPE_DENIED', message: 'organization is required on an install-wide connection' }
      })
      // The pinned agent belongs to the default org; naming the foreign org for it is refused before dispatch.
      const wrong = stub.inject(type, payload, { orgId: FOREIGN_ORG })
      expect({ type, error: await errorFor(stub, wrong) }).toMatchObject({
        type,
        error: { code: 'SCOPE_DENIED', message: 'organization does not match the targeted resource' }
      })
    }
  })

  it('frame mode: the right org reaches the handler', async () => {
    await seedTwoOrgs()
    const h = buildWsHarness(prisma)
    const stub = await ready(h, 'frame')
    const id = stub.inject('channel/agents', { platform: 'slack', requesterAgentId: AGENT }, { orgId: DEFAULT_ORG_ID })
    const ok = await stub.expectFrame('channel/agents/ok')
    expect(ok.corr).toBe(id)
    // The reply carries the org of the request it answers.
    expect(ok.orgId).toBe(DEFAULT_ORG_ID)
    if (!isFrame('channel/agents/ok')(ok)) throw new Error('expected channel/agents/ok')
    expect(ok.payload.agents.map((a) => a.agentId)).toContain(AGENT)
    expect(await errorFor(stub, id)).toBeUndefined()
  })

  it('frame mode: install-wide frames are refused when they carry an org', async () => {
    const h = buildWsHarness(prisma)
    const stub = await ready(h, 'frame')
    for (const { type, payload } of [
      { type: 'heartbeat' as const, payload: heartbeat() },
      { type: 'duty/release' as const, payload: { groupIds: [randomUUID()] } },
      { type: 'agent/exists' as const, payload: { agentIds: [AGENT] } },
      { type: 'capabilities/update' as const, payload: { capabilities: { platforms: [], runtimes: [], acp: true } } }
    ]) {
      const id = stub.inject(type, payload, { orgId: DEFAULT_ORG_ID })
      expect({ type, error: await errorFor(stub, id) }).toMatchObject({ type, error: { code: 'SCOPE_DENIED' } })
    }
    // Bare, they are taken.
    const beat = stub.inject('heartbeat', heartbeat())
    expect(await errorFor(stub, beat)).toBeUndefined()
  })

  it('frame mode: a hook is checked against the org the frame names through the scoped read', async () => {
    await seedTwoOrgs()
    const h = buildWsHarness(prisma)
    const stub = await ready(h, 'frame')
    const hookId = randomUUID()
    await new PgHookRepo(prisma).upsert({
      hookId: HookId(hookId),
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId: AgentId(AGENT),
      kind: 'webhook',
      name: 'default-org-hook',
      sessionMode: 'perThread',
      targetPlatform: 'slack'
    })
    // The registry does not know the foreign agent, so only the handler's scoped read can refuse this.
    const crossOrg = stub.inject(
      'hook/report',
      { hookId, agentId: FOREIGN_AGENT, deliveryKey: 'd', status: 'success' },
      { orgId: FOREIGN_ORG }
    )
    expect(await errorFor(stub, crossOrg)).toMatchObject({
      code: 'SCOPE_DENIED',
      message: 'hook is not in the organization this frame acts in'
    })
    // In its own org the same report goes through: the pinned agent's daemon may close the run.
    const own = stub.inject(
      'hook/report',
      { hookId, agentId: AGENT, deliveryKey: 'd', status: 'success' },
      { orgId: DEFAULT_ORG_ID }
    )
    await stub.settled()
    expect(stub.sent.find((f) => f.type === 'ack' && f.corr === own)?.orgId).toBe(DEFAULT_ORG_ID)
  })

  it('frame mode: a reply that does not carry the request org fails the request and is never applied', async () => {
    const h = buildWsHarness(prisma)
    const stub = await ready(h, 'frame')
    const conn = h.deps.connReg.get(DAEMON)!.conn
    const pending = conn.request('session/list', { agentId: AGENT })
    const req = await stub.expectFrame('session/list')
    expect(req.orgId).toBe(DEFAULT_ORG_ID)
    stub.inject('session/list/page', { sessions: [] }, { corr: req.id })
    await expect(pending).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
    const again = conn.request('session/list', { agentId: AGENT })
    const req2 = stub.sent.filter((f) => f.type === 'session/list').at(-1)!
    stub.inject('session/list/page', { sessions: [] }, { corr: req2.id, orgId: DEFAULT_ORG_ID })
    await expect(again).resolves.toEqual({ sessions: [] })
  })

  it('connection mode (API key): unscoped frames stay accepted, the connection org is accepted, another is refused', async () => {
    await seedTwoOrgs()
    const h = buildWsHarness(prisma)
    const stub = await ready(h, 'connection')
    const bare = stub.inject('channel/agents', { platform: 'slack', requesterAgentId: AGENT })
    expect((await stub.expectFrame('channel/agents/ok')).corr).toBe(bare)
    const own = stub.inject('usage/report', usageReport(), { orgId: DEFAULT_ORG_ID })
    expect(await errorFor(stub, own)).toBeUndefined()
    const beat = stub.inject('heartbeat', heartbeat(), { orgId: DEFAULT_ORG_ID })
    expect(await errorFor(stub, beat)).toBeUndefined()
    const foreign = stub.inject('usage/report', usageReport(), { orgId: FOREIGN_ORG })
    expect(await errorFor(stub, foreign)).toMatchObject({ code: 'SCOPE_DENIED' })
    // Downlink frames carry the connection org, and a reply that omits it still settles.
    const conn = h.deps.connReg.get(DAEMON)!.conn
    const pending = conn.request('session/list', { agentId: AGENT })
    const req = await stub.expectFrame('session/list')
    expect(req.orgId).toBe(DEFAULT_ORG_ID)
    stub.inject('session/list/page', { sessions: [] }, { corr: req.id })
    await expect(pending).resolves.toEqual({ sessions: [] })
  })
})
