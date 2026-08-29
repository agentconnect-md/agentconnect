import { describe, expect, it } from 'vitest'
import { gitRepoUrlTileHint } from './git-url-tile'

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
