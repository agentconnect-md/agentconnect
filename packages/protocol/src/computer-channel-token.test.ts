import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  COMPUTER_CHANNEL_TOKEN_MAX_TTL_MS,
  readComputerChannelToken,
  signComputerChannelToken,
  verifyComputerChannelToken,
  type ComputerChannelTokenClaims
} from './computer-channel-token.js'

const COMPUTER = '00000000-0000-4000-8000-000000000001'
const AGENT = '00000000-0000-4000-8000-0000000000bb'
const key = randomBytes(32)
const now = 1_760_000_000_000

const claims: ComputerChannelTokenClaims = {
  aud: 'mcp',
  cmp: COMPUTER,
  kid: '1759999950000',
  iat: now,
  exp: now + 120_000,
  ses: 'sess-1',
  agt: AGENT,
  mode: 'control'
}

const verify = (token: string, over: Partial<Parameters<typeof verifyComputerChannelToken>[1]> = {}) =>
  verifyComputerChannelToken(token, {
    aud: 'mcp',
    computerId: COMPUTER,
    key: (kid) => (kid === claims.kid ? key : undefined),
    now: now + 1000,
    ...over
  })

describe('computer channel tokens', () => {
  it('verifies a token signed with the live key and returns its claims', () => {
    const token = signComputerChannelToken(claims, key)
    expect(readComputerChannelToken(token)).toEqual(claims)
    expect(verify(token)).toEqual(claims)
  })

  it('refuses a forged signature, another key, another Computer, the wrong audience and an expired token', () => {
    const token = signComputerChannelToken(claims, key)
    const [prefix, payload] = token.split('.')
    expect(verify(`${prefix}.${payload}.${'A'.repeat(43)}`)).toBeNull()
    expect(verify(signComputerChannelToken(claims, randomBytes(32)))).toBeNull()
    expect(verify(token, { key: () => undefined })).toBeNull()
    expect(verify(token, { computerId: '00000000-0000-4000-8000-000000000002' })).toBeNull()
    expect(verify(token, { aud: 'relay' })).toBeNull()
    expect(verify(token, { now: claims.exp })).toBeNull()
  })

  it('refuses claims edited after signing', () => {
    const token = signComputerChannelToken(claims, key)
    const [prefix, , sig] = token.split('.')
    const edited = Buffer.from(JSON.stringify({ ...claims, ses: 'sess-2' })).toString('base64url')
    expect(verify(`${prefix}.${edited}.${sig}`)).toBeNull()
  })

  it('will not sign an mcp token without its session, nor one that lives too long', () => {
    expect(() => signComputerChannelToken({ ...claims, ses: undefined }, key)).toThrow()
    expect(() =>
      signComputerChannelToken({ ...claims, exp: now + COMPUTER_CHANNEL_TOKEN_MAX_TTL_MS + 1 }, key)
    ).toThrow()
    const relay = signComputerChannelToken(
      { aud: 'relay', cmp: COMPUTER, kid: claims.kid, iat: now, exp: now + 60_000 },
      key
    )
    expect(verify(relay, { aud: 'relay' })).toMatchObject({ aud: 'relay', cmp: COMPUTER })
  })

  it('reads anything else as not a channel token', () => {
    for (const token of ['', 'acd_local', 'actk1.x', 'actk2.e30.AAAA', `actk1.${'A'.repeat(4000)}.A`]) {
      expect(readComputerChannelToken(token)).toBeNull()
    }
  })
})
