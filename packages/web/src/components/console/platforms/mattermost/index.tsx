// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import { MarkdownText } from '../../markdown-text'
import type { WebChannelListSemantics, WebPlatformModule } from '../contract'
import { identityCards, inviteBotHint } from '../wizard-chrome'
import { isValidMattermostServerUrl, MattermostWizardBody, normalizeMattermostServerUrl } from './Body'
import { MattermostMark } from './mark'
import { mattermostSettingsFragments } from './settings'

/** Mattermost post ids are 26-character lowercase alphanumeric strings. */
const MATTERMOST_POST_ID = /^[a-z0-9]{26}$/

/** A channel row's semantics: Mattermost channels use `#` and can be left directly from the console. */
export const MATTERMOST_CHANNEL_LIST: WebChannelListSemantics = {
  roomNoun: 'channel',
  roomGlyph: '#',
  leave: 'conversation',
  // Group DMs (`G`, `mpim`) behave like small private rooms with a room's session modes.
  groupDmSessionModes: ['createNew', 'append', 'auto']
}

export const mattermostModule: WebPlatformModule = {
  platformId: 'mattermost',
  docsPath: 'connect-automate/chat-platforms/mattermost',
  requires: 'mattermost',
  Mark: MattermostMark,
  wizard: {
    Body: MattermostWizardBody,
    // One bot serves one agent (`multiAgentShareable: false`), so any freed Mattermost bot is reusable.
    freeBotFilter: () => true,
    // WebSocket is the only transport, and the create DTO carries none.
    buildReuseInput: (bot, ctx) => ({ platform: 'mattermost', agentId: ctx.agentId, botId: bot.id }),
    affordances: {},
    identityCards: () => identityCards('mattermost'),
    inviteHint: () => inviteBotHint('channel', 'Platforms.mattermost.brand', true)
  },
  apiBindings: {},
  settingsFragments: mattermostSettingsFragments,
  channelList: MATTERMOST_CHANNEL_LIST,
  // CRITICAL: MessageText defaults omitted textRenderer to SlackMrkdwnText; Mattermost uses standard Markdown.
  textRenderer: MarkdownText,
  threadShape: {
    isThreadId: (id) => MATTERMOST_POST_ID.test(id),
    threadUrl: ({ serverUrl, workspaceId, rootId }) => {
      const candidate = serverUrl || (workspaceId && /^https?:\/\//i.test(workspaceId) ? workspaceId : null)
      const base = candidate && isValidMattermostServerUrl(candidate) ? normalizeMattermostServerUrl(candidate) : null
      return base && MATTERMOST_POST_ID.test(rootId) ? `${base}/_redirect/pl/${encodeURIComponent(rootId)}` : undefined
    }
  },
  messageIdentity: (row) => (MATTERMOST_POST_ID.test(row.ts) ? `ts:${row.ts}` : null)
}
