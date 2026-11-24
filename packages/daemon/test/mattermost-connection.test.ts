import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MATTERMOST_RESPONSE_FINAL_EVENT_TAG } from '@agentconnect.md/message'
import type { LoadedAgent } from '../src/agents/load-agents.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import {
  MattermostConnection,
  consolidateMattermost,
  mattermostConnKey,
  splitMattermostPost
} from '../src/platforms/mattermost/connection.js'
import { FakeMattermostServer, fakeMmId, quietLog } from './fakes/mattermost-server.js'

const connections: MattermostConnection[] = []

afterEach(async () => {
  for (const conn of connections.splice(0)) await conn.stop()
})

function setup(opts?: { serverUrl?: string; maxPostSize?: number | string; botUsername?: string }) {
  const server = new FakeMattermostServer({
    ...(opts?.serverUrl ? { serverUrl: opts.serverUrl } : {}),
    ...(opts?.maxPostSize !== undefined ? { maxPostSize: opts.maxPostSize } : {}),
    ...(opts?.botUsername ? { botUser: { username: opts.botUsername } } : {})
  })
  const messages: NormalizedMessage[] = []
  const conn = new MattermostConnection(
    {
      serverUrl: server.serverUrl,
      botToken: server.botToken,
      integrations: [{ agentId: 'agent-1', integrationId: 'int-mm' }]
    },
    {
      onMessage: (msg) => messages.push(msg),
      log: quietLog,
      createSocket: server.createSocket,
      fetchImpl: server.fetchImpl,
      sendIntervalMs: 0
    }
  )
  connections.push(conn)
  return { server, conn, messages }
}

describe('Mattermost connection consolidation and identity', () => {
  it('groups integrations sharing (serverUrl, botToken) and rejects blocked serverUrls', () => {
    const agent = (id: string, config: object) =>
      ({ id, integrations: [{ id: `int-${id}`, platform: 'mattermost', config }] }) as unknown as LoadedAgent

    const groups = consolidateMattermost([
      agent('a', { serverUrl: 'https://mm.example.com/', botToken: 'tok-1', botUserId: 'u1' }),
      agent('b', { serverUrl: 'https://mm.example.com', botToken: 'tok-1', botUsername: 'bot1' }),
      agent('c', { serverUrl: 'https://mm.example.com', botToken: 'tok-2' }),
      agent('d', { serverUrl: 'http://169.254.169.254', botToken: 'tok-3' })
    ])
    expect([...groups.values()].map((g) => g.integrations.map((i) => i.agentId))).toEqual([['a', 'b'], ['c']])
    expect(mattermostConnKey({ serverUrl: 'https://mm.example.com/', botToken: 'tok-1' })).toBe(
      mattermostConnKey({ serverUrl: 'https://mm.example.com', botToken: 'tok-1' })
    )
    expect(mattermostConnKey({ serverUrl: 'https://mm.example.com', botToken: 'tok-1' })).not.toContain('tok-1')
  })

  it('initializes botUserId, botUsername, maxPostSize, and D6 colon-free workspaceId at start', async () => {
    const { server, conn } = setup({
      serverUrl: 'https://mm.example.test/sub/',
      maxPostSize: '16383',
      botUsername: 'helperbot'
    })
    await conn.start()

    expect(conn.connected).toBe(true)
    expect(conn.botUserId).toBe(server.botUser.id)
    expect(conn.botUsername).toBe('helperbot')
    expect(conn.selfName).toBe('helperbot')
    expect(conn.maxPostSize).toBe(16_383)
    expect(conn.workspaceUrl).toBe('https://mm.example.test/sub')

    const expectedAppId = `mm-${createHash('sha256').update('https://mm.example.test/sub').digest('hex').slice(0, 16)}`
    expect(conn.workspaceId()).toBe(expectedAppId)
    expect(conn.workspaceId()).not.toContain(':')
  })
})

describe('Mattermost inbound admission, metadata caching, and question tags', () => {
  it('ignores own posts, parses JSON-stringified posted events, enriches missing metadata, and checks membership', async () => {
    const { server, conn, messages } = setup({ botUsername: 'acbot' })
    const alice = server.addUser({ id: fakeMmId('alice', 1), username: 'alice', is_bot: false })
    const otherBot = server.addUser({ id: fakeMmId('otherbot', 2), username: 'alertbot', is_bot: true })
    const pubCh = server.addChannel(
      { id: fakeMmId('pubch', 1), type: 'O', name: 'ops', display_name: 'Ops', team_id: [...server.teams.keys()][0]! },
      [server.botUser.id, alice.id]
    )
    const dmCh = server.addChannel({ id: fakeMmId('dmch', 2), type: 'D', name: `${alice.id}__${server.botUser.id}` }, [
      server.botUser.id,
      alice.id
    ])
    const gmCh = server.addChannel({ id: fakeMmId('gmch', 3), type: 'G', name: 'gm-group' }, [
      server.botUser.id,
      alice.id,
      otherBot.id
    ])

    await conn.start()

    // Own post must be ignored.
    server.lastSocket.emitPosted({
      id: server.nextId('p'),
      channel_id: pubCh.id,
      user_id: server.botUser.id,
      message: '@acbot self echo'
    })

    // Channel mention via data.mentions JSON string (without @acbot in text)
    const rootPostId = server.nextId('p')
    server.lastSocket.emitPosted(
      { id: rootPostId, channel_id: pubCh.id, user_id: alice.id, message: 'please check alerts', create_at: 1000 },
      { mentions: [server.botUser.id] }
    )

    // Group DM with @acbot text fallback and missing channel_type in WS envelope (resolved via REST)
    server.lastSocket.emitEvent('posted', {
      post: JSON.stringify({
        id: server.nextId('p'),
        channel_id: gmCh.id,
        user_id: otherBot.id,
        message: '@AcBot triage this',
        props: { from_bot: 'true' }
      })
    })

    // DM always admitted
    server.lastSocket.emitPosted({
      id: server.nextId('p'),
      channel_id: dmCh.id,
      user_id: alice.id,
      message: 'hello in dm'
    })

    await vi.waitFor(() => expect(messages).toHaveLength(3))
    const pubMsg = messages.find((m) => m.channel === pubCh.id)
    const gmMsg = messages.find((m) => m.channel === gmCh.id)
    const dmMsg = messages.find((m) => m.channel === dmCh.id)
    expect(pubMsg).toMatchObject({
      channel: pubCh.id,
      thread: rootPostId,
      isDm: false,
      mentionedBots: [server.botUser.id],
      sender: { id: alice.id, isBot: false, name: 'alice' }
    })
    expect(gmMsg).toMatchObject({
      channel: gmCh.id,
      isDm: false,
      isGroupDm: true,
      mentionedBots: [server.botUser.id],
      sender: { id: otherBot.id, isBot: true, name: 'alertbot' }
    })
    expect(dmMsg).toMatchObject({
      channel: dmCh.id,
      isDm: true,
      sender: { id: alice.id, isBot: false, name: 'alice' }
    })

    // Closing post_edited finalization from another agent bot is unwrapped with final tag
    server.lastSocket.emitPostEdited({
      id: server.nextId('p'),
      channel_id: pubCh.id,
      root_id: rootPostId,
      user_id: otherBot.id,
      message: 'All clear now',
      props: {
        from_bot: 'true',
        agentconnect_thread_event: {
          author_agent_id: 'agent-peer',
          response_id: 'resp-9',
          delivery_state: 'final',
          hop_count: 1,
          mentioned_agent_ids: ['agent-1'],
          addressed_anyone: true
        }
      }
    })
    await vi.waitFor(() => expect(messages).toHaveLength(4))
    expect(messages[3]!.ingressEventTag).toBe(MATTERMOST_RESPONSE_FINAL_EVENT_TAG)
    expect(messages[3]!.agentAuthorship?.authorAgentId).toBe('agent-peer')

    // Membership check + WS invalidation
    expect(await conn.hasChannelMember(pubCh.id, alice.id)).toBe(true)
    expect(await conn.hasChannelMember(pubCh.id, fakeMmId('stranger', 9))).toBe(false)
    server.channelMembers.get(pubCh.id)?.delete(alice.id)
    server.lastSocket.emitEvent('user_removed', { channel_id: pubCh.id, user_id: alice.id })
    expect(await conn.hasChannelMember(pubCh.id, alice.id)).toBe(false)
  })

  it('matches live question tags explicitly or by single open question in a thread', async () => {
    const { server, conn, messages } = setup()
    const alice = server.addUser({ id: fakeMmId('alice', 1), username: 'alice', is_bot: false })
    const ch = server.addChannel({ id: fakeMmId('ch', 1), type: 'O', name: 'qa' }, [server.botUser.id, alice.id])
    await conn.start()

    const threadA = server.nextId('p')
    const threadB = server.nextId('p')
    conn.noteQuestionTag(ch.id, 'Q-AAAA1111', threadA)
    conn.noteQuestionTag(ch.id, 'Q-BBBB2222', threadB)
    conn.noteQuestionTag(ch.id, 'Q-CCCC3333', threadB)

    // Bare reply in threadA (1 open question) auto-sets replyTo for numbers (even with @mention), but not normal prose or !commands
    server.lastSocket.emitPosted({
      id: server.nextId('p'),
      channel_id: ch.id,
      root_id: threadA,
      user_id: alice.id,
      message: '@acbot 2'
    })
    server.lastSocket.emitPosted({
      id: server.nextId('p'),
      channel_id: ch.id,
      root_id: threadA,
      user_id: alice.id,
      message: '!stop'
    })
    // Bare reply in threadB (2 open questions) leaves replyTo undefined
    server.lastSocket.emitPosted({
      id: server.nextId('p'),
      channel_id: ch.id,
      root_id: threadB,
      user_id: alice.id,
      message: '1'
    })
    // Tagged reply in threadB resolves exact question tag
    server.lastSocket.emitPosted({
      id: server.nextId('p'),
      channel_id: ch.id,
      root_id: threadB,
      user_id: alice.id,
      message: 'Q-CCCC3333 2'
    })

    await vi.waitFor(() => expect(messages).toHaveLength(4))
    expect(messages[0]!.replyTo).toBe('Q-AAAA1111')
    expect(messages[1]!.replyTo).toBeUndefined()
    expect(messages[2]!.replyTo).toBeUndefined()
    expect(messages[3]!.replyTo).toBe('Q-CCCC3333')

    conn.retireQuestionTag('Q-AAAA1111')
    server.lastSocket.emitPosted({
      id: server.nextId('p'),
      channel_id: ch.id,
      root_id: threadA,
      user_id: alice.id,
      message: '2'
    })
    await vi.waitFor(() => expect(messages).toHaveLength(5))
    expect(messages[4]!.replyTo).toBeUndefined()
  })
})

describe('Mattermost outbound posting, history, channels, conversations, and reactions', () => {
  it('creates, patches (PUT), deletes posts, splits long messages in-thread, and sends typing', async () => {
    const { server, conn } = setup({ maxPostSize: 40 })
    const alice = server.addUser({ id: fakeMmId('alice', 1), username: 'alice', is_bot: false })
    const ch = server.addChannel({ id: fakeMmId('ch', 1), type: 'O', name: 'eng' }, [server.botUser.id, alice.id])
    await conn.start()

    const created = await conn.createPost(ch.id, 'initial', {
      identity: { username: 'Agent X', icon_url: 'https://cdn.example/x.png', agentAuthorId: 'agent-1' }
    })
    expect(created.props?.override_username).toBe('Agent X')
    expect(created.props?.agentconnect_thread_event).toMatchObject({ author_agent_id: 'agent-1' })

    const patched = await conn.patchPost(created.id, 'updated text')
    expect(patched.message).toBe('updated text')

    await conn.sendTyping(ch.id, created.id)
    expect(server.lastSocket.frames('user_typing').at(-1)?.data).toEqual({
      channel_id: ch.id,
      parent_id: created.id
    })

    const longIds = await conn.sendMarkdown(ch.id, 'First paragraph of text.\n\nSecond paragraph that is also long.')
    expect(longIds.length).toBeGreaterThan(1)
    expect(server.posts.get(longIds[1]!)?.root_id).toBe(longIds[0])

    const mentionPostId = await conn.postMentioning(ch.id, 'please review', [alice.id])
    expect(server.posts.get(mentionPostId!)?.message).toBe('@alice please review')
    expect(server.posts.get(mentionPostId!)?.root_id).toBe('')

    const threadedMentionId = await conn.postMentioning(ch.id, 'in thread', [alice.id], undefined, mentionPostId)
    expect(server.posts.get(threadedMentionId!)?.message).toBe('@alice in thread')
    expect(server.posts.get(threadedMentionId!)?.root_id).toBe(mentionPostId)

    expect(await conn.deletePost(created.id)).toBe(true)
    expect(server.posts.get(created.id)?.delete_at).toBeGreaterThan(0)
    expect(await conn.deleteMessage(ch.id, 'nonexistent')).toBe(false)
    expect(splitMattermostPost('hello world', 5).join('')).toBe('hello world')
  })

  it('lists O/P channels, resolves names, reads channel info/members/profiles/history/threads, creates conversations, and reacts', async () => {
    const { server, conn } = setup()
    const alice = server.addUser({
      id: fakeMmId('alice', 1),
      username: 'alice',
      first_name: 'Alice',
      last_name: 'Ng',
      roles: 'system_user',
      timezone: { useAutomaticTimezone: 'true', automaticTimezone: 'Asia/Singapore' }
    })
    const guest = server.addUser({
      id: fakeMmId('guest', 2),
      username: 'guestuser',
      roles: 'system_guest'
    })
    const teamId = [...server.teams.keys()][0]!
    const pub = server.addChannel(
      { id: fakeMmId('pub', 1), type: 'O', name: 'general', display_name: 'General', team_id: teamId, header: 'Topic' },
      [server.botUser.id, alice.id, guest.id]
    )
    const priv = server.addChannel(
      { id: fakeMmId('priv', 2), type: 'P', name: 'secret', display_name: 'Secret', team_id: teamId, shared: true },
      [server.botUser.id, alice.id]
    )
    const dm = server.addChannel({ id: fakeMmId('dm', 3), type: 'D', name: `${alice.id}__${server.botUser.id}` }, [
      server.botUser.id,
      alice.id
    ])
    server.addChannel({ id: fakeMmId('gm', 4), type: 'G', name: 'gm-1' }, [server.botUser.id, alice.id])

    const root = server.addPost({ channel_id: pub.id, user_id: alice.id, message: 'Root question', create_at: 2000 })
    const reply = server.addPost({
      channel_id: pub.id,
      user_id: server.botUser.id,
      root_id: root.id,
      message: 'Bot reply',
      create_at: 2000 // same ms tie-breaker check
    })

    await conn.start()

    // listBotChannels filters O/P only (excludes D and G) and populates spaceId, space, and url
    const botChannels = await conn.listBotChannels()
    expect(botChannels?.map((c) => [c.id, c.isPrivate, c.externalReason, c.spaceId, c.space, c.url])).toEqual([
      [pub.id, false, null, teamId, 'Engineering', 'https://mm.example.test/engineering/channels/general'],
      [priv.id, true, 'externallyShared', teamId, 'Engineering', 'https://mm.example.test/engineering/channels/secret']
    ])
    expect(await conn.resolveChannelName('#General')).toBe(pub.id)
    expect(await conn.resolveChannelName('secret')).toBe(priv.id)

    expect(await conn.getChannelInfo(dm.id)).toMatchObject({ id: dm.id, isIm: true, isPrivate: true, user: alice.id })
    expect(await conn.getChannelInfo(pub.id)).toMatchObject({
      id: pub.id,
      name: 'General',
      isPrivate: false,
      topic: 'Topic'
    })
    expect(await conn.listMembers(pub.id)).toEqual([
      { id: server.botUser.id, name: 'acbot', isBot: true },
      { id: alice.id, name: 'alice', isBot: false },
      { id: guest.id, name: 'guestuser', isBot: false }
    ])
    expect(await conn.listMemberIds(pub.id)).toEqual([server.botUser.id, alice.id, guest.id])
    expect(await conn.getUserProfile(alice.id)).toEqual({
      id: alice.id,
      name: 'alice',
      realName: 'Alice Ng',
      isBot: false,
      timeZone: 'Asia/Singapore'
    })
    expect(await conn.isFullMember(alice.id)).toBe(true)
    expect(await conn.isFullMember(guest.id)).toBe(false)

    // Thread replies: root first even on equal create_at, with permalink
    const replies = await conn.getThreadReplies(pub.id, root.id)
    expect(replies.map((r) => [r.ts, r.text, r.isBot])).toEqual([
      [root.id, 'Root question', false],
      [reply.id, 'Bot reply', true]
    ])
    expect(replies[0]!.link).toBe(`${server.serverUrl}/_redirect/pl/${root.id}`)

    // Channel history
    const history = await conn.getChannelHistory(pub.id, { limit: 1 })
    expect(history.messages).toHaveLength(1)
    expect(history.hasMore).toBe(true)
    expect(history.nextCursor).toBe('1')

    // DM & conversation creation
    expect(await conn.openDirectMessage(alice.id)).toBe(dm.id)
    const createdChan = await conn.createConversation({ name: 'Incident Room', isPrivate: true, users: [alice.id] })
    expect(createdChan.isPrivate).toBe(true)
    expect(server.channels.get(createdChan.id)?.team_id).toBe(teamId)

    // Reactions
    await conn.addReaction(pub.id, root.id, ':thumbsup:')
    expect(await conn.getReactions(pub.id, root.id)).toEqual([
      { name: 'thumbsup', count: 1, users: [server.botUser.id] }
    ])
    // Normalizes wire/DOM post IDs (mattermost:<ch>:<id>, msg-<id>, post_<id>) and rejects cached user IDs.
    await conn.addReaction(pub.id, `mattermost:${pub.id}:${root.id}`, 'rocket')
    await conn.addReaction(pub.id, `msg-${reply.id}`, 'eyes')
    await conn.addReaction(pub.id, `post_${reply.id}`, 'white_check_mark')
    expect(await conn.getReactions(pub.id, `mattermost:${pub.id}:${root.id}`)).toEqual([
      { name: 'thumbsup', count: 1, users: [server.botUser.id] },
      { name: 'rocket', count: 1, users: [server.botUser.id] }
    ])
    expect(await conn.getReactions(pub.id, reply.id)).toEqual([
      { name: 'eyes', count: 1, users: [server.botUser.id] },
      { name: 'white_check_mark', count: 1, users: [server.botUser.id] }
    ])
    await expect(conn.addReaction(pub.id, alice.id, 'rocket')).rejects.toThrow(/is a user ID/)
    await expect(conn.addReaction(pub.id, server.botUser.id, 'rocket')).rejects.toThrow(/is a user ID/)

    // Translates 403 on a nonexistent post (uncached user ID or stale post id) into an actionable post-not-found error, while preserving real 403 on an existing post.
    const missingId = fakeMmId('missing', 99)
    server.enqueueFailure({
      method: 'POST',
      pathPrefix: '/api/v4/reactions',
      status: 403,
      body: { id: 'api.context.permissions.app_error', message: 'You do not have the appropriate permissions.' }
    })
    await expect(conn.addReaction(pub.id, missingId, 'rocket')).rejects.toThrow(/was not found/)

    server.enqueueFailure({
      method: 'POST',
      pathPrefix: '/api/v4/reactions',
      status: 403,
      body: { id: 'api.context.permissions.app_error', message: 'Real permission denied on existing post' }
    })
    await expect(conn.addReaction(pub.id, root.id, 'rocket')).rejects.toThrow(/Real permission denied on existing post/)

    await conn.react(pub.id, root.id, 'seen')
    expect(await conn.getReactions(pub.id, root.id)).toEqual([
      { name: 'thumbsup', count: 1, users: [server.botUser.id] },
      { name: 'rocket', count: 1, users: [server.botUser.id] },
      { name: 'eyes', count: 1, users: [server.botUser.id] }
    ])
    await conn.unreact(pub.id, root.id, 'seen')
    expect(await conn.getReactions(pub.id, root.id)).toEqual([
      { name: 'thumbsup', count: 1, users: [server.botUser.id] },
      { name: 'rocket', count: 1, users: [server.botUser.id] }
    ])
  })
})

describe('Mattermost P0 lifecycle, leave/ephemeral, reconnect catch-up, and 401 revocation', () => {
  it('supports leaveChannel and postEphemeral against API v4', async () => {
    const { server, conn } = setup()
    const alice = server.addUser({ id: fakeMmId('alice', 1), username: 'alice' })
    const ch = server.addChannel({ id: fakeMmId('ch', 1), type: 'O', name: 'eng' }, [server.botUser.id, alice.id])
    const root = server.addPost({ channel_id: ch.id, user_id: alice.id, message: 'hi' })
    await conn.start()

    await conn.postEphemeral(ch.id, alice.id, 'Only for Alice', root.id)
    expect(server.ephemeralPosts).toHaveLength(1)
    expect(server.ephemeralPosts[0]).toMatchObject({
      channel_id: ch.id,
      user_id: alice.id,
      root_id: root.id,
      message: 'Only for Alice'
    })

    await conn.leaveChannel(ch.id)
    expect(server.channelMembers.get(ch.id)?.has(server.botUser.id)).toBe(false)
  })

  it('emits onChannelsChanged and onPlaceExternal from WS channel/member lifecycle events', async () => {
    const server = new FakeMattermostServer()
    const alice = server.addUser({ id: fakeMmId('alice', 1), username: 'alice', is_bot: false })
    const guest = server.addUser({ id: fakeMmId('guest', 2), username: 'guest', roles: 'system_guest' })
    const ch = server.addChannel({ id: fakeMmId('ch', 1), type: 'O', name: 'ops', display_name: 'Ops' }, [alice.id])
    const onChannelsChanged = vi.fn()
    const onPlaceExternal = vi.fn()

    const conn = new MattermostConnection(
      {
        serverUrl: server.serverUrl,
        botToken: server.botToken,
        integrations: [{ agentId: 'agent-1', integrationId: 'int-mm' }]
      },
      {
        onMessage: () => {},
        onChannelsChanged,
        checksJoinedMembers: () => true,
        onPlaceExternal,
        log: quietLog,
        createSocket: server.createSocket,
        fetchImpl: server.fetchImpl,
        sendIntervalMs: 0
      }
    )
    connections.push(conn)
    await conn.start()

    server.lastSocket.emitEvent('user_added', { channel_id: ch.id, user_id: server.botUser.id })
    await vi.waitFor(() => expect(onChannelsChanged).toHaveBeenCalledWith({ channel: ch.id }))

    server.lastSocket.emitEvent('user_added', { channel_id: ch.id, user_id: guest.id })
    await vi.waitFor(() => expect(onPlaceExternal).toHaveBeenCalledWith(ch.id, 'guestMember'))

    server.lastSocket.emitEvent('channel_updated', { channel_id: ch.id })
    server.lastSocket.emitEvent('user_removed', { channel_id: ch.id, user_id: server.botUser.id })
    await vi.waitFor(() => expect(onChannelsChanged.mock.calls.length).toBeGreaterThanOrEqual(3))
  })

  it('catches up missed posts after reconnect in chronological order and deduplicates prior posts', async () => {
    const { server, conn, messages } = setup({ botUsername: 'acbot' })
    const alice = server.addUser({ id: fakeMmId('alice', 1), username: 'alice', is_bot: false })
    const ch = server.addChannel({ id: fakeMmId('ch', 1), type: 'O', name: 'eng', display_name: 'Eng' }, [
      server.botUser.id,
      alice.id
    ])
    await conn.start()

    const baseMs = Date.now()
    const seenPost = server.addPost({
      channel_id: ch.id,
      user_id: alice.id,
      message: '@acbot live post',
      create_at: baseMs + 1_000
    })
    server.lastSocket.emitPosted(seenPost)
    await vi.waitFor(() => expect(messages).toHaveLength(1))

    // Posts created while WS was down (bot's own post must be skipped; missed user posts ordered by create_at).
    const missed1 = server.addPost({
      channel_id: ch.id,
      user_id: alice.id,
      message: '@acbot missed first',
      create_at: baseMs + 2_000
    })
    const missed2 = server.addPost({
      channel_id: ch.id,
      user_id: alice.id,
      message: '@acbot missed second',
      create_at: baseMs + 3_000
    })
    server.addPost({
      channel_id: ch.id,
      user_id: server.botUser.id,
      message: 'bot own echo',
      create_at: baseMs + 3_500
    })

    await conn.catchUpAfterReconnect()
    await vi.waitFor(() => expect(messages).toHaveLength(3))
    expect(messages.map((m) => [m.msgId, m.text])).toEqual([
      [`mattermost:${ch.id}:${seenPost.id}`, '@acbot live post'],
      [`mattermost:${ch.id}:${missed1.id}`, '@acbot missed first'],
      [`mattermost:${ch.id}:${missed2.id}`, '@acbot missed second']
    ])
  })

  it('probes getMe on 401 and invokes onCredentialRevoked once while ignoring non-401 errors', async () => {
    const server = new FakeMattermostServer()
    const ch = server.addChannel({ id: fakeMmId('ch', 1), type: 'O', name: 'eng' }, [server.botUser.id])
    const onCredentialRevoked = vi.fn()
    const conn = new MattermostConnection(
      {
        serverUrl: server.serverUrl,
        botToken: server.botToken,
        integrations: [{ agentId: 'agent-1', integrationId: 'int-mm' }]
      },
      {
        onMessage: () => {},
        onCredentialRevoked,
        log: quietLog,
        createSocket: server.createSocket,
        fetchImpl: server.fetchImpl,
        sendIntervalMs: 0
      }
    )
    connections.push(conn)
    await conn.start()

    // Non-401 (500) must not revoke credentials.
    server.enqueueFailure({ method: 'POST', pathPrefix: '/api/v4/posts', status: 500, body: { message: 'boom' } })
    await expect(conn.createPost(ch.id, 'test')).rejects.toThrow()
    expect(onCredentialRevoked).not.toHaveBeenCalled()

    // 401 on a REST call triggers getMe probe; when getMe also returns 401, revocation fires once.
    server.enqueueFailure({
      method: 'POST',
      pathPrefix: '/api/v4/posts',
      status: 401,
      body: { id: 'api.context.session_expired.app_error', message: 'Invalid or expired session' }
    })
    server.enqueueFailure({
      method: 'GET',
      pathPrefix: '/api/v4/users/me',
      status: 401,
      body: { id: 'api.context.session_expired.app_error', message: 'Invalid or expired session' }
    })
    await expect(conn.createPost(ch.id, 'after revoke')).rejects.toThrow()
    await vi.waitFor(() => expect(onCredentialRevoked).toHaveBeenCalledTimes(1))
    expect(onCredentialRevoked).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'tokens_revoked',
        botUserId: server.botUser.id,
        workspaceId: conn.workspaceId()
      })
    )

    // Subsequent 401s do not duplicate revocation.
    server.enqueueFailure({
      method: 'POST',
      pathPrefix: '/api/v4/posts',
      status: 401,
      body: { message: 'expired' }
    })
    await expect(conn.createPost(ch.id, 'again')).rejects.toThrow()
    expect(onCredentialRevoked).toHaveBeenCalledTimes(1)
  })

  it('refreshes team metadata for newly joined teams in listBotChannels and mirrors Console continuation via postAsAuthor', async () => {
    const server = new FakeMattermostServer({ serverUrl: 'http://localhost:8065', maxPostSize: '300' })
    const alice = server.addUser({ id: fakeMmId('alice', 9), username: 'alice' })
    const initialTeamId = [...server.teams.keys()][0]!
    const ch1 = server.addChannel(
      { id: fakeMmId('ch', 9), team_id: initialTeamId, type: 'O', name: 'general', display_name: 'General' },
      [server.botUser.id, alice.id]
    )
    const conn = new MattermostConnection(
      {
        serverUrl: server.serverUrl,
        botToken: server.botToken,
        integrations: [{ agentId: '22222222-2222-4222-8222-222222222222', integrationId: 'int-mm' }]
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

    // Simulate joining a second team + channel after initial startup.
    const team2Id = fakeMmId('team', 2)
    server.teams.set(team2Id, { id: team2Id, name: 'agentconnect', display_name: 'AgentConnect' })
    const ch2 = server.addChannel(
      { id: fakeMmId('ch', 10), team_id: team2Id, type: 'O', name: 'playground', display_name: 'Agent Playground' },
      [server.botUser.id, alice.id]
    )
    const listed = await conn.listBotChannels()
    expect(listed?.find((c) => c.id === ch2.id)).toMatchObject({
      id: ch2.id,
      name: 'Agent Playground',
      spaceId: team2Id,
      space: 'AgentConnect',
      url: 'http://localhost:8065/agentconnect/channels/playground'
    })

    // Normal postAsAuthor renders distinct author header + indigo attachment card, dropping unsafe iconUrl.
    const rootPost = server.addPost({ channel_id: ch1.id, user_id: alice.id, message: '@acbot hi' })
    const cardRes = await conn.postAsAuthor(
      ch1.id,
      rootPost.id,
      { text: 'follow up', attributedText: '[Alice via console] follow up' },
      { name: 'Alice_Ops [admin]', iconUrl: 'javascript:alert(1)' },
      { agentAuthorId: '22222222-2222-4222-8222-222222222222' }
    )
    const cardPost = server.posts.get(cardRes!.ts)!
    expect(cardPost.message).toBe('💬 **Alice\\_Ops \\[admin\\]** _(via console)_')
    expect((cardPost.props?.attachments as Array<Record<string, unknown>>)[0]).toEqual({
      color: '#6366F1',
      text: 'follow up',
      fallback: '[Alice via console] follow up'
    })

    // Oversized text (> maxPostSize - 200) falls back to multi-post blockquote rather than dropping content.
    const longBody = 'x'.repeat(250)
    const longRes = await conn.postAsAuthor(
      ch1.id,
      rootPost.id,
      { text: longBody, attributedText: `[Bob via console] ${longBody}` },
      { name: 'Bob', iconUrl: 'https://cdn.example.test/avatar.png' }
    )
    expect(longRes).toEqual({ ts: expect.any(String), text: longBody })
    const longPost = server.posts.get(longRes!.ts)!
    expect(longPost.message).toContain('💬 **Bob** _(via console)_')
    expect(longPost.message).toContain('> ')
  })

  it('recovers from invalid reply root_id, sorts thread root first, exposes search threadTs, normalizes unreact, and passes finalized own-bot posts', async () => {
    const messages: unknown[] = []
    const server = new FakeMattermostServer()
    const alice = server.addUser({ id: fakeMmId('alice', 1), username: 'alice', is_bot: false })
    const ch = server.addChannel(
      { id: fakeMmId('ch', 21), team_id: [...server.teams.keys()][0]!, type: 'O', name: 'threads' },
      [server.botUser.id, alice.id]
    )
    const conn = new MattermostConnection(
      {
        serverUrl: server.serverUrl,
        botToken: server.botToken,
        integrations: [{ agentId: '22222222-2222-4222-8222-222222222222', integrationId: 'int-1' }]
      },
      {
        onMessage: (m) => messages.push(m),
        log: quietLog,
        createSocket: server.createSocket,
        fetchImpl: server.fetchImpl,
        sendIntervalMs: 0
      }
    )
    connections.push(conn)
    await conn.start()

    // Parent root + reply: replying to the reply auto-recovers to root_id = root.id instead of failing 400
    const root = server.addPost({ channel_id: ch.id, user_id: alice.id, message: 'root question' })
    const reply = server.addPost({ channel_id: ch.id, user_id: alice.id, root_id: root.id, message: 'nested reply' })
    const recovered = await conn.createPost(ch.id, 'answer in thread', {
      rootId: reply.id,
      identity: { username: 'HelperBot', agentAuthorId: '22222222-2222-4222-8222-222222222222' }
    })
    expect(server.posts.get(recovered.id)?.root_id).toBe(root.id)
    expect(server.posts.get(recovered.id)?.props?.from_webhook).toBe('true')

    // getThreadReplies always returns the root post first even if queried with reply id
    const threadMsgs = await conn.getThreadReplies(ch.id, root.id)
    expect(threadMsgs[0]?.ts).toBe(root.id)

    // searchPublicMessages includes threadTs
    const search = await conn.searchPublicMessages('nested reply')
    expect(search.messages[0]?.threadTs).toBe(root.id)

    // unreact normalizes mattermost:<ch>:<postId>
    await conn.react(ch.id, recovered.id, 'seen')
    await conn.unreact(ch.id, `mattermost:${ch.id}:${recovered.id}`, 'seen')
    expect(server.reactions).toEqual([])

    // Own-bot finalized post_edited passes through while streaming post_edited is ignored
    const streamId = server.nextId('p')
    server.lastSocket.emitPostEdited({
      id: streamId,
      channel_id: ch.id,
      root_id: root.id,
      user_id: server.botUser.id,
      message: 'streaming...',
      props: {
        from_bot: 'true',
        agentconnect_thread_event: {
          author_agent_id: '22222222-2222-4222-8222-222222222222',
          response_id: 'resp-own-1',
          delivery_state: 'streaming',
          hop_count: 0,
          mentioned_agent_ids: []
        }
      }
    })
    server.lastSocket.emitPostEdited({
      id: streamId,
      channel_id: ch.id,
      root_id: root.id,
      user_id: server.botUser.id,
      message: 'final text',
      props: {
        from_bot: 'true',
        agentconnect_thread_event: {
          author_agent_id: '22222222-2222-4222-8222-222222222222',
          response_id: 'resp-own-1',
          delivery_state: 'final',
          hop_count: 0,
          mentioned_agent_ids: ['33333333-3333-4333-8333-333333333333'],
          addressed_anyone: true
        }
      }
    })
    await vi.waitFor(() => expect(messages).toHaveLength(1))
    expect(
      messages[0] as { sender: { appId?: string }; agentAuthorship?: { addressedAnyone?: boolean } }
    ).toMatchObject({
      sender: { id: server.botUser.id, appId: conn.workspaceId() },
      agentAuthorship: { deliveryState: 'final', addressedAnyone: true }
    })
  })

  it('auto-reconnects on heartbeat timeout, runs onReconnect catch-up, advances quiet watermarks, and parses long whitespace card replies in linear time', async () => {
    const server = new FakeMattermostServer()
    const alice = server.addUser({ id: fakeMmId('alice', 11), username: 'alice', is_bot: false })
    const quietCh = server.addChannel({ id: fakeMmId('qch', 1), type: 'O', name: 'quiet', update_at: 100 }, [
      server.botUser.id,
      alice.id
    ])
    const activeCh = server.addChannel({ id: fakeMmId('ach', 2), type: 'O', name: 'active', update_at: 200 }, [
      server.botUser.id,
      alice.id
    ])
    const messages: Array<{ msgId: string; text: string }> = []
    const conn = new MattermostConnection(
      {
        serverUrl: server.serverUrl,
        botToken: server.botToken,
        integrations: [{ agentId: 'agent-1', integrationId: 'int-mm' }]
      },
      {
        onMessage: (m) => messages.push({ msgId: m.msgId, text: m.text }),
        onCardClick: async () => undefined,
        log: quietLog,
        createSocket: server.createSocket,
        fetchImpl: server.fetchImpl,
        timing: {
          heartbeatMs: 20,
          maxMissedPongs: 1,
          retryBaseMs: 15,
          retryMaxMs: 30,
          openTimeoutMs: 500,
          requestTimeoutMs: 500
        },
        sendIntervalMs: 0
      }
    )
    connections.push(conn)
    await conn.start()

    // Register a card reply + question tag, and verify 16,380 spaces without a trailing tag resolves fast without ReDoS.
    conn.noteCardReply({
      tag: 'A-DEADBEEF',
      channel: activeCh.id,
      postId: fakeMmId('card', 1),
      agentId: 'agent-1',
      integrationId: 'int-mm',
      kind: 'approval',
      requestId: 'req-1',
      optionCount: 2
    })
    conn.noteQuestionTag(activeCh.id, 'Q-CAFEBABE')
    const startMs = performance.now()
    server.lastSocket.emitPosted(
      server.addPost({
        channel_id: activeCh.id,
        user_id: alice.id,
        message: `${' '.repeat(16_380)}no-tag`,
        create_at: Date.now()
      })
    )
    await vi.waitFor(() => expect(messages).toHaveLength(1))
    expect(performance.now() - startMs).toBeLessThan(1_000)

    // Quiet channel sees a skipped bot-only post during reconnect catch-up, advancing its watermark.
    const socketBeforeDrop = server.lastSocket
    server.silentPing = true
    const missedPost = server.addPost({
      channel_id: activeCh.id,
      user_id: alice.id,
      message: '@acbot after heartbeat drop',
      create_at: Date.now() + 50
    })
    server.addPost({
      channel_id: quietCh.id,
      user_id: server.botUser.id,
      message: 'bot only update',
      create_at: Date.now() + 60
    })

    // Allow pings to resume once a new socket connects after heartbeat timeout closes socketBeforeDrop.
    await vi.waitFor(() => expect(socketBeforeDrop.readyState).toBe(3), { timeout: 2_000 })
    server.silentPing = false
    await vi.waitFor(() => expect(server.sockets.length).toBeGreaterThanOrEqual(2), { timeout: 2_000 })
    await vi.waitFor(() => expect(messages.some((m) => m.msgId.endsWith(missedPost.id))).toBe(true), {
      timeout: 3_000
    })

    // Subsequent catch-up must query quietCh with a watermark >= the skipped post's create_at (not the old start watermark).
    const beforeCount = server.requests.length
    await conn.catchUpAfterReconnect()
    const quietReqs = server.requests
      .slice(beforeCount)
      .filter((r) => r.path.startsWith(`/api/v4/channels/${quietCh.id}/posts`))
    expect(quietReqs).toHaveLength(1)
    const sinceParam = Number(new URL(quietReqs[0]!.url).searchParams.get('since') ?? '0')
    expect(sinceParam).toBeGreaterThan(Date.now() - 10_000)
  })

  it('freezes pre-disconnect channelWatermarks before concurrent live WS posts arrive on reconnect', async () => {
    const server = new FakeMattermostServer()
    const alice = server.addUser({ id: fakeMmId('alice', 12), username: 'alice', is_bot: false })
    const ch = server.addChannel({ id: fakeMmId('racech', 1), type: 'O', name: 'race' }, [server.botUser.id, alice.id])
    let holdChannels = false
    let notifyChannelsEntered: (() => void) | undefined
    const channelsEntered = new Promise<void>((resolve) => {
      notifyChannelsEntered = resolve
    })
    let releaseChannels: (() => void) | undefined
    const channelsReleased = new Promise<void>((resolve) => {
      releaseChannels = resolve
    })
    const wrappedFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
      if (holdChannels && method.toUpperCase() === 'GET' && url.includes('/api/v4/users/me/channels')) {
        holdChannels = false
        notifyChannelsEntered?.()
        await channelsReleased
      }
      return await server.fetchImpl(input, init)
    }

    const messages: Array<{ msgId: string; text: string }> = []
    const conn = new MattermostConnection(
      {
        serverUrl: server.serverUrl,
        botToken: server.botToken,
        integrations: [{ agentId: 'agent-1', integrationId: 'int-mm' }]
      },
      {
        onMessage: (m) => messages.push({ msgId: m.msgId, text: m.text }),
        log: quietLog,
        createSocket: server.createSocket,
        fetchImpl: wrappedFetch,
        timing: { retryBaseMs: 5, retryMaxMs: 10, openTimeoutMs: 500, requestTimeoutMs: 500 },
        sendIntervalMs: 0
      }
    )
    connections.push(conn)
    await conn.start()

    const baseMs = Date.now() + 5_000
    const seenPost = server.addPost({
      channel_id: ch.id,
      user_id: alice.id,
      message: '@acbot before drop',
      create_at: baseMs + 1_000
    })
    server.lastSocket.emitPosted(seenPost)
    await vi.waitFor(() => expect(messages).toHaveLength(1))

    // Disconnect WS and add outage posts while offline.
    const firstSocket = server.lastSocket
    holdChannels = true
    firstSocket.serverClose()
    const missed1 = server.addPost({
      channel_id: ch.id,
      user_id: alice.id,
      message: '@acbot missed first',
      create_at: baseMs + 2_000
    })
    const missed2 = server.addPost({
      channel_id: ch.id,
      user_id: alice.id,
      message: '@acbot missed second',
      create_at: baseMs + 4_000
    })

    // Wait for reconnect socket auth and paused catchUpOnce(), then deliver a live WS post far ahead of missed posts.
    await vi.waitFor(() => expect(server.sockets.length).toBeGreaterThanOrEqual(2), { timeout: 2_000 })
    await channelsEntered
    expect(conn.connected).toBe(true)

    const livePost = server.addPost({
      channel_id: ch.id,
      user_id: alice.id,
      message: '@acbot live after reconnect',
      create_at: baseMs + 20_000
    })
    server.lastSocket.emitPosted(livePost)
    await vi.waitFor(() => expect(messages).toHaveLength(2))

    const reqBeforeCatchUp = server.requests.length
    releaseChannels?.()
    await vi.waitFor(() => expect(messages).toHaveLength(4), { timeout: 2_000 })

    expect(messages.map((m) => [m.msgId, m.text])).toEqual([
      [`mattermost:${ch.id}:${seenPost.id}`, '@acbot before drop'],
      [`mattermost:${ch.id}:${livePost.id}`, '@acbot live after reconnect'],
      [`mattermost:${ch.id}:${missed1.id}`, '@acbot missed first'],
      [`mattermost:${ch.id}:${missed2.id}`, '@acbot missed second']
    ])

    const catchUpPostReqs = server.requests
      .slice(reqBeforeCatchUp)
      .filter((r) => r.path.startsWith(`/api/v4/channels/${ch.id}/posts`))
    expect(catchUpPostReqs).toHaveLength(1)
    expect(Number(new URL(catchUpPostReqs[0]!.url).searchParams.get('since'))).toBe(baseMs)
  })

  it('pages through >1000 outage posts using before cursors before advancing catch-up watermarks', async () => {
    const { server, conn, messages } = setup({ botUsername: 'acbot' })
    const alice = server.addUser({ id: fakeMmId('alice', 13), username: 'alice', is_bot: false })
    const ch = server.addChannel({ id: fakeMmId('bigch', 1), type: 'O', name: 'high-traffic' }, [
      server.botUser.id,
      alice.id
    ])
    await conn.start()

    const baseMs = Date.now() + 5_000
    // Pre-outage old bot post that also gets an edit timestamp during the outage (helps exercise cursor/bound filtering).
    const oldPost = server.addPost({
      channel_id: ch.id,
      user_id: server.botUser.id,
      message: 'old bot post',
      create_at: baseMs - 60_000,
      update_at: baseMs - 60_000
    })
    const seenPost = server.addPost({
      channel_id: ch.id,
      user_id: alice.id,
      message: '@acbot live watermark post',
      create_at: baseMs + 1_000
    })
    server.lastSocket.emitPosted(seenPost)
    await vi.waitFor(() => expect(messages).toHaveLength(1))

    // Add 1135 outage posts: `since` returns only the newest 1000, so the oldest 135 need `before` pages.
    const missed: Array<ReturnType<typeof server.addPost>> = []
    for (let i = 1; i <= 1_135; i++) {
      missed.push(
        server.addPost({
          channel_id: ch.id,
          user_id: alice.id,
          message: `@acbot missed #${i}`,
          create_at: baseMs + 1_000 + i * 1_000
        })
      )
    }
    oldPost.update_at = baseMs + 1_140_000

    const reqBefore = server.requests.length
    await conn.catchUpAfterReconnect()
    await vi.waitFor(() => expect(messages).toHaveLength(1_136), { timeout: 10_000 })

    expect(messages[0]!.msgId).toBe(`mattermost:${ch.id}:${seenPost.id}`)
    expect(messages.slice(1).map((m) => m.text)).toEqual(missed.map((p) => p.message))

    const postReqs = server.requests
      .slice(reqBefore)
      .filter((r) => r.path.startsWith(`/api/v4/channels/${ch.id}/posts`))
    expect(postReqs).toHaveLength(4)
    expect(new URL(postReqs[0]!.url).searchParams.get('since')).toBe(String(baseMs))
    for (const req of postReqs.slice(1)) expect(new URL(req.url).searchParams.get('before')).toBeTruthy()

    // Now that all pages settled, a follow-up catch-up must advance past oldPost.update_at (baseMs + 1_140_000).
    const reqSecond = server.requests.length
    await conn.catchUpAfterReconnect()
    const nextPostReqs = server.requests
      .slice(reqSecond)
      .filter((r) => r.path.startsWith(`/api/v4/channels/${ch.id}/posts`))
    expect(nextPostReqs).toHaveLength(1)
    expect(Number(new URL(nextPostReqs[0]!.url).searchParams.get('since'))).toBeGreaterThanOrEqual(
      baseMs + 1_140_000 - 1_000
    )
  })

  it('sweeps all >100 joined channels on reconnect and recovers outage posts in channels ranked 105..125 without drops', async () => {
    let clock = 1_770_000_000_000
    const server = new FakeMattermostServer()
    const alice = server.addUser({ id: fakeMmId('alice', 14), username: 'alice', is_bot: false })
    const teamId = [...server.teams.keys()][0]!
    const channels = Array.from({ length: 125 }, (_, i) => {
      const rank = i + 1
      const lastPostAt = clock - rank * 1_000
      if (rank === 124) {
        return server.addChannel(
          { id: fakeMmId('ch', rank), team_id: teamId, type: 'P', name: `priv-${rank}`, last_post_at: lastPostAt },
          [server.botUser.id, alice.id]
        )
      }
      if (rank === 125) {
        return server.addChannel(
          {
            id: fakeMmId('ch', rank),
            type: 'D',
            name: `${alice.id}__${server.botUser.id}`,
            last_post_at: lastPostAt
          },
          [server.botUser.id, alice.id]
        )
      }
      return server.addChannel(
        { id: fakeMmId('ch', rank), team_id: teamId, type: 'O', name: `chan-${rank}`, last_post_at: lastPostAt },
        [server.botUser.id, alice.id]
      )
    })

    const messages: NormalizedMessage[] = []
    const conn = new MattermostConnection(
      {
        serverUrl: server.serverUrl,
        botToken: server.botToken,
        integrations: [{ agentId: 'agent-1', integrationId: 'int-mm' }]
      },
      {
        onMessage: (msg) => messages.push(msg),
        log: quietLog,
        createSocket: server.createSocket,
        fetchImpl: server.fetchImpl,
        timing: { retryBaseMs: 5, retryMaxMs: 10, openTimeoutMs: 500, requestTimeoutMs: 500 },
        now: () => clock,
        sendIntervalMs: 0
      }
    )
    connections.push(conn)
    await conn.start()

    // Simulate WS outage and add missed posts in channels ranked 105..125 by last_post_at.
    server.autoOpen = false
    const reqBeforeReconnect = server.requests.length
    server.lastSocket.serverClose()
    clock += 5_000

    const targetChannels = channels.slice(104)
    const expectedPosts = targetChannels.map((ch, idx) =>
      server.addPost({
        channel_id: ch.id,
        user_id: alice.id,
        message: ch.type === 'D' ? `dm outage ${idx}` : `@acbot outage in rank ${105 + idx}`,
        create_at: clock + 100 + idx
      })
    )

    await vi.waitFor(() => expect(server.sockets.length).toBe(2), { timeout: 2_000 })
    server.autoOpen = true
    server.lastSocket.open()

    await vi.waitFor(() => expect(messages).toHaveLength(expectedPosts.length), { timeout: 5_000 })

    expect(new Set(messages.map((m) => m.msgId))).toEqual(
      new Set(expectedPosts.map((p) => `mattermost:${p.channel_id}:${p.id}`))
    )

    const sweptChannelIds = server.requests
      .slice(reqBeforeReconnect)
      .map((r) => /^\/api\/v4\/channels\/([^/]+)\/posts/.exec(r.path)?.[1])
      .filter((id): id is string => Boolean(id))
    expect(new Set(sweptChannelIds)).toEqual(new Set(channels.map((c) => c.id)))
    // Channels are swept most recently active first, and the outage posts made the last 21 the most recent.
    expect(sweptChannelIds.indexOf(channels[124]!.id)).toBeLessThan(sweptChannelIds.indexOf(channels[0]!.id))
    expect(sweptChannelIds.indexOf(channels[0]!.id)).toBeLessThan(sweptChannelIds.indexOf(channels[103]!.id))
  })

  it('schedules exponential retry on transient 503 catch-up failure, skips clean channels, preserves frozen watermark, and clears pending timer on stop', async () => {
    let clock = 1_770_100_000_000
    const server = new FakeMattermostServer()
    const alice = server.addUser({ id: fakeMmId('alice', 15), username: 'alice', is_bot: false })
    const teamId = [...server.teams.keys()][0]!
    const ch1 = server.addChannel(
      { id: fakeMmId('rchan', 1), team_id: teamId, type: 'O', name: 'clean-1', last_post_at: clock - 100 },
      [server.botUser.id, alice.id]
    )
    const ch2 = server.addChannel(
      { id: fakeMmId('rchan', 2), team_id: teamId, type: 'O', name: 'flaky-2', last_post_at: clock - 200 },
      [server.botUser.id, alice.id]
    )
    const ch3 = server.addChannel(
      { id: fakeMmId('rchan', 3), team_id: teamId, type: 'O', name: 'clean-3', last_post_at: clock - 300 },
      [server.botUser.id, alice.id]
    )

    let emitLiveAfterCh2Failure = false
    let liveCh2Post: ReturnType<typeof server.addPost> | undefined
    const wrappedFetch: typeof fetch = async (input, init) => {
      const res = await server.fetchImpl(input, init)
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (emitLiveAfterCh2Failure && res.status === 503 && url.includes(`/api/v4/channels/${ch2.id}/posts`)) {
        emitLiveAfterCh2Failure = false
        liveCh2Post = server.addPost({
          channel_id: ch2.id,
          user_id: alice.id,
          message: '@acbot live ws ahead of retry',
          create_at: clock + 50_000
        })
        server.lastSocket.emitPosted(liveCh2Post)
      }
      return res
    }

    const messages: NormalizedMessage[] = []
    const conn = new MattermostConnection(
      {
        serverUrl: server.serverUrl,
        botToken: server.botToken,
        integrations: [{ agentId: 'agent-1', integrationId: 'int-mm' }]
      },
      {
        onMessage: (msg) => messages.push(msg),
        log: quietLog,
        createSocket: server.createSocket,
        fetchImpl: wrappedFetch,
        timing: { retryBaseMs: 5, retryMaxMs: 10, openTimeoutMs: 500, requestTimeoutMs: 500 },
        catchUpRetryBaseMs: 20,
        now: () => clock,
        sendIntervalMs: 0
      }
    )
    connections.push(conn)
    await conn.start()

    // Seed pre-outage watermarks via live WS events at t1 = clock + 1_000.
    const t1 = clock + 1_000
    const seen1 = server.addPost({ channel_id: ch1.id, user_id: alice.id, message: '@acbot live 1', create_at: t1 })
    const seen2 = server.addPost({ channel_id: ch2.id, user_id: alice.id, message: '@acbot live 2', create_at: t1 })
    server.lastSocket.emitPosted(seen1)
    server.lastSocket.emitPosted(seen2)
    await vi.waitFor(() => expect(messages).toHaveLength(2))

    // Disconnect WS and inject outage posts plus a transient 503 on ch2's /posts.
    clock += 2_000
    server.autoOpen = false
    const reqBeforeDisconnect = server.requests.length
    server.lastSocket.serverClose()
    const missed1 = server.addPost({
      channel_id: ch1.id,
      user_id: alice.id,
      message: '@acbot missed ch1',
      create_at: clock + 100
    })
    const missed2 = server.addPost({
      channel_id: ch2.id,
      user_id: alice.id,
      message: '@acbot missed ch2',
      create_at: clock + 200
    })
    const missed3 = server.addPost({
      channel_id: ch3.id,
      user_id: alice.id,
      message: '@acbot missed ch3',
      create_at: clock + 300
    })

    emitLiveAfterCh2Failure = true
    server.enqueueFailure({
      method: 'GET',
      pathPrefix: `/api/v4/channels/${ch2.id}/posts`,
      status: 503,
      body: { message: 'Service Unavailable' }
    })

    // Advance clock well past missed2.create_at before reconnect so only a preserved frozen watermark catches missed2.
    clock += 10_000
    await vi.waitFor(() => expect(server.sockets.length).toBe(2), { timeout: 2_000 })
    server.autoOpen = true
    server.lastSocket.open()

    // Wait for automatic retry to deliver missed1, missed3, liveCh2Post, and finally missed2.
    await vi.waitFor(() => expect(messages.some((m) => m.msgId.endsWith(missed2.id))).toBe(true), { timeout: 2_000 })
    expect(messages.map((m) => m.msgId)).toEqual(
      expect.arrayContaining([
        `mattermost:${ch1.id}:${seen1.id}`,
        `mattermost:${ch2.id}:${seen2.id}`,
        `mattermost:${ch1.id}:${missed1.id}`,
        `mattermost:${ch3.id}:${missed3.id}`,
        `mattermost:${ch2.id}:${liveCh2Post!.id}`,
        `mattermost:${ch2.id}:${missed2.id}`
      ])
    )

    // Partition requests by /api/v4/users/me/channels calls after disconnect (pass 1 vs automatic retry pass 2).
    const postDisconnectReqs = server.requests.slice(reqBeforeDisconnect)
    const listIndices = postDisconnectReqs
      .map((r, i) => (r.method === 'GET' && r.path.startsWith('/api/v4/users/me/channels') ? i : -1))
      .filter((i) => i >= 0)
    expect(listIndices.length).toBeGreaterThanOrEqual(2)

    const pass1Reqs = postDisconnectReqs.slice(listIndices[0]!, listIndices[1]!)
    const retryReqs = postDisconnectReqs.slice(listIndices[1]!)
    expect(pass1Reqs.some((r) => r.path.startsWith(`/api/v4/channels/${ch1.id}/posts`))).toBe(true)
    expect(pass1Reqs.some((r) => r.path.startsWith(`/api/v4/channels/${ch2.id}/posts`))).toBe(true)
    expect(pass1Reqs.some((r) => r.path.startsWith(`/api/v4/channels/${ch3.id}/posts`))).toBe(true)

    // Already-clean channels must NOT be re-queried on retry; ch2 must still query from its frozen watermark (t1 - 1_000).
    expect(retryReqs.filter((r) => r.path.startsWith(`/api/v4/channels/${ch1.id}/posts`))).toHaveLength(0)
    expect(retryReqs.filter((r) => r.path.startsWith(`/api/v4/channels/${ch3.id}/posts`))).toHaveLength(0)
    const ch2RetryReqs = retryReqs.filter((r) => r.path.startsWith(`/api/v4/channels/${ch2.id}/posts`))
    expect(ch2RetryReqs).toHaveLength(1)
    expect(Number(new URL(ch2RetryReqs[0]!.url).searchParams.get('since'))).toBe(t1 - 1_000)

    // Verify stop() clears any pending catchUpRetryTimer cleanly.
    const conn2 = new MattermostConnection(
      {
        serverUrl: server.serverUrl,
        botToken: server.botToken,
        integrations: [{ agentId: 'agent-1', integrationId: 'int-mm' }]
      },
      {
        onMessage: () => {},
        log: quietLog,
        createSocket: server.createSocket,
        fetchImpl: server.fetchImpl,
        catchUpRetryBaseMs: 5_000,
        now: () => clock,
        sendIntervalMs: 0
      }
    )
    connections.push(conn2)
    await conn2.start()

    server.enqueueFailure({
      method: 'GET',
      pathPrefix: `/api/v4/channels/${ch2.id}/posts`,
      status: 503,
      body: { message: 'Service Unavailable' }
    })
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    try {
      await conn2.catchUpAfterReconnect()
      const retryCallIdx = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 5_000)
      expect(retryCallIdx).toBeGreaterThanOrEqual(0)
      const retryHandle = setTimeoutSpy.mock.results[retryCallIdx]!.value
      const reqsBeforeStop = server.requests.length
      await conn2.stop()
      expect(clearTimeoutSpy).toHaveBeenCalledWith(retryHandle)
      expect(server.requests.length).toBe(reqsBeforeStop)
    } finally {
      setTimeoutSpy.mockRestore()
      clearTimeoutSpy.mockRestore()
    }
  })

  it('retains >2,000 channel watermarks and falls back to recoveryWatermarks on transient getMyChannels failure', async () => {
    let clock = 1_770_200_000_000
    const server = new FakeMattermostServer()
    const alice = server.addUser({ id: fakeMmId('alice', 16), username: 'alice', is_bot: false })
    const teamId = [...server.teams.keys()][0]!
    const channels = Array.from({ length: 2_050 }, (_, i) =>
      server.addChannel(
        {
          id: fakeMmId('many', i + 1),
          team_id: teamId,
          type: 'O',
          name: `many-${i + 1}`,
          last_post_at: clock - (i + 1)
        },
        [server.botUser.id, alice.id]
      )
    )
    // Channel 0 is evicted from the 2,000-entry `this.channels` LRU cache during start(), so only `channelWatermarks` (cap 50,000) retains it.
    const evictedFromChannelCache = channels[0]!

    const messages: NormalizedMessage[] = []
    const conn = new MattermostConnection(
      {
        serverUrl: server.serverUrl,
        botToken: server.botToken,
        integrations: [{ agentId: 'agent-1', integrationId: 'int-mm' }]
      },
      {
        onMessage: (msg) => messages.push(msg),
        log: quietLog,
        createSocket: server.createSocket,
        fetchImpl: server.fetchImpl,
        timing: { retryBaseMs: 5, retryMaxMs: 10, openTimeoutMs: 500, requestTimeoutMs: 500 },
        catchUpRetryBaseMs: 20,
        now: () => clock,
        sendIntervalMs: 0
      }
    )
    connections.push(conn)
    await conn.start()

    clock += 5_000
    server.autoOpen = false
    server.lastSocket.serverClose()
    const missedInEvicted = server.addPost({
      channel_id: evictedFromChannelCache.id,
      user_id: alice.id,
      message: '@acbot recovered despite getMyChannels 503',
      create_at: clock + 50
    })

    // First reconnect getMyChannels fails 503; pass 1 must still sweep evictedFromChannelCache via recoveryWatermarks and recover its post, then pass 2 completes cleanly.
    server.enqueueFailure({
      method: 'GET',
      pathPrefix: '/api/v4/users/me/channels',
      status: 503,
      body: { message: 'Temporary failure' }
    })

    await vi.waitFor(() => expect(server.sockets.length).toBe(2), { timeout: 2_000 })
    server.autoOpen = true
    server.lastSocket.open()

    await vi.waitFor(
      () =>
        expect(messages.some((m) => m.msgId === `mattermost:${evictedFromChannelCache.id}:${missedInEvicted.id}`)).toBe(
          true
        ),
      { timeout: 5_000 }
    )
  })

  it('transitions from fast backoff to steady catch-up retry during prolonged 503 outage, recovers on stable WS, and cancels steady timer on stop', async () => {
    let clock = 1_770_250_000_000
    const server = new FakeMattermostServer()
    const alice = server.addUser({ id: fakeMmId('alice', 19), username: 'alice', is_bot: false })
    const teamId = [...server.teams.keys()][0]!
    const ch = server.addChannel(
      { id: fakeMmId('steady', 1), team_id: teamId, type: 'O', name: 'steady', last_post_at: clock - 1_000 },
      [server.botUser.id, alice.id]
    )

    const warnLogs: string[] = []
    const messages: NormalizedMessage[] = []
    const conn = new MattermostConnection(
      {
        serverUrl: server.serverUrl,
        botToken: server.botToken,
        integrations: [{ agentId: 'agent-1', integrationId: 'int-mm' }]
      },
      {
        onMessage: (msg) => messages.push(msg),
        log: { ...quietLog, warn: (msg) => warnLogs.push(msg) },
        createSocket: server.createSocket,
        fetchImpl: server.fetchImpl,
        timing: { retryBaseMs: 5, retryMaxMs: 10, openTimeoutMs: 500, requestTimeoutMs: 500 },
        catchUpRetryBaseMs: 1,
        catchUpSteadyRetryMs: 37,
        now: () => clock,
        sendIntervalMs: 0
      }
    )
    connections.push(conn)
    await conn.start()

    // Seed pre-outage watermark at t1.
    const t1 = clock + 1_000
    const seenPost = server.addPost({
      channel_id: ch.id,
      user_id: alice.id,
      message: '@acbot before prolonged outage',
      create_at: t1
    })
    server.lastSocket.emitPosted(seenPost)
    await vi.waitFor(() => expect(messages).toHaveLength(1))

    // Disconnect WS, create outage post, and enqueue 11 consecutive /posts 503s (1 initial + 8 fast + 2 steady failures; attempt #12 recovers).
    clock += 2_000
    server.autoOpen = false
    const reqBeforeDisconnect = server.requests.length
    server.lastSocket.serverClose()
    const missedPost = server.addPost({
      channel_id: ch.id,
      user_id: alice.id,
      message: '@acbot missed during prolonged REST outage',
      create_at: clock + 200
    })
    for (let i = 0; i < 11; i++) {
      server.enqueueFailure({
        method: 'GET',
        pathPrefix: `/api/v4/channels/${ch.id}/posts`,
        status: 503,
        body: { message: 'Service Unavailable' }
      })
    }

    // Advance clock well past missedPost.create_at before reconnect so only frozen recoveryWatermarks can recover it.
    clock += 10_000
    await vi.waitFor(() => expect(server.sockets.length).toBe(2), { timeout: 2_000, interval: 10 })

    let steadyScheduledCount = 0
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    try {
      server.autoOpen = true
      server.lastSocket.open()

      await vi.waitFor(() => expect(conn.connected).toBe(true), { timeout: 2_000, interval: 5 })
      const livePost = server.addPost({
        channel_id: ch.id,
        user_id: alice.id,
        message: '@acbot live ws during steady retry',
        create_at: clock + 50_000
      })
      server.lastSocket.emitPosted(livePost)
      await vi.waitFor(() => expect(messages.some((m) => m.msgId.endsWith(livePost.id))).toBe(true), {
        timeout: 2_000,
        interval: 10
      })

      // Wait for steady-state retry #12 (after >8 fast retries) to recover missedPost on the same stable socket.
      await vi.waitFor(() => expect(messages.some((m) => m.msgId.endsWith(missedPost.id))).toBe(true), {
        timeout: 5_000,
        interval: 20
      })
      steadyScheduledCount = setTimeoutSpy.mock.calls.filter(([, delay]) => delay === 37).length
    } finally {
      setTimeoutSpy.mockRestore()
    }

    // Wait past 2 steady intervals and confirm no extra catch-up retries are scheduled after recovery.
    await new Promise((r) => setTimeout(r, 80))

    expect(server.sockets).toHaveLength(2)
    const postReqs = server.requests
      .slice(reqBeforeDisconnect)
      .filter((r) => r.path.startsWith(`/api/v4/channels/${ch.id}/posts`))
    expect(postReqs).toHaveLength(12)
    // recoveryWatermarks stayed frozen at t1 (since = t1 - 1_000) across fast retries, steady retries, and recovery despite livePost.
    for (const req of postReqs) {
      expect(Number(new URL(req.url).searchParams.get('since'))).toBe(t1 - 1_000)
    }

    expect(steadyScheduledCount).toBe(3)
    const steadyWarns = warnLogs.filter((msg) => msg.includes('fast retries; falling back to steady'))
    expect(steadyWarns).toHaveLength(1)

    // Verify recoveryWatermarks was cleared on recovery: a follow-up catch-up now uses the advanced channel watermark, not t1.
    const reqBeforeFollowUp = server.requests.length
    await conn.catchUpAfterReconnect()
    const followUpReqs = server.requests
      .slice(reqBeforeFollowUp)
      .filter((r) => r.path.startsWith(`/api/v4/channels/${ch.id}/posts`))
    expect(followUpReqs).toHaveLength(1)
    expect(Number(new URL(followUpReqs[0]!.url).searchParams.get('since'))).toBeGreaterThanOrEqual(
      clock + 50_000 - 1_000
    )

    // Verify WS drop/reconnect resets catchUpRetryCount back to fast backoff and stop() cancels an active steady-state retry timer cleanly.
    const stopServer = new FakeMattermostServer()
    const stopCh = stopServer.addChannel({ id: fakeMmId('cap', 1), type: 'O', name: 'cap' }, [stopServer.botUser.id])
    const stopConn = new MattermostConnection(
      {
        serverUrl: stopServer.serverUrl,
        botToken: stopServer.botToken,
        integrations: [{ agentId: 'agent-1', integrationId: 'int-mm' }]
      },
      {
        onMessage: () => {},
        log: quietLog,
        createSocket: stopServer.createSocket,
        fetchImpl: stopServer.fetchImpl,
        timing: { retryBaseMs: 5, retryMaxMs: 10, openTimeoutMs: 500, requestTimeoutMs: 500 },
        catchUpRetryBaseMs: 1,
        catchUpSteadyRetryMs: 5_000,
        now: () => clock,
        sendIntervalMs: 0
      }
    )
    connections.push(stopConn)
    await stopConn.start()
    for (let i = 0; i < 30; i++) {
      stopServer.enqueueFailure({
        method: 'GET',
        pathPrefix: `/api/v4/channels/${stopCh.id}/posts`,
        status: 503
      })
    }

    const stopSetTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const stopClearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    try {
      await stopConn.catchUpAfterReconnect()
      await vi.waitFor(() => expect(stopSetTimeoutSpy.mock.calls.some(([, delay]) => delay === 5_000)).toBe(true), {
        timeout: 3_000,
        interval: 10
      })
      const steadyCallIdx1 = stopSetTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 5_000)
      const steadyHandle1 = stopSetTimeoutSpy.mock.results[steadyCallIdx1]!.value

      // Socket drop cancels the active steady timer and reconnect resets back to fast backoff (1ms, 2ms, ...).
      stopServer.autoOpen = false
      stopServer.lastSocket.serverClose()
      expect(stopClearTimeoutSpy).toHaveBeenCalledWith(steadyHandle1)
      await vi.waitFor(() => expect(stopServer.sockets.length).toBe(2), { timeout: 2_000, interval: 10 })

      const callsBeforeReconnect = stopSetTimeoutSpy.mock.calls.length
      stopServer.autoOpen = true
      stopServer.lastSocket.open()
      await vi.waitFor(
        () =>
          expect(stopSetTimeoutSpy.mock.calls.slice(callsBeforeReconnect).some(([, delay]) => delay === 5_000)).toBe(
            true
          ),
        { timeout: 3_000, interval: 10 }
      )
      const postReconnectDelays = stopSetTimeoutSpy.mock.calls.slice(callsBeforeReconnect).map(([, delay]) => delay)
      expect(postReconnectDelays).toEqual(expect.arrayContaining([1, 2, 5_000]))

      const steadyCallIdx2 = stopSetTimeoutSpy.mock.calls.findIndex(
        ([, delay], idx) => idx >= callsBeforeReconnect && delay === 5_000
      )
      const steadyHandle2 = stopSetTimeoutSpy.mock.results[steadyCallIdx2]!.value
      const reqsBeforeStop = stopServer.requests.length
      await stopConn.stop()
      expect(stopClearTimeoutSpy).toHaveBeenCalledWith(steadyHandle2)
      await new Promise((r) => setTimeout(r, 40))
      expect(stopServer.requests.length).toBe(reqsBeforeStop)
    } finally {
      stopSetTimeoutSpy.mockRestore()
      stopClearTimeoutSpy.mockRestore()
    }
  })

  it('aborts worker loop when wsDisconnected turns true mid-pass and does not mark in-flight channels completed', async () => {
    let clock = 1_770_300_000_000
    const server = new FakeMattermostServer()
    const alice = server.addUser({ id: fakeMmId('alice', 17), username: 'alice', is_bot: false })
    const teamId = [...server.teams.keys()][0]!
    const channels = Array.from({ length: 10 }, (_, i) =>
      server.addChannel(
        {
          id: fakeMmId('midch', i + 1),
          team_id: teamId,
          type: 'O',
          name: `mid-${i + 1}`,
          last_post_at: clock - (i + 1) * 100
        },
        [server.botUser.id, alice.id]
      )
    )

    let holdTop4 = false
    let enteredTop4Count = 0
    let notifyTopEntered: (() => void) | undefined
    const topEntered = new Promise<void>((resolve) => {
      notifyTopEntered = resolve
    })
    let releaseTop4: (() => void) | undefined
    const top4Released = new Promise<void>((resolve) => {
      releaseTop4 = resolve
    })
    const top4Ids = new Set(channels.slice(0, 4).map((c) => c.id))
    const wrappedFetch: typeof fetch = async (input, init) => {
      const res = await server.fetchImpl(input, init)
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const match = /\/api\/v4\/channels\/([^/]+)\/posts/.exec(url)
      if (holdTop4 && match && top4Ids.has(match[1]!)) {
        enteredTop4Count++
        if (enteredTop4Count === 4) notifyTopEntered?.()
        await top4Released
      }
      return res
    }

    const messages: NormalizedMessage[] = []
    const conn = new MattermostConnection(
      {
        serverUrl: server.serverUrl,
        botToken: server.botToken,
        integrations: [{ agentId: 'agent-1', integrationId: 'int-mm' }]
      },
      {
        onMessage: (msg) => messages.push(msg),
        log: quietLog,
        createSocket: server.createSocket,
        fetchImpl: wrappedFetch,
        timing: { retryBaseMs: 5, retryMaxMs: 10, openTimeoutMs: 500, requestTimeoutMs: 500 },
        catchUpRetryBaseMs: 20,
        now: () => clock,
        sendIntervalMs: 0
      }
    )
    connections.push(conn)
    await conn.start()

    // Outage 1: disconnect socket 1, then reconnect socket 2 with top-4 channel /posts held after fetch.
    server.autoOpen = false
    server.lastSocket.serverClose()
    await vi.waitFor(() => expect(server.sockets.length).toBe(2), { timeout: 2_000 })
    holdTop4 = true
    server.autoOpen = true
    server.lastSocket.open()

    await topEntered

    // Outage 2 mid-pass: disconnect socket 2 while top-4 workers are paused, then add missed posts in ch1 and ch10.
    clock += 5_000
    server.autoOpen = false
    server.lastSocket.serverClose()
    const missedCh1 = server.addPost({
      channel_id: channels[0]!.id,
      user_id: alice.id,
      message: '@acbot missed in ch1 after mid-pass disconnect',
      create_at: clock + 100
    })
    const missedCh10 = server.addPost({
      channel_id: channels[9]!.id,
      user_id: alice.id,
      message: '@acbot missed in ch10 after mid-pass disconnect',
      create_at: clock + 200
    })

    const reqBeforeRelease = server.requests.length
    holdTop4 = false
    releaseTop4?.()

    await vi.waitFor(() => expect(server.sockets.length).toBe(3), { timeout: 2_000 })
    // While disconnected, remaining channels (ch5..ch10) must NOT have been queried.
    const queriedWhileOffline = server.requests
      .slice(reqBeforeRelease)
      .filter((r) => /\/api\/v4\/channels\/[^/]+\/posts/.test(r.path))
    expect(queriedWhileOffline).toHaveLength(0)

    // Reconnect socket 3: must re-sweep ch1 (not marked complete) and ch10, recovering both posts.
    server.autoOpen = true
    server.lastSocket.open()
    await vi.waitFor(() => expect(messages).toHaveLength(2), { timeout: 2_000 })
    expect(new Set(messages.map((m) => m.msgId))).toEqual(
      new Set([`mattermost:${channels[0]!.id}:${missedCh1.id}`, `mattermost:${channels[9]!.id}:${missedCh10.id}`])
    )
  })

  it('falls back to recoveryFallbackSince for a channel joined during outage even when a live WS post arrives during retry backoff', async () => {
    const startClock = 1_770_400_000_000
    let clock = startClock
    const server = new FakeMattermostServer()
    const alice = server.addUser({ id: fakeMmId('alice', 18), username: 'alice', is_bot: false })
    const teamId = [...server.teams.keys()][0]!
    server.addChannel({ id: fakeMmId('initch', 1), team_id: teamId, type: 'O', name: 'init-1' }, [
      server.botUser.id,
      alice.id
    ])

    const messages: NormalizedMessage[] = []
    const conn = new MattermostConnection(
      {
        serverUrl: server.serverUrl,
        botToken: server.botToken,
        integrations: [{ agentId: 'agent-1', integrationId: 'int-mm' }]
      },
      {
        onMessage: (msg) => messages.push(msg),
        log: quietLog,
        createSocket: server.createSocket,
        fetchImpl: server.fetchImpl,
        timing: { retryBaseMs: 5, retryMaxMs: 10, openTimeoutMs: 500, requestTimeoutMs: 500 },
        catchUpRetryBaseMs: 80,
        now: () => clock,
        sendIntervalMs: 0
      }
    )
    connections.push(conn)
    await conn.start()

    // Disconnect WS, then join a brand-new channel during outage and receive an outage post in it.
    clock += 5_000
    server.autoOpen = false
    server.lastSocket.serverClose()
    const newCh = server.addChannel({ id: fakeMmId('newch', 2), team_id: teamId, type: 'O', name: 'newly-joined' }, [
      server.botUser.id,
      alice.id
    ])
    const outagePost = server.addPost({
      channel_id: newCh.id,
      user_id: alice.id,
      message: '@acbot missed in newly joined channel',
      create_at: clock + 100
    })

    // Pass 1 getMyChannels fails 503, scheduling an 80ms retry.
    server.enqueueFailure({
      method: 'GET',
      pathPrefix: '/api/v4/users/me/channels',
      status: 503,
      body: { message: 'Temporary failure' }
    })

    clock += 30_000
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    try {
      await vi.waitFor(() => expect(server.sockets.length).toBe(2), { timeout: 2_000 })
      server.autoOpen = true
      server.lastSocket.open()

      await vi.waitFor(() => expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 80)).toBe(true), {
        timeout: 2_000,
        interval: 2
      })
    } finally {
      setTimeoutSpy.mockRestore()
    }
    // Yield one microtask so catchUpAfterReconnect()'s finally block sets catchUpInFlight = false before the live WS post arrives.
    await Promise.resolve()

    const livePost = server.addPost({
      channel_id: newCh.id,
      user_id: alice.id,
      message: '@acbot live ws post during retry backoff',
      create_at: clock + 50_000
    })
    server.lastSocket.emitPosted(livePost)
    await vi.waitFor(() => expect(messages.some((m) => m.msgId.endsWith(livePost.id))).toBe(true), {
      timeout: 2_000,
      interval: 2
    })

    // Automatic retry Pass 2 runs after 80ms; freezeRecoveryWatermarks() must NOT capture livePost's watermark into recoveryWatermarks.
    await vi.waitFor(() => expect(messages.some((m) => m.msgId.endsWith(outagePost.id))).toBe(true), {
      timeout: 2_000
    })

    const newChReqs = server.requests.filter((r) => r.path.startsWith(`/api/v4/channels/${newCh.id}/posts`))
    expect(newChReqs).toHaveLength(1)
    expect(Number(new URL(newChReqs[0]!.url).searchParams.get('since'))).toBe(startClock - 1_000)
  })
})

describe('Mattermost catch-up replay, retry, clock skew, and forged response-final claims', () => {
  it('does not replay a human post from before the outage that was only edited during it', async () => {
    const { server, conn, messages } = setup({ botUsername: 'acbot' })
    const alice = server.addUser({ id: fakeMmId('alice', 31), username: 'alice', is_bot: false })
    const ch = server.addChannel({ id: fakeMmId('editch', 1), type: 'O', name: 'edits' }, [server.botUser.id, alice.id])
    await conn.start()

    const baseMs = Date.now()
    const oldPost = server.addPost({
      channel_id: ch.id,
      user_id: alice.id,
      message: '@acbot asked last week',
      create_at: baseMs - 7 * 86_400_000,
      update_at: baseMs - 7 * 86_400_000
    })
    oldPost.update_at = baseMs + 2_000
    const missed = server.addPost({
      channel_id: ch.id,
      user_id: alice.id,
      message: '@acbot asked during the outage',
      create_at: baseMs + 3_000
    })

    await conn.catchUpAfterReconnect()
    await vi.waitFor(() => expect(messages).toHaveLength(1))
    expect(messages[0]!.msgId).toBe(`mattermost:${ch.id}:${missed.id}`)
  })

  it('delivers a post on the next pass when its first catch-up dispatch failed', async () => {
    const server = new FakeMattermostServer({ botUser: { username: 'acbot' } })
    const delivered: NormalizedMessage[] = []
    let failures = 1
    const conn = new MattermostConnection(
      {
        serverUrl: server.serverUrl,
        botToken: server.botToken,
        integrations: [{ agentId: 'agent-1', integrationId: 'int-mm' }]
      },
      {
        onMessage: (msg) => {
          if (failures-- > 0) throw new Error('downstream unavailable')
          delivered.push(msg)
        },
        log: quietLog,
        createSocket: server.createSocket,
        fetchImpl: server.fetchImpl,
        catchUpRetryBaseMs: 60_000,
        sendIntervalMs: 0
      }
    )
    connections.push(conn)
    const alice = server.addUser({ id: fakeMmId('alice', 32), username: 'alice', is_bot: false })
    const ch = server.addChannel({ id: fakeMmId('retrych', 1), type: 'O', name: 'retry' }, [
      server.botUser.id,
      alice.id
    ])
    await conn.start()

    const missed = server.addPost({
      channel_id: ch.id,
      user_id: alice.id,
      message: '@acbot please retry me',
      create_at: Date.now() + 2_000
    })
    await conn.catchUpAfterReconnect()
    expect(delivered).toHaveLength(0)

    await conn.catchUpAfterReconnect()
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    expect(delivered[0]!.msgId).toBe(`mattermost:${ch.id}:${missed.id}`)
  })

  it('replays a response finalized by an edit during the outage in a channel with no new post', async () => {
    const { server, conn, messages } = setup({ botUsername: 'acbot' })
    const peer = server.addUser({ id: fakeMmId('peer', 35), username: 'peerbot', is_bot: true })
    const startedAt = Date.now()
    const ch = server.addChannel(
      { id: fakeMmId('finalch', 1), type: 'O', name: 'long-run', last_post_at: startedAt - 3_600_000 },
      [server.botUser.id, peer.id]
    )
    // The response started streaming an hour before the outage; an edit does not move the channel's last_post_at.
    const response = server.addPost({
      channel_id: ch.id,
      user_id: peer.id,
      message: 'working...',
      create_at: startedAt - 3_600_000,
      update_at: startedAt - 3_600_000,
      props: { from_bot: 'true' }
    })
    await conn.start()

    response.message = 'All clear now'
    response.update_at = Date.now() + 2_000
    response.props = {
      from_bot: 'true',
      agentconnect_thread_event: {
        author_agent_id: 'agent-peer',
        response_id: 'resp-long',
        delivery_state: 'final',
        hop_count: 1,
        mentioned_agent_ids: ['agent-1'],
        addressed_anyone: true
      }
    }
    expect(server.channels.get(ch.id)!.last_post_at).toBe(startedAt - 3_600_000)

    await conn.catchUpAfterReconnect()
    await vi.waitFor(() => expect(messages).toHaveLength(1))
    expect(messages[0]!.msgId).toContain(response.id)
    expect(messages[0]!.ingressEventTag).toBe(MATTERMOST_RESPONSE_FINAL_EVENT_TAG)
  })

  it('does not redeliver the post that set a watermark once the dedupe set has forgotten it', async () => {
    const { server, conn, messages } = setup({ botUsername: 'acbot' })
    const alice = server.addUser({ id: fakeMmId('alice', 36), username: 'alice', is_bot: false })
    const ch = server.addChannel({ id: fakeMmId('tailch', 1), type: 'O', name: 'tail' }, [server.botUser.id, alice.id])
    await conn.start()

    const baseMs = Date.now()
    const live = server.addPost({
      channel_id: ch.id,
      user_id: alice.id,
      message: '@acbot live',
      create_at: baseMs + 500
    })
    server.lastSocket.emitPosted(live)
    await vi.waitFor(() => expect(messages).toHaveLength(1))

    // More than SEEN_LIMIT keys passing through other channels evicts it; clearing the set stands in for that.
    ;(conn as unknown as { seen: Set<string> }).seen.clear()
    const missed = server.addPost({
      channel_id: ch.id,
      user_id: alice.id,
      message: '@acbot missed',
      create_at: baseMs + 900
    })
    await conn.catchUpAfterReconnect()
    await vi.waitFor(() => expect(messages).toHaveLength(2))
    expect(messages.map((m) => m.msgId)).toEqual([`mattermost:${ch.id}:${live.id}`, `mattermost:${ch.id}:${missed.id}`])

    // The post recovered by that pass set the new watermark, and is remembered the same way.
    ;(conn as unknown as { seen: Set<string> }).seen.clear()
    await conn.catchUpAfterReconnect()
    expect(messages).toHaveLength(2)
  })

  it('stops at the page cap instead of replaying the same newest posts on every retry', async () => {
    const server = new FakeMattermostServer({ botUser: { username: 'acbot' } })
    const messages: NormalizedMessage[] = []
    const warnings: string[] = []
    const conn = new MattermostConnection(
      {
        serverUrl: server.serverUrl,
        botToken: server.botToken,
        integrations: [{ agentId: 'agent-1', integrationId: 'int-mm' }]
      },
      {
        onMessage: (msg) => messages.push(msg),
        log: { ...quietLog, warn: (message: string) => warnings.push(message) },
        createSocket: server.createSocket,
        fetchImpl: server.fetchImpl,
        catchUpMaxPages: 1,
        catchUpRetryBaseMs: 60_000,
        sendIntervalMs: 0
      }
    )
    connections.push(conn)
    const alice = server.addUser({ id: fakeMmId('alice', 37), username: 'alice', is_bot: false })
    const ch = server.addChannel({ id: fakeMmId('capch', 1), type: 'O', name: 'cap' }, [server.botUser.id, alice.id])
    await conn.start()

    const baseMs = Date.now() + 5_000
    for (let i = 1; i <= 1_005; i++) {
      server.addPost({ channel_id: ch.id, user_id: alice.id, message: `@acbot burst #${i}`, create_at: baseMs + i })
    }
    await conn.catchUpAfterReconnect()
    await vi.waitFor(() => expect(messages).toHaveLength(1_000), { timeout: 10_000 })
    expect(messages[0]!.text).toBe('@acbot burst #6')
    expect(warnings.some((line) => line.includes('1-page cap'))).toBe(true)

    // The channel is settled: a later pass asks only for what came after, and replays nothing.
    const reqBefore = server.requests.length
    await conn.catchUpAfterReconnect()
    const later = server.requests.slice(reqBefore).filter((r) => r.path.startsWith(`/api/v4/channels/${ch.id}/posts`))
    expect(later).toHaveLength(1)
    expect(Number(new URL(later[0]!.url).searchParams.get('since'))).toBeGreaterThanOrEqual(baseMs + 1_005 - 1_000)
    expect(messages).toHaveLength(1_000)
  })

  it('recovers outage posts when the daemon clock runs ahead of the server', async () => {
    const server = new FakeMattermostServer({ botUser: { username: 'acbot' } })
    const skewMs = 60_000
    const messages: NormalizedMessage[] = []
    const conn = new MattermostConnection(
      {
        serverUrl: server.serverUrl,
        botToken: server.botToken,
        integrations: [{ agentId: 'agent-1', integrationId: 'int-mm' }]
      },
      {
        onMessage: (msg) => messages.push(msg),
        log: quietLog,
        createSocket: server.createSocket,
        // The server stamps its own wall clock, one minute behind the daemon's.
        fetchImpl: (async (input, init) => {
          const res = await server.fetchImpl(input, init)
          const headers = new Headers(res.headers)
          headers.set('date', new Date(Date.now() - skewMs).toUTCString())
          return new Response(res.body, { status: res.status, headers })
        }) as typeof fetch,
        sendIntervalMs: 0
      }
    )
    connections.push(conn)
    const alice = server.addUser({ id: fakeMmId('alice', 33), username: 'alice', is_bot: false })
    const ch = server.addChannel({ id: fakeMmId('skewch', 1), type: 'O', name: 'skew' }, [server.botUser.id, alice.id])
    await conn.start()

    // Twenty seconds after start on the server's clock is still forty seconds in the daemon's past.
    const missed = server.addPost({
      channel_id: ch.id,
      user_id: alice.id,
      message: '@acbot sent during the outage',
      create_at: Date.now() - skewMs + 20_000
    })
    await conn.catchUpAfterReconnect()
    await vi.waitFor(() => expect(messages).toHaveLength(1))
    expect(messages[0]!.msgId).toBe(`mattermost:${ch.id}:${missed.id}`)
  })

  it('ignores a response-final claim on an edit by an account the server does not mark as a bot', async () => {
    const { server, conn, messages } = setup({ botUsername: 'acbot' })
    const alice = server.addUser({ id: fakeMmId('alice', 34), username: 'alice', is_bot: false })
    const peer = server.addUser({ id: fakeMmId('peer', 34), username: 'peerbot', is_bot: true })
    const ch = server.addChannel({ id: fakeMmId('forgech', 1), type: 'O', name: 'forge' }, [
      server.botUser.id,
      alice.id,
      peer.id
    ])
    await conn.start()

    const claim = {
      author_agent_id: 'agent-peer',
      response_id: 'resp-forged',
      delivery_state: 'final',
      hop_count: 1,
      mentioned_agent_ids: ['agent-1'],
      addressed_anyone: true
    }
    // A human sets both props on their own post; neither makes them a bot.
    server.lastSocket.emitPostEdited({
      id: server.nextId('p'),
      channel_id: ch.id,
      user_id: alice.id,
      message: '@acbot run this again',
      create_at: Date.now(),
      props: { from_bot: 'true', agentconnect_thread_event: claim }
    })
    server.lastSocket.emitPostEdited({
      id: server.nextId('p'),
      channel_id: ch.id,
      user_id: peer.id,
      message: 'All clear now',
      create_at: Date.now(),
      props: { from_bot: 'true', agentconnect_thread_event: claim }
    })
    await vi.waitFor(() => expect(messages).toHaveLength(1))
    expect(messages[0]!.sender.id).toBe(peer.id)
    expect(messages[0]!.ingressEventTag).toBe(MATTERMOST_RESPONSE_FINAL_EVENT_TAG)
  })
})
