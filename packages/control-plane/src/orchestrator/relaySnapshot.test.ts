import { describe, expect, it, vi } from 'vitest'
import { RC_SNAPSHOT_MAX_WITHHELD, RELAY_PROJECTION_SNAPSHOT_V1_FEATURE } from '@agentconnect.md/protocol'
import type { RelayChannel } from '../ws/relay-registry.js'
import { replaySnapshot } from './relaySnapshot.js'

const PROVIDER = '11111111-1111-4111-8111-111111111111'
const FAILED = '22222222-2222-4222-8222-222222222222'

function channel(features: string[]) {
  const sent: Array<{ type: string; payload: unknown }> = []
  const ch = {
    relayId: 'relay-1',
    features,
    send: (type: string, payload: unknown) => sent.push({ type, payload }),
    close: vi.fn()
  } as unknown as RelayChannel
  return { ch, sent }
}

describe('replaySnapshot', () => {
  it('frames the replay for a relay that prunes, naming what failed to replay', async () => {
    const { ch, sent } = channel([RELAY_PROJECTION_SNAPSHOT_V1_FEATURE])
    await replaySnapshot(ch, 'mcp', async (withhold) => {
      ch.send('rc/mcp-assign', { providerId: PROVIDER, upstreamUrl: 'https://mcp.example.test', grantKeyHashes: ['a'] })
      withhold(FAILED)
    })
    expect(sent.map((frame) => frame.type)).toEqual(['rc/snapshot-begin', 'rc/mcp-assign', 'rc/snapshot-end'])
    const begin = sent[0]!.payload as { kind: string; snapshotId: string }
    expect(begin.kind).toBe('mcp')
    expect(sent[2]!.payload).toEqual({ kind: 'mcp', snapshotId: begin.snapshotId, withheld: [FAILED] })
  })

  it('replays without frames to a relay that predates snapshots', async () => {
    const { ch, sent } = channel([])
    const replay = vi.fn(async () => {})
    await replaySnapshot(ch, 'hook', replay)
    expect(replay).toHaveBeenCalledTimes(1)
    expect(sent).toEqual([])
  })

  it('sends no end when the replay could not enumerate, so the relay keeps its copy', async () => {
    const { ch, sent } = channel([RELAY_PROJECTION_SNAPSHOT_V1_FEATURE])
    await expect(
      replaySnapshot(ch, 'memory', async () => {
        throw new Error('database unavailable')
      })
    ).rejects.toThrow('database unavailable')
    expect(sent.map((frame) => frame.type)).toEqual(['rc/snapshot-begin'])
  })

  it('sends no end when more failed than one end frame can name', async () => {
    const { ch, sent } = channel([RELAY_PROJECTION_SNAPSHOT_V1_FEATURE])
    await replaySnapshot(ch, 'hook', async (withhold) => {
      for (let i = 0; i <= RC_SNAPSHOT_MAX_WITHHELD; i++)
        withhold(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    })
    expect(sent.map((frame) => frame.type)).toEqual(['rc/snapshot-begin'])
  })
})
