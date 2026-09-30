// A CP handoff closes the control socket for seconds: turn-path requests wait it out, and only idempotent reads are re-sent.
import { describe, it, expect, vi } from 'vitest'
import { buildEnvelope, AGENT_MEMORY_STORE_V1_FEATURE } from '@agentconnect.md/protocol'
import { CpClient, type CpClientDeps } from '../../src/cp/client.js'
import { FakeTransport } from './fake-transport.js'
import { FakeClock } from './fake-clock.js'

const DAEMON_ID = '22222222-2222-4222-8222-222222222222'
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const silent = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }
const tick = () => new Promise((r) => setImmediate(r))
const GRANT = {
  username: 'x-access-token',
  token: 'ghs_example',
  ttlSec: 3000,
  expiresAt: '2026-10-01T00:00:00.000Z',
  repoFullName: 'example-org/example-repo',
  access: 'read'
}

function harness() {
  const clock = new FakeClock()
  const transports: FakeTransport[] = []
  const connect = vi.fn(async () => {
    const transport = new FakeTransport()
    transports.push(transport)
    return transport
  })
  const deps = {
    url: 'wss://cp.example.test/daemon/ws',
    token: 't',
    daemonId: DAEMON_ID,
    agentVersion: '0.0.0',
    host: 'h',
    heartbeatDefaultMs: 15000,
    maxAgents: 4,
    capabilities: () => ({ platforms: ['slack'], runtimes: [], acp: true, features: [] }),
    runtimeProfiles: () => [],
    localState: () => ({ assignments: [], crons: [], leases: [], agents: [], integrations: [], stagedAgents: [] }),
    loadSnapshot: () => ({ cpu: 0, mem: 0, agents: 0 }),
    activeSessions: () => 0,
    configApply: {
      applyConfigPush() {},
      applyReconcileSnapshot() {},
      upsertCron() {},
      removeCron() {},
      applyRouteAssign() {},
      applyRouteUpdate() {}
    },
    clock,
    connect,
    log: silent,
    jitter: () => 0
  } as unknown as CpClientDeps
  return { clock, transports, connect, client: new CpClient(deps) }
}

async function handshake(t: FakeTransport, epoch: number): Promise<void> {
  const auth = t.lastSent()
  t.pushInbound(
    JSON.stringify(
      buildEnvelope(
        'auth/ok',
        { daemonId: DAEMON_ID, sessionEpoch: epoch, heartbeatSec: 15, serverTime: '2026-09-30T00:00:00.000Z' },
        { corr: auth.id }
      )
    )
  )
  await tick()
  const register = t.lastSent()
  t.pushInbound(
    JSON.stringify(
      buildEnvelope(
        'register/ok',
        {
          routingEpoch: epoch,
          assignments: [],
          crons: [],
          leases: [],
          drop: { assignments: [], crons: [] },
          serverFeatures: [AGENT_MEMORY_STORE_V1_FEATURE]
        },
        { corr: register.id }
      )
    )
  )
  await tick()
}

function sentOf(t: FakeTransport, type: string): Array<{ id: string; type: string }> {
  return t.sent.map((text) => JSON.parse(text)).filter((frame) => frame.type === type)
}

async function readyHarness() {
  const h = harness()
  h.client.start()
  await tick()
  await handshake(h.transports[0]!, 1)
  expect(h.client.state).toBe('READY')
  return h
}

describe('CpClient turn-path requests across a CP handoff', () => {
  it('waits out a dropped link before sending a git credential request, then sends it on the new link', async () => {
    const { clock, transports, client } = await readyHarness()
    transports[0]!.simulateClose(1012, 'restarting')
    const pending = client.requestGitCred({ agentId: AGENT, reason: 'push' })
    await tick()
    clock.advance(1000)
    await tick()
    await handshake(transports[1]!, 2)
    const [request] = sentOf(transports[1]!, 'gitcred/request')
    expect(request).toBeDefined()
    expect(sentOf(transports[0]!, 'gitcred/request')).toHaveLength(0)
    transports[1]!.pushInbound(JSON.stringify(buildEnvelope('gitcred/grant', GRANT, { corr: request!.id })))
    await expect(pending).resolves.toMatchObject({ token: 'ghs_example' })
  })

  it('fails as unreachable when the link does not return within the handoff wait', async () => {
    const { clock, transports, client } = await readyHarness()
    transports[0]!.simulateClose(1012, 'restarting')
    let settled = false
    const outcome = client
      .requestGitCred({ agentId: AGENT, reason: 'push' })
      .catch((err: unknown) => err)
      .finally(() => (settled = true))
    for (let elapsed = 0; elapsed < 9_000; elapsed += 1000) {
      clock.advance(1000)
      await tick()
    }
    expect(settled).toBe(false)
    clock.advance(2000)
    await tick()
    await expect(outcome).resolves.toMatchObject({ message: expect.stringMatching(/control plane unreachable/) })
  })

  it('re-sends an idempotent read once when its link closes mid-flight, only over the replaced link', async () => {
    const { clock, transports, client } = await readyHarness()
    const pending = client.requestGitCred({ agentId: AGENT, reason: 'fetch' })
    await tick()
    expect(sentOf(transports[0]!, 'gitcred/request')).toHaveLength(1)
    transports[0]!.simulateClose(1012, 'restarting')
    await tick()
    clock.advance(1000)
    await tick()
    await handshake(transports[1]!, 2)
    const [retry] = sentOf(transports[1]!, 'gitcred/request')
    expect(retry).toBeDefined()
    transports[1]!.pushInbound(JSON.stringify(buildEnvelope('gitcred/grant', GRANT, { corr: retry!.id })))
    await expect(pending).resolves.toMatchObject({ token: 'ghs_example' })
  })

  it('never re-sends a memory/store that was in flight when the link closed', async () => {
    const { clock, transports, client } = await readyHarness()
    const outcome = client
      .memoryStore({
        agentId: AGENT,
        op: { op: 'memory-append', root: '.', rel: 'notes.md.tmp', content: 'x', create: true }
      })
      .catch((err: unknown) => err)
    await tick()
    expect(sentOf(transports[0]!, 'memory/store')).toHaveLength(1)
    transports[0]!.simulateClose(1012, 'restarting')
    await expect(outcome).resolves.toMatchObject({ message: 'connection closed' })
    clock.advance(1000)
    await tick()
    await handshake(transports[1]!, 2)
    expect(sentOf(transports[1]!, 'memory/store')).toHaveLength(0)
  })

  it('fails fast when the link never came up, so a startup without a CP stays local-first', async () => {
    const { client } = harness()
    client.start()
    await tick()
    let settled = false
    const outcome = client
      .requestGitCred({ agentId: AGENT, reason: 'clone' })
      .catch((err: unknown) => err)
      .finally(() => (settled = true))
    await tick()
    expect(settled).toBe(true)
    await expect(outcome).resolves.toMatchObject({ message: expect.stringMatching(/control plane unreachable/) })
  })

  it('fails fast once an outage outlasts the handoff window', async () => {
    const { clock, transports, client } = await readyHarness()
    transports[0]!.simulateClose(1012, 'restarting')
    for (let elapsed = 0; elapsed < 31_000; elapsed += 1000) {
      clock.advance(1000)
      await tick()
    }
    let settled = false
    const outcome = client
      .requestGitCred({ agentId: AGENT, reason: 'push' })
      .catch((err: unknown) => err)
      .finally(() => (settled = true))
    await tick()
    expect(settled).toBe(true)
    await expect(outcome).resolves.toMatchObject({ message: expect.stringMatching(/control plane unreachable/) })
  })

  it('releases a waiting request as soon as the client stops', async () => {
    const { transports, client } = await readyHarness()
    transports[0]!.simulateClose(1012, 'restarting')
    let settled = false
    const outcome = client
      .requestGitCred({ agentId: AGENT, reason: 'push' })
      .catch((err: unknown) => err)
      .finally(() => (settled = true))
    await tick()
    expect(settled).toBe(false)
    await client.stop()
    await expect(outcome).resolves.toMatchObject({ message: expect.stringMatching(/control plane unreachable/) })
  })
})

describe('CpClient redial after a planned CP restart', () => {
  it('redials fast with a capped handshake and does not escalate while the handoff window lasts', async () => {
    const { clock, transports, connect } = await readyHarness()
    expect(connect.mock.calls[0]).toEqual([undefined])
    transports[0]!.simulateClose(1012, 'restarting')
    expect(clock.pending()).toContain(250)
    clock.advance(250)
    await tick()
    expect(connect).toHaveBeenCalledTimes(2)
    expect(connect.mock.calls[1]).toEqual([{ handshakeTimeoutMs: 1000 }])
    transports[1]!.simulateClose(1006, 'refused')
    await tick()
    expect(clock.pending()).toContain(250)
    expect(clock.pending()).not.toContain(2000)
  })

  it('keeps ordinary backoff for a drop that is not a planned restart', async () => {
    const { clock, transports } = await readyHarness()
    transports[0]!.simulateClose(1006, 'gone')
    expect(clock.pending()).toContain(1000)
    expect(clock.pending()).not.toContain(250)
  })

  it('resumes ordinary backoff once the handoff window has passed', async () => {
    const { clock, transports, connect } = await readyHarness()
    transports[0]!.simulateClose(1012, 'restarting')
    while (clock.now() < 10_000) {
      clock.advance(250)
      await tick()
      transports.at(-1)!.simulateClose(1006, 'refused')
      await tick()
    }
    const dials = connect.mock.calls.length
    expect(clock.pending()).toContain(1000)
    clock.advance(1000)
    await tick()
    expect(connect).toHaveBeenCalledTimes(dials + 1)
    expect(connect.mock.calls.at(-1)).toEqual([undefined])
  })
})
