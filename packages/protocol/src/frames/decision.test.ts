import { describe, expect, it } from 'vitest'
import { FRAME_SCHEMAS } from '../frame.js'
import {
  DECISION_EVALUATION_DETAIL_MAX_BYTES,
  DECISION_LIST_MAX_BYTES,
  DecisionEvaluationReply,
  DecisionEvaluationsReply,
  DecisionEvaluationsRequest,
  DecisionRoutingEvaluationReply,
  DecisionRoutingEvaluationRequest,
  DecisionRoutingEvaluationsReply,
  DecisionRoutingEvaluationsRequest
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

describe('routing evaluation frames', () => {
  const BOT = '22222222-2222-4222-8222-222222222222'
  const routingLane = { agentId: AGENT, integrationId: 'int-1', botId: BOT }
  const routed = (seq: number) => ({
    ...row(seq),
    outcome: 'routed' as const,
    channel: 'C1',
    evaluated: true,
    matchedRuleIds: [],
    usedOtherwise: false,
    fallback: null,
    targets: []
  })

  it('parses strict requests with a bounded channel list', () => {
    expect(DecisionRoutingEvaluationsRequest.parse({ ...routingLane, channels: ['C1'] }).limit).toBe(20)
    expect(DecisionRoutingEvaluationsRequest.safeParse({ ...routingLane, channels: [] }).success).toBe(false)
    expect(
      DecisionRoutingEvaluationsRequest.safeParse({
        ...routingLane,
        channels: Array.from({ length: 101 }, (_, i) => `C${i}`)
      }).success
    ).toBe(false)
    expect(DecisionRoutingEvaluationsRequest.safeParse({ ...routingLane, channels: ['C1'], extra: 1 }).success).toBe(
      false
    )
    expect(
      DecisionRoutingEvaluationsRequest.safeParse({ ...routingLane, botId: 'bot', channels: ['C1'] }).success
    ).toBe(false)
    expect(DecisionRoutingEvaluationRequest.parse({ ...routingLane, channel: 'C1', seq: 4 })).toMatchObject({ seq: 4 })
    expect(DecisionRoutingEvaluationRequest.safeParse({ ...routingLane, channel: 'C1', seq: 4, x: 1 }).success).toBe(
      false
    )
  })

  it('caps the page at 32 KiB and the detail at 64 KiB', () => {
    const page = { items: [routed(2)], nextCursor: null, conversation: { platform: 'slack', tenantScope: null } }
    expect(DecisionRoutingEvaluationsReply.parse(page)).toEqual(page)
    const target = {
      agentId: 'a'.repeat(128),
      effect: 'selected',
      via: 'implicit',
      participant: false,
      disposition: 'admitted',
      reason: 'r'.repeat(128)
    }
    const big = {
      items: Array.from({ length: 50 }, (_, i) => ({
        ...routed(i + 1),
        targets: Array.from({ length: 4 }, () => target)
      })),
      nextCursor: 1
    }
    expect(new TextEncoder().encode(JSON.stringify(big)).byteLength).toBeGreaterThan(DECISION_LIST_MAX_BYTES)
    expect(DecisionRoutingEvaluationsReply.safeParse(big).success).toBe(false)
    const entry = (text: string) => ({ id: 'm', sender: { id: 'U1' }, text, threadId: null })
    const detail = (history: number) => ({
      evaluation: {
        ...routed(3),
        snapshot: null,
        constraint: null,
        input: {
          currentMessage: entry('now'),
          history: Array.from({ length: history }, () => entry('y'.repeat(16 * 1024))),
          historyOmitted: 0,
          context: { partial: false, reasons: [], omittedMessages: 0 }
        },
        fullAnswer: null
      }
    })
    expect(DecisionRoutingEvaluationReply.safeParse(detail(3)).success).toBe(true)
    expect(DecisionRoutingEvaluationReply.safeParse(detail(4)).success).toBe(false)
    expect(DecisionRoutingEvaluationReply.parse({ evaluation: null })).toEqual({ evaluation: null })
  })

  it('registers both routing request/reply pairs', () => {
    for (const type of [
      'decision/routing-evaluations',
      'decision/routing-evaluations/page',
      'decision/routing-evaluation',
      'decision/routing-evaluation/result'
    ] as const)
      expect(FRAME_SCHEMAS[type]).toBeDefined()
  })
})
