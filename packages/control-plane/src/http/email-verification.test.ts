/** A console user's stored address is marked verified from the identity provider's linked sign-in methods. */
import { describe, expect, it, vi } from 'vitest'
import { syncEmailVerification } from './email-verification.js'

function deps(socialEmailsFor: () => Promise<string[]>) {
  const recordVerifiedEmails = vi.fn(async () => {})
  return {
    recordVerifiedEmails,
    deps: { identity: { socialEmailsFor }, users: { recordVerifiedEmails }, clock: { now: () => 1_000 } }
  }
}

describe('syncEmailVerification', () => {
  it('hands the repository every address the linked sign-in methods report, stamped with the clock', async () => {
    const h = deps(async () => ['someone@example.test'])

    await syncEmailVerification(h.deps, { userId: 'user-1', oidcSubject: 'subject-1' })
    expect(h.recordVerifiedEmails).toHaveBeenCalledWith('user-1', ['someone@example.test'], new Date(1_000))
  })

  it('reports no address for an account with no social sign-in method, which clears a stale mark', async () => {
    const h = deps(async () => [])

    await syncEmailVerification(h.deps, { userId: 'user-1', oidcSubject: 'subject-1' })
    expect(h.recordVerifiedEmails).toHaveBeenCalledWith('user-1', [], new Date(1_000))
  })

  it('writes nothing when the identity provider cannot be read', async () => {
    const h = deps(async () => {
      throw new Error('identity provider unavailable')
    })

    await expect(syncEmailVerification(h.deps, { userId: 'user-1', oidcSubject: 'subject-1' })).rejects.toThrow()
    expect(h.recordVerifiedEmails).not.toHaveBeenCalled()
  })
})
