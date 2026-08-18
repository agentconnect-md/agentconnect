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
    // A new flag shipping ON is the failure mode this prevents: every environment would
    // get it the moment it merged.
    setEnv()
    expect(featureFlagEnabled('daemon-groups')).toBe(false)
    expect(featureFlagEnabled('daemon-pool')).toBe(false)
    // `managed` off is the SELF-HOSTED reading, which is what an unconfigured install is.
    expect(featureFlagEnabled('managed')).toBe(false)
    setEnv('')
    expect(featureFlagEnabled('daemon-groups')).toBe(false)
    expect(featureFlagEnabled('daemon-pool')).toBe(false)
  })

  it('switches each flag on its own', () => {
    // One id in the list turns on THAT surface — groups and the pool ship and roll out apart.
    setEnv('daemon-pool')
    expect(featureFlagEnabled('daemon-pool')).toBe(true)
    expect(featureFlagEnabled('daemon-groups')).toBe(false)
    setEnv('daemon-groups,daemon-pool')
    expect(featureFlagEnabled('daemon-pool')).toBe(true)
    expect(featureFlagEnabled('daemon-groups')).toBe(true)
    // The pool can be offered without being AgentConnect's: that pair is the self-hoster.
    expect(featureFlagEnabled('managed')).toBe(false)
    setEnv('daemon-pool,managed')
    expect(featureFlagEnabled('managed')).toBe(true)
  })

  it('reads a comma-separated list, tolerating spacing and case', () => {
    setEnv(' Daemon-Groups , something-else ')
    expect(featureFlagEnabled('daemon-groups')).toBe(true)
  })

  it('ignores ids it does not know', () => {
    setEnv('not-a-feature')
    expect(featureFlagEnabled('daemon-groups')).toBe(false)
  })

  it('server and client read the same value, so the gate cannot differ across hydration', () => {
    // `public-env` injects plain `FEATURE_FLAGS`; a server branch reading only the build-time twin
    // would render the surface off and hydrate it on.
    const original = (window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV
    delete (window as unknown as { __AC_ENV?: unknown }).__AC_ENV
    process.env.FEATURE_FLAGS = 'daemon-groups'
    try {
      // The browser branch, with nothing injected: off, because there is nothing to read.
      expect(featureFlagEnabled('daemon-groups')).toBe(false)
      // And injected, it is the source both sides agree on.
      ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV = { FEATURE_FLAGS: 'daemon-groups' }
      expect(featureFlagEnabled('daemon-groups')).toBe(true)
    } finally {
      delete process.env.FEATURE_FLAGS
      ;(window as unknown as { __AC_ENV?: unknown }).__AC_ENV = original
    }
  })
})
