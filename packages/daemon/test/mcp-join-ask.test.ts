// A tool call that needs the bot in a public channel it has not joined asks a person behind the turn first (#2979).
import { describe, expect, it, vi } from 'vitest'
import { executeTool, type MessageGateway, type OpsDeps, type SessionContext } from '../src/mcp/ops.js'
import type { JoinRequest } from '../src/mcp/ops/join-ask.js'
import type { MemoryProvider } from '../src/memory/provider.js'
import { toolsForIntegrations } from '../src/mcp/tools.js'
import type { JoinOutcome } from '../src/permissions/join-confirmation.js'
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

function makeDeps(
  gw: MessageGateway,
  over: { answer?: JoinOutcome; nobody?: boolean } = {}
): OpsDeps & { confirmJoin: ReturnType<typeof vi.fn> } {
  const confirmJoin = vi.fn(async (_ctx: SessionContext, _ask: JoinRequest) => over.answer ?? 'join')
  return {
    gatewayFor: () => gw,
    channelAgents: async () => ({ platform: 'slack', agents: [] }),
    messageAgent: async (req) => ({ delivered: true, targetSession: `stub:${req.toAgentId}` }),
    replyToSession: async () => ({ delivered: true, targetSession: 'stub' }),
    startOrchestration: async () => ({ orchestrationId: 'o', delivered: [], failed: [] }),
    getOrchestration: async () => null,
    cancelOrchestration: async () => false,
    memory: {} as unknown as MemoryProvider,
    recordOutbound: async () => {},
    now: () => 1000,
    readAskers: async () => (over.nobody ? { people: [], nobody: true } : { people: [ADA], nobody: false }),
    readLookups: () => ({
      member: async () => true,
      fullMember: async () => true,
      console: async (_asker, sessionIds) => ({ asker: 'linked', visible: new Set(sessionIds) })
    }),
    placeStore: {
      listSessions: async () => [],
      latestSession: async () => undefined,
      transcriptPageForAgent: async () => ({ rows: [], hasMore: false }),
      getDisplayNames: async () => new Map()
    },
    confirmJoin
  } as OpsDeps & { confirmJoin: typeof confirmJoin }
}

describe('reading a public channel the bot has not joined', () => {
  it('asks a person behind the turn, joins on Join, and reads', async () => {
    const gw = gateway()
    const d = makeDeps(gw)
    const res = (await executeTool(ctx, 'getChannelHistory', { channel: 'C-GEN' }, d)) as { messages: unknown[] }
    expect(d.confirmJoin).toHaveBeenCalledWith(ctx, {
      integrationId: 'int-1',
      channel: 'C-GEN',
      name: 'general',
      purpose: 'read',
      askers: [ADA]
    })
    expect(gw.joinChannel).toHaveBeenCalledWith('C-GEN')
    expect(gw.getChannelHistory).toHaveBeenCalledTimes(2)
    expect(res.messages).toHaveLength(1)
  })

  it.each([
    ['declined', /did not join #general: the person asked chose not to let it\. Nothing was read/],
    ['expired', /did not join #general: nobody answered whether it may within 10 minutes\. Nothing was read/]
  ] as const)('fails cleanly when the answer is %s, and joins nothing', async (answer, said) => {
    const gw = gateway()
    const d = makeDeps(gw, { answer })
    await expect(executeTool(ctx, 'getChannelHistory', { channel: 'C-GEN' }, d)).rejects.toThrow(said)
    expect(gw.joinChannel).not.toHaveBeenCalled()
    expect(gw.getChannelHistory).toHaveBeenCalledTimes(1)
  })

  it('never joins for a turn no person is behind, and asks nobody', async () => {
    const gw = gateway()
    const d = makeDeps(gw, { nobody: true })
    await expect(executeTool(ctx, 'getChannelHistory', { channel: 'C-GEN' }, d)).rejects.toThrow(
      'getChannelHistory: the bot is not in #general; invite it, or ask from a conversation. Nothing was read.'
    )
    expect(d.confirmJoin).not.toHaveBeenCalled()
    expect(gw.joinChannel).not.toHaveBeenCalled()
  })

  it('asks nothing when the bot is already a member', async () => {
    const gw = gateway({ member: true })
    const d = makeDeps(gw)
    await expect(executeTool(ctx, 'getChannelHistory', { channel: 'C-GEN' }, d)).resolves.toMatchObject({
      channel: 'C-GEN'
    })
    expect(d.confirmJoin).not.toHaveBeenCalled()
    expect(gw.joinChannel).not.toHaveBeenCalled()
  })

  it('keeps the platform’s refusal for a channel that cannot be joined', async () => {
    const gw = gateway({ privateChannel: true })
    const d = makeDeps(gw)
    await expect(executeTool(ctx, 'getChannelHistory', { channel: 'C-GEN' }, d)).rejects.toThrow('not_in_channel')
    expect(d.confirmJoin).not.toHaveBeenCalled()
  })
})

describe('posting into a public channel the bot has not joined', () => {
  it('asks to post there, joins on Join, and posts once', async () => {
    const gw = gateway()
    const d = makeDeps(gw)
    await expect(executeTool(ctx, 'sendMessage', { channel: 'C-GEN', message: 'hi' }, d)).resolves.toMatchObject({
      post: { channel: 'C-GEN', ts: 'ts-9' }
    })
    expect(d.confirmJoin).toHaveBeenCalledWith(ctx, expect.objectContaining({ channel: 'C-GEN', purpose: 'post' }))
    expect(gw.postMessage).toHaveBeenCalledTimes(2)
  })

  it('sends nothing when the person declines', async () => {
    const gw = gateway()
    const d = makeDeps(gw, { answer: 'declined' })
    await expect(executeTool(ctx, 'sendMessage', { channel: 'C-GEN', message: 'hi' }, d)).rejects.toThrow(
      /sendMessage: the bot did not join #general.*Nothing was sent/
    )
    expect(gw.joinChannel).not.toHaveBeenCalled()
  })

  it('asks before a forwarded file is shared there too', async () => {
    const gw = gateway()
    const d = makeDeps(gw)
    d.resolveAttachment = async () => ({ bytes: Buffer.from('png'), name: 'a.png', mimeType: 'image/png' })
    await executeTool(ctx, 'sendMessage', { channel: 'C-GEN', message: 'look', attachment: 'a.png' }, d)
    expect(d.confirmJoin).toHaveBeenCalledTimes(1)
    expect(gw.uploadFile).toHaveBeenCalledTimes(2)
  })

  it('leaves the agent-to-agent form to its own reach: it asks nothing', async () => {
    const gw = gateway()
    const d = makeDeps(gw)
    await expect(
      executeTool(ctx, 'sendMessage', { toAgent: 'peer-1', channel: 'C-GEN', message: 'over to you' }, d)
    ).rejects.toThrow('not_in_channel')
    expect(d.confirmJoin).not.toHaveBeenCalled()
  })
})
