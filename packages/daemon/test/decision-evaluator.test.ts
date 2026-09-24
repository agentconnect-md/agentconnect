import { describe, expect, it, vi } from 'vitest'
import { type DecisionQuestion, type ProviderCredentialsReply } from '@agentconnect.md/protocol'
import { DecisionEvaluator, type DecisionEvaluationInput } from '../src/decisions/evaluator.js'
import { KeyServerClient } from '../src/key-server/client.js'

const agentId = '11111111-1111-4111-8111-111111111111'
const input: DecisionEvaluationInput = {
  agentId,
  evaluationId: 'example-evaluation',
  decision: {
    providerId: 'typesafe',
    model: 'jev-latest',
    question: { type: 'boolean', instructions: 'Is a reply useful?', criteria: { true: 'Actionable', false: 'Noise' } }
  },
  state: { messages: ['Earlier context', 'Current message'] }
}
const byok = {
  apiKey: 'example-key',
  endpoint: 'https://gateway.example.test/typesafe',
  headers: { 'x-extra': 'example-extra' }
}
const answer = (value: unknown) =>
  Response.json({ model: 'jev-example', answers: { decision: value }, usage: { input_tokens: 10, output_tokens: 2 } })
const booleanAnswer = () => answer({ type: 'noul', noul: 0.75 })

function setup(over: { configured?: boolean; timeoutMs?: number; now?: () => number } = {}) {
  const credentials = vi.fn(async (): Promise<ProviderCredentialsReply> => ({
    credentials: over.configured === false ? null : byok
  }))
  const providerFetch = vi.fn<typeof fetch>(async () => booleanAnswer())
  const issuerFetch = vi.fn<typeof fetch>(async (url) =>
    new URL(String(url)).pathname === '/v1/issue-key'
      ? Response.json({ keyId: 'example-grant', key: 'example-cloud-token', expiresInSeconds: 60 })
      : Response.json({})
  )
  const issuer = new KeyServerClient('https://issuer.example.test', { fetch: issuerFetch })
  const evaluator = new DecisionEvaluator({
    orgForAgent: () => 'example-org',
    credentials,
    keyServer: () => issuer,
    cloudBaseUrl: 'https://cloud.example.test/typesafe',
    fetch: providerFetch,
    timeoutMs: over.timeoutMs,
    now: over.now
  })
  return { evaluator, credentials, providerFetch, issuerFetch }
}

describe('daemon Decision evaluator', () => {
  it('projects supported models and Cloud availability without requesting keys or calling a provider', () => {
    const { evaluator, credentials, providerFetch, issuerFetch } = setup()
    expect(evaluator.catalog()).toMatchObject({
      providers: [
        {
          id: 'typesafe',
          cloudAvailable: true,
          models: [{ id: 'jev-1.13.0' }, { id: 'jev-latest' }, { id: 'jev-preview' }]
        }
      ]
    })
    expect(credentials).not.toHaveBeenCalled()
    expect(providerFetch).not.toHaveBeenCalled()
    expect(issuerFetch).not.toHaveBeenCalled()
    const local = new DecisionEvaluator({ orgForAgent: () => undefined, credentials, keyServer: () => undefined })
    expect(local.catalog().providers[0]!.cloudAvailable).toBe(false)
  })
  it('uses BYOK endpoint and headers, sends context/model, and reads replacements on the next evaluation', async () => {
    const { evaluator, credentials, providerFetch, issuerFetch } = setup()
    const result = await evaluator.evaluate(input)
    expect(result).toEqual({
      status: 'answered',
      answer: { type: 'boolean', value: true, probability: 0.75 },
      model: 'jev-example',
      usage: { inputTokens: 10, outputTokens: 2 }
    })
    const [url, request] = providerFetch.mock.calls[0]!
    expect(String(url)).toBe('https://gateway.example.test/typesafe/v1/systemone')
    expect(new Headers(request!.headers).get('authorization')).toBe('Bearer example-key')
    expect(new Headers(request!.headers).get('x-extra')).toBe('example-extra')
    expect(JSON.parse(request!.body as string)).toEqual({
      model: input.decision.model,
      state: input.state,
      questions: { decision: { ...input.decision.question, type: 'noul' } }
    })
    expect(request!.redirect).toBe('error')
    credentials.mockResolvedValueOnce({ credentials: { ...byok, apiKey: 'example-replacement' } })
    await evaluator.evaluate(input)
    expect(new Headers(providerFetch.mock.calls[1]![1]!.headers).get('authorization')).toBe(
      'Bearer example-replacement'
    )
    expect(issuerFetch).not.toHaveBeenCalled()
  })

  it('uses the existing IssueKey/RevokeKey contract for Cloud only after confirmed absence', async () => {
    const { evaluator, credentials, providerFetch, issuerFetch } = setup()
    credentials.mockResolvedValueOnce({ credentials: null })
    expect((await evaluator.evaluate(input)).status).toBe('answered')
    expect(JSON.parse(issuerFetch.mock.calls[0]![1]!.body as string)).toEqual({
      orgId: 'example-org',
      agentId,
      sessionId: 'decision:example-evaluation',
      provider: 'typesafe',
      ttlSeconds: 60
    })
    expect(String(providerFetch.mock.calls[0]![0])).toBe('https://cloud.example.test/typesafe/v1/systemone')
    expect(new Headers(providerFetch.mock.calls[0]![1]!.headers).get('authorization')).toBe(
      'Bearer example-cloud-token'
    )
    expect(String(issuerFetch.mock.calls[1]![0])).toBe('https://issuer.example.test/v1/revoke-key')
    expect(JSON.parse(issuerFetch.mock.calls[1]![1]!.body as string)).toEqual({ keyId: 'example-grant' })
  })

  it('does not switch to credits after a BYOK read or provider authentication failure', async () => {
    const { evaluator, credentials, providerFetch, issuerFetch } = setup()
    credentials.mockRejectedValueOnce(new Error('example-secret'))
    expect(await evaluator.evaluate(input)).toEqual({ status: 'unavailable', reason: 'credentials' })
    expect(providerFetch).not.toHaveBeenCalled()
    providerFetch.mockResolvedValueOnce(new Response('example-secret', { status: 401 }))
    expect(await evaluator.evaluate(input)).toEqual({ status: 'unavailable', reason: 'credentials' })
    expect(issuerFetch).not.toHaveBeenCalled()
  })

  it('requires both a configured issuer and gateway for Cloud and fails closed on issuer denial', async () => {
    const fetcher = vi.fn<typeof fetch>()
    for (const cloudBaseUrl of [undefined, 'file:///tmp/gateway']) {
      const evaluator = new DecisionEvaluator({
        orgForAgent: () => 'example-org',
        credentials: async () => ({ credentials: null }),
        keyServer: () => new KeyServerClient('https://issuer.example.test', { fetch: fetcher }),
        cloudBaseUrl,
        fetch: fetcher
      })
      expect(await evaluator.evaluate(input)).toEqual({ status: 'unavailable', reason: 'credentials' })
    }
    const noIssuer = new DecisionEvaluator({
      orgForAgent: () => 'example-org',
      credentials: async () => ({ credentials: null }),
      keyServer: () => undefined,
      cloudBaseUrl: 'https://cloud.example.test/typesafe',
      fetch: fetcher
    })
    expect(await noIssuer.evaluate(input)).toEqual({ status: 'unavailable', reason: 'credentials' })
    expect(fetcher).not.toHaveBeenCalled()
    const { evaluator, providerFetch, issuerFetch } = setup({ configured: false })
    issuerFetch.mockResolvedValueOnce(
      Response.json({ error: { code: 'quota_denied', message: 'example-sensitive-details' } }, { status: 403 })
    )
    expect(await evaluator.evaluate(input)).toEqual({ status: 'unavailable', reason: 'credentials' })
    expect(providerFetch).not.toHaveBeenCalled()
  })

  it('preserves Choice distributions and fractional Score values and rejects malformed domains', async () => {
    const { evaluator, providerFetch } = setup()
    const cases: Array<{ question: DecisionQuestion; raw: unknown; normalized: unknown }> = [
      {
        question: {
          type: 'choice',
          instructions: 'Select a group',
          criteria: { billing: 'Payments', technical: 'Bugs' }
        },
        raw: { type: 'choice', choice: 'billing', probabilities: { billing: 0.6, technical: 0.4 }, confidence: 0.2 },
        normalized: {
          type: 'choice',
          value: 'billing',
          probabilities: { billing: 0.6, technical: 0.4 },
          confidence: 0.2
        }
      },
      {
        question: { type: 'score', instructions: 'Rate frustration', criteria: ['Calm', 'Upset', 'Angry'] },
        raw: { type: 'score', score: 1.25, probabilities: { '0': 0, '1': 0.75, '2': 0.25 }, confidence: 0.5 },
        normalized: { type: 'score', value: 1.25, probabilities: [0, 0.75, 0.25], confidence: 0.5 }
      }
    ]
    for (const example of cases) {
      const candidate = { ...input, decision: { ...input.decision, question: example.question } }
      providerFetch.mockResolvedValueOnce(answer(example.raw))
      expect(await evaluator.evaluate(candidate)).toMatchObject({ status: 'answered', answer: example.normalized })
      providerFetch.mockResolvedValueOnce(answer({ ...(example.raw as object), probabilities: { wrong: 1 } }))
      expect(await evaluator.evaluate(candidate)).toEqual({ status: 'unavailable', reason: 'invalid_response' })
    }
  })

  it('hands the exact response body to onRawResponse for answers, malformed bodies, and error statuses', async () => {
    const { evaluator, providerFetch } = setup()
    const seen: string[] = []
    const capture = { ...input, onRawResponse: (text: string) => seen.push(text) }
    const body = JSON.stringify({
      model: 'jev-example',
      answers: { decision: { type: 'noul', noul: 0.75 } },
      usage: { input_tokens: 10, output_tokens: 2 }
    })
    providerFetch.mockResolvedValueOnce(new Response(body))
    expect(await evaluator.evaluate(capture)).toMatchObject({ status: 'answered' })
    providerFetch.mockResolvedValueOnce(new Response('{"model": "jev-example", "answers": '))
    expect(await evaluator.evaluate(capture)).toEqual({ status: 'unavailable', reason: 'invalid_response' })
    providerFetch.mockResolvedValueOnce(new Response('{"error":"bad state"}', { status: 422 }))
    expect(await evaluator.evaluate(capture)).toEqual({ status: 'unavailable', reason: 'unsupported_input' })
    expect(seen).toEqual([body, '{"model": "jev-example", "answers": ', '{"error":"bad state"}'])
    // The protocol result never carries the raw body, so preview frames stay strict-parseable.
    providerFetch.mockResolvedValueOnce(new Response(body))
    expect(Object.keys(await evaluator.evaluate(capture))).toEqual(['status', 'answer', 'model', 'usage'])
  })

  it('hands onRawRequest the exact body sent, and nothing when no request goes out', async () => {
    const { evaluator, credentials, providerFetch } = setup()
    const sent: string[] = []
    const capture = { ...input, onRawRequest: (text: string) => sent.push(text) }
    await evaluator.evaluate(capture)
    expect(sent).toEqual([providerFetch.mock.calls[0]![1]!.body])
    credentials.mockRejectedValueOnce(new Error('no key'))
    expect(await evaluator.evaluate(capture)).toEqual({ status: 'unavailable', reason: 'credentials' })
    expect(sent).toHaveLength(1)
  })

  it('bounds input and active evaluations and treats cancellation differently from a timeout', async () => {
    const { evaluator, providerFetch } = setup({ timeoutMs: 30 })
    expect(await evaluator.evaluate({ ...input, state: { text: 'x'.repeat(33 * 1024) } })).toEqual({
      status: 'unavailable',
      reason: 'unsupported_input'
    })
    providerFetch.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true })
        })
    )
    const pending = Array.from({ length: 4 }, () => evaluator.evaluate(input))
    expect(await evaluator.evaluate(input)).toEqual({ status: 'unavailable', reason: 'capacity' })
    expect(await Promise.all(pending)).toEqual(
      Array.from({ length: 4 }, () => ({ status: 'unavailable', reason: 'timeout' }))
    )
    const cancellation = new AbortController()
    const cancelled = evaluator.evaluate(input, cancellation.signal)
    cancellation.abort()
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    evaluator.close()
    await expect(evaluator.evaluate(input)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('shortens the timeout to the decision-stage deadline and times out a past one without I/O', async () => {
    const { evaluator, providerFetch, credentials } = setup({ timeoutMs: 5_000 })
    expect(await evaluator.evaluate({ ...input, deadlineAt: Date.now() - 1 })).toEqual({
      status: 'unavailable',
      reason: 'timeout'
    })
    expect(credentials).not.toHaveBeenCalled()
    expect(providerFetch).not.toHaveBeenCalled()
    providerFetch.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true })
        })
    )
    const started = Date.now()
    expect(await evaluator.evaluate({ ...input, deadlineAt: Date.now() + 40 })).toEqual({
      status: 'unavailable',
      reason: 'timeout'
    })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('evaluates against a sub-millisecond clock whose remaining deadline is fractional', async () => {
    const { evaluator, providerFetch } = setup({ now: () => performance.timeOrigin + performance.now() })
    expect(await evaluator.evaluate({ ...input, deadlineAt: Date.now() + 4_000.5 })).toMatchObject({
      status: 'answered'
    })
    expect(providerFetch).toHaveBeenCalledOnce()
  })
})
