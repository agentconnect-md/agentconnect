// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import type { WebChannelListSemantics, WebPlatformModule } from '../contract'
import { identityCards, inviteBotHint } from '../wizard-chrome'
import { msTeamsApi, type MsTeamsApi } from './api'
import { MsTeamsWizardBody } from './Body'
import { MsTeamsMark } from './mark'
import { msTeamsAgentPending } from './pending'
import { msTeamsSettingsFragments } from './settings'

const DEEP_LINK = 'https://teams.microsoft.com/l'
const TEAM_CHANNEL = /^19:[^/\s]+@thread\.tacv2$/
const GROUP_CHAT = /^19:[^/\s]+@thread\.v2$/
// The tenant only picks the account to open under; a link without one opens in the signed-in tenant.
const tenantQuery = (tenantId?: string | null): string => (tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : '')

/** A channel or group chat row: resource-specific consent delivers every message there, so every trigger applies (§4.1). */
export const MSTEAMS_CHANNEL_LIST: WebChannelListSemantics = {
  roomNoun: 'channel',
  roomGlyph: '',
  // The bot leaves a team or chat when someone removes the app in Teams.
  leave: 'none',
  // The id's own shape says which page opens it: a team channel, or a group chat; a bot's 1:1 id opens none.
  conversationUrl: ({ channelId, workspaceId }) => {
    const id = encodeURIComponent(channelId)
    if (TEAM_CHANNEL.test(channelId)) return `${DEEP_LINK}/channel/${id}/channel${tenantQuery(workspaceId)}`
    return GROUP_CHAT.test(channelId) ? `${DEEP_LINK}/chat/${id}/conversations${tenantQuery(workspaceId)}` : undefined
  },
  // A channel thread opens at its root post, named by the root's millisecond id.
  threadUrl: ({ channelId, workspaceId, rootId }) => {
    if (!TEAM_CHANNEL.test(channelId) || !/^\d+$/.test(rootId)) return undefined
    const query = new URLSearchParams({
      ...(workspaceId ? { tenantId: workspaceId } : {}),
      parentMessageId: rootId,
      createdTime: rootId
    })
    return `${DEEP_LINK}/message/${encodeURIComponent(channelId)}/${rootId}?${query.toString()}`
  }
}

export const msTeamsModule: WebPlatformModule<MsTeamsApi> = {
  agentPending: msTeamsAgentPending,
  platformId: 'msteams',
  docsPath: 'connect-automate/chat-platforms/msteams',
  Mark: MsTeamsMark,
  wizard: {
    Body: MsTeamsWizardBody,
    // One bot serves one agent (§1), so a freed bot is reusable and nothing else is.
    freeBotFilter: () => true,
    buildReuseInput: (bot, ctx) => ({ platform: 'msteams', agentId: ctx.agentId, botId: bot.id, transport: 'http' }),
    // No transport choice (HTTPS through the relay is the only one) and no shared bots (§1).
    affordances: {},
    identityCards: () => identityCards('msteams'),
    inviteHint: () => inviteBotHint('channel', 'Platforms.msteams.brand')
  },
  settingsFragments: msTeamsSettingsFragments,
  apiBindings: msTeamsApi,
  channelList: MSTEAMS_CHANNEL_LIST
}
