import { describe, expect, it } from 'vitest'
import { githubHookCovers } from './installation-row.js'

describe('githubHookCovers', () => {
  it('covers a repository row’s own repository, whatever installation signed the event', () => {
    const row = { kind: 'github', repoId: 42n, installationId: null } as const
    expect(githubHookCovers(row, 42n, 7n)).toBe(true)
    expect(githubHookCovers(row, 43n, 7n)).toBe(false)
    expect(githubHookCovers(row, null, 7n)).toBe(false)
  })

  it('covers every repository an installation row’s installation signed', () => {
    const row = { kind: 'github', repoId: null, installationId: 7n } as const
    expect(githubHookCovers(row, 42n, 7n)).toBe(true)
    expect(githubHookCovers(row, 43n, 7n)).toBe(true)
    expect(githubHookCovers(row, 42n, 8n)).toBe(false)
    expect(githubHookCovers(row, 42n, null)).toBe(false)
  })

  it('covers nothing outside github', () => {
    expect(githubHookCovers({ kind: 'gitlab', repoId: 42n, installationId: null }, 42n, 7n)).toBe(false)
  })
})
