// An API turn's Decision gate admits on a match, declines on an answered no, and fails open otherwise.
import { describe, expect, it, vi } from 'vitest'
import type { ChannelDecisionGate, DecisionEvaluation, DecisionToolDefinition } from '@agentconnect.md/protocol'
import { evaluateApiGate, type ApiGateInput } from '../src/decisions/api-gate.js'

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

function input(over: Partial<ApiGateInput> = {}): ApiGateInput {
  return {
    agentId: 'agent-1',
    gate,
    text: 'How do I install the daemon?',
    evaluationId: 'turn-1',
    now: () => Date.now(),
    decision: async (id) => ({ decision: definition(id) }),
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
    const verdict = await evaluateApiGate(input({ gate: chained, evaluate: evaluate as ApiGateInput['evaluate'] }))
    expect(evaluate).toHaveBeenCalledTimes(2)
    expect(verdict).toEqual({ admit: false, reason: 'declined' })
  })

  it('fails open when the evaluation is unavailable, capacity is full, or a Decision cannot be read', async () => {
    const unavailable = await evaluateApiGate(
      input({ evaluate: async () => ({ status: 'unavailable', reason: 'provider' }) })
    )
    expect(unavailable).toMatchObject({ admit: true, reason: 'unavailable', detail: 'provider' })
    const full = await evaluateApiGate(input({ acquire: async () => ({ kind: 'capacity', scope: 'queue' }) }))
    expect(full).toMatchObject({ admit: true, reason: 'unavailable', detail: 'capacity' })
    const missing = await evaluateApiGate(input({ decision: async () => ({ decision: null }) }))
    expect(missing).toMatchObject({ admit: true, reason: 'unavailable', detail: 'decision_missing' })
    const thrown = await evaluateApiGate(
      input({
        decision: async () => {
          throw new Error('offline')
        }
      })
    )
    expect(thrown).toMatchObject({ admit: true, reason: 'unavailable' })
  })

  it('releases its slot', async () => {
    const release = vi.fn()
    await evaluateApiGate(input({ acquire: async () => ({ kind: 'acquired', release }) }))
    expect(release).toHaveBeenCalledOnce()
  })
})
