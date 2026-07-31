// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { forgetOwnershipProof, rememberOwnershipProof, reusableOwnershipProof } from './ownership-proof'

const inMinutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString()

beforeEach(() => {
  sessionStorage.clear()
})

describe('ownership proof', () => {
  it('reuses a proof with room to spare, and refuses one that would expire mid-consent', () => {
    rememberOwnershipProof('proof-1', inMinutes(9))
    expect(reusableOwnershipProof()).toBe('proof-1')

    // Under the reserve: the provider round trip would outlive the record, so a
    // fresh code beats a link that 403s on the way back.
    rememberOwnershipProof('proof-2', inMinutes(4))
    expect(reusableOwnershipProof()).toBeUndefined()
  })

  it('trusts the record’s own expiry, not the moment it was stored', () => {
    // The record's clock starts when the CODE IS SENT. A slow reader redeems a
    // code that is already half spent — timing from storage would call this
    // fresh and hand back a proof with two minutes of life.
    rememberOwnershipProof('nearly-spent', inMinutes(2))
    expect(reusableOwnershipProof()).toBeUndefined()
  })

  it('fails closed on a missing, malformed or unparseable proof', () => {
    expect(reusableOwnershipProof()).toBeUndefined()

    sessionStorage.setItem('ac.social-link.proof', 'not json')
    expect(reusableOwnershipProof()).toBeUndefined()

    sessionStorage.setItem('ac.social-link.proof', JSON.stringify({ recordId: 'x' }))
    expect(reusableOwnershipProof()).toBeUndefined()

    sessionStorage.setItem('ac.social-link.proof', JSON.stringify({ recordId: 'x', expiresAt: 'whenever' }))
    expect(reusableOwnershipProof()).toBeUndefined()

    // Already past — a stale record must never look reusable.
    rememberOwnershipProof('expired', inMinutes(-1))
    expect(reusableOwnershipProof()).toBeUndefined()
  })

  it('forgets a proof outright, so a refusal or a sign-out ends it', () => {
    rememberOwnershipProof('proof-1', inMinutes(9))
    expect(reusableOwnershipProof()).toBe('proof-1')

    forgetOwnershipProof()
    expect(reusableOwnershipProof()).toBeUndefined()
  })
})
