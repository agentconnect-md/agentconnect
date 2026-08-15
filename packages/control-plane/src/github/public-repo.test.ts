/**
 * The anonymous repo read that binds a skill source's identity (issue #935).
 * What matters here is the verdict split: `not-found` is definitive and fails the
 * write, everything else is `unreachable` and stays retryable — a rate-limited
 * GitHub must never be reported as "no such repository".
 */
import { describe, it, expect } from 'vitest'
import { createPublicRepoResolver } from './public-repo.js'

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

describe('createPublicRepoResolver', () => {
  it('reads identity, privacy, and default branch without any credential', async () => {
    const calls: string[] = []
    let sentAuth: string | null = 'unset'
    const resolve = createPublicRepoResolver({
      fetchImpl: async (url, init) => {
        calls.push(url)
        sentAuth = new Headers(init?.headers).get('authorization')
        return new Response(
          JSON.stringify({ id: 8484, full_name: 'anthropics/skills', private: false, default_branch: 'trunk' }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
    })

    expect(await resolve('anthropics', 'skills')).toEqual({
      repoId: 8484n,
      fullName: 'anthropics/skills',
      private: false,
      defaultBranch: 'trunk'
    })
    expect(calls[0]).toBe('https://api.github.com/repos/anthropics/skills')
    expect(sentAuth).toBeNull()
  })

  it('reports a missing (or private-to-anonymous) repo as the definitive not-found', async () => {
    const resolve = createPublicRepoResolver({ fetchImpl: respond(404, { message: 'Not Found' }) })
    expect(await resolve('nobody', 'nothing')).toBe('not-found')
  })

  it('keeps a rate limit and a server error retryable rather than calling them not-found', async () => {
    const limited = createPublicRepoResolver({
      fetchImpl: respond(403, { message: 'rate limit exceeded' }, { 'x-ratelimit-remaining': '0' })
    })
    expect(await limited('anthropics', 'skills')).toBe('unreachable')

    const down = createPublicRepoResolver({ fetchImpl: respond(500, { message: 'boom' }) })
    expect(await down('anthropics', 'skills')).toBe('unreachable')

    const offline = createPublicRepoResolver({
      fetchImpl: async () => {
        throw new Error('ENOTFOUND')
      }
    })
    expect(await offline('anthropics', 'skills')).toBe('unreachable')
  })
})
