// The draft flow (assistant-mode.md §5.5, §5.10): who approves, what an approval posts, and what never posts.
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentApprovalRoute, AssistantModePolicy } from '@agentconnect.md/protocol'
import {
  AssistantDrafts,
  type DraftAsker,
  type DraftCard,
  type DraftCardPort,
  type InterceptedPost,
  type ProposalPlace,
  type TaskStart
} from '../src/assistant/drafts.js'
import type { MessageGateway } from '../src/mcp/ops/context.js'
import { settlePost } from '../src/mcp/ops/messaging.js'
import { slackDraftCardPort } from '../src/platforms/slack/draft-card.js'
import { SlackConnection } from '../src/slack/connection.js'
import {
  buildAssistantDraftCard,
  buildAssistantDraftSettledCard,
  type AssistantDraftCardView
} from '../src/slack/render.js'
import {
  ASSISTANT_DRAFT_TTL_MS,
  type AssistantDraft,
  type AssistantDraftSource,
  type AssistantDraftTarget
} from '../src/store/assistant-drafts.js'
import { LocalStore } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

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
/** A check of an item taken in C0GENERAL. */
const CHECK: AssistantDraftSource = {
  ...HERE,
  channel: 'C0GENERAL',
  thread: 'subsession:check-1',
  sessionKey: 'key-check',
  sessionId: 'outward-check',
  place: false
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
const ALICE = { integrationId: INT, userId: 'U0ALICE' }

let store: LocalStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

function fakePort() {
  let n = 0
  return {
    openDirectMessage: vi.fn(async (user: string) => `D_${user}`),
    // Alice is a full member of the workspace; anyone else is a guest or from another organization.
    isFullMember: vi.fn(async (user: string) => user === 'U0ALICE'),
    scope: () => 'T0EXAMPLE',
    postCard: vi.fn(async (_channel: string, _card: DraftCard, _thread?: string) => `card-${++n}`),
    updateCard: vi.fn(async (_channel: string, _ts: string, _card: DraftCard): Promise<boolean | void> => {}),
    // Members whose id starts with B are bots; D0ALICE is Alice's direct message with the agent.
    isPerson: vi.fn(async (user: string) => !user.startsWith('B')),
    nameOf: vi.fn(async (user: string) => `Name of ${user}`),
    directMessageWith: vi.fn(async (channel: string) => (channel === 'D0ALICE' ? 'U0ALICE' : null))
  } satisfies DraftCardPort
}

async function world(
  over: {
    policy?: Partial<AssistantModePolicy>
    external?: string[]
    post?: MessageGateway['postMessage']
    route?: (req: Omit<AgentApprovalRoute, 'agentId'>) => Promise<unknown>
    /** Conversations where a person's own message would start a turn of the agent. */
    askable?: string[]
    /** The control plane advertises `assistant-responsible-route-v1`; true unless set. */
    routesResponsible?: boolean
    /** The card surface the drafts reach, in place of the fake port. */
    cardPort?: DraftCardPort
    /** Whether the follow-up an approved follow-up form named exists. */
    followUpTaken?: boolean
  } = {}
) {
  store = await LocalStore.open({ database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')) })
  const s = store
  const port = fakePort()
  const gateway = { postMessage: vi.fn(over.post ?? (async () => '1700000000.000200')) }
  let now = 10_000
  const external = new Set(over.external ?? ['C0SHARED'])
  const route = vi.fn(
    over.route ??
      (async (req: Omit<AgentApprovalRoute, 'agentId'>) =>
        req.verify
          ? { requestId: req.requestId, allowed: req.verify.userId === 'U0RESP' }
          : req.responsible
            ? {
                requestId: req.requestId,
                target: { integrationId: INT, teamId: 'T0EXAMPLE', userId: 'U0RESP', consoleUserId: RESPONSIBLE }
              }
            : { requestId: req.requestId })
  )
  const policy: AssistantModePolicy = { enabled: true, ...over.policy }
  const describeDestination = vi.fn(async (target: AssistantDraftTarget, opts: { dm: boolean; recipient?: string }) =>
    opts.dm
      ? { userId: opts.recipient ?? null, name: 'Bob Example' }
      : {
          name: target.channel === 'C0SUPPORT' ? 'support' : 'shared',
          ...(target.thread ? { threadLink: `https://example.slack.test/archives/${target.channel}` } : {})
        }
  )
  const afterPost = vi.fn(async (_draft: AssistantDraft, _messageId: string) => {})
  const askable = new Set(over.askable ?? ['C0GENERAL', 'D0ALICE'])
  // An approved task's start claims the record, as the daemon's does; one that lost the claim ran nothing.
  const startTask = vi.fn(
    async (draft: AssistantDraft, by: { id: string | null; name: string | null }): Promise<TaskStart> =>
      (await s.assistantDrafts.beginTask(draft.id, by, `task-${draft.id}`, now))
        ? { kind: 'started' }
        : { kind: 'lost' }
  )
  const drafts = new AssistantDrafts({
    ledger: () => s.assistantDrafts,
    now: () => now,
    log: { info: vi.fn(), warn: vi.fn() },
    agent: () => ({ name: 'Butler', assistantMode: policy, integrations: [{ id: INT }] }),
    gatewayFor: (id) => (id === INT ? (gateway as unknown as MessageGateway) : undefined),
    placeExternal: (_agent, _id, channel) => external.has(channel),
    cardPortFor: (id) => (id === INT ? (over.cardPort ?? port) : undefined),
    approvalRoute: async (_agent, req) => (await route(req)) as never,
    routesResponsible: () => over.routesResponsible ?? true,
    sessionLink: (id) => `https://console.example.test/sessions/${id}`,
    platformName: () => 'Slack',
    describeDestination,
    afterPost,
    startTask,
    observe: async () => {},
    ...(over.followUpTaken !== undefined ? { followUpTaken: async () => over.followUpTaken! } : {}),
    admitsAsker: (_agent, id, channel, isDm) => id === INT && askable.has(channel) && isDm === channel.startsWith('D')
  })
  const click = (requestId: string, optionId: string, userId = 'U0ALICE') =>
    drafts.handleChoice({ requestId, optionId, actor: { userId, name: userId.toLowerCase() } })
  // An editor in the console; the control plane has already checked they may edit the agent.
  const decide = (draftId: string, choice: 'approve' | 'discard', agentId = AGENT) =>
    drafts.decideFromConsole({ agentId, draftId, choice, decider: { userId: 'usr-editor', name: 'Grace' } })
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
    decide,
    only,
    advance: (ms: number) => (now += ms),
    askable,
    startTask,
    describeDestination,
    afterPost,
    // A check's proposal for an item taken in `place`'s conversation; `extra` holds it for a round or makes it a follow-up form.
    propose: (place?: ProposalPlace, extra: Partial<Parameters<AssistantDrafts['propose']>[0]> = {}) =>
      drafts.propose({
        agentId: AGENT,
        target: { platform: 'slack', integrationId: INT, channel: place?.channel ?? 'C0GENERAL', thread: null },
        destination: { name: 'general' },
        task: 'Rebase PR #12 onto main and push.',
        sentence: 'I want to rebase PR #12 because it conflicts with main.',
        why: 'The check found a merge conflict.',
        itemId: 'item-1',
        itemVersion: 1,
        source: CHECK,
        ...(place ? { place } : {}),
        ...extra
      }),
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

  it('is drafted, and posted once approved, whether or not the agent is enabled at the target', async () => {
    const w = await world()
    await w.post({ ...TO_SUPPORT, channel: 'C0RANDOM' })
    expect(w.port.postCard).toHaveBeenCalledTimes(1)
    await w.click((await w.only()).id, 'approve')
    expect(w.gateway.postMessage).toHaveBeenCalledWith('C0RANDOM', 'The release is out.', undefined, expect.any(Object))
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
  it('is the responsible user the control plane derives when the asker is not an internal member, re-verified on the click', async () => {
    const w = await world()
    await w.post(TO_SUPPORT, HERE, { integrationId: INT, userId: 'U0GUEST' })
    expect(w.port.isFullMember).toHaveBeenCalledWith('U0GUEST')
    expect(w.route).toHaveBeenCalledWith({ requestId: expect.any(String), integrationIds: [INT], responsible: true })
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
    await w.post(TO_SUPPORT, HERE, { integrationId: INT, userId: 'U0ALICE' })
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

  it('ignores a control plane that answers a console asker with someone else, and asks for the responsible user', async () => {
    const w = await world({
      route: async (req) => ({
        requestId: req.requestId,
        target: { integrationId: INT, teamId: 'T0EXAMPLE', userId: 'U0CREATOR', consoleUserId: 'usr-creator' }
      })
    })
    expect(await w.post(TO_SUPPORT, HERE, { consoleUserId: 'usr-web' })).toMatchObject({
      result: { approver: "the agent's responsible user, in a direct message" }
    })
    expect(w.route.mock.calls.map(([req]) => req.consoleUserId ?? req.responsible)).toEqual(['usr-web', true])
    expect((await w.only()).approver).toMatchObject({
      kind: 'member',
      userId: 'U0CREATOR',
      consoleUserId: 'usr-creator'
    })
  })

  it('never uses a stored fallback conversation: with no one reachable the draft waits for an editor in Activity', async () => {
    const legacy = { fallbackConversation: { integrationId: INT, channelId: 'C0APPROVALS' } }
    const w = await world({
      policy: legacy as Partial<AssistantModePolicy>,
      route: async (req) => ({ requestId: req.requestId })
    })
    expect(await w.post(TO_SUPPORT, PLACELESS, null)).toMatchObject({ result: { drafted: true, approver: null } })
    expect(w.port.postCard).not.toHaveBeenCalled()
    const draft = await w.only()
    expect(draft.approver).toBeNull()
    // No card answers it; an editor decides it from Activity.
    expect(await w.click(draft.id, 'approve', 'U0ANYONE')).toBe(true)
    expect(w.gateway.postMessage).not.toHaveBeenCalled()
    expect(await w.decide(draft.id, 'approve')).toMatchObject({ result: 'decided', status: 'succeeded' })
    expect(w.gateway.postMessage).toHaveBeenCalledWith(
      'C0SUPPORT',
      'The release is out.',
      undefined,
      expect.any(Object)
    )
  })

  it.each([
    ['in assistant mode', { enabled: true }],
    ['outside assistant mode', { enabled: false }]
  ])('cards an external sub-session request %s to the responsible user too', async (_mode, policy) => {
    const w = await world({ policy })
    const requestId = '55555555-5555-4555-8555-555555555555'
    expect(await w.drafts.cardApprover(AGENT, requestId)).toEqual({
      channel: 'D_U0RESP',
      target: { integrationId: INT, teamId: 'T0EXAMPLE', userId: 'U0RESP', consoleUserId: RESPONSIBLE }
    })
    expect(w.route).toHaveBeenCalledWith({ requestId, integrationIds: [INT], responsible: true })
  })

  it('names no card for an external sub-session request when no one is reachable, never a stored fallback conversation', async () => {
    const legacy = { fallbackConversation: { integrationId: INT, channelId: 'C0APPROVALS' } }
    const w = await world({
      policy: legacy as Partial<AssistantModePolicy>,
      route: async (req) => ({ requestId: req.requestId })
    })
    expect(await w.drafts.cardApprover(AGENT, '66666666-6666-4666-8666-666666666666')).toBeUndefined()
  })

  it('outside assistant mode, is the asker only when a full member, and the post is refused otherwise', async () => {
    const w = await world({ policy: { enabled: false } })
    w.port.isFullMember.mockImplementation(async (user: string) => user === 'U0ALICE')
    const toShared = { ...TO_SUPPORT, channel: 'C0SHARED' }
    expect(await w.post(toShared, HERE, { integrationId: INT, userId: 'U0ALICE' })).toMatchObject({
      handled: true,
      result: { drafted: true, approver: 'the person who asked, in a direct message' }
    })
    expect(w.port.postCard.mock.calls[0]![0]).toBe('D_U0ALICE')
    expect((await w.only()).approver).toMatchObject({ kind: 'member', userId: 'U0ALICE' })
    // No responsible user stands in: a guest's or a run's post is refused, and no record kept.
    for (const asker of [{ integrationId: INT, userId: 'U0GUEST' }, null]) {
      await expect(w.post(toShared, asker ? HERE : PLACELESS, asker)).rejects.toThrow(
        /needs the approval of an internal member/
      )
    }
    expect(w.route).not.toHaveBeenCalledWith(expect.objectContaining({ responsible: true }))
    expect(w.port.postCard).toHaveBeenCalledTimes(1)
    await w.click((await w.only()).id, 'approve')
    expect(w.gateway.postMessage).toHaveBeenCalledWith('C0SHARED', 'The release is out.', undefined, expect.any(Object))
  })

  // A guest already in a channel when the bot arrived is never detected, so their place is not known external.
  for (const enabled of [true, false]) {
    const mode = enabled ? 'in assistant mode' : 'outside assistant mode'
    const GUEST = { integrationId: INT, userId: 'U0GUEST' }
    /** What a post comes to when the asker is not taken as internal: the responsible user, or a refusal. */
    const notTheAsker = async (w: Awaited<ReturnType<typeof world>>, asker: DraftAsker) => {
      if (enabled) {
        expect(await w.post(TO_SUPPORT, HERE, asker)).toMatchObject({
          result: { approver: "the agent's responsible user, in a direct message" }
        })
        expect(w.port.postCard.mock.calls.map(([channel]) => channel)).toEqual(['D_U0RESP'])
      } else {
        await expect(w.post(TO_SUPPORT, HERE, asker)).rejects.toThrow(/needs the approval of an internal member/)
        expect(w.port.postCard).not.toHaveBeenCalled()
      }
      expect(w.port.openDirectMessage).not.toHaveBeenCalledWith(asker.userId)
    }

    it(`asks the platform about every asker, so a guest is never the approver (${mode})`, async () => {
      const w = await world({ policy: { enabled } })
      await notTheAsker(w, GUEST)
      expect(w.port.isFullMember.mock.calls).toEqual([['U0GUEST']])
    })

    it(`takes a full member who asked as the approver, one lookup a draft (${mode})`, async () => {
      const w = await world({ policy: { enabled } })
      for (let i = 0; i < 2; i++) {
        expect(await w.post(TO_SUPPORT, HERE, ALICE)).toMatchObject({
          result: { approver: 'the person who asked, in a direct message' }
        })
      }
      expect(w.port.postCard.mock.calls.map(([channel]) => channel)).toEqual(['D_U0ALICE', 'D_U0ALICE'])
      expect(w.port.isFullMember.mock.calls).toEqual([['U0ALICE'], ['U0ALICE']])
    })

    it(`takes no one as internal when the membership lookup fails (${mode})`, async () => {
      const w = await world({ policy: { enabled } })
      w.port.isFullMember.mockRejectedValue(new Error('ratelimited'))
      await notTheAsker(w, ALICE)
    })

    it(`never takes an asker whose platform has no card surface to say they are a full member (${mode})`, async () => {
      const w = await world({ policy: { enabled } })
      await notTheAsker(w, { integrationId: 'int-without-cards', userId: 'U0ALICE' })
      expect(w.port.isFullMember).not.toHaveBeenCalled()
    })
  }

  it('requires every card surface to say whether an asker is a full member', () => {
    const { isFullMember: _isFullMember, ...blind } = fakePort()
    // @ts-expect-error a card surface without a membership answer is not a card port
    const port: DraftCardPort = blind
    expect(port.postCard).toBe(blind.postCard)
  })

  it('is nobody when nothing can be reached: the draft waits, and the model is told nothing was sent', async () => {
    const w = await world({ route: async (req) => ({ requestId: req.requestId }) })
    const result = await w.post(TO_SUPPORT, PLACELESS, null)
    expect(result).toMatchObject({ handled: true, result: { drafted: true, approver: null } })
    expect(w.port.postCard).not.toHaveBeenCalled()
    expect((await w.only()).approver).toBeNull()
  })

  // An older control plane strips the `responsible` form and answers its own chain, so it is never asked.
  it('asks no one for the responsible user when the control plane does not route it, and the draft waits in Activity', async () => {
    const w = await world({ routesResponsible: false })
    expect(await w.post(TO_SUPPORT, PLACELESS, null)).toMatchObject({ result: { drafted: true, approver: null } })
    expect(w.route).not.toHaveBeenCalled()
    expect(w.port.postCard).not.toHaveBeenCalled()
    expect(await w.drafts.cardApprover(AGENT, '77777777-7777-4777-8777-777777777777')).toBeUndefined()
    expect(w.route).not.toHaveBeenCalled()
    const draft = await w.only()
    expect(draft.approver).toBeNull()
    expect(await w.decide(draft.id, 'approve')).toMatchObject({ result: 'decided', status: 'succeeded' })
  })
})

describe('the membership lookup behind the approver', () => {
  it('costs one Slack lookup per person a minute, however many drafts they ask for', async () => {
    const info = vi.fn(async ({ user }: { user: string }) => ({ user: { id: user, team_id: 'T0EXAMPLE' } }))
    const conn = new SlackConnection(
      { group: { appToken: 'xapp-1', botToken: 'xoxb-a', integrations: [] }, onMessage: () => {} } as never,
      (opts) => {
        const app = fakeSlackAppFactory({ teamId: 'T0EXAMPLE' })(opts)
        return { ...app, client: { ...app.client, users: { ...app.client.users, info } } } as never
      }
    )
    await conn.start()
    try {
      const w = await world({ cardPort: slackDraftCardPort(conn, INT) })
      for (let i = 0; i < 2; i++) {
        expect(await w.post(TO_SUPPORT, HERE, ALICE)).toMatchObject({
          result: { approver: 'the person who asked, in a direct message' }
        })
      }
      expect(info.mock.calls).toEqual([[{ user: 'U0ALICE' }]])
    } finally {
      await conn.stop()
    }
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

describe('an external place reply drafted before such replies were posted directly', () => {
  it('stays approvable, and posts unchanged in its thread', async () => {
    const w = await world()
    const draft = await w.store.assistantDrafts.create({
      id: 'draft-reply-1',
      agentId: AGENT,
      kind: 'reply',
      target: { platform: 'slack', integrationId: INT, channel: 'C0SHARED', thread: '1700000000.000100' },
      targetExternal: true,
      text: 'Here is the answer.',
      source: { ...HERE, channel: 'C0SHARED', sessionKey: 'key-shared' },
      approver: {
        kind: 'member',
        integrationId: INT,
        channel: 'D_U0ALICE',
        userId: 'U0ALICE',
        teamId: 'T0EXAMPLE',
        consoleUserId: null
      },
      now: 10_000
    })
    expect(draft).toMatchObject({ kind: 'reply', targetExternal: true, status: 'awaiting_review' })
    await w.click(draft.id, 'approve')
    expect(w.gateway.postMessage).toHaveBeenCalledWith(
      'C0SHARED',
      'Here is the answer.',
      '1700000000.000100',
      expect.any(Object)
    )
  })
})

describe('a decision from the console', () => {
  it('approves as a click would: one unchanged post, the editor recorded, the card rewritten without buttons', async () => {
    const w = await world()
    await w.post({ ...TO_SUPPORT, thread: '1700000000.000100' })
    const draft = await w.only()
    expect(await w.decide(draft.id, 'approve')).toEqual({
      result: 'decided',
      status: 'succeeded',
      failure: null
    })
    expect(w.gateway.postMessage).toHaveBeenCalledTimes(1)
    expect(w.gateway.postMessage).toHaveBeenCalledWith(
      'C0SUPPORT',
      'The release is out.',
      '1700000000.000100',
      expect.objectContaining({ username: 'Butler', agentAuthorId: AGENT })
    )
    expect(w.afterPost).toHaveBeenCalledTimes(1)
    expect(await w.only()).toMatchObject({
      status: 'succeeded',
      decidedBy: 'user:usr-editor',
      decidedByName: 'Grace',
      messageId: '1700000000.000200'
    })
    expect(w.port.updateCard).toHaveBeenLastCalledWith(
      'D_U0ALICE',
      'card-1',
      expect.objectContaining({ outcome: '✅ Posted — approved by Grace in the console.' })
    )
    // The card no longer offers buttons, and neither a stale click nor a second decision posts again.
    expect('draftId' in w.port.updateCard.mock.calls.at(-1)![2]).toBe(false)
    await w.click(draft.id, 'approve')
    expect(await w.decide(draft.id, 'approve')).toMatchObject({ result: 'already-decided', status: 'succeeded' })
    expect(w.gateway.postMessage).toHaveBeenCalledTimes(1)
  })

  it('discards: nothing is posted and the card says who discarded it', async () => {
    const w = await world()
    await w.post()
    const draft = await w.only()
    expect(await w.decide(draft.id, 'discard')).toEqual({
      result: 'decided',
      status: 'denied',
      failure: null
    })
    expect(w.port.updateCard.mock.calls.at(-1)![2]).toMatchObject({
      outcome: '🗑️ Discarded by Grace in the console. Nothing was posted.'
    })
    await w.click(draft.id, 'approve')
    expect(w.gateway.postMessage).not.toHaveBeenCalled()
  })

  it('refuses an expired draft as expired, and retires its card', async () => {
    const w = await world()
    await w.post()
    const draft = await w.only()
    w.advance(ASSISTANT_DRAFT_TTL_MS)
    expect(await w.decide(draft.id, 'discard')).toEqual({
      result: 'expired',
      status: 'expired',
      failure: null
    })
    expect(w.port.updateCard.mock.calls.at(-1)![2]).toMatchObject({ outcome: expect.stringContaining('Expired') })
    expect(await w.decide(draft.id, 'approve')).toMatchObject({ result: 'expired' })
    expect(w.gateway.postMessage).not.toHaveBeenCalled()
  })

  it('refuses a draft already decided on its card', async () => {
    const w = await world()
    await w.post()
    const draft = await w.only()
    await w.click(draft.id, 'discard')
    expect(await w.decide(draft.id, 'approve')).toMatchObject({ result: 'already-decided', status: 'denied' })
    expect(w.gateway.postMessage).not.toHaveBeenCalled()
    expect((await w.only()).decidedBy).toBe('T0EXAMPLE:U0ALICE')
  })

  it('posts exactly once when a card click and a console approval race', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const w = await world({
      post: async () => {
        await gate
        return '1700000000.000200'
      }
    })
    await w.post()
    const draft = await w.only()
    const racing = Promise.all([w.click(draft.id, 'approve'), w.decide(draft.id, 'approve')])
    await new Promise((resolve) => setTimeout(resolve, 10))
    release()
    const [, decision] = await racing
    expect(w.gateway.postMessage).toHaveBeenCalledTimes(1)
    expect(['decided', 'already-decided']).toContain(decision.result)
    expect(await w.only()).toMatchObject({ status: 'succeeded' })
  })

  it('reads another agent’s draft, or an unknown one, as not found', async () => {
    const w = await world()
    await w.post()
    const draft = await w.only()
    expect(await w.decide(draft.id, 'approve', 'agent-b')).toEqual({
      result: 'not-found',
      status: null,
      failure: null
    })
    expect(await w.decide('no-such-draft', 'discard')).toMatchObject({ result: 'not-found' })
    expect((await w.only()).status).toBe('awaiting_review')
  })

  it('decides a draft nobody could be reached for, which has no card to rewrite', async () => {
    const w = await world({ route: async (req) => ({ requestId: req.requestId }) })
    await w.post(TO_SUPPORT, PLACELESS, null)
    expect(await w.decide((await w.only()).id, 'approve')).toMatchObject({ status: 'succeeded' })
    expect(w.gateway.postMessage).toHaveBeenCalledTimes(1)
    expect(w.port.updateCard).not.toHaveBeenCalled()
  })

  it('reports an uncertain or a failed post without retrying it', async () => {
    const unsure = await world({ post: async () => undefined })
    await unsure.post()
    const draft = await unsure.only()
    expect(await unsure.decide(draft.id, 'approve')).toMatchObject({
      result: 'decided',
      status: 'outcome_unknown',
      failure: 'the platform returned no message id'
    })
    expect(await unsure.decide(draft.id, 'approve')).toMatchObject({ result: 'already-decided' })
    expect(unsure.gateway.postMessage).toHaveBeenCalledTimes(1)
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

describe('a first look report round’s held cards (assistant-mode.md §5.13)', () => {
  const GENERAL: ProposalPlace = { integrationId: INT, channel: 'C0GENERAL' }
  const ROUND = 'assistant-report:round-1'

  it('cards nothing while held, then each once in the given thread, in the order proposed', async () => {
    const w = await world()
    const second = await w.propose(GENERAL, { hold: { round: ROUND, seq: 2 }, sentence: 'Second.' })
    const first = await w.propose(GENERAL, { hold: { round: ROUND, seq: 1 }, sentence: 'First.' })
    expect(first.approver).toBe('the people in the conversation the follow-up belongs to')
    expect(w.port.postCard).not.toHaveBeenCalled()
    await w.drafts.releaseRound(AGENT, ROUND, '1700000000.000900')
    await w.drafts.releaseRound(AGENT, ROUND, '1700000000.000900')
    expect(w.port.postCard.mock.calls.map((call) => [call[1].view.proposal?.sentence, call[2]])).toEqual([
      ['First.', '1700000000.000900'],
      ['Second.', '1700000000.000900']
    ])
    expect(await w.store.assistantDrafts.get(second.draft.id)).toMatchObject({
      cardTs: 'card-2',
      proposal: { held: false }
    })
  })

  it('cards none decided from the console while it was held', async () => {
    const w = await world()
    const { draft } = await w.propose(GENERAL, { hold: { round: ROUND, seq: 1 } })
    await w.decide(draft.id, 'discard')
    await w.drafts.releaseRound(AGENT, ROUND, undefined)
    expect(w.port.postCard).not.toHaveBeenCalled()
  })
})

describe('a follow-up form a restart cut short', () => {
  const FORM = { title: 'The release date', doneWhen: 'A date is posted.', nextCheck: null }

  it('settles as taken when its follow-up exists, else as not taken, and its card says which', async () => {
    for (const taken of [true, false]) {
      const w = await world({ followUpTaken: taken })
      const { draft } = await w.propose(
        { integrationId: INT, channel: 'C0GENERAL' },
        { task: undefined, followUp: FORM }
      )
      expect(
        await w.store.assistantDrafts.beginFollowUp(draft.id, { id: 'user:u', name: 'Ada' }, 'item-9', 11_000)
      ).toBe(true)
      await w.drafts.recover([AGENT])
      expect(await w.store.assistantDrafts.get(draft.id)).toMatchObject(
        taken
          ? { status: 'succeeded', failure: null }
          : { status: 'failed', failure: expect.stringContaining('restart') }
      )
      expect(w.port.updateCard.mock.calls.at(-1)![2]).toMatchObject({
        outcome: expect.stringContaining(taken ? 'The follow-up was taken' : 'Could not take the follow-up')
      })
      await store?.close()
      store = undefined
    }
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
  const text = (v: AssistantDraftCardView): string => JSON.stringify(buildAssistantDraftCard('d-1', v, {}))

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
  const blocks = (v: AssistantDraftCardView): any[] => buildAssistantDraftCard('d-1', v, {}) as any[]
  const proposal = (over: Partial<AssistantDraftCardView> = {}): AssistantDraftCardView => ({
    ...view({ channel: 'C0GENERAL', name: 'release-train' }),
    kind: 'task',
    text: 'Draft the release notes for 2.6 from the merged pull requests.',
    proposal: {
      sentence: 'I want to draft the release notes because two releases went out without them.',
      why: 'Asked twice this month.'
    },
    sessionUrl: 'https://console.example.test/example-org/sessions/s-1',
    ...over
  })

  it('shows a follow-up form as what it will do and its first check, in the agent’s own words', () => {
    const card = blocks(
      proposal({
        text: 'Release notes',
        proposal: {
          sentence: 'I want to check each release has notes.',
          why: 'Two releases went out without them.',
          followUp: {
            title: 'Release notes',
            doneWhen: 'I’ll look each Monday morning and remind the owner here; I stop once every release has notes.',
            nextCheck: 1_760_000_000_000
          }
        }
      })
    )
    expect(card.map((b) => b.type)).toEqual(['section', 'markdown', 'markdown', 'context', 'actions'])
    expect(card[0].text.text).toBe('*I want to check each release has notes.*')
    expect(card[1].text).toBe('Two releases went out without them.')
    expect(card[2].text).toBe(
      'I’ll look each Monday morning and remind the owner here; I stop once every release has notes.'
    )
    expect(card[3].elements[0].text).toBe('🕒 <!date^1760000000^{date_short_pretty} {time}|2025-10-09T08:53:20.000Z>')
    const all = JSON.stringify(card)
    for (const gone of ['Butler', 'Release notes', 'Follow-up', 'Why', 'Done when', 'First check', 'nothing else runs'])
      expect(all).not.toContain(gone)
    expect(all).not.toContain('C0GENERAL')
  })

  it('shows no first check for a follow-up form without one', () => {
    const card = blocks(
      proposal({
        proposal: {
          sentence: 'I want to follow this up.',
          why: 'Asked.',
          followUp: { title: 'Notes', doneWhen: 'I stop once the notes are posted.', nextCheck: null }
        }
      })
    )
    expect(card.map((b) => b.type)).toEqual(['section', 'markdown', 'markdown', 'actions'])
    expect(JSON.stringify(card)).not.toContain('No check until')
  })

  it('shows a task form as its sentence and reason, its exact work one click away on the proposing session', () => {
    const card = blocks(proposal())
    expect(card.map((b) => b.type)).toEqual(['section', 'markdown', 'context', 'actions'])
    expect(card[0].text.text).toBe('*I want to draft the release notes because two releases went out without them.*')
    expect(card[1].text).toBe('Asked twice this month.')
    expect(card[2].elements).toEqual([
      { type: 'mrkdwn', text: '<https://console.example.test/example-org/sessions/s-1|🔗>' }
    ])
    const all = JSON.stringify(card)
    for (const gone of ['Butler', 'Draft the release notes for 2.6', 'Work', 'Why', 'Runs with', 'Open the check'])
      expect(all).not.toContain(gone)
    expect(card[3].elements.map((b: any) => b.text.text)).toEqual(['Approve', 'Deny'])
  })

  it('quotes a task form’s exact work, with no label, where no session link exists', () => {
    const { sessionUrl: _, ...rest } = proposal()
    const card = blocks(rest)
    expect(card.map((b) => b.type)).toEqual(['section', 'markdown', 'markdown', 'actions'])
    expect(card[2].text).toBe('> Draft the release notes for 2.6 from the merged pull requests.')
    expect(JSON.stringify(card)).not.toContain('Work')
  })

  it('keeps the settled outcome and drops the footer once a proposal is decided', () => {
    const settled = buildAssistantDraftSettledCard(proposal(), '🚫 Denied by Ada. Nothing was run.') as any[]
    expect(settled.map((b) => b.type)).toEqual(['section', 'markdown', 'context', 'section'])
    expect(JSON.stringify(settled.at(-1))).toContain('🚫 Denied by Ada. Nothing was run.')
    expect(JSON.stringify(settled)).not.toContain('Runs with')
  })
})

describe('a proposal in the conversation its item belongs to', () => {
  const GENERAL: ProposalPlace = { integrationId: INT, channel: 'C0GENERAL', thread: '1700000000.000100' }
  const ALICES_DM: ProposalPlace = { integrationId: INT, channel: 'D0ALICE' }
  const DENIED = '\u{1F6AB} Denied by u0bob. Nothing was run.'

  it('is carded there, in the thread its replies land in, and nowhere else', async () => {
    const w = await world()
    const { draft, approver } = await w.propose(GENERAL)
    expect(approver).toBe('the people in the conversation the follow-up belongs to')
    expect(w.port.postCard).toHaveBeenCalledTimes(1)
    expect(w.port.postCard.mock.calls[0]).toEqual([
      'C0GENERAL',
      expect.objectContaining({
        draftId: draft.id,
        view: expect.objectContaining({
          kind: 'task',
          proposal: expect.objectContaining({ sentence: expect.any(String) })
        })
      }),
      '1700000000.000100'
    ])
    expect(w.route).not.toHaveBeenCalled()
    expect(draft).toMatchObject({
      approver: { kind: 'place', integrationId: INT, channel: 'C0GENERAL', userId: null },
      cardTs: 'card-1',
      cardShows: 'awaiting_review'
    })
  })

  it('is approved by a person whose message there would start a turn, and by no one else', async () => {
    const w = await world()
    const { draft } = await w.propose(GENERAL)
    await w.click(draft.id, 'approve', 'B0BOT')
    w.askable.delete('C0GENERAL')
    await w.click(draft.id, 'approve', 'U0BOB')
    expect(await w.store.assistantDrafts.get(draft.id)).toMatchObject({ status: 'awaiting_review' })
    expect(w.startTask).not.toHaveBeenCalled()

    w.askable.add('C0GENERAL')
    await w.click(draft.id, 'approve', 'U0BOB')
    expect(w.startTask).toHaveBeenCalledTimes(1)
    expect(await w.store.assistantDrafts.get(draft.id)).toMatchObject({
      status: 'executing',
      decidedBy: 'T0EXAMPLE:U0BOB',
      decidedByName: 'u0bob',
      cardShows: 'executing'
    })
    expect(w.port.updateCard).toHaveBeenLastCalledWith(
      'C0GENERAL',
      'card-1',
      expect.objectContaining({ outcome: expect.stringContaining('Approved by u0bob') })
    )
  })

  it('names who decided when a relayed click carries only their id', async () => {
    const w = await world()
    const { draft } = await w.propose(GENERAL)
    await w.drafts.handleChoice({ requestId: draft.id, optionId: 'approve', actor: { userId: 'U0BOB' } })
    expect(w.port.nameOf).toHaveBeenCalledWith('U0BOB')
    expect(await w.store.assistantDrafts.get(draft.id)).toMatchObject({
      decidedBy: 'T0EXAMPLE:U0BOB',
      decidedByName: 'Name of U0BOB'
    })
    expect(w.port.updateCard).toHaveBeenLastCalledWith(
      'C0GENERAL',
      'card-1',
      expect.objectContaining({ outcome: expect.stringContaining('Approved by Name of U0BOB') })
    )
  })

  it('in a direct message, is approved by that person only', async () => {
    const w = await world()
    const { draft } = await w.propose(ALICES_DM)
    expect(w.port.postCard.mock.calls[0]![0]).toBe('D0ALICE')
    expect(w.port.postCard.mock.calls[0]![2]).toBeUndefined()
    await w.click(draft.id, 'approve', 'U0BOB')
    expect(w.startTask).not.toHaveBeenCalled()
    await w.click(draft.id, 'approve', 'U0ALICE')
    expect(await w.store.assistantDrafts.get(draft.id)).toMatchObject({ status: 'executing', decidedByName: 'u0alice' })
  })

  it('says on its card that nothing was run once denied, or once expired', async () => {
    const w = await world()
    const { draft: denied } = await w.propose(GENERAL)
    await w.click(denied.id, 'discard', 'U0BOB')
    expect(w.port.updateCard).toHaveBeenLastCalledWith(
      'C0GENERAL',
      'card-1',
      expect.objectContaining({ outcome: DENIED })
    )
    const { draft: lapsed } = await w.propose(GENERAL)
    w.advance(ASSISTANT_DRAFT_TTL_MS)
    await w.drafts.sweep([AGENT])
    expect(w.port.updateCard).toHaveBeenLastCalledWith(
      'C0GENERAL',
      'card-2',
      expect.objectContaining({ outcome: expect.stringContaining('Expired. Nothing was run.') })
    )
    expect(await w.store.assistantDrafts.get(lapsed.id)).toMatchObject({ status: 'expired', cardShows: 'expired' })
    expect(w.startTask).not.toHaveBeenCalled()
  })

  it('never runs a task for an agent outside assistant mode, whose sub-sessions are delegated only', async () => {
    const w = await world({ policy: { enabled: false } })
    const { draft } = await w.propose(GENERAL)
    expect(await w.decide(draft.id, 'approve')).toMatchObject({
      result: 'decided',
      status: 'failed',
      failure: 'the agent is no longer in assistant mode'
    })
    expect(w.startTask).not.toHaveBeenCalled()
  })

  it('runs once when its card and the console answer together', async () => {
    const w = await world()
    const { draft } = await w.propose(GENERAL)
    const [answer] = await Promise.all([w.decide(draft.id, 'approve'), w.click(draft.id, 'approve', 'U0BOB')])
    expect(answer.result).toMatch(/^(decided|already-decided)$/)
    const started = await Promise.all(w.startTask.mock.results.map((r) => r.value as Promise<TaskStart>))
    expect(started.filter((r) => r.kind === 'started')).toHaveLength(1)
    expect((await w.store.assistantDrafts.get(draft.id))?.status).toBe('executing')
  })

  it('falls back to the responsible user, and only there, when the place cannot take the card', async () => {
    const w = await world()
    w.port.postCard.mockImplementationOnce(async () => {
      throw new Error('not_in_channel')
    })
    const { draft, approver } = await w.propose(GENERAL)
    expect(approver).toBe("the agent's responsible user, in a direct message")
    expect(w.port.postCard.mock.calls.map((c) => c[0])).toEqual(['C0GENERAL', 'D_U0RESP'])
    expect(draft).toMatchObject({ approver: { kind: 'member', userId: 'U0RESP' }, cardTs: 'card-1' })
    // The place's people decide nothing now: the card they would click was never posted.
    await w.click(draft.id, 'approve', 'U0BOB')
    expect(w.startTask).not.toHaveBeenCalled()
    await w.click(draft.id, 'approve', 'U0RESP')
    expect(w.startTask).toHaveBeenCalledTimes(1)
  })

  it('keeps a card whose post timed out in its place, and never cards it twice', async () => {
    const w = await world()
    w.port.postCard.mockImplementationOnce(async () => {
      throw Object.assign(new Error('send queue: task timed out'), { sendQueueTimeout: true })
    })
    const { draft, approver } = await w.propose(GENERAL)
    expect(approver).toBe('the people in the conversation the follow-up belongs to')
    expect(w.port.postCard.mock.calls.map((c) => c[0])).toEqual(['C0GENERAL'])
    expect(draft).toMatchObject({ approver: { kind: 'place', channel: 'C0GENERAL' }, cardTs: null })
    // The card may have landed late, and the place's people still decide it.
    await w.click(draft.id, 'approve', 'U0BOB')
    expect(w.startTask).toHaveBeenCalledTimes(1)
  })

  it('goes to the responsible user, as before, where no one could ask the agent', async () => {
    const w = await world()
    const { draft } = await w.propose({ integrationId: INT, channel: 'C0SHARED' })
    expect(w.port.postCard.mock.calls.map((c) => c[0])).toEqual(['D_U0RESP'])
    expect(draft.approver).toMatchObject({ kind: 'member', userId: 'U0RESP' })
  })

  it('rewrites a card that missed its settlement when the integration reconnects, once', async () => {
    const w = await world()
    const { draft } = await w.propose(GENERAL)
    w.port.updateCard.mockResolvedValueOnce(false)
    await w.click(draft.id, 'discard', 'U0BOB')
    expect(await w.store.assistantDrafts.get(draft.id)).toMatchObject({
      status: 'denied',
      cardShows: 'awaiting_review'
    })
    // A restart: a fresh service over the same store, as the reconnect sweep runs it.
    const restarted = new AssistantDrafts(w.drafts['host'])
    await restarted.retireStaleCards(INT)
    expect(w.port.updateCard).toHaveBeenLastCalledWith(
      'C0GENERAL',
      'card-1',
      expect.objectContaining({ outcome: DENIED })
    )
    expect((await w.store.assistantDrafts.get(draft.id))?.cardShows).toBe('denied')
    w.port.updateCard.mockClear()
    await restarted.retireStaleCards(INT)
    expect(w.port.updateCard).not.toHaveBeenCalled()
  })
})
