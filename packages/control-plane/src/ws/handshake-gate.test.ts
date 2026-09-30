import { describe, expect, it } from 'vitest'
import { HandshakeGate, handshakeLimit } from './handshake-gate.js'

describe('HandshakeGate', () => {
  it('admits up to its limit and refuses the rest until a slot is released', () => {
    const gate = new HandshakeGate(2)
    const first = gate.tryAcquire()
    const second = gate.tryAcquire()
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(gate.tryAcquire()).toBeUndefined()

    first!()
    expect(gate.size).toBe(1)
    expect(gate.tryAcquire()).toBeDefined()
  })

  it('frees a slot once however many times its release runs', () => {
    const gate = new HandshakeGate(1)
    const release = gate.tryAcquire()!
    const other = new HandshakeGate(1).tryAcquire()!
    release()
    release()
    other()
    expect(gate.size).toBe(0)
    expect(gate.tryAcquire()).toBeDefined()
    expect(gate.tryAcquire()).toBeUndefined()
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
