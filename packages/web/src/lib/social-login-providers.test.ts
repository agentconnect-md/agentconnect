import { describe, expect, it } from 'vitest'
import { SOCIAL_LOGIN_CATALOG, parseEnabledTargets, selectEnabledProviders } from './social-login-providers'

const targets = (raw: string | undefined) => selectEnabledProviders(raw).map((p) => p.target)

describe('social login provider selection', () => {
  it('offers the whole catalog when nothing is configured', () => {
    // The OSS default: a deployment that says nothing gets today's behavior.
    expect(parseEnabledTargets(undefined)).toBeNull()
    expect(targets(undefined)).toEqual(SOCIAL_LOGIN_CATALOG.map((p) => p.target))
    expect(targets('*')).toEqual(SOCIAL_LOGIN_CATALOG.map((p) => p.target))
    expect(targets('   ')).toEqual(SOCIAL_LOGIN_CATALOG.map((p) => p.target))
  })

  it('narrows to the configured targets, in catalog order', () => {
    // Order comes from the catalog, not from however the variable was written.
    expect(targets('slack,github')).toEqual(['github', 'slack'])
    expect(targets(' google , slack ')).toEqual(['google', 'slack'])
    expect(targets('github')).toEqual(['github'])
  })

  it('ignores targets it cannot render rather than rendering a blank button', () => {
    expect(targets('github,facebook')).toEqual(['github'])
  })

  it('falls back to the catalog when the setting names nothing usable', () => {
    // Leaving the sign-in page with zero ways in is worse than ignoring a typo.
    expect(targets('facebook')).toEqual(SOCIAL_LOGIN_CATALOG.map((p) => p.target))
    expect(targets(',,')).toEqual(SOCIAL_LOGIN_CATALOG.map((p) => p.target))
  })
})
