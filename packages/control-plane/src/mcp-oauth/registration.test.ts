import { describe, it, expect } from 'vitest'
import type { GuardedResult } from '../net/guarded-fetch.js'
import type { AuthServerMetadata, Dial } from './discovery.js'
import { clientBindingStale, obtainClient } from './registration.js'

const ISSUER = 'https://auth.example.test'
const REDIRECT_URI = 'https://console.example.test/v1/mcp-providers/oauth/callback'

const AS: AuthServerMetadata = {
  issuer: ISSUER,
  authorizationEndpoint: `${ISSUER}/authorize`,
  tokenEndpoint: `${ISSUER}/token`,
  registrationEndpoint: `${ISSUER}/register`,
  issParameterSupported: true,
  clientIdMetadataDocumentSupported: false
}

function fakeDial(result: GuardedResult): Dial & { bodies: string[] } {
  const bodies: string[] = []
  const dial = ((_url: string, init?: { body?: string }) => {
    if (init?.body !== undefined) bodies.push(init.body)
    return Promise.resolve(result)
  }) as Dial & { bodies: string[] }
  dial.bodies = bodies
  return dial
}

const created = (json: unknown, status = 201): GuardedResult => ({
  ok: true,
  response: { status, headers: {}, text: JSON.stringify(json), json }
})

describe('clientBindingStale', () => {
  it('is false with no stored issuer and true once the issuer moves', () => {
    expect(clientBindingStale(undefined, ISSUER)).toBe(false)
    expect(clientBindingStale(ISSUER, ISSUER)).toBe(false)
    expect(clientBindingStale('https://old.example.test', ISSUER)).toBe(true)
  })
})

describe('obtainClient', () => {
  it('prefers operator-supplied credentials over dynamic registration', async () => {
    const dial = fakeDial(created({ client_id: 'dcr-id' }))
    const result = await obtainClient(dial, {
      metadata: AS,
      redirectUri: REDIRECT_URI,
      preregistered: { clientId: 'manual-id', clientSecret: 'manual-secret' }
    })
    expect(result).toEqual({
      ok: true,
      value: { clientId: 'manual-id', clientSecret: 'manual-secret', source: 'preregistered' }
    })
    expect(dial.bodies).toHaveLength(0)
  })

  it('registers dynamically with the exact callback, a web application type, and refresh_token', async () => {
    const dial = fakeDial(created({ client_id: 'dcr-id', client_secret: 'dcr-secret' }))
    const result = await obtainClient(dial, { metadata: AS, redirectUri: REDIRECT_URI })
    expect(result).toEqual({ ok: true, value: { clientId: 'dcr-id', clientSecret: 'dcr-secret', source: 'dynamic' } })
    expect(JSON.parse(dial.bodies[0]!)).toEqual({
      client_name: 'AgentConnect',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      application_type: 'web',
      token_endpoint_auth_method: 'none'
    })
  })

  it('accepts a 200 as well as a 201, and omits an absent client_secret', async () => {
    const result = await obtainClient(fakeDial(created({ client_id: 'dcr-id' }, 200)), {
      metadata: AS,
      redirectUri: REDIRECT_URI
    })
    expect(result).toEqual({ ok: true, value: { clientId: 'dcr-id', source: 'dynamic' } })
  })

  it('has nothing to fall back to when the server offers no registration endpoint', async () => {
    const { registrationEndpoint: _drop, ...withoutRegistration } = AS
    const result = await obtainClient(fakeDial(created({ client_id: 'x' })), {
      metadata: withoutRegistration,
      redirectUri: REDIRECT_URI
    })
    expect(result).toEqual({ ok: false, failure: 'no_client_registration' })
  })

  it.each([
    [created({ error: 'invalid_redirect_uri' }, 400), 'registration_rejected'],
    [created({ not_a_client: true }), 'registration_rejected'],
    [{ ok: false, failure: 'unreachable' } as GuardedResult, 'registration_unreachable'],
    [{ ok: false, failure: 'address_blocked' } as GuardedResult, 'registration_unreachable'],
    [{ ok: false, failure: 'malformed_response' } as GuardedResult, 'registration_rejected']
  ])('reports %#', async (response, failure) => {
    const result = await obtainClient(fakeDial(response), { metadata: AS, redirectUri: REDIRECT_URI })
    expect(result).toEqual({ ok: false, failure })
  })
})
