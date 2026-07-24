import { describe, it, expect } from 'vitest'
import {
  DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS,
  GitCloneUrlError,
  normalizeAllowedWorkspaceGitUrl,
  normalizeGitCloneUrl,
  normalizeGithubRepoUrl,
  normalizeGitUrl,
  normalizeWorkspaceGitOrigin,
  redactGitUrlSecrets,
  gitRepoLabel,
  workspaceGitOriginOf
} from './git-url.js'

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

describe('normalizeGitCloneUrl', () => {
  it('normalizes GitHub and public-host shorthand', () => {
    expect(normalizeGitCloneUrl('acme/infra')).toBe('https://github.com/acme/infra')
    expect(normalizeGitCloneUrl('github.com/acme/infra')).toBe('https://github.com/acme/infra')
    expect(normalizeGitCloneUrl('gitlab.com/group/sub/repo')).toBe('https://gitlab.com/group/sub/repo')
  })

  it('accepts credential-free HTTPS and SSH remotes', () => {
    for (const url of [
      'https://gitlab.com/group/sub/repo.git',
      'ssh://git@github.com/acme/infra.git',
      'git@github.com:acme/infra.git'
    ]) {
      expect(normalizeGitCloneUrl(url)).toBe(url)
    }
  })

  it('rejects local, option-like, malformed, and control-character targets', () => {
    for (const url of [
      '',
      'repo',
      '/tmp/repo',
      './repo',
      '../repo',
      '~/repo',
      '-uploader',
      'acme/\ninfra',
      'https://good.example\\user:token@127.0.0.1/repo'
    ]) {
      expect(() => normalizeGitCloneUrl(url), url).toThrow(GitCloneUrlError)
    }
  })

  it('rejects unsafe and unsupported transports', () => {
    for (const url of [
      'http://github.com/acme/infra',
      'file:///tmp/repo',
      'git://github.com/acme/infra',
      'ext::sh -c id',
      'ftp://example.com/acme/infra'
    ]) {
      expect(() => normalizeGitCloneUrl(url), url).toThrow(GitCloneUrlError)
    }
  })

  it('rejects credentials, passwords, queries, and fragments', () => {
    for (const url of [
      'https://user@github.com/acme/infra',
      'https://user:token@github.com/acme/infra',
      'ssh://git:secret@github.com/acme/infra',
      'https://github.com/acme/infra?token=secret',
      'ssh://git@github.com/acme/infra#main',
      'https://github.com/acme/infra?',
      'ssh://git@github.com/acme/infra#'
    ]) {
      expect(() => normalizeGitCloneUrl(url), url).toThrow(GitCloneUrlError)
    }
  })
})

describe('workspace git origin policy', () => {
  it('canonicalizes exact HTTPS, SSH, and scp-style origins', () => {
    expect(normalizeWorkspaceGitOrigin('HTTPS://GitHub.COM.:443/')).toBe('https://github.com')
    expect(normalizeWorkspaceGitOrigin('ssh://GIT.EXAMPLE.:22')).toBe('ssh://git.example')
    expect(workspaceGitOriginOf('git@github.com:acme/infra.git')).toBe('ssh://github.com')
    expect(workspaceGitOriginOf('ssh://git@git.example:2222/acme/infra.git')).toBe('ssh://git.example:2222')
  })

  it('requires an exact allowed scheme, host, and port', () => {
    expect(normalizeAllowedWorkspaceGitUrl('acme/infra', DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS)).toBe(
      'https://github.com/acme/infra'
    )
    expect(
      normalizeAllowedWorkspaceGitUrl('git@github.com:acme/infra.git', DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS)
    ).toBe('git@github.com:acme/infra.git')

    for (const url of [
      'https://gitlab.com/group/repo',
      'https://github.com.evil.example/acme/infra',
      'https://github.com:8443/acme/infra',
      'ssh://git@github.com:2222/acme/infra'
    ]) {
      expect(() => normalizeAllowedWorkspaceGitUrl(url, DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS), url).toThrow(
        'git clone origin is not allowed'
      )
    }
  })

  it('rejects ambiguous allowlist entries', () => {
    for (const origin of [
      'https://*.example.com',
      'https://user@git.example',
      'https://@git.example',
      'https://git.example/group',
      'https://git.example/./',
      'https://git.example?target=other',
      'https://git.example?',
      'https://git.example#',
      'git.example'
    ]) {
      expect(() => normalizeWorkspaceGitOrigin(origin), origin).toThrow(GitCloneUrlError)
    }
  })
})

describe('redactGitUrlSecrets', () => {
  it('normalizes shorthand and removes URL secrets', () => {
    expect(redactGitUrlSecrets('acme/infra')).toBe('https://github.com/acme/infra')
    expect(redactGitUrlSecrets('https://user:token@github.com/acme/infra.git?token=secret#main')).toBe(
      'https://github.com/acme/infra.git'
    )
    expect(redactGitUrlSecrets('ftp://user:token@example.com/acme/infra?token=secret')).toBe(
      'ftp://example.com/acme/infra'
    )
  })

  it('keeps SSH and scp usernames while removing secret-bearing suffixes', () => {
    expect(redactGitUrlSecrets('ssh://git:secret@github.com/acme/infra.git?token=secret#main')).toBe(
      'ssh://git@github.com/acme/infra.git'
    )
    expect(redactGitUrlSecrets('git@github.com:acme/infra.git?token=secret#main')).toBe('git@github.com:acme/infra.git')
  })

  it('redacts ambiguous backslash authority credentials without leaking them as path text', () => {
    const redacted = redactGitUrlSecrets('https://good.example\\user:token@127.0.0.1/repo')
    expect(redacted).toBe('https://127.0.0.1/repo')
    expect(redacted).not.toContain('token')
    expect(redacted).not.toContain('good.example')
  })

  it('quarantines ambiguous malformed userinfo without changing a valid query URL host', () => {
    expect(redactGitUrlSecrets('https://user:secret?@host.example/repo')).toBe('https://')
    expect(redactGitUrlSecrets('https://user:secret#@host.example/repo')).toBe('https://')
    expect(redactGitUrlSecrets('https://example.com?ref=@evil.test/owner/repo')).toBe('https://example.com')
  })

  it('never throws for malformed or empty historical values', () => {
    expect(redactGitUrlSecrets('')).toBe('')
    expect(redactGitUrlSecrets('not a url')).toBe('not a url')
    expect(() => redactGitUrlSecrets('https://user:secret@')).not.toThrow()
    expect(redactGitUrlSecrets('https://user:secret@')).not.toContain('secret')
  })
})

describe('normalizeGithubRepoUrl', () => {
  it('binds App-backed repositories to canonical GitHub owner/repo URLs', () => {
    expect(normalizeGithubRepoUrl('https://other-host.example/acme/infra')).toBe('https://github.com/acme/infra')
    expect(normalizeGithubRepoUrl('ssh://git@other-host.example/acme/infra.git')).toBe(
      'https://github.com/acme/infra.git'
    )
    expect(() => normalizeGithubRepoUrl('https://other-host.example/acme/infra/extra')).toThrow(GitCloneUrlError)
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
