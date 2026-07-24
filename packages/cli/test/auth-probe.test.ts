import { describe, it, expect } from 'vitest'
import { buildEnvelope, encode, decodeEnvelope } from '@agentconnect.md/protocol'
import type { Transport } from '@agentconnect.md/connection'
import { probeAuth } from '../src/cp/auth-probe.js'

/** Flush all pending microtasks so async chains (including async-function awaits) advance. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** In-memory transport: captures sent frames and lets the test drive replies/close. */
class FakeTransport implements Transport {
  sent: string[] = []
  private msg?: (t: string) => void
  private cls?: (code: number, reason: string) => void
  readonly subprotocol = 'agentconnect.v1'
  send(text: string): void {
    this.sent.push(text)
  }
  onMessage(cb: (t: string) => void): void {
    this.msg = cb
  }
  onClose(cb: (code: number, reason: string) => void): void {
    this.cls = cb
  }
  close(): void {}
  // test drivers:
  lastSentId(): string {
    const d = decodeEnvelope(this.sent[this.sent.length - 1]!)
    if (!d.ok) throw new Error('sent frame did not decode')
    return d.frame.id
  }
  reply(type: string, payload: unknown): void {
    this.msg!(encode(buildEnvelope(type as 'auth/ok', payload, { corr: this.lastSentId() })))
  }
  closeWith(code: number): void {
    this.cls!(code, '')
  }
}

describe('probeAuth', () => {
  it('resolves ok with daemonId on auth/ok', async () => {
    const t = new FakeTransport()
    const p = probeAuth({ url: 'wss://cp/daemon/ws', token: 'tok', connect: async () => t })
    await tick() // let the auth frame send (async-function awaits need setImmediate to flush)
    const daemonId = '11111111-1111-4111-8111-111111111111'
    t.reply('auth/ok', { daemonId, sessionEpoch: 1, heartbeatSec: 15, serverTime: new Date().toISOString() })
    const r = await p
    expect(r.ok).toBe(true)
    expect(r.daemonId).toBe(daemonId)
  })

  it('resolves not-ok on a correlated error frame', async () => {
    const t = new FakeTransport()
    const p = probeAuth({ url: 'wss://cp/daemon/ws', token: 'bad', connect: async () => t })
    await tick()
    t.reply('error', { code: 'AUTH_FAILED', message: 'bad token', retryable: false })
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/AUTH_FAILED|bad token/)
  })

  it('resolves not-ok on a 4401 close', async () => {
    const t = new FakeTransport()
    const p = probeAuth({ url: 'wss://cp/daemon/ws', token: 'bad', connect: async () => t })
    await tick()
    t.closeWith(4401)
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/4401|auth/i)
  })

  it('resolves not-ok when the dial fails', async () => {
    const r = await probeAuth({
      url: 'wss://cp/daemon/ws',
      token: 'tok',
      connect: async () => {
        throw new Error('ECONNREFUSED')
      }
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/ECONNREFUSED|cannot reach/i)
  })

  it('resolves not-ok on timeout', async () => {
    const t = new FakeTransport()
    const r = await probeAuth({ url: 'wss://cp/daemon/ws', token: 'tok', timeoutMs: 10, connect: async () => t })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/timed out/i)
  })
})
