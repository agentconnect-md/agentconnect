// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import type { WebPlatformModule } from '../contract'
import { directBotHint, identityCards } from '../wizard-chrome'
import { weChatApi, type WeChatApi } from './api'
import { WeChatWizardBody } from './Body'
import { WeChatMark } from './mark'
import { weChatIdTail, weChatSettingsFragments } from './settings'

export const weChatModule: WebPlatformModule<WeChatApi> = {
  platformId: 'wechat',
  docsPath: 'connect-automate/chat-platforms/wechat',
  requires: 'wechat',
  Mark: WeChatMark,
  senderFallback: (sender) => (sender.endsWith('@im.wechat') ? `WeChat user · ${weChatIdTail(sender)}` : undefined),
  wizard: {
    Body: WeChatWizardBody,
    // A bot is one member's chat with one agent, so no bot is ever offered for reuse.
    freeBotFilter: () => false,
    buildReuseInput: (bot, ctx) => ({ platform: 'wechat', agentId: ctx.agentId, botId: bot.id }),
    affordances: {},
    identityCards: () => identityCards('wechat'),
    inviteHint: () => directBotHint('group', 'Platforms.wechat.brand')
  },
  apiBindings: weChatApi,
  settingsFragments: weChatSettingsFragments,
  // One-to-one only: no rooms, and the member's one chat is already one continuous session.
  channelList: { roomNoun: 'conversation', roomGlyph: '', leave: 'none', sessionModes: ['createNew'] }
}
