import { describe, it, expect } from 'vitest'
import type { WebSocketServer } from 'ws'
import { attachKeepalive } from './keepalive.js'

class FakeWs {
  readonly OPEN = 1
  readyState = 1
  pinged = 0
  terminated = false
  private handlers = new Map<string, Array<() => void>>()
  on(event: string, cb: () => void): this {
    const arr = this.handlers.get(event) ?? []
    arr.push(cb)
    this.handlers.set(event, arr)
    return this
  }
  ping(): void {
    this.pinged++
  }
  terminate(): void {
    this.terminated = true
  }
  emit(event: string): void {
    for (const cb of this.handlers.get(event) ?? []) cb()
  }
}

class FakeWss {
  clients = new Set<FakeWs>()
  private closeCbs: Array<() => void> = []
  on(event: string, cb: () => void): void {
    if (event === 'close') this.closeCbs.push(cb)
  }
  fireClose(): void {
    for (const cb of this.closeCbs) cb()
  }
}

function arm(wss: FakeWss, intervalMs = 1000) {
  let tick: (() => void) | undefined
  let cleared = false
  const track = attachKeepalive(wss as unknown as WebSocketServer, intervalMs, {
    setInterval: (fn) => {
      tick = fn
      return { unref() {} }
    },
    clearInterval: () => {
      cleared = true
    }
  })
  return { track: track as unknown as (ws: FakeWs) => void, sweep: () => tick?.(), isCleared: () => cleared }
}

describe('attachKeepalive', () => {
  it('pings a socket proven alive, then terminates it if silent for a full interval', () => {
    const wss = new FakeWss()
    const k = arm(wss)
    const ws = new FakeWs()
    wss.clients.add(ws)
    k.track(ws) // seen alive
    k.sweep() // alive ⇒ consume the mark + ping
    expect(ws.pinged).toBe(1)
    expect(ws.terminated).toBe(false)
    k.sweep() // no inbound since ⇒ half-open ⇒ terminate
    expect(ws.terminated).toBe(true)
  })

  it('an inbound frame re-marks the socket alive so the next sweep pings instead of terminating', () => {
    const wss = new FakeWss()
    const k = arm(wss)
    const ws = new FakeWs()
    wss.clients.add(ws)
    k.track(ws)
    k.sweep() // ping (mark consumed)
    ws.emit('message') // inbound ⇒ re-marked alive
    k.sweep()
    expect(ws.terminated).toBe(false)
    expect(ws.pinged).toBe(2)
  })

  it('skips a socket that is not OPEN (leaves it to its own close)', () => {
    const wss = new FakeWss()
    const k = arm(wss)
    const ws = new FakeWs()
    ws.readyState = 2 // CLOSING
    wss.clients.add(ws)
    k.track(ws)
    k.sweep()
    expect(ws.pinged).toBe(0)
    expect(ws.terminated).toBe(false)
  })

  it('clears the sweep timer when the server closes', () => {
    const wss = new FakeWss()
    const k = arm(wss)
    wss.fireClose()
    expect(k.isCleared()).toBe(true)
  })
})
