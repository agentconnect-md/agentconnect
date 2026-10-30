// auto-session-mode.md §6.2–§6.5, §6.7: a threaded task's turns, its threads' answers, its summary and its lifetime.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import { Daemon } from '../src/daemon.js'
import { THREADED_TASK_IDLE_CLOSE_MS } from '../src/auto-session/coordinator-sessions.js'
import { SUBSESSION_IDLE_END_MS } from '../src/collab/coordinator.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { stopTaskToolsFor } from '../src/mcp/ops/assistant-subsessions.js'
import { isCoordinatorCoordinate } from '../src/session/append-coordinate.js'
import { buildStandingContext, THREADED_TASK_APPEND } from '../src/session/turn/standing-context.js'
import { sessionKey } from '../src/store/local-store.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

const slack = (ts: string, over: Partial<NormalizedMessage> = {}): NormalizedMessage =>
  ({
    msgId: `slack:C1:${ts}`,
    traceId: `t-${ts}`,
    source: 'user',
    platform: 'slack',
    channel: 'C1',
    thread: ts,
    sender: { id: 'U1', isBot: false },
    text: 'hello',
    mentionedBots: [],
    isDm: false,
    ...over
  }) as NormalizedMessage

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-threaded-task-'))
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
          platform: 'slack',
          core: {
            bindRules: [{ match: { kind: 'auto' }, channel: 'C1' }],
            sessionModes: [{ channel: 'C1', mode: 'auto' }]
          },
          config: { botToken: 'xoxb', appToken: 'xapp' }
        }
      ],
      output: { mode: 'medium' }
    })
  )
  return root
}

type Turn = { text: string; state?: string }

async function boot(clock?: FakeClock) {
  let onUpdate!: (sid: string, update: unknown) => void
  const turns: Turn[] = []
  const host = {
    __started: true,
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => 'acp-task'),
    hasSession: () => true,
    prompt: vi.fn(async (sid: string, blocks: { type: string; text?: string }[]) => {
      // The task's row as its own turn sees it.
      const state = (await d.store.assistantSubsessions.get('bot-a', taskKey))?.state
      turns.push({ text: blocks.map((block) => block.text ?? '').join('\n'), ...(state ? { state } : {}) })
      onUpdate(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `answer ${turns.length}` } })
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
    },
    ...(clock ? { clock } : {})
  })
  await daemon.start()
  const d = daemon as any
  // The harness has no real platform audience to bind a session to.
  d.bindSessionSource = async () => 'unchanged'
  const posts: { channel: string; thread: string | undefined; text: string }[] = []
  vi.spyOn(daemon as never as { replyConnFor: () => unknown }, 'replyConnFor').mockReturnValue({
    botUserId: 'UBOT',
    setStatus: vi.fn(async () => true),
    setTitle: vi.fn(async () => {}),
    getThreadReplies: vi.fn(async () => []),
    postMessage: vi.fn(async (channel: string, text: string, thread?: string) => {
      posts.push({ channel, thread, text })
      return `1700000100.00000${posts.length}`
    }),
    postBlocks: vi.fn(async () => '1700000200.000001'),
    updateMessage: vi.fn(async () => true),
    updateBlocks: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => true),
    postContext: vi.fn(async () => {})
  })
  const scope: string = d.transportScopeForIntegrationIds(['int-bot-a'])
  const coordinator: string = await d.store.resolveAppendCoordinate('bot-a', 'C1', scope, 1, 'coordinator')
  const coordinatorKey = sessionKey('slack', 'C1', coordinator, 'bot-a', scope)
  const taskKey = sessionKey('slack', 'C1', '1.1', 'bot-a', scope)
  const index = d.store.assistantSubsessions
  // A task the coordinator opened for 1.1, holding a second thread it was handed later.
  await index.open({
    agentId: 'bot-a',
    childSessionKey: taskKey,
    parentSessionId: 'sid-coordinator',
    parentSessionKey: coordinatorKey,
    title: 'Flaky test',
    now: 1
  })
  for (const thread of ['1.1', '5.1'])
    await index.attachThread({
      agentId: 'bot-a',
      childSessionKey: taskKey,
      platform: 'slack',
      channel: 'C1',
      transportScope: scope,
      thread,
      sinceRound: 1,
      now: 1
    })
  await index.finish('bot-a', taskKey, 'done')
  const route = async (msg: NormalizedMessage) => await d.onInboundOutcome(msg, ['int-bot-a'])
  const idle = async () => await vi.waitFor(() => expect(d.pending.size + d.inflight.size).toBe(0), WAIT)
  const at = (thread: string) => ({ platform: 'slack', channel: 'C1', transportScope: scope, thread })
  return { daemon, d, index, scope, taskKey, coordinator, coordinatorKey, turns, posts, route, idle, at }
}

describe('a threaded task (auto-session-mode.md §6)', () => {
  it('answers each message in the thread it came from, runs while its turn does, and is reminded of its summary', async () => {
    const { daemon, index, taskKey, turns, posts, route, idle } = await boot()
    await route(slack('5.2', { thread: '5.1', text: 'is it fixed?' }))
    await vi.waitFor(() => expect(turns).toHaveLength(1), WAIT)
    await idle()
    await route(slack('6.1', { thread: '1.1', text: 'and on main?' }))
    await vi.waitFor(() => expect(turns).toHaveLength(2), WAIT)
    await idle()
    expect(turns.map((turn) => turn.state)).toEqual(['open', 'open'])
    expect(turns[0]!.text).toContain('is it fixed?')
    // §6.4: the session stays on the thread it opened on; each answer goes to its message's thread.
    expect(posts.filter((post) => post.text.startsWith('answer '))).toEqual([
      { channel: 'C1', thread: '5.1', text: 'answer 1' },
      { channel: 'C1', thread: '1.1', text: 'answer 2' }
    ])
    // §6.7: a turn after the first with no summary yet is reminded to write one.
    expect(turns[0]!.text).not.toContain('This task has no summary yet')
    expect(turns[1]!.text).toContain('This task has no summary yet')
    expect(await index.get('bot-a', taskKey)).toMatchObject({ state: 'done', round: 3, turnsSinceSummary: 2 })
    await daemon.stop()
  })

  it('is offered updateTask and told it answers in its threads', async () => {
    const thread = { thread: '1.1' }
    expect(stopTaskToolsFor(thread).map((tool) => tool.name)).toEqual(['listTasks', 'stopTask'])
    expect(stopTaskToolsFor({ ...thread, threadedTask: true }).map((tool) => tool.name)).toEqual([
      'listTasks',
      'stopTask',
      'updateTask'
    ])
    const base = {
      agentName: 'bot-a',
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      envSecretNames: [],
      fileSecrets: [],
      memoryIndex: '',
      usesMeta: false
    }
    expect(buildStandingContext({ ...base, ...thread, threadedTask: true }).sessionContext).toContain(
      THREADED_TASK_APPEND
    )
    expect(buildStandingContext({ ...base, ...thread }).sessionContext).not.toContain('# You are a task')
  })

  it('settles a turn left running without reporting it to the coordinator', async () => {
    const clock = new FakeClock(Date.now())
    const { daemon, d, index, taskKey } = await boot(clock)
    await index.resumeThreaded('bot-a', taskKey)
    const reports = vi.spyOn(d.collab, 'deliverDaemonReport')
    await d.collab.endIdleSubsessions(['bot-a'])
    clock.advance(SUBSESSION_IDLE_END_MS)
    await d.collab.endIdleSubsessions(['bot-a'])
    expect(await index.get('bot-a', taskKey)).toMatchObject({ state: 'done' })
    expect(reports).not.toHaveBeenCalled()
    await daemon.stop()
  })

  it('opens background tasks of its own, which report to it, not the coordinator, and open none (§6.3)', async () => {
    const { daemon, d, scope, taskKey, coordinator, coordinatorKey } = await boot()
    const seed = async (key: string, thread: string, id: string) =>
      await d.store.upsertSession({
        key,
        agentId: 'bot-a',
        platform: 'slack',
        channel: 'C1',
        thread,
        transportScope: scope,
        acpSessionId: `acp-${id}`,
        sessionId: `sid-${id}`,
        state: 'idle',
        lastDeliveredTs: null,
        updatedAt: Date.now()
      })
    await seed(coordinatorKey, coordinator, 'coordinator')
    await seed(taskKey, '1.1', 'task')
    const placements = [{ agentId: 'bot-a', daemonId: 'local-daemon', name: 'bot-a' }]
    d.cpCollab.replace({
      generation: 0,
      channels: [{ orgId: 'org-1', platform: 'slack', channelId: 'C1', agents: placements }],
      agents: placements.map((placement) => ({ ...placement, orgId: 'org-1' }))
    })
    const calls: { msg: NormalizedMessage }[] = []
    d.dispatch = vi.fn(
      async (_agentId: string, msg: NormalizedMessage, _i?: string, _w?: unknown, _c?: unknown, o?: any) => {
        calls.push({ msg })
        o?.onAdmission?.({ accepted: true })
        return 'acp-1'
      }
    )
    const delegate = (callerThread: string) =>
      d.collab.messageAgent({
        callerAgentId: 'bot-a',
        platform: 'slack',
        callerChannel: 'C1',
        callerThread,
        callerTransportScope: scope,
        toAgentId: 'bot-a',
        text: 'check the Windows leg',
        title: 'Windows leg',
        channel: 'C1',
        thread: '1.1',
        postless: true
      })
    const opened = await delegate('1.1')
    expect(opened).toMatchObject({ delivered: true, subsession: true })
    const child = await d.store.assistantSubsessions.get('bot-a', opened.targetSession)
    expect(child).toMatchObject({ parentSessionKey: taskKey })
    const childThread = calls[0]!.msg.thread!
    await seed(opened.targetSession, childThread, 'child')
    expect(await delegate(childThread)).toMatchObject({ delivered: false, reason: 'task_nesting' })

    // Its report reaches the task that opened it, though the conversation's place session is the coordinator.
    await d.store.assistantSubsessions.claimReport(
      'bot-a',
      opened.targetSession,
      JSON.stringify({
        text: 'ended',
        hopCount: 0,
        caller: { platform: 'slack', channel: 'C1', thread: childThread, transportScope: scope }
      })
    )
    await d.collab.resendSubsessionReports(['bot-a'])
    const report = calls.at(-1)!.msg
    expect(calls).toHaveLength(2)
    expect(report.sessionThread ?? report.thread).toBe('1.1')
    await daemon.stop()
  })

  it('closes after a week idle, and its threads go back to the coordinator (§6.5)', async () => {
    const clock = new FakeClock(Date.now())
    const { daemon, d, index, scope, taskKey, at } = await boot(clock)
    await d.store.upsertSession({
      key: taskKey,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: '1.1',
      transportScope: scope,
      acpSessionId: 'acp-task',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: clock.now()
    })
    clock.advance(THREADED_TASK_IDLE_CLOSE_MS - 60_000)
    await d.closeIdleThreadedTasks()
    expect(await index.taskOfThread('bot-a', at('5.1'))).toBe(taskKey)
    clock.advance(120_000)
    await d.closeIdleThreadedTasks()
    expect(await index.get('bot-a', taskKey)).toBeUndefined()
    expect(await index.taskOfThread('bot-a', at('5.1'))).toBeUndefined()
    // Its session stays, an ordinary thread session; a reply in either thread reaches the coordinator.
    expect(await d.store.getSession(taskKey)).toBeDefined()
    const calls: NormalizedMessage[] = []
    d.dispatch = vi.fn(async (_agentId: string, msg: NormalizedMessage) => {
      calls.push(msg)
      return null
    })
    await d.onInboundOutcome(slack('5.3', { thread: '5.1' }), ['int-bot-a'])
    await d.onInboundOutcome(slack('1.4', { thread: '1.1' }), ['int-bot-a'])
    expect(calls.map((msg) => isCoordinatorCoordinate(msg.sessionThread))).toEqual([true, true])
    await daemon.stop()
  })
})
