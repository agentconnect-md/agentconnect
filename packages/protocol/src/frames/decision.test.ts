import { describe, expect, it } from 'vitest'
import { FRAME_SCHEMAS } from '../frame.js'
import {
  DECISION_EVALUATION_DETAIL_MAX_BYTES,
  DECISION_LIST_MAX_BYTES,
  DecisionEvaluationReply,
  DecisionEvaluationsReply,
  DecisionEvaluationsRequest
} from './decision.js'

const AGENT = '11111111-1111-4111-8111-111111111111'
const lane = { agentId: AGENT, integrationId: 'int-1', channel: 'C1' }
const row = (seq: number, messageId: string | null = null) => ({
  seq,
  at: '2026-01-01T00:00:00.000Z',
  messageId,
  decisionId: 'd1',
  outcome: 'skipped' as const,
  reason: null,
  answer: null,
  matchedKeys: [],
  latencyMs: null,
  requestedModel: 'jev-latest',
  actualModel: null,
  usage: null,
  detailsExpired: false
})

describe('decision evaluation frames', () => {
  it('defaults the page limit to 20 and caps it at 50', () => {
    expect(DecisionEvaluationsRequest.parse(lane).limit).toBe(20)
    expect(DecisionEvaluationsRequest.safeParse({ ...lane, limit: 51 }).success).toBe(false)
    expect(DecisionEvaluationsRequest.safeParse({ ...lane, cursor: 0 }).success).toBe(false)
    expect(DecisionEvaluationsRequest.safeParse({ ...lane, extra: 1 }).success).toBe(false)
  })

  it('refuses a page over 32 KiB', () => {
    const page = { items: [row(2), row(1)], nextCursor: null }
    expect(DecisionEvaluationsReply.parse(page)).toEqual(page)
    const keys = Array.from({ length: 32 }, (_, i) => `${i}`.padEnd(64, 'k'))
    const big = { items: Array.from({ length: 50 }, (_, i) => ({ ...row(i + 1), matchedKeys: keys })), nextCursor: 1 }
    expect(new TextEncoder().encode(JSON.stringify(big)).byteLength).toBeGreaterThan(DECISION_LIST_MAX_BYTES)
    expect(DecisionEvaluationsReply.safeParse(big).success).toBe(false)
  })

  it('refuses a detail over 64 KiB', () => {
    const entry = (text: string) => ({ id: 'm', sender: { id: 'U1' }, text, threadId: null })
    const detail = (history: number) => ({
      evaluation: {
        ...row(3),
        snapshot: null,
        input: {
          currentMessage: entry('now'),
          history: Array.from({ length: history }, () => entry('y'.repeat(16 * 1024))),
          historyOmitted: 0,
          context: { partial: false, reasons: [], omittedMessages: 0 }
        },
        fullAnswer: null,
        evidence: null
      }
    })
    expect(DecisionEvaluationReply.safeParse(detail(3)).success).toBe(true)
    expect(new TextEncoder().encode(JSON.stringify(detail(4))).byteLength).toBeGreaterThan(
      DECISION_EVALUATION_DETAIL_MAX_BYTES
    )
    expect(DecisionEvaluationReply.safeParse(detail(4)).success).toBe(false)
    expect(DecisionEvaluationReply.parse({ evaluation: null })).toEqual({ evaluation: null })
  })

  it('carries the lane conversation namespace on both replies and bounds it', () => {
    const conversation = { platform: 'slack', tenantScope: 'T1' }
    const page = { items: [row(1)], nextCursor: null, conversation }
    expect(DecisionEvaluationsReply.parse(page)).toEqual(page)
    expect(
      DecisionEvaluationReply.parse({ evaluation: null, conversation: { platform: 'discord', tenantScope: null } })
    ).toMatchObject({ conversation: { tenantScope: null } })
    for (const bad of [
      { platform: '', tenantScope: 'T1' },
      { platform: 'slack', tenantScope: '' },
      { platform: 'slack' }
    ])
      expect(DecisionEvaluationsReply.safeParse({ ...page, conversation: bad }).success).toBe(false)
    expect(DecisionEvaluationsReply.safeParse({ ...page, conversation: { ...conversation, extra: 1 } }).success).toBe(
      false
    )
  })

  it('registers both request/reply pairs', () => {
    for (const type of [
      'decision/evaluations',
      'decision/evaluations/page',
      'decision/evaluation',
      'decision/evaluation/result'
    ] as const)
      expect(FRAME_SCHEMAS[type]).toBeDefined()
  })
})
