import { describe, it, expect } from 'vitest'
import { isSyntheticEmail, SYNTHETIC_EMAIL_SUFFIX } from './ports.js'

describe('isSyntheticEmail', () => {
  it('flags a synthesized placeholder address', () => {
    expect(isSyntheticEmail(`zcsi1pujg2kv${SYNTHETIC_EMAIL_SUFFIX}`)).toBe(true)
    expect(isSyntheticEmail('anything@oidc.local')).toBe(true)
  })

  it('does not flag real emails or empty values', () => {
    expect(isSyntheticEmail('dana@acme.com')).toBe(false)
    expect(isSyntheticEmail('')).toBe(false)
    expect(isSyntheticEmail(null)).toBe(false)
    expect(isSyntheticEmail(undefined)).toBe(false)
  })
})
