import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { jwtVerify } from 'jose'
import { loadConfig, tokenSigningRoot } from './env.js'
import { ApiKeyCodec } from '../registry/apiKey.js'
import { WebchatTokenService, type WebchatTokenClaims } from '../registry/webchatToken.js'
import { deriveInstallStateKey } from '../github/install-state.js'
import { emailRelayTicketKey } from '../platforms/email/deployment.js'

const DATABASE_URL = 'postgresql://agentconnect:agentconnect@localhost:5432/agentconnect'
const PEPPER = 'synthetic-test-pepper-0000000000000000'
const SIGNING_A = 'synthetic-signing-secret-aaaaaaaaaaaaaaaa'
const SIGNING_B = 'synthetic-signing-secret-bbbbbbbbbbbbbbbb'
const CLAIMS: WebchatTokenClaims = {
  userId: 'user-1',
  user: 'ada@example.test',
  agentId: '11111111-1111-4111-8111-111111111111',
  orgId: 'org-1',
  conversationId: '33333333-3333-4333-8333-333333333333'
}

const load = (extra: Record<string, string> = {}) => loadConfig({ DATABASE_URL, API_KEY_PEPPER: PEPPER, ...extra })
const hmac = (key: string, label: string) => createHmac('sha256', key).update(label).digest()

describe('TOKEN_SIGNING_SECRET', () => {
  it('falls back to the pepper when unset', () => {
    expect(tokenSigningRoot(load())).toBe(PEPPER)
  })

  it('treats an empty value as unset', () => {
    const config = load({ TOKEN_SIGNING_SECRET: '' })
    expect(config.TOKEN_SIGNING_SECRET).toBeUndefined()
    expect(tokenSigningRoot(config)).toBe(PEPPER)
  })

  it('becomes the signing root when set', () => {
    expect(tokenSigningRoot(load({ TOKEN_SIGNING_SECRET: SIGNING_A }))).toBe(SIGNING_A)
  })

  it('refuses a value equal to the pepper', () => {
    expect(() => load({ TOKEN_SIGNING_SECRET: PEPPER })).toThrow(/must differ from API_KEY_PEPPER/)
  })

  it('refuses a value shorter than 32 characters', () => {
    expect(() => load({ TOKEN_SIGNING_SECRET: 'x'.repeat(31) })).toThrow()
  })
})

describe('signing keys with TOKEN_SIGNING_SECRET unset', () => {
  const root = tokenSigningRoot(load())

  it('keeps the webchat token key byte-identical to the pepper-derived one', async () => {
    const { token } = await new WebchatTokenService(root).mint(CLAIMS)
    const key = new Uint8Array(hmac(PEPPER, 'agentconnect.webchat-token.v2'))
    await expect(jwtVerify(token, key, { algorithms: ['HS256'] })).resolves.toBeDefined()
  })

  it('keeps the GitHub install-state key byte-identical to the pepper-derived one', () => {
    expect(deriveInstallStateKey(root).equals(hmac(PEPPER, 'github-install-state-v1'))).toBe(true)
  })

  it('keeps the email relay ticket key byte-identical to the pepper-derived one', () => {
    expect(emailRelayTicketKey(root)).toBe(hmac(PEPPER, 'email-relay-ticket-v1').toString('base64url'))
  })
})

describe('signing root separation', () => {
  it('rejects a webchat token minted under another signing root', async () => {
    const { token } = await new WebchatTokenService(SIGNING_A).mint(CLAIMS)
    expect(await new WebchatTokenService(SIGNING_A).verify(token)).toEqual(CLAIMS)
    expect(await new WebchatTokenService(SIGNING_B).verify(token)).toBeNull()
  })

  it('leaves stored API key hashes independent of the signing secret', () => {
    const secret = 'synthetic-api-key-secret-0123456789'
    const hashes = [load(), load({ TOKEN_SIGNING_SECRET: SIGNING_A }), load({ TOKEN_SIGNING_SECRET: SIGNING_B })].map(
      (config) => new ApiKeyCodec({ API_KEY_PEPPER: config.API_KEY_PEPPER }).hash(secret)
    )
    expect(new Set(hashes).size).toBe(1)
    expect(hashes[0]).toBe(createHmac('sha256', PEPPER).update(secret).digest('hex'))
  })
})
