import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchPublicGithubBranches } from './github-public-repos'

const base = 'https://api.github.com/repos/example-org/example-repo/branches'

function page(names: string[], next?: number, status = 200): Response {
  const headers = next
    ? { link: `<${base}?per_page=100&page=${next}>; rel="next", <${base}?page=99>; rel="last"` }
    : undefined
  return new Response(JSON.stringify(names.map((name) => ({ name }))), { status, headers })
}

afterEach(() => vi.unstubAllGlobals())

describe('fetchPublicGithubBranches', () => {
  it('follows rel="next" until the last page', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page(['a', 'b'], 2))
      .mockResolvedValueOnce(page(['c']))
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchPublicGithubBranches('example-org/example-repo')).toEqual(['a', 'b', 'c'])
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([`${base}?per_page=100`, `${base}?per_page=100&page=2`])
  })

  it('stops at the page cap', async () => {
    let n = 0
    const fetchMock = vi.fn().mockImplementation(async () => page([`b${++n}`], n + 1))
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchPublicGithubBranches('example-org/example-repo')).toHaveLength(10)
    expect(fetchMock).toHaveBeenCalledTimes(10)
  })

  it('keeps earlier pages when a later page fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(page(['a'], 2))
        .mockResolvedValueOnce(page([], undefined, 403))
    )
    expect(await fetchPublicGithubBranches('example-org/example-repo')).toEqual(['a'])
  })

  it('returns null when the first page fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(page([], undefined, 404)))
    expect(await fetchPublicGithubBranches('example-org/example-repo')).toBeNull()
  })
})
