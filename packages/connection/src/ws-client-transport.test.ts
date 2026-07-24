import { describe, it, expect } from 'vitest'
import { WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import { ClientTransport, armRxWatchdog, type WatchdogSocket } from './ws-client-transport.js'

// ── armRxWatchdog — the half-open detector (injected timers, no real sockets) ──

class FakeWatchdogSocket implements WatchdogSocket {
  readonly OPEN = 1
  readyState = 1
  pings = 0
  terminated = false
  private handlers = new Map<string, Array<(...a: unknown[]) => void>>()
  on(event: string, listener: (...a: unknown[]) => void): unknown {
    const arr = this.handlers.get(event) ?? []
    arr.push(listener)
    this.handlers.set(event, arr)
    return this
  }
  ping(): void {
    this.pings++
  }
  terminate(): void {
    this.terminated = true
  }
  emit(event: string): void {
    for (const h of this.handlers.get(event) ?? []) h()
  }
}

function armWith(sock: FakeWatchdogSocket, selfPingMs: number, idleMs: number) {
  let tick: (() => void) | undefined
  let now = 0
  let cleared = false
  armRxWatchdog(sock, {
    selfPingMs,
    idleMs,
    now: () => now,
    setInterval: (fn) => {
      tick = fn
      return { unref() {} }
    },
    clearInterval: () => {
      cleared = true
    }
  })
  return {
    setNow: (n: number) => {
      now = n
    },
    fire: () => tick?.(),
    isCleared: () => cleared
  }
}

describe('armRxWatchdog', () => {
  it('pings while inbound activity is recent, and resets the idle clock on rx', () => {
    const sock = new FakeWatchdogSocket()
    const wd = armWith(sock, 1000, 3000)
    wd.setNow(1000)
    wd.fire() // 1000 - 0 = 1000 < 3000 → ping
    expect(sock.pings).toBe(1)
    expect(sock.terminated).toBe(false)
    // inbound message resets lastRx to 'now'
    wd.setNow(2000)
    sock.emit('message')
    wd.setNow(4500)
    wd.fire() // 4500 - 2000 = 2500 < 3000 → ping (would have terminated without the reset)
    expect(sock.terminated).toBe(false)
    expect(sock.pings).toBe(2)
  })

  it('terminates a socket idle longer than idleMs', () => {
    const sock = new FakeWatchdogSocket()
    const wd = armWith(sock, 1000, 3000)
    wd.setNow(3001) // no rx since lastRx=0 → 3001 > 3000
    wd.fire()
    expect(sock.terminated).toBe(true)
    expect(sock.pings).toBe(0)
  })

  it('an inbound pong (the peer answered our ping) resets the idle clock', () => {
    const sock = new FakeWatchdogSocket()
    const wd = armWith(sock, 1000, 3000)
    wd.setNow(2500)
    sock.emit('pong') // inbound → resets lastRx to 2500
    wd.setNow(5000) // 2500ms since the pong < idleMs 3000
    wd.fire()
    expect(sock.terminated).toBe(false)
    expect(sock.pings).toBe(1)
  })

  it('does not ping a socket that is no longer OPEN', () => {
    const sock = new FakeWatchdogSocket()
    const wd = armWith(sock, 1000, 3000)
    sock.readyState = 2 // CLOSING — not OPEN
    wd.setNow(1000)
    wd.fire()
    expect(sock.pings).toBe(0)
    expect(sock.terminated).toBe(false)
  })

  it('clears the timer when the socket closes', () => {
    const sock = new FakeWatchdogSocket()
    const wd = armWith(sock, 1000, 3000)
    sock.emit('close')
    expect(wd.isCleared()).toBe(true)
  })
})

// ── ClientTransport.dial — real in-process ws round-trip + post-open containment ──

async function startServer(
  subprotocol: string,
  onConn: (ws: import('ws').WebSocket) => void
): Promise<{ port: number; close: () => Promise<void> }> {
  const wss = new WebSocketServer({
    port: 0,
    handleProtocols: (protocols: Set<string>) => (protocols.has(subprotocol) ? subprotocol : false)
  })
  wss.on('connection', onConn)
  await new Promise<void>((r) => wss.once('listening', () => r()))
  const port = (wss.address() as AddressInfo).port
  return {
    port,
    close: () => new Promise<void>((r) => wss.close(() => r()))
  }
}

describe('ClientTransport.dial', () => {
  it('dials with the given subprotocol/path and round-trips a message', async () => {
    // Echo on client send — avoids racing the server's greeting against the
    // client's onMessage registration (which only exists after dial resolves).
    const server = await startServer('test.sub.v1', (ws) =>
      ws.on('message', (d: Buffer) => ws.send(`echo:${d.toString()}`))
    )
    const t = await ClientTransport.dial(`ws://127.0.0.1:${server.port}`, {
      subprotocol: 'test.sub.v1',
      path: '/relays/ws'
    })
    expect(t.subprotocol).toBe('test.sub.v1')
    const got = new Promise<string>((resolve) => t.onMessage(resolve))
    t.send('ping')
    expect(await got).toBe('echo:ping')
    t.close(1000, 'done')
    await server.close()
  })

  it('contains a post-open socket error (oversized frame) as a close, never an unhandled throw', async () => {
    // A server frame past the 256 KiB cap makes the client ws emit a post-open
    // 'error'; the transport folds it into terminate()→'close' instead of letting
    // it surface as an unhandled 'error' event that would crash the process.
    const server = await startServer('test.sub.v1', (ws) => ws.send(Buffer.alloc(300 * 1024)))
    const t = await ClientTransport.dial(`ws://127.0.0.1:${server.port}`, {
      subprotocol: 'test.sub.v1',
      path: '/relays/ws'
    })
    // If containment regressed, the unhandled 'error' would crash this worker
    // before onClose ever fires.
    await new Promise<void>((resolve) => t.onClose(() => resolve()))
    await server.close()
  })
})
