import { describe, expect, it } from 'vitest'
import { SOCIAL_LOGIN_CATALOG, parseEnabledTargets, selectEnabledProviders } from './social-login-providers'

const targets = (raw: string | undefined) => selectEnabledProviders(raw).map((p) => p.target)

describe('social login provider selection', () => {
  it('keeps the original providers by default and requires an explicit wildcard for the whole catalog', () => {
    expect(parseEnabledTargets(undefined)).toEqual(new Set(['github', 'google', 'slack']))
    expect(targets(undefined)).toEqual(['github', 'google', 'slack'])
    expect(targets('*')).toEqual(SOCIAL_LOGIN_CATALOG.map((p) => p.target))
    expect(targets('   ')).toEqual(['github', 'google', 'slack'])
  })

  it('narrows to the configured targets, in catalog order', () => {
    // Order comes from the catalog, not from however the variable was written.
    expect(targets('slack,github')).toEqual(['github', 'slack'])
    expect(targets(' google , slack ')).toEqual(['google', 'slack'])
    expect(targets('feishu,lark')).toEqual(['lark', 'feishu'])
    expect(targets('github')).toEqual(['github'])
  })

  it('ignores targets it cannot render rather than rendering a blank button', () => {
    expect(targets('github,facebook')).toEqual(['github'])
  })

  it('falls back to the original providers when the setting names nothing usable', () => {
    // Leaving the sign-in page with zero ways in is worse than ignoring a typo.
    expect(targets('facebook')).toEqual(['github', 'google', 'slack'])
    expect(targets(',,')).toEqual(['github', 'google', 'slack'])
  })

  // The invariant this variable exists for: whatever the console offers must be
  // linkable. The CP deliberately does NOT re-derive this set -- it accepts any
  // connector slug and lets the tenant's connector list be the gate -- so no
  // second implementation of these rules can drift from these vectors.
  it.each(['github,google,slack', 'lark,feishu', 'slack', 'facebook', '', '*', 'github,facebook', undefined])(
    'only ever offers targets the catalog can render (%s)',
    (raw) => {
      const offered = selectEnabledProviders(raw).map((p) => p.target)
      const renderable = SOCIAL_LOGIN_CATALOG.map((p) => p.target)
      expect(offered.length).toBeGreaterThan(0)
      expect(offered.every((target) => renderable.includes(target))).toBe(true)
    }
  )
})
