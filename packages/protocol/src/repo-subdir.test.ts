import { describe, expect, it } from 'vitest'
import { MAX_REPO_SUBDIR_LENGTH, RepoSubdirError, normalizeRepoSubdir } from './repo-subdir.js'

describe('normalizeRepoSubdir', () => {
  it.each([undefined, null, '', '   ', '/', '.', './'])('maps root sentinel %j to repository root', (value) => {
    expect(normalizeRepoSubdir(value)).toBeUndefined()
  })

  it('normalizes a repository-relative directory', () => {
    expect(normalizeRepoSubdir(' ./services/api ')).toBe('services/api')
  })

  it.each([
    '/services/api',
    'C:/services/api',
    'services\\api',
    '../services',
    'services/../api',
    'services/./api',
    'services//api',
    'services/\u0000api',
    'services/\u001fapi',
    'services/\u007fapi'
  ])('rejects unsafe path %j', (value) => {
    expect(() => normalizeRepoSubdir(value)).toThrow(RepoSubdirError)
  })

  it('enforces the normalized length limit', () => {
    expect(normalizeRepoSubdir('a'.repeat(MAX_REPO_SUBDIR_LENGTH))).toHaveLength(MAX_REPO_SUBDIR_LENGTH)
    expect(() => normalizeRepoSubdir('a'.repeat(MAX_REPO_SUBDIR_LENGTH + 1))).toThrow(RepoSubdirError)
  })
})
