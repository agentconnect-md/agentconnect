import { describe, expect, it } from 'vitest'
import {
  buildEnvelope,
  decodeEnvelope,
  encode,
  isFrame,
  MEMORY_PLACE_CLEAR_FEATURE,
  MemoryChannelClearOk,
  MemoryChannelClearReq,
  MemoryChannelEntry,
  MemoryChannelsReq
} from '../index.js'

describe('a place layer on the memory frames', () => {
  it('names a place by its platform and display name, both optional so an older daemon still parses', () => {
    expect(
      MemoryChannelEntry.parse({
        channelKey: 'slack-C0EXAMPLE1-abc',
        channel: 'C0EXAMPLE1',
        platform: 'slack',
        name: 'ops'
      })
    ).toEqual({ channelKey: 'slack-C0EXAMPLE1-abc', channel: 'C0EXAMPLE1', platform: 'slack', name: 'ops' })
    expect(MemoryChannelEntry.parse({ channelKey: 'slack-C0EXAMPLE1-abc' })).toEqual({
      channelKey: 'slack-C0EXAMPLE1-abc'
    })
    expect(MemoryChannelsReq.parse({ agentId: 'agent-a', channelKey: 'k-1' })).toEqual({
      agentId: 'agent-a',
      channelKey: 'k-1'
    })
    expect(MemoryChannelsReq.safeParse({ agentId: 'agent-a', channelKey: '../x' }).success).toBe(false)
  })

  it('round-trips a clear that carries no content either way', () => {
    const req = decodeEnvelope(encode(buildEnvelope('memory/channel/clear', { agentId: 'agent-a', channelKey: 'k-1' })))
    if (!req.ok || !isFrame('memory/channel/clear')(req.frame)) throw new Error('expected memory/channel/clear')
    expect(req.frame.payload).toEqual({ agentId: 'agent-a', channelKey: 'k-1' })
    const rep = decodeEnvelope(
      encode(buildEnvelope('memory/channel/clear/ok', { agentId: 'agent-a', channelKey: 'k-1', cleared: true }))
    )
    if (!rep.ok || !isFrame('memory/channel/clear/ok')(rep.frame)) throw new Error('expected memory/channel/clear/ok')
    expect(rep.frame.payload.cleared).toBe(true)
    expect(MemoryChannelClearReq.safeParse({ agentId: 'agent-a', channelKey: 'k-1', path: 'x.md' }).success).toBe(false)
    expect(
      MemoryChannelClearOk.safeParse({ agentId: 'agent-a', channelKey: 'k-1', cleared: true, content: 'x' }).success
    ).toBe(false)
    expect(MEMORY_PLACE_CLEAR_FEATURE).toBe('memory-place-clear-v1')
  })
})
