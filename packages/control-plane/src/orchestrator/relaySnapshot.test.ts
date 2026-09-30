import { describe, expect, it, vi } from 'vitest'
import { RC_SNAPSHOT_MAX_WITHHELD, RELAY_PROJECTION_SNAPSHOT_V1_FEATURE } from '@agentconnect.md/protocol'
import { RelayRegistry, type RelayChannel } from '../ws/relay-registry.js'
import { RelayControlSender } from './relayControl.js'
import { replaySnapshot } from './relaySnapshot.js'

const PROVIDER = '11111111-1111-4111-8111-111111111111'
const FAILED = '22222222-2222-4222-8222-222222222222'
const HOOK = '33333333-3333-4333-8333-333333333333'
const noHold = { hold: () => () => {} }

function channel(features: string[], relayId = 'relay-1') {
  const sent: Array<{ type: string; payload: unknown }> = []
  const ch = {
    relayId,
    features,
    send: (type: string, payload: unknown) => sent.push({ type, payload }),
    close: vi.fn()
  } as unknown as RelayChannel
  return { ch, sent }
}

function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { open, opened }
}

describe('replaySnapshot', () => {
  it('frames the replay for a relay that prunes, naming what failed to replay', async () => {
    const { ch, sent } = channel([RELAY_PROJECTION_SNAPSHOT_V1_FEATURE])
    await replaySnapshot(ch, 'mcp', noHold, async (withhold) => {
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
    await replaySnapshot(ch, 'hook', noHold, replay)
    expect(replay).toHaveBeenCalledTimes(1)
    expect(sent).toEqual([])
  })

  it('sends no end when the replay could not enumerate, so the relay keeps its copy', async () => {
    const { ch, sent } = channel([RELAY_PROJECTION_SNAPSHOT_V1_FEATURE])
    await expect(
      replaySnapshot(ch, 'memory', noHold, async () => {
        throw new Error('database unavailable')
      })
    ).rejects.toThrow('database unavailable')
    expect(sent.map((frame) => frame.type)).toEqual(['rc/snapshot-begin'])
  })

  it('sends no end when more failed than one end frame can name', async () => {
    const { ch, sent } = channel([RELAY_PROJECTION_SNAPSHOT_V1_FEATURE])
    await replaySnapshot(ch, 'hook', noHold, async (withhold) => {
      for (let i = 0; i <= RC_SNAPSHOT_MAX_WITHHELD; i++)
        withhold(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    })
    expect(sent.map((frame) => frame.type)).toEqual(['rc/snapshot-begin'])
  })

  it('delivers a removal made during the replay after the stale assign the replay read before it', async () => {
    const relays = new RelayRegistry()
    const replaying = channel([RELAY_PROJECTION_SNAPSHOT_V1_FEATURE], 'relay-1')
    const other = channel([RELAY_PROJECTION_SNAPSHOT_V1_FEATURE], 'relay-2')
    relays.add(replaying.ch)
    relays.add(other.ch)
    const control = new RelayControlSender(relays)
    const read = gate()
    const replay = replaySnapshot(replaying.ch, 'mcp', control, async () => {
      await read.opened
      replaying.ch.send('rc/mcp-assign', {
        providerId: PROVIDER,
        upstreamUrl: 'https://mcp.example.test',
        grantKeyHashes: ['a']
      })
    })

    control.mcpUnassign({ providerId: PROVIDER })
    control.hookRemove(HOOK)
    control.daemonRevoke('daemon-1')
    read.open()
    await replay

    expect(replaying.sent.map((frame) => frame.type)).toEqual([
      'rc/snapshot-begin',
      'rc/hook-remove',
      'rc/daemon-revoke',
      'rc/mcp-assign',
      'rc/snapshot-end',
      'rc/mcp-unassign'
    ])
    expect(other.sent.map((frame) => frame.type)).toEqual(['rc/mcp-unassign', 'rc/hook-remove', 'rc/daemon-revoke'])
  })

  it('still delivers held changes when the replay fails', async () => {
    const relays = new RelayRegistry()
    const replaying = channel([RELAY_PROJECTION_SNAPSHOT_V1_FEATURE])
    relays.add(replaying.ch)
    const control = new RelayControlSender(relays)
    const read = gate()
    const replay = replaySnapshot(replaying.ch, 'hook', control, async () => {
      await read.opened
      throw new Error('database unavailable')
    })

    control.hookRemove(HOOK)
    read.open()
    await expect(replay).rejects.toThrow('database unavailable')

    expect(replaying.sent.map((frame) => frame.type)).toEqual(['rc/snapshot-begin', 'rc/hook-remove'])
  })

  it('keeps holding until every overlapping replay of that projection ends', () => {
    const relays = new RelayRegistry()
    const replaying = channel([RELAY_PROJECTION_SNAPSHOT_V1_FEATURE])
    relays.add(replaying.ch)
    const control = new RelayControlSender(relays)
    const first = control.hold(replaying.ch, 'hook')
    const second = control.hold(replaying.ch, 'hook')

    control.hookRemove(HOOK)
    first()
    first()
    expect(replaying.sent).toEqual([])
    second()
    expect(replaying.sent.map((frame) => frame.type)).toEqual(['rc/hook-remove'])
  })
})
