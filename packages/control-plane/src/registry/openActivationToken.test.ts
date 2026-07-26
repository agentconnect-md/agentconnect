import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { OpenActivationTokenCodec } from './openActivationToken.js'
import { WaitlistJoinTokenCodec } from './waitlistJoinToken.js'

const PEPPER = 'test-open-activation-pepper-0123456789abcdef'

describe('OpenActivationTokenCodec', () => {
  it('mints a versioned base62 token and hashes it deterministically', () => {
    const codec = new OpenActivationTokenCodec(PEPPER)
    const minted = codec.mint()

    expect(minted.token).toMatch(/^oa1_[0-9A-Za-z]{43}$/)
    expect(minted.displayTail).toBe(`…${minted.token.slice(-6)}`)
    expect(codec.hash(minted.token)).toBe(minted.hash)
    expect(minted.hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects malformed / wrong-version tokens and domain-separates the HMAC', () => {
    const codec = new OpenActivationTokenCodec(PEPPER)
    const minted = codec.mint()
    const body = minted.token.slice('oa1_'.length)
    const undomained = createHmac('sha256', PEPPER).update(minted.token).digest('hex')

    expect(codec.hash('not-a-token')).toBeNull()
    expect(codec.hash(body)).toBeNull() // missing version prefix
    expect(codec.hash(`oa2_${body}`)).toBeNull() // unknown version
    expect(minted.hash).not.toBe(undomained)
  })

  it('is stable across instances with the same pepper (admin mints, CP verifies)', () => {
    const admin = new OpenActivationTokenCodec(PEPPER)
    const cp = new OpenActivationTokenCodec(PEPPER)
    const other = new OpenActivationTokenCodec('a-different-pepper-0123456789abcdefghij')
    const minted = admin.mint()

    expect(cp.hash(minted.token)).toBe(minted.hash)
    expect(other.hash(minted.token)).not.toBe(minted.hash)
  })

  it('cannot be confused with a waitlist join link under the same pepper', () => {
    const open = new OpenActivationTokenCodec(PEPPER)
    const join = new WaitlistJoinTokenCodec(PEPPER)

    // Neither codec accepts the other's version prefix, so one route can dispatch on
    // shape…
    expect(join.hash(open.mint().token)).toBeNull()
    expect(open.hash(join.mint().token)).toBeNull()

    // …and even a token whose BODY is reused under the other prefix hashes differently
    // (distinct HMAC domains), so a stolen body cannot cross flavors.
    const body = open.mint().token.slice('oa1_'.length)
    expect(open.hash(`oa1_${body}`)).not.toBe(join.hash(`w1_${body}`))
  })
})
