// Sub-session safeguards for every agent (assistant-mode.md §5.6/§5.7): a failure is reported too, and a concurrency cap.
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import { Daemon } from '../src/daemon.js'
import { REPORT_ANSWER_LANGUAGE, SUBSESSION_IDLE_END_MS, subsessionEndReport } from '../src/collab/coordinator.js'
import { PATROL_SWEEP_INTERVAL_MS } from '../src/assistant/patrol.js'
import { executeTool, type MessageAgentReq } from '../src/mcp/ops.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { sessionKey } from '../src/store/local-store.js'
import { SESSION_MESSAGE_HEADER } from '../src/collab/session-message.js'
import {
  isSubsessionCoordinate,
  patrolCoordinate,
  subsessionCoordinate,
  taskCoordinate
} from '../src/session/subsession-coordinate.js'
import { sdkLeaseKey } from '../src/daemon/turn-types.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

/** What the model received for a delivered message: its prompt when the console shows less (§9.5), else its text. */
const modelText = (msg: { text: string; turnBody?: { prompt?: string } }): string => msg.turnBody?.prompt ?? msg.text

/** A report's or reply's body, without the session-message header the parent sees it under (send-message-guide.md §9.5). */
const body = (text: string): string => text.replace(SESSION_MESSAGE_HEADER, '')

/** The newest message the task at `thread` received from its owning session, which its reply answers (§9.4). */
async function ownerMessage(d: any, scope: string, thread: string): Promise<string> {
  const key = sessionKey('slack', 'C1', thread, 'bot-a', scope)
  const messages = (await d.store.sessionMessages.listFor(key, 50)) as { messageId: string; createdAt: number }[]
  return messages.sort((a, b) => b.createdAt - a.createdAt)[0]!.messageId
}

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
  const behavior: { sub: PromptBehavior; plain: PromptBehavior } = { sub: 'answer', plain: 'answer' }
  const subPrompts: string[] = []
  const hosts: any[] = []
  const hostFactory = () => {
    let cancelled: (() => void) | undefined
    const host = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => `acp-${randomUUID()}`),
      prompt: vi.fn(async (sessionId: string, blocks: unknown[]) => {
        const sub = /’s task “|as a delegated task|a new message for this task/.test(JSON.stringify(blocks))
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

/** How a delegated sub-session's round-end report continues it (send-message-guide.md §8.5). */
const continueHint = (key: string) =>
  `To give it more work in the same context, call sendMessage with {"action":"messageTask","taskId":"${key}","message":"..."}.`
/** The report of a round that stopped before finishing. */
const stoppedReport = (key: string, why: string) =>
  `[task ended] Task ${key} stopped before finishing (${why}). Anything it sent before this is all it reported. ${continueHint(key)}\n\n${REPORT_ANSWER_LANGUAGE}`

describe('the end report the daemon sends for a patrol or approved proposal', () => {
  it('names a patrol a patrol, never a task or a sub-session', () => {
    const thread = patrolCoordinate('p-1')
    expect(subsessionEndReport('k-1', { outcome: 'completed' }, thread)).toBe(
      '[patrol ended] Patrol k-1 ended without reporting back. It sent no result.'
    )
    expect(subsessionEndReport('k-1', { outcome: 'failed' }, thread)).toBe(
      '[patrol ended] Patrol k-1 stopped before finishing (error). It sent no result.'
    )
  })

  it('names an approved proposal an approved proposal', () => {
    const thread = taskCoordinate('t-1')
    expect(subsessionEndReport('k-2', { outcome: 'completed' }, thread)).toBe(
      '[approved proposal ended] Approved proposal k-2 ended without reporting back. It sent no result; delegate a task if the work is still needed.'
    )
    expect(subsessionEndReport('k-2', { outcome: 'interrupted', reason: 'stop' }, thread)).toBe(
      '[approved proposal ended] Approved proposal k-2 stopped before finishing (stop). It sent no result; delegate a task if the work is still needed.'
    )
  })
})

const stateOf = async (d: any, key: string) => (await d.store.assistantSubsessions.get('bot-a', key))?.state
const rowOf = async (d: any, key: string) => await d.store.assistantSubsessions.get('bot-a', key)

/** Hold the agent paused, so the pause gate refuses every fresh delivery, its failure report included. */
async function pauseWith(d: any, rt: ReturnType<typeof runtimes>, delegate: () => Promise<any>) {
  rt.behavior.sub = 'hang'
  const res = await delegate()
  await vi.waitFor(() => expect(rt.subPrompts).toHaveLength(1), WAIT)
  d.agents.get('bot-a').pause = true
  await d.interruptAgentTurns('bot-a', 'pause')
  await vi.waitFor(async () => expect(await rowOf(d, res.targetSession)).toMatchObject({ reportAttempts: 1 }), WAIT)
  return res
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

/** One idle sweep now and one `SUBSESSION_IDLE_END_MS` later: the second reports what the first already saw idle. */
async function sweepAcrossTheWait(d: any, clock: FakeClock) {
  await d.collab.endIdleSubsessions(['bot-a'])
  clock.advance(SUBSESSION_IDLE_END_MS)
  await d.collab.endIdleSubsessions(['bot-a'])
}

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
    expect(body(modelText(report!.msg))).toBe(stoppedReport(res.targetSession, reason))
    // It continues the delegation's hop chain and comes from the sub-session, under a delivery id of its own.
    expect(report!.callMeta).toMatchObject({ callFrom: 'bot-a', hopCount: 1 })
    expect(report!.callMeta.deliveryId).toMatch(/^assistant-report:[0-9a-f]{32}$/)
    expect(reports()).toHaveLength(1)
    await vi.waitFor(async () => expect(await stateOf(d, res.targetSession)).toBe('failed'), WAIT)
    expect(dispatched.filter((c) => isSubsessionCoordinate(c.msg.thread))).toHaveLength(1)
    // Settled, it is not sent again.
    await d.collab.resendSubsessionReports(['bot-a'])
    expect(reports()).toHaveLength(1)
    await daemon.stop()
  })

  it('reports the failure of an agent outside assistant mode the same way', async () => {
    const { daemon, d, rt, reports, settled } = await boot(scaffold([{ id: 'bot-a' }]))
    const caller = await seedCaller(d)
    rt.behavior.sub = 'throw'

    const res = await d.collab.messageAgent(delegation(caller))
    expect(res).toMatchObject({ delivered: true, subsession: true })
    await vi.waitFor(() => expect(reports()).toHaveLength(1), WAIT)
    await settled()

    expect(reports()[0]!.msg).toMatchObject({ channel: 'C1', sessionThread: caller.coordinate })
    expect(body(modelText(reports()[0]!.msg))).toBe(stoppedReport(res.targetSession, 'error'))
    expect(await stateOf(d, res.targetSession)).toBe('failed')
    await daemon.stop()
  })

  it('still reports the failure of a round whose sub-session replied before its turn failed', async () => {
    const { daemon, d, rt, dispatched, reports, settled } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(d)
    // The runtime reports through `sendMessage {sessionId}` mid-turn, then dies.
    rt.behavior.sub = async () => {
      const thread = dispatched.find((c) => isSubsessionCoordinate(c.msg.thread))!.msg.thread!
      const reply = await d.collab.replyToSession({
        callerAgentId: 'bot-a',
        platform: 'slack',
        callerTransportScope: caller.scope,
        callerChannel: 'C1',
        callerThread: thread,
        messageId: await ownerMessage(d, caller.scope, thread),
        text: 'PR opened'
      })
      expect(reply).toMatchObject({ delivered: true })
      throw new Error('the runtime exited after reporting')
    }

    const res = await d.collab.messageAgent(delegation(caller))
    await vi.waitFor(() => expect(reports()).toHaveLength(2), WAIT)
    await settled()

    // send-message-guide.md §8.3: the reply is a message, not the round's outcome.
    expect(reports().map((c) => body(modelText(c.msg)))).toEqual([
      'PR opened',
      stoppedReport(res.targetSession, 'error')
    ])
    expect(await stateOf(d, res.targetSession)).toBe('failed')
    await daemon.stop()
  })

  it('settles a cleanly finished sub-session done through its round-end report, with nothing extra', async () => {
    const { daemon, d, reports, settled } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(d)

    const res = await d.collab.messageAgent(delegation(caller))
    await vi.waitFor(() => expect(reports()).toHaveLength(1), WAIT)
    await settled()

    expect(body(modelText(reports()[0]!.msg))).toMatch(/^\[task finished\]/)
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

    // The same process replays the kept delivery its cut prompt already carried.
    rt.behavior.sub = 'answer'
    await d.replayInbox(new Set(['bot-a']))
    await vi.waitFor(() => expect(reports()).toHaveLength(1), WAIT)
    await settled()
    expect(rt.subPrompts).toHaveLength(2)
    expect(body(modelText(reports()[0]!.msg))).toMatch(/^\[task finished\]/)
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
    await vi.waitFor(async () => expect(await stateOf(d, res.targetSession)).toBe('reporting'), WAIT)
    expect(reports()).toHaveLength(0)
    release()
    await vi.waitFor(() => expect(reports()).toHaveLength(1), WAIT)
    await settled()
    await vi.waitFor(async () => expect(await stateOf(d, res.targetSession)).toBe('failed'), WAIT)

    expect(body(modelText(reports()[0]!.msg))).toContain(
      `Task ${res.targetSession} stopped before finishing (not started: busy)`
    )
    expect(rt.subPrompts).toHaveLength(0)
    await daemon.stop()
  })

  it('keeps a report the pause gate refused, and the sweep delivers it once the agent resumes', async () => {
    const { daemon, d, rt, reports, settled } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(d)

    const res = await pauseWith(d, rt, () => d.collab.messageAgent(delegation(caller)))
    await settled()
    expect(reports()).toHaveLength(1)
    expect(await reports()[0]!.turn).toBeNull()
    expect(await stateOf(d, res.targetSession)).toBe('reporting')

    d.agents.get('bot-a').pause = false
    await d.collab.resendSubsessionReports(['bot-a'])
    await settled()
    expect(reports()).toHaveLength(2)
    expect(await reports()[1]!.turn).not.toBeNull()
    // One report, sent twice under the one delivery id.
    expect(reports()[1]!.callMeta.deliveryId).toBe(reports()[0]!.callMeta.deliveryId)
    expect(body(modelText(reports()[1]!.msg))).toContain(`Task ${res.targetSession} stopped before finishing (pause)`)
    expect(await rowOf(d, res.targetSession)).toMatchObject({ state: 'failed', reportAttempts: 1 })
    await d.collab.resendSubsessionReports(['bot-a'])
    expect(reports()).toHaveLength(2)
    await daemon.stop()
  })

  it('gives up a report refused three times, with a WARN naming the sub-session and why', async () => {
    const { daemon, d, rt, reports, settled } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(d)
    const warn = vi.spyOn(d.log, 'warn')

    const res = await pauseWith(d, rt, () => d.collab.messageAgent(delegation(caller)))
    await d.collab.resendSubsessionReports(['bot-a'])
    expect(await rowOf(d, res.targetSession)).toMatchObject({ state: 'reporting', reportAttempts: 2 })
    expect(warn.mock.calls.some(([m]) => String(m).includes(`sub-session ${res.targetSession} ended`))).toBe(false)
    await d.collab.resendSubsessionReports(['bot-a'])
    await settled()

    expect(await rowOf(d, res.targetSession)).toMatchObject({ state: 'failed', reportAttempts: 3 })
    expect(reports()).toHaveLength(3)
    expect(warn).toHaveBeenCalledWith(
      `sub-session ${res.targetSession} ended without a report, and its end report was not delivered (paused, 3 attempts); none sent`
    )
    await d.collab.resendSubsessionReports(['bot-a'])
    expect(reports()).toHaveLength(3)
    await daemon.stop()
  })

  it('logs and reports nothing when the parent session is gone', async () => {
    const { daemon, d, rt, reports, settled } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(d)
    const warn = vi.spyOn(d.log, 'warn')
    rt.behavior.sub = 'hang'

    const res = await d.collab.messageAgent(delegation(caller))
    await vi.waitFor(() => expect(rt.subPrompts).toHaveLength(1), WAIT)
    expect(await d.store.deleteSession(caller.key)).toBe(true)
    await d.interruptTurn('bot-a', res.targetSession, 'stop')
    await settled()

    await vi.waitFor(async () => expect(await stateOf(d, res.targetSession)).toBe('failed'), WAIT)
    expect(reports()).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith(
      `sub-session ${res.targetSession} ended without a report, and its end report was not delivered (its parent session is gone); none sent`
    )
    await daemon.stop()
  })

  it('reports into the conversation’s current session after `!new`, not the one that delegated', async () => {
    const { daemon, d, rt, reports, settled } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(d)
    rt.behavior.sub = 'hang'

    const res = await d.collab.messageAgent(delegation(caller))
    await vi.waitFor(() => expect(rt.subPrompts).toHaveLength(1), WAIT)
    const next = await rotate(d, caller)
    await d.interruptTurn('bot-a', res.targetSession, 'stop')
    await vi.waitFor(() => expect(reports()).toHaveLength(1), WAIT)
    await settled()

    expect(next).not.toBe(caller.coordinate)
    expect(reports()[0]!.msg).toMatchObject({ channel: 'C1', sessionThread: next })
    expect(body(modelText(reports()[0]!.msg))).toContain(`Task ${res.targetSession} stopped before finishing (stop)`)
    // The new session cannot continue the child, so the report does not tell it to.
    expect(body(modelText(reports()[0]!.msg))).not.toContain(continueHint(res.targetSession))
    expect(body(modelText(reports()[0]!.msg))).toContain('belongs to an earlier session of this conversation')
    expect(await rowOf(d, res.targetSession)).toMatchObject({ state: 'failed', parentSessionId: 'sid-parent-1' })
    await daemon.stop()
  })

  it('stays open while a background task owes the sub-session a wake, and that turn settles it', async () => {
    const clock = new FakeClock(Date.now())
    const root = scaffold([{ id: 'bot-a', assistantMode: ON }])
    const { daemon, d, rt, dispatched, reports, settled } = await boot(root, { clock })
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
    // However long the build takes, the idle sweep leaves it to the wake.
    await sweepAcrossTheWait(d, clock)
    expect(reports()).toHaveLength(0)
    expect(await stateOf(d, child)).toBe('open')

    // The build settles and its wake turn ends: the daemon reports that the round finished.
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
    expect(body(modelText(reports()[0]!.msg))).toContain(`Task ${child} finished this round of work`)
    await vi.waitFor(async () => expect(await stateOf(d, child)).toBe('done'), WAIT)
    await daemon.stop()
  })
})

describe('a failure report survives a drain or a crash', () => {
  it('leaves a report a drain held back in `reporting`, and the next start sends it once', async () => {
    const { daemon, d, rt, reports, settled } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(d)
    rt.behavior.sub = 'hang'

    const res = await d.collab.messageAgent(delegation(caller))
    await vi.waitFor(() => expect(rt.subPrompts).toHaveLength(1), WAIT)
    // The daemon starts draining as the sub-session is stopped.
    d.draining = true
    await d.interruptTurn('bot-a', res.targetSession, 'stop')
    await settled()
    await vi.waitFor(async () => expect(await stateOf(d, res.targetSession)).toBe('reporting'), WAIT)
    await d.collab.resendSubsessionReports(['bot-a'])
    expect(reports()).toHaveLength(0)
    expect(await rowOf(d, res.targetSession)).not.toHaveProperty('reportAttempts')

    d.draining = false
    await d.replayInbox(new Set(['bot-a']))
    await settled()
    await d.replayInbox(new Set(['bot-a']))
    await settled()

    expect(reports()).toHaveLength(1)
    expect(body(modelText(reports()[0]!.msg))).toContain(`Task ${res.targetSession} stopped before finishing (stop)`)
    expect(await stateOf(d, res.targetSession)).toBe('failed')
    await daemon.stop()
  })

  it('sends nothing again for a report already admitted when a crash kept it from settling', async () => {
    const { daemon, d, rt, reports, settled } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(d)
    rt.behavior.sub = 'hang'
    // The process dies once the report is in, before the row settles.
    const index = d.store.assistantSubsessions
    const settleReport = index.settleReport.bind(index)
    let crashed = false
    index.settleReport = async (...args: [string, string]) => {
      if (crashed) return await settleReport(...args)
      crashed = true
      throw new Error('the daemon was killed')
    }

    const res = await d.collab.messageAgent(delegation(caller))
    await vi.waitFor(() => expect(rt.subPrompts).toHaveLength(1), WAIT)
    await d.interruptTurn('bot-a', res.targetSession, 'stop')
    await vi.waitFor(() => expect(crashed).toBe(true), WAIT)
    await settled()
    expect(reports()).toHaveLength(1)
    expect(await stateOf(d, res.targetSession)).toBe('reporting')

    // The next start finds it still reporting; the receipt says it is already in.
    await d.replayInbox(new Set(['bot-a']))
    await settled()
    expect(reports()).toHaveLength(1)
    expect(told(rt.hosts, `Task ${res.targetSession} stopped before finishing`)).toBe(1)
    expect(await stateOf(d, res.targetSession)).toBe('failed')
    await daemon.stop()
  })
})

describe('a sub-session’s own report and the daemon’s end report never both reach the parent', () => {
  const ownReport = async (d: any, caller: { scope: string }, thread: string) =>
    d.collab.replyToSession({
      callerAgentId: 'bot-a',
      platform: 'slack',
      callerTransportScope: caller.scope,
      callerChannel: 'C1',
      callerThread: thread,
      messageId: await ownerMessage(d, caller.scope, thread),
      text: 'PR opened'
    })

  it('delivers the reply already admitted and then the stop of its round when an interrupt ends the turn', async () => {
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
    // The parent's later prompt names sub-sessions too; it answers.
    rt.behavior.sub = 'answer'
    await vi.waitFor(() => expect(settling).toHaveBeenCalled(), WAIT)
    releaseReport()
    expect(await report).toMatchObject({ delivered: true })
    await settled()

    await vi.waitFor(async () => expect(await stateOf(d, res.targetSession)).toBe('failed'), WAIT)
    expect(reports().map((c) => body(modelText(c.msg)))).toEqual([
      'PR opened',
      stoppedReport(res.targetSession, 'stop')
    ])
    await daemon.stop()
  })

  it('refuses its own report while the daemon’s end report is still on its way', async () => {
    const { daemon, d, rt, dispatched, reports, settled } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const caller = await seedCaller(d)

    const res = await pauseWith(d, rt, () => d.collab.messageAgent(delegation(caller)))
    expect(await stateOf(d, res.targetSession)).toBe('reporting')
    expect(await ownReport(d, caller, dispatched[0]!.msg.thread!)).toEqual({
      delivered: false,
      inReplyTo: expect.any(String),
      reason: 'task_ended'
    })
    await settled()

    expect(reports().map((c) => body(modelText(c.msg)))).toEqual([
      expect.stringContaining('stopped before finishing (pause)')
    ])
    expect(await stateOf(d, res.targetSession)).toBe('reporting')
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
      inReplyTo: expect.any(String),
      reason: 'task_ended'
    })
    await settled()

    expect(reports()).toHaveLength(1)
    expect(body(modelText(reports()[0]!.msg))).toContain('stopped before finishing (stop)')
    expect(await stateOf(d, res.targetSession)).toBe('failed')
    await daemon.stop()
  })
})

describe('the sub-session cap', () => {
  it.each<[string, Record<string, unknown> | undefined]>([
    ['in assistant mode', ON],
    ['outside assistant mode', undefined]
  ])(
    'refuses the fourth running sub-session by default %s, and admits one once another has settled',
    async (_mode, assistantMode) => {
      const agent = { id: 'bot-a', ...(assistantMode ? { assistantMode } : {}) }
      const { daemon, d, dispatched } = await boot(scaffold([agent]), { spy: true })
      const caller = await seedCaller(d)

      const opened = []
      for (let i = 0; i < 3; i++) opened.push(await d.collab.messageAgent(delegation(caller)))
      expect(opened.map((r) => r.delivered)).toEqual([true, true, true])
      const refused = await d.collab.messageAgent(delegation(caller))
      expect(refused).toMatchObject({
        delivered: false,
        reason: 'task_limit',
        message:
          'You already have 3 tasks running, the most allowed at once. Finish this here, or wait until one of them reports.'
      })
      expect(await stateOf(d, refused.targetSession)).toBeUndefined()
      expect(d.collab.childSessionLinks.has(refused.targetSession)).toBe(false)
      expect(dispatched).toHaveLength(3)

      await d.store.assistantSubsessions.finish('bot-a', opened[0].targetSession, 'done')
      expect(await d.collab.messageAgent(delegation(caller))).toMatchObject({ delivered: true, subsession: true })
      await daemon.stop()
    }
  )

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

    const first = (await executeTool(ctx, 'sendMessage', { action: 'delegateTask', message: 'one' }, deps)) as any
    expect(first.wake).toMatchObject({ delivered: true, subsession: true })
    const second = (await executeTool(ctx, 'sendMessage', { action: 'delegateTask', message: 'two' }, deps)) as any
    expect(second.wake).toMatchObject({
      delivered: false,
      reason: 'task_limit',
      message:
        'You already have 1 task running, the most allowed at once. Finish this here, or wait until one of them reports.'
    })
    expect(second.taskId).toBeUndefined()
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
      reason: 'task_limit'
    })
    await daemon.stop()
  })
})

describe('an open sub-session nothing runs for any more', () => {
  /** One run of the daemon's own minute sweep. */
  const tick = async (d: any, clock: FakeClock) => {
    clock.advance(PATROL_SWEEP_INTERVAL_MS)
    await vi.waitFor(() => expect(d.patrolSweepTimer).toBeDefined(), WAIT)
  }

  it('is reported ended once nothing runs for it any more, and frees its slot', async () => {
    const clock = new FakeClock(Date.now())
    const policy = { ...ON, limits: { maxConcurrentSubsessions: 1 } }
    const root = scaffold([{ id: 'bot-a', assistantMode: policy }])
    const { daemon, d, rt, reports, settled } = await boot(root, { clock })
    const caller = await seedCaller(d)
    rt.behavior.sub = 'hang'

    const res = await d.collab.messageAgent(delegation(caller))
    await vi.waitFor(() => expect(rt.subPrompts).toHaveLength(1), WAIT)
    // A handover keeps the delivery, and a purge then drops it before anything replays it: nothing runs.
    await d.interruptAgentTurns('bot-a', 'handover', 'handoff')
    await settled()
    for (const row of await d.store.listInboxBySessionKeyFifo()) await d.store.removeInbox(row.id)
    rt.behavior.sub = 'answer'
    expect(rt.subPrompts).toHaveLength(1)
    expect(await stateOf(d, res.targetSession)).toBe('open')
    expect(await d.collab.messageAgent(delegation(caller))).toMatchObject({
      delivered: false,
      reason: 'task_limit'
    })

    // The first sweep finds nothing running for it; the one ten minutes on reports it ended.
    const sweeps = SUBSESSION_IDLE_END_MS / PATROL_SWEEP_INTERVAL_MS
    for (let i = 0; i < sweeps; i++) await tick(d, clock)
    expect(reports()).toHaveLength(0)
    await tick(d, clock)
    await vi.waitFor(() => expect(reports()).toHaveLength(1), WAIT)
    await settled()

    const [report] = reports()
    expect(report!.msg).toMatchObject({ channel: 'C1', sessionThread: caller.coordinate })
    expect(body(modelText(report!.msg))).toBe(stoppedReport(res.targetSession, 'no longer running'))
    expect(await stateOf(d, res.targetSession)).toBe('failed')
    await sweepAcrossTheWait(d, clock)
    expect(reports()).toHaveLength(1)
    expect(await d.collab.messageAgent(delegation(caller))).toMatchObject({ delivered: true, subsession: true })
    await settled()
    await daemon.stop()
  })

  it('reports a delegation that never got a session through its parent’s place', async () => {
    const clock = new FakeClock(Date.now())
    const { daemon, d, reports } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]), { spy: true, clock })
    const caller = await seedCaller(d)

    const res = await d.collab.messageAgent(delegation(caller))
    await sweepAcrossTheWait(d, clock)

    expect(reports()).toHaveLength(1)
    expect(reports()[0]!.msg).toMatchObject({ channel: 'C1', sessionThread: caller.coordinate })
    expect(body(modelText(reports()[0]!.msg))).toContain(
      `Task ${res.targetSession} stopped before finishing (no longer running)`
    )
    expect(await stateOf(d, res.targetSession)).toBe('failed')
    await daemon.stop()
  })

  it('leaves a running turn, a delivery kept for replay, a paused agent and an approved task alone', async () => {
    const clock = new FakeClock(Date.now())
    const { daemon, d, rt, reports, settled } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]), { clock })
    const caller = await seedCaller(d)
    rt.behavior.sub = 'hang'

    // Running, past the wait.
    const running = await d.collab.messageAgent(delegation(caller))
    await vi.waitFor(() => expect(rt.subPrompts).toHaveLength(1), WAIT)
    await sweepAcrossTheWait(d, clock)
    expect(await stateOf(d, running.targetSession)).toBe('open')

    // Cut by a handover, its delivery waits in the inbox for whoever replays it.
    await d.interruptAgentTurns('bot-a', 'handover', 'handoff')
    await settled()
    await sweepAcrossTheWait(d, clock)
    expect(await stateOf(d, running.targetSession)).toBe('open')

    // An approved task's row settles with its record, through the task's own recovery.
    const task = sessionKey('slack', 'C1', taskCoordinate('77'), 'bot-a', caller.scope)
    await d.store.assistantSubsessions.open({
      agentId: 'bot-a',
      childSessionKey: task,
      parentSessionId: 'sid-parent-1',
      parentSessionKey: caller.key
    })
    // A purge drops the kept delivery, and while the agent is paused nothing is reported.
    for (const row of await d.store.listInboxBySessionKeyFifo()) await d.store.removeInbox(row.id)
    d.agents.get('bot-a').pause = true
    await sweepAcrossTheWait(d, clock)
    expect(await stateOf(d, running.targetSession)).toBe('open')

    d.agents.get('bot-a').pause = false
    await sweepAcrossTheWait(d, clock)
    await settled()
    expect(reports().map((c) => body(modelText(c.msg)))).toEqual([
      expect.stringContaining(`Task ${running.targetSession} stopped before finishing (no longer running)`)
    ])
    expect(await stateOf(d, task)).toBe('open')
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
