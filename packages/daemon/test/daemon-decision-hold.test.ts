import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { transcriptChannelKey } from '../src/store/local-store.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

/**
 * Stage 3a By decision hold (decisions.md §3.1, §7.1): a human candidate in a bound conversation is
 * recorded (message-intake.md §5 step 1) and never dispatched, whatever rung selected it, until the
 * Stage 3b gate lands. Commands and agent-authored traffic keep their own paths.
 */

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

interface AgentSpec {
  id: string
  /** 'decision' binds C1 By decision with a bundle; 'auto' is an ordinary Any conversation. */
  trigger: 'decision' | 'auto'
}

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
              bindRules: [{ match: { kind: 'mention' } }, { match: { kind: a.trigger }, channel: 'C1' }],
              ...(a.trigger === 'decision'
                ? {
                    decisions: {
                      bindings: [{ channel: 'C1', consumer: gate, enabled: true }],
                      definitions: [definition]
                    }
                  }
                : {})
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

describe('Stage 3a By decision hold', () => {
  it('advertises decision-trigger-v1 to the control plane', async () => {
    const { daemon } = await boot([{ id: 'bot-a', trigger: 'decision' }])
    expect((daemon as any).registrationFeatures()).toContain('decision-trigger-v1')
    await daemon.stop()
  })

  it('records and holds an unaddressed message, an explicit @mention, and a thread reply', async () => {
    const { daemon, store, channel, dispatch } = await boot([{ id: 'bot-a', trigger: 'decision' }])
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

  it('logs the hold once per window', async () => {
    const { daemon } = await boot([{ id: 'bot-a', trigger: 'decision' }])
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
      { id: 'bot-a', trigger: 'decision' },
      { id: 'bot-b', trigger: 'auto' }
    ])
    await route(daemon, human({ text: 'both of you' }), ['int-bot-a', 'int-bot-b'])
    await vi.waitFor(
      async () => expect((await admissionsOf(store, channel)).map((a) => a.agentId)).toEqual(['bot-b']),
      WAIT
    )
    await daemon.stop()
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

    it('consumes a matching, a mismatched, and an absent-binding decisionId without dispatching', async () => {
      const { daemon, store, channel, dispatch } = await boot([
        { id: 'bot-a', trigger: 'decision' },
        { id: 'bot-b', trigger: 'auto' }
      ])
      for (const frame of [
        relayFrame('bot-a', { decisionId: DECISION }),
        relayFrame('bot-a', { decisionId: 'other' }),
        relayFrame('bot-a'),
        relayFrame('bot-b', { decisionId: DECISION })
      ])
        expect(await (daemon as any).handleRelayIm(frame)).toMatchObject({ accepted: true })
      expect(await rowsOf(store, channel)).toHaveLength(4)
      expect(await admissionsOf(store, channel)).toEqual([])
      expect(dispatch).not.toHaveBeenCalled()
      await daemon.stop()
    })
  })
})
