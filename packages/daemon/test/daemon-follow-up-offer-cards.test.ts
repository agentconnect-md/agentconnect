// An ordinary turn offers a follow-up as a proposal card (assistant-mode.md §5.10): held until the turn's reply posts, threaded where it replied, taken on approval.
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { buildCpClientDeps } from '../src/cp/cp-client-deps.js'
import { Daemon } from '../src/daemon.js'
import { executeTool, type SessionContext } from '../src/mcp/ops.js'
import { answerThreadOf } from '../src/auto-session/coordinator-turns.js'
import {
  PROPOSE_ARGS,
  PROPOSE_OFFER_TOOL,
  PROPOSE_OFFER_WATCH_TOOL,
  PROPOSE_PLACE_TOOL,
  PROPOSE_PLACE_WATCH_TOOL
} from '../src/mcp/ops/assistant-items.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import {
  COORDINATOR_COORDINATE_PREFIX,
  appendCoordinate,
  isAppendCoordinate
} from '../src/session/append-coordinate.js'
import { isTaskCoordinate } from '../src/session/subsession-coordinate.js'
import type { AssistantDraft } from '../src/store/assistant-drafts.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

const TEST_ORG = '00000000-0000-0000-0000-0000000000a1'
const ASK = 'Is the deploy out yet?'
const REPLY = 'Not yet: the deploy is still rolling out.'
const OFFER = {
  sentence: 'I can check the deploy again at 15:30 and tell you here.',
  why: 'It was still rolling out.',
  followUp: {
    title: 'The 2.6 deploy',
    doneWhen: 'I’ll look at 15:30 and say here whether it finished; I stop once it has.',
    nextCheck: '2099-01-01T15:30:00Z'
  }
}

function scaffold(over: { external?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-offer-cards-'))
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
            bindRules: [{ match: { kind: 'auto' }, channel: 'C1' }],
            sessionModes: [{ channel: 'C1', mode: 'append' }],
            ...(over.external ? { externalChannels: ['C1'] } : {})
          },
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
type Turn = (ctx: SessionContext, say: (text: string) => void) => Promise<void>

async function boot(over: { external?: boolean } = {}) {
  const behavior: { turn: Turn } = { turn: async () => {} }
  const registered: SessionContext[] = []
  const hostFactory = (_agent: unknown, update: (sid: string, u: unknown) => void) =>
    ({
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => `acp-${randomUUID()}`),
      permissionModeOptions: vi.fn(() => ({ current: undefined, modes: ['default', 'plan'] })),
      setSessionPermissionMode: vi.fn(async () => true),
      prompt: vi.fn(async (sessionId: string, blocks: unknown[]) => {
        if (JSON.stringify(blocks).includes(ASK)) {
          const ctx = [...registered].reverse().find((c) => isAppendCoordinate(c.thread))!
          const say = (text: string) =>
            update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
          await behavior.turn(ctx, say)
        }
        return 'end_turn'
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }) as any
  const posts: Post[] = []
  const updates: { channel: string; ts: string; text: string }[] = []
  let n = 0
  const base = fakeSlackAppFactory()
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
    return app
  }) as typeof base
  const root = scaffold(over)
  const daemon = new Daemon({ slackAppFactory, root, hostFactory: hostFactory as any })
  await daemon.start()
  const d = daemon as any
  // The harness has no real platform audience to bind a session to.
  d.bindSessionSource = async () => 'unchanged'
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
  /** A person asks at the channel's top level, and the turn it starts runs to its end. */
  const ask = async (ts = '1700000100.000100', thread?: string) => {
    await d.onInboundOutcome(
      {
        msgId: `slack:C1:${ts}`,
        traceId: `t-${ts}`,
        source: 'user',
        platform: 'slack',
        channel: 'C1',
        ts,
        sender: { id: 'U0ALICE', isBot: false },
        text: ASK,
        ...(thread ? { thread } : {}),
        mentionedBots: [],
        isDm: false
      },
      ['int-bot-a']
    )
    await vi.waitFor(() => expect(dispatched.length).toBeGreaterThan(0), WAIT)
    await settled()
  }
  const cards = () => posts.filter((p) => p.blocks !== undefined && JSON.stringify(p.blocks).includes('ac_perm'))
  const reply = () => posts.find((p) => p.text.includes(REPLY))
  const records = async (): Promise<AssistantDraft[]> =>
    await d.store.assistantDrafts.listPending('bot-a', 10, 0, { tasks: true })
  const activity = buildCpClientDeps(d.cpClientDepsHost(root, 'wss://cp.example.test', () => {})).assistantActivity!
  return {
    daemon,
    d,
    behavior,
    registered,
    dispatched,
    posts,
    updates,
    cards,
    reply,
    records,
    settled,
    deps,
    ask,
    activity
  }
}

/** A turn that answers and offers a follow-up, recording what each call gave back. */
const offering =
  (deps: unknown, results: unknown[], opts: { twice?: boolean; silent?: boolean } = {}): Turn =>
  async (ctx, say) => {
    results.push(await executeTool(ctx, 'propose', OFFER, deps as never))
    if (opts.twice) results.push(await executeTool(ctx, 'propose', OFFER, deps as never).catch((e: Error) => e.message))
    if (!opts.silent) say(REPLY)
  }

describe('an ordinary turn offers a follow-up as a card', () => {
  it('is offered propose for the follow-up form, once a turn, carded after the reply in the thread it replied in', async () => {
    const h = await boot()
    const results: unknown[] = []
    let heldDuringTurn: number | undefined
    h.behavior.turn = async (ctx, say) => {
      await offering(h.deps, results, { twice: true })(ctx, say)
      heldDuringTurn = h.cards().length
    }
    await h.ask()
    const session = h.registered.find((c) => isAppendCoordinate(c.thread))!
    expect(session.tools.find((t) => t.name === 'propose')).toBeDefined()
    expect([PROPOSE_PLACE_TOOL, PROPOSE_PLACE_WATCH_TOOL]).toContainEqual(
      session.tools.find((t) => t.name === 'propose')
    )
    expect(results[0]).toMatchObject({
      proposed: true,
      approver: 'the people in the conversation the follow-up belongs to'
    })
    expect(results[1]).toContain('a turn offers at most one follow-up')
    // Nothing is carded while the turn runs; one card follows its reply, in the thread it replied in.
    expect(heldDuringTurn).toBe(0)
    const reply = h.reply()!
    const [card] = h.cards()
    expect(h.cards()).toHaveLength(1)
    expect(card!.channel).toBe('C1')
    expect(card!.thread).toBe(reply.thread)
    expect(h.posts.indexOf(reply)).toBeLessThan(h.posts.indexOf(card!))
    expect(JSON.stringify(card!.blocks)).toContain(OFFER.followUp.doneWhen)
    // The record acts on no task, and names the conversation and the thread its reports reply in.
    const [record] = await h.records()
    expect(record).toMatchObject({
      status: 'awaiting_review',
      target: { platform: 'slack', channel: 'C1', thread: reply.thread ?? null },
      proposal: { itemId: null, held: false, followUp: { title: OFFER.followUp.title } },
      approver: { kind: 'place', channel: 'C1' },
      cardThread: reply.thread ?? ''
    })
    await h.daemon.stop()
  })

  it('in a thread, cards it in that thread, and the follow-up it takes reports there', async () => {
    const h = await boot()
    const results: { proposalId: string }[] = []
    h.behavior.turn = offering(h.deps, results)
    const thread = '1700000100.000050'
    await h.ask('1700000100.000100', thread)
    expect(h.reply()!.thread).toBe(thread)
    expect(h.cards().map((card) => card.thread)).toEqual([thread])
    expect(h.posts.indexOf(h.reply()!)).toBeLessThan(h.posts.indexOf(h.cards()[0]!))
    await h.d.drafts.handleChoice({
      requestId: results[0]!.proposalId,
      optionId: 'approve',
      actor: { userId: 'U0ADA', name: 'Ada' }
    })
    const draft = await h.d.store.assistantDrafts.get(results[0]!.proposalId)
    expect(draft).toMatchObject({ status: 'succeeded', target: { thread }, cardThread: thread })
    expect(await h.d.store.assistantWatchTasks.get('bot-a', draft.proposal.tookItemId)).toMatchObject({
      replyThread: thread,
      origin: { platform: 'slack', channel: 'C1' }
    })
    await h.daemon.stop()
  })

  it('passes through Activity naming itself, with no follow-up title', async () => {
    const h = await boot()
    h.behavior.turn = offering(h.deps, [])
    await h.ask()
    const [record] = await h.records()
    const listed = (await h.activity.read({ agentId: 'bot-a', operation: 'drafts', limit: 10, proposals: true })) as any
    expect(listed.drafts).toEqual([
      expect.objectContaining({
        id: record!.id,
        kind: 'task',
        proposal: expect.objectContaining({ sentence: OFFER.sentence, itemId: record!.id, itemTitle: null })
      })
    ])
    await h.daemon.stop()
  })

  it('takes the follow-up on approval, with the approver as its asker, reporting in the turn’s thread', async () => {
    const h = await boot()
    const results: { proposalId: string }[] = []
    h.behavior.turn = offering(h.deps, results)
    await h.ask()
    const reply = h.reply()!
    const warn = vi.spyOn(h.d.log, 'warn')
    await h.d.drafts.handleChoice({
      requestId: results[0]!.proposalId,
      optionId: 'approve',
      actor: { userId: 'U0ADA', name: 'Ada' }
    })
    const draft = await h.d.store.assistantDrafts.get(results[0]!.proposalId)
    expect(draft).toMatchObject({ status: 'succeeded', decidedByName: 'Ada' })
    const taken = await h.d.store.assistantWatchTasks.get('bot-a', draft.proposal.tookItemId)
    expect(taken).toMatchObject({
      title: OFFER.followUp.title,
      doneWhen: OFFER.followUp.doneWhen,
      status: 'active',
      nextAt: Date.parse(OFFER.followUp.nextCheck),
      background: OFFER.why,
      origin: { platform: 'slack', channel: 'C1' },
      ...(reply.thread ? { replyThread: reply.thread } : {})
    })
    expect(taken.asker).toMatch(/^slack:.+:U0ADA$/)
    // The long session lists it as its own, and nothing runs for it.
    const [session] = h.registered.filter((c) => isAppendCoordinate(c.thread))
    const listed = (await executeTool(session!, 'listTasks', {}, h.deps)) as any
    expect(JSON.stringify(listed)).toContain(OFFER.followUp.title)
    await h.settled()
    expect(h.dispatched.some((c) => isTaskCoordinate(c.msg.thread))).toBe(false)
    expect(h.updates.at(-1)?.text).toContain('The follow-up was taken')
    // No source task is looked up or observed on the way.
    expect(warn.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('assistant proposal'))).toEqual(
      []
    )
    expect(
      await h.d.drafts.decideFromConsole({
        agentId: 'bot-a',
        draftId: draft.id,
        choice: 'approve',
        decider: { userId: 'usr-1', name: 'Grace' }
      })
    ).toMatchObject({ result: 'already-decided' })
    await h.daemon.stop()
  })

  it('takes nothing once denied or expired, and the card says so', async () => {
    const h = await boot()
    const results: { proposalId: string }[] = []
    h.behavior.turn = offering(h.deps, results)
    await h.ask('1700000100.000100')
    await h.ask('1700000100.000200')
    const [denied, lapsed] = results.map((r) => r.proposalId)
    await h.d.drafts.handleChoice({ requestId: denied, optionId: 'discard', actor: { userId: 'U0ADA', name: 'Ada' } })
    expect(await h.d.store.assistantDrafts.get(denied)).toMatchObject({
      status: 'denied',
      proposal: { tookItemId: null }
    })
    expect(h.updates.at(-1)?.text).toContain('No follow-up was taken')
    await h.d.store.assistantDrafts.db.query('UPDATE assistant_draft SET expiresAt = ? WHERE id = ?', [1, lapsed])
    await h.d.drafts.sweep(['bot-a'])
    expect(await h.d.store.assistantDrafts.get(lapsed)).toMatchObject({
      status: 'expired',
      proposal: { tookItemId: null }
    })
    expect(h.updates.at(-1)?.text).toContain('Expired. No follow-up was taken')
    expect(await h.d.store.assistantWatchTasks.list('bot-a')).not.toContainEqual(
      expect.objectContaining({ title: OFFER.followUp.title })
    )
    await h.daemon.stop()
  })

  it('still cards an offer whose turn ended without a reply, where that turn would have replied', async () => {
    const h = await boot()
    h.behavior.turn = offering(h.deps, [], { silent: true })
    await h.ask()
    const [record] = await h.records()
    expect(h.reply()).toBeUndefined()
    expect(h.cards()).toHaveLength(1)
    expect(h.cards()[0]!.thread).toBe(record!.target.thread ?? undefined)
    await h.daemon.stop()
  })

  it('posts a card a cut turn left held once nothing runs that session, and only once', async () => {
    const h = await boot()
    h.behavior.turn = offering(h.deps, [])
    // A crash between the turn's end and its release leaves the card held.
    const release = h.d.releaseRoundCards.bind(h.d)
    h.d.releaseRoundCards = async () => {}
    await h.ask()
    expect(h.cards()).toEqual([])
    h.d.releaseRoundCards = release
    await h.d.releaseStrandedRounds()
    await h.d.releaseStrandedRounds()
    expect(h.cards()).toHaveLength(1)
    expect(h.cards()[0]!.thread).toBe(h.reply()!.thread)
    await h.daemon.stop()
  })
})

describe('an offer that cannot be carded is refused, and the agent asks in its reply', () => {
  const refusedWith = async (h: Awaited<ReturnType<typeof boot>>, args: unknown, before?: () => void) => {
    let refused = ''
    h.behavior.turn = async (ctx, say) => {
      before?.()
      refused = await executeTool(ctx, 'propose', args as never, h.deps).then(
        () => '',
        (e: Error) => e.message
      )
      say(REPLY)
    }
    await h.ask()
    expect(await h.records()).toEqual([])
    expect(h.cards()).toEqual([])
    return refused
  }

  it('refuses the task form, which only a getting-to-know report round may propose', async () => {
    const h = await boot()
    expect(await refusedWith(h, { sentence: OFFER.sentence, why: OFFER.why, task: 'Redeploy 2.6.' })).toContain(
      'only on the round a getting-to-know task reports back'
    )
    await h.daemon.stop()
  })

  it('refuses where the conversation has no approval cards', async () => {
    const h = await boot()
    expect(await refusedWith(h, OFFER, () => (h.d.hasCardSurface = () => false))).toContain(
      'no approval cards; ask in your reply instead'
    )
    await h.daemon.stop()
  })

  it('refuses in a conversation shared with another organization', async () => {
    const h = await boot({ external: true })
    expect(await refusedWith(h, OFFER)).toContain('not one whose people can approve a card here')
    await h.daemon.stop()
  })

  it('refuses outside a turn', async () => {
    const h = await boot()
    await h.ask()
    const session = h.registered.find((c) => isAppendCoordinate(c.thread))!
    await expect(executeTool(session, 'propose', OFFER, h.deps)).rejects.toThrow('only during a turn')
    await h.daemon.stop()
  })
})

describe('where an offer is offered', () => {
  it('gives a conversation that cannot get to know its place the follow-up form only, and a background task none', async () => {
    const h = await boot()
    const agent = h.d.agents.get('bot-a')
    const at = { platform: 'slack', channel: 'D1', integrationId: 'int-bot-a', isDm: true }
    const dm = h.d.sessionBridgeTools(agent, { ...at, thread: appendCoordinate(1) })
    expect([PROPOSE_OFFER_TOOL, PROPOSE_OFFER_WATCH_TOOL]).toContainEqual(dm.find((t: any) => t.name === 'propose'))
    const thread = h.d.sessionBridgeTools(agent, { ...at, channel: 'C1', isDm: false, thread: '1700000100.000050' })
    expect([PROPOSE_OFFER_TOOL, PROPOSE_OFFER_WATCH_TOOL]).toContainEqual(thread.find((t: any) => t.name === 'propose'))
    h.d.hasCardSurface = () => false
    expect(h.d.sessionBridgeTools(agent, { ...at, thread: appendCoordinate(1) }).map((t: any) => t.name)).not.toContain(
      'propose'
    )
    await h.daemon.stop()
  })

  it('has a coordinator name the message its offer answers, whose thread the card goes in', async () => {
    const h = await boot()
    const scope: string = h.d.transportScopeForIntegrationIds(['int-bot-a'])
    const ctx: SessionContext = {
      agentId: 'bot-a',
      platform: 'slack',
      integrationId: 'int-bot-a',
      transportScope: scope,
      isDm: false,
      channel: 'C1',
      thread: `${COORDINATOR_COORDINATE_PREFIX}1`,
      deliveryThread: '1700000100.000300',
      tools: []
    }
    const key = h.d.sessionKeyOf(ctx)
    h.d.activeTurnShare.set(key, { platform: 'slack', channel: 'C1', headless: false, synthetic: false })
    const input = PROPOSE_ARGS.parse(OFFER)
    await expect(h.d.offerFollowUp(ctx, input)).rejects.toThrow('with `messageId`')
    const asked = {
      msgId: 'slack:C1:1700000100.000300',
      traceId: 't',
      source: 'user',
      platform: 'slack',
      channel: 'C1',
      ts: '1700000100.000300',
      sender: { id: 'U0ALICE', isBot: false },
      text: ASK,
      mentionedBots: [],
      isDm: false
    } as unknown as NormalizedMessage
    await h.d.offerFollowUp({ ...ctx, forMessage: asked }, input)
    const [record] = await h.records()
    expect(record!.target.thread).toBe(answerThreadOf(asked))
    expect(record!.target.thread).toBe('1700000100.000300')
    await h.d.releaseRoundCards('bot-a', h.d.offerRounds.get(key), undefined)
    expect(h.cards().map((card) => card.thread)).toEqual(['1700000100.000300'])
    await h.daemon.stop()
  })
})
