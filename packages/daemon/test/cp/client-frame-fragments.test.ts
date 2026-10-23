// A CP frame past MAX_FRAME_BYTES arrives as `frame/fragment` envelopes (daemon-cp-ws-protocol.md §1.2).
import { describe, it, expect } from 'vitest'
import {
  buildEnvelope,
  encode,
  fragmentFrame,
  FRAME_FRAGMENTS_FEATURE,
  MAX_FRAME_BYTES,
  type RegisterReq
} from '@agentconnect.md/protocol'
import { CpClient, type CpClientDeps } from '../../src/cp/client.js'
import { FakeTransport } from './fake-transport.js'
import { FakeClock } from './fake-clock.js'

const DAEMON_ID = '22222222-2222-4222-8222-222222222222'
const AGENT_ID = '33333333-3333-4333-8333-333333333333'
const silent = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }
const tick = () => new Promise((r) => setImmediate(r))

function makeDeps(transport: FakeTransport, applied: unknown[], warnings: string[]): CpClientDeps {
  return {
    url: 'wss://cp.example/daemon/ws',
    token: 'tok_abc',
    daemonId: DAEMON_ID,
    agentVersion: '0.0.0',
    host: 'host-1',
    heartbeatDefaultMs: 15000,
    maxAgents: 4,
    capabilities: () => ({ platforms: ['slack'], runtimes: ['claude'], acp: true, features: ['worktree-iso'] }),
    runtimeProfiles: () => [],
    localState: () => ({ assignments: [], crons: [], leases: [], agents: [], integrations: [], stagedAgents: [] }),
    loadSnapshot: () => ({ cpu: 0, mem: 0, agents: 0 }),
    activeSessions: () => 0,
    configApply: {
      applyConfigPush() {},
      applyReconcileSnapshot(snap: unknown) {
        applied.push(snap)
      },
      upsertCron() {},
      removeCron() {},
      applyRouteAssign() {},
      applyRouteUpdate() {}
    },
    clock: new FakeClock(),
    connect: async () => transport,
    log: { ...silent, warn: (m: string) => void warnings.push(m) },
    jitter: () => 0
  } as unknown as CpClientDeps
}

/** A register/ok whose collaboration snapshot alone is past the frame cap. */
function bigRegisterOk(corr: string): string {
  const channels = Array.from({ length: 2500 }, (_, i) => ({
    orgId: 'org_default',
    platform: 'slack' as const,
    channelId: `C${String(i).padStart(10, '0')}`,
    agents: [{ agentId: AGENT_ID, daemonId: DAEMON_ID, name: 'räksmörgås-agent' }]
  }))
  return encode(
    buildEnvelope(
      'register/ok',
      {
        routingEpoch: 3,
        assignments: [],
        crons: [],
        leases: [],
        drop: { assignments: [], crons: [] },
        collabRoutes: { generation: 3, channels, agents: [], platformKinds: [] }
      },
      { corr }
    )
  )
}

async function authenticate(t: FakeTransport, client: CpClient): Promise<RegisterReq & { id: string }> {
  client.start()
  await tick()
  const auth = t.lastSent()
  t.pushInbound(
    JSON.stringify(
      buildEnvelope(
        'auth/ok',
        { daemonId: DAEMON_ID, sessionEpoch: 7, heartbeatSec: 20, serverTime: '2026-06-26T00:00:00.000Z' },
        { corr: auth.id }
      )
    )
  )
  await tick()
  const reg = t.lastSent()
  return { ...reg.payload, id: reg.id }
}

describe('CpClient — frame fragments', () => {
  it('advertises frame-fragments-v1 alongside the daemon features', async () => {
    const t = new FakeTransport()
    const client = new CpClient(makeDeps(t, [], []))
    const reg = await authenticate(t, client)
    expect(reg.capabilities.features).toEqual(['worktree-iso', FRAME_FRAGMENTS_FEATURE])
    client.stop()
  })

  it('reassembles a fragmented register/ok and completes the handshake', async () => {
    const t = new FakeTransport()
    const applied: any[] = []
    const client = new CpClient(makeDeps(t, applied, []))
    const reg = await authenticate(t, client)
    const text = bigRegisterOk(reg.id)
    expect(Buffer.byteLength(text)).toBeGreaterThan(MAX_FRAME_BYTES)
    const parts = fragmentFrame(text, 'frame/fragment')!
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) {
      expect(Buffer.byteLength(part)).toBeLessThanOrEqual(MAX_FRAME_BYTES)
      t.pushInbound(part)
    }
    await tick()
    await tick()
    expect(client.state).toBe('READY')
    expect(applied).toHaveLength(1)
    expect(applied[0].collabRoutes.channels).toHaveLength(2500)
    expect(applied[0].collabRoutes.channels[0].agents[0].name).toBe('räksmörgås-agent')
    client.stop()
  })

  it('drops a fragment stream that arrives out of sequence', async () => {
    const t = new FakeTransport()
    const applied: unknown[] = []
    const warnings: string[] = []
    const client = new CpClient(makeDeps(t, applied, warnings))
    const reg = await authenticate(t, client)
    const parts = fragmentFrame(bigRegisterOk(reg.id), 'frame/fragment')!
    t.pushInbound(parts[0]!)
    t.pushInbound(parts[2] ?? parts[1]!)
    for (const part of parts.slice(3)) t.pushInbound(part)
    await tick()
    expect(client.state).not.toBe('READY')
    expect(applied).toHaveLength(0)
    expect(warnings.some((w) => w.includes('out of sequence'))).toBe(true)
    client.stop()
  })
})
