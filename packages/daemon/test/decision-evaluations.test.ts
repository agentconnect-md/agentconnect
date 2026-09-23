import { describe, expect, it, vi } from 'vitest'
import {
  DECISION_EVALUATION_DETAIL_MAX_BYTES,
  DecisionEvaluationReply,
  DecisionEvaluationsReply,
  type AnyFrame
} from '@agentconnect.md/protocol'
import { DecisionEvaluationReader } from '../src/decisions/evaluations.js'
import { decisionEvaluation, decisionEvaluations } from '../src/cp/control/decision.js'
import type { ControlWire } from '../src/cp/control/context.js'
import type { DecisionVerdictReservation, LocalStore } from '../src/store/local-store.js'
import { openTestStore } from './store-support.js'

// decisions.md §9.5: Recent evaluations read one lane's decision_verdict rows, bounded, on the owning daemon.

const ORG = 'org-1'
const AGENT = '11111111-1111-4111-8111-111111111111'
const OTHER_AGENT = '22222222-2222-4222-8222-222222222222'
const CH = 'C1'
const FENCE = 'daemon-1:boot-1'
const SCOPE = { platform: 'slack', tenantScope: 'T-A' }
const AT = 1_800_000_000_000
const question = { type: 'boolean', instructions: 'Reply?', criteria: { true: 'Yes', false: 'No' } }
const config = {
  decisionId: 'd-1',
  providerId: 'typesafe',
  model: 'jev-latest',
  question,
  condition: { type: 'boolean', values: [true] },
  binding: { channel: CH, consumer: { type: 'gate', decisionId: 'd-1', when: { type: 'boolean', values: [true] } } },
  sessionMode: 'createNew',
  fingerprint: 'f'
}
const yes = { type: 'boolean', value: true, probability: 0.9 }
const no = { type: 'boolean', value: false, probability: 0.2 }

async function record(s: LocalStore, ts: number, channel = CH): Promise<{ seq: number; orgId: string }> {
  await s.appendTranscript({
    channel,
    thread: String(ts),
    ts: String(ts),
    sender: 'U1',
    kind: 'text',
    text: `m${ts}`,
    orgAgentId: AGENT
  })
  const ref = (await s.channelRecordRef(channel, String(ts), AGENT))!
  return { seq: ref.seq, orgId: ref.orgId }
}

async function reserve(
  s: LocalStore,
  ts: number,
  over: Partial<DecisionVerdictReservation> = {}
): Promise<{ seq: number }> {
  const { seq, orgId } = await record(s, ts, over.channel ?? CH)
  await s.reserveDecisionVerdict({
    seq,
    subject: AGENT,
    orgId,
    channel: CH,
    agentId: AGENT,
    integrationId: 'int-a',
    decisionId: 'd-1',
    configJson: JSON.stringify(config),
    deliveryJson: '{"origin":"direct"}',
    requestedModel: 'jev-latest',
    deadlineAt: AT + 5_000,
    ownerFence: FENCE,
    createdAt: AT + ts,
    ...over
  })
  return { seq }
}

function state(history: Array<{ id: string; text: string }> = []) {
  return JSON.stringify({
    currentMessage: { id: 'cur', sender: { id: 'U1' }, text: 'Help please', threadId: null },
    history: history.map((entry) => ({ ...entry, sender: { id: 'U0' }, threadId: null })),
    conversation: {},
    addressing: { mentions: [], target: { agentId: AGENT, via: 'implicit' } },
    context: { partial: false, reasons: [], omittedMessages: 0, snapshotSequence: 1, tokenCount: 'estimate' }
  })
}

async function settle(
  s: LocalStore,
  seq: number,
  disposition: 'match' | 'skip' | 'unavailable',
  answer?: unknown,
  matchedKeys: string[] = [],
  inputJson = state()
): Promise<void> {
  await s.beginDecisionEvaluation(seq, AGENT, FENCE, inputJson)
  await s.settleDecisionVerdict(seq, AGENT, FENCE, {
    disposition,
    ...(disposition === 'unavailable' ? { unavailableReason: 'timeout' } : {}),
    ...(answer ? { answerJson: JSON.stringify({ answer, matchedKeys }) } : {}),
    ...(answer ? { actualModel: 'jev-1.13.0', inputTokens: 10, outputTokens: 1 } : {}),
    latencyMs: 42,
    settledAt: AT + 100
  })
}

function readerFor(s: LocalStore) {
  return new DecisionEvaluationReader({
    store: () => s,
    servedIntegration: async (orgId, agentId, integrationId) =>
      orgId === ORG && agentId === AGENT && integrationId === 'int-a' ? { ...SCOPE } : undefined
  })
}

const lane = { agentId: AGENT, integrationId: 'int-a', channel: CH }

describe('DecisionEvaluationReader', () => {
  it('lists one lane newest-first, maps every state to an outcome, and pages by cursor', async () => {
    const s = await openTestStore()
    const triggered = (await reserve(s, 1)).seq
    await settle(s, triggered, 'match', yes)
    await s.finishDecisionVerdict(triggered, AGENT, FENCE, 'admitted', null, AT + 200)
    const skipped = (await reserve(s, 2)).seq
    await settle(s, skipped, 'skip', no)
    const unavailable = (await reserve(s, 3)).seq
    await settle(s, unavailable, 'unavailable')
    await s.finishDecisionVerdict(unavailable, AGENT, FENCE, 'admitted', null, AT + 300)
    const canceled = (await reserve(s, 4)).seq
    await s.finishDecisionVerdict(canceled, AGENT, null, 'canceled', 'stop', AT + 400)
    const reserved = (await reserve(s, 5)).seq
    const settled = (await reserve(s, 6)).seq
    await settle(s, settled, 'match', yes)
    // Another integration, another subject, and another conversation stay out of this lane.
    await reserve(s, 7, { integrationId: 'int-b' })
    await reserve(s, 8, { subject: OTHER_AGENT, agentId: OTHER_AGENT })
    await reserve(s, 9, { channel: 'C2' })
    const reader = readerFor(s)
    const page = await reader.list(ORG, { ...lane, limit: 20 })
    expect(DecisionEvaluationsReply.parse(page)).toEqual(page)
    expect(page.conversation).toEqual(SCOPE)
    expect(page.nextCursor).toBeNull()
    expect(page.items.map((item) => [item.seq, item.outcome, item.reason])).toEqual([
      [settled, 'pending', null],
      [reserved, 'pending', null],
      [canceled, 'canceled', 'stop'],
      [unavailable, 'unavailable', 'timeout'],
      [skipped, 'skipped', null],
      [triggered, 'triggered', null]
    ])
    expect(page.items.at(-1)).toMatchObject({
      messageId: '1',
      decisionId: 'd-1',
      answer: { type: 'boolean', value: true, probability: 0.9 },
      matchedKeys: [],
      latencyMs: 42,
      requestedModel: 'jev-latest',
      actualModel: 'jev-1.13.0',
      usage: { inputTokens: 10, outputTokens: 1 },
      detailsExpired: false,
      at: new Date(AT + 1).toISOString()
    })
    const first = await reader.list(ORG, { ...lane, limit: 2 })
    expect(first.items.map((item) => item.seq)).toEqual([settled, reserved])
    expect(first.nextCursor).toBe(reserved)
    const second = await reader.list(ORG, { ...lane, limit: 2, cursor: first.nextCursor! })
    expect(second.items.map((item) => item.seq)).toEqual([canceled, unavailable])
    const last = await reader.list(ORG, { ...lane, limit: 2, cursor: unavailable })
    expect(last).toEqual({ items: expect.any(Array), nextCursor: null, conversation: SCOPE })
    expect(last.items.map((item) => item.seq)).toEqual([skipped, triggered])
    await s.close()
  })

  it('stops a page at 32 KiB and continues from the last row it kept', async () => {
    const s = await openTestStore()
    const keys = Array.from({ length: 32 }, (_, i) => `${i}`.padEnd(64, 'k'))
    const choice = {
      type: 'choice',
      value: keys[0],
      probabilities: Object.fromEntries(keys.map((key) => [key, 1 / 32])),
      confidence: 0.5
    }
    const seqs: number[] = []
    for (let n = 1; n <= 20; n += 1) {
      const { seq } = await reserve(s, n)
      await settle(s, seq, 'skip', choice, keys)
      seqs.push(seq)
    }
    const reader = readerFor(s)
    const page = await reader.list(ORG, { ...lane, limit: 20 })
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.items.length).toBeLessThan(20)
    expect(DecisionEvaluationsReply.safeParse(page).success).toBe(true)
    expect(page.nextCursor).toBe(page.items.at(-1)!.seq)
    const rest = await reader.list(ORG, { ...lane, limit: 20, cursor: page.nextCursor! })
    expect([...page.items, ...rest.items].map((item) => item.seq)).toEqual([...seqs].reverse())
    await s.close()
  })

  it('returns the frozen snapshot and input while bodies exist, and Details expired after the strip', async () => {
    const s = await openTestStore()
    const { seq } = await reserve(s, 1)
    await settle(s, seq, 'match', yes, [], state([{ id: 'h1', text: 'Earlier' }]))
    await s.claimVerdictBackground(seq, AGENT, [1, 2])
    await s.finishDecisionVerdict(seq, AGENT, FENCE, 'admitted', null, AT + 200)
    const reader = readerFor(s)
    const reply = await reader.get(ORG, { ...lane, seq })
    expect(DecisionEvaluationReply.parse(reply)).toEqual(reply)
    expect(reply.conversation).toEqual(SCOPE)
    const detail = reply.evaluation
    expect(detail).toMatchObject({
      seq,
      outcome: 'triggered',
      snapshot: { decisionId: 'd-1', providerId: 'typesafe', model: 'jev-latest', question, sessionMode: 'createNew' },
      input: {
        currentMessage: { id: 'cur', text: 'Help please', sender: { id: 'U1' } },
        history: [{ id: 'h1', text: 'Earlier', sender: { id: 'U0' } }],
        historyOmitted: 0,
        context: { partial: false, reasons: [], omittedMessages: 0 }
      },
      fullAnswer: yes,
      evidence: { snapshotSeq: seq, suppliedBackground: 2 },
      detailsExpired: false
    })
    expect(detail!.input!.currentMessage).not.toHaveProperty('conversation')
    await s.stripDecisionVerdictBodies(AT + 10 * 24 * 3_600_000)
    const expired = (await reader.get(ORG, { ...lane, seq })).evaluation
    expect(expired).toMatchObject({
      detailsExpired: true,
      answer: null,
      input: null,
      fullAnswer: null,
      evidence: { snapshotSeq: seq, suppliedBackground: null },
      snapshot: { decisionId: 'd-1', question }
    })
    expect((await reader.list(ORG, { ...lane, limit: 5 })).items[0]).toMatchObject({ detailsExpired: true })
    expect(await reader.get(ORG, { ...lane, seq: seq + 999 })).toEqual({ evaluation: null, conversation: SCOPE })
    await s.close()
  })

  it('trims the oldest history until the detail fits 64 KiB', async () => {
    const s = await openTestStore()
    const { seq } = await reserve(s, 1)
    const history = Array.from({ length: 6 }, (_, i) => ({ id: `h${i}`, text: 'z'.repeat(15 * 1024) }))
    await settle(s, seq, 'skip', no, [], state(history))
    const reply = await readerFor(s).get(ORG, { ...lane, seq })
    const detail = reply.evaluation
    expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThanOrEqual(DECISION_EVALUATION_DETAIL_MAX_BYTES)
    expect(DecisionEvaluationReply.safeParse(reply).success).toBe(true)
    expect(detail!.input!.historyOmitted).toBeGreaterThan(0)
    expect(detail!.input!.history.at(-1)?.id).toBe('h5')
    expect(detail!.input!.history.length + detail!.input!.historyOmitted).toBe(6)
    await s.close()
  })
})

describe('decision/evaluations control handlers', () => {
  function wire() {
    const reply = vi.fn()
    const sendError = vi.fn()
    return { reply, sendError, emit: vi.fn(), log: { warn: vi.fn() } } as unknown as ControlWire & {
      reply: ReturnType<typeof vi.fn>
      sendError: ReturnType<typeof vi.fn>
    }
  }
  const frame = (type: string, payload: unknown, orgId?: string) =>
    ({ v: 1, id: 'req-1', ts: 't', type, payload, ...(orgId ? { orgId } : {}) }) as unknown as AnyFrame

  it('answers with a page and a detail, and refuses a lane or org it does not serve', async () => {
    const s = await openTestStore()
    const { seq } = await reserve(s, 1)
    const deps = { decisionEvaluations: readerFor(s) }
    const ok = wire()
    await decisionEvaluations(frame('decision/evaluations', { ...lane, limit: 5 }, ORG), deps, ok)
    expect(ok.reply).toHaveBeenCalledWith(expect.anything(), 'decision/evaluations/page', {
      items: [expect.objectContaining({ seq, outcome: 'pending' })],
      nextCursor: null,
      conversation: SCOPE
    })
    const detail = wire()
    await decisionEvaluation(frame('decision/evaluation', { ...lane, seq }, ORG), deps, detail)
    expect(detail.reply).toHaveBeenCalledWith(expect.anything(), 'decision/evaluation/result', {
      evaluation: expect.objectContaining({ seq }),
      conversation: SCOPE
    })
    const unscoped = wire()
    const bare = new DecisionEvaluationReader({
      store: () => s,
      servedIntegration: async () => ({ platform: 'discord', tenantScope: null })
    })
    await decisionEvaluation(
      frame('decision/evaluation', { ...lane, seq }, ORG),
      { decisionEvaluations: bare },
      unscoped
    )
    expect(DecisionEvaluationReply.parse(unscoped.reply.mock.calls[0]![2])).toMatchObject({
      conversation: { platform: 'discord', tenantScope: null }
    })
    for (const [payload, orgId] of [
      [{ ...lane, agentId: OTHER_AGENT, limit: 5 }, ORG],
      [{ ...lane, integrationId: 'int-b', limit: 5 }, ORG],
      [{ ...lane, limit: 5 }, 'org-2']
    ] as const) {
      const denied = wire()
      await decisionEvaluations(frame('decision/evaluations', payload, orgId), deps, denied)
      expect(denied.reply).not.toHaveBeenCalled()
      expect(denied.sendError).toHaveBeenCalledWith('req-1', 'SCOPE_DENIED', expect.any(String), false)
    }
    const noOrg = wire()
    await decisionEvaluations(frame('decision/evaluations', { ...lane, limit: 5 }), deps, noOrg)
    expect(noOrg.sendError).toHaveBeenCalledWith('req-1', 'BAD_PAYLOAD', expect.any(String), false)
    const bad = wire()
    await decisionEvaluation(frame('decision/evaluation', { ...lane }, ORG), deps, bad)
    expect(bad.sendError).toHaveBeenCalledWith('req-1', 'BAD_PAYLOAD', expect.any(String), false)
    await s.close()
  })
})
