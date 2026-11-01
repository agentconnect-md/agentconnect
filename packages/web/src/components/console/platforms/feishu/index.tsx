// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import LarkFeishuSwitcher from '@/components/LarkFeishuSwitcher'
import type { WebPlatformModule } from '../contract'
import { identityCards as identityCardsFor, inviteBotHint } from '../wizard-chrome'
import { feishuApi, type FeishuApi } from './api'
import { FeishuWizardBody, FEISHU_TRANSPORT_LABEL } from './Body'
import { FeishuMark } from './mark'
import { feishuAppLinkOrigin, feishuBrand, feishuRegionOf, type FeishuRegion } from './region'
import { feishuSettingsFragments } from './settings'

/** Lark / Feishu's provider-native message id: an `om_`-prefixed opaque id,
 *  which no numeric daemon-local stamp can collide with. */
const FEISHU_MESSAGE_ID = /^om_[A-Za-z0-9_-]+$/

export const feishuModule: WebPlatformModule<FeishuApi> = {
  platformId: 'feishu',
  docsPath: 'connect-automate/chat-platforms/lark-feishu',
  Mark: FeishuMark,
  wizard: {
    Body: FeishuWizardBody,
    // A bot belongs to ONE developer-console cloud; offering a Feishu bot while
    // the wizard is on Lark would mint an integration against the wrong gateway.
    freeBotFilter: (bot, ctx) => feishuRegionOf(bot) === (ctx.region ?? 'lark'),
    buildReuseInput: (bot, ctx) => ({
      platform: 'feishu',
      agentId: ctx.agentId,
      botId: bot.id,
      // Reuse keeps the bot's own transport (immutable post-create).
      transport: bot.transport ?? 'socket'
    }),
    affordances: {
      // Long Connection stays the default; a public callback address makes HTTP
      // available as an explicit choice, never as the default.
      transport: { labels: FEISHU_TRANSPORT_LABEL, httpByDefaultWhenRelayAvailable: false }
    },
    identityCards: (region) => (feishuBrand(region) === 'Lark' ? identityCardsFor('lark') : identityCardsFor('feishu')),
    // New installs start on international Lark; the tile's Lark / Feishu word switches the cloud.
    regions: {
      initial: () => 'lark',
      Switcher: ({ value, onSwitch, disabled }) => (
        <LarkFeishuSwitcher
          value={feishuRegionOf({ feishuRegion: value as FeishuRegion })}
          onSwitch={onSwitch}
          disabled={disabled}
        />
      )
    },
    inviteHint: (region) =>
      inviteBotHint(
        'group',
        feishuBrand(region) === 'Feishu' ? 'Platforms.feishu.brand.feishu' : 'Platforms.feishu.brand.lark',
        true
      )
  },
  settingsFragments: feishuSettingsFragments,
  apiBindings: feishuApi,
  channelList: {
    roomNoun: 'group',
    // Lark groups have no `#name` convention, so the row shows the bare title.
    roomGlyph: '',
    // No console-driven leave: the bot is removed from a group in Lark itself.
    leave: 'none',
    // AppLink opens a group by its chat id on the bot's own cloud; a DM opens by user, which the row lacks.
    conversationUrl: ({ channelId, kind, feishuRegion }) =>
      kind === 'im'
        ? undefined
        : `${feishuAppLinkOrigin(feishuRegionOf({ feishuRegion }))}/client/chat/open?openChatId=${encodeURIComponent(channelId)}`
  },
  messageIdentity: (row) => (FEISHU_MESSAGE_ID.test(row.ts) ? `ts:${row.ts}` : null)
}
