// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import type { WebChannelListSemantics, WebPlatformModule } from '../contract'
import { identityCards, inviteBotHint } from '../wizard-chrome'
import { msTeamsApi, type MsTeamsApi } from './api'
import { MsTeamsWizardBody } from './Body'
import { MsTeamsMark } from './mark'
import { msTeamsSettingsFragments } from './settings'

/** A channel or group chat row: resource-specific consent delivers every message there, so every trigger applies (§4.1). */
export const MSTEAMS_CHANNEL_LIST: WebChannelListSemantics = {
  roomNoun: 'channel',
  roomGlyph: '',
  // The bot leaves a team or chat when someone removes the app in Teams.
  leave: 'none'
}

export const msTeamsModule: WebPlatformModule<MsTeamsApi> = {
  platformId: 'msteams',
  Mark: MsTeamsMark,
  wizard: {
    Body: MsTeamsWizardBody,
    // One bot serves one agent (§1), so a freed bot is reusable and nothing else is.
    freeBotFilter: () => true,
    buildReuseInput: (bot, ctx) => ({ platform: 'msteams', agentId: ctx.agentId, botId: bot.id, transport: 'http' }),
    // No transport choice (HTTPS through the relay is the only one) and no shared bots (§1).
    affordances: {},
    identityCards: () => identityCards('msteams'),
    inviteHint: () => inviteBotHint('channel', 'Microsoft Teams')
  },
  settingsFragments: msTeamsSettingsFragments,
  apiBindings: msTeamsApi,
  channelList: MSTEAMS_CHANNEL_LIST
}
