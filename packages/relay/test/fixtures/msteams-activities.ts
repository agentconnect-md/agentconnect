// Synthetic Bot Connector activities in the measured Teams shape (teams-integration.md §4.1, §4.4); every ID is a placeholder.
export const APP_ID = '00000000-0000-4000-8000-0000000000a1'
export const OTHER_APP_ID = '00000000-0000-4000-8000-0000000000a2'
export const BOT_ID = `28:${APP_ID}`
export const TENANT = '00000000-0000-4000-8000-000000000002'
export const OTHER_TENANT = '00000000-0000-4000-8000-000000000009'
export const AAD_USER = '00000000-0000-4000-8000-000000000003'
export const USER = '29:1example-user-0001'
export const SERVICE_URL = `https://smba.trafficmanager.net/amer/${TENANT}/`
export const PERSONAL = 'a:1example-personal-conversation'
export const GROUP_CHAT = '19:example-group-chat@thread.v2'
export const CHANNEL = '19:example-channel@thread.tacv2'
export const TEAM = '19:example-team@thread.tacv2'
export const ROOT = '1767225600000'
export const CARD_ACTIVITY = '1767225650000'

const common = {
  type: 'message',
  timestamp: '2026-01-01T00:00:10.1234567Z',
  serviceUrl: SERVICE_URL,
  channelId: 'msteams',
  from: { id: USER, name: 'Example User', aadObjectId: AAD_USER },
  recipient: { id: BOT_ID, name: 'Example Bot' },
  textFormat: 'plain',
  locale: 'en-US',
  entities: [{ type: 'clientInfo' }]
}

export const personalText = {
  ...common,
  id: '1767225610123',
  conversation: { id: PERSONAL, conversationType: 'personal', tenantId: TENANT },
  text: 'hello there',
  attachments: [{ contentType: 'text/html', content: '<p>hello there</p>' }],
  channelData: { tenant: { id: TENANT } }
}

export const channelMention = {
  ...common,
  id: ROOT,
  conversation: { id: `${CHANNEL};messageid=${ROOT}`, conversationType: 'channel', tenantId: TENANT, isGroup: true },
  text: '<at>Example Bot</at> please summarize the release notes',
  replyToId: null,
  entities: [
    { type: 'mention', mentioned: { id: BOT_ID, name: 'Example Bot' }, text: '<at>Example Bot</at>' },
    { type: 'clientInfo' }
  ],
  channelData: { tenant: { id: TENANT }, team: { id: TEAM }, channel: { id: CHANNEL }, teamsChannelId: CHANNEL }
}

// An unmentioned reply the bot receives through resource-specific consent.
export const channelReply = {
  ...channelMention,
  id: '1767225620000',
  text: 'and the breaking changes?',
  entities: [{ type: 'clientInfo' }]
}

export const groupText = {
  ...common,
  id: '1767225630000',
  conversation: { id: GROUP_CHAT, conversationType: 'groupChat', tenantId: TENANT, isGroup: true },
  text: 'what changed today?',
  channelData: { tenant: { id: TENANT } }
}

/** An `Action.Execute` click on a card the bot posted as {@link CARD_ACTIVITY}. */
export const cardClick = {
  type: 'invoke',
  name: 'adaptiveCard/action',
  id: 'f:example-invoke-0001',
  timestamp: '2026-01-01T00:01:00.000Z',
  serviceUrl: SERVICE_URL,
  channelId: 'msteams',
  from: { id: USER, name: 'Example User', aadObjectId: AAD_USER },
  recipient: { id: BOT_ID, name: 'Example Bot' },
  conversation: { id: PERSONAL, conversationType: 'personal', tenantId: TENANT },
  replyToId: CARD_ACTIVITY,
  value: {
    action: {
      type: 'Action.Execute',
      verb: 'agentconnect.elicit',
      data: { requestId: 'req-1', option: 0, token: 't' }
    },
    trigger: 'manual'
  },
  channelData: { tenant: { id: TENANT }, source: { name: 'message' } },
  locale: 'en-US'
}

export const conversationUpdate = {
  ...common,
  type: 'conversationUpdate',
  id: 'f:example-update',
  conversation: { id: `${CHANNEL};messageid=${ROOT}`, conversationType: 'channel', tenantId: TENANT },
  channelData: { tenant: { id: TENANT }, team: { id: TEAM }, eventType: 'teamMemberAdded' }
}

/** A deep copy of a fixture with one change, so each case states only what it changes. */
export function edit<T>(activity: T, mutate: (a: any) => void): T {
  const copy = JSON.parse(JSON.stringify(activity)) as T
  mutate(copy)
  return copy
}
