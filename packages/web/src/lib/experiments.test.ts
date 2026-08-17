// @vitest-environment happy-dom
// The parse is the whole contract: what a deployment writes decides what its console shows.
import { describe, expect, it, afterEach } from 'vitest'
import { experimentEnabled } from './experiments'

const setEnv = (value?: string) => {
  ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV =
    value === undefined ? {} : { EXPERIMENTS: value }
}

afterEach(() => setEnv())

describe('experimentEnabled', () => {
  it('is off unless the deployment asks for it', () => {
    // A new experiment shipping ON is the failure mode this prevents: every environment would
    // get it the moment it merged.
    setEnv()
    expect(experimentEnabled('daemon-groups')).toBe(false)
    setEnv('')
    expect(experimentEnabled('daemon-groups')).toBe(false)
  })

  it('reads a comma-separated list, tolerating spacing and case', () => {
    setEnv(' Daemon-Groups , something-else ')
    expect(experimentEnabled('daemon-groups')).toBe(true)
  })

  it('ignores ids it does not know', () => {
    setEnv('not-a-feature')
    expect(experimentEnabled('daemon-groups')).toBe(false)
  })

  it('server and client read the same value, so the gate cannot differ across hydration', () => {
    // `public-env` injects plain `EXPERIMENTS`; a server branch reading only the build-time twin
    // would render the surface off and hydrate it on.
    const original = (window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV
    delete (window as unknown as { __AC_ENV?: unknown }).__AC_ENV
    process.env.EXPERIMENTS = 'daemon-groups'
    try {
      // The browser branch, with nothing injected: off, because there is nothing to read.
      expect(experimentEnabled('daemon-groups')).toBe(false)
      // And injected, it is the source both sides agree on.
      ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV = { EXPERIMENTS: 'daemon-groups' }
      expect(experimentEnabled('daemon-groups')).toBe(true)
    } finally {
      delete process.env.EXPERIMENTS
      ;(window as unknown as { __AC_ENV?: unknown }).__AC_ENV = original
    }
  })
})
