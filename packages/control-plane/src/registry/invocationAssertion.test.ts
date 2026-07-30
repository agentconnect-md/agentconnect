import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import { InvocationAssertionCodec } from './invocationAssertion.js'

const PEPPER = 'test-pepper-that-is-at-least-thirty-two-characters'

describe('InvocationAssertionCodec', () => {
  it('mints an opaque assertion with a distinct recognizable prefix and at least 192 bits of entropy', () => {
    const codec = new InvocationAssertionCodec(PEPPER)
    const assertions = Array.from({ length: 64 }, () => codec.mint().plaintext)

    expect(new Set(assertions)).toHaveLength(assertions.length)
    for (const assertion of assertions) {
      expect(assertion).toMatch(/^ac_mcp_assert_v1_[A-Za-z0-9_-]{43}$/)
      expect(Buffer.from(assertion.slice('ac_mcp_assert_v1_'.length), 'base64url')).toHaveLength(32)
      expect(assertion).not.toMatch(/^[0-9A-Za-z]{49}$/)
      expect(assertion).not.toMatch(/^eyJ/)
    }
  })

  it('uses a stable peppered hash in an invocation-assertion-specific domain', () => {
    const codec = new InvocationAssertionCodec(PEPPER)
    const assertion = codec.mint().plaintext

    expect(codec.hash(assertion)).toBe(codec.hash(assertion))
    expect(codec.hash(assertion)).not.toBe(new InvocationAssertionCodec(`${PEPPER}-other`).hash(assertion))
    expect(codec.hash(assertion)).not.toBe(
      // The API-key domain is deliberately a bare HMAC of the token.
      createHmac('sha256', PEPPER).update(assertion).digest('hex')
    )
  })

  it('rejects malformed assertions before hashing', () => {
    const codec = new InvocationAssertionCodec(PEPPER)

    expect(codec.hash('not-an-invocation-assertion')).toBeNull()
    expect(codec.hash('ac_mcp_assert_v1_short')).toBeNull()
  })

  it('keeps the one-time plaintext outside the persistence-shaped mint result', () => {
    const codec = new InvocationAssertionCodec(PEPPER)
    const minted = codec.mint()

    expect(minted.persistence).toEqual({ assertionHash: codec.hash(minted.plaintext) })
    expect(JSON.stringify(minted.persistence)).not.toContain(minted.plaintext)
    expect(Object.keys(minted.persistence)).toEqual(['assertionHash'])
  })
})
