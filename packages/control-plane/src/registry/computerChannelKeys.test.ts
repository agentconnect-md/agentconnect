import { describe, expect, it } from 'vitest'
import { ComputerChannelKeys } from './computerChannelKeys.js'

const PEPPER = 'unit-test-pepper-0123456789abcdefghij'
const T0 = 1_760_000_000_000 - (1_760_000_000_000 % 150_000)

describe('ComputerChannelKeys', () => {
  const keys = new ComputerChannelKeys(PEPPER, 300)

  it('issues one key per half lifetime, each valid a full lifetime from its window start', () => {
    const a = keys.current('c1', 'k1', T0 + 10_000)
    expect(a.keyId).toBe(String(T0))
    expect(Date.parse(a.expiresAt) - Date.parse(a.issuedAt)).toBe(300_000)
    expect(keys.current('c1', 'k1', T0 + 149_999)).toEqual(a)
    const b = keys.current('c1', 'k1', T0 + 150_000)
    expect(b.keyId).not.toBe(a.keyId)
    // The renewal overlaps the key it replaces by half a lifetime.
    expect(Date.parse(a.expiresAt) - Date.parse(b.issuedAt)).toBe(150_000)
  })

  it('derives the same key on any replica and a different one per Computer, key and pepper', () => {
    const a = keys.current('c1', 'k1', T0)
    expect(new ComputerChannelKeys(PEPPER, 300).current('c1', 'k1', T0).key).toBe(a.key)
    expect(keys.current('c2', 'k1', T0).key).not.toBe(a.key)
    expect(keys.current('c1', 'k2', T0).key).not.toBe(a.key)
    expect(new ComputerChannelKeys(`${PEPPER}x`, 300).current('c1', 'k1', T0).key).not.toBe(a.key)
  })

  it('recomputes a key by id only while it is live', () => {
    const a = keys.current('c1', 'k1', T0)
    expect(keys.keyFor('c1', 'k1', a.keyId, T0 + 299_999)?.toString('base64url')).toBe(a.key)
    expect(keys.keyFor('c1', 'k1', a.keyId, T0 + 300_000)).toBeNull()
    expect(keys.keyFor('c1', 'k1', String(T0 + 150_000), T0)).toBeNull()
    expect(keys.keyFor('c1', 'k1', String(T0 + 1), T0 + 10)).toBeNull()
    expect(keys.keyFor('c1', 'k1', 'nope', T0)).toBeNull()
  })
})
