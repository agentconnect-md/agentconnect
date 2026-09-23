import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { transcriptChannelKey } from '../src/store/local-store.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

// By decision hold: a bound conversation whose binding cannot run is recorded and never dispatched, never Any.

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

const router = { type: 'shared_bot_routing' }
const routingConfig = {
  enabled: true,
  decisionId: DECISION,
  rules: [{ id: 'r1', when: { type: 'boolean', values: [true] }, action: { type: 'skip' } }],
  otherwise: { type: 'default_agent' }
}

interface AgentSpec {
  id: string
  /** gate: 'decision' | 'disabled' (review) | 'orphan' (no bundle); 'auto' is Any; router: 'routed' | 'hosted'. */
  trigger: 'decision' | 'disabled' | 'auto' | 'orphan' | 'routed' | 'hosted'
}

function decisionsOf(trigger: AgentSpec['trigger']): Record<string, unknown> {
  if (trigger === 'routed') return { decisions: { bindings: [{ channel: 'C1', consumer: router, enabled: true }] } }
  if (trigger === 'hosted')
    return {
      decisions: {
        bindings: [{ channel: 'C1', consumer: router, enabled: true }],
        definitions: [definition],
        sharedBotRouting: { botId: 'b1', config: routingConfig, channels: [{ channel: 'C1' }] }
      }
    }
  if (trigger === 'decision' || trigger === 'disabled')
    return {
      decisions: {
        bindings: [
          trigger === 'decision'
            ? { channel: 'C1', consumer: gate, enabled: true }
            : { channel: 'C1', consumer: gate, enabled: false, disabledReason: 'needs_review' }
        ],
        definitions: [definition]
      }
    }
  return {}
}

const isDecisionRule = (trigger: AgentSpec['trigger']) => ['disabled', 'routed', 'hosted'].includes(trigger)

function scaffold(agents: AgentSpec[]): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-decision-hold-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  for (const a of agents) {
    const adir = join(root, 'agents', a.id)
    mkdirSync(adir, { recursive: true })
    writeFileSync(
      join(adir, 'agent.json'),
      JSON.stringify({
        id: a.id,
        name: a.id,
        status: 'active',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
        integrations: [
          {
            id: `int-${a.id}`,
            platform: 'slack',
            core: {
              bindRules: [
                { match: { kind: 'mention' } },
                a.trigger === 'orphan'
                  ? { match: { kind: 'decision' } }
                  : { match: { kind: isDecisionRule(a.trigger) ? 'decision' : a.trigger }, channel: 'C1' }
              ],
              ...decisionsOf(a.trigger)
            },
            config: { botToken: 'xoxb', appToken: 'xapp' }
          }
        ],
        output: { mode: 'low' }
      })
    )
  }
  return root
}

async function boot(agents: AgentSpec[]) {
  const host = {
    __started: true,
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => 'acp-1'),
    prompt: vi.fn(async () => 'end_turn'),
    cancel: vi.fn(),
    stop: vi.fn()
  }
  const daemon = new Daemon({
    root: scaffold(agents),
    hostFactory: () => host as never,
    slackAppFactory: fakeSlackAppFactory()
  })
  await daemon.start()
  const store = (daemon as any).store
  const scope = (daemon as any).transportScopeForIntegrationIds([`int-${agents[0]!.id}`]) as string | undefined
  const dispatch = vi.spyOn((daemon as any).evalHooks, 'dispatchHandle')
  return { daemon, store, host, dispatch, channel: transcriptChannelKey('C1', scope) }
}

const rowsOf = async (store: any, channel: string): Promise<any[]> =>
  (await store.db.prepare(`SELECT text FROM transcript WHERE channel = ?`).all(channel)) as any[]
const admissionsOf = async (store: any, channel: string): Promise<{ agentId: string }[]> =>
  (await store.db
    .prepare(
      `SELECT tr.agentId AS agentId FROM transcript_recipient tr JOIN transcript t ON t.seq = tr.seq WHERE t.channel = ?`
    )
    .all(channel)) as { agentId: string }[]

let ts = 100
const human = (over: Record<string, unknown> = {}) => {
  ts += 1
  return {
    msgId: `slack:C1:1720000000.000${ts}`,
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
const route = async (daemon: Daemon, msg: unknown, on: string[]): Promise<any> =>
  await (daemon as any).onInboundOutcome(msg, on)

describe('By decision hold', () => {
  it('advertises decision-trigger-v1 to the control plane', async () => {
    const { daemon } = await boot([{ id: 'bot-a', trigger: 'decision' }])
    expect((daemon as any).registrationFeatures()).toContain('decision-trigger-v1')
    await daemon.stop()
  })

  it('records and holds an unaddressed message, an explicit @mention, and a thread reply', async () => {
    const { daemon, store, channel, dispatch } = await boot([{ id: 'bot-a', trigger: 'disabled' }])
    ;(daemon as any).sessions.threadOwner = async () => 'bot-a'

    const unaddressed = await route(daemon, human({ text: 'anyone?' }), ['int-bot-a'])
    const mention = await route(daemon, human({ text: '<@U_FAKE_BOT> help', mentionedBots: ['U_FAKE_BOT'] }), [
      'int-bot-a'
    ])
    const reply = await route(daemon, human({ text: 'follow-up', thread: '1720000000.000001' }), ['int-bot-a'])

    for (const outcome of [unaddressed, mention, reply]) expect(outcome).toEqual({ kind: 'rejected', reason: 'gated' })
    expect((await rowsOf(store, channel)).map((r) => r.text)).toEqual(['anyone?', '<@U_FAKE_BOT> help', 'follow-up'])
    expect(await admissionsOf(store, channel)).toEqual([])
    expect(dispatch).not.toHaveBeenCalled()
    await daemon.stop()
  })

  it('holds a decision rule whose bundle entry is missing, in every channel it covers', async () => {
    const { daemon, store, channel, dispatch } = await boot([{ id: 'bot-a', trigger: 'orphan' }])
    const here = await route(daemon, human({ text: 'no bundle' }), ['int-bot-a'])
    const elsewhere = await route(daemon, human({ channel: 'C9', msgId: 'slack:C9:1720000000.000900' }), ['int-bot-a'])
    for (const outcome of [here, elsewhere]) expect(outcome).toEqual({ kind: 'rejected', reason: 'gated' })
    expect((await rowsOf(store, channel)).map((r) => r.text)).toEqual(['no bundle'])
    expect(dispatch).not.toHaveBeenCalled()
    await daemon.stop()
  })

  it('logs the hold once per window', async () => {
    const { daemon } = await boot([{ id: 'bot-a', trigger: 'disabled' }])
    const info = vi.spyOn((daemon as any).log, 'info')
    await route(daemon, human(), ['int-bot-a'])
    await route(daemon, human(), ['int-bot-a'])
    expect(info.mock.calls.filter(([m]) => String(m).startsWith('decision:'))).toHaveLength(1)
    await daemon.stop()
  })

  it('still runs a control command in the conversation', async () => {
    const { daemon } = await boot([{ id: 'bot-a', trigger: 'decision' }])
    const handle = vi.fn(async () => true)
    ;(daemon as any).commands.handleCommand = handle
    expect(await route(daemon, human({ text: '!stop' }), ['int-bot-a'])).toEqual({
      kind: 'rejected',
      reason: 'suppressed'
    })
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ kind: 'stop' }), expect.anything(), undefined, [
      'int-bot-a'
    ])
    await daemon.stop()
  })

  it('leaves agent-authored traffic on its own ladder', async () => {
    const { daemon } = await boot([{ id: 'bot-a', trigger: 'decision' }])
    const verified = { authorAgentId: 'bot-x', recipients: [] }
    ;(daemon as any).isAgentBotMessage = () => true
    ;(daemon as any).verifyAgentAuthor = () => verified
    const ladder = vi.fn(async () => ({ kind: 'rejected', reason: 'suppressed' }))
    ;(daemon as any).routeVerifiedAgentMessage = ladder
    const hold = vi.spyOn(daemon as any, 'decisionCandidate')
    await route(daemon, human({ sender: { id: 'UAPP', isBot: true } }), ['int-bot-a'])
    expect(ladder).toHaveBeenCalled()
    expect(hold).not.toHaveBeenCalled()
    await daemon.stop()
  })

  it('still dispatches a peer whose own conversation is Any', async () => {
    const { daemon, store, channel } = await boot([
      { id: 'bot-a', trigger: 'disabled' },
      { id: 'bot-b', trigger: 'auto' }
    ])
    await route(daemon, human({ text: 'both of you' }), ['int-bot-a', 'int-bot-b'])
    await vi.waitFor(
      async () => expect((await admissionsOf(store, channel)).map((a) => a.agentId)).toEqual(['bot-b']),
      WAIT
    )
    await daemon.stop()
  })

  describe('shared-bot routed conversations (held until 5b)', () => {
    for (const trigger of ['routed', 'hosted'] as const) {
      it(`records and holds a bare message, a mention and a thread reply (${trigger})`, async () => {
        const { daemon, store, channel, dispatch } = await boot([{ id: 'bot-a', trigger }])
        ;(daemon as any).sessions.threadOwner = async () => 'bot-a'
        const info = vi.spyOn((daemon as any).log, 'info')
        const candidate = vi.spyOn(daemon as any, 'decisionCandidate')
        const outcomes = [
          await route(daemon, human({ text: 'billing?' }), ['int-bot-a']),
          await route(daemon, human({ text: '<@U_FAKE_BOT> help', mentionedBots: ['U_FAKE_BOT'] }), ['int-bot-a']),
          await route(daemon, human({ text: 'follow-up', thread: '1720000000.000001' }), ['int-bot-a'])
        ]
        for (const outcome of outcomes) expect(outcome).toEqual({ kind: 'rejected', reason: 'gated' })
        for (const result of candidate.mock.results)
          expect(await result.value).toEqual({ kind: 'held', reason: 'routing_not_implemented' })
        expect((await rowsOf(store, channel)).map((r) => r.text)).toEqual([
          'billing?',
          '<@U_FAKE_BOT> help',
          'follow-up'
        ])
        expect(await admissionsOf(store, channel)).toEqual([])
        expect(dispatch).not.toHaveBeenCalled()
        const holds = info.mock.calls.filter(([m]) => String(m).startsWith('decision:'))
        expect(holds.map(([m]) => m)).toEqual([
          'decision: shared-bot routing not implemented yet — holding message in ch=C1'
        ])
        await daemon.stop()
      })
    }

    it('holds a thread participant, never gate-evaluating it', async () => {
      const { daemon, store, channel, dispatch } = await boot([
        { id: 'bot-a', trigger: 'routed' },
        { id: 'bot-b', trigger: 'routed' }
      ])
      ;(daemon as any).sessions.threadOwner = async () => 'bot-a'
      ;(daemon as any).sessions.threadParticipants = async () => ['bot-a', 'bot-b']
      const candidate = vi.spyOn(daemon as any, 'decisionCandidate')
      const evaluate = vi.spyOn((daemon as any).decisionEvaluator, 'evaluate')
      await route(daemon, human({ text: 'both?', thread: '1720000000.000001' }), ['int-bot-a', 'int-bot-b'])
      expect(candidate.mock.calls.map(([, agentId]) => agentId).sort()).toEqual(['bot-a', 'bot-b'])
      for (const result of candidate.mock.results)
        expect(await result.value).toEqual({ kind: 'held', reason: 'routing_not_implemented' })
      expect(await admissionsOf(store, channel)).toEqual([])
      expect(dispatch).not.toHaveBeenCalled()
      expect(evaluate).not.toHaveBeenCalled()
      await daemon.stop()
    })

    it('ACKs and holds a relay delivery carrying the router Decision', async () => {
      const { daemon, store, channel, dispatch } = await boot([{ id: 'bot-a', trigger: 'hosted' }])
      const payload = human({ text: 'relayed' })
      const frame = {
        source: 'im' as const,
        agentId: 'bot-a',
        sessionKey: 'C1',
        msgId: payload.msgId,
        botId: '11111111-1111-4111-8111-111111111111',
        integrationId: 'int-bot-a',
        chatId: 'C1',
        payload,
        decisionId: DECISION
      }
      expect(await (daemon as any).handleRelayIm(frame)).toMatchObject({ accepted: true })
      expect((await rowsOf(store, channel)).map((r) => r.text)).toEqual(['relayed'])
      expect(dispatch).not.toHaveBeenCalled()
      await daemon.stop()
    })

    it('still runs a control command and does not advertise decision-routing-v1', async () => {
      const { daemon } = await boot([{ id: 'bot-a', trigger: 'hosted' }])
      const handle = vi.fn(async () => true)
      ;(daemon as any).commands.handleCommand = handle
      expect(await route(daemon, human({ text: '!stop' }), ['int-bot-a'])).toEqual({
        kind: 'rejected',
        reason: 'suppressed'
      })
      expect(handle).toHaveBeenCalled()
      expect((daemon as any).registrationFeatures()).not.toContain('decision-routing-v1')
      await daemon.stop()
    })
  })

  describe('relay-forwarded candidates', () => {
    const relayFrame = (agentId: string, over: Record<string, unknown> = {}) => {
      const payload = human()
      return {
        source: 'im' as const,
        agentId,
        sessionKey: 'C1',
        msgId: payload.msgId,
        botId: '11111111-1111-4111-8111-111111111111',
        integrationId: `int-${agentId}`,
        chatId: 'C1',
        payload,
        ...over
      }
    }

    it('consumes a mismatched, an absent, and an unbound decisionId, and any on a disabled binding', async () => {
      const { daemon, store, channel, dispatch } = await boot([
        { id: 'bot-a', trigger: 'decision' },
        { id: 'bot-b', trigger: 'auto' },
        { id: 'bot-c', trigger: 'disabled' }
      ])
      for (const frame of [
        relayFrame('bot-a', { decisionId: 'other' }),
        relayFrame('bot-a'),
        relayFrame('bot-b', { decisionId: DECISION }),
        relayFrame('bot-c', { decisionId: DECISION })
      ])
        expect(await (daemon as any).handleRelayIm(frame)).toMatchObject({ accepted: true })
      expect(await rowsOf(store, channel)).toHaveLength(4)
      expect(await admissionsOf(store, channel)).toEqual([])
      expect(dispatch).not.toHaveBeenCalled()
      await daemon.stop()
    })
  })
})
