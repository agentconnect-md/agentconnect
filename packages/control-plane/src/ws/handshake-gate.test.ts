import { afterEach, describe, expect, it, vi } from 'vitest'
import { HandshakeGate, handshakeLimit } from './handshake-gate.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('HandshakeGate', () => {
  it('admits auth steps up to its limit and refuses the rest until a slot is released', () => {
    const gate = new HandshakeGate(2)
    const first = gate.tryAcquire()
    expect(gate.tryAcquire()).toBeDefined()
    expect(gate.tryAcquire()).toBeUndefined()

    first!()
    expect(gate.size).toBe(1)
    expect(gate.tryAcquire()).toBeDefined()
  })

  it('queues a register step instead of refusing it, and hands it the next free slot', async () => {
    const gate = new HandshakeGate(1)
    const held = gate.tryAcquire()!
    let granted = false
    const register = gate.acquire().then((release) => {
      granted = true
      return release
    })
    await Promise.resolve()
    expect(granted).toBe(false)
    expect(gate.waiting).toBe(1)

    held()
    const release = await register
    expect(gate.size).toBe(1)
    expect(gate.waiting).toBe(0)
    release()
    expect(gate.size).toBe(0)
  })

  it('refuses a new auth step while a register step waits, so a daemon past auth goes first', () => {
    const gate = new HandshakeGate(1)
    const held = gate.tryAcquire()!
    void gate.acquire()
    held()
    expect(gate.size).toBe(1)
    expect(gate.tryAcquire()).toBeUndefined()
  })

  it('frees a slot once however many times its release runs', () => {
    const gate = new HandshakeGate(1)
    const release = gate.tryAcquire()!
    release()
    release()
    expect(gate.size).toBe(0)
    expect(gate.tryAcquire()).toBeDefined()
    expect(gate.tryAcquire()).toBeUndefined()
  })

  it('reports refusals at most once every ten seconds, with the count since the last report', () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const report = vi.fn()
    const gate = new HandshakeGate(1, report)
    gate.tryAcquire()
    gate.tryAcquire()
    gate.tryAcquire()
    expect(report.mock.calls).toEqual([[1]])

    vi.setSystemTime(1_010_000)
    gate.tryAcquire()
    expect(report.mock.calls).toEqual([[1], [2]])
  })
})

describe('handshakeLimit', () => {
  it('leaves a quarter of the database pool to everything but handshakes', () => {
    expect(handshakeLimit({ DATABASE_POOL_MAX: 20 })).toBe(15)
    expect(handshakeLimit({})).toBe(7)
    expect(handshakeLimit({ DATABASE_POOL_MAX: 1 })).toBe(1)
  })

  it('uses an explicit concurrency as given', () => {
    expect(handshakeLimit({ DATABASE_POOL_MAX: 20, DAEMON_HANDSHAKE_CONCURRENCY: 4 })).toBe(4)
  })
})
