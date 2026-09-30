import { describe, expect, it } from 'vitest'
import { parseGitlabVersion } from './version.js'

describe('GitLab signed webhook and service account requirements', () => {
  it.each([
    ['18.11.0-ee', false],
    ['19.0.0-ee', false],
    ['19.1.0', true],
    ['19.1.0-ee', true],
    ['19.1.0-ee-something', true],
    ['19.1.0-eex', true],
    [' 20.0.1-ee ', true]
  ])('checks the signed webhook version floor for %s', (version, supported) => {
    expect(parseGitlabVersion(version).supported).toBe(supported)
  })

  it('records the reported version and edition', () => {
    expect(parseGitlabVersion(' 19.1.0-ee ')).toEqual({
      raw: '19.1.0-ee',
      major: 19,
      minor: 1,
      enterprise: true,
      supported: true
    })
  })

  it('fails closed when the version is unreadable', () => {
    for (const version of [undefined, null, '', '19', 'v19.1.0-ee', 'garbage-ee']) {
      expect(parseGitlabVersion(version)).toMatchObject({ major: null, minor: null, supported: false })
    }
  })
})
