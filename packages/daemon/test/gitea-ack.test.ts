/**
 * Gitea's turn-start acknowledgement (gitea-integration.md §10.1): the `eyes` reaction on the comment
 * or subject that fired the turn, placed only after the instance's allowed-reaction list is read once
 * per REST root; a 403 naming a disallowed reaction is "no reaction", not a fault.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { acknowledgeCodeHostTrigger } from '../src/codehost/ack.js'
import type { CodeHostReplyTarget } from '../src/codehost/reply-target.js'
import { resetGiteaReactionCache } from '../src/gitea/reactions.js'

const HOOK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const BASE = 'https://gitea.example.test:8443/gitea/api/v1'

interface Route {
  url: string
  status?: number
  body?: string
}

function harness(routes: Route[] = []) {
  const warn = vi.fn()
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, init })
    const route = routes.find((candidate) => url.startsWith(candidate.url))
    if (!route) return Promise.resolve(new Response('{}', { status: 201 }))
    return Promise.resolve(new Response(route.body ?? '{}', { status: route.status ?? 200 }))
  }) as unknown as typeof fetch
  return { calls, warn, deps: { token: async () => 'tok_1', apiBaseUrl: () => BASE, log: { warn }, fetchImpl } }
}

const settings = (reactions: string[]): Route => ({
  url: `${BASE}/settings/ui`,
  body: JSON.stringify({ allowed_reactions: reactions, custom_emojis: [] })
})

const gitea = (extra: Partial<CodeHostReplyTarget> = {}): CodeHostReplyTarget => ({
  hookId: HOOK,
  provider: 'gitea',
  subjectKind: 'merge_request',
  repo: '556677',
  repoPath: 'example-org/example-repo',
  number: 12,
  ...extra
})

beforeEach(() => resetGiteaReactionCache())

describe('gitea acknowledgement', () => {
  it('reads the allowed reactions once per instance, then reacts on the comment that fired the turn', async () => {
    const h = harness([settings(['+1', 'eyes'])])
    await acknowledgeCodeHostTrigger(gitea({ triggerComment: { kind: 'issue_comment', id: '9001' } }), h.deps)
    expect(h.calls.map((c) => c.url)).toEqual([
      `${BASE}/settings/ui`,
      `${BASE}/repos/example-org/example-repo/issues/comments/9001/reactions`
    ])
    expect(h.calls[0]!.init.headers).toMatchObject({ authorization: 'token tok_1' })
    expect(h.calls[1]!.init.method).toBe('POST')
    expect(h.calls[1]!.init.body).toBe(JSON.stringify({ content: 'eyes' }))
    expect(h.calls[1]!.init.headers).toMatchObject({ authorization: 'token tok_1' })
    // The subject itself fired the next delivery; the list is remembered for the instance.
    await acknowledgeCodeHostTrigger(gitea({ subjectKind: 'issue', number: 42 }), h.deps)
    expect(h.calls.map((c) => c.url).slice(2)).toEqual([`${BASE}/repos/example-org/example-repo/issues/42/reactions`])
    expect(h.warn).not.toHaveBeenCalled()
  })

  it('places no reaction on an instance that removed eyes, and warns about nothing', async () => {
    const h = harness([settings(['+1', '-1'])])
    await acknowledgeCodeHostTrigger(gitea(), h.deps)
    await acknowledgeCodeHostTrigger(gitea(), h.deps)
    expect(h.calls.map((c) => c.url)).toEqual([`${BASE}/settings/ui`])
    expect(h.warn).not.toHaveBeenCalled()
  })

  it('reads a 403 naming a disallowed reaction as no reaction, not a fault, and re-reads the list next time', async () => {
    const h = harness([
      settings(['eyes']),
      {
        url: `${BASE}/repos/example-org/example-repo/issues/12/reactions`,
        status: 403,
        body: JSON.stringify({ message: "'eyes' is not an allowed reaction" })
      }
    ])
    await acknowledgeCodeHostTrigger(gitea(), h.deps)
    expect(h.warn).not.toHaveBeenCalled()
    await acknowledgeCodeHostTrigger(gitea(), h.deps)
    expect(h.calls.map((c) => c.url)).toEqual([
      `${BASE}/settings/ui`,
      `${BASE}/repos/example-org/example-repo/issues/12/reactions`,
      `${BASE}/settings/ui`,
      `${BASE}/repos/example-org/example-repo/issues/12/reactions`
    ])
  })

  it('treats a repeated reaction answering 200 as success', async () => {
    const h = harness([settings(['eyes']), { url: `${BASE}/repos/`, status: 200, body: '{"id":1}' }])
    await acknowledgeCodeHostTrigger(gitea(), h.deps)
    expect(h.warn).not.toHaveBeenCalled()
  })

  it('skips the reaction while the list cannot be read, without remembering the failure', async () => {
    const failing = harness([{ url: `${BASE}/settings/ui`, status: 500, body: 'boom' }])
    await acknowledgeCodeHostTrigger(gitea(), failing.deps)
    expect(failing.calls).toHaveLength(1)
    expect(failing.warn).not.toHaveBeenCalled()
    const recovered = harness([settings(['eyes'])])
    await acknowledgeCodeHostTrigger(gitea(), recovered.deps)
    expect(recovered.calls.map((c) => c.url)).toEqual([
      `${BASE}/settings/ui`,
      `${BASE}/repos/example-org/example-repo/issues/12/reactions`
    ])
  })

  it('degrades to one warn on any other rejection, a credential refusal included', async () => {
    const h = harness([
      settings(['eyes']),
      {
        url: `${BASE}/repos/`,
        status: 403,
        body: JSON.stringify({ message: 'token does not have the required scope' })
      }
    ])
    await acknowledgeCodeHostTrigger(gitea(), h.deps)
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('gitea ack: reaction rejected (HTTP 403)'))
    const broken = harness([settings(['eyes'])])
    await acknowledgeCodeHostTrigger(gitea({ repoPath: undefined }), broken.deps)
    expect(broken.warn).toHaveBeenCalledWith(expect.stringContaining('gitea ack: reaction failed'))
  })
})
