import { describe, it, expect } from 'vitest'
import { createHmac, randomBytes } from 'node:crypto'
import { verifyStandardWebhook, STANDARD_WEBHOOK_TOLERANCE_MS } from './standard-webhooks.js'

const KEY = randomBytes(32)
const TOKEN = `whsec_${KEY.toString('base64')}`
const NOW = 1_760_000_000_000
const TS = String(Math.floor(NOW / 1000))
const BODY = Buffer.from('{"object_kind":"issue"}')

const sign = (id: string, ts: string, body: Buffer, key = KEY) =>
  `v1,${createHmac('sha256', key).update(`${id}.${ts}.`).update(body).digest('base64')}`

describe('verifyStandardWebhook (§11.2)', () => {
  it('accepts a valid v1 signature, including one inside a space-separated list', () => {
    expect(verifyStandardWebhook(TOKEN, 'msg_1', TS, BODY, sign('msg_1', TS, BODY), NOW)).toBe(true)
    const list = `v1,${'A'.repeat(43)}= ${sign('msg_1', TS, BODY)} v2,${'B'.repeat(43)}=`
    expect(verifyStandardWebhook(TOKEN, 'msg_1', TS, BODY, list, NOW)).toBe(true)
  })

  it('rejects a wrong key, wrong id, tampered body, and non-v1 entries', () => {
    expect(verifyStandardWebhook(TOKEN, 'msg_1', TS, BODY, sign('msg_1', TS, BODY, randomBytes(32)), NOW)).toBe(false)
    expect(verifyStandardWebhook(TOKEN, 'msg_2', TS, BODY, sign('msg_1', TS, BODY), NOW)).toBe(false)
    expect(verifyStandardWebhook(TOKEN, 'msg_1', TS, Buffer.from('{}'), sign('msg_1', TS, BODY), NOW)).toBe(false)
    const sig = sign('msg_1', TS, BODY).replace('v1,', 'v2,')
    expect(verifyStandardWebhook(TOKEN, 'msg_1', TS, BODY, sig, NOW)).toBe(false)
  })

  it('rejects timestamps outside the replay window and malformed tokens', () => {
    const staleSeconds = Math.floor((NOW - STANDARD_WEBHOOK_TOLERANCE_MS - 1000) / 1000)
    const stale = String(staleSeconds)
    expect(verifyStandardWebhook(TOKEN, 'msg_1', stale, BODY, sign('msg_1', stale, BODY), NOW)).toBe(false)
    expect(verifyStandardWebhook(TOKEN, 'msg_1', 'soon', BODY, sign('msg_1', 'soon', BODY), NOW)).toBe(false)
    expect(verifyStandardWebhook('plain-secret', 'msg_1', TS, BODY, sign('msg_1', TS, BODY), NOW)).toBe(false)
    expect(verifyStandardWebhook('whsec_', 'msg_1', TS, BODY, sign('msg_1', TS, BODY), NOW)).toBe(false)
  })
})
