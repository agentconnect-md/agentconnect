import { describe, expect, it } from 'vitest'
import { shouldIgnoreUndiciRequest } from './observability.js'

describe('shouldIgnoreUndiciRequest', () => {
  it.each(['/bottelegram-secret/getMe', '/bottelegram-secret/setMyProfilePhoto'])(
    'suppresses token-bearing Telegram Bot API path %s',
    (path) => {
      expect(shouldIgnoreUndiciRequest({ origin: 'https://api.telegram.org', path })).toBe(true)
    }
  )

  it('keeps unrelated outgoing requests instrumented', () => {
    expect(shouldIgnoreUndiciRequest({ origin: 'https://api.example.test', path: '/bottelegram-secret/getMe' })).toBe(
      false
    )
    expect(shouldIgnoreUndiciRequest({ origin: 'https://api.telegram.org', path: '/file/example' })).toBe(false)
  })
})
