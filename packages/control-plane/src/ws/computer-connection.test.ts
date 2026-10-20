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
    audit?: ComputerConnDeps['audit']
    screenshots?: ComputerConnDeps['screenshots']
    status?: string
    stoppedAt?: () => Date | null
    keyDeliveryMs?: number
  } = {}
) {
  const clock = new FakeClock(T0)
  const transport = new FakeTransport()
  const registry = new ComputerChannelRegistry()
  const reports: ComputerLiveReport[] = []
  const repo = {
    get: vi.fn(
      async () =>
        ({
          name: 'desk',
          ownerUserId: 'u1',
          status: over.status ?? 'online',
          stoppedAt: over.stoppedAt ? over.stoppedAt() : null,
          policy: ComputerPolicySchema.parse({ screenshotRetentionDays: 7 })
        }) as unknown as ComputerRecord
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
    keys: new ComputerChannelKeys('unit-test-pepper-0123456789abcdefghij', 300, over.keyDeliveryMs ?? 0),
    registry,
    clock,
    heartbeatSec: 15,
    ...(over.handshakes ? { handshakes: over.handshakes } : {}),
    ...(over.leases ? { leases: over.leases } : {}),
    ...(over.relays ? { relays: over.relays } : {}),
    ...(over.audit ? { audit: over.audit } : {}),
    ...(over.screenshots ? { screenshots: over.screenshots } : {})
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
  it('tells the desktop a console Stop after auth, again while it does not show it, and the resume', async () => {
    let stoppedAt: Date | null = new Date(T0)
    const { transport, registry } = setup({ stoppedAt: () => stoppedAt })
    transport.deliver(auth())
    await settle()
    expect(transport.ofType('computer/stop').map((f) => f.payload)).toEqual([
      { stop: { at: new Date(T0).toISOString() } }
    ])
    transport.deliver(beat({ status: 'paused' }))
    await settle()
    expect(transport.ofType('computer/stop')).toHaveLength(1)
    // Resumed locally while the console Stop stands: told again.
    transport.deliver(beat())
    await settle()
    expect(transport.ofType('computer/stop')).toHaveLength(2)
    // Resumed on another replica: the next heartbeat carries it.
    stoppedAt = null
    transport.deliver(beat({ status: 'paused' }))
    await settle()
    expect(transport.ofType('computer/stop').at(-1)?.payload).toEqual({ stop: null })
    transport.deliver(beat({ status: 'paused' }))
    await settle()
    expect(transport.ofType('computer/stop')).toHaveLength(3)
    registry.pushStop(CID, { at: new Date(T0 + 1).toISOString() })
    expect(transport.ofType('computer/stop').at(-1)?.payload).toEqual({ stop: { at: new Date(T0 + 1).toISOString() } })
  })

  it('does not undo a console Stop with a heartbeat read that started before it', async () => {
    const { transport, registry, repo } = setup()
    transport.deliver(auth())
    await settle()
    expect(transport.ofType('computer/stop').at(-1)?.payload).toEqual({ stop: null })
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const stale = await repo.get()
    repo.get.mockImplementationOnce(async () => {
      await gate
      return stale
    })
    transport.deliver(beat())
    await settle()
    const stop = { at: new Date(T0 + 1).toISOString() }
    registry.pushStop(CID, stop)
    release()
    await settle()
    await settle()
    expect(transport.ofType('computer/stop').at(-1)?.payload).toEqual({ stop })
    expect(transport.ofType('computer/stop')).toHaveLength(2)
  })

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

  it('offers computer-audit-v1 only with an audit store, and acks a stored batch', async () => {
    const plain = setup()
    plain.transport.deliver(auth())
    await settle()
    const plainOk = plain.transport.ofType('computer/auth/ok')[0]!
    expect(plainOk.type === 'computer/auth/ok' && plainOk.payload.features).toBeUndefined()

    const record = vi.fn(async () => 1)
    const { transport } = setup({ audit: { record } })
    transport.deliver(auth())
    await settle()
    expect(transport.ofType('computer/auth/ok')[0]).toMatchObject({ payload: { features: ['computer-audit-v1'] } })
    const entry = {
      id: '00000000-0000-4000-8000-0000000000dd',
      at: new Date(T0).toISOString(),
      tool: 'computer_type',
      client: 'local',
      outcome: 'ok' as const,
      textLength: 5,
      ms: 3
    }
    const report = buildComputerCpFrame('computer/audit', { entries: [entry] })
    transport.deliver(report)
    await settle()
    expect(record).toHaveBeenCalledWith('org_1', CID, [entry])
    expect(transport.ofType('computer/audit/ok')[0]).toMatchObject({ corr: report.id, payload: { stored: 1 } })

    record.mockRejectedValueOnce(new Error('db down'))
    const again = buildComputerCpFrame('computer/audit', { entries: [entry] })
    transport.deliver(again)
    await settle()
    expect(transport.ofType('error').at(-1)).toMatchObject({ corr: again.id, payload: { retryable: true } })
    expect(transport.closed).toBeUndefined()
  })

  it('offers computer-screenshot-v1 with a store, tells the retention, and signs and confirms uploads', async () => {
    const sha256 = 'ab'.repeat(32)
    const put = vi.fn(async () => ({
      status: 'upload' as const,
      url: 'https://store.example.test/k?X-Amz-Signature=s',
      headers: { 'content-length': '3' },
      expiresAt: new Date(T0 + 300_000).toISOString()
    }))
    const commit = vi.fn(async () => true)
    const { transport, registry } = setup({
      screenshots: { retentionDays: (p) => p.screenshotRetentionDays ?? 30, put, commit }
    })
    transport.deliver(auth())
    await settle()
    expect(transport.ofType('computer/auth/ok')[0]).toMatchObject({
      payload: { features: ['computer-screenshot-v1'], screenshotRetentionDays: 7 }
    })
    const offered = {
      sessionId: 'sess-1',
      agentId: '11111111-1111-4111-8111-111111111111',
      sha256,
      bytes: 3,
      contentType: 'image/png' as const,
      takenAt: new Date(T0).toISOString()
    }
    const offer = buildComputerCpFrame('computer/screenshot/put', offered)
    transport.deliver(offer)
    await settle()
    expect(put).toHaveBeenCalledWith(
      { orgId: 'org_1', computerId: CID, policy: expect.objectContaining({ screenshotRetentionDays: 7 }) },
      offered
    )
    expect(transport.ofType('computer/screenshot/put/ok')[0]).toMatchObject({
      corr: offer.id,
      payload: { status: 'upload' }
    })
    const done = buildComputerCpFrame('computer/screenshot/commit', { sessionId: 'sess-1', sha256 })
    transport.deliver(done)
    await settle()
    expect(commit).toHaveBeenCalledWith(CID, done.payload)
    expect(transport.ofType('computer/screenshot/commit/ok')[0]).toMatchObject({
      corr: done.id,
      payload: { stored: true }
    })

    registry.pushPolicy(CID, ComputerPolicySchema.parse({ screenshotRetentionDays: 0 }))
    expect(transport.ofType('computer/policy').at(-1)).toMatchObject({ payload: { screenshotRetentionDays: 0 } })

    put.mockRejectedValueOnce(new Error('bucket down'))
    const again = buildComputerCpFrame('computer/screenshot/put', offered)
    transport.deliver(again)
    await settle()
    expect(transport.ofType('error').at(-1)).toMatchObject({ corr: again.id, payload: { retryable: true } })
  })

  it('signs nothing for a revoked Computer, and answers screenshot frames without a store as illegal', async () => {
    const put = vi.fn()
    const revoked = setup({ status: 'revoked', screenshots: { retentionDays: () => 30, put, commit: vi.fn() } })
    revoked.transport.deliver(auth())
    await settle()
    const offer = buildComputerCpFrame('computer/screenshot/put', {
      sessionId: 'sess-1',
      agentId: '11111111-1111-4111-8111-111111111111',
      sha256: 'ab'.repeat(32),
      bytes: 3,
      contentType: 'image/png',
      takenAt: new Date(T0).toISOString()
    })
    revoked.transport.deliver(offer)
    await settle()
    expect(put).not.toHaveBeenCalled()
    expect(revoked.transport.ofType('computer/screenshot/put/ok')[0]).toMatchObject({ payload: { status: 'skipped' } })

    const plain = setup()
    plain.transport.deliver(auth())
    await settle()
    plain.transport.deliver(offer)
    await settle()
    expect(plain.transport.ofType('error').at(-1)).toMatchObject({ payload: { code: 'PROTOCOL_STATE' } })
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

  it('also hands a desktop that joins just after a key window opens the key grants still sign with', async () => {
    // T0 opens a key window.
    const { transport } = setup({ keyDeliveryMs: 50_000 })
    transport.deliver(auth())
    await settle()
    const ok = transport.ofType('computer/auth/ok')[0]!
    const extra = transport.ofType('computer/credential')
    expect(ok.type === 'computer/auth/ok' && ok.payload.credential.keyId).toBe(String(T0))
    expect(extra).toHaveLength(1)
    expect(extra[0]!.type === 'computer/credential' && extra[0]!.payload.credential.keyId).toBe(String(T0 - 150_000))
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
