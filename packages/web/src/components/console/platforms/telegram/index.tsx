// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import type { WebPlatformModule } from '../contract'
import { inviteBotHint } from '../wizard-chrome'
import { telegramApi, type TelegramApi } from './api'
import { TelegramWizardBody } from './Body'
import { TelegramMark } from './mark'

export const telegramModule: WebPlatformModule<TelegramApi> = {
  platformId: 'telegram',
  Mark: TelegramMark,
  wizard: {
    Body: TelegramWizardBody,
    // Nothing beyond the chassis's generic live-and-uninstalled predicate: a
    // Telegram bot has no workspace-scoped install to disqualify it.
    freeBotFilter: () => true,
    // No transport concept — the create DTO carries none either.
    buildReuseInput: (bot, ctx) => ({ platform: 'telegram', agentId: ctx.agentId, botId: bot.id }),
    affordances: {},
    identityCards: () => ({ create: 'Create a bot with @BotFather', existing: 'An unused Telegram bot' }),
    inviteHint: () => inviteBotHint('group', 'Telegram')
  },
  apiBindings: telegramApi,
  // A Telegram bot's rows carry no extra chrome: there is no per-bot developer
  // portal to deep-link (BotFather is a chat, not a URL) and nothing to refresh.
  channelList: {
    roomNoun: 'group',
    // Telegram groups have no `#name` convention, so the row shows the bare title.
    roomGlyph: '',
    // `leaveChat` needs no extra permission, so a row can be left from the console.
    leave: 'conversation'
  }
}
