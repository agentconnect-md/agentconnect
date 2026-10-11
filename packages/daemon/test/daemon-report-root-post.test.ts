// A report injected into a parent session carries a synthetic id; where the parent appends, its turn speaks at the root and no Slack call addresses that id.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { sessionKey } from '../src/store/local-store.js'
import { patrolCoordinate, subsessionCoordinate, taskCoordinate } from '../src/session/subsession-coordinate.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

const TEST_ORG = '00000000-0000-0000-0000-0000000000a1'
const SLACK_TS = /^\d+\.\d+$/

/** One assistant-mode Slack agent whose DM D1 and channel C1 append; C2 keeps a session per thread. */
function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-report-root-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: [] } }
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
            bindRules: [{ match: { kind: 'dm' } }, { match: { kind: 'mention' } }],
            sessionModes: [
              { channel: 'D1', mode: 'append' },
              { channel: 'C1', mode: 'append' }
            ]
          },
          config: { botToken: 'xoxb', appToken: 'xapp' }
        }
      ],
      output: { mode: 'medium', showStatusBar: true },
      assistantMode: { enabled: true, responsibleUserId: 'user-1' }
    })
  )
  return root
}

type SlackCall = { op: string; channel: string; thread: string | undefined; text?: string }

async function boot() {
  let onUpdate!: (sid: string, update: unknown) => void
  let turns = 0
  const host = {
    __started: true,
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => `acp-new-${turns}`),
    hasSession: () => true,
    prompt: vi.fn(async (sid: string) => {
      turns++
      onUpdate(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `answer ${turns}` } })
      return { stopReason: 'end_turn' }
    }),
    cancel: vi.fn(),
    stop: vi.fn()
  }
  const daemon = new Daemon({
    root: scaffold(),
    slackAppFactory: fakeSlackAppFactory(),
    hostFactory: (_agent, update) => {
      onUpdate = update
      return host as never
    }
  })
  await daemon.start()
  const calls: SlackCall[] = []
  const record = (op: string, channel: string, thread: string | undefined, text?: string) =>
    calls.push({ op, channel, thread, ...(text !== undefined ? { text } : {}) })
  let posts = 0
  vi.spyOn(daemon as never as { replyConnFor: () => unknown }, 'replyConnFor').mockReturnValue({
    botUserId: 'UBOT',
    setStatus: vi.fn(async (channel: string, thread: string) => (record('setStatus', channel, thread), true)),
    setTitle: vi.fn(async (channel: string, thread: string) => void record('setTitle', channel, thread)),
    getThreadReplies: vi.fn(
      async (channel: string, thread: string) => (record('getThreadReplies', channel, thread), [])
    ),
    postMessage: vi.fn(async (channel: string, text: string, thread?: string) => {
      record('postMessage', channel, thread, text)
      return `1700000100.${String(++posts).padStart(6, '0')}`
    }),
    postBlocks: vi.fn(async (channel: string, _blocks: unknown, text: string, thread?: string) => {
      record('postBlocks', channel, thread, text)
      return `1700000200.${String(++posts).padStart(6, '0')}`
    }),
    updateMessage: vi.fn(async () => true),
    updateBlocks: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => true),
    postContext: vi.fn(async () => {})
  })
  const d = daemon as any
  const scope: string = d.transportScopeForIntegrationIds(['int-bot-a'])
  const placements = [{ agentId: 'bot-a', daemonId: 'local-daemon', name: 'bot-a' }]
  d.cpCollab.replace({
    generation: 0,
    channels: ['D1', 'C1', 'C2'].map((channelId) => ({
      orgId: TEST_ORG,
      platform: 'slack',
      channelId,
      agents: placements
    })),
    agents: placements.map((placement) => ({ ...placement, orgId: TEST_ORG }))
  })
  const answers = () => calls.filter((c) => c.op === 'postMessage' && c.text?.startsWith('answer '))
  /** Every turn has left, so its chrome has settled too. */
  const idle = async () => await vi.waitFor(() => expect(d.pending.size).toBe(0), WAIT)
  return { daemon, d, calls, scope, answers, idle }
}

/** The parent `sid-<channel>`: the conversation's current append session, or a session on a real Slack thread. */
async function seedParent(d: any, scope: string, channel: string, thread?: string) {
  const coordinate: string = thread ?? (await d.store.resolveAppendCoordinate('bot-a', channel, scope, 1))
  const key = sessionKey('slack', channel, coordinate, 'bot-a', scope)
  await d.store.upsertSession({
    key,
    agentId: 'bot-a',
    platform: 'slack',
    channel,
    thread: coordinate,
    transportScope: scope,
    acpSessionId: `acp-${channel}`,
    sessionId: `sid-${channel}`,
    state: 'idle',
    lastDeliveredTs: null,
    updatedAt: Date.now()
  })
  return { key, coordinate }
}

/** A child session in `channel` whose current turn the parent woke, so it may report into it. */
async function replyFromChild(d: any, scope: string, channel: string) {
  const callerThread = '1700000000.000100'
  d.activeTurnCallMeta.set(sessionKey('slack', channel, callerThread, 'bot-a', scope), {
    callFrom: 'bot-a',
    hopCount: 1,
    deliveryId: `d-${channel}`,
    originSessionId: `sid-${channel}`
  })
  return await d.collab.replyToSession({
    callerAgentId: 'bot-a',
    platform: 'slack',
    callerChannel: channel,
    callerThread,
    callerTransportScope: scope,
    sessionId: `sid-${channel}`,
    text: 'result: done'
  })
}

/** Every thread a Slack call addressed is a Slack ts, never a daemon-minted id. */
function expectOnlySlackThreads(calls: SlackCall[]): void {
  const synthetic = calls.filter((c) => c.thread !== undefined && !SLACK_TS.test(c.thread))
  expect(synthetic).toEqual([])
}

/** The parents' turns spoke at the root, with no status, title or history read for a thread that does not exist. */
function expectRootTurns(calls: SlackCall[], answers: SlackCall[]): void {
  expect(answers.map((a) => [a.channel, a.thread])).toEqual([
    ['D1', undefined],
    ['C1', undefined]
  ])
  expectOnlySlackThreads(calls)
  expect(calls.filter((c) => ['setStatus', 'setTitle', 'getThreadReplies'].includes(c.op))).toEqual([])
}

describe('a report into a Slack parent that appends, in a DM and in a channel', () => {
  it('posts the replyToSession turn at the root', async () => {
    const { daemon, d, calls, scope, answers, idle } = await boot()
    for (const channel of ['D1', 'C1']) {
      await seedParent(d, scope, channel)
      expect(await replyFromChild(d, scope, channel)).toMatchObject({ delivered: true })
      await vi.waitFor(() => expect(answers().filter((a) => a.channel === channel)).toHaveLength(1), WAIT)
      await idle()
    }
    expectRootTurns(calls, answers())
    await daemon.stop()
  })

  it.each([
    ['patrol', patrolCoordinate('p-1'), '[patrol] nothing needs you'],
    ['task', taskCoordinate('t-1'), '[task] the proposal ran'],
    ['failure', subsessionCoordinate('s-1'), '[sub-session ended] it stopped before finishing']
  ])('posts a daemon %s report at the root', async (kind, callerThread, text) => {
    const { daemon, d, calls, scope, answers, idle } = await boot()
    for (const channel of ['D1', 'C1']) {
      await seedParent(d, scope, channel)
      const result = await d.collab.deliverDaemonReport({
        agentId: 'bot-a',
        caller: { platform: 'slack', channel, thread: callerThread, transportScope: scope },
        parentSessionId: `sid-${channel}`,
        text,
        reportId: `${kind}:${channel}`
      })
      expect(result).toEqual({ admitted: true })
      await vi.waitFor(() => expect(answers().filter((a) => a.channel === channel)).toHaveLength(1), WAIT)
      await idle()
    }
    expectRootTurns(calls, answers())
    await daemon.stop()
  })
})

describe('a report into a Slack thread session', () => {
  it('answers in that thread, shows its status there and reads that thread', async () => {
    const { daemon, d, calls, scope, answers, idle } = await boot()
    const thread = '1700000000.000200'
    await seedParent(d, scope, 'C2', thread)

    expect(await replyFromChild(d, scope, 'C2')).toMatchObject({ delivered: true })
    await vi.waitFor(() => expect(answers()).toHaveLength(1), WAIT)
    await idle()

    expect(answers()[0]).toMatchObject({ channel: 'C2', thread })
    expectOnlySlackThreads(calls)
    expect(calls.filter((c) => c.op === 'setStatus').map((c) => c.thread)).toContain(thread)
    expect(calls.filter((c) => c.op === 'getThreadReplies').map((c) => c.thread)).toContain(thread)
    await daemon.stop()
  })
})

describe('a self-delegated sub-session', () => {
  it('reads no provider thread for its own coordinate, and its report posts at the DM root', async () => {
    const { daemon, d, calls, scope, answers, idle } = await boot()
    const { coordinate } = await seedParent(d, scope, 'D1')

    const res = await d.collab.messageAgent({
      callerAgentId: 'bot-a',
      platform: 'slack',
      callerChannel: 'D1',
      callerThread: coordinate,
      callerTransportScope: scope,
      toAgentId: 'bot-a',
      text: 'check the build',
      channel: 'D1',
      thread: '1700000000.000100',
      postless: true
    })
    expect(res).toMatchObject({ delivered: true, subsession: true })
    // The sub-session answers headless; the parent hears it and answers at the root.
    await vi.waitFor(() => expect(answers()).toHaveLength(1), WAIT)
    await idle()

    expect(answers()[0]).toMatchObject({ channel: 'D1', thread: undefined })
    expectOnlySlackThreads(calls)
    expect(calls.filter((c) => c.op === 'getThreadReplies')).toEqual([])
    await daemon.stop()
  })
})
