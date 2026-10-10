// Assistant-mode patrols (assistant-mode.md §5.9, minimal): woken by a due next check, read-only, silent unless something changed.
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { executeTool, type MessageAgentReq, type SessionContext } from '../src/mcp/ops.js'
import {
  ASSISTANT_ITEM_TOOLS,
  PATROL_UPDATE_ITEM_ARGS,
  PATROL_UPDATE_ITEM_TOOL
} from '../src/mcp/ops/assistant-items.js'
import { DEFAULT_DAILY_PATROL_BUDGET, patrolTools } from '../src/assistant/patrol.js'
import { createAssistantActivity } from '../src/cp/assistant-activity.js'
import { toolsForIntegrations } from '../src/mcp/tools.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { CLAUDE_HEADLESS_DISALLOWED_TOOLS } from '../src/runtime-defs/claude-runtime.js'
import { isPatrolCoordinate, isSubsessionCoordinate } from '../src/session/subsession-coordinate.js'
import { PATROL_MAX_FAILURES } from '../src/store/assistant-patrols.js'
import { sessionKey } from '../src/store/local-store.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'
import { z } from 'zod'

const TEST_ORG = '00000000-0000-0000-0000-0000000000a1'
const ON = { enabled: true, responsibleUserId: 'user-1' }
const MINUTE = 60_000
const PATROL_OPENING = '[patrol] A scheduled, read-only check'

/** One Slack agent per entry, each appending in `C1`. */
function scaffold(agents: { id: string; assistantMode?: Record<string, unknown>; permissionMode?: string }[]): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-patrol-'))
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

/** What a patrol's runtime does with its prompt, given the bridge context the patrol was registered with. */
type PatrolBehavior = (ctx: SessionContext) => Promise<unknown>

async function boot(root: string) {
  const behavior: { patrol: PatrolBehavior | 'hang' | 'throw' } = { patrol: async () => 'end_turn' }
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
      prompt: vi.fn(async (sessionId: string, blocks: unknown[]) => {
        if (!JSON.stringify(blocks).includes(PATROL_OPENING)) return 'end_turn'
        if (behavior.patrol === 'throw') throw new Error('the runtime exited')
        if (behavior.patrol === 'hang') return await new Promise((resolve) => (cancelled = () => resolve('cancelled')))
        const ctx = [...registered].reverse().find((c) => isPatrolCoordinate(c.thread))!
        // A behavior that never returns waits, like `hang`, until the turn is cancelled.
        return await Promise.race([
          behavior.patrol(ctx).then(() => 'end_turn'),
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
  const patrols = () => dispatched.filter((c) => isPatrolCoordinate(c.msg.thread))
  const reports = () => dispatched.filter((c) => c.msg.parentReport === true)
  /** Every turn dispatched so far, and any it dispatched in turn, has settled, and so has the patrol bookkeeping. */
  const settled = async () => {
    for (let seen = -1; seen !== dispatched.length;) {
      seen = dispatched.length
      await Promise.all(dispatched.map((c) => c.turn))
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  const deps = { ...d.mcp.deps, canRun: () => true }
  return { daemon, d, behavior, hosts, registered, dispatched, patrols, reports, settled, deps }
}

const scopeOf = (d: any, agentId = 'bot-a'): string => d.transportScopeForIntegrationIds([`int-${agentId}`])

/** The conversation's long session in C1, which an item taken there reports into. */
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

async function takeItem(d: any, over: { agentId?: string; nextCheck?: number; title?: string } = {}) {
  const agentId = over.agentId ?? 'bot-a'
  return await d.store.assistantItems.create({
    agentId,
    title: over.title ?? 'Watch the release build',
    doneWhen: 'The release is published',
    nextCheck: over.nextCheck ?? Date.now() - MINUTE,
    origin: { platform: 'slack', channel: 'C1', transportScope: scopeOf(d, agentId) },
    followers: [
      {
        identity: 'slack:T0EXAMPLE:U0ALICE',
        place: { platform: 'slack', channel: 'C1', transportScope: scopeOf(d, agentId) }
      }
    ],
    summary: 'Alice asked to hear when the release is out.'
  })
}

/** A patrol that saw nothing new: one observation and the next check, no report. */
const quiet =
  (deps: any): PatrolBehavior =>
  async (ctx) => {
    const itemId = await deps.assistantItems.patrol.itemFor(ctx)
    const current = ((await executeTool(ctx, 'listItems', { itemId }, deps)) as any).items[0]
    await executeTool(
      ctx,
      'updateItem',
      {
        itemId: current.id,
        version: current.version,
        observation: 'The build is still running.',
        nextCheck: new Date(Date.now() + 60 * MINUTE).toISOString()
      },
      deps
    )
  }

const patrolState = (d: any, itemId: string) => d.store.assistantPatrols.get('bot-a', itemId)

describe('a due next check wakes one patrol', () => {
  it('patrols a due item once, in a read-only sub-session of the place, and stays silent when nothing changed', async () => {
    const { daemon, d, behavior, hosts, patrols, reports, settled, deps } = await boot(
      scaffold([{ id: 'bot-a', assistantMode: ON, permissionMode: 'bypassPermissions' }])
    )
    const place = await seedPlace(d)
    const item = await takeItem(d)
    behavior.patrol = quiet(deps)

    await d.patrols.sweep()
    await vi.waitFor(() => expect(patrols()).toHaveLength(1), WAIT)
    await settled()

    const [patrol] = patrols()
    expect(patrol!.msg).toMatchObject({ channel: 'C1', source: 'agent', headless: true })
    expect(isSubsessionCoordinate(patrol!.msg.thread)).toBe(true)
    expect(patrol!.msg.text).toContain(`Item ${item.id}`)
    expect(patrol!.msg.text).toContain('Watch the release build')
    // It inherits the place's long session, and owes no report back.
    expect(patrol!.callMeta).toMatchObject({ callFrom: 'bot-a', hopCount: 0, originSessionId: 'sid-parent-bot-a' })
    expect(patrol!.callMeta.needsReply).toBeUndefined()
    const key = sessionKey('slack', 'C1', patrol!.msg.thread!, 'bot-a', place.scope)
    expect(await d.store.assistantSubsessions.get('bot-a', key)).toMatchObject({
      kind: 'patrol',
      state: 'done',
      parentSessionId: 'sid-parent-bot-a'
    })
    expect(await d.store.getSession(key)).toMatchObject({ originSessionId: 'sid-parent-bot-a' })
    // Nothing changed, so nothing reached the conversation.
    expect(reports()).toHaveLength(0)
    const after = await d.store.assistantItems.get('bot-a', item.id)
    expect(after.observations.map((o: any) => [o.text, o.author])).toEqual([['The build is still running.', 'patrol']])

    // The runtime's own read-only mode, never the agent's, and no plan-mode exit nobody could approve.
    const host = hosts.find((h) => h.prompt.mock.calls.some((c: any) => JSON.stringify(c).includes(PATROL_OPENING)))
    const patrolSession = host.prompt.mock.calls.find((c: any) => JSON.stringify(c).includes(PATROL_OPENING))[0]
    expect(
      host.setSessionPermissionMode.mock.calls.filter((c: any) => c[0] === patrolSession).map((c: any) => c[1])
    ).toEqual(['plan'])
    expect(host.newSession.mock.calls.at(-1)?.[6]).toEqual(CLAUDE_HEADLESS_DISALLOWED_TOOLS)

    // Not again for the same next check, however often the sweep runs.
    await d.patrols.sweep()
    await d.patrols.sweep()
    await settled()
    expect(patrols()).toHaveLength(1)
    await daemon.stop()
  })

  it('reports a change into the conversation the item was taken in, once', async () => {
    const { daemon, d, behavior, patrols, reports, settled, deps } = await boot(
      scaffold([{ id: 'bot-a', assistantMode: ON }])
    )
    const place = await seedPlace(d)
    const item = await takeItem(d)
    behavior.patrol = async (ctx) => {
      await executeTool(
        ctx,
        'updateItem',
        {
          itemId: item.id,
          version: item.version,
          status: 'done',
          observation: 'The release is published.',
          report: 'The release is out.'
        },
        deps
      )
    }

    await d.patrols.sweep()
    await vi.waitFor(() => expect(reports()).toHaveLength(1), WAIT)
    await settled()

    const [report] = reports()
    expect(report!.msg).toMatchObject({ channel: 'C1', sessionThread: place.coordinate, source: 'agent' })
    expect(report!.msg.text).toContain(
      `The scheduled check of item ${item.id} ("Watch the release build") found a change`
    )
    expect(report!.msg.text).toContain('The release is out.')
    expect(report!.callMeta).toMatchObject({ callFrom: 'bot-a', hopCount: 1 })
    expect(reports()).toHaveLength(1)
    expect((await d.store.assistantItems.get('bot-a', item.id)).status).toBe('done')
    expect(patrols()).toHaveLength(1)
    await daemon.stop()
  })

  it('records why when the item’s conversation has no session to report to, and does not try that check again', async () => {
    const { daemon, d, patrols, settled } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const item = await takeItem(d)

    await d.patrols.sweep()
    await d.patrols.sweep()
    await settled()

    expect(patrols()).toHaveLength(0)
    const after = await d.store.assistantItems.get('bot-a', item.id)
    expect(after.observations.map((o: any) => o.text)).toEqual([
      'No scheduled check ran: the conversation this item was taken in has no ongoing session to report to.'
    ])
    await daemon.stop()
  })

  it('patrols nothing while the agent is paused, then an overdue item exactly once', async () => {
    const { daemon, d, behavior, patrols, settled, deps } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    await seedPlace(d)
    await takeItem(d, { nextCheck: Date.now() - 3 * 60 * MINUTE })
    behavior.patrol = quiet(deps)

    d.agents.get('bot-a').pause = true
    await d.patrols.sweep()
    await settled()
    expect(patrols()).toHaveLength(0)

    d.agents.get('bot-a').pause = false
    await d.patrols.sweep()
    await vi.waitFor(() => expect(patrols()).toHaveLength(1), WAIT)
    await settled()
    await d.patrols.sweep()
    await settled()
    expect(patrols()).toHaveLength(1)
    await daemon.stop()
  })

  it('leaves the check due when a pause stops the patrol, and runs it once after', async () => {
    const { daemon, d, behavior, patrols, reports, settled, deps } = await boot(
      scaffold([{ id: 'bot-a', assistantMode: ON }])
    )
    await seedPlace(d)
    const item = await takeItem(d)
    behavior.patrol = 'hang'

    await d.patrols.sweep()
    await vi.waitFor(() => expect(patrols()).toHaveLength(1), WAIT)
    d.agents.get('bot-a').pause = true
    await d.interruptAgentTurns('bot-a', 'pause')
    await settled()
    expect(await patrolState(d, item.id)).toMatchObject({ failures: 0, runningKey: null, patrolledNextCheck: null })
    expect(reports()).toHaveLength(0)

    d.agents.get('bot-a').pause = false
    behavior.patrol = quiet(deps)
    await d.patrols.sweep()
    await vi.waitFor(() => expect(patrols()).toHaveLength(2), WAIT)
    await settled()
    expect(await patrolState(d, item.id)).toMatchObject({ patrolledNextCheck: item.nextCheck })
    await daemon.stop()
  })

  it('leaves the patrolling to the daemon holding the agent’s duty', async () => {
    const { daemon, d, patrols, settled } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    await seedPlace(d)
    await takeItem(d)
    d.servesAgent = () => false

    await d.patrols.sweep()
    await settled()
    expect(patrols()).toHaveLength(0)
    await daemon.stop()
  })

  it('patrols nothing for an agent outside assistant mode', async () => {
    const { daemon, d, patrols, settled } = await boot(scaffold([{ id: 'bot-b' }]))
    await seedPlace(d, 'bot-b')
    await takeItem(d, { agentId: 'bot-b' })

    await d.patrols.sweep()
    await settled()
    expect(patrols()).toHaveLength(0)
    await daemon.stop()
  })
})

describe('one patrol at a time, beside the delegations', () => {
  it('runs one patrol per agent, and the next item once it ends', async () => {
    const { daemon, d, behavior, patrols, settled, deps } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    await seedPlace(d)
    await takeItem(d, { title: 'First', nextCheck: Date.now() - 2 * MINUTE })
    await takeItem(d, { title: 'Second', nextCheck: Date.now() - MINUTE })
    behavior.patrol = 'hang'

    await d.patrols.sweep()
    await vi.waitFor(() => expect(patrols()).toHaveLength(1), WAIT)
    await d.patrols.sweep()
    expect(patrols()).toHaveLength(1)
    expect(patrols()[0]!.msg.text).toContain('Title: First')

    behavior.patrol = quiet(deps)
    await d.interruptTurn('bot-a', sessionKey('slack', 'C1', patrols()[0]!.msg.thread!, 'bot-a', scopeOf(d)), 'stop')
    await settled()
    await d.patrols.sweep()
    await vi.waitFor(() => expect(patrols()).toHaveLength(2), WAIT)
    expect(patrols()[1]!.msg.text).toContain('Title: Second')
    await settled()
    await daemon.stop()
  })

  it('keeps patrols out of the concurrent sub-session limit, both ways', async () => {
    const { daemon, d, behavior, patrols, settled } = await boot(
      scaffold([{ id: 'bot-a', assistantMode: { ...ON, limits: { maxConcurrentSubsessions: 1 } } }])
    )
    const place = await seedPlace(d)
    await takeItem(d)
    behavior.patrol = 'hang'
    await d.patrols.sweep()
    await vi.waitFor(() => expect(patrols()).toHaveLength(1), WAIT)

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
    // The running patrol takes none of the user's one place …
    expect(await d.collab.messageAgent(delegation(1))).toMatchObject({ delivered: true, subsession: true })
    // … which the delegation now holds.
    expect(await d.collab.messageAgent(delegation(2))).toMatchObject({ delivered: false, reason: 'subsession_limit' })
    await d.interruptAgentTurns('bot-a', 'stop')
    await settled()
    await daemon.stop()
  })
})

describe('a patrol reads and records, nothing else', () => {
  it('is offered the reads and its own updateItem, never a write, a post, a new item or a draft', async () => {
    const { daemon, d, behavior, registered, patrols, settled, deps } = await boot(
      scaffold([{ id: 'bot-a', assistantMode: ON }])
    )
    await seedPlace(d)
    await takeItem(d)
    behavior.patrol = quiet(deps)
    await d.patrols.sweep()
    await vi.waitFor(() => expect(patrols()).toHaveLength(1), WAIT)
    await settled()

    const ctx = registered.find((c) => isPatrolCoordinate(c.thread))!
    const names = ctx.tools.map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining(['listItems', 'updateItem', 'recall', 'getChannelHistory', 'readMemory'])
    )
    for (const write of [
      'sendMessage',
      'shareFile',
      'takeItem',
      'followItem',
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
    expect(ctx.tools.find((t) => t.name === 'updateItem')).toBe(PATROL_UPDATE_ITEM_TOOL)
    // A name it was not offered is refused, whatever the runtime sends.
    await expect(executeTool(ctx, 'sendMessage', { toAgent: 'bot-a', message: 'hi' }, deps)).rejects.toThrow(
      'sendMessage is not available in a read-only patrol'
    )
    await expect(executeTool(ctx, 'takeItem', { title: 'x', doneWhen: 'y' }, deps)).rejects.toThrow(
      'not available in a read-only patrol'
    )
    // Another session of the agent keeps its whole tool set.
    const other = registered.find((c) => !isPatrolCoordinate(c.thread))
    if (other) expect(other.tools.map((t) => t.name)).toContain('sendMessage')
    await daemon.stop()
  })

  it('refuses whatever would need approval in a patrol, without asking anyone', async () => {
    const { daemon, d, behavior, patrols, settled } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    await seedPlace(d)
    await takeItem(d)
    behavior.patrol = 'hang'
    await d.patrols.sweep()
    await vi.waitFor(
      () => expect([...d.pending.values()].some((p: any) => isPatrolCoordinate(p.plan.sessionThread))).toBe(true),
      WAIT
    )
    const p = [...d.pending.values()].find((turn: any) => isPatrolCoordinate(turn.plan.sessionThread)) as any
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
    expect(patrols()).toHaveLength(1)
    await daemon.stop()
  })

  it('writes only its own item, never sooner than five minutes, and never drops it', async () => {
    const { daemon, d, behavior, patrols, settled, deps } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    await seedPlace(d)
    const item = await takeItem(d)
    const other = await takeItem(d, { title: 'Other', nextCheck: Date.now() + 60 * MINUTE })
    const results: unknown[] = []
    behavior.patrol = async (ctx) => {
      for (const args of [
        { itemId: other.id, observation: 'x' },
        {
          itemId: item.id,
          version: item.version,
          nextCheck: new Date(Date.now() + MINUTE).toISOString(),
          observation: 'x'
        },
        { itemId: item.id, version: item.version, status: 'dropped', observation: 'x' }
      ])
        results.push(await executeTool(ctx, 'updateItem', args, deps).catch((err: Error) => err.message))
      await quiet(deps)(ctx)
    }
    await d.patrols.sweep()
    await vi.waitFor(() => expect(patrols()).toHaveLength(1), WAIT)
    await settled()
    expect(results[0]).toBe(`this patrol checks item ${item.id} only; nothing was written`)
    expect(results[1]).toBe('nextCheck must be at least five minutes from now; nothing was written')
    expect(String(results[2])).toContain('argument status must be one of: active, waiting, done')
    expect((await d.store.assistantItems.get('bot-a', other.id)).observations).toEqual([])
    await daemon.stop()
  })
})

describe('failures back off and stop', () => {
  it('records a failure, backs off, and after five in a row stops and tells the conversation once', async () => {
    const { daemon, d, behavior, patrols, reports, settled } = await boot(
      scaffold([{ id: 'bot-a', assistantMode: ON }])
    )
    await seedPlace(d)
    const item = await takeItem(d)
    behavior.patrol = 'throw'

    await d.patrols.sweep()
    await vi.waitFor(() => expect(patrols()).toHaveLength(1), WAIT)
    await settled()
    const first = await patrolState(d, item.id)
    expect(first).toMatchObject({ failures: 1, stopped: false, patrolledNextCheck: null })
    expect(first.retryAt).toBeGreaterThanOrEqual(Date.now() + 2 * MINUTE - 5_000)
    expect((await d.store.assistantItems.get('bot-a', item.id)).observations.map((o: any) => o.text)).toEqual([
      'Scheduled check failed (error); the next attempt is in 2 minutes.'
    ])
    // Backing off: nothing before the wait is over.
    await d.patrols.sweep()
    await settled()
    expect(patrols()).toHaveLength(1)

    for (let n = 2; n <= PATROL_MAX_FAILURES; n++) {
      await d.store.assistantPatrols.db.query(
        'UPDATE assistant_patrol SET retryAt = 0 WHERE agentId = ? AND itemId = ?',
        ['bot-a', item.id]
      )
      await d.patrols.sweep()
      await vi.waitFor(() => expect(patrols()).toHaveLength(n), WAIT)
      await settled()
    }
    expect(await patrolState(d, item.id)).toMatchObject({ failures: PATROL_MAX_FAILURES, stopped: true })
    expect(reports()).toHaveLength(1)
    expect(reports()[0]!.msg.text).toContain(
      `Scheduled checks of item ${item.id} ("Watch the release build") stopped after 5`
    )

    await d.store.assistantPatrols.db.query(
      'UPDATE assistant_patrol SET retryAt = 0 WHERE agentId = ? AND itemId = ?',
      ['bot-a', item.id]
    )
    await d.patrols.sweep()
    await settled()
    expect(patrols()).toHaveLength(PATROL_MAX_FAILURES)
    expect(reports()).toHaveLength(1)
    await daemon.stop()
  })

  it('counts a patrol that recorded nothing as a failure, and sends no "ended without reporting" into the place', async () => {
    const { daemon, d, patrols, reports, settled } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    await seedPlace(d)
    const item = await takeItem(d)

    await d.patrols.sweep()
    await vi.waitFor(() => expect(patrols()).toHaveLength(1), WAIT)
    await settled()
    expect(await patrolState(d, item.id)).toMatchObject({ failures: 1 })
    expect((await d.store.assistantItems.get('bot-a', item.id)).observations.map((o: any) => o.text)).toEqual([
      'Scheduled check failed (nothing recorded); the next attempt is in 2 minutes.'
    ])
    expect(reports()).toHaveLength(0)
    await daemon.stop()
  })
})

describe('a patrol in its conversation’s sub-session panel', () => {
  it('is listed under the conversation, and the panel’s stop ends it silently with its check done', async () => {
    const { daemon, d, behavior, patrols, reports, settled } = await boot(
      scaffold([{ id: 'bot-a', assistantMode: ON }])
    )
    await seedPlace(d)
    const item = await takeItem(d)
    behavior.patrol = 'hang'
    await d.patrols.sweep()
    await vi.waitFor(() => expect(patrols()).toHaveLength(1), WAIT)
    const key = sessionKey('slack', 'C1', patrols()[0]!.msg.thread!, 'bot-a', scopeOf(d))
    await vi.waitFor(async () => expect((await d.store.getSession(key))?.sessionId).toBeTruthy(), WAIT)
    const sessionId = (await d.store.getSession(key)).sessionId
    // The same seam the control plane's frames reach, with the daemon's own cancel core behind its stop.
    const activity = createAssistantActivity({
      store: () => d.store,
      agent: (agentId) => d.agents.get(agentId),
      now: () => Date.now(),
      decideDraft: async () => {
        throw new Error('not used')
      },
      stopSession: (k, actor) => d.commands.cancelSessionByKey(k, actor)
    })

    const listed = (await activity.read({
      agentId: 'bot-a',
      operation: 'subsessions',
      limit: 10,
      parent: { sessionId: 'sid-parent-bot-a' }
    })) as any
    expect(listed.subsessions).toEqual([expect.objectContaining({ sessionId, state: 'open' })])

    expect(
      await activity.write({
        agentId: 'bot-a',
        operation: 'stop-subsession',
        sessionId,
        actor: { userId: 'usr-1', name: 'Grace' }
      })
    ).toEqual({ operation: 'stop-subsession', result: 'stopped' })
    await vi.waitFor(async () => expect((await patrolState(d, item.id))?.runningKey).toBeNull(), WAIT)
    await settled()

    // Settled by the patrol path: no "ended without reporting" into the place, and the check is done.
    expect(reports()).toHaveLength(0)
    expect(await patrolState(d, item.id)).toMatchObject({ failures: 0, patrolledNextCheck: item.nextCheck })
    expect(await d.store.assistantSubsessions.get('bot-a', key)).toMatchObject({ kind: 'patrol', state: 'failed' })
    await daemon.stop()
  })
})

describe('a patrol replayed after a handover', () => {
  /** The patrol's turn is cut for a handover that keeps it, then a fresh patrol service replays it, as a successor daemon would. */
  async function handOver(d: any, behavior: { patrol: unknown }, next: PatrolBehavior) {
    await d.interruptAgentTurns('bot-a', 'handover', 'handoff')
    d.assistantPatrolService = undefined
    d.absorbedContextTs.clear()
    behavior.patrol = next
    await d.replayInbox(new Set(['bot-a']))
  }
  const nothing: PatrolBehavior = async () => {}

  it('counts an empty completion on a fresh service as a failure, backs off and keeps the check due', async () => {
    const { daemon, d, behavior, patrols, reports, settled } = await boot(
      scaffold([{ id: 'bot-a', assistantMode: ON }])
    )
    await seedPlace(d)
    const item = await takeItem(d)
    behavior.patrol = 'hang'
    await d.patrols.sweep()
    await vi.waitFor(() => expect(patrols()).toHaveLength(1), WAIT)
    await vi.waitFor(async () => expect((await patrolState(d, item.id))?.runningKey).toBeTruthy(), WAIT)

    await handOver(d, behavior, nothing)
    await vi.waitFor(async () => expect((await patrolState(d, item.id))?.failures).toBe(1), WAIT)
    await settled()

    const state = await patrolState(d, item.id)
    expect(state).toMatchObject({ failures: 1, stopped: false, patrolledNextCheck: null, runningKey: null })
    expect(state.retryAt).toBeGreaterThanOrEqual(Date.now() + 2 * MINUTE - 5_000)
    expect((await d.store.assistantItems.get('bot-a', item.id)).observations.map((o: any) => o.text)).toEqual([
      'Scheduled check failed (nothing recorded); the next attempt is in 2 minutes.'
    ])
    expect(reports()).toHaveLength(0)
    // The check stays due once the backoff is over.
    expect(await d.store.assistantPatrols.due('bot-a', Date.now() + 3 * MINUTE, 10)).toEqual([
      { itemId: item.id, nextCheck: item.nextCheck }
    ])
    await daemon.stop()
  })

  it('still delivers the report and counts the observation the cut turn recorded', async () => {
    const { daemon, d, behavior, patrols, reports, settled, deps } = await boot(
      scaffold([{ id: 'bot-a', assistantMode: ON }])
    )
    await seedPlace(d)
    const item = await takeItem(d)
    let recorded = false
    behavior.patrol = async (ctx) => {
      await executeTool(
        ctx,
        'updateItem',
        { itemId: item.id, observation: 'The release is published.', report: 'The release is out.' },
        deps
      )
      recorded = true
      await new Promise(() => {})
    }
    await d.patrols.sweep()
    await vi.waitFor(() => expect(recorded).toBe(true), WAIT)

    await handOver(d, behavior, nothing)
    await vi.waitFor(() => expect(reports()).toHaveLength(1), WAIT)
    await settled()

    expect(reports()[0]!.msg.text).toContain('The release is out.')
    expect(await patrolState(d, item.id)).toMatchObject({ failures: 0, patrolledNextCheck: item.nextCheck })
    // The replay ran the same patrol; no second one started.
    expect(new Set(patrols().map((c) => c.msg.thread)).size).toBe(1)
    await daemon.stop()
  })
})

/** A patrol that saw a change: it records it and reports it, after `first` ran in its turn. */
const reporting =
  (deps: any, item: any, first: () => Promise<void> = async () => {}): PatrolBehavior =>
  async (ctx) => {
    await first()
    await executeTool(
      ctx,
      'updateItem',
      {
        itemId: item.id,
        version: item.version,
        status: 'done',
        observation: 'The release is published.',
        report: 'The release is out.'
      },
      deps
    )
  }

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

describe('a patrol passes on what it found before it settles', () => {
  it('settles a run only once its report is in', async () => {
    const { daemon, d, behavior, reports, settled, deps } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    await seedPlace(d)
    const item = await takeItem(d)
    behavior.patrol = reporting(deps, item)
    let release!: () => void
    const seen = watchReports(d, new Promise<void>((resolve) => (release = resolve)))

    await d.patrols.sweep()
    await vi.waitFor(() => expect(seen.calls).toBe(1), WAIT)
    // The report is still on its way, so the run still holds it and its check is not done.
    const held = await patrolState(d, item.id)
    expect(held).toMatchObject({ runningReport: 'The release is out.', patrolledNextCheck: null })
    expect(held.runningKey).toBeTruthy()

    release()
    await vi.waitFor(async () => expect((await patrolState(d, item.id))?.runningKey).toBeNull(), WAIT)
    await settled()
    expect(reports()).toHaveLength(1)
    expect(await patrolState(d, item.id)).toMatchObject({ patrolledNextCheck: item.nextCheck, runningReport: null })
    await daemon.stop()
  })

  it('delivers again after a crash between its report and its settling, and the conversation hears it once', async () => {
    const { daemon, d, behavior, hosts, patrols, reports, settled, deps } = await boot(
      scaffold([{ id: 'bot-a', assistantMode: ON }])
    )
    const place = await seedPlace(d)
    const item = await takeItem(d)
    behavior.patrol = reporting(deps, item)
    const seen = watchReports(d)
    // The process dies after the report is in, before the run is settled.
    const ledger = d.store.assistantPatrols
    const succeed = ledger.succeed.bind(ledger)
    let crashed = false
    ledger.succeed = async (...args: unknown[]) => {
      if (crashed) return await succeed(...args)
      crashed = true
      throw new Error('the daemon was killed')
    }

    await d.patrols.sweep()
    await vi.waitFor(() => expect(crashed).toBe(true), WAIT)
    await settled()
    expect(reports()).toHaveLength(1)
    expect((await patrolState(d, item.id)).runningKey).toBeTruthy()

    // The next start finds the run its turn left unsettled, and settles it without a second report.
    d.assistantPatrolService = undefined
    await d.replayInbox(new Set(['bot-a']))
    await settled()

    const key = sessionKey('slack', 'C1', patrols()[0]!.msg.thread!, 'bot-a', place.scope)
    expect(await patrolState(d, item.id)).toMatchObject({ runningKey: null, patrolledNextCheck: item.nextCheck })
    expect(await d.store.assistantSubsessions.get('bot-a', key)).toMatchObject({ state: 'done' })
    expect(seen.calls).toBe(2)
    expect(reports()).toHaveLength(1)
    expect(told(hosts, 'The release is out.')).toBe(1)
    expect((await d.store.assistantItems.get('bot-a', item.id)).observations.map((o: any) => o.text)).toEqual([
      'The release is published.'
    ])
    expect(patrols()).toHaveLength(1)
    await daemon.stop()
  })

  it('leaves a report a drain held back to the next start, which delivers it once', async () => {
    const { daemon, d, behavior, patrols, reports, settled, deps } = await boot(
      scaffold([{ id: 'bot-a', assistantMode: ON }])
    )
    await seedPlace(d)
    const item = await takeItem(d)
    // The daemon starts draining as the patrol's turn ends.
    behavior.patrol = async (ctx) => {
      await reporting(deps, item)(ctx)
      d.draining = true
    }

    await d.patrols.sweep()
    await vi.waitFor(() => expect(patrols()).toHaveLength(1), WAIT)
    await settled()
    expect(reports()).toHaveLength(0)
    expect(await patrolState(d, item.id)).toMatchObject({
      runningReport: 'The release is out.',
      patrolledNextCheck: null
    })

    d.draining = false
    d.assistantPatrolService = undefined
    await d.replayInbox(new Set(['bot-a']))
    await settled()
    await d.replayInbox(new Set(['bot-a']))
    await settled()

    expect(reports()).toHaveLength(1)
    expect(reports()[0]!.msg.text).toContain('The release is out.')
    expect(await patrolState(d, item.id)).toMatchObject({ runningKey: null, patrolledNextCheck: item.nextCheck })
    expect(patrols()).toHaveLength(1)
    await daemon.stop()
  })

  it('records a report the conversation refused on the item and settles the run as before', async () => {
    const { daemon, d, behavior, settled, deps } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    await seedPlace(d)
    const item = await takeItem(d)
    behavior.patrol = reporting(deps, item)
    d.reportIntoParent = async () => false

    await d.patrols.sweep()
    await vi.waitFor(async () => expect((await patrolState(d, item.id))?.patrolledNextCheck).toBe(item.nextCheck), WAIT)
    await settled()

    expect(await patrolState(d, item.id)).toMatchObject({ runningKey: null, failures: 0 })
    expect((await d.store.assistantItems.get('bot-a', item.id)).observations.map((o: any) => o.text)).toEqual([
      'The release is published.',
      'A report from a scheduled check could not reach the conversation the item was taken in.'
    ])
    await daemon.stop()
  })
})

describe('a patrol report after `!new`', () => {
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

  it('lands in the conversation’s current session, not the one the patrol started under', async () => {
    const { daemon, d, behavior, patrols, reports, settled, deps } = await boot(
      scaffold([{ id: 'bot-a', assistantMode: ON }])
    )
    const place = await seedPlace(d)
    const item = await takeItem(d)
    let next = ''
    behavior.patrol = reporting(deps, item, async () => {
      next = await rotate(d, place, true)
    })

    await d.patrols.sweep()
    await vi.waitFor(() => expect(reports()).toHaveLength(1), WAIT)
    await settled()

    expect(next).not.toBe(place.coordinate)
    expect(reports()[0]!.msg).toMatchObject({ channel: 'C1', sessionThread: next })
    expect(reports()[0]!.msg.text).toContain('The release is out.')
    // The patrol still belongs to the session it started under.
    const key = sessionKey('slack', 'C1', patrols()[0]!.msg.thread!, 'bot-a', place.scope)
    expect(await d.store.assistantSubsessions.get('bot-a', key)).toMatchObject({
      parentSessionId: 'sid-parent-bot-a',
      state: 'done'
    })
    await daemon.stop()
  })

  it('falls back to the session it started under while the new one has not begun', async () => {
    const { daemon, d, behavior, reports, settled, deps } = await boot(scaffold([{ id: 'bot-a', assistantMode: ON }]))
    const place = await seedPlace(d)
    const item = await takeItem(d)
    behavior.patrol = reporting(deps, item, async () => {
      await rotate(d, place, false)
    })

    await d.patrols.sweep()
    await vi.waitFor(() => expect(reports()).toHaveLength(1), WAIT)
    await settled()

    expect(reports()[0]!.msg).toMatchObject({ channel: 'C1', sessionThread: place.coordinate })
    await daemon.stop()
  })
})

describe('the daily patrol budget', () => {
  it('starts no patrol past the agent’s budget in 24 hours', async () => {
    expect(DEFAULT_DAILY_PATROL_BUDGET).toBe(50)
    const { daemon, d, behavior, patrols, settled, deps } = await boot(
      scaffold([{ id: 'bot-a', assistantMode: { ...ON, limits: { dailyPatrolBudget: 1 } } }])
    )
    await seedPlace(d)
    await takeItem(d, { title: 'First', nextCheck: Date.now() - 2 * MINUTE })
    await takeItem(d, { title: 'Second', nextCheck: Date.now() - MINUTE })
    behavior.patrol = quiet(deps)

    await d.patrols.sweep()
    await vi.waitFor(() => expect(patrols()).toHaveLength(1), WAIT)
    await settled()
    await d.patrols.sweep()
    await settled()
    expect(patrols()).toHaveLength(1)
    await daemon.stop()
  })
})

describe('item tool text', () => {
  it('says a next check schedules a read-only check that reports only a change', () => {
    const text = (name: string) => JSON.stringify(ASSISTANT_ITEM_TOOLS.find((t) => t.name === name))
    expect(text('takeItem')).toContain('A next check schedules a read-only check of the item at that time')
    expect(text('takeItem')).toContain('reports here only if something changed')
    expect(text('takeItem')).not.toContain('cannot wake yourself')
    expect(text('updateItem')).toContain('A new nextCheck schedules the next read-only check of the item')
    expect(text('takeItem')).not.toContain('nothing wakes you')
    expect(text('updateItem')).not.toContain('nothing wakes you')
  })

  it('advertises exactly the patrol updateItem’s arguments', () => {
    const view = (schema: { properties?: Record<string, unknown>; required?: string[] }) => ({
      properties: Object.keys(schema.properties ?? {}).sort(),
      required: [...(schema.required ?? [])].sort()
    })
    expect(view(z.toJSONSchema(PATROL_UPDATE_ITEM_ARGS, { io: 'input', unrepresentable: 'any' }) as never)).toEqual(
      view(PATROL_UPDATE_ITEM_TOOL.inputSchema as never)
    )
  })

  it('filters a tool list to reads and the patrol’s own updateItem', () => {
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
        { organizationKnowledge: true, decisions: true, currentPlatform: 'slack', assistantMode: true }
      ),
      ...ASSISTANT_ITEM_TOOLS
    ]
    const names = patrolTools(all).map((t) => t.name)
    expect(names).not.toContain('sendMessage')
    expect(names).not.toContain('takeItem')
    expect(names).not.toContain('evaluateDecision')
    expect(names.filter((n) => n === 'updateItem')).toHaveLength(1)
  })
})
