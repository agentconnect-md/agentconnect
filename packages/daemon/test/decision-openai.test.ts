import { describe, expect, it, vi } from 'vitest'
import type { DecisionQuestion } from '@agentconnect.md/protocol'
import { DecisionEvaluator, decisionRequestBody, type DecisionEvaluationInput } from '../src/decisions/evaluator.js'
import { fitDecisionState, largestDecisionRequest } from '../src/decisions/state.js'

const input: DecisionEvaluationInput = {
  agentId: 'example-agent',
  evaluationId: 'example-evaluation',
  decision: {
    providerId: 'openai',
    model: 'gpt-6-luna',
    question: { type: 'boolean', instructions: 'Reply?', criteria: { true: 'Actionable', false: 'Noise' } }
  },
  state: { currentMessage: { text: 'Help me' } }
}
const predicate = { type: 'predicate', name: 'decision', probability: 0.8 }
const response = (answer: unknown) =>
  Response.json({
    model: 'gpt-6-luna',
    answers: [answer],
    usage: { input_tokens: 42, output_tokens: 0 }
  })
function setup() {
  const credentials = vi.fn(async () => ({
    credentials: {
      apiKey: 'example-openai-key',
      endpoint: null as string | null,
      headers: { 'x-extra': 'example-header' }
    }
  }))
  const fetcher = vi.fn<typeof fetch>(async () => response(predicate))
  const keyServer = vi.fn(() => undefined)
  const evaluator = new DecisionEvaluator({ orgForAgent: () => 'example-org', credentials, fetch: fetcher, keyServer })
  return { evaluator, credentials, fetcher, keyServer }
}

describe('OpenAI Decisions provider', () => {
  it('uses OpenAI credentials and preserves state, boolean criteria, usage and raw bodies', async () => {
    const { evaluator, credentials, fetcher } = setup()
    const onRawRequest = vi.fn(),
      onRawResponse = vi.fn()
    expect(await evaluator.evaluate({ ...input, onRawRequest, onRawResponse })).toEqual({
      status: 'answered',
      model: 'gpt-6-luna',
      answer: { type: 'boolean', value: true, probability: 0.8 },
      usage: { inputTokens: 42, outputTokens: 0 }
    })
    expect(credentials.mock.calls[0]).toEqual([{ agentId: input.agentId, provider: 'openai' }, expect.any(AbortSignal)])
    const [url, request] = fetcher.mock.calls[0]!
    expect(String(url)).toBe('https://api.openai.com/v1/decisions')
    expect(new Headers(request!.headers).get('authorization')).toBe('Bearer example-openai-key')
    expect(new Headers(request!.headers).get('x-extra')).toBe('example-header')
    expect(request!.redirect).toBe('error')
    const body = JSON.parse(request!.body as string)
    expect(JSON.parse(body.input)).toEqual(input.state)
    expect(body.questions).toEqual([
      { name: 'decision', type: 'predicate', instructions: 'Reply?\n\nTrue: Actionable\nFalse: Noise' }
    ])
    expect(onRawRequest).toHaveBeenCalledWith(request!.body)
    expect(JSON.parse(onRawResponse.mock.calls[0]![0])).toMatchObject({ answers: [predicate] })
    credentials.mockResolvedValueOnce({
      credentials: {
        apiKey: 'replacement-key',
        endpoint: 'https://gateway.example.test/openai/v1/',
        headers: { 'x-extra': 'replacement-header' }
      }
    })
    await evaluator.evaluate(input)
    expect(String(fetcher.mock.calls[1]![0])).toBe('https://gateway.example.test/openai/v1/decisions')
  })

  it('normalizes choice distributions and score levels by index rather than response order', async () => {
    const { evaluator, fetcher } = setup()
    const cases: Array<{
      question: DecisionQuestion
      answer: unknown
      expected: unknown
      wire: Record<string, unknown>
    }> = [
      {
        question: { type: 'choice', instructions: 'Route', criteria: { a: 'Billing', b: 'Support' } },
        answer: {
          type: 'choice',
          name: 'decision',
          choice: 'b',
          confidence: 0.6,
          probabilities: [
            { value: 'b', probability: 0.8 },
            { value: 'a', probability: 0.2 }
          ]
        },
        expected: { type: 'choice', value: 'b', confidence: 0.6, probabilities: { a: 0.2, b: 0.8 } },
        wire: {
          type: 'choice',
          choices: [
            { value: 'a', description: 'Billing' },
            { value: 'b', description: 'Support' }
          ]
        }
      },
      {
        question: { type: 'score', instructions: 'Severity', criteria: ['Minor', 'Major', 'Critical'] },
        answer: {
          type: 'score',
          name: 'decision',
          score: 1.1,
          confidence: 0.55,
          probabilities: [
            { value: 2, label: '2', probability: 0.2 },
            { value: 0, label: '0', probability: 0.1 },
            { value: 1, label: '1', probability: 0.7 }
          ]
        },
        expected: { type: 'score', value: 1.1, confidence: 0.55, probabilities: [0.1, 0.7, 0.2] },
        wire: {
          type: 'score',
          levels: [
            { label: '0', description: 'Minor' },
            { label: '1', description: 'Major' },
            { label: '2', description: 'Critical' }
          ]
        }
      }
    ]
    for (const { question, answer, expected, wire } of cases) {
      fetcher.mockResolvedValueOnce(response(answer))
      expect(await evaluator.evaluate({ ...input, decision: { ...input.decision, question } })).toMatchObject({
        status: 'answered',
        answer: expected
      })
      expect(JSON.parse(fetcher.mock.lastCall![1]!.body as string).questions[0]).toMatchObject(wire)
    }
  })

  it('keeps refusals unavailable and rejects malformed, mismatched and duplicate answers', async () => {
    const { evaluator, fetcher } = setup()
    fetcher.mockResolvedValueOnce(response({ type: 'refusal', name: 'decision' }))
    expect(await evaluator.evaluate(input)).toEqual({ status: 'unavailable', reason: 'provider' })
    for (const answer of [
      { ...predicate, name: 'wrong' },
      { ...predicate, probability: 2 },
      { ...predicate, type: 'noul' }
    ]) {
      fetcher.mockResolvedValueOnce(response(answer))
      expect(await evaluator.evaluate(input)).toEqual({ status: 'unavailable', reason: 'invalid_response' })
    }
    const question: DecisionQuestion = { type: 'choice', instructions: 'Route', criteria: { a: 'A', b: 'B' } }
    fetcher.mockResolvedValueOnce(
      response({
        type: 'choice',
        name: 'decision',
        choice: 'a',
        confidence: 0.5,
        probabilities: [
          { value: 'a', probability: 0.2 },
          { value: 'a', probability: 0.3 },
          { value: 'b', probability: 0.7 }
        ]
      })
    )
    expect(await evaluator.evaluate({ ...input, decision: { ...input.decision, question } })).toEqual({
      status: 'unavailable',
      reason: 'invalid_response'
    })
  })

  it('never uses the TypeSafe Cloud gateway for missing OpenAI credentials', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const keyServer = vi.fn(() => undefined)
    const evaluator = new DecisionEvaluator({
      orgForAgent: () => 'example-org',
      credentials: async () => ({ credentials: null }),
      keyServer,
      cloudBaseUrl: 'https://gateway.example.test/typesafe',
      fetch: fetcher
    })
    expect(await evaluator.evaluate(input)).toEqual({ status: 'unavailable', reason: 'credentials' })
    expect(keyServer).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([
    [401, 'credentials'],
    [429, 'capacity'],
    [413, 'unsupported_input'],
    [500, 'provider']
  ] as const)('maps HTTP %s to %s', async (status, reason) => {
    const { evaluator, fetcher } = setup()
    fetcher.mockResolvedValueOnce(new Response('upstream error', { status }))
    expect(await evaluator.evaluate(input)).toEqual({ status: 'unavailable', reason })
  })

  it('budgets escaped input for every provider in a mixed chain', () => {
    const decisions = [
      input.decision,
      {
        ...input.decision,
        providerId: 'typesafe',
        model: 'jev-latest',
        question: { ...input.decision.question, instructions: 'x'.repeat(2000) }
      }
    ] as const
    const result = fitDecisionState(
      { currentMessage: { text: 'current' }, history: Array.from({ length: 8 }, () => ({ text: '"\\'.repeat(2000) })) },
      largestDecisionRequest(decisions)
    )
    expect(result.unsupported).not.toBe(true)
    if (result.unsupported) return
    expect(result.omittedMessages).toBeGreaterThan(0)
    for (const decision of decisions)
      expect(Buffer.byteLength(decisionRequestBody({ decision, state: result.state }))).toBeLessThanOrEqual(32 * 1024)
  })
})
