// Persistent task messaging (send-message-guide.md §8): messageTask, work rounds, slots, origins and receipts.
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import type { FakeClock } from '@agentconnect.md/connection'
import { Daemon } from '../src/daemon.js'
import { REPORT_ANSWER_LANGUAGE } from '../src/collab/coordinator.js'
import { executeTool } from '../src/mcp/ops.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { sessionKey } from '../src/store/local-store.js'
import { isSubsessionCoordinate, checkCoordinate, taskCoordinate } from '../src/session/subsession-coordinate.js'
import { buildStandingContext, TASK_SUMMARY_REQUEST } from '../src/session/turn/standing-context.js'
import { UPDATE_TASK_TOOL } from '../src/mcp/ops/assistant-subsessions.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

/** What the model received for a delivered message: its prompt when the console shows less (§9.5), else its text. */
const modelText = (msg: { text: string; turnBody?: { prompt?: string } }): string => msg.turnBody?.prompt ?? msg.text

const TEST_ORG = '00000000-0000-0000-0000-0000000000a1'
const ON = { enabled: true }

/** One Slack agent per entry, each appending in `C1`. */
function scaffold(agents: { id: string; assistantMode?: Record<string, unknown> }[]): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-subguard-'))
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
              bindRules: [{ match: { kind: 'mention' } }],
              sessionModes: [{ channel: 'C1', mode: 'append' }]
            },
            config: { botToken: `xoxb-${a.id}`, appToken: `xapp-${a.id}` }
          }
        ],
        output: { mode: 'low' },
        ...(a.assistantMode ? { assistantMode: a.assistantMode } : {})
      })
    )
  }
  return root
}

/** What a runtime does with one prompt: answer, throw, or wait until it is cancelled. */
type PromptBehavior = 'answer' | 'throw' | 'hang' | ((sessionId: string) => Promise<unknown>)

/** A runtime per agent whose task prompts follow `sub`, and every other prompt (the owning session's) answers. */
function runtimes() {
  const behavior: {
    sub: PromptBehavior
    plain: PromptBehavior
    subQueue: PromptBehavior[]
    /** A prompt whose text matches takes this behavior before any other. */
    byText: [RegExp, PromptBehavior][]
  } = {
    sub: 'answer',
    plain: 'answer',
    subQueue: [],
    byText: []
  }
  const subPrompts: string[] = []
  const hosts: any[] = []
  const hostFactory = () => {
    let cancelled: (() => void) | undefined
    const host = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => `acp-${randomUUID()}`),
      prompt: vi.fn(async (sessionId: string, blocks: unknown[]) => {
        // A task's own input names it; the owning session's list of its running tasks does not count.
        const text = JSON.stringify(blocks)
        const sub = /as a delegated task|a new message for this task/.test(text)
        if (sub) subPrompts.push(sessionId)
        const matched = behavior.byText.find(([pattern]) => pattern.test(text))?.[1]
        const act = matched ?? (sub ? (behavior.subQueue.shift() ?? behavior.sub) : behavior.plain)
        if (act === 'throw') throw new Error('the runtime exited')
        if (act === 'hang') return await new Promise((resolve) => (cancelled = () => resolve('cancelled')))
        if (typeof act === 'function') return await act(sessionId)
        return 'end_turn'
      }),
      cancel: vi.fn(async () => cancelled?.()),
      stop: vi.fn(async () => {})
    } as any
    hosts.push(host)
    return host
  }
  return { behavior, subPrompts, hosts, hostFactory }
}

/** How many prompts of the agent's sessions carried `text`. */
const told = (hosts: any[], text: string): number =>
  hosts.flatMap((h) => h.prompt.mock.calls).filter((c: any) => JSON.stringify(c).includes(text)).length

async function boot(root: string, opts: { spy?: boolean; clock?: FakeClock; remotePeers?: string[] } = {}) {
  const rt = runtimes()
  const daemon = new Daemon({
    slackAppFactory: fakeSlackAppFactory(),
    root,
    hostFactory: rt.hostFactory,
    ...(opts.clock ? { clock: opts.clock } : {})
  })
  await daemon.start()
  const d = daemon as any
  const placements = [...d.agents.values()].map((agent: any) => ({
    agentId: agent.id,
    daemonId: 'local-daemon',
    name: agent.name,
    callPolicy: agent.callPolicy,
    allowedCallerAgentIds: agent.allowedCallerAgentIds,
    outboundPolicy: agent.outboundPolicy,
    allowedTargetAgentIds: agent.allowedTargetAgentIds
  }))
  // A peer placed on another daemon, which this one reaches only over the relay.
  for (const agentId of opts.remotePeers ?? [])
    placements.push({
      agentId,
      daemonId: 'other-daemon',
      name: agentId,
      callPolicy: 'all',
      allowedCallerAgentIds: [],
      outboundPolicy: 'all',
      allowedTargetAgentIds: []
    })
  d.cpCollab.replace({
    generation: 0,
    channels: [{ orgId: TEST_ORG, platform: 'slack', channelId: 'C1', agents: placements }],
    agents: placements.map((placement) => ({ ...placement, orgId: TEST_ORG }))
  })
  const dispatched: { agentId: string; msg: NormalizedMessage; callMeta?: any; turn: Promise<unknown> }[] = []
  if (opts.spy === true) {
    // The wake is admitted and never runs, so its task stays open.
    d.dispatch = vi.fn(async (agentId: string, msg: any, _i?: string, _w?: any, callMeta?: any, o?: any) => {
      dispatched.push({ agentId, msg, callMeta, turn: Promise.resolve() })
      o?.onAdmission?.({ accepted: true })
      return 'acp-1'
    })
  } else {
    const real = d.dispatch.bind(d)
    d.dispatch = (
      agentId: string,
      msg: NormalizedMessage,
      integrationId?: string,
      webchat?: any,
      callMeta?: any,
      ...rest: any[]
    ) => {
      const turn = real(agentId, msg, integrationId, webchat, callMeta, ...rest)
      dispatched.push({ agentId, msg, callMeta, turn: turn.catch(() => undefined) })
      return turn
    }
  }
  const reports = () => dispatched.filter((c) => c.msg.parentReport === true)
  /** Every turn dispatched so far, and any it dispatched in turn, has settled. */
  const settled = async () => {
    for (let seen = -1; seen !== dispatched.length;) {
      seen = dispatched.length
      await Promise.all(dispatched.map((c) => c.turn))
    }
  }
  return { daemon, d, rt, dispatched, reports, settled }
}

const scopeOf = (d: any, integrationId: string): string => d.transportScopeForIntegrationIds([integrationId])

/** A caller session in the middle of a turn of its append session; the first in C1 is the parent the tests delegate from. */
async function seedCaller(d: any, agentId = 'bot-a', channel = 'C1') {
  const scope = scopeOf(d, `int-${agentId}`)
  const coordinate = await d.store.resolveAppendCoordinate(agentId, channel, scope, 1)
  const key = sessionKey('slack', channel, coordinate, agentId, scope)
  const primary = agentId === 'bot-a' && channel === 'C1'
  await d.store.upsertSession({
    key,
    agentId,
    platform: 'slack',
    channel,
    thread: coordinate,
    transportScope: scope,
    acpSessionId: primary ? 'acp-parent-1' : `acp-${agentId}-${channel}`,
    sessionId: primary ? 'sid-parent-1' : `sid-${agentId}-${channel}`,
    state: 'idle',
    lastDeliveredTs: null,
    updatedAt: Date.now()
  })
  return { key, scope, coordinate }
}

/** The conversation's `!new`: it rotates onto its next coordinate, whose first message starts the new session. */
async function rotate(d: any, caller: { scope: string; coordinate: string }): Promise<string> {
  const next: string = await d.store.advanceAppendCoordinate('bot-a', 'C1', caller.coordinate, caller.scope)
  await d.store.upsertSession({
    key: sessionKey('slack', 'C1', next, 'bot-a', caller.scope),
    agentId: 'bot-a',
    platform: 'slack',
    channel: 'C1',
    thread: next,
    transportScope: caller.scope,
    acpSessionId: 'acp-current-1',
    sessionId: 'sid-current-1',
    state: 'idle',
    lastDeliveredTs: null,
    updatedAt: Date.now()
  })
  return next
}

/** The caller's MCP context in its append session in C1. */
const toolContext = (caller: { scope: string; coordinate: string }, agentId = 'bot-a') => ({
  agentId,
  platform: 'slack',
  integrationId: `int-${agentId}`,
  transportScope: caller.scope,
  isDm: false,
  channel: 'C1',
  thread: caller.coordinate,
  deliveryThread: '100.1',
  tools: [],
  integrations: [{ id: `int-${agentId}`, platform: 'slack' }]
})

/** `sendMessage` through the daemon's own tool pipeline, as the caller session. */
async function send(
  d: any,
  caller: { scope: string; coordinate: string },
  args: Record<string, unknown>,
  callId?: string
) {
  const deps = { ...d.mcp.deps, canRun: () => true, ...(callId ? { callId } : {}) }
  return (await executeTool(toolContext(caller), 'sendMessage', args, deps)) as any
}

/** The parent's request to continue `sessionId`, as `continueSubsession` takes it. */
const continuation = (caller: { scope: string; coordinate: string }, sessionId: string, text = 'also Windows') => ({
  callerAgentId: 'bot-a',
  platform: 'slack',
  callerTransportScope: caller.scope,
  callerChannel: 'C1',
  callerThread: caller.coordinate,
  sessionId,
  text
})

/** The newest message `key` received, which its `replyToSession` answers (send-message-guide.md §9.4). */
const lastReceived = async (d: any, key: string, kind?: string) => {
  const messages = (await d.store.sessionMessages.listFor(key, 50)) as {
    messageId: string
    kind: string
    createdAt: number
  }[]
  return messages.filter((m) => kind === undefined || m.kind === kind).sort((a, b) => b.createdAt - a.createdAt)[0]!
}

/** The child's own `replyToSession`, answering the newest message its owning session sent it. */
const childReply = async (d: any, caller: { scope: string }, thread: string, text: string) =>
  d.collab.replyToSession({
    callerAgentId: 'bot-a',
    platform: 'slack',
    callerTransportScope: caller.scope,
    callerChannel: 'C1',
    callerThread: thread,
    messageId: (await lastReceived(d, sessionKey('slack', 'C1', thread, 'bot-a', caller.scope))).messageId,
    text
  })

const rowOf = async (d: any, key: string) => await d.store.assistantSubsessions.get('bot-a', key)
const subInputs = <T extends { msg: NormalizedMessage }>(dispatched: T[]): T[] =>
  dispatched.filter((c) => isSubsessionCoordinate(c.msg.thread) && c.msg.parentReport !== true)
const finished = (label: string) => `[task finished] Task "${label}" finished this round of work`

/** Start one task through the tool and let its first round finish. */
async function startAndFinish(h: Awaited<ReturnType<typeof boot>>, caller: { scope: string; coordinate: string }) {
  const created = await send(h.d, caller, {
    action: 'delegateTask',
    title: 'investigate the flaky test',
    message: 'investigate the flaky test'
  })
  expect(created.wake).toMatchObject({ delivered: true, subsession: true })
  const child: string = created.taskId
  await vi.waitFor(async () => expect((await rowOf(h.d, child))?.state).toBe('done'), WAIT)
  await h.settled()
  return child
}

describe('messageTask continues an existing task of this session', () => {
  // A DM's request asked in a thread under a person's message: the task's report replies in that thread, as its acknowledgement did.
  it('reports each round in the thread of the turn that asked for it, and at the top when no turn asked', async () => {
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(h.d)
    const asking = (thread: string) =>
      h.d.activeTurnShare.set(caller.key, {
        platform: 'slack',
        channel: 'C1',
        thread,
        headless: false,
        synthetic: false
      })
    asking('200.1')
    const created = await send(h.d, caller, {
      action: 'delegateTask',
      title: 'investigate the flaky test',
      message: 'investigate the flaky test'
    })
    const child: string = created.taskId
    await vi.waitFor(() => expect(h.reports()).toHaveLength(1), WAIT)
    await h.settled()
    expect(h.reports()[0]!.msg).toMatchObject({ thread: '200.1', sessionThread: caller.coordinate })

    asking('300.1')
    expect(
      (await send(h.d, caller, { action: 'messageTask', taskId: child, message: 'run it again' })).wake
    ).toMatchObject({
      delivered: true
    })
    await vi.waitFor(() => expect(h.reports()).toHaveLength(2), WAIT)
    await h.settled()
    expect(h.reports()[1]!.msg).toMatchObject({ thread: '300.1', sessionThread: caller.coordinate })
    expect(await rowOf(h.d, child)).toMatchObject({ round: 2, replyThread: '300.1' })

    // The daemon's own message (research's second round) has no asking turn, so its report lands at the top.
    h.d.activeTurnShare.delete(caller.key)
    expect((await h.d.collab.continueSubsession(continuation(caller, child, 'once more'))).delivered).toBe(true)
    await vi.waitFor(() => expect(h.reports()).toHaveLength(3), WAIT)
    await h.settled()
    expect(h.reports()[2]!.msg.thread).toBeUndefined()
    expect(h.reports()[2]!.msg.sessionThread).toBe(caller.coordinate)
    await h.daemon.stop()
  })

  it('sends into the same task by its taskId and opens a new round after the first finished', async () => {
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(h.d)
    const child = await startAndFinish(h, caller)
    expect(h.reports().map((c) => modelText(c.msg))).toEqual([
      expect.stringContaining(finished('investigate the flaky test'))
    ])
    const firstSession = (await h.d.store.getSession(child))?.acpSessionId

    const res = await send(h.d, caller, { action: 'messageTask', taskId: child, message: 'also Windows' })
    expect(res).toMatchObject({
      ok: true,
      wake: { delivered: true, targetSession: child, subsession: true },
      taskId: child,
      reply: { requested: true, state: 'awaiting' },
      nextAction: 'finish-turn-and-wait'
    })
    await vi.waitFor(() => expect(h.reports()).toHaveLength(2), WAIT)
    await h.settled()

    // The same child, in its own context: one index row, the same runtime session, and round 2 settled done.
    const inputs = subInputs(h.dispatched)
    expect(inputs).toHaveLength(2)
    expect(sessionKey('slack', 'C1', inputs[1]!.msg.thread!, 'bot-a', inputs[1]!.msg.transportScope)).toBe(child)
    // §9.5: the input shows its message id, its source, and the reply call.
    const messageId = inputs[1]!.callMeta.messageId as string
    expect(modelText(inputs[1]!.msg)).toBe(
      `[Message ${messageId}] From the session that delegated this task (session sid-parent-1), a new message for ` +
        `this task:\nalso Windows\n\n[Send progress, a question, or your result for it with sendMessage ` +
        `{"action":"replyToSession","messageId":"${messageId}","message":"..."}; a reply does not end your work.]`
    )
    expect(inputs[1]!.callMeta).toMatchObject({
      originSessionId: 'sid-parent-1',
      needsReply: true,
      subsessionRound: 2,
      messageKind: 'taskInput'
    })
    // The console shows the body alone; the header's facts and the reply call fold beneath it.
    expect(inputs[1]!.msg.text).toBe('also Windows')
    expect(inputs[1]!.msg.turnBody?.sessionMessage).toMatchObject({
      messageId,
      kind: 'taskInput',
      source: { agentId: 'bot-a', sessionId: 'sid-parent-1' },
      replyRequested: true,
      notes: [expect.stringContaining('"action":"replyToSession"')]
    })
    expect(modelText(inputs[0]!.msg)).toContain(`From your own session (session sid-parent-1), as a delegated task:`)
    expect((await h.d.store.getSession(child))?.acpSessionId).toBe(firstSession)
    expect(await h.d.store.assistantSubsessions.list('bot-a', 10)).toHaveLength(1)
    expect(await rowOf(h.d, child)).toMatchObject({ state: 'done', round: 2 })
    // Each round reports once, under a delivery id of its own.
    const [first, second] = h.reports()
    expect(modelText(second!.msg)).toContain(finished('investigate the flaky test'))
    // A report with no output shows its status alone; the continue call and language note fold beneath it.
    expect(second!.msg.text).toBe(
      `${finished('investigate the flaky test')} without a final output; any reply it sent before this is its result.`
    )
    expect(second!.msg.turnBody?.sessionMessage).toMatchObject({
      kind: 'report',
      notes: [
        expect.stringContaining('"action":"messageTask"'),
        'Speak to the people here in the language they use, even when this report is in another.'
      ]
    })
    expect(second!.callMeta.deliveryId).not.toBe(first!.callMeta.deliveryId)
    await h.daemon.stop()
  })

  it('also takes the child’s outward session id', async () => {
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(h.d)
    const child = await startAndFinish(h, caller)
    const outward = await h.d.store.ensureOutwardSessionId(child, 'bot-a', Date.now())

    const res = await send(h.d, caller, { action: 'messageTask', taskId: outward, message: 'one more' })
    expect(res.wake).toMatchObject({ delivered: true, targetSession: child })
    expect(res.taskId).toBe(child)
    await h.settled()
    // §8.2: never its ACP runtime id.
    const acp: string = (await h.d.store.getSession(child)).acpSessionId
    expect(acp).toBeTruthy()
    const refused = await send(h.d, caller, { action: 'messageTask', taskId: acp, message: 'one more' })
    expect(refused.wake).toMatchObject({ delivered: false, reason: 'task_not_found' })
    await h.daemon.stop()
  })

  it('never creates or retargets for an unknown, unrelated, rotated or purged id', async () => {
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }, { id: 'bot-b' }]))
    const caller = await seedCaller(h.d)
    const child = await startAndFinish(h, caller)
    const before = subInputs(h.dispatched).length
    const refusal = {
      delivered: false,
      reason: 'task_not_found',
      message:
        'This session started no task with that id. Nothing was sent. Pass the `taskId` a delegateTask call in this ' +
        'session returned (listTasks shows them), or use delegateTask to delegate a new task.'
    }
    const unknown = 'slack:C1:subsession:404:bot-a'
    expect(await send(h.d, caller, { action: 'messageTask', taskId: unknown, message: 'm' })).toEqual({
      ok: true,
      wake: { ...refusal, targetSession: unknown }
    })
    // The child itself, a sibling-to-be, or the parent's own session are not a direct child of the caller.
    expect((await h.d.collab.continueSubsession(continuation(caller, caller.key))).reason).toBe('task_not_found')
    const thread = subInputs(h.dispatched)[0]!.msg.thread!
    expect((await h.d.collab.continueSubsession({ ...continuation(caller, child), callerThread: thread })).reason).toBe(
      'task_not_found'
    )
    // Another conversation of the same agent, and the same conversation after `!new`.
    const other = await seedCaller(h.d, 'bot-a', 'C2')
    expect((await h.d.collab.continueSubsession({ ...continuation(other, child), callerChannel: 'C2' })).reason).toBe(
      'task_not_found'
    )
    const next = await rotate(h.d, caller)
    expect((await h.d.collab.continueSubsession({ ...continuation(caller, child), callerThread: next })).reason).toBe(
      'task_not_found'
    )
    // Another agent naming this agent's child.
    const peer = await seedCaller(h.d, 'bot-b')
    expect((await h.d.collab.continueSubsession({ ...continuation(peer, child), callerAgentId: 'bot-b' })).reason).toBe(
      'task_not_found'
    )
    // A purged child is not recreated.
    expect(await h.d.store.deleteSession(child)).toBe(true)
    expect((await h.d.collab.continueSubsession(continuation(caller, child))).reason).toBe('task_not_found')
    expect(subInputs(h.dispatched)).toHaveLength(before)
    expect(await h.d.store.assistantSubsessions.list('bot-a', 10)).toHaveLength(0)
    await h.daemon.stop()
  })

  it('refuses a paused agent truthfully and leaves the retained child idle', async () => {
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(h.d)
    const child = await startAndFinish(h, caller)
    h.d.agents.get('bot-a').pause = true
    const res = await h.d.collab.continueSubsession(continuation(caller, child))
    expect(res).toMatchObject({ delivered: false, targetSession: child, reason: 'paused' })
    expect(await rowOf(h.d, child)).toMatchObject({ state: 'done' })
    expect(await rowOf(h.d, child)).not.toHaveProperty('round')
    await h.daemon.stop()
  })
})

describe('a work round, its slot and its outcome', () => {
  it('keeps a round open through progress replies, which neither end it nor free its slot', async () => {
    const policy = { ...ON, limits: { maxConcurrentSubsessions: 1 } }
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: policy }]))
    const caller = await seedCaller(h.d)
    let finish!: () => void
    h.rt.behavior.subQueue.push(async () => {
      const thread = subInputs(h.dispatched)[0]!.msg.thread!
      expect(await childReply(h.d, caller, thread, 'Halfway: the failure is isolated.')).toMatchObject({
        delivered: true
      })
      expect(await childReply(h.d, caller, thread, 'Should I keep the old format?')).toMatchObject({ delivered: true })
      await new Promise<void>((resolve) => (finish = resolve))
      return 'end_turn'
    })
    const created = await send(h.d, caller, {
      action: 'delegateTask',
      title: 'repair the parser',
      message: 'repair the parser'
    })
    const child: string = created.taskId
    await vi.waitFor(() => expect(h.reports()).toHaveLength(2), WAIT)
    expect(await rowOf(h.d, child)).toMatchObject({ state: 'open' })
    // Its slot is still held: a second task is refused.
    expect(
      (await send(h.d, caller, { action: 'delegateTask', title: 'another', message: 'another' })).wake
    ).toMatchObject({
      delivered: false,
      reason: 'task_limit'
    })
    finish()
    await vi.waitFor(() => expect(h.reports()).toHaveLength(3), WAIT)
    await h.settled()
    // §9.5: each reply reaches the owning session under its own header, answering the owner's message.
    expect(h.reports().map((c) => modelText(c.msg))).toEqual([
      expect.stringMatching(
        /^\[Message msg-[^\]]+\] Reply from bot-a .* to your message msg-[^:]+:\nHalfway: the failure is isolated\.$/
      ),
      expect.stringMatching(/\nShould I keep the old format\?$/),
      expect.stringContaining(finished('repair the parser'))
    ])
    await vi.waitFor(async () => expect(await rowOf(h.d, child)).toMatchObject({ state: 'done' }), WAIT)
    await h.daemon.stop()
  })

  it('queues a message to a running child into its round, with no second slot and one report', async () => {
    const policy = { ...ON, limits: { maxConcurrentSubsessions: 1 } }
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: policy }]))
    const caller = await seedCaller(h.d)
    let finish!: () => void
    h.rt.behavior.subQueue.push(async () => {
      await new Promise<void>((resolve) => (finish = resolve))
      return 'end_turn'
    })
    const created = await send(h.d, caller, {
      action: 'delegateTask',
      title: 'repair the parser',
      message: 'repair the parser'
    })
    const child: string = created.taskId
    await vi.waitFor(() => expect(h.rt.subPrompts).toHaveLength(1), WAIT)

    const res = await send(h.d, caller, { action: 'messageTask', taskId: child, message: 'keep the format' })
    expect(res.wake).toMatchObject({ delivered: true, targetSession: child })
    expect(await rowOf(h.d, child)).toMatchObject({ state: 'open' })
    expect(await rowOf(h.d, child)).not.toHaveProperty('round')
    finish()
    await vi.waitFor(() => expect(h.rt.subPrompts).toHaveLength(2), WAIT)
    await vi.waitFor(() => expect(h.reports()).toHaveLength(1), WAIT)
    await h.settled()
    expect(subInputs(h.dispatched).map((c) => c.callMeta.subsessionRound)).toEqual([1, 1])
    expect(h.reports()).toHaveLength(1)
    expect(await rowOf(h.d, child)).toMatchObject({ state: 'done' })
    await h.daemon.stop()
  })

  it('opens one round for simultaneous messages to an idle child', async () => {
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(h.d)
    const child = await startAndFinish(h, caller)
    const results = await Promise.all([
      h.d.collab.continueSubsession(continuation(caller, child, 'first')),
      h.d.collab.continueSubsession(continuation(caller, child, 'second'))
    ])
    expect(results.map((r: any) => r.delivered)).toEqual([true, true])
    await vi.waitFor(() => expect(h.reports()).toHaveLength(2), WAIT)
    await h.settled()
    expect(subInputs(h.dispatched).map((c) => c.callMeta.subsessionRound)).toEqual([1, 2, 2])
    expect(await rowOf(h.d, child)).toMatchObject({ state: 'done', round: 2 })
    expect(h.reports()).toHaveLength(2)
    await h.daemon.stop()
  })

  it('keeps a reopened round that another message joined when the message that opened it is refused', async () => {
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(h.d)
    const child = await startAndFinish(h, caller)
    let refuseFirst!: () => void
    const refusal = new Promise<void>((resolve) => (refuseFirst = resolve))
    let finishSecond!: () => void
    h.rt.behavior.subQueue.push(
      async () => (await new Promise<void>((resolve) => (finishSecond = resolve)), 'end_turn')
    )
    const inner = h.d.dispatch
    h.d.dispatch = (agentId: string, msg: NormalizedMessage, ...rest: any[]) => {
      if (!msg.text.includes('FIRST-INPUT')) return inner(agentId, msg, ...rest)
      return (async () => {
        await refusal
        rest[3]?.onAdmission?.({ accepted: false, reason: 'queue_full' })
        return undefined
      })()
    }
    const first = h.d.collab.continueSubsession(continuation(caller, child, 'FIRST-INPUT'))
    await vi.waitFor(async () => expect(await rowOf(h.d, child)).toMatchObject({ state: 'open', round: 2 }), WAIT)
    expect((await h.d.collab.continueSubsession(continuation(caller, child, 'SECOND-INPUT'))).delivered).toBe(true)
    await vi.waitFor(() => expect(h.rt.subPrompts).toHaveLength(2), WAIT)
    refuseFirst()
    expect(await first).toMatchObject({ delivered: false, reason: 'queue_full' })
    expect(await rowOf(h.d, child)).toMatchObject({ state: 'open', round: 2 })
    finishSecond()
    await vi.waitFor(() => expect(h.reports()).toHaveLength(2), WAIT)
    await h.settled()
    expect(await rowOf(h.d, child)).toMatchObject({ state: 'done', round: 2 })
    await h.daemon.stop()
  })

  it('reacquires a slot per round, and a retained idle child holds none', async () => {
    const policy = { ...ON, limits: { maxConcurrentSubsessions: 1 } }
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: policy }]))
    const caller = await seedCaller(h.d)
    const first = await startAndFinish(h, caller)
    // The finished child holds no slot, so a new one starts; while that one runs, the first cannot reopen.
    h.rt.behavior.subQueue.push('hang')
    const second = await send(h.d, caller, { action: 'delegateTask', title: 'second task', message: 'second task' })
    expect(second.wake).toMatchObject({ delivered: true })
    await vi.waitFor(() => expect(h.rt.subPrompts).toHaveLength(2), WAIT)
    const refused = await send(h.d, caller, { action: 'messageTask', taskId: first, message: 'more' })
    expect(refused).toEqual({
      ok: true,
      wake: {
        delivered: false,
        targetSession: first,
        reason: 'task_limit',
        message:
          'You already have 1 task running, the most allowed at once. Nothing was sent; message it again once one of them reports.'
      }
    })
    expect(await rowOf(h.d, first)).toMatchObject({ state: 'done' })
    expect(await rowOf(h.d, first)).not.toHaveProperty('round')
    await h.d.interruptTurn('bot-a', second.taskId, 'stop')
    await vi.waitFor(async () => expect((await rowOf(h.d, second.taskId))?.state).toBe('failed'), WAIT)
    expect((await h.d.collab.continueSubsession(continuation(caller, first))).delivered).toBe(true)
    await h.settled()
    await h.daemon.stop()
  })

  it('ignores a late outcome of an older round', async () => {
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(h.d)
    const child = await startAndFinish(h, caller)
    h.rt.behavior.subQueue.push('hang')
    expect((await h.d.collab.continueSubsession(continuation(caller, child))).delivered).toBe(true)
    await vi.waitFor(() => expect(h.rt.subPrompts).toHaveLength(2), WAIT)
    const old = subInputs(h.dispatched)[0]!.msg
    await h.d.collab.settleSubsessionTurn({
      agentId: 'bot-a',
      key: child,
      msg: old,
      outcome: 'failed',
      replayed: false,
      round: 1
    })
    expect(await rowOf(h.d, child)).toMatchObject({ state: 'open', round: 2 })
    expect(h.reports()).toHaveLength(1)
    await h.d.interruptTurn('bot-a', child, 'stop')
    await vi.waitFor(() => expect(h.reports()).toHaveLength(2), WAIT)
    await h.settled()
    await h.daemon.stop()
  })

  it('keeps a round open while the child waits for a reply it asked a peer for', async () => {
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }, { id: 'bot-b' }]))
    const caller = await seedCaller(h.d)
    let releasePeer!: () => void
    const peerTurn = new Promise<void>((resolve) => (releasePeer = resolve))
    let reportedFromWake: unknown
    h.rt.behavior.byText.push(
      [/PEER-TASK/, async () => (await peerTurn, 'end_turn')],
      [
        /\[inferred reply\]/,
        async () => {
          reportedFromWake = await childReply(h.d, caller, subInputs(h.dispatched)[0]!.msg.thread!, 'PEER-RESULT')
          return 'end_turn'
        }
      ]
    )
    h.rt.behavior.subQueue.push(async () => {
      const thread = subInputs(h.dispatched)[0]!.msg.thread!
      const deps = { ...h.d.mcp.deps, canRun: () => true }
      const call = (await executeTool(
        { ...toolContext(caller), thread },
        'sendMessage',
        {
          action: 'callAgent',
          toAgent: { agentId: 'bot-b', needsReply: true },
          message: 'PEER-TASK: check the schema'
        },
        deps
      )) as any
      expect(call.wake).toMatchObject({ delivered: true })
      return 'end_turn'
    })
    const created = await send(h.d, caller, {
      action: 'delegateTask',
      title: 'ask bot-b about the schema',
      message: 'ask bot-b about the schema'
    })
    const child: string = created.taskId
    await vi.waitFor(() => expect(told(h.rt.hosts, 'PEER-TASK')).toBeGreaterThanOrEqual(1), WAIT)
    // The child's turn ended while the peer still works: its round stays open and nothing is reported.
    await subInputs(h.dispatched)[0]!.turn
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await rowOf(h.d, child)).toMatchObject({ state: 'open' })
    expect(h.reports()).toHaveLength(0)
    releasePeer()
    await vi.waitFor(() => expect(reportedFromWake).toMatchObject({ delivered: true }), WAIT)
    await vi.waitFor(() => expect(h.reports().some((c) => modelText(c.msg).endsWith('\nPEER-RESULT'))).toBe(true), WAIT)
    await vi.waitFor(
      () =>
        expect(h.reports().some((c) => modelText(c.msg).includes(finished('ask bot-b about the schema')))).toBe(true),
      WAIT
    )
    await h.settled()
    await vi.waitFor(async () => expect(await rowOf(h.d, child)).toMatchObject({ state: 'done' }), WAIT)
    await h.daemon.stop()
  })

  it.each([
    ['naming the message it answers', true],
    ['from a peer daemon without message ids', false]
  ])('settles the round once a peer on another daemon replies, %s', async (_name, withIds) => {
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]), { remotePeers: ['bot-remote'] })
    const caller = await seedCaller(h.d)
    const sent: Record<string, any>[] = []
    h.d.relays = {
      stop: vi.fn(async () => {}),
      sendAgentMsg: vi.fn(async (payload: Record<string, any>) => {
        sent.push(payload)
        return { deliveryId: payload.deliveryId, delivered: true, childSessionId: 'slack:C1:200.1:bot-remote' }
      })
    }
    h.rt.behavior.subQueue.push(async () => {
      const thread = subInputs(h.dispatched)[0]!.msg.thread!
      const deps = { ...h.d.mcp.deps, canRun: () => true }
      const call = (await executeTool(
        { ...toolContext(caller), thread },
        'sendMessage',
        { action: 'callAgent', toAgent: { agentId: 'bot-remote', needsReply: true }, message: 'check the schema' },
        deps
      )) as any
      expect(call.wake).toMatchObject({ delivered: true })
      return 'end_turn'
    })
    const created = await send(h.d, caller, {
      action: 'delegateTask',
      title: 'ask bot-remote about the schema',
      message: 'ask bot-remote about the schema'
    })
    const child: string = created.taskId
    await vi.waitFor(() => expect(sent).toHaveLength(1), WAIT)
    await subInputs(h.dispatched)[0]!.turn
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await rowOf(h.d, child)).toMatchObject({ state: 'open' })
    expect(h.reports()).toHaveLength(0)
    // The peer's reply comes back over the relay into the task that sent the call.
    const call = sent[0]!
    expect(
      await h.d.handleRelayAgentMsg({
        trustedFromAgentId: 'bot-remote',
        orgId: TEST_ORG,
        toAgentId: 'bot-a',
        text: 'REMOTE-RESULT',
        coords: { platform: 'slack', channel: 'C1' },
        hopCount: 2,
        deliveryId: 'remote-reply-1',
        originSessionId: 'sid-remote-1',
        originCoords: { platform: 'slack', channel: 'C1', thread: '200.1' },
        deliveryKind: 'session-reply',
        lineageReplyTo: call.originSessionId,
        ...(withIds ? { messageId: 'msg-remote-reply-1', messageKind: 'reply', inReplyTo: call.messageId } : {})
      })
    ).toMatchObject({ delivered: true, childSessionId: child })
    await vi.waitFor(() => expect(told(h.rt.hosts, 'REMOTE-RESULT')).toBe(1), WAIT)
    await vi.waitFor(
      () =>
        expect(h.reports().some((c) => modelText(c.msg).includes(finished('ask bot-remote about the schema')))).toBe(
          true
        ),
      WAIT
    )
    await h.settled()
    await vi.waitFor(async () => expect(await rowOf(h.d, child)).toMatchObject({ state: 'done' }), WAIT)
    await h.daemon.stop()
  })

  it('stops the round with its queued input, and only an explicit later message starts new work', async () => {
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(h.d)
    h.rt.behavior.subQueue.push('hang')
    const created = await send(h.d, caller, { action: 'delegateTask', title: 'long task', message: 'long task' })
    const child: string = created.taskId
    await vi.waitFor(() => expect(h.rt.subPrompts).toHaveLength(1), WAIT)
    expect((await h.d.collab.continueSubsession(continuation(caller, child, 'queued'))).delivered).toBe(true)
    await h.d.interruptTurn('bot-a', child, 'stop')
    await vi.waitFor(() => expect(h.reports()).toHaveLength(1), WAIT)
    await h.settled()
    expect(h.rt.subPrompts).toHaveLength(1)
    expect(modelText(h.reports()[0]!.msg)).toMatch(/^\[Message msg-[^\]]+\] Report from your task \(session [^)]+\):\n/)
    expect(modelText(h.reports()[0]!.msg)).toContain(
      `\n[task ended] Task "long task" stopped before finishing (stop). Anything it sent before this is all it reported. To give it more work in the same context, call sendMessage with {"action":"messageTask","taskId":"${child}","message":"..."}.\n\n${REPORT_ANSWER_LANGUAGE}`
    )
    await vi.waitFor(async () => expect(await rowOf(h.d, child)).toMatchObject({ state: 'failed' }), WAIT)
    // The child refuses replies of the stopped round, and runs again only when asked.
    expect(await childReply(h.d, caller, subInputs(h.dispatched)[0]!.msg.thread!, 'late')).toEqual({
      delivered: false,
      inReplyTo: expect.any(String),
      reason: 'task_ended'
    })
    expect((await h.d.collab.continueSubsession(continuation(caller, child, 'try again'))).delivered).toBe(true)
    await vi.waitFor(() => expect(h.reports()).toHaveLength(2), WAIT)
    await h.settled()
    expect(h.rt.subPrompts).toHaveLength(2)
    expect(await rowOf(h.d, child)).toMatchObject({ state: 'done', round: 2 })
    await h.daemon.stop()
  })
})

describe('a task’s own background tasks (auto-session-mode.md §6.3)', () => {
  /** The MCP context of a task's own turn, on its coordinate. */
  const inTask = (caller: { scope: string; coordinate: string }, thread: string) => ({
    ...toolContext(caller),
    thread
  })
  const taskSend = async (h: Awaited<ReturnType<typeof boot>>, ctx: object, args: Record<string, unknown>) =>
    (await executeTool(ctx as never, 'sendMessage', args, { ...h.d.mcp.deps, canRun: () => true })) as any

  it('reports a task’s task into that task, which keeps its round open until then and reports once itself', async () => {
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(h.d)
    let levelOneThread = ''
    let nested: any
    let releaseLevelTwo!: () => void
    const levelTwoDone = new Promise<void>((resolve) => (releaseLevelTwo = resolve))
    h.rt.behavior.byText.push(
      [
        /LEVEL-ONE-WORK/,
        async () => {
          levelOneThread = subInputs(h.dispatched).find((c) => c.msg.text.includes('LEVEL-ONE-WORK'))!.msg.thread!
          nested = await taskSend(h, inTask(caller, levelOneThread), {
            action: 'delegateTask',
            title: 'Level two',
            message: 'LEVEL-TWO-WORK'
          })
          // A restart forgets the in-memory link; the index alone keeps level one's round open.
          h.d.collab.childSessionLinks.clear()
          return 'end_turn'
        }
      ],
      [
        /LEVEL-TWO-WORK/,
        async () => {
          await levelTwoDone
          return 'end_turn'
        }
      ]
    )
    const created = await send(h.d, caller, { action: 'delegateTask', title: 'Level one', message: 'LEVEL-ONE-WORK' })
    const levelOne: string = created.taskId
    await vi.waitFor(() => expect(nested?.wake).toMatchObject({ delivered: true, subsession: true }), WAIT)
    const levelTwo: string = nested.taskId
    expect(await rowOf(h.d, levelTwo)).toMatchObject({ parentSessionKey: levelOne, title: 'Level two', state: 'open' })
    // Level one's turn ended, but its own task still runs, so its round stays open and nothing reaches the root.
    await subInputs(h.dispatched).find((c) => c.msg.text.includes('LEVEL-ONE-WORK'))!.turn
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await rowOf(h.d, levelOne)).toMatchObject({ state: 'open' })
    expect(h.reports()).toHaveLength(0)
    // The level-one task lists and messages its own task, and nobody else's.
    await h.d.store.upsertSession({ ...(await h.d.store.getSession(caller.key)), triggeredBy: 'U0ALICE' })
    const listed = await executeTool(inTask(caller, levelOneThread) as never, 'listTasks', {}, {
      ...h.d.mcp.deps,
      canRun: () => true
    } as never)
    // A task's task works for the person behind the root session (auto-session-mode.md §6.2).
    expect((listed as any).tasks).toEqual([
      expect.objectContaining({ taskId: levelTwo, title: 'Level two', owner: 'U0ALICE', running: true })
    ])

    releaseLevelTwo()
    await vi.waitFor(() => expect(h.reports()).toHaveLength(2), WAIT)
    await h.settled()
    const [intoLevelOne, intoRoot] = h.reports()
    // Level two's report reaches level one, never the conversation's own session.
    expect(intoLevelOne!.msg.thread).toBe(levelOneThread)
    expect(modelText(intoLevelOne!.msg)).toContain(finished('Level two'))
    expect(intoRoot!.msg.sessionThread).toBe(caller.coordinate)
    expect(modelText(intoRoot!.msg)).toContain(finished('Level one'))
    await vi.waitFor(async () => expect(await rowOf(h.d, levelOne)).toMatchObject({ state: 'done' }), WAIT)
    expect(await rowOf(h.d, levelTwo)).toMatchObject({ state: 'done' })
    await h.daemon.stop()
  })

  it('lets a task message and stop its own task, and never another session’s', async () => {
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]), { spy: true })
    const caller = await seedCaller(h.d)
    const levelOne = await send(h.d, caller, { action: 'delegateTask', title: 'Level one', message: 'one' })
    const levelOneThread = h.dispatched[0]!.msg.thread!
    await h.d.store.upsertSession({
      key: levelOne.taskId,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: levelOneThread,
      transportScope: caller.scope,
      acpSessionId: 'acp-level-one',
      sessionId: 'sid-level-one',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    const ctx = inTask(caller, levelOneThread)
    const levelTwo = await taskSend(h, ctx, { action: 'delegateTask', title: 'Level two', message: 'two' })
    expect(levelTwo.wake).toMatchObject({ delivered: true, subsession: true })
    expect(await taskSend(h, ctx, { action: 'messageTask', taskId: levelTwo.taskId, message: 'more' })).toMatchObject({
      wake: { delivered: true }
    })
    // The root's task is not level one's to message.
    expect(await taskSend(h, ctx, { action: 'messageTask', taskId: levelOne.taskId, message: 'more' })).toMatchObject({
      wake: { delivered: false, reason: 'task_not_found' }
    })
    const deps = { ...h.d.mcp.deps, canRun: () => true }
    expect(await executeTool(ctx as never, 'stopTask', { taskId: levelOne.taskId }, deps)).toMatchObject({
      result: 'refused'
    })
    expect(await executeTool(ctx as never, 'stopTask', { taskId: levelTwo.taskId }, deps)).toMatchObject({
      taskId: levelTwo.taskId
    })
    await h.daemon.stop()
  })
})

describe('a task with a thread attached (auto-session-mode.md §6.2, §6.6)', () => {
  it('reports the round running when its thread attaches once, and no later round', async () => {
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(h.d)
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    h.rt.behavior.byText.push([
      /THREADED-WORK/,
      async () => {
        await held
        return 'end_turn'
      }
    ])
    const created = await send(h.d, caller, { action: 'delegateTask', title: 'Threaded', message: 'THREADED-WORK' })
    const child: string = created.taskId
    // The thread attaches while round 1 runs, so round 2 is the first that answers only in the thread.
    expect(
      await h.d.store.assistantSubsessions.attachThread({
        agentId: 'bot-a',
        childSessionKey: child,
        platform: 'slack',
        channel: 'C1',
        transportScope: caller.scope,
        thread: '1700000900.000100',
        sinceRound: 2,
        now: Date.now()
      })
    ).toBe(true)
    release()
    await vi.waitFor(() => expect(h.reports()).toHaveLength(1), WAIT)
    await h.settled()
    await vi.waitFor(async () => expect(await rowOf(h.d, child)).toMatchObject({ state: 'done' }), WAIT)

    expect((await send(h.d, caller, { action: 'messageTask', taskId: child, message: 'more' })).wake).toMatchObject({
      delivered: true
    })
    await vi.waitFor(async () => expect(await rowOf(h.d, child)).toMatchObject({ state: 'done', round: 2 }), WAIT)
    await h.settled()
    expect(h.reports()).toHaveLength(1)
    await h.daemon.stop()
  })
})

describe('one submission, one input', () => {
  it('returns the first receipt for a replayed submission, with no second input, slot or round', async () => {
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(h.d)
    const child = await startAndFinish(h, caller)
    const args = { action: 'messageTask', taskId: child, message: 'same text' }
    const first = await send(h.d, caller, args, 'call-7')
    const again = await send(h.d, caller, args, 'call-7')
    expect(again).toEqual(first)
    // A new call with the same text is a new submission.
    await vi.waitFor(async () => expect((await rowOf(h.d, child))?.state).toBe('done'), WAIT)
    await h.settled()
    expect(subInputs(h.dispatched)).toHaveLength(2)
    expect((await send(h.d, caller, args, 'call-8')).wake).toMatchObject({ delivered: true })
    await vi.waitFor(() => expect(subInputs(h.dispatched)).toHaveLength(3), WAIT)
    await h.settled()
    expect(await rowOf(h.d, child)).toMatchObject({ round: 3 })
    await h.daemon.stop()
  })
})

describe('one delegateTask submission, one task', () => {
  it('returns the first receipt for a replayed delegateTask, in process and from the recorded message', async () => {
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(h.d)
    const args = { action: 'delegateTask', title: 'investigate the flaky test', message: 'investigate the flaky test' }
    const first = await send(h.d, caller, args, 'nonce-1:7')
    expect(first.wake).toMatchObject({ delivered: true, subsession: true })
    expect(await send(h.d, caller, args, 'nonce-1:7')).toEqual(first)
    await vi.waitFor(async () => expect((await rowOf(h.d, first.taskId))?.state).toBe('done'), WAIT)
    await h.settled()
    h.d.collab.callSubmissions.clear()
    const again = await send(h.d, caller, args, 'nonce-1:7')
    expect(again.wake).toEqual({ delivered: true, targetSession: first.taskId, subsession: true })
    expect(again.taskId).toBe(first.taskId)
    await h.settled()
    expect(subInputs(h.dispatched)).toHaveLength(1)
    expect(await h.d.store.assistantSubsessions.list('bot-a', 10)).toHaveLength(1)
    await h.daemon.stop()
  })
})

describe('admission that cannot be decided yet', () => {
  it('sends one input for two concurrent deliveries of one submission', async () => {
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(h.d)
    const child = await startAndFinish(h, caller)
    const args = { action: 'messageTask', taskId: child, message: 'same call' }
    const results = await Promise.all([send(h.d, caller, args, 'call-9'), send(h.d, caller, args, 'call-9')])
    // The second either reads the first receipt or is told the same message is still on its way; never a resend.
    expect(results.filter((r) => r.wake.delivered)).not.toHaveLength(0)
    for (const r of results) if (!r.wake.delivered) expect(r.wake.reason).toBe('submission_in_flight')
    await vi.waitFor(async () => expect((await rowOf(h.d, child))?.state).toBe('done'), WAIT)
    await h.settled()
    expect(subInputs(h.dispatched)).toHaveLength(2)
    expect(await rowOf(h.d, child)).toMatchObject({ round: 2 })
    await h.daemon.stop()
  })

  it('opens no round while the previous round’s report still waits for admission', async () => {
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]), { spy: true })
    const caller = await seedCaller(h.d)
    const created = await send(h.d, caller, { action: 'delegateTask', title: 'task', message: 'task' })
    const child: string = created.taskId
    expect(await h.d.store.assistantSubsessions.claimReport('bot-a', child, '{"text":"held"}')).toBe(true)
    const res = await h.d.collab.continueSubsession(continuation(caller, child))
    expect(res).toMatchObject({ delivered: false, targetSession: child, reason: 'task_reporting' })
    expect(res.message).toContain('Nothing was sent; end this turn and message it again after the report arrives.')
    expect(await rowOf(h.d, child)).toMatchObject({ state: 'reporting' })
    expect(h.dispatched).toHaveLength(1)
    await h.daemon.stop()
  })
})

describe('the owning session and its task answer each other’s messages', () => {
  it('routes the owning session’s reply to a task’s report through the round accounting, and no other session can', async () => {
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(h.d)
    const child = await startAndFinish(h, caller)
    // §9.3: the round's report reached its owning session as a message from the task.
    const report = await lastReceived(h.d, caller.key, 'report')
    expect(modelText(h.reports()[0]!.msg)).toContain(`[Message ${report.messageId}] Report from your task`)
    const reply = (from: { scope: string; coordinate: string }, channel = 'C1') =>
      h.d.collab.replyToSession({
        callerAgentId: 'bot-a',
        platform: 'slack',
        callerTransportScope: from.scope,
        callerChannel: channel,
        callerThread: from.coordinate,
        messageId: report.messageId,
        text: 'Yes, keep the old format.'
      })
    expect(await reply(caller)).toEqual({ delivered: true, targetSession: child, inReplyTo: report.messageId })
    await vi.waitFor(() => expect(h.reports()).toHaveLength(2), WAIT)
    await h.settled()
    expect(subInputs(h.dispatched)[1]!.callMeta).toMatchObject({
      originSessionId: 'sid-parent-1',
      subsessionRound: 2,
      messageKind: 'taskInput'
    })
    expect(await rowOf(h.d, child)).toMatchObject({ state: 'done', round: 2 })
    expect((await h.d.store.getSession(child))?.originSessionId).toBe('sid-parent-1')
    // Another session of the agent cannot answer a message it never received.
    const other = await seedCaller(h.d, 'bot-a', 'C2')
    expect(await reply(other, 'C2')).toEqual({
      delivered: false,
      inReplyTo: report.messageId,
      reason: 'message_not_found'
    })
    expect(subInputs(h.dispatched)).toHaveLength(2)
    await h.daemon.stop()
  })

  it('delivers another session’s reply to a task’s message like a peer’s, outside the owner’s round admission', async () => {
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(h.d)
    const child = await startAndFinish(h, caller)
    const taskId = await h.d.store.ensureOutwardSessionId(child, 'bot-a', Date.now())
    // The channel session the task opened with a self callAgent holds its call.
    const channel = await seedCaller(h.d, 'bot-a', 'C2')
    await h.d.store.sessionMessages.recordReceived({
      messageId: 'msg-from-task',
      recipientKey: channel.key,
      recipientAgentId: 'bot-a',
      sourceSessionId: taskId,
      sourceAgentId: 'bot-a',
      kind: 'call',
      replyState: 'open',
      hopCount: 1,
      now: Date.now()
    })
    const before = h.dispatched.length
    const res = await h.d.collab.replyToSession({
      callerAgentId: 'bot-a',
      platform: 'slack',
      callerTransportScope: channel.scope,
      callerChannel: 'C2',
      callerThread: channel.coordinate,
      messageId: 'msg-from-task',
      text: 'Here is what you asked for.'
    })
    expect(res).toEqual({ delivered: true, targetSession: child, inReplyTo: 'msg-from-task' })
    await h.settled()
    const into = h.dispatched.slice(before).filter((c) => c.msg.thread === h.dispatched[before]?.msg.thread)
    expect(into[0]!.callMeta).toMatchObject({ messageKind: 'reply', inReplyTo: 'msg-from-task' })
    expect(into[0]!.callMeta.subsessionRound).toBeUndefined()
    await h.daemon.stop()
  })

  it('never wakes an approved proposal or a check by answering its message', async () => {
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(h.d)
    for (const thread of [taskCoordinate('x1'), checkCoordinate('x2')]) {
      const key = sessionKey('slack', 'C1', thread, 'bot-a', caller.scope)
      await h.d.store.upsertSession({
        key,
        agentId: 'bot-a',
        platform: 'slack',
        channel: 'C1',
        thread,
        transportScope: caller.scope,
        acpSessionId: `acp-${thread}`,
        sessionId: `sid-${thread}`,
        state: 'idle',
        lastDeliveredTs: null,
        updatedAt: Date.now()
      })
      const messageId = `msg-${thread}`
      await h.d.store.sessionMessages.recordReceived({
        messageId,
        recipientKey: caller.key,
        recipientAgentId: 'bot-a',
        sourceSessionId: `sid-${thread}`,
        sourceAgentId: 'bot-a',
        kind: 'reply',
        replyState: 'open',
        hopCount: 1,
        now: Date.now()
      })
      const res = await h.d.collab.replyToSession({
        callerAgentId: 'bot-a',
        platform: 'slack',
        callerTransportScope: caller.scope,
        callerChannel: 'C1',
        callerThread: caller.coordinate,
        messageId,
        text: 'please also do Y'
      })
      expect(res).toEqual({ delivered: false, inReplyTo: messageId, reason: 'not_authorized' })
    }
    expect(h.dispatched).toHaveLength(0)
    await h.daemon.stop()
  })

  it('settles the owner’s messages to a task with its round report, never with the task’s own replies', async () => {
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(h.d)
    let settleRound!: () => void
    h.rt.behavior.subQueue.push(async () => {
      const thread = subInputs(h.dispatched)[0]!.msg.thread!
      expect(await childReply(h.d, caller, thread, 'progress')).toMatchObject({ delivered: true })
      await new Promise<void>((resolve) => (settleRound = resolve))
      return 'end_turn'
    })
    const created = await send(h.d, caller, { action: 'delegateTask', title: 'long work', message: 'long work' })
    const child: string = created.taskId
    await vi.waitFor(() => expect(h.reports()).toHaveLength(1), WAIT)
    const input = await lastReceived(h.d, child, 'taskInput')
    expect(await h.d.store.sessionMessages.received(input.messageId)).toMatchObject({
      recipientKey: child,
      sourceSessionId: 'sid-parent-1',
      replyState: 'open'
    })
    settleRound()
    await vi.waitFor(() => expect(h.reports()).toHaveLength(2), WAIT)
    await h.settled()
    expect((await h.d.store.sessionMessages.received(input.messageId))?.replyState).toBe('replied')
    await h.daemon.stop()
  })
})

describe('a task’s standing context', () => {
  it('tells a task to answer its owning session’s messages by id, and that a reply does not end its work', () => {
    const standing = buildStandingContext({
      agentName: 'bot-a',
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: 'subsession:1',
      sessionId: 'sid-child-1',
      originSessionId: 'sid-parent-1',
      envSecretNames: [],
      fileSecrets: [],
      memoryIndex: '',
      usesMeta: true
    })
    expect(standing.agentMeta).toContain('- Created by session: sid-parent-1')
    expect(standing.taskReportingAppend).toContain(
      '`{"action":"replyToSession","messageId":"<id of its message>","message":"..."}`; a reply does not end your work.'
    )
    expect(standing.taskReportingAppend).toContain('You are a task your own session sid-parent-1 delegated')
    expect(standing.taskReportingAppend).toContain('the daemon tells that session automatically')
    expect(standing.taskReportingAppend).not.toContain('Send it exactly once')
    // It keeps a summary of scope, status and next step with updateTask (auto-session-mode.md §6.7).
    expect(standing.taskReportingAppend).toContain(TASK_SUMMARY_REQUEST)
    expect(TASK_SUMMARY_REQUEST).toContain('at most 500 characters in three parts: its scope')
  })

  it('asks only a task that keeps a summary for one, never research or an ordinary session', () => {
    const standing = (thread: string) =>
      buildStandingContext({
        agentName: 'bot-a',
        agentId: 'bot-a',
        platform: 'slack',
        channel: 'C1',
        thread,
        sessionId: 'sid-child-1',
        originSessionId: 'sid-parent-1',
        envSecretNames: [],
        fileSecrets: [],
        memoryIndex: '',
        usesMeta: true
      }).sessionContext
    expect(standing('subsession:1')).toContain(TASK_SUMMARY_REQUEST)
    for (const thread of ['subsession:research-1', 'subsession:check-1', 'append:1'])
      expect(standing(thread)).not.toContain('# Your task summary')
  })
})

describe('a task’s own summary (auto-session-mode.md §5.3, §6.7)', () => {
  /** Whatever the runtimes were handed, the session metadata included. */
  const handed = (h: Awaited<ReturnType<typeof boot>>, text: string): number =>
    h.rt.hosts
      .flatMap((host) => [...host.newSession.mock.calls, ...host.prompt.mock.calls])
      .filter((c: unknown) => JSON.stringify(c).includes(text)).length

  it('reminds a task with no summary from its second turn, and lists what it writes to its owning session', async () => {
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(h.d)
    const deps = { ...h.d.mcp.deps, canRun: () => true }
    const child = await startAndFinish(h, caller)
    // The first turn is asked for a summary in its standing context, and counted, with no reminder yet.
    expect(handed(h, '# Your task summary')).toBeGreaterThan(0)
    expect(handed(h, 'This task has no summary yet')).toBe(0)
    expect(await rowOf(h.d, child)).toMatchObject({ turnsSinceSummary: 1 })
    let listed = (await executeTool(toolContext(caller), 'listTasks', {}, deps)) as any
    expect(listed.tasks[0]).toMatchObject({ taskId: child, background: 'investigate the flaky test' })

    await send(h.d, caller, { action: 'messageTask', taskId: child, message: 'also Windows' })
    await vi.waitFor(() => expect(h.reports()).toHaveLength(2), WAIT)
    await h.settled()
    expect(handed(h, 'This task has no summary yet')).toBe(1)
    expect(await rowOf(h.d, child)).toMatchObject({ turnsSinceSummary: 2 })

    // The task writes its summary and renames itself; the owning session lists both, and the session takes the title.
    const { thread } = await h.d.store.getSession(child)
    const summary = 'Scope: the flaky e2e test. Status: in progress, Linux fixed. Next: Windows.'
    expect(
      await executeTool(
        { ...toolContext(caller), thread },
        'updateTask',
        { summary, title: '  Fix the flaky\ntest  ' },
        deps
      )
    ).toMatchObject({ result: 'updated', title: 'Fix the flaky test' })
    expect(await rowOf(h.d, child)).not.toHaveProperty('turnsSinceSummary')
    expect((await h.d.store.getSession(child))?.title).toBe('Fix the flaky test')
    listed = (await executeTool(toolContext(caller), 'listTasks', {}, deps)) as any
    expect(listed.tasks[0]).toMatchObject({
      taskId: child,
      title: 'Fix the flaky test',
      summary,
      summaryUpdatedAt: expect.any(String)
    })
    expect(listed.tasks[0]).not.toHaveProperty('background')

    // The owning session is no task, so it keeps no summary.
    expect(await executeTool(toolContext(caller), 'updateTask', { summary: 'mine' }, deps)).toEqual({
      result: 'refused',
      reason: 'Only a task keeps a summary, and this session is not one. Nothing was saved.'
    })
    await h.daemon.stop()
  })

  it('refuses a summary over 500 characters, a title over 80, and a title alone', async () => {
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(h.d)
    const deps = { ...h.d.mcp.deps, canRun: () => true }
    const child = await startAndFinish(h, caller)
    const { thread } = await h.d.store.getSession(child)
    const inTask = { ...toolContext(caller), thread }
    await expect(executeTool(inTask, 'updateTask', { summary: 'x'.repeat(501) }, deps)).rejects.toThrow(
      /argument summary must be at most 500 characters/
    )
    await expect(executeTool(inTask, 'updateTask', { summary: 'ok', title: 'x'.repeat(81) }, deps)).rejects.toThrow(
      /argument title must be at most 80 characters/
    )
    await expect(executeTool(inTask, 'updateTask', { title: 'Renamed' }, deps)).rejects.toThrow(
      /missing required string argument: summary/
    )
    // 500 characters of any script are allowed.
    expect(await executeTool(inTask, 'updateTask', { summary: '修'.repeat(500) }, deps)).toMatchObject({
      result: 'updated'
    })
    expect(await rowOf(h.d, child)).toMatchObject({ title: 'investigate the flaky test' })
    // A follow-up's check and an approved proposal keep no summary.
    for (const other of [checkCoordinate('d-1'), taskCoordinate('d-1')])
      expect(
        await executeTool({ ...inTask, thread: other, tools: [UPDATE_TASK_TOOL] }, 'updateTask', { summary: 'x' }, deps)
      ).toMatchObject({ result: 'refused' })
    await h.daemon.stop()
  })
})
