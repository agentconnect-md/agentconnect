// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import type { WebPlatformModule } from '../contract'
import { inviteBotHint } from '../wizard-chrome'
import { DiscordWizardBody } from './Body'
import { DiscordMark } from './mark'
import { discordSettingsFragments } from './settings'

/** Discord's install needs no CP call of its own — the invite URL is derived
 *  from the pasted token in the browser (`./invite.ts`). */
const discordApi = {}

/** Discord's provider-native message id: a snowflake, 16–20 digits (creation
 *  ms in the top 42 bits). Long enough that a 13-digit daemon-local
 *  millisecond stamp can never match it. */
const DISCORD_SNOWFLAKE = /^\d{16,20}$/

export const discordModule: WebPlatformModule<typeof discordApi> = {
  platformId: 'discord',
  Mark: DiscordMark,
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
  settingsFragments: discordSettingsFragments,
  apiBindings: discordApi,
  channelList: {
    roomNoun: 'channel',
    roomGlyph: '#',
    // A Discord bot joins a SERVER, not a channel, so the only leave the console
    // can offer is the whole server — the band heading's action, not the row's.
    leave: 'space',
    cannotLeaveRowHint:
      'A Discord bot belongs to a server, not one channel — use Leave on the server heading above to take it out. If it is still in there, the row will come back.',
    footerNote: 'A Discord bot joins servers, not channels, so it can only leave a whole server.'
  },
  messageIdentity: (row) => (DISCORD_SNOWFLAKE.test(row.ts) ? `ts:${row.ts}` : null)
}
