// A report into a Slack parent that appends reaches its runtime after a human turn has moved the parent's read cursor.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import type { SlackAppFactory } from '../src/slack/connection.js'
import { sessionKey } from '../src/store/local-store.js'
import { isAppendCoordinate } from '../src/session/append-coordinate.js'
import { checkCoordinate, subsessionCoordinate, taskCoordinate } from '../src/session/subsession-coordinate.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

type Handler = (args: { event?: unknown; message?: unknown }) => Promise<void>

const TEST_ORG = '00000000-0000-0000-0000-0000000000a1'
const CHANNELS = ['D1', 'C1'] as const
type Channel = (typeof CHANNELS)[number]

/** One assistant-mode Slack agent whose DM D1 and channel C1 append. */
function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-report-parent-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      // An ordinary session delegates only with the Auto switch off (auto-session-mode.md §5.1).
      features: { autoSessionMode: false },
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
            bindRules: [{ match: { kind: 'dm' } }, { match: { kind: 'auto' }, channel: 'C1' }],
            sessionModes: CHANNELS.map((channel) => ({ channel, mode: 'append' }))
          },
          config: { botToken: 'xoxb', appToken: 'xapp' }
        }
      ],
      output: { mode: 'low' },
      assistantMode: { enabled: true }
    })
  )
  return root
}

async function boot() {
  const handlers = new Map<string, Handler>()
  // A workspace id, so a channel session binds its conversation audience.
  const base = fakeSlackAppFactory({ teamId: 'T1' })
  const factory: SlackAppFactory = (opts) => {
    const app = base(opts) as unknown as Record<string, unknown>
    app.message = (fn: Handler) => handlers.set('message', fn)
    app.event = (type: string, fn: Handler) => handlers.set(type, fn)
    return app as unknown as ReturnType<SlackAppFactory>
  }
  let onUpdate!: (sid: string, update: unknown) => void
  /** Every prompt the runtime received; a sub-session answers with its result, any other turn with `answer <n>`. */
  const prompts: string[] = []
  const host = {
    __started: true,
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => `acp-${prompts.length}`),
    hasSession: () => true,
    prompt: vi.fn(async (sid: string, blocks: unknown[]) => {
      const prompt = JSON.stringify(blocks)
      prompts.push(prompt)
      const text = prompt.includes('as a delegated task') ? 'the build is green' : `answer ${prompts.length}`
      onUpdate(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
      return { stopReason: 'end_turn' }
    }),
    cancel: vi.fn(),
    stop: vi.fn()
  }
  const daemon = new Daemon({
    root: scaffold(),
    slackAppFactory: factory,
    hostFactory: (_agent, update) => {
      onUpdate = update
      return host as never
    }
  })
  await daemon.start()
  const posts: { channel: string; text: string; thread?: string }[] = []
  vi.spyOn(daemon as never as { replyConnFor: () => unknown }, 'replyConnFor').mockReturnValue({
    setStatus: vi.fn(async () => true),
    setTitle: vi.fn(async () => {}),
    postMessage: vi.fn(async (channel: string, text: string, thread?: string) => {
      posts.push({ channel, text, thread })
      return `1700000200.${String(posts.length).padStart(6, '0')}`
    }),
    updateMessage: vi.fn(async () => {}),
    postBlocks: vi.fn(async () => '1700000200.900000'),
    updateBlocks: vi.fn(async () => {}),
    postContext: vi.fn(async () => {})
  })
  const d = daemon as any
  const scope: string = d.transportScopeForIntegrationIds(['int-bot-a'])
  // The agent may delegate to itself in both conversations.
  const placements = [{ agentId: 'bot-a', daemonId: 'local-daemon', name: 'bot-a' }]
  d.cpCollab.replace({
    generation: 0,
    channels: CHANNELS.map((channelId) => ({ orgId: TEST_ORG, platform: 'slack', channelId, agents: placements })),
    agents: placements.map((placement) => ({ ...placement, orgId: TEST_ORG }))
  })
  const answers = () => posts.filter((p) => p.text.startsWith('answer '))
  return { daemon, d, handlers, prompts, answers, scope }
}

type Booted = Awaited<ReturnType<typeof boot>>

/** A person speaks in `channel` and the parent answers, so its read cursor is now that Slack ts. */
async function humanTurn(b: Booted, channel: Channel, ts: string) {
  const before = b.answers().length
  await b.handlers.get('message')!({
    message: {
      type: 'message',
      channel,
      channel_type: channel === 'D1' ? 'im' : 'channel',
      user: 'U1',
      text: 'check the build for me',
      ts
    }
  })
  await vi.waitFor(() => expect(b.answers()).toHaveLength(before + 1), WAIT)
  const coordinate: string = await b.d.store.currentAppendCoordinate('bot-a', channel, b.scope)
  expect(isAppendCoordinate(coordinate)).toBe(true)
  const key = sessionKey('slack', channel, coordinate, 'bot-a', b.scope)
  await vi.waitFor(async () => expect((await b.d.store.getSession(key))?.lastDeliveredTs).toBe(ts), WAIT)
  return { key, coordinate, sessionId: (await b.d.store.ensureOutwardSessionId(key, 'bot-a')) as string }
}

/** A sub-session the parent opened on `thread`, carrying the conversation's audience as a spawned one does. */
async function seedSubsession(b: Booted, channel: Channel, parentKey: string, thread: string): Promise<void> {
  const key = sessionKey('slack', channel, thread, 'bot-a', b.scope)
  await b.d.store.upsertSession({
    key,
    agentId: 'bot-a',
    platform: 'slack',
    channel,
    thread,
    transportScope: b.scope,
    acpSessionId: `acp-${thread}`,
    sessionId: `sid-${thread}`,
    state: 'idle',
    lastDeliveredTs: null,
    updatedAt: Date.now()
  })
  const parent = await b.d.store.getSession(parentKey)
  if (parent?.externalProvider)
    await b.d.store.setSessionClassification(key, {
      externalProvider: parent.externalProvider,
      externalRealmKey: parent.externalRealmKey,
      externalResourceKind: parent.externalResourceKind,
      externalResourceKey: parent.externalResourceKey,
      sourceBindingKind: 'external'
    })
}

describe('a report into a Slack parent that appends reaches its runtime', () => {
  it.each(CHANNELS)('from a self-delegated sub-session in %s, through replyToSession', async (channel) => {
    const b = await boot()
    const humanTs = '1700000100.000100'
    const parent = await humanTurn(b, channel, humanTs)

    const res = await b.d.collab.messageAgent({
      callerAgentId: 'bot-a',
      platform: 'slack',
      callerChannel: channel,
      callerThread: parent.coordinate,
      callerTransportScope: b.scope,
      toAgentId: 'bot-a',
      text: 'check the build',
      channel,
      thread: humanTs,
      postless: true
    })
    expect(res).toMatchObject({ delivered: true, subsession: true })

    // The sub-session's result comes back as its report, and the parent's runtime is prompted with it.
    await vi.waitFor(() => expect(b.prompts).toHaveLength(3), WAIT)
    expect(b.prompts[2]).toContain('the build is green')
    await vi.waitFor(() => expect(b.answers()).toHaveLength(2), WAIT)
    expect(b.answers()[1]).toMatchObject({ channel, thread: undefined, text: 'answer 3' })
    // The human's ts stays the cursor: the report is no platform message to read past.
    expect((await b.d.store.getSession(parent.key))?.lastDeliveredTs).toBe(humanTs)
    await b.daemon.stop()
  })

  it.each([
    ['follow-up', checkCoordinate('p-1'), '[follow-up] two new issues need you'],
    ['task', taskCoordinate('t-1'), '[approved proposal] the approved change is merged'],
    ['failure', subsessionCoordinate('s-1'), '[approved proposal ended] it stopped before finishing']
  ])('from a daemon %s report, in D1 and C1', async (kind, callerThread, text) => {
    const b = await boot()
    for (const [i, channel] of CHANNELS.entries()) {
      const parent = await humanTurn(b, channel, `1700000100.00010${i}`)
      await seedSubsession(b, channel, parent.key, callerThread)
      const prompted = b.prompts.length

      const result = await b.d.collab.deliverDaemonReport({
        agentId: 'bot-a',
        caller: { platform: 'slack', channel, thread: callerThread, transportScope: b.scope },
        parentSessionId: parent.sessionId,
        text,
        reportId: `${kind}:${channel}`
      })
      expect(result).toEqual({ admitted: true })

      await vi.waitFor(() => expect(b.prompts).toHaveLength(prompted + 1), WAIT)
      expect(b.prompts[prompted]).toContain(text)
      // Its framing is English, so the parent is told to answer its people in their own language.
      expect(b.prompts[prompted]).toContain(
        'Speak to the people here in the language they use, even when this report is in another.'
      )
    }
    await b.daemon.stop()
  })
})
