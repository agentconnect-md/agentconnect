import { describe, it, expect } from 'vitest'
import { readPackageVersion, releaseTag } from './package-version.js'

describe('releaseTag', () => {
  it('names the release an image was built from, formal or candidate', () => {
    expect(releaseTag('1.60.0')).toBe('v1.60.0')
    expect(releaseTag('1.61.0-rc.167')).toBe('v1.61.0-rc.167')
  })

  it('names no release for a checkout, whose manifest carries the dev version', () => {
    expect(releaseTag('1.0.0-dev')).toBeUndefined()
    expect(releaseTag(undefined)).toBeUndefined()
    expect(releaseTag(readPackageVersion())).toBeUndefined()
  })
})
