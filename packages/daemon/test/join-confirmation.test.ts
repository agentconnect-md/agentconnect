// The confirmation before the bot joins a public channel (#2979): where its card goes, who may answer, and how it settles.
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import { agentHostKey } from '../src/acp/host-key.js'
import type { ChatSurface } from '../src/agents/chat-actions.js'
import { AssistantDrafts, type DraftCardPort } from '../src/assistant/drafts.js'
import type { ReadAsker } from '../src/assistant/place-access.js'
import { listAgentPermissionRequests } from '../src/cp/config-apply-handlers.js'
import { pendingTurnKey, type Pending } from '../src/daemon/turn-types.js'
import { PermissionCoordinator, type PermissionHost } from '../src/permissions/coordinator.js'
import {
  JOIN_ANSWER_REFUSED,
  JOIN_ASK_TIMEOUT_MS,
  JOIN_EXPIRED_TEXT,
  type JoinAsk
} from '../src/permissions/join-confirmation.js'
import { slackApprovalCards } from '../src/platforms/slack/approval-card.js'
import type { SlackConnection } from '../src/slack/connection.js'
import { LocalStore } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'
import type { AssistantDraftLedger } from '../src/store/assistant-drafts.js'
import { WAIT } from './wait-support.js'

const AGENT = 'bot-a'
const OWNER = agentHostKey(AGENT)
const ACP = 'acp-1'
const ADA: ReadAsker = { kind: 'member', platform: 'slack', integrationId: 'int-1', userId: 'U-ada' }
const ADA_CONSOLE: ReadAsker = { kind: 'console', userId: 'cu-ada' }

function fakeSlack() {
  let n = 0
  return {
    openDirectMessage: vi.fn(async (user: string) => `D-${user}`),
    postBlocks: vi.fn(async (..._args: unknown[]) => `300.${++n}`),
    updateBlocks: vi.fn(async (..._args: unknown[]) => undefined),
    postEphemeral: vi.fn(async (..._args: unknown[]) => true),
    workspaceUrl: 'https://w.slack.example.test',
    workspaceId: () => 'T1',
    memberName: vi.fn(async () => 'Ada Example' as string | undefined)
  }
}

const ask = (over: Partial<JoinAsk> = {}): JoinAsk => ({
  channel: 'C-GEN',
  name: 'general',
  purpose: 'read',
  askers: [ADA],
  ...over
})

async function world(
  over: {
    /** The turn's own conversation; false for a run with none (a schedule with no conversation). */
    conversation?: boolean
    webchat?: boolean
    surface?: ChatSurface
    database?: DatabaseSync
    personDm?: PermissionHost['personDm']
    joinCardExpired?: PermissionHost['joinCardExpired']
  } = {}
) {
  const store = await LocalStore.open({
    database: SqliteAsyncDatabase.adopt(over.database ?? new DatabaseSync(':memory:'))
  })
  const clock = new FakeClock(1_000_000)
  const slack = fakeSlack()
  const cp = vi.fn(async (payload: { requestId: string; verify?: { userId: string; consoleUserId?: string } }) =>
    payload.verify
      ? { requestId: payload.requestId, allowed: payload.verify.userId === 'U-ada', displayName: 'Ada Example' }
      : { requestId: payload.requestId }
  )
  const output = vi.fn()
  const pending = new Map<string, Pending>()
  const p = {
    plan: {
      sessionKey: 'slack:C1:100.1:bot-a',
      agentId: AGENT,
      agentName: 'Butler',
      platform: over.webchat ? 'webchat' : 'slack',
      channel: 'C1',
      thread: '100.1',
      integrationId: over.webchat ? undefined : 'int-1',
      requesterId: 'U-ada',
      sessionThread: '100.1',
      statusThread: '100.1',
      approvalSurfaceSuppressed: false
    },
    ...(over.conversation === false || over.webchat ? {} : { conn: slack }),
    ...(over.webchat ? { webchat: { conversationId: 'wc-1', turnId: 't-1', index: 0, sink: { output } } } : {}),
    approval: { waitMs: 0, depth: 0 },
    acpSessionId: ACP,
    hostKey: OWNER,
    outwardSessionId: 'sid-1',
    builtinSystemToolCallIds: new Set<string>(),
    entry: { msg: { text: 'what did #general decide?', source: 'user', sender: { id: 'U-ada', isBot: false } } }
  } as unknown as Pending
  pending.set(pendingTurnKey(OWNER, ACP), p)
  const host: PermissionHost = {
    log: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as never,
    clock: () => clock,
    cancelTurn: vi.fn(async () => {}),
    store: () => store,
    // Approving tool calls in chat is off here: a join confirmation does not depend on it.
    agents: () => new Map([[AGENT, { id: AGENT, name: 'Butler', chatActions: 'talk' } as never]]),
    pending: () => pending,
    evalHooks: () => ({ emit: vi.fn() }) as never,
    memoryExtraction: () => undefined,
    enqueueApply: vi.fn(),
    postCardSerialized: async (_p, post) => await post(slack),
    elicitCardFacet: () => undefined,
    approvalCardFacet: (platform) => (platform === 'slack' ? slackApprovalCards : undefined),
    chatCardsAt: (integrationId) =>
      integrationId === 'int-1' ? { facet: slackApprovalCards, conn: slack } : undefined,
    httpSlackSessionTarget: () => undefined,
    maskAgentSecrets: (_agentId, payload) => payload,
    logSessionAction: vi.fn(),
    emitApprovalActivity: vi.fn(),
    approvalGateOpened: () => false,
    approvalGateClosed: vi.fn(),
    cpApprovalRoute: () => ({ approvalRoute: cp as never }),
    orgForAgent: () => 'org-1',
    sessionLink: (sessionId) => `https://console.example.test/sessions/${sessionId}`,
    slackConnFor: (integrationId) => (integrationId === 'int-1' ? (slack as unknown as SlackConnection) : undefined),
    approvalDmIntegrations: () => ['int-1'],
    slackDmSessionTarget: (_p, integrationId) => `target:${integrationId}`,
    chatSurface: () => over.surface ?? 'open',
    chatEditorsOnly: () => false,
    chatActor: async () => 'not-editor',
    ...(over.personDm ? { personDm: over.personDm } : {}),
    ...(over.joinCardExpired ? { joinCardExpired: over.joinCardExpired } : {})
  }
  const coordinator = new PermissionCoordinator(host)
  const offered = vi.fn((_to: string | null, _thread?: string) => {})
  const requestId = async (): Promise<string> => {
    await vi.waitFor(async () => expect(await store.listPermissionRequests(AGENT)).toHaveLength(1), WAIT)
    return (await store.listPermissionRequests(AGENT))[0]!.id
  }
  const posted = (call = 0) => slack.postBlocks.mock.calls[call] as unknown[]
  const rewrites = () => slack.updateBlocks.mock.calls.map((call) => JSON.stringify(call[2]))
  return { store, clock, slack, cp, p, output, coordinator, offered, host, requestId, posted, rewrites }
}

/** A person's DM through the routing drafts use: a console user reaches the chat account they linked. */
function draftsRouting(slack: ReturnType<typeof fakeSlack>): AssistantDrafts {
  const port: DraftCardPort = {
    openDirectMessage: async (user) => await slack.openDirectMessage(user),
    isFullMember: async () => true,
    scope: () => 'T1',
    postCard: async () => undefined,
    updateCard: async () => true
  }
  return new AssistantDrafts({
    ledger: () => ({}) as AssistantDraftLedger,
    now: () => 0,
    log: { info: () => {}, warn: () => {} },
    agent: () => ({ name: 'Butler', integrations: [{ id: 'int-1' }] }),
    gatewayFor: () => undefined,
    placeExternal: () => false,
    cardPortFor: (id) => (id === 'int-1' ? port : undefined),
    approvalRoute: async (_agentId, req) =>
      req.consoleUserId === 'cu-ada'
        ? {
            requestId: req.requestId,
            target: { integrationId: 'int-1', teamId: 'T1', userId: 'U-ada', consoleUserId: 'cu-ada' }
          }
        : { requestId: req.requestId },
    platformName: () => 'Slack',
    describeDestination: async () => ({})
  })
}

describe('the card in the conversation the request came from', () => {
  it('asks in the turn’s thread, and the asker’s Join lets the call go on', async () => {
    const w = await world()
    const asked = w.coordinator.askToJoin(w.p, ask(), JOIN_ASK_TIMEOUT_MS, w.offered)
    const id = await w.requestId()
    await vi.waitFor(() => expect(w.slack.postBlocks).toHaveBeenCalledTimes(1), WAIT)
    const [channel, blocks, , thread] = w.posted()
    expect([channel, thread]).toEqual(['C1', '100.1'])
    const card = JSON.stringify(blocks)
    expect(card).toContain('Let Butler join #general to read it?')
    expect(card).toContain('"text":"Join"')
    expect(card).toContain('"text":"Don’t join"')
    // The call is told whom it asked, and the thread its turn replied in, as soon as the card is up.
    await vi.waitFor(() => expect(w.offered).toHaveBeenCalledTimes(1), WAIT)
    expect(w.offered.mock.calls[0]![1]).toBe('100.1')

    await w.coordinator.handlePermissionChoice({ requestId: id, optionId: 'join', actor: { userId: 'U-ada' } })
    await expect(asked).resolves.toEqual({ outcome: 'join', by: ADA })
    expect(w.rewrites()).toEqual([expect.stringContaining(':white_check_mark: Joined #general — Ada Example')])
    expect(w.rewrites()[0]).not.toContain('"type":"button"')
    expect((await w.store.listPermissionRequests(AGENT))[0]).toMatchObject({ status: 'allowed' })
    expect(w.clock.pending).toBe(0)
    await w.store.close()
  })

  it('reads “Not joined — Name” after Don’t join, and the call does not join', async () => {
    const w = await world()
    const asked = w.coordinator.askToJoin(w.p, ask({ purpose: 'post' }), JOIN_ASK_TIMEOUT_MS, w.offered)
    const id = await w.requestId()
    await vi.waitFor(() => expect(w.slack.postBlocks).toHaveBeenCalledTimes(1), WAIT)
    expect(JSON.stringify(w.posted()[1])).toContain('Let Butler join #general to post there?')
    await w.coordinator.handlePermissionChoice({ requestId: id, optionId: 'dont-join', actor: { userId: 'U-ada' } })
    await expect(asked).resolves.toMatchObject({ outcome: 'declined' })
    expect(w.rewrites()).toEqual([expect.stringContaining('Not joined — Ada Example')])
    await w.store.close()
  })

  it('outlives the turn that asked, and never holds it as a wait for a person', async () => {
    const w = await world()
    const asked = w.coordinator.askToJoin(w.p, ask(), JOIN_ASK_TIMEOUT_MS, w.offered)
    const id = await w.requestId()
    await vi.waitFor(() => expect(w.offered).toHaveBeenCalledTimes(1), WAIT)
    expect(w.coordinator.awaitingHuman(OWNER, ACP)).toBe(false)
    expect(w.host.emitApprovalActivity).not.toHaveBeenCalled()
    // The turn ends with the call already returned; the card stays answerable.
    await w.coordinator.releaseApprovals(OWNER, ACP)
    expect(w.rewrites()).toEqual([])
    await w.coordinator.handlePermissionChoice({ requestId: id, optionId: 'join', actor: { userId: 'U-ada' } })
    await expect(asked).resolves.toMatchObject({ outcome: 'join' })
    await w.store.close()
  })

  it('ends unjoined when nobody answers within the approval wait, and rewrites the card', async () => {
    const w = await world()
    const asked = w.coordinator.askToJoin(w.p, ask(), JOIN_ASK_TIMEOUT_MS, w.offered)
    await w.requestId()
    await vi.waitFor(() => expect(w.slack.postBlocks).toHaveBeenCalledTimes(1), WAIT)
    w.clock.advance(JOIN_ASK_TIMEOUT_MS - 1)
    expect(w.rewrites()).toEqual([])
    w.clock.advance(1)
    await expect(asked).resolves.toMatchObject({ outcome: 'expired' })
    expect(w.rewrites()).toEqual([expect.stringContaining(JOIN_EXPIRED_TEXT)])
    expect((await w.store.listPermissionRequests(AGENT))[0]).toMatchObject({ status: 'expired' })
    await w.store.close()
  })

  it('gives the continuation to the answer that won, never to one that lost the race', async () => {
    const w = await world()
    const bob: ReadAsker = { kind: 'member', platform: 'slack', integrationId: 'int-1', userId: 'U-bob' }
    const asked = w.coordinator.askToJoin(w.p, ask({ askers: [ADA, bob] }), JOIN_ASK_TIMEOUT_MS, w.offered)
    const id = await w.requestId()
    await vi.waitFor(() => expect(w.slack.postBlocks).toHaveBeenCalledTimes(1), WAIT)
    // Two people behind the turn answer at once: Ada's Join reaches the row first, Bob's Don't join loses.
    await Promise.all([
      w.coordinator.handlePermissionChoice({
        requestId: id,
        optionId: 'join',
        actor: { userId: 'U-ada', name: 'Ada' }
      }),
      w.coordinator.handlePermissionChoice({
        requestId: id,
        optionId: 'dont-join',
        actor: { userId: 'U-bob', name: 'Bob' }
      })
    ])
    await expect(asked).resolves.toEqual({ outcome: 'join', by: ADA })
    expect((await w.store.listPermissionRequests(AGENT))[0]).toMatchObject({ status: 'allowed', resolvedByName: 'Ada' })
    expect(w.rewrites()).toEqual([expect.stringContaining('Joined #general — Ada')])
    await w.store.close()
  })

  it('refuses anyone else privately and leaves the card live; a bot decides nothing', async () => {
    const w = await world()
    const decided = vi.fn()
    const asked = w.coordinator
      .askToJoin(w.p, ask(), JOIN_ASK_TIMEOUT_MS, w.offered)
      .then((outcome) => (decided(), outcome))
    const id = await w.requestId()
    await vi.waitFor(() => expect(w.slack.postBlocks).toHaveBeenCalledTimes(1), WAIT)

    await w.coordinator.handlePermissionChoice({ requestId: id, optionId: 'join', actor: { userId: 'U-bob' } })
    expect(w.slack.postEphemeral).toHaveBeenCalledWith('C1', 'U-bob', JOIN_ANSWER_REFUSED, '100.1')
    await w.coordinator.handlePermissionChoice({
      requestId: id,
      optionId: 'join',
      actor: { userId: 'U-ada', isBot: true }
    })
    expect(w.rewrites()).toEqual([])
    expect(decided).not.toHaveBeenCalled()

    // The first valid answer decides.
    await w.coordinator.handlePermissionChoice({ requestId: id, optionId: 'join', actor: { userId: 'U-ada' } })
    await expect(asked).resolves.toMatchObject({ outcome: 'join' })
    await w.store.close()
  })

  it('takes the answer of a console person behind the turn through the chat account they linked', async () => {
    const w = await world()
    const asked = w.coordinator.askToJoin(w.p, ask({ askers: [ADA_CONSOLE] }), JOIN_ASK_TIMEOUT_MS, w.offered)
    const id = await w.requestId()
    await vi.waitFor(() => expect(w.slack.postBlocks).toHaveBeenCalledTimes(1), WAIT)
    await w.coordinator.handlePermissionChoice({ requestId: id, optionId: 'join', actor: { userId: 'U-ada' } })
    await expect(asked).resolves.toEqual({ outcome: 'join', by: ADA_CONSOLE })
    expect(w.cp).toHaveBeenCalledWith(
      expect.objectContaining({
        verify: { integrationId: 'int-1', teamId: 'T1', userId: 'U-ada', consoleUserId: 'cu-ada' }
      }),
      'org-1'
    )
    await w.store.close()
  })
})

describe('where else the card goes', () => {
  it('sends a person-backed run with no conversation of its own to that person’s DM', async () => {
    const holder: { drafts?: AssistantDrafts } = {}
    const w = await world({
      conversation: false,
      personDm: (agentId: string, requestId: string, asker: ReadAsker) =>
        holder.drafts!.personApprover(agentId, requestId, asker)
    })
    holder.drafts = draftsRouting(w.slack)
    const asked = w.coordinator.askToJoin(w.p, ask({ askers: [ADA_CONSOLE] }), JOIN_ASK_TIMEOUT_MS, w.offered)
    const id = await w.requestId()
    await vi.waitFor(() => expect(w.slack.postBlocks).toHaveBeenCalledTimes(1), WAIT)
    expect(w.posted()[0]).toBe('D-U-ada')
    expect(JSON.stringify(w.posted()[1])).toContain('Let Butler join #general to read it?')
    await w.coordinator.handlePermissionChoice({ requestId: id, optionId: 'join', actor: { userId: 'U-ada' } })
    await expect(asked).resolves.toEqual({ outcome: 'join', by: ADA_CONSOLE })
    expect(w.rewrites()).toEqual([expect.stringContaining('Joined #general — Ada Example')])
    await w.store.close()
  })

  it('puts no card naming the channel in a conversation shared with another organization', async () => {
    const personDm = vi.fn(async () => ({
      target: { integrationId: 'int-1', teamId: 'T1', userId: 'U-ada' },
      channel: 'D-U-ada'
    }))
    const w = await world({ surface: 'external', personDm })
    const asked = w.coordinator.askToJoin(w.p, ask(), JOIN_ASK_TIMEOUT_MS, w.offered)
    const id = await w.requestId()
    await vi.waitFor(() => expect(w.slack.postBlocks).toHaveBeenCalledTimes(1), WAIT)
    expect(w.posted()[0]).toBe('D-U-ada')
    // A member's own DM needs no console recheck: they are the person behind the turn.
    await w.coordinator.handlePermissionChoice({ requestId: id, optionId: 'join', actor: { userId: 'U-ada' } })
    await expect(asked).resolves.toEqual({ outcome: 'join', by: ADA })
    expect(w.cp).not.toHaveBeenCalled()
    await w.store.close()
  })

  it('asks nobody when no card can reach a person behind the turn', async () => {
    const w = await world({ conversation: false, personDm: async () => undefined })
    await expect(w.coordinator.askToJoin(w.p, ask(), JOIN_ASK_TIMEOUT_MS, w.offered)).resolves.toMatchObject({
      outcome: 'unavailable'
    })
    expect(w.slack.postBlocks).not.toHaveBeenCalled()
    expect(await w.store.listPermissionRequests(AGENT)).toEqual([])
    await w.store.close()
  })

  it('keeps the console answer that won, not one that lost the race', async () => {
    const w = await world({ webchat: true })
    const bob: ReadAsker = { kind: 'console', userId: 'cu-bob' }
    const asked = w.coordinator.askToJoin(w.p, ask({ askers: [ADA_CONSOLE, bob] }), JOIN_ASK_TIMEOUT_MS, w.offered)
    const id = await w.requestId()
    const decide = (decidedBy: string, decision: 'allow' | 'deny', optionId: string) =>
      w.coordinator.decideEditorPermission({ agentId: AGENT, requestId: id, decision, optionId, decidedBy })
    const [ada, bobs] = await Promise.all([
      decide('user:cu-ada', 'allow', 'join'),
      decide('user:cu-bob', 'deny', 'dont-join')
    ])
    expect([ada, bobs]).toEqual([{ ok: true }, { ok: false, reason: 'permission request is no longer pending' }])
    await expect(asked).resolves.toEqual({ outcome: 'join', by: ADA_CONSOLE })
    await w.store.close()
  })

  it('lists a webchat asker’s confirmation among the conversation’s pending requests, for them alone', async () => {
    const w = await world({ webchat: true })
    const asked = w.coordinator.askToJoin(
      w.p,
      ask({ askers: [ADA_CONSOLE], purpose: 'post' }),
      JOIN_ASK_TIMEOUT_MS,
      w.offered
    )
    const id = await w.requestId()
    expect(w.slack.postBlocks).not.toHaveBeenCalled()
    expect(w.output).toHaveBeenCalledWith(
      expect.objectContaining({
        event: { kind: 'message', text: expect.stringContaining('Let Butler join #general to post there?') }
      })
    )
    // What the console's pending-requests strip renders: the question and its two answers.
    const page = await listAgentPermissionRequests(
      {
        store: () => w.store,
        clock: () => w.clock,
        pendingPermissionOptions: (agentId: string, requestId: string) =>
          w.coordinator.pendingPermissionOptions(agentId, requestId),
        pendingJoinAskers: (agentId: string, requestId: string) => w.coordinator.pendingJoinAskers(agentId, requestId)
      } as never,
      { agentId: AGENT, limit: 50 }
    )
    expect(page.requests).toEqual([
      expect.objectContaining({
        id,
        status: 'pending',
        command: 'Let Butler join #general to post there?',
        kind: 'join',
        joinAskers: ['cu-ada'],
        options: [expect.objectContaining({ optionId: 'join' }), expect.objectContaining({ optionId: 'dont-join' })]
      })
    ])
    // An Agent editor who is not the person behind the turn may not decide it.
    await expect(
      w.coordinator.decideEditorPermission({
        agentId: AGENT,
        requestId: id,
        decision: 'allow',
        optionId: 'join',
        decidedBy: 'user:cu-editor'
      })
    ).resolves.toEqual({ ok: false, reason: JOIN_ANSWER_REFUSED })
    await expect(
      w.coordinator.decideEditorPermission({
        agentId: AGENT,
        requestId: id,
        decision: 'allow',
        optionId: 'join',
        decidedBy: 'user:cu-ada',
        decidedByName: 'Ada Example'
      })
    ).resolves.toEqual({ ok: true })
    await expect(asked).resolves.toEqual({ outcome: 'join', by: ADA_CONSOLE })
    await w.store.close()
  })
})

describe('a restart', () => {
  it('leaves a pending card to the reconnect sweep, which rewrites it as expired', async () => {
    const database = new DatabaseSync(':memory:')
    const w = await world({ database })
    void w.coordinator.askToJoin(w.p, ask(), JOIN_ASK_TIMEOUT_MS, w.offered)
    const id = await w.requestId()
    // Its handle is on the row, as a sub-session's card's is.
    const handle = () =>
      database.prepare('SELECT notifyChannel, notifyTs FROM permission_requests WHERE id = ?').get(id)
    await vi.waitFor(() => expect(handle()).toEqual({ notifyChannel: 'C1', notifyTs: '300.1' }), WAIT)

    // The process dies; the next one opens the store, which expires every request no resolver holds.
    const joinCardExpired = vi.fn()
    const restarted = await world({ database, joinCardExpired })
    await restarted.coordinator.retireOrphanedCards('int-1')
    // Its session is told the call did nothing, in the words a timeout uses, in the thread that asked.
    expect(joinCardExpired).toHaveBeenCalledWith(AGENT, ACP, { name: 'general', purpose: 'read', thread: '100.1' })
    const swept = restarted.slack.updateBlocks.mock.calls
    expect(swept).toHaveLength(1)
    expect(swept[0]![0]).toBe('C1')
    expect(swept[0]![1]).toBe('300.1')
    expect(JSON.stringify(swept[0]![2])).toContain('Let Butler join #general to read it?')
    expect(JSON.stringify(swept[0]![2])).toContain(':hourglass: expired')
    await restarted.store.close()
  })
})
