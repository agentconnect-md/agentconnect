// auto-session-mode.md §4.7: a coordinator filter verdict as Recent evaluations reads it back.
import { describe, expect, it } from 'vitest'
import { COORDINATOR_FILTER_DECISION_ID } from '@agentconnect.md/protocol'
import {
  CoordinatorFilterEvaluationReader,
  coordinatorFilterEvaluationRecord
} from '../src/auto-session/coordinator-filter-evaluations.js'
import { COORDINATOR_FILTER_QUESTION } from '../src/auto-session/coordinator-filter.js'
import { openTestStore } from './store-support.js'

const AGENT = '11111111-1111-4111-8111-111111111111'
const filter = { providerId: 'typesafe', model: 'jev-1.13.0' }

function verdict(i: number, probability: number | null) {
  return coordinatorFilterEvaluationRecord({
    filter,
    messageId: `slack:C1:${i}.1`,
    text: `message ${i}\nsecond line`,
    sender: 'U1',
    state: undefined,
    evaluation:
      probability === null
        ? { status: 'unavailable', reason: 'timeout' }
        : {
            status: 'answered',
            answer: { type: 'boolean', value: probability >= 0.5, probability },
            model: 'jev-1.13.0',
            usage: { inputTokens: 10, outputTokens: 1 }
          },
    admits: probability === null || probability >= 0.25,
    latencyMs: 40,
    rawRequest: '{"model":"jev-1.13.0"}',
    at: Date.UTC(2026, 10, 11, 8, 0, i)
  })
}

describe('coordinator filter evaluations', () => {
  it('pages newest first and reads one verdict with its frozen question and input', async () => {
    const store = await openTestStore()
    for (const [i, p] of [
      [1, 0.9],
      [2, 0.1],
      [3, null]
    ] as const) {
      const { summary, detail } = verdict(i, p)
      await store.saveCoordinatorFilterEvaluation(AGENT, `slack:C1:${i}.1`, summary, detail, 1_000 + i)
    }
    const reader = new CoordinatorFilterEvaluationReader({ store: () => store, servesAgent: () => true })
    const first = await reader.list('org-1', { agentId: AGENT, limit: 2 })
    expect(first.items.map((item) => [item.title, item.outcome, item.reason])).toEqual([
      ['message 3', 'unavailable', 'timeout'],
      ['message 2', 'skipped', null]
    ])
    expect(first.items[0]).toMatchObject({ decisionId: COORDINATOR_FILTER_DECISION_ID, requestedModel: 'jev-1.13.0' })
    const rest = await reader.list('org-1', { agentId: AGENT, limit: 2, cursor: first.nextCursor! })
    expect(rest).toMatchObject({ items: [{ title: 'message 1', outcome: 'triggered' }], nextCursor: null })

    const { evaluation } = await reader.get('org-1', { agentId: AGENT, seq: first.items[1]!.seq })
    expect(evaluation).toMatchObject({
      outcome: 'skipped',
      answer: { type: 'boolean', value: false },
      snapshot: { decisionId: COORDINATOR_FILTER_DECISION_ID, question: COORDINATOR_FILTER_QUESTION },
      input: { currentMessage: { id: 'slack:C1:2.1', sender: { id: 'U1' }, text: 'message 2\nsecond line' } },
      rawRequest: { text: '{"model":"jev-1.13.0"}', truncated: false }
    })
    await store.close()
  })

  it('keeps the title once the bodies are stripped, and refuses an agent the daemon does not serve', async () => {
    const store = await openTestStore()
    for (let i = 1; i <= 22; i++) {
      const { summary, detail } = verdict(i, 0.1)
      await store.saveCoordinatorFilterEvaluation(AGENT, `slack:C1:${i}.1`, summary, detail, Date.now())
    }
    expect(await store.stripCoordinatorFilterEvaluationBodies(Date.now())).toBe(2)
    const reader = new CoordinatorFilterEvaluationReader({ store: () => store, servesAgent: () => true })
    const page = await reader.list('org-1', { agentId: AGENT, limit: 50 })
    expect(page.items.at(-1)).toMatchObject({ title: 'message 1', detailsExpired: true })
    const { evaluation } = await reader.get('org-1', { agentId: AGENT, seq: page.items.at(-1)!.seq })
    expect(evaluation).toMatchObject({ title: 'message 1', input: null, snapshot: null })
    const stranger = new CoordinatorFilterEvaluationReader({ store: () => store, servesAgent: () => false })
    await expect(stranger.list('org-1', { agentId: AGENT, limit: 20 })).rejects.toThrow()
    await store.close()
  })
})
