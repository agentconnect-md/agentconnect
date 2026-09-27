// Anonymized captures of one Chat app's interaction events (google-chat-integration.md §9); ids are reserved examples.
import type { GoogleChatEvent } from '@agentconnect.md/message'

/** The Cloud project number: the `aud` of every token Google sent the probe app. */
export const AUDIENCE = '100000000000'
export const APP = 'users/100000000000000000009'
export const OTHER_APP = 'users/100000000000000000008'
export const PERSON = 'users/100000000000000000001'
export const DM = 'spaces/EXAMPLE_DM'
export const SPACE = 'spaces/EXAMPLE_SPACE'

const person = {
  name: PERSON,
  displayName: 'Example Person',
  avatarUrl: 'https://example.test/avatar.png',
  email: 'person@example.test',
  type: 'HUMAN',
  domainId: 'example'
}

const dmSpace = {
  name: DM,
  type: 'DM',
  singleUserBotDm: true,
  spaceThreadingState: 'THREADED_MESSAGES',
  spaceType: 'DIRECT_MESSAGE',
  spaceHistoryState: 'HISTORY_ON',
  membershipCount: { joinedDirectHumanUserCount: 1 },
  spaceUri: 'https://chat.example.test/space'
}

const namedSpace = {
  name: SPACE,
  type: 'ROOM',
  displayName: 'Example Space',
  spaceThreadingState: 'THREADED_MESSAGES',
  spaceType: 'SPACE',
  spaceHistoryState: 'HISTORY_ON',
  membershipCount: { joinedDirectHumanUserCount: 1 },
  spaceUri: 'https://chat.example.test/space'
}

const appMention = (type: 'ADD' | 'MENTION') => ({
  type: 'USER_MENTION',
  startIndex: 0,
  length: 19,
  userMention: {
    user: { name: APP, displayName: 'AgentConnect Probe', avatarUrl: 'https://example.test/avatar.png', type: 'BOT' },
    type
  }
})

/** Adding the app to a DM: no message rides along. */
export const dmAdded = {
  type: 'ADDED_TO_SPACE',
  eventTime: '2026-09-27T04:23:10.989538Z',
  user: person,
  space: dmSpace,
  configCompleteRedirectUrl: 'https://chat.example.test/config-complete?token=REDACTED'
} as GoogleChatEvent

/** A plain DM message; DMs carry `thread.name` too. */
export const dmMessage = {
  type: 'MESSAGE',
  eventTime: '2026-09-27T04:23:15.658111Z',
  message: {
    name: `${DM}/messages/EXAMPLE_THREAD_1.EXAMPLE_MSG_ROOT`,
    sender: person,
    createTime: '2026-09-27T04:23:15.658111Z',
    text: 'hi',
    thread: { name: `${DM}/threads/EXAMPLE_THREAD_1`, retentionSettings: { state: 'PERMANENT' } },
    space: dmSpace,
    argumentText: 'hi',
    retentionSettings: { state: 'PERMANENT' },
    messageHistoryState: 'HISTORY_ON',
    formattedText: 'hi',
    markupSyntax: 'MARKUP_SYNTAX_CHAT'
  },
  user: person,
  space: dmSpace,
  configCompleteRedirectUrl: 'https://chat.example.test/config-complete?token=REDACTED',
  common: { userLocale: 'en', hostApp: 'CHAT', timeZone: { id: 'Asia/Tokyo', offset: 32400000 } },
  thread: { name: `${DM}/threads/EXAMPLE_THREAD_1` }
} as GoogleChatEvent

/** Adding the app to a Space by @mention: one ADDED_TO_SPACE carrying the triggering message with an ADD annotation. */
export const spaceAddedByMention = {
  type: 'ADDED_TO_SPACE',
  eventTime: '2026-09-27T04:28:34.991528Z',
  message: {
    name: `${SPACE}/messages/EXAMPLE_THREAD_2.EXAMPLE_MSG_ROOT`,
    sender: person,
    createTime: '2026-09-27T04:28:34.773503Z',
    text: '@AgentConnect Probe hello',
    annotations: [appMention('ADD')],
    thread: { name: `${SPACE}/threads/EXAMPLE_THREAD_2`, retentionSettings: { state: 'PERMANENT' } },
    space: namedSpace,
    argumentText: ' hello',
    retentionSettings: { state: 'PERMANENT' },
    messageHistoryState: 'HISTORY_ON',
    formattedText: '@AgentConnect Probe hello',
    markupSyntax: 'MARKUP_SYNTAX_CHAT'
  },
  user: person,
  space: namedSpace,
  configCompleteRedirectUrl: 'https://chat.example.test/config-complete?token=REDACTED',
  thread: { name: `${SPACE}/threads/EXAMPLE_THREAD_2` }
} as GoogleChatEvent

/** A plain Space mention: `argumentText` strips every app mention and keeps the leading space. */
export const spaceMention = {
  type: 'MESSAGE',
  eventTime: '2026-09-27T04:31:02.532927Z',
  message: {
    name: `${SPACE}/messages/EXAMPLE_THREAD_3.EXAMPLE_MSG_ROOT`,
    sender: person,
    createTime: '2026-09-27T04:31:02.532927Z',
    text: '@AgentConnect Probe  第二条',
    annotations: [appMention('MENTION')],
    thread: { name: `${SPACE}/threads/EXAMPLE_THREAD_3`, retentionSettings: { state: 'PERMANENT' } },
    space: namedSpace,
    argumentText: '  第二条',
    retentionSettings: { state: 'PERMANENT' },
    messageHistoryState: 'HISTORY_ON',
    formattedText: '@AgentConnect Probe  第二条',
    markupSyntax: 'MARKUP_SYNTAX_CHAT'
  },
  user: person,
  space: namedSpace,
  configCompleteRedirectUrl: 'https://chat.example.test/config-complete?token=REDACTED',
  common: { userLocale: 'en', hostApp: 'CHAT', timeZone: { id: 'Asia/Tokyo', offset: 32400000 } },
  thread: { name: `${SPACE}/threads/EXAMPLE_THREAD_3` }
} as GoogleChatEvent

/** Removal is documented, not captured: the probe app was never removed from a Space. */
export const spaceRemoved = {
  type: 'REMOVED_FROM_SPACE',
  eventTime: '2026-09-27T05:00:00.000000Z',
  user: person,
  space: namedSpace
} as GoogleChatEvent
