import { describe, expect, it, vi } from 'vitest'
import type { DecisionBundle, DecisionEvaluation } from '@agentconnect.md/protocol'
import { resolveDecisionBundle, type ResolvedDecisionGate } from '../src/decisions/bundle.js'
import type { DecisionEvaluationInput } from '../src/decisions/evaluator.js'
import {
  DEFAULT_DECISION_GATE_LIMITS,
  DecisionGate,
  decisionReceiptId,
  type CurrentGate,
  type DecisionGateHost,
  type DecisionGateLimits,
  type DecisionReleaseRequest,
  type DecisionReleaseResult
} from '../src/decisions/gate.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import type { LocalStore } from '../src/store/local-store.js'
import { openTestStore } from './store-support.js'

// decisions.md §8.3 / §10.3 Stage 1 cases (b), (c), (e), (f), (g) and the §7.3 limits, over a controllable fake provider.

const AGENT = 'bot-a'
const WAIT = { timeout: 3_000, interval: 5 }

const bundle = (over: { model?: string; name?: string; instructions?: string } = {}): DecisionBundle => ({
  bindings: [
    {
      channel: 'C1',
      consumer: { type: 'gate', decisionId: 'd-1', when: { type: 'boolean', values: [true] } },
      enabled: true
    },
    {
      channel: 'C2',
      consumer: { type: 'gate', decisionId: 'd-1', when: { type: 'boolean', values: [true] } },
      enabled: true
    }
  ],
  definitions: [
    {
      id: 'd-1',
      orgId: 'org-1',
      name: over.name ?? 'Needs help',
      providerId: 'typesafe',
      model: over.model ?? 'jev-1.13.0',
      question: {
        type: 'boolean',
        instructions: over.instructions ?? 'Is help needed?',
        criteria: { true: 'Yes', false: 'No' }
      }
    }
  ]
})
const gateOf = (b: DecisionBundle, channel = 'C1'): ResolvedDecisionGate => resolveDecisionBundle(b).gates.get(channel)!

const yes: DecisionEvaluation = {
  status: 'answered',
  answer: { type: 'boolean', value: true, probability: 0.9 },
  model: 'jev-1.13.0-actual',
  usage: { inputTokens: 12, outputTokens: 1 }
}
const no: DecisionEvaluation = {
  status: 'answered',
  answer: { type: 'boolean', value: false, probability: 0.1 },
  model: 'jev-1.13.0-actual',
  usage: { inputTokens: 12, outputTokens: 1 }
}

interface Call {
  input: DecisionEvaluationInput
  signal: AbortSignal
  resolve: (value: DecisionEvaluation) => void
}
interface Release {
  request: DecisionReleaseRequest
  resolve: (value: DecisionReleaseResult) => void
}

async function harness(
  opts: {
    store?: LocalStore
    fence?: string
    limits?: Partial<DecisionGateLimits>
    rejectOnAbort?: boolean
    participates?: (msg: NormalizedMessage) => boolean
  } = {}
) {
  const serving = { served: true }
  const store = opts.store ?? (await openTestStore())
  const calls: Call[] = []
  const releases: Release[] = []
  const state: { current: CurrentGate; applied: DecisionBundle } = {
    applied: bundle(),
    current: { status: 'enabled', gate: gateOf(bundle()), sessionMode: 'createNew' }
  }
  const host: DecisionGateHost = {
    store: () => store,
    ownerFence: () => opts.fence ?? 'daemon-1:boot-1',
    now: () => Date.now(),
    evaluate: (input, signal) =>
      new Promise<DecisionEvaluation>((resolve, reject) => {
        calls.push({ input, signal, resolve })
        if (opts.rejectOnAbort !== false) signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    currentGate: (_agentId, _integrationId, channel) =>
      !serving.served
        ? { status: 'unknown' }
        : state.current.status === 'enabled'
          ? { ...state.current, gate: gateOf(state.applied, channel) ?? state.current.gate }
          : state.current,
    configConverged: () => true,
    servesAgent: () => serving.served,
    participates: async (_agentId, msg) => opts.participates?.(msg) ?? false,
    release: (request) => new Promise<DecisionReleaseResult>((resolve) => releases.push({ request, resolve })),
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    metrics: {
      verdict: () => undefined,
      finished: () => undefined,
      capacity: () => undefined,
      tokens: () => undefined,
      latency: () => undefined
    }
  }
  const gate = new DecisionGate(host, { ...DEFAULT_DECISION_GATE_LIMITS, ...opts.limits })
  let ts = 0
  const post = async (channel = 'C1', over: Partial<NormalizedMessage> = {}) => {
    ts += 1
    const id = `17000000${String(ts).padStart(2, '0')}.0001`
    await store.appendTranscript({
      channel,
      thread: over.thread ?? id,
      ts: id,
      sender: 'U1',
      kind: 'text',
      text: `message ${ts}`,
      orgAgentId: AGENT
    })
    const record = (await store.channelRecordRef(channel, id, AGENT))!
    const msg: NormalizedMessage = {
      msgId: `slack:${channel}:${id}`,
      traceId: 't',
      source: 'user',
      platform: 'slack',
      channel,
      sender: { id: 'U1', isBot: false },
      text: `message ${ts}`,
      mentionedBots: [],
      isDm: false,
      ...over
    }
    return { record, msg }
  }
  const candidate = async (posted: Awaited<ReturnType<typeof post>>, g = gate) =>
    await g.candidate({
      agentId: AGENT,
      integrationId: 'int-a',
      rawChannel: posted.msg.channel,
      record: posted.record,
      gate: gateOf(state.applied, posted.msg.channel),
      sessionMode: 'createNew',
      target: posted.msg,
      delivery: { origin: 'direct', primary: true, via: 'implicit', integrationId: 'int-a', msg: posted.msg }
    })
  return { store, gate, host, calls, releases, state, serving, post, candidate }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
}

describe('DecisionGate', () => {
  it('(b) releases a faster later verdict only after the earlier one is admission-ACKed', async () => {
    const h = await harness()
    const a = await h.post()
    const b = await h.post()
    expect((await h.candidate(a)).kind).toBe('pending')
    expect((await h.candidate(b)).kind).toBe('pending')
    await vi.waitFor(() => expect(h.calls).toHaveLength(2), WAIT)
    h.calls[1]!.resolve(yes)
    await settle()
    expect(h.releases).toHaveLength(0)
    h.calls[0]!.resolve(yes)
    await vi.waitFor(() => expect(h.releases).toHaveLength(1), WAIT)
    expect(h.releases[0]!.request.verdict.seq).toBe(a.record.seq)
    await settle()
    expect(h.releases).toHaveLength(1)
    h.releases[0]!.resolve({ kind: 'admitted' })
    await vi.waitFor(() => expect(h.releases).toHaveLength(2), WAIT)
    expect(h.releases[1]!.request.verdict.seq).toBe(b.record.seq)
    h.releases[1]!.resolve({ kind: 'admitted' })
    await h.gate.idle()
    expect((await h.store.getDecisionVerdict(b.record.seq, AGENT))?.state).toBe('admitted')
    expect(await h.store.decisionReleasedSeq('', 'C1', AGENT)).toBe(b.record.seq)
  })

  it('(b) releases the later verdict once the earlier one skips', async () => {
    const h = await harness()
    const a = await h.post()
    const b = await h.post()
    await h.candidate(a)
    await h.candidate(b)
    await vi.waitFor(() => expect(h.calls).toHaveLength(2), WAIT)
    h.calls[1]!.resolve(yes)
    await settle()
    expect(h.releases).toHaveLength(0)
    h.calls[0]!.resolve(no)
    await vi.waitFor(() => expect(h.releases).toHaveLength(1), WAIT)
    expect(h.releases[0]!.request.verdict.seq).toBe(b.record.seq)
    expect((await h.store.getDecisionVerdict(a.record.seq, AGENT))?.state).toBe('skipped')
    h.releases[0]!.resolve({ kind: 'admitted' })
    await h.gate.idle()
  })

  it('(c) recovers a pending verdict as unavailable with no provider call, before a settled later one', async () => {
    const store = await openTestStore()
    const one = await harness({ store, fence: 'daemon-1:boot-1' })
    const a = await one.post()
    const b = await one.post()
    const d = await one.post('C2')
    await one.candidate(a)
    await one.candidate(b)
    await one.candidate(d)
    await vi.waitFor(() => expect(one.calls).toHaveLength(3), WAIT)
    one.calls[1]!.resolve(yes)
    // A different conversation is its own lane: D releases while A is still pending.
    one.calls[2]!.resolve(yes)
    await vi.waitFor(() => expect(one.releases).toHaveLength(1), WAIT)
    expect(one.releases[0]!.request.verdict.channel).toBe('C2')
    one.releases[0]!.resolve({ kind: 'admitted' })
    await vi.waitFor(
      async () => expect((await store.getDecisionVerdict(b.record.seq, AGENT))?.state).toBe('settled'),
      WAIT
    )
    one.gate.close()
    await one.gate.idle()
    expect((await store.getDecisionVerdict(a.record.seq, AGENT))?.state).toBe('evaluating')

    const two = await harness({ store, fence: 'daemon-1:boot-2' })
    await two.gate.recover()
    await vi.waitFor(() => expect(two.releases).toHaveLength(1), WAIT)
    const first = two.releases[0]!.request
    expect(first.verdict.seq).toBe(a.record.seq)
    expect(first.evidence.result).toEqual({ status: 'unavailable', reason: 'timeout', recovered: true })
    expect(two.calls).toHaveLength(0)
    two.releases[0]!.resolve({ kind: 'admitted' })
    await vi.waitFor(() => expect(two.releases).toHaveLength(2), WAIT)
    expect(two.releases[1]!.request.verdict.seq).toBe(b.record.seq)
    expect(two.releases[1]!.request.evidence.result).toMatchObject({ status: 'answered' })
    two.releases[1]!.resolve({ kind: 'admitted' })
    await two.gate.idle()
    expect(two.calls).toHaveLength(0)
  })

  it('(c) trusts an existing admission receipt at recovery and never releases again', async () => {
    const store = await openTestStore()
    const one = await harness({ store })
    const a = await one.post()
    await one.candidate(a)
    await vi.waitFor(() => expect(one.calls).toHaveLength(1), WAIT)
    one.gate.close()
    await store.appendInbox({
      id: decisionReceiptId(a.record.seq, AGENT),
      sessionKey: 'k',
      agentId: AGENT,
      msg: '{}',
      completedAt: Date.now(),
      enqueuedAt: '1'
    })
    const two = await harness({ store, fence: 'daemon-1:boot-2' })
    await two.gate.recover()
    await two.gate.idle()
    expect((await store.getDecisionVerdict(a.record.seq, AGENT))?.state).toBe('admitted')
    expect(two.releases).toHaveLength(0)
  })

  it('shutdown during evaluation writes nothing and dispatches nothing', async () => {
    const h = await harness()
    const a = await h.post()
    await h.candidate(a)
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT)
    h.gate.close()
    await h.gate.idle()
    expect(h.calls[0]!.signal.aborted).toBe(true)
    expect((await h.store.getDecisionVerdict(a.record.seq, AGENT))?.state).toBe('evaluating')
    expect(h.releases).toHaveLength(0)
  })

  it('(e) !stop cancels an evaluating verdict at once and drops the late answer', async () => {
    const h = await harness({ rejectOnAbort: false })
    const a = await h.post()
    const pending = await h.candidate(a)
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT)
    expect(await h.gate.cancelForAgent(AGENT, 'C1', 'stop')).toBe(1)
    expect(h.calls[0]!.signal.aborted).toBe(true)
    expect(await (pending as { handle: { admission: Promise<unknown> } }).handle.admission).toEqual({
      admitted: false,
      reason: 'gated'
    })
    h.calls[0]!.resolve(yes)
    await h.gate.idle()
    expect(await h.store.getDecisionVerdict(a.record.seq, AGENT)).toMatchObject({
      state: 'canceled',
      cancelReason: 'stop'
    })
    expect(h.releases).toHaveLength(0)
  })

  it('(f) a model or question change cancels an evaluating verdict; a rename does not', async () => {
    const h = await harness()
    const a = await h.post()
    await h.candidate(a)
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT)
    await h.gate.onConfigApplied('int-a', bundle(), bundle({ name: 'Renamed' }))
    expect(h.calls[0]!.signal.aborted).toBe(false)
    await h.gate.onConfigApplied('int-a', bundle(), bundle({ model: 'jev-latest' }))
    expect(h.calls[0]!.signal.aborted).toBe(true)
    await h.gate.idle()
    expect(await h.store.getDecisionVerdict(a.record.seq, AGENT)).toMatchObject({
      state: 'canceled',
      cancelReason: 'config_changed'
    })
    const b = await h.post()
    await h.candidate(b)
    await vi.waitFor(() => expect(h.calls).toHaveLength(2), WAIT)
    await h.gate.onConfigApplied('int-a', bundle(), bundle({ instructions: 'Is this urgent?' }))
    await h.gate.idle()
    expect((await h.store.getDecisionVerdict(b.record.seq, AGENT))?.cancelReason).toBe('config_changed')
    expect(h.releases).toHaveLength(0)
  })

  it('(f) a change applied between settle and release is caught by the pre-release recheck', async () => {
    const h = await harness()
    const a = await h.post()
    await h.candidate(a)
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT)
    h.state.applied = bundle({ model: 'jev-latest' })
    h.calls[0]!.resolve(yes)
    await h.gate.idle()
    expect(await h.store.getDecisionVerdict(a.record.seq, AGENT)).toMatchObject({
      state: 'canceled',
      cancelReason: 'config_changed'
    })
    h.state.applied = bundle()
    h.state.current = { status: 'disabled', reason: 'needs_review' }
    const b = await h.post()
    await h.candidate(b)
    await vi.waitFor(() => expect(h.calls).toHaveLength(2), WAIT)
    h.calls[1]!.resolve(yes)
    await h.gate.idle()
    expect((await h.store.getDecisionVerdict(b.record.seq, AGENT))?.cancelReason).toBe('needs_review')
    expect(h.releases).toHaveLength(0)
  })

  it('(g) every unavailable reason continues to the same target with failure evidence; skip never does', async () => {
    const reasons = ['timeout', 'capacity', 'credentials', 'provider', 'invalid_response', 'unsupported_input'] as const
    const h = await harness()
    for (const reason of reasons) {
      const posted = await h.post()
      await h.candidate(posted)
      await vi.waitFor(() => expect(h.calls.length).toBeGreaterThan(0), WAIT)
      h.calls.shift()!.resolve({ status: 'unavailable', reason })
      await vi.waitFor(() => expect(h.releases).toHaveLength(1), WAIT)
      const release = h.releases.shift()!
      expect(release.request.evidence.result).toEqual({ status: 'unavailable', reason })
      expect(release.request.delivery.msg.msgId).toBe(posted.msg.msgId)
      release.resolve({ kind: 'admitted' })
      await h.gate.idle()
    }
    const skipped = await h.post()
    await h.candidate(skipped)
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT)
    h.calls[0]!.resolve(no)
    await h.gate.idle()
    expect(h.releases).toHaveLength(0)
  })

  it('joins a duplicate candidate while evaluating with one provider call, and reads a settled duplicate', async () => {
    const h = await harness()
    const a = await h.post()
    expect((await h.candidate(a)).kind).toBe('pending')
    expect((await h.candidate(a)).kind).toBe('pending')
    await settle()
    expect(h.calls).toHaveLength(1)
    h.calls[0]!.resolve(yes)
    await vi.waitFor(() => expect(h.releases).toHaveLength(1), WAIT)
    h.releases[0]!.resolve({ kind: 'admitted' })
    await h.gate.idle()
    expect((await h.candidate(a)).kind).toBe('duplicate')
    expect(h.calls).toHaveLength(1)
  })

  it('single-flights concurrent submissions of one message: one provider call, and its skip never dispatches', async () => {
    const h = await harness()
    const a = await h.post()
    const outcomes = await Promise.all([h.candidate(a), h.candidate(a)])
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['pending', 'pending'])
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.releases).toHaveLength(0)
    h.calls[0]!.resolve(no)
    await h.gate.idle()
    expect(h.calls).toHaveLength(1)
    expect(h.releases).toHaveLength(0)
    expect((await h.store.getDecisionVerdict(a.record.seq, AGENT))?.state).toBe('skipped')
    for (const outcome of outcomes)
      expect(await (outcome as { handle: { admission: Promise<unknown> } }).handle.admission).toEqual({
        admitted: false,
        reason: 'gated'
      })
  })

  it('(f) a config change applied while a release is in flight refuses its dispatch and cancels the verdict', async () => {
    const h = await harness()
    const a = await h.post()
    await h.candidate(a)
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT)
    h.calls[0]!.resolve(yes)
    await vi.waitFor(() => expect(h.releases).toHaveLength(1), WAIT)
    // Announced only: the fence alone would still read the old gate, so the token must carry the cancel.
    await h.gate.onConfigApplied('int-a', bundle(), bundle({ model: 'jev-latest' }))
    expect(h.releases[0]!.request.beforeDispatch()).toBe(false)
    h.releases[0]!.resolve({ kind: 'rejected', reason: 'gated', recoverable: false })
    await h.gate.idle()
    expect(await h.store.getDecisionVerdict(a.record.seq, AGENT)).toMatchObject({
      state: 'canceled',
      cancelReason: 'config_changed'
    })
  })

  it('(f) the dispatch fence rechecks the applied gate even before the config change is announced', async () => {
    const h = await harness()
    const a = await h.post()
    await h.candidate(a)
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT)
    h.calls[0]!.resolve(yes)
    await vi.waitFor(() => expect(h.releases).toHaveLength(1), WAIT)
    const fence = h.releases[0]!.request.beforeDispatch
    h.state.current = { status: 'enabled', gate: gateOf(bundle()), sessionMode: 'append' }
    expect(fence()).toBe(false)
    h.state.current = { status: 'enabled', gate: gateOf(bundle()), sessionMode: 'createNew' }
    h.state.applied = bundle({ instructions: 'Is this urgent?' })
    expect(fence()).toBe(false)
    h.releases[0]!.resolve({ kind: 'rejected', reason: 'gated', recoverable: false })
    await h.gate.idle()
    expect(await h.store.getDecisionVerdict(a.record.seq, AGENT)).toMatchObject({
      state: 'canceled',
      cancelReason: 'config_changed'
    })
  })

  it('(f) a session-mode-only change refuses an in-flight release even while the bundle and host view are unchanged', async () => {
    const h = await harness()
    const a = await h.post()
    await h.candidate(a)
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT)
    h.calls[0]!.resolve(yes)
    await vi.waitFor(() => expect(h.releases).toHaveLength(1), WAIT)
    const fence = h.releases[0]!.request.beforeDispatch
    await h.gate.onConfigApplied('int-a', bundle(), bundle(), [{ channel: 'C1', mode: 'append' }])
    expect(fence()).toBe(false)
    h.releases[0]!.resolve({ kind: 'rejected', reason: 'gated', recoverable: false })
    await h.gate.idle()
    expect(await h.store.getDecisionVerdict(a.record.seq, AGENT)).toMatchObject({
      state: 'canceled',
      cancelReason: 'config_changed'
    })
  })

  it('(f) announcing the same session mode leaves an in-flight release alone', async () => {
    const h = await harness()
    const a = await h.post()
    await h.candidate(a)
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT)
    h.calls[0]!.resolve(yes)
    await vi.waitFor(() => expect(h.releases).toHaveLength(1), WAIT)
    await h.gate.onConfigApplied('int-a', bundle(), bundle(), [])
    expect(h.releases[0]!.request.beforeDispatch()).toBe(true)
  })

  it('(f) a verdict frozen under the lagging host gate never releases once a new config was announced', async () => {
    const h = await harness()
    // Announced while the host's agents still serve the old gate, so intake freezes the old config.
    await h.gate.onConfigApplied('int-a', bundle(), bundle({ model: 'jev-latest' }))
    const a = await h.post()
    expect((await h.candidate(a)).kind).toBe('pending')
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT)
    h.calls[0]!.resolve(yes)
    await h.gate.idle()
    expect(h.releases).toHaveLength(0)
    expect(await h.store.getDecisionVerdict(a.record.seq, AGENT)).toMatchObject({
      state: 'canceled',
      cancelReason: 'config_changed'
    })
  })

  it('(f) a verdict never releases once its integration removal was announced but not yet reconciled', async () => {
    const h = await harness()
    await h.gate.onConfigApplied('int-a', bundle(), undefined)
    const a = await h.post()
    expect((await h.candidate(a)).kind).toBe('pending')
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT)
    h.calls[0]!.resolve(yes)
    await h.gate.idle()
    expect(h.releases).toHaveLength(0)
    expect(await h.store.getDecisionVerdict(a.record.seq, AGENT)).toMatchObject({
      state: 'canceled',
      cancelReason: 'integration_removed'
    })
  })

  it('judges an @mention in a thread the agent participates in; an unmentioned reply there bypasses', async () => {
    const h = await harness({ participates: (msg) => msg.thread === 'T-joined' })
    const mention = await h.post('C1', { thread: 'T-joined', trigger: 'mention', mentionedBots: ['U_BOT'] })
    expect((await h.candidate(mention)).kind).toBe('pending')
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT)
    h.calls[0]!.resolve(no)
    await h.gate.idle()
    expect((await h.store.getDecisionVerdict(mention.record.seq, AGENT))?.state).toBe('skipped')
    expect(h.releases).toHaveLength(0)
    const reply = await h.post('C1', { thread: 'T-joined' })
    expect(await h.candidate(reply)).toEqual({ kind: 'admit' })
    expect(await h.store.getDecisionVerdict(reply.record.seq, AGENT)).toBeUndefined()
    expect(h.calls).toHaveLength(1)
  })

  it('bounds active evaluations per provider and answers a full queue with capacity', async () => {
    const h = await harness()
    const posted: Awaited<ReturnType<typeof h.post>>[] = []
    for (let i = 0; i < 21; i++) posted.push(await h.post('C1', { thread: `T${i}` }))
    for (const p of posted) await h.candidate(p)
    await vi.waitFor(() => expect(h.calls).toHaveLength(4), WAIT)
    // 4 active + 16 queued for the one provider; the 21st has no queue share left.
    await vi.waitFor(
      async () =>
        expect(await h.store.getDecisionVerdict(posted[20]!.record.seq, AGENT)).toMatchObject({
          state: 'settled',
          unavailableReason: 'capacity'
        }),
      WAIT
    )
    h.calls[0]!.resolve(no)
    await vi.waitFor(() => expect(h.calls).toHaveLength(5), WAIT)
    h.gate.close()
  })

  it('answers capacity once the daemon-wide queue of 64 is full', async () => {
    const h = await harness({ limits: { providerQueued: 1_000 } })
    const posted: Awaited<ReturnType<typeof h.post>>[] = []
    for (let i = 0; i < 69; i++) posted.push(await h.post('C1', { thread: `T${i}` }))
    for (const p of posted) await h.candidate(p)
    await vi.waitFor(() => expect(h.calls).toHaveLength(4), WAIT)
    await vi.waitFor(
      async () =>
        expect(await h.store.getDecisionVerdict(posted[68]!.record.seq, AGENT)).toMatchObject({
          unavailableReason: 'capacity'
        }),
      WAIT
    )
    expect((await h.store.getDecisionVerdict(posted[67]!.record.seq, AGENT))?.state).toBe('reserved')
    h.gate.close()
  })

  it('settles a verdict queued past its deadline as timeout without calling the provider', async () => {
    const h = await harness({ limits: { providerActive: 1, deadlineMs: 50 } })
    const a = await h.post()
    const b = await h.post()
    await h.candidate(a)
    await h.candidate(b)
    await vi.waitFor(
      async () =>
        expect(await h.store.getDecisionVerdict(b.record.seq, AGENT)).toMatchObject({
          state: 'settled',
          unavailableReason: 'timeout'
        }),
      WAIT
    )
    expect(h.calls).toHaveLength(1)
    h.gate.close()
  })

  it('holds a participation admit behind a lower pending verdict of its lane', async () => {
    const h = await harness({ participates: (msg) => msg.thread === 'T-joined' })
    const a = await h.post()
    await h.candidate(a)
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT)
    const reply = await h.post('C1', { thread: 'T-joined' })
    let admitted = false
    const outcome = h.candidate(reply).then((result) => {
      admitted = true
      return result
    })
    await settle()
    expect(admitted).toBe(false)
    h.calls[0]!.resolve(no)
    expect(await outcome).toEqual({ kind: 'admit' })
    expect(await h.store.getDecisionVerdict(reply.record.seq, AGENT)).toBeUndefined()
    await h.gate.idle()
  })

  it('(b) a lower row that reserves while the ingress barrier holds a settled later one drains first', async () => {
    const h = await harness()
    const a = await h.post()
    const b = await h.post()
    const closeA = h.gate.openIngress(a.record)
    await h.candidate(b)
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT)
    h.calls[0]!.resolve(yes)
    await settle()
    expect(h.releases).toHaveLength(0)
    expect((await h.candidate(a)).kind).toBe('pending')
    closeA()
    await vi.waitFor(() => expect(h.calls).toHaveLength(2), WAIT)
    await settle()
    expect(h.releases).toHaveLength(0)
    h.calls[1]!.resolve(yes)
    await vi.waitFor(() => expect(h.releases).toHaveLength(1), WAIT)
    expect(h.releases[0]!.request.verdict.seq).toBe(a.record.seq)
    h.releases[0]!.resolve({ kind: 'admitted' })
    await vi.waitFor(() => expect(h.releases).toHaveLength(2), WAIT)
    expect(h.releases[1]!.request.verdict.seq).toBe(b.record.seq)
    h.releases[1]!.resolve({ kind: 'admitted' })
    await h.gate.idle()
  })

  it('leaves a settled verdict of an agent that moved away for its new owner', async () => {
    const h = await harness()
    const a = await h.post()
    await h.candidate(a)
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT)
    h.serving.served = false
    h.calls[0]!.resolve(yes)
    await h.gate.idle()
    expect(h.releases).toHaveLength(0)
    const row = await h.store.getDecisionVerdict(a.record.seq, AGENT)
    expect(row?.state).toBe('settled')
    expect(row?.disposition).toBe('match')
  })
})
