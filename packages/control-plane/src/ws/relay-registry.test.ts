import { describe, it, expect, vi } from 'vitest'
import { RelayRegistry, type RelayChannel } from './relay-registry.js'

function ch(relayId: string): RelayChannel {
  return { relayId, send: vi.fn(), close: vi.fn() }
}

describe('RelayRegistry', () => {
  it('add / get / all', () => {
    const reg = new RelayRegistry()
    const a = ch('r1')
    const b = ch('r2')
    reg.add(a)
    reg.add(b)
    expect(reg.get('r1')).toBe(a)
    expect(reg.all()).toHaveLength(2)
  })

  it('adding the same relayId supersedes (a restarted pod reclaims its id)', () => {
    const reg = new RelayRegistry()
    const a = ch('r1')
    const a2 = ch('r1')
    reg.add(a)
    reg.add(a2)
    expect(reg.get('r1')).toBe(a2)
    expect(reg.all()).toHaveLength(1)
  })

  it('remove is only-if-still-ours (a stale close must not evict the live socket)', () => {
    const reg = new RelayRegistry()
    const a = ch('r1')
    const a2 = ch('r1')
    reg.add(a)
    reg.add(a2) // supersede: a2 is now live
    reg.remove('r1', a) // late close from the superseded old socket
    expect(reg.get('r1')).toBe(a2) // a2 survives
    reg.remove('r1', a2)
    expect(reg.get('r1')).toBeUndefined()
  })
})
