import { afterEach, describe, expect, it, vi } from 'vitest'
import { MATTERMOST_PLATFORM } from '@agentconnect.md/protocol'
import { executeTool, type OpsDeps } from '../src/mcp/ops.js'
import { assertChannelReachable } from '../src/mcp/ops/channel-reach.js'
import type { SessionContext } from '../src/mcp/ops/context.js'
import { toolsForIntegrations } from '../src/mcp/tools.js'
import { EPHEMERAL_RESULT_MARKER } from '../src/session/ephemeral-results.js'
import { MattermostConnection } from '../src/platforms/mattermost/connection.js'
import { notJoinedChannel } from '../src/platforms/not-joined.js'
import { FakeMattermostServer, fakeMmId, quietLog } from './fakes/mattermost-server.js'

const connections: MattermostConnection[] = []

afterEach(async () => {
  for (const conn of connections.splice(0)) await conn.stop()
})

function connect(
  server: FakeMattermostServer,
  opts?: { integrations?: { agentId: string; integrationId: string }[] }
): MattermostConnection {
  const conn = new MattermostConnection(
    {
      serverUrl: server.serverUrl,
      botToken: server.botToken,
      integrations: opts?.integrations ?? [{ agentId: 'agent-1', integrationId: 'int-mm' }]
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
  return conn
}

describe('Mattermost Layer-1 searchPublicMessages', () => {
  it('searches across teams favoring current channel team, filters private/DM/GM/deleted fail-closed, paginates, and supports MCP tool', async () => {
    const server = new FakeMattermostServer()
    const teamAId = [...server.teams.keys()][0]!
    const teamBId = fakeMmId('team', 2)
    server.teams.set(teamBId, { id: teamBId, name: 'ops', display_name: 'Ops' })

    const alice = server.addUser({
      id: fakeMmId('alice', 1),
      username: 'alice',
      first_name: 'Alice',
      last_name: 'Ng',
      is_bot: false
    })
    const otherBot = server.addUser({ id: fakeMmId('cibot', 2), username: 'cibot', is_bot: true })

    const pubA = server.addChannel(
      { id: fakeMmId('puba', 1), team_id: teamAId, type: 'O', name: 'general', display_name: 'General' },
      [server.botUser.id, alice.id, otherBot.id]
    )
    const pubB = server.addChannel(
      { id: fakeMmId('pubb', 2), team_id: teamBId, type: 'O', name: 'alerts', display_name: 'Alerts' },
      [server.botUser.id, alice.id]
    )
    const privCh = server.addChannel(
      { id: fakeMmId('priv', 3), team_id: teamAId, type: 'P', name: 'secret', display_name: 'Secret' },
      [server.botUser.id, alice.id]
    )
    const gmCh = server.addChannel({ id: fakeMmId('gmch', 4), type: 'G', name: 'group-dm' }, [
      server.botUser.id,
      alice.id
    ])
    const dmCh = server.addChannel({ id: fakeMmId('dmch', 5), type: 'D', name: `${alice.id}__${server.botUser.id}` }, [
      server.botUser.id,
      alice.id
    ])
    const deletedCh = server.addChannel(
      { id: fakeMmId('delch', 6), team_id: teamAId, type: 'O', name: 'old', delete_at: 1_760_000_000_000 },
      [server.botUser.id, alice.id]
    )

    const p1 = server.addPost({
      channel_id: pubA.id,
      user_id: alice.id,
      message: 'deploy checklist approved',
      create_at: 1_767_225_601_000
    })
    const p2 = server.addPost({
      channel_id: pubB.id,
      user_id: alice.id,
      message: 'deploy window opened',
      create_at: 1_767_225_603_000
    })
    const pBot = server.addPost({
      channel_id: pubA.id,
      user_id: otherBot.id,
      message: 'deploy pipeline green',
      create_at: 1_767_225_602_000
    })
    server.addPost({
      channel_id: privCh.id,
      user_id: alice.id,
      message: 'deploy private secret',
      create_at: 1_767_225_604_000
    })
    server.addPost({
      channel_id: gmCh.id,
      user_id: alice.id,
      message: 'deploy group dm secret',
      create_at: 1_767_225_605_000
    })
    server.addPost({
      channel_id: dmCh.id,
      user_id: alice.id,
      message: 'deploy 1:1 dm secret',
      create_at: 1_767_225_606_000
    })
    server.addPost({
      channel_id: deletedCh.id,
      user_id: alice.id,
      message: 'deploy deleted channel',
      create_at: 1_767_225_607_000
    })
    server.addPost({
      channel_id: pubA.id,
      user_id: alice.id,
      message: 'deploy deleted post',
      delete_at: 1_767_225_608_000
    })

    const conn = connect(server)
    await conn.start()

    // Empty/whitespace query short-circuits cleanly without API calls.
    expect(await conn.searchPublicMessages('   ', {})).toEqual({ messages: [] })

    // Team containing `channel: pubB.id` is queried first; only public active channels remain, sorted newest-first.
    const page1 = await conn.searchPublicMessages('deploy', { channel: pubB.id, limit: 2 })
    const searchPaths = server.requests.filter((r) => r.path.endsWith('/posts/search')).map((r) => r.path)
    expect(searchPaths.slice(0, 2)).toEqual([
      `/api/v4/teams/${teamBId}/posts/search`,
      `/api/v4/teams/${teamAId}/posts/search`
    ])
    expect(page1.messages.map((m) => m.messageTs)).toEqual([p2.id, pBot.id])
    expect(page1.messages[0]).toMatchObject({
      channel: pubB.id,
      channelName: 'Alerts',
      text: 'deploy window opened',
      author: 'Alice Ng',
      authorId: alice.id,
      isBot: false,
      permalink: `${server.serverUrl}/_redirect/pl/${p2.id}`
    })
    expect(page1.nextCursor).toBe('2')

    const page2 = await conn.searchPublicMessages('deploy', { limit: 2, cursor: page1.nextCursor })
    expect(page2.messages.map((m) => m.messageTs)).toEqual([p1.id])
    expect(page2.nextCursor).toBeUndefined()

    // `includeBots: false` and `after` / `before` epoch-second bounds filter accurately.
    const humansOnly = await conn.searchPublicMessages('deploy', {
      includeBots: false,
      after: 1_767_225_602,
      before: 1_767_225_603
    })
    expect(humansOnly.messages.map((m) => m.messageTs)).toEqual([p2.id])

    // End-to-end execution via MCP `searchPublicMessages` tool (auto-injected by toolsForIntegrations).
    const mmTools = toolsForIntegrations([
      {
        id: 'int-mm',
        platform: MATTERMOST_PLATFORM,
        core: {
          mode: 'direct',
          bindRules: [],
          mutedChannels: [],
          gated: false,
          sessionModes: [],
          decisions: { bindings: [], definitions: [] }
        },
        config: { serverUrl: server.serverUrl, botToken: server.botToken }
      }
    ])
    expect(mmTools.map((t) => t.name)).toContain('searchPublicMessages')
    const ctx: SessionContext = {
      agentId: 'agent-1',
      platform: MATTERMOST_PLATFORM,
      integrationId: 'int-mm',
      channel: dmCh.id,
      thread: 'dm',
      deliveryThread: 'dm',
      tools: mmTools,
      isDm: true
    }
    const deps: OpsDeps = {
      gatewayFor: (id: string) => (id === 'int-mm' ? conn : undefined),
      resolveChannel: async () => undefined
    } as unknown as OpsDeps
    const toolRes = (await executeTool(ctx, 'searchPublicMessages', { query: 'checklist', limit: 5 }, deps)) as {
      platform: string
      policy: string
      messages: Array<{ messageTs: string }>
    }
    expect(toolRes.platform).toBe(MATTERMOST_PLATFORM)
    expect(toolRes.policy).toContain(EPHEMERAL_RESULT_MARKER)
    expect(toolRes.messages.map((m) => m.messageTs)).toEqual([p1.id])
  })
})

describe('Mattermost publicChannelReach, joinChannel, notJoined marking, identity fallback, and post_deleted', () => {
  it('enforces public-only assertChannelReachable and fail-closed lookup errors for Mattermost', async () => {
    const server = new FakeMattermostServer()
    const alice = server.addUser({ id: fakeMmId('alice', 1), username: 'alice' })
    const pub = server.addChannel({ id: fakeMmId('pub', 1), type: 'O', name: 'pub' }, [server.botUser.id, alice.id])
    const priv = server.addChannel({ id: fakeMmId('priv', 2), type: 'P', name: 'priv' }, [server.botUser.id, alice.id])
    const dm = server.addChannel({ id: fakeMmId('dm', 3), type: 'D', name: `${alice.id}__${server.botUser.id}` }, [
      server.botUser.id,
      alice.id
    ])
    const conn = connect(server)
    await conn.start()

    const ctx: SessionContext = {
      agentId: 'agent-1',
      platform: MATTERMOST_PLATFORM,
      integrationId: 'int-mm',
      channel: dm.id,
      thread: 'dm',
      deliveryThread: 'dm',
      tools: [],
      isDm: true
    }

    // Public channel allowed.
    await expect(assertChannelReachable(ctx, conn, MATTERMOST_PLATFORM, pub.id, 'sendMessage')).resolves.toBeUndefined()
    // Same conversation (even DM) always allowed.
    await expect(assertChannelReachable(ctx, conn, MATTERMOST_PLATFORM, dm.id, 'sendMessage')).resolves.toBeUndefined()
    // Private channel & other DMs rejected.
    await expect(assertChannelReachable(ctx, conn, MATTERMOST_PLATFORM, priv.id, 'sendMessage')).rejects.toThrow(
      /private Mattermost conversation/
    )
    // 404 unknown channel passes through to post path without hiding the provider's error.
    await expect(
      assertChannelReachable(ctx, conn, MATTERMOST_PLATFORM, fakeMmId('missing', 9), 'sendMessage')
    ).resolves.toBeUndefined()

    // Non-404 error fails closed cleanly.
    const transientErrConn = {
      ...conn,
      getChannelInfo: vi.fn(async () => {
        throw Object.assign(new Error('timeout'), { status: 503 })
      })
    }
    await expect(
      assertChannelReachable(ctx, transientErrConn as never, MATTERMOST_PLATFORM, 'ch-unknown', 'sendMessage')
    ).rejects.toThrow(/could not determine/)
  })

  it('joins public channels, refuses private/DM joinChannel, and marks 403 unjoined public channels with markNotJoined', async () => {
    const server = new FakeMattermostServer()
    server.requireMembershipToPost = true
    const teamId = [...server.teams.keys()][0]!
    const alice = server.addUser({ id: fakeMmId('alice', 1), username: 'alice' })
    const unjoinedPub = server.addChannel({ id: fakeMmId('pubnj', 1), team_id: teamId, type: 'O', name: 'unjoined' }, [
      alice.id
    ])
    const priv = server.addChannel({ id: fakeMmId('priv', 2), team_id: teamId, type: 'P', name: 'secret' }, [alice.id])
    const conn = connect(server)
    await conn.start()

    // Posting into an unjoined public channel throws a `markNotJoined`-tagged error.
    let caught: unknown
    try {
      await conn.createPost(unjoinedPub.id, 'hello public')
    } catch (err) {
      caught = err
    }
    expect(notJoinedChannel(caught)).toBe(unjoinedPub.id)

    // Refuses non-public channels.
    await expect(conn.joinChannel(priv.id)).rejects.toThrow(/only enters active public channels/)

    // Joins active public channel, updates membership cache, and allows subsequent posts.
    await conn.joinChannel(unjoinedPub.id)
    expect(server.channelMembers.get(unjoinedPub.id)?.has(server.botUser.id)).toBe(true)
    const posted = await conn.createPost(unjoinedPub.id, 'hello after join')
    expect(posted.message).toBe('hello after join')

    // Unjoined private channel 403 must NOT be tagged as joinable public channel.
    let privErr: unknown
    try {
      await conn.createPost(priv.id, 'hello private')
    } catch (err) {
      privErr = err
    }
    expect(notJoinedChannel(privErr)).toBeUndefined()
  })

  it('honors disabled override config flags, falls back on 400 override errors, and cleans caches on post_deleted', async () => {
    // 1. Server advertises EnablePostUsernameOverride=false & EnablePostIconOverride=false up front.
    const serverDisabled = new FakeMattermostServer()
    serverDisabled.enablePostUsernameOverride = false
    serverDisabled.enablePostIconOverride = false
    const ch1 = serverDisabled.addChannel({ id: fakeMmId('ch', 1), type: 'O', name: 'eng' }, [
      serverDisabled.botUser.id
    ])
    const conn1 = connect(serverDisabled)
    await conn1.start()

    const created1 = await conn1.createPost(ch1.id, 'hi', {
      identity: { username: 'Custom Bot', icon_url: 'https://cdn.example/a.png', agentAuthorId: 'agent-1' }
    })
    expect(created1.props?.override_username).toBeUndefined()
    expect(created1.props?.override_icon_url).toBeUndefined()
    expect(created1.props?.agentconnect_thread_event).toMatchObject({ author_agent_id: 'agent-1' })

    // 2. Server claims overrides are enabled at startup, then rejects at POST / PUT time with 400.
    const serverRuntimeReject = new FakeMattermostServer()
    serverRuntimeReject.rejectIdentityOverride = true
    const ch2 = serverRuntimeReject.addChannel({ id: fakeMmId('ch', 2), type: 'O', name: 'eng2' }, [
      serverRuntimeReject.botUser.id
    ])
    const conn2 = connect(serverRuntimeReject)
    await conn2.start()

    const created2 = await conn2.createPost(ch2.id, 'hello fallback', {
      identity: { username: 'Agent Y', icon_url: 'https://cdn.example/y.png', agentAuthorId: 'agent-y' }
    })
    expect(created2.message).toBe('hello fallback')
    expect(created2.props?.override_username).toBeUndefined()
    expect(created2.props?.agentconnect_thread_event).toMatchObject({ author_agent_id: 'agent-y' })

    // Re-enable check on server to prove subsequent patchPost remembers overrides disabled & cleans up on post_deleted.
    const patched = await conn2.patchPost(created2.id, 'edited fallback', {
      identity: { username: 'Agent Y', agentAuthorId: 'agent-y' }
    })
    expect(patched.message).toBe('edited fallback')
    expect(patched.props?.override_username).toBeUndefined()

    const wsSeen = (conn2 as unknown as { seen: Set<string>; postChannels: Map<string, string> }).seen
    const wsPostChannels = (conn2 as unknown as { postChannels: Map<string, string> }).postChannels
    wsSeen.add(`posted:${created2.id}`)
    expect(wsPostChannels.get(created2.id)).toBe(ch2.id)
    serverRuntimeReject.lastSocket.emitEvent('post_deleted', {
      post: JSON.stringify({ id: created2.id, channel_id: ch2.id, user_id: serverRuntimeReject.botUser.id })
    })
    await vi.waitFor(() => {
      expect(wsPostChannels.has(created2.id)).toBe(false)
      expect(wsSeen.has(`posted:${created2.id}`)).toBe(false)
    })
  })
})
