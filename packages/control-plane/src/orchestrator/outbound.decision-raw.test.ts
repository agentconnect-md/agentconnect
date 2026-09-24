import { describe, expect, it, vi } from 'vitest'
import {
  DECISION_EVALUATION_RAW_V1_FEATURE,
  DECISION_EVALUATIONS_V1_FEATURE,
  DECISION_ROUTING_EVALUATIONS_V1_FEATURE
} from '@agentconnect.md/protocol'
import { ControlSender } from './outbound.js'

const AGENT = '11111111-1111-4111-8111-111111111111'
const BOT = '22222222-2222-4222-8222-222222222222'

function senderWith(features: string[]) {
  const request = vi.fn(async () => ({ evaluation: null }))
  const registry = { get: () => ({ state: 'READY', sessionEpoch: 1, capabilities: { features }, conn: { request } }) }
  return { sender: new ControlSender(registry as never, {} as never), request }
}

describe('ControlSender evaluation details', () => {
  it('asks for raw provider JSON only from a daemon that advertises decision-evaluation-raw-v1', async () => {
    const lane = { agentId: AGENT, integrationId: 'int-a', channel: 'C1', seq: 3 }
    const base = [DECISION_EVALUATIONS_V1_FEATURE, DECISION_ROUTING_EVALUATIONS_V1_FEATURE]
    const old = senderWith(base)
    await old.sender.decisionEvaluation('d-1', 'org-1', lane)
    await old.sender.decisionRoutingEvaluation('d-1', 'org-1', { ...lane, botId: BOT })
    expect(old.request.mock.calls.map((call: unknown[]) => call[1])).toEqual([lane, { ...lane, botId: BOT }])
    const next = senderWith([...base, DECISION_EVALUATION_RAW_V1_FEATURE])
    await next.sender.decisionEvaluation('d-1', 'org-1', lane)
    await next.sender.decisionRoutingEvaluation('d-1', 'org-1', { ...lane, botId: BOT })
    expect(next.request.mock.calls.map((call: unknown[]) => call[1])).toEqual([
      { ...lane, includeRaw: true },
      { ...lane, botId: BOT, includeRaw: true }
    ])
  })
})
