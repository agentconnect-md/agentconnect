import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { OrgInviteLinkCodec } from './orgInviteLink.js'

const PEPPER = 'test-org-invite-pepper-0123456789abcdef'

describe('OrgInviteLinkCodec', () => {
  it('mints a 256-bit base64url token and hashes it deterministically', () => {
    const codec = new OrgInviteLinkCodec(PEPPER)
    const minted = codec.mint()

    expect(minted.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(minted.displayTail).toBe(`…${minted.token.slice(-6)}`)
    expect(codec.hash(minted.token)).toBe(minted.hash)
    expect(minted.hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects malformed tokens and domain-separates the stored HMAC', () => {
    const codec = new OrgInviteLinkCodec(PEPPER)
    const minted = codec.mint()
    const undomained = createHmac('sha256', PEPPER).update(minted.token).digest('hex')

    expect(codec.hash('not-a-token')).toBeNull()
    expect(minted.hash).not.toBe(undomained)
  })
})
