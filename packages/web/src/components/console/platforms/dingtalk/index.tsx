// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import type { WebChannelListSemantics, WebPlatformModule } from '../contract'
import { identityCards, inviteBotHint } from '../wizard-chrome'
import { DingTalkWizardBody } from './Body'
import { DingTalkMark } from './mark'
import { dingTalkSettingsFragments } from './settings'

/** A group row's semantics: DingTalk delivers only messages that mention the bot, so no trigger may promise more (§4.1). */
export const DINGTALK_CHANNEL_LIST: WebChannelListSemantics = {
  roomNoun: 'group',
  roomGlyph: '',
  // A robot has no API to leave a group; a member removes it in DingTalk.
  leave: 'none',
  triggers: ['off', 'mention'],
  // The host's hint promises replies in joined threads, and DingTalk has no threads.
  mentionHint: { key: 'dingtalkMentionHint' }
}

export const dingTalkModule: WebPlatformModule = {
  platformId: 'dingtalk',
  Mark: DingTalkMark,
  wizard: {
    Body: DingTalkWizardBody,
    // One app serves one agent (§1), so a freed app is reusable and nothing else is.
    freeBotFilter: () => true,
    // Stream is the only transport, and the create DTO carries none.
    buildReuseInput: (bot, ctx) => ({ platform: 'dingtalk', agentId: ctx.agentId, botId: bot.id }),
    affordances: {},
    identityCards: () => identityCards('dingtalk'),
    inviteHint: () => inviteBotHint('group', 'Platforms.dingtalk.brand', true)
  },
  apiBindings: {},
  settingsFragments: dingTalkSettingsFragments,
  channelList: DINGTALK_CHANNEL_LIST
}
