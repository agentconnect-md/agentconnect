// An API turn's Decision gate admits on a match, declines on an answered no, and fails open otherwise, reading nothing remote.
import { describe, expect, it, vi } from 'vitest'
import type {
  AgentApiGateProjection,
  ChannelDecisionGate,
  DecisionEvaluation,
  DecisionToolDefinition
} from '@agentconnect.md/protocol'
import {
  API_GATE_DEADLINE_MS,
  evaluateApiGate,
  type ApiGateEvidence,
  type ApiGateInput
} from '../src/decisions/api-gate.js'
import { apiGateEvaluationRecord } from '../src/decisions/api-gate-evaluations.js'

const ROOT = '11111111-1111-4111-8111-111111111111'
const SECOND = '22222222-2222-4222-8222-222222222222'
const STEP = '33333333-3333-4333-8333-333333333333'

const definition = (id: string): DecisionToolDefinition => ({
  id,
  name: 'On topic',
  providerId: 'example-provider',
  model: 'example-model',
  question: { type: 'boolean', instructions: 'Is it about the product?', criteria: { true: 'yes', false: 'no' } }
})
const answered = (value: boolean): DecisionEvaluation => ({
  status: 'answered',
  answer: { type: 'boolean', value, probability: value ? 0.9 : 0.1 },
  model: 'example-model',
  usage: { inputTokens: 1, outputTokens: 1 }
})
const gate: ChannelDecisionGate = { type: 'gate', decisionId: ROOT, when: { type: 'boolean', values: [true] } }
const projection = (g: ChannelDecisionGate = gate, ids = [ROOT]): AgentApiGateProjection => ({
  gate: g,
  definitions: ids.map(definition)
})

function input(over: Partial<ApiGateInput> = {}): ApiGateInput {
  return {
    agentId: 'agent-1',
    projection: projection(),
    text: 'How do I install the daemon?',
    evaluationId: 'turn-1',
    now: () => Date.now(),
    acquire: async () => ({ kind: 'acquired', release: () => undefined }),
    evaluate: async () => answered(true),
    ...over
  }
}

describe('evaluateApiGate', () => {
  it('admits a matching answer and evaluates the turn text', async () => {
    const evaluate = vi.fn(async () => answered(true))
    expect(await evaluateApiGate(input({ evaluate }))).toEqual({ admit: true, reason: 'matched' })
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        evaluationId: 'turn-1',
        state: expect.objectContaining({ currentMessage: { text: 'How do I install the daemon?' } })
      }),
      expect.anything()
    )
  })

  it('declines an answered no', async () => {
    expect(await evaluateApiGate(input({ evaluate: async () => answered(false) }))).toEqual({
      admit: false,
      reason: 'declined'
    })
  })

  it('follows a chained step to its answer', async () => {
    const chained: ChannelDecisionGate = {
      ...gate,
      nextStepId: STEP,
      steps: [{ id: STEP, decisionId: SECOND, when: { type: 'boolean', values: [true] } }]
    }
    const evaluate = vi.fn(async (i: { decision: { id?: string } }) => answered(i.decision.id === ROOT))
    const verdict = await evaluateApiGate(
      input({ projection: projection(chained, [ROOT, SECOND]), evaluate: evaluate as ApiGateInput['evaluate'] })
    )
    expect(evaluate).toHaveBeenCalledTimes(2)
    expect(verdict).toEqual({ admit: false, reason: 'declined' })
  })

  it('fails open when the evaluation is unavailable, capacity is full, or a Decision is missing', async () => {
    const unavailable = await evaluateApiGate(
      input({ evaluate: async () => ({ status: 'unavailable', reason: 'provider' }) })
    )
    expect(unavailable).toMatchObject({ admit: true, reason: 'unavailable', detail: 'provider' })
    const full = await evaluateApiGate(input({ acquire: async () => ({ kind: 'capacity', scope: 'queue' }) }))
    expect(full).toMatchObject({ admit: true, reason: 'unavailable', detail: 'capacity' })
    const missing = await evaluateApiGate(input({ projection: projection(gate, [SECOND]) }))
    expect(missing).toMatchObject({ admit: true, reason: 'unavailable', detail: 'decision_missing' })
  })

  it('answers within its deadline even when evaluation never returns', async () => {
    vi.useFakeTimers()
    try {
      const pending = evaluateApiGate(input({ evaluate: () => new Promise<DecisionEvaluation>(() => undefined) }))
      await vi.advanceTimersByTimeAsync(API_GATE_DEADLINE_MS)
      expect(await pending).toMatchObject({ admit: true, reason: 'unavailable', detail: 'timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases its slot', async () => {
    const release = vi.fn()
    await evaluateApiGate(input({ acquire: async () => ({ kind: 'acquired', release }) }))
    expect(release).toHaveBeenCalledOnce()
  })

  it("reports what it asked and was answered, with the root step's raw bodies", async () => {
    let evidence: ApiGateEvidence | undefined
    const verdict = await evaluateApiGate(
      input({
        evaluate: async (req) => {
          req.onRawRequest?.('{"request":1}')
          req.onRawResponse?.('{"response":1}')
          return answered(false)
        },
        onEvidence: (e) => (evidence = e)
      })
    )
    expect(evidence).toMatchObject({
      root: { id: ROOT },
      evaluation: answered(false),
      chain: [{ decisionId: ROOT, evaluation: answered(false) }],
      rawRequest: '{"request":1}',
      rawResponse: '{"response":1}'
    })
    const record = apiGateEvaluationRecord({
      projection: projection(),
      verdict,
      evidence: evidence!,
      messageId: 'turn-1',
      sender: 'Example caller',
      text: 'How do I install the daemon?',
      at: 0
    })
    expect(record?.summary).toMatchObject({ outcome: 'skipped', reason: null, answer: { value: false } })
    expect(record?.detail).toMatchObject({
      snapshot: { decisionId: ROOT, condition: gate.when },
      input: {
        currentMessage: { id: 'turn-1', sender: { id: 'Example caller' }, text: 'How do I install the daemon?' }
      },
      rawRequest: { text: '{"request":1}', truncated: false }
    })
  })

  it('records a failed evaluation as unavailable and a missing Decision not at all', async () => {
    let evidence: ApiGateEvidence | undefined
    const onEvidence = (e: ApiGateEvidence) => (evidence = e)
    const failed = await evaluateApiGate(
      input({ evaluate: async () => ({ status: 'unavailable', reason: 'provider' }), onEvidence })
    )
    const record = (verdict: typeof failed) =>
      apiGateEvaluationRecord({
        projection: projection(),
        verdict,
        evidence: evidence!,
        messageId: 'm',
        sender: 'api',
        text: 'x',
        at: 0
      })
    expect(record(failed)?.summary).toMatchObject({ outcome: 'unavailable', reason: 'provider' })
    const missing = await evaluateApiGate(input({ projection: projection(gate, [SECOND]), onEvidence }))
    expect(record(missing)).toBeNull()
  })
})
