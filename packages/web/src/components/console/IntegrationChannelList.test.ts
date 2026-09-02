import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  conversationOwners,
  groupBySpace,
  IntegrationChannelList,
  placePopover,
  roomArticle,
  roomGlyph,
  roomPlural,
  rowLabel,
  rowLabelParts,
  rowMark,
  rowMenuAction,
  rowName
} from './IntegrationChannelList'
import type { IntegrationChannelRow, IntegrationRow } from '@/lib/data'

vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    setChannelTrigger: vi.fn(),
    setChannelAgent: vi.fn(),
    forgetChannel: vi.fn(),
    leaveConversation: vi.fn(),
    bots: [
      { id: 'bot_shared', agentIds: ['alice', 'bob'] },
      { id: 'bot_solo', agentIds: ['alice'] }
    ],
    agents: [
      { id: 'alice', name: 'alice', displayName: 'Alice', runtime: 'claude' },
      { id: 'bob', name: 'bob', displayName: 'Bob', runtime: 'codex' }
    ],
    integrations: [
      {
        id: 'int_bob',
        botId: 'bot_shared',
        channels: [{ channelId: 'D1', name: '@Alice', kind: 'im', trigger: 'any', agentId: 'bob' }]
      }
    ]
  })
}))

// A shared bot fans its membership snapshot out to one integration per member
// agent, but persists the per-conversation owner on a single canonical row. Every
// member's page must therefore read ownership bot-wide, not off its own row.
describe('conversationOwners', () => {
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
    const owners = conversationOwners('bot_shared', [
      install('int_alice', 'alice', [chan('C-deploys', null)]),
      install('int_bob', 'bob', [chan('C-deploys', 'bob')])
    ])
    // Alice's page renders int_alice's row, whose agentId is null — the owner is bob.
    expect(owners.get('C-deploys')).toBe('bob')
  })

  it('ignores installs of other bots but includes direct-conversation rows', () => {
    const other = { ...install('int_other', 'zoe', [chan('C-deploys', 'zoe')]), botId: 'bot_other' }
    // DM and group DM owners use the same bot-wide projection as channels.
    const dm = install('int_dm', 'bob', [
      { ...chan('D-bob', 'bob'), kind: 'im' as const },
      { ...chan('G-team', 'bob'), kind: 'mpim' as const }
    ])
    const owners = conversationOwners('bot_shared', [other, dm, install('int_bob', 'bob', [chan('C-deploys', 'bob')])])
    expect([...owners]).toEqual([
      ['D-bob', 'bob'],
      ['G-team', 'bob'],
      ['C-deploys', 'bob']
    ])
  })

  it('keeps the first explicit owner when installs disagree', () => {
    // Legacy state can leave two rows claiming a channel; the console must be
    // deterministic rather than depending on install iteration luck.
    const owners = conversationOwners('bot_shared', [
      install('int_bob', 'bob', [chan('C-deploys', 'bob')]),
      install('int_alice', 'alice', [chan('C-deploys', 'alice')])
    ])
    expect(owners.get('C-deploys')).toBe('bob')
  })

  it('reports nothing for a channel no install has claimed', () => {
    const owners = conversationOwners('bot_shared', [install('int_alice', 'alice', [chan('C-deploys', null)])])
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

// A row offers exactly ONE way out, and the copy has to carry whatever that one action
// leaves undone — which differs by platform AND by what kind of place the row is.
describe('rowMenuAction', () => {
  const row = (kind: IntegrationChannelRow['kind'], name = 'acme docs'): IntegrationChannelRow => ({
    channelId: 'C1',
    name,
    kind,
    trigger: 'mention'
  })

  it('offers leaving, and only leaving, where the platform can leave one conversation', () => {
    const action = rowMenuAction(row('channel'), 'telegram')
    expect(action).toMatchObject({ leave: true, label: 'Leave group' })
    expect(action.hint).toContain('leaves this group in Telegram')
  })

  it('offers removing the row, and says where to remove the bot, where it cannot', () => {
    const action = rowMenuAction(row('channel'), 'slack')
    expect(action).toMatchObject({ leave: false, label: 'Remove from this list' })
    expect(action.hint).toContain('remove it in Slack')
    expect(action.confirm).toContain('the row will come back')
  })

  // A Discord bot joins a SERVER, so naming Discord would send the operator hunting for
  // a per-channel control that does not exist; the way out is the band above the row.
  it('points a Discord row at its server, not at Discord', () => {
    const action = rowMenuAction(row('channel'), 'discord')
    expect(action.leave).toBe(false)
    expect(action.hint).toContain('Leave on the server heading above')
    expect(action.hint).not.toContain('remove it in Discord')
  })

  // Nobody is ADDED to a direct conversation, so telling the operator to remove the bot
  // there describes something that cannot be done — on Discord it would also point at a
  // server heading a DM row does not sit under.
  it.each(['telegram', 'slack', 'discord'])('describes a %s direct conversation as a listing only', (platform) => {
    for (const kind of ['im', 'mpim'] as const) {
      const action = rowMenuAction(row(kind), platform)
      expect(action.leave).toBe(false)
      expect(action.hint).toContain('Nobody adds or removes a bot')
      expect(action.hint).toContain('the row comes back on the next message')
      expect(action.hint).not.toContain('server heading')
      expect(action.hint).not.toMatch(/remove it in/)
    }
  })

  // Lark declares `leave: 'none'` with no hint of its own, so it takes the
  // generic sentence — with the platform NAMED, which is the whole point of the
  // shared label table (the id is 'feishu', the word is "Lark").
  it('falls back to the generic sentence, platform named, for a module with no hint', () => {
    const action = rowMenuAction(row('channel'), 'feishu')
    expect(action).toMatchObject({ leave: false, label: 'Remove from this list' })
    expect(action.hint).toContain('The bot stays in the group')
    expect(action.hint).toContain('remove it in Lark')
  })

  // An id no module claims must still produce a sentence — the prop is an open
  // string, and an integration row carries whatever the CP sent.
  it('degrades to the channel defaults and "the chat app" for an unknown platform', () => {
    const action = rowMenuAction(row('channel'), 'teams-x')
    expect(action.leave).toBe(false)
    expect(action.hint).toContain('The bot stays in the channel')
    expect(action.hint).toContain('remove it in the chat app')
  })

  // The stored DM label already carries the "@" the glyph column renders.
  it('names a DM in a confirm without doubling its @', () => {
    expect(rowMenuAction(row('im', '@Alice'), 'slack').confirm).toContain('Remove Alice from this list?')
  })
})

// The list sigil is the module's `roomGlyph`; the DM markers are kind-driven and
// platform-free. AgentDetailView's mobile card header renders this same value one
// line above the row, so the two must not disagree.
describe('roomGlyph', () => {
  it('marks a room with the platform convention, and a DM by kind', () => {
    expect(roomGlyph('channel', 'slack')).toBe('#')
    expect(roomGlyph('channel', 'discord')).toBe('#')
    expect(roomGlyph('channel', 'telegram')).toBe('')
    expect(roomGlyph('channel', 'feishu')).toBe('')
    // Unknown and absent ids take the host default.
    expect(roomGlyph('channel', 'teams-x')).toBe('#')
    expect(roomGlyph('channel', undefined)).toBe('#')
    for (const platform of ['slack', 'telegram', 'feishu', undefined]) {
      expect(roomGlyph('im', platform)).toBe('@')
      expect(roomGlyph('mpim', platform)).toBe('@@')
    }
  })
})

describe('IntegrationChannelList footer', () => {
  const footer = (platform?: string) =>
    renderToStaticMarkup(
      createElement(IntegrationChannelList, {
        platform,
        gated: false,
        channels: [{ channelId: 'C1', name: 'deploys', kind: 'channel', trigger: 'mention' }]
      })
    )

  it("appends the platform's own tail, and nothing when it has none", () => {
    expect(footer('discord')).toContain('A Discord bot joins servers, not channels')
    expect(footer('slack')).toContain('To remove the bot from a channel, do it in Slack')
    // Telegram and Lark contribute no tail — and neither may borrow another's.
    for (const platform of ['telegram', 'feishu', 'teams-x', undefined]) {
      const html = footer(platform)
      expect(html, String(platform)).not.toContain('joins servers, not channels')
      expect(html, String(platform)).not.toContain('do it in Slack')
    }
  })

  it('names the room with the platform noun throughout', () => {
    expect(footer('telegram')).toContain('A group appears here once the bot is added to it')
    expect(footer('slack')).toContain('A channel appears here once the bot is added to it')
    // The article follows the module's noun rather than being a literal, so a module
    // whose noun starts with a vowel reads correctly without the sentence changing.
    expect(roomArticle('issue')).toBe('An')
    expect(roomArticle('channel')).toBe('A')
  })

  it('lets a DERIVED roster replace the arrival sentences with its own note', () => {
    // Linear's team rows are the workspace's own list, upserted by the control plane, so
    // "appears here once the bot is added to it" would describe something that never
    // happens — and there are no direct messages to promise either.
    const html = footer('linear')
    expect(html).not.toContain('appears here once the bot is added to it')
    expect(html).not.toContain('Direct messages appear when someone writes to the bot')
    expect(html).toContain('Every team of this workspace is listed here')
  })

  it('falls back to the generic noun for a platform no module claims', () => {
    // The lookup has to be total — an integration row carries whatever platform the CP
    // sent — and what it answers is the host default, never a borrowed noun.
    expect(footer('not-a-platform')).toContain('A channel appears here once the bot is added to it')
  })
})

describe('IntegrationChannelList private-agent banner', () => {
  const banner = (platform?: string) =>
    renderToStaticMarkup(
      createElement(IntegrationChannelList, {
        platform,
        gated: true,
        channels: [{ channelId: 'C1', name: 'deploys', kind: 'channel', trigger: 'mention' }]
      })
    )

  it('states the gate in one clause, in the platform’s noun', () => {
    expect(banner('slack')).toContain('Private agent: it answers only in a channel or direct message enabled below.')
    expect(banner('telegram')).toContain('only in a group or direct message enabled below')
  })

  it('lets a platform whose gate is more than the row say so itself', () => {
    // §4.3: a gated Linear member acts in a team only as its default, so the host's
    // "enable it below" would promise a per-member switch the model does not have.
    const html = banner('linear')
    expect(html).toContain('Private agent: it answers in a team only where it is the default and the team is not off.')
    expect(html).not.toContain('enabled below')
    expect(html).not.toContain('direct message')
  })
})

describe('IntegrationChannelList trigger control', () => {
  it('does not repeat the lightning glyph an agent avatar may already carry', () => {
    // `zap` is one of the agent icon glyphs, so a row whose dispatch avatar is a bolt read
    // as two of one control. The trigger keeps a neutral bell and its own label.
    const html = renderToStaticMarkup(
      createElement(IntegrationChannelList, {
        platform: 'slack',
        gated: false,
        channels: [{ channelId: 'C1', name: 'deploys', kind: 'channel', trigger: 'mention' }]
      })
    )
    expect(html).toContain('lucide-bell')
    expect(html).not.toContain('lucide-zap')
  })
})

describe('rowLabel', () => {
  it('strips the stored @ from a direct conversation and leaves a channel alone', () => {
    expect(rowLabel({ kind: 'im', name: '@Alice' })).toBe('Alice')
    expect(rowLabel({ kind: 'mpim', name: '@Alice, Bob' })).toBe('Alice, Bob')
    expect(rowLabel({ kind: 'channel', name: 'deploys' })).toBe('deploys')
  })
})

describe('rowLabelParts', () => {
  it('keeps the whole label as the name where the platform declares no split', () => {
    expect(rowLabelParts({ kind: 'channel', name: 'deploys' }, 'slack')).toEqual({ name: 'deploys' })
  })

  it('drops the workspace a Linear team row already sits under, and never shows a team key', () => {
    expect(rowLabelParts({ kind: 'channel', name: 'Acme / Engineering' }, 'linear')).toEqual({
      name: 'Engineering'
    })
    // The team KEY is an identifier: it is not in the stored label and never reaches a row.
    expect(rowLabelParts({ kind: 'channel', name: 'Acme / Engineering' }, 'linear').name).not.toContain('ENG')
    // Only the FIRST separator is the workspace's, so a team named with a slash survives whole.
    expect(rowLabelParts({ kind: 'channel', name: 'Acme / Design / Brand' }, 'linear')).toEqual({
      name: 'Design / Brand'
    })
    // A team the daemon could only label by id, or one whose workspace went unnamed, stands alone.
    expect(rowLabelParts({ kind: 'channel', name: 'team-9f2' }, 'linear')).toEqual({ name: 'team-9f2' })
    expect(rowLabelParts({ kind: 'channel', name: 'Engineering' }, 'linear')).toEqual({ name: 'Engineering' })
  })

  it('never splits a direct row — that label is a person', () => {
    expect(rowLabelParts({ kind: 'im', name: '@A · B' }, 'linear')).toEqual({ name: 'A · B' })
  })
})

describe('rowName', () => {
  it('is the platform’s own, and only where the platform declares one', () => {
    // Linear prints a team's key after its name and links the name; nobody else has either.
    expect(rowName('channel', 'linear')).toBeDefined()
    for (const platform of ['slack', 'discord', 'telegram', 'feishu', undefined]) {
      expect(rowName('channel', platform)).toBeUndefined()
    }
  })

  it('never renames a direct row — its label is a person, with no handle and no page', () => {
    expect(rowName('im', 'linear')).toBeUndefined()
    expect(rowName('mpim', 'linear')).toBeUndefined()
  })
})

describe('roomPlural', () => {
  it('heads a list of rows with the platform’s own noun, pluralised', () => {
    // The three nouns the modules declare today.
    expect(roomPlural('team')).toBe('teams')
    expect(roomPlural('channel')).toBe('channels')
    expect(roomPlural('chat')).toBe('chats')
  })

  it('keeps the sibilant arm honest for a noun no module declares yet', () => {
    expect(roomPlural('inbox')).toBe('inboxes')
    expect(roomPlural('branch')).toBe('branches')
    // The host capitalises before pluralising, so the header reads "Teams", not "teamS".
    expect(roomPlural('Team')).toBe('Teams')
  })
})

describe('rowMark', () => {
  it('is the platform’s own, and only where the platform declares one', () => {
    expect(rowMark('channel', 'linear')).toBeDefined()
    // Every other platform leads its rows with the kind-driven glyph alone.
    for (const platform of ['slack', 'discord', 'telegram', 'feishu', undefined]) {
      expect(rowMark('channel', platform)).toBeUndefined()
    }
  })

  it('never marks a direct row — its label is a person, and `@`/`@@` already lead it', () => {
    expect(rowMark('im', 'linear')).toBeUndefined()
    expect(rowMark('mpim', 'linear')).toBeUndefined()
  })
})

// One member is no choice: the picker would name that agent and offer nothing to pick.
describe('IntegrationChannelList default dispatch on a one-member bot', () => {
  const render = (botId: string) =>
    renderToStaticMarkup(
      createElement(IntegrationChannelList, {
        integrationId: 'int_alice',
        botId,
        agentId: 'alice',
        platform: 'slack',
        shareable: true,
        channels: [{ channelId: 'C1', name: 'deploys', kind: 'channel', trigger: 'mention', agentId: 'alice' }]
      })
    )

  it('drops the picker and the sentence that explains it', () => {
    const html = render('bot_solo')
    expect(html).not.toContain('Default dispatch')
    expect(html).not.toContain('the agent who handles unmatched messages')
  })

  it('keeps both once a second agent shares the bot', () => {
    const html = render('bot_shared')
    expect(html).toContain('Default dispatch — Alice')
    expect(html).toContain('the agent who handles unmatched messages')
  })
})

// A CONTROL has one shape wherever it appears — the trigger's bell, and this. The button used
// to lead with the current agent's avatar, which varies per agent: the control had no
// recognisable form, and one agent's mark could read as a different control entirely.
describe('IntegrationChannelList default dispatch control', () => {
  const render = (agentId: string) =>
    renderToStaticMarkup(
      createElement(IntegrationChannelList, {
        integrationId: 'int_alice',
        botId: 'bot_shared',
        agentId: 'alice',
        platform: 'slack',
        shareable: true,
        channels: [{ channelId: 'C1', name: 'deploys', kind: 'channel', trigger: 'mention', agentId }]
      })
    )

  it('reads as a FIXED glyph plus the current default’s NAME, on every agent', () => {
    const alice = render('alice')
    const bob = render('bob')
    for (const html of [alice, bob]) expect(html).toContain('lucide-corner-down-right')
    expect(alice).toContain('>Alice</span>')
    expect(bob).toContain('>Bob</span>')
  })

  it('prints the name on the desktop row too, rather than hiding it behind a mark', () => {
    expect(render('alice')).not.toContain('desktop:hidden')
  })
})

describe('IntegrationChannelList direct rows', () => {
  it('renders an Everyone DM with its on/off trigger dropdown', () => {
    const html = renderToStaticMarkup(
      createElement(IntegrationChannelList, {
        platform: 'discord',
        gated: false,
        channels: [{ channelId: 'D1', name: '@Alice', kind: 'im', trigger: 'any' }]
      })
    )
    expect(html).toContain('Direct messages')
    // The closed control READS the current choice; "off" is one menu item away.
    expect(html).toContain('aria-label="Trigger for Alice"')
    expect(html).toContain('>on</span>')
  })

  it('renders shared-bot default dispatch for a DM', () => {
    const html = renderToStaticMarkup(
      createElement(IntegrationChannelList, {
        integrationId: 'int_alice',
        botId: 'bot_shared',
        agentId: 'alice',
        platform: 'slack',
        shareable: true,
        channels: [{ channelId: 'D1', name: '@Alice', kind: 'im', trigger: 'any', agentId: 'bob' }]
      })
    )
    expect(html).toContain('Default dispatch — Bob')
  })
})

// A platform may give a conversation more than a label: a Linear team has a KEY and a page.
// Both ride the row as their own fields — neither is ever read back out of the stored label.
describe('IntegrationChannelList row name, where the platform gives one', () => {
  const render = (row: Partial<IntegrationChannelRow> = {}) =>
    renderToStaticMarkup(
      createElement(IntegrationChannelList, {
        platform: 'linear',
        gated: false,
        channels: [
          {
            channelId: 'team-eng',
            name: 'Acme / Engineering',
            kind: 'channel',
            trigger: 'mention',
            key: 'ENG',
            url: 'https://linear.app/example-workspace/team/ENG',
            ...row
          }
        ]
      })
    )

  it('prints the team’s key after its name and links the NAME to the team in Linear', () => {
    const html = render()
    expect(html).toContain('href="https://linear.app/example-workspace/team/ENG"')
    expect(html).toContain('>Engineering</span>')
    expect(html).toContain('>ENG<')
    // The stored label still carries the workspace and never the key (§4.5).
    expect(html).not.toContain('Acme / Engineering</span>')
  })

  it('leaves every other platform’s row exactly as it was', () => {
    const slack = renderToStaticMarkup(
      createElement(IntegrationChannelList, {
        platform: 'slack',
        gated: false,
        channels: [{ channelId: 'C1', name: 'deploys', kind: 'channel', trigger: 'mention' }]
      })
    )
    expect(slack).not.toContain('<a ')
    expect(slack).toContain('>deploys</span>')
  })
})

// A row offers exactly one way out, so it spends it directly — the same × the repository
// rows carry — rather than hiding a single item behind an overflow menu.
describe('IntegrationChannelList row action', () => {
  const render = (platform: string) =>
    renderToStaticMarkup(
      createElement(IntegrationChannelList, {
        integrationId: 'int_alice',
        platform,
        channels: [{ channelId: 'C1', name: 'deploys', kind: 'channel', trigger: 'mention' }]
      })
    )

  it('delists with an × where the bot cannot leave', () => {
    const html = render('slack')
    expect(html).toContain('aria-label="Remove from this list: deploys"')
    expect(html).toContain('lucide-x')
    expect(html).not.toContain('lucide-ellipsis')
  })

  it('leaves, and says so, where the platform can leave one conversation', () => {
    const html = render('telegram')
    expect(html).toContain('aria-label="Leave group: deploys"')
    expect(html).toContain('lucide-log-out')
    expect(html).not.toContain('lucide-ellipsis')
  })
})
