/** The version floor (gitea-integration.md §3): Gitea 1.23 or Forgejo 15, read per product, unreadable fails closed. */
import { describe, expect, it } from 'vitest'
import { GITEA_VERSION_REQUIREMENT, parseGiteaVersion } from './version.js'

describe('parseGiteaVersion', () => {
  it('names both floors operators read', () => {
    expect(GITEA_VERSION_REQUIREMENT).toBe('Gitea 1.23 or later, or Forgejo 15.0 or later')
  })

  it('accepts the Gitea floor, a later minor, a development build and a later major', () => {
    expect(parseGiteaVersion('1.23.0')).toMatchObject({ product: 'gitea', major: 1, minor: 23, supported: true })
    expect(parseGiteaVersion('1.27.3')).toMatchObject({ product: 'gitea', major: 1, minor: 27, supported: true })
    expect(parseGiteaVersion('1.27.0+dev')).toMatchObject({ product: 'gitea', major: 1, minor: 27, supported: true })
    expect(parseGiteaVersion('v2.0.0')).toMatchObject({ product: 'gitea', major: 2, minor: 0, supported: true })
  })

  it('refuses a Gitea release below the floor', () => {
    expect(parseGiteaVersion('1.22.6')).toMatchObject({ product: 'gitea', floor: '1.23', supported: false })
    expect(parseGiteaVersion('1.9.0').supported).toBe(false)
  })

  it('reads Forgejo by its own version against its own floor, whatever its compatibility marker says', () => {
    // Forgejo pins the marker at gitea-1.22.0 on every release (§3), so only the leading number moves.
    expect(parseGiteaVersion('15.0.9+gitea-1.22.0')).toMatchObject({
      product: 'forgejo',
      major: 15,
      minor: 0,
      floor: '15.0',
      supported: true
    })
    expect(parseGiteaVersion('16.0.3+gitea-1.22.0')).toMatchObject({ product: 'forgejo', major: 16, supported: true })
    expect(parseGiteaVersion('14.0.2+gitea-1.22.0')).toMatchObject({
      product: 'forgejo',
      floor: '15.0',
      supported: false
    })
    expect(parseGiteaVersion('11.0.1+gitea-1.22.0').supported).toBe(false)
    // Forgejo before v7 versioned as 1.x and falls below its floor.
    expect(parseGiteaVersion('1.21.11-1+gitea-1.21.11')).toMatchObject({ product: 'forgejo', supported: false })
  })

  it('fails closed on an unreadable or absent string', () => {
    expect(parseGiteaVersion('')).toEqual({
      raw: '',
      product: 'gitea',
      major: null,
      minor: null,
      floor: '1.23',
      supported: false
    })
    expect(parseGiteaVersion('latest').supported).toBe(false)
    expect(parseGiteaVersion('+gitea-1.22.0')).toMatchObject({ product: 'forgejo', supported: false })
    expect(parseGiteaVersion(undefined).supported).toBe(false)
    expect(parseGiteaVersion(null).raw).toBe('')
  })
})
