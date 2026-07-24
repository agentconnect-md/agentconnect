import { describe, expect, it } from 'vitest'
import type { ConnectorProviderDto } from '@/lib/api'
import {
  credentialFieldsFor,
  filterByCategory,
  filterProviders,
  initialAuthType,
  providerCategories,
  providerIconUrl
} from './connectors'

function provider(over: Partial<ConnectorProviderDto> & { service: string }): ConnectorProviderDto {
  return {
    displayName: over.service,
    categories: [],
    authTypes: [],
    auth: [],
    ...over
  }
}

describe('filterProviders / filterByCategory / providerCategories', () => {
  const providers = [
    provider({ service: 'github', displayName: 'GitHub', categories: ['dev'], authTypes: ['oauth2'] }),
    provider({ service: 'stripe', displayName: 'Stripe', categories: ['payments'], authTypes: ['api_key'] }),
    provider({ service: 'gitlab', displayName: 'GitLab', categories: ['dev'], authTypes: ['oauth2'] })
  ]

  it('search matches name / service / category / authType', () => {
    expect(filterProviders(providers, 'git').map((p) => p.service)).toEqual(['github', 'gitlab'])
    expect(filterProviders(providers, 'payments').map((p) => p.service)).toEqual(['stripe'])
    expect(filterProviders(providers, 'api_key').map((p) => p.service)).toEqual(['stripe'])
  })

  it('category filter keeps only matching providers (null ⇒ all)', () => {
    expect(filterByCategory(providers, 'dev').map((p) => p.service)).toEqual(['github', 'gitlab'])
    expect(filterByCategory(providers, null)).toHaveLength(3)
  })

  it('providerCategories returns sorted distinct categories', () => {
    expect(providerCategories(providers)).toEqual(['dev', 'payments'])
  })
})

describe('initialAuthType', () => {
  it('prefers oauth2, then api_key, then first', () => {
    expect(initialAuthType(provider({ service: 'a', auth: [{ type: 'api_key' }, { type: 'oauth2' }] }))).toBe('oauth2')
    expect(initialAuthType(provider({ service: 'b', auth: [{ type: 'no_auth' }, { type: 'api_key' }] }))).toBe(
      'api_key'
    )
    expect(initialAuthType(provider({ service: 'c', auth: [{ type: 'no_auth' }] }))).toBe('no_auth')
  })
})

describe('credentialFieldsFor', () => {
  it('api_key yields a secret apiKey field (+ extras); custom yields its fields; oauth/no_auth none', () => {
    expect(credentialFieldsFor({ type: 'api_key' }).map((f) => f.key)).toEqual(['apiKey'])
    expect(credentialFieldsFor({ type: 'oauth2' })).toEqual([])
    expect(credentialFieldsFor({ type: 'no_auth' })).toEqual([])
    const custom = credentialFieldsFor({
      type: 'custom_credential',
      fields: [{ key: 'token', label: 'Token', inputType: 'password', required: true, secret: true }]
    })
    expect(custom.map((f) => f.key)).toEqual(['token'])
  })
})

describe('providerIconUrl', () => {
  it('uses an absolute iconUrl, else a favicon from homepage, else null', () => {
    expect(providerIconUrl(provider({ service: 'a', iconUrl: 'https://cdn.example/a.svg' }))).toBe(
      'https://cdn.example/a.svg'
    )
    expect(
      providerIconUrl(provider({ service: 'b', iconUrl: '/relative.svg', homepageUrl: 'https://b.com' }))
    ).toContain('domain=b.com')
    expect(providerIconUrl(provider({ service: 'c' }))).toBeNull()
  })
})
