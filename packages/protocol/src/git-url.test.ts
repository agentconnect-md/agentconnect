import { describe, it, expect } from 'vitest'
import { normalizeGitUrl, gitRepoLabel } from './git-url.js'

describe('normalizeGitUrl', () => {
  it('expands bare org/repo to a full GitHub https address', () => {
    expect(normalizeGitUrl('acme/infra')).toBe('https://github.com/acme/infra')
  })

  it('expands host-prefixed shorthand to https', () => {
    expect(normalizeGitUrl('github.com/acme/infra')).toBe('https://github.com/acme/infra')
    expect(normalizeGitUrl('gitlab.com/group/sub/repo')).toBe('https://gitlab.com/group/sub/repo')
  })

  it('passes full addresses through unchanged (idempotent)', () => {
    for (const url of [
      'https://github.com/acme/infra',
      'https://github.com/acme/infra.git',
      'ssh://git@github.com/acme/infra.git',
      'git://github.com/acme/infra.git',
      'git@github.com:acme/infra.git'
    ]) {
      expect(normalizeGitUrl(url)).toBe(url)
      expect(normalizeGitUrl(normalizeGitUrl(url))).toBe(normalizeGitUrl(url))
    }
  })

  it('trims whitespace and trailing slashes', () => {
    expect(normalizeGitUrl('  acme/infra/ ')).toBe('https://github.com/acme/infra')
  })

  it('leaves unrecognized inputs (single segment, empty) untouched', () => {
    expect(normalizeGitUrl('just-a-name')).toBe('just-a-name')
    expect(normalizeGitUrl('')).toBe('')
  })
})

describe('gitRepoLabel', () => {
  it('shortens https addresses to org/repo', () => {
    expect(gitRepoLabel('https://github.com/acme/infra')).toBe('acme/infra')
    expect(gitRepoLabel('https://github.com/acme/infra.git')).toBe('acme/infra')
  })

  it('shortens scp-like ssh addresses', () => {
    expect(gitRepoLabel('git@github.com:acme/infra.git')).toBe('acme/infra')
  })

  it('shortens ssh:// addresses', () => {
    expect(gitRepoLabel('ssh://git@github.com/acme/infra.git')).toBe('acme/infra')
  })

  it('shortens host-prefixed shorthand', () => {
    expect(gitRepoLabel('github.com/acme/infra')).toBe('acme/infra')
  })

  it('keeps an already-short org/repo unchanged', () => {
    expect(gitRepoLabel('acme/infra')).toBe('acme/infra')
  })

  it('round-trips normalize → label back to the short form', () => {
    expect(gitRepoLabel(normalizeGitUrl('acme/infra'))).toBe('acme/infra')
  })
})
