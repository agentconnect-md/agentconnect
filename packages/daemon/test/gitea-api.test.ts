// The Gitea REST root and client (gitea-integration.md §3, §4.2): concatenated onto a prefixed base, one token header, big ids kept, auth rejections typed.
import { describe, expect, it } from 'vitest'
import { giteaApiBaseUrl } from '../src/gitea/api-base.js'
import { giteaRepoPath, giteaRequest, GiteaRequestError } from '../src/gitea/api.js'

function fakeFetch(responses: Array<{ status: number; body: string }>) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const next = responses.shift() ?? { status: 200, body: '{}' }
    return new Response(next.status === 204 ? null : next.body, {
      status: next.status,
      headers: { 'content-type': 'application/json' }
    })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('giteaApiBaseUrl', () => {
  it('concatenates /api/v1 onto the normalized base, prefix and port preserved, gitea.com by default', () => {
    expect(giteaApiBaseUrl()).toBe('https://gitea.com/api/v1')
    expect(giteaApiBaseUrl(' ')).toBe('https://gitea.com/api/v1')
    expect(giteaApiBaseUrl('https://gitea.example.test:8443/gitea/')).toBe(
      'https://gitea.example.test:8443/gitea/api/v1'
    )
  })
})

describe('giteaRequest', () => {
  const client = (fetchImpl: typeof fetch) => ({
    apiBaseUrl: 'https://gitea.example.test/api/v1',
    token: 'tok',
    fetchImpl
  })

  it('sends the token header and a JSON body, and keeps ids beyond the safe-integer range as strings', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 201, body: '{"id":9007199254740993123,"user":{"id":7}}' }])
    const parsed = await giteaRequest(client(fetchImpl), {
      method: 'POST',
      path: '/repos/o/r/issues/1/comments',
      query: { limit: '5' },
      body: { body: 'hi' }
    })
    expect(calls[0]!.url).toBe('https://gitea.example.test/api/v1/repos/o/r/issues/1/comments?limit=5')
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.init.headers).toMatchObject({ authorization: 'token tok', 'content-type': 'application/json' })
    expect(calls[0]!.init.body).toBe('{"body":"hi"}')
    expect(parsed).toEqual({ id: '9007199254740993123', user: { id: 7 } })
  })

  it('types a 401/403 as an auth rejection with the bounded message, and nothing else as one', async () => {
    const { fetchImpl } = fakeFetch([
      { status: 403, body: '{"message":"token does not have at least one of required scope(s): [write:issue]"}' },
      { status: 500, body: 'boom' }
    ])
    const denied = (await giteaRequest(client(fetchImpl), { method: 'GET', path: '/user' }).catch(
      (err: unknown) => err
    )) as GiteaRequestError
    expect(denied).toBeInstanceOf(GiteaRequestError)
    expect(denied.authRejected).toBe(true)
    expect(denied.status).toBe(403)
    expect(denied.message).toContain('write:issue')
    const failed = (await giteaRequest(client(fetchImpl), { method: 'GET', path: '/user' }).catch(
      (err: unknown) => err
    )) as GiteaRequestError
    expect(failed.authRejected).toBe(false)
    expect(failed.message).toBe('Gitea GET failed with 500')
  })

  it('answers undefined for an empty body and refuses an unreadable one', async () => {
    const { fetchImpl } = fakeFetch([
      { status: 204, body: '' },
      { status: 200, body: 'not json' }
    ])
    expect(await giteaRequest(client(fetchImpl), { method: 'DELETE', path: '/x' })).toBeUndefined()
    await expect(giteaRequest(client(fetchImpl), { method: 'GET', path: '/x' })).rejects.toThrow(/unreadable GET/)
  })
})

describe('giteaRepoPath', () => {
  it('composes /repos/<owner>/<repo> from exactly two plain segments', () => {
    expect(giteaRepoPath('example-org/example-repo')).toBe('/repos/example-org/example-repo')
    expect(() => giteaRepoPath('example-org/sub/example-repo')).toThrow(/exactly owner\/repo/)
    expect(() => giteaRepoPath('../example-repo')).toThrow(/exactly owner\/repo/)
    expect(() => giteaRepoPath('example-org')).toThrow(/exactly owner\/repo/)
  })
})
