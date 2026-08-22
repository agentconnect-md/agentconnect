import { describe, expect, it } from 'vitest'
import {
  VirtualDeliveryRejected,
  VirtualSlackConnection,
  type OutboundEffectInput,
  type OutboundEffectResult,
  type VirtualConnectionWorldPort
} from '../../packages/daemon/src/evaluation/index.js'

function worldStub(overrides: Partial<VirtualConnectionWorldPort> = {}) {
  const recorded: OutboundEffectInput[] = []
  let sequence = 0
  const port: VirtualConnectionWorldPort = {
    recordOutbound: async (effect) => {
      recorded.push(effect)
      sequence += 1
      return { status: 'delivered', messageId: `1700000000.${String(sequence).padStart(6, '0')}`, sequence }
    },
    channelInfo: (channel) => (channel === 'C-KNOWN' ? { id: 'C-KNOWN', name: 'known' } : undefined),
    members: (channel) => (channel === 'C-KNOWN' ? [{ id: 'agent-1', name: 'agent-one', isBot: true }] : []),
    channels: () => [{ id: 'C-KNOWN', name: 'known' }],
    profile: (user) => (user === 'U-HUMAN' ? { id: 'U-HUMAN', name: 'human' } : undefined),
    ...overrides
  }
  return { port, recorded }
}

describe('VirtualSlackConnection — the concrete-connection surface the daemon consumes', () => {
  it('routes the ordinary reply path to the world as a reply effect and returns the message id', async () => {
    const { port, recorded } = worldStub()
    const conn = new VirtualSlackConnection('int-1', { workspaceId: 'T-EVAL' }, port)
    const ts = await conn.postMessage('C-KNOWN', 'hello room', '1700.000001', {
      username: 'Agent One',
      agentAuthorId: 'agent-1'
    })
    expect(ts).toMatch(/^1700000000\./)
    expect(recorded).toEqual([
      {
        kind: 'reply',
        platform: 'slack',
        integrationId: 'int-1',
        channel: 'C-KNOWN',
        thread: '1700.000001',
        identity: { username: 'Agent One', agentAuthorId: 'agent-1' },
        text: 'hello room'
      }
    ])
  })

  it('records daemon delivery chrome as chrome effects, never as room speech', async () => {
    const { port, recorded } = worldStub()
    const conn = new VirtualSlackConnection('int-1', { workspaceId: 'T-EVAL' }, port)
    await conn.postMessage('C-KNOWN', 'progress…', undefined, { chrome: true })
    await conn.postBlocks('C-KNOWN', [], 'status bar', '1700.000001', { chrome: true })
    await conn.updateMessage('C-KNOWN', '1.2', 'edited body')
    expect(recorded.map((effect) => effect.kind)).toEqual(['chrome', 'chrome', 'chrome'])
  })

  it('surfaces a rejected reply to the caller as the platform-shaped error (§7.2)', async () => {
    const rejection: OutboundEffectResult = { status: 'rejected', sequence: 9, reason: 'not_a_member' }
    const { port } = worldStub({ recordOutbound: async () => rejection })
    const conn = new VirtualSlackConnection('int-1', { workspaceId: 'T-EVAL' }, port)
    await expect(conn.postMessage('C-OTHER', 'sneaky post')).rejects.toThrow(VirtualDeliveryRejected)
    // Chrome remains best-effort like the real connection: rejected chrome never throws.
    await expect(conn.postMessage('C-OTHER', 'chrome', undefined, { chrome: true })).resolves.toBeUndefined()
  })

  it('provides tenant identity and the MessageGateway ops from the world read model', async () => {
    const { port } = worldStub()
    const conn = new VirtualSlackConnection(
      'int-1',
      { workspaceId: 'T-EVAL', workspaceUrl: 'https://eval.example.test' },
      port,
      {
        botUserId: 'UBOT1'
      }
    )
    expect(conn.workspaceId()).toBe('T-EVAL')
    expect(conn.workspaceUrl).toBe('https://eval.example.test')
    expect(conn.botUserId).toBe('UBOT1')
    await expect(conn.getChannelInfo('C-KNOWN')).resolves.toMatchObject({ id: 'C-KNOWN' })
    await expect(conn.getChannelInfo('C-MISSING')).rejects.toThrow('channel_not_found')
    await expect(conn.listMembers('C-KNOWN')).resolves.toEqual([{ id: 'agent-1', name: 'agent-one', isBot: true }])
    await expect(conn.listChannels()).resolves.toEqual([{ id: 'C-KNOWN', name: 'known' }])
    await expect(conn.getUserProfile('U-HUMAN')).resolves.toMatchObject({ id: 'U-HUMAN', name: 'human' })
    await expect(conn.getUserProfile('U-UNKNOWN')).resolves.toEqual({ id: 'U-UNKNOWN' })
    await expect(conn.downloadFile()).resolves.toBeNull()
  })

  it('provides bounded channel history pages from the virtual world', async () => {
    const { port } = worldStub({
      channelHistory: () => [
        { ts: '1700000000.000001', text: 'older', sender: 'U1', isBot: false },
        { ts: '1700000000.000002', text: 'newer', sender: 'UBOT', isBot: true }
      ]
    })
    const conn = new VirtualSlackConnection('int-1', { workspaceId: 'T-EVAL' }, port)
    await expect(conn.getChannelHistory('C-KNOWN', { limit: 1 })).resolves.toEqual({
      messages: [{ ts: '1700000000.000002', text: 'newer', sender: 'UBOT', isBot: true }],
      hasMore: true,
      nextCursor: '1'
    })
    await expect(conn.getChannelHistory('C-KNOWN', { cursor: '1', limit: 1 })).resolves.toEqual({
      messages: [{ ts: '1700000000.000001', text: 'older', sender: 'U1', isBot: false }],
      hasMore: false
    })
    const bounded = await conn.getChannelHistory('C-KNOWN', {
      oldest: '1700000000.000001',
      latest: '1700000000.000002'
    })
    expect(bounded.messages).toEqual(
      expect.arrayContaining([
        { ts: '1700000000.000001', text: 'older', sender: 'U1', isBot: false },
        { ts: '1700000000.000002', text: 'newer', sender: 'UBOT', isBot: true }
      ])
    )
  })
})
