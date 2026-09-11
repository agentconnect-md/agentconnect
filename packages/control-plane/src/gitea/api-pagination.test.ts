/** The Gitea edge (gitea-integration.md §4.2, §6): base concatenation, `token` auth, Link/X-Total-Count paging, typed errors. */
import { describe, expect, it } from 'vitest'
import {
  GITEA_DEFAULT_PAGE_SIZE,
  GiteaApiClient,
  GiteaApiError,
  giteaCurrentUser,
  giteaPagedGet,
  giteaPageSize,
  giteaPermissionAdmits,
  giteaPublicRepository,
  isGiteaAuthRejection,
  nextPageOfLink,
  splitGiteaRepoPath,
  type FetchLike
} from './api.js'

const BASE = 'https://gitea.example.test/gitea'

function client(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  api: GiteaApiClient
  calls: { url: string; init?: RequestInit }[]
} {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, ...(init ? { init } : {}) })
    return handler(url, init)
  }
  return { api: new GiteaApiClient(BASE, fetchImpl), calls }
}

describe('GiteaApiClient', () => {
  it('composes /api/v1 by concatenation so a path prefix survives, and sends the token header', async () => {
    const { api, calls } = client(() => Response.json({ id: 9042, login: 'agent-bot', full_name: 'Agent Bot' }))
    const user = await giteaCurrentUser('secret-token', api)
    expect(user).toEqual({ id: 9042, login: 'agent-bot', full_name: 'Agent Bot' })
    expect(calls[0]!.url).toBe(`${BASE}/api/v1/user`)
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe('token secret-token')
  })

  it('reads the next page from the Link header and stops at X-Total-Count', async () => {
    const { api, calls } = client((url) => {
      const page = Number(new URL(url).searchParams.get('page'))
      const rows = page === 1 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }]
      return Response.json(rows, {
        headers: {
          'x-total-count': '3',
          link: page === 1 ? `<${BASE}/api/v1/user/repos?page=2&limit=2>; rel="next"` : ''
        }
      })
    })
    const rows = await giteaPagedGet<{ id: number }>('/user/repos', { token: 't', client: api, pageSize: 2 })
    expect(rows.map((row) => row.id)).toEqual([1, 2, 3])
    expect(calls.map((call) => new URL(call.url).search)).toEqual(['?page=1&limit=2', '?page=2&limit=2'])
  })

  it('stops on an empty page or a missing Link, and refuses a Link that does not advance', async () => {
    const single = client(() => Response.json([{ id: 1 }]))
    expect(await giteaPagedGet('/user/orgs', { token: 't', client: single.api, pageSize: 50 })).toEqual([{ id: 1 }])
    const stuck = client(() =>
      Response.json([{ id: 1 }], { headers: { link: `<${BASE}/api/v1/x?page=1&limit=50>; rel="next"` } })
    )
    await expect(giteaPagedGet('/x', { token: 't', client: stuck.api, pageSize: 50 })).rejects.toMatchObject({
      message: 'gitea pagination did not advance'
    })
    expect(nextPageOfLink('<https://h/api/v1/x?page=4>; rel="prev", <https://h/api/v1/x?page=6>; rel="next"')).toBe(6)
    expect(nextPageOfLink('<https://h/api/v1/x?page=4>; rel="last"')).toBeNull()
    expect(nextPageOfLink(null)).toBeNull()
  })

  it('reads the instance paging ceiling and falls back to the Gitea default', async () => {
    const configured = client(() => Response.json({ max_response_items: 25, default_paging_num: 30 }))
    expect(await giteaPageSize(configured.api)).toBe(25)
    const broken = client(() => Response.json({ message: 'boom' }, { status: 500 }))
    expect(await giteaPageSize(broken.api)).toBe(GITEA_DEFAULT_PAGE_SIZE)
  })

  it('types a 401 and a scope 403 as the definite token rejection, other 403s as forbidden', async () => {
    const unauthorized = client(() => Response.json({ message: 'token is required' }, { status: 401 }))
    await expect(giteaCurrentUser('t', unauthorized.api)).rejects.toSatisfy(isGiteaAuthRejection)
    const scope = client(() =>
      Response.json(
        { message: 'token does not have at least one of required scope(s), required=[read:user]' },
        { status: 403 }
      )
    )
    await expect(giteaCurrentUser('t', scope.api)).rejects.toSatisfy(isGiteaAuthRejection)
    const forbidden = client(() => Response.json({ message: 'Only admins can query all permissions' }, { status: 403 }))
    await expect(giteaCurrentUser('t', forbidden.api)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
    const rate = client(() => Response.json({ message: 'slow down' }, { status: 429 }))
    await expect(giteaCurrentUser('t', rate.api)).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: false })
    const down = client(() => {
      throw new Error('connect ECONNREFUSED')
    })
    await expect(giteaCurrentUser('t', down.api)).rejects.toMatchObject({ code: 'INTERNAL', retryable: true })
    // The message carries the status and the provider's message only — never the token.
    await expect(giteaCurrentUser('secret-token', unauthorized.api)).rejects.toSatisfy(
      (e: unknown) => e instanceof GiteaApiError && !e.message.includes('secret-token')
    )
  })

  it('resolves a public repository anonymously and answers null for anything private or absent', async () => {
    const found = client(() => Response.json({ id: 7, full_name: 'example-org/example-repo', private: false }))
    expect(await giteaPublicRepository('example-org', 'example-repo', found.api)).toMatchObject({ id: 7 })
    expect((found.calls[0]!.init!.headers as Record<string, string>).authorization).toBeUndefined()
    const hidden = client(() => Response.json({ message: 'Not Found' }, { status: 404 }))
    expect(await giteaPublicRepository('example-org', 'private', hidden.api)).toBeNull()
  })

  it('accepts write, admin and owner from the permission lookup and splits owner/repo paths', () => {
    expect(['none', 'read', 'write', 'admin', 'owner'].filter(giteaPermissionAdmits)).toEqual([
      'write',
      'admin',
      'owner'
    ])
    expect(giteaPermissionAdmits(undefined)).toBe(false)
    expect(splitGiteaRepoPath('example-org/example-repo')).toEqual({ owner: 'example-org', repo: 'example-repo' })
    expect(splitGiteaRepoPath('group/sub/repo')).toBeNull()
    expect(splitGiteaRepoPath('bare')).toBeNull()
  })
})
