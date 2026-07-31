import { describe, it, expect, vi } from 'vitest'
import {
  executeTool,
  type OpsDeps,
  type SessionContext,
  type MessageGateway,
  type MessageAgentReq,
  type ReplyToSessionReq,
  type SessionStatusReq
} from '../src/mcp/ops.js'
import type { MemoryProvider } from '../src/agents/memory-provider.js'
import { toolsForIntegrations } from '../src/mcp/tools.js'

const ctx: SessionContext = {
  agentId: 'bot-a',
  platform: 'slack',
  integrationId: 'int-1',
  isDm: false,
  channel: 'C_CURRENT',
  thread: '111.1',
  tools: toolsForIntegrations([
    { id: 'int-1', platform: 'slack', slack: { botToken: 'x', appToken: 'y', allowedUserIds: [], bindRules: [] } }
  ]),
  integrations: [{ id: 'int-1', platform: 'slack' }]
}

function fakeGateway(over: Partial<MessageGateway> = {}): MessageGateway {
  return {
    postMessage: vi.fn(async () => 'ts-123'),
    getChannelInfo: vi.fn(async (id) => ({ id, name: 'general' })),
    listMembers: vi.fn(async () => [{ id: 'U1', name: 'alice', isBot: false }]),
    listChannels: vi.fn(async () => [{ id: 'C1', name: 'general' }]),
    getUserProfile: vi.fn(async (u) => ({ id: u, name: 'alice', isBot: false })),
    downloadFile: vi.fn(async () => Buffer.from('FILEBYTES')),
    ...over
  }
}

// Memory is never exercised by these tool tests; a typed placeholder keeps the deps
// object a complete OpsDeps (so it type-checks) without a full provider stub.
const noMemory = {} as unknown as MemoryProvider

/** A COMPLETE OpsDeps with harmless stubs for every required field, so any test can
 *  spread it and override only the callbacks it asserts on. `messageAgent`/`replyToSession`
 *  return a benign delivered result; the send/read/discovery deps are overridden per test. */
function makeDeps(over: Partial<OpsDeps> = {}): OpsDeps {
  return {
    setSessionTitle: async () => {},
    gatewayFor: () => undefined,
    channelAgents: async () => {
      throw new Error('channelAgents not stubbed in this test')
    },
    messageAgent: async (req) => ({ delivered: true, targetSession: `stub:${req.toAgentId}` }),
    replyToSession: async () => ({ delivered: true, targetSession: 'stub' }),
    startOrchestration: async () => ({ orchestrationId: 'o', delivered: [], failed: [] }),
    getOrchestration: async () => null,
    cancelOrchestration: async () => false,
    memory: noMemory,
    recordOutbound: () => {},
    now: () => 1000,
    ...over
  }
}

function deps(gw: MessageGateway): { deps: OpsDeps; recorded: unknown[]; titleUpdates: unknown[] } {
  const recorded: unknown[] = []
  const titleUpdates: unknown[] = []
  return {
    recorded,
    titleUpdates,
    deps: makeDeps({
      setSessionTitle: async (req) => {
        titleUpdates.push(req)
      },
      gatewayFor: () => gw,
      recordOutbound: (_c, channel, thread, text, ts) => recorded.push({ channel, thread, text, ts }),
      now: () => 1000
    })
  }
}

describe('executeTool: setSessionTitle', () => {
  it('normalizes the title and forwards only trusted session coordinates', async () => {
    const gw = fakeGateway()
    const gatewayFor = vi.fn(() => gw)
    const { deps: d, titleUpdates } = deps(gw)
    d.gatewayFor = gatewayFor

    const result = await executeTool(
      { ...ctx, isDm: true },
      'setSessionTitle',
      {
        title: '  Fix\n  session titles  ',
        agentId: 'attacker',
        channel: 'C_OTHER',
        integrationId: 'int-other'
      },
      d
    )

    expect(titleUpdates).toEqual([
      {
        agentId: 'bot-a',
        platform: 'slack',
        integrationId: 'int-1',
        isDm: true,
        channel: 'C_CURRENT',
        thread: '111.1',
        title: 'Fix session titles'
      }
    ])
    expect(result).toEqual({ mcpContent: [] })
    expect(gatewayFor).not.toHaveBeenCalled()
  })

  it('rejects blank, overlong, and stopped title updates', async () => {
    const { deps: d, titleUpdates } = deps(fakeGateway())
    await expect(executeTool(ctx, 'setSessionTitle', { title: '  ' }, d)).rejects.toThrow(/title/)
    await expect(executeTool(ctx, 'setSessionTitle', { title: 'x'.repeat(81) }, d)).rejects.toThrow(/80/)
    d.canRun = () => false
    await expect(executeTool(ctx, 'setSessionTitle', { title: 'Late title' }, d)).rejects.toThrow(/stopped/)
    expect(titleUpdates).toEqual([])
  })
})

// The unified `sendMessage` tool's MessageTarget post path (§3) — the former
// `sendPlatformMessage`. `to.channel` (no `toAgent`) posts a visible IM through the
// gateway; the top-level result nests the post under `post`.
describe('executeTool: sendMessage (channel post)', () => {
  it('rejects every bridge tool after the owning turn is stopped', async () => {
    const gw = fakeGateway()
    const { deps: d } = deps(gw)
    d.canRun = () => false
    await expect(executeTool(ctx, 'sendMessage', { to: { channel: 'C_CURRENT' }, message: 'late' }, d)).rejects.toThrow(
      /stopped/
    )
    expect(gw.postMessage).not.toHaveBeenCalled()
  })

  it('posts to the channel ROOT by default (omitted thread) and records the outbound message', async () => {
    const gw = fakeGateway()
    const { deps: d, recorded } = deps(gw)
    // A deliberate send with no `thread` posts top-level — "reply here" is the agent's normal
    // turn output, not this tool. So thread resolves to root (undefined), NOT the session thread.
    const res = (await executeTool(ctx, 'sendMessage', { to: { channel: 'C_CURRENT' }, message: 'hi' }, d)) as Record<
      string,
      unknown
    >

    expect(gw.postMessage).toHaveBeenCalledWith('C_CURRENT', 'hi', undefined)
    expect(res).toMatchObject({
      ok: true,
      post: { platform: 'slack', channel: 'C_CURRENT', thread: null, ts: 'ts-123' }
    })
    // The transcript row lands in the thread the post CREATED (its own ts), not the caller's —
    // that key is what a later reply to this post resolves back onto.
    expect(recorded).toEqual([{ channel: 'C_CURRENT', thread: 'ts-123', text: 'hi', ts: 'ts-123' }])
  })

  it('posts inside a thread when one is named explicitly', async () => {
    const gw = fakeGateway()
    const { deps: d } = deps(gw)
    await executeTool(ctx, 'sendMessage', { to: { channel: 'C_CURRENT', thread: '111.1' }, message: 'hi' }, d)
    expect(gw.postMessage).toHaveBeenCalledWith('C_CURRENT', 'hi', '111.1')
  })

  it('honors an explicit channel and an empty thread (post to channel root)', async () => {
    const gw = fakeGateway()
    const { deps: d } = deps(gw)
    await executeTool(ctx, 'sendMessage', { to: { channel: 'C_OTHER', thread: '' }, message: 'yo' }, d)
    expect(gw.postMessage).toHaveBeenCalledWith('C_OTHER', 'yo', undefined)
  })

  describe('root post: one canonical thread key for every consumer', () => {
    // A post whose key differs from what the next inbound reply resolves to opens a session that
    // reply can never reach. threadKeyForPost is the ONE place a post becomes a thread segment,
    // and it has to follow each platform's conversation model — Telegram groups thread off the
    // root message (`tg:<id>`), Discord conversations ARE the channel, and a DM is one continuous
    // conversation that a post joins rather than forks.
    const withIntegration = (platform: string, id: string): SessionContext => ({
      ...ctx,
      integrations: [...ctx.integrations!, { id, platform }]
    })
    const tgCtx = withIntegration('telegram', 'int-tg')
    const tgDeps = (over: Partial<OpsDeps> = {}, gw: Partial<MessageGateway> = {}) => {
      const spawns: Record<string, unknown>[] = []
      const recorded: Record<string, unknown>[] = []
      const wakes: MessageAgentReq[] = []
      const d = makeDeps({
        gatewayFor: () => fakeGateway({ postMessage: vi.fn(async () => '172'), ...gw }),
        recordOutbound: (_c, channel, thread, text, ts) => recorded.push({ channel, thread, text, ts }),
        spawnChannelRootSession: (req) => {
          spawns.push(req)
          return true
        },
        messageAgent: async (req) => {
          wakes.push(req)
          return { delivered: true, targetSession: 'stub' }
        },
        now: () => 1000,
        ...over
      })
      return { d, spawns, recorded, wakes }
    }

    it('keys the spawned session and its transcript row alike', async () => {
      const { d, spawns, recorded } = tgDeps()
      await executeTool(tgCtx, 'sendMessage', { to: { platform: 'telegram', channel: '-100123' }, message: 'hi' }, d)
      // The session key is canonical; the RAW ts travels beside it for the transcript row, which
      // must stay a real, comparable platform ts.
      expect(spawns[0]).toMatchObject({ thread: 'tg:172', postTs: '172' })
      expect(recorded[0]).toMatchObject({ thread: 'tg:172', ts: '172' })
    })

    it('anchors a peer wake to that same key', async () => {
      // #295 canonicalized only the spawn and left this path on the raw ts, so ONE post yielded
      // two different session keys. A peer wake always posts on the caller's own platform, so
      // this is the Telegram-session case.
      const tgSession: SessionContext = {
        ...ctx,
        platform: 'telegram',
        integrationId: 'int-tg',
        channel: '-100123',
        thread: 'tg:100',
        integrations: [{ id: 'int-tg', platform: 'telegram' }]
      }
      const { d, wakes } = tgDeps()
      await executeTool(tgSession, 'sendMessage', { to: { toAgent: 'peer-1', channel: '-100123' }, message: 'hi' }, d)
      expect(wakes[0]).toMatchObject({ thread: 'tg:172', transcriptTs: '172' })
    })

    it('leaves an explicit thread and non-Telegram platforms untouched', async () => {
      // An explicit numeric thread is a forum TOPIC id and drives message_thread_id at post
      // time — canonicalizing it would silently move the post to another conversation.
      const topic = tgDeps()
      await executeTool(
        tgCtx,
        'sendMessage',
        { to: { platform: 'telegram', channel: '-100123', thread: '172' }, message: 'hi' },
        topic.d
      )
      expect(topic.recorded[0]).toMatchObject({ thread: '172' })
      expect(topic.spawns).toHaveLength(0)

      // Slack's ts already IS the thread segment.
      const slack = tgDeps({ gatewayFor: () => fakeGateway() })
      await executeTool(ctx, 'sendMessage', { to: { channel: 'C_X' }, message: 'hi' }, slack.d)
      expect(slack.spawns[0]).toMatchObject({ thread: 'ts-123', postTs: 'ts-123' })
    })

    it('keys a Discord post by its channel, which is what a Discord conversation is', async () => {
      // Every inbound Discord message keys the channel id (discord-message.ts), so a post there
      // cannot open a thread of its own — keying it by the message id made a session unreachable.
      const discord = tgDeps({}, { postMessage: vi.fn(async () => '900') })
      await executeTool(
        withIntegration('discord', 'int-dc'),
        'sendMessage',
        { to: { platform: 'discord', channel: 'C42' }, message: 'hi' },
        discord.d
      )
      expect(discord.spawns[0]).toMatchObject({ thread: 'C42', postTs: '900' })
      expect(discord.recorded[0]).toMatchObject({ thread: 'C42', ts: '900' })
    })

    it('joins a DM instead of forking it, on each platform that keeps DMs continuous', async () => {
      // A DM is one stream: Telegram keys it `dm`, Feishu keys it by the chat. Only the platform
      // knows which chats those are, so ops asks — and asks only where the answer changes the key.
      const asDm = { getChannelInfo: vi.fn(async (id: string) => ({ id, isIm: true })) }
      const tgDm = tgDeps({}, asDm)
      await executeTool(tgCtx, 'sendMessage', { to: { platform: 'telegram', channel: '555' }, message: 'hi' }, tgDm.d)
      expect(tgDm.spawns[0]).toMatchObject({ thread: 'dm', postTs: '172' })

      const feishuDm = tgDeps({}, asDm)
      await executeTool(
        withIntegration('feishu', 'int-fs'),
        'sendMessage',
        { to: { platform: 'feishu', channel: 'oc_42' }, message: 'hi' },
        feishuDm.d
      )
      expect(feishuDm.spawns[0]).toMatchObject({ thread: 'oc_42', postTs: '172' })

      // A Feishu GROUP threads off the message, like Slack.
      const feishuGroup = tgDeps()
      await executeTool(
        withIntegration('feishu', 'int-fs'),
        'sendMessage',
        { to: { platform: 'feishu', channel: 'oc_43' }, message: 'hi' },
        feishuGroup.d
      )
      expect(feishuGroup.spawns[0]).toMatchObject({ thread: '172', postTs: '172' })
    })

    it('does not interrogate the platform where the answer cannot change the key', async () => {
      // Slack and Discord key the same way for DMs and channels, and an explicit thread settles
      // it outright — so no send pays for a lookup it does not need.
      const getChannelInfo = vi.fn(async (id: string) => ({ id, isIm: true }))
      const slack = tgDeps({}, { getChannelInfo })
      await executeTool(ctx, 'sendMessage', { to: { channel: 'C_X' }, message: 'hi' }, slack.d)
      const threaded = tgDeps({}, { getChannelInfo })
      await executeTool(
        tgCtx,
        'sendMessage',
        { to: { platform: 'telegram', channel: '555', thread: '9' }, message: 'hi' },
        threaded.d
      )
      expect(getChannelInfo).not.toHaveBeenCalled()
    })

    it('falls back to a non-DM key when the platform lookup fails', async () => {
      // The post already happened; a failed classification must not fail the call.
      const flaky = tgDeps({}, { getChannelInfo: vi.fn(async () => Promise.reject(new Error('rate limited'))) })
      await executeTool(tgCtx, 'sendMessage', { to: { platform: 'telegram', channel: '555' }, message: 'hi' }, flaky.d)
      expect(flaky.spawns[0]).toMatchObject({ thread: 'tg:172', postTs: '172' })
    })
  })

  describe('root-post notice: the post forked a conversation this agent is already in', () => {
    // The spawn is what the notice describes, so it only speaks where a daemon actually seeds
    // the session (the chat CLI passes no spawn callback and gets no notice).
    const rootPostDeps = (over: Partial<OpsDeps> = {}) =>
      makeDeps({ gatewayFor: () => fakeGateway(), spawnChannelRootSession: () => true, now: () => 1000, ...over })
    const send = (d: OpsDeps, to: Record<string, unknown>, from: SessionContext = ctx) =>
      executeTool(from, 'sendMessage', { to, message: 'the answer' }, d) as Promise<{ notice?: string }>

    // Which conversation a post landed on is the DAEMON's verdict (it owns transport-scope
    // identity and the durable parent link); ops only formats what it is told.
    const parentRelation = { kind: 'parent', sessionId: 'sess-parent' } as const
    const dualCtx: SessionContext = {
      ...ctx,
      integrations: [...ctx.integrations!, { id: 'int-tg', platform: 'telegram' }]
    }

    it('names the parent session to reply into when the post lands on the parent’s conversation', async () => {
      const d = rootPostDeps({ rootPostRelation: () => parentRelation })
      const res = await send(d, { platform: 'telegram', channel: '-100123' }, dualCtx)
      // The claim is about what a ROOT post does — a separate context, not an answer. The seed
      // itself is dispatched fire-and-forget, so the notice never states a session as fact.
      expect(res.notice).toContain('starts a separate context there instead of answering')
      expect(res.notice).not.toMatch(/opened a (NEW )?session/)
      expect(res.notice).toContain('{"to":{"sessionId":"sess-parent"}}')
    })

    it('points a post into its own conversation back at the turn’s ordinary reply', async () => {
      const d = rootPostDeps({ rootPostRelation: () => ({ kind: 'self' }) })
      const res = await send(d, { channel: 'C_CURRENT' })
      expect(res.notice).toContain('Your ordinary reply for this turn already reaches this conversation')
    })

    it('passes the target coords the daemon needs to judge conversation identity', async () => {
      const seen: Record<string, unknown>[] = []
      const d = rootPostDeps({
        rootPostRelation: (req) => {
          seen.push(req)
          return undefined
        }
      })
      await send(d, { platform: 'telegram', channel: '-100123' }, dualCtx)
      // Including the integration — the daemon resolves it to a transport scope, without which
      // two bots' identical channel ids would read as the same conversation.
      expect(seen[0]).toMatchObject({
        callerAgentId: 'bot-a',
        platform: 'slack',
        callerChannel: 'C_CURRENT',
        callerThread: '111.1',
        targetPlatform: 'telegram',
        targetChannel: '-100123',
        targetIntegrationId: 'int-tg'
      })
    })

    it('stays quiet for an unrelated destination, and for a threaded post', async () => {
      const unrelated = rootPostDeps({ rootPostRelation: () => undefined })
      expect((await send(unrelated, { channel: 'C_OTHER' })).notice).toBeUndefined()
      // Threaded: it joins a conversation instead of forking, so nothing is spawned or asked.
      const threaded = rootPostDeps({ rootPostRelation: () => parentRelation })
      expect(
        (await send(threaded, { platform: 'telegram', channel: '-100123', thread: '9' }, dualCtx)).notice
      ).toBeUndefined()
    })

    it('says nothing when no session was actually seeded', async () => {
      // No daemon at all (chat CLI).
      const noSpawn = makeDeps({
        gatewayFor: () => fakeGateway(),
        rootPostRelation: () => parentRelation,
        now: () => 1000
      })
      expect((await send(noSpawn, { platform: 'telegram', channel: '-100123' }, dualCtx)).notice).toBeUndefined()
      // A platform that returned no ts leaves nothing to key a session on, so nothing forked.
      const noTs = rootPostDeps({
        gatewayFor: () => fakeGateway({ postMessage: vi.fn(async () => undefined) }),
        rootPostRelation: () => parentRelation
      })
      expect((await send(noTs, { platform: 'telegram', channel: '-100123' }, dualCtx)).notice).toBeUndefined()
      // The daemon DECLINED the seed (agent-call hop limit): the post happened, but claiming a
      // session opened would be false.
      const declined = rootPostDeps({
        spawnChannelRootSession: () => false,
        rootPostRelation: () => parentRelation
      })
      expect((await send(declined, { platform: 'telegram', channel: '-100123' }, dualCtx)).notice).toBeUndefined()
    })
  })

  it('synthesizes a ts when the platform returns none', async () => {
    const gw = fakeGateway({ postMessage: vi.fn(async () => undefined) })
    const { deps: d } = deps(gw)
    const res = (await executeTool(ctx, 'sendMessage', { to: { channel: 'C_CURRENT' }, message: 'hi' }, d)) as {
      post: { ts: string }
    }
    expect(res.post.ts).toBe('local-1000')
  })

  it('rejects a missing message argument', async () => {
    const { deps: d } = deps(fakeGateway())
    await expect(executeTool(ctx, 'sendMessage', { to: { channel: 'C_CURRENT' } }, d)).rejects.toThrow(/message/)
  })

  it('rejects a platform the agent has no integration for', async () => {
    const { deps: d } = deps(fakeGateway())
    await expect(
      executeTool(ctx, 'sendMessage', { to: { platform: 'discord', channel: 'D1' }, message: 'hi' }, d)
    ).rejects.toThrow(/no discord integration/)
  })

  it('posts cross-platform to another of the agent’s integrations (Slack session → Telegram)', async () => {
    const gw = fakeGateway()
    const { deps: d, recorded } = deps(gw)
    // A Slack-triggered session whose agent also has a Telegram bot.
    const dual = { ...ctx, integrations: [...ctx.integrations!, { id: 'int-tg', platform: 'telegram' }] }
    const res = (await executeTool(
      dual,
      'sendMessage',
      { to: { platform: 'telegram', channel: '-100123' }, message: 'hi' },
      d
    )) as { post: Record<string, unknown> }
    expect(gw.postMessage).toHaveBeenCalledWith('-100123', 'hi', undefined)
    expect(res.post).toMatchObject({ platform: 'telegram', integrationId: 'int-tg', channel: '-100123' })
    // Pre-fix this row carried the CALLER's Slack thread under a Telegram channel — coords that
    // belong to no session, and a trap for the reply-owner lookup. It now keys the post's own.
    expect(recorded).toEqual([{ channel: '-100123', thread: 'ts-123', text: 'hi', ts: 'ts-123' }])
  })

  it('rejects a platform-only target with repairable examples and no side effect', async () => {
    const gw = fakeGateway()
    const { deps: d } = deps(gw)
    const dual = { ...ctx, integrations: [...ctx.integrations!, { id: 'int-tg', platform: 'telegram' }] }
    await expect(executeTool(dual, 'sendMessage', { to: { platform: 'telegram' }, message: 'hi' }, d)).rejects.toThrow(
      /Valid targets:.*toAgent.*channel.*sessionId/
    )
    expect(gw.postMessage).not.toHaveBeenCalled()
  })

  it('defaults an omitted integrationId to the current session integration, not the first candidate', async () => {
    const gw = fakeGateway()
    const { deps: d } = deps(gw)
    // Two Slack bots; the session was delivered by the SECOND one (int-b, not first).
    const multi = {
      ...ctx,
      integrationId: 'int-b',
      integrations: [
        { id: 'int-a', platform: 'slack' },
        { id: 'int-b', platform: 'slack' }
      ]
    }
    // A same-platform send must resolve through int-b (the session's bot), not int-a (the
    // first candidate). Thread defaults to root (undefined) for a deliberate send.
    const res = (await executeTool(multi, 'sendMessage', { to: { channel: 'C_CURRENT' }, message: 'hi' }, d)) as {
      post: Record<string, unknown>
    }
    expect(gw.postMessage).toHaveBeenCalledWith('C_CURRENT', 'hi', undefined)
    expect(res.post).toMatchObject({ integrationId: 'int-b', channel: 'C_CURRENT' })
  })

  it('stamps the agent’s own identity (from the session, not tool input) onto the send', async () => {
    const gw = fakeGateway()
    const { deps: d } = deps(gw)
    const withIdentity = { ...ctx, agentName: 'Bot A', iconUrl: 'https://x/y.png' }
    await executeTool(withIdentity, 'sendMessage', { to: { channel: 'C_CURRENT' }, message: 'hi' }, d)
    expect(gw.postMessage).toHaveBeenCalledWith('C_CURRENT', 'hi', undefined, {
      username: 'Bot A',
      icon_url: 'https://x/y.png'
    })
  })

  it('omits identity (plain 3-arg postMessage) when the session carries none', async () => {
    const gw = fakeGateway()
    const { deps: d } = deps(gw)
    await executeTool(ctx, 'sendMessage', { to: { channel: 'C_CURRENT' }, message: 'hi' }, d)
    expect(gw.postMessage).toHaveBeenCalledWith('C_CURRENT', 'hi', undefined)
  })

  it('toUser @-mentions a human on Slack (prepends <@id>), and rejects toUser off Slack', async () => {
    const gw = fakeGateway()
    const { deps: d, recorded } = deps(gw)
    await executeTool(ctx, 'sendMessage', { to: { channel: 'C_CURRENT', toUser: 'U9' }, message: 'ping' }, d)
    expect(gw.postMessage).toHaveBeenCalledWith('C_CURRENT', '<@U9> ping', undefined)
    // An already-wrapped mention is left as-is.
    await executeTool(ctx, 'sendMessage', { to: { channel: 'C_CURRENT', toUser: '<@U9>' }, message: 'again' }, d)
    expect(gw.postMessage).toHaveBeenLastCalledWith('C_CURRENT', '<@U9> again', undefined)
    expect(recorded).toEqual([
      { channel: 'C_CURRENT', thread: 'ts-123', text: '<@U9> ping', ts: 'ts-123' },
      { channel: 'C_CURRENT', thread: 'ts-123', text: '<@U9> again', ts: 'ts-123' }
    ])

    // toUser is Slack-only for now — on another platform it throws (nothing posted).
    const dual = { ...ctx, integrations: [...ctx.integrations!, { id: 'int-tg', platform: 'telegram' }] }
    await expect(
      executeTool(dual, 'sendMessage', { to: { platform: 'telegram', channel: '-100', toUser: '42' }, message: 'x' }, d)
    ).rejects.toThrow(/only supported on Slack/)
  })
})

describe('executeTool: read tools', () => {
  it('getCurrentChannel returns the bound channel + thread', async () => {
    const { deps: d } = deps(fakeGateway())
    const res = (await executeTool(ctx, 'getCurrentChannel', {}, d)) as Record<string, unknown>
    expect(res).toMatchObject({ channel: 'C_CURRENT', thread: '111.1', name: 'general' })
  })

  it('listChannelMembers defaults to the current channel', async () => {
    const gw = fakeGateway()
    const { deps: d } = deps(gw)
    const res = (await executeTool(ctx, 'listChannelMembers', {}, d)) as Record<string, unknown>
    expect(gw.listMembers).toHaveBeenCalledWith('C_CURRENT')
    expect(res.members).toEqual([{ id: 'U1', name: 'alice', isBot: false }])
  })

  it('routes a read to another connected platform via the `platform` arg', async () => {
    // Slack session; agent also has a Telegram bot. Ask for Telegram channels — the
    // read must resolve the Telegram gateway, not the current Slack one.
    const slackGw = fakeGateway({ listChannels: vi.fn(async () => [{ id: 'C_SLACK' }]) })
    const tgGw = fakeGateway({
      listChannels: vi.fn(async () => []),
      listMembers: vi.fn(async () => [{ id: '42', name: 'bob' }])
    })
    const { deps: base } = deps(slackGw)
    const d: OpsDeps = { ...base, gatewayFor: (id) => (id === 'int-tg' ? tgGw : slackGw) }
    const dual = { ...ctx, integrations: [...ctx.integrations!, { id: 'int-tg', platform: 'telegram' }] }

    const chans = (await executeTool(dual, 'listChannels', { platform: 'telegram' }, d)) as Record<string, unknown>
    expect(chans).toEqual({ platform: 'telegram', channels: [], source: 'live' })
    expect(tgGw.listChannels).toHaveBeenCalled()
    expect(slackGw.listChannels).not.toHaveBeenCalled()

    // A cross-platform member read has no "current channel" — it must be supplied.
    await expect(executeTool(dual, 'listChannelMembers', { platform: 'telegram' }, d)).rejects.toThrow(
      /channel is required/
    )
    const members = (await executeTool(
      dual,
      'listChannelMembers',
      { platform: 'telegram', channel: '-100' },
      d
    )) as Record<string, unknown>
    expect(tgGw.listMembers).toHaveBeenCalledWith('-100')
    expect(members).toMatchObject({ platform: 'telegram', channel: '-100' })
  })

  it('falls back to observed session history when the live channel list is empty (Telegram)', async () => {
    const tgGw = fakeGateway({ listChannels: vi.fn(async () => []) })
    const { deps: base } = deps(tgGw)
    const observed = [
      { id: '-100', name: 'team chat' },
      { id: '55', name: '@bob' }
    ]
    const d: OpsDeps = { ...base, observedChannels: () => observed }
    const dual = {
      ...ctx,
      platform: 'telegram',
      integrationId: 'int-tg',
      integrations: [{ id: 'int-tg', platform: 'telegram' }]
    }

    const res = (await executeTool(dual, 'listChannels', {}, d)) as Record<string, unknown>
    expect(res).toEqual({ platform: 'telegram', channels: observed, source: 'observed' })
  })

  it('listKnownUsers returns observed users and needs no live gateway', async () => {
    const users = [{ id: '55', name: '@bob' }, { id: '77' }]
    const d = makeDeps({ gatewayFor: () => undefined, now: () => 0, observedUsers: () => users })
    const dual = {
      ...ctx,
      platform: 'telegram',
      integrationId: 'int-tg',
      integrations: [{ id: 'int-tg', platform: 'telegram' }]
    }
    const res = (await executeTool(dual, 'listKnownUsers', {}, d)) as Record<string, unknown>
    expect(res).toEqual({ platform: 'telegram', users })
    // Rejects a platform the agent isn't connected to.
    await expect(executeTool(dual, 'listKnownUsers', { platform: 'discord' }, d)).rejects.toThrow(
      /no discord integration/
    )
  })

  it('is integration-aware with two bots on one platform: reads route by integrationId, ambiguous history is suppressed', async () => {
    // Agent has TWO Slack bots; the session was triggered by int-a.
    const gwA = fakeGateway({ listChannels: vi.fn(async () => [{ id: 'CA' }]) })
    const gwB = fakeGateway({
      listChannels: vi.fn(async () => [{ id: 'CB' }]),
      getUserProfile: vi.fn(async (u) => ({ id: u, name: 'from-B' }))
    })
    const observedChannels = vi.fn(() => [{ id: 'C_HIST' }])
    const observedUsers = vi.fn(() => [{ id: 'U_HIST' }])
    const base = deps(gwA).deps
    const d: OpsDeps = { ...base, gatewayFor: (id) => (id === 'int-b' ? gwB : gwA), observedChannels, observedUsers }
    const twoBots = {
      ...ctx,
      integrationId: 'int-a',
      integrations: [
        { id: 'int-a', platform: 'slack' },
        { id: 'int-b', platform: 'slack' }
      ]
    }

    // A live read routes to the CHOSEN bot, not just the first candidate.
    expect(await executeTool(twoBots, 'listChannels', { integrationId: 'int-b' }, d)).toMatchObject({
      channels: [{ id: 'CB' }],
      source: 'live'
    })
    expect(await executeTool(twoBots, 'getUserProfile', { integrationId: 'int-b', user: 'U9' }, d)).toMatchObject({
      name: 'from-B'
    })

    // History-backed paths can't attribute to one bot → suppressed with a note; the
    // observed callbacks are never queried.
    const gwEmpty = fakeGateway({ listChannels: vi.fn(async () => []) })
    const d2: OpsDeps = { ...d, gatewayFor: () => gwEmpty }
    const chans = (await executeTool(twoBots, 'listChannels', {}, d2)) as Record<string, unknown>
    expect(chans).toMatchObject({ channels: [], source: 'observed' })
    expect(chans.note).toMatch(/multiple integrations/i)
    const kus = (await executeTool(twoBots, 'listKnownUsers', {}, d2)) as Record<string, unknown>
    expect(kus).toMatchObject({ users: [] })
    expect(kus.note).toMatch(/multiple integrations/i)
    expect(observedChannels).not.toHaveBeenCalled()
    expect(observedUsers).not.toHaveBeenCalled()
  })

  it('throws on missing live connection', async () => {
    const d = makeDeps({ gatewayFor: () => undefined, now: () => 0 })
    await expect(executeTool(ctx, 'getCurrentChannel', {}, d)).rejects.toThrow(/no live platform connection/)
  })

  it('throws on an unknown tool', async () => {
    const { deps: d } = deps(fakeGateway())
    await expect(executeTool(ctx, 'nope', {}, d)).rejects.toThrow(/unknown tool/)
  })
})

describe('executeTool: readSlackFile', () => {
  it('returns an image as native MCP image content (base64) for image/* urls', async () => {
    const png = Buffer.from('PNGDATA')
    const gw = fakeGateway({ downloadFile: vi.fn(async () => png) })
    const { deps: d } = deps(gw)
    const res = (await executeTool(ctx, 'readSlackFile', { url: 'https://files/x.png' }, d)) as {
      mcpContent: { type: string; data?: string; mimeType?: string }[]
    }
    expect(gw.downloadFile).toHaveBeenCalledWith('https://files/x.png', expect.any(Number))
    expect(res.mcpContent).toEqual([{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }])
  })

  it('honors an explicit mimeType hint and returns text content for text files', async () => {
    const gw = fakeGateway({ downloadFile: vi.fn(async () => Buffer.from('hello world')) })
    const { deps: d } = deps(gw)
    const res = (await executeTool(ctx, 'readSlackFile', { url: 'https://files/note', mimeType: 'text/plain' }, d)) as {
      mcpContent: { type: string; text?: string }[]
    }
    expect(res.mcpContent).toEqual([{ type: 'text', text: 'hello world' }])
  })

  it('summarizes non-image binary instead of inlining a base64 blob', async () => {
    const gw = fakeGateway({ downloadFile: vi.fn(async () => Buffer.from([1, 2, 3, 4])) })
    const { deps: d } = deps(gw)
    const res = (await executeTool(
      ctx,
      'readSlackFile',
      { url: 'https://files/archive.zip', mimeType: 'application/zip' },
      d
    )) as { mcpContent: { type: string; text?: string }[] }
    expect(res.mcpContent[0]!.type).toBe('text')
    expect(res.mcpContent[0]!.text).toMatch(/4 bytes of application\/zip/)
  })

  it('errors clearly when the download fails (e.g. missing files:read)', async () => {
    const gw = fakeGateway({ downloadFile: vi.fn(async () => null) })
    const { deps: d } = deps(gw)
    await expect(executeTool(ctx, 'readSlackFile', { url: 'https://files/x.png' }, d)).rejects.toThrow(
      /could not download|files:read/
    )
  })
})

describe('executeTool: telegram tool names dispatch through the same gateway', () => {
  it('readTelegramFile downloads via the gateway (file_id as url)', async () => {
    const gw = fakeGateway({ downloadFile: vi.fn(async () => Buffer.from('doc')) })
    const { deps: d } = deps(gw)
    const res = (await executeTool(ctx, 'readTelegramFile', { url: 'AgACAgID', mimeType: 'text/plain' }, d)) as {
      mcpContent: { type: string; text?: string }[]
    }
    expect(gw.downloadFile).toHaveBeenCalledWith('AgACAgID', expect.any(Number))
    expect(res.mcpContent).toEqual([{ type: 'text', text: 'doc' }])
  })
})

describe('executeTool: listChannelAgents', () => {
  // A deps bundle whose channelAgents dep records the request it received and
  // returns a canned roster. gatewayFor throws to prove discovery does NOT need a
  // platform gateway (it runs before the gateway gate).
  function discoveryDeps(over: Partial<OpsDeps> = {}): {
    deps: OpsDeps
    calls: { platform: string; channel: string; requesterAgentId: string }[]
  } {
    const calls: { platform: string; channel: string; requesterAgentId: string }[] = []
    const d = makeDeps({
      gatewayFor: () => {
        throw new Error('gatewayFor must not be called for listChannelAgents')
      },
      channelAgents: async (req) => {
        calls.push({ platform: req.platform, channel: req.channel, requesterAgentId: req.requesterAgentId })
        return {
          platform: req.platform,
          channel: req.channel,
          agents: [{ agentId: 'peer-1', name: 'peer', status: 'active' as const }]
        }
      },
      now: () => 0,
      ...over
    })
    return { deps: d, calls }
  }

  it('defaults platform+channel to the session coords and returns the roster', async () => {
    const { deps: d, calls } = discoveryDeps()
    const res = (await executeTool(ctx, 'listChannelAgents', {}, d)) as { channel: string; agents: unknown[] }
    expect(calls).toEqual([{ platform: 'slack', channel: 'C_CURRENT', requesterAgentId: 'bot-a' }])
    expect(res.channel).toBe('C_CURRENT')
    expect(res.agents).toEqual([{ agentId: 'peer-1', name: 'peer', status: 'active' }])
  })

  it('lets `channel` be overridden but keeps the current channel by default', async () => {
    const { deps: d, calls } = discoveryDeps()
    await executeTool(ctx, 'listChannelAgents', { channel: 'C_OTHER' }, d)
    expect(calls[0]).toMatchObject({ channel: 'C_OTHER' })
  })

  it('takes requesterAgentId + platform from the session context, NOT tool input', async () => {
    const { deps: d, calls } = discoveryDeps()
    // Attacker-controlled args attempt to impersonate another agent / probe another
    // platform — both must be ignored in favor of the trusted session context.
    await executeTool(ctx, 'listChannelAgents', { requesterAgentId: 'someone-else', platform: 'telegram' }, d)
    expect(calls[0]).toEqual({ platform: 'slack', channel: 'C_CURRENT', requesterAgentId: 'bot-a' })
  })
})

// The unified `sendMessage` tool's A2A/wake path (§4) and SessionTarget reply path (§5),
// the former `messageAgent` tool. `to.toAgent` wakes a peer through `deps.messageAgent`;
// `to.sessionId` replies into an origin session through `deps.replyToSession`.
describe('executeTool: sendMessage (wake / reply)', () => {
  function wakeDeps(over: Partial<OpsDeps> = {}): {
    deps: OpsDeps
    calls: MessageAgentReq[]
    gw: MessageGateway
    recorded: unknown[]
  } {
    const calls: MessageAgentReq[] = []
    const recorded: unknown[] = []
    const gw = fakeGateway()
    const d = makeDeps({
      gatewayFor: () => gw,
      messageAgent: async (req) => {
        calls.push(req)
        return { delivered: true, targetSession: `slack:${req.channel}:${req.thread ?? 'root'}:${req.toAgentId}` }
      },
      recordOutbound: (_c, channel, thread, text, ts) => recorded.push({ channel, thread, text, ts }),
      now: () => 0,
      ...over
    })
    return { deps: d, calls, gw, recorded }
  }

  it('to.toAgent alone wakes the peer at the current coords, with no channel post', async () => {
    const { deps: d, calls, gw } = wakeDeps()
    const res = (await executeTool(ctx, 'sendMessage', { to: { toAgent: 'peer-1' }, message: 'help' }, d)) as {
      ok: boolean
      wake?: { delivered: boolean }
      post?: unknown
    }
    expect(res.ok).toBe(true)
    expect(res.wake?.delivered).toBe(true)
    expect(res.post).toBeUndefined() // no separate channel post
    expect(gw.postMessage).not.toHaveBeenCalled() // channel-less wake is postless (#854)
    expect(calls[0]).toEqual({
      callerAgentId: 'bot-a',
      platform: 'slack',
      callerIntegrationId: 'int-1',
      callerChannel: 'C_CURRENT',
      callerThread: '111.1',
      toAgentId: 'peer-1',
      text: 'help',
      channel: 'C_CURRENT',
      thread: '111.1'
    })
  })

  it('channel + toAgent (no thread) posts a ROOT message and lands the peer in that post’s thread', async () => {
    // New semantics: a `channel` alongside `toAgent` posts a visible root message AND wakes the
    // peer INTO that post's ts, so the collaboration is visible + threaded (both share the ts).
    const { deps: d, calls, gw, recorded } = wakeDeps()
    const res = (await executeTool(
      ctx,
      'sendMessage',
      { to: { toAgent: 'peer-1', channel: 'C_X' }, message: 'over to you' },
      d
    )) as {
      ok: boolean
      wake?: unknown
      post?: { channel: string; thread: string | null; ts: string }
    }
    expect(res.ok).toBe(true)
    expect(res.wake).toBeDefined()
    // Visible root post through the gateway (no identity on this ctx → 3-arg call).
    expect(gw.postMessage).toHaveBeenCalledWith('C_X', 'over to you', undefined)
    expect(res.post).toEqual({ platform: 'slack', integrationId: 'int-1', channel: 'C_X', thread: null, ts: 'ts-123' })
    expect(recorded).toEqual([{ channel: 'C_X', thread: 'ts-123', text: 'over to you', ts: 'ts-123' }])
    // The peer is woken INTO the post's ts, and the post ts is carried through as the wake's
    // transcriptTs so the wake row collapses onto the recorded post's PK (no duplicate hand-off).
    expect(calls[0]).toMatchObject({ toAgentId: 'peer-1', channel: 'C_X', thread: 'ts-123', transcriptTs: 'ts-123' })
  })

  it('channel + toAgent + thread posts INTO that thread and reuses it for the peer', async () => {
    const { deps: d, calls, gw } = wakeDeps()
    await executeTool(
      ctx,
      'sendMessage',
      { to: { toAgent: 'peer-1', channel: 'C_X', thread: '222.2' }, message: 'ping' },
      d
    )
    expect(gw.postMessage).toHaveBeenCalledWith('C_X', 'ping', '222.2')
    // Thread reused; transcriptTs = the post's real ts (dedups against the recorded post row).
    expect(calls[0]).toMatchObject({ toAgentId: 'peer-1', channel: 'C_X', thread: '222.2', transcriptTs: 'ts-123' })
  })

  it('a wake that preflight rejects leaves NO visible post (but still runs the wake)', async () => {
    // preflightWake reports the wake will be refused (e.g. not_allowed). The channel post must be
    // skipped so no misleading hand-off is left; messageAgent still runs (it re-checks and returns
    // the typed reason — stubbed here to just record the call).
    const { deps: d, calls, gw } = wakeDeps({ preflightWake: () => 'not_allowed' })
    const res = (await executeTool(
      ctx,
      'sendMessage',
      { to: { toAgent: 'peer-1', channel: 'C_X' }, message: 'nope' },
      d
    )) as { ok: boolean; wake?: unknown; post?: unknown }
    expect(gw.postMessage).not.toHaveBeenCalled()
    expect(res.post).toBeUndefined()
    expect(res.wake).toBeDefined()
    // The wake ran, and with the post skipped it carries no transcriptTs.
    expect(calls[0]).toMatchObject({ toAgentId: 'peer-1', channel: 'C_X' })
    expect(calls[0]!.transcriptTs).toBeUndefined()
  })

  it('takes callerAgentId + platform from the trusted context, ignoring attacker args', async () => {
    const { deps: d, calls } = wakeDeps()
    await executeTool(
      ctx,
      'sendMessage',
      { to: { toAgent: 'peer-1', channel: 'C_OTHER' }, message: 'help', callerAgentId: 'victim', platform: 'telegram' },
      d
    )
    expect(calls[0]).toMatchObject({ callerAgentId: 'bot-a', platform: 'slack', channel: 'C_OTHER' })
  })

  it('honors an explicit empty thread (channel root) on a wake', async () => {
    const { deps: d, calls } = wakeDeps()
    await executeTool(ctx, 'sendMessage', { to: { toAgent: 'peer-1', thread: '' }, message: 'x' }, d)
    expect(calls[0]!.thread).toBeUndefined()
  })

  it.each([
    { to: {}, label: 'empty target' },
    { to: { platform: 'slack' }, label: 'platform-only target' },
    { to: { toUser: 'U1' }, label: 'human id without a channel' }
  ])('rejects $label before dispatch and returns repairable target examples', async ({ to }) => {
    const { deps: d } = wakeDeps()
    await expect(executeTool(ctx, 'sendMessage', { to, message: 'x' }, d)).rejects.toThrow(
      /Valid targets:.*toAgent.*channel.*sessionId/
    )
  })

  it.each([
    { to: { sessionId: 'sess-1', toAgent: 'peer-1' }, label: 'session target' },
    { to: { toAgent: 'peer-1', toUser: 'U1' }, label: 'agent target' },
    { to: { channel: 'C1', correlationId: 'o1.0' }, label: 'channel target' }
  ])('rejects mixed fields on a $label instead of silently ignoring them', async ({ to }) => {
    const { deps: d } = wakeDeps()
    await expect(executeTool(ctx, 'sendMessage', { to, message: 'x' }, d)).rejects.toThrow(/allows only/)
  })

  it('to.sessionId is a SessionTarget reply routed to deps.replyToSession', async () => {
    const replyCalls: ReplyToSessionReq[] = []
    const d = makeDeps({
      gatewayFor: () => {
        throw new Error('gatewayFor must not be called for a SessionTarget reply')
      },
      messageAgent: async () => {
        throw new Error('messageAgent must not be called for a SessionTarget reply')
      },
      replyToSession: async (req) => {
        replyCalls.push(req)
        return { delivered: true, targetSession: 'origin-key' }
      }
    })
    const res = await executeTool(ctx, 'sendMessage', { to: { sessionId: 'sess-1' }, message: 'done' }, d)
    // The ReplyToSessionResult is returned verbatim (NOT wrapped in { ok, wake, post }).
    expect(res).toEqual({ delivered: true, targetSession: 'origin-key' })
    expect(replyCalls[0]).toEqual({
      callerAgentId: 'bot-a',
      platform: 'slack',
      callerChannel: 'C_CURRENT',
      callerThread: '111.1',
      sessionId: 'sess-1',
      text: 'done'
    })
  })

  it('passes an explicit correlationId override through on a SessionTarget reply', async () => {
    const replyCalls: ReplyToSessionReq[] = []
    const d = makeDeps({
      replyToSession: async (req) => {
        replyCalls.push(req)
        return { delivered: true, targetSession: 'origin-key' }
      }
    })
    await executeTool(ctx, 'sendMessage', { to: { sessionId: 'sess-1', correlationId: 'o1.0' }, message: 'done' }, d)
    expect(replyCalls[0]!.correlationId).toBe('o1.0')
  })

  // The woken peer runs in its own session; the caller needs its id to follow the work it just
  // delegated (viewSessionStatus). Only an ADMITTED wake opened one.
  it('returns the woken session as childSessionId', async () => {
    const { deps: d } = wakeDeps()
    const res = (await executeTool(ctx, 'sendMessage', { to: { toAgent: 'peer-1' }, message: 'go' }, d)) as {
      childSessionId?: string
      wake?: { targetSession: string }
    }
    expect(res.childSessionId).toBe(res.wake!.targetSession)
  })

  it('omits childSessionId when the wake was refused — nothing was opened', async () => {
    const { deps: d } = wakeDeps({
      messageAgent: async () => ({ delivered: false, targetSession: 'slack:C:root:peer-1', reason: 'not_allowed' })
    })
    const res = (await executeTool(ctx, 'sendMessage', { to: { toAgent: 'peer-1' }, message: 'go' }, d)) as {
      childSessionId?: string
      wake?: { reason?: string }
    }
    expect(res.childSessionId).toBeUndefined()
    expect(res.wake?.reason).toBe('not_allowed')
  })

  it('omits childSessionId for a plain channel post — a post is not a delegated session', async () => {
    const { deps: d } = wakeDeps()
    const res = (await executeTool(ctx, 'sendMessage', { to: { channel: 'C_X' }, message: 'fyi' }, d)) as {
      childSessionId?: string
    }
    expect(res.childSessionId).toBeUndefined()
  })

  it('accepts the object toAgent form and forwards needsReply as trusted request metadata', async () => {
    const { deps: d, calls } = wakeDeps()
    await executeTool(
      ctx,
      'sendMessage',
      { to: { toAgent: { agentId: 'peer-1', needsReply: true } }, message: 'take this over' },
      d
    )
    expect(calls[0]!.toAgentId).toBe('peer-1')
    expect(calls[0]!.needsReply).toBe(true)
    // needsReply must NOT leak into the delivered text — it becomes a standing directive on the
    // child's session instead, which the daemon owns.
    expect(calls[0]!.text).toBe('take this over')
  })

  it('leaves needsReply absent for the bare-string form and for an explicit false', async () => {
    const { deps: d, calls } = wakeDeps()
    await executeTool(ctx, 'sendMessage', { to: { toAgent: 'peer-1' }, message: 'a' }, d)
    await executeTool(
      ctx,
      'sendMessage',
      { to: { toAgent: { agentId: 'peer-1', needsReply: false } }, message: 'b' },
      d
    )
    expect(calls[0]!.needsReply).toBeUndefined()
    expect(calls[1]!.needsReply).toBeUndefined()
  })

  it('the object toAgent form still composes with a visible channel post', async () => {
    const { deps: d, calls, gw } = wakeDeps()
    const res = (await executeTool(
      ctx,
      'sendMessage',
      { to: { toAgent: { agentId: 'peer-1', needsReply: true }, channel: 'C_X' }, message: 'over to you' },
      d
    )) as { post?: { ts: string }; childSessionId?: string }
    expect(gw.postMessage).toHaveBeenCalled()
    expect(res.post?.ts).toBe('ts-123')
    expect(calls[0]).toMatchObject({ toAgentId: 'peer-1', channel: 'C_X', thread: 'ts-123', needsReply: true })
    expect(res.childSessionId).toBe('slack:C_X:ts-123:peer-1')
  })

  it.each([
    { toAgent: {}, label: 'an object with no agentId' },
    { toAgent: { agentId: 'peer-1', urgent: true }, label: 'an unknown option' },
    { toAgent: { agentId: 'peer-1', needsReply: 'yes' }, label: 'a non-boolean needsReply' },
    { toAgent: ['peer-1'], label: 'an array' },
    { toAgent: 42, label: 'a number' }
  ])('rejects $label for to.toAgent instead of silently dropping it', async ({ toAgent }) => {
    const { deps: d, calls } = wakeDeps()
    await expect(executeTool(ctx, 'sendMessage', { to: { toAgent }, message: 'x' }, d)).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
})

// viewSessionStatus is the read counterpart of a SessionTarget reply: the identity + coords come
// from the trusted SessionContext and only `sessionId` is model input. ops.ts owns the argument
// contract and the deliberately-indistinguishable unknown/not-yours error; the daemon owns the
// lineage check itself (see daemon-message-agent.test.ts).
describe('executeTool: viewSessionStatus', () => {
  const childStatus = {
    sessionId: 'slack:C_X:ts-1:peer-1',
    agentId: 'peer-1',
    status: 'in-progress' as const,
    state: 'prompting' as const,
    updatedAt: 5
  }

  it('passes the trusted caller coords and returns the daemon status verbatim', async () => {
    const calls: SessionStatusReq[] = []
    const d = makeDeps({
      viewSessionStatus: async (req) => {
        calls.push(req)
        return childStatus
      }
    })
    const res = await executeTool(ctx, 'viewSessionStatus', { sessionId: 'slack:C_X:ts-1:peer-1' }, d)
    expect(res).toEqual(childStatus)
    expect(calls[0]).toEqual({
      callerAgentId: 'bot-a',
      platform: 'slack',
      callerChannel: 'C_CURRENT',
      callerThread: '111.1',
      sessionId: 'slack:C_X:ts-1:peer-1'
    })
  })

  it('surfaces an unauthorized/unknown session as one error that does not confirm existence', async () => {
    const d = makeDeps({ viewSessionStatus: async () => null })
    await expect(executeTool(ctx, 'viewSessionStatus', { sessionId: 'someone-elses' }, d)).rejects.toThrow(
      /not a session started by this session/
    )
  })

  it('requires a sessionId', async () => {
    const d = makeDeps({
      viewSessionStatus: async () => {
        throw new Error('must not be called without a sessionId')
      }
    })
    await expect(executeTool(ctx, 'viewSessionStatus', {}, d)).rejects.toThrow(/missing required string argument/)
  })

  it('reports unavailability when the daemon does not supply the callback (chat CLI)', async () => {
    const d = makeDeps()
    delete (d as Partial<OpsDeps>).viewSessionStatus
    await expect(executeTool(ctx, 'viewSessionStatus', { sessionId: 'x' }, d)).rejects.toThrow(/unavailable/)
  })
})

describe('executeTool: submitGithubReview', () => {
  it('takes agent/session identity from trusted context and passes only semantic review input', async () => {
    const submitGithubReview = vi.fn(async () => ({
      state: 'submitted' as const,
      reviewId: '99',
      event: 'REQUEST_CHANGES' as const,
      verdict: 'fail' as const,
      commitId: 'a'.repeat(40)
    }))
    const { deps: d } = deps(fakeGateway())
    d.submitGithubReview = submitGithubReview

    const result = await executeTool(
      ctx,
      'submitGithubReview',
      {
        // These attacker-supplied target fields are ignored.
        repoFullName: 'evil/repo',
        pullNumber: 1,
        agentId: 'victim',
        event: 'REQUEST_CHANGES',
        verdict: 'fail',
        body: 'Please fix this.',
        comments: [{ path: 'src/a.ts', body: 'Bug here.', line: 9, side: 'RIGHT' }]
      },
      d
    )

    expect(result).toMatchObject({ state: 'submitted', reviewId: '99' })
    expect(submitGithubReview).toHaveBeenCalledWith({
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C_CURRENT',
      thread: '111.1',
      event: 'REQUEST_CHANGES',
      verdict: 'fail',
      body: 'Please fix this.',
      comments: [{ path: 'src/a.ts', body: 'Bug here.', line: 9, side: 'RIGHT' }]
    })
  })

  it('fails closed when no review effect boundary is wired', async () => {
    const { deps: d } = deps(fakeGateway())
    await expect(
      executeTool(ctx, 'submitGithubReview', { event: 'COMMENT', verdict: 'neutral', body: 'note' }, d)
    ).rejects.toThrow(/unavailable/)
  })

  it('validates inline coordinates before calling the effect boundary', async () => {
    const submitGithubReview = vi.fn()
    const { deps: d } = deps(fakeGateway())
    d.submitGithubReview = submitGithubReview
    await expect(
      executeTool(
        ctx,
        'submitGithubReview',
        {
          event: 'COMMENT',
          verdict: 'neutral',
          body: 'note',
          comments: [{ path: 'x.ts', body: 'bad line', line: 0, side: 'RIGHT' }]
        },
        d
      )
    ).rejects.toThrow(/positive integer/)
    expect(submitGithubReview).not.toHaveBeenCalled()
  })
})
