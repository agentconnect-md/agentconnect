import { describe, expect, it } from 'vitest'
import { FakeClock, type Transport } from '@agentconnect.md/connection'
import {
  buildComputerCpFrame,
  ComputerPolicySchema,
  type ComputerCpFrame,
  type ComputerPolicy
} from '@agentconnect.md/protocol/computer'
import { ChannelAuthority } from './authority.js'
import { ComputerCpClient, type HeartbeatReport } from './client.js'

class FakeTransport implements Transport {
  readonly subprotocol = 'agentconnect.computer.v1'
  sent: ComputerCpFrame[] = []
  closedWith: number | undefined
  private message: (text: string) => void = () => {}
  private closeCb: (code: number, reason: string) => void = () => {}
  send(text: string): void {
    this.sent.push(JSON.parse(text) as ComputerCpFrame)
  }
  onMessage(cb: (text: string) => void): void {
    this.message = cb
  }
  onClose(cb: (code: number, reason: string) => void): void {
    this.closeCb = cb
  }
  close(code: number): void {
    if (this.closedWith !== undefined) return
    this.closedWith = code
    this.closeCb(code, '')
  }
  deliver(frame: ComputerCpFrame): void {
    this.message(JSON.stringify(frame))
  }
  drop(code: number): void {
    this.close(code)
  }
  ofType(type: string): ComputerCpFrame[] {
    return this.sent.filter((frame) => frame.type === type)
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

function harness() {
  const clock = new FakeClock(1_760_000_000_000)
  const transports: FakeTransport[] = []
  const policies: ComputerPolicy[] = []
  const revoked: string[] = []
  const leases: unknown[] = []
  let report: HeartbeatReport = { status: 'online', facts: { osVersion: 'Ubuntu 26.04', session: 'x11' } }
  const authority = new ChannelAuthority({
    registered: true,
    now: () => clock.now(),
    setTimer: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimer: (handle) => clock.clearTimeout(handle as number)
  })
  const client = new ComputerCpClient({
    channelUrl: 'wss://cp.example.com/v1/computers/ws',
    apiKey: 'computer-key',
    desktopDaemonVersion: '0.2.0',
    authority,
    report: () => report,
    onPolicy: (policy) => policies.push(policy),
    onLease: (lease) => leases.push(lease),
    onRevoked: (reason) => revoked.push(reason),
    log: () => {},
    clock,
    jitter: () => 0,
    connect: async () => {
      const transport = new FakeTransport()
      transports.push(transport)
      return transport
    }
  })
  const credential = (offsetMs = 0) => ({
    keyId: String(clock.now() + offsetMs),
    key: Buffer.alloc(32, 7).toString('base64url'),
    issuedAt: new Date(clock.now() + offsetMs).toISOString(),
    expiresAt: new Date(clock.now() + offsetMs + 300_000).toISOString()
  })
  const authOk = (transport: FakeTransport, features?: string[]) => {
    const auth = transport.ofType('computer/auth')[0]!
    transport.deliver(
      buildComputerCpFrame(
        'computer/auth/ok',
        {
          computerId: '00000000-0000-4000-8000-000000000001',
          orgId: 'org_1',
          name: 'desk',
          heartbeatSec: 15,
          serverTime: new Date(clock.now()).toISOString(),
          credential: credential(),
          policy: ComputerPolicySchema.parse({ leaseIdleSeconds: 60 }),
          ...(features ? { features } : {})
        },
        { corr: auth.id }
      )
    )
  }
  return {
    clock,
    transports,
    policies,
    revoked,
    leases,
    authority,
    client,
    credential,
    authOk,
    setReport: (next: HeartbeatReport) => (report = next)
  }
}

describe('ComputerCpClient', () => {
  it('reports audit entries only to a CP that accepts them, and only once it stored them', async () => {
    const entry = {
      id: '00000000-0000-4000-8000-0000000000dd',
      at: new Date(0).toISOString(),
      tool: 'computer_click',
      client: 'local',
      outcome: 'ok' as const,
      ms: 1
    }
    const old = harness()
    old.client.start()
    await settle()
    old.authOk(old.transports[0]!)
    await settle()
    expect(await old.client.reportAudit([entry])).toBe('retry')
    expect(old.transports[0]!.ofType('computer/audit')).toEqual([])

    const h = harness()
    h.client.start()
    await settle()
    const transport = h.transports[0]!
    h.authOk(transport, ['computer-audit-v1'])
    await settle()
    const sent = h.client.reportAudit([entry])
    const report = transport.ofType('computer/audit')[0]!
    expect(report.payload).toEqual({ entries: [entry] })
    transport.deliver(buildComputerCpFrame('computer/audit/ok', { stored: 1 }, { corr: report.id }))
    expect(await sent).toBe('stored')

    const failed = h.client.reportAudit([entry])
    const again = transport.ofType('computer/audit')[1]!
    transport.deliver(
      buildComputerCpFrame('error', { code: 'INTERNAL', message: 'db', retryable: true }, { corr: again.id })
    )
    expect(await failed).toBe('retry')

    // A non-retryable refusal tells the reporter that resending the same batch cannot help.
    const refused = h.client.reportAudit([entry])
    const third = transport.ofType('computer/audit')[2]!
    transport.deliver(
      buildComputerCpFrame('error', { code: 'BAD_PAYLOAD', message: 'bad', retryable: false }, { corr: third.id })
    )
    expect(await refused).toBe('rejected')
  })

  it('hands the told control lease on and reports its local lease in every heartbeat', async () => {
    const h = harness()
    h.client.start()
    await settle()
    const [transport] = h.transports
    h.authOk(transport!)
    await settle()
    const lease = {
      leaseId: '00000000-0000-4000-8000-0000000000aa',
      computerId: '00000000-0000-4000-8000-000000000001',
      holder: { sessionId: 'sess-1', agentId: '00000000-0000-4000-8000-0000000000bb' },
      acquiredAt: new Date(h.clock.now()).toISOString(),
      expiresAt: new Date(h.clock.now() + 1_800_000).toISOString()
    }
    transport!.deliver(buildComputerCpFrame('computer/lease', { lease }))
    transport!.deliver(buildComputerCpFrame('computer/lease', { lease: null }))
    expect(h.leases).toEqual([lease, null])
    h.setReport({
      status: 'busy',
      lease: { holder: 'sess-1', idleMs: 400 },
      facts: { osVersion: 'Ubuntu 26.04', session: 'x11' }
    })
    h.client.beat()
    expect(transport!.ofType('computer/heartbeat').at(-1)!.payload).toEqual({
      status: 'busy',
      lease: { holder: 'sess-1', idleMs: 400 }
    })
  })

  it('authenticates with the key, takes the credential and policy, and reports its facts once', async () => {
    const h = harness()
    h.client.start()
    await settle()
    const [transport] = h.transports
    expect(transport!.ofType('computer/auth')[0]).toMatchObject({
      payload: { apiKey: 'computer-key', desktopDaemonVersion: '0.2.0' }
    })
    expect(h.authority.refusal()).toBeDefined()
    h.authOk(transport!)
    await settle()
    expect(h.client.state).toBe('READY')
    expect(h.authority.refusal()).toBeUndefined()
    expect(h.policies[0]?.leaseIdleSeconds).toBe(60)
    expect(transport!.ofType('computer/heartbeat')[0]).toMatchObject({
      payload: { status: 'online', osVersion: 'Ubuntu 26.04', session: 'x11' }
    })

    h.clock.advance(15_000)
    expect(transport!.ofType('computer/heartbeat')[1]!.payload).toEqual({ status: 'online' })
    h.setReport({ status: 'busy', facts: { osVersion: 'Ubuntu 26.04', session: 'xvfb' } })
    h.client.beat()
    expect(transport!.ofType('computer/heartbeat')[2]!.payload).toMatchObject({ status: 'busy', session: 'xvfb' })
  })

  it('keeps its authority alive with renewals and loses it when the CP stays away past the key', async () => {
    const h = harness()
    h.client.start()
    await settle()
    const first = h.transports[0]!
    h.authOk(first)
    await settle()
    h.clock.advance(150_000)
    first.deliver(buildComputerCpFrame('computer/credential', { credential: h.credential() }))
    h.clock.advance(200_000)
    expect(h.authority.refusal()).toBeUndefined()

    // The link drops and the CP is unreachable: redial attempts fail, the last key lapses.
    first.drop(1006)
    expect(h.client.state).toBe('DEGRADED')
    h.clock.advance(1000)
    await settle()
    expect(h.transports).toHaveLength(2)
    h.transports[1]!.drop(1006)
    for (let i = 0; i < 20; i++) {
      h.clock.advance(15_000)
      await settle()
    }
    expect(h.authority.refusal()).toMatch(/not connected/)

    // Reconnected: a fresh key restores it.
    await settle()
    const second = h.transports.at(-1)!
    h.authOk(second)
    await settle()
    expect(h.authority.refusal()).toBeUndefined()
  })

  it('obeys a revoke: drops the key, reports it once and never redials', async () => {
    const h = harness()
    h.client.start()
    await settle()
    const transport = h.transports[0]!
    h.authOk(transport)
    await settle()
    transport.deliver(buildComputerCpFrame('computer/revoke', { reason: 'revoked' }))
    transport.drop(4401)
    expect(h.revoked).toEqual(['revoked by the Control Plane'])
    expect(h.authority.state().kind).toBe('revoked')
    h.clock.advance(60_000)
    await settle()
    expect(h.transports).toHaveLength(1)
  })

  it('treats a refused key at auth as revoked', async () => {
    const h = harness()
    h.client.start()
    await settle()
    const transport = h.transports[0]!
    const auth = transport.ofType('computer/auth')[0]!
    transport.deliver(
      buildComputerCpFrame('error', { code: 'AUTH_FAILED', message: 'no', retryable: false }, { corr: auth.id })
    )
    transport.drop(4401)
    await settle()
    expect(h.revoked).toEqual(['key refused by the Control Plane'])
    expect(h.client.state).toBe('REVOKED')
  })

  it('redials after a bare close 4401 that no refusal or revoke preceded', async () => {
    const h = harness()
    h.client.start()
    await settle()
    h.transports[0]!.drop(4401)
    await settle()
    expect(h.revoked).toEqual([])
    expect(h.client.state).toBe('DEGRADED')
    h.clock.advance(1000)
    await settle()
    expect(h.transports).toHaveLength(2)
  })

  it('redials with backoff after a transient close', async () => {
    const h = harness()
    h.client.start()
    await settle()
    h.authOk(h.transports[0]!)
    await settle()
    h.transports[0]!.drop(1012)
    h.clock.advance(999)
    await settle()
    expect(h.transports).toHaveLength(1)
    h.clock.advance(1)
    await settle()
    expect(h.transports).toHaveLength(2)
    expect(h.transports[1]!.ofType('computer/auth')).toHaveLength(1)
  })
})
