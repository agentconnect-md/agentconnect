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
import { ASSISTANT_ITEM_TOOLS } from '../src/mcp/ops/assistant-items.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { sessionKey, transcriptChannelKey } from '../src/store/local-store.js'
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
const DELEGATED = '), as a background task:'

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

/** Start a task from the conversation, as `sendMessage` `startTask` does, and wait until its turn runs. */
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
const ended = (key: string) =>
  `[task ended] Task ${key} stopped before finishing (cancel). Anything it sent before this is all it reported. To give it more work in the same context, call sendMessage with {"action":"messageTask","taskId":"${key}","message":"..."}.\n\n${REPORT_ANSWER_LANGUAGE}`

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
      const stoppedBy: [string, string][] = [
        [byTool, 'Alice'],
        [byConsole, 'Grace']
      ]
      for (const [key, who] of stoppedBy) {
        await vi.waitFor(async () => expect(await stateOf(h, key)).toBe('failed'), WAIT)
        await vi.waitFor(() => expect(h.reports()).toContain(ended(key)), WAIT)
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
      await vi.waitFor(() => expect(h.reports()).toContain(ended(onReport)), WAIT)
      await idle()
      expect(await stop(h, dm, noTurn)).toMatchObject({ result: 'stopped', taskId: noTurn })
      await vi.waitFor(() => expect(h.reports()).toContain(ended(noTurn)), WAIT)
      await idle()

      // On a turn another agent's reply started.
      const onPeer = await delegate(h, dm, 'check the release')
      h.rt.behavior.plain = 'hang'
      await liveTurn(h, dm, { source: 'agent', sender: { id: 'peer-agent', isBot: true }, text: 'the peer’s answer' })
      expect(await stop(h, dm, onPeer)).toMatchObject({ result: 'stopped', taskId: onPeer })
      h.rt.behavior.plain = 'answer'
      for (const [sessionId, release] of h.rt.hung) if (!h.rt.subPrompts.includes(sessionId)) release('end_turn')
      await vi.waitFor(() => expect(h.reports()).toContain(ended(onPeer)), WAIT)
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

  it('refuses the session after `!new`, another agent, a patrol and an approved proposal, in the unknown-id words', async () => {
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
      // A patrol and an approved proposal this session started keep their own stop paths.
      for (const thread of ['subsession:patrol-p-1', 'subsession:task-t-1']) {
        const key = sessionKey('slack', DM, thread, AGENT, h.scope)
        const row = { agentId: AGENT, childSessionKey: key, parentSessionId: owner, parentSessionKey: dm.key }
        if (thread.includes('patrol'))
          await h.d.store.assistantSubsessions.openPatrol(row, { startedSince: 0, staleBefore: 0 })
        else await h.d.store.assistantSubsessions.open(row)
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
      // A patrol runs only the tools it was offered, and it is offered none of this.
      await expect(
        executeTool({ ...dm.ctx, thread: 'subsession:patrol-d-1' }, 'stopTask', { taskId: child }, h.deps)
      ).rejects.toThrow('stopTask is not available in a read-only patrol')
      expect(await stateOf(h, child)).toBe('open')
    } finally {
      await h.close()
    }
  })
})

describe('who is offered stopTask', () => {
  it('is every session that can start a task, of every agent, and never a task, patrol or approved proposal', async () => {
    const h = await boot()
    try {
      const tool = (agent: Record<string, unknown>, session: Record<string, unknown>) => {
        const [server] = h.d.sessions.deps.mcpServersFor({
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
        const token = server!.env.find((entry: { name: string }) => entry.name === 'AC_MCP_TOKEN')!.value
        return h.d.mcp.sessions.get(token)!.tools.find((t: { name: string }) => t.name === 'stopTask')
      }
      const offered = (agent: Record<string, unknown>, session: Record<string, unknown>): boolean =>
        tool(agent, session) !== undefined
      const on = { assistantMode: ON }
      expect(tool(on, {})).toEqual({
        name: 'stopTask',
        description:
          'Stop a background task this session started with sendMessage startTask, when it is no longer needed: the ' +
          'plan changed, a task it depended on failed, or its result is not wanted any more. What it already did is ' +
          'not undone, and a process its runtime started in the background (a build, a dev server) may keep running; ' +
          'the result says so. When it is not clear which task a person means, ask them before stopping one.',
        inputSchema: {
          type: 'object',
          properties: {
            taskId: {
              type: 'string',
              minLength: 1,
              description: 'The `taskId` startTask returned, or one listed as running in your reminders.'
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
      // Never a task, a patrol or an approved proposal; a hook run or a scheduled run may own tasks too.
      for (const thread of ['subsession:d-1', 'subsession:patrol-d-1', 'subsession:task-d-1'])
        expect(offered(on, { thread })).toBe(false)
      expect(offered(on, { platform: 'hook', channel: 'hook:h-1', thread: 'd-1', integrationId: undefined })).toBe(true)
      expect(offered(on, { channel: 'cron:c-1', thread: 'cron:c-1:t-1', integrationId: undefined })).toBe(true)
      // An agent outside assistant mode is offered the same tool.
      expect(tool({}, {})).toEqual(tool(on, {}))
      expect(tool({ assistantMode: { enabled: false } }, {})).toEqual(tool(on, {}))
      expect(offered({}, { thread: 'subsession:d-1' })).toBe(false)
    } finally {
      await h.close()
    }
  })

  it('offers the same tools in or out of assistant mode, but for the item tools and one sentence of remind', async () => {
    const h = await boot()
    try {
      const toolsOf = (agent: Record<string, unknown>, thread: string) => {
        const [server] = h.d.sessions.deps.mcpServersFor({
          agent: { ...h.d.agents.get(AGENT), assistantMode: undefined, ...agent },
          platform: 'slack',
          channel: DM,
          thread,
          deliveryThread: '1700000000.000100',
          integrationId: INT,
          isDm: true,
          sessionKey: `slack:${DM}:${thread}:${AGENT}`
        })
        const token = server!.env.find((entry: { name: string }) => entry.name === 'AC_MCP_TOKEN')!.value
        return h.d.mcp.sessions.get(token)!.tools as { name: string; description: string }[]
      }
      const items = new Set(ASSISTANT_ITEM_TOOLS.map((t) => t.name))
      for (const thread of ['append:1', 'subsession:d-1']) {
        const on = toolsOf({ assistantMode: ON }, thread)
        const off = toolsOf({}, thread)
        expect(toolsOf({ assistantMode: { enabled: false } }, thread)).toEqual(off)
        expect(on.filter((t) => items.has(t.name)).map((t) => t.name)).toEqual(ASSISTANT_ITEM_TOOLS.map((t) => t.name))
        expect(off.filter((t) => items.has(t.name))).toEqual([])
        const shared = on.filter((t) => !items.has(t.name))
        expect(shared.map((t) => t.name)).toEqual(off.map((t) => t.name))
        const differing = shared.filter((t, i) => JSON.stringify(t) !== JSON.stringify(off[i]))
        // A sub-session has no reminders, so nothing but the item tools sets it apart.
        expect(differing.map((t) => t.name)).toEqual(thread === 'append:1' ? ['remind'] : [])
        for (const remind of differing)
          expect(remind.description.replace(/; for something to be checked on at a time, take an item[^.]*/, '')).toBe(
            off.find((t) => t.name === 'remind')!.description
          )
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
  const resultFor = async (thread: string, kind?: 'patrol') => {
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
      assistantSubsessions: {
        actor: () => ({ userId: 'u-1' }),
        sessionIdOf: async () => 'sid-owner',
        find: async () => row as never,
        stopSession: async () => true
      }
    }
    return (await executeTool(ctx, 'stopTask', { taskId: childSessionKey }, deps as never)) as any
  }

  it('names messageTask for a task, and refuses an approved proposal or a patrol as an unknown id', async () => {
    expect((await resultFor('subsession:d-1')).note).toContain('message it with messageTask')
    expect(await resultFor('subsession:task-d-1')).toEqual(NOT_OWNED)
    expect(await resultFor('subsession:patrol-d-1', 'patrol')).toEqual(NOT_OWNED)
  })
})
