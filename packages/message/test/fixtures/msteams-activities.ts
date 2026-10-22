// Synthetic Bot Connector activities in the measured Teams shape (teams-integration.md §4.1); every ID is a placeholder.
import type { MsTeamsActivity } from '../../src/msteams-message.js'

export const APP_ID = '00000000-0000-4000-8000-0000000000a1'
export const BOT_ID = `28:${APP_ID}`
export const OTHER_BOT_ID = '28:00000000-0000-4000-8000-0000000000a2'
export const TENANT = '00000000-0000-4000-8000-000000000002'
export const AAD_USER = '00000000-0000-4000-8000-000000000003'
export const USER = '29:1example-user-0001'
export const SERVICE_URL = `https://smba.trafficmanager.net/amer/${TENANT}/`
export const PERSONAL = 'a:1example-personal-conversation'
export const GROUP_CHAT = '19:example-group-chat@thread.v2'
export const CHANNEL = '19:example-channel@thread.tacv2'
export const TEAM = '19:example-team@thread.tacv2'
export const ROOT = '1767225600000'

const common = {
  type: 'message',
  timestamp: '2026-01-01T00:00:10.1234567Z',
  localTimestamp: '2026-01-01T00:00:10.1234567+00:00',
  serviceUrl: SERVICE_URL,
  channelId: 'msteams',
  from: { id: USER, name: 'Example User', aadObjectId: AAD_USER },
  recipient: { id: BOT_ID, name: 'Example Bot' },
  textFormat: 'plain',
  locale: 'en-US',
  entities: [{ type: 'clientInfo' }]
} satisfies MsTeamsActivity

export const personalText: MsTeamsActivity = {
  ...common,
  id: '1767225610123',
  conversation: { id: PERSONAL, conversationType: 'personal', tenantId: TENANT },
  text: 'hello there',
  attachments: [{ contentType: 'text/html', content: '<p>hello there</p>' }],
  channelData: { tenant: { id: TENANT } }
}

export const channelPost: MsTeamsActivity = {
  ...common,
  id: ROOT,
  conversation: { id: `${CHANNEL};messageid=${ROOT}`, conversationType: 'channel', tenantId: TENANT, isGroup: true },
  text: '<at>Example Bot</at> please summarize the release notes',
  replyToId: null,
  entities: [
    { type: 'mention', mentioned: { id: BOT_ID, name: 'Example Bot' }, text: '<at>Example Bot</at>' },
    { type: 'clientInfo' }
  ],
  channelData: {
    tenant: { id: TENANT },
    team: { id: TEAM },
    channel: { id: CHANNEL },
    teamsChannelId: CHANNEL,
    teamsTeamId: TEAM
  }
}

export const channelReply: MsTeamsActivity = {
  ...channelPost,
  id: '1767225620000',
  text: 'and the breaking changes?',
  entities: [{ type: 'clientInfo' }]
}

export const groupMention: MsTeamsActivity = {
  ...common,
  id: '1767225630000',
  conversation: { id: GROUP_CHAT, conversationType: 'groupChat', tenantId: TENANT, isGroup: true },
  text: 'ask <at>Another Person</at> and <at>Example Bot</at> what changed',
  entities: [
    {
      type: 'mention',
      mentioned: { id: '29:1example-user-0002', name: 'Another Person' },
      text: '<at>Another Person</at>'
    },
    { type: 'mention', mentioned: { id: BOT_ID, name: 'Example Bot' }, text: '<at>Example Bot</at>' },
    { type: 'clientInfo' }
  ],
  channelData: { tenant: { id: TENANT } }
}

export const groupQuote: MsTeamsActivity = {
  ...common,
  id: '1767225640000',
  conversation: { id: GROUP_CHAT, conversationType: 'groupChat', tenantId: TENANT, isGroup: true },
  text: '<quoted messageId="1767225635000"/>\nwhat about the tests?',
  attachments: [
    {
      contentType: 'text/html',
      content: '<blockquote itemscope="">Here is the summary.</blockquote><p>what about the tests?</p>'
    }
  ],
  entities: [
    {
      type: 'quotedReply',
      quotedReply: {
        messageId: '1767225635000',
        senderId: BOT_ID,
        senderName: 'Example Bot',
        preview: 'Here is the summary.',
        time: '1767225635000',
        validatedMessageReference: true
      }
    },
    { type: 'clientInfo' }
  ],
  channelData: { tenant: { id: TENANT } }
}

export const conversationUpdate: MsTeamsActivity = {
  ...common,
  type: 'conversationUpdate',
  id: 'f:example-update',
  conversation: { id: `${CHANNEL};messageid=${ROOT}`, conversationType: 'channel', tenantId: TENANT },
  channelData: { tenant: { id: TENANT }, team: { id: TEAM }, eventType: 'teamMemberAdded' }
}
