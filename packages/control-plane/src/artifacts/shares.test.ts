import { describe, expect, it } from 'vitest'
import { OrgInviteLinkCodec } from '../registry/orgInviteLink.js'
import { ArtifactShareCodec, artifactShareLinkPath } from './shares.js'

const PEPPER = 'artifact-share-unit-pepper-0123456789abcdef'

describe('ArtifactShareCodec', () => {
  it('mints a 256-bit base64url token whose hash it can recompute, and shows only its tail', () => {
    const codec = new ArtifactShareCodec(PEPPER)
    const minted = codec.mint()
    expect(minted.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(minted.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(minted.hash).not.toContain(minted.token)
    expect(codec.hash(minted.token)).toBe(minted.hash)
    expect(minted.displayTail).toBe(`…${minted.token.slice(-6)}`)
    expect(codec.mint().token).not.toBe(minted.token)
    expect(artifactShareLinkPath(minted.token)).toBe(`/share/${minted.token}`)
  })

  it('refuses a malformed token and never hashes like another token kind or pepper', () => {
    const codec = new ArtifactShareCodec(PEPPER)
    for (const bad of ['', 'short', `${'A'.repeat(43)}=`, `${'A'.repeat(42)}.`]) expect(codec.hash(bad)).toBeNull()
    const token = codec.mint().token
    expect(new OrgInviteLinkCodec(PEPPER).hash(token)).not.toBe(codec.hash(token))
    expect(new ArtifactShareCodec(`${PEPPER}-other`).hash(token)).not.toBe(codec.hash(token))
  })
})
