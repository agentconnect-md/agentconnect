import { describe, expect, it } from 'vitest'
import {
  githubHookScope,
  githubHookScopeKey,
  installationScopeAccount,
  installationScopeKey
} from './github-hook-scope'

describe('github hook scope', () => {
  it('round-trips an installation account through its owner/* key', () => {
    expect(installationScopeKey('acme')).toBe('acme/*')
    expect(installationScopeAccount('acme/*')).toBe('acme')
    expect(installationScopeAccount('acme/platform')).toBeNull()
    expect(installationScopeAccount(null)).toBeNull()
  })

  it('writes and keys an installation row by its account and any other row by its repository', () => {
    expect(githubHookScope({ repoFullName: null, installationAccount: 'acme' })).toEqual({ githubAccount: 'acme' })
    expect(githubHookScope({ repoFullName: 'acme/platform' })).toEqual({ repoFullName: 'acme/platform' })
    expect(githubHookScopeKey({ repoFullName: null, installationAccount: 'acme' })).toBe('acme/*')
    expect(githubHookScopeKey({ repoFullName: 'acme/platform', installationAccount: null })).toBe('acme/platform')
  })
})
