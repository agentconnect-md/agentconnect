// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import type { WebPlatformModule } from '../contract'
import { inviteBotHint } from '../wizard-chrome'
import { feishuApi, type FeishuApi } from './api'
import { FeishuWizardBody, FEISHU_TRANSPORT_LABEL } from './Body'
import { FeishuMark } from './mark'
import { feishuBrand, feishuRegionOf } from './region'
import { feishuSettingsFragments } from './settings'

/** Lark / Feishu's provider-native message id: an `om_`-prefixed opaque id,
 *  which no numeric daemon-local stamp can collide with. */
const FEISHU_MESSAGE_ID = /^om_[A-Za-z0-9_-]+$/

export const feishuModule: WebPlatformModule<FeishuApi> = {
  platformId: 'feishu',
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
    identityCards: (region) => ({
      create: `Create with one-click ${feishuBrand(region)} setup`,
      existing: `An unused ${feishuBrand(region)} bot`
    }),
    inviteHint: (region) => inviteBotHint('group', feishuBrand(region), '@-mention it to start')
  },
  settingsFragments: feishuSettingsFragments,
  apiBindings: feishuApi,
  channelList: {
    roomNoun: 'group',
    // Lark groups have no `#name` convention, so the row shows the bare title.
    roomGlyph: '',
    // No console-driven leave: the bot is removed from a group in Lark itself.
    leave: 'none'
  },
  messageIdentity: (row) => (FEISHU_MESSAGE_ID.test(row.ts) ? `ts:${row.ts}` : null)
}
