import { describe, expect, it } from 'vitest'
import { stunUrlsFrom } from './stun.js'

describe('stunUrlsFrom', () => {
  it('reads comma-separated stun: URLs, and is off when unset or blank', () => {
    expect(stunUrlsFrom({})).toBeUndefined()
    expect(stunUrlsFrom({ COMPUTER_STUN_URLS: ' , ' })).toBeUndefined()
    expect(stunUrlsFrom({ COMPUTER_STUN_URLS: 'stun:stun.cloudflare.com:3478, stun:[2001:db8::1]:3478' })).toEqual([
      'stun:stun.cloudflare.com:3478',
      'stun:[2001:db8::1]:3478'
    ])
  })

  it('fails boot on a URL that is not stun:, or on more than a grant carries', () => {
    expect(() => stunUrlsFrom({ COMPUTER_STUN_URLS: 'turn:turn.example.com:3478' })).toThrow(/not a stun: URL/)
    expect(() => stunUrlsFrom({ COMPUTER_STUN_URLS: 'stun:a:1,stun:b:2,stun:c:3' })).toThrow(/at most 2/)
  })
})
