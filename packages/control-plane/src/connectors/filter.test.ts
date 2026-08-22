import { describe, expect, it } from 'vitest'
import {
  composeProfileName,
  filterCatalog,
  isValidConnectionName,
  parseBlocklist,
  parseWhitelist,
  PROFILE_HASH_LEN,
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

    const kept = filterCatalog(providers, configs, null, new Set())
    expect(kept.map((p) => p.service)).toEqual(['github', 'stripe'])
    expect(kept.every((p) => p.actions === undefined)).toBe(true)
  })

  it('keeps a non-oauth provider even with no oauth config', () => {
    expect(filterCatalog([provider('stripe', { oauth: false })], [], null, new Set()).map((p) => p.service)).toEqual([
      'stripe'
    ])
  })

  it('keeps a dual provider but strips the oauth2 method when its secret is unconfigured', () => {
    const kept = filterCatalog([dualProvider('linear')], [config('linear', false)], null, new Set())
    expect(kept.map((p) => p.service)).toEqual(['linear'])
    expect(kept[0]!.auth.map((a) => a.type)).toEqual(['api_key'])
    expect(kept[0]!.authTypes).toEqual(['api_key'])
  })

  it('keeps both methods on a dual provider when oauth IS configured', () => {
    const kept = filterCatalog([dualProvider('linear')], [config('linear', true)], null, new Set())
    expect(kept[0]!.auth.map((a) => a.type)).toEqual(['oauth2', 'api_key'])
    expect(kept[0]!.authTypes).toEqual(['oauth2', 'api_key'])
  })

  it('applies the whitelist', () => {
    const providers = [provider('github'), provider('stripe', { oauth: false })]
    expect(
      filterCatalog(providers, [config('github', true)], new Set(['github']), new Set()).map((p) => p.service)
    ).toEqual(['github'])
  })

  it('applies the blocklist after the whitelist', () => {
    const providers = [provider('github'), provider('stripe', { oauth: false })]
    expect(
      filterCatalog(providers, [config('github', true)], new Set(['github', 'stripe']), new Set(['github'])).map(
        (p) => p.service
      )
    ).toEqual(['stripe'])
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

describe('parseBlocklist', () => {
  it('parses exact service ids and treats blank input as no exclusions', () => {
    expect(parseBlocklist(undefined)).toEqual(new Set())
    expect(parseBlocklist('github, telegram ,, feishu_app_bot')).toEqual(
      new Set(['github', 'telegram', 'feishu_app_bot'])
    )
  })
})

describe('composeProfileName', () => {
  it('hashes each id to a fixed-width segment and keeps the connection name verbatim', () => {
    const name = composeProfileName('clorg1234567890abcdef', 'cluser1234567890abcdef', 'my-conn')
    const [org, user, conn] = name.split('--')
    expect(org).toHaveLength(PROFILE_HASH_LEN)
    expect(user).toHaveLength(PROFILE_HASH_LEN)
    expect(conn).toBe('my-conn')
    expect(composeProfileName('clorg1234567890abcdef', 'cluser1234567890abcdef', 'my-conn')).toBe(name)
  })

  it('stays within open-connector 64-char limit at the longest legal connection name', () => {
    // Worst case: 13 + 2 + 13 + 2 + 32 = 62 ≤ 64.
    const max = composeProfileName('x'.repeat(30), 'y'.repeat(30), 'z'.repeat(32))
    expect(max.length).toBe(62)
    expect(max.length).toBeLessThanOrEqual(64)
  })

  it('composes a name open-connector accepts — its charset, alphanumeric-led, ≤64', () => {
    // Fixed-width base36 is [0-9a-z], so no digest can start the profile with _ or -.
    for (let i = 0; i < 200; i++) {
      const profile = composeProfileName(`c${i}org`, `c${i}user`, 'prod_gmail-1')
      expect(profile).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
    }
  })

  it('separates ids that shared a truncated cuid prefix (the collision this replaced)', () => {
    // Two orgs created in the same ~36ms bucket, whose creating users also were, both
    // naming a connection "gmail": identical under `<id[0..8]>`, so one org's saved
    // credential overwrote the other's and its agents then ran actions as that org.
    const truncated = (o: string, u: string, n: string) => `${o.slice(0, 8)}--${u.slice(0, 8)}--${n}`
    const a = ['clzzzzzzAAAAAAA', 'clyyyyyyBBBBBBB', 'gmail'] as const
    const b = ['clzzzzzzCCCCCCC', 'clyyyyyyDDDDDDD', 'gmail'] as const
    expect(truncated(...a)).toBe(truncated(...b))
    expect(composeProfileName(...a)).not.toBe(composeProfileName(...b))
  })

  it('domain-separates the org and user segments', () => {
    const [org, user] = composeProfileName('same-id', 'same-id', 'c').split('--')
    expect(org).not.toBe(user)
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
