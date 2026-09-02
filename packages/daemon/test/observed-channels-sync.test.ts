import { describe, it, expect } from 'vitest'
import { ObservedChannelsSync } from '../src/platforms/observed-channels-sync.js'
import type { ObservedChannelsSyncHost } from '../src/platforms/observed-channels-sync.js'
import type { IntegrationChannel } from '@agentconnect.md/protocol'

const INTEGRATION = 'a05ba3a0-9f97-4a2b-9c1f-9f8ff0e6d101'

/** A host with just the seams `observePlatformChats` spends — one integration, one snapshot map. */
function harness() {
  const snapshots = new Map<string, { channels: IntegrationChannel[]; authoritative: boolean }>()
  const reports: { integrationId: string; channels: IntegrationChannel[] }[] = []
  const host = {
    store: () => ({ setDisplayName: async () => {} }),
    channelSnapshots: () => snapshots,
    integrationConfigById: () => ({ id: INTEGRATION, platform: 'linear' }),
    cpClient: () => ({
      emitIntegrationChannels: (s: { integrationId: string; channels: IntegrationChannel[] }) => reports.push(s)
    }),
    emitSessionMetadataSnapshotsForDisplayName: async () => {}
  } as unknown as ObservedChannelsSyncHost
  return { sync: new ObservedChannelsSync(host), snapshots, reports }
}

const rows = (snapshots: Map<string, { channels: IntegrationChannel[] }>): IntegrationChannel[] =>
  snapshots.get(INTEGRATION)?.channels ?? []

describe('observePlatformChats — the conversation row a platform reports as observed', () => {
  it('carries the chat’s own glyph onto the row, and leaves it off where there is none', async () => {
    const { sync, snapshots, reports } = harness()
    await sync.observePlatformChats(
      'linear',
      [
        { id: 'team-1', name: 'Acme / Engineering', icon: 'Feather', color: '#5E6AD2', isPrivate: false },
        { id: 'team-2', name: 'Acme / Design', isPrivate: false }
      ],
      [INTEGRATION]
    )
    expect(rows(snapshots)).toEqual([
      {
        id: 'team-1',
        name: 'Acme / Engineering',
        icon: 'Feather',
        color: '#5E6AD2',
        isPrivate: false,
        kind: 'channel'
      },
      { id: 'team-2', name: 'Acme / Design', isPrivate: false, kind: 'channel' }
    ])
    expect(reports).toHaveLength(1)
  })

  it('learns a glyph once and never unlearns it — a later observation without one keeps the row drawn', async () => {
    const { sync, snapshots, reports } = harness()
    const glyphed = { id: 'team-1', name: 'Acme / Engineering', icon: '🚀', color: '#F2994A', isPrivate: false }
    await sync.observePlatformChats('linear', [glyphed], [INTEGRATION])
    await sync.observePlatformChats(
      'linear',
      [{ id: 'team-1', name: 'Acme / Engineering', isPrivate: false }],
      [INTEGRATION]
    )
    expect(rows(snapshots)[0]).toMatchObject({ icon: '🚀', color: '#F2994A' })
    // Nothing changed, so nothing was reported a second time.
    expect(reports).toHaveLength(1)
  })

  it('reports again when only the glyph changed — a renamed row is not the only thing the console redraws', async () => {
    const { sync, snapshots, reports } = harness()
    const chat = { id: 'team-1', name: 'Acme / Engineering', isPrivate: false }
    await sync.observePlatformChats('linear', [{ ...chat, icon: 'Feather', color: '#5E6AD2' }], [INTEGRATION])
    await sync.observePlatformChats('linear', [{ ...chat, icon: 'Feather', color: '#26B5CE' }], [INTEGRATION])
    expect(rows(snapshots)[0]).toMatchObject({ color: '#26B5CE' })
    expect(reports).toHaveLength(2)
  })
})
