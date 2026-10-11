// A main conversation stops a sub-session it opened (assistant-mode.md §1.4, §5.8), through the console's own Stop.
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createAssistantActivity } from '../src/cp/assistant-activity.js'
import { Daemon } from '../src/daemon.js'
import { executeTool, type MessageAgentReq, type SessionContext } from '../src/mcp/ops.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { sessionKey, transcriptChannelKey } from '../src/store/local-store.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

const TEST_ORG = '00000000-0000-0000-0000-0000000000a1'
const AGENT = 'bot-a'
const INT = 'int-bot-a'
const DM = 'D0ALICE'
const OTHER_DM = 'D0BOB'
const ON = { enabled: true, responsibleUserId: 'user-1' }
// Only a sub-session's prompt carries this; the parent's never does.
const DELEGATED = 'From your own main conversation, as a background sub-session'

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

/** A runtime whose prompts follow `sub` for a sub-session and `plain` for everything else; a hung prompt ends on its own cancel. */
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
    reports: () => dispatched.filter((c) => c.msg.parentReport === true).map((c) => c.msg.text),
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

/** Open a sub-session from the conversation, as `sendMessage` to the agent itself does, and wait until its turn runs. */
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

const stop = (h: Harness, c: Conversation, sessionId: string) =>
  executeTool(c.ctx, 'stopSubsession', { sessionId }, h.deps) as Promise<any>

const stateOf = async (h: Harness, key: string) => (await h.d.store.assistantSubsessions.get(AGENT, key))?.state

describe('stopSubsession in a Slack DM main conversation', () => {
  it('interrupts the turn of a sub-session this conversation opened exactly as the console Stop does', async () => {
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
        sessionId: byTool,
        note:
          'Its current turn was interrupted, and it reports back here that it ended. Nothing it already did is ' +
          'undone, and a process its runtime started in the background (a build, a dev server) may keep running.'
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

      // One cancel core for both, each naming who stopped it, and each sub-session reports it ended the same way.
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
        await vi.waitFor(
          () =>
            expect(h.reports()).toContain(
              `[sub-session ended] Sub-session ${key} stopped before finishing (cancel). It sent no result; delegate again if the work is still needed.`
            ),
          WAIT
        )
        const { thread } = await h.d.store.getSession(key)
        const rows = await h.d.store.threadTranscript(transcriptChannelKey(DM, h.scope), thread)
        expect(rows.map((row: { text: string }) => row.text)).toContain(`🛑 Turn cancelled by ${who}.`)
      }
      // Already ended: nothing to stop.
      expect(await stop(h, dm, byTool)).toEqual({
        result: 'not_running',
        sessionId: byTool,
        note: 'It has already ended. Nothing was stopped.'
      })
    } finally {
      await h.close()
    }
  })

  it('refuses a sub-session another conversation opened, and an unknown id, in the same words', async () => {
    const h = await boot()
    try {
      const support = await conversation(h, OTHER_DM)
      await liveTurn(h, support, { sender: { id: 'U0BOB', isBot: false, name: 'Bob' } })
      const theirs = await delegate(h, support)
      const dm = await conversation(h, DM)
      await liveTurn(h, dm)
      const cancel = vi.spyOn(h.d.commands, 'cancelSessionByKey')

      const refusal = {
        result: 'refused',
        reason: 'This conversation opened no sub-session with that id. Nothing was stopped.'
      }
      expect(await stop(h, dm, theirs)).toEqual(refusal)
      expect(await stop(h, dm, (await h.d.store.getSession(theirs)).sessionId)).toEqual(refusal)
      expect(await stop(h, dm, 'slack:D0ALICE:subsession:unknown:bot-a')).toEqual(refusal)
      expect(JSON.stringify(refusal)).not.toContain(OTHER_DM)
      expect(cancel).not.toHaveBeenCalled()
      expect(await stateOf(h, theirs)).toBe('open')
      // Its own conversation may.
      expect(await stop(h, support, theirs)).toMatchObject({ result: 'stopped' })
    } finally {
      await h.close()
    }
  })

  it('refuses on a turn no person started, and for a sender the `!stop` rule turns away', async () => {
    const h = await boot()
    try {
      const dm = await conversation(h, DM)
      await liveTurn(h, dm)
      const child = await delegate(h, dm)
      const cancel = vi.spyOn(h.d.commands, 'cancelSessionByKey')

      // The conversation switched off since its person's turn began: `!stop` would be refused there now.
      h.d.agents.get(AGENT).integrations[0].core.mutedChannels.push(DM)
      expect(await stop(h, dm, child)).toEqual({
        result: 'refused',
        reason:
          'The person whose message started this turn may not stop work in this conversation. Nothing was stopped.'
      })
      h.d.agents.get(AGENT).integrations[0].core.mutedChannels.length = 0

      // No live turn, or one no person started, such as a scheduled run in this conversation.
      await h.d.interruptTurn(AGENT, dm.key, 'cancel')
      await vi.waitFor(() => expect(h.d.activeGateEntries.has(dm.key)).toBe(false), WAIT)
      const notPerson = {
        result: 'refused',
        reason:
          "This turn was not started by a person's message, and only a person here can ask to stop a sub-session. " +
          'Nothing was stopped.'
      }
      expect(await stop(h, dm, child)).toEqual(notPerson)
      await liveTurn(h, dm, { source: 'cron', sender: { id: 'cron:c-1', isBot: false }, trigger: 'cron' })
      expect(await stop(h, dm, child)).toEqual(notPerson)

      expect(cancel).not.toHaveBeenCalled()
      expect(await stateOf(h, child)).toBe('open')
    } finally {
      await h.close()
    }
  })

  it('says a sub-session with no turn to interrupt is not running, and that its background work may go on', async () => {
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
        sessionId: idle,
        note:
          'No turn of it is running. A background process it started may still be running; that cannot be stopped ' +
          'from here, and the sub-session reports back here when it ends.'
      })
      expect(await stateOf(h, idle)).toBe('open')
    } finally {
      await h.close()
    }
  })

  it('still stops its own sub-session after a read only the person here may see', async () => {
    const h = await boot()
    try {
      const dm = await conversation(h, DM)
      await liveTurn(h, dm)
      const child = await delegate(h, dm)
      await h.d.store.assistantWidened.mark(AGENT, dm.key, { platform: 'slack', channel: DM }, Date.now())
      // The mark bars sending to an agent, which a stop is not.
      await expect(executeTool(dm.ctx, 'sendMessage', { toAgent: AGENT, text: 'more work' }, h.deps)).rejects.toThrow(
        'it now writes only here'
      )
      expect(await stop(h, dm, child)).toMatchObject({ result: 'stopped', sessionId: child })
    } finally {
      await h.close()
    }
  })

  it('is refused in a sub-session, which may stop nothing', async () => {
    const h = await boot()
    try {
      const dm = await conversation(h, DM)
      await liveTurn(h, dm)
      const child = await delegate(h, dm)
      const row = await h.d.store.getSession(child)
      const refusal = {
        result: 'refused',
        reason: 'Only the conversation that opened a sub-session can stop it, and this is not one. Nothing was stopped.'
      }
      for (const thread of [row.thread, 'subsession:task-d-1'])
        expect(await executeTool({ ...dm.ctx, thread }, 'stopSubsession', { sessionId: child }, h.deps)).toEqual(
          refusal
        )
      // A patrol runs only the tools it was offered, and it is offered none of this.
      await expect(
        executeTool({ ...dm.ctx, thread: 'subsession:patrol-d-1' }, 'stopSubsession', { sessionId: child }, h.deps)
      ).rejects.toThrow('stopSubsession is not available in a read-only patrol')
      expect(await stateOf(h, child)).toBe('open')
    } finally {
      await h.close()
    }
  })
})

describe('who is offered stopSubsession', () => {
  it('is a place’s main conversation of an assistant-mode agent, on any platform, and nothing else', async () => {
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
        return h.d.mcp.sessions.get(token)!.tools.find((t: { name: string }) => t.name === 'stopSubsession')
      }
      const offered = (agent: Record<string, unknown>, session: Record<string, unknown>): boolean =>
        tool(agent, session) !== undefined
      const on = { assistantMode: ON }
      expect(tool(on, {})).toEqual({
        name: 'stopSubsession',
        description:
          'Stop the current turn of a background sub-session that this conversation opened. What it already did is ' +
          'not undone, and a process its runtime started in the background (a build, a dev server) may keep running; ' +
          'the result says so. Before stopping, confirm with the person in one sentence which sub-session they mean.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: {
              type: 'string',
              minLength: 1,
              description:
                "The sub-session's id: the `childSessionId` `sendMessage` returned when you opened it, or one listed " +
                'as running in your standing summary.'
            }
          },
          required: ['sessionId'],
          additionalProperties: false
        }
      })
      expect(offered(on, { channel: 'C0SUPPORT', isDm: false })).toBe(true)
      expect(offered(on, { platform: 'webchat', channel: 'conv-1', thread: 'conv-1', integrationId: undefined })).toBe(
        true
      )
      // Never a sub-session, a patrol or an approved task, a hook run, or a run with no conversation of its own.
      for (const thread of ['subsession:d-1', 'subsession:patrol-d-1', 'subsession:task-d-1'])
        expect(offered(on, { thread })).toBe(false)
      expect(offered(on, { platform: 'hook', channel: 'hook:h-1', thread: 'd-1', integrationId: undefined })).toBe(
        false
      )
      expect(offered(on, { channel: 'cron:c-1', thread: 'cron:c-1:t-1', integrationId: undefined })).toBe(false)
      // An agent outside assistant mode is offered nothing new.
      expect(offered({}, {})).toBe(false)
      expect(offered({ assistantMode: { enabled: false } }, {})).toBe(false)
    } finally {
      await h.close()
    }
  })

  it('is refused for an agent outside assistant mode even if called', async () => {
    const h = await boot({ assistantMode: false })
    try {
      const dm = await conversation(h, DM)
      expect(await stop(h, dm, 'slack:D0ALICE:subsession:x:bot-a')).toEqual({
        result: 'refused',
        reason: 'Only an agent in assistant mode can stop a sub-session. Nothing was stopped.'
      })
    } finally {
      await h.close()
    }
  })

  it('reads a webchat conversation’s person as its owner, and no turn without a person', async () => {
    const h = await boot()
    try {
      const stopper = (ctx: SessionContext, msg?: Partial<NormalizedMessage>) => {
        const key = sessionKey(ctx.platform, ctx.channel, ctx.thread, AGENT, ctx.transportScope)
        if (msg) h.d.activeGateEntries.set(key, { msg })
        try {
          return h.d.subsessionStopper(ctx)
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
      // The Control Plane admits a webchat message only from someone who may continue the conversation.
      expect(stopper(webchat, { source: 'user', platform: 'webchat', sender: { id: 'usr-1', isBot: false } })).toEqual({
        ok: true,
        actor: { userId: 'usr-1' }
      })
      expect(stopper(webchat)).toEqual({ ok: false, reason: 'no-person' })
      const dm = (await conversation(h, DM)).ctx
      expect(
        stopper(dm, { source: 'cron', platform: 'slack', channel: DM, sender: { id: 'cron:c', isBot: false } })
      ).toEqual({ ok: false, reason: 'no-person' })
      expect(
        stopper(dm, { source: 'user', platform: 'slack', channel: DM, sender: { id: 'B0BOT', isBot: true } })
      ).toEqual({ ok: false, reason: 'no-person' })
    } finally {
      await h.close()
    }
  })
})
