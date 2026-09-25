import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DecisionToolDefinition, AgentModelSelection } from '@agentconnect.md/protocol'
import { evaluateSessionModel, modelSelectionState } from '../src/decisions/model-selection.js'
import { codeHostPullRequestContext, type CodeHostTurnFinalHost } from '../src/codehost/turn-final.js'
import { PULL_CONTEXT_TIMEOUT_MS, readPullRequestContext } from '../src/codehost/pull-context.js'

const decision: DecisionToolDefinition = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Complexity',
  providerId: 'typesafe',
  model: 'jev-latest',
  question: {
    type: 'boolean',
    instructions: 'Is currentMessage.text complex?',
    criteria: { true: 'Complex', false: 'Simple' }
  }
}
const selection: AgentModelSelection = {
  decisionId: decision.id,
  rules: [{ when: { type: 'boolean', values: [true] }, runtime: 'claude', model: 'model-capable' }]
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
const lease = {
  token: async () => 'fixture-token',
  invalidateToken: () => {},
  apiBaseUrl: () => 'https://code.example.test'
}
const paths = {
  description: '/pulls/42',
  descriptionField: 'body' as const,
  baseShaPath: ['base', 'sha'],
  headShaPath: ['head', 'sha'],
  commits: '/pulls/42/commits',
  commitMessagePath: ['commit', 'message'],
  diff: '/pulls/42.diff'
}
const patch = 'diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-old\n+new\n'
const revision = { base: { sha: 'base' }, head: { sha: 'head' }, diff_refs: { base_sha: 'base', head_sha: 'head' } }
const revisionState = { baseSha: 'base', headSha: 'head' }

describe('session model evaluation', () => {
  it('evaluates only the chosen path against one input snapshot and falls back on a failed next step', async () => {
    const next = {
      ...decision,
      id: '44444444-4444-4444-8444-444444444444',
      name: 'Urgency',
      question: { ...decision.question, instructions: 'x'.repeat(14_000) }
    }
    const chain: AgentModelSelection = {
      decisionId: decision.id,
      rules: [{ when: { type: 'boolean', values: [true] }, nextStepId: 'urgency' }],
      steps: [{ id: 'urgency', decisionId: next.id, rules: selection.rules }]
    }
    const state = vi.fn(async () => modelSelectionState('chat', 'Opening message'))
    const get = vi.fn(async (id: string) => ({ decision: id === decision.id ? decision : next }))
    const evaluate = vi.fn(async () => ({
      status: 'answered' as const,
      model: 'jev-latest',
      usage: { inputTokens: 1, outputTokens: 0 },
      answer: { type: 'boolean' as const, value: true, probability: 0.9 }
    }))
    const input = {
      agentId: 'example-agent',
      selection: chain,
      supported: () => true,
      signal: new AbortController().signal,
      evaluationId: 'example-evaluation',
      current: () => true,
      decision: get,
      state,
      evaluate
    }
    expect(await evaluateSessionModel(input)).toEqual({ runtime: 'claude', model: 'model-capable' })
    expect(get.mock.calls.map(([id]) => id)).toEqual([decision.id, next.id])
    expect(state).toHaveBeenCalledOnce()
    expect(state).toHaveBeenCalledWith(next)
    const calls = evaluate.mock.calls as unknown as Array<
      [{ state: unknown; deadlineAt: number; evaluationId: string }]
    >
    expect(calls[1]![0].state).toBe(calls[0]![0].state)
    expect(calls[1]![0].deadlineAt).toBe(calls[0]![0].deadlineAt)
    expect(calls[1]![0].evaluationId).not.toBe(calls[0]![0].evaluationId)
    get.mockClear()
    evaluate.mockResolvedValueOnce({
      status: 'answered',
      model: 'jev-latest',
      usage: { inputTokens: 1, outputTokens: 0 },
      answer: { type: 'boolean', value: false, probability: 0.1 }
    })
    expect(await evaluateSessionModel(input)).toBeUndefined()
    expect(get.mock.calls.map(([id]) => id)).toEqual([decision.id, next.id])
    expect(
      await evaluateSessionModel({
        ...input,
        decision: async (id) => ({ decision: id === decision.id ? decision : null })
      })
    ).toBeUndefined()
    expect(
      await evaluateSessionModel({
        ...input,
        evaluate: async (request) =>
          request.decision === next ? { status: 'unavailable', reason: 'provider' } : evaluate()
      })
    ).toBeUndefined()
  })

  it('stops a chain at its shared deadline even when the next definition read stalls', async () => {
    vi.useFakeTimers()
    let release!: (value: { decision: DecisionToolDefinition }) => void
    const evaluate = vi.fn(async () => ({
      status: 'answered' as const,
      model: 'jev-latest',
      usage: { inputTokens: 1, outputTokens: 0 },
      answer: { type: 'boolean' as const, value: true, probability: 0.9 }
    }))
    const nextId = '44444444-4444-4444-8444-444444444444'
    const result = evaluateSessionModel({
      agentId: 'example-agent',
      supported: () => true,
      signal: new AbortController().signal,
      evaluationId: 'example-evaluation',
      current: () => true,
      selection: {
        decisionId: decision.id,
        rules: [{ when: { type: 'boolean', values: [true] }, nextStepId: 'next' }],
        steps: [{ id: 'next', decisionId: nextId, rules: selection.rules }]
      },
      state: async () => ({}),
      evaluate,
      decision: async (id) =>
        id === decision.id
          ? { decision }
          : new Promise((resolve) => {
              release = resolve
            })
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await result).toBeUndefined()
    release({ decision: { ...decision, id: nextId } })
    await vi.advanceTimersByTimeAsync(1)
    expect(evaluate).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds input and ignores stale, invalid, failed and unadvertised results', async () => {
    const state = modelSelectionState('chat', '界'.repeat(4000))
    expect(Buffer.byteLength((state.currentMessage as { text: string }).text)).toBeLessThanOrEqual(8192)
    expect(state).toMatchObject({ history: [], truncated: true })
    const current = vi.fn(() => true)
    const evaluate = vi.fn(async () => ({
      status: 'answered' as const,
      model: 'jev-latest',
      usage: { inputTokens: 1, outputTokens: 1 },
      answer: { type: 'boolean' as const, value: true, probability: 0.9 }
    }))
    const input = {
      agentId: 'example-agent',
      selection,
      supported: (target: { runtime: string; model: string }) =>
        target.runtime === 'claude' && target.model === 'model-capable',
      signal: new AbortController().signal,
      evaluationId: 'example-evaluation',
      current,
      decision: async () => ({ decision }),
      state: async () => state,
      evaluate
    }
    expect(await evaluateSessionModel(input)).toEqual({ runtime: 'claude', model: 'model-capable' })
    expect(await evaluateSessionModel({ ...input, supported: () => false })).toBeUndefined()
    current.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(false)
    expect(await evaluateSessionModel(input)).toBeUndefined()
    expect(
      await evaluateSessionModel({ ...input, evaluate: async () => ({ status: 'unavailable', reason: 'timeout' }) })
    ).toBeUndefined()
    expect(
      await evaluateSessionModel({
        ...input,
        selection: {
          ...selection,
          rules: [{ when: { type: 'choice', thresholds: { unknown: 0.5 } }, runtime: 'claude', model: 'model-capable' }]
        }
      })
    ).toBeUndefined()
    const abort = new AbortController()
    await expect(
      evaluateSessionModel({
        ...input,
        signal: abort.signal,
        evaluate: async () => {
          abort.abort()
          return { status: 'unavailable', reason: 'timeout' }
        }
      })
    ).rejects.toThrow()
  })

  it('checks the revision around bounded commits and diff under one GitHub repository grant', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes('/commits?')) return Response.json([{ commit: { message: 'Fix login' } }])
      if (new Headers(init?.headers).get('accept') === 'application/vnd.github.diff') return new Response(patch)
      return Response.json({ ...revision, body: 'The PR description', title: 'Not the input' })
    })
    vi.stubGlobal('fetch', fetcher)
    const getPostToken = vi.fn(async () => ({ token: 'fixture-token' }))
    const host = { getPostToken, invalidatePost: vi.fn() } as unknown as CodeHostTurnFinalHost
    const source = {
      hookId: 'hook-1',
      context: { source: 'github' as const, repo: 'example-org/example-repo', number: 42 },
      github: {
        repoId: '100',
        sourceInstallationId: '200',
        repoFullName: 'example-org/example-repo',
        subjectKind: 'pull_request' as const,
        pullNumber: 42,
        issueCommentId: '17'
      }
    }
    expect(await codeHostPullRequestContext(source, 'example-agent', host, new AbortController().signal)).toEqual({
      description: 'The PR description',
      ...revisionState,
      commitMessages: ['Fix login'],
      diff: patch,
      reasons: []
    })
    expect(getPostToken).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(fetcher.mock.calls.map(([url]) => String(url))).toContain(
      'https://api.github.com/repos/example-org/example-repo/pulls/42/commits?per_page=10&page=1'
    )
    expect(getPostToken).toHaveBeenCalledWith('example-agent', 'example-org/example-repo', 'hook-1')
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.github.com/repos/example-org/example-repo/pulls/42',
      expect.objectContaining({
        redirect: 'error',
        headers: { authorization: 'Bearer fixture-token', accept: 'application/json' }
      })
    )
    fetcher.mockClear()
    expect(
      await codeHostPullRequestContext({ hookId: 'hook-1' }, 'example-agent', host, new AbortController().signal)
    ).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(['gitlab', 'gitea'] as const)(
    'reads %s context through its existing instance-bound lease',
    async (provider) => {
      const token = vi.fn(async () => ({ token: 'fixture-token' }))
      const host = {
        getGitlabPostToken: token,
        gitlabHostFor: () => 'https://code.example.test',
        getGiteaPostToken: token,
        giteaHostFor: () => 'https://code.example.test'
      } as unknown as CodeHostTurnFinalHost
      const source =
        provider === 'gitlab'
          ? {
              hookId: 'hook-1',
              gitlab: {
                host: 'https://code.example.test',
                projectId: '100',
                projectPath: 'example-org/example-repo',
                target: { kind: 'merge_request' as const, iid: 42 }
              }
            }
          : {
              hookId: 'hook-1',
              gitea: {
                host: 'https://code.example.test',
                repoId: '100',
                repoPath: 'example-org/example-repo',
                target: { kind: 'pull' as const, index: 42 }
              }
            }
      const fetcher = vi.fn<typeof fetch>(async (url) => {
        if (String(url).includes('/commits?'))
          return Response.json([
            provider === 'gitlab' ? { message: 'Fix login' } : { commit: { message: 'Fix login' } }
          ])
        if (String(url).endsWith('/raw_diffs') || String(url).endsWith('.diff')) return new Response(patch)
        return Response.json({ ...revision, body: 'Description', description: 'Description' })
      })
      vi.stubGlobal('fetch', fetcher)
      expect(await codeHostPullRequestContext(source, 'example-agent', host, new AbortController().signal)).toEqual({
        description: 'Description',
        ...revisionState,
        commitMessages: ['Fix login'],
        diff: patch,
        reasons: []
      })
      expect(token).toHaveBeenCalledExactlyOnceWith('example-agent', '100', 'hook-1')
      const urls = fetcher.mock.calls.map(([url]) => String(url))
      expect(urls).toEqual(
        provider === 'gitlab'
          ? [
              'https://code.example.test/api/v4/projects/100/merge_requests/42',
              'https://code.example.test/api/v4/projects/100/merge_requests/42/commits?per_page=10&page=1',
              'https://code.example.test/api/v4/projects/100/merge_requests/42/raw_diffs',
              'https://code.example.test/api/v4/projects/100/merge_requests/42'
            ]
          : [
              'https://code.example.test/api/v1/repos/example-org/example-repo/pulls/42',
              'https://code.example.test/api/v1/repos/example-org/example-repo/pulls/42/commits?limit=10&page=1&verification=false&files=false',
              'https://code.example.test/api/v1/repos/example-org/example-repo/pulls/42.diff',
              'https://code.example.test/api/v1/repos/example-org/example-repo/pulls/42'
            ]
      )
      for (const [, init] of fetcher.mock.calls)
        expect(init).toMatchObject({
          redirect: 'error',
          headers: { authorization: `${provider === 'gitlab' ? 'Bearer' : 'token'} fixture-token` }
        })
    }
  )

  it.each(['commits', 'diff'] as const)(
    'abandons slow %s at the shared deadline and discards unverified supplements',
    async (slow) => {
      vi.useFakeTimers()
      const cancelled = vi.fn()
      const fetcher = vi.fn<typeof fetch>(async (url) => {
        if (String(url).endsWith(paths[slow])) return new Response(new ReadableStream({ cancel: cancelled }))
        if (String(url).endsWith(paths.commits)) return Response.json([{ commit: { message: 'Fix login' } }])
        if (String(url).endsWith(paths.diff)) return new Response(patch)
        return Response.json({ ...revision, body: 'Description' })
      })
      const result = readPullRequestContext(lease, paths, new AbortController().signal, fetcher)
      const settled = vi.fn()
      void result.then(settled)
      await vi.advanceTimersByTimeAsync(PULL_CONTEXT_TIMEOUT_MS - 1)
      expect(fetcher).toHaveBeenCalledTimes(3)
      expect(settled).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(await result).toEqual({
        description: 'Description',
        ...revisionState,
        commitMessages: [],
        diff: '',
        reasons: ['revision_unverified']
      })
      expect(cancelled).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('bounds response reads, cancels large streams, and marks partial context', async () => {
    const cancel = vi.fn()
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith(paths.commits))
        return Response.json(Array.from({ length: 10 }, () => ({ commit: { message: 'Fix' } })))
      if (String(url).endsWith(paths.diff))
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(Buffer.from(patch + '界'.repeat(5000)))
            },
            cancel
          })
        )
      return Response.json({ ...revision, body: 'Description' })
    })
    const result = await readPullRequestContext(lease, paths, new AbortController().signal, fetcher)
    expect(result).toMatchObject({ reasons: ['commit_limit', 'diff_truncated'] })
    expect(Buffer.byteLength(result!.diff)).toBeLessThanOrEqual(12 * 1024)
    expect(result!.diff).not.toContain('�')
    expect(cancel).toHaveBeenCalledOnce()
    const oversized = vi.fn()
    fetcher.mockImplementation(async (url) =>
      String(url).endsWith(paths.description)
        ? new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(1024 * 1024 + 1))
              },
              cancel: oversized
            })
          )
        : new Response('[]')
    )
    expect(await readPullRequestContext(lease, paths, new AbortController().signal, fetcher)).toBeUndefined()
    expect(oversized).toHaveBeenCalledOnce()
  })

  it('does not wait for a stalled token mint or issue requests after cancellation', async () => {
    const abort = new AbortController()
    let release!: (token: string) => void
    const fetcher = vi.fn<typeof fetch>()
    const result = readPullRequestContext(
      {
        ...lease,
        token: () =>
          new Promise((resolve) => {
            release = resolve
          })
      },
      paths,
      abort.signal,
      fetcher
    )
    const rejected = expect(result).rejects.toThrow('Cancelled')
    abort.abort(new Error('Cancelled'))
    await rejected
    release('fixture-token')
    await Promise.resolve()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('omits commits and diff if the PR moves during the read', async () => {
    let reads = 0
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith(paths.commits)) return Response.json([{ commit: { message: 'Fix login' } }])
      if (String(url).endsWith(paths.diff)) return new Response(patch)
      return Response.json({ ...revision, head: { sha: ++reads === 1 ? 'head' : 'new-head' }, body: 'Description' })
    })
    expect(await readPullRequestContext(lease, paths, new AbortController().signal, fetcher)).toEqual({
      ...revisionState,
      description: 'Description',
      commitMessages: [],
      diff: '',
      reasons: ['revision_changed']
    })
  })
})
