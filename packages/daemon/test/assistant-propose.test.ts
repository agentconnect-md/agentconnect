// A patrol's proposal (assistant-mode.md §5.10): carded for approval, run once as a normal-permission sub-session, never re-run after a cut.
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { buildCpClientDeps } from '../src/cp/cp-client-deps.js'
import { Daemon } from '../src/daemon.js'
import { executeTool, type SessionContext } from '../src/mcp/ops.js'
import { assistantItemToolsFor, PROPOSE_ARGS, PROPOSE_TOOL } from '../src/mcp/ops/assistant-items.js'
import { toolsForIntegrations } from '../src/mcp/tools.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { isPatrolCoordinate, isTaskCoordinate, patrolCoordinate } from '../src/session/subsession-coordinate.js'
import { assistantTaskHash, type AssistantDraft } from '../src/store/assistant-drafts.js'
import { sessionKey } from '../src/store/local-store.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'
import { z } from 'zod'

const TEST_ORG = '00000000-0000-0000-0000-0000000000a1'
const INT_A = '11111111-1111-4111-8111-1111111111a1'
const INT_B = '11111111-1111-4111-8111-1111111111b1'
const MINUTE = 60_000
const PATROL_OPENING = '[patrol] A scheduled, read-only check'
const TASK_OPENING = '[approved task]'
const SENTENCE = 'I want to rebase PR #12 because it conflicts with main.'
const TASK = 'Rebase PR #12 onto main and push.'
const FALLBACK = { enabled: true, fallbackConversation: { integrationId: INT_A, channelId: 'C0FALLBACK' } }

/** Slack agents appending in `C1`: bot-a in assistant mode with a fallback conversation for cards, bot-b outside it. */
function scaffold(over: { limits?: Record<string, unknown> } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-propose-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const agents = [
    {
      id: 'bot-a',
      integration: INT_A,
      assistantMode: { ...FALLBACK, ...(over.limits ? { limits: over.limits } : {}) }
    },
    { id: 'bot-b', integration: INT_B }
  ]
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
            id: a.integration,
            platform: 'slack',
            core: {
              bindRules: [{ match: { kind: 'mention' } }],
              sessionModes: [{ channel: 'C1', mode: 'append' }]
            },
            config: { botToken: `xoxb-${a.id}`, appToken: `xapp-${a.id}` }
          }
        ],
        output: { mode: 'low' },
        permissionMode: 'acceptEdits',
        ...(a.assistantMode ? { assistantMode: a.assistantMode } : {})
      })
    )
  }
  return root
}

type Behavior = ((ctx: SessionContext) => Promise<unknown>) | 'hang' | 'throw' | 'end'

async function boot(root: string) {
  const behavior: { patrol: Behavior; task: Behavior } = { patrol: 'end', task: 'end' }
  const hosts: any[] = []
  const registered: SessionContext[] = []
  const latest = (match: (thread: string) => boolean) => [...registered].reverse().find((c) => match(c.thread))!
  const hostFactory = () => {
    const cancels = new Map<string, () => void>()
    const modes = new Map<string, string>()
    const run = async (sessionId: string, b: Behavior, ctx: () => SessionContext) => {
      if (b === 'end') return 'end_turn'
      if (b === 'throw') throw new Error('the runtime exited')
      const cancelled = new Promise((resolve) => cancels.set(sessionId, () => resolve('cancelled')))
      if (b === 'hang') return await cancelled
      return await Promise.race([b(ctx()).then(() => 'end_turn'), cancelled])
    }
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
        const text = JSON.stringify(blocks)
        if (text.includes(PATROL_OPENING))
          return await run(sessionId, behavior.patrol, () => latest(isPatrolCoordinate))
        if (text.includes(TASK_OPENING)) return await run(sessionId, behavior.task, () => latest(isTaskCoordinate))
        return 'end_turn'
      }),
      cancel: vi.fn(async (sessionId: string) => cancels.get(sessionId)?.()),
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
  // The card surface: the integration's own Slack connection, its card calls observed.
  const conn = d.connByIntegration.get(INT_A)
  const cards = {
    post: vi.spyOn(conn, 'postBlocks').mockResolvedValue('card-1'),
    update: vi.spyOn(conn, 'updateBlocks').mockResolvedValue(true)
  }
  vi.spyOn(conn, 'getChannelInfo').mockResolvedValue({ id: 'C1', name: 'general', isPrivate: false } as never)
  const patrols = () => dispatched.filter((c) => isPatrolCoordinate(c.msg.thread))
  const tasks = () => dispatched.filter((c) => isTaskCoordinate(c.msg.thread))
  const reports = () => dispatched.filter((c) => c.msg.parentReport === true)
  const settled = async () => {
    for (let seen = -1; seen !== dispatched.length;) {
      seen = dispatched.length
      await Promise.all(dispatched.map((c) => c.turn))
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  const deps = { ...d.mcp.deps, canRun: () => true }
  const activity = buildCpClientDeps(d.cpClientDepsHost(root, 'wss://cp.example.test', () => {})).assistantActivity!
  const decide = (draftId: string, choice: 'approve' | 'discard' | 'always' = 'approve') =>
    activity.write({
      agentId: 'bot-a',
      operation: 'decide-draft',
      draftId,
      choice,
      decider: { userId: 'usr-editor', name: 'Grace' }
    }) as Promise<any>
  const click = (draftId: string, optionId: 'approve' | 'discard' = 'approve') =>
    d.routePermissionChoice({ requestId: draftId, optionId, actor: { userId: 'U0BOB' } })
  const records = async (): Promise<AssistantDraft[]> => {
    const rows = (await d.store.assistantDrafts.db.query('SELECT id FROM assistant_draft ORDER BY createdAt', []))
      .rows as { id: string }[]
    return await Promise.all(rows.map(async (row) => (await d.store.assistantDrafts.get(row.id)) as AssistantDraft))
  }
  return {
    daemon,
    d,
    behavior,
    hosts,
    registered,
    dispatched,
    patrols,
    tasks,
    reports,
    settled,
    deps,
    cards,
    activity,
    decide,
    click,
    records
  }
}

const scopeOf = (d: any): string => d.transportScopeForIntegrationIds([INT_A])

/** The conversation's long session in C1, which the item reports into and an approved task runs under. */
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
    acpSessionId: 'acp-parent-bot-a',
    sessionId: 'sid-parent-bot-a',
    state: 'idle',
    lastDeliveredTs: null,
    updatedAt: Date.now()
  })
  return { key, scope, coordinate }
}

async function takeItem(d: any, nextCheck = Date.now() - MINUTE) {
  return await d.store.assistantItems.create({
    agentId: 'bot-a',
    title: 'Land PR #12',
    doneWhen: 'PR #12 is merged',
    nextCheck,
    origin: { platform: 'slack', channel: 'C1', transportScope: scopeOf(d) },
    summary: 'Alice asked to see PR #12 through.'
  })
}

/** A patrol that proposes, tries a second time, and records what it saw. */
const proposing =
  (deps: any, results: unknown[]) =>
  async (ctx: SessionContext): Promise<void> => {
    const itemId = await deps.assistantItems.patrol.itemFor(ctx)
    const args = { sentence: SENTENCE, why: 'The check found a merge conflict.', task: TASK }
    results.push(await executeTool(ctx, 'propose', args, deps))
    results.push(await executeTool(ctx, 'propose', args, deps).catch((err: Error) => err.message))
    const current = ((await executeTool(ctx, 'listItems', { itemId }, deps)) as any).items[0]
    await executeTool(
      ctx,
      'updateItem',
      {
        itemId,
        version: current.version,
        observation: 'PR #12 conflicts with main.',
        nextCheck: new Date(Date.now() + 60 * MINUTE).toISOString()
      },
      deps
    )
  }

/** One proposal from a patrol of a fresh item, as the patrol makes it. */
async function proposed(h: Awaited<ReturnType<typeof boot>>) {
  const place = await seedPlace(h.d)
  const item = await takeItem(h.d)
  const results: unknown[] = []
  h.behavior.patrol = proposing(h.deps, results)
  await h.d.patrols.sweep()
  await vi.waitFor(() => expect(h.patrols()).toHaveLength(1), WAIT)
  await h.settled()
  const [record] = await h.records()
  return { place, item, results, record: record! }
}

/** The task's own report into the conversation that took the item, through `sendMessage {sessionId}`. */
const reportsBack =
  (deps: any) =>
  async (ctx: SessionContext): Promise<void> => {
    await executeTool(ctx, 'sendMessage', { sessionId: 'sid-parent-bot-a', message: 'Rebased and pushed.' }, deps)
  }

describe('a patrol proposes', () => {
  it('records the proposal and cards it to the fallback conversation, once per patrol, running nothing', async () => {
    const h = await boot(scaffold())
    const { place, item, results, record } = await proposed(h)

    const patrolKey = sessionKey('slack', 'C1', h.patrols()[0]!.msg.thread!, 'bot-a', place.scope)
    expect(record).toMatchObject({
      agentId: 'bot-a',
      action: 'task',
      kind: 'task',
      text: TASK,
      status: 'awaiting_review',
      target: { platform: 'slack', integrationId: INT_A, channel: 'C1', thread: null },
      destination: { name: 'general' },
      proposal: { sentence: SENTENCE, why: 'The check found a merge conflict.', itemId: item.id, itemVersion: 1 },
      source: { sessionKey: patrolKey, place: false },
      approver: { kind: 'conversation', integrationId: INT_A, channel: 'C0FALLBACK' },
      offerAlways: false,
      cardTs: 'card-1'
    })
    expect(record.hash).toBe(assistantTaskHash('bot-a', item.id, 1, TASK))
    expect(record.expiresAt - record.createdAt).toBe(24 * 60 * MINUTE)
    expect(results[0]).toMatchObject({
      proposed: true,
      proposalId: record.id,
      approver: "the agent's fallback conversation"
    })
    expect(results[1]).toContain('this patrol already proposed')
    expect(await h.records()).toHaveLength(1)

    // The card leads with the sentence, shows the reason and the task, and offers approve or deny only.
    const [channel, blocks] = h.cards.post.mock.calls[0]!
    expect(channel).toBe('C0FALLBACK')
    const card = JSON.stringify(blocks)
    expect(card.indexOf(SENTENCE)).toBeGreaterThan(-1)
    expect(card.indexOf(SENTENCE)).toBeLessThan(card.indexOf(TASK))
    expect(card).toContain('The check found a merge conflict.')
    expect(card).toContain('Approve')
    expect(card).toContain('Deny')
    expect(card).not.toContain('Always allow')
    // Nothing ran, and the patrol still recorded what it saw.
    expect(h.tasks()).toHaveLength(0)
    expect((await h.d.store.assistantItems.get('bot-a', item.id)).observations.map((o: any) => o.text)).toEqual([
      'PR #12 conflicts with main.'
    ])
    await h.daemon.stop()
  })

  it('lists the proposal for editors only when asked, beside the drafts', async () => {
    const h = await boot(scaffold())
    const { item, record } = await proposed(h)
    const plain = (await h.activity.read({ agentId: 'bot-a', operation: 'drafts', limit: 10 })) as any
    expect(plain.drafts).toEqual([])
    const listed = (await h.activity.read({ agentId: 'bot-a', operation: 'drafts', limit: 10, proposals: true })) as any
    expect(listed.drafts).toEqual([
      expect.objectContaining({
        id: record.id,
        kind: 'task',
        text: TASK,
        offerAlways: false,
        target: expect.objectContaining({ integrationId: INT_A, channel: 'C1', name: 'general' }),
        proposal: {
          sentence: SENTENCE,
          why: 'The check found a merge conflict.',
          itemId: item.id,
          itemTitle: 'Land PR #12'
        }
      })
    ])
    await h.daemon.stop()
  })

  it('is offered to patrols only, and to no agent outside assistant mode', async () => {
    const h = await boot(scaffold())
    const { record } = await proposed(h)
    await h.decide(record.id)
    await vi.waitFor(() => expect(h.tasks()).toHaveLength(1), WAIT)
    await h.settled()
    const args = { sentence: SENTENCE, why: 'x', task: TASK }

    const patrol = h.registered.find((c) => isPatrolCoordinate(c.thread))!
    expect(patrol.tools.find((t) => t.name === 'propose')).toBe(PROPOSE_TOOL)
    // Another session of the same agent, the approved task itself, is not offered it and is refused it.
    const task = h.registered.find((c) => isTaskCoordinate(c.thread))!
    expect(task.tools.map((t) => t.name)).not.toContain('propose')
    await expect(executeTool(task, 'propose', args, h.deps)).rejects.toThrow('propose is available only in a patrol')
    // An agent outside assistant mode has no item tools at all, and no patrol coordinate gives it one.
    const botB = h.d.agents.get('bot-b')
    const offered = [
      ...toolsForIntegrations(botB.integrations, { currentPlatform: 'slack', assistantMode: false }),
      ...assistantItemToolsFor(botB)
    ].map((t) => t.name)
    expect(offered).not.toContain('propose')
    await expect(executeTool({ ...patrol, agentId: 'bot-b' }, 'propose', args, h.deps)).rejects.toThrow(
      'only to an agent in assistant mode'
    )
    expect(await h.records()).toHaveLength(1)
    await h.daemon.stop()
  })

  it('advertises exactly the arguments it takes', () => {
    const view = (schema: { properties?: Record<string, unknown>; required?: string[] }) => ({
      properties: Object.keys(schema.properties ?? {}).sort(),
      required: [...(schema.required ?? [])].sort()
    })
    expect(view(z.toJSONSchema(PROPOSE_ARGS, { io: 'input', unrepresentable: 'any' }) as never)).toEqual(
      view(PROPOSE_TOOL.inputSchema as never)
    )
  })
})

describe('an approved proposal runs once', () => {
  it('opens a normal-permission sub-session in the item’s place, records it with the approval, and reports back', async () => {
    const h = await boot(scaffold())
    const { place, item, record } = await proposed(h)
    h.behavior.task = reportsBack(h.deps)

    expect(await h.decide(record.id)).toMatchObject({
      operation: 'decide-draft',
      result: 'decided',
      status: 'executing'
    })
    await vi.waitFor(() => expect(h.tasks()).toHaveLength(1), WAIT)
    const [task] = h.tasks()
    const key = sessionKey('slack', 'C1', task!.msg.thread!, 'bot-a', place.scope)
    // The approval and the sub-session it runs in were recorded together, before the dispatch.
    const started = (await h.d.store.assistantDrafts.get(record.id)) as AssistantDraft
    expect(started).toMatchObject({ status: 'executing', subsessionKey: key, decidedByName: 'Grace' })
    expect(task!.msg).toMatchObject({ channel: 'C1', source: 'agent', headless: true })
    expect(task!.msg.text).toContain(TASK_OPENING)
    expect(task!.msg.text).toContain(`Task: ${TASK}`)
    expect(task!.msg.text).toContain(`Item ${item.id}`)
    expect(task!.callMeta).toMatchObject({
      callFrom: 'bot-a',
      hopCount: 0,
      originSessionId: 'sid-parent-bot-a',
      needsReply: true
    })
    await h.settled()

    // The agent's own permission mode, not a patrol's read-only one, and the runtime's tools unrestricted.
    const host = h.hosts.find((x) => x.prompt.mock.calls.some((c: any) => JSON.stringify(c).includes(TASK_OPENING)))
    const taskSession = host.prompt.mock.calls.find((c: any) => JSON.stringify(c).includes(TASK_OPENING))[0]
    expect(
      host.setSessionPermissionMode.mock.calls.filter((c: any) => c[0] === taskSession).map((c: any) => c[1])
    ).toEqual(['acceptEdits'])
    const taskCtx = h.registered.find((c) => isTaskCoordinate(c.thread))!
    expect(taskCtx.tools.map((t) => t.name)).toContain('sendMessage')
    expect(taskCtx.tools.map((t) => t.name)).not.toContain('propose')

    expect(h.reports().map((c) => c.msg.text)).toEqual(['Rebased and pushed.'])
    expect(h.reports()[0]!.msg).toMatchObject({ channel: 'C1', sessionThread: place.coordinate })
    expect(await h.d.store.assistantDrafts.get(record.id)).toMatchObject({ status: 'succeeded' })
    expect(await h.d.store.assistantSubsessions.get('bot-a', key)).toMatchObject({
      state: 'done',
      parentSessionId: 'sid-parent-bot-a'
    })
    const card = JSON.stringify(h.cards.update.mock.calls.at(-1))
    expect(card).toContain('reported back')
    expect(card).not.toContain('"actions"')
    const observations = (await h.d.store.assistantItems.get('bot-a', item.id)).observations.map((o: any) => o.text)
    expect(observations).toEqual(
      expect.arrayContaining([
        `Proposal "${SENTENCE}" was approved by Grace; it runs in a background session.`,
        `The approved task "${SENTENCE}" reported back.`
      ])
    )
    // Approved again, it runs nothing more.
    expect(await h.decide(record.id)).toMatchObject({ result: 'already-decided' })
    expect(h.tasks()).toHaveLength(1)
    await h.daemon.stop()
  })

  it('runs once when a card click and the console decide at the same moment', async () => {
    const h = await boot(scaffold())
    const { record } = await proposed(h)
    h.behavior.task = 'hang'

    const [answer] = await Promise.all([h.decide(record.id), h.click(record.id)])
    expect(answer.result).toMatch(/^(decided|already-decided)$/)
    await vi.waitFor(() => expect(h.tasks()).toHaveLength(1), WAIT)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(h.tasks()).toHaveLength(1)
    expect((await h.d.store.assistantDrafts.get(record.id)).status).toBe('executing')
    await h.d.interruptAgentTurns('bot-a', 'stop')
    await h.settled()
    await h.daemon.stop()
  })

  it('reports a task that ended without its own report through the daemon, and records it failed', async () => {
    const h = await boot(scaffold())
    const { record } = await proposed(h)
    h.behavior.task = 'throw'

    await h.decide(record.id)
    await vi.waitFor(() => expect(h.reports()).toHaveLength(1), WAIT)
    await h.settled()
    expect(h.reports()[0]!.msg.text).toMatch(/^\[sub-session ended\] .* stopped before finishing \(error\)/)
    expect(await h.d.store.assistantDrafts.get(record.id)).toMatchObject({ status: 'failed', failure: 'it failed' })
    expect(JSON.stringify(h.cards.update.mock.calls.at(-1))).toContain('ended without reporting back')
    await h.daemon.stop()
  })
})

describe('a proposal that is not approved never runs', () => {
  it('runs nothing once denied from its card', async () => {
    const h = await boot(scaffold())
    const { item, record } = await proposed(h)

    await h.click(record.id, 'discard')
    expect(await h.d.store.assistantDrafts.get(record.id)).toMatchObject({ status: 'denied' })
    expect(await h.decide(record.id)).toMatchObject({ result: 'already-decided' })
    await h.click(record.id)
    await h.settled()
    expect(h.tasks()).toHaveLength(0)
    expect(JSON.stringify(h.cards.update.mock.calls.at(-1))).toContain('Denied')
    expect((await h.d.store.assistantItems.get('bot-a', item.id)).observations.map((o: any) => o.text)).toContain(
      `Proposal "${SENTENCE}" was denied; nothing was run.`
    )
    await h.daemon.stop()
  })

  it('runs nothing once expired', async () => {
    const h = await boot(scaffold())
    const { record } = await proposed(h)
    await h.d.store.assistantDrafts.db.query('UPDATE assistant_draft SET expiresAt = ? WHERE id = ?', [
      Date.now() - 1,
      record.id
    ])
    await h.d.drafts.sweep(['bot-a'])
    expect((await h.d.store.assistantDrafts.get(record.id)).status).toBe('expired')
    expect(await h.decide(record.id)).toMatchObject({ result: 'expired' })
    await h.click(record.id)
    await h.settled()
    expect(h.tasks()).toHaveLength(0)
    expect(JSON.stringify(h.cards.update.mock.calls.at(-1))).toContain('Expired. Nothing was run.')
    await h.daemon.stop()
  })

  it('refuses a record changed after it was written', async () => {
    const h = await boot(scaffold())
    const { record } = await proposed(h)
    await h.d.store.assistantDrafts.db.query('UPDATE assistant_draft SET text = ? WHERE id = ?', [
      'Delete the release branch.',
      record.id
    ])
    expect(await h.decide(record.id)).toMatchObject({
      result: 'decided',
      status: 'failed',
      failure: 'the proposal changed after it was written'
    })
    await h.settled()
    expect(h.tasks()).toHaveLength(0)
    await h.daemon.stop()
  })

  it('refuses a proposal whose item was closed meanwhile', async () => {
    const h = await boot(scaffold())
    const { item, record } = await proposed(h)
    const current = await h.d.store.assistantItems.get('bot-a', item.id)
    await h.d.store.assistantItems.transition('bot-a', item.id, current.version, { status: 'done', nextCheck: null })
    expect(await h.decide(record.id)).toMatchObject({ status: 'failed', failure: 'its item is done' })
    await h.settled()
    expect(h.tasks()).toHaveLength(0)
    await h.daemon.stop()
  })
})

describe('the user’s sub-session limit', () => {
  it('refuses an approval while the limit is full, keeps it waiting, and runs it once a place frees', async () => {
    const h = await boot(scaffold({ limits: { maxConcurrentSubsessions: 1 } }))
    const { place, record } = await proposed(h)
    const busy = sessionKey('slack', 'C1', 'subsession:busy', 'bot-a', place.scope)
    await h.d.store.assistantSubsessions.open({
      agentId: 'bot-a',
      childSessionKey: busy,
      parentSessionId: 'sid-parent-bot-a',
      parentSessionKey: place.key,
      now: Date.now()
    })

    const refused = await h.decide(record.id)
    expect(refused).toMatchObject({ result: 'busy', status: 'awaiting_review', granted: false })
    expect(refused.failure).toContain('already has 1 sub-sessions running')
    expect(await h.d.store.assistantDrafts.get(record.id)).toMatchObject({
      status: 'awaiting_review',
      subsessionKey: null
    })
    expect(h.tasks()).toHaveLength(0)
    // The card keeps its buttons and says why nothing ran.
    const card = JSON.stringify(h.cards.update.mock.calls.at(-1))
    expect(card).toContain('"actions"')
    expect(card).toContain('already has 1 sub-sessions running')

    await h.d.store.assistantSubsessions.finish('bot-a', busy, 'done')
    expect(await h.decide(record.id)).toMatchObject({ result: 'decided', status: 'executing' })
    await vi.waitFor(() => expect(h.tasks()).toHaveLength(1), WAIT)
    await h.settled()
    await h.daemon.stop()
  })
})

describe('a task cut short by a restart or handover', () => {
  it('is recorded outcome_unknown, never re-run, and its place is told once to check', async () => {
    const h = await boot(scaffold())
    const { place, item, record } = await proposed(h)
    h.behavior.task = 'hang'
    await h.decide(record.id)
    await vi.waitFor(() => expect(h.tasks()).toHaveLength(1), WAIT)
    const key = sessionKey('slack', 'C1', h.tasks()[0]!.msg.thread!, 'bot-a', place.scope)
    await vi.waitFor(async () => expect((await h.d.store.getSession(key))?.acpSessionId).toBeTruthy(), WAIT)

    // The turn is cut for a handover that keeps its delivery; a fresh task service replays, as a successor would.
    await h.d.interruptAgentTurns('bot-a', 'handover', 'handoff')
    h.d.assistantTaskService = undefined
    h.d.absorbedContextTs.clear()
    h.behavior.task = reportsBack(h.deps)
    await h.d.replayInbox(new Set(['bot-a']))
    await vi.waitFor(() => expect(h.reports()).toHaveLength(1), WAIT)
    await h.settled()
    await h.d.replayInbox(new Set(['bot-a']))
    await h.settled()

    expect(h.tasks()).toHaveLength(1)
    expect(h.reports()).toHaveLength(1)
    expect(h.reports()[0]!.msg.text).toContain('Not sure this went through, please check')
    expect(h.reports()[0]!.msg.text).toContain(`item ${item.id}`)
    expect(h.reports()[0]!.msg).toMatchObject({ channel: 'C1', sessionThread: place.coordinate })
    expect(await h.d.store.assistantDrafts.get(record.id)).toMatchObject({ status: 'outcome_unknown' })
    expect(await h.d.store.assistantSubsessions.get('bot-a', key)).toMatchObject({ state: 'failed' })
    expect(JSON.stringify(h.cards.update.mock.calls.at(-1))).toContain('not sure this went through')
    expect((await h.d.store.listInboxBySessionKeyFifo()).filter((row: any) => row.agentId === 'bot-a')).toEqual([])
    await h.daemon.stop()
  })

  it('is recovered the same way when the daemon stopped between the approval and the dispatch', async () => {
    const h = await boot(scaffold())
    const { place, record } = await proposed(h)
    // As if the process died right after the transaction: executing, with its sub-session, and nothing dispatched.
    const key = sessionKey('slack', 'C1', 'subsession:task-cut', 'bot-a', place.scope)
    await h.d.store.assistantSubsessions.openWithinLimitClaiming(
      { agentId: 'bot-a', childSessionKey: key, parentSessionId: 'sid-parent-bot-a', parentSessionKey: place.key },
      { limit: 3, startedSince: 0 },
      (tx: any) =>
        h.d.store.assistantDrafts.beginTask(record.id, { id: 'user:usr-editor', name: 'Grace' }, key, Date.now(), tx)
    )
    h.d.assistantTaskService = undefined
    await h.d.replayInbox(new Set(['bot-a']))
    await vi.waitFor(() => expect(h.reports()).toHaveLength(1), WAIT)
    await h.settled()

    expect(h.tasks()).toHaveLength(0)
    expect(h.reports()[0]!.msg.text).toContain('Not sure this went through, please check')
    expect(await h.d.store.assistantDrafts.get(record.id)).toMatchObject({ status: 'outcome_unknown' })
    await h.daemon.stop()
  })

  it.each([
    ['done', 'succeeded', null, 'reported back'],
    ['failed', 'failed', 'it ended without reporting back', 'ended without reporting back']
  ] as const)(
    'settles a task whose sub-session already ended %s from that end, with no second report',
    async (rowState, status, failure, card) => {
      const h = await boot(scaffold())
      const { place, item, record } = await proposed(h)
      // Its report (or the daemon's failure report) reached the parent, then the daemon stopped before the record settled.
      const key = sessionKey('slack', 'C1', 'subsession:task-reported', 'bot-a', place.scope)
      await h.d.store.assistantSubsessions.openWithinLimitClaiming(
        { agentId: 'bot-a', childSessionKey: key, parentSessionId: 'sid-parent-bot-a', parentSessionKey: place.key },
        { limit: 3, startedSince: 0 },
        (tx: any) =>
          h.d.store.assistantDrafts.beginTask(record.id, { id: 'user:usr-editor', name: 'Grace' }, key, Date.now(), tx)
      )
      expect(await h.d.store.assistantSubsessions.finish('bot-a', key, rowState)).toBe(true)
      h.d.assistantTaskService = undefined
      await h.d.replayInbox(new Set(['bot-a']))
      await h.settled()
      await h.d.replayInbox(new Set(['bot-a']))
      await h.settled()

      expect(h.reports()).toHaveLength(0)
      expect(h.tasks()).toHaveLength(0)
      expect(await h.d.store.assistantDrafts.get(record.id)).toMatchObject({ status, failure })
      expect(await h.d.store.assistantSubsessions.get('bot-a', key)).toMatchObject({ state: rowState })
      expect(JSON.stringify(h.cards.update.mock.calls.at(-1))).toContain(card)
      const observations = (await h.d.store.assistantItems.get('bot-a', item.id)).observations.map((o: any) => o.text)
      expect(observations.some((text: string) => text.includes('cut short'))).toBe(false)
      await h.daemon.stop()
    }
  )

  it('leaves a task this daemon is running alone when its inbox is replayed for another reason', async () => {
    const h = await boot(scaffold())
    const { record } = await proposed(h)
    h.behavior.task = 'hang'
    await h.decide(record.id)
    await vi.waitFor(() => expect(h.tasks()).toHaveLength(1), WAIT)
    await h.d.replayInbox(new Set(['bot-a']))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect((await h.d.store.assistantDrafts.get(record.id)).status).toBe('executing')
    expect(h.tasks()).toHaveLength(1)
    expect(h.reports()).toHaveLength(0)
    await h.d.interruptAgentTurns('bot-a', 'stop')
    await h.daemon.stop()
  })
})

describe('the patrol’s standing rules', () => {
  it('give it the third outcome: propose when an action is warranted, else report or stay silent', async () => {
    const h = await boot(scaffold())
    await seedPlace(h.d)
    await takeItem(h.d)
    h.behavior.patrol = 'end'
    await h.d.patrols.sweep()
    await vi.waitFor(() => expect(h.patrols()).toHaveLength(1), WAIT)
    await h.settled()
    const text = h.patrols()[0]!.msg.text
    expect(text).toContain('one of three outcomes')
    expect(text).toContain('call `propose` once')
    expect(text).toContain('The item gets its observation either way.')
    expect(patrolCoordinate('x')).not.toBe('subsession:task-x')
    await h.daemon.stop()
  })
})
