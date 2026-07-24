/**
 * Unit tests for `attachKeepalive` (no-Docker `unit` project). A fake
 * WebSocketServer + fake sockets and a manual interval driver pin the sweep's
 * decision: terminate a socket silent for a full interval, ping the rest, and
 * reset liveness on any inbound frame. No real timers, no socket.
 */
import { describe, it, expect } from 'vitest'
import { attachKeepalive } from './keepalive.js'

const OPEN = 1

/** Minimal ws-socket fake recording ping/terminate and replaying registered listeners. */
class FakeSocket {
  readonly OPEN = OPEN
  readyState = OPEN
  pinged = 0
  terminated = false
  private listeners: Record<string, Array<() => void>> = {}
  on(event: string, fn: () => void): this {
    ;(this.listeners[event] ??= []).push(fn)
    return this
  }
  emit(event: string): void {
    for (const fn of this.listeners[event] ?? []) fn()
  }
  ping(): void {
    this.pinged++
  }
  terminate(): void {
    this.terminated = true
  }
}

/** Fake WebSocketServer: a live `clients` set + a single `close` listener slot. */
class FakeWss {
  clients = new Set<FakeSocket>()
  private onClose?: () => void
  on(event: string, fn: () => void): this {
    if (event === 'close') this.onClose = fn
    return this
  }
  emitClose(): void {
    this.onClose?.()
  }
}

/** A hand-driven interval: `attachKeepalive` registers its sweep here; the test fires it. */
function manualTimers() {
  let swept: (() => void) | undefined
  let cleared = false
  return {
    fire: () => swept?.(),
    get cleared() {
      return cleared
    },
    timers: {
      setInterval: (fn: () => void) => {
        swept = fn
        return { unref: () => {} }
      },
      clearInterval: () => {
        cleared = true
      }
    }
  }
}

// The fakes model exactly the surface the sweep touches; cast through unknown to the
// `ws` types attachKeepalive expects (structural match isn't inferred across the import).
const anyWss = (w: FakeWss): Parameters<typeof attachKeepalive>[0] =>
  w as unknown as Parameters<typeof attachKeepalive>[0]
const anySock = (s: FakeSocket): Parameters<ReturnType<typeof attachKeepalive>>[0] =>
  s as unknown as Parameters<ReturnType<typeof attachKeepalive>>[0]

describe('attachKeepalive', () => {
  it('pings a socket that proved itself alive, and does not terminate it', () => {
    const wss = new FakeWss()
    const drv = manualTimers()
    const track = attachKeepalive(anyWss(wss), 30_000, drv.timers)

    const sock = new FakeSocket()
    wss.clients.add(sock)
    track(anySock(sock)) // freshly tracked ⇒ alive

    drv.fire() // first sweep
    expect(sock.terminated).toBe(false)
    expect(sock.pinged).toBe(1)

    // It was pinged (liveness consumed); the peer pongs before the next sweep.
    sock.emit('pong')
    drv.fire()
    expect(sock.terminated).toBe(false)
    expect(sock.pinged).toBe(2)
  })

  it('terminates a socket that produced no inbound frame across a full interval', () => {
    const wss = new FakeWss()
    const drv = manualTimers()
    const track = attachKeepalive(anyWss(wss), 30_000, drv.timers)

    const sock = new FakeSocket()
    wss.clients.add(sock)
    track(anySock(sock))

    drv.fire() // sweep 1: alive (fresh) → ping, consume liveness
    expect(sock.pinged).toBe(1)
    expect(sock.terminated).toBe(false)

    drv.fire() // sweep 2: no pong/message since → half-open → terminate
    expect(sock.terminated).toBe(true)
    expect(sock.pinged).toBe(1) // not pinged again
  })

  it('counts an app message (not only a pong) as liveness', () => {
    const wss = new FakeWss()
    const drv = manualTimers()
    const track = attachKeepalive(anyWss(wss), 30_000, drv.timers)

    const sock = new FakeSocket()
    wss.clients.add(sock)
    track(anySock(sock))

    drv.fire() // ping, consume liveness
    sock.emit('message') // a heartbeat frame — proves the socket is alive
    drv.fire()
    expect(sock.terminated).toBe(false)
    expect(sock.pinged).toBe(2)
  })

  it('skips a socket that is not OPEN (leaves it to its own close)', () => {
    const wss = new FakeWss()
    const drv = manualTimers()
    const track = attachKeepalive(anyWss(wss), 30_000, drv.timers)

    const sock = new FakeSocket()
    sock.readyState = 2 // CLOSING
    wss.clients.add(sock)
    track(anySock(sock))

    drv.fire()
    expect(sock.terminated).toBe(false)
    expect(sock.pinged).toBe(0)
  })

  it('clears the sweep timer when the server closes', () => {
    const wss = new FakeWss()
    const drv = manualTimers()
    attachKeepalive(anyWss(wss), 30_000, drv.timers)
    expect(drv.cleared).toBe(false)
    wss.emitClose()
    expect(drv.cleared).toBe(true)
  })
})
