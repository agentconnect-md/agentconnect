import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DecisionEvaluation } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import type { DecisionEvaluationInput } from '../src/decisions/evaluator.js'
import { transcriptChannelKey } from '../src/store/local-store.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

// The Stage 1 gate end to end (decisions.md §10.3): a real daemon and store, with `decisionEvaluator.evaluate` spied on.

const DECISION = 'd-1'
const gate = { type: 'gate', decisionId: DECISION, when: { type: 'boolean', values: [true] } }
const definition = {
  id: DECISION,
  orgId: 'org-1',
  name: 'Needs help',
  providerId: 'typesafe',
  model: 'jev-1.13.0',
  question: { type: 'boolean', instructions: 'Is help needed?', criteria: { true: 'Yes', false: 'No' } }
}
const yes: DecisionEvaluation = {
  status: 'answered',
  answer: { type: 'boolean', value: true, probability: 0.9 },
  model: 'jev-1.13.0',
  usage: { inputTokens: 20, outputTokens: 1 }
}
const no: DecisionEvaluation = {
  status: 'answered',
  answer: { type: 'boolean', value: false, probability: 0.2 },
  model: 'jev-1.13.0',
  usage: { inputTokens: 20, outputTokens: 1 }
}

function scaffold(opts: { append?: boolean; steering?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-decision-gate-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      ...(opts.steering ? { features: { sessionSteering: true } } : {}),
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const adir = join(root, 'agents', 'bot-a')
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [
        {
          id: 'int-bot-a',
          platform: 'slack',
          core: {
            bindRules: [{ match: { kind: 'mention' } }, { match: { kind: 'decision' }, channel: 'C1' }],
            decisions: { bindings: [{ channel: 'C1', consumer: gate, enabled: true }], definitions: [definition] },
            ...(opts.append ? { sessionModes: [{ channel: 'C1', mode: 'append' }] } : {})
          },
          config: { botToken: 'xoxb', appToken: 'xapp' }
        }
      ],
      output: { mode: 'low' }
    })
  )
  return root
}

async function boot(opts: { blockTurns?: boolean; append?: boolean; steering?: boolean } = {}) {
  let release!: () => void
  const blocked = new Promise<void>((resolve) => (release = resolve))
  const host = {
    __started: true,
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => 'acp-1'),
    prompt: vi.fn(async (_sessionId: string, _blocks: { type: string; text?: string }[]) => {
      if (opts.blockTurns) await blocked
      return 'end_turn'
    }),
    cancel: vi.fn(async () => {}),
    stop: vi.fn(),
    ...(opts.steering
      ? {
          hasSession: vi.fn(() => true),
          steeringSupported: vi.fn(() => true),
          steer: vi.fn(async (_sessionId: string, _blocks: { type: string; text?: string }[]) => 'injected')
        }
      : {})
  }
  const daemon = new Daemon({
    root: scaffold(opts),
    hostFactory: () => host as never,
    slackAppFactory: fakeSlackAppFactory()
  })
  await daemon.start()
  ;(daemon as any).connByIntegration.set('int-bot-a', {
    workspaceId: () => 'T_FAKE_TEAM',
    setStatus: vi.fn(async () => {}),
    react: vi.fn(async () => {}),
    postMessage: vi.fn(async () => 'reply-1'),
    postBlocks: vi.fn(async () => 'status-bar'),
    updateBlocks: vi.fn(async () => {})
  })
  const store = (daemon as any).store
  const scope = (daemon as any).transportScopeForIntegrationIds(['int-bot-a']) as string | undefined
  const channel = transcriptChannelKey('C1', scope)
  const evaluate = vi.spyOn((daemon as any).decisionEvaluator, 'evaluate') as unknown as ReturnType<
    typeof vi.fn<(input: DecisionEvaluationInput, signal?: AbortSignal) => Promise<DecisionEvaluation>>
  >
  const dispatch = vi.spyOn((daemon as any).evalHooks, 'dispatchHandle')
  return { daemon, store, host, channel, scope, evaluate, dispatch, release, gate: (daemon as any).decisionGate }
}

let ts = 100
const human = (over: Record<string, unknown> = {}) => {
  ts += 1
  const id = `1720000000.000${ts}`
  return {
    msgId: `slack:C1:${id}`,
    traceId: 't',
    source: 'user' as const,
    platform: 'slack' as const,
    channel: 'C1',
    sender: { id: 'U1', isBot: false },
    text: 'hello',
    mentionedBots: [] as string[],
    isDm: false,
    ...over
  }
}
const route = async (daemon: Daemon, msg: unknown): Promise<any> =>
  await (daemon as any).onInboundOutcome(msg, ['int-bot-a'])
const verdicts = async (store: any): Promise<any[]> =>
  (await store.db
    .prepare('SELECT seq, subject, state, disposition, unavailableReason FROM decision_verdict ORDER BY seq')
    .all()) as any[]
const admissions = async (store: any, channel: string): Promise<{ text: string; agentId: string }[]> =>
  (await store.db
    .prepare(
      `SELECT t.text AS text, tr.agentId AS agentId FROM transcript_recipient tr JOIN transcript t ON t.seq = tr.seq
        WHERE t.channel = ? AND t.kind = 'text' ORDER BY t.seq`
    )
    .all(channel)) as { text: string; agentId: string }[]
const textsOf = (blocks: { type: string; text?: string }[]): string[] => blocks.map((b) => b.text ?? '')
const stateText = (input: DecisionEvaluationInput): string =>
  (input.state as { currentMessage: { text: string } }).currentMessage.text

describe('By decision gate (daemon)', () => {
  it('(a) skip A, skip B, match C: one admission, one session, A and B once as attributed background', async () => {
    const { daemon, store, host, channel, evaluate, gate: g } = await boot()
    evaluate.mockImplementation(async (input) => (stateText(input).startsWith('C ') ? yes : no))
    await route(daemon, human({ text: 'A first remark', sender: { id: 'U1', isBot: false } }))
    await route(daemon, human({ text: 'B second remark', sender: { id: 'U2', isBot: false } }))
    await route(daemon, human({ text: 'C please help', sender: { id: 'U3', isBot: false } }))
    await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(1), WAIT)
    await g.idle()
    expect((await verdicts(store)).map((v) => v.state)).toEqual(['skipped', 'skipped', 'admitted'])
    expect(await admissions(store, channel)).toEqual([{ text: 'C please help', agentId: 'bot-a' }])
    expect((await store.db.prepare('SELECT key FROM sessions').all()) as unknown[]).toHaveLength(1)
    const blocks = textsOf(host.prompt.mock.calls[0]![1])
    const background = blocks.filter((b) => b.startsWith('(Background conversation'))
    expect(background).toHaveLength(1)
    expect(background[0]!.match(/A first remark/g)).toHaveLength(1)
    expect(background[0]!.match(/B second remark/g)).toHaveLength(1)
    expect(background[0]).toContain('[U1] (thread')
    expect(background[0]).toMatch(/\[U1\][^\n]* A first remark/)
    expect(background[0]).toMatch(/\[U2\][^\n]* B second remark/)
    expect(background[0]).not.toContain('C please help')
    const evidence = blocks.find((b) => b.startsWith('(Decision evidence'))
    expect(evidence).toContain(`Decision: ${DECISION}`)
    expect(evidence).toContain('Answer: yes')
    const trigger = blocks.findIndex((b) => b.includes('[U3] C please help'))
    expect(blocks.indexOf(background[0]!)).toBeLessThan(trigger)
    expect(blocks.indexOf(evidence!)).toBeGreaterThan(trigger)
    await daemon.stop()
  })

  it('(d) evaluates an @mention and a top-level message, and admits a participant reply with no verdict', async () => {
    const { daemon, store, channel, scope, evaluate, dispatch, gate: g } = await boot()
    evaluate.mockResolvedValue(no)
    await route(daemon, human({ text: '<@U_FAKE_BOT> hi', mentionedBots: ['U_FAKE_BOT'] }))
    await route(daemon, human({ text: 'top-level' }))
    await g.idle()
    expect((await verdicts(store)).map((v) => v.state)).toEqual(['skipped', 'skipped'])
    expect(dispatch).not.toHaveBeenCalled()
    const thread = '1720000000.000900'
    const key = `slack:C1:${thread}:bot-a${scope ? `:${scope}` : ''}`
    await store.upsertSession({
      key,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread,
      transportScope: scope ?? null,
      acpSessionId: null,
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    await store.recordThreadParticipation({
      channel: 'C1',
      thread,
      agentId: 'bot-a',
      sessionKey: key,
      transportScope: scope
    })
    const before = evaluate.mock.calls.length
    await route(daemon, human({ text: 'a reply in our thread', thread }))
    await vi.waitFor(
      async () => expect((await admissions(store, channel)).map((a) => a.text)).toContain('a reply in our thread'),
      WAIT
    )
    expect(evaluate.mock.calls.length).toBe(before)
    expect(await verdicts(store)).toHaveLength(2)
    await daemon.stop()
  })

  it('(e) a real !stop cancels the pending verdict without waiting for the evaluator', async () => {
    const { daemon, store, evaluate, dispatch, gate: g } = await boot()
    let seen: AbortSignal | undefined
    evaluate.mockImplementation(
      (_input, signal) =>
        new Promise<DecisionEvaluation>((_resolve, reject) => {
          seen = signal
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
    await route(daemon, human({ text: 'should I?' }))
    await vi.waitFor(() => expect(seen).toBeDefined(), WAIT)
    expect(await route(daemon, human({ text: '!stop' }))).toEqual({ kind: 'rejected', reason: 'suppressed' })
    expect(seen!.aborted).toBe(true)
    await g.idle()
    expect(await verdicts(store)).toMatchObject([{ state: 'canceled' }])
    expect(dispatch).not.toHaveBeenCalled()
    await daemon.stop()
  })

  it('(g) an unavailable evaluation dispatches the same agent with failure evidence; a skip never does', async () => {
    const { daemon, store, host, evaluate, dispatch, gate: g } = await boot()
    evaluate.mockResolvedValueOnce(no)
    await route(daemon, human({ text: 'skipped one' }))
    await g.idle()
    expect(dispatch).not.toHaveBeenCalled()
    evaluate.mockResolvedValueOnce({ status: 'unavailable', reason: 'provider' })
    await route(daemon, human({ text: 'provider down' }))
    await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(1), WAIT)
    expect(dispatch.mock.calls[0]![0]).toBe('bot-a')
    const evidence = textsOf(host.prompt.mock.calls[0]![1]).find((b) => b.startsWith('(Decision evidence'))
    expect(evidence).toContain('unavailable: provider, delivered because evaluation failed')
    expect((await verdicts(store)).map((v) => [v.state, v.unavailableReason])).toEqual([
      ['skipped', null],
      ['admitted', 'provider']
    ])
    await daemon.stop()
  })

  it('a match steered into a live append-mode turn still carries its background and evidence', async () => {
    const { daemon, host, evaluate, release, gate: g } = await boot({ blockTurns: true, append: true, steering: true })
    evaluate.mockImplementation(async (input) => (stateText(input).startsWith('skip') ? no : yes))
    await route(daemon, human({ text: 'first ask' }))
    await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(1), WAIT)
    await route(daemon, human({ text: 'skip this aside', sender: { id: 'U2', isBot: false } }))
    await route(daemon, human({ text: 'second ask', sender: { id: 'U3', isBot: false } }))
    await vi.waitFor(() => expect(host.steer).toHaveBeenCalledTimes(1), WAIT)
    const blocks = textsOf(host.steer!.mock.calls[0]![1])
    const trigger = blocks.findIndex((b) => b.includes('[U3] second ask'))
    const background = blocks.findIndex((b) => b.startsWith('(Background conversation'))
    const evidence = blocks.findIndex((b) => b.startsWith('(Decision evidence'))
    expect(background).toBeGreaterThanOrEqual(0)
    expect(blocks[background]).toMatch(/\[U2\][^\n]* skip this aside/)
    expect(blocks[background]).not.toContain('first ask')
    expect(background).toBeLessThan(trigger)
    expect(evidence).toBeGreaterThan(trigger)
    expect(blocks[evidence]).toContain('Answer: yes')
    release()
    await g.idle()
    await daemon.stop()
  })

  it('(h) a row an evaluating verdict holds survives 100 newer messages and is admitted intact', async () => {
    const { daemon, store, channel, evaluate, gate: g } = await boot()
    let answer!: (value: DecisionEvaluation) => void
    evaluate.mockImplementation(() => new Promise<DecisionEvaluation>((resolve) => (answer = resolve)))
    await route(daemon, human({ text: 'the held one' }))
    await vi.waitFor(() => expect(answer).toBeDefined(), WAIT)
    for (let i = 0; i < 110; i++)
      await (daemon as any).recordChannelInbound(human({ text: `newer ${i}` }), ['int-bot-a'], { orgAgentId: 'bot-a' })
    await store.sweepObservations('', channel)
    answer(yes)
    await vi.waitFor(
      async () => expect((await admissions(store, channel)).map((a) => a.text)).toEqual(['the held one']),
      WAIT
    )
    await g.idle()
    await daemon.stop()
  })

  it('(i) a relay retry reuses the verdict: one evaluation, one admission, durable intake on the inbox row', async () => {
    const { daemon, store, host, channel, evaluate, release, gate: g } = await boot({ blockTurns: true })
    evaluate.mockResolvedValue(yes)
    const payload = human({ text: 'relayed help' })
    const frame = {
      source: 'im' as const,
      agentId: 'bot-a',
      sessionKey: 'C1',
      msgId: payload.msgId,
      botId: '11111111-1111-4111-8111-111111111111',
      integrationId: 'int-bot-a',
      chatId: 'C1',
      decisionId: DECISION,
      payload
    }
    expect(await (daemon as any).handleRelayIm(frame)).toEqual({ msgId: payload.msgId, accepted: true })
    expect(await (daemon as any).handleRelayIm(frame)).toEqual({ msgId: payload.msgId, accepted: true })
    await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(1), WAIT)
    expect(evaluate).toHaveBeenCalledTimes(1)
    expect(await (daemon as any).handleRelayIm(frame)).toEqual({ msgId: payload.msgId, accepted: true })
    await g.idle()
    expect(evaluate).toHaveBeenCalledTimes(1)
    expect(await admissions(store, channel)).toEqual([{ text: 'relayed help', agentId: 'bot-a' }])
    // What a restart replays: the inbox row carries the background choice and the evidence, not a recompute.
    const inbox = (await store.db.prepare('SELECT msg FROM inbox WHERE completedAt IS NULL').all()) as { msg: string }[]
    expect(inbox).toHaveLength(1)
    const persisted = JSON.parse(inbox[0]!.msg)
    expect(persisted.channelIntake).toMatchObject({ backgroundSeqs: [], evidence: { decisionId: DECISION } })
    const [, blocks] = host.prompt.mock.calls[0]!
    expect(textsOf(blocks).some((b) => b.startsWith('(Decision evidence'))).toBe(true)
    release()
    await vi.waitFor(() => expect((daemon as any).pending.size).toBe(0), WAIT)
    await daemon.stop()
  })

  it('ACKs a durability refusal when the record cannot be read back', async () => {
    const { daemon, store } = await boot()
    store.channelRecordRef = async () => {
      throw new Error('store down')
    }
    const payload = human({ text: 'unrecorded' })
    expect(
      await (daemon as any).handleRelayIm({
        source: 'im',
        agentId: 'bot-a',
        sessionKey: 'C1',
        msgId: payload.msgId,
        botId: '11111111-1111-4111-8111-111111111111',
        integrationId: 'int-bot-a',
        chatId: 'C1',
        decisionId: DECISION,
        payload
      })
    ).toEqual({ msgId: payload.msgId, accepted: false, reason: 'durability' })
    await daemon.stop()
  })
})
