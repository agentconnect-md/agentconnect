import { describe, expect, it } from 'vitest'
import { DecisionModelEvaluationReader } from '../src/decisions/model-evaluations.js'
import { STORE_RETENTION_RULES, StoreRetentionSweeper } from '../src/store/retention.js'
import { openTestStore } from './store-support.js'

const AGENT = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const DECISION = '33333333-3333-4333-8333-333333333333'
const DAY = 24 * 3_600_000
const AT = 1_800_000_000_000
const sessionId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
const question = { type: 'boolean' as const, instructions: 'Choose a model?', criteria: { true: 'Yes', false: 'No' } }

describe('model selection evaluation history', () => {
  it('filters by Decision before paging an agent lane', async () => {
    const store = await openTestStore()
    const reader = new DecisionModelEvaluationReader({ store: () => store, servesAgent: () => true })
    const save = (i: number, decisionId: string) =>
      store.saveDecisionModelEvaluation(
        AGENT,
        sessionId(i),
        {
          at: new Date(AT).toISOString(),
          sessionId: sessionId(i),
          decisionId,
          outcome: 'selected',
          reason: null,
          target: { runtime: 'test', model: 'chosen' },
          answer: null,
          requestedModel: null,
          actualModel: null,
          latencyMs: null,
          usage: null
        },
        { selection: null, question: null, input: null, fullAnswer: null, rawRequest: null, rawResponse: null },
        AT
      )
    await save(1, DECISION)
    await save(2, OTHER)
    await save(3, DECISION)
    const page = await reader.list('', { agentId: AGENT, decisionId: DECISION, limit: 1 })
    expect(page.items.map((item) => item.sessionId)).toEqual([sessionId(3)])
    expect(page.nextCursor).toBe(page.items[0]!.seq)
    expect(
      (await reader.list('', { agentId: AGENT, decisionId: DECISION, cursor: page.nextCursor!, limit: 1 })).items.map(
        (item) => item.sessionId
      )
    ).toEqual([sessionId(1)])
    expect(
      (await reader.list('', { agentId: AGENT, decisionId: OTHER, limit: 20 })).items.map((item) => item.sessionId)
    ).toEqual([sessionId(2)])
    await store.close()
  })

  it('keeps a separate per-agent lane, strips bodies after 20 newer choices or 24 hours, and deletes summaries after seven days', async () => {
    const store = await openTestStore()
    const reader = new DecisionModelEvaluationReader({
      store: () => store,
      servesAgent: (orgId, agentId) => orgId === '' && agentId === AGENT
    })
    const save = async (agentId: string, i: number, at = AT) =>
      store.saveDecisionModelEvaluation(
        agentId,
        sessionId(i),
        {
          at: new Date(at).toISOString(),
          sessionId: sessionId(i),
          decisionId: DECISION,
          outcome: 'selected',
          reason: null,
          target: { runtime: 'test', model: 'chosen' },
          answer: { type: 'boolean', value: true, probability: 0.9 },
          requestedModel: 'jev-latest',
          actualModel: 'jev-latest',
          latencyMs: 12,
          usage: { inputTokens: 1, outputTokens: 1 }
        },
        {
          selection: {
            decisionId: DECISION,
            rules: [{ when: { type: 'boolean', values: [true] }, runtime: 'test', model: 'chosen' }]
          },
          question,
          input: { currentMessage: { text: 'Choose' } },
          fullAnswer: { type: 'boolean', value: true, probability: 0.9 },
          chain: [
            {
              stepId: '',
              decisionId: DECISION,
              evaluation: {
                status: 'answered',
                answer: { type: 'boolean', value: true, probability: 0.9 },
                model: 'jev-latest',
                usage: { inputTokens: 1, outputTokens: 1 }
              }
            }
          ],
          rawRequest: null,
          rawResponse: null
        },
        at
      )

    await save(OTHER, 100)
    for (let i = 1; i <= 21; i++) await save(AGENT, i)
    await save(AGENT, 21)
    const first = await reader.list('', { agentId: AGENT, limit: 20 })
    expect(first.items).toHaveLength(20)
    expect(first.nextCursor).not.toBeNull()
    expect((await reader.list('', { agentId: AGENT, limit: 20, cursor: first.nextCursor! })).items).toHaveLength(1)
    expect(await store.listDecisionVerdicts({ orgId: '', subject: AGENT, integrationId: 'int-a', limit: 20 })).toEqual(
      []
    )
    await expect(reader.list('', { agentId: OTHER, limit: 20 })).rejects.toThrow()
    await expect(reader.list('other-org', { agentId: AGENT, limit: 20 })).rejects.toThrow()
    expect(await store.stripDecisionModelEvaluationBodies(AT + 1)).toBe(1)
    const oldest = (await reader.list('', { agentId: AGENT, limit: 21 })).items.at(-1)!
    expect(oldest.detailsExpired).toBe(true)
    expect((await reader.get('', { agentId: AGENT, seq: oldest.seq })).evaluation).toMatchObject({
      input: null,
      fullAnswer: null
    })
    expect((await reader.get('', { agentId: AGENT, seq: first.items[0]!.seq })).evaluation).toMatchObject({
      input: { currentMessage: { text: 'Choose' } },
      detailsExpired: false
    })
    expect(await store.stripDecisionModelEvaluationBodies(AT + DAY + 1)).toBe(21)
    const sweep = new StoreRetentionSweeper({
      store,
      settings: { scale: 1, deleteOrphans: false },
      rules: STORE_RETENTION_RULES.filter((rule) => rule.id === 'decision-model-evaluation'),
      clock: { now: () => AT + 8 * DAY } as never,
      log: { info: () => undefined, warn: () => undefined }
    })
    await sweep.sweepAgeOnly()
    expect((await reader.list('', { agentId: AGENT, limit: 20 })).items).toHaveLength(0)
    await store.close()
  })
})
