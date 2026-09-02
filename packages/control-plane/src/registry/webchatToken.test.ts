import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import { WebchatTokenService, type WebchatTokenClaims } from './webchatToken.js'

const PEPPER = 'webchat-token-test-pepper-0123456789abcdef'
const CLAIMS: WebchatTokenClaims = {
  userId: 'user-1',
  user: 'ada@example.com',
  agentId: '11111111-1111-4111-8111-111111111111',
  orgId: 'org-1',
  conversationId: '33333333-3333-4333-8333-333333333333'
}

describe('WebchatTokenService', () => {
  it('mints a token that verifies back to the same claims', async () => {
    const svc = new WebchatTokenService(PEPPER)
    const token = await svc.mint(CLAIMS)
    expect(await svc.verify(token)).toEqual(CLAIMS)
  })

  it("round-trips the author's avatar URL when the profile has one", async () => {
    const svc = new WebchatTokenService(PEPPER)
    const claims = { ...CLAIMS, userPicture: 'https://cdn.example.test/avatars/user-1.png' }
    expect(await svc.verify(await svc.mint(claims))).toEqual(claims)
  })

  it('round-trips an exact private-session owner proof', async () => {
    const svc = new WebchatTokenService(PEPPER)
    const claims = { ...CLAIMS, privateSessionOwnerIdentity: 'slack:T1:U1' }
    expect(await svc.verify(await svc.mint(claims))).toEqual(claims)
  })

  it('rejects a token minted with a DIFFERENT pepper (bad signature)', async () => {
    const minted = await new WebchatTokenService(PEPPER).mint(CLAIMS)
    const other = new WebchatTokenService('a-totally-different-pepper-0123456789ab')
    expect(await other.verify(minted)).toBeNull()
  })

  it('isolates v1 and v2 tokens during a rolling deployment', async () => {
    const legacyKey = new Uint8Array(createHmac('sha256', PEPPER).update('agentconnect.webchat-token.v1').digest())
    const legacyToken = await new SignJWT({
      user: CLAIMS.user,
      agentId: CLAIMS.agentId,
      orgId: CLAIMS.orgId,
      conversationId: CLAIMS.conversationId
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(CLAIMS.userId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(legacyKey)
    const current = new WebchatTokenService(PEPPER)
    expect(await current.verify(legacyToken)).toBeNull()

    const currentToken = await current.mint(CLAIMS)
    await expect(jwtVerify(currentToken, legacyKey, { algorithms: ['HS256'] })).rejects.toThrow()
  })

  it('rejects an EXPIRED token', async () => {
    const svc = new WebchatTokenService(PEPPER, -10) // exp 10s in the past ⇒ already expired
    const token = await svc.mint(CLAIMS)
    expect(await new WebchatTokenService(PEPPER).verify(token)).toBeNull()
  })

  it('rejects a tampered token', async () => {
    const svc = new WebchatTokenService(PEPPER)
    const token = await svc.mint(CLAIMS)
    const [h, p, s] = token.split('.')
    // Flip a byte in the payload segment — signature no longer matches.
    const tampered = `${h}.${p!.slice(0, -1)}${p!.at(-1) === 'A' ? 'B' : 'A'}.${s}`
    expect(await svc.verify(tampered)).toBeNull()
  })

  it('rejects a malformed / non-JWT string', async () => {
    const svc = new WebchatTokenService(PEPPER)
    expect(await svc.verify('not-a-jwt')).toBeNull()
    expect(await svc.verify('')).toBeNull()
  })
})
