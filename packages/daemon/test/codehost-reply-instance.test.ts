import { expect, it, vi } from 'vitest'
import { turnFinalFor, type CodeHostTurnFinalHost } from '../src/codehost/turn-final.js'

it.each(['gitlab', 'gitea'] as const)(
  '%s refuses a parent output lease after its instance binding changes',
  async (provider) => {
    let instance = 'https://original.example.test'
    const token = vi.fn(async () => ({ token: 'test-token' }))
    const host = {
      gitlabHostFor: () => instance,
      giteaHostFor: () => instance,
      getGitlabPostToken: token,
      getGiteaPostToken: token
    } as unknown as CodeHostTurnFinalHost
    const target = { provider, host: instance, hookId: 'hook-1', repo: '123', number: 42 }
    const lease = turnFinalFor(target).effectLease('parent', target, host)
    expect(await lease.token()).toBe('test-token')
    token.mockClear()
    instance = 'https://replacement.example.test'
    await expect(lease.token()).rejects.toThrow(`${provider}_host_mismatch`)
    expect(token).not.toHaveBeenCalled()
    expect(lease.apiBaseUrl()).toContain('https://original.example.test/')
  }
)
