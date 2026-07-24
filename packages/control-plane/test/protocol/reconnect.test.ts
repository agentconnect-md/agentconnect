/**
 * Reconnect supersession (design §4.3/§4.4) — a daemon that reconnects on a NEW
 * socket must stay indexed even when the OLD socket's close event arrives late.
 *
 * The production shape of the bug: a half-dead TCP connection (sleep / NAT
 * rebind) lingers on the CP while the daemon reconnects. The new connection's
 * `auth` overwrites the `ConnectionRegistry` entry; when the old socket's close
 * finally fires, an unguarded `remove(daemonId)` evicted the LIVE connection —
 * `GET /daemons` read `offline` while heartbeats kept refreshing `lastSeenAt`.
 */
import { describe, it, expect } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildWsHarness } from '../fakes/build-ws.js'
import { InMemoryDaemonStub } from '../fakes/daemon-stub.js'

const DAEMON = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

/**
 * A transport whose close EVENT is decoupled from the close CALL — the CP can
 * `close()` it (or the peer can vanish) long before the socket's close event is
 * observed, exactly like a half-dead TCP connection.
 */
class DelayedCloseStub extends InMemoryDaemonStub {
  private cb: ((code: number, reason: string) => void) | undefined
  private pending: { code: number; reason: string } | undefined

  override onClose(cb: (code: number, reason: string) => void): void {
    this.cb = cb
  }

  override close(code: number, reason: string): void {
    if (this.closed) return
    this.closed = { code, reason }
    this.pending = { code, reason } // recorded, NOT delivered — event still in flight
  }

  /** Deliver the (late) close event to the connection. */
  fireClose(): void {
    if (this.pending && this.cb) this.cb(this.pending.code, this.pending.reason)
  }
}

function authPayload(apiKey: string) {
  return { apiKey, daemonId: DAEMON, agentVersion: '1.4.0' }
}

describe('daemon reconnect — new connection survives the old socket', () => {
  it('re-auth supersedes the old connection (closed 4409) and a late close does not evict the new entry', async () => {
    const h = buildWsHarness(prisma)
    const token = await h.mintToken(DAEMON)

    // First connection authenticates and owns the registry entry.
    const oldStub = new DelayedCloseStub()
    const a = h.connect(oldStub)
    oldStub.inject('auth', authPayload(token))
    await oldStub.expectFrame('auth/ok')
    expect(h.deps.connReg.get(DAEMON)?.conn).toBe(a.conn)

    // The daemon reconnects on a new socket while the old one is still open.
    const b = h.connect()
    b.stub.inject('auth', authPayload(token))
    await b.stub.expectFrame('auth/ok')

    // The new connection owns the entry; the superseded socket was closed 4409.
    expect(h.deps.connReg.get(DAEMON)?.conn).toBe(b.conn)
    expect(oldStub.closed).toEqual({ code: 4409, reason: 'superseded by a newer connection' })

    // The old socket's close event lands AFTER the new auth (half-dead TCP):
    // it must NOT evict the live connection from the index.
    oldStub.fireClose()
    expect(h.deps.connReg.get(DAEMON)?.conn).toBe(b.conn)

    // A heartbeat on the new connection still updates the live entry.
    b.stub.inject('heartbeat', {
      load: { cpu: 0.5, mem: 0.5, agents: 1 },
      health: 'ok',
      activeSessions: 1,
      degradedScopes: []
    })
    expect(h.deps.connReg.get(DAEMON)?.reachable).toBe(true)
  })

  it('a normally-ordered disconnect still removes the entry (own close is not skipped)', async () => {
    const h = buildWsHarness(prisma)
    const token = await h.mintToken(DAEMON)

    const { stub } = h.connect()
    stub.inject('auth', authPayload(token))
    await stub.expectFrame('auth/ok')
    expect(h.deps.connReg.has(DAEMON)).toBe(true)

    stub.close(1000, 'daemon shutdown')
    expect(h.deps.connReg.has(DAEMON)).toBe(false)
  })
})
