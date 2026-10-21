import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { turnConfigFrom, turnCredentials } from './turn.js'

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
})
