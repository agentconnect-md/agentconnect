import { describe, expect, it } from 'vitest'
import { systemClock } from '../../domain/clock.js'
import { GoogleChatRecoveryOAuth } from './recovery.js'

const APP = { clientId: 'example-client', clientSecret: 'synthetic-secret', webAppUrl: 'https://console.example.test' }
const PEPPER = 'synthetic-recovery-pepper-at-least-32-characters'
const attempt = {
  orgId: 'example-org',
  userId: 'example-user',
  accountId: '123456789',
  appId: '123456789012',
  snapshot: 'example-snapshot',
  claim: { v: 1 as const, app: '123456789012', space: 'spaces/AAAAexample', kind: 'dm' as const, iat: 1 }
}

describe('Google Chat recovery proof lifetime', () => {
  it('rejects expired or modified state and binds verification to the configured application', async () => {
    const clock = {
      ...systemClock,
      now: () => 1_800_000_000_000,
      setTimeout: systemClock.setTimeout,
      clearTimeout: systemClock.clearTimeout
    }
    const oauth = new GoogleChatRecoveryOAuth(APP, PEPPER, clock, fetch)
    const { state } = await oauth.start(attempt)
    expect(await oauth.attempt(state)).toMatchObject(attempt)
    await expect(oauth.attempt(state + 'x')).rejects.toMatchObject({ code: 'GOOGLE_CHAT_RECOVERY_CHANGED' })
    const changed = new GoogleChatRecoveryOAuth({ ...APP, clientId: 'replacement-client' }, PEPPER, clock, fetch)
    await expect(changed.attempt(state)).rejects.toMatchObject({ code: 'GOOGLE_CHAT_RECOVERY_CHANGED' })
    clock.now = () => 1_800_000_600_000
    await expect(oauth.attempt(state)).rejects.toMatchObject({ code: 'GOOGLE_CHAT_RECOVERY_CHANGED' })
  })

  it('encrypts the delegated token and refuses expired confirmation', async () => {
    let now = 1_800_000_000_000
    const oauth = new GoogleChatRecoveryOAuth(
      APP,
      PEPPER,
      { now: () => now, setTimeout: systemClock.setTimeout, clearTimeout: systemClock.clearTimeout },
      fetch
    )
    const ticket = await oauth.seal({
      ...attempt,
      clientId: APP.clientId,
      accessToken: 'synthetic-admin-token',
      customerId: 'C0000000000',
      exp: now / 1000 + 600
    })
    expect(ticket).not.toContain('synthetic-admin-token')
    expect((await oauth.open(ticket)).accountId).toBe(attempt.accountId)
    now += 600_000
    await expect(oauth.open(ticket)).rejects.toMatchObject({ code: 'GOOGLE_CHAT_RECOVERY_CHANGED' })
  })
})
