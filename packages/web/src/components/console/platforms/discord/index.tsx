// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import { PlatformMark } from '@/components/marks'
import type { WebPlatformModule } from '../contract'
import { inviteBotHint } from '../wizard-chrome'
import { DiscordWizardBody } from './Body'

/** Discord's install needs no CP call of its own — the invite URL is derived
 *  from the pasted token in the browser (`lib/discord-invite.ts`). */
const discordApi = {}

export const discordModule: WebPlatformModule<typeof discordApi> = {
  platformId: 'discord',
  Mark: ({ fillPct }) => <PlatformMark platform="discord" {...(fillPct === undefined ? {} : { fillPct })} />,
  wizard: {
    Body: DiscordWizardBody,
    // Nothing beyond the chassis's generic live-and-uninstalled predicate.
    freeBotFilter: () => true,
    // No transport concept — the create DTO carries none either.
    buildReuseInput: (bot, ctx) => ({ platform: 'discord', agentId: ctx.agentId, botId: bot.id }),
    affordances: {},
    identityCards: () => ({ create: 'Create a bot in Discord', existing: 'An unused Discord bot' }),
    inviteHint: () => inviteBotHint('channel', 'Discord')
  },
  apiBindings: discordApi
}
