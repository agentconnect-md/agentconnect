// No 'use client' here: reached only from the console's client trees
// (ModalProvider and the views), exactly like `registry.ts`.

import { larkFeishuBrand, type LarkFeishuTarget } from '@/components/LarkFeishuSwitcher'
import type { BotDto } from '@/lib/api'
import { platformLabel } from '@/lib/platform-labels'
import { platformRegistry } from './registry'

/**
 * The console's HOST PROJECTIONS over the platform axis — the surfaces whose
 * ROW SET is "one entry per platform" but whose CONTENT the registry cannot
 * answer for: the install picker's tiles, the agent page's
 * empty-integrations tiles, and the Settings → Bots tab strip.
 *
 * Every row set here derives from `platformRegistry.ids()` (audit §10.6 F14 —
 * the Bots tab strip used to be a hand-written five-row table with its own
 * labels and nouns, so adding a platform silently left a tab missing). What the
 * host adds on top is projection, not membership:
 *
 *  - **display names** come from the console's one display-name table
 *    (`lib/platform-labels.ts`), never re-spelled here. §5's `displayName` is
 *    manifest data shared with the daemon/relay/CP and deliberately NOT a
 *    web-module member (contract D2);
 *  - the **core trigger kinds** (`webhook`, `github`, `gitlab`) are not platform
 *    modules at all — picking one mints an inbound hook rather than a bot
 *    identity — so the chassis lists them itself;
 *  - the **region axis** ({@link BOT_PLATFORM_TABS}), for the same D2 reason.
 *
 * The rule these exist to keep: adding a platform is ONE registry line. Nothing
 * in this file may become a second list of WHICH platforms exist —
 * `platform-set.test.tsx` fails if one does.
 */

/** One picker/tile row. `key` is an OPEN string — the platform axis is the
 *  registry's, and a closed union over it is a type-level lie the runtime does
 *  not back (audit §10.6 F15). See `Platform` in `AddIntegrationModal`. */
export interface PlatformTile {
  readonly key: string
  readonly label: string
}

/**
 * Project a set of platform ids onto picker tiles. Pure and exported so the
 * drift test can push an id through it that no module claims: an unregistered
 * id renders as ITSELF rather than being cast into a union that never had it.
 */
export function platformTiles(ids: readonly string[]): PlatformTile[] {
  return ids.map((id) => ({ key: id, label: platformLabel(id)?.picker ?? id }))
}

/**
 * The install picker's chat-platform tiles, in registry (picker) order. Gated
 * at the call site on the owning daemon's advertised adapters, so a tile can
 * never promise a platform the modal would refuse.
 */
export const BOT_PLATFORMS: readonly PlatformTile[] = platformTiles(platformRegistry.ids())

/** Every picker choice: the chat platforms plus the core trigger kinds. None of
 *  the triggers is gated by daemon adapters — all live on the relay pool, and a
 *  code host the deployment has not configured says so in its own pane. */
export const PLATFORMS: readonly PlatformTile[] = [
  ...BOT_PLATFORMS,
  { key: 'webhook', label: 'Webhook' },
  { key: 'github', label: 'GitHub' },
  { key: 'gitlab', label: 'GitLab' }
]

/** The core trigger kinds — every picker choice that is NOT a registry platform.
 *  Derived from the two lists rather than restated, so adding a trigger kind above
 *  is still one edit. These ride the relay pool, so no daemon's chat-adapter
 *  capabilities gate them; every picker must treat them as always available. */
export function isCoreTriggerKind(key: string): boolean {
  return !BOT_PLATFORMS.some((tile) => tile.key === key) && PLATFORMS.some((tile) => tile.key === key)
}

/**
 * One-liners for the agent page's empty-integrations tiles, keyed by picker
 * choice. An open record rather than an exhaustive one for the same reason
 * {@link PlatformTile.key} is an open string; totality is kept by the drift
 * test instead of by a union the registry cannot produce.
 */
export const INTEGRATION_BLURB: Record<string, string> = {
  slack: 'Reply in channels & DMs',
  telegram: 'Reply in groups & chats',
  discord: 'Reply in servers',
  feishu: 'Reply in groups & chats',
  linear: 'Work delegated issues',
  github: 'React to issues & PRs',
  gitlab: 'React to issues & MRs',
  webhook: 'Trigger by posting a URL'
}

/** One tab of the Settings → Bots card: a platform, or one cloud of a platform
 *  with regional clouds. */
export interface BotPlatformTab {
  /** Stable tab identity — internal (component state + lookup), never shown.
   *  Compound on a region row so two platforms' regions can never collide. */
  readonly key: string
  /** The registry platform id this tab reads modules and copy for. */
  readonly platform: string
  /** The cloud this tab is filtered to, or null on a regionless platform. */
  readonly region: LarkFeishuTarget | null
  /** The tab's display word. */
  readonly label: string
}

/**
 * The one platform with regional clouds, expanded to a tab per cloud — the
 * SAME chassis carve-out the install wizard makes (`platform === 'feishu' ?
 * feishuRegion : undefined`, AddIntegrationModal, plus the switcher on its
 * picker tile). §5's `regions` is manifest data the web module deliberately
 * does not carry (contract D2): inventing a web-only `regions` member would
 * create the second authority that note exists to prevent, so the region axis
 * stays the chassis's and lives in exactly these two places.
 */
const REGION_CLOUDS: Readonly<Record<string, readonly LarkFeishuTarget[]>> = {
  feishu: ['lark', 'feishu']
}

/**
 * The Settings → Bots tab strip, in registry (picker) order. The row SET is the
 * registry's; the labels are the display-name table's, except on a region row,
 * whose word is the cloud's brand rather than the platform's ({@link
 * larkFeishuBrand} — `platformLabel('feishu').name` is "Lark" on purpose).
 */
export const BOT_PLATFORM_TABS: readonly BotPlatformTab[] = platformRegistry
  .ids()
  .flatMap((platform): BotPlatformTab[] => {
    const clouds = REGION_CLOUDS[platform]
    if (!clouds) return [{ key: platform, platform, region: null, label: platformLabel(platform)?.name ?? platform }]
    return clouds.map((region) => ({
      key: `${platform}:${region}`,
      platform,
      region,
      label: larkFeishuBrand(region)
    }))
  })

/** Whether a bot row belongs under this tab. `feishuRegion` is the only region
 *  a `BotDto` carries; a row predating the axis is Feishu. */
export function botMatchesPlatformTab(bot: Pick<BotDto, 'platform' | 'feishuRegion'>, tab: BotPlatformTab): boolean {
  if (bot.platform !== tab.platform) return false
  return tab.region === null || (bot.feishuRegion ?? 'feishu') === tab.region
}
