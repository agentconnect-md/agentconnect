import { describe, expect, it } from 'vitest'
import {
  composeProfileName,
  filterCatalog,
  isValidConnectionName,
  parseWhitelist,
  type OcOAuthConfig,
  type OcProvider
} from './filter.js'

function provider(service: string, opts: { oauth?: boolean } = {}): OcProvider {
  const oauth = opts.oauth ?? true
  return {
    service,
    displayName: service,
    categories: [],
    authTypes: oauth ? ['oauth2'] : ['api_key'],
    auth: oauth ? [{ type: 'oauth2' }] : [{ type: 'api_key' }],
    actions: [{ id: 'x' }]
  }
}

/** A provider that offers BOTH oauth2 and api-key. */
function dualProvider(service: string): OcProvider {
  return {
    service,
    displayName: service,
    categories: [],
    authTypes: ['oauth2', 'api_key'],
    auth: [{ type: 'oauth2' }, { type: 'api_key' }],
    actions: [{ id: 'x' }]
  }
}

const config = (service: string, configured: boolean): OcOAuthConfig => ({
  service,
  configured,
  clientId: configured ? 'client-id' : null
})

describe('filterCatalog', () => {
  it('keeps configured-oauth + all non-oauth, drops unconfigured oauth, and strips actions', () => {
    const providers = [provider('github'), provider('slack'), provider('stripe', { oauth: false })]
    const configs = [config('github', true), config('slack', false)]

    const kept = filterCatalog(providers, configs, null)
    expect(kept.map((p) => p.service)).toEqual(['github', 'stripe'])
    expect(kept.every((p) => p.actions === undefined)).toBe(true)
  })

  it('keeps a non-oauth provider even with no oauth config', () => {
    expect(filterCatalog([provider('stripe', { oauth: false })], [], null).map((p) => p.service)).toEqual(['stripe'])
  })

  it('keeps a dual provider but strips the oauth2 method when its secret is unconfigured', () => {
    const kept = filterCatalog([dualProvider('linear')], [config('linear', false)], null)
    expect(kept.map((p) => p.service)).toEqual(['linear'])
    expect(kept[0].auth.map((a) => a.type)).toEqual(['api_key'])
    expect(kept[0].authTypes).toEqual(['api_key'])
  })

  it('keeps both methods on a dual provider when oauth IS configured', () => {
    const kept = filterCatalog([dualProvider('linear')], [config('linear', true)], null)
    expect(kept[0].auth.map((a) => a.type)).toEqual(['oauth2', 'api_key'])
    expect(kept[0].authTypes).toEqual(['oauth2', 'api_key'])
  })

  it('applies the whitelist', () => {
    const providers = [provider('github'), provider('stripe', { oauth: false })]
    expect(filterCatalog(providers, [config('github', true)], new Set(['github'])).map((p) => p.service)).toEqual([
      'github'
    ])
  })
})

describe('parseWhitelist', () => {
  it("treats unset and '*' as no restriction", () => {
    expect(parseWhitelist(undefined)).toBeNull()
    expect(parseWhitelist('*')).toBeNull()
  })
  it('parses a comma list, trimming blanks', () => {
    expect(parseWhitelist('github, google ,, slack')).toEqual(new Set(['github', 'google', 'slack']))
  })
})

describe('composeProfileName', () => {
  it('prefixes the first 8 id chars and stays within open-connector 64-char limit', () => {
    const name = composeProfileName('clorg1234567890abcdef', 'cluser1234567890abcdef', 'my-conn')
    expect(name).toBe('clorg123--cluser12--my-conn')
    // Worst case: 8 + 2 + 8 + 2 + 32 = 52 ≤ 64.
    const max = composeProfileName('x'.repeat(30), 'y'.repeat(30), 'z'.repeat(32))
    expect(max.length).toBeLessThanOrEqual(64)
  })
})

describe('isValidConnectionName', () => {
  it('accepts alphanumeric-led names with _ and -, ≤32 chars', () => {
    expect(isValidConnectionName('prod_gmail-1')).toBe(true)
    expect(isValidConnectionName('a'.repeat(32))).toBe(true)
  })
  it('rejects empty, over-length, bad charset, or non-alphanumeric start', () => {
    expect(isValidConnectionName('')).toBe(false)
    expect(isValidConnectionName('a'.repeat(33))).toBe(false)
    expect(isValidConnectionName('has space')).toBe(false)
    expect(isValidConnectionName('_leading')).toBe(false)
  })
})
