import { describe, expect, it } from 'vitest'
import { LogtoApiError } from '../github/logto-identity.js'
import { LogtoOrgSsoIdp, OrgSsoIdpRejected } from './idp.js'

interface Call {
  method: string
  path: string
  body: unknown
}

/** A Management API that answers each `METHOD path` from a table and records what it was sent. */
function management(answers: Record<string, { status: number; body?: unknown }>) {
  const calls: Call[] = []
  const request = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? 'GET'
    calls.push({ method, path, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
    const answer = answers[`${method} ${path}`] ?? { status: 404 }
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status })
  }
  return { idp: new LogtoOrgSsoIdp(request), calls }
}

const input = { connectorName: 'org-1', protocol: 'oidc' as const, displayName: 'Example IdP' }

describe('LogtoOrgSsoIdp', () => {
  it('creates the organization’s connector with no domains and no settings', async () => {
    const { idp, calls } = management({
      'GET /api/sso-connectors': { status: 200, body: [{ id: 'other', connectorName: 'org-2', providerName: 'OIDC' }] },
      'POST /api/sso-connectors': { status: 200, body: { id: 'new' } }
    })
    expect(await idp.ensureConnector(input)).toBe('new')
    expect(calls[1]).toEqual({
      method: 'POST',
      path: '/api/sso-connectors',
      body: { providerName: 'OIDC', connectorName: 'org-1', branding: { displayName: 'Example IdP' } }
    })
  })

  it('returns the connector a retried create left, and replaces one of another protocol', async () => {
    const existing = { id: 'kept', connectorName: 'org-1', providerName: 'OIDC' }
    const same = management({ 'GET /api/sso-connectors': { status: 200, body: [existing] } })
    expect(await same.idp.ensureConnector(input)).toBe('kept')
    expect(same.calls).toHaveLength(1)

    const switched = management({
      'GET /api/sso-connectors': { status: 200, body: [existing] },
      'DELETE /api/sso-connectors/kept': { status: 204 },
      'POST /api/sso-connectors': { status: 200, body: { id: 'saml' } }
    })
    expect(await switched.idp.ensureConnector({ ...input, protocol: 'saml' })).toBe('saml')
    expect(switched.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /api/sso-connectors',
      'DELETE /api/sso-connectors/kept',
      'POST /api/sso-connectors'
    ])
  })

  it('writes settings and domains as separate whole values', async () => {
    const { idp, calls } = management({ 'PATCH /api/sso-connectors/c1': { status: 200, body: {} } })
    expect(
      await idp.configure('c1', { displayName: 'Example IdP', config: { issuer: 'https://idp.example.test' } })
    ).toBe('ok')
    expect(await idp.setDomains('c1', ['example.test'])).toBe('ok')
    expect(calls.map((call) => call.body)).toEqual([
      { config: { issuer: 'https://idp.example.test' }, branding: { displayName: 'Example IdP' } },
      { domains: ['example.test'] }
    ])
  })

  it('tells a missing connector, a refusal and an outage apart', async () => {
    expect(await management({}).idp.setDomains('gone', [])).toBe('missing')

    const refused = management({
      'PATCH /api/sso-connectors/c1': { status: 422, body: { message: 'Issuer discovery failed.' } }
    })
    await expect(refused.idp.configure('c1', { displayName: 'x', config: {} })).rejects.toEqual(
      new OrgSsoIdpRejected('Issuer discovery failed')
    )

    const down = management({ 'PATCH /api/sso-connectors/c1': { status: 502 } })
    await expect(down.idp.setDomains('c1', [])).rejects.toBeInstanceOf(LogtoApiError)
  })

  it('reads a connector’s stored settings and reports one that is gone', async () => {
    const { idp } = management({
      'GET /api/sso-connectors/c1': { status: 200, body: { id: 'c1', config: { issuer: 'https://idp.example.test' } } },
      'GET /api/sso-connectors/c2': { status: 200, body: { id: 'c2', config: {} } },
      'GET /api/sso-connectors/c3': { status: 503 }
    })
    expect(await idp.connector('c1')).toEqual({ config: { issuer: 'https://idp.example.test' } })
    expect(await idp.connector('c2')).toEqual({ config: {} })
    expect(await idp.connector('gone')).toBe('missing')
    await expect(idp.connector('c3')).rejects.toBeInstanceOf(LogtoApiError)
  })

  it('reads an account’s address and the connectors it holds an identity on', async () => {
    const { idp } = management({
      'GET /api/users/sub-1?includeSsoIdentities=true': {
        status: 200,
        body: {
          primaryEmail: 'person@example.test',
          ssoIdentities: [
            {
              ssoConnectorId: 'c1',
              issuer: 'https://idp.example.test',
              detail: {
                mail: 'person@Example.TEST',
                upn: 'p',
                groups: ['admins'],
                aliases: ['x', 'p@acme.example'],
                nested: { email: 'n@example.test' }
              }
            },
            { issuer: 'no-connector' }
          ]
        }
      },
      'GET /api/users/sub-2?includeSsoIdentities=true': { status: 200, body: { primaryEmail: '' } }
    })
    expect(await idp.account('sub-1')).toEqual({
      primaryEmail: 'person@example.test',
      connectorIds: ['c1'],
      attributeNames: { c1: ['mail', 'upn', 'groups', 'aliases', 'nested'] },
      addressAttributes: {
        c1: [
          { name: 'mail', domain: 'example.test' },
          { name: 'aliases', domain: 'acme.example' }
        ]
      }
    })
    expect(await idp.account('sub-2')).toEqual({
      primaryEmail: null,
      connectorIds: [],
      attributeNames: {},
      addressAttributes: {}
    })
    expect(await idp.account('gone')).toBeNull()
  })

  it('treats an already-removed connector or account as removed', async () => {
    const { idp } = management({})
    await expect(idp.deleteConnector('gone')).resolves.toBeUndefined()
    await expect(idp.deleteAccount('gone')).resolves.toBeUndefined()
  })
})
