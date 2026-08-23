import { describe, expect, it } from 'vitest'
import {
  GITLAB_MINIMUM_VERSION,
  GITLAB_MINIMUM_VERSION_LABEL,
  INSTANCE_VERSION_UNSUPPORTED_REASON,
  parseGitlabVersion
} from './version.js'

describe('the GitLab version floor (§24.2)', () => {
  it('is 18.11, where group service accounts reached every tier', () => {
    expect(GITLAB_MINIMUM_VERSION).toEqual({ major: 18, minor: 11 })
    expect(GITLAB_MINIMUM_VERSION_LABEL).toBe('18.11')
    expect(INSTANCE_VERSION_UNSUPPORTED_REASON).toBe('instance_version_unsupported')
  })

  it('reads MAJOR.MINOR through the build suffixes GitLab actually reports', () => {
    expect(parseGitlabVersion('18.11.0-ee')).toEqual({
      raw: '18.11.0-ee',
      major: 18,
      minor: 11,
      enterprise: true,
      supported: true
    })
    // Community Edition at the floor is in the contract: service accounts are
    // generally available on every tier there, which is why the floor is 18.11.
    expect(parseGitlabVersion('18.11.0')).toMatchObject({ major: 18, minor: 11, enterprise: false, supported: true })
    expect(parseGitlabVersion('18.11.0-pre')).toMatchObject({ minor: 11, enterprise: false, supported: true })
    expect(parseGitlabVersion('19.0.0-ee')).toMatchObject({ major: 19, minor: 0, enterprise: true, supported: true })
    expect(parseGitlabVersion('  18.12.1-rc42  ')).toMatchObject({ raw: '18.12.1-rc42', supported: true })
    // Two-component and four-component strings are both readable as MAJOR.MINOR.
    expect(parseGitlabVersion('18.11')).toMatchObject({ major: 18, minor: 11, supported: true })
    expect(parseGitlabVersion('18.11.0.1-ee')).toMatchObject({ major: 18, minor: 11, supported: true })
  })

  it('refuses the versions below the floor, on either component', () => {
    expect(parseGitlabVersion('18.10.9-ee')).toMatchObject({ major: 18, minor: 10, supported: false })
    expect(parseGitlabVersion('18.0.0')).toMatchObject({ supported: false })
    expect(parseGitlabVersion('17.99.0-ee')).toMatchObject({ major: 17, minor: 99, supported: false })
    // A larger MINOR never rescues a smaller MAJOR.
    expect(parseGitlabVersion('9.999.0')).toMatchObject({ supported: false })
  })

  it('fails closed on anything it cannot read as a version', () => {
    for (const garbage of ['', '   ', 'v18.11.0', '18', '18.', 'eighteen.eleven', 'null', '18-11', '.18.11']) {
      const parsed = parseGitlabVersion(garbage)
      expect(parsed.major).toBeNull()
      expect(parsed.minor).toBeNull()
      expect(parsed.supported).toBe(false)
    }
    // An instance that says nothing at all is below the floor, not unknown.
    expect(parseGitlabVersion(undefined)).toMatchObject({ raw: '', supported: false })
    expect(parseGitlabVersion(null)).toMatchObject({ raw: '', supported: false })
  })

  it('keeps the edition reading independent of whether the version parsed', () => {
    expect(parseGitlabVersion('garbage-ee ')).toMatchObject({ enterprise: true, supported: false })
    expect(parseGitlabVersion('18.11.0-eex')).toMatchObject({ enterprise: false, supported: true })
  })
})
