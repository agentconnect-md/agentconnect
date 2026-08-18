import { describe, expect, it } from 'vitest'
import { githubSubmoduleRepo, gitmoduleRepos, parseGitmoduleUrls } from '../src/workspace/gitmodules.js'

describe('parseGitmoduleUrls', () => {
  it('reads the url of every submodule section, in file order', () => {
    const text = [
      '[submodule "vendor/shared-library"]',
      '\tpath = vendor/shared-library',
      '\turl = https://github.com/example-co/shared-library.git',
      '[submodule "vendor/infra"]',
      '\tpath = vendor/infra',
      '\turl = git@github.com:acme/infra.git',
      '\tbranch = main'
    ].join('\n')

    expect(parseGitmoduleUrls(text)).toEqual([
      'https://github.com/example-co/shared-library.git',
      'git@github.com:acme/infra.git'
    ])
  })

  it('ignores comments, blank lines, and keys outside a submodule section', () => {
    const text = [
      '# a comment',
      '; another one',
      '[core]',
      '\turl = https://github.com/acme/not-a-submodule',
      '',
      '[submodule.dotted]',
      '\tURL = "https://github.com/acme/infra"',
      '\tnot-a-pair'
    ].join('\n')

    expect(parseGitmoduleUrls(text)).toEqual(['https://github.com/acme/infra'])
  })

  it('survives an empty or malformed file', () => {
    expect(parseGitmoduleUrls('')).toEqual([])
    expect(parseGitmoduleUrls('[submodule "x"')).toEqual([])
    expect(parseGitmoduleUrls('[submodule "x"]\n\turl =\n')).toEqual([])
  })
})

describe('githubSubmoduleRepo', () => {
  it('normalizes every github.com spelling to a lowercased owner/repo', () => {
    for (const url of [
      'https://github.com/Acme/Infra.git',
      'https://github.com/acme/infra/',
      'git@github.com:acme/infra.git',
      'ssh://git@github.com/acme/infra',
      'github.com/acme/infra',
      'https://token@github.com/acme/infra.git'
    ]) {
      expect(githubSubmoduleRepo(url)).toBe('acme/infra')
    }
  })

  it('names no repository for a relative, local, or non-github address', () => {
    for (const url of [
      '../shared-library',
      './vendor/infra',
      '/srv/mirrors/infra.git',
      'https://git.example.test/acme/infra.git',
      'git@git.example.test:acme/infra.git',
      'https://github.com/acme',
      'https://github.com/acme/infra/extra',
      ''
    ]) {
      expect(githubSubmoduleRepo(url)).toBeUndefined()
    }
  })
})

describe('gitmoduleRepos', () => {
  it('collects only the github.com submodules a file declares', () => {
    const text = [
      '[submodule "a"]',
      '\turl = https://github.com/Example-Co/Shared-Library.git',
      '[submodule "b"]',
      '\turl = ../sibling-repo',
      '[submodule "c"]',
      '\turl = https://git.example.test/acme/infra.git'
    ].join('\n')

    expect([...gitmoduleRepos(text)]).toEqual(['example-co/shared-library'])
  })
})
