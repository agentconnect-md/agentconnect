// Assistant-mode sub-session safeguards (assistant-mode.md §5.6/§5.7): a failure is reported too, and a concurrency cap.
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { executeTool, type MessageAgentReq } from '../src/mcp/ops.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { sessionKey } from '../src/store/local-store.js'
import { isSubsessionCoordinate, subsessionCoordinate } from '../src/session/subsession-coordinate.js'
import { sdkLeaseKey } from '../src/daemon/turn-types.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

const TEST_ORG = '00000000-0000-0000-0000-0000000000a1'
const ON = { enabled: true, responsibleUserId: 'user-1' }

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
  const behavior: { sub: PromptBehavior; plain: PromptBehavior } = { sub: 'answer', plain: 'answer' }
  const subPrompts: string[] = []
  const hostFactory = () => {
    let cancelled: (() => void) | undefined
    return {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => `acp-${randomUUID()}`),
      prompt: vi.fn(async (sessionId: string, blocks: unknown[]) => {
        const sub = JSON.stringify(blocks).includes('background sub-session')
        if (sub) subPrompts.push(sessionId)
        const act = sub ? behavior.sub : behavior.plain
        if (act === 'throw') throw new Error('the runtime exited')
        if (act === 'hang') return await new Promise((resolve) => (cancelled = () => resolve('cancelled')))
        if (typeof act === 'function') return await act(sessionId)
        return 'end_turn'
      }),
      cancel: vi.fn(async () => cancelled?.()),
      stop: vi.fn(async () => {})
    } as any
  }
  return { behavior, subPrompts, hostFactory }
}

async function boot(root: string, opts: { spy?: boolean } = {}) {
  const rt = runtimes()
  const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: rt.hostFactory })
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

/** The caller in the middle of a turn of its append session in C1, which the delegation takes as its parent. */
async function seedCaller(d: any, agentId = 'bot-a') {
  const scope = scopeOf(d, `int-${agentId}`)
  const coordinate = await d.store.resolveAppendCoordinate(agentId, 'C1', scope, 1)
  const key = sessionKey('slack', 'C1', coordinate, agentId, scope)
  await d.store.upsertSession({
    key,
    agentId,
    platform: 'slack',
    channel: 'C1',
    thread: coordinate,
    transportScope: scope,
    acpSessionId: 'acp-parent-1',
    sessionId: 'sid-parent-1',
    state: 'idle',
    lastDeliveredTs: null,
    updatedAt: Date.now()
  })
  return { key, scope, coordinate }
}

const delegation = (
  caller: { scope: string; coordinate: string },
  over: Partial<MessageAgentReq> = {}
): MessageAgentReq => ({
  callerAgentId: 'bot-a',
  platform: 'slack',
  callerChannel: 'C1',
  callerThread: caller.coordinate,
  callerTransportScope: caller.scope,
  toAgentId: 'bot-a',
  text: 'fix the flaky test and open a PR',
  channel: 'C1',
  thread: '100.1',
  postless: true,
  ...over
})

const stateOf = async (d: any, key: string) => (await d.store.assistantSubsessions.get('bot-a', key))?.state

describe('a sub-session that ends without reporting is reported by the daemon', () => {
  it.each<[string, (d: any, key: string) => Promise<void>]>([
    ['error', async () => {}],
    ['stop', async (d, key) => await d.interruptTurn('bot-a', key, 'stop')],
    ['pause', async (d) => await d.interruptAgentTurns('bot-a', 'pause')],
    ['stalled', async (d, key) => await d.interruptTurn('bot-a', key, 'stalled')]
  ])('reports a turn that ended on %s exactly once into the parent', async (reason, end) => {
    const { daemon, d, rt, dispatched, reports, settled } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(d)
    rt.behavior.sub = reason === 'error' ? 'throw' : 'hang'

    const res = await d.collab.messageAgent(delegation(caller))
    await vi.waitFor(() => expect(rt.subPrompts).toHaveLength(1), WAIT)
    await end(d, res.targetSession)
    await vi.waitFor(() => expect(reports()).toHaveLength(1), WAIT)
    await settled()

    const [report] = reports()
    expect(report!.agentId).toBe('bot-a')
    expect(report!.msg).toMatchObject({ channel: 'C1', sessionThread: caller.coordinate })
    expect(report!.msg.text).toBe(
      `[sub-session ended] Sub-session ${res.targetSession} stopped before finishing (${reason}). It sent no result; delegate again if the work is still needed.`
    )
    // It continues the delegation's hop chain and comes from the sub-session.
    expect(report!.callMeta).toMatchObject({ callFrom: 'bot-a', hopCount: 1 })
    expect(reports()).toHaveLength(1)
    expect(await stateOf(d, res.targetSession)).toBe('failed')
    expect(dispatched.filter((c) => isSubsessionCoordinate(c.msg.thread))).toHaveLength(1)
    await daemon.stop()
  })

  it('reports nothing more for a sub-session that already reported, even when its turn then fails', async () => {
    const { daemon, d, rt, dispatched, reports, settled } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(d)
    // The runtime reports through `sendMessage {sessionId}` mid-turn, then dies.
    rt.behavior.sub = async () => {
      const reply = await d.collab.replyToSession({
        callerAgentId: 'bot-a',
        platform: 'slack',
        callerTransportScope: caller.scope,
        callerChannel: 'C1',
        callerThread: dispatched.find((c) => isSubsessionCoordinate(c.msg.thread))!.msg.thread!,
        sessionId: 'sid-parent-1',
        text: 'PR opened'
      })
      expect(reply).toMatchObject({ delivered: true })
      throw new Error('the runtime exited after reporting')
    }

    const res = await d.collab.messageAgent(delegation(caller))
    await vi.waitFor(() => expect(reports()).toHaveLength(1), WAIT)
    await settled()

    expect(reports().map((c) => c.msg.text)).toEqual(['PR opened'])
    expect(await stateOf(d, res.targetSession)).toBe('done')
    await daemon.stop()
  })

  it('settles a cleanly finished sub-session done through its inferred report, with nothing extra', async () => {
    const { daemon, d, reports, settled } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(d)

    const res = await d.collab.messageAgent(delegation(caller))
    await vi.waitFor(() => expect(reports()).toHaveLength(1), WAIT)
    await settled()

    expect(reports()[0]!.msg.text).toMatch(/^\[inferred reply\]/)
    expect(reports()).toHaveLength(1)
    expect(await stateOf(d, res.targetSession)).toBe('done')
    await daemon.stop()
  })

  it('reports nothing for a handover that keeps the delivery, and the replayed turn settles the row', async () => {
    const { daemon, d, rt, reports, settled } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(d)
    rt.behavior.sub = 'hang'

    const res = await d.collab.messageAgent(delegation(caller))
    await vi.waitFor(() => expect(rt.subPrompts).toHaveLength(1), WAIT)
    await d.interruptAgentTurns('bot-a', 'handover', 'handoff')
    await settled()
    expect(reports()).toHaveLength(0)
    expect(await stateOf(d, res.targetSession)).toBe('open')

    // The successor replays the kept delivery in a process that never prompted it.
    d.absorbedContextTs.clear()
    rt.behavior.sub = 'answer'
    await d.replayInbox(new Set(['bot-a']))
    await vi.waitFor(() => expect(reports()).toHaveLength(1), WAIT)
    await settled()
    expect(rt.subPrompts).toHaveLength(2)
    expect(reports()[0]!.msg.text).toMatch(/^\[inferred reply\]/)
    expect(await stateOf(d, res.targetSession)).toBe('done')
    await daemon.stop()
  })

  it('reports a sub-session refused before its first turn, once the interrupt holding admission unwinds', async () => {
    const { daemon, d, rt, reports, settled } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(d)
    // Another conversation of the agent is being stopped: fresh deliveries are refused until it unwinds.
    const release = d.beginActiveDispatch('bot-a', 'slack:C9:other:bot-a')
    d.beginSafetyDrain('bot-a', 'stop', ['slack:C9:other:bot-a'])

    const res = await d.collab.messageAgent(delegation(caller))
    expect(res).toMatchObject({ delivered: true, subsession: true })
    await vi.waitFor(async () => expect(await stateOf(d, res.targetSession)).toBe('failed'), WAIT)
    expect(reports()).toHaveLength(0)
    release()
    await vi.waitFor(() => expect(reports()).toHaveLength(1), WAIT)
    await settled()

    expect(reports()[0]!.msg.text).toContain(
      `Sub-session ${res.targetSession} stopped before finishing (not started: busy)`
    )
    expect(rt.subPrompts).toHaveLength(0)
    await daemon.stop()
  })

  it('while the agent stays paused, the pause gate refuses the report like any other turn', async () => {
    const { daemon, d, rt, reports, settled } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(d)
    rt.behavior.sub = 'hang'

    const res = await d.collab.messageAgent(delegation(caller))
    await vi.waitFor(() => expect(rt.subPrompts).toHaveLength(1), WAIT)
    d.agents.get('bot-a').pause = true
    await d.interruptAgentTurns('bot-a', 'pause')
    await vi.waitFor(() => expect(reports()).toHaveLength(1), WAIT)
    await settled()

    expect(await reports()[0]!.turn).toBeNull()
    expect(await stateOf(d, res.targetSession)).toBe('failed')
    await daemon.stop()
  })

  it('logs and reports nothing when the parent session is gone', async () => {
    const { daemon, d, rt, reports, settled } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(d)
    rt.behavior.sub = 'hang'

    const res = await d.collab.messageAgent(delegation(caller))
    await vi.waitFor(() => expect(rt.subPrompts).toHaveLength(1), WAIT)
    expect(await d.store.deleteSession(caller.key)).toBe(true)
    await d.interruptTurn('bot-a', res.targetSession, 'stop')
    await settled()

    expect(reports()).toHaveLength(0)
    expect(await stateOf(d, res.targetSession)).toBe('failed')
    await daemon.stop()
  })

  it('stays open while a background task owes the sub-session a wake, and that turn settles it', async () => {
    const { daemon, d, rt, dispatched, reports, settled } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(d)
    let leaseKey = ''
    // The turn ends having started a background build, so neither it nor the daemon reports yet.
    rt.behavior.sub = async (sessionId) => {
      const { thread, transportScope } = dispatched[0]!.msg
      const key = sessionKey('slack', 'C1', thread!, 'bot-a', transportScope)
      leaseKey = sdkLeaseKey(d.sessionOwnerKey('bot-a', key), sessionId)
      d.sdkLease.set(leaseKey, {
        agentId: 'bot-a',
        tasks: new Map([['t1', { isSubagent: false, startedAt: 0 }]]),
        settled: [],
        sdkState: 'idle',
        bgWakes: 0,
        armedWakes: 0,
        deliveringWakes: 0,
        drainText: '',
        drainDeliveries: 0
      })
      return 'end_turn'
    }
    const res = await d.collab.messageAgent(delegation(caller))
    const child: string = res.targetSession
    await settled()
    expect(reports()).toHaveLength(0)
    expect(await stateOf(d, child)).toBe('open')

    // The build settles and its wake turn ends without a report: the daemon reports that it ended.
    d.sdkLease.delete(leaseKey)
    const sub = dispatched[0]!.msg
    await d.dispatch(
      'bot-a',
      {
        msgId: 'bgtask:C1:t1',
        traceId: 'bgtask:t1',
        source: 'agent',
        platform: 'slack',
        channel: 'C1',
        thread: sub.thread,
        transportScope: sub.transportScope,
        sender: { id: 'background-task:t1', isBot: true },
        text: '[background task finished] build',
        mentionedBots: [],
        isDm: false
      },
      'int-bot-a'
    )
    await vi.waitFor(() => expect(reports()).toHaveLength(1), WAIT)
    await settled()
    expect(reports()[0]!.msg.text).toContain(`Sub-session ${child} ended without reporting back.`)
    expect(await stateOf(d, child)).toBe('failed')
    await daemon.stop()
  })
})

describe('a sub-session’s own report and the daemon’s end report never both reach the parent', () => {
  const ownReport = (d: any, caller: { scope: string }, thread: string) =>
    d.collab.replyToSession({
      callerAgentId: 'bot-a',
      platform: 'slack',
      callerTransportScope: caller.scope,
      callerChannel: 'C1',
      callerThread: thread,
      sessionId: 'sid-parent-1',
      text: 'PR opened'
    })

  it('delivers only the report already admitted when an interrupt ends the turn before it is recorded', async () => {
    const { daemon, d, rt, dispatched, reports, settled } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(d)
    // Hold the report after the parent admitted it, before its bookkeeping runs.
    let releaseReport!: () => void
    const held = new Promise<void>((resolve) => (releaseReport = resolve))
    const record = d.collab.markChildParentReply.bind(d.collab)
    const holding = vi.spyOn(d.collab, 'markChildParentReply').mockImplementation(async (...args: unknown[]) => {
      await held
      return await record(...args)
    })
    const settling = vi.spyOn(d.collab, 'settleSubsessionTurn')
    let report!: Promise<unknown>
    let endTurn!: (stopReason: string) => void
    rt.behavior.sub = async () => {
      report = ownReport(d, caller, dispatched[0]!.msg.thread!)
      return await new Promise((resolve) => (endTurn = resolve))
    }

    const res = await d.collab.messageAgent(delegation(caller))
    await vi.waitFor(() => expect(holding).toHaveBeenCalled(), WAIT)
    expect(reports()).toHaveLength(1)
    await d.interruptTurn('bot-a', res.targetSession, 'stop')
    endTurn('cancelled')
    await vi.waitFor(() => expect(settling).toHaveBeenCalled(), WAIT)
    releaseReport()
    expect(await report).toMatchObject({ delivered: true })
    await settled()

    expect(reports().map((c) => c.msg.text)).toEqual(['PR opened'])
    expect(await stateOf(d, res.targetSession)).toBe('done')
    await daemon.stop()
  })

  it('refuses a report that arrives after the daemon reported the end, so the parent hears once', async () => {
    const { daemon, d, rt, dispatched, reports, settled } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(d)
    rt.behavior.sub = 'hang'

    const res = await d.collab.messageAgent(delegation(caller))
    await vi.waitFor(() => expect(rt.subPrompts).toHaveLength(1), WAIT)
    await d.interruptTurn('bot-a', res.targetSession, 'stop')
    await vi.waitFor(() => expect(reports()).toHaveLength(1), WAIT)
    await settled()
    expect(await ownReport(d, caller, dispatched[0]!.msg.thread!)).toEqual({
      delivered: false,
      reason: 'subsession_ended'
    })
    await settled()

    expect(reports()).toHaveLength(1)
    expect(reports()[0]!.msg.text).toContain('stopped before finishing (stop)')
    expect(await stateOf(d, res.targetSession)).toBe('failed')
    await daemon.stop()
  })
})

describe('the sub-session cap', () => {
  it('refuses the fourth running sub-session by default, and admits one once another has settled', async () => {
    const { daemon, d, dispatched } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]), { spy: true })
    const caller = await seedCaller(d)

    const opened = []
    for (let i = 0; i < 3; i++) opened.push(await d.collab.messageAgent(delegation(caller)))
    expect(opened.map((r) => r.delivered)).toEqual([true, true, true])
    const refused = await d.collab.messageAgent(delegation(caller))
    expect(refused).toMatchObject({
      delivered: false,
      reason: 'subsession_limit',
      message: 'You already have 3 sub-sessions running, the limit. Finish this here or wait for one to report.'
    })
    expect(await stateOf(d, refused.targetSession)).toBeUndefined()
    expect(d.collab.childSessionLinks.has(refused.targetSession)).toBe(false)
    expect(dispatched).toHaveLength(3)

    await d.store.assistantSubsessions.finish('bot-a', opened[0].targetSession, 'done')
    expect(await d.collab.messageAgent(delegation(caller))).toMatchObject({ delivered: true, subsession: true })
    await daemon.stop()
  })

  it('honors a configured limit, and tells the model through sendMessage', async () => {
    const policy = { ...ON, limits: { maxConcurrentSubsessions: 1 } }
    const { daemon, d, dispatched } = await boot(scaffold([{ id: 'bot-a', assistantMode: policy }]), { spy: true })
    const caller = await seedCaller(d)
    const ctx = {
      agentId: 'bot-a',
      platform: 'slack',
      integrationId: 'int-bot-a',
      transportScope: caller.scope,
      isDm: false,
      channel: 'C1',
      thread: caller.coordinate,
      deliveryThread: '100.1',
      tools: [],
      integrations: [{ id: 'int-bot-a', platform: 'slack' }]
    }
    const deps = { ...d.mcp.deps, canRun: () => true }

    const first = (await executeTool(ctx, 'sendMessage', { toAgent: 'bot-a', message: 'one' }, deps)) as any
    expect(first.wake).toMatchObject({ delivered: true, subsession: true })
    const second = (await executeTool(ctx, 'sendMessage', { toAgent: 'bot-a', message: 'two' }, deps)) as any
    expect(second.wake).toMatchObject({
      delivered: false,
      reason: 'subsession_limit',
      message: 'You already have 1 sub-sessions running, the limit. Finish this here or wait for one to report.'
    })
    expect(second.childSessionId).toBeUndefined()
    expect(dispatched).toHaveLength(1)
    await daemon.stop()
  })

  it('does not count an open row whose sub-session never got a session, once past the start grace', async () => {
    const { daemon, d } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]), { spy: true })
    const caller = await seedCaller(d)
    const long = Date.now() - 11 * 60_000
    const stale = (id: string) => ({
      agentId: 'bot-a',
      childSessionKey: sessionKey('slack', 'C1', subsessionCoordinate(id), 'bot-a', caller.scope),
      parentSessionId: 'sid-parent-1',
      parentSessionKey: caller.key,
      now: long
    })
    for (const id of ['1', '2', '3']) await d.store.assistantSubsessions.open(stale(id))
    expect(await d.collab.messageAgent(delegation(caller))).toMatchObject({ delivered: true, subsession: true })

    // Rows as old whose sessions exist are still running, and still count.
    for (const id of ['4', '5']) {
      const row = stale(id)
      await d.store.assistantSubsessions.open(row)
      await d.store.upsertSession({
        key: row.childSessionKey,
        agentId: 'bot-a',
        platform: 'slack',
        channel: 'C1',
        thread: subsessionCoordinate(id),
        transportScope: caller.scope,
        acpSessionId: `acp-${id}`,
        state: 'prompting',
        lastDeliveredTs: null,
        updatedAt: long
      })
    }
    expect(await d.collab.messageAgent(delegation(caller))).toMatchObject({
      delivered: false,
      reason: 'subsession_limit'
    })
    await daemon.stop()
  })
})

describe('everything that is not a sub-session is unchanged', () => {
  it('caps neither an assistant-mode agent’s peer wakes nor its channel-root self wake', async () => {
    const root = scaffold([
      { id: 'bot-a', assistantMode: { ...ON, limits: { maxConcurrentSubsessions: 1 } } },
      { id: 'bot-b' }
    ])
    const { daemon, d, dispatched } = await boot(root, { spy: true })
    const caller = await seedCaller(d)
    expect(await d.collab.messageAgent(delegation(caller))).toMatchObject({ delivered: true, subsession: true })

    expect(await d.collab.messageAgent(delegation(caller, { toAgentId: 'bot-b' }))).toMatchObject({ delivered: true })
    const channelRoot = await d.collab.messageAgent(
      delegation(caller, {
        postless: undefined,
        thread: '200.2',
        transcriptTs: '200.2',
        agentCallDeliveryId: 'paired-1'
      })
    )
    expect(channelRoot).toEqual({ delivered: true, targetSession: caller.key })
    expect(dispatched).toHaveLength(3)
    await daemon.stop()
  })

  it('leaves a peer’s failed turn unreported and unindexed, as before', async () => {
    const root = scaffold([{ id: 'bot-a', assistantMode: ON }, { id: 'bot-b' }])
    const { daemon, d, rt, dispatched, reports, settled } = await boot(root)
    const caller = await seedCaller(d)
    rt.behavior.plain = 'throw'

    const res = await d.collab.messageAgent(delegation(caller, { toAgentId: 'bot-b', needsReply: true }))
    expect(res).toMatchObject({ delivered: true })
    expect(res.subsession).toBeUndefined()
    await vi.waitFor(() => expect(dispatched).toHaveLength(1), WAIT)
    await settled()

    expect(reports()).toHaveLength(0)
    expect(await d.store.assistantSubsessions.get('bot-b', res.targetSession)).toBeUndefined()
    expect(await d.store.assistantSubsessions.get('bot-a', res.targetSession)).toBeUndefined()
    await daemon.stop()
  })
})
