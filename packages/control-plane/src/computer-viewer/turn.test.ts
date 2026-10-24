import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  cloudflareIceServers,
  cloudflareTurn,
  cloudflareTurnConfigFrom,
  relayTurnSecret,
  turnConfigFrom,
  turnCredentials
} from './turn.js'

describe('TURN for the console viewer', () => {
  it('is off without settings and fails fast when half configured or malformed', () => {
    expect(turnConfigFrom({ COMPUTER_TURN_TTL_SEC: 600 })).toBeUndefined()
    expect(() => turnConfigFrom({ COMPUTER_TURN_URLS: 'turn:t:3478', COMPUTER_TURN_TTL_SEC: 600 })).toThrow()
    expect(() => turnConfigFrom({ COMPUTER_TURN_SECRET: 's'.repeat(16), COMPUTER_TURN_TTL_SEC: 600 })).toThrow()
    expect(() =>
      turnConfigFrom({
        COMPUTER_TURN_URLS: 'stun:t:3478',
        COMPUTER_TURN_SECRET: 's'.repeat(16),
        COMPUTER_TURN_TTL_SEC: 600
      })
    ).toThrow()
    expect(
      turnConfigFrom({
        COMPUTER_TURN_URLS: ' turn:t:3478?transport=udp , turns:t:5349 ',
        COMPUTER_TURN_SECRET: 's'.repeat(16),
        COMPUTER_TURN_TTL_SEC: 600
      })
    ).toEqual({ urls: ['turn:t:3478?transport=udp', 'turns:t:5349'], secret: 's'.repeat(16), ttlSec: 600 })
  })

  it('mints coturn use-auth-secret credentials', () => {
    const config = { urls: ['turn:t:3478'], secret: 'shared-secret-0123', ttlSec: 600 }
    const server = turnCredentials(config, 'viewer-u1', 1_000_000_500)
    expect(server.username).toBe('1000600:viewer-u1')
    expect(server.credential).toBe(createHmac('sha1', config.secret).update('1000600:viewer-u1').digest('base64'))
  })

  it('derives the relay TURN secret from the pepper, stable and domain-separated', () => {
    const secret = relayTurnSecret('p'.repeat(32))
    expect(secret).toBe(relayTurnSecret('p'.repeat(32)))
    expect(secret).not.toBe(relayTurnSecret('q'.repeat(32)))
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(secret).not.toContain('p'.repeat(8))
  })

  it('takes Cloudflare TURN only whole, and never beside a coturn', () => {
    const base = { COMPUTER_TURN_TTL_SEC: 600 }
    expect(cloudflareTurnConfigFrom(base)).toBeUndefined()
    expect(() => cloudflareTurnConfigFrom({ ...base, COMPUTER_TURN_CLOUDFLARE_KEY_ID: 'k1' })).toThrow()
    expect(() => cloudflareTurnConfigFrom({ ...base, COMPUTER_TURN_CLOUDFLARE_API_TOKEN: 't' })).toThrow()
    const whole = { ...base, COMPUTER_TURN_CLOUDFLARE_KEY_ID: ' k1 ', COMPUTER_TURN_CLOUDFLARE_API_TOKEN: 'tok' }
    expect(() => cloudflareTurnConfigFrom({ ...whole, COMPUTER_TURN_CLOUDFLARE_KEY_ID: 'k/../x' })).toThrow()
    expect(() => cloudflareTurnConfigFrom({ ...whole, COMPUTER_TURN_URLS: 'turn:t:3478' })).toThrow()
    expect(cloudflareTurnConfigFrom(whole)).toEqual({ keyId: 'k1', apiToken: 'tok', ttlSec: 600 })
  })
})

describe('Cloudflare TURN', () => {
  // Cloudflare's answer as it comes back today: an alternate UDP 443 and plain TCP 80 beside the four we keep.
  const answer = {
    iceServers: [
      { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:443'] },
      {
        urls: [
          'turn:turn.cloudflare.com:3478?transport=udp',
          'turn:turn.cloudflare.com:3478?transport=tcp',
          'turns:turn.cloudflare.com:5349?transport=tcp',
          'turn:turn.cloudflare.com:443?transport=udp',
          'turn:turn.cloudflare.com:80?transport=tcp',
          'turns:turn.cloudflare.com:443?transport=tcp'
        ],
        username: 'cf-user',
        credential: 'cf-credential'
      }
    ]
  }

  it('keeps the TURN entry, without STUN or the ports browsers and the desktop cannot use', () => {
    expect(cloudflareIceServers(answer)).toEqual([
      {
        urls: [
          'turn:turn.cloudflare.com:3478?transport=udp',
          'turns:turn.cloudflare.com:443?transport=tcp',
          'turn:turn.cloudflare.com:3478?transport=tcp',
          'turns:turn.cloudflare.com:5349?transport=tcp'
        ],
        username: 'cf-user',
        credential: 'cf-credential'
      }
    ])
    // Browsers block 53.
    const withDns = {
      iceServers: [{ urls: ['turn:t:53?transport=udp', 'turn:t:3478'], username: 'u', credential: 'c' }]
    }
    expect(cloudflareIceServers(withDns)[0]?.urls).toEqual(['turn:t:3478'])
    expect(cloudflareIceServers({ iceServers: [{ urls: 'turn:t:3478' }] })).toEqual([])
    expect(cloudflareIceServers({ nope: true })).toEqual([])
  })

  it('asks Cloudflare once per peer with the key, token and TTL', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(answer), { status: 201 }))
    const warn = vi.fn()
    const turn = cloudflareTurn({ keyId: 'k1', apiToken: 'tok', ttlSec: 600 }, { warn, fetch })
    const servers = await turn('viewer-u1', 0)
    expect(servers[0]).toMatchObject({ username: 'cf-user', credential: 'cf-credential' })
    expect(fetch).toHaveBeenCalledWith(
      'https://rtc.live.cloudflare.com/v1/turn/keys/k1/credentials/generate-ice-servers',
      expect.objectContaining({
        method: 'POST',
        headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
        body: JSON.stringify({ ttl: 600 })
      })
    )
    expect(warn).not.toHaveBeenCalled()
  })

  it('leaves the viewer without TURN when Cloudflare refuses or is unreachable', async () => {
    const warn = vi.fn()
    const refused = cloudflareTurn(
      { keyId: 'k1', apiToken: 'tok', ttlSec: 600 },
      { warn, fetch: async () => new Response('{}', { status: 401 }) }
    )
    expect(await refused('viewer-u1', 0)).toEqual([])
    expect(warn).toHaveBeenCalledWith({ status: 401 }, expect.any(String))
    const down = cloudflareTurn(
      { keyId: 'k1', apiToken: 'tok', ttlSec: 600 },
      {
        warn,
        fetch: async () => {
          throw new Error('offline')
        }
      }
    )
    expect(await down('viewer-u1', 0)).toEqual([])
    expect(warn).toHaveBeenCalledTimes(2)
  })
})
