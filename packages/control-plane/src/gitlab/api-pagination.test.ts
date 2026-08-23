/**
 * Paginated GitLab listings (gitlab-com-integration.md §7.2). These three reads
 * back predicates that are sound only over a COMPLETE listing — the create
 * window's snapshot, the `username_taken` foreign-account check, the stray-PAT
 * sweep, the exact-URL webhook adoption — so each must follow `x-next-page` and
 * must refuse rather than hand back a partial page.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FetchLike } from './api.js'
import {
  GitlabApiClient,
  GitlabApiError,
  gitlabListServiceAccountTokens,
  gitlabListServiceAccounts,
  gitlabListWebhooks
} from './api.js'

/** The axis unset: a GitLab.com-bound client over a scripted transport. */
const dotCom = (fetchImpl: FetchLike): GitlabApiClient => new GitlabApiClient('https://gitlab.com', fetchImpl)

const TOKEN = 'at-1'

/** A GitLab-shaped paged edge: `pages` are served in order, and `x-next-page`
 *  carries the next index, empty on the last — exactly what gitlab.com sends. */
function pagedFetch(pages: unknown[][]): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = []
  const fetch: FetchLike = async (url) => {
    urls.push(url)
    const page = Number(new URL(url).searchParams.get('page') ?? '1')
    const body = pages[page - 1] ?? []
    const next = page < pages.length ? String(page + 1) : ''
    return Response.json(body, { headers: { 'x-next-page': next } })
  }
  return { fetch, urls }
}

const account = (id: number) => ({ id, username: `bot-${id}`, name: `bot ${id}` })

afterEach(() => {
  vi.useRealTimers()
})

describe('gitlabListServiceAccounts', () => {
  it('follows x-next-page and returns every page, in order', async () => {
    const first = Array.from({ length: 100 }, (_, i) => account(1000 + i))
    const second = [account(2000), account(2001)]
    const { fetch, urls } = pagedFetch([first, second])

    const accounts = await gitlabListServiceAccounts(TOKEN, 77, dotCom(fetch))

    expect(accounts).toHaveLength(102)
    expect(accounts.map((a) => a.id)).toEqual([...first, ...second].map((a) => a.id))
    expect(urls).toEqual([
      'https://gitlab.com/api/v4/groups/77/service_accounts?per_page=100&page=1',
      'https://gitlab.com/api/v4/groups/77/service_accounts?per_page=100&page=2'
    ])
  })

  it('is one request when the header says there is no next page', async () => {
    const { fetch, urls } = pagedFetch([[account(1)]])
    await expect(gitlabListServiceAccounts(TOKEN, 77, dotCom(fetch))).resolves.toHaveLength(1)
    expect(urls).toHaveLength(1)
  })

  it('stops at a provider that sends no pagination header at all', async () => {
    let calls = 0
    const fetch: FetchLike = async () => {
      calls++
      return Response.json([account(1)])
    }
    await expect(gitlabListServiceAccounts(TOKEN, 77, dotCom(fetch))).resolves.toHaveLength(1)
    expect(calls).toBe(1)
  })

  it('presents the bearer on every page', async () => {
    const seen: (string | undefined)[] = []
    const fetch: FetchLike = async (url, init) => {
      seen.push((init?.headers as Record<string, string> | undefined)?.authorization)
      const page = Number(new URL(url).searchParams.get('page') ?? '1')
      return Response.json([account(page)], { headers: { 'x-next-page': page < 3 ? String(page + 1) : '' } })
    }
    await gitlabListServiceAccounts(TOKEN, 77, dotCom(fetch))
    expect(seen).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`, `Bearer ${TOKEN}`])
  })

  it('refuses a mid-listing failure rather than returning the pages it already read', async () => {
    const fetch: FetchLike = async (url) => {
      const page = Number(new URL(url).searchParams.get('page') ?? '1')
      if (page === 2) return Response.json({ message: 'upstream' }, { status: 502 })
      return Response.json([account(1)], { headers: { 'x-next-page': '2' } })
    }
    await expect(gitlabListServiceAccounts(TOKEN, 77, dotCom(fetch))).rejects.toMatchObject({
      name: 'GitlabApiError',
      status: 502,
      retryable: true
    })
  })

  it('refuses a header that does not advance instead of spinning or truncating', async () => {
    let calls = 0
    const fetch: FetchLike = async () => {
      calls++
      return Response.json([account(1)], { headers: { 'x-next-page': '1' } })
    }
    await expect(gitlabListServiceAccounts(TOKEN, 77, dotCom(fetch))).rejects.toBeInstanceOf(GitlabApiError)
    expect(calls).toBe(1)
  })

  it('raises retryably once the walk outruns its time budget, so it cannot outlive a caller lease', async () => {
    // Only Date is faked: AbortSignal.timeout keeps its real timer.
    vi.useFakeTimers({ toFake: ['Date'] })
    let calls = 0
    const fetch: FetchLike = async (url) => {
      calls++
      // Each page answers slowly enough that a few of them spend the budget.
      vi.setSystemTime(Date.now() + 25_000)
      const page = Number(new URL(url).searchParams.get('page') ?? '1')
      return Response.json([account(page)], { headers: { 'x-next-page': String(page + 1) } })
    }
    const error = await gitlabListServiceAccounts(TOKEN, 77, dotCom(fetch)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GitlabApiError)
    expect((error as GitlabApiError).retryable).toBe(true)
    // Three pages spend 75s of a 60s budget; the fourth is never attempted.
    expect(calls).toBe(3)
  })

  it('raises retryably past the page bound rather than truncating the listing', async () => {
    let calls = 0
    const fetch: FetchLike = async (url) => {
      calls++
      const page = Number(new URL(url).searchParams.get('page') ?? '1')
      return Response.json([account(page)], { headers: { 'x-next-page': String(page + 1) } })
    }
    const error = await gitlabListServiceAccounts(TOKEN, 77, dotCom(fetch)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GitlabApiError)
    expect((error as GitlabApiError).retryable).toBe(true)
    expect(calls).toBe(50)
  })
})

describe('gitlabListServiceAccountTokens', () => {
  it('follows x-next-page so a stray on a later page is still swept', async () => {
    const grant = (id: number) => ({ id, name: 'ac-api', scopes: ['api'], active: true, expires_at: null })
    const { fetch, urls } = pagedFetch([[grant(1)], [grant(2)]])

    const grants = await gitlabListServiceAccountTokens(TOKEN, 77, 5001n, dotCom(fetch))

    expect(grants.map((g) => g.id)).toEqual([1, 2])
    expect(urls[0]).toBe(
      'https://gitlab.com/api/v4/groups/77/service_accounts/5001/personal_access_tokens?per_page=100&page=1'
    )
    expect(urls[1]).toContain('page=2')
  })
})

describe('gitlabListWebhooks', () => {
  it('follows x-next-page so an existing hook on a later page is still adopted', async () => {
    const managed = { id: 9, url: 'https://relay.example.test/webhooks/gitlab' }
    const { fetch, urls } = pagedFetch([[{ id: 8, url: 'https://other.example.test/hook' }], [managed]])

    const hooks = await gitlabListWebhooks(TOKEN, 4455667n, dotCom(fetch))

    expect(hooks.map((h) => h.id)).toEqual([8, 9])
    expect(urls[0]).toBe('https://gitlab.com/api/v4/projects/4455667/hooks?per_page=100&page=1')
    expect(urls[1]).toContain('page=2')
  })
})
