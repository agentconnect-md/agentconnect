// The first look (assistant-mode.md §5.13): a follow-up of its place that reads the place once, within its bounds, and reports to the place's long session.
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { executeTool, type SessionContext } from '../src/mcp/ops.js'
import { FIRST_LOOK_TOOL } from '../src/mcp/ops/first-look.js'
import { LIST_TASKS_TOOL } from '../src/mcp/ops/assistant-subsessions.js'
import { NO_FOLLOW_UPS, standingSummaryFor } from '../src/assistant/standing-summary.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { isAppendCoordinate } from '../src/session/append-coordinate.js'
import { isFirstLookCoordinate } from '../src/session/subsession-coordinate.js'
import { CHECK_MAX_FAILURES } from '../src/store/assistant-checks.js'
import { sessionKey } from '../src/store/local-store.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

const modelText = (msg: NormalizedMessage): string => msg.turnBody?.prompt ?? msg.text ?? ''

const TEST_ORG = '00000000-0000-0000-0000-0000000000a1'
const ON = { enabled: true }
const DAY = 24 * 60 * 60_000
const LOOK_OPENING = 'You are taking a first look at'

function scaffold(opts: { budget?: number; bindRules?: unknown[] } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-first-look-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: [] } }
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
      integrations: [
        {
          id: 'int-bot-a',
          platform: 'slack',
          core: {
            bindRules: opts.bindRules ?? [{ match: { kind: 'mention' } }],
            sessionModes: [{ channel: 'C1', mode: 'append' }]
          },
          config: { botToken: 'xoxb-bot-a', appToken: 'xapp-bot-a' }
        }
      ],
      output: { mode: 'low' },
      assistantMode: { ...ON, ...(opts.budget !== undefined ? { limits: { dailyCheckBudget: opts.budget } } : {}) }
    })
  )
  return root
}

/** Slack's history of C1 as the fake answers it: each call takes the next page. */
type HistoryPage = { messages: { ts: string; user?: string; text: string }[]; next_cursor?: string }

async function boot(root: string, pages: HistoryPage[] = []) {
  const behavior: { look: ((ctx: SessionContext) => Promise<unknown>) | 'hang' | 'throw' } = { look: async () => {} }
  const hostFactory = () => {
    let cancelled: (() => void) | undefined
    return {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => `acp-${randomUUID()}`),
      permissionModeOptions: vi.fn(() => ({ current: undefined, modes: ['default', 'plan'] })),
      setSessionPermissionMode: vi.fn(async () => true),
      prompt: vi.fn(async (_sessionId: string, blocks: unknown[]) => {
        if (!JSON.stringify(blocks).includes(LOOK_OPENING)) return 'end_turn'
        if (behavior.look === 'throw') throw new Error('the runtime exited')
        if (behavior.look === 'hang') return await new Promise((resolve) => (cancelled = () => resolve('cancelled')))
        const ctx = [...registered].reverse().find((c) => isFirstLookCoordinate(c.thread))!
        await behavior.look(ctx)
        return 'end_turn'
      }),
      cancel: vi.fn(async () => cancelled?.()),
      stop: vi.fn(async () => {})
    } as any
  }
  const base = fakeSlackAppFactory()
  const slackAppFactory = ((...args: unknown[]) => {
    const app = (base as any)(...args)
    app.client.conversations.history = async () => {
      const page = pages.shift() ?? { messages: [] }
      return {
        messages: page.messages,
        ...(page.next_cursor ? { has_more: true, response_metadata: { next_cursor: page.next_cursor } } : {})
      }
    }
    return app
  }) as typeof base
  const daemon = new Daemon({ slackAppFactory, root, hostFactory })
  await daemon.start()
  const d = daemon as any
  const placement = { agentId: 'bot-a', daemonId: 'local-daemon', name: 'bot-a' }
  d.cpCollab.replace({
    generation: 0,
    channels: [{ orgId: TEST_ORG, platform: 'slack', channelId: 'C1', agents: [placement] }],
    agents: [{ ...placement, orgId: TEST_ORG }]
  })
  const registered: SessionContext[] = []
  const register = d.mcp.register.bind(d.mcp)
  d.mcp.register = (ctx: SessionContext) => {
    registered.push(ctx)
    return register(ctx)
  }
  const dispatched: { msg: NormalizedMessage; callMeta?: any; turn: Promise<unknown> }[] = []
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
    dispatched.push({ msg, callMeta, turn: turn.catch(() => undefined) })
    return turn
  }
  const looks = () => dispatched.filter((c) => isFirstLookCoordinate(c.msg.thread))
  const reports = () => dispatched.filter((c) => c.msg.parentReport === true)
  const settled = async () => {
    for (let seen = -1; seen !== dispatched.length;) {
      seen = dispatched.length
      await Promise.all(dispatched.map((c) => c.turn))
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  const deps = { ...d.mcp.deps, canRun: () => true }
  return { daemon, d, behavior, registered, dispatched, looks, reports, settled, deps }
}

const scopeOf = (d: any): string => d.transportScopeForIntegrationIds(['int-bot-a'])

/** C1's long session, which asks for a first look and hears its report. */
async function seedPlace(d: any) {
  const scope = scopeOf(d)
  const coordinate = await d.store.resolveAppendCoordinate('bot-a', 'C1', scope, 1)
  const key = sessionKey('slack', 'C1', coordinate, 'bot-a', scope)
  await d.store.upsertSession({
    key,
    agentId: 'bot-a',
    platform: 'slack',
    channel: 'C1',
    thread: coordinate,
    transportScope: scope,
    acpSessionId: 'acp-parent',
    sessionId: 'sid-parent',
    state: 'idle',
    lastDeliveredTs: null,
    updatedAt: Date.now()
  })
  return { key, scope, coordinate }
}

const placeCtx = (place: { coordinate: string; scope: string }): SessionContext => ({
  agentId: 'bot-a',
  platform: 'slack',
  integrationId: 'int-bot-a',
  transportScope: place.scope,
  isDm: false,
  channel: 'C1',
  thread: place.coordinate,
  deliveryThread: '100.1',
  tools: [FIRST_LOOK_TOOL, LIST_TASKS_TOOL]
})

const REPORT = '## How this place works\nReleases are planned here.\n\n## Recurring\nA weekly sync.'

/** A first look that hands back its report. */
const handsBack = (deps: any) => async (ctx: SessionContext) => {
  await executeTool(ctx, 'recordCheck', { observation: 'Read 2 weeks of the place.', report: REPORT, done: true }, deps)
}

const slackTs = (ms: number): string => `${Math.floor(ms / 1000)}.000100`
const messages = (count: number, startMs: number) =>
  Array.from({ length: count }, (_, i) => ({ ts: slackTs(startMs - i * 60_000), user: 'U1', text: `message ${i}` }))

describe('a first look someone asks for', () => {
  it('reads its own place once, read-only, and reports to the long session with what to do next', async () => {
    const { daemon, d, behavior, registered, looks, reports, settled, deps } = await boot(scaffold())
    const place = await seedPlace(d)
    behavior.look = handsBack(deps)

    const started = (await executeTool(placeCtx(place), 'firstLook', {}, deps)) as any
    expect(started).toMatchObject({ started: true })
    await vi.waitFor(() => expect(looks()).toHaveLength(1), WAIT)
    await settled()

    const [look] = looks()
    const prompt = modelText(look!.msg)
    expect(prompt).toContain('You are taking a first look at "fake", a channel you are in. Read it, write')
    expect(prompt).toContain('the last 30 days or 500 messages, whichever')
    expect(prompt).toContain('Hand it back with recordCheck: a one-line observation, this report, and done set.')
    expect(prompt).toMatch(/actually do with its tools: .*sendMessage.*and your runtime’s own tools\./s)
    expect(look!.msg.initialSessionTitle).toBe('First look at fake')
    // Only the place's own reads, memory reads and writes, and recordCheck.
    const tools = registered.find((c) => isFirstLookCoordinate(c.thread))!.tools.map((t) => t.name)
    for (const present of ['getChannelHistory', 'writeMemory', 'createMemoryEntry', 'updateMemoryEntry', 'recordCheck'])
      expect(tools).toContain(present)
    for (const absent of [
      'recall',
      'sendMessage',
      'addReaction',
      'deleteMemoryEntry',
      'listChannels',
      'searchPublicMessages',
      'propose',
      'followUp'
    ])
      expect(tools).not.toContain(absent)

    // The report reaches the place's top level, with the handling first.
    expect(reports()).toHaveLength(1)
    const report = reports()[0]!.msg
    expect(report.thread).toBeUndefined()
    expect(report.sessionThread).toBe(place.coordinate)
    const text = modelText(report)
    expect(text).toContain('[first look] Your first look at "fake" reported back.')
    expect(text).toContain('reach you (@-mention me).')
    // Slack has approval cards, so its suggestions are offered with propose (§5.13).
    expect(text).toContain('2. Under it, offer each "Where I could help" item with propose.')
    expect(text).toContain(`Its report:\n\n${REPORT}`)

    // One check ends it as done; it is listed as a first look and takes no messages.
    const item = await d.store.assistantItems.byTaskKey('bot-a', started.taskId)
    expect(item).toMatchObject({ firstLook: 'requested', status: 'done', nextCheck: null })
    expect(await d.store.assistantChecks.checks('bot-a', item.id, 5)).toEqual([
      expect.objectContaining({ observation: 'Read 2 weeks of the place.', reported: true })
    ])
    const listed = (await executeTool(placeCtx(place), 'listTasks', {}, deps)) as any
    expect(listed.tasks).toEqual([
      expect.objectContaining({ kind: 'first look', state: 'done', label: 'First look at fake' })
    ])
    const messaged = await d.collab.continueSubsession({
      callerAgentId: 'bot-a',
      platform: 'slack',
      callerChannel: 'C1',
      callerThread: place.coordinate,
      callerTransportScope: place.scope,
      sessionId: started.taskId,
      text: 'Look again.',
      submissionId: randomUUID()
    })
    expect(messaged).toMatchObject({ delivered: false, reason: 'first_look' })
    // The standing list leaves it out: it is no commitment.
    const summary = await standingSummaryFor(d.store.assistantItems, d.agents.get('bot-a'), {
      platform: 'slack',
      channel: 'C1',
      transportScope: place.scope
    })
    expect(summary).toBe(NO_FOLLOW_UPS)
    await daemon.stop()
  })

  it('runs one at a time per place, and a new one once the last has ended', async () => {
    const { daemon, d, behavior, looks, settled, deps } = await boot(scaffold())
    const place = await seedPlace(d)
    behavior.look = 'hang'
    expect(await executeTool(placeCtx(place), 'firstLook', {}, deps)).toMatchObject({ started: true })
    await vi.waitFor(() => expect(looks()).toHaveLength(1), WAIT)
    expect(await executeTool(placeCtx(place), 'firstLook', {}, deps)).toMatchObject({
      started: false,
      reason: 'running'
    })
    await d.interruptAgentTurns('bot-a', 'stop')
    await settled()
    behavior.look = handsBack(deps)
    expect(await executeTool(placeCtx(place), 'firstLook', {}, deps)).toMatchObject({ started: true })
    await vi.waitFor(() => expect(looks()).toHaveLength(2), WAIT)
    await settled()
    await daemon.stop()
  })

  it('is refused past the day’s budget with the time it resets', async () => {
    const { daemon, d, deps } = await boot(scaffold({ budget: 1 }))
    const place = await seedPlace(d)
    await d.store.assistantChecks.db.query(
      'INSERT INTO assistant_check (agentId, itemId, checkNo, startedAt, reported) VALUES (?, ?, 1, ?, 0)',
      ['bot-a', 'an-earlier-check', Date.now() - 60_000]
    )
    const refused = (await executeTool(placeCtx(place), 'firstLook', {}, deps)) as any
    expect(refused).toMatchObject({ started: false, reason: 'budget' })
    expect(refused.note).toMatch(/a first look counts as one\. Nothing was started; ask again after \d{4}-/)
    await daemon.stop()
  })

  it('is refused outside the place’s long session', async () => {
    const { daemon, d, deps } = await boot(scaffold())
    const place = await seedPlace(d)
    const thread = { ...placeCtx(place), thread: '1700000000.000100' }
    expect(await executeTool(thread, 'firstLook', {}, deps)).toMatchObject({
      started: false,
      reason: 'not_long_session'
    })
    await daemon.stop()
  })

  it('reports once after five failures in a row and ends', async () => {
    const { daemon, d, behavior, looks, reports, settled, deps } = await boot(scaffold())
    const place = await seedPlace(d)
    behavior.look = 'throw'
    const started = (await executeTool(placeCtx(place), 'firstLook', {}, deps)) as any
    await vi.waitFor(() => expect(looks()).toHaveLength(1), WAIT)
    await settled()
    const item = await d.store.assistantItems.byTaskKey('bot-a', started.taskId)
    for (let n = 2; n <= CHECK_MAX_FAILURES; n++) {
      await d.store.assistantChecks.db.query(
        'UPDATE assistant_check_state SET retryAt = 0 WHERE agentId = ? AND itemId = ?',
        ['bot-a', item.id]
      )
      await d.followUpChecks.sweep()
      await vi.waitFor(() => expect(looks()).toHaveLength(n), WAIT)
      await settled()
    }
    expect(await d.store.assistantItems.get('bot-a', item.id)).toMatchObject({ status: 'dropped' })
    expect(reports()).toHaveLength(1)
    expect(modelText(reports()[0]!.msg)).toContain(
      '[first look] The first look at "fake" that was asked for here failed 5'
    )
    await daemon.stop()
  })
})

describe('what a first look may read', () => {
  it('reads only its own place, back at most 30 days and 500 messages in all', async () => {
    const now = Date.now()
    const pages: HistoryPage[] = [
      { messages: messages(300, now), next_cursor: 'c2' },
      { messages: messages(300, now - 300 * 60_000), next_cursor: 'c3' },
      {
        messages: [
          { ts: slackTs(now - 2 * DAY), text: 'recent' },
          { ts: slackTs(now - 40 * DAY), text: 'old' }
        ]
      }
    ]
    const { daemon, d, behavior, looks, settled, deps } = await boot(scaffold(), pages)
    const place = await seedPlace(d)
    const reads: any[] = []
    behavior.look = async (ctx) => {
      reads.push(await executeTool(ctx, 'getChannelHistory', {}, deps))
      reads.push(await executeTool(ctx, 'getChannelHistory', { cursor: 'c2' }, deps))
      reads.push(await executeTool(ctx, 'getChannelHistory', { cursor: 'c3' }, deps))
      reads.push(await executeTool(ctx, 'getChannelHistory', { channel: 'C2' }, deps).catch((e: Error) => e.message))
      reads.push(await executeTool(ctx, 'recall', { query: 'anything' }, deps).catch((e: Error) => e.message))
      await handsBack(deps)(ctx)
    }
    await executeTool(placeCtx(place), 'firstLook', {}, deps)
    await vi.waitFor(() => expect(looks()).toHaveLength(1), WAIT)
    await settled()
    expect(reads[0]).toMatchObject({ hasMore: true, nextCursor: 'c2' })
    expect(reads[0].messages).toHaveLength(300)
    expect(reads[1].messages).toHaveLength(200)
    expect(reads[1]).toMatchObject({ hasMore: false })
    expect(reads[1].note).toContain('has read its 500 messages')
    expect(reads[2].messages).toHaveLength(0)
    expect(reads[3]).toContain('a first look reads only its own place')
    expect(reads[4]).toContain('is not available')
    await daemon.stop()
  })

  it('reads nothing older than 30 days, and ends the read there', async () => {
    const now = Date.now()
    const pages: HistoryPage[] = [
      {
        messages: [
          { ts: slackTs(now - 2 * DAY), text: 'recent' },
          { ts: slackTs(now - 40 * DAY), text: 'old' }
        ],
        next_cursor: 'c2'
      }
    ]
    const { daemon, d, behavior, looks, settled, deps } = await boot(scaffold(), pages)
    const place = await seedPlace(d)
    let read: any
    behavior.look = async (ctx) => {
      read = await executeTool(ctx, 'getChannelHistory', {}, deps)
      await handsBack(deps)(ctx)
    }
    await executeTool(placeCtx(place), 'firstLook', {}, deps)
    await vi.waitFor(() => expect(looks()).toHaveLength(1), WAIT)
    await settled()
    expect(read.messages.map((m: any) => m.text)).toEqual(['recent'])
    expect(read).toMatchObject({ hasMore: false, note: "Older messages are past this first look's 30 days." })
    expect(read.nextCursor).toBeUndefined()
    await daemon.stop()
  })
})

describe('the bot joining a place', () => {
  it('takes one first look once the row is listed, and its report opens the place’s long session', async () => {
    const { daemon, d, behavior, looks, reports, settled, deps } = await boot(scaffold())
    behavior.look = handsBack(deps)
    await joins(d, 'C1', 'U0INVITER')
    await vi.waitFor(
      async () => expect(await d.store.assistantItems.latestFirstLook('bot-a', place(d))).toBeDefined(),
      WAIT
    )
    const item = await d.store.assistantItems.latestFirstLook('bot-a', place(d))
    expect(item).toMatchObject({ firstLook: 'joined', status: 'active', title: 'First look at fake' })
    expect(item.asker).toMatch(/^slack:.+:U0INVITER$/)
    // Nobody spoke there yet, so its owner is the coordinate the place's first message would key.
    expect(await d.store.placeSession('bot-a', 'slack', 'C1', scopeOf(d))).toBeUndefined()

    await d.followUpChecks.sweep()
    await vi.waitFor(() => expect(looks()).toHaveLength(1), WAIT)
    await settled()
    expect(modelText(looks()[0]!.msg)).toContain('a channel you were just added to.')
    expect(reports()).toHaveLength(1)
    expect(isAppendCoordinate(reports()[0]!.msg.sessionThread)).toBe(true)
    const opened = await d.store.placeSession('bot-a', 'slack', 'C1', scopeOf(d))
    expect(opened?.thread).toBe(reports()[0]!.msg.sessionThread)
    expect(await d.store.assistantItems.get('bot-a', item.id)).toMatchObject({ status: 'done' })

    // A rejoin takes none: the first look's row is the place's record.
    await d.store.db.prepare('DELETE FROM channel_intro WHERE agentId = ?').run('bot-a')
    await joins(d, 'C1')
    await d.takeJoinedFirstLooks()
    const rows = await d.store.assistantItems.list('bot-a', {})
    expect(rows.filter((row: any) => row.firstLook !== null)).toHaveLength(1)
    await daemon.stop()
  })

  it('takes the relay’s report of the bot joining as the same join', async () => {
    const { daemon, d } = await boot(scaffold())
    // The relay speaks for an HTTP-mode bot, which the daemon holds as a shared integration.
    d.agents.get('bot-a').integrations[0].core.mode = 'shared'
    d.connByIntegration.set('int-bot-a', d.connByIntegration.get('int-bot-a') ?? {})
    const answer = await d.handleRelaySlackAction({
      agentId: 'bot-a',
      integrationId: 'int-bot-a',
      sessionKey: 'slack:C1',
      msgId: 'm-join',
      botId: 'bot-1',
      userId: 'U0INVITER',
      payload: { kind: 'bot-joined', channelId: 'C1', inviter: 'U0INVITER' }
    })
    expect(answer).toEqual({ msgId: 'm-join', accepted: true })
    await vi.waitFor(
      async () => expect(await d.store.assistantItems.latestFirstLook('bot-a', place(d))).toBeDefined(),
      WAIT
    )
    await daemon.stop()
  })

  it('replaces the agent’s join introduction where a first look will run, and keeps it where none will', async () => {
    const { daemon, d, dispatched } = await boot(scaffold())
    const agent = d.agents.get('bot-a')
    agent.introduceOnJoin = true
    agent.integrations[0].core.externalChannels = ['C2']
    const intros = () => dispatched.filter((c) => c.msg.msgId.startsWith('intro:')).map((c) => c.msg.channel)
    await joins(d, 'C1')
    await vi.waitFor(
      async () => expect(await d.store.assistantItems.latestFirstLook('bot-a', place(d))).toBeDefined(),
      WAIT
    )
    expect(intros()).toEqual([])
    // A place shared with another organization takes no first look, so the introduction stays.
    await joins(d, 'C2')
    expect(intros()).toEqual(['C2'])
    await daemon.stop()
  })

  it('takes none for a conversation the Control Plane has not listed', async () => {
    const { daemon, d } = await boot(scaffold())
    await joins(d, 'C9')
    await d.takeJoinedFirstLooks()
    expect(await d.store.assistantItems.list('bot-a', {})).toEqual([])
    await daemon.stop()
  })

  it('ends an automatic one after five failures without a word in the place', async () => {
    const { daemon, d, behavior, looks, reports, settled } = await boot(scaffold())
    behavior.look = 'throw'
    await joins(d, 'C1')
    await vi.waitFor(
      async () => expect(await d.store.assistantItems.latestFirstLook('bot-a', place(d))).toBeDefined(),
      WAIT
    )
    const item = await d.store.assistantItems.latestFirstLook('bot-a', place(d))
    await d.followUpChecks.sweep()
    await vi.waitFor(() => expect(looks()).toHaveLength(1), WAIT)
    await settled()
    for (let n = 2; n <= CHECK_MAX_FAILURES; n++) {
      await d.store.assistantChecks.db.query(
        'UPDATE assistant_check_state SET retryAt = 0 WHERE agentId = ? AND itemId = ?',
        ['bot-a', item.id]
      )
      await d.followUpChecks.sweep()
      await vi.waitFor(() => expect(looks()).toHaveLength(n), WAIT)
      await settled()
    }
    const ended = await d.store.assistantItems.get('bot-a', item.id)
    expect(ended.status).toBe('dropped')
    expect(ended.observations.at(-1).text).toBe(
      'First look failed (error), 5 times in a row; it ended without reporting.'
    )
    expect(reports()).toHaveLength(0)
    await daemon.stop()
  })
})

const place = (d: any) => ({ platform: 'slack', channel: 'C1', transportScope: scopeOf(d) })

/** The bot's channels re-listed after Slack said it joined `joined`: the first snapshot is the baseline, so it is listed first. */
async function joins(d: any, channel: string, inviter?: string): Promise<void> {
  await d.connections.maybeIntroduceOnJoin('slack', 'int-bot-a', [])
  await d.connections.maybeIntroduceOnJoin('slack', 'int-bot-a', [{ id: channel }], {
    channel,
    ...(inviter ? { inviter } : {})
  })
}
