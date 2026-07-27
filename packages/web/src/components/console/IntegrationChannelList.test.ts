import { describe, expect, it } from 'vitest'
import { channelOwners, placePopover } from './IntegrationChannelList'
import type { IntegrationChannelRow, IntegrationRow } from '@/lib/data'

// A shared bot fans its membership snapshot out to one integration per member
// agent, but persists the per-channel owner on a single canonical row. Every
// member's page must therefore read ownership bot-wide, not off its own row.
describe('channelOwners', () => {
  const install = (id: string, agentId: string, channels: IntegrationChannelRow[]): IntegrationRow => ({
    id,
    agentId,
    botId: 'bot_shared',
    shareable: true,
    name: 'acme-bridge',
    platform: 'slack',
    kind: 'Shared bot',
    workspace: 'acme.example.test',
    daemon: 'edge-1',
    status: 'online',
    agentCount: '3',
    channels
  })
  const chan = (channelId: string, agentId?: string | null): IntegrationChannelRow => ({
    channelId,
    name: channelId,
    kind: 'channel',
    trigger: 'mention',
    ...(agentId !== undefined ? { agentId } : {})
  })

  it('finds an owner persisted on a different member installation', () => {
    const owners = channelOwners('bot_shared', [
      install('int_alice', 'alice', [chan('C-deploys', null)]),
      install('int_bob', 'bob', [chan('C-deploys', 'bob')])
    ])
    // Alice's page renders int_alice's row, whose agentId is null — the owner is bob.
    expect(owners.get('C-deploys')).toBe('bob')
  })

  it('ignores installs of other bots and DM rows', () => {
    const other = { ...install('int_other', 'zoe', [chan('C-deploys', 'zoe')]), botId: 'bot_other' }
    const dm = install('int_dm', 'bob', [{ ...chan('D-bob', 'bob'), kind: 'im' as const }])
    const owners = channelOwners('bot_shared', [other, dm, install('int_bob', 'bob', [chan('C-deploys', 'bob')])])
    expect([...owners]).toEqual([['C-deploys', 'bob']])
  })

  it('keeps the first explicit owner when installs disagree', () => {
    // Legacy state can leave two rows claiming a channel; the console must be
    // deterministic rather than depending on install iteration luck.
    const owners = channelOwners('bot_shared', [
      install('int_bob', 'bob', [chan('C-deploys', 'bob')]),
      install('int_alice', 'alice', [chan('C-deploys', 'alice')])
    ])
    expect(owners.get('C-deploys')).toBe('bob')
  })

  it('reports nothing for a channel no install has claimed', () => {
    const owners = channelOwners('bot_shared', [install('int_alice', 'alice', [chan('C-deploys', null)])])
    expect(owners.has('C-deploys')).toBe(false)
  })
})

// The default-dispatch popover is portalled to the body at fixed coordinates
// (its host cards clip), so nothing else keeps it inside the viewport — these
// four corners are that guarantee.
describe('placePopover', () => {
  const btn = (left: number, top: number) => ({ left, right: left + 44, top, bottom: top + 28 })

  it('anchors below-left of the button when there is room', () => {
    expect(placePopover(btn(300, 200), 1280, 720).style).toEqual({ left: 300, top: 234 })
  })

  it('right-aligns when the menu would run past the right edge', () => {
    // 1100 + 240 > 1280 - 8 ⇒ pin the menu's right edge to the button's.
    expect(placePopover(btn(1100, 200), 1280, 720).style).toEqual({ right: 1280 - 1144, top: 234 })
  })

  it('flips above the button when the bottom edge is too close', () => {
    expect(placePopover(btn(300, 600), 1280, 720).style).toEqual({ left: 300, bottom: 720 - 600 + 6 })
  })

  it('stays below when flipping up would clip the top instead', () => {
    // A short viewport with the button near the top: neither side fits, and
    // below is the one that keeps the button visible.
    expect(placePopover(btn(300, 40), 1280, 200).style).toEqual({ left: 300, top: 74 })
  })
})
