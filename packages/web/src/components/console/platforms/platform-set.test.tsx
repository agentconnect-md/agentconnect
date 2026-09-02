import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { larkFeishuBrand } from '@/components/LarkFeishuSwitcher'
import { PlatformMark } from '@/components/marks'
import { chatRoomSigil, PLATFORM_LABEL_IDS, platformLabel } from '@/lib/platform-labels'
import {
  BOT_PLATFORMS,
  BOT_PLATFORM_TABS,
  INTEGRATION_BLURB,
  PLATFORMS,
  botMatchesPlatformTab,
  isCoreTriggerKind,
  platformTiles
} from './host-projections'
import { PLATFORM_MARK_IDS, platformMark } from './marks'
import { botCardCopy, channelListSemantics, platformRegistry } from './registry'

/**
 * The registry is the single platform-set authority (§10), but two lookups
 * deliberately do NOT read through it — `platforms/marks.ts`, because
 * `PlatformMark` is imported by the signed-out routes and a registry read there
 * would drag the install wizard into their bundles, and `lib/platform-labels.ts`,
 * for the same reason via `lib/data.ts`. Both list the platform ids a second
 * time, so this file is what keeps the copies honest: adding a module without
 * adding its mark or its label fails here rather than shipping a plug glyph and a
 * capitalized id into production.
 *
 * It also covers the host PROJECTIONS over that id set (`host-projections.ts`) —
 * the install picker's tiles, the agent page's tile blurbs and the Settings →
 * Bots tab strip. The strip in particular was once a hand-written five-row table
 * with its own labels and nouns, uncovered by any test and therefore free to
 * drift.
 */
const ALIASES = ['lark']

/** Not modules and never will be: picking one mints an inbound trigger, not a
 *  bot identity (contract, registry doc). The picker still offers them. */
// The code hosts follow the chat platforms; the generic webhook closes the row.
const CORE_TRIGGER_KINDS = ['github', 'gitlab', 'webhook']

describe('platform set', () => {
  it('gives every registered module a mark and a label', () => {
    for (const id of platformRegistry.ids()) {
      expect(platformMark(id), `mark for ${id}`).toBeDefined()
      expect(platformLabel(id), `label for ${id}`).toBeDefined()
    }
  })

  it('adds nothing to the mark and label tables beyond the modules and the known aliases', () => {
    const allowed = [...platformRegistry.ids(), ...ALIASES].sort()
    expect([...PLATFORM_MARK_IDS].sort()).toEqual(allowed)
    expect([...PLATFORM_LABEL_IDS].sort()).toEqual(allowed)
  })

  it('keeps the prose name and the picker label distinct only where they must be', () => {
    // One platform id, two clouds: prose picks the international brand, the
    // picker names both so a Feishu user recognizes their own tile.
    expect(platformLabel('feishu')).toEqual({ name: 'Lark', picker: 'Lark/Feishu', sigil: '' })
    expect(platformLabel('lark')).toEqual(platformLabel('feishu'))
    for (const id of ['slack', 'telegram', 'discord', 'linear']) {
      const label = platformLabel(id)!
      expect(label.name, id).toBe(label.picker)
    }
  })

  it('spells the room sigil the same in the label table and the module contract', () => {
    // The session list writes a channel label without reading the registry (that would drag the
    // install wizard into every route), so the copy has to be kept honest here: a Linear team and
    // a Telegram group carry no "#", and only a platform whose rooms ARE channels gets one.
    for (const id of platformRegistry.ids()) {
      expect(chatRoomSigil(id), id).toBe(channelListSemantics(id).roomGlyph)
    }
    expect(chatRoomSigil('feishu')).toBe(chatRoomSigil('lark'))
    expect(chatRoomSigil('linear')).toBe('')
    // An id no chat platform claims keeps the channel convention every non-module row had.
    expect(chatRoomSigil('teams-x')).toBe('#')
    expect(chatRoomSigil(undefined)).toBe('#')
  })

  it('offers exactly the registered platforms as picker tiles, plus the core triggers', () => {
    // The tile SET is the registry's, in registry order; the trigger kinds are
    // appended by the chassis because they are not modules.
    expect(BOT_PLATFORMS.map((tile) => tile.key)).toEqual([...platformRegistry.ids()])
    expect(PLATFORMS.map((tile) => tile.key)).toEqual([...platformRegistry.ids(), ...CORE_TRIGGER_KINDS])
  })

  it('labels every picker tile from the display-name table and blurbs every choice', () => {
    for (const tile of BOT_PLATFORMS) {
      expect(tile.label, tile.key).toBe(platformLabel(tile.key)?.picker)
    }
    // A choice with no one-liner is a tile with no tooltip — the drift a
    // registry-derived list makes easy and an exhaustive record used to catch.
    for (const tile of PLATFORMS) {
      expect(INTEGRATION_BLURB[tile.key], tile.key).toBeTruthy()
    }
    expect(Object.keys(INTEGRATION_BLURB).sort()).toEqual([...platformRegistry.ids(), ...CORE_TRIGGER_KINDS].sort())
  })

  it('treats exactly the non-module choices as relay-backed trigger kinds', () => {
    // Both pickers gate a chat platform on the owning daemon's advertised adapters
    // and must NEVER gate a trigger kind that way — GitLab's empty-state tile
    // rendered disabled for a normally placed agent while this set named only two.
    expect(PLATFORMS.map((tile) => tile.key).filter(isCoreTriggerKind)).toEqual(CORE_TRIGGER_KINDS)
    expect(isCoreTriggerKind('gitlab')).toBe(true)
    for (const id of platformRegistry.ids()) expect(isCoreTriggerKind(id), id).toBe(false)
    expect(isCoreTriggerKind('zulip')).toBe(false)
  })

  it('passes an id no module claims straight through the tile projection', () => {
    // F15: the tile list used to be CAST into a closed union, so an id the
    // registry could legitimately grow was a type-level lie. It is a plain
    // string now — an unknown id renders as itself rather than as a claim that
    // it is one of four.
    expect(platformTiles(['zulip', 'slack'])).toEqual([
      { key: 'zulip', label: 'zulip' },
      { key: 'slack', label: 'Slack' }
    ])
  })

  it('gives every registered platform a Settings → Bots tab', () => {
    // Adding a module without a tab used to hide its bots from the card
    // entirely. The strip is region-EXPANDED, so compare the platforms it
    // covers, not its row count.
    expect([...new Set(BOT_PLATFORM_TABS.map((tab) => tab.platform))]).toEqual([...platformRegistry.ids()])
    expect(new Set(BOT_PLATFORM_TABS.map((tab) => tab.key)).size).toBe(BOT_PLATFORM_TABS.length)
  })

  it('takes every tab label from the display-name table, or from the cloud on a region row', () => {
    for (const tab of BOT_PLATFORM_TABS) {
      if (tab.region === null) {
        expect(tab.label, tab.key).toBe(platformLabel(tab.platform)?.name)
      } else {
        // The one platform with regional clouds: the row is per CLOUD, and
        // `platformLabel('feishu').name` is deliberately the international
        // brand ("Lark"), so a region row's word comes from the region axis's
        // own vocabulary instead of being re-spelled here.
        expect(tab.label, tab.key).toBe(larkFeishuBrand(tab.region))
      }
    }
    expect(BOT_PLATFORM_TABS.map((tab) => tab.label)).toEqual([
      'Slack',
      'Telegram',
      'Discord',
      'Lark',
      'Feishu',
      'Linear'
    ])
  })

  it('routes each bot to exactly one tab, region rows included', () => {
    const bots = [
      { platform: 'slack', feishuRegion: null },
      { platform: 'telegram', feishuRegion: null },
      { platform: 'discord', feishuRegion: null },
      { platform: 'feishu', feishuRegion: 'lark' as const },
      { platform: 'feishu', feishuRegion: 'feishu' as const },
      // Rows predating the region axis belong to Feishu, not to Lark.
      { platform: 'feishu', feishuRegion: null }
    ]
    for (const bot of bots) {
      const matched = BOT_PLATFORM_TABS.filter((tab) => botMatchesPlatformTab(bot, tab))
      expect(
        matched.map((tab) => tab.label),
        `${bot.platform}/${bot.feishuRegion}`
      ).toHaveLength(1)
    }
    const legacyFeishu = BOT_PLATFORM_TABS.filter((tab) =>
      botMatchesPlatformTab({ platform: 'feishu', feishuRegion: null }, tab)
    )
    expect(legacyFeishu[0]?.label).toBe('Feishu')
    // A platform the console has not been taught lands on no tab at all rather
    // than under whichever one happens to be first.
    expect(BOT_PLATFORM_TABS.filter((tab) => botMatchesPlatformTab({ platform: 'zulip' }, tab))).toEqual([])
  })

  it('names the bot identity from the module, not from the tab table', () => {
    // The noun was the tab table's own column ('app' for Slack, 'bot' for the
    // rest). It is module copy now, so the card's heading, delete tooltip and
    // empty state read one declaration — and a row that is not a bot at all can
    // say so ('workspace' on Linear, where the row IS one connected workspace).
    const NOUNS: Record<string, string> = { slack: 'app', linear: 'workspace' }
    for (const id of platformRegistry.ids()) {
      expect(botCardCopy(id).identityNoun, id).toBe(NOUNS[id] ?? 'bot')
    }
    expect(botCardCopy('zulip').identityNoun).toBe('bot')
  })

  it('renders the same mark through the module and through PlatformMark', () => {
    // The `fillPct` box contract is the regression this guards: the host caps the
    // square glyphs at 80% and the module must cap identically, or the two render
    // paths for one platform disagree on glyph size.
    for (const module of platformRegistry.all()) {
      const { Mark, platformId } = module
      for (const fillPct of [undefined, 60, 70, 100]) {
        const viaModule = renderToStaticMarkup(<Mark {...(fillPct === undefined ? {} : { fillPct })} />)
        const viaHost = renderToStaticMarkup(
          <PlatformMark platform={platformId} {...(fillPct === undefined ? {} : { fillPct })} />
        )
        expect(viaHost, `${platformId} @ ${fillPct ?? 'default'}`).toBe(viaModule)
      }
    }
  })
})
