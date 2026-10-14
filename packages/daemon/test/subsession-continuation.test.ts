// Persistent sub-session messaging (send-message-guide.md §8): continuation, work rounds, slots, origins and receipts.
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
import { isSubsessionCoordinate } from '../src/session/subsession-coordinate.js'
import { buildStandingContext } from '../src/session/turn/standing-context.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

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

/** A runtime per agent whose sub-session prompts follow `sub`, and every other prompt (the parent's) answers. */
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
        // A sub-session's own input names it; the parent's standing summary of its sub-sessions does not count.
        const text = JSON.stringify(blocks)
        const sub = /as a background sub-session|for this background sub-session/.test(text)
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

async function boot(root: string, opts: { spy?: boolean; clock?: FakeClock } = {}) {
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
  d.cpCollab.replace({
    generation: 0,
    channels: [{ orgId: TEST_ORG, platform: 'slack', channelId: 'C1', agents: placements }],
    agents: placements.map((placement) => ({ ...placement, orgId: TEST_ORG }))
  })
  const dispatched: { agentId: string; msg: NormalizedMessage; callMeta?: any; turn: Promise<unknown> }[] = []
  if (opts.spy === true) {
    // The wake is admitted and never runs, so its sub-session stays open.
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

/** The child's own `replyToSession` to its parent. */
const childReply = (d: any, caller: { scope: string }, thread: string, text: string) =>
  d.collab.replyToSession({
    callerAgentId: 'bot-a',
    platform: 'slack',
    callerTransportScope: caller.scope,
    callerChannel: 'C1',
    callerThread: thread,
    sessionId: 'sid-parent-1',
    text
  })

const rowOf = async (d: any, key: string) => await d.store.assistantSubsessions.get('bot-a', key)
const subInputs = <T extends { msg: NormalizedMessage }>(dispatched: T[]): T[] =>
  dispatched.filter((c) => isSubsessionCoordinate(c.msg.thread) && c.msg.parentReport !== true)
const finished = (key: string) => `[sub-session finished] Sub-session ${key} finished this round of work`

/** Start one sub-session through the tool and let its first round finish. */
async function startAndFinish(h: Awaited<ReturnType<typeof boot>>, caller: { scope: string; coordinate: string }) {
  const created = await send(h.d, caller, { action: 'messageSubsession', message: 'investigate the flaky test' })
  expect(created.wake).toMatchObject({ delivered: true, subsession: true })
  const child: string = created.childSessionId
  await vi.waitFor(async () => expect((await rowOf(h.d, child))?.state).toBe('done'), WAIT)
  await h.settled()
  return child
}

describe('messageSubsession continues an existing direct child', () => {
  it('sends into the same child by its childSessionId and opens a new round after the first finished', async () => {
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(h.d)
    const child = await startAndFinish(h, caller)
    expect(h.reports().map((c) => c.msg.text)).toEqual([expect.stringContaining(finished(child))])
    const firstSession = (await h.d.store.getSession(child))?.acpSessionId

    const res = await send(h.d, caller, { action: 'messageSubsession', sessionId: child, message: 'also Windows' })
    expect(res).toMatchObject({
      ok: true,
      wake: { delivered: true, targetSession: child, subsession: true },
      childSessionId: child,
      reply: { requested: true, state: 'awaiting' },
      nextAction: 'finish-turn-and-wait'
    })
    await vi.waitFor(() => expect(h.reports()).toHaveLength(2), WAIT)
    await h.settled()

    // The same child, in its own context: one index row, the same runtime session, and round 2 settled done.
    const inputs = subInputs(h.dispatched)
    expect(inputs).toHaveLength(2)
    expect(sessionKey('slack', 'C1', inputs[1]!.msg.thread!, 'bot-a', inputs[1]!.msg.transportScope)).toBe(child)
    expect(inputs[1]!.msg.text).toBe(
      'From your own main conversation (session sid-parent-1), a new message for this background sub-session: also Windows'
    )
    expect(inputs[1]!.callMeta).toMatchObject({ originSessionId: 'sid-parent-1', needsReply: true, subsessionRound: 2 })
    expect((await h.d.store.getSession(child))?.acpSessionId).toBe(firstSession)
    expect(await h.d.store.assistantSubsessions.list('bot-a', 10)).toHaveLength(1)
    expect(await rowOf(h.d, child)).toMatchObject({ state: 'done', round: 2 })
    // Each round reports once, under a delivery id of its own.
    const [first, second] = h.reports()
    expect(second!.msg.text).toContain(finished(child))
    expect(second!.callMeta.deliveryId).not.toBe(first!.callMeta.deliveryId)
    await h.daemon.stop()
  })

  it('also takes the child’s outward session id', async () => {
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(h.d)
    const child = await startAndFinish(h, caller)
    const outward = await h.d.store.ensureOutwardSessionId(child, 'bot-a', Date.now())

    const res = await send(h.d, caller, { action: 'messageSubsession', sessionId: outward, message: 'one more' })
    expect(res.wake).toMatchObject({ delivered: true, targetSession: child })
    expect(res.childSessionId).toBe(child)
    await h.settled()
    await h.daemon.stop()
  })

  it('never creates or retargets for an unknown, unrelated, rotated or purged id', async () => {
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }, { id: 'bot-b' }]))
    const caller = await seedCaller(h.d)
    const child = await startAndFinish(h, caller)
    const before = subInputs(h.dispatched).length
    const refusal = {
      delivered: false,
      reason: 'subsession_not_found',
      message:
        'This conversation has no sub-session with that id. Nothing was sent. Pass the `childSessionId` a messageSubsession ' +
        'call here returned, or omit `sessionId` to start a new sub-session.'
    }
    const unknown = 'slack:C1:subsession:404:bot-a'
    expect(await send(h.d, caller, { action: 'messageSubsession', sessionId: unknown, message: 'm' })).toEqual({
      ok: true,
      wake: { ...refusal, targetSession: unknown }
    })
    // The child itself, a sibling-to-be, or the parent's own session are not a direct child of the caller.
    expect((await h.d.collab.continueSubsession(continuation(caller, caller.key))).reason).toBe('subsession_not_found')
    const thread = subInputs(h.dispatched)[0]!.msg.thread!
    expect((await h.d.collab.continueSubsession({ ...continuation(caller, child), callerThread: thread })).reason).toBe(
      'subsession_not_found'
    )
    // Another conversation of the same agent, and the same conversation after `!new`.
    const other = await seedCaller(h.d, 'bot-a', 'C2')
    expect((await h.d.collab.continueSubsession({ ...continuation(other, child), callerChannel: 'C2' })).reason).toBe(
      'subsession_not_found'
    )
    const next = await rotate(h.d, caller)
    expect((await h.d.collab.continueSubsession({ ...continuation(caller, child), callerThread: next })).reason).toBe(
      'subsession_not_found'
    )
    // Another agent naming this agent's child.
    const peer = await seedCaller(h.d, 'bot-b')
    expect((await h.d.collab.continueSubsession({ ...continuation(peer, child), callerAgentId: 'bot-b' })).reason).toBe(
      'subsession_not_found'
    )
    // A purged child is not recreated.
    expect(await h.d.store.deleteSession(child)).toBe(true)
    expect((await h.d.collab.continueSubsession(continuation(caller, child))).reason).toBe('subsession_not_found')
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
    const created = await send(h.d, caller, { action: 'messageSubsession', message: 'repair the parser' })
    const child: string = created.childSessionId
    await vi.waitFor(() => expect(h.reports()).toHaveLength(2), WAIT)
    expect(await rowOf(h.d, child)).toMatchObject({ state: 'open' })
    // Its slot is still held: a second sub-session is refused.
    expect((await send(h.d, caller, { action: 'messageSubsession', message: 'another' })).wake).toMatchObject({
      delivered: false,
      reason: 'subsession_limit'
    })
    finish()
    await vi.waitFor(() => expect(h.reports()).toHaveLength(3), WAIT)
    await h.settled()
    expect(h.reports().map((c) => c.msg.text)).toEqual([
      'Halfway: the failure is isolated.',
      'Should I keep the old format?',
      expect.stringContaining(finished(child))
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
    const created = await send(h.d, caller, { action: 'messageSubsession', message: 'repair the parser' })
    const child: string = created.childSessionId
    await vi.waitFor(() => expect(h.rt.subPrompts).toHaveLength(1), WAIT)

    const res = await send(h.d, caller, { action: 'messageSubsession', sessionId: child, message: 'keep the format' })
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
    const second = await send(h.d, caller, { action: 'messageSubsession', message: 'second task' })
    expect(second.wake).toMatchObject({ delivered: true })
    await vi.waitFor(() => expect(h.rt.subPrompts).toHaveLength(2), WAIT)
    const refused = await send(h.d, caller, { action: 'messageSubsession', sessionId: first, message: 'more' })
    expect(refused).toEqual({
      ok: true,
      wake: {
        delivered: false,
        targetSession: first,
        reason: 'subsession_limit',
        message:
          'You already have 1 sub-sessions running, the limit. Nothing was sent; message it again once one reports.'
      }
    })
    expect(await rowOf(h.d, first)).toMatchObject({ state: 'done' })
    expect(await rowOf(h.d, first)).not.toHaveProperty('round')
    await h.d.interruptTurn('bot-a', second.childSessionId, 'stop')
    await vi.waitFor(async () => expect((await rowOf(h.d, second.childSessionId))?.state).toBe('failed'), WAIT)
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
    const created = await send(h.d, caller, { action: 'messageSubsession', message: 'ask bot-b about the schema' })
    const child: string = created.childSessionId
    await vi.waitFor(() => expect(told(h.rt.hosts, 'PEER-TASK')).toBeGreaterThanOrEqual(1), WAIT)
    // The child's turn ended while the peer still works: its round stays open and nothing is reported.
    await subInputs(h.dispatched)[0]!.turn
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await rowOf(h.d, child)).toMatchObject({ state: 'open' })
    expect(h.reports()).toHaveLength(0)
    releasePeer()
    await vi.waitFor(() => expect(reportedFromWake).toMatchObject({ delivered: true }), WAIT)
    await vi.waitFor(() => expect(h.reports().map((c) => c.msg.text)).toContain('PEER-RESULT'), WAIT)
    await vi.waitFor(() => expect(h.reports().some((c) => c.msg.text.includes(finished(child)))).toBe(true), WAIT)
    await h.settled()
    await vi.waitFor(async () => expect(await rowOf(h.d, child)).toMatchObject({ state: 'done' }), WAIT)
    await h.daemon.stop()
  })

  it('stops the round with its queued input, and only an explicit later message starts new work', async () => {
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(h.d)
    h.rt.behavior.subQueue.push('hang')
    const created = await send(h.d, caller, { action: 'messageSubsession', message: 'long task' })
    const child: string = created.childSessionId
    await vi.waitFor(() => expect(h.rt.subPrompts).toHaveLength(1), WAIT)
    expect((await h.d.collab.continueSubsession(continuation(caller, child, 'queued'))).delivered).toBe(true)
    await h.d.interruptTurn('bot-a', child, 'stop')
    await vi.waitFor(() => expect(h.reports()).toHaveLength(1), WAIT)
    await h.settled()
    expect(h.rt.subPrompts).toHaveLength(1)
    expect(h.reports()[0]!.msg.text).toBe(
      `[sub-session ended] Sub-session ${child} stopped before finishing (stop). Anything it sent before this is all it reported. To give it more work in the same context, call sendMessage with {"action":"messageSubsession","sessionId":"${child}","message":"..."}.\n\n${REPORT_ANSWER_LANGUAGE}`
    )
    await vi.waitFor(async () => expect(await rowOf(h.d, child)).toMatchObject({ state: 'failed' }), WAIT)
    // The child refuses replies of the stopped round, and runs again only when asked.
    expect(await childReply(h.d, caller, subInputs(h.dispatched)[0]!.msg.thread!, 'late')).toEqual({
      delivered: false,
      reason: 'subsession_ended'
    })
    expect((await h.d.collab.continueSubsession(continuation(caller, child, 'try again'))).delivered).toBe(true)
    await vi.waitFor(() => expect(h.reports()).toHaveLength(2), WAIT)
    await h.settled()
    expect(h.rt.subPrompts).toHaveLength(2)
    expect(await rowOf(h.d, child)).toMatchObject({ state: 'done', round: 2 })
    await h.daemon.stop()
  })
})

describe('one submission, one input', () => {
  it('returns the first receipt for a replayed submission, with no second input, slot or round', async () => {
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(h.d)
    const child = await startAndFinish(h, caller)
    const args = { action: 'messageSubsession', sessionId: child, message: 'same text' }
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

describe('admission that cannot be decided yet', () => {
  it('sends one input for two concurrent deliveries of one submission', async () => {
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(h.d)
    const child = await startAndFinish(h, caller)
    const args = { action: 'messageSubsession', sessionId: child, message: 'same call' }
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
    const created = await send(h.d, caller, { action: 'messageSubsession', message: 'task' })
    const child: string = created.childSessionId
    expect(await h.d.store.assistantSubsessions.claimReport('bot-a', child, '{"text":"held"}')).toBe(true)
    const res = await h.d.collab.continueSubsession(continuation(caller, child))
    expect(res).toMatchObject({ delivered: false, targetSession: child, reason: 'subsession_reporting' })
    expect(res.message).toContain('Nothing was sent; end this turn and message it again after the report arrives.')
    expect(await rowOf(h.d, child)).toMatchObject({ state: 'reporting' })
    expect(h.dispatched).toHaveLength(1)
    await h.daemon.stop()
  })
})

describe('the parent stays the child’s origin', () => {
  it('routes the parent’s reciprocal reply through the round accounting, and refuses another session of the agent', async () => {
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(h.d)
    const child = await startAndFinish(h, caller)
    const outward = await h.d.store.ensureOutwardSessionId(child, 'bot-a', Date.now())
    // The parent session's durable origin names the child, as the turn its report woke would.
    const parent = await h.d.store.getSession(caller.key)
    await h.d.store.upsertSession({ ...parent, originSessionId: outward })
    const reply = (from: { scope: string; coordinate: string }, channel = 'C1') =>
      h.d.collab.replyToSession({
        callerAgentId: 'bot-a',
        platform: 'slack',
        callerTransportScope: from.scope,
        callerChannel: channel,
        callerThread: from.coordinate,
        sessionId: outward,
        text: 'Yes, keep the old format.'
      })
    expect(await reply(caller)).toEqual({ delivered: true, targetSession: child })
    await vi.waitFor(() => expect(h.reports()).toHaveLength(2), WAIT)
    await h.settled()
    expect(subInputs(h.dispatched)[1]!.callMeta).toMatchObject({ originSessionId: 'sid-parent-1', subsessionRound: 2 })
    expect(await rowOf(h.d, child)).toMatchObject({ state: 'done', round: 2 })
    expect((await h.d.store.getSession(child))?.originSessionId).toBe('sid-parent-1')
    // Another session of the agent whose origin also names the child cannot message it.
    const other = await seedCaller(h.d, 'bot-a', 'C2')
    const otherRec = await h.d.store.getSession(other.key)
    await h.d.store.upsertSession({ ...otherRec, originSessionId: outward })
    expect(await reply(other, 'C2')).toEqual({ delivered: false, reason: 'not_authorized' })
    expect(subInputs(h.dispatched)).toHaveLength(2)
    await h.daemon.stop()
  })

  it('records no standing reply path from the parent into a sub-session that reported to it', async () => {
    const h = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(h.d)
    const child = await startAndFinish(h, caller)
    expect(h.reports()).toHaveLength(1)
    const outward = await h.d.store.ensureOutwardSessionId(child, 'bot-a', Date.now())
    expect(await h.d.store.sessionSources.get(caller.key, outward)).toBeUndefined()
    await h.daemon.stop()
  })

  it('tells a sub-session that its parent is its origin and that a reply does not end its work', () => {
    const standing = buildStandingContext({
      agentName: 'bot-a',
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: 'subsession:1',
      sessionId: 'sid-child-1',
      parentSessionId: 'sid-parent-1',
      envSecretNames: [],
      fileSecrets: [],
      needsReplyToParent: true,
      memoryIndex: '',
      usesMeta: true
    })
    expect(standing.agentMeta).toContain('- Parent session: sid-parent-1')
    expect(standing.parentReplyAppend).toContain(
      '`{"action":"replyToSession","sessionId":"sid-parent-1","message":"..."}`; a reply does not end your work.'
    )
    expect(standing.parentReplyAppend).toContain('the daemon tells your parent automatically')
    expect(standing.parentReplyAppend).not.toContain('Send it exactly once')
  })
})
