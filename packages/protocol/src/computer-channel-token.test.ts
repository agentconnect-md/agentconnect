import { createHmac, randomBytes } from 'node:crypto'
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

  it('reads a token whose signer added a claim this verifier does not know, dropping that claim', () => {
    const signed = `actk1.${Buffer.from(JSON.stringify({ ...claims, later: ['x'] })).toString('base64url')}`
    const sig = createHmac('sha256', key)
      .update('agentconnect/computer-channel-token/v1\n' + signed)
      .digest()
      .toString('base64url')
    expect(verify(`${signed}.${sig}`)).toEqual(claims)
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

  it('signs a view token naming its member, mode and TURN servers, and refuses one without its member', () => {
    const view: ComputerChannelTokenClaims = {
      aud: 'view',
      cmp: COMPUTER,
      kid: claims.kid,
      iat: now,
      exp: now + 120_000,
      usr: 'user-1',
      mode: 'control',
      ice: [
        {
          urls: ['turn:turn.example.com:3478?transport=udp', 'turns:turn.example.com:5349?transport=tcp'],
          username: `${Math.floor(now / 1000) + 3600}:${COMPUTER}`,
          credential: 'x'.repeat(28)
        }
      ]
    }
    const token = signComputerChannelToken(view, key)
    expect(verify(token, { aud: 'view' })).toEqual(view)
    expect(verify(token)).toBeNull()
    expect(() => signComputerChannelToken({ ...view, usr: undefined }, key)).toThrow()
    expect(() =>
      signComputerChannelToken({ ...view, ice: [{ urls: ['http://x'], username: 'u', credential: 'c' }] }, key)
    ).toThrow()
  })

  it('reads anything else as not a channel token', () => {
    for (const token of ['', 'acd_local', 'actk1.x', 'actk2.e30.AAAA', `actk1.${'A'.repeat(5000)}.A`]) {
      expect(readComputerChannelToken(token)).toBeNull()
    }
  })
})
