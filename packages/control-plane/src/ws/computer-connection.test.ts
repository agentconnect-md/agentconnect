import { describe, expect, it, vi } from 'vitest'
import { buildComputerCpFrame, ComputerPolicySchema, type ComputerCpFrame } from '@agentconnect.md/protocol'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import { ComputerId, OrgId } from '../domain/ids.js'
import { ComputerChannelKeys } from '../registry/computerChannelKeys.js'
import type { ComputerPrincipal } from '../registry/computerService.js'
import type { ComputerLiveReport, ComputerRecord } from '../persistence/ports.js'
import { ComputerConnection, type ComputerConnDeps, type ComputerTransport } from './computer-connection.js'
import { ComputerChannelRegistry } from './computer-registry.js'
import { HandshakeGate } from './handshake-gate.js'

const CID = ComputerId('cccccccc-cccc-4ccc-8ccc-cccccccccccc')
const T0 = 1_760_000_100_000
const principal: ComputerPrincipal = { computerId: CID, orgId: OrgId('org_1'), apiKeyId: 'key_1' }

class FakeTransport implements ComputerTransport {
  sent: ComputerCpFrame[] = []
  closed: { code: number; reason: string } | undefined
  private onMsg: (text: string) => void = () => {}
  private onCls: (code: number, reason: string) => void = () => {}
  send(text: string): void {
    this.sent.push(JSON.parse(text) as ComputerCpFrame)
  }
  onMessage(cb: (text: string) => void): void {
    this.onMsg = cb
  }
  onClose(cb: (code: number, reason: string) => void): void {
    this.onCls = cb
  }
  close(code: number, reason: string): void {
    if (this.closed) return
    this.closed = { code, reason }
    this.onCls(code, reason)
  }
  deliver(frame: ComputerCpFrame): void {
    this.onMsg(JSON.stringify(frame))
  }
  ofType(type: string): ComputerCpFrame[] {
    return this.sent.filter((f) => f.type === type)
  }
}

function setup(
  over: {
    authenticate?: ComputerPrincipal | null
    authenticateImpl?: () => Promise<ComputerPrincipal | null>
    live?: () => boolean
    handshakes?: HandshakeGate
    leases?: ComputerConnDeps['leases']
    relays?: ComputerConnDeps['relays']
  } = {}
) {
  const clock = new FakeClock(T0)
  const transport = new FakeTransport()
  const registry = new ComputerChannelRegistry()
  const reports: ComputerLiveReport[] = []
  const repo = {
    get: vi.fn(
      async () =>
        ({ name: 'desk', ownerUserId: 'u1', policy: ComputerPolicySchema.parse({}) }) as unknown as ComputerRecord
    ),
    recordLive: vi.fn(async (_o: unknown, _c: unknown, _k: unknown, report: ComputerLiveReport) => {
      reports.push(report)
      return over.live ? over.live() : true
    }),
    markOffline: vi.fn(async () => {})
  }
  const deps: ComputerConnDeps = {
    computers: {
      authenticate: vi.fn(
        over.authenticateImpl ?? (async () => (over.authenticate === undefined ? principal : over.authenticate))
      )
    },
    repo,
    keys: new ComputerChannelKeys('unit-test-pepper-0123456789abcdefghij', 300),
    registry,
    clock,
    heartbeatSec: 15,
    ...(over.handshakes ? { handshakes: over.handshakes } : {}),
    ...(over.leases ? { leases: over.leases } : {}),
    ...(over.relays ? { relays: over.relays } : {})
  }
  const conn = new ComputerConnection(transport, deps)
  conn.start()
  return { clock, transport, registry, repo, reports, conn }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))
const auth = () => buildComputerCpFrame('computer/auth', { apiKey: 'secret', desktopDaemonVersion: '0.2.0' })
const beat = (extra: Record<string, unknown> = {}) =>
  buildComputerCpFrame('computer/heartbeat', { status: 'online', ...extra })

describe('ComputerConnection', () => {
  it('authenticates, records the Computer online and answers with policy and a channel credential', async () => {
    const { transport, registry, reports, conn } = setup()
    const req = auth()
    transport.deliver(req)
    await settle()
    const [ok] = transport.ofType('computer/auth/ok')
    expect(ok).toMatchObject({
      corr: req.id,
      payload: { computerId: CID, orgId: 'org_1', name: 'desk', heartbeatSec: 15 }
    })
    const okFrame = ok!
    expect(okFrame.type === 'computer/auth/ok' && Date.parse(okFrame.payload.credential.expiresAt)).toBeGreaterThan(T0)
    expect(reports[0]).toEqual({ status: 'online', desktopDaemonVersion: '0.2.0' })
    expect(registry.get(CID)).toBe(conn)
  })

  it('tells the desktop the relay roster after auth and again when it changes', async () => {
    const relay = { relayId: '11111111-1111-4111-8111-111111111111', url: 'wss://relay-0.example.com/rd/ws' }
    const { transport, registry } = setup({ relays: async () => [relay] })
    transport.deliver(auth())
    await settle()
    expect(transport.ofType('computer/relays').map((f) => f.payload)).toEqual([{ relays: [relay] }])
    registry.pushRelays([])
    expect(transport.ofType('computer/relays').at(-1)?.payload).toEqual({ relays: [] })
  })

  it('refuses a bad key with AUTH_FAILED and close 4401', async () => {
    const { transport, registry } = setup({ authenticate: null })
    transport.deliver(auth())
    await settle()
    expect(transport.ofType('error')[0]).toMatchObject({ payload: { code: 'AUTH_FAILED' } })
    expect(transport.closed?.code).toBe(4401)
    expect(registry.size).toBe(0)
  })

  it('refuses any frame before auth and closes a socket that never authenticates', async () => {
    const first = setup()
    first.transport.deliver(beat())
    await settle()
    expect(first.transport.ofType('error')[0]).toMatchObject({ payload: { code: 'PROTOCOL_STATE' } })
    expect(first.transport.closed?.code).toBe(4400)

    const idle = setup()
    idle.clock.advance(10_000)
    expect(idle.transport.closed?.code).toBe(1008)
  })

  it('never answers an unreadable first frame with 4401', async () => {
    const { transport } = setup()
    const extra = auth() as unknown as { payload: Record<string, unknown> }
    extra.payload.machineId = 'from-a-newer-desktop'
    transport.deliver(extra as unknown as ComputerCpFrame)
    await settle()
    expect(transport.ofType('error')[0]).toMatchObject({ payload: { code: 'BAD_PAYLOAD' } })
    expect(transport.closed?.code).toBe(4400)
  })

  it('lets an auth still in flight finish past the auth timeout instead of closing it as refused', async () => {
    let resolve: (p: ComputerPrincipal) => void = () => {}
    const pending = new Promise<ComputerPrincipal>((r) => (resolve = r))
    const { transport, clock, registry, conn } = setup({ authenticateImpl: () => pending })
    transport.deliver(auth())
    await settle()
    clock.advance(30_000)
    expect(transport.closed).toBeUndefined()
    resolve(principal)
    await settle()
    expect(transport.ofType('computer/auth/ok')).toHaveLength(1)
    expect(registry.get(CID)).toBe(conn)
  })

  it('refuses auth with a retryable RATE_LIMITED, not 4401, while the handshake gate is full', async () => {
    const gate = new HandshakeGate(1)
    const held = gate.tryAcquire()
    const { transport, repo } = setup({ handshakes: gate })
    transport.deliver(auth())
    await settle()
    expect(transport.ofType('error')[0]).toMatchObject({ payload: { code: 'RATE_LIMITED', retryable: true } })
    expect(transport.closed?.code).toBe(4429)
    expect(repo.get).not.toHaveBeenCalled()
    held?.()

    const next = setup({ handshakes: gate })
    next.transport.deliver(auth())
    await settle()
    expect(next.transport.ofType('computer/auth/ok')).toHaveLength(1)
    expect(gate.size).toBe(0)
  })

  it('stores heartbeat reports and renews the credential once its window rolls over', async () => {
    const { transport, reports, clock } = setup()
    transport.deliver(auth())
    await settle()
    const doctor = { checkedAt: new Date(T0).toISOString(), checks: [{ name: 'session', status: 'ok', detail: 'X11' }] }
    transport.deliver(beat({ capabilities: { screenshot: true }, doctor, session: 'x11' }))
    await settle()
    expect(reports[1]).toMatchObject({ status: 'online', session: 'x11', doctor, capabilities: { screenshot: true } })
    expect(transport.ofType('computer/credential')).toHaveLength(0)

    clock.advance(150_000)
    transport.deliver(beat({ status: 'busy' }))
    await settle()
    const renewals = transport.ofType('computer/credential')
    expect(renewals).toHaveLength(1)
    const first = transport.ofType('computer/auth/ok')[0]!
    const renewal = renewals[0]!
    expect(renewal.type === 'computer/credential' && renewal.payload.credential.keyId).not.toBe(
      first.type === 'computer/auth/ok' && first.payload.credential.keyId
    )
  })

  it('ends the channel when a heartbeat finds the Computer revoked behind its back', async () => {
    let live = true
    const { transport, registry } = setup({ live: () => live })
    transport.deliver(auth())
    await settle()
    live = false
    transport.deliver(beat())
    await settle()
    expect(transport.ofType('computer/revoke')[0]).toMatchObject({ payload: { reason: 'revoked' } })
    expect(transport.closed?.code).toBe(4401)
    expect(registry.size).toBe(0)
  })

  it('pushes revoke and policy through the registry, and a superseded socket leaves its successor online', async () => {
    const a = setup()
    a.transport.deliver(auth())
    await settle()
    a.registry.pushPolicy(CID, ComputerPolicySchema.parse({ agentMode: 'view' }))
    expect(a.transport.ofType('computer/policy')[0]).toMatchObject({ payload: { policy: { agentMode: 'view' } } })

    const b = new ComputerConnection(new FakeTransport(), {
      computers: { authenticate: async () => principal },
      repo: a.repo,
      keys: new ComputerChannelKeys('unit-test-pepper-0123456789abcdefghij', 300),
      registry: a.registry,
      clock: a.clock,
      heartbeatSec: 15
    })
    const bTransport = (b as unknown as { transport: FakeTransport }).transport
    b.start()
    bTransport.deliver(auth())
    await settle()
    expect(a.transport.closed?.code).toBe(1012)
    expect(a.registry.get(CID)).toBe(b)
    await settle()
    expect(a.repo.markOffline).not.toHaveBeenCalled()

    a.registry.revoke(CID, 'deleted')
    expect(bTransport.ofType('computer/revoke')[0]).toMatchObject({ payload: { reason: 'deleted' } })
    expect(bTransport.closed?.code).toBe(4401)
  })

  it('marks the Computer offline when its live socket closes', async () => {
    const { transport, repo } = setup()
    transport.deliver(auth())
    await settle()
    transport.close(1006, 'gone')
    await settle()
    expect(repo.markOffline).toHaveBeenCalledWith('org_1', CID, new Date(T0))
  })
})

describe('ComputerConnection control lease', () => {
  const lease = {
    leaseId: '11111111-1111-4111-8111-111111111111',
    computerId: CID,
    holder: { sessionId: 's1', agentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    acquiredAt: new Date(T0).toISOString(),
    expiresAt: new Date(T0 + 1_800_000).toISOString()
  }

  it('tells the desktop the standing lease after auth and each change after a heartbeat, once', async () => {
    let held: typeof lease | null = lease
    const observe = vi.fn(async () => held)
    const { transport } = setup({ leases: { current: vi.fn(async () => held), observe } })
    transport.deliver(auth())
    await settle()
    expect(transport.ofType('computer/lease').map((f) => f.payload)).toEqual([{ lease }])
    transport.deliver(beat({ status: 'busy', lease: { holder: 's1', idleMs: 250 } }))
    await settle()
    expect(observe).toHaveBeenCalledWith('org_1', CID, { status: 'busy', lease: { holder: 's1', idleMs: 250 } })
    expect(transport.ofType('computer/lease')).toHaveLength(1)
    held = null
    transport.deliver(beat({ status: 'paused' }))
    await settle()
    expect(transport.ofType('computer/lease').map((f) => f.payload)).toEqual([{ lease }, { lease: null }])
  })

  it('re-reads a lease the service changed while the channel is live, and keeps the channel when a read fails', async () => {
    let held: typeof lease | null = null
    const { transport, registry } = setup({
      leases: {
        current: vi.fn(async () => held),
        observe: vi.fn(async () => Promise.reject(new Error('db down')))
      }
    })
    transport.deliver(auth())
    await settle()
    held = lease
    registry.leaseChanged(CID)
    transport.deliver(beat())
    await settle()
    expect(transport.ofType('computer/lease').map((f) => f.payload)).toEqual([{ lease: null }, { lease }])
    expect(transport.closed).toBeUndefined()
  })

  it('orders a change after a heartbeat whose lease read was already in flight', async () => {
    let held: typeof lease | null = null
    let finishObserve: (v: null) => void = () => {}
    // The heartbeat reads no lease; an acquire then commits before the heartbeat pushes its stale read.
    const observe = vi.fn(() => new Promise<null>((resolve) => (finishObserve = resolve)))
    const { transport, registry } = setup({ leases: { current: vi.fn(async () => held), observe } })
    transport.deliver(auth())
    await settle()
    transport.deliver(beat())
    await settle()
    held = lease
    registry.leaseChanged(CID)
    finishObserve(null)
    await settle()
    expect(transport.ofType('computer/lease').map((f) => f.payload)).toEqual([{ lease: null }, { lease }])
  })
})
