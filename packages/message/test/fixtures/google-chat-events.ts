import type { GoogleChatEventObject } from '../../src/google-chat-message.js'

// Workspace add-on requests shaped by Google's add-on event-object reference (design §11); every id and token is a placeholder.

export const APP = 'users/100000000000000000009'
export const OTHER_APP = 'users/100000000000000000008'
export const PERSON = 'users/100000000000000000001'
export const MENTIONED_PERSON = 'users/100000000000000000002'
export const SPACE = 'spaces/EXAMPLE_SPACE'
export const DM = 'spaces/EXAMPLE_DM'

const person = { name: PERSON, displayName: 'Example Person', type: 'HUMAN' }
const common = { hostApp: 'CHAT', userLocale: 'en', timeZone: { id: 'Etc/UTC', offset: 0 } }
const authorization = {
  userOAuthToken: 'EXAMPLE_USER_OAUTH_TOKEN',
  userIdToken: 'EXAMPLE_USER_ID_TOKEN',
  systemIdToken: 'EXAMPLE_SYSTEM_ID_TOKEN'
}
const dmSpace = { name: DM, spaceType: 'DIRECT_MESSAGE', singleUserBotDm: true }

export const dmMessage = {
  commonEventObject: common,
  authorizationEventObject: authorization,
  chat: {
    user: person,
    eventTime: '2026-01-02T03:04:06.000000Z',
    messagePayload: {
      space: dmSpace,
      message: {
        name: `${DM}/messages/EXAMPLE_DM_MESSAGE`,
        sender: person,
        createTime: '2026-01-02T03:04:05.678901Z',
        text: 'Summarize the open incidents',
        argumentText: 'Summarize the open incidents',
        thread: { name: `${DM}/threads/EXAMPLE_DM_THREAD` }
      }
    }
  }
} satisfies GoogleChatEventObject

export const spaceMention = {
  commonEventObject: common,
  authorizationEventObject: authorization,
  chat: {
    user: person,
    eventTime: '2026-01-02T03:05:00.000000Z',
    messagePayload: {
      space: {
        name: SPACE,
        displayName: 'Example Space',
        spaceType: 'SPACE',
        spaceThreadingState: 'THREADED_MESSAGES'
      },
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
            userMention: {
              user: { name: MENTIONED_PERSON, displayName: 'Example Person', type: 'HUMAN' },
              type: 'MENTION'
            }
          }
        ]
      }
    }
  }
} satisfies GoogleChatEventObject

/** An @mention adding the app: the add carries no message, which arrives as its own request. */
export const addedToSpace = {
  commonEventObject: common,
  authorizationEventObject: authorization,
  chat: {
    user: person,
    eventTime: '2026-01-02T03:06:00.000000Z',
    addedToSpacePayload: {
      space: { name: SPACE, displayName: 'Example Space', spaceType: 'SPACE' },
      interactionAdd: true
    }
  }
} satisfies GoogleChatEventObject

export const addedToDm = {
  commonEventObject: common,
  authorizationEventObject: authorization,
  chat: { user: person, eventTime: '2026-01-02T03:00:00.000000Z', addedToSpacePayload: { space: dmSpace } }
} satisfies GoogleChatEventObject

export const removedFromSpace = {
  commonEventObject: common,
  chat: {
    user: person,
    eventTime: '2026-01-02T04:00:00.000000Z',
    removedFromSpacePayload: { space: { name: SPACE, spaceType: 'SPACE' } }
  }
} satisfies GoogleChatEventObject

// Tenant-bearing variants (design §10): the ids are reserved examples, never a real customer or domain.
export const CUSTOMER = 'customers/C0000000000'
export const DOMAIN_ID = '0000000000'
export const EXTERNAL_PERSON = 'users/100000000000000000003'
export const CONFIG_COMPLETE_URL = 'https://chat.example.test/config-complete?token=EXAMPLE'

const workspacePerson = { ...person, domainId: DOMAIN_ID }
// A member of another Workspace organization writing in this customer's Space.
const externalPerson = { name: EXTERNAL_PERSON, displayName: 'External Person', type: 'HUMAN', domainId: '0000000001' }
const customerSpace = { name: SPACE, displayName: 'Example Space', spaceType: 'SPACE', customer: CUSTOMER }

/** A DM from a Workspace account, with the configuration return URL Chat puts on its payloads. */
export const dmMessageFromWorkspace = {
  ...dmMessage,
  chat: {
    ...dmMessage.chat,
    user: workspacePerson,
    messagePayload: {
      ...dmMessage.chat.messagePayload,
      message: { ...dmMessage.chat.messagePayload.message, sender: workspacePerson },
      configCompleteRedirectUri: CONFIG_COMPLETE_URL
    }
  }
} satisfies GoogleChatEventObject

/** A mention in a customer's Space by an external member: the tenant is the Space's customer, never the sender's domain. */
export const spaceMentionByExternalMember = {
  ...spaceMention,
  chat: {
    ...spaceMention.chat,
    user: externalPerson,
    messagePayload: {
      space: customerSpace,
      message: { ...spaceMention.chat.messagePayload.message, sender: externalPerson },
      configCompleteRedirectUri: CONFIG_COMPLETE_URL
    }
  }
} satisfies GoogleChatEventObject

/** Adding the app to a Workspace account's DM. */
export const addedToWorkspaceDm = {
  ...addedToDm,
  chat: {
    ...addedToDm.chat,
    user: workspacePerson,
    addedToSpacePayload: { space: dmSpace, configCompleteRedirectUri: CONFIG_COMPLETE_URL }
  }
} satisfies GoogleChatEventObject

/** A click on an elicitation card's Confirm: the button's function was the events URL, so the action rides our own parameter. */
export const buttonClicked = {
  commonEventObject: {
    ...common,
    parameters: { 'agentconnect.action': 'agentconnect.elicit', request: 'req-1', token: 'ok' },
    formInputs: { f0: { stringInputs: { value: ['typed'] } } }
  },
  authorizationEventObject: authorization,
  chat: {
    user: workspacePerson,
    eventTime: '2026-01-02T03:07:00.000000Z',
    buttonClickedPayload: {
      space: customerSpace,
      message: {
        name: `${SPACE}/messages/EXAMPLE_CARD_MESSAGE`,
        sender: { name: APP, displayName: 'ExampleApp', type: 'BOT' },
        createTime: '2026-01-02T03:06:30.000000Z',
        thread: { name: `${SPACE}/threads/EXAMPLE_CARD_THREAD` }
      },
      configCompleteRedirectUri: CONFIG_COMPLETE_URL,
      isDialogEvent: false
    }
  }
} satisfies GoogleChatEventObject

/** `/help` typed in a customer's Space: an `appCommandPayload` whose message names the command in a `SLASH_COMMAND` annotation. */
export const helpInSpace = {
  commonEventObject: common,
  authorizationEventObject: authorization,
  chat: {
    user: workspacePerson,
    eventTime: '2026-01-02T03:08:00.000000Z',
    appCommandPayload: {
      appCommandMetadata: { appCommandId: '1', appCommandType: 'SLASH_COMMAND' },
      space: customerSpace,
      message: {
        name: `${SPACE}/messages/EXAMPLE_HELP_MESSAGE`,
        sender: workspacePerson,
        createTime: '2026-01-02T03:08:00.000000Z',
        text: '/help',
        thread: { name: `${SPACE}/threads/EXAMPLE_HELP_THREAD` },
        slashCommand: { commandId: '1' },
        annotations: [
          {
            type: 'SLASH_COMMAND',
            startIndex: 0,
            length: 5,
            slashCommand: {
              bot: { name: APP, displayName: 'ExampleApp', type: 'BOT' },
              type: 'INVOKE',
              commandName: '/help',
              commandId: '1'
            }
          }
        ]
      },
      configCompleteRedirectUri: CONFIG_COMPLETE_URL
    }
  }
} satisfies GoogleChatEventObject

/** `/help` typed in a Workspace account's DM. */
export const helpInDm = {
  ...helpInSpace,
  chat: {
    ...helpInSpace.chat,
    appCommandPayload: {
      ...helpInSpace.chat.appCommandPayload,
      space: dmSpace,
      message: {
        ...helpInSpace.chat.appCommandPayload.message,
        name: `${DM}/messages/EXAMPLE_HELP_MESSAGE`,
        thread: { name: `${DM}/threads/EXAMPLE_HELP_THREAD` }
      }
    }
  }
} satisfies GoogleChatEventObject
