import { describe, it, expect } from 'vitest'
import { ApiKeyCodec } from './apiKey.js'

const PEPPER = 'test-api-key-pepper-0123456789abcdef'
const codec = new ApiKeyCodec({ API_KEY_PEPPER: PEPPER })

describe('ApiKeyCodec', () => {
  it('mints a bare base62 token (no prefix/role) and round-trips through parse', () => {
    const { token, hash, displayTail } = codec.mint()
    expect(token).toMatch(/^[0-9A-Za-z]+$/) // no `ac_`, no role, no separators
    const parsed = codec.parse(token)
    expect(parsed).not.toBeNull()
    // the stored hash equals HMAC of the parsed-out secret
    expect(codec.hash(parsed!.secret)).toBe(hash)
    // displayTail is the non-secret tail = the token's last 4 chars (= secret's last 4)
    expect(displayTail).toBe(`…${token.slice(-10, -6)}`)
  })

  it('mints unique secrets and hashes across calls', () => {
    const a = codec.mint()
    const b = codec.mint()
    expect(a.token).not.toBe(b.token)
    expect(a.hash).not.toBe(b.hash)
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects a token whose secret was tampered (CRC mismatch)', () => {
    const { token } = codec.mint()
    const i = 10 // flip a char in the secret body (before the trailing 6-char CRC)
    const flipped = token[i] === 'a' ? 'b' : 'a'
    const tampered = token.slice(0, i) + flipped + token.slice(i + 1)
    expect(tampered).not.toBe(token)
    expect(codec.parse(tampered)).toBeNull()
  })

  it('rejects malformed / too-short / non-base62 tokens', () => {
    expect(codec.parse('')).toBeNull()
    expect(codec.parse('short')).toBeNull() // ≤ CRC_LEN
    expect(codec.parse('has_underscore_x')).toBeNull() // non-base62
    expect(codec.parse('has-hyphen-x')).toBeNull() // non-base62
    expect(codec.parse('a.b.c')).toBeNull() // dotted (e.g. a JWT) is not a key
    expect(codec.parse('ac_daemon_xxxxxxxxxx')).toBeNull() // the old prefixed form is no longer valid
  })

  it('binds the hash to the pepper (different pepper ⇒ different hash)', () => {
    const other = new ApiKeyCodec({ API_KEY_PEPPER: 'a-totally-different-pepper-0123456789' })
    const { token } = codec.mint()
    const secret = codec.parse(token)!.secret
    expect(other.hash(secret)).not.toBe(codec.hash(secret))
  })

  it('hashEquals is true for equal, false for unequal/length-mismatch', () => {
    expect(ApiKeyCodec.hashEquals('abc', 'abc')).toBe(true)
    expect(ApiKeyCodec.hashEquals('abc', 'abd')).toBe(false)
    expect(ApiKeyCodec.hashEquals('abc', 'abcd')).toBe(false)
  })
})
