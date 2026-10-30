// An owning session stops its own task on any of its turns (send-message-guide.md §8.7), through the console's own Stop.
import { SESSION_MESSAGE_HEADER } from '../src/collab/session-message.js'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { REPORT_ANSWER_LANGUAGE } from '../src/collab/coordinator.js'
import { createAssistantActivity } from '../src/cp/assistant-activity.js'
import { Daemon } from '../src/daemon.js'
import { executeTool, type MessageAgentReq, type SessionContext } from '../src/mcp/ops.js'
import { FOLLOW_UP_TOOL } from '../src/mcp/ops/assistant-items.js'
import { LIST_TASKS_TOOL, stopTaskToolsFor, UPDATE_TASK_TOOL } from '../src/mcp/ops/assistant-subsessions.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { sessionKey, transcriptChannelKey } from '../src/store/local-store.js'
import type { TaskReach } from '../src/session/subsession-coordinate.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

/** What the model received for a delivered message: its prompt when the console shows less (§9.5), else its text. */
const modelText = (msg: { text: string; turnBody?: { prompt?: string } }): string => msg.turnBody?.prompt ?? msg.text

const TEST_ORG = '00000000-0000-0000-0000-0000000000a1'
const AGENT = 'bot-a'
const INT = 'int-bot-a'
const DM = 'D0ALICE'
const OTHER_DM = 'D0BOB'
const ON = { enabled: true }
// Only a task's first input carries this in its message header (send-message-guide.md §9.5); its owning session's never does.
const DELEGATED = '), as a delegated task:'

function scaffold(assistantMode: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-stopsub-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: [] } }
    })
  )
  const adir = join(root, 'agents', AGENT)
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: AGENT,
      name: AGENT,
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [
        {
          id: INT,
          platform: 'slack',
          core: {
            bindRules: [{ match: { kind: 'mention' } }],
            sessionModes: [
              { channel: DM, mode: 'append' },
              { channel: OTHER_DM, mode: 'append' }
            ]
          },
          config: { botToken: 'xoxb-test', appToken: 'xapp-test' }
        }
      ],
      output: { mode: 'low' },
      ...(assistantMode ? { assistantMode: ON } : {})
    })
  )
  return root
}

/** A runtime whose prompts follow `sub` for a task and `plain` for everything else; a hung prompt ends on its own cancel. */
function runtimes() {
  const behavior: { sub: 'answer' | 'hang'; plain: 'answer' | 'hang' } = { sub: 'hang', plain: 'hang' }
  const subPrompts: string[] = []
  const plainPrompts: string[] = []
  const hung = new Map<string, (stopReason?: string) => void>()
  const hostFactory = () =>
    ({
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => `acp-${randomUUID()}`),
      prompt: vi.fn(async (sessionId: string, blocks: unknown[]) => {
        const sub = JSON.stringify(blocks).includes(DELEGATED)
        ;(sub ? subPrompts : plainPrompts).push(sessionId)
        if ((sub ? behavior.sub : behavior.plain) === 'answer') return 'end_turn'
        return await new Promise((resolve) => hung.set(sessionId, (stopReason = 'cancelled') => resolve(stopReason)))
      }),
      cancel: vi.fn(async (sessionId: string) => hung.get(sessionId)?.()),
      stop: vi.fn(async () => {})
    }) as any
  return { behavior, subPrompts, plainPrompts, hung, hostFactory }
}

async function boot(opts: { assistantMode?: boolean } = {}) {
  const root = scaffold(opts.assistantMode !== false)
  const rt = runtimes()
  const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: rt.hostFactory })
  await daemon.start()
  const d = daemon as any
  const placement = { agentId: AGENT, daemonId: 'local-daemon', name: AGENT }
  d.cpCollab.replace({
    generation: 0,
    channels: [DM, OTHER_DM].map((channelId) => ({
      orgId: TEST_ORG,
      platform: 'slack',
      channelId,
      agents: [placement]
    })),
    agents: [{ ...placement, orgId: TEST_ORG }]
  })
  const dispatched: { msg: NormalizedMessage; turn: Promise<unknown> }[] = []
  const real = d.dispatch.bind(d)
  d.dispatch = (agentId: string, msg: NormalizedMessage, ...rest: unknown[]) => {
    const turn = real(agentId, msg, ...rest)
    dispatched.push({ msg, turn: turn.catch(() => undefined) })
    return turn
  }
  const scope: string = d.transportScopeForIntegrationIds([INT])
  const deps = { ...d.mcp.deps, canRun: () => true }
  return {
    d,
    rt,
    root,
    scope,
    deps,
    // Each report's body, without the session-message header it reaches the owning session under (send-message-guide.md §9.5).
    reports: () =>
      dispatched
        .filter((c) => c.msg.parentReport === true)
        .map((c) => modelText(c.msg).replace(SESSION_MESSAGE_HEADER, '')),
    async close() {
      // Every live turn ends as answered, and so does whatever was queued behind it.
      rt.behavior.sub = rt.behavior.plain = 'answer'
      for (const release of rt.hung.values()) release('end_turn')
      for (let seen = -1; seen !== dispatched.length;) {
        seen = dispatched.length
        await Promise.all(dispatched.map((c) => c.turn))
      }
      await daemon.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

type Harness = Awaited<ReturnType<typeof boot>>

/** A conversation of the agent: its append session, the tool context its turns get, and a message in it. */
async function conversation(h: Harness, channel: string) {
  const coordinate: string = await h.d.store.resolveAppendCoordinate(AGENT, channel, h.scope, 1)
  const key = sessionKey('slack', channel, coordinate, AGENT, h.scope)
  const ctx: SessionContext = {
    agentId: AGENT,
    platform: 'slack',
    integrationId: INT,
    transportScope: h.scope,
    isDm: true,
    channel,
    thread: coordinate,
    deliveryThread: '1700000000.000100',
    tools: []
  }
  let seq = 100
  const message = (over: Partial<NormalizedMessage> = {}): NormalizedMessage => {
    const ts = `1700000000.000${(seq += 1)}`
    return {
      msgId: `slack:${channel}:${ts}`,
      traceId: randomUUID(),
      source: 'user',
      platform: 'slack',
      channel,
      thread: ts,
      sessionThread: coordinate,
      transportScope: h.scope,
      sender: { id: 'U0ALICE', isBot: false, name: 'Alice' },
      text: 'write the release notes in the background',
      mentionedBots: [],
      isDm: true,
      ...over
    }
  }
  return { coordinate, key, ctx, message }
}

type Conversation = Awaited<ReturnType<typeof conversation>>

/** Start a turn of the conversation, which stays live until it is cancelled. */
async function liveTurn(h: Harness, c: Conversation, over: Partial<NormalizedMessage> = {}) {
  const msg = c.message(over)
  void h.d.dispatch(AGENT, msg, INT)
  await vi.waitFor(() => expect(h.d.activeGateEntries.get(c.key)?.msg.traceId).toBe(msg.traceId), WAIT)
  await vi.waitFor(async () => expect((await h.d.store.getSession(c.key))?.sessionId).toBeTruthy(), WAIT)
}

/** Start a task from the conversation, as `sendMessage` `delegateTask` does, and wait until its turn runs. */
async function delegate(h: Harness, c: Conversation, text = 'write the release notes'): Promise<string> {
  const before = h.rt.subPrompts.length
  const req: MessageAgentReq = {
    callerAgentId: AGENT,
    platform: 'slack',
    callerChannel: c.ctx.channel,
    callerThread: c.coordinate,
    callerTransportScope: h.scope,
    toAgentId: AGENT,
    text,
    channel: c.ctx.channel,
    thread: '1700000000.000100',
    postless: true
  }
  const res = await h.d.collab.messageAgent(req)
  expect(res).toMatchObject({ delivered: true, subsession: true })
  await vi.waitFor(() => expect(h.rt.subPrompts).toHaveLength(before + 1), WAIT)
  return res.targetSession
}

const stop = (h: Harness, c: Conversation, taskId: string) =>
  executeTool(c.ctx, 'stopTask', { taskId }, h.deps) as Promise<any>

const NOT_OWNED = { result: 'refused', reason: 'This session started no task with that id. Nothing was stopped.' }
const ended = (key: string, label = 'write the release notes') =>
  `[task ended] Task "${label}" stopped before finishing (cancel). Anything it sent before this is all it reported. To give it more work in the same context, call sendMessage with {"action":"messageTask","taskId":"${key}","message":"..."}.\n\n${REPORT_ANSWER_LANGUAGE}`

const stateOf = async (h: Harness, key: string) => (await h.d.store.assistantSubsessions.get(AGENT, key))?.state

describe('stopTask in a Slack DM conversation', () => {
  it('interrupts the turn of a task this session started exactly as the console Stop does', async () => {
    const h = await boot()
    try {
      const dm = await conversation(h, DM)
      await liveTurn(h, dm)
      const byTool = await delegate(h, dm)
      const byConsole = await delegate(h, dm, 'update the changelog')
      const cancel = vi.spyOn(h.d.commands, 'cancelSessionByKey')
      const info = vi.spyOn(h.d.log, 'info')

      const result = await stop(h, dm, byTool)
      expect(result).toEqual({
        result: 'stopped',
        taskId: byTool,
        note:
          'Its current turn was interrupted, messages still waiting for it were dropped, and it reports back here that ' +
          'it ended. Nothing it already did is undone, and a process its runtime started in the background (a build, a ' +
          'dev server) may keep running. To give it new work later, message it with messageTask and this taskId.'
      })

      // The console's Stop, through the same seam the control plane's frame reaches.
      const host = h.d.cpClientDepsHost(h.root, 'wss://cp.example.test', () => {})
      const activity = createAssistantActivity({
        store: () => h.d.store,
        agent: (agentId) => h.d.agents.get(agentId),
        now: () => Date.now(),
        decideDraft: async () => {
          throw new Error('not used')
        },
        stopSession: (key, actor) => host.cancelSessionByKey(key, actor)
      })
      const outward = (await h.d.store.getSession(byConsole)).sessionId
      expect(
        await activity.write({
          agentId: AGENT,
          operation: 'stop-subsession',
          sessionId: outward,
          actor: { userId: 'usr-1', name: 'Grace' }
        })
      ).toEqual({ operation: 'stop-subsession', result: 'stopped' })

      // One cancel core for both, each naming who stopped it, and each task reports it ended the same way.
      expect(cancel.mock.calls).toEqual([
        [byTool, { userId: 'U0ALICE', name: 'Alice' }],
        [byConsole, { userId: 'usr-1', name: 'Grace' }]
      ])
      expect(info).toHaveBeenCalledWith(`session ${byTool}: "cancel" by U0ALICE`)
      expect(info).toHaveBeenCalledWith(`session ${byConsole}: "cancel" by usr-1`)
      const stoppedBy: [string, string, string][] = [
        [byTool, 'Alice', 'write the release notes'],
        [byConsole, 'Grace', 'update the changelog']
      ]
      for (const [key, who, label] of stoppedBy) {
        await vi.waitFor(async () => expect(await stateOf(h, key)).toBe('failed'), WAIT)
        await vi.waitFor(() => expect(h.reports()).toContain(ended(key, label)), WAIT)
        const { thread } = await h.d.store.getSession(key)
        const rows = await h.d.store.threadTranscript(transcriptChannelKey(DM, h.scope), thread)
        expect(rows.map((row: { text: string }) => row.text)).toContain(`🛑 Turn cancelled by ${who}.`)
      }
      // Already ended: nothing to stop.
      expect(await stop(h, dm, byTool)).toEqual({
        result: 'not_running',
        taskId: byTool,
        note: 'It has already ended. Nothing was stopped.'
      })
    } finally {
      await h.close()
    }
  })

  it('refuses a task another session started, and an unknown id, in the same words', async () => {
    const h = await boot()
    try {
      const support = await conversation(h, OTHER_DM)
      await liveTurn(h, support, { sender: { id: 'U0BOB', isBot: false, name: 'Bob' } })
      const theirs = await delegate(h, support)
      const dm = await conversation(h, DM)
      await liveTurn(h, dm)
      const cancel = vi.spyOn(h.d.commands, 'cancelSessionByKey')

      const refusal = NOT_OWNED
      expect(await stop(h, dm, theirs)).toEqual(refusal)
      expect(await stop(h, dm, (await h.d.store.getSession(theirs)).sessionId)).toEqual(refusal)
      expect(await stop(h, dm, 'slack:D0ALICE:subsession:unknown:bot-a')).toEqual(refusal)
      // §8.2: a task's ACP runtime id is no handle, even in its owning session.
      expect(await stop(h, support, (await h.d.store.getSession(theirs)).acpSessionId)).toEqual(refusal)
      expect(JSON.stringify(refusal)).not.toContain(OTHER_DM)
      expect(cancel).not.toHaveBeenCalled()
      expect(await stateOf(h, theirs)).toBe('open')
      // Its owning session may.
      expect(await stop(h, support, theirs)).toMatchObject({ result: 'stopped' })
    } finally {
      await h.close()
    }
  })

  it('stops on any turn of its owning session, whoever started it, logged as who asked', async () => {
    const h = await boot()
    try {
      const dm = await conversation(h, DM)
      await liveTurn(h, dm)
      const muted = await delegate(h, dm)
      const onReport = await delegate(h, dm, 'update the changelog')
      const scheduled = await delegate(h, dm, 'sort the backlog')
      const cancel = vi.spyOn(h.d.commands, 'cancelSessionByKey')
      const idle = async () =>
        await vi.waitFor(
          () => expect(h.d.activeGateEntries.has(dm.key) || (h.d.serialQueue.get(dm.key)?.length ?? 0) > 0).toBe(false),
          WAIT
        )

      // A sender `!stop` would turn away no longer gates it: the owning session decides.
      h.d.agents.get(AGENT).integrations[0].core.mutedChannels.push(DM)
      expect(await stop(h, dm, muted)).toMatchObject({ result: 'stopped', taskId: muted })
      h.d.agents.get(AGENT).integrations[0].core.mutedChannels.length = 0

      // The stopped task's report is a turn no person started; it may stop another task, logged as the agent.
      await h.d.interruptTurn(AGENT, dm.key, 'cancel')
      await vi.waitFor(() => expect(h.d.activeGateEntries.get(dm.key)?.msg.parentReport).toBe(true), WAIT)
      expect(await stop(h, dm, onReport)).toMatchObject({ result: 'stopped', taskId: onReport })

      // With no live turn at all; a slot freed above takes this task.
      await vi.waitFor(async () => expect(await stateOf(h, muted)).toBe('failed'), WAIT)
      const noTurn = await delegate(h, dm, 'tidy the docs')
      h.rt.behavior.plain = 'answer'
      for (const [sessionId, release] of h.rt.hung) if (!h.rt.subPrompts.includes(sessionId)) release('end_turn')
      await vi.waitFor(() => expect(h.reports()).toContain(ended(onReport, 'update the changelog')), WAIT)
      await idle()
      expect(await stop(h, dm, noTurn)).toMatchObject({ result: 'stopped', taskId: noTurn })
      await vi.waitFor(() => expect(h.reports()).toContain(ended(noTurn, 'tidy the docs')), WAIT)
      await idle()

      // On a turn another agent's reply started.
      const onPeer = await delegate(h, dm, 'check the release')
      h.rt.behavior.plain = 'hang'
      await liveTurn(h, dm, { source: 'agent', sender: { id: 'peer-agent', isBot: true }, text: 'the peer’s answer' })
      expect(await stop(h, dm, onPeer)).toMatchObject({ result: 'stopped', taskId: onPeer })
      h.rt.behavior.plain = 'answer'
      for (const [sessionId, release] of h.rt.hung) if (!h.rt.subPrompts.includes(sessionId)) release('end_turn')
      await vi.waitFor(() => expect(h.reports()).toContain(ended(onPeer, 'check the release')), WAIT)
      await idle()

      // On a scheduled run in this conversation.
      h.rt.behavior.plain = 'hang'
      await liveTurn(h, dm, { source: 'cron', sender: { id: 'cron:c-1', isBot: false }, trigger: 'cron' })
      expect(await stop(h, dm, scheduled)).toMatchObject({ result: 'stopped', taskId: scheduled })

      const agent = { userId: AGENT, isBot: true }
      expect(cancel.mock.calls.filter(([key]) => key !== dm.key)).toEqual([
        [muted, { userId: 'U0ALICE', name: 'Alice' }],
        [onReport, agent],
        [noTurn, agent],
        [onPeer, agent],
        [scheduled, agent]
      ])
      for (const key of [muted, onReport, noTurn, onPeer, scheduled])
        await vi.waitFor(async () => expect(await stateOf(h, key)).toBe('failed'), WAIT)
    } finally {
      await h.close()
    }
  })

  it('refuses the session after `!new`, another agent, a follow-up with no record and an approved proposal, in the unknown-id words', async () => {
    const h = await boot()
    try {
      const dm = await conversation(h, DM)
      await liveTurn(h, dm)
      const child = await delegate(h, dm)
      const cancel = vi.spyOn(h.d.commands, 'cancelSessionByKey')
      // The same conversation after `!new`: a new session on a new coordinate.
      const next: string = await h.d.store.advanceAppendCoordinate(AGENT, DM, dm.coordinate, h.scope)
      expect(await executeTool({ ...dm.ctx, thread: next }, 'stopTask', { taskId: child }, h.deps)).toEqual(NOT_OWNED)
      // A recreated session on the same key is not the one that started it either.
      const owner = (await h.d.store.getSession(dm.key)).sessionId
      vi.spyOn(h.d.store, 'getSession').mockImplementation(async (...args: unknown[]) => {
        const rec = await (h.d.store.constructor.prototype.getSession as any).apply(h.d.store, args)
        return args[0] === dm.key && rec ? { ...rec, sessionId: `${owner}-replaced` } : rec
      })
      expect(await stop(h, dm, child)).toEqual(NOT_OWNED)
      vi.mocked(h.d.store.getSession).mockRestore()
      // Another agent naming this agent's task.
      expect(await executeTool({ ...dm.ctx, agentId: 'bot-b' }, 'stopTask', { taskId: child }, h.deps)).toEqual(
        NOT_OWNED
      )
      // A follow-up row with no follow-up behind it, and an approved proposal this session started, are not its to stop.
      for (const thread of ['subsession:check-p-1', 'subsession:task-t-1']) {
        const key = sessionKey('slack', DM, thread, AGENT, h.scope)
        const row = { agentId: AGENT, childSessionKey: key, parentSessionId: owner, parentSessionKey: dm.key }
        if (thread.includes('check-')) {
          await h.d.store.assistantSubsessions.openFollowUp(row)
          await h.d.store.assistantSubsessions.checking(AGENT, key)
        } else await h.d.store.assistantSubsessions.open(row)
        expect(await stop(h, dm, key)).toEqual(NOT_OWNED)
        expect(await stateOf(h, key)).toBe('open')
      }
      expect(cancel).not.toHaveBeenCalled()
      expect(await stateOf(h, child)).toBe('open')
    } finally {
      await h.close()
    }
  })

  it('says a task with no turn to interrupt is not running, and that its background work may go on', async () => {
    const h = await boot()
    try {
      const dm = await conversation(h, DM)
      await liveTurn(h, dm)
      // Open, so it has not reported, but no turn of it runs: it waits on a background task it started.
      const idle = sessionKey('slack', DM, 'subsession:idle-1', AGENT, h.scope)
      await h.d.store.assistantSubsessions.open({
        agentId: AGENT,
        childSessionKey: idle,
        parentSessionId: (await h.d.store.getSession(dm.key)).sessionId,
        parentSessionKey: dm.key
      })
      expect(await stop(h, dm, idle)).toEqual({
        result: 'not_running',
        taskId: idle,
        note:
          'No turn of it is running. A background process it started may still be running; that cannot be stopped ' +
          'from here, and the task reports back here when it ends.'
      })
      expect(await stateOf(h, idle)).toBe('open')
    } finally {
      await h.close()
    }
  })

  it('is refused in the task itself and in a sibling task, in the unknown-id words', async () => {
    const h = await boot()
    try {
      const dm = await conversation(h, DM)
      await liveTurn(h, dm)
      const child = await delegate(h, dm)
      const sibling = await delegate(h, dm, 'update the changelog')
      for (const key of [child, sibling]) {
        const { thread } = await h.d.store.getSession(key)
        expect(await executeTool({ ...dm.ctx, thread }, 'stopTask', { taskId: child }, h.deps)).toEqual(NOT_OWNED)
      }
      expect(
        await executeTool({ ...dm.ctx, thread: 'subsession:task-d-1' }, 'stopTask', { taskId: child }, h.deps)
      ).toEqual(NOT_OWNED)
      // A follow-up's check runs only the tools it was offered, and it is offered none of this.
      await expect(
        executeTool({ ...dm.ctx, thread: 'subsession:check-d-1' }, 'stopTask', { taskId: child }, h.deps)
      ).rejects.toThrow('stopTask is not available in a follow-up’s read-only check')
      expect(await stateOf(h, child)).toBe('open')
    } finally {
      await h.close()
    }
  })
})

describe('who is offered stopTask', () => {
  it('is every session that can start a task, a task included, of every agent, and never a follow-up’s check or an approved proposal', async () => {
    const h = await boot()
    try {
      const tool = (agent: Record<string, unknown>, session: Record<string, unknown>) => {
        const [server] = h.d.sessions.deps
          .toolContextFor({
            agent: { id: AGENT, name: AGENT, runtime: 'claude', integrations: [], mcpServers: [], ...agent },
            platform: 'slack',
            channel: DM,
            thread: 'append:1',
            deliveryThread: '1700000000.000100',
            integrationId: INT,
            isDm: true,
            sessionKey: `slack:${DM}:append:1:${AGENT}`,
            ...session
          })
          .mcpServers()
        const token = server!.env.find((entry: { name: string }) => entry.name === 'AC_MCP_TOKEN')!.value
        const tools = h.d.mcp.sessions.get(token)!.tools as { name: string }[]
        const stopTool = tools.find((t) => t.name === 'stopTask')
        // listTasks is offered exactly where stopTask is, right before it.
        expect(tools.find((t) => t.name === 'listTasks')).toEqual(stopTool ? LIST_TASKS_TOOL : undefined)
        if (stopTool) expect(tools[tools.indexOf(stopTool) - 1]!.name).toBe('listTasks')
        // updateTask only inside a task, which keeps its own summary (auto-session-mode.md §5.3).
        const thread = String(session.thread ?? 'append:1')
        const summaryKept = thread.startsWith('subsession:') && !/^subsession:(check|task|research)-/.test(thread)
        expect(tools.find((t) => t.name === 'updateTask')).toEqual(summaryKept ? UPDATE_TASK_TOOL : undefined)
        return stopTool
      }
      const offered = (agent: Record<string, unknown>, session: Record<string, unknown>): boolean =>
        tool(agent, session) !== undefined
      const on = { assistantMode: ON }
      expect(tool(on, {})).toEqual({
        name: 'stopTask',
        description:
          'Stop a task this session delegated with sendMessage delegateTask, or end a follow-up of this conversation, ' +
          'when it is no longer needed: the plan changed, a task it depended on failed, or its result is not wanted any ' +
          'more. Stopping a follow-up ends it: no further checks run. What it already did is not undone, and a process ' +
          'its runtime started in the background (a build, a dev server) may keep running; the result says so. When it ' +
          'is not clear which task a person means, ask them, naming each by its title and never by its taskId, before ' +
          'stopping one.',
        inputSchema: {
          type: 'object',
          properties: {
            taskId: {
              type: 'string',
              minLength: 1,
              description: 'The `taskId` delegateTask or followUp returned, or one listTasks or your reminders show.'
            }
          },
          required: ['taskId'],
          additionalProperties: false
        }
      })
      expect(offered(on, { channel: 'C0SUPPORT', isDm: false })).toBe(true)
      expect(offered(on, { platform: 'webchat', channel: 'conv-1', thread: 'conv-1', integrationId: undefined })).toBe(
        true
      )
      // A task may own tasks of its own (auto-session-mode.md §6.3); a follow-up's check or an approved proposal never.
      expect(offered(on, { thread: 'subsession:d-1' })).toBe(true)
      for (const thread of ['subsession:check-d-1', 'subsession:task-d-1']) expect(offered(on, { thread })).toBe(false)
      // Research keeps no summary and owns no task.
      expect(stopTaskToolsFor({ thread: 'subsession:research-1' })).toEqual([])
      expect(stopTaskToolsFor({ thread: 'subsession:d-1' }).map((t) => t.name)).toEqual([
        'listTasks',
        'stopTask',
        'updateTask'
      ])
      // A hook run or a scheduled run may own tasks too.
      expect(offered(on, { platform: 'hook', channel: 'hook:h-1', thread: 'd-1', integrationId: undefined })).toBe(true)
      expect(offered(on, { channel: 'cron:c-1', thread: 'cron:c-1:t-1', integrationId: undefined })).toBe(true)
      // An agent outside assistant mode is offered the same tool.
      expect(tool({}, {})).toEqual(tool(on, {}))
      expect(tool({ assistantMode: { enabled: false } }, {})).toEqual(tool(on, {}))
      expect(offered({}, { thread: 'subsession:d-1' })).toBe(true)
    } finally {
      await h.close()
    }
  })

  it('offers the same tools in or out of assistant mode, but for followUp and one sentence of remind', async () => {
    const h = await boot()
    try {
      const toolsOf = (agent: Record<string, unknown>, thread: string) => {
        const [server] = h.d.sessions.deps
          .toolContextFor({
            agent: { ...h.d.agents.get(AGENT), assistantMode: undefined, ...agent },
            platform: 'slack',
            channel: DM,
            thread,
            deliveryThread: '1700000000.000100',
            integrationId: INT,
            isDm: true,
            sessionKey: `slack:${DM}:${thread}:${AGENT}`
          })
          .mcpServers()
        const token = server!.env.find((entry: { name: string }) => entry.name === 'AC_MCP_TOKEN')!.value
        return h.d.mcp.sessions.get(token)!.tools as { name: string; description: string }[]
      }
      const items = new Set([FOLLOW_UP_TOOL.name])
      for (const thread of ['append:1', 'subsession:d-1']) {
        const on = toolsOf({ assistantMode: ON }, thread)
        const off = toolsOf({}, thread)
        expect(toolsOf({ assistantMode: { enabled: false } }, thread)).toEqual(off)
        expect(on.filter((t) => items.has(t.name)).map((t) => t.name)).toEqual([FOLLOW_UP_TOOL.name])
        expect(off.filter((t) => items.has(t.name))).toEqual([])
        const shared = on.filter((t) => !items.has(t.name))
        expect(shared.map((t) => t.name)).toEqual(off.map((t) => t.name))
        const differing = shared.filter((t, i) => JSON.stringify(t) !== JSON.stringify(off[i]))
        // A sub-session has no reminders, so nothing but followUp sets it apart.
        expect(differing.map((t) => t.name)).toEqual(thread === 'append:1' ? ['remind'] : [])
        for (const remind of differing)
          expect(
            remind.description.replace(/; for something to be checked on at a time, take a follow-up[^.]*/, '')
          ).toBe(off.find((t) => t.name === 'remind')!.description)
      }
      expect(toolsOf({}, 'append:1').map((t) => t.name)).toContain('stopTask')
    } finally {
      await h.close()
    }
  })

  it('stops a task of an agent outside assistant mode the same way', async () => {
    const h = await boot({ assistantMode: false })
    try {
      const dm = await conversation(h, DM)
      await liveTurn(h, dm)
      const child = await delegate(h, dm)
      expect(await stop(h, dm, child)).toMatchObject({ result: 'stopped', taskId: child })
      await vi.waitFor(async () => expect(await stateOf(h, child)).toBe('failed'), WAIT)
      await vi.waitFor(() => expect(h.reports()).toContain(ended(child)), WAIT)
      expect(await stop(h, dm, 'slack:D0ALICE:subsession:x:bot-a')).toEqual(NOT_OWNED)
    } finally {
      await h.close()
    }
  })

  it('logs a stop as the person behind the live turn, else as the agent itself', async () => {
    const h = await boot()
    try {
      const stopper = (ctx: SessionContext, msg?: Partial<NormalizedMessage>) => {
        const key = sessionKey(ctx.platform, ctx.channel, ctx.thread, AGENT, ctx.transportScope)
        if (msg) h.d.activeGateEntries.set(key, { msg })
        try {
          return h.d.taskStopper(ctx)
        } finally {
          h.d.activeGateEntries.delete(key)
        }
      }
      const webchat: SessionContext = {
        agentId: AGENT,
        platform: 'webchat',
        isDm: false,
        channel: 'conv-1',
        thread: 'conv-1',
        deliveryThread: 'conv-1',
        tools: []
      }
      expect(stopper(webchat, { source: 'user', platform: 'webchat', sender: { id: 'usr-1', isBot: false } })).toEqual({
        userId: 'usr-1'
      })
      const agent = { userId: AGENT, isBot: true }
      expect(stopper(webchat)).toEqual(agent)
      const dm = (await conversation(h, DM)).ctx
      expect(
        stopper(dm, { source: 'cron', platform: 'slack', channel: DM, sender: { id: 'cron:c', isBot: false } })
      ).toEqual(agent)
      expect(
        stopper(dm, { source: 'user', platform: 'slack', channel: DM, sender: { id: 'B0BOT', isBot: true } })
      ).toEqual(agent)
    } finally {
      await h.close()
    }
  })
})

describe('the stop note and authority, from the index row alone', () => {
  const ctx = {
    agentId: AGENT,
    platform: 'slack',
    integrationId: INT,
    isDm: true,
    channel: DM,
    thread: '100.1',
    tools: []
  } as unknown as SessionContext
  const parent = sessionKey('slack', DM, '100.1', AGENT)
  const resultFor = async (thread: string, kind?: 'follow-up', reach?: TaskReach) => {
    const childSessionKey = sessionKey('slack', DM, thread, AGENT)
    const row = {
      agentId: AGENT,
      childSessionKey,
      parentSessionKey: parent,
      parentSessionId: 'sid-owner',
      state: 'open',
      ...(kind ? { kind } : {})
    }
    const deps = {
      ...(reach ? { taskReach: async () => reach } : {}),
      assistantSubsessions: {
        actor: () => ({ userId: 'u-1' }),
        sessionIdOf: async () => 'sid-owner',
        find: async () => row as never,
        stopSession: async () => true
      }
    }
    return (await executeTool(ctx, 'stopTask', { taskId: childSessionKey }, deps as never)) as any
  }

  it('names messageTask for a task, and refuses an approved proposal or a follow-up it does not own as an unknown id', async () => {
    expect((await resultFor('subsession:d-1')).note).toContain('message it with messageTask')
    expect(await resultFor('subsession:task-d-1')).toEqual(NOT_OWNED)
    expect(await resultFor('subsession:check-d-1', 'follow-up')).toEqual(NOT_OWNED)
  })

  it('leaves a delegated task to run to its end where only the coordinator delegates, but stops research (auto-session-mode.md §5.1)', async () => {
    for (const reach of ['assistant', 'none'] as const) {
      const refused = await resultFor('subsession:d-1', undefined, reach)
      expect(refused).toMatchObject({ result: 'refused' })
      expect(refused.reason).toMatch(/^Only an Auto conversation’s coordinator stops a delegated task\./)
      expect(refused.reason).toContain('finishes on its own and reports here')
    }
    expect(await resultFor('subsession:research-d-1', undefined, 'assistant')).toMatchObject({ result: 'stopped' })
    expect(await resultFor('subsession:d-1', undefined, 'delegate')).toMatchObject({ result: 'stopped' })
  })
})

describe('listTasks (send-message-guide.md §8.7)', () => {
  const list = (h: Harness, c: Conversation) => executeTool(c.ctx, 'listTasks', {}, h.deps) as Promise<any>

  it('lists only the tasks this session delegated, with their handle, and nothing to another session', async () => {
    const h = await boot()
    try {
      const dm = await conversation(h, DM)
      await liveTurn(h, dm)
      const first = await delegate(h, dm)
      const second = await delegate(h, dm, 'update the changelog')
      const other = await conversation(h, OTHER_DM)
      await liveTurn(h, other, { sender: { id: 'U0BOB', isBot: false, name: 'Bob' } })
      const theirs = await delegate(h, other, 'sort the backlog')
      await h.d.store.setDisplayName('U0ALICE', 'Alice', Date.now())

      const mine = await list(h, dm)
      expect(mine.tasks.map((t: { taskId?: string }) => t.taskId)).toEqual([second, first])
      for (const task of mine.tasks) {
        expect(task).toMatchObject({
          kind: 'delegated task',
          state: 'running',
          running: true,
          // A background task works for its parent's owner (auto-session-mode.md §6.2).
          owner: 'Alice',
          threaded: false,
          handedBackResult: false
        })
        expect(task.elapsed).toMatch(/min|under a minute/)
        expect(Date.parse(task.startedAt)).not.toBeNaN()
        expect(Date.parse(task.lastActivity)).not.toBeNaN()
        expect(task).not.toHaveProperty('summary')
        expect(task).not.toHaveProperty('threads')
      }
      // Before its first summary, a task shows the message it was opened with (§6.7).
      expect(mine.tasks.map((t: { background?: string }) => t.background)).toEqual([
        'update the changelog',
        'write the release notes'
      ])
      expect(mine.note).toContain('A delegated task or a follow-up has a taskId')
      expect(mine.note).toContain('never shown to people, who know it by its title')
      expect(JSON.stringify(mine)).not.toContain(theirs)
      // An owner with no known name is listed by id.
      expect((await list(h, other)).tasks.map((t: { taskId?: string; owner?: string }) => [t.taskId, t.owner])).toEqual(
        [[theirs, 'U0BOB']]
      )

      // A stopped task stays listed as ended, with no result handed back.
      expect(await stop(h, dm, first)).toMatchObject({ result: 'stopped' })
      await vi.waitFor(async () => expect(await stateOf(h, first)).toBe('failed'), WAIT)
      const after = await list(h, dm)
      expect(after.tasks.map((t: { taskId?: string; state: string }) => [t.taskId, t.state])).toEqual([
        [second, 'running'],
        [first, 'ended']
      ])
      expect(after.tasks[1]).toMatchObject({
        running: false,
        handedBackResult: false,
        lastActivity: expect.any(String)
      })
      expect(after.tasks[1]).not.toHaveProperty('elapsed')
    } finally {
      await h.close()
    }
  })

  it('answers a session with no tasks, and a task itself, with an empty list', async () => {
    const h = await boot({ assistantMode: false })
    try {
      const dm = await conversation(h, DM)
      await liveTurn(h, dm)
      expect(await list(h, dm)).toEqual({ tasks: [], note: 'This session has no tasks.' })
      const child = await delegate(h, dm)
      const { thread } = await h.d.store.getSession(child)
      expect(await list(h, { ...dm, ctx: { ...dm.ctx, thread } })).toEqual({
        tasks: [],
        note: 'This session has no tasks.'
      })
    } finally {
      await h.close()
    }
  })
})

describe('listTasks kinds, states and results, from the index rows alone', () => {
  const ctx = {
    agentId: AGENT,
    platform: 'slack',
    integrationId: INT,
    isDm: true,
    channel: DM,
    thread: '100.1',
    tools: []
  } as unknown as SessionContext
  const parent = sessionKey('slack', DM, '100.1', AGENT)
  const child = (thread: string) => sessionKey('slack', DM, thread, AGENT)
  const NOW = Date.parse('2026-01-01T12:00:00Z')
  const row = (thread: string, state: string, createdAt: number, extra: Record<string, unknown> = {}) => ({
    agentId: AGENT,
    childSessionKey: child(thread),
    parentSessionKey: parent,
    parentSessionId: 'sid-owner',
    state,
    createdAt,
    ...extra
  })
  const rows = [
    row('subsession:d-run', 'open', NOW - 75 * 60_000),
    row('subsession:d-done', 'done', NOW - 3 * 3_600_000, {
      title: 'Ship the release notes',
      summary: 'Release notes for 2.4. Done: drafted and posted. Next: nothing.',
      summaryUpdatedAt: NOW - 2 * 3_600_000,
      background: 'write the release notes for 2.4'
    }),
    row('subsession:d-failed', 'failed', NOW - 4 * 3_600_000, { background: 'bisect the flaky test' }),
    row('subsession:d-reporting', 'reporting', NOW - 5 * 3_600_000),
    row('subsession:task-t-1', 'failed', NOW - 7 * 3_600_000)
  ]
  const deps = (owner: string | undefined, listed = rows, unlisted = 2) => {
    const listForOwner = vi.fn(async () => ({ rows: listed as never[], total: listed.length + unlisted }))
    return {
      listForOwner,
      deps: {
        assistantSubsessions: {
          actor: () => ({ userId: 'u-1' }),
          sessionIdOf: async () => owner,
          find: async () => undefined,
          stopSession: async () => true,
          listForOwner,
          sessionOf: async (key: string) =>
            key === child('subsession:d-run')
              ? {
                  title:
                    '[Message msg-1] From your own session (session sid-owner), as a delegated task:\nfix the flaky test',
                  updatedAt: NOW
                }
              : { title: `Title of ${key.split(':')[3]}`, updatedAt: NOW - 60_000 },
          ownerOf: async (r: { childSessionKey: string }) =>
            r.childSessionKey === child('subsession:d-reporting') ? undefined : 'Alice',
          threadsOf: async (_agentId: string, key: string) =>
            key === child('subsession:d-done')
              ? [
                  {
                    channel: 'C0ENG',
                    thread: '1700000000.000200',
                    link: 'https://example.test/C0ENG/p1700000000000200'
                  }
                ]
              : [],
          now: () => NOW
        }
      }
    }
  }

  it('names each kind and state, gives an approved proposal no handle, and flags a handed-back result', async () => {
    const { deps: d, listForOwner } = deps('sid-owner')
    const res = (await executeTool(ctx, 'listTasks', {}, d as never)) as any
    expect(listForOwner).toHaveBeenCalledWith(AGENT, { sessionId: 'sid-owner', key: parent }, 20, { followUps: false })
    const ended = new Date(NOW - 60_000).toISOString()
    expect(res.tasks).toEqual([
      {
        taskId: child('subsession:d-run'),
        kind: 'delegated task',
        title: 'fix the flaky test',
        state: 'running',
        running: true,
        owner: 'Alice',
        startedAt: new Date(NOW - 75 * 60_000).toISOString(),
        elapsed: '1 h 15 min',
        lastActivity: new Date(NOW).toISOString(),
        threaded: false,
        handedBackResult: false
      },
      {
        taskId: child('subsession:d-done'),
        kind: 'delegated task',
        // The index row's title wins over its session's.
        title: 'Ship the release notes',
        state: 'finished',
        running: false,
        owner: 'Alice',
        startedAt: new Date(NOW - 3 * 3_600_000).toISOString(),
        lastActivity: ended,
        // A summary replaces the opening message (auto-session-mode.md §6.7).
        summary: 'Release notes for 2.4. Done: drafted and posted. Next: nothing.',
        summaryUpdatedAt: new Date(NOW - 2 * 3_600_000).toISOString(),
        threaded: true,
        threads: [
          { channel: 'C0ENG', thread: '1700000000.000200', link: 'https://example.test/C0ENG/p1700000000000200' }
        ],
        handedBackResult: true
      },
      expect.objectContaining({
        taskId: child('subsession:d-failed'),
        state: 'ended',
        running: false,
        background: 'bisect the flaky test',
        handedBackResult: false
      }),
      expect.not.objectContaining({ owner: expect.anything() }),
      {
        kind: 'approved proposal',
        title: 'Title of task-t-1',
        state: 'ended',
        running: false,
        owner: 'Alice',
        startedAt: expect.any(String),
        lastActivity: ended,
        handedBackResult: false
      }
    ])
    expect(res.tasks[3]).toMatchObject({ taskId: child('subsession:d-reporting'), state: 'reporting', running: false })
    expect(res.more).toBe(2)
  })

  it('lists no delegated task where only the coordinator delegates (auto-session-mode.md §5.1)', async () => {
    const { deps: d, listForOwner } = deps('sid-owner')
    await executeTool(ctx, 'listTasks', {}, { ...d, taskReach: async () => 'assistant' } as never)
    expect(listForOwner).toHaveBeenCalledWith(AGENT, { sessionId: 'sid-owner', key: parent }, 20, {
      followUps: false,
      delegatedTasks: false
    })
  })

  it('lists nothing for a session with no outward id, or inside a follow-up’s check or an approved proposal', async () => {
    const empty = { tasks: [], note: 'This session has no tasks.' }
    const none = deps(undefined)
    expect(await executeTool(ctx, 'listTasks', {}, none.deps as never)).toEqual(empty)
    expect(none.listForOwner).not.toHaveBeenCalled()
    for (const thread of ['subsession:check-d-1', 'subsession:task-d-1']) {
      const owned = deps('sid-owner')
      // A follow-up's check runs only the tools it was offered, so the handler is asked as if it had been.
      const inside = { ...ctx, thread, tools: [LIST_TASKS_TOOL] }
      expect(await executeTool(inside, 'listTasks', {}, owned.deps as never)).toEqual(empty)
      expect(owned.listForOwner).not.toHaveBeenCalled()
    }
    expect(await executeTool(ctx, 'listTasks', {}, deps('sid-owner', [], 0).deps as never)).toEqual(empty)
  })
})
