// Follow-ups (assistant-mode.md §5.12): read-only checks in one retained session, woken by a due next check or a message from their place, silent unless something changed.
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { executeTool, type MessageAgentReq, type SessionContext } from '../src/mcp/ops.js'
import { FOLLOW_UP_TOOL, RECORD_CHECK_ARGS, RECORD_CHECK_TOOL } from '../src/mcp/ops/assistant-items.js'
import { LIST_TASKS_TOOL, STOP_TASK_TOOL } from '../src/mcp/ops/assistant-subsessions.js'
import { DEFAULT_DAILY_CHECK_BUDGET, checkPrompt, checkTools } from '../src/assistant/follow-up-checks.js'
import { createAssistantActivity } from '../src/cp/assistant-activity.js'
import { toolsForIntegrations } from '../src/mcp/tools.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { CLAUDE_HEADLESS_DISALLOWED_TOOLS } from '../src/runtime-defs/claude-runtime.js'
import { isCheckCoordinate, isSubsessionCoordinate } from '../src/session/subsession-coordinate.js'
import type { AssistantItem } from '../src/store/assistant-items.js'
import { CHECK_MAX_FAILURES } from '../src/store/assistant-checks.js'
import { sessionKey } from '../src/store/local-store.js'
import type { ObjectToolSchema } from '../src/tool-schema/descriptor.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'
import { z } from 'zod'

/** What the model received for a delivered message: its prompt when the console shows less (§9.5), else its text. */
const modelText = (msg: { text: string; turnBody?: { prompt?: string } }): string => msg.turnBody?.prompt ?? msg.text

const TEST_ORG = '00000000-0000-0000-0000-0000000000a1'
const ON = { enabled: true }
const MINUTE = 60_000
const CHECK_OPENING = '[follow-up check] A read-only check'
// The check writes in its people's language, and the conversation answers in it whatever the report's.
const CHECK_LANGUAGE =
  'Write `report` and `propose`’s sentence in the language the people in its conversation use; without a message ' +
  'of theirs to go by, use the language of its title and summary.'
const ANSWER_LANGUAGE = 'Speak to the people here in the language they use, even when this report is in another.'

/** One Slack agent per entry, each appending in `C1`. */
function scaffold(agents: { id: string; assistantMode?: Record<string, unknown>; permissionMode?: string }[]): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-follow-up-'))
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
        ...(a.permissionMode ? { permissionMode: a.permissionMode } : {}),
        ...(a.assistantMode ? { assistantMode: a.assistantMode } : {})
      })
    )
  }
  return root
}

/** What a check's runtime does with its prompt, given the bridge context the check was registered with. */
type CheckBehavior = (ctx: SessionContext) => Promise<unknown>

async function boot(root: string) {
  const behavior: { check: CheckBehavior | 'hang' | 'throw' } = { check: async () => 'end_turn' }
  const hosts: any[] = []
  const hostFactory = () => {
    let cancelled: (() => void) | undefined
    const modes = new Map<string, string>()
    const host = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => `acp-${randomUUID()}`),
      permissionModeOptions: vi.fn((sessionId?: string) => ({
        current: sessionId ? modes.get(sessionId) : undefined,
        modes: ['default', 'acceptEdits', 'plan', 'bypassPermissions']
      })),
      setSessionPermissionMode: vi.fn(async (sessionId: string, mode: string) => {
        modes.set(sessionId, mode)
        return true
      }),
      prompt: vi.fn(async (_sessionId: string, blocks: unknown[]) => {
        if (!JSON.stringify(blocks).includes(CHECK_OPENING)) return 'end_turn'
        if (behavior.check === 'throw') throw new Error('the runtime exited')
        if (behavior.check === 'hang') return await new Promise((resolve) => (cancelled = () => resolve('cancelled')))
        const ctx = [...registered].reverse().find((c) => isCheckCoordinate(c.thread))!
        // A behavior that never returns waits, like `hang`, until the turn is cancelled.
        return await Promise.race([
          behavior.check(ctx).then(() => 'end_turn'),
          new Promise((resolve) => (cancelled = () => resolve('cancelled')))
        ])
      }),
      cancel: vi.fn(async () => cancelled?.()),
      stop: vi.fn(async () => {})
    } as any
    hosts.push(host)
    return host
  }
  const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory })
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
  // The bridge context every session is registered with, as the runtime's tool calls would carry it.
  const registered: SessionContext[] = []
  const register = d.mcp.register.bind(d.mcp)
  d.mcp.register = (ctx: SessionContext) => {
    registered.push(ctx)
    return register(ctx)
  }
  const dispatched: { agentId: string; msg: NormalizedMessage; callMeta?: any; turn: Promise<unknown> }[] = []
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
  const checks = () => dispatched.filter((c) => isCheckCoordinate(c.msg.thread))
  const reports = () => dispatched.filter((c) => c.msg.parentReport === true)
  /** Every turn dispatched so far, and any it dispatched in turn, has settled, and so has the check bookkeeping. */
  const settled = async () => {
    for (let seen = -1; seen !== dispatched.length;) {
      seen = dispatched.length
      await Promise.all(dispatched.map((c) => c.turn))
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  const deps = { ...d.mcp.deps, canRun: () => true }
  return { daemon, d, behavior, hosts, registered, dispatched, checks, reports, settled, deps }
}

const scopeOf = (d: any, agentId = 'bot-a'): string => d.transportScopeForIntegrationIds([`int-${agentId}`])

/** The conversation's long session in C1, which a follow-up taken there belongs to. */
async function seedPlace(d: any, agentId = 'bot-a') {
  const scope = scopeOf(d, agentId)
  const coordinate = await d.store.resolveAppendCoordinate(agentId, 'C1', scope, 1)
  const key = sessionKey('slack', 'C1', coordinate, agentId, scope)
  await d.store.upsertSession({
    key,
    agentId,
    platform: 'slack',
    channel: 'C1',
    thread: coordinate,
    transportScope: scope,
    acpSessionId: `acp-parent-${agentId}`,
    sessionId: `sid-parent-${agentId}`,
    state: 'idle',
    lastDeliveredTs: null,
    updatedAt: Date.now()
  })
  return { key, scope, coordinate }
}

/** Take a follow-up in C1, as `followUp` would for Alice. */
async function takeFollowUp(
  d: any,
  over: { agentId?: string; nextCheck?: number | null; title?: string; replyThread?: string } = {}
): Promise<AssistantItem> {
  const agentId = over.agentId ?? 'bot-a'
  const scope = scopeOf(d, agentId)
  const nextCheck = over.nextCheck === undefined ? Date.now() - MINUTE : over.nextCheck
  return await d.followUpChecks.take({
    agentId,
    origin: { platform: 'slack', channel: 'C1', transportScope: scope },
    caller: { sessionId: `sid-parent-${agentId}`, key: sessionKey('slack', 'C1', 'append:0', agentId, scope) },
    title: over.title ?? 'Watch the release build',
    doneWhen: 'The release is published',
    ...(nextCheck !== null ? { nextCheck } : {}),
    summary: 'Alice asked to hear when the release is out.',
    asker: 'slack:T0EXAMPLE:U0ALICE',
    ...(over.replyThread !== undefined ? { replyThread: over.replyThread } : {})
  })
}

/** A check that saw nothing new: what it saw and the next check, no report. */
const quiet =
  (deps: any): CheckBehavior =>
  async (ctx) => {
    await executeTool(
      ctx,
      'recordCheck',
      { observation: 'The build is still running.', nextCheck: new Date(Date.now() + 60 * MINUTE).toISOString() },
      deps
    )
  }

/** A check that saw a change: it records it as done and reports it, after `first` ran in its turn. */
const reporting =
  (deps: any, first: () => Promise<void> = async () => {}): CheckBehavior =>
  async (ctx) => {
    await first()
    await executeTool(
      ctx,
      'recordCheck',
      { observation: 'The release is published.', done: true, report: 'The release is out.' },
      deps
    )
  }

const checkState = (d: any, itemId: string) => d.store.assistantChecks.get('bot-a', itemId)

/** The place's long session in C1, as its bridge context would carry it. */
const placeCtx = (place: { coordinate: string; scope: string }): SessionContext => ({
  agentId: 'bot-a',
  platform: 'slack',
  integrationId: 'int-bot-a',
  transportScope: place.scope,
  isDm: false,
  channel: 'C1',
  thread: place.coordinate,
  deliveryThread: '100.1',
  tools: [FOLLOW_UP_TOOL, LIST_TASKS_TOOL, STOP_TASK_TOOL]
})

/** `messageTask` from a session of C1 to a follow-up. */
const message = (d: any, from: { coordinate: string; scope: string }, taskId: string, text: string) =>
  d.collab.continueSubsession({
    callerAgentId: 'bot-a',
    platform: 'slack',
    callerChannel: 'C1',
    callerThread: from.coordinate,
    callerTransportScope: from.scope,
    sessionId: taskId,
    text,
    submissionId: randomUUID()
  })

describe('a due next check wakes one check', () => {
  it('checks a due follow-up once, in its own read-only session of the place, and stays silent when nothing changed', async () => {
    const { daemon, d, behavior, hosts, checks, reports, settled, deps } = await boot(
      scaffold([{ id: 'bot-a', assistantMode: ON, permissionMode: 'bypassPermissions' }])
    )
    const place = await seedPlace(d)
    const item = await takeFollowUp(d)
    behavior.check = quiet(deps)

    await d.followUpChecks.sweep()
    await vi.waitFor(() => expect(checks()).toHaveLength(1), WAIT)
    await settled()

    const [check] = checks()
    expect(check!.msg).toMatchObject({ channel: 'C1', source: 'agent', headless: true })
    expect(isSubsessionCoordinate(check!.msg.thread)).toBe(true)
    expect(sessionKey('slack', 'C1', check!.msg.thread!, 'bot-a', place.scope)).toBe(item.taskKey)
    expect(modelText(check!.msg)).toContain(`Follow-up ${item.taskKey}`)
    expect(modelText(check!.msg)).toContain('Watch the release build')
    // It belongs to the place's long session, and owes no report back.
    expect(check!.callMeta).toMatchObject({ callFrom: 'bot-a', hopCount: 0, originSessionId: 'sid-parent-bot-a' })
    expect(check!.callMeta.needsReply).toBeUndefined()
    expect(await d.store.assistantSubsessions.get('bot-a', item.taskKey)).toMatchObject({
      kind: 'follow-up',
      state: 'done',
      parentSessionId: 'sid-parent-bot-a',
      parentSessionKey: place.key
    })
    expect(await d.store.getSession(item.taskKey)).toMatchObject({ originSessionId: 'sid-parent-bot-a' })
    // Nothing changed, so nothing reached the conversation; the check is in its log.
    expect(reports()).toHaveLength(0)
    const after = await d.store.assistantItems.get('bot-a', item.id)
    expect(after.observations.map((o: any) => [o.text, o.author])).toEqual([['The build is still running.', 'check']])
    expect(after).toMatchObject({ status: 'active' })
    expect(await d.store.assistantChecks.checks('bot-a', item.id, 10)).toEqual([
      expect.objectContaining({ checkNo: 1, observation: 'The build is still running.', reported: false })
    ])

    // The runtime's own read-only mode, never the agent's, and no plan-mode exit nobody could approve.
    const host = hosts.find((h) => h.prompt.mock.calls.some((c: any) => JSON.stringify(c).includes(CHECK_OPENING)))
    const checkSession = host.prompt.mock.calls.find((c: any) => JSON.stringify(c).includes(CHECK_OPENING))[0]
    expect(
      host.setSessionPermissionMode.mock.calls.filter((c: any) => c[0] === checkSession).map((c: any) => c[1])
    ).toEqual(['plan'])
    expect(host.newSession.mock.calls.at(-1)?.[6]).toEqual(CLAUDE_HEADLESS_DISALLOWED_TOOLS)

    // Not again for the same next check, however often the sweep runs.
    await d.followUpChecks.sweep()
    await d.followUpChecks.sweep()
    await settled()
    expect(checks()).toHaveLength(1)
    await daemon.stop()
  })

  it('runs every check of a follow-up in the same retained session', async () => {
    const { daemon, d, behavior, checks, settled, deps } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    await seedPlace(d)
    const item = await takeFollowUp(d)
    behavior.check = quiet(deps)
    await d.followUpChecks.sweep()
    await vi.waitFor(() => expect(checks()).toHaveLength(1), WAIT)
    await settled()
    await d.store.assistantItems.schedule('bot-a', item.id, { status: 'active', nextCheck: Date.now() - 1_000 })
    await d.followUpChecks.sweep()
    await vi.waitFor(() => expect(checks()).toHaveLength(2), WAIT)
    await settled()
    expect(checks()[1]!.msg.thread).toBe(checks()[0]!.msg.thread)
    // The second check is handed what the first one saw.
    expect(modelText(checks()[1]!.msg)).toContain('The build is still running.')
    expect((await d.store.assistantChecks.checks('bot-a', item.id, 10)).map((c: any) => c.checkNo)).toEqual([2, 1])
    await daemon.stop()
  })

  it('reports a change into the conversation the follow-up belongs to, once', async () => {
    const { daemon, d, behavior, hosts, checks, reports, settled, deps } = await boot(
      scaffold([{ id: 'bot-a', assistantMode: ON }])
    )
    const place = await seedPlace(d)
    const item = await takeFollowUp(d)
    behavior.check = reporting(deps)

    await d.followUpChecks.sweep()
    await vi.waitFor(() => expect(reports()).toHaveLength(1), WAIT)
    await settled()

    const [report] = reports()
    expect(report!.msg).toMatchObject({ channel: 'C1', sessionThread: place.coordinate, source: 'agent' })
    expect(modelText(report!.msg)).toContain(
      `The check of follow-up ${item.taskKey} ("Watch the release build") found a change`
    )
    expect(modelText(report!.msg).endsWith(`The release is out.\n\n${ANSWER_LANGUAGE}`)).toBe(true)
    expect(report!.callMeta).toMatchObject({ callFrom: 'bot-a', hopCount: 1 })
    // The check is asked for its people's language, and the conversation's runtime is told to answer in it.
    const prompts = hosts.flatMap((h) => h.prompt.mock.calls.map((c: any) => JSON.stringify(c[1])))
    expect(prompts.find((p: string) => p.includes(CHECK_OPENING))).toContain(CHECK_LANGUAGE)
    expect(prompts.find((p: string) => p.includes('found a change'))).toContain(ANSWER_LANGUAGE)
    expect((await d.store.assistantItems.get('bot-a', item.id)).status).toBe('done')
    expect(await d.store.assistantChecks.checks('bot-a', item.id, 10)).toEqual([
      expect.objectContaining({ observation: 'The release is published.', reported: true })
    ])
    expect(checks()).toHaveLength(1)
    await daemon.stop()
  })

  it('records why when the follow-up’s conversation has no session to report to, and does not try that check again', async () => {
    const { daemon, d, checks, settled } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const item = await takeFollowUp(d)

    await d.followUpChecks.sweep()
    await d.followUpChecks.sweep()
    await settled()

    expect(checks()).toHaveLength(0)
    const after = await d.store.assistantItems.get('bot-a', item.id)
    expect(after.observations.map((o: any) => o.text)).toEqual([
      'No scheduled check ran: the conversation this follow-up belongs to has no ongoing session to report to.'
    ])
    await daemon.stop()
  })

  it('checks nothing while the agent is paused, then an overdue follow-up exactly once', async () => {
    const { daemon, d, behavior, checks, settled, deps } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    await seedPlace(d)
    await takeFollowUp(d, { nextCheck: Date.now() - 3 * 60 * MINUTE })
    behavior.check = quiet(deps)

    d.agents.get('bot-a').pause = true
    await d.followUpChecks.sweep()
    await settled()
    expect(checks()).toHaveLength(0)

    d.agents.get('bot-a').pause = false
    await d.followUpChecks.sweep()
    await vi.waitFor(() => expect(checks()).toHaveLength(1), WAIT)
    await settled()
    await d.followUpChecks.sweep()
    await settled()
    expect(checks()).toHaveLength(1)
    await daemon.stop()
  })

  it('leaves the check due when a pause stops it, and runs it once after', async () => {
    const { daemon, d, behavior, checks, reports, settled, deps } = await boot(
      scaffold([{ id: 'bot-a', assistantMode: ON }])
    )
    await seedPlace(d)
    const item = await takeFollowUp(d)
    behavior.check = 'hang'

    await d.followUpChecks.sweep()
    await vi.waitFor(() => expect(checks()).toHaveLength(1), WAIT)
    d.agents.get('bot-a').pause = true
    await d.interruptAgentTurns('bot-a', 'pause')
    await settled()
    expect(await checkState(d, item.id)).toMatchObject({ failures: 0, runningKey: null, checkedNextCheck: null })
    expect(await d.store.assistantChecks.checks('bot-a', item.id, 10)).toEqual([])
    expect(reports()).toHaveLength(0)

    d.agents.get('bot-a').pause = false
    behavior.check = quiet(deps)
    await d.followUpChecks.sweep()
    await vi.waitFor(() => expect(checks()).toHaveLength(2), WAIT)
    await settled()
    expect(await checkState(d, item.id)).toMatchObject({ checkedNextCheck: item.nextCheck })
    await daemon.stop()
  })

  it('leaves the checking to the daemon holding the agent’s duty, and to assistant mode', async () => {
    const { daemon, d, checks, settled } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }, { id: 'bot-b' }]))
    await seedPlace(d)
    await seedPlace(d, 'bot-b')
    await takeFollowUp(d)
    await takeFollowUp(d, { agentId: 'bot-b' })
    const serves = d.servesAgent.bind(d)
    d.servesAgent = (agentId: string) => agentId !== 'bot-a' && serves(agentId)

    await d.followUpChecks.sweep()
    await settled()
    expect(checks()).toHaveLength(0)
    await daemon.stop()
  })
})

describe('one scheduled check at a time, beside the delegations', () => {
  it('runs one scheduled check per agent, and the next follow-up’s once it ends', async () => {
    const { daemon, d, behavior, checks, settled, deps } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    await seedPlace(d)
    const first = await takeFollowUp(d, { title: 'First', nextCheck: Date.now() - 2 * MINUTE })
    await takeFollowUp(d, { title: 'Second', nextCheck: Date.now() - MINUTE })
    behavior.check = 'hang'

    await d.followUpChecks.sweep()
    await vi.waitFor(() => expect(checks()).toHaveLength(1), WAIT)
    await d.followUpChecks.sweep()
    expect(checks()).toHaveLength(1)
    expect(modelText(checks()[0]!.msg)).toContain('Title: First')

    behavior.check = quiet(deps)
    await d.interruptTurn('bot-a', first.taskKey, 'stop')
    await settled()
    await d.followUpChecks.sweep()
    await vi.waitFor(() => expect(checks()).toHaveLength(2), WAIT)
    expect(modelText(checks()[1]!.msg)).toContain('Title: Second')
    await settled()
    await daemon.stop()
  })

  it('keeps checks out of the concurrent task limit, both ways', async () => {
    const { daemon, d, behavior, checks, settled } = await boot(
      scaffold([{ id: 'bot-a', assistantMode: { ...ON, limits: { maxConcurrentSubsessions: 1 } } }])
    )
    const place = await seedPlace(d)
    await takeFollowUp(d)
    behavior.check = 'hang'
    await d.followUpChecks.sweep()
    await vi.waitFor(() => expect(checks()).toHaveLength(1), WAIT)

    const delegation = (n: number): MessageAgentReq => ({
      callerAgentId: 'bot-a',
      platform: 'slack',
      callerChannel: 'C1',
      callerThread: place.coordinate,
      callerTransportScope: place.scope,
      toAgentId: 'bot-a',
      text: `long work ${n}`,
      channel: 'C1',
      thread: `100.${n}`,
      postless: true
    })
    // The running check takes none of the user's one place …
    expect(await d.collab.messageAgent(delegation(1))).toMatchObject({ delivered: true, subsession: true })
    // … which the delegation now holds.
    expect(await d.collab.messageAgent(delegation(2))).toMatchObject({ delivered: false, reason: 'task_limit' })
    await d.interruptAgentTurns('bot-a', 'stop')
    await settled()
    await daemon.stop()
  })
})

describe('a check reads and records, nothing else', () => {
  it('is offered the reads, recordCheck and propose, never a write, a post, a follow-up or a draft', async () => {
    const { daemon, d, behavior, registered, checks, settled, deps } = await boot(
      scaffold([{ id: 'bot-a', assistantMode: ON }])
    )
    await seedPlace(d)
    await takeFollowUp(d)
    behavior.check = quiet(deps)
    await d.followUpChecks.sweep()
    await vi.waitFor(() => expect(checks()).toHaveLength(1), WAIT)
    await settled()

    const ctx = registered.find((c) => isCheckCoordinate(c.thread))!
    const names = ctx.tools.map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining(['recordCheck', 'propose', 'recall', 'getChannelHistory', 'readMemory'])
    )
    for (const write of [
      'sendMessage',
      'shareFile',
      'followUp',
      'listTasks',
      'stopTask',
      'addReaction',
      'deleteMessage',
      'writeMemory',
      'scheduleMessage',
      'createCanvas',
      'submitCodeReview',
      'listAgents',
      'viewSessionStatus'
    ])
      expect(names).not.toContain(write)
    expect(ctx.tools.find((t) => t.name === 'recordCheck')).toBe(RECORD_CHECK_TOOL)
    // A name it was not offered is refused, whatever the runtime sends.
    await expect(
      executeTool(ctx, 'sendMessage', { action: 'callAgent', toAgent: 'bot-a', message: 'hi' }, deps)
    ).rejects.toThrow('sendMessage is not available in a follow-up’s read-only check')
    // Another session of the agent keeps its whole tool set.
    const other = registered.find((c) => !isCheckCoordinate(c.thread))
    if (other) expect(other.tools.map((t) => t.name)).toContain('sendMessage')
    await daemon.stop()
  })

  it('refuses whatever would need approval in a check, without asking anyone', async () => {
    const { daemon, d, behavior, checks, settled } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    await seedPlace(d)
    await takeFollowUp(d)
    behavior.check = 'hang'
    await d.followUpChecks.sweep()
    await vi.waitFor(
      () => expect([...d.pending.values()].some((p: any) => isCheckCoordinate(p.plan.sessionThread))).toBe(true),
      WAIT
    )
    const p = [...d.pending.values()].find((turn: any) => isCheckCoordinate(turn.plan.sessionThread)) as any
    const answer = await d.permissions.onAcpPermission(p.hostKey, p.acpSessionId, {
      sessionId: p.acpSessionId,
      toolCall: { toolCallId: 'tc-1', title: 'rm -rf build', kind: 'execute' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
      ]
    })
    expect(answer).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } })
    await d.interruptAgentTurns('bot-a', 'stop')
    await settled()
    expect(checks()).toHaveLength(1)
    await daemon.stop()
  })

  it('never sets its next check sooner than five minutes, nor both ends and reschedules', async () => {
    const { daemon, d, behavior, checks, settled, deps } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    await seedPlace(d)
    const item = await takeFollowUp(d)
    const results: unknown[] = []
    behavior.check = async (ctx) => {
      for (const args of [
        { observation: 'x', nextCheck: new Date(Date.now() + MINUTE).toISOString() },
        { observation: 'x', done: true, nextCheck: new Date(Date.now() + 60 * MINUTE).toISOString() }
      ])
        results.push(await executeTool(ctx, 'recordCheck', args, deps).catch((err: Error) => err.message))
      await quiet(deps)(ctx)
    }
    await d.followUpChecks.sweep()
    await vi.waitFor(() => expect(checks()).toHaveLength(1), WAIT)
    await settled()
    expect(results[0]).toBe('nextCheck must be at least five minutes from now; nothing was written')
    expect(results[1]).toBe('recordCheck takes `done` or `nextCheck`, not both; nothing was written')
    expect((await d.store.assistantItems.get('bot-a', item.id)).observations).toHaveLength(1)
    await daemon.stop()
  })
})

describe('failures back off and stop', () => {
  it('records a failure, backs off, and after five in a row stops and tells the conversation once, until it is messaged', async () => {
    const { daemon, d, behavior, checks, reports, settled } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const place = await seedPlace(d)
    const item = await takeFollowUp(d)
    behavior.check = 'throw'

    await d.followUpChecks.sweep()
    await vi.waitFor(() => expect(checks()).toHaveLength(1), WAIT)
    await settled()
    const first = await checkState(d, item.id)
    expect(first).toMatchObject({ failures: 1, stopped: false, checkedNextCheck: null })
    expect(first.retryAt).toBeGreaterThanOrEqual(Date.now() + 2 * MINUTE - 5_000)
    expect((await d.store.assistantItems.get('bot-a', item.id)).observations.map((o: any) => o.text)).toEqual([
      'Scheduled check failed (error); the next attempt is in 2 minutes.'
    ])
    expect(await d.store.assistantChecks.checks('bot-a', item.id, 10)).toEqual([
      expect.objectContaining({ observation: 'Scheduled check failed (error); the next attempt is in 2 minutes.' })
    ])
    // Backing off: nothing before the wait is over.
    await d.followUpChecks.sweep()
    await settled()
    expect(checks()).toHaveLength(1)

    for (let n = 2; n <= CHECK_MAX_FAILURES; n++) {
      await d.store.assistantChecks.db.query(
        'UPDATE assistant_check_state SET retryAt = 0 WHERE agentId = ? AND itemId = ?',
        ['bot-a', item.id]
      )
      await d.followUpChecks.sweep()
      await vi.waitFor(() => expect(checks()).toHaveLength(n), WAIT)
      await settled()
    }
    expect(await checkState(d, item.id)).toMatchObject({ failures: CHECK_MAX_FAILURES, stopped: true })
    expect(reports()).toHaveLength(1)
    expect(modelText(reports()[0]!.msg)).toContain(
      `Checks of follow-up ${item.taskKey} ("Watch the release build") stopped after 5 failed attempts in a row. ` +
        'They resume once it is messaged with messageTask.'
    )
    expect(modelText(reports()[0]!.msg)).toContain(`Tell the people here.\n\n${ANSWER_LANGUAGE}`)

    // A new next check does not resume it.
    await d.store.assistantItems.schedule('bot-a', item.id, { status: 'active', nextCheck: Date.now() - 1_000 })
    await d.followUpChecks.sweep()
    await settled()
    expect(checks()).toHaveLength(CHECK_MAX_FAILURES)
    // A message does, at once and with a fresh streak.
    behavior.check = 'hang'
    expect(await message(d, place, item.taskKey, 'Try again now.')).toMatchObject({
      delivered: true,
      followUp: 'checking'
    })
    await vi.waitFor(() => expect(checks()).toHaveLength(CHECK_MAX_FAILURES + 1), WAIT)
    expect(await checkState(d, item.id)).toMatchObject({ failures: 0, stopped: false })
    await d.interruptAgentTurns('bot-a', 'stop')
    await settled()
    await daemon.stop()
  })

  it('counts a check that recorded nothing as a failure, and sends no "ended without reporting" into the place', async () => {
    const { daemon, d, checks, reports, settled } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    await seedPlace(d)
    const item = await takeFollowUp(d)

    await d.followUpChecks.sweep()
    await vi.waitFor(() => expect(checks()).toHaveLength(1), WAIT)
    await settled()
    expect(await checkState(d, item.id)).toMatchObject({ failures: 1 })
    expect((await d.store.assistantItems.get('bot-a', item.id)).observations.map((o: any) => o.text)).toEqual([
      'Scheduled check failed (nothing recorded); the next attempt is in 2 minutes.'
    ])
    expect(reports()).toHaveLength(0)
    await daemon.stop()
  })
})

describe('a follow-up owned by its place', () => {
  it('is listed, messaged and ended by the place’s current long session alone', async () => {
    const { daemon, d, behavior, checks, settled, deps } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const place = await seedPlace(d)
    const item = await takeFollowUp(d, { nextCheck: Date.now() + 60 * MINUTE })
    const here = placeCtx(place)

    const listed = (await executeTool(here, 'listTasks', {}, deps)) as any
    expect(listed.tasks).toEqual([
      {
        taskId: item.taskKey,
        kind: 'follow-up',
        label: 'Watch the release build',
        state: 'waiting',
        startedAt: expect.any(String),
        nextCheck: new Date(item.nextCheck!).toISOString(),
        handedBackResult: false
      }
    ])

    // A message runs a check at once, with the message in it.
    behavior.check = 'hang'
    expect(await message(d, place, item.taskKey, 'Check the staging build too.')).toMatchObject({
      delivered: true,
      targetSession: item.taskKey,
      followUp: 'checking'
    })
    await vi.waitFor(() => expect(checks()).toHaveLength(1), WAIT)
    expect(modelText(checks()[0]!.msg)).toContain('Check: asked for by its conversation now')
    expect(modelText(checks()[0]!.msg)).toContain('Check the staging build too.')
    expect(((await executeTool(here, 'listTasks', {}, deps)) as any).tasks[0]).toMatchObject({ state: 'checking' })
    // One that arrives while it checks waits for the next check, which takes it once this one ends.
    expect(await message(d, place, item.taskKey, 'And the docs build.')).toMatchObject({
      delivered: true,
      followUp: 'queued'
    })
    behavior.check = quiet(deps)
    await d.interruptTurn('bot-a', item.taskKey, 'stop')
    await vi.waitFor(() => expect(checks()).toHaveLength(2), WAIT)
    await settled()
    expect(modelText(checks()[1]!.msg)).toContain('And the docs build.')
    expect(modelText(checks()[1]!.msg)).not.toContain('Check the staging build too.')
    expect(checks()[1]!.msg.thread).toBe(checks()[0]!.msg.thread)

    // stopTask ends the follow-up itself.
    const stopped = (await executeTool(here, 'stopTask', { taskId: item.taskKey }, deps)) as any
    expect(stopped).toMatchObject({ result: 'stopped', taskId: item.taskKey })
    expect(await d.store.assistantItems.get('bot-a', item.id)).toMatchObject({ status: 'dropped', nextCheck: null })
    expect(await executeTool(here, 'stopTask', { taskId: item.taskKey }, deps)).toMatchObject({ result: 'not_running' })
    expect(await message(d, place, item.taskKey, 'More?')).toMatchObject({ delivered: false, reason: 'task_ended' })
    expect(((await executeTool(here, 'listTasks', {}, deps)) as any).tasks[0]).toMatchObject({ state: 'stopped' })
    await daemon.stop()
  })

  it('says it handed back a result only while its latest check reported', async () => {
    const { daemon, d, behavior, checks, settled, deps } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const place = await seedPlace(d)
    const item = await takeFollowUp(d)
    const handedBack = async () =>
      ((await executeTool(placeCtx(place), 'listTasks', {}, deps)) as any).tasks[0].handedBackResult
    expect(await handedBack()).toBe(false)

    const next = new Date(Date.now() + 60 * MINUTE).toISOString()
    behavior.check = async (ctx) =>
      await executeTool(
        ctx,
        'recordCheck',
        { observation: 'The build passed.', report: 'It passed.', nextCheck: next },
        deps
      )
    await d.followUpChecks.sweep()
    await vi.waitFor(() => expect(checks()).toHaveLength(1), WAIT)
    await settled()
    expect(await handedBack()).toBe(true)

    behavior.check = quiet(deps)
    await message(d, place, item.taskKey, 'Look again.')
    await vi.waitFor(() => expect(checks()).toHaveLength(2), WAIT)
    await settled()
    expect(await handedBack()).toBe(false)
    await daemon.stop()
  })

  it('reports in the thread it was taken in, else where its place last replied', async () => {
    const { daemon, d, behavior, reports, settled, deps } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const place = await seedPlace(d)
    // `followUp` keeps the thread the taking turn replies in.
    d.activeTurnShare.set(place.key, {
      platform: 'slack',
      channel: 'C1',
      thread: '200.1',
      headless: false,
      synthetic: false
    })
    const taken = await deps.assistantItems.take(placeCtx(place), {
      title: 'Watch the release build',
      doneWhen: 'The release is published',
      nextCheck: Date.now() - MINUTE,
      asker: 'slack:T0EXAMPLE:U0ALICE'
    })
    d.activeTurnShare.delete(place.key)
    expect(taken.replyThread).toBe('200.1')
    behavior.check = reporting(deps)
    await d.followUpChecks.sweep()
    await vi.waitFor(() => expect(reports()).toHaveLength(1), WAIT)
    await settled()
    expect(reports()[0]!.msg).toMatchObject({ thread: '200.1', sessionThread: place.coordinate })

    await d.store.setSessionReplyThread(place.key, '300.1')
    await takeFollowUp(d, { title: 'Watch the docs build' })
    await d.followUpChecks.sweep()
    await vi.waitFor(() => expect(reports()).toHaveLength(2), WAIT)
    await settled()
    expect(reports()[1]!.msg).toMatchObject({ thread: '300.1', sessionThread: place.coordinate })
    await daemon.stop()
  })

  it('passes to the place’s new session after `!new`, and no other session addresses it', async () => {
    const { daemon, d, settled, deps } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const place = await seedPlace(d)
    const item = await takeFollowUp(d, { nextCheck: Date.now() + 60 * MINUTE })
    const next = await d.store.advanceAppendCoordinate('bot-a', 'C1', place.coordinate, place.scope)
    await d.store.upsertSession({
      key: sessionKey('slack', 'C1', next, 'bot-a', place.scope),
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: next,
      transportScope: place.scope,
      acpSessionId: 'acp-current-bot-a',
      sessionId: 'sid-current-bot-a',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    const old = placeCtx(place)
    const current = placeCtx({ coordinate: next, scope: place.scope })
    const notOwned = { result: 'refused', reason: 'This session started no task with that id. Nothing was stopped.' }
    // The retired session no longer owns it, and does not see it.
    expect(await executeTool(old, 'stopTask', { taskId: item.taskKey }, deps)).toEqual(notOwned)
    expect(await message(d, place, item.taskKey, 'x')).toMatchObject({ delivered: false, reason: 'task_not_found' })
    expect(((await executeTool(old, 'listTasks', {}, deps)) as any).tasks).toEqual([])
    // The new one lists it, and its row names the new session.
    expect(((await executeTool(current, 'listTasks', {}, deps)) as any).tasks).toEqual([
      expect.objectContaining({ taskId: item.taskKey, kind: 'follow-up' })
    ])
    expect(await d.store.assistantSubsessions.get('bot-a', item.taskKey)).toMatchObject({
      parentSessionId: 'sid-current-bot-a'
    })
    // A thread of the place and another place are not its owner.
    const thread = { ...current, thread: '100.1' }
    expect(await executeTool(thread, 'stopTask', { taskId: item.taskKey }, deps)).toEqual(notOwned)
    const elsewhere = { ...current, channel: 'C2' }
    expect(await executeTool(elsewhere, 'stopTask', { taskId: item.taskKey }, deps)).toEqual(notOwned)
    expect((await d.store.assistantItems.get('bot-a', item.id)).status).toBe('active')
    expect(await executeTool(current, 'stopTask', { taskId: item.taskKey }, deps)).toMatchObject({ result: 'stopped' })
    await settled()
    await daemon.stop()
  })

  it('refuses a message once the day’s budget is spent, naming when it resets', async () => {
    expect(DEFAULT_DAILY_CHECK_BUDGET).toBe(50)
    const { daemon, d, behavior, checks, settled, deps } = await boot(
      scaffold([{ id: 'bot-a', assistantMode: { ...ON, limits: { dailyCheckBudget: 1 } } }])
    )
    const place = await seedPlace(d)
    const item = await takeFollowUp(d)
    behavior.check = quiet(deps)
    await d.followUpChecks.sweep()
    await vi.waitFor(() => expect(checks()).toHaveLength(1), WAIT)
    await settled()
    const [first] = await d.store.assistantChecks.checks('bot-a', item.id, 1)
    const refused = await message(d, place, item.taskKey, 'Check again.')
    expect(refused).toMatchObject({ delivered: false, reason: 'budget' })
    expect(refused.message).toContain(new Date(first.startedAt + 24 * 60 * MINUTE).toISOString())
    expect(checks()).toHaveLength(1)
    await daemon.stop()
  })

  it('is listed in its conversation’s Tasks panel, whose stop ends it', async () => {
    const { daemon, d, behavior, checks, reports, settled } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    await seedPlace(d)
    const item = await takeFollowUp(d)
    behavior.check = 'hang'
    await d.followUpChecks.sweep()
    await vi.waitFor(() => expect(checks()).toHaveLength(1), WAIT)
    await vi.waitFor(async () => expect((await d.store.getSession(item.taskKey))?.sessionId).toBeTruthy(), WAIT)
    const sessionId = (await d.store.getSession(item.taskKey)).sessionId
    // The same seam the control plane's frames reach, with the daemon's own stops behind it.
    const activity = createAssistantActivity({
      store: () => d.store,
      agent: (agentId) => d.agents.get(agentId),
      now: () => Date.now(),
      decideDraft: async () => {
        throw new Error('not used')
      },
      stopSession: (k, actor) => d.commands.cancelSessionByKey(k, actor),
      stopFollowUp: (agentId, followUp, actor) => d.followUpChecks.stop(agentId, followUp, actor)
    })

    const listed = (await activity.read({
      agentId: 'bot-a',
      operation: 'subsessions',
      limit: 10,
      parent: { sessionId: 'sid-parent-bot-a' }
    })) as any
    expect(listed.subsessions).toEqual([
      expect.objectContaining({
        sessionId,
        state: 'open',
        kind: 'follow-up',
        followUp: expect.objectContaining({ status: 'checking' })
      })
    ])

    expect(
      await activity.write({
        agentId: 'bot-a',
        operation: 'stop-subsession',
        sessionId,
        actor: { userId: 'usr-1', name: 'Grace' }
      })
    ).toEqual({ operation: 'stop-subsession', result: 'stopped' })
    await vi.waitFor(async () => expect((await checkState(d, item.id))?.runningKey).toBeNull(), WAIT)
    await settled()

    // Ended with its check done, silently.
    expect(reports()).toHaveLength(0)
    expect(await d.store.assistantItems.get('bot-a', item.id)).toMatchObject({ status: 'dropped' })
    expect(await checkState(d, item.id)).toMatchObject({ failures: 0 })
    expect(await d.store.assistantSubsessions.get('bot-a', item.taskKey)).toMatchObject({
      kind: 'follow-up',
      state: 'failed'
    })
    await daemon.stop()
  })
})

describe('a check replayed after a handover', () => {
  /** The check's turn is cut for a handover that keeps it, then a fresh follow-up service replays it, as a successor daemon would. */
  async function handOver(d: any, behavior: { check: unknown }, next: CheckBehavior) {
    await d.interruptAgentTurns('bot-a', 'handover', 'handoff')
    d.followUpCheckService = undefined
    d.absorbedContextTs.clear()
    behavior.check = next
    await d.replayInbox(new Set(['bot-a']))
  }
  const nothing: CheckBehavior = async () => {}

  it('counts an empty completion on a fresh service as a failure, backs off and keeps the check due', async () => {
    const { daemon, d, behavior, checks, reports, settled } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    await seedPlace(d)
    const item = await takeFollowUp(d)
    behavior.check = 'hang'
    await d.followUpChecks.sweep()
    await vi.waitFor(() => expect(checks()).toHaveLength(1), WAIT)
    await vi.waitFor(async () => expect((await checkState(d, item.id))?.runningKey).toBeTruthy(), WAIT)

    await handOver(d, behavior, nothing)
    await vi.waitFor(async () => expect((await checkState(d, item.id))?.failures).toBe(1), WAIT)
    await settled()

    const state = await checkState(d, item.id)
    expect(state).toMatchObject({ failures: 1, stopped: false, checkedNextCheck: null, runningKey: null })
    expect(state.retryAt).toBeGreaterThanOrEqual(Date.now() + 2 * MINUTE - 5_000)
    expect(reports()).toHaveLength(0)
    // The check stays due once the backoff is over.
    expect(await d.store.assistantChecks.due('bot-a', Date.now() + 3 * MINUTE, 10)).toEqual([
      { itemId: item.id, nextCheck: item.nextCheck }
    ])
    await daemon.stop()
  })

  it('still delivers the report and counts the observation the cut turn recorded', async () => {
    const { daemon, d, behavior, checks, reports, settled, deps } = await boot(
      scaffold([{ id: 'bot-a', assistantMode: ON }])
    )
    await seedPlace(d)
    const item = await takeFollowUp(d)
    let recorded = false
    behavior.check = async (ctx) => {
      await executeTool(
        ctx,
        'recordCheck',
        { observation: 'The release is published.', report: 'The release is out.' },
        deps
      )
      recorded = true
      await new Promise(() => {})
    }
    await d.followUpChecks.sweep()
    await vi.waitFor(() => expect(recorded).toBe(true), WAIT)

    await handOver(d, behavior, nothing)
    await vi.waitFor(() => expect(reports()).toHaveLength(1), WAIT)
    await settled()

    expect(modelText(reports()[0]!.msg)).toContain('The release is out.')
    expect(await checkState(d, item.id)).toMatchObject({ failures: 0, checkedNextCheck: item.nextCheck })
    // The replay ran the same check; no second one started.
    expect(new Set(checks().map((c) => c.msg.thread)).size).toBe(1)
    await daemon.stop()
  })
})

/** How many turns of the conversation's sessions were prompted with `text`. */
const told = (hosts: any[], text: string): number =>
  hosts.flatMap((h) => h.prompt.mock.calls).filter((c: any) => JSON.stringify(c).includes(text)).length

/** Count the daemon's report deliveries, each held until `hold` resolves. */
function watchReports(d: any, hold: Promise<unknown> = Promise.resolve()) {
  const seen = { calls: 0 }
  const report = d.reportIntoParent.bind(d)
  d.reportIntoParent = async (...args: unknown[]) => {
    seen.calls += 1
    await hold
    return await report(...args)
  }
  return seen
}

describe('a check passes on what it found before it settles', () => {
  it('settles a check only once its report is in', async () => {
    const { daemon, d, behavior, reports, settled, deps } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    await seedPlace(d)
    const item = await takeFollowUp(d)
    behavior.check = reporting(deps)
    let release!: () => void
    const seen = watchReports(d, new Promise<void>((resolve) => (release = resolve)))

    await d.followUpChecks.sweep()
    await vi.waitFor(() => expect(seen.calls).toBe(1), WAIT)
    // The report is still on its way, so the check still holds it and is not done.
    const held = await checkState(d, item.id)
    expect(held).toMatchObject({ runningReport: 'The release is out.', checkedNextCheck: null })
    expect(held.runningKey).toBeTruthy()

    release()
    await vi.waitFor(async () => expect((await checkState(d, item.id))?.runningKey).toBeNull(), WAIT)
    await settled()
    expect(reports()).toHaveLength(1)
    expect(await checkState(d, item.id)).toMatchObject({ checkedNextCheck: item.nextCheck, runningReport: null })
    await daemon.stop()
  })

  it('delivers again after a crash between its report and its settling, and the conversation hears it once', async () => {
    const { daemon, d, behavior, hosts, checks, reports, settled, deps } = await boot(
      scaffold([{ id: 'bot-a', assistantMode: ON }])
    )
    await seedPlace(d)
    const item = await takeFollowUp(d)
    behavior.check = reporting(deps)
    const seen = watchReports(d)
    // The process dies after the report is in, before the check is settled.
    const ledger = d.store.assistantChecks
    const succeed = ledger.succeed.bind(ledger)
    let crashed = false
    ledger.succeed = async (...args: unknown[]) => {
      if (crashed) return await succeed(...args)
      crashed = true
      throw new Error('the daemon was killed')
    }

    await d.followUpChecks.sweep()
    await vi.waitFor(() => expect(crashed).toBe(true), WAIT)
    await settled()
    expect(reports()).toHaveLength(1)
    expect((await checkState(d, item.id)).runningKey).toBeTruthy()

    // The next start finds the check its turn left unsettled, and settles it without a second report.
    d.followUpCheckService = undefined
    await d.replayInbox(new Set(['bot-a']))
    await settled()

    expect(await checkState(d, item.id)).toMatchObject({ runningKey: null, checkedNextCheck: item.nextCheck })
    expect(await d.store.assistantSubsessions.get('bot-a', item.taskKey)).toMatchObject({ state: 'done' })
    expect(seen.calls).toBe(2)
    expect(reports()).toHaveLength(1)
    expect(told(hosts, 'The release is out.')).toBe(1)
    expect((await d.store.assistantItems.get('bot-a', item.id)).observations.map((o: any) => o.text)).toEqual([
      'The release is published.'
    ])
    expect(checks()).toHaveLength(1)
    await daemon.stop()
  })

  it('leaves a report a drain held back to the next start, which delivers it once', async () => {
    const { daemon, d, behavior, checks, reports, settled, deps } = await boot(
      scaffold([{ id: 'bot-a', assistantMode: ON }])
    )
    await seedPlace(d)
    const item = await takeFollowUp(d)
    // The daemon starts draining as the check's turn ends.
    behavior.check = async (ctx) => {
      await reporting(deps)(ctx)
      d.draining = true
    }

    await d.followUpChecks.sweep()
    await vi.waitFor(() => expect(checks()).toHaveLength(1), WAIT)
    await settled()
    expect(reports()).toHaveLength(0)
    expect(await checkState(d, item.id)).toMatchObject({
      runningReport: 'The release is out.',
      checkedNextCheck: null
    })

    d.draining = false
    d.followUpCheckService = undefined
    await d.replayInbox(new Set(['bot-a']))
    await settled()
    await d.replayInbox(new Set(['bot-a']))
    await settled()

    expect(reports()).toHaveLength(1)
    expect(modelText(reports()[0]!.msg)).toContain('The release is out.')
    expect(await checkState(d, item.id)).toMatchObject({ runningKey: null, checkedNextCheck: item.nextCheck })
    expect(checks()).toHaveLength(1)
    await daemon.stop()
  })

  it('records a report the conversation refused on the follow-up and settles the check as before', async () => {
    const { daemon, d, behavior, settled, deps } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    await seedPlace(d)
    const item = await takeFollowUp(d)
    behavior.check = reporting(deps)
    d.reportIntoParent = async () => false

    await d.followUpChecks.sweep()
    await vi.waitFor(async () => expect((await checkState(d, item.id))?.checkedNextCheck).toBe(item.nextCheck), WAIT)
    await settled()

    expect(await checkState(d, item.id)).toMatchObject({ runningKey: null, failures: 0 })
    expect((await d.store.assistantItems.get('bot-a', item.id)).observations.map((o: any) => o.text)).toEqual([
      'The release is published.',
      'A report from a check could not reach the conversation this follow-up belongs to.'
    ])
    expect(await d.store.assistantChecks.checks('bot-a', item.id, 1)).toEqual([
      expect.objectContaining({ reported: false })
    ])
    await daemon.stop()
  })
})

describe('a check’s report after `!new`', () => {
  /** `!new` rotates the conversation onto a fresh coordinate; `speak` also starts its session, as the next message would. */
  async function rotate(d: any, place: { coordinate: string; scope: string }, speak: boolean): Promise<string> {
    const next = await d.store.advanceAppendCoordinate('bot-a', 'C1', place.coordinate, place.scope)
    if (speak)
      await d.store.upsertSession({
        key: sessionKey('slack', 'C1', next, 'bot-a', place.scope),
        agentId: 'bot-a',
        platform: 'slack',
        channel: 'C1',
        thread: next,
        transportScope: place.scope,
        acpSessionId: 'acp-current-bot-a',
        sessionId: 'sid-current-bot-a',
        state: 'idle',
        lastDeliveredTs: null,
        updatedAt: Date.now()
      })
    return next
  }

  it('lands in the conversation’s current session, which owns the follow-up from its next check', async () => {
    const { daemon, d, behavior, reports, settled, deps } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const place = await seedPlace(d)
    const item = await takeFollowUp(d)
    let next = ''
    behavior.check = async (ctx) => {
      next = await rotate(d, place, true)
      await executeTool(
        ctx,
        'recordCheck',
        {
          observation: 'The release is published.',
          report: 'The release is out.',
          nextCheck: new Date(Date.now() + 60 * MINUTE).toISOString()
        },
        deps
      )
    }

    await d.followUpChecks.sweep()
    await vi.waitFor(() => expect(reports()).toHaveLength(1), WAIT)
    await settled()

    expect(next).not.toBe(place.coordinate)
    expect(reports()[0]!.msg).toMatchObject({ channel: 'C1', sessionThread: next })
    expect(modelText(reports()[0]!.msg)).toContain('The release is out.')
    // The check ran under the session it started under; the next one is the new session's.
    expect(await d.store.assistantSubsessions.get('bot-a', item.taskKey)).toMatchObject({
      parentSessionId: 'sid-parent-bot-a',
      state: 'done'
    })
    await d.store.assistantItems.schedule('bot-a', item.id, { status: 'active', nextCheck: Date.now() - 1_000 })
    behavior.check = quiet(deps)
    await d.followUpChecks.sweep()
    await vi.waitFor(
      async () =>
        expect(await d.store.assistantSubsessions.get('bot-a', item.taskKey)).toMatchObject({
          parentSessionId: 'sid-current-bot-a'
        }),
      WAIT
    )
    await settled()
    await daemon.stop()
  })

  it('falls back to the session it started under while the new one has not begun', async () => {
    const { daemon, d, behavior, reports, settled, deps } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const place = await seedPlace(d)
    await takeFollowUp(d)
    behavior.check = reporting(deps, async () => {
      await rotate(d, place, false)
    })

    await d.followUpChecks.sweep()
    await vi.waitFor(() => expect(reports()).toHaveLength(1), WAIT)
    await settled()

    expect(reports()[0]!.msg).toMatchObject({ channel: 'C1', sessionThread: place.coordinate })
    await daemon.stop()
  })
})

describe('the daily check budget', () => {
  it('starts no scheduled check past the agent’s budget in 24 hours', async () => {
    const { daemon, d, behavior, checks, settled, deps } = await boot(
      scaffold([{ id: 'bot-a', assistantMode: { ...ON, limits: { dailyCheckBudget: 1 } } }])
    )
    await seedPlace(d)
    await takeFollowUp(d, { title: 'First', nextCheck: Date.now() - 2 * MINUTE })
    await takeFollowUp(d, { title: 'Second', nextCheck: Date.now() - MINUTE })
    behavior.check = quiet(deps)

    await d.followUpChecks.sweep()
    await vi.waitFor(() => expect(checks()).toHaveLength(1), WAIT)
    await settled()
    await d.followUpChecks.sweep()
    await settled()
    expect(checks()).toHaveLength(1)
    await daemon.stop()
  })
})

describe('follow-up tool text', () => {
  const followUp = {
    id: 'item-1',
    taskKey: 'slack:C1:subsession:check-1:bot-a',
    version: 1,
    status: 'active',
    title: 'Confirm the new build works',
    doneWhen: null,
    summary: '',
    observations: []
  } as unknown as AssistantItem

  it('says a next check runs a read-only check that reports only a change', () => {
    const text = JSON.stringify(FOLLOW_UP_TOOL)
    expect(text).toContain('at each next check a read-only check runs in the background and reports here only if')
    expect(text).not.toContain('nothing wakes you')
  })

  it('tells a check its report promises no later message, time or check', () => {
    const prompt = checkPrompt(followUp, { itemId: 'item-1', nextCheck: Date.UTC(2030, 0, 1) })
    expect(prompt).toContain(
      '4. A report says what you found and promises nothing: no later message, no time anyone will hear back, no ' +
        'next check. When it should be looked at again, set `nextCheck`; the people in its conversation are not ' +
        'told about it.'
    )
    // The report-only-on-a-change rule is unchanged.
    expect(prompt).toContain('Otherwise leave `report` out: nothing is said.')
    const report = JSON.stringify((RECORD_CHECK_TOOL.inputSchema as ObjectToolSchema).properties.report)
    expect(report).toContain('promises no later message, no time anyone will hear back and no next check')
  })

  it('asks a check to write in the language of the people in its conversation', () => {
    const prompt = checkPrompt({ ...followUp, title: '确认新版本可用' }, { itemId: 'item-1', nextCheck: 0 })
    expect(prompt).toContain(`The check records its observation either way. ${CHECK_LANGUAGE}`)
  })

  it('advertises exactly recordCheck’s arguments', () => {
    const view = (schema: { properties?: Record<string, unknown>; required?: string[] }) => ({
      properties: Object.keys(schema.properties ?? {}).sort(),
      required: [...(schema.required ?? [])].sort()
    })
    expect(view(z.toJSONSchema(RECORD_CHECK_ARGS, { io: 'input', unrepresentable: 'any' }) as never)).toEqual(
      view(RECORD_CHECK_TOOL.inputSchema as never)
    )
  })

  it('filters a tool list to reads, recordCheck and propose', () => {
    const all = [
      ...toolsForIntegrations(
        [
          {
            id: 'int-1',
            platform: 'slack',
            core: {
              mode: 'direct',
              bindRules: [],
              mutedChannels: [],
              gated: false,
              sessionModes: [],
              decisions: { bindings: [], definitions: [] }
            },
            config: { botToken: 'xoxb', appToken: 'xapp' }
          } as never
        ],
        { organizationKnowledge: true, decisions: true, currentPlatform: 'slack' }
      ),
      FOLLOW_UP_TOOL
    ]
    const names = checkTools(all).map((t) => t.name)
    expect(names).not.toContain('sendMessage')
    expect(names).not.toContain('followUp')
    expect(names).not.toContain('evaluateDecision')
    expect(names.filter((n) => n === 'recordCheck')).toHaveLength(1)
  })
})
