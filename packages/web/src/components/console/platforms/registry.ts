// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import type { WebChannelListSemantics, WebPlatformModule, WebPlatformRegistry } from './contract'
import { discordModule } from './discord'
import { feishuModule } from './feishu'
import { slackModule } from './slack'
import { telegramModule } from './telegram'

/**
 * The console's platform registry (§10) — the single platform-set authority
 * behind the install wizard. Registering a platform is ONE line here; no host
 * component grows a branch for it.
 *
 * `webhook` and `github` are deliberately absent: picking either mints an
 * inbound trigger (a relay/CP-backed hook) rather than a bot identity, so their
 * wizard sections are CORE fragments of the chassis, not modules of this
 * contract.
 *
 * Order is the picker order.
 */
const MODULES: readonly WebPlatformModule[] = [slackModule, telegramModule, discordModule, feishuModule]

const BY_ID = new Map(MODULES.map((m) => [m.platformId, m]))
const IDS: readonly string[] = MODULES.map((m) => m.platformId)

export const platformRegistry: WebPlatformRegistry = {
  get: (platformId) => BY_ID.get(platformId),
  all: () => MODULES,
  ids: () => IDS
}

/**
 * The channel card's fallback semantics — the arm every non-module platform took
 * before the switch moved: a "channel" with a `#`, and no console-driven leave.
 * `IntegrationChannelList`'s `platform` prop is an OPEN, optional string (an
 * integration row carries whatever the CP sent), so the lookup has to be total.
 */
export const DEFAULT_CHANNEL_LIST: WebChannelListSemantics = {
  roomNoun: 'channel',
  roomGlyph: '#',
  leave: 'none'
}

/** One platform's channel-list display semantics, defaulted. */
export function channelListSemantics(platformId?: string): WebChannelListSemantics {
  return (platformId ? platformRegistry.get(platformId)?.channelList : undefined) ?? DEFAULT_CHANNEL_LIST
}
