import { describe, it, expect, vi } from 'vitest'
import {
  executeTool,
  type OpsDeps,
  type SessionContext,
  type MessageGateway,
  type MessageAgentReq,
  type MessageAgentResult,
  type ReplyToSessionReq,
  type SessionStatusReq
} from '../src/mcp/ops.js'
import type { MemoryProvider } from '../src/memory/provider.js'
import { toolsForIntegrations } from '../src/mcp/tools.js'

const ctx: SessionContext = {
  agentId: 'bot-a',
  platform: 'slack',
  integrationId: 'int-1',
  isDm: false,
  channel: 'C_CURRENT',
  thread: '111.1',
  tools: toolsForIntegrations([
    {
      id: 'int-1',
      platform: 'slack',
      core: { mode: 'direct', bindRules: [], mutedChannels: [], gated: false },
      config: { botToken: 'x', appToken: 'y' }
    }
  ]),
  integrations: [{ id: 'int-1', platform: 'slack' }]
}
const authorIdentity = { agentAuthorId: 'bot-a' }

/**
 * The identity stamped on the VISIBLE half of a paired `toAgent + channel` send
 * (send-message-routing-rework.md §3.2/§4). Unlike a streamed turn reply this post is
 * complete when made — no finalization edit closes it — so it is `final` on arrival and
 * carries the pairing id the target's rendezvous keys on. The id is minted per call, so
 * match its shape; `responseId` and `agentCallDeliveryId` are the same value because the
 * post IS the whole response.
 */
const pairedAuthorIdentity = {
  agentAuthorId: 'bot-a',
  response: {
    responseId: expect.any(String),
    deliveryState: 'final',
    hopCount: 0,
    // NAMES THE TARGET, and must: ingress selects targets from this field, so an empty set
    // would make the echo unroutable — the platform-first rendezvous unreachable, and a
    // lost wake silent instead of the delivery failure §8.6 promises. It cannot
    // double-activate: ingress checks the pairing id first and routes to the
    // claim-an-observation branch, never to dispatch.
    mentionedAgentIds: ['peer-1'],
    agentCallDeliveryId: expect.any(String)
  }
}

function fakeGateway(over: Partial<MessageGateway> = {}): MessageGateway {
  return {
    openDirectMessage: vi.fn(async (user) => `D-${user}`),
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
    recordOutbound: async () => {},
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
      recordOutbound: async (_c, channel, thread, text, ts) => void recorded.push({ channel, thread, text, ts }),
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
// `sendPlatformMessage`. A `channel`-only target posts a visible IM through the gateway
// without waking an agent or addressing a human; the top-level result nests the post under
// `post`.
describe('executeTool: sendMessage (channel post)', () => {
  it('rejects every bridge tool after the owning turn is stopped', async () => {
    const gw = fakeGateway()
    const { deps: d } = deps(gw)
    d.canRun = () => false
    await expect(executeTool(ctx, 'sendMessage', { channel: 'C_CURRENT', message: 'late' }, d)).rejects.toThrow(
      /stopped/
    )
    expect(gw.postMessage).not.toHaveBeenCalled()
  })

  it('posts to the channel ROOT by default (omitted thread) and records the outbound message', async () => {
    const gw = fakeGateway()
    const { deps: d, recorded } = deps(gw)
    // A deliberate send with no `thread` posts top-level — "reply here" is the agent's normal
    // turn output, not this tool. So thread resolves to root (undefined), NOT the session thread.
    const res = (await executeTool(ctx, 'sendMessage', { channel: 'C_CURRENT', message: 'hi' }, d)) as Record<
      string,
      unknown
    >

    expect(gw.postMessage).toHaveBeenCalledWith('C_CURRENT', 'hi', undefined, authorIdentity)
    expect(res).toMatchObject({
      ok: true,
      post: { platform: 'slack', channel: 'C_CURRENT', thread: null, ts: 'ts-123' }
    })
    // The transcript row lands in the thread the post CREATED (its own ts), not the caller's —
    // that key is what a later reply to this post resolves back onto.
    expect(recorded).toEqual([{ channel: 'C_CURRENT', thread: 'ts-123', text: 'hi', ts: 'ts-123' }])
  })

  it('rejects `thread` on a channel post — there is no visible in-thread form', async () => {
    // send-message-routing-rework.md §2.2: no branch accepts `thread`. Addressing the
    // current thread is the ordinary turn reply's job (§2.1), so a `thread` here is a
    // caller working from an old example. Reject LOUDLY: silently posting at the root what
    // the caller meant for a thread is the outcome that would confuse them.
    const gw = fakeGateway()
    const { deps: d } = deps(gw)
    await expect(
      executeTool(ctx, 'sendMessage', { channel: 'C_CURRENT', thread: '111.1', message: 'hi' }, d)
    ).rejects.toThrow(/thread/)
    expect(gw.postMessage).not.toHaveBeenCalled()
  })

  it('posts a cross-channel send at that channel’s root', async () => {
    const gw = fakeGateway()
    const { deps: d } = deps(gw)
    await executeTool(ctx, 'sendMessage', { channel: 'C_OTHER', message: 'yo' }, d)
    expect(gw.postMessage).toHaveBeenCalledWith('C_OTHER', 'yo', undefined, authorIdentity)
  })

  // Forwarding a file the conversation RECEIVED. This is the only way an image crosses
  // platforms: the bytes are resolved daemon-side from what already arrived, never produced
  // by the model, and a file share is its own message kind rather than a decorated post.
  describe('attachment forward', () => {
    const bytes = Buffer.from('PNGBYTES')
    const resolved = { bytes, name: 'shot.png', mimeType: 'image/png' }
    // Slack's share answers with the file and no ts; the other three answer with a message.
    const anchorless = () => fakeGateway({ uploadFile: vi.fn(async () => ({ ok: true as const })) })
    const anchoring = () => fakeGateway({ uploadFile: vi.fn(async () => ({ ok: true as const, messageId: 'ts-999' })) })
    const resolves = () => ({
      resolveAttachment: vi.fn(async (_c: SessionContext, name: string) => (name === 'shot.png' ? resolved : undefined))
    })

    it('uploads the received bytes with `message` as the caption instead of posting text', async () => {
      const gw = anchorless()
      const { deps: d, recorded } = deps(gw)
      Object.assign(d, resolves())

      const res = (await executeTool(
        ctx,
        'sendMessage',
        { channel: 'C_OTHER', attachment: 'shot.png', message: 'from telegram' },
        d
      )) as Record<string, unknown>

      expect(gw.uploadFile).toHaveBeenCalledWith('C_OTHER', resolved, 'from telegram', undefined, authorIdentity)
      expect(gw.postMessage).not.toHaveBeenCalled()
      // No anchor came back, so the send records under a synthetic id and seeds no
      // channel-root session — the path a gateway returning no id already took.
      expect(res).toMatchObject({ ok: true, post: { channel: 'C_OTHER', ts: 'local-1000' } })
      expect(recorded).toEqual([{ channel: 'C_OTHER', thread: undefined, text: 'from telegram', ts: 'local-1000' }])
    })

    it('anchors the forward like any other post when the platform answers with a message id', async () => {
      // Slack is the outlier here: Telegram, Discord and Feishu all return the message their
      // file send created, so a forward there threads and seeds exactly like a text post.
      const gw = anchoring()
      const { deps: d, recorded } = deps(gw)
      Object.assign(d, resolves())

      const res = (await executeTool(
        ctx,
        'sendMessage',
        { channel: 'C_OTHER', attachment: 'shot.png', message: 'look' },
        d
      )) as Record<string, unknown>

      expect(res).toMatchObject({ ok: true, post: { channel: 'C_OTHER', ts: 'ts-999' } })
      expect(recorded).toEqual([{ channel: 'C_OTHER', thread: 'ts-999', text: 'look', ts: 'ts-999' }])
    })

    it('surfaces a partial send as a notice rather than as success or failure', async () => {
      // The file landed and the caption did not. Neither "sent" nor "nothing was sent" is
      // true, and only the agent can decide what to do about it inside this turn.
      const gw = fakeGateway({
        uploadFile: vi.fn(async () => ({ ok: true as const, messageId: 'ts-999', warning: 'its caption did not post' }))
      })
      const { deps: d } = deps(gw)
      Object.assign(d, resolves())
      const res = (await executeTool(
        ctx,
        'sendMessage',
        { channel: 'C_OTHER', attachment: 'shot.png', message: 'look' },
        d
      )) as Record<string, unknown>
      expect(res).toMatchObject({ ok: true, notice: expect.stringContaining('its caption did not post') })
    })

    it('raises a refused share instead of reporting it as sent', async () => {
      // Nothing reached the conversation, so this must not read as a delivered message —
      // a silently dropped image is the one outcome the agent cannot detect on its own.
      const gw = fakeGateway({
        uploadFile: vi.fn(async () => ({ ok: false as const, reason: 'forbidden' as const }))
      })
      const { deps: d, recorded } = deps(gw)
      Object.assign(d, resolves())
      await expect(
        executeTool(ctx, 'sendMessage', { channel: 'C_OTHER', attachment: 'shot.png', message: 'hi' }, d)
      ).rejects.toThrow(/rejected the file "shot.png" \(forbidden\)/)
      expect(recorded).toEqual([])
    })

    it('refuses an unforwardable name without blaming the spelling or inviting a re-send', async () => {
      const gw = anchorless()
      const { deps: d } = deps(gw)
      Object.assign(d, resolves())
      await expect(
        executeTool(ctx, 'sendMessage', { channel: 'C_OTHER', attachment: 'nope.png', message: 'hi' }, d)
      ).rejects.toThrow(/"nope.png" cannot be forwarded/)
      expect(gw.uploadFile).not.toHaveBeenCalled()
      expect(gw.postMessage).not.toHaveBeenCalled()
      // An agent read an earlier phrasing backwards and asked the user to re-send the picture
      // AS a document — the one move that cannot help. The refusal now forecloses it.
      await expect(
        executeTool(ctx, 'sendMessage', { channel: 'C_OTHER', attachment: 'nope.png', message: 'hi' }, d)
      ).rejects.toThrow(/Do NOT ask anyone to re-send it/)
    })

    it('refuses a target platform with no upload port rather than sending the caption alone', async () => {
      const gw = fakeGateway()
      const { deps: d } = deps(gw)
      Object.assign(d, resolves())
      await expect(
        executeTool(ctx, 'sendMessage', { channel: 'C_OTHER', attachment: 'shot.png', message: 'hi' }, d)
      ).rejects.toThrow(/cannot post files/)
      expect(gw.postMessage).not.toHaveBeenCalled()
    })
  })

  // shareFile (agent-authored-attachments.md §3): the produced-file share into the CURRENT
  // conversation — coordinate-less, fenced, budgeted, and never a session seed.
  describe('shareFile', () => {
    const image = {
      ok: true as const,
      bytes: Buffer.from('PNGBYTES'),
      name: 'chart.png',
      mimeType: 'image/png',
      sha256: 'a'.repeat(64)
    }
    const target = {
      ok: true as const,
      platform: 'slack',
      integrationId: 'int-1',
      channel: 'C_CURRENT',
      thread: '111.1',
      replyTo: 41
    }
    function shareDeps(over: Partial<OpsDeps> = {}) {
      const gw = fakeGateway({ uploadFile: vi.fn(async () => ({ ok: true as const, messageId: 'ts-42' })) })
      const shares: unknown[] = []
      const d = makeDeps({
        gatewayFor: () => gw,
        shareTarget: () => target,
        readWorkspaceImage: async (_c, path) => (path === 'out/chart.png' ? image : { ok: false, reason: 'not-found' }),
        chargeShareBudget: vi.fn(() => ({ ok: true as const, release: vi.fn() })),
        recordShare: async (_c, row) => {
          shares.push(row)
        },
        ...over
      })
      return { d, gw, shares }
    }

    it('posts into the active turn’s own conversation with the trusted anchor and identity', async () => {
      const { d, gw, shares } = shareDeps()
      const res = (await executeTool(
        ctx,
        'shareFile',
        { path: 'out/chart.png', caption: 'revenue by week' },
        d
      )) as Record<string, unknown>

      expect(gw.uploadFile).toHaveBeenCalledWith(
        'C_CURRENT',
        { bytes: image.bytes, name: 'chart.png', mimeType: 'image/png' },
        'revenue by week',
        { thread: '111.1', replyTo: 41 },
        authorIdentity
      )
      expect(res).toMatchObject({
        ok: true,
        shared: { path: 'out/chart.png', mimeType: 'image/png', bytes: image.bytes.byteLength },
        post: { platform: 'slack', channel: 'C_CURRENT', ts: 'ts-42' }
      })
      // Provenance row: caption + the [shared: …] marker, with the bytes for console replay.
      expect(shares).toEqual([
        expect.objectContaining({
          ts: 'ts-42',
          text: expect.stringContaining('[shared: out/chart.png (image/png, 8 bytes, sha256:aaaaaaaaaaaaaaaa)]'),
          image: expect.objectContaining({ mimeType: 'image/png' })
        })
      ])
    })

    it('neutralizes mention syntax in the caption — it labels a file, it must not ping', async () => {
      const { d, gw } = shareDeps()
      await executeTool(
        ctx,
        'shareFile',
        { path: 'out/chart.png', caption: 'cc <@U1> @here <at user_id="all">everyone</at>' },
        d
      )
      const caption = (gw.uploadFile as ReturnType<typeof vi.fn>).mock.calls[0]![2] as string
      expect(caption).not.toContain('<@U1>')
      expect(caption).not.toContain('@here')
      expect(caption).not.toContain('<at ')
      expect(caption).toContain('U1')
    })

    it('reports a failed transcript record as a notice, never as a failed share', async () => {
      // The image is already in the conversation; a thrown error here would invite the
      // double-posting retry the outcome vocabulary exists to prevent.
      const { d } = shareDeps({
        recordShare: async () => {
          throw new Error('store closed')
        }
      })
      const res = (await executeTool(ctx, 'shareFile', { path: 'out/chart.png' }, d)) as Record<string, unknown>
      expect(res).toMatchObject({ ok: true, notice: expect.stringContaining('transcript') })
    })

    it('refuses a headless turn — its whole point is that nothing is posted', async () => {
      const { d, gw } = shareDeps({ shareTarget: () => ({ ok: false, reason: 'headless' }) })
      await expect(executeTool(ctx, 'shareFile', { path: 'out/chart.png' }, d)).rejects.toThrow(/headless/)
      expect(gw.uploadFile).not.toHaveBeenCalled()
    })

    it('refuses a postless A2A child, whose live gateway would otherwise pass the port probe', async () => {
      const { d } = shareDeps({ shareTarget: () => ({ ok: false, reason: 'no-conversation' }) })
      await expect(executeTool(ctx, 'shareFile', { path: 'out/chart.png' }, d)).rejects.toThrow(
        /no platform conversation/
      )
    })

    it('refuses before any file I/O when the platform cannot host files', async () => {
      const reads = vi.fn(async () => image)
      const { d } = shareDeps({ gatewayFor: () => fakeGateway(), readWorkspaceImage: reads })
      await expect(executeTool(ctx, 'shareFile', { path: 'out/chart.png' }, d)).rejects.toThrow(/cannot host files/)
      expect(reads).not.toHaveBeenCalled()
    })

    it('names GIF in its refusal — a plausible find-me-images result, not a generic non-image', async () => {
      const { d } = shareDeps({ readWorkspaceImage: async () => ({ ok: false, reason: 'gif' }) })
      await expect(executeTool(ctx, 'shareFile', { path: 'anim.gif' }, d)).rejects.toThrow(/GIF is not supported/)
    })

    it('refuses over the per-turn budget and never uploads', async () => {
      const { d, gw } = shareDeps({ chargeShareBudget: () => ({ ok: false }) })
      await expect(executeTool(ctx, 'shareFile', { path: 'out/chart.png' }, d)).rejects.toThrow(/upload budget/)
      expect(gw.uploadFile).not.toHaveBeenCalled()
    })

    it('releases the budget charge when the upload is refused, and names the reason', async () => {
      const release = vi.fn()
      const { d } = shareDeps({
        gatewayFor: () =>
          fakeGateway({ uploadFile: vi.fn(async () => ({ ok: false as const, reason: 'missing_scope' as const })) }),
        chargeShareBudget: () => ({ ok: true, release })
      })
      await expect(executeTool(ctx, 'shareFile', { path: 'out/chart.png' }, d)).rejects.toThrow(
        /file-upload permission/
      )
      expect(release).toHaveBeenCalledOnce()
    })

    it('says MAY-have-landed on an indeterminate outcome, and forbids the retry', async () => {
      const { d, shares } = shareDeps({
        gatewayFor: () =>
          fakeGateway({ uploadFile: vi.fn(async () => ({ ok: false as const, reason: 'indeterminate' as const })) })
      })
      await expect(executeTool(ctx, 'shareFile', { path: 'out/chart.png' }, d)).rejects.toThrow(/do NOT retry/)
      expect(shares).toEqual([])
    })

    it('refuses an over-long caption up front, before anything is read or sent', async () => {
      const reads = vi.fn(async () => image)
      const { d } = shareDeps({ readWorkspaceImage: reads })
      await expect(
        executeTool(ctx, 'shareFile', { path: 'out/chart.png', caption: 'x'.repeat(1001) }, d)
      ).rejects.toThrow(/1000 characters/)
      expect(reads).not.toHaveBeenCalled()
    })

    it('surfaces a partial send (caption lost after the file) as a notice on success', async () => {
      const { d } = shareDeps({
        gatewayFor: () =>
          fakeGateway({
            uploadFile: vi.fn(async () => ({ ok: true as const, warning: 'part of its caption did not post' }))
          })
      })
      const res = (await executeTool(ctx, 'shareFile', { path: 'out/chart.png', caption: 'hi' }, d)) as Record<
        string,
        unknown
      >
      expect(res).toMatchObject({ ok: true, notice: expect.stringContaining('part of its caption') })
      // No message id came back (Slack), so the transcript ts is synthesized like sendMessage's.
      expect(res).toMatchObject({ post: expect.objectContaining({ ts: 'local-1000' }) })
    })
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
        recordOutbound: async (_c, channel, thread, text, ts) => void recorded.push({ channel, thread, text, ts }),
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
      await executeTool(tgCtx, 'sendMessage', { platform: 'telegram', channel: '-100123', message: 'hi' }, d)
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
      await executeTool(tgSession, 'sendMessage', { toAgent: 'peer-1', channel: '-100123', message: 'hi' }, d)
      expect(wakes[0]).toMatchObject({ thread: 'tg:172', transcriptTs: '172' })
    })

    it('keys a non-Telegram root post by the platform’s own conversation model', async () => {
      // Slack's ts already IS the thread segment, so the post opens a session on itself.
      const slack = tgDeps({ gatewayFor: () => fakeGateway() })
      await executeTool(ctx, 'sendMessage', { channel: 'C_X', message: 'hi' }, slack.d)
      expect(slack.spawns[0]).toMatchObject({ thread: 'ts-123', postTs: 'ts-123' })
    })

    it('keys a Discord guild root post by its message id', async () => {
      // A native Discord thread opened from this post receives the same id as its
      // starter message, so later in-thread replies meet this initialized session.
      const createThread = vi.fn(async () => '900')
      const discord = tgDeps({}, { postMessage: vi.fn(async () => '900'), createThread })
      await executeTool(
        withIntegration('discord', 'int-dc'),
        'sendMessage',
        { platform: 'discord', channel: 'C42', message: 'hi' },
        discord.d
      )
      expect(discord.spawns[0]).toMatchObject({ thread: '900', postTs: '900' })
      expect(discord.recorded[0]).toMatchObject({ thread: '900', ts: '900' })
      expect(createThread).toHaveBeenCalledWith('C42', '900', 'hi')
    })

    it('does not initialize a Discord root session when its native thread cannot be created', async () => {
      const discord = tgDeps({}, { postMessage: vi.fn(async () => '900'), createThread: vi.fn(async () => undefined) })
      await expect(
        executeTool(
          withIntegration('discord', 'int-dc'),
          'sendMessage',
          { platform: 'discord', channel: 'C42', message: 'hi' },
          discord.d
        )
      ).rejects.toThrow(/required thread could not be created/)
      expect(discord.spawns).toHaveLength(0)
      expect(discord.recorded[0]).toMatchObject({ thread: '900', ts: '900' })
    })

    it('joins a DM instead of forking it, on each platform that keeps DMs continuous', async () => {
      // A DM is one stream: Telegram keys it `dm`, Feishu keys it by the chat. Only the platform
      // knows which chats those are, so ops asks — and asks only where the answer changes the key.
      const asDm = { getChannelInfo: vi.fn(async (id: string) => ({ id, isIm: true })) }
      const tgDm = tgDeps({}, asDm)
      await executeTool(tgCtx, 'sendMessage', { platform: 'telegram', channel: '555', message: 'hi' }, tgDm.d)
      expect(tgDm.spawns[0]).toMatchObject({ thread: 'dm', postTs: '172' })

      const feishuDm = tgDeps({}, asDm)
      await executeTool(
        withIntegration('feishu', 'int-fs'),
        'sendMessage',
        { platform: 'feishu', channel: 'oc_42', message: 'hi' },
        feishuDm.d
      )
      expect(feishuDm.spawns[0]).toMatchObject({ thread: 'oc_42', postTs: '172' })

      const createThread = vi.fn(async () => '900')
      const discordDm = tgDeps({}, { ...asDm, postMessage: vi.fn(async () => '900'), createThread })
      await executeTool(
        withIntegration('discord', 'int-dc'),
        'sendMessage',
        { platform: 'discord', channel: 'D42', message: 'hi' },
        discordDm.d
      )
      expect(discordDm.spawns[0]).toMatchObject({ thread: 'D42', postTs: '900' })
      expect(createThread).not.toHaveBeenCalled()

      // A Feishu GROUP threads off the message, like Slack.
      const feishuGroup = tgDeps()
      await executeTool(
        withIntegration('feishu', 'int-fs'),
        'sendMessage',
        { platform: 'feishu', channel: 'oc_43', message: 'hi' },
        feishuGroup.d
      )
      expect(feishuGroup.spawns[0]).toMatchObject({ thread: '172', postTs: '172' })
    })

    it('does not interrogate the platform where the answer cannot change the key', async () => {
      // Slack and Discord key the same way for DMs and channels, so no send pays for a
      // lookup it does not need.
      const getChannelInfo = vi.fn(async (id: string) => ({ id, isIm: true }))
      const slack = tgDeps({}, { getChannelInfo })
      await executeTool(ctx, 'sendMessage', { channel: 'C_X', message: 'hi' }, slack.d)
      expect(getChannelInfo).not.toHaveBeenCalled()
    })

    it('falls back to a non-DM key when the platform lookup fails', async () => {
      // The post already happened; a failed classification must not fail the call.
      const flaky = tgDeps({}, { getChannelInfo: vi.fn(async () => Promise.reject(new Error('rate limited'))) })
      await executeTool(tgCtx, 'sendMessage', { platform: 'telegram', channel: '555', message: 'hi' }, flaky.d)
      expect(flaky.spawns[0]).toMatchObject({ thread: 'tg:172', postTs: '172' })
    })
  })

  describe('root-post notice: the post forked a conversation this agent is already in', () => {
    // The spawn is what the notice describes, so it only speaks where a daemon actually seeds
    // the session (the chat CLI passes no spawn callback and gets no notice).
    const rootPostDeps = (over: Partial<OpsDeps> = {}) =>
      makeDeps({ gatewayFor: () => fakeGateway(), spawnChannelRootSession: () => true, now: () => 1000, ...over })
    const send = (d: OpsDeps, to: Record<string, unknown>, from: SessionContext = ctx) =>
      executeTool(from, 'sendMessage', { ...to, message: 'the answer' }, d) as Promise<{ notice?: string }>

    // Which conversation a post landed on is the DAEMON's verdict (it owns transport-scope
    // identity and the durable parent link); ops only formats what it is told.
    const parentRelation = { kind: 'parent', sessionId: 'sess-parent' } as const
    const dualCtx: SessionContext = {
      ...ctx,
      integrations: [...ctx.integrations!, { id: 'int-tg', platform: 'telegram' }]
    }

    it('names the parent session to reply into when the post lands on the parent’s conversation', async () => {
      const d = rootPostDeps({ rootPostRelation: async () => parentRelation })
      const res = await send(d, { platform: 'telegram', channel: '-100123' }, dualCtx)
      // The claim is about what a ROOT post does — a separate context, not an answer. The seed
      // itself is dispatched fire-and-forget, so the notice never states a session as fact.
      expect(res.notice).toContain('starts a separate context there instead of answering')
      expect(res.notice).not.toMatch(/opened a (NEW )?session/)
      expect(res.notice).toContain('{"sessionId":"sess-parent"}')
    })

    it('points a post into its own conversation back at the turn’s ordinary reply', async () => {
      const d = rootPostDeps({ rootPostRelation: async () => ({ kind: 'self' }) })
      const res = await send(d, { channel: 'C_CURRENT' })
      expect(res.notice).toContain('Your ordinary reply for this turn already reaches this conversation')
    })

    it('passes the target coords the daemon needs to judge conversation identity', async () => {
      const seen: Record<string, unknown>[] = []
      const d = rootPostDeps({
        rootPostRelation: async (req) => {
          seen.push(req)
          return undefined
        }
      })
      await send(d, { platform: 'telegram', channel: '-100123' }, dualCtx)
      // Including the integration — the daemon resolves it to a transport scope, without which
      // two bots' identical channel ids would read as the same conversation — and the post's own
      // thread key, without which it cannot tell a fork from a message that simply landed.
      expect(seen[0]).toMatchObject({
        callerAgentId: 'bot-a',
        platform: 'slack',
        callerChannel: 'C_CURRENT',
        callerThread: '111.1',
        targetPlatform: 'telegram',
        targetChannel: '-100123',
        targetThread: 'ts-123',
        targetIntegrationId: 'int-tg'
      })
    })

    it('stays quiet for an unrelated destination', async () => {
      const unrelated = rootPostDeps({ rootPostRelation: async () => undefined })
      expect((await send(unrelated, { channel: 'C_OTHER' })).notice).toBeUndefined()
    })

    it('says nothing when no session was actually seeded', async () => {
      // No daemon at all (chat CLI).
      const noSpawn = makeDeps({
        gatewayFor: () => fakeGateway(),
        rootPostRelation: async () => parentRelation,
        now: () => 1000
      })
      expect((await send(noSpawn, { platform: 'telegram', channel: '-100123' }, dualCtx)).notice).toBeUndefined()
      // A platform that returned no ts leaves nothing to key a session on, so nothing forked.
      const noTs = rootPostDeps({
        gatewayFor: () => fakeGateway({ postMessage: vi.fn(async () => undefined) }),
        rootPostRelation: async () => parentRelation
      })
      expect((await send(noTs, { platform: 'telegram', channel: '-100123' }, dualCtx)).notice).toBeUndefined()
      // The daemon DECLINED the seed (agent-call hop limit): the post happened, but claiming a
      // session opened would be false.
      const declined = rootPostDeps({
        spawnChannelRootSession: () => false,
        rootPostRelation: async () => parentRelation
      })
      expect((await send(declined, { platform: 'telegram', channel: '-100123' }, dualCtx)).notice).toBeUndefined()
    })
  })

  it('synthesizes a ts when the platform returns none', async () => {
    const gw = fakeGateway({ postMessage: vi.fn(async () => undefined) })
    const { deps: d } = deps(gw)
    const res = (await executeTool(ctx, 'sendMessage', { channel: 'C_CURRENT', message: 'hi' }, d)) as {
      post: { ts: string }
    }
    expect(res.post.ts).toBe('local-1000')
  })

  it('rejects a missing message argument', async () => {
    const { deps: d } = deps(fakeGateway())
    await expect(executeTool(ctx, 'sendMessage', { channel: 'C_CURRENT' }, d)).rejects.toThrow(/message/)
  })

  it('rejects a platform the agent has no integration for', async () => {
    const { deps: d } = deps(fakeGateway())
    await expect(
      executeTool(ctx, 'sendMessage', { platform: 'discord', channel: 'D1', message: 'hi' }, d)
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
      { platform: 'telegram', channel: '-100123', message: 'hi' },
      d
    )) as { post: Record<string, unknown> }
    expect(gw.postMessage).toHaveBeenCalledWith('-100123', 'hi', undefined, authorIdentity)
    expect(res.post).toMatchObject({ platform: 'telegram', integrationId: 'int-tg', channel: '-100123' })
    // Pre-fix this row carried the CALLER's Slack thread under a Telegram channel — coords that
    // belong to no session, and a trap for the reply-owner lookup. It now keys the post's own.
    expect(recorded).toEqual([{ channel: '-100123', thread: 'ts-123', text: 'hi', ts: 'ts-123' }])
  })

  it('rejects a platform-only target with repairable examples and no side effect', async () => {
    const gw = fakeGateway()
    const { deps: d } = deps(gw)
    const dual = { ...ctx, integrations: [...ctx.integrations!, { id: 'int-tg', platform: 'telegram' }] }
    await expect(executeTool(dual, 'sendMessage', { platform: 'telegram', message: 'hi' }, d)).rejects.toThrow(
      /Valid targets:.*toAgent.*toUser.*channel.*sessionId/
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
    const res = (await executeTool(multi, 'sendMessage', { channel: 'C_CURRENT', message: 'hi' }, d)) as {
      post: Record<string, unknown>
    }
    expect(gw.postMessage).toHaveBeenCalledWith('C_CURRENT', 'hi', undefined, authorIdentity)
    expect(res.post).toMatchObject({ integrationId: 'int-b', channel: 'C_CURRENT' })
  })

  it('stamps the agent’s own identity (from the session, not tool input) onto the send', async () => {
    const gw = fakeGateway()
    const { deps: d } = deps(gw)
    const withIdentity = { ...ctx, agentName: 'Bot A', iconUrl: 'https://x/y.png' }
    await executeTool(withIdentity, 'sendMessage', { channel: 'C_CURRENT', message: 'hi' }, d)
    expect(gw.postMessage).toHaveBeenCalledWith('C_CURRENT', 'hi', undefined, {
      username: 'Bot A',
      icon_url: 'https://x/y.png',
      agentAuthorId: 'bot-a'
    })
  })

  it('stamps the stable author id when the session has no visual identity', async () => {
    const gw = fakeGateway()
    const { deps: d } = deps(gw)
    await executeTool(ctx, 'sendMessage', { channel: 'C_CURRENT', message: 'hi' }, d)
    expect(gw.postMessage).toHaveBeenCalledWith('C_CURRENT', 'hi', undefined, authorIdentity)
  })

  it('toUser alone sends a Slack DM without changing the message body', async () => {
    const gw = fakeGateway()
    const { deps: d, recorded } = deps(gw)
    const res = (await executeTool(ctx, 'sendMessage', { toUser: 'U9', message: 'ping' }, d)) as {
      post: Record<string, unknown>
    }
    expect(gw.openDirectMessage).toHaveBeenCalledWith('U9')
    expect(gw.postMessage).toHaveBeenCalledWith('D-U9', 'ping', undefined, authorIdentity)
    expect(recorded).toEqual([{ channel: 'D-U9', thread: 'ts-123', text: 'ping', ts: 'ts-123' }])
    expect(res.post).toMatchObject({ platform: 'slack', channel: 'D-U9', thread: null, ts: 'ts-123' })
  })

  it('rejects toUser off Slack before posting', async () => {
    const gw = fakeGateway()
    const { deps: d } = deps(gw)
    // `toUser` needs the Layer-1 openDirectMessage read port, which only Slack
    // declares — on another platform it throws (nothing posted). The error still
    // NAMES the capable platform, which is the whole reason the declaration
    // carries a label instead of core carrying the literal.
    const dual = { ...ctx, integrations: [...ctx.integrations!, { id: 'int-tg', platform: 'telegram' }] }
    await expect(
      executeTool(dual, 'sendMessage', { toUser: '42', platform: 'telegram', message: 'x' }, d)
    ).rejects.toThrow('sendMessage: toUser is only supported on Slack (not telegram) yet')
    expect(gw.postMessage).not.toHaveBeenCalled()
  })

  it('rejects the toUser CHANNEL form off Slack too — the whole mode rides the port', async () => {
    // Not just the DM form: the channel-root form renders `<@id>` mentions, which
    // is the same platform's syntax. Both arms were behind one `!== 'slack'` gate
    // and both stay behind the one port check.
    const gw = fakeGateway()
    const { deps: d } = deps(gw)
    const dual = { ...ctx, integrations: [...ctx.integrations!, { id: 'int-tg', platform: 'telegram' }] }
    await expect(
      executeTool(dual, 'sendMessage', { toUser: '42', channel: '-100123', platform: 'telegram', message: 'x' }, d)
    ).rejects.toThrow('sendMessage: toUser is only supported on Slack (not telegram) yet')
    expect(gw.postMessage).not.toHaveBeenCalled()
  })

  it('defaults a DM to the port-capable platform even from a session on another one', async () => {
    // A Telegram-triggered session that also owns a Slack bot DMs through SLACK
    // when the caller names no platform: the DM form defaults to the platform
    // that can open one, not to the session's own.
    const gw = fakeGateway()
    const { deps: d } = deps(gw)
    const fromTelegram = {
      ...ctx,
      platform: 'telegram',
      integrationId: 'int-tg',
      integrations: [
        { id: 'int-tg', platform: 'telegram' },
        { id: 'int-1', platform: 'slack' }
      ]
    }
    const res = (await executeTool(fromTelegram, 'sendMessage', { toUser: 'U9', message: 'ping' }, d)) as {
      post: Record<string, unknown>
    }
    expect(gw.openDirectMessage).toHaveBeenCalledWith('U9')
    expect(res.post).toMatchObject({ platform: 'slack', integrationId: 'int-1', channel: 'D-U9' })
  })

  it('reports the missing integration first when the agent has no port-capable bot at all', async () => {
    // Ordering is load-bearing and unchanged: the DM default resolves to Slack,
    // gateway resolution runs BEFORE the port gate, so a Telegram-only agent gets
    // "no slack integration" rather than "not supported on Slack".
    const gw = fakeGateway()
    const { deps: d } = deps(gw)
    const telegramOnly = {
      ...ctx,
      platform: 'telegram',
      integrationId: 'int-tg',
      integrations: [{ id: 'int-tg', platform: 'telegram' }]
    }
    await expect(executeTool(telegramOnly, 'sendMessage', { toUser: '42', message: 'x' }, d)).rejects.toThrow(
      'this agent has no slack integration'
    )
    expect(gw.postMessage).not.toHaveBeenCalled()
  })

  it('reports a selected integration whose live connection cannot open a DM', async () => {
    // The platform declares the port; THIS gateway does not implement it (a
    // send-only connection). The live probe is the second, narrower gate.
    const gw = fakeGateway({ openDirectMessage: undefined })
    const { deps: d } = deps(gw)
    await expect(executeTool(ctx, 'sendMessage', { toUser: 'U9', message: 'ping' }, d)).rejects.toThrow(
      'sendMessage: the selected Slack integration cannot open direct messages'
    )
    expect(gw.postMessage).not.toHaveBeenCalled()
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

  it('reads one channel-history page and forwards Slack pagination arguments', async () => {
    const getChannelHistory = vi.fn(async () => ({
      messages: [{ sender: 'U1', ts: '100.5', text: 'hello', isBot: false }],
      hasMore: true,
      nextCursor: 'next-page'
    }))
    const gw = fakeGateway({ getChannelHistory })
    const { deps: d } = deps(gw)

    const res = (await executeTool(
      ctx,
      'getChannelHistory',
      { cursor: 'previous-page', limit: 2, oldest: '100.0', latest: '100.5' },
      d
    )) as Record<string, unknown>

    expect(getChannelHistory).toHaveBeenCalledWith('C_CURRENT', {
      cursor: 'previous-page',
      limit: 2,
      oldest: '100.0',
      latest: '100.5'
    })
    expect(res).toMatchObject({
      platform: 'slack',
      channel: 'C_CURRENT',
      hasMore: true,
      nextCursor: 'next-page'
    })

    await executeTool(ctx, 'getChannelHistory', { channel: 'C_OTHER' }, d)
    expect(getChannelHistory).toHaveBeenLastCalledWith('C_CURRENT', {})
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
    const d: OpsDeps = { ...base, observedChannels: async () => observed }
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
    const d = makeDeps({ gatewayFor: () => undefined, now: () => 0, observedUsers: async () => users })
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
    const observedChannels = vi.fn(async () => [{ id: 'C_HIST' }])
    const observedUsers = vi.fn(async () => [{ id: 'U_HIST' }])
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

describe('executeTool: getThreadHistory', () => {
  const reply = (over: Record<string, unknown> = {}) => ({
    sender: 'U1',
    ts: '100.1',
    text: 'hello',
    isBot: false,
    chrome: false,
    attachments: [],
    ...over
  })

  it('reads the bound channel by default and forwards the window', async () => {
    const getThreadReplies = vi.fn(async () => [reply()])
    const { deps: d } = deps(fakeGateway({ getThreadReplies }))

    const res = (await executeTool(
      ctx,
      'getThreadHistory',
      { thread: '99.9', limit: 25, oldest: '100.0', latest: '200.0' },
      d
    )) as Record<string, unknown>

    expect(getThreadReplies).toHaveBeenCalledWith('C_CURRENT', '99.9', 25, {
      oldest: '100.0',
      latest: '200.0',
      throwOnError: true,
      readState: { truncated: false }
    })
    expect(res).toMatchObject({ platform: 'slack', channel: 'C_CURRENT', thread: '99.9', truncated: false })
  })

  // Status chrome is this daemon's own streaming placeholders — noise to a reader, and the
  // one thing the provider read cannot filter for us.
  it('drops chrome rows and projects attachments the agent can then fetch', async () => {
    const getThreadReplies = vi.fn(
      async (_c: string, _t: string, _m?: number, w?: { readState?: { truncated: boolean } }) => {
        if (w?.readState) w.readState.truncated = true
        return [
          reply({ chrome: true, text: 'thinking…' }),
          reply({
            ts: '100.2',
            agentAuthorId: 'agent-7',
            appId: 'A123',
            chromeOwnerAgentId: 'agent-7',
            attachments: [
              { id: 'F1', name: 'chart.png', mimeType: 'image/png', sourceUrl: 'https://files.slack.com/x' }
            ]
          })
        ]
      }
    )
    const { deps: d } = deps(fakeGateway({ getThreadReplies }))

    const res = (await executeTool(ctx, 'getThreadHistory', { thread: '99.9' }, d)) as {
      truncated: boolean
      messages: Record<string, unknown>[]
    }

    expect(res.truncated).toBe(true)
    expect(res.messages).toEqual([
      {
        sender: 'U1',
        ts: '100.2',
        text: 'hello',
        isBot: false,
        agentId: 'agent-7',
        attachments: [{ name: 'chart.png', mimeType: 'image/png', url: 'https://files.slack.com/x' }]
      }
    ])
  })

  it('needs an explicit channel across platforms, and refuses a connection without the port', async () => {
    const tgGw = fakeGateway()
    const { deps: base } = deps(fakeGateway({ getThreadReplies: vi.fn(async () => []) }))
    const d: OpsDeps = {
      ...base,
      gatewayFor: (id) => (id === 'int-tg' ? tgGw : fakeGateway({ getThreadReplies: vi.fn(async () => []) }))
    }
    const dual = { ...ctx, integrations: [...ctx.integrations!, { id: 'int-tg', platform: 'telegram' }] }

    await expect(executeTool(dual, 'getThreadHistory', { platform: 'telegram', thread: '1' }, d)).rejects.toThrow(
      /channel is required/
    )
    await expect(
      executeTool(dual, 'getThreadHistory', { platform: 'telegram', channel: '-100', thread: '1' }, d)
    ).rejects.toThrow(/thread history is unavailable/)
  })
})

describe('executeTool: reactions', () => {
  it('adds a reaction, tolerating the colons a model may wrap it in', async () => {
    const addReaction = vi.fn(async () => {})
    const { deps: d } = deps(fakeGateway({ addReaction }))

    const res = (await executeTool(ctx, 'addReaction', { messageTs: '100.1', emoji: ':eyes:' }, d)) as Record<
      string,
      unknown
    >

    expect(addReaction).toHaveBeenCalledWith('C_CURRENT', '100.1', 'eyes')
    expect(res).toEqual({ platform: 'slack', channel: 'C_CURRENT', messageTs: '100.1', emoji: 'eyes', added: true })
  })

  it('reads reactions off another channel when told which', async () => {
    const getReactions = vi.fn(async () => [{ name: 'tada', count: 2, users: ['U1', 'U2'] }])
    const { deps: d } = deps(fakeGateway({ getReactions }))

    const res = (await executeTool(ctx, 'getReactions', { channel: 'C_OTHER', messageTs: '100.1' }, d)) as Record<
      string,
      unknown
    >

    expect(getReactions).toHaveBeenCalledWith('C_OTHER', '100.1')
    expect(res).toMatchObject({ channel: 'C_OTHER', reactions: [{ name: 'tada', count: 2, users: ['U1', 'U2'] }] })
  })

  it('refuses on a connection that does not offer them', async () => {
    const { deps: d } = deps(fakeGateway())
    await expect(executeTool(ctx, 'addReaction', { messageTs: '1', emoji: 'eyes' }, d)).rejects.toThrow(
      /reactions is unavailable/
    )
  })
})

describe('executeTool: bookmarks', () => {
  it('defaults to the session conversation and returns what is pinned', async () => {
    const list = vi.fn(async () => [{ id: 'Bk1', title: 'Runbook', link: 'https://x.test/rb' }])
    const { deps: d } = deps(fakeGateway({ listBookmarks: list }))

    const res = (await executeTool(ctx, 'listBookmarks', {}, d)) as Record<string, unknown>
    expect(list).toHaveBeenCalledWith('C_CURRENT')
    expect(res).toMatchObject({ channel: 'C_CURRENT', bookmarks: [{ id: 'Bk1', title: 'Runbook' }] })
  })

  it('pins a link in a channel the model named', async () => {
    const add = vi.fn(async () => ({ id: 'Bk2', title: 'Dash', link: 'https://x.test/d' }))
    const { deps: d } = deps(fakeGateway({ addBookmark: add }))

    await executeTool(ctx, 'addBookmark', { channel: 'C_OTHER', title: 'Dash', link: 'https://x.test/d' }, d)
    expect(add).toHaveBeenCalledWith('C_OTHER', { title: 'Dash', link: 'https://x.test/d' })
  })

  it('removes by the id a read returned', async () => {
    const remove = vi.fn(async () => undefined)
    const { deps: d } = deps(fakeGateway({ removeBookmark: remove }))

    const res = (await executeTool(ctx, 'removeBookmark', { bookmarkId: 'Bk1' }, d)) as Record<string, unknown>
    expect(remove).toHaveBeenCalledWith('C_CURRENT', 'Bk1')
    expect(res).toMatchObject({ removed: 'Bk1' })
  })

  // `ctx.channel` belongs to the SESSION's platform. Defaulting to it for a cross-platform call
  // hands Slack a Telegram id, which fails as `channel_not_found` well away from the cause.
  it('requires an explicit channel when the target is not this conversation', async () => {
    const add = vi.fn(async () => ({ id: 'Bk1', title: 't' }))
    const { deps: d } = deps(fakeGateway({ addBookmark: add }))
    // A Telegram session whose agent also has Slack: the resolved target is a different
    // integration, so `ctx.channel` is a Telegram id that Slack would reject.
    const elsewhere: SessionContext = {
      ...ctx,
      platform: 'telegram',
      integrationId: 'int-tg',
      channel: '-100123',
      integrations: [
        { id: 'int-tg', platform: 'telegram' },
        { id: 'int-1', platform: 'slack' }
      ]
    }

    await expect(
      executeTool(elsewhere, 'addBookmark', { platform: 'slack', title: 't', link: 'https://x.test' }, d)
    ).rejects.toThrow(/channel is required/)
    expect(add).not.toHaveBeenCalled()

    // Naming one is all it takes.
    await executeTool(elsewhere, 'addBookmark', { platform: 'slack', channel: 'C_SLACK', title: 't', link: 'l' }, d)
    expect(add).toHaveBeenCalledWith('C_SLACK', { title: 't', link: 'l' })
  })

  it('refuses on a platform that does not pin links', async () => {
    const { deps: d } = deps(fakeGateway())
    await expect(executeTool(ctx, 'addBookmark', { title: 't', link: 'l' }, d)).rejects.toThrow(
      /bookmarks is unavailable/
    )
  })
})

describe('executeTool: lists', () => {
  // A write is addressed by column id and keyed by column type, and Slack publishes no schema
  // endpoint — so the read has to carry the columns or the write tools are unusable.
  it('returns rows together with the columns a write needs', async () => {
    const page = {
      columns: [{ id: 'Col1', type: 'rich_text' }],
      items: [{ id: 'Rec1', fields: { Col1: 'ship it' } }],
      nextCursor: 'p2'
    }
    const read = vi.fn(async () => page)
    const { deps: d } = deps(fakeGateway({ readList: read }))

    const res = (await executeTool(ctx, 'readList', { listId: 'F1', limit: 50 }, d)) as Record<string, unknown>
    expect(read).toHaveBeenCalledWith('F1', { limit: 50 })
    expect(res).toMatchObject({ listId: 'F1', columns: page.columns, items: page.items, nextCursor: 'p2' })
  })

  it('appends a row from column ids the read handed back', async () => {
    const add = vi.fn(async () => ({ id: 'Rec2', fields: {} }))
    const { deps: d } = deps(fakeGateway({ addListItem: add }))
    const fields = [{ columnId: 'Col1', type: 'rich_text', value: ['x'] }]

    await executeTool(ctx, 'addListItem', { listId: 'F1', fields }, d)
    expect(add).toHaveBeenCalledWith('F1', fields)
  })

  it('refuses a write that names no column', async () => {
    const { deps: d } = deps(fakeGateway({ addListItem: vi.fn() }))
    await expect(executeTool(ctx, 'addListItem', { listId: 'F1', fields: [] }, d)).rejects.toThrow(
      /at least one column/
    )
  })

  it('updates only the named fields of a row', async () => {
    const update = vi.fn(async () => undefined)
    const { deps: d } = deps(fakeGateway({ updateListItem: update }))
    const fields = [{ columnId: 'Col1', type: 'checkbox', value: true }]

    await executeTool(ctx, 'updateListItem', { listId: 'F1', itemId: 'Rec1', fields }, d)
    expect(update).toHaveBeenCalledWith('F1', 'Rec1', fields)
  })
})

describe('executeTool: createConversation', () => {
  it('creates a channel and opens a direct conversation from the same tool', async () => {
    const createConversation = vi.fn(async (spec: { name?: string }) => ({ id: spec.name ? 'C_NEW' : 'D_NEW' }))
    const { deps: d } = deps(fakeGateway({ createConversation }))

    await executeTool(ctx, 'createConversation', { name: 'plans', isPrivate: true, users: ['U1'] }, d)
    expect(createConversation).toHaveBeenLastCalledWith({ name: 'plans', isPrivate: true, users: ['U1'] })

    const dm = (await executeTool(ctx, 'createConversation', { users: ['U1', 'U2'] }, d)) as Record<string, unknown>
    expect(createConversation).toHaveBeenLastCalledWith({ users: ['U1', 'U2'] })
    expect(dm).toEqual({ platform: 'slack', conversation: { id: 'D_NEW' } })
  })

  it('rejects a call that names neither a channel nor anyone to talk to', async () => {
    const { deps: d } = deps(fakeGateway({ createConversation: vi.fn(async () => ({ id: 'C_NEW' })) }))
    await expect(executeTool(ctx, 'createConversation', {}, d)).rejects.toThrow(/pass `name`.*or `users`/)
    await expect(executeTool(ctx, 'createConversation', { users: ['U1'], isPrivate: true }, d)).rejects.toThrow(
      /`isPrivate` describes a channel/
    )
  })
})

describe('executeTool: scheduleMessage', () => {
  const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString()

  it('resolves an ISO instant to the epoch second the platform wants', async () => {
    const scheduleMessage = vi.fn(async (channel: string, _t: string, postAt: number) => ({
      id: 'Q1',
      channel,
      postAt
    }))
    const { deps: d } = deps(fakeGateway({ scheduleMessage }))
    const at = iso(10 * 60 * 1000)

    const res = (await executeTool(ctx, 'scheduleMessage', { message: 'standup', postAt: at }, d)) as Record<
      string,
      unknown
    >

    const expected = Math.floor(Date.parse(at) / 1000)
    expect(scheduleMessage).toHaveBeenCalledWith('C_CURRENT', 'standup', expected)
    expect(res).toMatchObject({ platform: 'slack', id: 'Q1', channel: 'C_CURRENT', postAt: expected })
  })

  // The platform's own bounds, checked here so the agent gets something it can repair from
  // rather than a bare `time_in_past`.
  it('rejects a time it cannot schedule, before calling the platform', async () => {
    const scheduleMessage = vi.fn(async () => ({ id: 'Q1', channel: 'C_CURRENT', postAt: 0 }))
    const { deps: d } = deps(fakeGateway({ scheduleMessage }))

    await expect(executeTool(ctx, 'scheduleMessage', { message: 'x', postAt: 'tomorrow' }, d)).rejects.toThrow(
      /not an ISO-8601 instant/
    )
    await expect(executeTool(ctx, 'scheduleMessage', { message: 'x', postAt: iso(30 * 1000) }, d)).rejects.toThrow(
      /at least 2 minutes/
    )
    await expect(
      executeTool(ctx, 'scheduleMessage', { message: 'x', postAt: iso(200 * 24 * 3600 * 1000) }, d)
    ).rejects.toThrow(/at most 120 days/)
    expect(scheduleMessage).not.toHaveBeenCalled()
  })
})

describe('executeTool: canvases', () => {
  it('creates and reads one back', async () => {
    const createCanvas = vi.fn(async () => ({ id: 'F1', title: 'Plan', url: 'https://x/canvas' }))
    const readCanvas = vi.fn(async () => ({ id: 'F1', title: 'Plan', sections: [{ id: 's1' }] }))
    const { deps: d } = deps(fakeGateway({ createCanvas, readCanvas }))

    await executeTool(ctx, 'createCanvas', { title: 'Plan', markdown: '# Plan', channel: 'C1' }, d)
    expect(createCanvas).toHaveBeenCalledWith('Plan', '# Plan', 'C1')

    const read = (await executeTool(ctx, 'readCanvas', { canvasId: 'F1' }, d)) as Record<string, unknown>
    expect(readCanvas).toHaveBeenCalledWith('F1')
    expect(read).toEqual({ platform: 'slack', canvas: { id: 'F1', title: 'Plan', sections: [{ id: 's1' }] } })
  })

  it('applies edits, and rejects one the platform would only refuse later', async () => {
    const updateCanvas = vi.fn(async () => {})
    const { deps: d } = deps(fakeGateway({ updateCanvas }))

    const res = (await executeTool(
      ctx,
      'updateCanvas',
      {
        canvasId: 'F1',
        edits: [
          { operation: 'replace', markdown: '# New' },
          { operation: 'insert_after', sectionId: 's1', markdown: 'more' },
          { operation: 'delete', sectionId: 's2' }
        ]
      },
      d
    )) as Record<string, unknown>

    expect(updateCanvas).toHaveBeenCalledWith('F1', [
      { operation: 'replace', markdown: '# New' },
      { operation: 'insert_after', sectionId: 's1', markdown: 'more' },
      { operation: 'delete', sectionId: 's2' }
    ])
    expect(res).toEqual({ platform: 'slack', canvasId: 'F1', applied: 3 })

    await expect(
      executeTool(ctx, 'updateCanvas', { canvasId: 'F1', edits: [{ operation: 'insert_after', markdown: 'x' }] }, d)
    ).rejects.toThrow(/needs a sectionId/)
    await expect(
      executeTool(ctx, 'updateCanvas', { canvasId: 'F1', edits: [{ operation: 'replace' }] }, d)
    ).rejects.toThrow(/needs markdown/)
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

describe('executeTool: listAgents', () => {
  // A deps bundle whose channelAgents dep records the request it received and
  // returns a canned roster. gatewayFor throws to prove discovery does NOT need a
  // platform gateway (it runs before the gateway gate).
  function discoveryDeps(over: Partial<OpsDeps> = {}): {
    deps: OpsDeps
    calls: { platform: string; channel?: string; currentChannel?: string; requesterAgentId: string }[]
  } {
    const calls: { platform: string; channel?: string; currentChannel?: string; requesterAgentId: string }[] = []
    const d = makeDeps({
      gatewayFor: () => {
        throw new Error('gatewayFor must not be called for listAgents')
      },
      channelAgents: async (req) => {
        calls.push({
          platform: req.platform,
          channel: req.channel,
          currentChannel: req.currentChannel,
          requesterAgentId: req.requesterAgentId
        })
        return {
          platform: req.platform,
          ...(req.channel !== undefined ? { channel: req.channel } : {}),
          agents: [{ agentId: 'peer-1', name: 'peer', status: 'active' as const }]
        }
      },
      now: () => 0,
      ...over
    })
    return { deps: d, calls }
  }

  // The whole point of the org-scoped directory: NO channel is sent unless the agent asked
  // for one, so a session with no IM integration can still discover peers.
  it('sends NO channel by default (org-wide scope) and returns a channel-less roster', async () => {
    const { deps: d, calls } = discoveryDeps()
    const res = (await executeTool(ctx, 'listAgents', {}, d)) as { channel?: string; agents: unknown[] }
    expect(calls).toEqual([
      { platform: 'slack', channel: undefined, currentChannel: 'C_CURRENT', requesterAgentId: 'bot-a' }
    ])
    expect(res).not.toHaveProperty('channel')
    expect(res.agents).toEqual([{ agentId: 'peer-1', name: 'peer', status: 'active' }])
  })

  it('passes `channel` through as a filter when the agent asks for one', async () => {
    const { deps: d, calls } = discoveryDeps()
    const res = (await executeTool(ctx, 'listAgents', { channel: 'C_OTHER' }, d)) as { channel?: string }
    expect(calls[0]).toMatchObject({ channel: 'C_OTHER', currentChannel: 'C_CURRENT' })
    expect(res.channel).toBe('C_OTHER')
  })

  it('still answers to the deprecated `listChannelAgents` name, with the same org-wide default', async () => {
    const { deps: d, calls } = discoveryDeps()
    const res = (await executeTool(ctx, 'listChannelAgents', {}, d)) as { agents: unknown[] }
    expect(calls[0]).toEqual({
      platform: 'slack',
      channel: undefined,
      currentChannel: 'C_CURRENT',
      requesterAgentId: 'bot-a'
    })
    expect(res.agents).toHaveLength(1)
  })

  it('takes requesterAgentId + platform from the session context, NOT tool input', async () => {
    const { deps: d, calls } = discoveryDeps()
    // Attacker-controlled args attempt to impersonate another agent / probe another
    // platform — both must be ignored in favor of the trusted session context.
    await executeTool(ctx, 'listAgents', { requesterAgentId: 'someone-else', platform: 'telegram' }, d)
    expect(calls[0]).toEqual({
      platform: 'slack',
      channel: undefined,
      currentChannel: 'C_CURRENT',
      requesterAgentId: 'bot-a'
    })
  })

  // The daemon identifies the CALLING TURN by its logical sessionKey, which is how a turn
  // whose discovery scope the daemon fixed itself (the #536 self-introduce turn) can be
  // bounded in code rather than by prompt. All three coordinates are trusted context.
  it('carries the trusted turn coordinates (thread + transport scope) so the daemon can identify the turn', async () => {
    const calls: Record<string, unknown>[] = []
    const d = makeDeps({
      channelAgents: async (req) => {
        calls.push({ ...req })
        return { platform: req.platform, agents: [] }
      }
    })
    await executeTool({ ...ctx, transportScope: 'bot-1' }, 'listAgents', {}, d)
    expect(calls[0]).toMatchObject({
      currentChannel: 'C_CURRENT',
      currentThread: '111.1',
      currentTransportScope: 'bot-1',
      requesterAgentId: 'bot-a'
    })
    // A session with no physical-bot scope simply omits it (never a literal undefined on the wire).
    await executeTool(ctx, 'listAgents', {}, d)
    expect(calls[1]).not.toHaveProperty('currentTransportScope')
    expect(calls[1]).toMatchObject({ currentThread: '111.1' })
  })
})

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
      recordOutbound: async (_c, channel, thread, text, ts) => void recorded.push({ channel, thread, text, ts }),
      now: () => 0,
      ...over
    })
    return { deps: d, calls, gw, recorded }
  }

  it('toAgent dm form (no channel) wakes the peer at the current coords, with no channel post', async () => {
    const { deps: d, calls, gw } = wakeDeps()
    const res = (await executeTool(ctx, 'sendMessage', { toAgent: 'peer-1', message: 'help' }, d)) as {
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
      thread: '111.1',
      // §3.1: the postless form's child runs HEADLESS. Otherwise "postless" would only
      // describe the wake — nothing announces the call, but the child's own answer would
      // still land in the caller's channel, which is the interruption this form avoids.
      postless: true
    })
  })

  it('channel + toAgent (no thread) posts a ROOT message and lands the peer in that post’s thread', async () => {
    // New semantics: a `channel` alongside `toAgent` posts a visible root message AND wakes the
    // peer INTO that post's ts, so the collaboration is visible + threaded (both share the ts).
    const { deps: d, calls, gw, recorded } = wakeDeps()
    const res = (await executeTool(
      ctx,
      'sendMessage',
      { toAgent: 'peer-1', channel: 'C_X', message: 'over to you' },
      d
    )) as {
      ok: boolean
      wake?: unknown
      post?: { channel: string; thread: string | null; ts: string }
    }
    expect(res.ok).toBe(true)
    expect(res.wake).toBeDefined()
    // Visible root post through the gateway, stamped with the calling agent's stable id
    // and the finalized pairing metadata the target's rendezvous keys on.
    expect(gw.postMessage).toHaveBeenCalledWith('C_X', 'over to you', undefined, pairedAuthorIdentity)
    expect(res.post).toEqual({ platform: 'slack', integrationId: 'int-1', channel: 'C_X', thread: null, ts: 'ts-123' })
    expect(recorded).toEqual([{ channel: 'C_X', thread: 'ts-123', text: 'over to you', ts: 'ts-123' }])
    // The peer is woken INTO the post's ts, and the post ts is carried through as the wake's
    // transcriptTs so the wake row collapses onto the recorded post's PK (no duplicate hand-off).
    expect(calls[0]).toMatchObject({ toAgentId: 'peer-1', channel: 'C_X', thread: 'ts-123', transcriptTs: 'ts-123' })
    // §3.2: BOTH halves carry the SAME minted id — that identity is the entire basis for
    // the target recognizing them as one delivery, so assert they actually match rather
    // than that each is merely present.
    const postedId = (gw.postMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![3] as {
      response?: { agentCallDeliveryId?: string }
    }
    expect(postedId.response?.agentCallDeliveryId).toBeTruthy()
    expect(calls[0]!.agentCallDeliveryId).toBe(postedId.response?.agentCallDeliveryId)
  })

  it('channel + toAgent self posts a paired ROOT message and wakes the caller without allowSelf', async () => {
    const { deps: d, calls, gw } = wakeDeps()
    const res = (await executeTool(
      ctx,
      'sendMessage',
      { toAgent: 'bot-a', channel: 'C_X', message: 'continue here' },
      d
    )) as {
      ok: boolean
      wake?: { delivered: boolean }
      post?: { channel: string; thread: string | null; ts: string }
    }

    expect(res).toMatchObject({
      ok: true,
      wake: { delivered: true },
      post: { channel: 'C_X', thread: null, ts: 'ts-123' }
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      callerAgentId: 'bot-a',
      toAgentId: 'bot-a',
      channel: 'C_X',
      thread: 'ts-123',
      transcriptTs: 'ts-123'
    })
    expect(calls[0]).not.toHaveProperty('postless')

    const postedIdentity = (gw.postMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![3] as {
      response?: { mentionedAgentIds?: string[]; agentCallDeliveryId?: string }
    }
    expect(postedIdentity.response?.mentionedAgentIds).toEqual(['bot-a'])
    expect(postedIdentity.response?.agentCallDeliveryId).toBeTruthy()
    expect(calls[0]!.agentCallDeliveryId).toBe(postedIdentity.response?.agentCallDeliveryId)
  })

  it('does not authorize a self wake when the gateway returns no provider message id', async () => {
    const gw = fakeGateway({ postMessage: vi.fn(async () => undefined) })
    const { deps: d, calls } = wakeDeps({ gatewayFor: () => gw })
    d.messageAgent = async (req) => {
      calls.push(req)
      return { delivered: false, reason: 'self' } as MessageAgentResult
    }

    const res = (await executeTool(
      ctx,
      'sendMessage',
      { toAgent: 'bot-a', channel: 'C_X', message: 'continue here' },
      d
    )) as { wake?: { delivered: boolean; reason?: string }; post?: { ts: string } }

    expect(res.post?.ts).toBe('local-0')
    expect(res.wake).toEqual({ delivered: false, reason: 'self' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).not.toHaveProperty('thread')
    expect(calls[0]).not.toHaveProperty('transcriptTs')
    expect(calls[0]).not.toHaveProperty('agentCallDeliveryId')
  })

  it('mints NO pairing id for a postless wake or a bare channel post', async () => {
    // §3.2: the id means "a visible post accompanies this wake". Stamping it on a bare
    // channel post would make ingress hold that post for an internal envelope that is
    // never coming, and it would expire as a spurious delivery failure.
    const postless = wakeDeps()
    await executeTool(ctx, 'sendMessage', { toAgent: 'peer-1', message: 'quietly' }, postless.deps)
    expect(postless.calls[0]!.agentCallDeliveryId).toBeUndefined()

    const bare = wakeDeps()
    await executeTool(ctx, 'sendMessage', { channel: 'C_X', message: 'fyi' }, bare.deps)
    expect(bare.gw.postMessage).toHaveBeenCalledWith('C_X', 'fyi', undefined, authorIdentity)
  })

  it('rejects `thread` on an agent target — the in-thread form is gone', async () => {
    // §2.2: `toAgent + channel + thread` is invalid. To reach a peer in the thread you are
    // already in, @-mention it in your ordinary reply (§2.1).
    const { deps: d, calls, gw } = wakeDeps()
    await expect(
      executeTool(ctx, 'sendMessage', { toAgent: 'peer-1', channel: 'C_X', thread: '222.2', message: 'ping' }, d)
    ).rejects.toThrow(/thread/)
    expect(gw.postMessage).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('renders the target’s exact mention into the channel-root post', async () => {
    // §3.2: the visible half of a paired call names its recipient, so a human reading the
    // channel sees who it is for and the peer is addressed in the body — not only in
    // metadata. The address comes from the daemon's directory, never from model text.
    const {
      deps: d,
      calls,
      gw
    } = wakeDeps({
      mentionAddressFor: ({ agentId, channel }) =>
        agentId === 'peer-1' && channel === 'C_X' ? '<@U01PEER>' : undefined
    })
    await executeTool(ctx, 'sendMessage', { toAgent: 'peer-1', channel: 'C_X', message: 'ping' }, d)
    expect(gw.postMessage).toHaveBeenCalledWith('C_X', '<@U01PEER> ping', undefined, pairedAuthorIdentity)
    // The wake anchors to the post's own ts, and carries it so the two collapse onto one
    // transcript row rather than duplicating the hand-off.
    expect(calls[0]).toMatchObject({ toAgentId: 'peer-1', channel: 'C_X', thread: 'ts-123', transcriptTs: 'ts-123' })
  })

  it('still posts and wakes when the target has no address in that conversation', async () => {
    // A peer with no platform presence there (or a shared bot with no slug) simply gets an
    // unmentioned post plus its internal wake — the delivery happens, it is only less legible.
    const { deps: d, calls, gw } = wakeDeps({ mentionAddressFor: () => undefined })
    await executeTool(ctx, 'sendMessage', { toAgent: 'peer-1', channel: 'C_X', message: 'ping' }, d)
    expect(gw.postMessage).toHaveBeenCalledWith('C_X', 'ping', undefined, pairedAuthorIdentity)
    expect(calls[0]).toMatchObject({ toAgentId: 'peer-1', transcriptTs: 'ts-123' })
  })

  it('a wake that preflight rejects leaves NO visible post (but still runs the wake)', async () => {
    // preflightWake reports the wake will be refused (e.g. not_allowed). The channel post must be
    // skipped so no misleading hand-off is left; messageAgent still runs (it re-checks and returns
    // the typed reason — stubbed here to just record the call).
    const { deps: d, calls, gw } = wakeDeps({ preflightWake: () => 'not_allowed' })
    const res = (await executeTool(ctx, 'sendMessage', { toAgent: 'peer-1', channel: 'C_X', message: 'nope' }, d)) as {
      ok: boolean
      wake?: unknown
      post?: unknown
    }
    expect(gw.postMessage).not.toHaveBeenCalled()
    expect(res.post).toBeUndefined()
    expect(res.wake).toBeDefined()
    // The wake ran, and with the post skipped it carries no transcriptTs.
    expect(calls[0]).toMatchObject({ toAgentId: 'peer-1', channel: 'C_X' })
    expect(calls[0]!.transcriptTs).toBeUndefined()
  })

  it('rejects attacker-supplied identity fields instead of honoring them', async () => {
    const { deps: d, calls } = wakeDeps()
    await expect(
      executeTool(
        ctx,
        'sendMessage',
        { toAgent: 'peer-1', channel: 'C_OTHER', message: 'help', callerAgentId: 'victim', platform: 'telegram' },
        d
      )
    ).rejects.toThrow(/allows only/)
    expect(calls).toHaveLength(0)
  })

  it('anchors a POSTLESS wake to the caller’s own session coordinates', async () => {
    // §3.1: with no `channel`, the call is postless and its child session is headless. The
    // coordinates come from the TRUSTED caller session — a channel the model named is not
    // evidence the caller may reach it, so it never becomes the child's key.
    const { deps: d, calls, gw } = wakeDeps()
    await executeTool(ctx, 'sendMessage', { toAgent: 'peer-1', message: 'x' }, d)
    expect(gw.postMessage).not.toHaveBeenCalled()
    expect(calls[0]).toMatchObject({ toAgentId: 'peer-1', channel: ctx.channel, thread: ctx.thread })
    expect(calls[0]!.transcriptTs).toBeUndefined()
  })

  it.each([
    { extra: {}, label: 'empty target' },
    { extra: { platform: 'slack' }, label: 'platform-only target' }
  ])('rejects $label before dispatch and returns repairable target examples', async ({ extra }) => {
    const { deps: d } = wakeDeps()
    await expect(executeTool(ctx, 'sendMessage', { ...extra, message: 'x' }, d)).rejects.toThrow(
      /Valid targets:.*toAgent.*toUser.*channel.*sessionId/
    )
  })

  it('toUser plus channel is the channel-root form: posts a root @-mention', async () => {
    const { deps: d, gw } = wakeDeps()
    const res = (await executeTool(ctx, 'sendMessage', { toUser: 'U1', channel: 'C1', message: 'private' }, d)) as {
      post?: { channel: string; thread: string | null }
    }
    expect(gw.postMessage).toHaveBeenCalledWith('C1', '<@U1> private', undefined, authorIdentity)
    expect(res.post).toMatchObject({ channel: 'C1', thread: null })
  })

  it('toUser array plus channel posts one message mentioning every listed user', async () => {
    const { deps: d, gw, recorded } = wakeDeps()
    const res = (await executeTool(
      ctx,
      'sendMessage',
      {
        toUser: ['U1', '<@U2>'],
        channel: 'C1',
        message: 'please review'
      },
      d
    )) as { post?: { channel: string; thread: string | null } }
    expect(gw.postMessage).toHaveBeenCalledWith('C1', '<@U1> <@U2> please review', undefined, authorIdentity)
    expect(recorded.at(-1)).toMatchObject({ channel: 'C1', text: '<@U1> <@U2> please review' })
    expect(res.post).toMatchObject({ channel: 'C1', thread: null })
  })

  it('rejects `thread` on a toUser target — there is no visible in-thread form', async () => {
    const { deps: d, gw } = wakeDeps()
    await expect(
      executeTool(ctx, 'sendMessage', { toUser: ['U1', 'U2'], channel: 'C1', thread: '222.2', message: 'please' }, d)
    ).rejects.toThrow(/thread/)
    expect(gw.postMessage).not.toHaveBeenCalled()
  })

  it('rejects a toUser array without channel instead of treating it as a group DM', async () => {
    const { deps: d, gw } = wakeDeps()
    await expect(executeTool(ctx, 'sendMessage', { toUser: ['U1', 'U2'], message: 'x' }, d)).rejects.toThrow(
      /array requires `channel`/
    )
    expect(gw.postMessage).not.toHaveBeenCalled()
  })

  it.each([
    { toUser: [], label: 'empty array' },
    { toUser: ['U1', ''], label: 'empty member id' },
    { toUser: ['U1', 42], label: 'non-string member id' },
    { toUser: ['U1', '<@U1>'], label: 'duplicate member id' }
  ])('rejects an invalid toUser $label before posting', async ({ toUser }) => {
    const { deps: d, gw } = wakeDeps()
    await expect(executeTool(ctx, 'sendMessage', { toUser, channel: 'C1', message: 'x' }, d)).rejects.toThrow(/toUser/)
    expect(gw.postMessage).not.toHaveBeenCalled()
  })

  it('rejects `thread` on a toUser DM', async () => {
    const { deps: d } = wakeDeps()
    await expect(executeTool(ctx, 'sendMessage', { toUser: 'U1', thread: '222.2', message: 'x' }, d)).rejects.toThrow(
      /thread/
    )
  })

  it('rejects mixing toAgent and toUser in one call', async () => {
    const { deps: d } = wakeDeps()
    await expect(executeTool(ctx, 'sendMessage', { toAgent: 'peer-1', toUser: 'U1', message: 'x' }, d)).rejects.toThrow(
      /mutually exclusive/
    )
  })

  it.each([
    { args: { sessionId: 'sess-1', channel: 'C1' }, label: 'session + channel' },
    { args: { toUser: 'U1', correlationId: 'o1.0' }, label: 'user + correlation' },
    { args: { toAgent: 'peer-1', platform: 'telegram' }, label: 'agent + platform' },
    { args: { channel: 'C1', correlationId: 'o1.0' }, label: 'channel + correlation' }
  ])('rejects mixed fields on a $label instead of silently ignoring them', async ({ args }) => {
    const { deps: d } = wakeDeps()
    await expect(executeTool(ctx, 'sendMessage', { ...args, message: 'x' }, d)).rejects.toThrow(/allows only/)
  })

  it('sessionId is a SessionTarget reply routed to deps.replyToSession', async () => {
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
    const res = await executeTool(ctx, 'sendMessage', { sessionId: 'sess-1', message: 'done' }, d)
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
    await executeTool(ctx, 'sendMessage', { sessionId: 'sess-1', correlationId: 'o1.0', message: 'done' }, d)
    expect(replyCalls[0]!.correlationId).toBe('o1.0')
  })

  // The woken peer runs in its own session; the caller needs its id to follow the work it just
  // delegated (viewSessionStatus). Only an ADMITTED wake opened one.
  it('returns the woken session as childSessionId', async () => {
    const { deps: d } = wakeDeps()
    const res = (await executeTool(ctx, 'sendMessage', { toAgent: 'peer-1', message: 'go' }, d)) as {
      childSessionId?: string
      wake?: { targetSession: string }
    }
    expect(res.childSessionId).toBe(res.wake!.targetSession)
  })

  it('tells a needsReply caller to finish the current turn and wait instead of retrying', async () => {
    const { deps: d } = wakeDeps()
    const res = (await executeTool(
      ctx,
      'sendMessage',
      { toAgent: { agentId: 'peer-1', needsReply: true }, message: 'go' },
      d
    )) as Record<string, any>
    expect(res.reply).toEqual({ requested: true, state: 'awaiting' })
    expect(res.nextAction).toBe('finish-turn-and-wait')
    expect(res.message).toMatch(/End this turn.*do not retry/i)
  })

  it('omits childSessionId when the wake was refused — nothing was opened', async () => {
    const { deps: d } = wakeDeps({
      messageAgent: async () => ({ delivered: false, targetSession: 'slack:C:root:peer-1', reason: 'not_allowed' })
    })
    const res = (await executeTool(ctx, 'sendMessage', { toAgent: 'peer-1', message: 'go' }, d)) as {
      childSessionId?: string
      wake?: { reason?: string }
    }
    expect(res.childSessionId).toBeUndefined()
    expect(res.wake?.reason).toBe('not_allowed')
  })

  it('omits childSessionId for a plain channel post — a post is not a delegated session', async () => {
    const { deps: d } = wakeDeps()
    const res = (await executeTool(ctx, 'sendMessage', { channel: 'C_X', message: 'fyi' }, d)) as {
      childSessionId?: string
    }
    expect(res.childSessionId).toBeUndefined()
  })

  it('accepts the object toAgent form and forwards needsReply as trusted request metadata', async () => {
    const { deps: d, calls } = wakeDeps()
    await executeTool(
      ctx,
      'sendMessage',
      { toAgent: { agentId: 'peer-1', needsReply: true }, message: 'take this over' },
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
    await executeTool(ctx, 'sendMessage', { toAgent: 'peer-1', message: 'a' }, d)
    await executeTool(ctx, 'sendMessage', { toAgent: { agentId: 'peer-1', needsReply: false }, message: 'b' }, d)
    expect(calls[0]!.needsReply).toBeUndefined()
    expect(calls[1]!.needsReply).toBeUndefined()
  })

  it('the object toAgent form still composes with a visible channel post', async () => {
    const { deps: d, calls, gw } = wakeDeps()
    const res = (await executeTool(
      ctx,
      'sendMessage',
      { toAgent: { agentId: 'peer-1', needsReply: true }, channel: 'C_X', message: 'over to you' },
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
  ])('rejects $label for toAgent instead of silently dropping it', async ({ toAgent }) => {
    const { deps: d, calls } = wakeDeps()
    await expect(executeTool(ctx, 'sendMessage', { toAgent, message: 'x' }, d)).rejects.toThrow()
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
    updatedAt: 5,
    reply: { requested: true, state: 'awaiting' as const },
    nextAction: 'finish-turn-and-wait' as const,
    message: 'Message delivered; end this turn and wait.'
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

describe('executeTool: submitCodeReview', () => {
  it('takes agent/session identity from trusted context and passes only semantic review input', async () => {
    const submitCodeReview = vi.fn(async () => ({
      state: 'submitted' as const,
      reviewId: '99',
      event: 'REQUEST_CHANGES' as const,
      verdict: 'fail' as const,
      commitId: 'a'.repeat(40)
    }))
    const { deps: d } = deps(fakeGateway())
    d.submitCodeReview = submitCodeReview

    const result = await executeTool(
      ctx,
      'submitCodeReview',
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
    expect(submitCodeReview).toHaveBeenCalledWith({
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
      executeTool(ctx, 'submitCodeReview', { event: 'COMMENT', verdict: 'neutral', body: 'note' }, d)
    ).rejects.toThrow(/unavailable/)
  })

  it('still dispatches the pre-promotion `submitGithubReview` name to the same entry', async () => {
    const submitCodeReview = vi.fn(async () => ({ provider: 'gitlab', state: 'submitted' }))
    const { deps: d } = deps(fakeGateway())
    d.submitCodeReview = submitCodeReview
    await executeTool(ctx, 'submitGithubReview', { event: 'COMMENT', verdict: 'neutral', body: 'note' }, d)
    expect(submitCodeReview).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'bot-a', event: 'COMMENT', verdict: 'neutral', body: 'note' })
    )
  })

  it('validates inline coordinates before calling the effect boundary', async () => {
    const submitCodeReview = vi.fn()
    const { deps: d } = deps(fakeGateway())
    d.submitCodeReview = submitCodeReview
    await expect(
      executeTool(
        ctx,
        'submitCodeReview',
        {
          event: 'COMMENT',
          verdict: 'neutral',
          body: 'note',
          comments: [{ path: 'x.ts', body: 'bad line', line: 0, side: 'RIGHT' }]
        },
        d
      )
    ).rejects.toThrow(/positive integer/)
    expect(submitCodeReview).not.toHaveBeenCalled()
  })

  // A malformed entry must name its own INDEX — that is the whole repair instruction for a
  // model holding a long batch, so the number has to survive the argument-schema plumbing.
  it.each([
    {
      tool: 'submitCodeReview',
      args: {
        event: 'COMMENT',
        verdict: 'neutral',
        body: 'note',
        comments: [{ path: 'x.ts', body: 'b', line: 1, side: 'LEFT' }, 'nope']
      },
      expected: 'comments[1] must be an object'
    },
    {
      tool: 'replyGithubReviewThreads',
      args: { replies: [{ threadRootCommentId: '1', body: 'ok' }, 7] },
      expected: 'replies[1] must be an object'
    },
    { tool: 'startOrchestration', args: { subtasks: ['nope'] }, expected: 'subtasks[0] must be an object' }
  ])('$tool names the offending entry by index', async ({ tool, args, expected }) => {
    const { deps: d } = deps(fakeGateway())
    d.submitCodeReview = vi.fn()
    d.replyGithubReviewThreads = vi.fn()
    await expect(executeTool(ctx, tool, args, d)).rejects.toThrow(expected)
  })
})

describe('executeTool: replyGithubReviewThreads', () => {
  it('takes session identity from trusted context and validates decimal roots', async () => {
    const replyGithubReviewThreads = vi.fn(async () => ({
      replies: [{ threadRootCommentId: '123', state: 'published' as const, commentId: '999' }]
    }))
    const { deps: d } = deps(fakeGateway())
    d.replyGithubReviewThreads = replyGithubReviewThreads

    await expect(
      executeTool(
        ctx,
        'replyGithubReviewThreads',
        {
          repo: 'evil/repo',
          number: 1,
          replies: [{ threadRootCommentId: '123', body: 'Fixed in the latest push.' }]
        },
        d
      )
    ).resolves.toMatchObject({ replies: [{ commentId: '999' }] })
    expect(replyGithubReviewThreads).toHaveBeenCalledWith({
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C_CURRENT',
      thread: '111.1',
      replies: [{ threadRootCommentId: '123', body: 'Fixed in the latest push.' }]
    })

    await expect(
      executeTool(
        ctx,
        'replyGithubReviewThreads',
        {
          replies: [{ threadRootCommentId: '01', body: 'bad target' }]
        },
        d
      )
    ).rejects.toThrow(/positive decimal string/)
  })
})
