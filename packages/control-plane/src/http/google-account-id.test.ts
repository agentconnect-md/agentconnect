/** The console user's Google account id follows the identity provider (google-chat-integration.md §10.6). */
import { describe, expect, it, vi } from 'vitest'
import { syncGoogleAccountId } from './google-account-id.js'

function deps(reported: string | null, recorded: string | null) {
  const googleAccountIdFor = vi.fn(async () => reported)
  const setGoogleAccountId = vi.fn(async () => {})
  return {
    googleAccountIdFor,
    setGoogleAccountId,
    deps: {
      identity: { googleAccountIdFor },
      users: { getGoogleAccountId: async () => recorded, setGoogleAccountId }
    }
  }
}

describe('syncGoogleAccountId', () => {
  it('records a newly linked Google identity', async () => {
    const h = deps('100000000000000000009', null)

    await expect(
      syncGoogleAccountId(h.deps, { userId: 'user-1', oidcSubject: 'logto-subject', fresh: true })
    ).resolves.toBe('100000000000000000009')
    expect(h.googleAccountIdFor).toHaveBeenCalledWith('logto-subject', true)
    expect(h.setGoogleAccountId).toHaveBeenCalledWith('user-1', '100000000000000000009')
  })

  it('writes nothing when the recorded id is current', async () => {
    const h = deps('100000000000000000009', '100000000000000000009')

    await syncGoogleAccountId(h.deps, { userId: 'user-1', oidcSubject: 'logto-subject' })
    expect(h.setGoogleAccountId).not.toHaveBeenCalled()
  })

  it('clears an id whose Google identity was unlinked', async () => {
    const h = deps(null, '100000000000000000009')

    await expect(syncGoogleAccountId(h.deps, { userId: 'user-1', oidcSubject: 'logto-subject' })).resolves.toBeNull()
    expect(h.setGoogleAccountId).toHaveBeenCalledWith('user-1', null)
  })
})
