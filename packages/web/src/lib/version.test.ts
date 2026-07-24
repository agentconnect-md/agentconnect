import { describe, it, expect } from 'vitest'
import { isUpgradeAvailable } from './version'

describe('isUpgradeAvailable', () => {
  it('flags a newer stable release', () => {
    expect(isUpgradeAvailable('1.2.3', '1.2.4')).toBe(true)
    expect(isUpgradeAvailable('1.2.3', '1.3.0')).toBe(true)
    expect(isUpgradeAvailable('1.2.3', '2.0.0')).toBe(true)
  })

  it('is false when already current or ahead', () => {
    expect(isUpgradeAvailable('1.2.3', '1.2.3')).toBe(false)
    expect(isUpgradeAvailable('1.3.0', '1.2.9')).toBe(false)
    expect(isUpgradeAvailable('2.0.0', '1.9.9')).toBe(false)
  })

  it('orders prereleases within a channel', () => {
    expect(isUpgradeAvailable('1.5.0-rc.1', '1.5.0-rc.2')).toBe(true)
    expect(isUpgradeAvailable('1.5.0-rc.2', '1.5.0-rc.1')).toBe(false)
    // Numeric identifiers rank below alphanumeric; more identifiers win when a prefix matches.
    expect(isUpgradeAvailable('1.5.0-rc.2', '1.5.0-rc.2.1')).toBe(true)
  })

  it('treats a stable release as newer than its prerelease', () => {
    expect(isUpgradeAvailable('1.5.0-rc.9', '1.5.0')).toBe(true)
    expect(isUpgradeAvailable('1.5.0', '1.5.0-rc.9')).toBe(false)
  })

  it('tolerates a leading v', () => {
    expect(isUpgradeAvailable('v1.2.3', 'v1.2.4')).toBe(true)
    expect(isUpgradeAvailable('1.2.3', 'v1.2.3')).toBe(false)
  })

  it('never nags on missing / unparseable versions', () => {
    expect(isUpgradeAvailable(null, '1.2.3')).toBe(false)
    expect(isUpgradeAvailable('1.2.3', null)).toBe(false)
    expect(isUpgradeAvailable('—', '1.2.3')).toBe(false)
    expect(isUpgradeAvailable('dev', '1.2.3')).toBe(false)
    expect(isUpgradeAvailable('1.0', '1.2.3')).toBe(false)
    expect(isUpgradeAvailable('', '')).toBe(false)
  })

  it('recognizes a dev prerelease as behind a published stable', () => {
    // The in-repo daemon reports `1.0.0-dev`; a published `latest` is genuinely ahead.
    expect(isUpgradeAvailable('1.0.0-dev', '1.2.3')).toBe(true)
  })
})
