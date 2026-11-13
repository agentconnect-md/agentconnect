// auto-session-mode.md §6.10: a WeCom or QQ group in auto, where every message reaches the coordinator and a task answers in the room.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { ApiClient, TokenManager } from '@tencent-connect/qqbot-nodejs/protocol'
import { normalizeQQMessage } from '@agentconnect.md/message'
import { Daemon } from '../src/daemon.js'
import { coordinatorSessionTools } from '../src/auto-session/coordinator-prompt.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import type { SessionContext } from '../src/mcp/ops/context.js'
import { QQConnection } from '../src/platforms/qq/connection.js'
import { WeComConnection } from '../src/platforms/wecom/connection.js'
import { sessionKey, transcriptChannelKey } from '../src/store/local-store.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

const ROOMS = {
  wecom: { channel: 'chat-example-group', config: { botId: 'aibot-example', secret: 'secret-placeholder' } },
  qq: { channel: 'group:chat-example-group', config: { appId: '100', appSecret: 'secret-placeholder' } }
} as const
type Platform = keyof typeof ROOMS

// A group mention as each platform's normalizer hands it over, before canonicalization gives a WeCom one its thread.
const MESSAGES: Record<Platform, (id: string, text: string) => NormalizedMessage> = {
  wecom: (id, text) =>
    ({
      msgId: `wecom:aibot-example:${id}`,
      traceId: `t-${id}`,
      source: 'user',
      platform: 'wecom',
      channel: ROOMS.wecom.channel,
      sender: { id: 'user-alice', isBot: false },
      text: `@bot ${text}`,
      mentionedBots: ['aibot-example'],
      isDm: false
    }) as NormalizedMessage,
  qq: (id, text) =>
    normalizeQQMessage(
      '100',
      {
        rawEventType: 'GROUP_AT_MESSAGE_CREATE',
        kind: 'group',
        groupOpenid: 'chat-example-group',
        senderId: 'user-alice',
        messageId: id,
        content: `<@!100> ${text}`
      },
      `t-${id}`
    ) as NormalizedMessage
}

function scaffold(platform: Platform): string {
  const room = ROOMS[platform]
  const root = mkdtempSync(join(tmpdir(), 'ac-threadless-room-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      features: { autoSessionMode: true },
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
          platform,
          core: {
            bindRules: [{ match: { kind: 'mention' } }],
            sessionModes: [{ channel: room.channel, mode: 'auto' }]
          },
          config: room.config
        }
      ],
      output: { mode: 'low' }
    })
  )
  return root
}

type Step = { call?: () => Record<string, unknown>; text?: string }

let running: Daemon | undefined
afterEach(async () => {
  await running?.stop()
  running = undefined
  vi.restoreAllMocks()
})

/** A daemon whose runtime plays the coordinator by `script` and answers every task turn with its own numbered answer. */
async function boot(platform: Platform, script: Record<string, Step>) {
  vi.spyOn(WeComConnection.prototype, 'start').mockResolvedValue()
  vi.spyOn(QQConnection.prototype, 'start').mockResolvedValue()
  vi.spyOn(TokenManager.prototype, 'getAccessToken').mockResolvedValue('token')
  const request = vi.spyOn(ApiClient.prototype, 'request').mockResolvedValue({ id: 'reply' })
  const live: { d?: any; ctx?: SessionContext; taskId?: string } = {}
  const decided: string[][] = []
  const batches: string[] = []
  const tasks: string[] = []
  let sessions = 0
  let onUpdate: (sessionId: string, update: unknown) => void = () => {}
  const say = (sessionId: string, text: string) =>
    onUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
  const host = {
    __started: true,
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => `acp-${++sessions}`),
    prompt: vi.fn(async (sessionId: string, blocks: { type: string; text?: string }[]) => {
      const prompt = blocks.map((block) => block.text ?? '').join('\n')
      const ids = [...prompt.matchAll(/<message id="(msg-[^"]+)"/g)].map((match) => match[1]!)
      if (ids.length > 0) batches.push(prompt)
      if (ids.length === 0) {
        tasks.push(prompt)
        say(sessionId, `task answer ${tasks.length}`)
        return 'end_turn'
      }
      decided.push(ids)
      for (const id of ids) {
        const step = script[id]
        if (step?.call) {
          const receipt = (await live.d.coordinators.decide(live.ctx, step.call())) as { taskId?: string }
          if (receipt.taskId) live.taskId = receipt.taskId
        }
        if (step?.text) say(sessionId, step.text)
      }
      return 'end_turn'
    }),
    cancel: vi.fn(async () => {}),
    stop: vi.fn()
  }
  const daemon = new Daemon({
    root: scaffold(platform),
    hostFactory: (_agent, update) => {
      onUpdate = update
      return host as never
    },
    slackAppFactory: fakeSlackAppFactory()
  })
  running = daemon
  await daemon.start()
  const d = daemon as any
  live.d = d
  // The harness has no real platform audience to bind a session to.
  d.bindSessionSource = async () => 'unchanged'
  const { channel } = ROOMS[platform]
  const scope: string = d.transportScopeForIntegrationIds(['int-bot-a'])
  const coordinator: string = await d.store.resolveAppendCoordinate('bot-a', channel, scope, 1, 'coordinator')
  live.ctx = {
    agentId: 'bot-a',
    platform,
    channel,
    thread: coordinator,
    transportScope: scope,
    isDm: false,
    tools: coordinatorSessionTools([])
  } as SessionContext
  const keyAt = (thread: string) => sessionKey(platform, channel, thread, 'bot-a', scope)
  const at = (thread: string) => ({ platform, channel, transportScope: scope, thread })
  const idle = async () => await vi.waitFor(() => expect(d.pending.size + d.inflight.size).toBe(0), WAIT)
  return { d, live, decided, batches, tasks, request, scope, coordinator, keyAt, at, idle }
}

/** WeCom's callback handles as the connection holds them for each message it received, and what went out under them. */
function weComReplies(d: any) {
  const conn = d.weComConnByIntegration.get('int-bot-a') as WeComConnection
  const streamed: { reqId: string; content: string; finish: boolean }[] = []
  const proactive: string[] = []
  vi.spyOn(conn, 'respondStream').mockImplementation(async (handle, stream) => {
    streamed.push({ reqId: handle.reqId, content: stream.content, finish: stream.finish })
  })
  vi.spyOn(conn, 'sendMarkdown').mockImplementation(async (_channel, text) => {
    proactive.push(text)
    return [{ text, reqId: `req-proactive-${proactive.length}` }]
  })
  const receive = (msg: NormalizedMessage) =>
    (conn as any).replies.set(msg.msgId, {
      reqId: `req-${msg.msgId.split(':').at(-1)}`,
      generation: 1,
      channel: msg.channel,
      receivedAt: Date.now(),
      claimed: false
    })
  const finals = () => streamed.filter((part) => part.finish).map((part) => [part.reqId, part.content])
  return { receive, finals, proactive }
}

for (const platform of ['wecom', 'qq'] as const) {
  describe(`a ${platform} group in auto (auto-session-mode.md §6.10)`, () => {
    it('brings every message to the coordinator, whose tasks and own reply answer in the room', async () => {
      const booted = await boot(platform, {
        'msg-m1': { call: () => ({ action: 'delegateTask', messageId: 'msg-m1', title: 'Release notes' }) },
        'msg-m2': { call: () => ({ action: 'messageTask', messageId: 'msg-m2', taskId: booted.live.taskId }) },
        'msg-m3': { text: 'Good morning!' }
      })
      const { d, decided, batches, tasks, request, coordinator, keyAt, at, idle } = booted
      const wecom = platform === 'wecom' ? weComReplies(d) : undefined
      const send = async (id: string, text: string) => {
        const msg = MESSAGES[platform](id, text)
        wecom?.receive(msg)
        await d.onInboundOutcome(msg, ['int-bot-a'])
        await vi.waitFor(() => expect(decided.at(-1)).toEqual([`msg-${id}`]), WAIT)
        await idle()
      }

      await send('m1', 'draft the release notes')
      await vi.waitFor(() => expect(tasks).toHaveLength(1), WAIT)
      await idle()
      // The coordinator is a real session now, and its task holds the message's own thread, never the room's root.
      expect(await d.store.getSession(keyAt(coordinator))).toBeDefined()
      const taskKey = keyAt('m1')
      expect(booted.live.taskId).toBe(taskKey)
      expect(await d.store.assistantSubsessions.taskOfThread('bot-a', at('m1'))).toBe(taskKey)
      expect(await d.store.assistantSubsessions.taskOfThread('bot-a', at('group'))).toBeUndefined()

      // A follow-up arrives at the root too: the coordinator hands it over, and the task answers it.
      await send('m2', 'add the migration note')
      await vi.waitFor(() => expect(tasks).toHaveLength(2), WAIT)
      await idle()
      await send('m3', 'morning!')
      expect(decided).toEqual([['msg-m1'], ['msg-m2'], ['msg-m3']])
      // Each one arrived at the root, and the coordinator is told the room has no threads.
      expect(batches.join('\n')).not.toContain(' thread="')
      const instructions: string = d.coordinatorInstructions(d.agents.get('bot-a'), {
        platform,
        channel: ROOMS[platform].channel,
        integrationId: 'int-bot-a'
      })
      expect(instructions).toContain('This conversation has no threads: people cannot answer in a thread')
      expect(d.coordinatorInstructions(d.agents.get('bot-a'), { platform, channel: 'dm:user-alice' })).not.toContain(
        'has no threads'
      )
      expect(tasks[0]).toContain('draft the release notes')
      // The task is told nobody can reply to it directly, so its messages come from the coordinator.
      expect(tasks[0]).toContain('This conversation has no threads, so people cannot reply to you directly')
      expect(tasks[1]).toContain('add the migration note')
      expect(
        (await d.store.assistantSubsessions.threadsOf('bot-a', taskKey)).map((one: { thread: string }) => one.thread)
      ).toEqual(['m1', 'm2'])

      if (wecom) {
        // Each task answer streams under the callback of the message it answers, which the coordinator's turn left unclaimed.
        await vi.waitFor(
          () =>
            expect(wecom.finals()).toEqual([
              ['req-m1', 'task answer 1'],
              ['req-m2', 'task answer 2']
            ]),
          WAIT
        )
        // The coordinator's own reply is a message in the group.
        await vi.waitFor(() => expect(wecom.proactive).toEqual(['Good morning!']), WAIT)
      } else {
        // Each answer is a passive reply to the message it answers, the coordinator's own included.
        const replies = () =>
          request.mock.calls
            .filter((call) => (call[3] as { msg_type?: number })?.msg_type === 2)
            .map((call) => [call[2], (call[3] as any).msg_id, (call[3] as any).markdown.content])
        const path = '/v2/groups/chat-example-group/messages'
        await vi.waitFor(
          () =>
            expect(replies()).toEqual([
              [path, 'm1', 'task answer 1'],
              [path, 'm2', 'task answer 2'],
              [path, 'm3', 'Good morning!']
            ]),
          WAIT
        )
      }
      // The coordinator's own reply is in its record once, as a message of the replied message's internal thread.
      const coordinatorRows = (await d.store.transcriptSince(
        {
          transcriptChannel: transcriptChannelKey(ROOMS[platform].channel, booted.scope),
          coordinate: coordinator,
          sessionKey: keyAt(coordinator),
          agentId: 'bot-a'
        },
        null
      )) as { sender: string; thread: string; text: string }[]
      expect(coordinatorRows.filter((row) => row.sender === 'bot-a').map((row) => [row.thread, row.text])).toEqual([
        ['m3', 'Good morning!']
      ])
    })
  })
}
