// The draft flow (assistant-mode.md §5.5, §5.10): who approves, what an approval posts, and what never posts.
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentApprovalRoute, AssistantModePolicy } from '@agentconnect.md/protocol'
import {
  AssistantDrafts,
  type DraftAsker,
  type DraftCard,
  type DraftCardPort,
  type InterceptedPost
} from '../src/assistant/drafts.js'
import type { MessageGateway } from '../src/mcp/ops/context.js'
import { settlePost } from '../src/mcp/ops/messaging.js'
import { buildAssistantDraftCard, type AssistantDraftCardView } from '../src/slack/render.js'
import {
  ASSISTANT_DRAFT_TTL_MS,
  type AssistantDraft,
  type AssistantDraftSource,
  type AssistantDraftTarget
} from '../src/store/assistant-drafts.js'
import { LocalStore } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'

const AGENT = 'agent-a'
const INT = '33333333-3333-4333-8333-333333333333'
const RESPONSIBLE = 'usr-responsible'
const HERE: AssistantDraftSource = {
  platform: 'slack',
  integrationId: INT,
  channel: 'D0ALICE',
  thread: 'append:dm',
  transportScope: 'T0EXAMPLE',
  sessionKey: 'key-dm',
  sessionId: 'outward-dm',
  place: true
}
/** A cron run with no conversation of its own. */
const PLACELESS: AssistantDraftSource = { ...HERE, integrationId: null, channel: 'cron-1', place: false }
const TO_SUPPORT: InterceptedPost = {
  platform: 'slack',
  integrationId: INT,
  channel: 'C0SUPPORT',
  text: 'The release is out.',
  directMessage: false
}
const ALICE = { integrationId: INT, userId: 'U0ALICE', trusted: true }

let store: LocalStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

function fakePort() {
  let n = 0
  return {
    openDirectMessage: vi.fn(async (user: string) => `D_${user}`),
    isFullMember: vi.fn(async (_user: string) => false),
    scope: () => 'T0EXAMPLE',
    postCard: vi.fn(async (_channel: string, _card: DraftCard) => `card-${++n}`),
    updateCard: vi.fn(async (_channel: string, _ts: string, _card: DraftCard) => {})
  } satisfies DraftCardPort
}

async function world(
  over: {
    policy?: Partial<AssistantModePolicy>
    enabled?: string[]
    external?: string[]
    post?: MessageGateway['postMessage']
    route?: (req: Omit<AgentApprovalRoute, 'agentId'>) => Promise<unknown>
  } = {}
) {
  store = await LocalStore.open({ database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')) })
  const s = store
  const port = fakePort()
  const gateway = { postMessage: vi.fn(over.post ?? (async () => '1700000000.000200')) }
  let now = 10_000
  const enabled = new Set(over.enabled ?? ['D0ALICE', 'C0SUPPORT', 'C0SHARED', 'D0BOB'])
  const external = new Set(over.external ?? ['C0SHARED'])
  const route = vi.fn(
    over.route ??
      (async (req: Omit<AgentApprovalRoute, 'agentId'>) =>
        req.verify
          ? { requestId: req.requestId, allowed: req.verify.userId === 'U0RESP' }
          : req.consoleUserId === RESPONSIBLE
            ? {
                requestId: req.requestId,
                target: { integrationId: INT, teamId: 'T0EXAMPLE', userId: 'U0RESP', consoleUserId: RESPONSIBLE }
              }
            : { requestId: req.requestId })
  )
  const policy: AssistantModePolicy = { enabled: true, responsibleUserId: RESPONSIBLE, ...over.policy }
  const describeDestination = vi.fn(async (target: AssistantDraftTarget, opts: { dm: boolean; recipient?: string }) =>
    opts.dm
      ? { userId: opts.recipient ?? null, name: 'Bob Example' }
      : {
          name: target.channel === 'C0SUPPORT' ? 'support' : 'shared',
          ...(target.thread ? { threadLink: `https://example.slack.test/archives/${target.channel}` } : {})
        }
  )
  const afterPost = vi.fn(async (_draft: AssistantDraft, _messageId: string) => {})
  const drafts = new AssistantDrafts({
    ledger: () => s.assistantDrafts,
    now: () => now,
    log: { info: vi.fn(), warn: vi.fn() },
    agent: () => ({ name: 'Butler', assistantMode: policy, integrations: [{ id: INT }] }),
    gatewayFor: (id) => (id === INT ? (gateway as unknown as MessageGateway) : undefined),
    placeEnabled: (_agent, id, channel) => id === INT && enabled.has(channel),
    placeExternal: (_agent, _id, channel) => external.has(channel),
    cardPortFor: (id) => (id === INT ? port : undefined),
    approvalRoute: async (_agent, req) => (await route(req)) as never,
    sessionLink: (id) => `https://console.example.test/sessions/${id}`,
    platformName: () => 'Slack',
    describeDestination,
    afterPost
  })
  const click = (requestId: string, optionId: string, userId = 'U0ALICE') =>
    drafts.handleChoice({ requestId, optionId, actor: { userId, name: userId.toLowerCase() } })
  const only = async () => {
    const rows = (await s.assistantDrafts['db'].query('SELECT id FROM assistant_draft', [])).rows as { id: string }[]
    expect(rows).toHaveLength(1)
    return (await s.assistantDrafts.get(rows[0]!.id))!
  }
  return {
    store: s,
    drafts,
    port,
    gateway,
    route,
    click,
    only,
    advance: (ms: number) => (now += ms),
    enabled,
    describeDestination,
    afterPost,
    /** Switch assistant mode as the daemon does: the live policy, then a new grant generation. */
    switchMode: async (on: boolean) => {
      policy.enabled = on
      await s.assistantDrafts.resetGrants(AGENT)
    },
    // `null` stands for no asker: an explicit undefined would take the default.
    post: (post: InterceptedPost = TO_SUPPORT, source: AssistantDraftSource = HERE, asker: DraftAsker | null = ALICE) =>
      drafts.interceptPost(AGENT, source, post, asker ?? undefined)
  }
}

describe('a post to another place', () => {
  it('is drafted to the asker in a DM, showing the target and the exact text, and nothing is posted', async () => {
    const w = await world()
    const result = await w.post()
    expect(result).toMatchObject({
      handled: true,
      result: { drafted: true, approver: 'the person who asked, in a direct message' }
    })
    expect(w.gateway.postMessage).not.toHaveBeenCalled()
    expect(w.port.openDirectMessage).toHaveBeenCalledWith('U0ALICE')
    const [channel, card] = w.port.postCard.mock.calls[0]!
    expect(channel).toBe('D_U0ALICE')
    expect(card).toMatchObject({
      agentId: AGENT,
      sessionKey: 'key-dm',
      offerAlways: true,
      view: {
        agentName: 'Butler',
        kind: 'elsewhere',
        target: { platform: 'slack', channel: 'C0SUPPORT', isDm: false, external: false },
        text: 'The release is out.',
        sessionUrl: 'https://console.example.test/sessions/outward-dm'
      }
    })
    expect(await w.only()).toMatchObject({ status: 'awaiting_review', cardTs: 'card-1' })
  })

  it('stays refused when this agent is not enabled at the target', async () => {
    const w = await world()
    await expect(w.post({ ...TO_SUPPORT, channel: 'C0RANDOM' })).rejects.toThrow(/not enabled in that conversation/)
    expect(w.port.postCard).not.toHaveBeenCalled()
    expect(w.gateway.postMessage).not.toHaveBeenCalled()
  })

  it('posts the text unchanged, once, on approval', async () => {
    const w = await world()
    const thread = { ...TO_SUPPORT, thread: '1700000000.000100' }
    await w.post(thread)
    const draft = await w.only()
    expect(await w.click(draft.id, 'approve')).toBe(true)
    expect(w.gateway.postMessage).toHaveBeenCalledTimes(1)
    expect(w.gateway.postMessage).toHaveBeenCalledWith(
      'C0SUPPORT',
      'The release is out.',
      '1700000000.000100',
      expect.objectContaining({ username: 'Butler', agentAuthorId: AGENT })
    )
    expect(await w.only()).toMatchObject({
      status: 'succeeded',
      messageId: '1700000000.000200',
      decidedBy: 'T0EXAMPLE:U0ALICE'
    })
    expect(w.port.updateCard.mock.calls.at(-1)![2]).toMatchObject({ outcome: expect.stringContaining('Posted') })
    await w.click(draft.id, 'approve')
    await w.click(draft.id, 'discard')
    expect(w.gateway.postMessage).toHaveBeenCalledTimes(1)
  })

  it('never posts a discarded or an expired draft', async () => {
    const w = await world()
    await w.post()
    const discarded = await w.only()
    await w.click(discarded.id, 'discard')
    await w.click(discarded.id, 'approve')
    expect((await w.store.assistantDrafts.get(discarded.id))?.status).toBe('denied')
    expect(w.port.updateCard.mock.calls.at(-1)![2]).toMatchObject({ outcome: expect.stringContaining('Discarded') })

    await w.store.assistantDrafts.deleteForAgent(AGENT)
    await w.post()
    const late = await w.only()
    w.advance(ASSISTANT_DRAFT_TTL_MS)
    await w.click(late.id, 'approve')
    expect((await w.store.assistantDrafts.get(late.id))?.status).toBe('expired')
    expect(w.port.updateCard.mock.calls.at(-1)![2]).toMatchObject({ outcome: expect.stringContaining('Expired') })
    expect(w.gateway.postMessage).not.toHaveBeenCalled()
  })

  it('expires due drafts on the sweep and retires their cards', async () => {
    const w = await world()
    await w.post()
    w.advance(ASSISTANT_DRAFT_TTL_MS)
    await w.drafts.sweep([AGENT])
    expect((await w.only()).status).toBe('expired')
    expect(w.port.updateCard).toHaveBeenCalledWith(
      'D_U0ALICE',
      'card-1',
      expect.objectContaining({ outcome: expect.any(String) })
    )
  })

  it.each([
    ['returns no message id', async () => undefined],
    [
      'throws',
      async () => {
        throw new Error('socket hang up')
      }
    ]
  ])('records an uncertain outcome when the platform %s, and never retries it', async (_label, post) => {
    const w = await world({ post: post as MessageGateway['postMessage'] })
    await w.post()
    const draft = await w.only()
    await w.click(draft.id, 'approve')
    expect((await w.only()).status).toBe('outcome_unknown')
    expect(w.port.updateCard.mock.calls.at(-1)![2]).toMatchObject({
      outcome: expect.stringContaining('Not sure this went through')
    })
    await w.click(draft.id, 'approve')
    expect(w.gateway.postMessage).toHaveBeenCalledTimes(1)
  })

  it('fails without posting when the target is no longer enabled', async () => {
    const w = await world()
    await w.post()
    const draft = await w.only()
    w.enabled.delete('C0SUPPORT')
    await w.click(draft.id, 'approve')
    expect(await w.only()).toMatchObject({ status: 'failed', failure: expect.stringMatching(/no longer enabled/) })
    expect(w.gateway.postMessage).not.toHaveBeenCalled()
  })

  it('ignores a click from anyone the card was not addressed to', async () => {
    const w = await world()
    await w.post()
    const draft = await w.only()
    expect(await w.click(draft.id, 'approve', 'U0MALLORY')).toBe(true)
    expect((await w.only()).status).toBe('awaiting_review')
    expect(w.gateway.postMessage).not.toHaveBeenCalled()
  })

  it('leaves a click on any other card to the permission path', async () => {
    const w = await world()
    expect(await w.drafts.handleChoice({ requestId: 'perm-1', optionId: 'allow_once' })).toBe(false)
    expect(await w.drafts.handleChoice({ requestId: 'perm-1', optionId: 'approve' })).toBe(false)
  })
})

describe('the approver', () => {
  it('is the responsible user when the asker is not an internal member, re-verified on the click', async () => {
    const w = await world()
    await w.post(TO_SUPPORT, HERE, { integrationId: INT, userId: 'U0GUEST', trusted: false })
    expect(w.port.isFullMember).toHaveBeenCalledWith('U0GUEST')
    expect(w.route).toHaveBeenCalledWith(expect.objectContaining({ consoleUserId: RESPONSIBLE, integrationIds: [INT] }))
    expect(w.port.postCard.mock.calls[0]![0]).toBe('D_U0RESP')
    const draft = await w.only()
    expect(draft.approver).toMatchObject({ kind: 'member', userId: 'U0RESP', consoleUserId: RESPONSIBLE })
    await w.click(draft.id, 'approve', 'U0GUEST')
    expect(w.gateway.postMessage).not.toHaveBeenCalled()
    await w.click(draft.id, 'approve', 'U0RESP')
    expect(w.route).toHaveBeenLastCalledWith(
      expect.objectContaining({ verify: expect.objectContaining({ userId: 'U0RESP', consoleUserId: RESPONSIBLE }) })
    )
    expect(w.gateway.postMessage).toHaveBeenCalledTimes(1)
  })

  it('is the asker in an external place when the platform says they are a full member', async () => {
    const w = await world()
    w.port.isFullMember.mockResolvedValue(true)
    await w.post(TO_SUPPORT, HERE, { integrationId: INT, userId: 'U0ALICE', trusted: false })
    expect(w.port.postCard.mock.calls[0]![0]).toBe('D_U0ALICE')
  })

  it('refuses the click when the control plane no longer verifies the routed member', async () => {
    const w = await world({
      route: async (req) =>
        req.verify
          ? { requestId: req.requestId, allowed: false }
          : {
              requestId: req.requestId,
              target: { integrationId: INT, teamId: 'T0EXAMPLE', userId: 'U0RESP', consoleUserId: RESPONSIBLE }
            }
    })
    await w.post(TO_SUPPORT, PLACELESS, null)
    const draft = await w.only()
    await w.click(draft.id, 'approve', 'U0RESP')
    expect((await w.only()).status).toBe('awaiting_review')
    expect(w.gateway.postMessage).not.toHaveBeenCalled()
  })

  it('ignores a control plane that answers with someone other than the named user', async () => {
    const w = await world({
      policy: { fallbackConversation: { integrationId: INT, channelId: 'C0APPROVALS' } },
      route: async (req) => ({
        requestId: req.requestId,
        target: { integrationId: INT, teamId: 'T0EXAMPLE', userId: 'U0CREATOR', consoleUserId: 'usr-creator' }
      })
    })
    await w.post(TO_SUPPORT, PLACELESS, null)
    expect(w.port.postCard.mock.calls[0]![0]).toBe('C0APPROVALS')
    const draft = await w.only()
    expect(draft.approver).toMatchObject({ kind: 'conversation', channel: 'C0APPROVALS', userId: null })
    // Anyone in the fallback conversation may decide.
    await w.click(draft.id, 'approve', 'U0ANYONE')
    expect(w.gateway.postMessage).toHaveBeenCalledTimes(1)
  })

  it('is nobody when nothing can be reached: the draft waits, and the model is told nothing was sent', async () => {
    const w = await world({ route: async (req) => ({ requestId: req.requestId }) })
    const result = await w.post(TO_SUPPORT, PLACELESS, null)
    expect(result).toMatchObject({ handled: true, result: { drafted: true, approver: null } })
    expect(w.port.postCard).not.toHaveBeenCalled()
    expect((await w.only()).approver).toBeNull()
  })
})

describe('"always allow from here to there"', () => {
  it('lets a later post from here to there go out without a card, and nothing else', async () => {
    const w = await world()
    await w.post()
    await w.click((await w.only()).id, 'always')
    expect(w.gateway.postMessage).toHaveBeenCalledTimes(1)
    expect(w.port.updateCard.mock.calls.at(-1)![2]).toMatchObject({
      outcome: expect.stringContaining('without asking')
    })
    expect(await w.post()).toEqual({ handled: false })
    expect(w.port.postCard).toHaveBeenCalledTimes(1)

    // Another source place, or another target, still asks.
    const fromBob = await w.post(TO_SUPPORT, { ...HERE, channel: 'D0BOB', sessionKey: 'key-bob' })
    expect(fromBob).toMatchObject({ handled: true })
    const elsewhere = await w.post({ ...TO_SUPPORT, channel: 'D0BOB', directMessage: true })
    expect(elsewhere).toMatchObject({ handled: true })

    // Switching assistant mode off ends the grant.
    await w.switchMode(false)
    await w.switchMode(true)
    expect(await w.post()).toMatchObject({ handled: true })
  })

  it('is never offered, nor honored, for an external target or a placeless session', async () => {
    const w = await world()
    await w.post({ ...TO_SUPPORT, channel: 'C0SHARED' })
    expect(w.port.postCard.mock.calls[0]![1]).toMatchObject({
      offerAlways: false,
      view: { target: { external: true } }
    })
    const external = (await w.store.assistantDrafts['db'].query('SELECT id FROM assistant_draft', [])).rows[0] as {
      id: string
    }
    await w.click(external.id, 'always')
    expect(await w.store.assistantDrafts.granted(AGENT, HERE, { ...HERE, channel: 'C0SHARED' })).toBe(false)

    await w.post(TO_SUPPORT, PLACELESS, ALICE)
    expect(w.port.postCard.mock.calls[1]![1]).toMatchObject({ offerAlways: false })
  })
})

describe('"always allow" across a mode switch', () => {
  it('grants nothing from a card offered before assistant mode was switched off, even once it is on again', async () => {
    const w = await world()
    await w.post()
    const old = await w.only()
    await w.switchMode(false)
    await w.click(old.id, 'always')
    // The click still approves this one post, but it grants nothing and says nothing about a grant.
    expect(w.gateway.postMessage).toHaveBeenCalledTimes(1)
    expect(await w.store.assistantDrafts.granted(AGENT, HERE, { ...HERE, channel: 'C0SUPPORT' })).toBe(false)
    expect(w.port.updateCard.mock.calls.at(-1)![2]).toMatchObject({
      outcome: expect.not.stringContaining('without asking')
    })
    await w.switchMode(true)
    expect(await w.post()).toMatchObject({ handled: true })
  })

  it('grants nothing when a switch lands between the card and the click, whatever the live view still says', async () => {
    const w = await world()
    await w.post()
    const card = await w.only()
    // The store moved to a new generation while this daemon still sees the mode on: the race a disable can win.
    await w.store.assistantDrafts.resetGrants(AGENT)
    await w.click(card.id, 'always')
    expect(w.gateway.postMessage).toHaveBeenCalledTimes(1)
    expect(await w.post()).toMatchObject({ handled: true })
  })

  it('grants from a card of the current generation', async () => {
    const w = await world()
    await w.switchMode(false)
    await w.switchMode(true)
    await w.post()
    await w.click((await w.only()).id, 'always')
    expect(await w.post()).toEqual({ handled: false })
  })
})

describe('the card names the actual destination', () => {
  it('carries the conversation name and the thread link for a thread post', async () => {
    const w = await world()
    await w.post({ ...TO_SUPPORT, thread: '1700000000.000100' })
    expect(w.describeDestination).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C0SUPPORT' }), { dm: false })
    expect(w.port.postCard.mock.calls[0]![1]).toMatchObject({
      view: {
        target: {
          channel: 'C0SUPPORT',
          name: 'support',
          thread: '1700000000.000100',
          threadLink: 'https://example.slack.test/archives/C0SUPPORT'
        }
      }
    })
    expect((await w.only()).destination).toEqual({
      name: 'support',
      userId: null,
      threadLink: 'https://example.slack.test/archives/C0SUPPORT'
    })
  })

  it('carries the recipient of a direct message', async () => {
    const w = await world()
    await w.post({ ...TO_SUPPORT, channel: 'D0BOB', directMessage: true, recipient: 'U0BOB' })
    expect(w.describeDestination).toHaveBeenCalledWith(expect.objectContaining({ channel: 'D0BOB' }), {
      dm: true,
      recipient: 'U0BOB'
    })
    expect(w.port.postCard.mock.calls[0]![1]).toMatchObject({
      view: { target: { isDm: true, userId: 'U0BOB', name: 'Bob Example' } }
    })
  })
})

describe('after an approved post', () => {
  it('runs the sent-message bookkeeping once, with the draft and the posted id', async () => {
    const w = await world()
    await w.post()
    const draft = await w.only()
    await w.click(draft.id, 'approve')
    expect(w.afterPost).toHaveBeenCalledTimes(1)
    expect(w.afterPost).toHaveBeenCalledWith(
      expect.objectContaining({ id: draft.id, source: expect.objectContaining({ thread: 'append:dm' }) }),
      '1700000000.000200'
    )
  })

  it('never runs it for an uncertain or a failed post, and a failure in it never re-posts', async () => {
    const unsure = await world({ post: async () => undefined })
    await unsure.post()
    await unsure.click((await unsure.only()).id, 'approve')
    expect(unsure.afterPost).not.toHaveBeenCalled()

    const w = await world()
    w.afterPost.mockRejectedValueOnce(new Error('store down'))
    await w.post()
    const draft = await w.only()
    await w.click(draft.id, 'approve')
    await w.click(draft.id, 'approve')
    expect(w.gateway.postMessage).toHaveBeenCalledTimes(1)
    expect((await w.only()).status).toBe('succeeded')
  })
})

describe('an external place reply', () => {
  it('drafts the reply for the same thread, never offering "always allow"', async () => {
    const w = await world()
    w.port.isFullMember.mockResolvedValue(true)
    const draft = await w.drafts.draftReply({
      agentId: AGENT,
      target: { platform: 'slack', integrationId: INT, channel: 'C0SHARED', thread: '1700000000.000100' },
      targetDm: false,
      text: 'Here is the answer.',
      source: { ...HERE, channel: 'C0SHARED', sessionKey: 'key-shared' },
      asker: { integrationId: INT, userId: 'U0ALICE', trusted: false }
    })
    expect(draft).toMatchObject({ kind: 'reply', targetExternal: true, offerAlways: false, status: 'awaiting_review' })
    expect(w.port.postCard.mock.calls[0]![1]).toMatchObject({ view: { kind: 'reply' }, offerAlways: false })
    await w.click(draft.id, 'approve')
    expect(w.gateway.postMessage).toHaveBeenCalledWith(
      'C0SHARED',
      'Here is the answer.',
      '1700000000.000100',
      expect.any(Object)
    )
  })
})

describe('recovery', () => {
  it('turns an execution a restart cut short into outcome_unknown and says so on the card', async () => {
    const w = await world()
    await w.post()
    const draft = await w.only()
    await w.store.assistantDrafts.begin(draft.id, { id: null, name: null }, 11_000)
    await w.drafts.recover([AGENT])
    expect((await w.only()).status).toBe('outcome_unknown')
    expect(w.port.updateCard.mock.calls.at(-1)![2]).toMatchObject({
      outcome: expect.stringContaining('Not sure this went through')
    })
    await w.click(draft.id, 'approve')
    expect(w.gateway.postMessage).not.toHaveBeenCalled()
  })
})

describe('the sent-message bookkeeping an approved draft shares with sendMessage', () => {
  const origin = {
    agentId: AGENT,
    platform: 'slack',
    channel: 'D0ALICE',
    thread: 'append:dm',
    transportScope: 'T0EXAMPLE',
    deliveryThread: '1.1'
  }

  it("materializes a platform's required root thread and seeds the author's session under the origin", async () => {
    const recordOutbound = vi.fn(async () => {})
    const spawnChannelRootSession = vi.fn(async () => true)
    const createThread = vi.fn(async () => '900')
    const gw = { getChannelInfo: vi.fn(async (id: string) => ({ id })), createThread } as unknown as MessageGateway
    const settled = await settlePost(origin, { recordOutbound, spawnChannelRootSession }, gw, {
      platform: 'discord',
      integrationId: 'int-dc',
      channel: 'C42',
      body: 'hello there',
      providerPostId: '900',
      ts: '900',
      directMessage: false,
      seed: true
    })
    expect(settled).toEqual({ postedThread: '900', seeded: true })
    expect(createThread).toHaveBeenCalledWith('C42', '900', 'hello there')
    expect(recordOutbound).toHaveBeenCalledWith(origin, 'C42', '900', 'hello there', '900', 'int-dc')
    expect(spawnChannelRootSession).toHaveBeenCalledWith(
      expect.objectContaining({
        thread: '900',
        originPlatform: 'slack',
        originTransportScope: 'T0EXAMPLE',
        originChannel: 'D0ALICE',
        originThread: 'append:dm'
      })
    )
  })

  it('records a reply in its thread without seeding, the conversation already holding its session', async () => {
    const recordOutbound = vi.fn(async () => {})
    const spawnChannelRootSession = vi.fn(async () => true)
    const gw = { getChannelInfo: vi.fn() } as unknown as MessageGateway
    const settled = await settlePost(origin, { recordOutbound, spawnChannelRootSession }, gw, {
      platform: 'slack',
      integrationId: INT,
      channel: 'C0SHARED',
      updateThread: '1700000000.000100',
      body: 'the answer',
      providerPostId: '1700000000.000300',
      ts: '1700000000.000300',
      directMessage: false,
      seed: false
    })
    expect(settled).toEqual({ postedThread: '1700000000.000100', seeded: false })
    expect(recordOutbound).toHaveBeenCalledWith(
      origin,
      'C0SHARED',
      '1700000000.000100',
      'the answer',
      '1700000000.000300',
      INT
    )
    expect(spawnChannelRootSession).not.toHaveBeenCalled()
  })
})

describe('the Slack draft card', () => {
  const view = (target: Partial<AssistantDraftCardView['target']>, platformName = 'Slack'): AssistantDraftCardView => ({
    agentName: 'Butler',
    kind: 'elsewhere',
    target: { platform: 'slack', channel: 'C0SUPPORT', isDm: false, external: false, ...target },
    platformName,
    text: 'The release is out.'
  })
  const text = (v: AssistantDraftCardView): string =>
    JSON.stringify(buildAssistantDraftCard('d-1', v, { offerAlways: true }))

  it('names a channel by name and id, and a thread by its link', () => {
    const card = text(
      view({
        name: 'support',
        thread: '1700000000.000100',
        threadLink: 'https://example.slack.test/archives/C0SUPPORT'
      })
    )
    expect(card).toContain('<#C0SUPPORT> (#support)')
    expect(card).toContain('`C0SUPPORT`')
    expect(card).toContain('<https://example.slack.test/archives/C0SUPPORT|thread 1700000000.000100>')
  })

  it('names the recipient of a direct message, and a conversation on another platform with that platform', () => {
    expect(text(view({ channel: 'D0BOB', isDm: true, userId: 'U0BOB', name: 'Bob Example' }))).toContain(
      'a direct message to <@U0BOB>'
    )
    const other = text(view({ platform: 'telegram', channel: '-1001', name: 'ops' }, 'Telegram'))
    expect(other).toContain('*ops* on Telegram')
    expect(other).toContain('Telegram `-1001`')
  })
})
