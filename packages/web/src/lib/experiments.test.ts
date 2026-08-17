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
})
