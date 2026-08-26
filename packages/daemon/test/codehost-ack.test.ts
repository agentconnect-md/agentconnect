import { describe, it, expect, vi } from 'vitest'
import { acknowledgeCodeHostTrigger } from '../src/codehost/ack.js'
import type { GithubReplyTarget } from '../src/github/hook-coords.js'

const HOOK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function harness(overrides: { fetchImpl?: typeof fetch; token?: () => Promise<string> } = {}) {
  const warn = vi.fn()
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl =
    overrides.fetchImpl ??
    (((url: string, init: RequestInit) => {
      calls.push({ url, init })
      return Promise.resolve(new Response('{}', { status: 201 }))
    }) as unknown as typeof fetch)
  return {
    calls,
    warn,
    deps: {
      token: overrides.token ?? (async () => 'tok_1'),
      apiBaseUrl: () => 'https://api.example.test',
      log: { warn },
      fetchImpl
    }
  }
}

const github = (extra: Partial<GithubReplyTarget> = {}): GithubReplyTarget => ({
  hookId: HOOK,
  repo: 'acme/infra',
  number: 42,
  ...extra
})

const gitlab = (extra: Partial<GithubReplyTarget> = {}): GithubReplyTarget => ({
  hookId: HOOK,
  provider: 'gitlab',
  subjectKind: 'issue',
  repo: '4455667',
  number: 42,
  ...extra
})

describe('code-host acknowledgement', () => {
  it('reacts on the conversation comment that fired a github turn', async () => {
    const h = harness()
    await acknowledgeCodeHostTrigger(github({ triggerComment: { kind: 'issue_comment', id: '4242' } }), h.deps)
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]!.url).toBe('https://api.example.test/repos/acme/infra/issues/comments/4242/reactions')
    expect(h.calls[0]!.init.body).toBe(JSON.stringify({ content: 'eyes' }))
    expect(h.calls[0]!.init.headers).toMatchObject({ authorization: 'Bearer tok_1' })
    expect(h.warn).not.toHaveBeenCalled()
  })

  it('reacts on the inline review comment, which is a different github resource', async () => {
    const h = harness()
    await acknowledgeCodeHostTrigger(github({ triggerComment: { kind: 'review_comment', id: '99' } }), h.deps)
    expect(h.calls[0]!.url).toBe('https://api.example.test/repos/acme/infra/pulls/comments/99/reactions')
  })

  it('reacts on the subject when the subject itself fired — including a pull request', async () => {
    const h = harness()
    await acknowledgeCodeHostTrigger(github(), h.deps)
    // A pull request reacts through /issues/:number like any other issue.
    await acknowledgeCodeHostTrigger(github({ number: 7, reviewThreadRootCommentId: '5' }), h.deps)
    expect(h.calls.map((c) => c.url)).toEqual([
      'https://api.example.test/repos/acme/infra/issues/42/reactions',
      'https://api.example.test/repos/acme/infra/issues/7/reactions'
    ])
  })

  it('reacts on the note that fired a gitlab turn, under the merge-request family too', async () => {
    const h = harness()
    await acknowledgeCodeHostTrigger(gitlab({ triggerComment: { kind: 'note', id: '8801' } }), h.deps)
    await acknowledgeCodeHostTrigger(
      gitlab({ subjectKind: 'merge_request', number: 77, triggerComment: { kind: 'note', id: '8802' } }),
      h.deps
    )
    expect(h.calls.map((c) => c.url)).toEqual([
      'https://api.example.test/projects/4455667/issues/42/notes/8801/award_emoji',
      'https://api.example.test/projects/4455667/merge_requests/77/notes/8802/award_emoji'
    ])
    expect(h.calls[0]!.init.body).toBe(JSON.stringify({ name: 'eyes' }))
    expect(h.calls[0]!.init.headers).toMatchObject({ 'private-token': 'tok_1' })
  })

  it('reacts on the gitlab subject when no note fired the delivery', async () => {
    const h = harness()
    await acknowledgeCodeHostTrigger(gitlab({ subjectKind: 'merge_request', number: 77 }), h.deps)
    expect(h.calls[0]!.url).toBe('https://api.example.test/projects/4455667/merge_requests/77/award_emoji')
  })

  it('degrades to one warn on a rejected reaction, and never throws', async () => {
    const h = harness({
      fetchImpl: (() => Promise.resolve(new Response('nope', { status: 403 }))) as unknown as typeof fetch
    })
    await expect(acknowledgeCodeHostTrigger(github(), h.deps)).resolves.toBeUndefined()
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 403'))
  })

  it('degrades to one warn when the mint or the request throws', async () => {
    const h = harness({
      token: async () => {
        throw new Error('lease refused')
      }
    })
    await expect(acknowledgeCodeHostTrigger(github(), h.deps)).resolves.toBeUndefined()
    expect(h.calls).toHaveLength(0)
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('lease refused'))

    const thrown = harness({
      fetchImpl: (() => Promise.reject(new Error('socket hang up'))) as unknown as typeof fetch
    })
    await expect(acknowledgeCodeHostTrigger(gitlab(), thrown.deps)).resolves.toBeUndefined()
    expect(thrown.warn).toHaveBeenCalledWith(expect.stringContaining('socket hang up'))
  })

  it('names the provider that failed, so one warn identifies its own host', async () => {
    const h = harness({
      fetchImpl: (() => Promise.resolve(new Response('', { status: 500 }))) as unknown as typeof fetch
    })
    await acknowledgeCodeHostTrigger(gitlab(), h.deps)
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('gitlab ack'))
  })
})
