// @vitest-environment happy-dom
// The parse is the whole contract: what a deployment writes decides what its console shows.
import { describe, expect, it, afterEach } from 'vitest'
import { featureFlagEnabled } from './feature-flags'

const setEnv = (value?: string) => {
  ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV =
    value === undefined ? {} : { FEATURE_FLAGS: value }
}

afterEach(() => setEnv())

describe('featureFlagEnabled', () => {
  it('is off unless the deployment asks for it', () => {
    // A new flag must stay off until the deployment enables it.
    setEnv()
    expect(featureFlagEnabled('billing')).toBe(false)
    expect(featureFlagEnabled('daemon-pool')).toBe(false)
    // `managed` off is the SELF-HOSTED reading, which is what an unconfigured install is.
    expect(featureFlagEnabled('managed')).toBe(false)
    setEnv('')
    expect(featureFlagEnabled('billing')).toBe(false)
    expect(featureFlagEnabled('daemon-pool')).toBe(false)
  })

  it('switches each flag on its own', () => {
    // Enabling the pool does not enable billing or managed-cloud presentation.
    setEnv('daemon-pool')
    expect(featureFlagEnabled('daemon-pool')).toBe(true)
    expect(featureFlagEnabled('billing')).toBe(false)
    setEnv('billing,daemon-pool')
    expect(featureFlagEnabled('daemon-pool')).toBe(true)
    expect(featureFlagEnabled('billing')).toBe(true)
    // The pool can be offered without being AgentConnect's: that pair is the self-hoster.
    expect(featureFlagEnabled('managed')).toBe(false)
    setEnv('daemon-pool,managed')
    expect(featureFlagEnabled('managed')).toBe(true)
  })

  it('reads a comma-separated list, tolerating spacing and case', () => {
    setEnv(' Billing , something-else ')
    expect(featureFlagEnabled('billing')).toBe(true)
  })

  it('ignores ids it does not know', () => {
    setEnv('not-a-feature')
    expect(featureFlagEnabled('billing')).toBe(false)
  })

  it('server and client read the same value, so the gate cannot differ across hydration', () => {
    // The browser reads injected FEATURE_FLAGS rather than the server's environment.
    const original = (window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV
    delete (window as unknown as { __AC_ENV?: unknown }).__AC_ENV
    process.env.FEATURE_FLAGS = 'billing'
    try {
      // The browser branch, with nothing injected: off, because there is nothing to read.
      expect(featureFlagEnabled('billing')).toBe(false)
      // And injected, it is the source both sides agree on.
      ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV = { FEATURE_FLAGS: 'billing' }
      expect(featureFlagEnabled('billing')).toBe(true)
    } finally {
      delete process.env.FEATURE_FLAGS
      ;(window as unknown as { __AC_ENV?: unknown }).__AC_ENV = original
    }
  })
})
