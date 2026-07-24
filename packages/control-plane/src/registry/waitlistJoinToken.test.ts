import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { WaitlistJoinTokenCodec } from './waitlistJoinToken.js'

const PEPPER = 'test-waitlist-join-pepper-0123456789abcdef'

describe('WaitlistJoinTokenCodec', () => {
  it('mints a versioned base62 token and hashes it deterministically', () => {
    const codec = new WaitlistJoinTokenCodec(PEPPER)
    const minted = codec.mint()

    expect(minted.token).toMatch(/^w1_[0-9A-Za-z]{43}$/)
    expect(minted.displayTail).toBe(`…${minted.token.slice(-6)}`)
    expect(codec.hash(minted.token)).toBe(minted.hash)
    expect(minted.hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects malformed / wrong-version tokens and domain-separates the HMAC', () => {
    const codec = new WaitlistJoinTokenCodec(PEPPER)
    const minted = codec.mint()
    const body = minted.token.slice('w1_'.length)
    const undomained = createHmac('sha256', PEPPER).update(minted.token).digest('hex')

    expect(codec.hash('not-a-token')).toBeNull()
    expect(codec.hash(body)).toBeNull() // missing version prefix
    expect(codec.hash(`w2_${body}`)).toBeNull() // unknown version
    expect(minted.hash).not.toBe(undomained)
  })

  it('is stable across instances with the same pepper (admin mints, CP verifies)', () => {
    const admin = new WaitlistJoinTokenCodec(PEPPER)
    const cp = new WaitlistJoinTokenCodec(PEPPER)
    const other = new WaitlistJoinTokenCodec('a-different-pepper-0123456789abcdefghij')
    const minted = admin.mint()

    expect(cp.hash(minted.token)).toBe(minted.hash)
    expect(other.hash(minted.token)).not.toBe(minted.hash)
  })
})
