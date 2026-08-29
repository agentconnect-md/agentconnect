import { afterEach, describe, expect, it } from 'vitest'
import { gitRepoUrlTileHint, managedGitlabRepoPath } from './git-url-tile'

// The Git URL tile takes FULL addresses on unmanaged hosts only, so tile ↔ stored
// shape stays injective (git-workspace-model.md §7). A non-null hint says why.
describe('gitRepoUrlTileHint', () => {
  it('accepts a full address on any unmanaged host', () => {
    expect(gitRepoUrlTileHint('https://git.example.test/team/repo.git')).toBeNull()
    expect(gitRepoUrlTileHint('ssh://git@git.example.test/team/repo.git')).toBeNull()
    expect(gitRepoUrlTileHint('git@git.example.test:team/repo.git')).toBeNull()
    // A self-hosted GitLab is not the managed host, so it belongs here.
    expect(gitRepoUrlTileHint('https://gitlab.example.test/team/repo')).toBeNull()
  })

  it('refuses shorthand — this tile has no host to complete it with', () => {
    expect(gitRepoUrlTileHint('acme/infra')).toBe('Enter a full https:// or ssh:// clone URL.')
    expect(gitRepoUrlTileHint('git.example.test/team/repo')).toBe('Enter a full https:// or ssh:// clone URL.')
  })

  it('sends the managed hosts to their own tiles', () => {
    expect(gitRepoUrlTileHint('https://github.com/acme/infra')).toContain('GitHub')
    expect(gitRepoUrlTileHint('git@github.com:acme/infra.git')).toContain('GitHub')
    expect(gitRepoUrlTileHint('https://GitLab.com/acme/platform')).toContain('GitLab')
  })

  it('stays quiet on an empty box — emptiness is canSubmit’s business', () => {
    expect(gitRepoUrlTileHint('')).toBeNull()
    expect(gitRepoUrlTileHint('   ')).toBeNull()
  })
})

describe('managed self-hosted instance (runtime config)', () => {
  // These lib tests run in node — publish the browser global the getter reads.
  const g = globalThis as unknown as { window?: { __AC_ENV?: Record<string, string> } }
  afterEach(() => {
    delete g.window
  })

  it('refuses the configured GitLab base with the CP classifier semantics', () => {
    g.window = { __AC_ENV: { GITLAB_URL: 'https://gitlab.example.test' } }
    expect(gitRepoUrlTileHint('https://gitlab.example.test/team/repo')).toBe(
      'Use the “GitLab” tile for GitLab projects.'
    )
    // An unrelated self-hosted server stays on this tile — and so does
    // gitlab.com once another instance is configured.
    expect(gitRepoUrlTileHint('https://git.example.test/team/repo')).toBeNull()
    expect(gitRepoUrlTileHint('https://gitlab.com/team/repo')).toBeNull()
  })

  it('matches a non-default port exactly', () => {
    g.window = { __AC_ENV: { GITLAB_URL: 'https://gitlab.example.test:8443' } }
    expect(gitRepoUrlTileHint('https://gitlab.example.test:8443/team/repo')).toBe(
      'Use the “GitLab” tile for GitLab projects.'
    )
    expect(gitRepoUrlTileHint('https://gitlab.example.test/team/repo')).toBeNull()
  })

  it('claims only addresses under a path-prefixed base', () => {
    g.window = { __AC_ENV: { GITLAB_URL: 'https://example.test/gitlab' } }
    expect(managedGitlabRepoPath('https://example.test/gitlab/team/repo.git')).toBe('team/repo')
    expect(managedGitlabRepoPath('https://example.test/other/team/repo')).toBeNull()
    expect(gitRepoUrlTileHint('https://example.test/other/team/repo')).toBeNull()
  })
})
