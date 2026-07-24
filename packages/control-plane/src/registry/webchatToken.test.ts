import { describe, it, expect } from 'vitest'
import { WebchatTokenService, type WebchatTokenClaims } from './webchatToken.js'

const PEPPER = 'webchat-token-test-pepper-0123456789abcdef'
const CLAIMS: WebchatTokenClaims = {
  userId: 'user-1',
  user: 'ada@example.com',
  agentId: '11111111-1111-4111-8111-111111111111',
  orgId: 'org-1'
}

describe('WebchatTokenService', () => {
  it('mints a token that verifies back to the same claims', async () => {
    const svc = new WebchatTokenService(PEPPER)
    const token = await svc.mint(CLAIMS)
    expect(await svc.verify(token)).toEqual(CLAIMS)
  })

  it('rejects a token minted with a DIFFERENT pepper (bad signature)', async () => {
    const minted = await new WebchatTokenService(PEPPER).mint(CLAIMS)
    const other = new WebchatTokenService('a-totally-different-pepper-0123456789ab')
    expect(await other.verify(minted)).toBeNull()
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
    const tampered = `${h}.${p.slice(0, -1)}${p.at(-1) === 'A' ? 'B' : 'A'}.${s}`
    expect(await svc.verify(tampered)).toBeNull()
  })

  it('rejects a malformed / non-JWT string', async () => {
    const svc = new WebchatTokenService(PEPPER)
    expect(await svc.verify('not-a-jwt')).toBeNull()
    expect(await svc.verify('')).toBeNull()
  })
})
