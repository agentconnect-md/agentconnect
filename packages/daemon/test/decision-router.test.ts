import { describe, expect, it, vi } from 'vitest'
import { DECISION_RAW_JSON_MAX_CHARS } from '@agentconnect.md/protocol'
import type {
  DecisionEvaluation,
  RdRouteAck,
  RdRouteReport,
  RdRoutingConstraintEntry,
  SharedBotDecisionRouting
} from '@agentconnect.md/protocol'
import { routerFingerprint, type ResolvedRoutedChannel } from '../src/decisions/bundle.js'
import type { DecisionEvaluationInput } from '../src/decisions/evaluator.js'
import { DecisionLaneRuntime } from '../src/decisions/lanes.js'
import {
  DEFAULT_DECISION_ROUTER_LIMITS,
  DecisionRouter,
  decisionRouteReceiptId,
  routerSubject,
  type CurrentRouting,
  type DecisionRouterHost,
  type DecisionRouterLimits,
  type RouterAdmitRequest,
  type RouterForwardRequest,
  type RouterTarget
} from '../src/decisions/router.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import type { LocalStore } from '../src/store/local-store.js'
import { openTestStore } from './store-support.js'

// decisions.md §10.3 Stage 2 cases (a), (c)–(h) over a controllable fake evaluator and cross-daemon transport.

const WAIT = { timeout: 3_000, interval: 5 }
const BOT = '11111111-1111-4111-8111-111111111111'
const SELF = 'd-self'
const OTHER = 'd-2'
const CH = 'C1'
const SUBJECT = routerSubject(BOT)
const [A, B, C] = ['agent-a', 'agent-b', 'agent-c']
const PLACE: Record<string, string> = { [A]: SELF, [B]: OTHER, [C]: SELF }

const routingConfig: SharedBotDecisionRouting = {
  enabled: true,
  decisionId: 'd-1',
  otherwise: { type: 'default_agent' },
  rules: [
    { id: 'billing', when: { type: 'choice', thresholds: { billing: 0.2 } }, action: { type: 'agent', agentId: A } },
    {
      id: 'technical',
      when: { type: 'choice', thresholds: { technical: 0.2 } },
      action: { type: 'agent', agentId: B }
    },
    { id: 'sales', when: { type: 'choice', thresholds: { sales: 0.2 } }, action: { type: 'agent', agentId: C } }
  ]
}
const definition = {
  id: 'd-1',
  orgId: 'org-1',
  name: 'Topic',
  providerId: 'typesafe',
  model: 'jev-1.13.0',
  question: {
    type: 'choice' as const,
    instructions: 'Which team?',
    criteria: { billing: 'Money', technical: 'Bugs', sales: 'Quotes' }
  }
}
const routingOf = (over: Partial<SharedBotDecisionRouting> = {}, defaultAgentId?: string) =>
  ({
    botId: BOT,
    config: { ...routingConfig, ...over },
    definition,
    ...(defaultAgentId ? { defaultAgentId } : {})
  }) as NonNullable<ResolvedRoutedChannel['routing']>

const answer = (probabilities: Record<string, number>): DecisionEvaluation => ({
  status: 'answered',
  answer: {
    type: 'choice',
    value: Object.entries(probabilities).sort((x, y) => y[1] - x[1])[0]![0],
    probabilities,
    confidence: 0.4
  },
  model: 'jev-1.13.0-actual',
  usage: { inputTokens: 30, outputTokens: 2 }
})
const all = answer({ billing: 0.4, technical: 0.35, sales: 0.25 })
const none = answer({ billing: 0.1, technical: 0.1, sales: 0.8 })

interface Call {
  input: DecisionEvaluationInput
  resolve: (value: DecisionEvaluation) => void
  reject: (err: Error) => void
}
interface Forward {
  request: RouterForwardRequest
  resolve: (ack: RdRouteAck) => void
}

async function harness(opts: { store?: LocalStore; fence?: string; limits?: Partial<DecisionRouterLimits> } = {}) {
  const store = opts.store ?? (await openTestStore())
  const calls: Call[] = []
  const forwards: Forward[] = []
  const admits: RouterAdmitRequest[] = []
  const reports: RdRouteReport[] = []
  const state: {
    routing: NonNullable<ResolvedRoutedChannel['routing']>
    current?: CurrentRouting
    admit: (
      request: RouterAdmitRequest
    ) => Promise<{ kind: 'admitted' } | { kind: 'rejected'; reason: string; recoverable: boolean }>
    autoForward?: (request: RouterForwardRequest) => RdRouteAck | undefined
    participants: Set<string>
    unserved: Set<string>
    report: (report: RdRouteReport) => { accepted: boolean; reason?: string }
  } = {
    routing: routingOf(),
    participants: new Set(),
    unserved: new Set(),
    report: () => ({ accepted: true }),
    admit: async (request) => {
      await store.appendInboxWithReceipt(
        {
          id: `row-${request.receiptId}`,
          sessionKey: 'k',
          agentId: request.target.agentId,
          msg: '{}',
          enqueuedAt: '1'
        },
        {
          id: request.receiptId,
          sessionKey: 'k',
          agentId: request.target.agentId,
          msg: '{}',
          enqueuedAt: '1',
          completedAt: 1
        }
      )
      return request.beforeDispatch() ? { kind: 'admitted' } : { kind: 'rejected', reason: 'gated', recoverable: false }
    }
  }
  const host: DecisionRouterHost = {
    store: () => store,
    ownerFence: () => opts.fence ?? 'd-self:boot-1',
    now: () => Date.now(),
    selfDaemonId: () => SELF,
    evaluate: (input, signal) =>
      new Promise<DecisionEvaluation>((resolve, reject) => {
        calls.push({ input, resolve, reject })
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    currentRouting: () =>
      state.current ?? { status: 'enabled', routing: state.routing, fingerprint: routerFingerprint(state.routing, CH) },
    configConverged: () => true,
    localTarget: (_botId, agentId) =>
      PLACE[agentId] === SELF
        ? { integrationId: `int-${agentId}`, sessionMode: 'createNew', served: !state.unserved.has(agentId) }
        : undefined,
    participates: async (agentId) => state.participants.has(agentId),
    admitLocal: async (request) => {
      admits.push(request)
      return await state.admit(request)
    },
    forwardRemote: (request) =>
      new Promise<RdRouteAck>((resolve) => {
        const auto = state.autoForward?.(request)
        if (auto) resolve(auto)
        else forwards.push({ request, resolve })
      }),
    report: async (report) => {
      reports.push(report)
      return state.report(report)
    },
    backfill: async () => [{ ts: '0.1', thread: null, sender: 'U0', text: 'before' }],
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    metrics: {
      verdict: () => undefined,
      finished: () => undefined,
      capacity: () => undefined,
      tokens: () => undefined,
      latency: () => undefined
    }
  }
  const limits = { ...DEFAULT_DECISION_ROUTER_LIMITS, retryDelayMs: 5, ...opts.limits }
  const router = new DecisionRouter(host, new DecisionLaneRuntime(limits), limits)
  let ts = 0
  const post = async (over: { thread?: string; constraint?: RdRoutingConstraintEntry[]; text?: string } = {}) => {
    ts += 1
    const id = `17000000${String(ts).padStart(2, '0')}.0001`
    await store.appendTranscript({
      channel: CH,
      thread: over.thread ?? id,
      ts: id,
      sender: 'U1',
      kind: 'text',
      text: over.text ?? `message ${ts}`,
      orgAgentId: A
    })
    const record = (await store.channelRecordRef(CH, id, A))!
    const msg: NormalizedMessage = {
      msgId: `slack:${CH}:${id}`,
      traceId: 't',
      source: 'user',
      platform: 'slack',
      channel: CH,
      ...(over.thread ? { thread: over.thread } : { thread: id }),
      sender: { id: 'U1', isBot: false },
      text: over.text ?? `message ${ts}`,
      mentionedBots: [],
      isDm: false
    }
    const candidate = {
      botId: BOT,
      integrationId: `int-${A}`,
      carrierAgentId: A,
      rawChannel: CH,
      record,
      routing: state.routing,
      delivery: {
        rd: {
          source: 'im' as const,
          agentId: A,
          sessionKey: `${CH}/${over.thread ?? id}`,
          msgId: msg.msgId,
          botId: BOT,
          integrationId: `int-${A}`,
          payload: msg as never
        },
        msg,
        relayId: 'relay-1',
        constraint: over.constraint ?? [],
        candidates: [A, B, C].map((agentId) => ({
          agentId,
          daemonId: PLACE[agentId]!,
          integrationId: `int-${agentId}`
        })),
        thread: record.thread
      }
    }
    return { record, msg, candidate }
  }
  const verdict = async (seq: number) => (await store.getDecisionVerdict(seq, SUBJECT))!
  const targetsOf = async (seq: number) => JSON.parse((await verdict(seq)).targetsJson ?? '[]') as RouterTarget[]
  return { store, router, host, calls, forwards, admits, reports, state, post, verdict, targetsOf }
}

const entry = (agentId: string, participant: boolean): RdRoutingConstraintEntry => ({
  agentId,
  daemonId: PLACE[agentId]!,
  integrationId: `int-${agentId}`,
  participant,
  via: participant ? 'implicit' : 'mention'
})

describe('DecisionRouter', () => {
  it('fans out through matched child rules and records the selected terminal agent', async () => {
    const h = await harness()
    h.state.routing = {
      ...routingOf(),
      config: {
        ...routingConfig,
        rules: [
          {
            id: 'start',
            when: { type: 'choice', thresholds: { billing: 0.2 } },
            action: { type: 'decision', nextStepId: 'assign' }
          }
        ],
        steps: [
          {
            id: 'assign',
            decisionId: 'd-2',
            rules: [
              { id: 'confirmed', when: { type: 'boolean', values: [true] }, action: { type: 'agent', agentId: C } }
            ]
          }
        ]
      },
      definitions: [
        definition,
        {
          ...definition,
          id: 'd-2',
          question: { type: 'boolean', instructions: 'Assign the specialist?', criteria: { true: 'Yes', false: 'No' } }
        }
      ]
    }
    const m = await h.post()
    await h.router.intake(m.candidate)
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT)
    h.calls[0]!.resolve(all)
    await vi.waitFor(() => expect(h.calls).toHaveLength(2), WAIT)
    expect(h.calls[1]!.input.state).toBe(h.calls[0]!.input.state)
    expect(h.calls[1]!.input.deadlineAt).toBe(h.calls[0]!.input.deadlineAt)
    h.calls[1]!.resolve({
      status: 'answered',
      answer: { type: 'boolean', value: true, probability: 0.9 },
      model: 'jev-latest',
      usage: { inputTokens: 10, outputTokens: 1 }
    })
    await h.router.idle()
    expect((await h.targetsOf(m.record.seq)).map((t) => [t.agentId, t.effect])).toEqual([[C, 'selected']])
    expect(JSON.parse((await h.verdict(m.record.seq)).answerJson!).matchedRuleIds).toEqual(['start', 'confirmed'])
    expect(h.forwards).toHaveLength(0)
  })

  it('(a) one evaluation, one verdict, three dispositions: local admitted by receipt, remote forwarded', async () => {
    const h = await harness()
    const m = await h.post()
    expect(await h.router.intake(m.candidate)).toEqual({ kind: 'pending' })
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT)
    expect(h.calls[0]!.input.state).toMatchObject({ addressing: { constraint: { eligibleAgentIds: [] } } })
    h.calls[0]!.resolve(all)
    await vi.waitFor(() => expect(h.forwards).toHaveLength(1), WAIT)
    expect(h.admits.map((a) => [a.target.agentId, a.receiptId])).toEqual([
      [A, decisionRouteReceiptId(m.record.seq, A)],
      [C, decisionRouteReceiptId(m.record.seq, C)]
    ])
    const fwd = h.forwards[0]!.request
    expect(fwd).toMatchObject({
      deliveryId: `${BOT}:${m.msg.msgId}#${B}`,
      target: { agentId: B, daemonId: OTHER },
      selection: { hostSeq: m.record.seq, effect: 'selected', constrained: false, targetAgentIds: [A, B, C] },
      backfill: [{ text: 'before' }]
    })
    expect(fwd.selection.result).toMatchObject({
      status: 'answered',
      matchedRuleIds: ['billing', 'technical', 'sales']
    })
    expect(h.admits[0]!.evidence.routing).toMatchObject({ effect: 'selected', constrained: false })
    h.forwards[0]!.resolve({ deliveryId: fwd.deliveryId, disposition: 'admitted', daemonId: OTHER })
    await h.router.idle()
    const row = await h.verdict(m.record.seq)
    expect(row.state).toBe('admitted')
    expect([row.inputTokens, row.outputTokens].map(Number)).toEqual([30, 2])
    expect((await h.targetsOf(m.record.seq)).map((t) => [t.agentId, t.disposition])).toEqual([
      [A, 'admitted'],
      [B, 'admitted'],
      [C, 'admitted']
    ])
    expect(h.calls).toHaveLength(1)
    // A duplicate intake joins the settled verdict and never evaluates again.
    expect(await h.router.intake(m.candidate)).toEqual({ kind: 'duplicate' })
  })

  it('(c) participant A + eligible B: one evaluation; skip keeps A and drops B', async () => {
    const h = await harness()
    h.state.routing = routingOf({ otherwise: { type: 'skip' }, rules: [routingConfig.rules[0]!] })
    const m = await h.post({ constraint: [entry(A, true), entry(B, false)] })
    await h.router.intake(m.candidate)
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT)
    h.calls[0]!.resolve(none)
    await h.router.idle()
    expect(h.calls).toHaveLength(1)
    expect((await h.targetsOf(m.record.seq)).map((t) => [t.agentId, t.effect, t.disposition])).toEqual([
      [A, 'participant', 'admitted']
    ])
    expect(h.forwards).toHaveLength(0)
    // A participant is not reported again; no owner is chosen for a constrained conversation.
    expect(h.reports).toEqual([])
  })

  it('keeps the raw provider response in the verdict for answered and unavailable settles', async () => {
    const h = await harness()
    h.state.routing = routingOf({ otherwise: { type: 'skip' }, rules: [routingConfig.rules[0]!] })
    const m = await h.post({ constraint: [entry(A, true), entry(B, false)] })
    await h.router.intake(m.candidate)
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT)
    h.calls[0]!.input.onRawRequest?.('{"model":"jev-latest"}')
    h.calls[0]!.input.onRawResponse?.('{"model":"jev-example"}')
    h.calls[0]!.resolve(none)
    await h.router.idle()
    expect(JSON.parse((await h.verdict(m.record.seq)).answerJson!)).toMatchObject({
      request: '{"model":"jev-latest"}',
      raw: '{"model":"jev-example"}'
    })
    expect(JSON.parse((await h.verdict(m.record.seq)).answerJson!)).not.toHaveProperty('rawTruncated')

    const down = await harness()
    const n = await down.post({ constraint: [entry(A, true), entry(C, false)] })
    await down.router.intake(n.candidate)
    await vi.waitFor(() => expect(down.calls).toHaveLength(1), WAIT)
    down.calls[0]!.input.onRawResponse?.('x'.repeat(DECISION_RAW_JSON_MAX_CHARS + 5))
    down.calls[0]!.resolve({ status: 'unavailable', reason: 'provider' })
    await down.router.idle()
    const stored = JSON.parse((await down.verdict(n.record.seq)).answerJson!)
    expect(stored.raw).toHaveLength(DECISION_RAW_JSON_MAX_CHARS)
    expect(stored.rawTruncated).toBe(true)
    expect(down.admits[1]!.evidence.result).toMatchObject({ status: 'unavailable', reason: 'provider' })
  })

  it('(c) an all-participant reply settles with no model call and keeps every participant', async () => {
    const h = await harness()
    h.state.autoForward = (r) => ({ deliveryId: r.deliveryId, disposition: 'admitted', daemonId: OTHER })
    const m = await h.post({ constraint: [entry(A, true), entry(B, true)] })
    await h.router.intake(m.candidate)
    await h.router.idle()
    expect(h.calls).toHaveLength(0)
    const row = await h.verdict(m.record.seq)
    expect(row.state).toBe('admitted')
    expect(row.inputTokens).toBeNull()
    expect(JSON.parse(row.answerJson!)).toEqual({ evaluated: false })
    expect(h.admits[0]!.evidence.result).toEqual({ status: 'not_evaluated', reason: 'all_participants' })
  })

  it('(d) unavailable keeps the constrained recipients, or the default for a new conversation, or nothing', async () => {
    const constrained = await harness()
    const m = await constrained.post({ constraint: [entry(A, true), entry(C, false)] })
    await constrained.router.intake(m.candidate)
    await vi.waitFor(() => expect(constrained.calls).toHaveLength(1), WAIT)
    constrained.calls[0]!.resolve({ status: 'unavailable', reason: 'provider' })
    await constrained.router.idle()
    expect((await constrained.targetsOf(m.record.seq)).map((t) => [t.agentId, t.effect])).toEqual([
      [A, 'participant'],
      [C, 'fallback_constrained']
    ])
    expect(constrained.admits[1]!.evidence.result).toMatchObject({ status: 'unavailable', reason: 'provider' })

    const fresh = await harness()
    fresh.state.routing = routingOf({}, C)
    const n = await fresh.post()
    await fresh.router.intake(n.candidate)
    await vi.waitFor(() => expect(fresh.calls).toHaveLength(1), WAIT)
    fresh.calls[0]!.resolve({ status: 'unavailable', reason: 'timeout' })
    await fresh.router.idle()
    expect((await fresh.targetsOf(n.record.seq)).map((t) => [t.agentId, t.effect])).toEqual([[C, 'fallback_default']])
    expect(fresh.reports).toEqual([
      {
        botId: BOT,
        sessionKey: n.candidate.delivery.rd.sessionKey,
        channel: CH,
        owner: { agentId: C, daemonId: SELF },
        participants: [{ agentId: C, daemonId: SELF }]
      }
    ])

    const bare = await harness()
    const o = await bare.post()
    await bare.router.intake(o.candidate)
    await vi.waitFor(() => expect(bare.calls).toHaveLength(1), WAIT)
    bare.calls[0]!.resolve({ status: 'unavailable', reason: 'timeout' })
    await bare.router.idle()
    expect(await bare.verdict(o.record.seq)).toMatchObject({ state: 'canceled', cancelReason: 'no_default' })
  })

  it('(d) a refused target is unavailable, never rerouted; siblings proceed and Otherwise is not invoked', async () => {
    const h = await harness()
    h.state.routing = routingOf({}, C)
    const m = await h.post()
    await h.router.intake(m.candidate)
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT)
    h.calls[0]!.resolve(answer({ billing: 0.5, technical: 0.5, sales: 0 }))
    await vi.waitFor(() => expect(h.forwards).toHaveLength(1), WAIT)
    h.forwards[0]!.resolve({ deliveryId: 'x', disposition: 'rejected', reason: 'not_member', daemonId: OTHER })
    await h.router.idle()
    expect((await h.targetsOf(m.record.seq)).map((t) => [t.agentId, t.disposition, t.reason])).toEqual([
      [A, 'admitted', undefined],
      [B, 'unavailable', 'not_member']
    ])
    expect(h.admits.map((a) => a.target.agentId)).toEqual([A])
    expect(h.reports[0]).toMatchObject({ owner: { agentId: A }, participants: [{ agentId: A }] })
  })

  it('(e) a crash after settlement resumes from targetsJson: no re-evaluation, no second admission, usage once', async () => {
    const store = await openTestStore()
    const first = await harness({ store, fence: 'd-self:boot-1' })
    const m = await first.post()
    await first.router.intake(m.candidate)
    await vi.waitFor(() => expect(first.calls).toHaveLength(1), WAIT)
    first.calls[0]!.resolve(all)
    await vi.waitFor(() => expect(first.forwards).toHaveLength(1), WAIT)
    // Crash: the process dies with A and C admitted and B's forward unanswered.
    first.router.close()
    first.forwards[0]!.resolve({ deliveryId: 'x', disposition: 'retry', reason: 'offline' })
    await first.router.idle()
    expect((await first.targetsOf(m.record.seq)).map((t) => t.disposition)).toEqual(['admitted', 'pending', 'admitted'])

    const second = await harness({ store, fence: 'd-self:boot-2' })
    second.state.autoForward = (r) => ({ deliveryId: r.deliveryId, disposition: 'admitted', daemonId: OTHER })
    await second.router.recover()
    await vi.waitFor(async () => expect((await second.verdict(m.record.seq)).state).toBe('admitted'), WAIT)
    await second.router.idle()
    expect(second.calls).toHaveLength(0)
    expect(second.admits).toHaveLength(0)
    const row = await second.verdict(m.record.seq)
    expect([row.inputTokens, row.outputTokens].map(Number)).toEqual([30, 2])
    expect((await second.targetsOf(m.record.seq)).map((t) => t.disposition)).toEqual([
      'admitted',
      'admitted',
      'admitted'
    ])
  })

  it('(e) a pending evaluation recovers as unavailable with no provider call', async () => {
    const store = await openTestStore()
    const first = await harness({ store, fence: 'd-self:boot-1' })
    first.state.routing = routingOf({}, C)
    const m = await first.post()
    await first.router.intake(m.candidate)
    await vi.waitFor(() => expect(first.calls).toHaveLength(1), WAIT)
    first.router.close()
    await first.router.idle()
    const second = await harness({ store, fence: 'd-self:boot-2' })
    second.state.routing = first.state.routing
    await second.router.recover()
    await vi.waitFor(async () => expect((await second.verdict(m.record.seq)).state).toBe('admitted'), WAIT)
    expect(second.calls).toHaveLength(0)
    expect(second.admits[0]!.evidence.result).toEqual({ status: 'unavailable', reason: 'timeout', recovered: true })
  })

  it('(f) the owner is the first admitted target in rule order, whatever order the acks arrive in', async () => {
    const h = await harness()
    let releaseLocal!: () => void
    const gate = new Promise<void>((resolve) => (releaseLocal = resolve))
    const admit = h.state.admit
    h.state.admit = async (request) => {
      await gate
      return await admit(request)
    }
    const m = await h.post()
    await h.router.intake(m.candidate)
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT)
    // A (the first rule) admits locally only after B's remote ack has already arrived.
    h.calls[0]!.resolve(all)
    await vi.waitFor(() => expect(h.forwards).toHaveLength(1), WAIT)
    h.forwards[0]!.resolve({ deliveryId: 'x', disposition: 'admitted', daemonId: OTHER })
    await new Promise((resolve) => setTimeout(resolve, 20))
    releaseLocal()
    await h.router.idle()
    expect(h.reports).toHaveLength(1)
    expect(h.reports[0]).toEqual({
      botId: BOT,
      sessionKey: m.candidate.delivery.rd.sessionKey,
      channel: CH,
      owner: { agentId: A, daemonId: SELF },
      participants: [
        { agentId: A, daemonId: SELF },
        { agentId: B, daemonId: OTHER },
        { agentId: C, daemonId: SELF }
      ]
    })
  })

  it('(f) a skipped message reports nothing and creates no affinity', async () => {
    const g = await harness()
    g.state.routing = routingOf({ otherwise: { type: 'skip' }, rules: [routingConfig.rules[0]!] })
    const n = await g.post()
    await g.router.intake(n.candidate)
    await vi.waitFor(() => expect(g.calls).toHaveLength(1), WAIT)
    g.calls[0]!.resolve(none)
    await g.router.idle()
    expect((await g.verdict(n.record.seq)).state).toBe('skipped')
    expect(g.reports).toEqual([])
    expect(g.admits).toEqual([])
  })

  it('(g) an early follow-up waits for its pending root, then keeps the root recipients with no model call', async () => {
    const h = await harness()
    const root = await h.post()
    await h.router.intake(root.candidate)
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT)
    const reply = await h.post({ thread: root.record.thread! })
    await h.router.intake(reply.candidate)
    await new Promise((resolve) => setTimeout(resolve, 30))
    // The reply has not evaluated or frozen anything while its root is pending.
    expect(h.calls).toHaveLength(1)
    expect((await h.verdict(reply.record.seq)).state).toBe('reserved')
    h.calls[0]!.resolve(answer({ billing: 0.9, technical: 0.05, sales: 0.05 }))
    await h.router.idle()
    expect(h.calls).toHaveLength(1)
    expect((await h.targetsOf(reply.record.seq)).map((t) => [t.agentId, t.effect, t.disposition])).toEqual([
      [A, 'participant', 'admitted']
    ])
    expect(h.admits.map((a) => [a.verdict.seq, a.target.agentId])).toEqual([
      [root.record.seq, A],
      [reply.record.seq, A]
    ])
  })

  it('(h) a fingerprint change during evaluation cancels; the late result neither settles nor dispatches', async () => {
    const h = await harness()
    const m = await h.post()
    await h.router.intake(m.candidate)
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT)
    h.state.routing = routingOf({ otherwise: { type: 'skip' } })
    await h.router.onConfigApplied(`int-${A}`, undefined, {
      bindings: [{ channel: CH, consumer: { type: 'shared_bot_routing' }, enabled: true }],
      definitions: [definition],
      sharedBotRouting: { botId: BOT, config: h.state.routing.config, channels: [{ channel: CH }] }
    })
    h.calls[0]!.resolve(all)
    await h.router.idle()
    expect(await h.verdict(m.record.seq)).toMatchObject({ state: 'canceled', cancelReason: 'config_changed' })
    expect(h.admits).toEqual([])
    expect(h.forwards).toEqual([])
  })

  it('(h) a pause or a removed host projection refuses the pending targets at release', async () => {
    for (const current of [{ status: 'disabled', reason: 'paused' } as const, { status: 'not_host' } as const]) {
      const h = await harness()
      const m = await h.post()
      await h.router.intake(m.candidate)
      await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT)
      h.state.current = current
      h.calls[0]!.resolve(all)
      await h.router.idle()
      const row = await h.verdict(m.record.seq)
      expect(row.state).toBe('canceled')
      expect(h.admits).toEqual([])
      expect(h.forwards).toEqual([])
      expect((await h.targetsOf(m.record.seq)).every((t) => t.disposition === 'rejected')).toBe(true)
    }
  })

  it('releases a lane in seq order: a faster later result waits for the earlier one', async () => {
    const h = await harness()
    const first = await h.post()
    const later = await h.post()
    await h.router.intake(first.candidate)
    await h.router.intake(later.candidate)
    await vi.waitFor(() => expect(h.calls).toHaveLength(2), WAIT)
    h.calls[1]!.resolve(answer({ billing: 0.9, technical: 0.05, sales: 0.05 }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(h.admits).toEqual([])
    h.calls[0]!.resolve(answer({ billing: 0.05, technical: 0.05, sales: 0.9 }))
    await h.router.idle()
    expect(h.admits.map((a) => [a.verdict.seq, a.target.agentId])).toEqual([
      [first.record.seq, C],
      [later.record.seq, A]
    ])
  })

  it('a remote retry keeps the lane until the target admits or times out as unavailable', async () => {
    const h = await harness({ limits: { targetRetryMs: 40 } })
    h.state.autoForward = (r) => ({ deliveryId: r.deliveryId, disposition: 'retry', reason: 'offline' })
    const m = await h.post()
    await h.router.intake(m.candidate)
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT)
    h.calls[0]!.resolve(answer({ billing: 0.05, technical: 0.9, sales: 0.05 }))
    await vi.waitFor(async () => expect((await h.verdict(m.record.seq)).state).toBe('canceled'), WAIT)
    expect((await h.targetsOf(m.record.seq))[0]).toMatchObject({
      agentId: B,
      disposition: 'unavailable',
      reason: 'timeout'
    })
  })

  it('!stop refuses only that agent’s pending target; its siblings keep running', async () => {
    const h = await harness()
    const m = await h.post()
    await h.router.intake(m.candidate)
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT)
    await h.router.cancelForAgent(A, CH, 'stop')
    h.state.autoForward = (r) => ({ deliveryId: r.deliveryId, disposition: 'admitted', daemonId: OTHER })
    h.calls[0]!.resolve(all)
    await h.router.idle()
    expect((await h.targetsOf(m.record.seq)).map((t) => [t.agentId, t.disposition])).toEqual([
      [A, 'rejected'],
      [B, 'admitted'],
      [C, 'admitted']
    ])
  })

  it('a local target whose duty a pool sibling holds is forwarded through the relay, not dropped as not_member', async () => {
    const h = await harness()
    h.state.unserved.add(A)
    const forwarded: RouterForwardRequest[] = []
    h.state.autoForward = (r) => {
      forwarded.push(r)
      return { deliveryId: r.deliveryId, disposition: 'admitted', daemonId: 'd-sibling' }
    }
    const m = await h.post()
    await h.router.intake(m.candidate)
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT)
    h.calls[0]!.resolve(answer({ billing: 0.9, technical: 0.05, sales: 0.05 }))
    await h.router.idle()
    expect(h.admits).toEqual([])
    expect(forwarded.map((r) => [r.target.agentId, r.target.daemonId, r.deliveryId])).toEqual([
      [A, SELF, `${BOT}:${m.msg.msgId}#${A}`]
    ])
    expect((await h.targetsOf(m.record.seq)).map((t) => [t.agentId, t.disposition, t.daemonId])).toEqual([
      [A, 'admitted', 'd-sibling']
    ])
  })

  it('a recovered early follow-up keeps its root recipients; it never falls back to the default', async () => {
    const store = await openTestStore()
    const first = await harness({ store, fence: 'd-self:boot-1' })
    first.state.routing = routingOf({}, C)
    // The root's admission never completes before the crash.
    first.state.admit = () => new Promise(() => undefined)
    const root = await first.post()
    await first.router.intake(root.candidate)
    await vi.waitFor(() => expect(first.calls).toHaveLength(1), WAIT)
    const reply = await first.post({ thread: root.record.thread! })
    await first.router.intake(reply.candidate)
    first.calls[0]!.resolve(answer({ billing: 0.9, technical: 0.05, sales: 0.05 }))
    await vi.waitFor(() => expect(first.admits).toHaveLength(1), WAIT)
    first.router.close()
    expect((await first.verdict(reply.record.seq)).state).toBe('reserved')

    const second = await harness({ store, fence: 'd-self:boot-2' })
    second.state.routing = first.state.routing
    await second.router.recover()
    await vi.waitFor(async () => expect((await second.verdict(reply.record.seq)).state).toBe('admitted'), WAIT)
    await second.router.idle()
    expect(second.calls).toHaveLength(0)
    expect((await second.targetsOf(reply.record.seq)).map((t) => [t.agentId, t.effect, t.disposition])).toEqual([
      [A, 'participant', 'admitted']
    ])
    expect(second.admits.map((a) => [a.verdict.seq, a.target.agentId])).toEqual([
      [root.record.seq, A],
      [reply.record.seq, A]
    ])
  })

  it('an evaluation that throws settles against the frozen constraint, keeping the root recipients', async () => {
    const h = await harness()
    h.state.routing = routingOf({}, B)
    const root = await h.post()
    await h.router.intake(root.candidate)
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT)
    h.calls[0]!.resolve(answer({ billing: 0.9, technical: 0.05, sales: 0.05 }))
    await h.router.idle()
    const reply = await h.post({ thread: root.record.thread!, constraint: [entry(C, false)] })
    await h.router.intake(reply.candidate)
    await vi.waitFor(() => expect(h.calls).toHaveLength(2), WAIT)
    expect(h.calls[1]!.input.state).toMatchObject({
      addressing: { constraint: { eligibleAgentIds: [C], participantAgentIds: [A] } }
    })
    h.calls[1]!.reject(new Error('provider exploded'))
    await h.router.idle()
    expect((await h.targetsOf(reply.record.seq)).map((t) => [t.agentId, t.effect])).toEqual([
      [A, 'participant'],
      [C, 'fallback_constrained']
    ])
  })

  it('an unaccepted owner/participant report is retried until the relay accepts it', async () => {
    const h = await harness()
    let refusals = 2
    h.state.report = () => (refusals-- > 0 ? { accepted: false, reason: 'offline' } : { accepted: true })
    const m = await h.post()
    await h.router.intake(m.candidate)
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT)
    h.calls[0]!.resolve(answer({ billing: 0.9, technical: 0.05, sales: 0.05 }))
    await vi.waitFor(() => expect(h.reports).toHaveLength(3), WAIT)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(h.reports).toHaveLength(3)
    expect(new Set(h.reports.map((r) => JSON.stringify(r))).size).toBe(1)
    expect(h.reports[0]).toMatchObject({ owner: { agentId: A, daemonId: SELF } })
    expect((await h.verdict(m.record.seq)).state).toBe('admitted')
  })

  it('a not_host report refusal from a converged host is final; a bounded retry gives up', async () => {
    const h = await harness()
    h.state.report = () => ({ accepted: false, reason: 'not_host' })
    const m = await h.post()
    await h.router.intake(m.candidate)
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT)
    h.calls[0]!.resolve(answer({ billing: 0.9, technical: 0.05, sales: 0.05 }))
    await h.router.idle()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(h.reports).toHaveLength(1)

    const bounded = await harness({ limits: { reportRetryMs: 30 } })
    bounded.state.report = () => ({ accepted: false, reason: 'offline' })
    const n = await bounded.post()
    await bounded.router.intake(n.candidate)
    await vi.waitFor(() => expect(bounded.calls).toHaveLength(1), WAIT)
    bounded.calls[0]!.resolve(answer({ billing: 0.9, technical: 0.05, sales: 0.05 }))
    await vi.waitFor(() => expect(bounded.reports.length).toBeGreaterThan(1), WAIT)
    await new Promise((resolve) => setTimeout(resolve, 120))
    const settledCount = bounded.reports.length
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(bounded.reports).toHaveLength(settledCount)
  })
})
