import { describe, it, expect } from 'vitest'
import { isOlderVersion } from './semver.js'

describe('isOlderVersion', () => {
  it('orders release and prerelease versions by semver precedence', () => {
    expect(isOlderVersion('1.40.2', '1.41.0')).toBe(true)
    expect(isOlderVersion('1.9.0', '1.10.0')).toBe(true)
    expect(isOlderVersion('1.41.0-rc.1', '1.41.0')).toBe(true)
    expect(isOlderVersion('1.41.0-rc.2', '1.41.0-rc.10')).toBe(true)
    expect(isOlderVersion('1.41.0', '1.41.0')).toBe(false)
    expect(isOlderVersion('1.41.0', '1.41.0-rc.3')).toBe(false)
    expect(isOlderVersion('1.42.0', '1.41.0')).toBe(false)
  })

  it('is false when either side does not parse', () => {
    expect(isOlderVersion('1.0.0', null)).toBe(false)
    expect(isOlderVersion('dev', '1.0.0')).toBe(false)
  })
})
