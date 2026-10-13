// A tool call that needs the bot in a public channel it has not joined asks a person behind the turn first, and returns at once (#2979).
import { describe, expect, it, vi } from 'vitest'
import { executeTool, type MessageGateway, type OpsDeps, type SessionContext } from '../src/mcp/ops.js'
import type { JoinDelivery, JoinRequest } from '../src/mcp/ops/join-ask.js'
import type { MemoryProvider } from '../src/memory/provider.js'
import { toolsForIntegrations } from '../src/mcp/tools.js'
import type { JoinAnswer, JoinOutcome } from '../src/permissions/join-confirmation.js'
import { markNotJoined } from '../src/platforms/not-joined.js'

const ctx: SessionContext = {
  agentId: 'bot-a',
  platform: 'slack',
  integrationId: 'int-1',
  isDm: false,
  channel: 'C-HERE',
  thread: '111.1',
  deliveryThread: '111.1',
  tools: toolsForIntegrations([
    {
      id: 'int-1',
      platform: 'slack',
      core: {
        mode: 'direct',
        bindRules: [],
        mutedChannels: [],
        gated: false,
        sessionModes: [],
        decisions: { bindings: [], definitions: [] }
      },
      config: { botToken: 'x', appToken: 'y' }
    }
  ]),
  integrations: [{ id: 'int-1', platform: 'slack' }]
}

const ADA = { kind: 'member' as const, platform: 'slack', integrationId: 'int-1', userId: 'U-ada' }

/** Slack's refusal for a channel the bot is not in, tagged as the connection tags it. */
const notIn = (channel: string): Error => markNotJoined(new Error('An API error occurred: not_in_channel'), channel)

/** A bot that is in none of the public channels until it joins one. */
function gateway(over: { privateChannel?: boolean; member?: boolean } = {}) {
  const joined = new Set<string>(over.member ? ['C-GEN'] : [])
  const gw = {
    postMessage: vi.fn(async (channel: string) => {
      if (!joined.has(channel)) throw notIn(channel)
      return 'ts-9'
    }),
    getChannelHistory: vi.fn(async (channel: string) => {
      if (!joined.has(channel)) throw notIn(channel)
      return { messages: [{ sender: 'U1', ts: '1.0', text: 'hello', isBot: false }], hasMore: false }
    }),
    uploadFile: vi.fn(async (channel: string) =>
      joined.has(channel)
        ? { ok: true as const }
        : { ok: false as const, reason: 'forbidden' as const, detail: 'not_in_channel', notJoined: true as const }
    ),
    joinChannel: vi.fn(async (channel: string) => void joined.add(channel)),
    getChannelInfo: vi.fn(async (id: string) => ({ id, name: 'general', isPrivate: over.privateChannel === true })),
    listMembers: vi.fn(async () => []),
    listChannels: vi.fn(async () => []),
    getUserProfile: vi.fn(async (u: string) => ({ id: u })),
    downloadFile: vi.fn(async () => null)
  }
  return gw as typeof gw & MessageGateway
}

function makeDeps(gw: MessageGateway, over: { nobody?: boolean; unreachable?: boolean; blocking?: boolean } = {}) {
  let answer!: (outcome: JoinOutcome) => void
  const answered = new Promise<JoinOutcome>((resolve) => (answer = resolve))
  const confirmJoin = vi.fn(
    async (_ctx: SessionContext, _ask: JoinRequest, offered: (to: string | null) => void): Promise<JoinAnswer> => {
      if (over.unreachable) return { outcome: 'unavailable' }
      offered('Ada Example')
      const outcome = await answered
      return outcome === 'join' ? { outcome, by: ADA } : { outcome }
    }
  )
  const deliver = vi.fn((_ctx: SessionContext, _outcome: JoinDelivery) => {})
  const deps = {
    gatewayFor: () => gw,
    channelAgents: async () => ({ platform: 'slack', agents: [] }),
    messageAgent: async (req) => ({ delivered: true, targetSession: `stub:${req.toAgentId}` }),
    replyToSession: async () => ({ delivered: true, targetSession: 'stub' }),
    memory: {} as unknown as MemoryProvider,
    recordOutbound: async () => {},
    now: () => 1000,
    readAskers: async () => (over.nobody ? { people: [], nobody: true } : { people: [ADA], nobody: false }),
    readLookups: () => ({
      member: async () => true,
      fullMember: async () => true,
      console: async (_asker, sessionIds) => ({ asker: 'linked', visible: new Set(sessionIds) }),
      linked: async () => null
    }),
    placeStore: {
      listSessions: async () => [],
      latestSession: async () => undefined,
      transcriptPageForAgent: async () => ({ rows: [], hasMore: false }),
      getDisplayNames: async () => new Map()
    },
    confirmJoin,
    ...(over.blocking ? {} : { deliverJoinOutcome: deliver })
  } as OpsDeps
  /** The person's answer, and the outcome the session is handed once the call finished. */
  const settle = async (outcome: JoinOutcome): Promise<JoinDelivery> => {
    answer(outcome)
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
    return deliver.mock.calls[0]![1]
  }
  return { deps, confirmJoin, deliver, answer, settle }
}

const PARKED = {
  joinRequested: true,
  channel: '#general',
  note: expect.stringContaining('Asked Ada Example to let the bot join #general')
}

describe('reading a public channel the bot has not joined', () => {
  it('asks a person behind the turn and returns at once; their Join runs the read and hands the result back', async () => {
    const gw = gateway()
    const w = makeDeps(gw)
    await expect(executeTool(ctx, 'getChannelHistory', { channel: 'C-GEN' }, w.deps)).resolves.toEqual(PARKED)
    expect(w.confirmJoin).toHaveBeenCalledWith(
      ctx,
      {
        integrationId: 'int-1',
        channel: 'C-GEN',
        name: 'general',
        purpose: 'read',
        tool: 'getChannelHistory',
        askers: [ADA]
      },
      expect.any(Function)
    )
    expect(gw.joinChannel).not.toHaveBeenCalled()
    expect(w.deliver).not.toHaveBeenCalled()

    const delivered = await w.settle('join')
    expect(gw.joinChannel).toHaveBeenCalledWith('C-GEN')
    expect(gw.getChannelHistory).toHaveBeenCalledTimes(2)
    expect(delivered).toMatchObject({
      tool: 'getChannelHistory',
      name: 'general',
      purpose: 'read',
      to: 'Ada Example',
      // The result speaks for the person who answered Join.
      by: ADA,
      result: { channel: 'C-GEN', messages: [{ text: 'hello' }] }
    })
  })

  it.each([
    ['declined', /did not join #general: the person asked chose not to let it\. Nothing was read/],
    ['expired', /did not join #general: nobody answered whether it may within 10 minutes\. Nothing was read/]
  ] as const)('tells the session nothing was done when the answer is %s', async (answer, said) => {
    const gw = gateway()
    const w = makeDeps(gw)
    await expect(executeTool(ctx, 'getChannelHistory', { channel: 'C-GEN' }, w.deps)).resolves.toEqual(PARKED)
    const delivered = await w.settle(answer)
    expect(delivered).toMatchObject({ tool: 'getChannelHistory', error: expect.stringMatching(said) })
    expect(gw.joinChannel).not.toHaveBeenCalled()
    expect(gw.getChannelHistory).toHaveBeenCalledTimes(1)
  })

  it('never joins for a turn no person is behind, and asks nobody', async () => {
    const gw = gateway()
    const w = makeDeps(gw, { nobody: true })
    await expect(executeTool(ctx, 'getChannelHistory', { channel: 'C-GEN' }, w.deps)).rejects.toThrow(
      'getChannelHistory: the bot is not in #general; invite it, or ask from a conversation. Nothing was read.'
    )
    expect(w.confirmJoin).not.toHaveBeenCalled()
    expect(w.deliver).not.toHaveBeenCalled()
  })

  it('fails at once when no card can reach anyone behind the turn', async () => {
    const gw = gateway()
    const w = makeDeps(gw, { unreachable: true })
    await expect(executeTool(ctx, 'getChannelHistory', { channel: 'C-GEN' }, w.deps)).rejects.toThrow(
      /the bot is not in #general; invite it, or ask from a conversation/
    )
    expect(w.deliver).not.toHaveBeenCalled()
  })

  it('asks nothing when the bot is already a member', async () => {
    const gw = gateway({ member: true })
    const w = makeDeps(gw)
    await expect(executeTool(ctx, 'getChannelHistory', { channel: 'C-GEN' }, w.deps)).resolves.toMatchObject({
      channel: 'C-GEN'
    })
    expect(w.confirmJoin).not.toHaveBeenCalled()
    expect(gw.joinChannel).not.toHaveBeenCalled()
  })

  it('keeps the platform’s refusal for a channel that cannot be joined', async () => {
    const gw = gateway({ privateChannel: true })
    const w = makeDeps(gw)
    await expect(executeTool(ctx, 'getChannelHistory', { channel: 'C-GEN' }, w.deps)).rejects.toThrow('not_in_channel')
    expect(w.confirmJoin).not.toHaveBeenCalled()
  })

  it('waits for the answer on a host that cannot hand a late outcome back', async () => {
    const gw = gateway()
    const w = makeDeps(gw, { blocking: true })
    const read = executeTool(ctx, 'getChannelHistory', { channel: 'C-GEN' }, w.deps)
    await vi.waitFor(() => expect(w.confirmJoin).toHaveBeenCalledTimes(1))
    w.answer('join')
    await expect(read).resolves.toMatchObject({ channel: 'C-GEN', messages: [{ text: 'hello' }] })
  })
})

describe('posting into a public channel the bot has not joined', () => {
  it('asks to post there and returns at once; Join posts once and hands the post back', async () => {
    const gw = gateway()
    const w = makeDeps(gw)
    await expect(executeTool(ctx, 'sendMessage', { channel: 'C-GEN', message: 'hi' }, w.deps)).resolves.toEqual({
      ...PARKED,
      note: expect.stringContaining('nothing was sent yet')
    })
    expect(w.confirmJoin).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ channel: 'C-GEN', purpose: 'post' }),
      expect.any(Function)
    )
    expect(await w.settle('join')).toMatchObject({ result: { post: { channel: 'C-GEN', ts: 'ts-9' } } })
    expect(gw.postMessage).toHaveBeenCalledTimes(2)
  })

  it('sends nothing when the person declines, and says so to the session', async () => {
    const gw = gateway()
    const w = makeDeps(gw)
    await executeTool(ctx, 'sendMessage', { channel: 'C-GEN', message: 'hi' }, w.deps)
    expect(await w.settle('declined')).toMatchObject({
      error: expect.stringMatching(/sendMessage: the bot did not join #general.*Nothing was sent/)
    })
    expect(gw.postMessage).toHaveBeenCalledTimes(1)
  })

  it('asks before a forwarded file is shared there too', async () => {
    const gw = gateway()
    const w = makeDeps(gw)
    w.deps.resolveAttachment = async () => ({ bytes: Buffer.from('png'), name: 'a.png', mimeType: 'image/png' })
    await executeTool(ctx, 'sendMessage', { channel: 'C-GEN', message: 'look', attachment: 'a.png' }, w.deps)
    await w.settle('join')
    expect(w.confirmJoin).toHaveBeenCalledTimes(1)
    expect(gw.uploadFile).toHaveBeenCalledTimes(2)
  })

  it('leaves the agent-to-agent form to its own reach: it asks nothing', async () => {
    const gw = gateway()
    const w = makeDeps(gw)
    await expect(
      executeTool(ctx, 'sendMessage', { toAgent: 'peer-1', channel: 'C-GEN', message: 'over to you' }, w.deps)
    ).rejects.toThrow('not_in_channel')
    expect(w.confirmJoin).not.toHaveBeenCalled()
  })
})
