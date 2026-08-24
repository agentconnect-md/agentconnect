import { describe, it, expect, vi } from 'vitest'
import {
  buildRelayDaemonFrame,
  RELAY_DAEMON_SUBPROTOCOL,
  type RelayDaemonFrame,
  type RcVerifyResult
} from '@agentconnect.md/protocol'
import { FakeClock, type ServerTransport } from '@agentconnect.md/connection'
import { RelayDaemonConnection } from './relay-daemon-connection.js'
import type { Logger } from './log.js'

const RELAY_ID = '11111111-1111-4111-8111-111111111111'
const DAEMON_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_DAEMON = '33333333-3333-4333-8333-333333333333'
const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

class FakeServerTransport implements ServerTransport {
  readonly subprotocol = RELAY_DAEMON_SUBPROTOCOL
  readonly remoteAddr = 'test'
  sent: RelayDaemonFrame[] = []
  closed?: { code: number; reason: string }
  private msgCb?: (t: string) => void
  private closeCb?: (c: number, r: string) => void

  send(text: string): void {
    this.sent.push(JSON.parse(text) as RelayDaemonFrame)
  }
  onMessage(cb: (t: string) => void): void {
    this.msgCb = cb
  }
  onClose(cb: (c: number, r: string) => void): void {
    this.closeCb = cb
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason }
    this.closeCb?.(code, reason)
  }
  feed(type: 'rd/hello' | 'rd/ack', payload: unknown): void {
    this.msgCb?.(JSON.stringify(buildRelayDaemonFrame(type, payload as never)))
  }
  lastRep(type: string): RelayDaemonFrame | undefined {
    return [...this.sent].reverse().find((f) => f.type === type)
  }
}

function build(opts: { verify?: () => Promise<RcVerifyResult>; relayId?: string | undefined } = {}) {
  const verify = vi.fn(opts.verify ?? (async () => ({ ok: true, daemonId: DAEMON_ID, orgId: 'org-1' })))
  const onReady = vi.fn()
  const onClosed = vi.fn()
  const transport = new FakeServerTransport()
  const conn = new RelayDaemonConnection(transport, {
    verify,
    relayId: () => ('relayId' in opts ? opts.relayId : RELAY_ID),
    clock: new FakeClock(),
    onChat: () => {},
    onWebchatPost: () => {},
    onAgentMsg: async () => ({ deliveryId: 'unused', delivered: false }),
    onReady,
    onClosed,
    log: silentLog
  })
  conn.start()
  return { conn, transport, verify, onReady, onClosed }
}

describe('RelayDaemonConnection (rd/* accept FSM)', () => {
  it('rd/hello with a valid key + matching daemonId → rd/hello/ok{relayId} + onReady', async () => {
    const { conn, transport, verify, onReady } = build()
    transport.feed('rd/hello', { apiKey: 'the-key', daemonId: DAEMON_ID })
    await Promise.resolve()
    await Promise.resolve()
    expect(verify).toHaveBeenCalledWith('daemon-key', 'the-key', DAEMON_ID)
    expect(transport.lastRep('rd/hello/ok')!.payload).toEqual({ relayId: RELAY_ID })
    expect(conn.state).toBe('READY')
    expect(conn.daemonId).toBe(DAEMON_ID)
    expect(onReady).toHaveBeenCalledWith(DAEMON_ID, conn)
  })

  it('delegates a projected ServiceAccount token as daemon-token, in place of any key', async () => {
    const { conn, transport, verify } = build()
    transport.feed('rd/hello', { serviceAccountToken: 'projected', apiKey: 'stale-key', daemonId: DAEMON_ID })
    await Promise.resolve()
    await Promise.resolve()
    // The token wins: a stale key must never pick a different identity than the CP socket did.
    // The claimed id rides along so CP can match it to the install-wide daemon record.
    // tells the CP which of them this token is presented for.
    expect(verify).toHaveBeenCalledWith('daemon-token', 'projected', DAEMON_ID)
    expect(conn.state).toBe('READY')
  })

  it('refuses a hello carrying no credential at all (close 4401)', async () => {
    const { transport, verify } = build()
    transport.feed('rd/hello', { daemonId: DAEMON_ID })
    await Promise.resolve()
    await Promise.resolve()
    expect(verify).not.toHaveBeenCalled()
    expect(transport.lastRep('error')!.payload).toMatchObject({ code: 'AUTH_FAILED' })
    expect(transport.closed?.code).toBe(4401)
  })

  it('rejects an invalid credential with AUTH_FAILED + close(4401)', async () => {
    const { transport } = build({ verify: async () => ({ ok: false, reason: 'nope' }) })
    transport.feed('rd/hello', { apiKey: 'bad', daemonId: DAEMON_ID })
    await Promise.resolve()
    await Promise.resolve()
    expect(transport.lastRep('error')!.payload).toMatchObject({ code: 'AUTH_FAILED' })
    expect(transport.closed?.code).toBe(4401)
  })

  it('rejects a daemonId that the key does not resolve to (close 4401)', async () => {
    const { transport } = build({ verify: async () => ({ ok: true, daemonId: DAEMON_ID, orgId: 'org-1' }) })
    transport.feed('rd/hello', { apiKey: 'k', daemonId: OTHER_DAEMON }) // claims a different id
    await Promise.resolve()
    await Promise.resolve()
    expect(transport.closed?.code).toBe(4401)
  })

  it('asks the daemon to retry (close 1013) when the relay is not yet registered', async () => {
    const { transport, verify } = build({ relayId: undefined })
    transport.feed('rd/hello', { apiKey: 'k', daemonId: DAEMON_ID })
    await Promise.resolve()
    expect(verify).not.toHaveBeenCalled() // no CP link to verify against
    expect(transport.closed?.code).toBe(1013)
  })

  it('asks the daemon to retry (close 1013) when verify throws (link not ready)', async () => {
    const { transport } = build({
      verify: async () => {
        throw new Error('link not ready')
      }
    })
    transport.feed('rd/hello', { apiKey: 'k', daemonId: DAEMON_ID })
    await Promise.resolve()
    await Promise.resolve()
    expect(transport.lastRep('error')!.payload).toMatchObject({ code: 'INTERNAL', retryable: true })
    expect(transport.closed?.code).toBe(1013)
  })

  it('gates by state — an rd/ack before hello is PROTOCOL_STATE', async () => {
    const { transport } = build()
    transport.feed('rd/ack', { msgId: 'm', accepted: true })
    await Promise.resolve()
    expect(transport.lastRep('error')!.payload).toMatchObject({ code: 'PROTOCOL_STATE' })
  })

  it('does NOT register (onReady) if the socket closes during the verify RTT', async () => {
    let resolveVerify!: (r: RcVerifyResult) => void
    const { conn, transport, onReady, onClosed } = build({
      verify: () => new Promise<RcVerifyResult>((res) => (resolveVerify = res))
    })
    transport.feed('rd/hello', { apiKey: 'k', daemonId: DAEMON_ID })
    await Promise.resolve()
    // Socket dies mid-verify: onClose runs with daemonId still '' → onClosed skipped.
    transport.close(1006, 'peer gone')
    expect(conn.state).toBe('CLOSED')
    // verify now resolves OK — the CLOSED guard must prevent a dead onReady insert.
    resolveVerify({ ok: true, daemonId: DAEMON_ID, orgId: 'org-1' })
    await Promise.resolve()
    await Promise.resolve()
    expect(onReady).not.toHaveBeenCalled()
    expect(onClosed).not.toHaveBeenCalled() // never registered ⇒ nothing to unregister
    expect(conn.state).toBe('CLOSED')
  })

  it('fires onClosed with the daemonId once authenticated', async () => {
    const { conn, transport, onClosed } = build()
    transport.feed('rd/hello', { apiKey: 'k', daemonId: DAEMON_ID })
    await Promise.resolve()
    await Promise.resolve()
    conn.close(4409, 'revoked')
    expect(onClosed).toHaveBeenCalledWith(DAEMON_ID, conn)
  })
})
