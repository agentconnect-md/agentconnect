import { describe, expect, it, vi } from 'vitest'
import {
  DECISION_EVALUATION_DETAIL_MAX_BYTES,
  DecisionEvaluationReply,
  DecisionEvaluationsReply,
  DecisionRoutingEvaluationReply,
  DecisionRoutingEvaluationsReply,
  type AnyFrame
} from '@agentconnect.md/protocol'
import { DecisionEvaluationReader } from '../src/decisions/evaluations.js'
import {
  decisionEvaluation,
  decisionEvaluations,
  decisionRoutingEvaluation,
  decisionRoutingEvaluations
} from '../src/cp/control/decision.js'
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

describe('decision/evaluations control handlers', () => {
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

describe('DecisionEvaluationReader router verdicts', () => {
  const BOT = '33333333-3333-4333-8333-333333333333'
  const ROUTER = `router:${BOT}`
  const routing = {
    enabled: true,
    decisionId: 'd-1',
    rules: [
      { id: 'r1', when: { type: 'boolean', values: [true] }, action: { type: 'agent', agentId: AGENT } },
      { id: 'r2', when: { type: 'boolean', values: [false] }, action: { type: 'skip' } }
    ],
    otherwise: { type: 'skip' }
  }
  const frozen = (channel: string) =>
    JSON.stringify({
      botId: BOT,
      channel,
      decisionId: 'd-1',
      providerId: 'typesafe',
      model: 'jev-latest',
      question,
      routing,
      defaultAgentId: AGENT,
      fingerprint: 'f',
      hostDaemonId: 'daemon-1'
    })
  const delivery = JSON.stringify({
    rd: { payload: { msgId: 'm', text: 'SECRET-BODY' } },
    msg: { text: 'SECRET-BODY' },
    constraint: [{ agentId: OTHER_AGENT, participant: false, via: 'mention', daemonId: 'd-2' }],
    frozenConstraint: [
      { agentId: OTHER_AGENT, participant: false, via: 'mention', daemonId: 'd-2', integrationId: 'int-b' },
      { agentId: AGENT, participant: true, daemonId: 'daemon-1' }
    ],
    candidates: [],
    thread: null
  })
  const routerState = JSON.stringify({
    ...JSON.parse(state()),
    addressing: { mentions: [], constraint: { eligibleAgentIds: [OTHER_AGENT], participantAgentIds: [AGENT] } }
  })
  const target = (agentId: string, disposition: string, extra: Record<string, unknown> = {}) => ({
    agentId,
    daemonId: 'daemon-1',
    participant: false,
    effect: 'selected',
    via: 'implicit',
    disposition,
    ...extra
  })

  async function routed(
    s: LocalStore,
    ts: number,
    channel: string,
    end: {
      disposition?: 'match' | 'skip' | 'unavailable'
      targets?: unknown[]
      finish?: ['admitted' | 'canceled', string | null]
      answer?: Record<string, unknown>
    } = {}
  ): Promise<number> {
    const { seq, orgId } = await record(s, ts, channel)
    await s.reserveDecisionVerdict({
      seq,
      subject: ROUTER,
      orgId,
      channel,
      agentId: AGENT,
      integrationId: `int-${ts}`,
      decisionId: 'd-1',
      configJson: frozen(channel),
      deliveryJson: delivery,
      requestedModel: 'jev-latest',
      deadlineAt: AT + 5_000,
      ownerFence: FENCE,
      createdAt: AT + ts
    })
    if (!end.disposition) return seq
    await s.beginDecisionEvaluation(seq, ROUTER, FENCE, routerState)
    await s.settleDecisionVerdict(seq, ROUTER, FENCE, {
      disposition: end.disposition,
      ...(end.disposition === 'unavailable' ? { unavailableReason: 'timeout' } : {}),
      answerJson: JSON.stringify(
        end.answer ?? { answer: yes, matchedRuleIds: ['r1'], matchedKeys: [], usedOtherwise: false }
      ),
      targetsJson: JSON.stringify(end.targets ?? []),
      latencyMs: 30,
      settledAt: AT + 100
    })
    if (end.finish) await s.finishDecisionVerdict(seq, ROUTER, FENCE, end.finish[0], end.finish[1], AT + 200)
    return seq
  }

  function routingReader(s: LocalStore, botId: string | null = BOT) {
    return new DecisionEvaluationReader({
      store: () => s,
      servedIntegration: async (orgId, agentId, integrationId) =>
        orgId === ORG && agentId === AGENT && integrationId === 'int-a'
          ? { ...SCOPE, ...(botId ? { botId } : {}) }
          : undefined
    })
  }
  const routingLane = { agentId: AGENT, integrationId: 'int-a', botId: BOT }

  it('lists the bot router across channels with no install filter and classifies every outcome', async () => {
    const s = await openTestStore()
    const routedSeq = await routed(s, 1, CH, {
      disposition: 'match',
      targets: [target(AGENT, 'admitted'), target(OTHER_AGENT, 'admitted')],
      finish: ['admitted', null]
    })
    const partial = await routed(s, 2, 'C2', {
      disposition: 'match',
      targets: [target(AGENT, 'admitted'), target(OTHER_AGENT, 'unavailable', { reason: 'not_member' })],
      finish: ['admitted', null]
    })
    const fallback = await routed(s, 3, CH, {
      disposition: 'unavailable',
      answer: { matchedRuleIds: [], matchedKeys: [], usedOtherwise: false, fallback: 'default' },
      targets: [target(AGENT, 'admitted', { effect: 'fallback_default' })],
      finish: ['admitted', null]
    })
    const unavailable = await routed(s, 4, CH, {
      disposition: 'unavailable',
      answer: { matchedRuleIds: [], matchedKeys: [], usedOtherwise: false, fallback: 'default' },
      targets: [target(AGENT, 'unavailable', { effect: 'fallback_default', reason: 'timeout' })],
      finish: ['canceled', 'targets_rejected']
    })
    const skipped = await routed(s, 5, CH, {
      disposition: 'skip',
      answer: { answer: no, matchedRuleIds: ['r2'], matchedKeys: [], usedOtherwise: false }
    })
    const canceled = await routed(s, 6, CH)
    await s.finishDecisionVerdict(canceled, ROUTER, null, 'canceled', 'stop', AT + 400)
    const pending = await routed(s, 7, CH, { disposition: 'match', targets: [target(AGENT, 'pending')] })
    // Another bot's router, a gate verdict, and an unlisted channel stay out.
    const { seq: gateSeq } = await reserve(s, 8)
    await routed(s, 9, 'C3', { disposition: 'skip' })
    const reader = routingReader(s)
    const page = await reader.listRouting(ORG, { ...routingLane, channels: [CH, 'C2'], limit: 20 })
    expect(DecisionRoutingEvaluationsReply.parse(page)).toEqual(page)
    expect(page.conversation).toEqual(SCOPE)
    expect(page.items.map((item) => [item.seq, item.channel, item.outcome])).toEqual([
      [pending, CH, 'pending'],
      [canceled, CH, 'canceled'],
      [skipped, CH, 'skipped'],
      [unavailable, CH, 'unavailable'],
      [fallback, CH, 'fallback'],
      [partial, 'C2', 'partially_routed'],
      [routedSeq, CH, 'routed']
    ])
    expect(page.items.map((item) => item.seq)).not.toContain(gateSeq)
    expect(page.items.find((item) => item.seq === partial)).toMatchObject({
      matchedRuleIds: ['r1'],
      usedOtherwise: false,
      evaluated: true,
      answer: { type: 'boolean', value: true },
      targets: [
        { agentId: AGENT, disposition: 'admitted', effect: 'selected', reason: null },
        { agentId: OTHER_AGENT, disposition: 'unavailable', reason: 'not_member' }
      ]
    })
    expect(page.items.find((item) => item.seq === fallback)).toMatchObject({ fallback: 'default', answer: null })
    expect(page.items.find((item) => item.seq === canceled)).toMatchObject({ reason: 'stop' })
    const first = await reader.listRouting(ORG, { ...routingLane, channels: [CH, 'C2'], limit: 3 })
    expect(first.nextCursor).toBe(skipped)
    const rest = await reader.listRouting(ORG, { ...routingLane, channels: [CH, 'C2'], limit: 20, cursor: skipped })
    expect(rest.items.map((item) => item.seq)).toEqual([unavailable, fallback, partial, routedSeq])
    await s.close()
  })

  it('projects the frozen snapshot and constraint without message content, then expires the bodies', async () => {
    const s = await openTestStore()
    const seq = await routed(s, 1, CH, {
      disposition: 'match',
      targets: [target(OTHER_AGENT, 'admitted', { effect: 'kept', via: 'mention' })],
      finish: ['admitted', null]
    })
    const reader = routingReader(s)
    // While pending, the frozen delivery names the constraint; its message fields are never projected.
    const open = await routed(s, 2, CH, { disposition: 'match', targets: [target(OTHER_AGENT, 'pending')] })
    const pendingReply = await reader.getRouting(ORG, { ...routingLane, channel: CH, seq: open })
    expect(pendingReply.evaluation).toMatchObject({ outcome: 'pending' })
    expect(pendingReply.evaluation!.constraint).toEqual([
      { agentId: OTHER_AGENT, participant: false, via: 'mention' },
      { agentId: AGENT, participant: true, via: 'implicit' }
    ])
    expect(JSON.stringify(pendingReply)).not.toContain('SECRET-BODY')
    expect(JSON.stringify(pendingReply)).not.toContain('int-b')
    const reply = await reader.getRouting(ORG, { ...routingLane, channel: CH, seq })
    expect(DecisionRoutingEvaluationReply.parse(reply)).toEqual(reply)
    expect(reply.evaluation).toMatchObject({
      seq,
      outcome: 'routed',
      snapshot: {
        decisionId: 'd-1',
        providerId: 'typesafe',
        model: 'jev-latest',
        question,
        routing,
        defaultAgentId: AGENT
      },
      constraint: [
        { agentId: OTHER_AGENT, participant: false, via: 'mention' },
        { agentId: AGENT, participant: true, via: 'implicit' }
      ],
      input: { currentMessage: { id: 'cur', text: 'Help please' } },
      fullAnswer: yes
    })
    expect(JSON.stringify(reply)).not.toContain('SECRET-BODY')
    expect(JSON.stringify(reply.evaluation!.constraint)).not.toContain('int-b')
    expect(await reader.getRouting(ORG, { ...routingLane, channel: 'C2', seq })).toEqual({
      evaluation: null,
      conversation: SCOPE
    })
    await s.stripDecisionVerdictBodies(AT + 10 * 24 * 3_600_000)
    expect((await reader.getRouting(ORG, { ...routingLane, channel: CH, seq })).evaluation).toMatchObject({
      detailsExpired: true,
      input: null,
      fullAnswer: null,
      constraint: null,
      outcome: 'routed',
      snapshot: { routing }
    })
    await s.close()
  })

  it('bounds a page at 32 KiB and a detail at 64 KiB', async () => {
    const s = await openTestStore()
    const many = Array.from({ length: 64 }, (_, i) =>
      target(`${i}`.padEnd(128, 'a'), 'admitted', { reason: 'r'.repeat(128) })
    )
    for (let n = 1; n <= 20; n += 1)
      await routed(s, n, CH, { disposition: 'match', targets: many, finish: ['admitted', null] })
    const reader = routingReader(s)
    const page = await reader.listRouting(ORG, { ...routingLane, channels: [CH], limit: 20 })
    expect(page.items.length).toBeLessThan(20)
    expect(DecisionRoutingEvaluationsReply.safeParse(page).success).toBe(true)
    expect(page.nextCursor).toBe(page.items.at(-1)!.seq)
    const { seq, orgId } = await record(s, 99, CH)
    const history = Array.from({ length: 6 }, (_, i) => ({ id: `h${i}`, text: 'z'.repeat(15 * 1024) }))
    await s.reserveDecisionVerdict({
      seq,
      subject: ROUTER,
      orgId,
      channel: CH,
      agentId: AGENT,
      integrationId: 'int-a',
      decisionId: 'd-1',
      configJson: frozen(CH),
      deliveryJson: delivery,
      requestedModel: 'jev-latest',
      deadlineAt: AT + 5_000,
      ownerFence: FENCE,
      createdAt: AT + 99
    })
    await s.beginDecisionEvaluation(seq, ROUTER, FENCE, state(history))
    const detail = await reader.getRouting(ORG, { ...routingLane, channel: CH, seq })
    expect(Buffer.byteLength(JSON.stringify(detail))).toBeLessThanOrEqual(DECISION_EVALUATION_DETAIL_MAX_BYTES)
    expect(detail.evaluation!.input!.historyOmitted).toBeGreaterThan(0)
    await s.close()
  })

  it('refuses another bot, an unrouted member, and an unserved lane as SCOPE_DENIED', async () => {
    const s = await openTestStore()
    const seq = await routed(s, 1, CH, { disposition: 'skip' })
    const deps = { decisionEvaluations: routingReader(s) }
    const ok = wire()
    await decisionRoutingEvaluations(
      frame('decision/routing-evaluations', { ...routingLane, channels: [CH] }, ORG),
      deps,
      ok
    )
    expect(ok.reply).toHaveBeenCalledWith(expect.anything(), 'decision/routing-evaluations/page', {
      items: [expect.objectContaining({ seq, outcome: 'skipped' })],
      nextCursor: null,
      conversation: SCOPE
    })
    const one = wire()
    await decisionRoutingEvaluation(
      frame('decision/routing-evaluation', { ...routingLane, channel: CH, seq }, ORG),
      deps,
      one
    )
    expect(one.reply).toHaveBeenCalledWith(expect.anything(), 'decision/routing-evaluation/result', {
      evaluation: expect.objectContaining({ seq }),
      conversation: SCOPE
    })
    const cases: Array<[unknown, { decisionEvaluations: DecisionEvaluationReader }]> = [
      [{ ...routingLane, botId: '44444444-4444-4444-8444-444444444444', channels: [CH] }, deps],
      [{ ...routingLane, channels: [CH] }, { decisionEvaluations: routingReader(s, null) }],
      [{ ...routingLane, integrationId: 'int-b', channels: [CH] }, deps]
    ]
    for (const [payload, handlerDeps] of cases) {
      const denied = wire()
      await decisionRoutingEvaluations(frame('decision/routing-evaluations', payload, ORG), handlerDeps, denied)
      expect(denied.reply).not.toHaveBeenCalled()
      expect(denied.sendError).toHaveBeenCalledWith('req-1', 'SCOPE_DENIED', expect.any(String), false)
    }
    const bad = wire()
    await decisionRoutingEvaluations(
      frame('decision/routing-evaluations', { ...routingLane, channels: [] }, ORG),
      deps,
      bad
    )
    expect(bad.sendError).toHaveBeenCalledWith('req-1', 'BAD_PAYLOAD', expect.any(String), false)
    await s.close()
  })
})
