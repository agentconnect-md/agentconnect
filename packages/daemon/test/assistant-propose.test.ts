// A follow-up check's proposal (assistant-mode.md §5.10): carded for approval, run once as a normal-permission sub-session, never re-run after a cut.
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { buildCpClientDeps } from '../src/cp/cp-client-deps.js'
import { Daemon } from '../src/daemon.js'
import { executeTool, type SessionContext } from '../src/mcp/ops.js'
import { followUpToolsFor, PROPOSE_ARGS, PROPOSE_TOOL } from '../src/mcp/ops/assistant-items.js'
import { toolsForIntegrations } from '../src/mcp/tools.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { isCheckCoordinate, isTaskCoordinate, checkCoordinate } from '../src/session/subsession-coordinate.js'
import { assistantTaskHash, type AssistantDraft } from '../src/store/assistant-drafts.js'
import { sessionKey } from '../src/store/local-store.js'
import { SlackConnection } from '../src/slack/connection.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'
import { z } from 'zod'

/** What the model received for a delivered message: its prompt when the console shows less (§9.5), else its text. */
const modelText = (msg: { text: string; turnBody?: { prompt?: string } }): string => msg.turnBody?.prompt ?? msg.text

const TEST_ORG = '00000000-0000-0000-0000-0000000000a1'
const INT_A = '11111111-1111-4111-8111-1111111111a1'
const INT_B = '11111111-1111-4111-8111-1111111111b1'
const MINUTE = 60_000
const CHECK_OPENING = '[follow-up check] A read-only check'
const TASK_OPENING = '[approved proposal]'
const TASK_LANGUAGE =
  'Write your report in the language the people in the follow-up’s conversation use; without a message of theirs ' +
  'to go by, use the language of its title and summary.'
const ANSWER_LANGUAGE = 'Speak to the people here in the language they use, even when this report is in another.'
const SENTENCE = 'I want to rebase PR #12 because it conflicts with main.'
const TASK = 'Rebase PR #12 onto main and push.'
const ASSISTANT = { enabled: true }

/** Slack agents appending in `C1`: bot-a in assistant mode, with no control plane to name a responsible user, bot-b outside it. */
function scaffold(over: { limits?: Record<string, unknown>; chat?: boolean; external?: string[] } = {}): string {
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
      assistantMode: { ...ASSISTANT, ...(over.limits ? { limits: over.limits } : {}) }
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
              sessionModes: [{ channel: 'C1', mode: 'append' }],
              ...(a.assistantMode && over.external ? { externalChannels: over.external } : {})
            },
            config: { botToken: `xoxb-${a.id}`, appToken: `xapp-${a.id}` }
          }
        ],
        output: { mode: 'low' },
        permissionMode: 'acceptEdits',
        ...(a.assistantMode && over.chat !== undefined ? { chatActions: over.chat ? 'settings' : 'talk' } : {}),
        ...(a.assistantMode ? { assistantMode: a.assistantMode } : {})
      })
    )
  }
  return root
}

type Behavior = ((ctx: SessionContext) => Promise<unknown>) | 'hang' | 'throw' | 'end'

async function boot(root: string) {
  const behavior: { check: Behavior; task: Behavior } = { check: 'end', task: 'end' }
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
        if (text.includes(CHECK_OPENING)) return await run(sessionId, behavior.check, () => latest(isCheckCoordinate))
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
  const conn: SlackConnection = d.connByIntegration.get(INT_A)
  const cards = {
    post: vi.spyOn(conn, 'postBlocks').mockResolvedValue('card-1'),
    update: vi.spyOn(conn, 'updateBlocks').mockResolvedValue(true)
  }
  // C1 is a channel; D1 is Alice's direct message with bot-a; U0BOT is a bot, everyone else a person.
  vi.spyOn(conn, 'getChannelInfo').mockImplementation(
    async (channel: string) =>
      (channel === 'D1'
        ? { id: 'D1', isIm: true, user: 'U0ALICE' }
        : { id: channel, name: channel === 'C1' ? 'general' : 'other', isPrivate: false }) as never
  )
  vi.spyOn(conn, 'getUserProfile').mockImplementation(
    async (user: string) => ({ id: user, name: user.toLowerCase(), isBot: user === 'U0BOT' }) as never
  )
  const checks = () => dispatched.filter((c) => isCheckCoordinate(c.msg.thread))
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
  const decide = (draftId: string, choice: 'approve' | 'discard' = 'approve') =>
    activity.write({
      agentId: 'bot-a',
      operation: 'decide-draft',
      draftId,
      choice,
      decider: { userId: 'usr-editor', name: 'Grace' }
    }) as Promise<any>
  const click = (draftId: string, optionId: 'approve' | 'discard' = 'approve', userId = 'U0BOB') =>
    d.routePermissionChoice({ requestId: draftId, optionId, actor: { userId, name: userId.toLowerCase() } })
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
    checks,
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
async function seedPlace(d: any, channel = 'C1') {
  const scope = scopeOf(d)
  const coordinate = await d.store.resolveAppendCoordinate('bot-a', channel, scope, 1)
  const key = sessionKey('slack', channel, coordinate, 'bot-a', scope)
  await d.store.upsertSession({
    key,
    agentId: 'bot-a',
    platform: 'slack',
    channel,
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

async function takeItem(d: any, nextCheck = Date.now() - MINUTE, channel = 'C1') {
  return await d.store.assistantItems.create({
    agentId: 'bot-a',
    taskKey: sessionKey('slack', channel, checkCoordinate(randomUUID()), 'bot-a', scopeOf(d)),
    asker: 'slack:T0EXAMPLE:U0ALICE',
    title: 'Land PR #12',
    doneWhen: 'PR #12 is merged',
    nextCheck,
    origin: { platform: 'slack', channel, transportScope: scopeOf(d) },
    summary: 'Alice asked to see PR #12 through.'
  })
}

/** A check that proposes, tries a second time, and records what it saw. */
const proposing =
  (deps: any, results: unknown[]) =>
  async (ctx: SessionContext): Promise<void> => {
    const args = { sentence: SENTENCE, why: 'The check found a merge conflict.', task: TASK }
    results.push(await executeTool(ctx, 'propose', args, deps))
    results.push(await executeTool(ctx, 'propose', args, deps).catch((err: Error) => err.message))
    await executeTool(
      ctx,
      'recordCheck',
      {
        observation: 'PR #12 conflicts with main.',
        nextCheck: new Date(Date.now() + 60 * MINUTE).toISOString()
      },
      deps
    )
  }

/** One proposal from a check of a fresh item, as the check makes it. */
async function proposed(h: Awaited<ReturnType<typeof boot>>, channel = 'C1') {
  const place = await seedPlace(h.d, channel)
  const item = await takeItem(h.d, Date.now() - MINUTE, channel)
  const results: unknown[] = []
  h.behavior.check = proposing(h.deps, results)
  await h.d.followUpChecks.sweep()
  await vi.waitFor(() => expect(h.checks()).toHaveLength(1), WAIT)
  await h.settled()
  const [record] = await h.records()
  return { place, item, results, record: record! }
}

/** The task's own report into the conversation that took the item, answering the message that started it (§9.4). */
const reportsBack =
  (deps: any, d: any) =>
  async (ctx: SessionContext): Promise<void> => {
    const key = sessionKey(ctx.platform, ctx.channel, ctx.thread, ctx.agentId, ctx.transportScope)
    const [started] = await d.store.sessionMessages.listFor(key, 1)
    await executeTool(
      ctx,
      'sendMessage',
      { action: 'replyToSession', messageId: started.messageId, message: 'Rebased and pushed.' },
      deps
    )
  }

describe('a follow-up’s check proposes', () => {
  it('records the proposal and cards it in the conversation its follow-up belongs to, once per check, running nothing', async () => {
    const h = await boot(scaffold())
    const { place, item, results, record } = await proposed(h)

    const checkKey = sessionKey('slack', 'C1', h.checks()[0]!.msg.thread!, 'bot-a', place.scope)
    expect(record).toMatchObject({
      agentId: 'bot-a',
      action: 'task',
      kind: 'task',
      text: TASK,
      status: 'awaiting_review',
      target: { platform: 'slack', integrationId: INT_A, channel: 'C1', thread: null },
      destination: { name: 'general' },
      proposal: { sentence: SENTENCE, why: 'The check found a merge conflict.', itemId: item.id, itemVersion: 1 },
      source: { sessionKey: checkKey, place: false },
      approver: { kind: 'place', integrationId: INT_A, channel: 'C1' },
      cardTs: 'card-1'
    })
    expect(record.hash).toBe(assistantTaskHash('bot-a', item.id, 1, TASK))
    expect(record.expiresAt - record.createdAt).toBe(24 * 60 * MINUTE)
    expect(results[0]).toMatchObject({
      proposed: true,
      proposalId: record.id,
      approver: 'the people in the conversation the follow-up belongs to'
    })
    expect(results[1]).toContain('this check already proposed')
    expect(await h.records()).toHaveLength(1)

    // One card, at the root of the appending conversation, and none anywhere else.
    expect(h.cards.post).toHaveBeenCalledTimes(1)
    const [channel, blocks, , thread] = h.cards.post.mock.calls[0]!
    expect(channel).toBe('C1')
    expect(thread).toBeUndefined()
    // The card leads with the sentence, shows the reason and the task, and offers approve or deny only.
    const card = JSON.stringify(blocks)
    expect(card.indexOf(SENTENCE)).toBeGreaterThan(-1)
    expect(card.indexOf(SENTENCE)).toBeLessThan(card.indexOf(TASK))
    expect(card).toContain('The check found a merge conflict.')
    expect(card).toContain('Approve')
    expect(card).toContain('Deny')
    expect(card).not.toContain('Always allow')
    // Nothing ran, and the check still recorded what it saw.
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

  it('is offered to checks only, and to no agent outside assistant mode', async () => {
    const h = await boot(scaffold())
    const { record } = await proposed(h)
    await h.decide(record.id)
    await vi.waitFor(() => expect(h.tasks()).toHaveLength(1), WAIT)
    await h.settled()
    const args = { sentence: SENTENCE, why: 'x', task: TASK }

    const check = h.registered.find((c) => isCheckCoordinate(c.thread))!
    expect(check.tools.find((t) => t.name === 'propose')).toBe(PROPOSE_TOOL)
    // Another session of the same agent, the approved task itself, is not offered it and is refused it.
    const task = h.registered.find((c) => isTaskCoordinate(c.thread))!
    expect(task.tools.map((t) => t.name)).not.toContain('propose')
    await expect(executeTool(task, 'propose', args, h.deps)).rejects.toThrow(
      'propose is available only in a follow-up’s check'
    )
    // An agent outside assistant mode has no item tools at all, and no check coordinate gives it one.
    const botB = h.d.agents.get('bot-b')
    const offered = [
      ...toolsForIntegrations(botB.integrations, { currentPlatform: 'slack' }),
      ...followUpToolsFor(botB)
    ].map((t) => t.name)
    expect(offered).not.toContain('propose')
    await expect(executeTool({ ...check, agentId: 'bot-b' }, 'propose', args, h.deps)).rejects.toThrow(
      'only to an agent in assistant mode'
    )
    expect(await h.records()).toHaveLength(1)
    await h.daemon.stop()
  })

  it('takes a task or a follow-up form, exactly one of them', () => {
    const base = { sentence: SENTENCE, why: 'x' }
    expect(PROPOSE_ARGS.parse({ ...base, task: TASK })).toEqual({ ...base, task: TASK })
    expect(
      PROPOSE_ARGS.parse({
        ...base,
        followUp: { title: 'The release date', doneWhen: 'A date is posted.', nextCheck: '2026-10-20T09:00:00+08:00' }
      })
    ).toEqual({
      ...base,
      followUp: {
        title: 'The release date',
        doneWhen: 'A date is posted.',
        nextCheck: Date.parse('2026-10-20T01:00:00Z')
      }
    })
    for (const bad of [
      base,
      { ...base, task: TASK, followUp: { title: 't', doneWhen: 'd' } },
      { ...base, followUp: { title: 't' } },
      { ...base, followUp: { title: 't', doneWhen: 'd', nextCheck: 'tomorrow' } }
    ])
      expect(PROPOSE_ARGS.safeParse(bad).success).toBe(false)
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

describe('a check’s follow-up form (assistant-mode.md §5.13)', () => {
  it('takes that follow-up of the place once approved, with the approver as its asker, and runs no task', async () => {
    const h = await boot(scaffold())
    await seedPlace(h.d)
    const item = await takeItem(h.d)
    const form = { title: 'The 2.6 release date', doneWhen: 'A date is posted here.' }
    h.behavior.check = async (ctx) => {
      await executeTool(ctx, 'propose', { sentence: SENTENCE, why: 'Ada is waiting on it.', followUp: form }, h.deps)
      await executeTool(ctx, 'recordCheck', { observation: 'No date yet.' }, h.deps)
    }
    await h.d.followUpChecks.sweep()
    await vi.waitFor(() => expect(h.checks()).toHaveLength(1), WAIT)
    await h.settled()
    const [record] = await h.records()
    expect(record).toMatchObject({ text: form.title, proposal: { followUp: { ...form, nextCheck: null } } })
    const answer = await h.decide(record!.id)
    expect(answer).toMatchObject({
      result: 'decided',
      status: 'succeeded',
      followUp: { id: expect.any(String), parentSessionId: 'sid-parent-bot-a' }
    })
    expect(await h.d.store.assistantItems.get('bot-a', answer.followUp.id)).toMatchObject({
      ...form,
      status: 'waiting',
      nextCheck: null,
      asker: 'user:usr-editor',
      summary: 'Ada is waiting on it.',
      origin: { platform: 'slack', channel: 'C1' }
    })
    await h.settled()
    expect(h.tasks()).toEqual([])
    const observed = (await h.d.store.assistantItems.get('bot-a', item.id)).observations.at(-1).text
    expect(observed).toContain(`was taken as the follow-up "${form.title}"`)
    // A second decision finds it already decided and takes nothing more.
    expect(await h.decide(record!.id)).toMatchObject({ result: 'already-decided' })
    await h.daemon.stop()
  })
})

describe('an approved proposal runs once', () => {
  it('opens a normal-permission sub-session in the item’s place, records it with the approval, and reports back', async () => {
    const h = await boot(scaffold())
    const { place, item, record } = await proposed(h)
    h.behavior.task = reportsBack(h.deps, h.d)

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
    expect(modelText(task!.msg)).toContain(TASK_OPENING)
    expect(modelText(task!.msg)).toContain(`Work: ${TASK}`)
    expect(task!.msg.initialSessionTitle).toMatch(/^Approved proposal: /)
    expect(modelText(task!.msg)).toContain(`A check of your follow-up ${item.taskKey} proposed this`)
    expect(modelText(task!.msg)).toContain(`Do exactly this work, nothing more. ${TASK_LANGUAGE}`)
    expect(task!.callMeta).toMatchObject({
      callFrom: 'bot-a',
      hopCount: 0,
      originSessionId: 'sid-parent-bot-a',
      needsReply: true
    })
    await h.settled()

    // The agent's own permission mode, not a check's read-only one, and the runtime's tools unrestricted.
    const host = h.hosts.find((x) => x.prompt.mock.calls.some((c: any) => JSON.stringify(c).includes(TASK_OPENING)))
    const taskPrompt = host.prompt.mock.calls.find((c: any) => JSON.stringify(c).includes(TASK_OPENING))
    const taskSession = taskPrompt[0]
    expect(JSON.stringify(taskPrompt[1])).toContain(TASK_LANGUAGE)
    expect(
      host.setSessionPermissionMode.mock.calls.filter((c: any) => c[0] === taskSession).map((c: any) => c[1])
    ).toEqual(['acceptEdits'])
    const taskCtx = h.registered.find((c) => isTaskCoordinate(c.thread))!
    expect(taskCtx.tools.map((t) => t.name)).toContain('sendMessage')
    expect(taskCtx.tools.map((t) => t.name)).not.toContain('propose')

    // §9.5: the reply reaches the place under its header, answering the message that started the work.
    expect(h.reports().map((c) => modelText(c.msg))).toEqual([
      expect.stringMatching(
        /^\[Message msg-[^\]]+\] Reply from bot-a .* to your message msg-[^:]+:\nRebased and pushed\.$/
      )
    ])
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
        `The approved proposal "${SENTENCE}" reported back.`
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
    expect(modelText(h.reports()[0]!.msg)).toMatch(
      /^\[approved proposal ended\] Approved proposal .* stopped before finishing \(error\)/
    )
    expect(modelText(h.reports()[0]!.msg)).toContain(
      `delegate a task if the work is still needed.\n\n${ANSWER_LANGUAGE}`
    )
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
    // The card in the conversation says who denied it and that nothing ran.
    const [channel, ts, blocks] = h.cards.update.mock.calls.at(-1)!
    expect([channel, ts]).toEqual(['C1', 'card-1'])
    expect(JSON.stringify(blocks)).toContain('Denied by u0bob. Nothing was run.')
    expect(JSON.stringify(blocks)).not.toContain('"actions"')
    expect((await h.d.store.assistantItems.get('bot-a', item.id)).observations.map((o: any) => o.text)).toContain(
      `Proposal "${SENTENCE}" was denied by u0bob; nothing was run.`
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
    expect(h.cards.update.mock.calls.at(-1)!.slice(0, 2)).toEqual(['C1', 'card-1'])
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

  it('refuses a proposal whose follow-up ended meanwhile', async () => {
    const h = await boot(scaffold())
    const { item, record } = await proposed(h)
    await h.d.store.assistantItems.schedule('bot-a', item.id, { status: 'done', nextCheck: null })
    expect(await h.decide(record.id)).toMatchObject({ status: 'failed', failure: 'its follow-up has ended' })
    await h.settled()
    expect(h.tasks()).toHaveLength(0)
    await h.daemon.stop()
  })
})

describe('a proposal in the conversation its item belongs to', () => {
  const draftOf = async (h: Awaited<ReturnType<typeof boot>>, id: string): Promise<AssistantDraft> =>
    await h.d.store.assistantDrafts.get(id)

  it.each([true, false])(
    'is approved there by a person who could ask the agent, whatever in-chat runtime changes allow (%s)',
    async (chat) => {
      const h = await boot(scaffold({ chat }))
      const { record } = await proposed(h)
      h.behavior.task = reportsBack(h.deps, h.d)
      expect(h.cards.post.mock.calls.map((c) => c[0])).toEqual(['C1'])

      await h.click(record.id, 'approve', 'U0BOB')
      await vi.waitFor(() => expect(h.tasks()).toHaveLength(1), WAIT)
      await h.settled()
      expect(h.tasks()[0]!.msg).toMatchObject({ channel: 'C1', source: 'agent', headless: true })
      expect(await draftOf(h, record.id)).toMatchObject({
        status: 'succeeded',
        decidedBy: expect.stringMatching(/U0BOB$/),
        decidedByName: 'u0bob'
      })
      // The card in the conversation is rewritten in place: approved by whom, then how it ended.
      const rewrites = h.cards.update.mock.calls.filter((c) => c[0] === 'C1' && c[1] === 'card-1')
      expect(JSON.stringify(rewrites)).toContain('Approved by u0bob')
      expect(JSON.stringify(rewrites.at(-1))).toContain('reported back')
      expect(h.cards.post).toHaveBeenCalledTimes(1)
      await h.daemon.stop()
    }
  )

  it('refuses a bot, and anyone once the agent is switched off there, and runs nothing', async () => {
    const h = await boot(scaffold())
    const { record } = await proposed(h)
    await h.click(record.id, 'approve', 'U0BOT')
    h.d.agents.get('bot-a').integrations[0].core.mutedChannels = ['C1']
    await h.click(record.id, 'approve', 'U0BOB')
    await h.settled()
    expect(h.tasks()).toHaveLength(0)
    expect(await draftOf(h, record.id)).toMatchObject({ status: 'awaiting_review', decidedBy: null })
    expect(h.cards.update).not.toHaveBeenCalled()
    await h.daemon.stop()
  })

  it('in a direct message, lands there and is approved by that person only', async () => {
    const h = await boot(scaffold())
    const { record } = await proposed(h, 'D1')
    expect(h.cards.post.mock.calls.map((c) => c[0])).toEqual(['D1'])
    expect(record.approver).toMatchObject({ kind: 'place', channel: 'D1' })

    await h.click(record.id, 'approve', 'U0BOB')
    expect(await draftOf(h, record.id)).toMatchObject({ status: 'awaiting_review' })
    h.behavior.task = 'hang'
    await h.click(record.id, 'approve', 'U0ALICE')
    await vi.waitFor(() => expect(h.tasks()).toHaveLength(1), WAIT)
    expect(h.tasks()[0]!.msg).toMatchObject({ channel: 'D1' })
    expect(await draftOf(h, record.id)).toMatchObject({ status: 'executing', decidedByName: 'u0alice' })
    await h.d.interruptAgentTurns('bot-a', 'stop')
    await h.settled()
    await h.daemon.stop()
  })

  it('waits in Activity when the conversation cannot take the card and no responsible user can be reached', async () => {
    const h = await boot(scaffold())
    h.cards.post.mockRejectedValueOnce(new Error('not_in_channel'))
    const { record, results } = await proposed(h)
    expect(h.cards.post.mock.calls.map((c) => c[0])).toEqual(['C1'])
    expect(record).toMatchObject({ status: 'awaiting_review', approver: null, cardTs: null })
    expect(results[0]).toMatchObject({ approver: null })
    await h.daemon.stop()
  })

  it('cards nothing in an external place when no responsible user can be reached, leaving it to Activity', async () => {
    const h = await boot(scaffold({ external: ['C1'] }))
    const { record } = await proposed(h)
    expect(h.cards.post).not.toHaveBeenCalled()
    expect(record).toMatchObject({ status: 'awaiting_review', approver: null })
    await h.daemon.stop()
  })

  it('keeps its card across a restart, and the reconnect rewrites one whose decision it missed', async () => {
    const root = scaffold()
    const h = await boot(root)
    const { item, record } = await proposed(h)
    // A second proposal, denied while its card could not be edited.
    h.cards.post.mockResolvedValueOnce('card-2')
    const { draft: missed } = await h.d.drafts.propose({
      agentId: 'bot-a',
      target: record.target,
      destination: {},
      task: TASK,
      sentence: 'I want to close PR #12.',
      why: '',
      itemId: item.id,
      itemVersion: item.version,
      source: record.source,
      place: { integrationId: INT_A, channel: 'C1' }
    })
    h.cards.update.mockResolvedValueOnce(false)
    await h.click(missed.id, 'discard', 'U0BOB')
    expect(await draftOf(h, missed.id)).toMatchObject({ status: 'denied', cardShows: 'awaiting_review' })
    await h.daemon.stop()

    const edits = vi.spyOn(SlackConnection.prototype, 'updateBlocks')
    try {
      const restarted = await boot(root)
      await vi.waitFor(async () => expect((await draftOf(restarted, missed.id)).cardShows).toBe('denied'), WAIT)
      const swept = edits.mock.calls.find((c) => c[0] === 'C1' && c[1] === 'card-2')
      expect(JSON.stringify(swept)).toContain('Denied by u0bob. Nothing was run.')

      // The first, pending across the restart, is decided there and its card rewritten.
      restarted.behavior.task = 'hang'
      await restarted.click(record.id, 'approve', 'U0BOB')
      await vi.waitFor(() => expect(restarted.tasks()).toHaveLength(1), WAIT)
      const rewrite = restarted.cards.update.mock.calls.find((c) => c[0] === 'C1' && c[1] === 'card-1')
      expect(JSON.stringify(rewrite)).toContain('Approved by u0bob')
      await restarted.d.interruptAgentTurns('bot-a', 'stop')
      await restarted.settled()
      await restarted.daemon.stop()
    } finally {
      edits.mockRestore()
    }
  })

  it('leaves an agent outside assistant mode alone: no check, so no card', async () => {
    const h = await boot(scaffold())
    await h.d.store.assistantItems.create({
      agentId: 'bot-b',
      taskKey: 'slack:C1:subsession:check-b:bot-b',
      title: 'Land PR #12',
      doneWhen: 'PR #12 is merged',
      nextCheck: Date.now() - MINUTE,
      origin: { platform: 'slack', channel: 'C1', transportScope: h.d.transportScopeForIntegrationIds([INT_B]) },
      summary: 'Bob asked.'
    })
    await h.d.followUpChecks.sweep()
    await h.settled()
    expect(h.checks()).toHaveLength(0)
    expect(await h.records()).toEqual([])
    expect(h.cards.post).not.toHaveBeenCalled()
    await h.daemon.stop()
  })
})

describe('a proposal in a webchat conversation', () => {
  const CONVERSATION = 'sid-webchat-bot-a'

  /** A webchat conversation's one session, which an item taken there reports into and whose page decides its proposals. */
  async function seedWebchat(d: any, channel: string, sessionId: string) {
    const thread = `webchat:${channel}`
    await d.store.upsertSession({
      key: sessionKey('webchat', channel, thread, 'bot-a'),
      agentId: 'bot-a',
      platform: 'webchat',
      channel,
      thread,
      acpSessionId: `acp-${sessionId}`,
      sessionId,
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
  }

  /** One proposal from a check of an item taken in the webchat conversation `conv-1`. */
  async function proposedInWebchat(h: Awaited<ReturnType<typeof boot>>) {
    await seedWebchat(h.d, 'conv-1', CONVERSATION)
    const item = await h.d.store.assistantItems.create({
      agentId: 'bot-a',
      taskKey: sessionKey('webchat', 'conv-1', checkCoordinate(randomUUID()), 'bot-a'),
      asker: 'user:usr-alice',
      title: 'Land PR #12',
      doneWhen: 'PR #12 is merged',
      nextCheck: Date.now() - MINUTE,
      origin: { platform: 'webchat', channel: 'conv-1', transportScope: null },
      summary: 'Alice asked in webchat to see PR #12 through.'
    })
    const results: unknown[] = []
    h.behavior.check = proposing(h.deps, results)
    await h.d.followUpChecks.sweep()
    await vi.waitFor(() => expect(h.checks()).toHaveLength(1), WAIT)
    await h.settled()
    const [record] = await h.records()
    return { item, results, record: record! }
  }

  /** A decision made on a conversation's page, as the Control Plane forwards it for whoever may continue it. */
  const decideIn = (
    h: Awaited<ReturnType<typeof boot>>,
    draftId: string,
    sessionId = CONVERSATION,
    choice: 'approve' | 'discard' = 'approve'
  ) =>
    h.activity.write({
      agentId: 'bot-a',
      operation: 'decide-draft',
      draftId,
      choice,
      decider: { userId: 'usr-owner', name: 'Alice' },
      conversation: { sessionId }
    }) as Promise<any>

  const listIn = async (h: Awaited<ReturnType<typeof boot>>, sessionId: string) =>
    (
      (await h.activity.read({
        agentId: 'bot-a',
        operation: 'drafts',
        limit: 10,
        proposals: true,
        conversation: { sessionId }
      })) as any
    ).drafts.map((d: any) => d.id)

  it('waits on the conversation’s page, listed there only, and is carded to no one', async () => {
    const h = await boot(scaffold())
    const { record, results } = await proposedInWebchat(h)
    await seedPlace(h.d)

    expect(record).toMatchObject({
      status: 'awaiting_review',
      target: { platform: 'webchat', integrationId: '', channel: 'conv-1' },
      approver: { kind: 'place', integrationId: '', channel: 'conv-1' },
      cardTs: null
    })
    expect(results[0]).toMatchObject({ approver: 'the people in the conversation the follow-up belongs to' })
    // The responsible user is not carded.
    expect(h.cards.post).not.toHaveBeenCalled()

    expect(await listIn(h, CONVERSATION)).toEqual([record.id])
    for (const other of ['sid-parent-bot-a', 'sid-unknown']) expect(await listIn(h, other)).toEqual([])
    // Editors still see it in Activity, decided in its conversation rather than by a named approver.
    const activity = (await h.activity.read({
      agentId: 'bot-a',
      operation: 'drafts',
      limit: 10,
      proposals: true
    })) as any
    expect(activity.drafts).toEqual([
      expect.objectContaining({ id: record.id, kind: 'task', approver: null, inConversation: true })
    ])
    await h.daemon.stop()
  })

  it('starts its task once when decided there, and refuses a decision naming another conversation', async () => {
    const h = await boot(scaffold())
    const { record } = await proposedInWebchat(h)
    await seedPlace(h.d)
    await seedWebchat(h.d, 'conv-2', 'sid-webchat-other')
    // A Slack proposal is not one of the webchat conversation's either.
    const slack = await h.d.store.assistantDrafts.createTask({
      agentId: 'bot-a',
      target: { platform: 'slack', integrationId: INT_A, channel: 'C1', thread: null },
      task: TASK,
      sentence: SENTENCE,
      why: '',
      itemId: 'item-slack',
      itemVersion: 1,
      source: record.source!
    })

    for (const sessionId of ['sid-parent-bot-a', 'sid-webchat-other', 'sid-unknown'])
      expect(await decideIn(h, record.id, sessionId)).toMatchObject({ result: 'not-found', status: null })
    expect(await decideIn(h, slack.id)).toMatchObject({ result: 'not-found' })
    expect((await h.d.store.assistantDrafts.get(record.id)).status).toBe('awaiting_review')
    expect((await h.d.store.assistantDrafts.get(slack.id)).status).toBe('awaiting_review')

    h.behavior.task = 'hang'
    expect(await decideIn(h, record.id)).toMatchObject({ result: 'decided', status: 'executing' })
    await vi.waitFor(() => expect(h.tasks()).toHaveLength(1), WAIT)
    expect(h.tasks()[0]!.msg).toMatchObject({ platform: 'webchat', channel: 'conv-1', headless: true })
    expect(h.tasks()[0]!.callMeta).toMatchObject({ originSessionId: CONVERSATION })
    expect(await h.d.store.assistantDrafts.get(record.id)).toMatchObject({
      status: 'executing',
      decidedBy: 'user:usr-owner',
      decidedByName: 'Alice'
    })
    // Decided again there or in Activity, it runs nothing more.
    expect(await decideIn(h, record.id)).toMatchObject({ result: 'already-decided' })
    expect(await h.decide(record.id)).toMatchObject({ result: 'already-decided' })
    expect(await listIn(h, CONVERSATION)).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(h.tasks()).toHaveLength(1)
    expect(h.cards.post).not.toHaveBeenCalled()
    await h.d.interruptAgentTurns('bot-a', 'stop')
    await h.settled()
    await h.daemon.stop()
  })

  it('takes the first answer from any surface: one denied in Activity is not approved on the page', async () => {
    const h = await boot(scaffold())
    const { item, record } = await proposedInWebchat(h)

    expect(await h.decide(record.id, 'discard')).toMatchObject({ result: 'decided', status: 'denied' })
    expect(await decideIn(h, record.id)).toMatchObject({ result: 'already-decided', status: 'denied' })
    await h.settled()
    expect(h.tasks()).toHaveLength(0)
    expect((await h.d.store.assistantItems.get('bot-a', item.id)).observations.map((o: any) => o.text)).toContain(
      `Proposal "${SENTENCE}" was denied by Grace; nothing was run.`
    )
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
    expect(refused).toMatchObject({ result: 'busy', status: 'awaiting_review' })
    expect(refused.failure).toContain('already has 1 task running, the most it runs at once')
    expect(await h.d.store.assistantDrafts.get(record.id)).toMatchObject({
      status: 'awaiting_review',
      subsessionKey: null
    })
    expect(h.tasks()).toHaveLength(0)
    // The card keeps its buttons and says why nothing ran.
    const card = JSON.stringify(h.cards.update.mock.calls.at(-1))
    expect(card).toContain('"actions"')
    expect(card).toContain('already has 1 task running, the most it runs at once')

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
    h.behavior.task = reportsBack(h.deps, h.d)
    await h.d.replayInbox(new Set(['bot-a']))
    await vi.waitFor(() => expect(h.reports()).toHaveLength(1), WAIT)
    await h.settled()
    await h.d.replayInbox(new Set(['bot-a']))
    await h.settled()

    expect(h.tasks()).toHaveLength(1)
    expect(h.reports()).toHaveLength(1)
    expect(modelText(h.reports()[0]!.msg)).toContain(
      '[approved proposal cut short] Not sure this went through, please check: the approved proposal'
    )
    expect(modelText(h.reports()[0]!.msg)).toContain(`for follow-up "Land PR #12"`)
    expect(modelText(h.reports()[0]!.msg)).toContain(`Tell the people here to check.\n\n${ANSWER_LANGUAGE}`)
    expect(h.reports()[0]!.msg).toMatchObject({ channel: 'C1', sessionThread: place.coordinate })
    expect(await h.d.store.assistantDrafts.get(record.id)).toMatchObject({ status: 'outcome_unknown' })
    expect(await h.d.store.assistantSubsessions.get('bot-a', key)).toMatchObject({ state: 'failed' })
    expect(JSON.stringify(h.cards.update.mock.calls.at(-1))).toContain('not sure this went through')
    // Nothing left to run; only the report's receipt, which a re-delivery is recognized by.
    const inbox = (await h.d.store.listInboxBySessionKeyFifo()).filter((row: any) => row.agentId === 'bot-a')
    expect(inbox.filter((row: any) => row.completedAt === null)).toEqual([])
    expect(inbox).toEqual([expect.objectContaining({ sessionKey: place.key, id: expect.stringMatching(/receipt/) })])
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
    expect(modelText(h.reports()[0]!.msg)).toContain(
      '[approved proposal cut short] Not sure this went through, please check: the approved proposal'
    )
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

  /** An approved task that hangs, then is cut for a handover that keeps its delivery and replayed by a fresh service. */
  async function cutTask(
    h: Awaited<ReturnType<typeof boot>>,
    before: (place: { coordinate: string; scope: string }) => Promise<void> = async () => {}
  ) {
    const { place, item, record } = await proposed(h)
    h.behavior.task = 'hang'
    await h.decide(record.id)
    await vi.waitFor(() => expect(h.tasks()).toHaveLength(1), WAIT)
    const key = sessionKey('slack', 'C1', h.tasks()[0]!.msg.thread!, 'bot-a', place.scope)
    await vi.waitFor(async () => expect((await h.d.store.getSession(key))?.acpSessionId).toBeTruthy(), WAIT)
    await before(place)
    await h.d.interruptAgentTurns('bot-a', 'handover', 'handoff')
    h.d.assistantTaskService = undefined
    h.d.absorbedContextTs.clear()
    const replayed = h.d.replayInbox(new Set(['bot-a'])) as Promise<void>
    return { place, item, record, key, replayed }
  }

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

  it('tells its place before the record settles', async () => {
    const h = await boot(scaffold())
    let release!: () => void
    const seen = watchReports(h.d, new Promise<void>((resolve) => (release = resolve)))
    const { record, key, replayed } = await cutTask(h)
    await vi.waitFor(() => expect(seen.calls).toBe(1), WAIT)
    // The report is still on its way, so neither the record nor the sub-session has settled.
    expect(await h.d.store.assistantDrafts.get(record.id)).toMatchObject({ status: 'executing' })
    expect(await h.d.store.assistantSubsessions.get('bot-a', key)).toMatchObject({ state: 'open' })

    release()
    await replayed
    await h.settled()
    expect(h.reports()).toHaveLength(1)
    expect(await h.d.store.assistantDrafts.get(record.id)).toMatchObject({ status: 'outcome_unknown' })
    expect(await h.d.store.assistantSubsessions.get('bot-a', key)).toMatchObject({ state: 'failed' })
    await h.daemon.stop()
  })

  it('tells its place again after a crash between the report and the settling, and the place hears it once', async () => {
    const h = await boot(scaffold())
    const seen = watchReports(h.d)
    // The process dies after the report is in, before the record settles; the recovery that follows tries again.
    const index = h.d.store.assistantSubsessions
    const finishClaiming = index.finishClaiming.bind(index)
    let crashed = false
    index.finishClaiming = async (...args: unknown[]) => {
      if (crashed) return await finishClaiming(...args)
      crashed = true
      throw new Error('the daemon was killed')
    }
    const { record, replayed } = await cutTask(h)
    await replayed
    await h.settled()

    expect(crashed).toBe(true)
    expect(seen.calls).toBe(2)
    expect(h.reports()).toHaveLength(1)
    expect(
      h.hosts.flatMap((x) => x.prompt.mock.calls).filter((c: any) => JSON.stringify(c).includes('Not sure'))
    ).toHaveLength(1)
    expect(await h.d.store.assistantDrafts.get(record.id)).toMatchObject({ status: 'outcome_unknown' })
    expect(h.tasks()).toHaveLength(1)
    await h.daemon.stop()
  })

  it('tells the conversation’s current session after `!new`, not the one the task started under', async () => {
    const h = await boot(scaffold())
    let next = ''
    // `!new` rotates the conversation while the task runs, and the next message starts the new session.
    const { place, key, replayed } = await cutTask(h, async ({ coordinate, scope }) => {
      next = await h.d.store.advanceAppendCoordinate('bot-a', 'C1', coordinate, scope)
      await h.d.store.upsertSession({
        key: sessionKey('slack', 'C1', next, 'bot-a', scope),
        agentId: 'bot-a',
        platform: 'slack',
        channel: 'C1',
        thread: next,
        transportScope: scope,
        acpSessionId: 'acp-current-bot-a',
        sessionId: 'sid-current-bot-a',
        state: 'idle',
        lastDeliveredTs: null,
        updatedAt: Date.now()
      })
    })
    await replayed
    await h.settled()

    expect(next).not.toBe(place.coordinate)
    expect(h.reports()).toHaveLength(1)
    expect(modelText(h.reports()[0]!.msg)).toContain(
      '[approved proposal cut short] Not sure this went through, please check: the approved proposal'
    )
    expect(h.reports()[0]!.msg).toMatchObject({ channel: 'C1', sessionThread: next })
    expect(await h.d.store.assistantSubsessions.get('bot-a', key)).toMatchObject({
      parentSessionId: 'sid-parent-bot-a'
    })
    await h.daemon.stop()
  })

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

describe('a check’s standing rules', () => {
  it('give it the third outcome: propose when an action is warranted, else report or stay silent', async () => {
    const h = await boot(scaffold())
    await seedPlace(h.d)
    await takeItem(h.d)
    h.behavior.check = 'end'
    await h.d.followUpChecks.sweep()
    await vi.waitFor(() => expect(h.checks()).toHaveLength(1), WAIT)
    await h.settled()
    const text = modelText(h.checks()[0]!.msg)
    expect(text).toContain('one of three outcomes')
    expect(text).toContain('call `propose` once')
    expect(text).toContain('The check records its observation either way.')
    expect(checkCoordinate('x')).not.toBe('subsession:task-x')
    await h.daemon.stop()
  })
})
