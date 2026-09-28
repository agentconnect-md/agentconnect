import type { GoogleChatAddOnEvent, GoogleChatEvent } from '../../src/google-chat-message.js'

// Documentation-derived (Chat `Event`, `Message`, `Space` references); replace with anonymized live-probe fixtures.

export const APP = 'users/100000000000000000009'
export const OTHER_APP = 'users/100000000000000000008'
export const PERSON = 'users/100000000000000000001'
export const MENTIONED_PERSON = 'users/100000000000000000002'
export const SPACE = 'spaces/EXAMPLE_SPACE'
export const DM = 'spaces/EXAMPLE_DM'

const person = { name: PERSON, displayName: 'Example Person', type: 'HUMAN' }

export const dmMessage = {
  type: 'MESSAGE',
  eventTime: '2026-01-02T03:04:06.000000Z',
  space: { name: DM, spaceType: 'DIRECT_MESSAGE', singleUserBotDm: true },
  message: {
    name: `${DM}/messages/EXAMPLE_DM_MESSAGE`,
    sender: person,
    createTime: '2026-01-02T03:04:05.678901Z',
    text: 'Summarize the open incidents',
    argumentText: 'Summarize the open incidents',
    thread: { name: `${DM}/threads/EXAMPLE_DM_THREAD` }
  },
  user: person
} satisfies GoogleChatEvent

export const spaceMention = {
  type: 'MESSAGE',
  eventTime: '2026-01-02T03:05:00.000000Z',
  space: { name: SPACE, displayName: 'Example Space', spaceType: 'SPACE', spaceThreadingState: 'THREADED_MESSAGES' },
  message: {
    name: `${SPACE}/messages/EXAMPLE_MESSAGE`,
    sender: person,
    createTime: '2026-01-02T03:04:59.123456Z',
    text: '@ExampleApp ask @OtherApp and @Example Person to review this',
    argumentText: ' ask  and @Example Person to review this',
    thread: { name: `${SPACE}/threads/EXAMPLE_THREAD` },
    threadReply: false,
    annotations: [
      {
        type: 'USER_MENTION',
        startIndex: 0,
        length: 11,
        userMention: { user: { name: APP, displayName: 'ExampleApp', type: 'BOT' }, type: 'MENTION' }
      },
      {
        type: 'USER_MENTION',
        startIndex: 16,
        length: 9,
        userMention: { user: { name: OTHER_APP, displayName: 'OtherApp', type: 'BOT' }, type: 'MENTION' }
      },
      {
        type: 'USER_MENTION',
        startIndex: 30,
        length: 15,
        userMention: { user: { name: MENTIONED_PERSON, displayName: 'Example Person', type: 'HUMAN' }, type: 'MENTION' }
      }
    ]
  },
  user: person
} satisfies GoogleChatEvent

// The request-mapping guide's single `ADDED_TO_SPACE` event that carries the @mention which added the app.
export const addedWithMessage = {
  type: 'ADDED_TO_SPACE',
  eventTime: '2026-01-02T03:06:00.000000Z',
  space: { name: SPACE, displayName: 'Example Space', spaceType: 'SPACE' },
  message: {
    name: `${SPACE}/messages/EXAMPLE_ADD_MESSAGE`,
    sender: person,
    createTime: '2026-01-02T03:05:59.000000Z',
    text: '@ExampleApp set up the release checklist',
    thread: { name: `${SPACE}/threads/EXAMPLE_ADD_THREAD` },
    annotations: [
      {
        type: 'USER_MENTION',
        startIndex: 0,
        length: 11,
        userMention: { user: { name: APP, displayName: 'ExampleApp', type: 'BOT' }, type: 'ADD' }
      }
    ]
  },
  user: person
} satisfies GoogleChatEvent

export const addedToDm = {
  type: 'ADDED_TO_SPACE',
  eventTime: '2026-01-02T03:00:00.000000Z',
  space: { name: DM, spaceType: 'DIRECT_MESSAGE', singleUserBotDm: true },
  user: person
} satisfies GoogleChatEvent

export const removedFromSpace = {
  type: 'REMOVED_FROM_SPACE',
  eventTime: '2026-01-02T04:00:00.000000Z',
  space: { name: SPACE, spaceType: 'SPACE' },
  user: person
} satisfies GoogleChatEvent

// Tenant-bearing variants (design §10): the ids are reserved examples, never a real customer or domain.
export const CUSTOMER = 'customers/C0000000000'
export const DOMAIN_ID = '0000000000'
export const EXTERNAL_PERSON = 'users/100000000000000000003'
export const CONFIG_COMPLETE_URL = 'https://chat.example.test/config-complete?token=EXAMPLE'

const workspacePerson = { ...person, domainId: DOMAIN_ID }
// A member of another Workspace organization writing in this customer's Space.
const externalPerson = { name: EXTERNAL_PERSON, displayName: 'External Person', type: 'HUMAN', domainId: '0000000001' }
const customerSpace = { name: SPACE, displayName: 'Example Space', spaceType: 'SPACE', customer: CUSTOMER }

/** A DM from a Workspace account, with the configuration return URL Chat puts on interaction events. */
export const dmMessageFromWorkspace = {
  ...dmMessage,
  message: { ...dmMessage.message, sender: workspacePerson },
  user: workspacePerson,
  configCompleteRedirectUrl: CONFIG_COMPLETE_URL
} satisfies GoogleChatEvent

/** A mention in a customer's Space by an external member: the tenant is the Space's customer, never the sender's domain. */
export const spaceMentionByExternalMember = {
  ...spaceMention,
  space: customerSpace,
  message: { ...spaceMention.message, sender: externalPerson },
  user: externalPerson,
  configCompleteRedirectUrl: CONFIG_COMPLETE_URL
} satisfies GoogleChatEvent

/** Adding the app to a Workspace account's DM. */
export const addedToWorkspaceDm = {
  ...addedToDm,
  user: workspacePerson,
  configCompleteRedirectUrl: CONFIG_COMPLETE_URL
} satisfies GoogleChatEvent

/** Clicking the welcome card's button in the customer's Space (design §10.7). */
export const cardClicked = {
  type: 'CARD_CLICKED',
  eventTime: '2026-01-02T03:07:00.000000Z',
  space: customerSpace,
  message: {
    name: `${SPACE}/messages/EXAMPLE_CARD_MESSAGE`,
    sender: { name: APP, displayName: 'ExampleApp', type: 'BOT' },
    createTime: '2026-01-02T03:06:30.000000Z',
    thread: { name: `${SPACE}/threads/EXAMPLE_ADD_THREAD` }
  },
  user: workspacePerson,
  action: { actionMethodName: 'agentconnect.claim', parameters: [{ key: 'source', value: 'welcome' }] },
  common: {
    invokedFunction: 'agentconnect.claim',
    parameters: { source: 'welcome' },
    userLocale: 'en',
    hostApp: 'CHAT'
  },
  configCompleteRedirectUrl: CONFIG_COMPLETE_URL,
  isDialogEvent: false
} satisfies GoogleChatEvent

// Workspace add-on requests (design §11), shaped by Google's add-on event-object reference; every token is a placeholder.
const addOnCommon = { hostApp: 'CHAT', userLocale: 'en', timeZone: { id: 'Etc/UTC', offset: 0 } }
const addOnAuthorization = {
  userOAuthToken: 'EXAMPLE_USER_OAUTH_TOKEN',
  userIdToken: 'EXAMPLE_USER_ID_TOKEN',
  systemIdToken: 'EXAMPLE_SYSTEM_ID_TOKEN'
}

/** {@link dmMessageFromWorkspace} as an add-on sends it. */
export const addOnDmMessage = {
  commonEventObject: addOnCommon,
  authorizationEventObject: addOnAuthorization,
  chat: {
    user: workspacePerson,
    eventTime: dmMessage.eventTime,
    messagePayload: {
      message: dmMessageFromWorkspace.message,
      space: dmMessage.space,
      configCompleteRedirectUri: CONFIG_COMPLETE_URL
    }
  }
} satisfies GoogleChatAddOnEvent

/** {@link spaceMentionByExternalMember} as an add-on sends it. */
export const addOnSpaceMention = {
  commonEventObject: addOnCommon,
  authorizationEventObject: addOnAuthorization,
  chat: {
    user: spaceMentionByExternalMember.user,
    eventTime: spaceMention.eventTime,
    messagePayload: {
      message: spaceMentionByExternalMember.message,
      space: customerSpace,
      configCompleteRedirectUri: CONFIG_COMPLETE_URL
    }
  }
} satisfies GoogleChatAddOnEvent

/** An @mention adding the app, whose message an add-on receives separately afterwards. */
export const addOnAddedToSpace = {
  commonEventObject: addOnCommon,
  authorizationEventObject: addOnAuthorization,
  chat: {
    user: workspacePerson,
    eventTime: addedWithMessage.eventTime,
    addedToSpacePayload: { space: customerSpace, interactionAdd: true, configCompleteRedirectUri: CONFIG_COMPLETE_URL }
  }
} satisfies GoogleChatAddOnEvent

export const addOnRemovedFromSpace = {
  commonEventObject: addOnCommon,
  chat: {
    user: workspacePerson,
    eventTime: removedFromSpace.eventTime,
    removedFromSpacePayload: { space: customerSpace }
  }
} satisfies GoogleChatAddOnEvent

/** An elicitation button an add-on posted: the function was the events URL, so the action rides our own parameter. */
export const addOnButtonClicked = {
  commonEventObject: {
    ...addOnCommon,
    parameters: { 'agentconnect.action': 'agentconnect.elicit', request: 'req-1', token: 'ok' },
    formInputs: { f0: { stringInputs: { value: ['typed'] } } }
  },
  authorizationEventObject: addOnAuthorization,
  chat: {
    user: workspacePerson,
    eventTime: cardClicked.eventTime,
    buttonClickedPayload: { message: cardClicked.message, space: customerSpace, isDialogEvent: false }
  }
} satisfies GoogleChatAddOnEvent
