// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import type { WebChannelListSemantics, WebPlatformModule } from '../contract'
import { identityCards, inviteBotHint } from '../wizard-chrome'
import { WeComWizardBody } from './Body'
import { WeComMark } from './mark'
import { weComSettingsFragments } from './settings'

/** A group row's semantics: WeCom delivers a group message only when it mentions the bot, so no trigger may promise more. */
export const WECOM_CHANNEL_LIST: WebChannelListSemantics = {
  roomNoun: 'group',
  roomGlyph: '',
  // A smart bot has no API to leave a group; a member removes it in WeCom.
  leave: 'none',
  triggers: ['off', 'mention'],
  // The host's hint promises replies in joined threads, and WeCom has no threads.
  mentionHint: { key: 'wecomMentionHint' }
}

export const weComModule: WebPlatformModule = {
  platformId: 'wecom',
  docsPath: 'connect-automate/chat-platforms/wecom',
  requires: 'wecom',
  Mark: WeComMark,
  wizard: {
    Body: WeComWizardBody,
    // One bot serves one agent, so any freed WeCom bot is reusable.
    freeBotFilter: () => true,
    // The long connection is the only transport, and the create DTO carries none.
    buildReuseInput: (bot, ctx) => ({ platform: 'wecom', agentId: ctx.agentId, botId: bot.id }),
    affordances: {},
    identityCards: () => identityCards('wecom'),
    inviteHint: () => inviteBotHint('group', 'Platforms.wecom.brand', true)
  },
  apiBindings: {},
  settingsFragments: weComSettingsFragments,
  channelList: WECOM_CHANNEL_LIST
}
