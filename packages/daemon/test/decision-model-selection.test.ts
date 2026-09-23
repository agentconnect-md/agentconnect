import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DecisionToolDefinition, AgentModelSelection } from '@agentconnect.md/protocol'
import { evaluateSessionModel, modelSelectionState } from '../src/decisions/model-selection.js'
import { codeHostPullRequestDescription, type CodeHostTurnFinalHost } from '../src/codehost/turn-final.js'
import { readPullDescription } from '../src/codehost/pull-description.js'

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
afterEach(() => vi.unstubAllGlobals())

describe('session model evaluation', () => {
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

  it('reads the root PR description for a comment event using the repository grant', async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ body: 'The PR description', title: 'Not the input' }))
    )
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
    expect(await codeHostPullRequestDescription(source, 'example-agent', host, new AbortController().signal)).toBe(
      'The PR description'
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
      await codeHostPullRequestDescription({ hookId: 'hook-1' }, 'example-agent', host, new AbortController().signal)
    ).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('refuses oversized descriptions and cancels the remaining response', async () => {
    const cancel = vi.fn()
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024 + 1))
        },
        cancel
      })
    )
    expect(
      await readPullDescription(
        {
          token: async () => 'fixture-token',
          invalidateToken: () => {},
          apiBaseUrl: () => 'https://code.example.test'
        },
        '/pulls/42',
        'body',
        new AbortController().signal,
        'Bearer',
        vi.fn(async () => response)
      )
    ).toBeUndefined()
    expect(cancel).toHaveBeenCalledOnce()
  })
})
