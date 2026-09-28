// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import type { WebChannelListSemantics, WebPlatformModule } from '../contract'
import { identityCards, inviteBotHint } from '../wizard-chrome'
import { googleChatApi, type GoogleChatApi } from './api'
import { GoogleChatWizardBody } from './Body'
import { GoogleChatMark } from './mark'
import { GoogleChatText } from './renderer'
import { googleChatSettingsFragments } from './settings'

/** A Space row's semantics: Google delivers only messages that mention the app, so no trigger may promise every message (§4). */
export const GOOGLE_CHAT_CHANNEL_LIST: WebChannelListSemantics = {
  roomNoun: 'space',
  roomGlyph: '',
  // The app leaves a space when someone removes it in Google Chat.
  leave: 'none',
  triggers: ['off', 'mention', 'decision'],
  // Google delivers a Space message, thread replies included, only when it mentions the app; the host's hint promises more.
  mentionHint: { key: 'googlechatMentionHint' }
}

export const googleChatModule: WebPlatformModule<GoogleChatApi> = {
  platformId: 'googlechat',
  requires: 'google-chat',
  Mark: GoogleChatMark,
  wizard: {
    Body: GoogleChatWizardBody,
    // One app serves one agent in this version (§3), so a freed app is reusable and nothing else is.
    freeBotFilter: () => true,
    buildReuseInput: (bot, ctx) => ({ platform: 'googlechat', agentId: ctx.agentId, botId: bot.id, transport: 'http' }),
    // No transport choice (HTTPS through the relay is the only one) and no shared bots (§1).
    affordances: {},
    identityCards: () => identityCards('googlechat'),
    inviteHint: () => inviteBotHint('space', 'Google Chat', true)
  },
  settingsFragments: googleChatSettingsFragments,
  apiBindings: googleChatApi,
  channelList: GOOGLE_CHAT_CHANNEL_LIST,
  textRenderer: GoogleChatText
}
