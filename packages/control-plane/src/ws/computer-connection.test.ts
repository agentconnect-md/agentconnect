import { describe, expect, it, vi } from 'vitest'
import { buildComputerCpFrame, ComputerPolicySchema, type ComputerCpFrame } from '@agentconnect.md/protocol'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import { ComputerId, OrgId } from '../domain/ids.js'
import { ComputerChannelKeys } from '../registry/computerChannelKeys.js'
import type { ComputerPrincipal } from '../registry/computerService.js'
import type { ComputerLiveReport, ComputerRecord } from '../persistence/ports.js'
import { ComputerConnection, type ComputerConnDeps, type ComputerTransport } from './computer-connection.js'
import { ComputerChannelRegistry } from './computer-registry.js'

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

function setup(over: { authenticate?: ComputerPrincipal | null; live?: () => boolean } = {}) {
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
    computers: { authenticate: vi.fn(async () => (over.authenticate === undefined ? principal : over.authenticate)) },
    repo,
    keys: new ComputerChannelKeys('unit-test-pepper-0123456789abcdefghij', 300),
    registry,
    clock,
    heartbeatSec: 15
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
    expect(first.transport.closed?.code).toBe(4401)

    const idle = setup()
    idle.clock.advance(10_000)
    expect(idle.transport.closed?.code).toBe(4401)
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
