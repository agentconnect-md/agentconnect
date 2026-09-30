// Workspace add-on requests built from one Chat app's anonymized captures (google-chat-integration.md §9, §11.3); ids are reserved examples.
import type { GoogleChatEventObject } from '@agentconnect.md/message'

/** The Cloud project number: the number in the add-on service account that signs every request. */
export const PROJECT_NUMBER = '100000000000'
/** The relay's public origin and the events URL under it: every token's audience. */
export const PUBLIC_RELAY_URL = 'https://relay.example.test'
export const EVENTS_URL = `${PUBLIC_RELAY_URL}/googlechat/events`
export const APP = 'users/100000000000000000009'
export const OTHER_APP = 'users/100000000000000000008'
export const PERSON = 'users/100000000000000000001'
export const DM = 'spaces/EXAMPLE_DM'
export const SPACE = 'spaces/EXAMPLE_SPACE'
/** The Workspace customer that owns the named Space, and the person's domain as a DM's tenant key (design §10.4). */
export const CUSTOMER = 'customers/C0000000000'
export const DOMAIN = 'domains/0000000000'
/** The completion URL Chat puts on a payload for the authorization prompt. */
export const REDIRECT = 'https://chat.example.test/config-complete?token=REDACTED'

const person = {
  name: PERSON,
  displayName: 'Example Person',
  avatarUrl: 'https://example.test/avatar.png',
  email: 'person@example.test',
  type: 'HUMAN',
  domainId: '0000000000'
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
  spaceUri: 'https://chat.example.test/space',
  customer: CUSTOMER
}

const common = { hostApp: 'CHAT', userLocale: 'en', timeZone: { id: 'Asia/Tokyo', offset: 32400000 } }
// Never read by the relay; present because Google always sends it.
const authorization = { systemIdToken: 'EXAMPLE_SYSTEM_ID_TOKEN' }

function request(eventTime: string, payload: NonNullable<GoogleChatEventObject['chat']>): GoogleChatEventObject {
  return {
    commonEventObject: common,
    authorizationEventObject: authorization,
    chat: { user: person, eventTime, ...payload }
  }
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

/** Adding the app to a DM. */
export const dmAdded = request('2026-09-27T04:23:10.989538Z', {
  addedToSpacePayload: { space: dmSpace, configCompleteRedirectUri: REDIRECT }
})

/** A plain DM message; DMs carry `thread.name` too. */
export const dmMessage = request('2026-09-27T04:23:15.658111Z', {
  messagePayload: {
    space: dmSpace,
    message: {
      name: `${DM}/messages/EXAMPLE_THREAD_1.EXAMPLE_MSG_ROOT`,
      sender: person,
      createTime: '2026-09-27T04:23:15.658111Z',
      text: 'hi',
      thread: { name: `${DM}/threads/EXAMPLE_THREAD_1` },
      space: dmSpace,
      argumentText: 'hi'
    },
    configCompleteRedirectUri: REDIRECT
  }
})

/** Adding the app to a Space by @mention: the add carries no message, which arrives as its own request. */
export const spaceAdded = request('2026-09-27T04:28:34.991528Z', {
  addedToSpacePayload: { space: namedSpace, interactionAdd: true, configCompleteRedirectUri: REDIRECT }
})

/** A plain Space mention: `argumentText` strips every app mention and keeps the leading space. */
export const spaceMention = request('2026-09-27T04:31:02.532927Z', {
  messagePayload: {
    space: namedSpace,
    message: {
      name: `${SPACE}/messages/EXAMPLE_THREAD_3.EXAMPLE_MSG_ROOT`,
      sender: person,
      createTime: '2026-09-27T04:31:02.532927Z',
      text: '@AgentConnect Probe  第二条',
      annotations: [appMention('MENTION')],
      thread: { name: `${SPACE}/threads/EXAMPLE_THREAD_3` },
      space: namedSpace,
      argumentText: '  第二条'
    },
    configCompleteRedirectUri: REDIRECT
  }
})

/** The @mention that added the app, as its own request after {@link spaceAdded}; its annotation names the add. */
export const spaceAddingMention = request('2026-09-27T04:28:35.101528Z', {
  messagePayload: {
    space: namedSpace,
    message: {
      name: `${SPACE}/messages/EXAMPLE_THREAD_2.EXAMPLE_MSG_ROOT`,
      sender: person,
      createTime: '2026-09-27T04:28:34.773503Z',
      text: '@AgentConnect Probe hello',
      annotations: [appMention('ADD')],
      thread: { name: `${SPACE}/threads/EXAMPLE_THREAD_2` },
      space: namedSpace,
      argumentText: ' hello'
    },
    configCompleteRedirectUri: REDIRECT
  }
})

/** A slash command typed in `space`: an `appCommandPayload` whose message names the command in a `SLASH_COMMAND` annotation. */
export function slashCommand(commandName: string, inDm = false): GoogleChatEventObject {
  const space = inDm ? dmSpace : namedSpace
  return request('2026-09-27T04:45:00.000000Z', {
    appCommandPayload: {
      appCommandMetadata: { appCommandId: '1', appCommandType: 'SLASH_COMMAND' },
      space,
      message: {
        name: `${space.name}/messages/EXAMPLE_COMMAND.EXAMPLE_COMMAND`,
        sender: person,
        createTime: '2026-09-27T04:45:00.000000Z',
        text: commandName,
        annotations: [
          {
            type: 'SLASH_COMMAND',
            length: commandName.length,
            slashCommand: {
              bot: { name: APP, displayName: 'AgentConnect Probe', type: 'BOT' },
              type: 'INVOKE',
              commandName,
              commandId: '1'
            }
          }
        ],
        thread: { name: `${space.name}/threads/EXAMPLE_COMMAND` },
        space,
        argumentText: ''
      },
      configCompleteRedirectUri: REDIRECT
    }
  })
}

/** `/help` in the Space and in the DM. */
export const spaceHelp = slashCommand('/help')
export const dmHelp = slashCommand('/help', true)

/** Removing the app from a Space. */
export const spaceRemoved = request('2026-09-27T05:00:00.000000Z', { removedFromSpacePayload: { space: namedSpace } })

/** A click on a button of a card the app posted in the Space, carrying the button's parameters. */
export function buttonClicked(
  parameters: Record<string, string>,
  formInputs: Record<string, { stringInputs: { value: string[] } }> = {}
): GoogleChatEventObject {
  const card = request('2026-09-27T04:40:00.000000Z', {
    buttonClickedPayload: {
      space: namedSpace,
      message: {
        name: `${SPACE}/messages/EXAMPLE_CARD.EXAMPLE_CARD`,
        sender: { name: APP, displayName: 'AgentConnect Probe', type: 'BOT' },
        createTime: '2026-09-27T04:39:00.000000Z',
        thread: { name: `${SPACE}/threads/EXAMPLE_CARD` },
        space: namedSpace
      },
      isDialogEvent: false
    }
  })
  return { ...card, commonEventObject: { ...common, parameters, formInputs } }
}

/** A click on an elicitation card's first option (design §5). */
export const cardClicked = buttonClicked({
  'agentconnect.action': 'agentconnect.elicit',
  request: 'req-1',
  token: 'o0'
})
