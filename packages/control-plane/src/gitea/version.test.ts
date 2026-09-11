/** The 1.23 floor (gitea-integration.md §3): read from the front, a compatibility marker first, unreadable fails closed. */
import { describe, expect, it } from 'vitest'
import { GITEA_MINIMUM_VERSION_LABEL, parseGiteaVersion } from './version.js'

describe('parseGiteaVersion', () => {
  it('names the floor operators read', () => {
    expect(GITEA_MINIMUM_VERSION_LABEL).toBe('1.23')
  })

  it('accepts the floor, a later minor, a development build and a later major', () => {
    expect(parseGiteaVersion('1.23.0')).toMatchObject({ major: 1, minor: 23, supported: true })
    expect(parseGiteaVersion('1.27.3')).toMatchObject({ major: 1, minor: 27, supported: true })
    expect(parseGiteaVersion('1.27.0+dev')).toMatchObject({ major: 1, minor: 27, supported: true })
    expect(parseGiteaVersion('v2.0.0')).toMatchObject({ major: 2, minor: 0, supported: true })
  })

  it('refuses a release below the floor', () => {
    expect(parseGiteaVersion('1.22.6').supported).toBe(false)
    expect(parseGiteaVersion('1.9.0').supported).toBe(false)
  })

  it('reads a fork by its Gitea compatibility marker, not by its own leading number', () => {
    // Forgejo reports its own major first; the marker is what it can actually serve (§3).
    expect(parseGiteaVersion('11.0.0+gitea-1.22.0')).toMatchObject({ major: 1, minor: 22, supported: false })
    expect(parseGiteaVersion('12.0.0+gitea-1.23.0')).toMatchObject({ major: 1, minor: 23, supported: true })
  })

  it('fails closed on an unreadable or absent string', () => {
    expect(parseGiteaVersion('')).toEqual({ raw: '', major: null, minor: null, supported: false })
    expect(parseGiteaVersion('latest').supported).toBe(false)
    expect(parseGiteaVersion(undefined).supported).toBe(false)
    expect(parseGiteaVersion(null).raw).toBe('')
  })
})
