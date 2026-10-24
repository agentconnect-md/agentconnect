import { describe, it, expect } from 'vitest'
import { cliChannel, computerImage, readPackageVersion, releaseTag } from './package-version.js'

describe('releaseTag', () => {
  it('names the release an image was built from, formal or candidate', () => {
    expect(releaseTag('1.60.0')).toBe('v1.60.0')
    expect(releaseTag('1.61.0-rc.167')).toBe('v1.61.0-rc.167')
  })

  it('names no release for a checkout, whose manifest carries the dev version', () => {
    expect(releaseTag('2.0.0-dev')).toBeUndefined()
    expect(releaseTag(undefined)).toBeUndefined()
    expect(releaseTag(readPackageVersion())).toBeUndefined()
  })
})

describe('cliChannel', () => {
  it('follows the release channel, and rc from a checkout', () => {
    expect(cliChannel('v2.6.0')).toBe('stable')
    expect(cliChannel('v2.6.0-rc.57')).toBe('rc')
    expect(cliChannel(undefined)).toBe('rc')
  })
})

describe('computerImage', () => {
  it('pins the desktop image to the release this CP was built from, and to latest from a checkout', () => {
    expect(computerImage(undefined, 'v2.6.0')).toBe('ghcr.io/agentconnect-md/computer:v2.6.0')
    expect(computerImage(undefined)).toBe('ghcr.io/agentconnect-md/computer:latest')
    expect(computerImage('registry.example.com/computer:v2.6.0', 'v2.7.0')).toBe('registry.example.com/computer:v2.6.0')
  })
})
