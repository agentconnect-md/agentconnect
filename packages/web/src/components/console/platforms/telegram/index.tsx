// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import { PlatformMark } from '@/components/marks'
import { checkTelegramBot } from '@/lib/api'
import type { WebPlatformModule } from '../contract'
import { inviteBotHint } from '../wizard-chrome'
import { TelegramWizardBody } from './Body'

/** The Telegram module's own CP client surface — see {@link WebPlatformModule.apiBindings}. */
const telegramApi = { checkBot: checkTelegramBot }

export const telegramModule: WebPlatformModule<typeof telegramApi> = {
  platformId: 'telegram',
  Mark: ({ fillPct }) => <PlatformMark platform="telegram" {...(fillPct === undefined ? {} : { fillPct })} />,
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
  apiBindings: telegramApi
}
