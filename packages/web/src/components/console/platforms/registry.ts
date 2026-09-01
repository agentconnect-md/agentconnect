// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import type { ComponentType } from 'react'
import type { BotDto, SessionMessageDto } from '@/lib/api'
import type { WebBotCardCopy, WebChannelListSemantics, WebPlatformModule, WebPlatformRegistry } from './contract'
import { discordModule } from './discord'
import { feishuModule } from './feishu'
import { linearModule } from './linear'
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
const MODULES: readonly WebPlatformModule[] = [slackModule, telegramModule, discordModule, feishuModule, linearModule]

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

/**
 * The Settings → Bots row copy every platform gets unless its module says
 * otherwise — provider-free by construction, because the strings these replace
 * described Slack's model on every platform's rows.
 *
 * `shareHint`'s two arms are the SAME sentence here on purpose. The host picks an
 * arm by transport, but a platform that declares nothing supports no multi-agent
 * bot at any transport, so the arm it lands on is not the reason sharing is
 * unavailable and a second sentence would promise a fix that does not exist.
 */
export const DEFAULT_BOT_CARD_COPY: Required<WebBotCardCopy> = {
  revokedHint: 'This bot’s credentials were revoked — re-install to reconnect',
  shareHint: {
    available: 'Sharing one bot across several agents isn’t available on this platform',
    unavailable: 'Sharing one bot across several agents isn’t available on this platform'
  },
  identityNoun: 'bot'
}

/**
 * One platform's Settings → Bots row copy, defaulted member by member: a module
 * may name the revocation it can actually reach without also having to restate
 * the share sentence, and vice versa. `IntegrationChannelList`'s lookup is total
 * for the same reason this one is — a bot row carries whatever platform the CP
 * sent.
 */
export function botCardCopy(platformId?: string): Required<WebBotCardCopy> {
  const copy = platformId ? platformRegistry.get(platformId)?.settingsFragments?.copy : undefined
  return {
    revokedHint: copy?.revokedHint ?? DEFAULT_BOT_CARD_COPY.revokedHint,
    shareHint: copy?.shareHint ?? DEFAULT_BOT_CARD_COPY.shareHint,
    identityNoun: copy?.identityNoun ?? DEFAULT_BOT_CARD_COPY.identityNoun
  }
}

/**
 * Whether this platform supports multi-agent bots at all — the §5
 * `multiAgentShareable` fact, read from the ONE place a module declares it
 * (`WebWizardAffordances.share`). Total, like every lookup here: a bot row
 * carries whatever platform the CP sent, and `webhook`/`github` are not modules.
 *
 * Read by BOTH surfaces that offer sharing — the install wizard's opt-in and the
 * Settings → Bots toggle — rather than mirrored onto a second member of
 * `WebBotSettingsFragments`. Two declarations of one platform fact can
 * disagree, and there is no state in which they legitimately would: the CP
 * refuses a multi-agent install and a `shareable: true` PATCH on exactly the
 * platforms that do not declare it here.
 */
export function platformSupportsSharing(platformId?: string): boolean {
  return (platformId ? platformRegistry.get(platformId)?.wizard.affordances.share : undefined) === true
}

/**
 * Whether the Settings → Bots Sharable toggle may be OPERATED for this bot —
 * the platform half of its `disabled` predicate (the viewer's write access and
 * the in-flight PATCH stay the card's own).
 *
 * Both server preconditions, in the order the CP checks them
 * (`http/routes/bots.ts`): the platform must support multi-agent bots, and the
 * bot must be on the http transport (immutable post-create — a socket bot can
 * never be shared). Gating on transport ALONE is what let a Feishu HTTP bot
 * present a live toggle for a capability the CP refuses.
 *
 * The `shareable` escape hatch is deliberate rather than defensive: while the
 * toggle was transport-gated only, the PATCH accepted the flip, so rows on a
 * non-sharing platform may already carry `shareable: true`. The CP still honors
 * turning those OFF, so the console must keep the control that does it.
 */
export function botSharingEditable(bot: Pick<BotDto, 'platform' | 'transport' | 'shareable'>): boolean {
  if (bot.shareable) return true
  return platformSupportsSharing(bot.platform) && (bot.transport ?? 'socket') === 'http'
}

/**
 * This platform's transcript text renderer OVERRIDE, or `undefined` for the
 * core default — which is every platform today (§10: the registry "ships with
 * the Slack renderer as the default for all chat platforms, then per-platform
 * overrides land separately").
 *
 * The default itself deliberately stays in `MessageText`, so this lookup does
 * NOT return it: resolving it here would pull the markdown pipeline
 * (react-markdown + remark-gfm + remark-breaks + node-emoji) into this module,
 * and `ModalProvider` — mounted by the console shell on EVERY route — imports
 * this registry through `AddIntegrationModal`. Only the session transcript
 * renders message text; only it should carry the parser. Same reasoning that
 * keeps `platforms/marks.ts` and `lib/platform-labels.ts` out of here.
 */
export function platformTextRenderer(platformId?: string): ComponentType<{ text: string }> | undefined {
  return platformId ? platformRegistry.get(platformId)?.textRenderer : undefined
}

/**
 * This row's provider-native duplicate identity under `platformId`'s rule, or
 * `null` when it must never dedupe across sources — including every platform
 * id no module claims. See {@link WebPlatformModule.messageIdentity}: the
 * caller (`lib/conversation-merge.ts`) keeps the rules that are core rather
 * than any platform's, and this resolves only the provider id SHAPE.
 */
export function platformMessageIdentity(platformId: string, row: SessionMessageDto): string | null {
  return platformRegistry.get(platformId)?.messageIdentity?.(row) ?? null
}

/** This platform's transcript page ordering, defaulted to the conservative
 *  daemon sequence. See {@link WebPlatformModule.transcriptOrdering}. */
export function platformTranscriptOrdering(platformId: string): 'seq' | 'event-time' {
  return platformRegistry.get(platformId)?.transcriptOrdering ?? 'seq'
}
