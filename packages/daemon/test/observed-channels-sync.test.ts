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

  it('carries the chat’s handle and link onto the row, learned once like the glyph', async () => {
    const { sync, snapshots, reports } = harness()
    const linked = {
      id: 'team-1',
      name: 'Acme / Engineering',
      key: 'ENG',
      url: 'https://linear.app/example-workspace/team/ENG',
      isPrivate: false
    }
    await sync.observePlatformChats('linear', [linked], [INTEGRATION])
    expect(rows(snapshots)[0]).toMatchObject({ key: 'ENG', url: 'https://linear.app/example-workspace/team/ENG' })
    // A later observation that resolved neither leaves the linked row standing, and reports nothing.
    await sync.observePlatformChats(
      'linear',
      [{ id: 'team-1', name: 'Acme / Engineering', isPrivate: false }],
      [INTEGRATION]
    )
    expect(rows(snapshots)[0]).toMatchObject({ key: 'ENG', url: 'https://linear.app/example-workspace/team/ENG' })
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

const TEAM = '19:example-team@thread.tacv2'
const DESIGN = '19:example-design@thread.tacv2'
const PERSONAL = 'a:example-personal'

/** A Teams integration whose live connection names the team of every channel in `spaces`, and whose sessions observed `observed`. */
function teamsHarness(observed: { id: string; name?: string }[], spaces: Map<string, { id: string; name?: string }>) {
  const snapshots = new Map<string, { channels: IntegrationChannel[]; authoritative: boolean }>()
  const reports: { integrationId: string; channels: IntegrationChannel[] }[] = []
  const integration = { id: INTEGRATION, platform: 'msteams' }
  const host = {
    store: () => ({
      setDisplayName: async () => {},
      retractedConversations: async () => new Set<string>(),
      observedChannels: async () => observed,
      getDisplayNames: async () => new Map<string, string>(),
      getChannelScopes: async () => new Map([[PERSONAL, { isIm: true }]])
    }),
    agents: () => new Map([['agent', { id: 'agent', integrations: [integration] }]]),
    channelSnapshots: () => snapshots,
    integrationConfigById: () => integration,
    liveSpaceFor: async (_integrationId: string, channelId: string) => spaces.get(channelId),
    transportScopeForIntegration: () => '',
    cpClient: () => ({
      emitIntegrationChannels: (s: { integrationId: string; channels: IntegrationChannel[] }) => reports.push(s)
    }),
    emitSessionMetadataSnapshotsForDisplayName: async () => {}
  } as unknown as ObservedChannelsSyncHost
  return { sync: new ObservedChannelsSync(host), snapshots, reports }
}

describe('a Teams channel row’s space — its team, as the live connection names it', () => {
  it('labels each observed channel with its team and leaves a 1:1 chat without one', async () => {
    const spaces = new Map([
      [TEAM, { id: TEAM, name: 'Example Team' }],
      [DESIGN, { id: TEAM, name: 'Example Team' }]
    ])
    const { sync, snapshots } = teamsHarness([{ id: TEAM }, { id: DESIGN }, { id: PERSONAL }], spaces)
    await sync.refreshObservedChannels()
    expect(rows(snapshots)).toEqual([
      { id: TEAM, spaceId: TEAM, space: 'Example Team' },
      { id: DESIGN, spaceId: TEAM, space: 'Example Team' },
      { id: PERSONAL, kind: 'im' }
    ])
  })

  it('keeps the last known team while the connection cannot name it, as after a restart', async () => {
    const spaces = new Map([[DESIGN, { id: TEAM, name: 'Example Team' }]])
    const { sync, snapshots } = teamsHarness([{ id: DESIGN }], spaces)
    await sync.refreshObservedChannels()
    spaces.clear()
    await sync.refreshObservedChannels()
    expect(rows(snapshots)).toEqual([{ id: DESIGN, spaceId: TEAM, space: 'Example Team' }])
    expect(await sync.spaceFor('msteams', DESIGN, INTEGRATION)).toBeUndefined()
  })

  it('carries a reported team onto an install’s rows, learned once, leaving privacy unsaid', async () => {
    const { sync, snapshots, reports } = teamsHarness([], new Map())
    await sync.observePlatformChats(
      'msteams',
      [
        { id: TEAM, name: 'General', spaceId: TEAM, space: 'Example Team' },
        { id: DESIGN, name: 'Design', spaceId: TEAM, space: 'Example Team' }
      ],
      [INTEGRATION]
    )
    expect(rows(snapshots)).toEqual([
      { id: TEAM, name: 'General', spaceId: TEAM, space: 'Example Team', kind: 'channel' },
      { id: DESIGN, name: 'Design', spaceId: TEAM, space: 'Example Team', kind: 'channel' }
    ])
    await sync.observePlatformChats('msteams', [{ id: DESIGN, name: 'Design' }], [INTEGRATION])
    expect(rows(snapshots)[1]).toMatchObject({ spaceId: TEAM, space: 'Example Team' })
    expect(reports).toHaveLength(1)
    // An install's row survives the next rebuild from session history, its team still named.
    await sync.refreshObservedChannels()
    expect(rows(snapshots).map((c) => c.space)).toEqual(['Example Team', 'Example Team'])
  })
})
