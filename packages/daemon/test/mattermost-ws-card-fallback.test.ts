import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk/unstable'
import { MATTERMOST_PLATFORM } from '@agentconnect.md/protocol'
import { agentHostKey } from '../src/acp/host-key.js'
import { Daemon } from '../src/daemon.js'
import { pendingTurnKey, type Pending } from '../src/daemon/turn-types.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import type { ChatCardClick } from '../src/platforms/contract.js'
import { mattermostApprovalCards, mattermostApprovalTag } from '../src/platforms/mattermost/approval-card.js'
import { MattermostConnection } from '../src/platforms/mattermost/connection.js'
import { mattermostDraftCardPort, mattermostDraftTag } from '../src/platforms/mattermost/draft-card.js'
import { MATTERMOST_DM_THREAD } from '../src/platforms/mattermost/module.js'
import { LocalStore } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'
import { FakeMattermostServer, fakeMmId, quietLog } from './fakes/mattermost-server.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const AGENT_ID = '22222222-2222-4222-8222-222222222222'
const INT_ID = '33333333-3333-4333-8333-333333333333'

const connections: MattermostConnection[] = []
const stores: LocalStore[] = []
const daemons: Daemon[] = []

afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => {})
  for (const c of connections.splice(0)) await c.stop()
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {})))
})

const samplePermission: RequestPermissionRequest = {
  sessionId: 's1',
  options: [
    { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
  ],
  toolCall: { toolCallId: 'tc-1', title: 'Run git status' }
} as unknown as RequestPermissionRequest

function createPureWsConn(
  server: FakeMattermostServer,
  opts?: {
    onMessage?: (msg: NormalizedMessage) => void
    onCardClick?: (click: ChatCardClick, agentId: string, integrationId: string) => Promise<string | undefined>
  }
): MattermostConnection {
  const conn = new MattermostConnection(
    {
      serverUrl: server.serverUrl,
      botToken: server.botToken,
      integrations: [{ agentId: AGENT_ID, integrationId: INT_ID }]
    },
    {
      onMessage: opts?.onMessage ?? (() => {}),
      ...(opts?.onCardClick ? { onCardClick: opts.onCardClick } : {}),
      log: quietLog,
      createSocket: server.createSocket,
      fetchImpl: server.fetchImpl,
      sendIntervalMs: 0
    }
  )
  connections.push(conn)
  return conn
}

describe('Mattermost pure-WS numbered card fallback', () => {
  it('renders numbered approval cards without actionCallback, handles explicit A-XXXXXXXX and bare thread replies, and retires tags on rewrite', async () => {
    const server = new FakeMattermostServer()
    const alice = server.addUser({ id: fakeMmId('alice', 1), username: 'alice', is_bot: false, first_name: 'Alice' })
    const ch = server.addChannel({ id: fakeMmId('ch', 1), type: 'O', name: 'ops' }, [server.botUser.id, alice.id])
    const otherCh = server.addChannel({ id: fakeMmId('ch', 2), type: 'O', name: 'random' }, [
      server.botUser.id,
      alice.id
    ])
    const rootPost = server.addPost({ channel_id: ch.id, user_id: alice.id, message: '@acbot run status' })

    const messages: NormalizedMessage[] = []
    const clicks: Array<{ click: ChatCardClick; agentId: string; integrationId: string }> = []
    const conn = createPureWsConn(server, {
      onMessage: (m) => messages.push(m),
      onCardClick: async (click, agentId, integrationId) => {
        clicks.push({ click, agentId, integrationId })
        return undefined
      }
    })
    await conn.start()

    expect(mattermostApprovalTag()).toMatch(/^A-[0-9A-F]{8}$/)
    expect(mattermostApprovalCards.canApproveInChat?.(conn)).toBe(true)

    const draft = mattermostApprovalCards.build(
      { requestId: 'req-ws-1', params: samplePermission, via: { agentId: AGENT_ID, integrationId: INT_ID } },
      conn
    )
    expect(draft).not.toBeNull()

    const turn = {
      conn,
      plan: {
        platform: MATTERMOST_PLATFORM,
        agentId: AGENT_ID,
        integrationId: INT_ID,
        channel: ch.id,
        thread: rootPost.id,
        statusThread: rootPost.id,
        agentName: 'Agent'
      }
    }
    const host = {
      postCardSerialized: async (_t: unknown, fn: (c: unknown) => Promise<string | undefined>) => await fn(conn),
      sessionTarget: () => undefined,
      turnState: () => ({ conn, channel: ch.id, rootId: rootPost.id, isDm: false })
    }

    const postId = await mattermostApprovalCards.send(host, turn, draft!)
    expect(postId).toBeTruthy()
    const created = server.posts.get(postId!)!
    expect(created.props?.attachments).toBeUndefined()
    expect(created.message).toContain('1. Allow once')
    expect(created.message).toContain('2. Deny')
    const tagMatch = /`(A-[0-9A-F]{8}) <number>`/.exec(created.message ?? '')
    expect(tagMatch).not.toBeNull()
    const tag = tagMatch![1]!
    expect(created.message).toContain(`_Reply \`${tag} <number>\` (or reply \`<number>\` in this thread) to decide._`)

    // Unrelated bare message at channel root must NOT trigger bare reply match for a threaded card.
    server.lastSocket.emitPosted({
      id: server.nextId('p'),
      channel_id: ch.id,
      user_id: alice.id,
      message: '1'
    })
    await vi.waitFor(() => expect(messages).toHaveLength(1))
    expect(clicks).toHaveLength(0)

    // Cross-channel explicit tag must NOT match.
    server.lastSocket.emitPosted({
      id: server.nextId('p'),
      channel_id: otherCh.id,
      user_id: alice.id,
      message: `${tag} 1`
    })
    await vi.waitFor(() => expect(messages).toHaveLength(2))
    expect(clicks).toHaveLength(0)

    // Out-of-range option number must NOT match.
    server.lastSocket.emitPosted({
      id: server.nextId('p'),
      channel_id: ch.id,
      root_id: rootPost.id,
      user_id: alice.id,
      message: `${tag} 9`
    })
    await vi.waitFor(() => expect(messages).toHaveLength(3))
    expect(clicks).toHaveLength(0)

    // Explicit tagged reply (even from channel root, with leading @mention) matches and consumes message.
    server.lastSocket.emitPosted({
      id: server.nextId('p'),
      channel_id: ch.id,
      user_id: alice.id,
      message: `@acbot ${tag.toLowerCase()}: 2`
    })
    await vi.waitFor(() => expect(clicks).toHaveLength(1))
    expect(clicks[0]).toEqual({
      click: {
        answer: { kind: 'approval', requestId: 'req-ws-1', option: 1 },
        ts: postId,
        actor: { userId: alice.id, name: 'alice' }
      },
      agentId: AGENT_ID,
      integrationId: INT_ID
    })
    expect(messages).toHaveLength(3)

    // Bare `1` inside the same thread matches when it is the sole active card in the thread.
    server.lastSocket.emitPosted({
      id: server.nextId('p'),
      channel_id: ch.id,
      root_id: rootPost.id,
      user_id: alice.id,
      message: '1'
    })
    await vi.waitFor(() => expect(clicks).toHaveLength(2))
    expect(clicks[1]!.click.answer).toEqual({ kind: 'approval', requestId: 'req-ws-1', option: 0 })
    expect(messages).toHaveLength(3)

    // rewrite with settled retires the tag so subsequent replies are no longer intercepted.
    mattermostApprovalCards.rewrite(
      { conn, channel: ch.id, thread: rootPost.id, ts: postId! },
      mattermostApprovalCards.settled({
        params: samplePermission,
        text: 'Allow once — Alice',
        allowed: true,
        fallback: 'Allowed'
      })
    )
    await vi.waitFor(() => {
      const updated = server.posts.get(postId!)!
      expect(updated.message).toContain('✅ Allow once — Alice')
      expect(updated.message).not.toContain(tag)
    })

    server.lastSocket.emitPosted({
      id: server.nextId('p'),
      channel_id: ch.id,
      root_id: rootPost.id,
      user_id: alice.id,
      message: `${tag} 1`
    })
    await vi.waitFor(() => expect(messages).toHaveLength(4))
    expect(clicks).toHaveLength(2)

    // DM send() with MATTERMOST_DM_THREAD allows bare `2` reply in the DM conversation.
    const dm = server.addChannel({ id: fakeMmId('dm', 3), type: 'D', name: `${alice.id}__${server.botUser.id}` }, [
      server.botUser.id,
      alice.id
    ])
    const dmDraft = mattermostApprovalCards.build(
      { requestId: 'req-ws-dm', params: samplePermission, via: { agentId: AGENT_ID, integrationId: INT_ID } },
      conn
    )!
    const dmTurn = {
      conn,
      plan: {
        platform: MATTERMOST_PLATFORM,
        agentId: AGENT_ID,
        integrationId: INT_ID,
        channel: dm.id,
        thread: MATTERMOST_DM_THREAD,
        statusThread: MATTERMOST_DM_THREAD,
        agentName: 'Agent'
      }
    }
    const dmHost = {
      postCardSerialized: async (_t: unknown, fn: (c: unknown) => Promise<string | undefined>) => await fn(conn),
      sessionTarget: () => undefined,
      turnState: () => ({ conn, channel: dm.id, isDm: true })
    }
    const dmPostId = await mattermostApprovalCards.send(dmHost, dmTurn, dmDraft)
    expect(dmPostId).toBeTruthy()
    expect(server.posts.get(dmPostId!)!.root_id).toBe('')
    server.lastSocket.emitPosted({
      id: server.nextId('p'),
      channel_id: dm.id,
      user_id: alice.id,
      message: '2'
    })
    await vi.waitFor(() => expect(clicks).toHaveLength(3))
    expect(clicks[2]!.click.answer).toEqual({ kind: 'approval', requestId: 'req-ws-dm', option: 1 })
  })

  it('ignores ambiguous bare digits when Q-XXXX coexists in the same thread and routes explicit tags cleanly', async () => {
    const server = new FakeMattermostServer()
    const alice = server.addUser({ id: fakeMmId('alice', 1), username: 'alice', is_bot: false })
    const ch = server.addChannel({ id: fakeMmId('ch', 1), type: 'O', name: 'ops' }, [server.botUser.id, alice.id])
    const rootPost = server.addPost({ channel_id: ch.id, user_id: alice.id, message: '@acbot help' })

    const messages: NormalizedMessage[] = []
    const clicks: ChatCardClick[] = []
    const conn = createPureWsConn(server, {
      onMessage: (m) => messages.push(m),
      onCardClick: async (click) => {
        clicks.push(click)
        return undefined
      }
    })
    await conn.start()

    const draft = mattermostApprovalCards.build(
      { requestId: 'req-ambig', params: samplePermission, via: { agentId: AGENT_ID, integrationId: INT_ID } },
      conn
    )!
    const postId = await mattermostApprovalCards.post(conn, { channel: ch.id, thread: rootPost.id }, draft, {
      conn,
      plan: {
        platform: MATTERMOST_PLATFORM,
        agentId: AGENT_ID,
        integrationId: INT_ID,
        channel: ch.id,
        thread: rootPost.id,
        statusThread: rootPost.id,
        agentName: 'Agent'
      }
    })
    expect(postId).toBeTruthy()
    const tag = /`(A-[0-9A-F]{8}) <number>`/.exec(server.posts.get(postId!)!.message ?? '')![1]!

    // Register an open Q-XXXX elicit tag in the same thread.
    conn.noteQuestionTag(ch.id, 'Q-1234ABCD', rootPost.id)

    // Bare `1` is ambiguous -> neither onCardClick nor Q-XXXX replyTo fires.
    server.lastSocket.emitPosted({
      id: server.nextId('p'),
      channel_id: ch.id,
      root_id: rootPost.id,
      user_id: alice.id,
      message: '1'
    })
    await vi.waitFor(() => expect(messages).toHaveLength(1))
    expect(messages[0]!.replyTo).toBeUndefined()
    expect(clicks).toHaveLength(0)

    // Explicit Q-1234ABCD 1 routes to question tag via onMessage.
    server.lastSocket.emitPosted({
      id: server.nextId('p'),
      channel_id: ch.id,
      root_id: rootPost.id,
      user_id: alice.id,
      message: 'Q-1234ABCD 1'
    })
    await vi.waitFor(() => expect(messages).toHaveLength(2))
    expect(messages[1]!.replyTo).toBe('Q-1234ABCD')
    expect(clicks).toHaveLength(0)

    // Retiring Q-1234ABCD makes bare `1` unambiguous again and routes to approval card.
    conn.retireQuestionTag('Q-1234ABCD')
    server.lastSocket.emitPosted({
      id: server.nextId('p'),
      channel_id: ch.id,
      root_id: rootPost.id,
      user_id: alice.id,
      message: '1'
    })
    await vi.waitFor(() => expect(clicks).toHaveLength(1))
    expect(clicks[0]!.answer).toEqual({ kind: 'approval', requestId: 'req-ambig', option: 0 })
    expect(messages).toHaveLength(2)

    // Explicit tag still works too until settled.
    server.lastSocket.emitPosted({
      id: server.nextId('p'),
      channel_id: ch.id,
      root_id: rootPost.id,
      user_id: alice.id,
      message: `${tag} 2`
    })
    await vi.waitFor(() => expect(clicks).toHaveLength(2))
    expect(clicks[1]!.answer).toEqual({ kind: 'approval', requestId: 'req-ambig', option: 1 })
  })

  it('posts ephemeral refusal on unauthorized reply while keeping the tag active for an authorized user', async () => {
    const server = new FakeMattermostServer()
    const alice = server.addUser({ id: fakeMmId('alice', 1), username: 'alice', is_bot: false })
    const bob = server.addUser({ id: fakeMmId('bob', 2), username: 'bob', is_bot: false })
    const otherBot = server.addUser({ id: fakeMmId('bot', 3), username: 'otherbot', is_bot: true })
    const ch = server.addChannel({ id: fakeMmId('ch', 1), type: 'O', name: 'ops' }, [
      server.botUser.id,
      alice.id,
      bob.id,
      otherBot.id
    ])
    const rootPost = server.addPost({ channel_id: ch.id, user_id: alice.id, message: '@acbot deploy' })

    const messages: NormalizedMessage[] = []
    const authorizedDecisions: ChatCardClick[] = []
    const conn = createPureWsConn(server, {
      onMessage: (m) => messages.push(m),
      onCardClick: async (click) => {
        if (click.actor?.userId !== alice.id) {
          return 'Only Agent editors can approve in this conversation.'
        }
        authorizedDecisions.push(click)
        return undefined
      }
    })
    await conn.start()

    const draft = mattermostApprovalCards.build(
      { requestId: 'req-auth', params: samplePermission, via: { agentId: AGENT_ID, integrationId: INT_ID } },
      conn
    )!
    const postId = await mattermostApprovalCards.post(conn, { channel: ch.id, thread: rootPost.id }, draft, {
      conn,
      plan: {
        platform: MATTERMOST_PLATFORM,
        agentId: AGENT_ID,
        integrationId: INT_ID,
        channel: ch.id,
        thread: rootPost.id,
        statusThread: rootPost.id,
        agentName: 'Agent'
      }
    })
    const tag = /`(A-[0-9A-F]{8}) <number>`/.exec(server.posts.get(postId!)!.message ?? '')![1]!

    // Another bot posting `A-XXXXXXXX 1` must never be treated as a card reply.
    server.lastSocket.emitPosted({
      id: server.nextId('p'),
      channel_id: ch.id,
      root_id: rootPost.id,
      user_id: otherBot.id,
      message: `@acbot ${tag} 1`,
      props: { from_bot: 'true' }
    })
    await vi.waitFor(() => expect(messages).toHaveLength(1))
    expect(authorizedDecisions).toHaveLength(0)

    // Unauthorized human reply receives ephemeral refusal, consumes message, leaves tag active.
    server.lastSocket.emitPosted({
      id: server.nextId('p'),
      channel_id: ch.id,
      root_id: rootPost.id,
      user_id: bob.id,
      message: `${tag} 1`
    })
    await vi.waitFor(() => expect(server.ephemeralPosts).toHaveLength(1))
    expect(server.ephemeralPosts[0]).toMatchObject({
      channel_id: ch.id,
      user_id: bob.id,
      root_id: rootPost.id,
      message: 'Only Agent editors can approve in this conversation.'
    })
    expect(messages).toHaveLength(1)
    expect(authorizedDecisions).toHaveLength(0)

    // Authorized human can still answer with the same tag afterward.
    server.lastSocket.emitPosted({
      id: server.nextId('p'),
      channel_id: ch.id,
      root_id: rootPost.id,
      user_id: alice.id,
      message: `${tag} 1`
    })
    await vi.waitFor(() => expect(authorizedDecisions).toHaveLength(1))
    expect(authorizedDecisions[0]!.answer).toEqual({ kind: 'approval', requestId: 'req-auth', option: 0 })
    expect(messages).toHaveLength(1)
  })

  it('handles pure-WS D-XXXXXXXX draft cards for task and reply kinds, preserves tag on busy notice, and retires on outcome', async () => {
    const server = new FakeMattermostServer()
    const alice = server.addUser({ id: fakeMmId('alice', 1), username: 'alice', is_bot: false })
    const dm = server.addChannel({ id: fakeMmId('dm', 1), type: 'D', name: `${alice.id}__${server.botUser.id}` }, [
      server.botUser.id,
      alice.id
    ])
    const ch = server.addChannel({ id: fakeMmId('ch', 2), type: 'O', name: 'eng' }, [server.botUser.id, alice.id])

    const messages: NormalizedMessage[] = []
    const clicks: ChatCardClick[] = []
    const conn = createPureWsConn(server, {
      onMessage: (m) => messages.push(m),
      onCardClick: async (click) => {
        clicks.push(click)
        return undefined
      }
    })
    await conn.start()

    expect(mattermostDraftTag()).toMatch(/^D-[0-9A-F]{8}$/)
    const port = mattermostDraftCardPort(conn, INT_ID)

    const taskView = {
      agentName: 'Helper',
      kind: 'task' as const,
      proposal: { sentence: 'Deploy hotfix', why: 'Fix outage' },
      target: { platform: MATTERMOST_PLATFORM, channel: ch.id, isDm: false, external: false, name: 'eng' },
      platformName: 'Mattermost',
      text: 'Run deploy script'
    }
    const taskPostId = await port.postCard(dm.id, {
      draftId: 'draft-task-1',
      agentId: AGENT_ID,
      sessionKey: 'mm:dm',
      view: taskView
    })
    expect(taskPostId).toBeTruthy()
    const taskPost = server.posts.get(taskPostId!)!
    expect(taskPost.props?.attachments).toBeUndefined()
    expect(taskPost.message).toContain('1. Approve\n2. Deny')
    const taskTag = /`(D-[0-9A-F]{8}) 1` or `\1 2`/.exec(taskPost.message ?? '')![1]!

    // Pending update with notice preserves D-XXXXXXXX tag and options.
    await port.updateCard(dm.id, taskPostId!, {
      draftId: 'draft-task-1',
      agentId: AGENT_ID,
      sessionKey: 'mm:dm',
      view: taskView,
      notice: 'Too many sub-sessions running; try again shortly.'
    })
    expect(server.posts.get(taskPostId!)!.message).toContain('Too many sub-sessions running')
    expect(server.posts.get(taskPostId!)!.message).toContain(taskTag)

    // Reply kind renders `2. Discard` and accepts bare `approve` / `discard` / `2` in DM and explicit `D-XXXXXXXX`.
    const replyView = {
      agentName: 'Helper',
      kind: 'elsewhere' as const,
      target: { platform: MATTERMOST_PLATFORM, channel: ch.id, isDm: false, external: false, name: 'eng' },
      platformName: 'Mattermost',
      text: 'Status update'
    }
    const replyPostId = await port.postCard(
      ch.id,
      {
        draftId: 'draft-reply-1',
        agentId: AGENT_ID,
        sessionKey: 'mm:ch',
        view: replyView
      },
      undefined
    )
    expect(replyPostId).toBeTruthy()
    const replyPost = server.posts.get(replyPostId!)!
    expect(replyPost.message).toContain('1. Approve\n2. Discard')
    const replyTag = /`(D-[0-9A-F]{8}) 1`/.exec(replyPost.message ?? '')![1]!

    // Explicit `D-XXXXXXXX approve`, `D-XXXXXXXX deny`, bare `1` in DM, bare `discard` in channel card thread, `D-XXXXXXXX 2`
    server.lastSocket.emitPosted({
      id: server.nextId('p'),
      channel_id: dm.id,
      user_id: alice.id,
      message: `${taskTag} approve`
    })
    await vi.waitFor(() => expect(clicks).toHaveLength(1))
    server.lastSocket.emitPosted({
      id: server.nextId('p'),
      channel_id: dm.id,
      user_id: alice.id,
      message: `${taskTag} deny`
    })
    await vi.waitFor(() => expect(clicks).toHaveLength(2))
    server.lastSocket.emitPosted({
      id: server.nextId('p'),
      channel_id: dm.id,
      user_id: alice.id,
      message: '1'
    })
    await vi.waitFor(() => expect(clicks).toHaveLength(3))
    // Bare `discard` inside the root-posted channel draft card's thread (`root_id = replyPostId`)
    server.lastSocket.emitPosted({
      id: server.nextId('p'),
      channel_id: ch.id,
      root_id: replyPostId,
      user_id: alice.id,
      message: 'discard'
    })
    await vi.waitFor(() => expect(clicks).toHaveLength(4))
    server.lastSocket.emitPosted({
      id: server.nextId('p'),
      channel_id: ch.id,
      user_id: alice.id,
      message: `${replyTag} 2`
    })

    await vi.waitFor(() => expect(clicks).toHaveLength(5))
    expect(clicks.map((c) => c.answer)).toEqual([
      { kind: 'draft', draftId: 'draft-task-1', optionId: 'approve' },
      { kind: 'draft', draftId: 'draft-task-1', optionId: 'discard' },
      { kind: 'draft', draftId: 'draft-task-1', optionId: 'approve' },
      { kind: 'draft', draftId: 'draft-reply-1', optionId: 'discard' },
      { kind: 'draft', draftId: 'draft-reply-1', optionId: 'discard' }
    ])
    expect(messages).toHaveLength(0)

    // Settling with outcome retires the tag.
    await port.updateCard(dm.id, taskPostId!, { view: taskView, outcome: 'Approved by Alice' })
    expect(server.posts.get(taskPostId!)!.message).toContain('Approved by Alice')
    expect(server.posts.get(taskPostId!)!.message).not.toContain(taskTag)

    server.lastSocket.emitPosted({
      id: server.nextId('p'),
      channel_id: dm.id,
      user_id: alice.id,
      message: `${taskTag} 1`
    })
    await vi.waitFor(() => expect(messages).toHaveLength(1))
    expect(clicks).toHaveLength(5)
  })

  it.each([false, true])(
    'settles cards through the daemon when callback is absent or disabled per binding (configured: %s)',
    async (configured) => {
      const server = new FakeMattermostServer()
      const alice = server.addUser({
        id: fakeMmId('alice', 1),
        username: 'alice',
        first_name: 'Alice',
        is_bot: false,
        roles: 'system_user'
      })
      const bob = server.addUser({
        id: fakeMmId('bob', 2),
        username: 'bob',
        first_name: 'Bob',
        is_bot: false,
        roles: 'system_user'
      })
      const ch = server.addChannel({ id: fakeMmId('ch', 1), type: 'O', name: 'eng', display_name: 'Eng' }, [
        server.botUser.id,
        alice.id,
        bob.id
      ])
      const dm = server.addChannel({ id: fakeMmId('dm', 2), type: 'D', name: `${alice.id}__${server.botUser.id}` }, [
        server.botUser.id,
        alice.id
      ])
      const rootPost = server.addPost({ channel_id: ch.id, user_id: alice.id, message: '@acbot run check' })

      const daemon: any = new Daemon({
        slackAppFactory: fakeSlackAppFactory(),
        sandboxMechanism: null,
        ...(configured
          ? {
              mattermostActionCallback: {
                url: 'https://relay.example.test/mattermost/actions',
                secret: 's'.repeat(32),
                daemonId: 'd',
                orgId: 'o'
              }
            }
          : {}),
        mattermostTransport: {
          createSocket: server.createSocket,
          fetchImpl: server.fetchImpl,
          sendIntervalMs: 0
        }
      })
      daemon.cfg = { ...(daemon.cfg ?? {}), webAppUrl: 'https://console.example.test' }
      daemons.push(daemon)
      const store = await LocalStore.open({ database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')) })
      stores.push(store)
      daemon.store = store
      daemon.agents.set(AGENT_ID, {
        id: AGENT_ID,
        name: 'Agent',
        chatActions: 'approve',
        integrations: [
          {
            id: INT_ID,
            platform: MATTERMOST_PLATFORM,
            config: { serverUrl: server.serverUrl, botToken: server.botToken, websocketRepliesOnly: configured },
            core: {
              mode: 'direct',
              bindRules: [],
              mutedChannels: [],
              gated: false,
              sessionModes: [],
              externalChannels: [],
              decisions: { bindings: [], definitions: [] }
            }
          }
        ]
      })

      await daemon.connections.reconcileMattermostConnections()
      const mmConn: MattermostConnection = daemon.mattermostConnByIntegration.get(INT_ID)
      expect(mmConn).toBeDefined()
      expect(mmConn.actionCallback()).toBeUndefined()
      expect(daemon.draftCardPort(INT_ID)).toBeDefined()

      // 1) Approval card flow through PermissionCoordinator + Daemon.answerCardClick
      const hostKey = agentHostKey(AGENT_ID)
      const acpSessionId = 'acp-mm-1'
      const sessKey = `${MATTERMOST_PLATFORM}:${ch.id}:${rootPost.id}:${AGENT_ID}`
      await store.upsertSession({
        key: sessKey,
        agentId: AGENT_ID,
        platform: MATTERMOST_PLATFORM,
        channel: ch.id,
        thread: rootPost.id,
        acpSessionId,
        sessionId: 'out-mm-1',
        state: 'idle',
        lastDeliveredTs: null,
        updatedAt: Date.now()
      })
      const pendingTurn = {
        hostKey,
        acpSessionId,
        outwardSessionId: 'out-mm-1',
        conn: mmConn,
        chrome: {},
        signals: { applyChain: Promise.resolve() },
        approval: { waitMs: 0, depth: 0 },
        knownToolCalls: new Map(),
        builtinSystemToolCallIds: new Set<string>(),
        entry: {
          msg: {
            msgId: `${MATTERMOST_PLATFORM}:${ch.id}:${rootPost.id}`,
            source: 'user',
            platform: MATTERMOST_PLATFORM,
            channel: ch.id,
            thread: rootPost.id,
            sender: { id: alice.id, isBot: false, name: 'alice' },
            text: '@acbot run check',
            externallyShared: false
          }
        },
        plan: {
          platform: MATTERMOST_PLATFORM,
          agentId: AGENT_ID,
          integrationId: INT_ID,
          channel: ch.id,
          transcriptChannel: ch.id,
          thread: rootPost.id,
          sessionThread: rootPost.id,
          statusThread: rootPost.id,
          isDm: false,
          sessionKey: sessKey,
          agentName: 'Agent',
          requesterId: alice.id,
          approvalSurfaceSuppressed: false
        }
      } as unknown as Pending
      daemon.pending.set(pendingTurnKey(hostKey, acpSessionId), pendingTurn)

      vi.spyOn(daemon, 'chatActor').mockImplementation(async (_agentId: unknown, _intId: unknown, actor: any) =>
        actor?.userId === alice.id ? 'allowed' : 'not-editor'
      )

      const permission = {
        ...samplePermission,
        options: [
          samplePermission.options[0]!,
          { optionId: 'always', name: 'Allow always', kind: 'allow_always' as const },
          samplePermission.options[1]!
        ]
      }
      const permPromise = daemon.permissions.onAcpPermission(hostKey, acpSessionId, permission)
      await vi.waitFor(() => {
        const cardPost = [...server.posts.values()].find(
          (p) => p.user_id === server.botUser.id && p.message?.includes('1. Allow once')
        )
        expect(cardPost).toBeDefined()
      })
      const approvalPost = [...server.posts.values()].find(
        (p) => p.user_id === server.botUser.id && p.message?.includes('1. Allow once')
      )!
      const approvalTag = /`(A-[0-9A-F]{8}) <number>`/.exec(approvalPost.message ?? '')![1]!

      // Bob is refused via ephemeral post while the card remains active.
      server.lastSocket.emitPosted({
        id: server.nextId('p'),
        channel_id: ch.id,
        root_id: rootPost.id,
        user_id: bob.id,
        message: `${approvalTag} 1`
      })
      await vi.waitFor(() => expect(server.ephemeralPosts).toHaveLength(1))
      expect(server.ephemeralPosts[0]!.user_id).toBe(bob.id)

      // The requester's bare number resolves the real pending permission in the original thread.
      server.lastSocket.emitPosted({
        id: server.nextId('p'),
        channel_id: ch.id,
        root_id: rootPost.id,
        user_id: alice.id,
        message: configured ? '3' : '1'
      })
      const permResult = await permPromise
      expect(permResult).toEqual({ outcome: { outcome: 'selected', optionId: configured ? 'deny' : 'allow' } })
      await vi.waitFor(() => {
        const updated = server.posts.get(approvalPost.id)!
        expect(updated.message).toContain(configured ? '🚫 Deny — alice' : '✅')
        expect(updated.message).not.toContain(approvalTag)
      })

      // 2) Assistant draft card flow through AssistantDrafts + Daemon.answerCardClick
      const interceptRes = await daemon.drafts.interceptPost(
        AGENT_ID,
        {
          platform: MATTERMOST_PLATFORM,
          integrationId: INT_ID,
          channel: ch.id,
          thread: rootPost.id,
          transportScope: null,
          sessionKey: `${MATTERMOST_PLATFORM}:${ch.id}:${rootPost.id}:${AGENT_ID}`,
          sessionId: 'out-mm-1',
          place: true
        },
        {
          platform: MATTERMOST_PLATFORM,
          integrationId: INT_ID,
          channel: ch.id,
          text: 'Posting external status update',
          directMessage: false
        },
        { integrationId: INT_ID, userId: alice.id }
      )
      expect(interceptRes.handled).toBe(true)
      const draftPost = [...server.posts.values()].find(
        (p) => p.channel_id === dm.id && p.message?.includes('1. Approve\n2. Discard')
      )
      expect(draftPost).toBeDefined()
      const draftTag = /`(D-[0-9A-F]{8}) 1`/.exec(draftPost!.message ?? '')![1]!

      // Alice discards via `D-XXXXXXXX 2` in DM -> settles draft as denied and clears D-tag.
      server.lastSocket.emitPosted({
        id: server.nextId('p'),
        channel_id: dm.id,
        user_id: alice.id,
        message: `${draftTag} 2`
      })
      await vi.waitFor(() => {
        const updated = server.posts.get(draftPost!.id)!
        expect(updated.message).toContain('🗑️ Discarded')
        expect(updated.message).not.toContain(draftTag)
      })
    }
  )
})
