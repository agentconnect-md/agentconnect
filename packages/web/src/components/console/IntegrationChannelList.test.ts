import { describe, expect, it } from 'vitest'
import { channelOwners, groupBySpace, placePopover } from './IntegrationChannelList'
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

// One Discord bot commonly spans several servers, each with a "#general" of its own —
// and Discord lets two of those servers carry the same NAME.
describe('groupBySpace', () => {
  const chan = (channelId: string, spaceId?: string, space?: string): IntegrationChannelRow => ({
    channelId,
    name: 'general',
    kind: 'channel',
    trigger: 'mention',
    ...(spaceId ? { spaceId } : {}),
    ...(space ? { space } : {})
  })

  it('bands the rows under their server, alphabetically', () => {
    expect(groupBySpace([chan('C2', 'G2', 'Side Project'), chan('C1', 'G1', 'Acme HQ')])).toEqual([
      { key: 'G1', label: 'Acme HQ', rows: [chan('C1', 'G1', 'Acme HQ')] },
      { key: 'G2', label: 'Side Project', rows: [chan('C2', 'G2', 'Side Project')] }
    ])
  })

  it('keeps two SAME-NAMED servers apart and makes the duplication visible', () => {
    // Grouping on the label would merge these, hiding the very ambiguity the server
    // band exists to resolve — both channels are called "general" too.
    const groups = groupBySpace([chan('C1', '90000001111', 'Acme'), chan('C2', '90000002222', 'Acme')])
    expect(groups.map((g) => g.key)).toEqual(['90000001111', '90000002222'])
    expect(groups.map((g) => g.label)).toEqual(['Acme · 1111', 'Acme · 2222'])
  })

  it('treats labels that READ alike as a clash — the header is uppercased', () => {
    const groups = groupBySpace([chan('C1', '90000001111', 'acme'), chan('C2', '90000002222', 'ACME')])
    expect(groups.map((g) => g.label)).toEqual(['acme · 1111', 'ACME · 2222'])
  })

  it('widens the id tail until the suffixes themselves differ', () => {
    // Snowflakes of one shard share their low bits, so a fixed 4-char tail can collide —
    // which would hand two distinct servers the same visible header.
    const groups = groupBySpace([chan('C1', '11110000', 'Acme'), chan('C2', '22220000', 'Acme')])
    // The 4-char tails are both "0000"; widening by one is enough here.
    expect(groups.map((g) => g.label)).toEqual(['Acme · 10000', 'Acme · 20000'])
  })

  it('breaks a tie between a real name and a synthesized one', () => {
    // A server can be NAMED like the header an unresolved one gets; only the real label
    // can take a suffix, so that is the one that moves.
    const groups = groupBySpace([chan('C1', '90000009999', 'server 2222'), chan('C2', '90000002222')])
    expect(groups.map((g) => g.label)).toEqual(['server 2222', 'server 2222 · 9999'].sort())
  })

  it('keeps a space-less platform one flat, unheaded list', () => {
    expect(groupBySpace([chan('C1'), chan('C2')])).toEqual([{ key: '', rows: [chan('C1'), chan('C2')] }])
  })

  it('heads a server whose name has not resolved yet by its id, not the flat group', () => {
    const groups = groupBySpace([chan('C1', 'G1', 'Acme HQ'), chan('C2', '90000002222'), chan('C3')])
    expect(groups).toEqual([
      { key: '', rows: [chan('C3')] },
      { key: 'G1', label: 'Acme HQ', rows: [chan('C1', 'G1', 'Acme HQ')] },
      { key: '90000002222', label: 'server 2222', rows: [chan('C2', '90000002222')] }
    ])
  })

  it('takes the label from whichever row of the server carries one', () => {
    const rows = [chan('C1', 'G1'), chan('C2', 'G1', 'Acme HQ')]
    expect(groupBySpace(rows)).toEqual([{ key: 'G1', label: 'Acme HQ', rows }])
  })
})
