import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk/unstable'
import {
  MATTERMOST_CARD_NOTE_MAX,
  MATTERMOST_PLATFORM,
  verifyMattermostActionToken,
  type RdMsgPlatformAction
} from '@agentconnect.md/protocol'
import { AgentSchema } from '../src/agents/agent-schema.js'
import { Daemon } from '../src/daemon.js'
import { TURN_NOTICE_TEXT } from '../src/platforms/approval-card.js'
import { withCapabilityClick } from '../src/platforms/capability-click.js'
import { mattermostApprovalCards, MATTERMOST_BUTTON_LABEL_CAP } from '../src/platforms/mattermost/approval-card.js'
import {
  mattermostCapabilityCards,
  mattermostCapabilityDeclineReply,
  mattermostCapabilityTag
} from '../src/platforms/mattermost/capability-card.js'
import { MattermostConnection } from '../src/platforms/mattermost/connection.js'
import { mattermostDraftCardPort } from '../src/platforms/mattermost/draft-card.js'
import { mattermostFillCards } from '../src/platforms/mattermost/fill-card.js'
import { createMattermostTurnOutput } from '../src/platforms/mattermost/surface.js'
import {
  MATTERMOST_DM_THREAD,
  decodeMattermostCardClick,
  mattermostCardClicks,
  mattermostPlatformModule,
  sanitizeMattermostCardText
} from '../src/platforms/mattermost/module.js'
import { ChatSessionApplication } from '../src/session/chat-application.js'
import { LocalStore, sessionKey } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'
import { WebchatTransport, type WebchatHost } from '../src/webchat/transport.js'
import { FakeMattermostServer, fakeMmId, quietLog } from './fakes/mattermost-server.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { memoryStoreDatabase, openTestStore } from './store-support.js'

const DAEMON_ID = '11111111-1111-4111-8111-111111111111'
const AGENT_ID = '22222222-2222-4222-8222-222222222222'
const INT_ID = '33333333-3333-4333-8333-333333333333'
const CARD_ID = '44444444-4444-4444-8444-444444444444'
const CALLBACK_SECRET = 'mattermost-test-hmac-secret'
const CALLBACK_CONFIG = {
  url: 'https://relay.example.test/mattermost/actions',
  secret: CALLBACK_SECRET,
  daemonId: DAEMON_ID
}

const WAIT = { timeout: 10_000 }
const daemons: Daemon[] = []
const connections: MattermostConnection[] = []
const stores: LocalStore[] = []
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
  toolCall: { toolCallId: 'tc-1', title: 'Run pwd' }
} as unknown as RequestPermissionRequest

describe('Mattermost approval cards & Relay button decoding', () => {
  it('renders signed alphanumeric buttons when callback is present, settles and clears attachments, and gates missing createPost', async () => {
    const server = new FakeMattermostServer()
    const alice = server.addUser({ id: fakeMmId('alice', 1), username: 'alice', first_name: 'Alice', last_name: 'Ng' })
    const ch = server.addChannel({ id: fakeMmId('ch', 1), type: 'O', name: 'ops' }, [server.botUser.id, alice.id])
    const rootPost = server.addPost({ channel_id: ch.id, user_id: alice.id, message: '@acbot hi' })

    expect(mattermostApprovalCards.canApproveInChat?.(undefined)).toBe(false)
    expect(mattermostApprovalCards.canApproveInChat?.({})).toBe(false)
    expect(
      mattermostApprovalCards.build(
        { requestId: 'req-0', params: samplePermission, via: { agentId: AGENT_ID, integrationId: INT_ID } },
        {}
      )
    ).toBeNull()

    const plainConn = new MattermostConnection(
      {
        serverUrl: server.serverUrl,
        botToken: server.botToken,
        integrations: [{ agentId: AGENT_ID, integrationId: INT_ID }]
      },
      {
        onMessage: () => {},
        log: quietLog,
        createSocket: server.createSocket,
        fetchImpl: server.fetchImpl,
        sendIntervalMs: 0
      }
    )
    connections.push(plainConn)
    await plainConn.start()
    expect(mattermostApprovalCards.canApproveInChat?.(plainConn)).toBe(true)
    const plainDraft = mattermostApprovalCards.build(
      { requestId: 'req-1', params: samplePermission, via: { agentId: AGENT_ID, integrationId: INT_ID } },
      plainConn
    )
    expect(plainDraft).not.toBeNull()

    const cardConn = new MattermostConnection(
      {
        serverUrl: server.serverUrl,
        botToken: server.botToken,
        integrations: [{ agentId: AGENT_ID, integrationId: INT_ID }]
      },
      {
        onMessage: () => {},
        actionCallback: () => CALLBACK_CONFIG,
        log: quietLog,
        createSocket: server.createSocket,
        fetchImpl: server.fetchImpl,
        sendIntervalMs: 0
      }
    )
    connections.push(cardConn)
    await cardConn.start()
    expect(mattermostApprovalCards.canApproveInChat?.(cardConn)).toBe(true)

    const draft = mattermostApprovalCards.build(
      { requestId: 'req-app-1', params: samplePermission, via: { agentId: AGENT_ID, integrationId: INT_ID } },
      cardConn
    )
    expect(draft).not.toBeNull()

    const turnState = { conn: cardConn, channel: ch.id, rootId: rootPost.id, isDm: false }
    const host = {
      postCardSerialized: async (_t: unknown, fn: (c: unknown) => Promise<string | undefined>) => await fn(cardConn),
      sessionTarget: () => undefined,
      turnState: () => turnState
    }
    const turn = {
      conn: cardConn,
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

    const postId = await mattermostApprovalCards.send(host, turn, draft!)
    expect(postId).toBeTruthy()
    const created = server.posts.get(postId!)!
    expect(created.root_id).toBe(rootPost.id)
    expect(created.message).toContain('Run pwd')

    const attachments = created.props?.attachments as Array<{
      actions: Array<{
        id: string
        name: string
        style?: string
        integration: { url: string; context: { token: string } }
      }>
    }>
    expect(attachments).toHaveLength(1)
    const actions = attachments[0]!.actions
    expect(actions.map((a) => [a.id, a.name, a.style])).toEqual([
      ['opt0', 'Allow once', 'good'],
      ['opt1', 'Deny', 'danger']
    ])
    for (const action of actions) {
      expect(action.id).toMatch(/^[a-zA-Z0-9]+$/)
      expect(action.integration.url).toBe(CALLBACK_CONFIG.url)
      const verified = verifyMattermostActionToken(action.integration.context.token, CALLBACK_SECRET)
      expect(verified).toMatchObject({
        daemonId: DAEMON_ID,
        agentId: AGENT_ID,
        integrationId: INT_ID,
        channelId: ch.id,
        kind: 'approval',
        requestId: 'req-app-1'
      })
    }

    mattermostApprovalCards.rewrite(
      { conn: cardConn, channel: ch.id, thread: rootPost.id, ts: postId! },
      mattermostApprovalCards.settled({
        params: samplePermission,
        text: 'Allow once — Alice Ng',
        allowed: true,
        fallback: 'Allowed'
      })
    )
    await vi.waitFor(() => {
      const updated = server.posts.get(postId!)!
      expect(updated.message).toContain('✅ Allow once — Alice Ng')
      expect(updated.props?.attachments).toEqual([])
    }, WAIT)

    expect(await mattermostApprovalCards.nameOf!({ conn: cardConn, channel: ch.id }, alice.id)).toBe('Alice Ng')
    expect(mattermostApprovalCards.answerScope!({ conn: cardConn, channel: ch.id })).toBe(cardConn.workspaceId())
    expect(mattermostApprovalCards.turnNotice()).toBeDefined()
  })

  it('clamps long button labels to prevent RHS overflow, differentiates allow_once vs allow_always styles, and lists full rules in card body', async () => {
    const server = new FakeMattermostServer()
    const alice = server.addUser({ id: fakeMmId('alice', 2), username: 'alice2' })
    const ch = server.addChannel({ id: fakeMmId('ch', 2), type: 'O', name: 'ops2' }, [server.botUser.id, alice.id])
    const rootPost = server.addPost({ channel_id: ch.id, user_id: alice.id, message: '@acbot run' })
    const conn = new MattermostConnection(
      {
        serverUrl: server.serverUrl,
        botToken: server.botToken,
        integrations: [{ agentId: AGENT_ID, integrationId: INT_ID }]
      },
      {
        onMessage: () => {},
        actionCallback: () => CALLBACK_CONFIG,
        log: quietLog,
        createSocket: server.createSocket,
        fetchImpl: server.fetchImpl,
        sendIntervalMs: 0
      }
    )
    connections.push(conn)
    await conn.start()

    const longAlwaysLabel =
      "Yes, and don't ask again for commands that start with `/opt/homebrew/bin/bash -lc 'printf ok'`"
    const longPermission = {
      sessionId: 's-long',
      options: [
        { optionId: 'once', name: 'Yes, proceed', kind: 'allow_once' },
        { optionId: 'always', name: longAlwaysLabel, kind: 'allow_always' },
        { optionId: 'deny', name: 'No, and tell Codex what to do differently', kind: 'reject_once' }
      ],
      toolCall: { toolCallId: 'tc-long', title: "bash -lc 'echo _test_ *all*'" }
    } as unknown as RequestPermissionRequest

    const draft = mattermostApprovalCards.build(
      { requestId: 'req-long', params: longPermission, via: { agentId: AGENT_ID, integrationId: INT_ID } },
      conn
    )!
    const turnState = { conn, channel: ch.id, rootId: rootPost.id, isDm: false }
    const host = {
      postCardSerialized: async (_t: unknown, fn: (c: unknown) => Promise<string | undefined>) => await fn(conn),
      sessionTarget: () => undefined,
      turnState: () => turnState
    }
    const postId = await mattermostApprovalCards.send(
      host,
      {
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
      },
      draft
    )

    const post = server.posts.get(postId!)!
    expect(post.message).toContain("🔒 **Permission requested** — `bash -lc 'echo _test_ *all*'`")
    const backtickDraft = mattermostApprovalCards.build(
      {
        requestId: 'req-backtick',
        params: {
          ...longPermission,
          toolCall: { toolCallId: 'tc-tick', title: 'echo `date`' }
        } as unknown as RequestPermissionRequest,
        via: { agentId: AGENT_ID, integrationId: INT_ID }
      },
      conn
    )!
    const backtickPostId = await mattermostApprovalCards.send(
      host,
      {
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
      },
      backtickDraft
    )
    expect(server.posts.get(backtickPostId!)?.message).toContain('🔒 **Permission requested** — `` echo `date` ``')
    const attachment = (
      post.props?.attachments as Array<{ text: string; actions: Array<{ name: string; style?: string }> }>
    )[0]!
    expect(attachment.text).toContain('1. Yes, proceed')
    expect(attachment.text).toContain(`2. ${longAlwaysLabel}`)
    expect(attachment.text).toContain('3. No, and tell Codex what to do differently')
    expect(attachment.actions.map((a) => [a.name, a.style])).toEqual([
      ['1. Yes, proceed', 'good'],
      [expect.stringMatching(/^2\. Yes, and don't ask again/), 'default'],
      [expect.stringMatching(/^3\. No, and tell Codex/), 'danger']
    ])
    for (const action of attachment.actions) {
      expect(action.name.length).toBeLessThanOrEqual(MATTERMOST_BUTTON_LABEL_CAP)
    }
  })

  it('decodes approval, elicit, and capability clicks via mattermostPlatformModule and formats bounded ephemeral refusals', () => {
    expect(mattermostPlatformModule.cardClicks).toBe(mattermostCardClicks)
    const makeFrame = (payload: Record<string, unknown>): Pick<RdMsgPlatformAction, 'payload'> => ({ payload })

    expect(
      decodeMattermostCardClick(
        makeFrame({
          postId: 'p1',
          channelId: 'ch1',
          userId: 'u1',
          userName: 'Alice',
          kind: 'approval',
          requestId: 'r1',
          option: 1
        })
      )
    ).toEqual({
      answer: { kind: 'approval', requestId: 'r1', option: 1 },
      ts: 'p1',
      actor: { userId: 'u1', name: 'Alice' }
    })

    expect(
      decodeMattermostCardClick(
        makeFrame({
          postId: 'p2',
          channelId: 'ch1',
          userId: 'u2',
          kind: 'elicit',
          requestId: 'r2',
          token: 'e0'
        })
      )
    ).toEqual({
      answer: { kind: 'choice', requestId: 'r2', token: 'e0' },
      ts: 'p2',
      actor: { userId: 'u2' }
    })

    expect(
      decodeMattermostCardClick(
        makeFrame({
          postId: 'p3',
          channelId: 'ch1',
          userId: 'u3',
          kind: 'capability',
          requestId: 'r3',
          cardId: CARD_ID,
          generation: 2
        })
      )
    ).toEqual({
      answer: { kind: 'capabilityDecline', cardId: CARD_ID, generation: 2 },
      ts: 'p3',
      actor: { userId: 'u3' }
    })

    expect(
      decodeMattermostCardClick(
        makeFrame({ kind: 'approval', postId: 'p1', channelId: 'c', userId: 'u', requestId: 'r' })
      )
    ).toBeNull()

    const oversized = 'x'.repeat(MATTERMOST_CARD_NOTE_MAX + 50)
    expect(mattermostCardClicks.response(oversized)).toEqual({
      ephemeralText: 'x'.repeat(MATTERMOST_CARD_NOTE_MAX)
    })
  })

  it('routes Relay capabilityDecline and unknown approval clicks through Daemon.handleRelayCardClick into ephemeralText', async () => {
    const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    daemons.push(daemon)
    const store = await LocalStore.open({ database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')) })
    stores.push(store)
    daemon.store = store
    daemon.agents.set(AGENT_ID, {
      id: AGENT_ID,
      name: 'Agent',
      integrations: [{ id: INT_ID, platform: MATTERMOST_PLATFORM, config: {} }]
    })

    const ackApproval: any = await daemon.handleRelayCardClick(
      {
        source: 'platform_action',
        platformId: MATTERMOST_PLATFORM,
        agentId: AGENT_ID,
        sessionKey: 'mm:ch1:root',
        integrationId: INT_ID,
        botId: INT_ID,
        msgId: 'mm-act-1',
        payload: {
          postId: 'post1',
          channelId: 'ch1',
          userId: 'alice-mm',
          userName: 'Alice',
          kind: 'approval',
          requestId: 'missing-request-id',
          option: 0
        }
      },
      mattermostCardClicks
    )
    expect(ackApproval.accepted).toBe(true)
    if (ackApproval.response !== undefined) {
      expect(ackApproval.response).toHaveProperty('ephemeralText')
    }

    const fakeMmConn = { postEphemeral: vi.fn(async () => {}) }
    daemon.mattermostConnByIntegration.set(INT_ID, fakeMmConn)
    vi.spyOn(daemon, 'declineCapabilityCard').mockImplementation(async () => {
      await mattermostCapabilityCards.tellPrivately(
        { conn: fakeMmConn, channel: 'ch1' },
        'alice-mm',
        'Only editors can decline'
      )
    })

    const ackCap = await daemon.handleRelayCardClick(
      {
        source: 'platform_action',
        platformId: MATTERMOST_PLATFORM,
        agentId: AGENT_ID,
        sessionKey: 'mm:ch1:root',
        integrationId: INT_ID,
        botId: INT_ID,
        msgId: 'mm-act-2',
        payload: {
          postId: 'post2',
          channelId: 'ch1',
          userId: 'alice-mm',
          userName: 'Alice',
          kind: 'capability',
          requestId: 'req-cap-1',
          cardId: CARD_ID,
          generation: 1
        }
      },
      mattermostCardClicks
    )
    expect(ackCap).toEqual({
      msgId: 'mm-act-2',
      accepted: true,
      response: { ephemeralText: 'Only editors can decline' }
    })
    expect(fakeMmConn.postEphemeral).not.toHaveBeenCalled()
  })

  it('routes pure-WS connections with createPost to approval cards and falls back to notice without createPost', () => {
    const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    daemons.push(daemon)
    daemon.agents.set(AGENT_ID, {
      id: AGENT_ID,
      name: 'Agent',
      chatActions: 'approve',
      integrations: [{ id: INT_ID, platform: MATTERMOST_PLATFORM, config: {} }]
    })
    const routeNoCreatePost = daemon.permissions.chatApprovalRoute(AGENT_ID, {
      plan: { platform: MATTERMOST_PLATFORM, agentId: AGENT_ID, integrationId: INT_ID, channel: 'ch1' },
      entry: { msg: { externallyShared: false } },
      conn: { actionCallback: () => undefined }
    })
    expect(routeNoCreatePost).toEqual({ to: 'none' })
    const routePureWs = daemon.permissions.chatApprovalRoute(AGENT_ID, {
      plan: { platform: MATTERMOST_PLATFORM, agentId: AGENT_ID, integrationId: INT_ID, channel: 'ch1' },
      entry: { msg: { externallyShared: false } },
      conn: { actionCallback: () => undefined, createPost: vi.fn() }
    })
    expect(routePureWs).toEqual({ to: 'card', facet: mattermostApprovalCards })
    expect((mattermostApprovalCards.turnNotice() as any).render({ conn: {}, channel: 'ch1' })).toEqual({
      text: TURN_NOTICE_TEXT
    })
  })
})

describe('Mattermost capability cards & ChatSessionContinuation mirroring', () => {
  it('renders capability button + C-tag, captures click refusal via withCapabilityClick, falls back to postEphemeral, and clears on settle', async () => {
    const server = new FakeMattermostServer()
    const alice = server.addUser({ id: fakeMmId('alice', 1), username: 'alice', is_bot: false, first_name: 'Alice' })
    const ch = server.addChannel({ id: fakeMmId('ch', 1), type: 'O', name: 'general' }, [server.botUser.id, alice.id])
    const dm = server.addChannel({ id: fakeMmId('dm', 2), type: 'D', name: `${alice.id}__${server.botUser.id}` }, [
      server.botUser.id,
      alice.id
    ])
    const rootPost = server.addPost({ channel_id: ch.id, user_id: alice.id, message: '@acbot help' })

    let callback: typeof CALLBACK_CONFIG | undefined = CALLBACK_CONFIG
    const conn = new MattermostConnection(
      {
        serverUrl: server.serverUrl,
        botToken: server.botToken,
        integrations: [{ agentId: AGENT_ID, integrationId: INT_ID }]
      },
      {
        onMessage: () => {},
        actionCallback: () => callback,
        log: quietLog,
        createSocket: server.createSocket,
        fetchImpl: server.fetchImpl,
        sendIntervalMs: 0
      }
    )
    connections.push(conn)
    await conn.start()

    const model = {
      requestId: 'cap-req-1',
      generation: 1,
      cardId: CARD_ID,
      summary: 'Read Gmail',
      reason: 'Need inbox access',
      link: 'https://console.example.test/requests/cap-req-1',
      agentName: 'Agent',
      via: { agentId: AGENT_ID, integrationId: INT_ID, sessionKey: `mattermost:${ch.id}:${rootPost.id}` }
    }
    const draft = mattermostCapabilityCards.build(model)
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

    const postId = await mattermostCapabilityCards.send(host, turn, draft)
    expect(postId).toBeTruthy()
    const created = server.posts.get(postId!)!
    const attachments = created.props?.attachments as Array<{ actions: Array<{ id: string; name: string }> }>
    expect(attachments[0]!.actions[0]!.id).toBe('decline')

    const clickedLines = await withCapabilityClick(conn, alice.id, { name: 'Alice' }, async () => {
      await mattermostCapabilityCards.tellPrivately(
        { conn, channel: ch.id, thread: rootPost.id },
        alice.id,
        'Not allowed'
      )
    })
    expect(clickedLines).toEqual(['Not allowed'])
    expect(server.ephemeralPosts).toHaveLength(0)

    await mattermostCapabilityCards.tellPrivately(
      { conn, channel: ch.id, thread: rootPost.id },
      alice.id,
      'Reply refusal'
    )
    expect(server.ephemeralPosts).toHaveLength(1)
    expect(server.ephemeralPosts[0]!.message).toBe('Reply refusal')

    const rewriteResult = await mattermostCapabilityCards.rewrite(
      { conn, channel: ch.id, thread: rootPost.id, ts: postId! },
      mattermostCapabilityCards.settled(model, { status: 'declined', by: 'Alice' })
    )
    expect(rewriteResult).toBe('edited')
    expect(server.posts.get(postId!)!.props?.attachments).toEqual([])

    // Pure-WS fallback mode (without callback): includes C-tag decline hint and parses decline replies.
    callback = undefined
    const dmPostId = await mattermostCapabilityCards.post(
      conn,
      { channel: dm.id },
      mattermostCapabilityCards.build(model),
      {
        agentName: 'Agent'
      }
    )
    expect(dmPostId).toBeTruthy()
    expect(server.posts.get(dmPostId!)!.message).toMatch(/Reply with `C-[0-9A-F]{8} decline` \(or `1`\) to decline\./)
    expect(server.posts.get(dmPostId!)!.root_id).toBe('')

    expect(mattermostCapabilityTag()).toMatch(/^C-[0-9A-F]{8}$/)
    expect(mattermostCapabilityDeclineReply('decline')).toBe(true)
    expect(mattermostCapabilityDeclineReply('1')).toBe(true)
    expect(mattermostCapabilityDeclineReply('C-8F2A1B0C decline')).toBe(true)
    expect(mattermostCapabilityDeclineReply('@acbot 1')).toBe(true)
    expect(mattermostCapabilityDeclineReply('please go ahead')).toBe(false)

    expect(await mattermostCapabilityCards.openDirectMessage(conn, alice.id)).toBe(dm.id)
    expect(await mattermostCapabilityCards.directMessageWith(conn, dm.id)).toBe(alice.id)
    expect(await mattermostCapabilityCards.directMessageWith(conn, ch.id)).toBeNull()
    expect(await mattermostCapabilityCards.isPerson(conn, alice.id)).toBe(true)
    expect(await mattermostCapabilityCards.isPerson(conn, server.botUser.id)).toBe(false)
    expect(await mattermostCapabilityCards.nameOf(conn, alice.id)).toBe('Alice')
  })

  it('mirrors Console continuation turns to Mattermost channel threads and DMs', async () => {
    const server = new FakeMattermostServer()
    const alice = server.addUser({ id: fakeMmId('alice', 1), username: 'alice' })
    const ch = server.addChannel({ id: fakeMmId('ch', 1), type: 'O', name: 'eng' }, [server.botUser.id, alice.id])
    const dm = server.addChannel({ id: fakeMmId('dm', 2), type: 'D', name: `${alice.id}__${server.botUser.id}` }, [
      server.botUser.id,
      alice.id
    ])
    const chRoot = server.addPost({ channel_id: ch.id, user_id: alice.id, message: 'Start thread' })

    const conn = new MattermostConnection(
      {
        serverUrl: server.serverUrl,
        botToken: server.botToken,
        integrations: [{ agentId: AGENT_ID, integrationId: INT_ID }]
      },
      {
        onMessage: () => {},
        log: quietLog,
        createSocket: server.createSocket,
        fetchImpl: server.fetchImpl,
        sendIntervalMs: 0
      }
    )
    connections.push(conn)
    await conn.start()

    const store = await openTestStore({ database: memoryStoreDatabase() })
    stores.push(store)

    const chSessionKey = sessionKey(MATTERMOST_PLATFORM, ch.id, chRoot.id, AGENT_ID, 'account')
    await store.upsertSession({
      key: chSessionKey,
      agentId: AGENT_ID,
      platform: MATTERMOST_PLATFORM,
      channel: ch.id,
      thread: chRoot.id,
      transportScope: 'account',
      sessionId: 'outward-ch',
      acpSessionId: 'acp-ch',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    })

    const dmSessionKey = sessionKey(MATTERMOST_PLATFORM, dm.id, MATTERMOST_DM_THREAD, AGENT_ID, 'account')
    await store.upsertSession({
      key: dmSessionKey,
      agentId: AGENT_ID,
      platform: MATTERMOST_PLATFORM,
      channel: dm.id,
      thread: MATTERMOST_DM_THREAD,
      transportScope: 'account',
      sessionId: 'outward-dm',
      acpSessionId: 'acp-dm',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    })

    const agents = new Map([
      [
        AGENT_ID,
        {
          ...AgentSchema.parse({
            id: AGENT_ID,
            name: 'Agent',
            runtime: 'claude',
            workspace: { mode: 'from-scratch', path: '/tmp/mm-continuation' }
          }),
          dir: '/tmp/mm-continuation'
        }
      ]
    ])
    const host: WebchatHost = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      now: () => 1_000,
      store: () => store,
      agents: () => agents,
      mergedRules: () => [],
      paused: () => false,
      startFailure: () => undefined,
      safetyDraining: () => false,
      draining: () => false,
      agentDraining: () => false,
      turnFinalContextRefresh: () => true,
      holdContextForOwnTurn: vi.fn(),
      inflight: () => new Set(),
      serialQueue: () => new Map(),
      pending: () => new Map(),
      activeGateEntries: () => new Map(),
      interruptTurn: vi.fn(async () => {}),
      dispatch: vi.fn(async (_a, _m, _i, _w, _c, options) => {
        options?.onAdmission?.({ accepted: true })
        await options?.admissionWait
        return null
      }),
      integrationIdForSessionTransport: () => INT_ID,
      connForIntegration: () => conn,
      botUserIds: () => ({ mattermost: server.botUser.id }),
      resolveCpAgent: () => null,
      sendWebchatPost: vi.fn(),
      collabAdmits: () => true
    }

    const application = new ChatSessionApplication({ ...host, queueFull: () => false })
    const transport = new WebchatTransport(host, application)
    const sink = { output: vi.fn(), done: vi.fn() }
    const author = { id: 'console-user', name: 'Alice' }

    const resCh = await transport.dispatchWebchatContinuationTurn(
      AGENT_ID,
      '55555555-5555-4555-8555-555555555555',
      'outward-ch',
      'continue in channel thread',
      author,
      sink,
      'turn-mm-ch'
    )
    expect(resCh).toEqual({ accepted: true, turnId: 'turn-mm-ch' })

    const resDm = await transport.dispatchWebchatContinuationTurn(
      AGENT_ID,
      '66666666-6666-4666-8666-666666666666',
      'outward-dm',
      'continue in dm',
      author,
      sink,
      'turn-mm-dm'
    )
    expect(resDm).toEqual({ accepted: true, turnId: 'turn-mm-dm' })

    const mirrored = [...server.posts.values()].filter((p) => p.user_id === server.botUser.id)
    expect(mirrored.map((p) => [p.channel_id, p.root_id, p.message])).toEqual([
      [ch.id, chRoot.id, '💬 **Alice** _(via console)_'],
      [dm.id, '', '💬 **Alice** _(via console)_']
    ])
    expect(mirrored.map((p) => (p.props?.attachments as Array<{ color?: string; text?: string }>)?.[0])).toEqual([
      {
        color: '#6366F1',
        text: 'continue in channel thread',
        fallback: '[Alice via console] continue in channel thread'
      },
      { color: '#6366F1', text: 'continue in dm', fallback: '[Alice via console] continue in dm' }
    ])
    expect(mirrored[0]!.props?.agentconnect_thread_event).toMatchObject({
      author_agent_id: AGENT_ID,
      delivery_state: 'final'
    })
  })
})

describe('Mattermost Fill cards and Assistant Draft cards', () => {
  it('renders, posts, and settles mattermostFillCards with defused Markdown and exposes it on turn output surface', async () => {
    const server = new FakeMattermostServer()
    const alice = server.addUser({ id: fakeMmId('alice', 1), username: 'alice' })
    const ch = server.addChannel({ id: fakeMmId('ch', 1), type: 'O', name: 'eng' }, [server.botUser.id, alice.id])
    const rootPost = server.addPost({ channel_id: ch.id, user_id: alice.id, message: '@acbot fill form' })
    const conn = new MattermostConnection(
      {
        serverUrl: server.serverUrl,
        botToken: server.botToken,
        integrations: [{ agentId: AGENT_ID, integrationId: INT_ID }]
      },
      {
        onMessage: () => {},
        log: quietLog,
        createSocket: server.createSocket,
        fetchImpl: server.fetchImpl,
        sendIntervalMs: 0
      }
    )
    connections.push(conn)
    await conn.start()

    const surface = createMattermostTurnOutput({
      recordReplySegment: vi.fn(async () => {}),
      appendTranscript: vi.fn(async () => {}),
      nowUs: () => 0,
      warn: vi.fn()
    })
    expect(surface.fillCards).toBe(mattermostFillCards)

    const model = {
      requestId: 'fill-1',
      agentName: 'Helper',
      computerName: 'Workstation',
      origin: 'https://portal.example.com',
      fieldCount: 2,
      reason: 'Sign in [fake](https://evil.example)',
      link: 'https://console.example.test/sessions/s1?fill=fill-1'
    }
    const turn = {
      conn,
      plan: {
        platform: MATTERMOST_PLATFORM,
        agentId: AGENT_ID,
        integrationId: INT_ID,
        channel: ch.id,
        thread: rootPost.id,
        statusThread: rootPost.id,
        agentName: 'Helper'
      }
    }
    const host = {
      postCardSerialized: async (_t: unknown, fn: (c: unknown) => Promise<string | undefined>) => await fn(conn),
      sessionTarget: () => undefined,
      turnState: () => ({ conn, channel: ch.id, rootId: rootPost.id, isDm: false })
    }

    const postId = await mattermostFillCards.send(host, turn, mattermostFillCards.build(model))
    expect(postId).toBeTruthy()
    const created = server.posts.get(postId!)!
    expect(created.root_id).toBe(rootPost.id)
    expect(created.message).toContain('[Fill in AgentConnect](https://console.example.test/sessions/s1?fill=fill-1)')
    expect(created.message).toContain('\\[fake\\]')

    const ok = await mattermostFillCards.rewrite(
      { conn, channel: ch.id, thread: rootPost.id, ts: postId! },
      mattermostFillCards.settled(model, 'filled')
    )
    expect(ok).toBe(true)
    expect(server.posts.get(postId!)!.message).toContain('Filled the form on')
  })

  it('posts signed assistant draft cards, settles them clearing buttons, and routes Relay draft clicks', async () => {
    const server = new FakeMattermostServer()
    const alice = server.addUser({
      id: fakeMmId('alice', 1),
      username: 'alice',
      first_name: 'Alice',
      is_bot: false,
      roles: 'system_user'
    })
    const dm = server.addChannel({ id: fakeMmId('dm', 1), type: 'D', name: `${alice.id}__${server.botUser.id}` }, [
      server.botUser.id,
      alice.id
    ])
    const conn = new MattermostConnection(
      {
        serverUrl: server.serverUrl,
        botToken: server.botToken,
        integrations: [{ agentId: AGENT_ID, integrationId: INT_ID }]
      },
      {
        onMessage: () => {},
        actionCallback: () => CALLBACK_CONFIG,
        log: quietLog,
        createSocket: server.createSocket,
        fetchImpl: server.fetchImpl,
        sendIntervalMs: 0
      }
    )
    connections.push(conn)
    await conn.start()

    const port = mattermostDraftCardPort(conn, INT_ID)
    expect(port.scope?.()).toBe(conn.workspaceId())
    expect(await port.openDirectMessage(alice.id)).toBe(dm.id)
    expect(await port.isFullMember(alice.id)).toBe(true)
    expect(await port.isPerson?.(alice.id)).toBe(true)
    expect(await port.nameOf?.(alice.id)).toBe('Alice')
    expect(await port.directMessageWith?.(dm.id)).toBe(alice.id)

    const draftId = '55555555-5555-4555-8555-555555555555'
    const view = {
      agentName: 'Helper',
      kind: 'task' as const,
      proposal: { sentence: 'Deploy hotfix', why: 'Fix outage' },
      target: { platform: MATTERMOST_PLATFORM, channel: dm.id, isDm: false, external: false, name: 'eng' },
      platformName: 'Mattermost',
      text: 'Run deploy script',
      sessionUrl: 'https://console.example.test/sessions/s1'
    }
    const cardId = await port.postCard(dm.id, {
      draftId,
      agentId: AGENT_ID,
      sessionKey: 'mm:dm',
      view
    })
    expect(cardId).toBeTruthy()
    const created = server.posts.get(cardId!)!
    const attachments = created.props?.attachments as Array<{
      actions: Array<{ id: string; name: string; integration: { context: { token: string } } }>
    }>
    expect(attachments[0]!.actions.map((a) => [a.id, a.name])).toEqual([
      ['approve', 'Approve'],
      ['discard', 'Deny']
    ])
    expect(
      verifyMattermostActionToken(attachments[0]!.actions[0]!.integration.context.token, CALLBACK_SECRET)
    ).toMatchObject({ kind: 'draft', requestId: draftId, token: 'approve' })

    expect(
      decodeMattermostCardClick({
        payload: {
          postId: cardId!,
          channelId: dm.id,
          userId: alice.id,
          userName: 'Alice',
          kind: 'draft',
          requestId: draftId,
          token: 'approve'
        }
      })
    ).toEqual({
      answer: { kind: 'draft', draftId, optionId: 'approve' },
      ts: cardId,
      actor: { userId: alice.id, name: 'Alice' }
    })

    const updated = await port.updateCard(dm.id, cardId!, { view, outcome: 'Approved by Alice' })
    expect(updated).toBe(true)
    expect(server.posts.get(cardId!)!.props?.attachments).toEqual([])
    expect(server.posts.get(cardId!)!.message).toContain('Approved by Alice')

    const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    daemons.push(daemon)
    const store = await LocalStore.open({ database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')) })
    stores.push(store)
    daemon.store = store
    daemon.agents.set(AGENT_ID, {
      id: AGENT_ID,
      name: 'Agent',
      integrations: [{ id: INT_ID, platform: MATTERMOST_PLATFORM, config: {} }]
    })
    daemon.mattermostConnByIntegration.set(INT_ID, conn)
    expect(daemon.draftCardPort(INT_ID)).toBeDefined()

    const handleChoice = vi.spyOn(daemon.drafts, 'handleChoice').mockResolvedValue(true)
    const ack = await daemon.handleRelayCardClick(
      {
        source: 'platform_action',
        platformId: MATTERMOST_PLATFORM,
        agentId: AGENT_ID,
        sessionKey: 'mm:dm',
        integrationId: INT_ID,
        botId: INT_ID,
        msgId: 'mm-draft-act-1',
        payload: {
          postId: cardId!,
          channelId: dm.id,
          userId: alice.id,
          userName: 'Alice',
          kind: 'draft',
          requestId: draftId,
          token: 'approve'
        }
      },
      mattermostCardClicks
    )
    expect(ack).toEqual({ msgId: 'mm-draft-act-1', accepted: true })
    expect(handleChoice).toHaveBeenCalledWith({
      requestId: draftId,
      optionId: 'approve',
      agentId: AGENT_ID,
      integrationId: INT_ID,
      actor: { userId: alice.id, name: 'Alice', isBot: false }
    })

    // Pure-WS draftCardPort + Daemon.answerCardClick integration (no actionCallback configured)
    const pureWsServer = new FakeMattermostServer()
    const pureAlice = pureWsServer.addUser({
      id: fakeMmId('alice', 2),
      username: 'alice',
      is_bot: false,
      roles: 'system_user'
    })
    const pureDm = pureWsServer.addChannel(
      { id: fakeMmId('dm', 3), type: 'D', name: `${pureAlice.id}__${pureWsServer.botUser.id}` },
      [pureWsServer.botUser.id, pureAlice.id]
    )
    const pureDaemon: any = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      sandboxMechanism: null,
      mattermostTransport: {
        createSocket: pureWsServer.createSocket,
        fetchImpl: pureWsServer.fetchImpl,
        sendIntervalMs: 0
      }
    })
    daemons.push(pureDaemon)
    pureDaemon.store = store
    pureDaemon.agents.set(AGENT_ID, {
      id: AGENT_ID,
      name: 'Agent',
      integrations: [
        {
          id: INT_ID,
          platform: MATTERMOST_PLATFORM,
          config: { serverUrl: pureWsServer.serverUrl, botToken: pureWsServer.botToken }
        }
      ]
    })
    await pureDaemon.connections.reconcileMattermostConnections()
    const pureHandleChoice = vi.spyOn(pureDaemon.drafts, 'handleChoice').mockResolvedValue(true)
    const purePort = pureDaemon.draftCardPort(INT_ID)
    expect(purePort).toBeDefined()
    const pureDraftId = '66666666-6666-4666-8666-666666666666'
    const pureCardId = await purePort!.postCard(pureDm.id, {
      draftId: pureDraftId,
      agentId: AGENT_ID,
      sessionKey: 'mm:dm',
      view
    })
    expect(pureCardId).toBeTruthy()
    const pureTag = /`(D-[0-9A-F]{8}) 1`/.exec(pureWsServer.posts.get(pureCardId!)!.message ?? '')![1]!

    pureWsServer.lastSocket.emitPosted({
      id: pureWsServer.nextId('p'),
      channel_id: pureDm.id,
      user_id: pureAlice.id,
      message: `${pureTag} 1`
    })
    await vi.waitFor(
      () =>
        expect(pureHandleChoice).toHaveBeenCalledWith({
          requestId: pureDraftId,
          optionId: 'approve',
          agentId: AGENT_ID,
          integrationId: INT_ID,
          actor: { userId: pureAlice.id, name: 'alice' }
        }),
      WAIT
    )
    await pureDaemon.connections.dispose()
  })

  it('enforces maxPostSize whole-menu fallback, surrogate-safe clamping, multi-backtick label fences, safe card URLs/sanitization, and fail-closed bot actor checks', async () => {
    const server = new FakeMattermostServer()
    const alice = server.addUser({ id: fakeMmId('alice', 7), username: 'alice7', is_bot: false })
    const botActor = server.addUser({ id: fakeMmId('otherbot', 8), username: 'otherbot', is_bot: true })
    const ch = server.addChannel({ id: fakeMmId('ch', 7), type: 'O', name: 'sec' }, [
      server.botUser.id,
      alice.id,
      botActor.id
    ])
    const conn = new MattermostConnection(
      {
        serverUrl: server.serverUrl,
        botToken: server.botToken,
        integrations: [{ agentId: AGENT_ID, integrationId: INT_ID }]
      },
      {
        onMessage: () => {},
        actionCallback: () => CALLBACK_CONFIG,
        log: quietLog,
        createSocket: server.createSocket,
        fetchImpl: server.fetchImpl,
        sendIntervalMs: 0
      }
    )
    connections.push(conn)
    await conn.start()

    // 25 x 200-char options exceed maxPostSize (4_000) -> build returns null (whole-menu fallback #1811).
    const overflowAsk = {
      requestId: 'req-overflow',
      via: { agentId: AGENT_ID, integrationId: INT_ID },
      params: {
        sessionId: 's-over',
        options: Array.from({ length: 25 }, (_, i) => ({
          optionId: `o-${i}`,
          name: `Option ${i + 1}: ${'r'.repeat(190)}`,
          kind: 'allow_once'
        })),
        toolCall: { toolCallId: 'tc-over', title: 'run tool' }
      } as unknown as RequestPermissionRequest
    }
    expect(mattermostApprovalCards.build(overflowAsk, conn)).toBeNull()

    // Surrogate-pair clamping at 40-char button cap & 200-char rule cap + multi-backtick perm label fence.
    const emoji = '🚀'
    const surrogateAsk = {
      requestId: 'req-surrogate',
      via: { agentId: AGENT_ID, integrationId: INT_ID },
      params: {
        sessionId: 's-surr',
        options: [
          { optionId: 'o1', name: `${'a'.repeat(39)}${emoji}tail`, kind: 'allow_once' },
          { optionId: 'o2', name: `${'b'.repeat(199)}${emoji}tail`, kind: 'allow_always' }
        ],
        toolCall: { toolCallId: 'tc-surr', title: 'echo ``injected``' }
      } as unknown as RequestPermissionRequest
    }
    const surrDraft = mattermostApprovalCards.build(surrogateAsk, conn) as { render(ctx: unknown): any }
    const rendered = surrDraft.render({ conn, channel: ch.id, agentId: AGENT_ID, integrationId: INT_ID })
    expect(rendered.text).toContain('``` echo ``injected`` ```')
    const surrActions = rendered.props.attachments[0].actions as Array<{ name: string }>
    for (const a of surrActions) {
      expect(a.name).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    }
    expect(rendered.props.attachments[0].text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)

    // Unpaired backticks cannot split code spans to leave bare URLs autolinked; balanced spans remain intact.
    expect(sanitizeMattermostCardText('` https://evil.test @channel')).toBe('ˋ `https://evil.test` @\u200bchannel')
    expect(sanitizeMattermostCardText('keep `https://safe.test` intact')).toBe('keep `https://safe.test` intact')

    // Unsafe sessionUrl / model.link schemes are dropped across draft/capability/fill cards and parentheses are encoded.
    const capBad = mattermostCapabilityCards.build({
      requestId: 'cap-bad',
      generation: 1,
      cardId: CARD_ID,
      summary: 'Read',
      reason: 'Need access',
      link: 'javascript:alert(1)',
      agentName: 'Agent',
      via: { agentId: AGENT_ID, integrationId: INT_ID, sessionKey: 'k' }
    }) as { render(ctx: unknown): { text: string } }
    expect(capBad.render({ conn, channel: ch.id }).text).not.toContain('javascript:')

    const capParens = mattermostCapabilityCards.build({
      requestId: 'cap-parens',
      generation: 1,
      cardId: CARD_ID,
      summary: 'Read',
      reason: 'Need access',
      link: 'https://console.example.test/req(1)',
      agentName: 'Agent',
      via: { agentId: AGENT_ID, integrationId: INT_ID, sessionKey: 'k' }
    }) as { render(ctx: unknown): { text: string } }
    expect(capParens.render({ conn, channel: ch.id }).text).toContain(
      '[Open the request](https://console.example.test/req%281%29)'
    )

    // capability-card.isPerson fails closed when getUserProfile errors.
    expect(
      await mattermostCapabilityCards.isPerson(
        { getUserProfile: async () => Promise.reject(new Error('network down')) },
        alice.id
      )
    ).toBe(false)

    // draft-card uses sanitizeMattermostCardText (defuses @channel/@all/@here) and drops unsafe sessionUrl.
    const draftPort = mattermostDraftCardPort(conn, INT_ID)
    const draftPostId = await draftPort.postCard(ch.id, {
      draftId: '77777777-7777-4777-8777-777777777777',
      agentId: AGENT_ID,
      sessionKey: 'mm:ch',
      view: {
        agentName: 'Helper',
        kind: 'reply',
        target: { platform: MATTERMOST_PLATFORM, channel: ch.id, isDm: false, external: false, name: 'sec' },
        platformName: 'Mattermost',
        text: 'Check @channel ` https://evil.test',
        sessionUrl: 'javascript:alert(1)'
      }
    })
    const draftMsg = server.posts.get(draftPostId!)!.message!
    expect(draftMsg).toContain('@\u200bchannel')
    expect(draftMsg).toContain('ˋ `https://evil.test`')
    expect(draftMsg).not.toContain('javascript:')

    // Relayed card click from a Mattermost bot actor is resolved as isBot: true before reaching answerCardClick.
    const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    daemons.push(daemon)
    daemon.agents.set(AGENT_ID, {
      id: AGENT_ID,
      name: 'Agent',
      integrations: [{ id: INT_ID, platform: MATTERMOST_PLATFORM, config: {} }]
    })
    daemon.mattermostConnByIntegration.set(INT_ID, conn)
    const answerSpy = vi.spyOn(daemon, 'answerCardClick').mockResolvedValue(undefined)
    await daemon.handleRelayCardClick(
      {
        source: 'platform_action',
        platformId: MATTERMOST_PLATFORM,
        agentId: AGENT_ID,
        sessionKey: 'mm:ch',
        integrationId: INT_ID,
        botId: INT_ID,
        msgId: 'mm-bot-click',
        payload: {
          postId: 'post1',
          channelId: ch.id,
          userId: botActor.id,
          userName: 'otherbot',
          kind: 'approval',
          requestId: 'req-1',
          option: 0
        }
      },
      mattermostCardClicks
    )
    expect(answerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { userId: botActor.id, name: 'otherbot', isBot: true } }),
      AGENT_ID,
      INT_ID
    )

    // With no connection to look the clicker up, the click is treated as a bot's rather than a person's.
    daemon.mattermostConnByIntegration.delete(INT_ID)
    answerSpy.mockClear()
    await daemon.handleRelayCardClick(
      {
        source: 'platform_action',
        platformId: MATTERMOST_PLATFORM,
        agentId: AGENT_ID,
        sessionKey: 'mm:ch',
        integrationId: INT_ID,
        botId: INT_ID,
        msgId: 'mm-unverified-click',
        payload: {
          postId: 'post1',
          channelId: ch.id,
          userId: 'someuser',
          userName: 'someone',
          kind: 'approval',
          requestId: 'req-1',
          option: 0
        }
      },
      mattermostCardClicks
    )
    expect(answerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { userId: 'someuser', name: 'someone', isBot: true } }),
      AGENT_ID,
      INT_ID
    )
  })
})
