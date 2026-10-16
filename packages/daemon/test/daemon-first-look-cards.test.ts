// A first look's suggestions as cards (assistant-mode.md §5.13 "Cards"): offered on its report's round, held until the reply posts, threaded under it, and the follow-up form.
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { executeTool, type SessionContext } from '../src/mcp/ops.js'
import { FIRST_LOOK_TOOL } from '../src/mcp/ops/first-look.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { isAppendCoordinate } from '../src/session/append-coordinate.js'
import { isFirstLookCoordinate, isTaskCoordinate } from '../src/session/subsession-coordinate.js'
import { sessionKey } from '../src/store/local-store.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

const TEST_ORG = '00000000-0000-0000-0000-0000000000a1'
const LOOK_OPENING = 'You are taking a first look at'
const ROUND_OPENING = '[first look] Your first look at'
const REPORT = '## How this place works\nReleases are planned here.\n\n## Where I could help\nRelease notes.'
const INTRO = 'Hi, I am bot-a. I read the release threads here; @-mention me.'

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-first-look-cards-'))
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
          core: { bindRules: [{ match: { kind: 'mention' } }], sessionModes: [{ channel: 'C1', mode: 'append' }] },
          config: { botToken: 'xoxb-bot-a', appToken: 'xapp-bot-a' }
        }
      ],
      output: { mode: 'low' },
      assistantMode: { enabled: true }
    })
  )
  return root
}

type Post = { channel: string; thread?: string; text: string; blocks?: unknown[]; ts: string }
type RoundTurn = (ctx: SessionContext, say: (text: string) => void) => Promise<void>

async function boot(opts: { seeded?: boolean; channel?: Record<string, unknown>; teamId?: string } = {}) {
  const behavior: { round: RoundTurn } = { round: async () => {} }
  const registered: SessionContext[] = []
  // The daemon's tool deps, known once it has started.
  const ops: { deps?: any } = {}
  const hostFactory = (_agent: unknown, update: (sid: string, u: unknown) => void) =>
    ({
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => `acp-${randomUUID()}`),
      permissionModeOptions: vi.fn(() => ({ current: undefined, modes: ['default', 'plan'] })),
      setSessionPermissionMode: vi.fn(async () => true),
      prompt: vi.fn(async (sessionId: string, blocks: unknown[]) => {
        const text = JSON.stringify(blocks)
        if (text.includes(LOOK_OPENING)) {
          const ctx = [...registered].reverse().find((c) => isFirstLookCoordinate(c.thread))!
          await executeTool(
            ctx,
            'recordCheck',
            { observation: 'Read the place.', report: REPORT, done: true },
            ops.deps
          )
        } else if (text.includes(ROUND_OPENING)) {
          const ctx = [...registered].reverse().find((c) => isAppendCoordinate(c.thread))!
          const say = (chunk: string) =>
            update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } })
          await behavior.round(ctx, say)
        }
        return 'end_turn'
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }) as any
  const posts: Post[] = []
  const updates: { channel: string; ts: string; text: string }[] = []
  let n = 0
  const base = fakeSlackAppFactory(opts.teamId ? { teamId: opts.teamId } : {})
  const slackAppFactory = ((...args: unknown[]) => {
    const app = (base as any)(...args)
    app.client.chat.postMessage = async (req: any) => {
      const ts = `1700000300.${String(++n).padStart(6, '0')}`
      posts.push({
        channel: req.channel,
        ...(req.thread_ts ? { thread: req.thread_ts } : {}),
        text: req.text,
        ...(req.blocks ? { blocks: req.blocks } : {}),
        ts
      })
      return { ok: true, ts }
    }
    app.client.chat.update = async (req: any) => {
      updates.push({ channel: req.channel, ts: req.ts, text: req.text })
      return { ok: true, ts: req.ts }
    }
    app.client.users.info = async ({ user }: { user: string }) => ({
      user: { id: user, name: user.toLowerCase(), is_bot: user.startsWith('B') }
    })
    if (opts.channel) app.client.conversations.info = async () => ({ channel: opts.channel })
    return app
  }) as typeof base
  const daemon = new Daemon({ slackAppFactory, root: scaffold(), hostFactory: hostFactory as any })
  await daemon.start()
  const d = daemon as any
  const placement = { agentId: 'bot-a', daemonId: 'local-daemon', name: 'bot-a' }
  d.cpCollab.replace({
    generation: 0,
    channels: [{ orgId: TEST_ORG, platform: 'slack', channelId: 'C1', agents: [placement] }],
    agents: [{ ...placement, orgId: TEST_ORG }]
  })
  const register = d.mcp.register.bind(d.mcp)
  d.mcp.register = (ctx: SessionContext) => {
    registered.push(ctx)
    return register(ctx)
  }
  const dispatched: { msg: NormalizedMessage; turn: Promise<unknown> }[] = []
  const real = d.dispatch.bind(d)
  d.dispatch = (agentId: string, msg: NormalizedMessage, ...rest: any[]) => {
    const turn = real(agentId, msg, ...rest)
    dispatched.push({ msg, turn: turn.catch(() => undefined) })
    return turn
  }
  const settled = async () => {
    for (let seen = -1; seen !== dispatched.length;) {
      seen = dispatched.length
      await Promise.all(dispatched.map((c) => c.turn))
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  const deps = { ...d.mcp.deps, canRun: () => true }
  ops.deps = deps
  const scope: string = d.transportScopeForIntegrationIds(['int-bot-a'])
  const coordinate: string = await d.store.resolveAppendCoordinate('bot-a', 'C1', scope, 1)
  const key = sessionKey('slack', 'C1', coordinate, 'bot-a', scope)
  // Unless a place nobody spoke in yet is wanted, its long session exists already.
  if (opts.seeded !== false)
    await d.store.upsertSession({
      key,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: coordinate,
      transportScope: scope,
      // No runtime yet, so the report's round opens one and is handed its tools.
      acpSessionId: null,
      sessionId: 'sid-parent',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
  const placeCtx: SessionContext = {
    agentId: 'bot-a',
    platform: 'slack',
    integrationId: 'int-bot-a',
    transportScope: scope,
    isDm: false,
    channel: 'C1',
    thread: coordinate,
    deliveryThread: '100.1',
    tools: [FIRST_LOOK_TOOL]
  }
  /** Ask for a first look and wait until its report round has run and settled. */
  const look = async () => {
    expect(await executeTool(placeCtx, 'firstLook', {}, deps)).toMatchObject({ started: true })
    await vi.waitFor(() => expect(dispatched.some((c) => c.msg.parentReport === true)).toBe(true), WAIT)
    await settled()
  }
  const cards = () => posts.filter((p) => p.blocks !== undefined && JSON.stringify(p.blocks).includes('ac_perm'))
  return { daemon, d, behavior, registered, dispatched, posts, updates, cards, settled, deps, scope, key, look }
}

const TASK = {
  sentence: 'I want to draft the release notes because two releases went out without them.',
  why: 'Asked twice.',
  task: 'Draft the release notes for 2.6.'
}
const FOLLOW_UP = {
  sentence: 'I want to follow up the 2.6 release because Ada is waiting on it.',
  why: 'Ada asked for a date on Monday.',
  followUp: { title: 'The 2.6 release date', doneWhen: 'A date is posted here.', nextCheck: '2099-01-01T09:00:00Z' }
}
const PIN = {
  sentence: 'I want to pin the release checklist because people keep asking for it.',
  why: 'Asked three times.',
  task: 'Pin the release checklist.'
}

describe('a first look’s report round on a platform with cards', () => {
  it('offers propose three times, holds the cards and threads them under the reply in the order proposed', async () => {
    const { daemon, d, behavior, registered, posts, cards, deps, look } = await boot()
    const results: unknown[] = []
    behavior.round = async (ctx, say) => {
      results.push(await executeTool(ctx, 'propose', TASK, deps))
      results.push(await executeTool(ctx, 'propose', FOLLOW_UP, deps))
      // Nothing is carded while the round runs.
      expect(cards()).toEqual([])
      say(INTRO)
      results.push(await executeTool(ctx, 'propose', PIN, deps))
      results.push(await executeTool(ctx, 'propose', TASK, deps).catch((err: Error) => err.message))
    }
    await look()
    const longSession = registered.find((c) => isAppendCoordinate(c.thread))!
    expect(longSession.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['firstLook', 'propose']))
    expect(results.slice(0, 3)).toEqual([
      expect.objectContaining({ proposed: true }),
      expect.objectContaining({ proposed: true }),
      expect.objectContaining({ proposed: true })
    ])
    expect(results[3]).toContain('at most 3 proposals')
    // The reply posts at the place's top level, and its cards in its thread, in the order proposed.
    const intro = posts.find((p) => p.text.includes('Hi, I am bot-a'))!
    expect(intro.thread).toBeUndefined()
    const carded = cards()
    expect(carded.map((p) => p.thread)).toEqual([intro.ts, intro.ts, intro.ts])
    expect(carded.map((p) => JSON.stringify(p.blocks))).toEqual([
      expect.stringContaining('I want to draft the release notes'),
      expect.stringContaining('A date is posted here.'),
      expect.stringContaining('I want to pin the release checklist')
    ])
    // A task's exact work is one click away on the proposing session, not on the card.
    const [draft, , pin] = carded.map((p) => JSON.stringify(p.blocks))
    expect(draft).toMatch(/\/sessions\/sid-parent[^|]*\|🔗>/)
    expect(draft).not.toContain('Draft the release notes for 2.6.')
    expect(pin).not.toContain('Pin the release checklist.')
    expect(posts.indexOf(intro)).toBeLessThan(posts.indexOf(carded[0]!))
    const pending = await d.store.assistantDrafts.listPending('bot-a', 10, Date.now(), { tasks: true })
    expect(pending.every((draft: any) => draft.proposal.held === false && draft.cardTs !== null)).toBe(true)
    await daemon.stop()
  })

  it('cards a round’s proposals where the place’s cards go when its reply never posts', async () => {
    const { daemon, behavior, cards, deps, look } = await boot()
    behavior.round = async (ctx) => {
      await executeTool(ctx, 'propose', TASK, deps)
    }
    await look()
    expect(cards()).toHaveLength(1)
    expect(cards()[0]!.channel).toBe('C1')
    expect(cards()[0]!.thread).toBeUndefined()
    await daemon.stop()
  })

  it('posts the cards a cut round left held, once nothing runs it', async () => {
    const { daemon, d, behavior, cards, deps, look } = await boot()
    behavior.round = async (ctx, say) => {
      await executeTool(ctx, 'propose', TASK, deps)
      say(INTRO)
    }
    // A crash between the round's end and its release leaves the card held.
    const release = d.releaseRoundCards.bind(d)
    d.releaseRoundCards = async () => {}
    await look()
    expect(cards()).toEqual([])
    d.releaseRoundCards = release
    await d.releaseStrandedRounds()
    expect(cards()).toHaveLength(1)
    await d.releaseStrandedRounds()
    expect(cards()).toHaveLength(1)
    await daemon.stop()
  })

  it('refuses a follow-up form with no first check, which nothing would wake, and cards one with a first check', async () => {
    const { daemon, behavior, posts, cards, deps, look } = await boot()
    const unscheduled = { title: FOLLOW_UP.followUp.title, doneWhen: FOLLOW_UP.followUp.doneWhen }
    const results: unknown[] = []
    behavior.round = async (ctx, say) => {
      results.push(
        await executeTool(ctx, 'propose', { ...FOLLOW_UP, followUp: unscheduled }, deps).catch(
          (err: Error) => err.message
        )
      )
      results.push(await executeTool(ctx, 'propose', FOLLOW_UP, deps))
      say(INTRO)
    }
    await look()
    expect(results).toEqual([
      expect.stringContaining('needs followUp.nextCheck'),
      expect.objectContaining({ proposed: true })
    ])
    // The refused call made no proposal, so only the scheduled one is carded, under the introduction.
    const intro = posts.find((p) => p.text.includes('Hi, I am bot-a'))!
    expect(cards().map((p) => [p.thread, JSON.stringify(p.blocks)])).toEqual([
      [intro.ts, expect.stringContaining('A date is posted here.')]
    ])
    await daemon.stop()
  })

  it('tells a public internal channel’s long session to merge what is new about the organization into its shared file', async () => {
    const { daemon, dispatched, look } = await boot({
      channel: { id: 'C1', name: 'release-train', is_private: false, is_ext_shared: false }
    })
    await look()
    const report = dispatched.find((c) => c.msg.parentReport === true)!
    const text = report.msg.turnBody?.prompt ?? report.msg.text ?? ''
    expect(text).toContain('- channels.md: one line for this place')
    expect(text).toContain('- organization.md: unless "About the organization" has nothing new')
    expect(text).toContain('updateMemoryEntry and that revision')
    await daemon.stop()
  })

  it('refuses propose on any other round of the long session', async () => {
    const { daemon, registered, deps, look } = await boot()
    await look()
    const longSession = registered.find((c) => isAppendCoordinate(c.thread))!
    await expect(executeTool(longSession, 'propose', TASK, deps)).rejects.toThrow(
      'only on the round a first look reports back'
    )
    await daemon.stop()
  })

  it('takes a follow-up form’s follow-up on approval, with the approver as its asker, and its card says so', async () => {
    const { daemon, d, behavior, dispatched, updates, cards, deps, scope, look, settled } = await boot()
    let proposalId = ''
    behavior.round = async (ctx, say) => {
      proposalId = ((await executeTool(ctx, 'propose', FOLLOW_UP, deps)) as { proposalId: string }).proposalId
      say(INTRO)
    }
    await look()
    expect(cards()).toHaveLength(1)
    const lookItem = await d.store.assistantItems.latestFirstLook('bot-a', {
      platform: 'slack',
      channel: 'C1',
      transportScope: scope
    })
    // The first look has ended by design; its proposal is not refused for that.
    expect(lookItem.status).toBe('done')
    await d.drafts.handleChoice({
      requestId: proposalId,
      optionId: 'approve',
      actor: { userId: 'U0ADA', name: 'Ada' }
    })
    const draft = await d.store.assistantDrafts.get(proposalId)
    expect(draft).toMatchObject({ status: 'succeeded', decidedByName: 'Ada' })
    const taken = await d.store.assistantItems.get('bot-a', draft.proposal.tookItemId)
    expect(taken).toMatchObject({
      title: 'The 2.6 release date',
      doneWhen: 'A date is posted here.',
      status: 'active',
      nextCheck: Date.parse('2099-01-01T09:00:00Z'),
      firstLook: null,
      origin: { platform: 'slack', channel: 'C1' }
    })
    expect(taken.asker).toMatch(/^slack:.+:U0ADA$/)
    // It runs no task, so nothing counts against the task limit.
    await settled()
    expect(dispatched.some((c) => isTaskCoordinate(c.msg.thread))).toBe(false)
    expect(updates.at(-1)?.text).toContain('The follow-up was taken')
    await daemon.stop()
  })

  it('runs an approved task proposal of the ended first look in its place', async () => {
    const { daemon, d, behavior, dispatched, deps, look, settled } = await boot()
    let proposalId = ''
    behavior.round = async (ctx, say) => {
      proposalId = ((await executeTool(ctx, 'propose', TASK, deps)) as { proposalId: string }).proposalId
      say(INTRO)
    }
    await look()
    const decision = await d.drafts.decideFromConsole({
      agentId: 'bot-a',
      draftId: proposalId,
      choice: 'approve',
      decider: { userId: 'usr-1', name: 'Grace' }
    })
    expect(decision).toMatchObject({ result: 'decided', status: 'executing', failure: null })
    await settled()
    const task = dispatched.find((c) => isTaskCoordinate(c.msg.thread))!
    expect(JSON.stringify(task.msg)).toContain('You proposed this after your first look at this place')
    await daemon.stop()
  })

  it('answers a console approval of the follow-up form with the follow-up and its conversation', async () => {
    const { daemon, d, behavior, deps, look } = await boot()
    let proposalId = ''
    behavior.round = async (ctx, say) => {
      proposalId = ((await executeTool(ctx, 'propose', FOLLOW_UP, deps)) as { proposalId: string }).proposalId
      say(INTRO)
    }
    await look()
    const decision = await d.drafts.decideFromConsole({
      agentId: 'bot-a',
      draftId: proposalId,
      choice: 'approve',
      decider: { userId: 'usr-1', name: 'Grace' }
    })
    expect(decision).toMatchObject({
      result: 'decided',
      status: 'succeeded',
      followUp: { id: expect.any(String), parentSessionId: expect.any(String) }
    })
    expect(await d.store.assistantItems.get('bot-a', decision.followUp.id)).toMatchObject({ asker: 'user:usr-1' })
    await daemon.stop()
  })
})

describe('a first look’s report round on a platform without cards', () => {
  it('keeps the text form of step 3 and offers no propose', async () => {
    const { daemon, d, behavior, registered, dispatched, deps, look } = await boot()
    d.hasCardSurface = () => false
    let refused = ''
    behavior.round = async (ctx) => {
      refused = await executeTool(ctx, 'propose', TASK, deps).then(
        () => '',
        (err: Error) => err.message
      )
    }
    await look()
    const report = dispatched.find((c) => c.msg.parentReport === true)!
    const text = report.msg.turnBody?.prompt ?? report.msg.text ?? ''
    expect(text).toContain('3. In the same message, list each "Where I could help" item in one line')
    expect(text).not.toContain('with propose')
    const longSession = registered.find((c) => isAppendCoordinate(c.thread))!
    expect(longSession.tools.map((t) => t.name)).not.toContain('propose')
    expect(refused).toContain('available only in a follow-up’s check')
    await daemon.stop()
  })
})

describe('a first look of a private channel an HTTP bot joined before anyone spoke there', () => {
  it('opens the place’s long session as the place’s own and threads the cards under its introduction', async () => {
    const { daemon, d, behavior, registered, dispatched, posts, cards, settled, deps } = await boot({
      seeded: false,
      channel: { id: 'C1', name: 'release-train', is_private: true },
      teamId: 'T0EXAMPLE'
    })
    // The relay routes an HTTP bot, so the daemon holds it as a shared integration with no rules of its own.
    const core = d.agents.get('bot-a').integrations[0].core
    core.mode = 'shared'
    core.bindRules = []
    const scope: string = d.transportScopeForIntegrationIds(['int-bot-a'])
    behavior.round = async (ctx, say) => {
      say(INTRO)
      await executeTool(ctx, 'propose', TASK, deps)
    }
    const joined = await d.handleRelaySlackAction({
      agentId: 'bot-a',
      integrationId: 'int-bot-a',
      sessionKey: 'slack:C1',
      msgId: 'm-join',
      botId: 'bot-1',
      userId: 'U0OWNER',
      payload: { kind: 'bot-joined', channelId: 'C1', inviter: 'U0OWNER' }
    })
    expect(joined).toEqual({ msgId: 'm-join', accepted: true })
    const place = { platform: 'slack', channel: 'C1', transportScope: scope }
    await vi.waitFor(
      async () => expect(await d.store.assistantItems.latestFirstLook('bot-a', place)).toBeDefined(),
      WAIT
    )
    expect(await d.store.placeSession('bot-a', 'slack', 'C1', scope)).toBeUndefined()
    await d.followUpChecks.sweep()
    await vi.waitFor(() => expect(dispatched.some((c) => c.msg.parentReport === true)).toBe(true), WAIT)
    await settled()

    // The introduction posts at the top level, and its card in its thread, not in anyone's direct message.
    const intro = posts.find((p) => p.text.includes('Hi, I am bot-a'))!
    expect(intro.thread).toBeUndefined()
    expect(cards().map((p) => [p.channel, p.thread])).toEqual([['C1', intro.ts]])

    // The report opened the place's long session as its root, bound to the channel's people as a person's message would.
    const opened = await d.store.placeSession('bot-a', 'slack', 'C1', scope)
    const key = opened.key
    expect(isAppendCoordinate(opened.thread)).toBe(true)
    expect(opened.originSessionId ?? null).toBeNull()
    expect(await d.store.getSessionClassificationByKey(key)).toMatchObject({
      conversationKind: 'channel',
      sourceBindingKind: 'external',
      externalProvider: 'slack',
      externalRealmKey: 'T0EXAMPLE',
      externalResourceKey: 'C1',
      externalIntegrationId: 'int-bot-a'
    })
    expect(await d.store.isCaptureExcluded('bot-a', key)).toBe(false)
    // The first look stays the long session's child, so the two never name each other.
    const lookCtx = registered.find((c) => isFirstLookCoordinate(c.thread))!
    const look = await d.store.getSession(sessionKey('slack', 'C1', lookCtx.thread, 'bot-a', scope))
    expect(look.originSessionId).toBe(opened.sessionId)
    // A private channel writes its own layer, so nothing of it is merged into the organization's shared file.
    const report = dispatched.find((c) => c.msg.parentReport === true)!
    expect(report.msg.turnBody?.prompt ?? report.msg.text ?? '').not.toContain('organization.md')
    await daemon.stop()
  })
})
