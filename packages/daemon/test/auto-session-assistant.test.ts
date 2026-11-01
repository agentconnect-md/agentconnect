// auto-session-mode.md §3.4: assistant mode's places run through the coordinator, which takes their reports.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { coordinatorSessionTools } from '../src/auto-session/coordinator-prompt.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import type { SessionContext } from '../src/mcp/ops/context.js'
import { executeTool } from '../src/mcp/ops.js'
import { ASSISTANT_REMINDER_TOOLS } from '../src/mcp/ops/assistant-reminders.js'
import { isCoordinatorCoordinate } from '../src/session/append-coordinate.js'
import { checkCoordinate } from '../src/session/subsession-coordinate.js'
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
  const root = mkdtempSync(join(tmpdir(), 'ac-auto-assistant-'))
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
      assistantMode: { enabled: true },
      integrations: [
        {
          id: 'int-bot-a',
          platform: 'slack',
          // The room as the control plane sends an assistant-mode place to a daemon that reads `auto`; DMs are unlisted.
          core: {
            bindRules: [{ match: { kind: 'dm' } }, { match: { kind: 'mention' } }],
            sessionModes: [{ channel: 'C1', mode: 'auto' }]
          },
          config: { botToken: 'xoxb', appToken: 'xapp', botUserId: 'U_FAKE_BOT' }
        }
      ],
      output: { mode: 'low' }
    })
  )
  return root
}

async function boot(prompt: (blocks: { type: string; text?: string }[]) => Promise<void> = async () => {}) {
  const host = {
    __started: true,
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => 'acp-coordinator'),
    hasSession: () => true,
    prompt: vi.fn(async (_sid: string, blocks: { type: string; text?: string }[]) => {
      await prompt(blocks)
      return { stopReason: 'end_turn' }
    }),
    cancel: vi.fn(),
    stop: vi.fn()
  }
  const daemon = new Daemon({
    root: scaffold(),
    hostFactory: () => host as never,
    slackAppFactory: fakeSlackAppFactory()
  })
  await daemon.start()
  const d = daemon as any
  // The harness has no real platform audience to bind a session to.
  d.bindSessionSource = async () => 'unchanged'
  const scope: string = d.transportScopeForIntegrationIds(['int-bot-a'])
  const route = async (msg: NormalizedMessage) => await d.onInboundOutcome(msg, ['int-bot-a'])
  return { daemon, d, scope, route }
}

describe('assistant mode under auto (auto-session-mode.md §3.4)', () => {
  it('runs a listed place and a DM it has not listed through the coordinator, retiring the old append session', async () => {
    const { daemon, d, scope, route } = await boot()
    const calls: NormalizedMessage[] = []
    d.dispatch = vi.fn(async (_agentId: string, msg: NormalizedMessage) => {
      calls.push(msg)
      return null
    })
    // The place's one long session from before auto.
    const old = await d.store.resolveAppendCoordinate('bot-a', 'C1', scope, 1)
    const oldKey = sessionKey('slack', 'C1', old, 'bot-a', scope)
    await d.store.upsertSession({
      key: oldKey,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: old,
      transportScope: scope,
      acpSessionId: 'acp-old',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    })

    // A root message mentions nobody, and still reaches the coordinator.
    await route(slack('2.1'))
    await route(slack('3.1', { msgId: 'slack:D1:3.1', channel: 'D1', isDm: true }))
    expect(calls.map((msg) => isCoordinatorCoordinate(msg.sessionThread))).toEqual([true, true])
    // The append session takes no new messages and ages out with retention; its context is not carried over.
    expect(await d.store.currentAppendCoordinate('bot-a', 'C1', scope)).toBe(calls[0]!.sessionThread)
    expect(await d.keepsAppendSession(await d.store.getSession(oldKey))).toBe(false)
    // A place nobody spoke in yet opens on its coordinator, as a report that starts it would.
    const opened = await d.checkParent(
      'bot-a',
      { platform: 'slack', channel: 'D2', transportScope: scope },
      {
        open: true,
        isDm: true
      }
    )
    expect(opened).toMatchObject({ opening: true })
    expect(isCoordinatorCoordinate(opened.thread)).toBe(true)
    await daemon.stop()
  })

  // A batch can start with a report; a place tool acts for the person whose message it names, never for the turn's first entry.
  it('binds a place tool to the person’s message it names, in a batch that starts with a report', async () => {
    const live: { d?: any; ctx?: SessionContext } = {}
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const results: unknown[] = []
    let turns = 0
    const at = new Date(Date.now() + 86_400_000).toISOString()
    const { daemon, d, scope, route } = await boot(async (blocks) => {
      turns += 1
      if (turns === 1) return await held
      const prompt = blocks.map((block) => block.text ?? '').join('\n')
      const report = /<report id="(msg-[^"]+)">/.exec(prompt)![1]!
      const deps = { ...live.d.mcp.deps, canRun: () => true }
      const call = (name: string, args: Record<string, unknown>) =>
        executeTool(live.ctx!, name, args, deps).catch((err: Error) => err.message)
      results.push(await call('remind', { messageId: report, message: 'standup', at }))
      results.push(await call('remind', { message: 'standup', at }))
      results.push(await call('remind', { messageId: 'msg-3.1', message: 'standup', at }))
    })
    live.d = d
    const coordinator = await d.store.resolveAppendCoordinate('bot-a', 'C1', scope, 1, 'coordinator')
    const coordinatorKey = sessionKey('slack', 'C1', coordinator, 'bot-a', scope)
    await d.store.upsertSession({
      key: coordinatorKey,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: coordinator,
      transportScope: scope,
      acpSessionId: 'acp-coordinator',
      sessionId: 'sid-coordinator',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    live.ctx = {
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: coordinator,
      transportScope: scope,
      integrationId: 'int-bot-a',
      isDm: false,
      tools: coordinatorSessionTools(ASSISTANT_REMINDER_TOOLS)
    } as SessionContext
    expect(live.ctx.tools.find((tool) => tool.name === 'remind')!.inputSchema).toMatchObject({
      required: expect.arrayContaining(['messageId'])
    })
    vi.spyOn(d, 'gatewayForIntegration').mockReturnValue({ postMessage: vi.fn(async () => {}) })
    vi.spyOn(d, 'replyConnFor').mockReturnValue({ react: vi.fn(async () => {}), setStatus: vi.fn(async () => true) })

    await route(slack('1.1', { sender: { id: 'U1', isBot: false } }))
    await vi.waitFor(() => expect(turns).toBe(1), WAIT)
    await d.collab.deliverDaemonReport({
      agentId: 'bot-a',
      caller: { platform: 'slack', channel: 'C1', thread: checkCoordinate('p-1'), transportScope: scope },
      place: { platform: 'slack', channel: 'C1', transportScope: scope },
      parentSessionId: 'sid-coordinator',
      text: '[follow-up] nothing changed',
      reportId: 'follow-up:p-1'
    })
    await route(slack('3.1', { sender: { id: 'U3', isBot: false }, text: 'remind me about standup tomorrow' }))
    release()
    await vi.waitFor(() => expect(results).toHaveLength(3), WAIT)
    await vi.waitFor(() => expect(d.pending.size + d.inflight.size).toBe(0), WAIT)
    expect(results[0]).toMatch(/is a report/)
    expect(results[1]).toMatch(/needs messageId/)
    expect(results[2]).toMatchObject({ note: expect.stringContaining('Set.') })
    const [reminder] = await d.store.assistantReminders.listOpen('bot-a', {
      platform: 'slack',
      channel: 'C1',
      transportScope: scope
    })
    // Asked by the person whose message it named, and posted in that message's thread.
    expect(reminder).toMatchObject({ requesterId: 'U3', targetThread: '3.1' })
    await daemon.stop()
  })

  // assistant-mode.md §5.18 ④: a report with no turn metadata of its own rides in the next batch beside the messages.
  it('folds the reports queued behind a turn into the next batch with the channel messages, in arrival order', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const prompts: string[] = []
    const { daemon, d, scope, route } = await boot(async (blocks) => {
      prompts.push(blocks.map((block) => block.text ?? '').join('\n'))
      if (prompts.length === 1) await held
    })
    const coordinator = await d.store.resolveAppendCoordinate('bot-a', 'C1', scope, 1, 'coordinator')
    await d.store.upsertSession({
      key: sessionKey('slack', 'C1', coordinator, 'bot-a', scope),
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: coordinator,
      transportScope: scope,
      acpSessionId: 'acp-coordinator',
      sessionId: 'sid-coordinator',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    vi.spyOn(d, 'replyConnFor').mockReturnValue({ react: vi.fn(async () => {}), setStatus: vi.fn(async () => true) })
    const report = async (id: string, text: string) =>
      await d.collab.deliverDaemonReport({
        agentId: 'bot-a',
        caller: { platform: 'slack', channel: 'C1', thread: checkCoordinate(id), transportScope: scope },
        place: { platform: 'slack', channel: 'C1', transportScope: scope },
        parentSessionId: 'sid-coordinator',
        text,
        reportId: `follow-up:${id}`
      })
    await route(slack('1.1', { text: 'first' }))
    await vi.waitFor(() => expect(prompts).toHaveLength(1), WAIT)
    await report('p-1', '[follow-up] first report')
    await report('p-2', '[follow-up] second report')
    await route(slack('3.1', { text: 'after the reports' }))
    await vi.waitFor(() => expect([...d.serialQueue.values()][0]).toHaveLength(3), WAIT)
    release()
    await vi.waitFor(() => expect(prompts).toHaveLength(2), WAIT)
    await vi.waitFor(() => expect(d.pending.size + d.inflight.size).toBe(0), WAIT)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('[One new channel-root message and 2 reports in C1]')
    const at = (text: string) => prompts[1]!.indexOf(text)
    expect(at('first report')).toBeGreaterThan(-1)
    expect(at('first report')).toBeLessThan(at('second report'))
    expect(at('second report')).toBeLessThan(at('after the reports'))
    await daemon.stop()
  })

  it('takes a follow-up’s report into the coordinator, which answers it in the place', async () => {
    const live: { d?: any; ctx?: SessionContext } = {}
    const seen: string[] = []
    const outcomes: unknown[] = []
    const { daemon, d, scope } = await boot(async (blocks) => {
      const prompt = blocks.map((block) => block.text ?? '').join('\n')
      seen.push(prompt)
      const id = /<report id="(msg-[^"]+)">/.exec(prompt)?.[1]
      if (!id) return
      outcomes.push(
        await live.d.coordinators
          .decide(live.ctx, { action: 'delegateTask', messageId: id, title: 'PR' })
          .catch((err: Error) => err.message)
      )
      outcomes.push(
        await live.d.coordinators.decide(live.ctx, {
          action: 'replyToMessage',
          messageId: id,
          message: 'The PR merged.'
        })
      )
    })
    live.d = d
    const coordinator = await d.store.resolveAppendCoordinate('bot-a', 'C1', scope, 1, 'coordinator')
    const coordinatorKey = sessionKey('slack', 'C1', coordinator, 'bot-a', scope)
    await d.store.upsertSession({
      key: coordinatorKey,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: coordinator,
      transportScope: scope,
      acpSessionId: 'acp-coordinator',
      sessionId: 'sid-coordinator',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    live.ctx = {
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: coordinator,
      transportScope: scope,
      isDm: false,
      tools: coordinatorSessionTools([])
    } as SessionContext
    const posts: { thread?: string; text: string }[] = []
    vi.spyOn(d, 'gatewayForIntegration').mockReturnValue({
      postMessage: vi.fn(async (_channel: string, text: string, thread?: string) => {
        posts.push({ thread, text })
      })
    })
    const react = vi.fn(async () => {})
    vi.spyOn(d, 'replyConnFor').mockReturnValue({ react, setStatus: vi.fn(async () => true) })

    const result = await d.collab.deliverDaemonReport({
      agentId: 'bot-a',
      caller: { platform: 'slack', channel: 'C1', thread: checkCoordinate('p-1'), transportScope: scope },
      place: { platform: 'slack', channel: 'C1', transportScope: scope },
      parentSessionId: 'sid-coordinator',
      text: '[follow-up] the PR merged',
      reportId: 'follow-up:p-1'
    })
    expect(result).toEqual({ admitted: true })
    await vi.waitFor(() => expect(posts).toHaveLength(1), WAIT)
    await vi.waitFor(() => expect(d.pending.size + d.inflight.size).toBe(0), WAIT)
    expect(seen[0]).toContain('[One report in C1]')
    expect(seen[0]).toContain('[follow-up] the PR merged')
    expect(outcomes[0]).toMatch(/is a report, not a channel message/)
    expect(outcomes[1]).toMatchObject({ ok: true, posted: { at: 'root' } })
    // The answer goes to the place's root, where the report belongs; no 🤔 shows on a report.
    expect(posts).toEqual([{ thread: undefined, text: 'The PR merged.' }])
    expect(react).not.toHaveBeenCalled()
    await daemon.stop()
  })
})
