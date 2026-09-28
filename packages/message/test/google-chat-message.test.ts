import { describe, expect, it } from 'vitest'
import { NormalizedPlatformMessageSchema, type NormalizedPlatformMessage } from '@agentconnect.md/protocol'
import {
  googleChatEventForm,
  googleChatEventFromAddOn,
  googleChatEventOf,
  googleChatTenantKey,
  normalizeGoogleChatEvent,
  type GoogleChatEventResult
} from '../src/google-chat-message.js'
import { nativeMessageCoordinates } from '../src/wire-coordinates.js'
import {
  APP,
  CONFIG_COMPLETE_URL,
  CUSTOMER,
  DM,
  DOMAIN_ID,
  EXTERNAL_PERSON,
  OTHER_APP,
  PERSON,
  SPACE,
  addOnAddedToSpace,
  addOnButtonClicked,
  addOnDmMessage,
  addOnRemovedFromSpace,
  addOnSpaceMention,
  addedToDm,
  addedToWorkspaceDm,
  addedWithMessage,
  cardClicked,
  dmMessage,
  dmMessageFromWorkspace,
  removedFromSpace,
  spaceMention,
  spaceMentionByExternalMember
} from './fixtures/google-chat-events.js'

const normalize = (event: unknown, appUserName = APP): GoogleChatEventResult =>
  normalizeGoogleChatEvent(event, { appUserName, traceId: 'trace-1' })

function messageOf(result: GoogleChatEventResult): NormalizedPlatformMessage {
  if (result.kind !== 'message') throw new Error(`expected a message, got ${JSON.stringify(result)}`)
  return result.message
}

// A mutable deep copy of a fixture, so each case states only what it changes.
function copy<T>(value: T): any {
  return JSON.parse(JSON.stringify(value))
}

describe('Google Chat event normalization', () => {
  it("removes only the receiving app's own mention, keeping the mentions argumentText would erase", () => {
    const msg = messageOf(normalize(spaceMention))
    expect(msg.text).toBe('ask @OtherApp and @Example Person to review this')
    expect(msg.mentionedBots).toEqual([APP])
    // The same message seen by the other app strips that app's mention and leaves ours.
    const other = messageOf(normalize(spaceMention, OTHER_APP))
    expect(other.text).toBe('@ExampleApp ask and @Example Person to review this')
    expect(other.mentionedBots).toEqual([OTHER_APP])
    // No mention of the app at all: it is not addressed, and the text stays verbatim.
    const unaddressed = copy(spaceMention)
    unaddressed.message.annotations = unaddressed.message.annotations.slice(1)
    expect(messageOf(normalize(unaddressed))).toMatchObject({ text: spaceMention.message.text, mentionedBots: [] })
  })

  it('never strips text an annotation does not point at, and reads an omitted startIndex as zero', () => {
    const misaligned = copy(spaceMention)
    misaligned.message.annotations[0].startIndex = 1
    expect(messageOf(normalize(misaligned))).toMatchObject({ text: spaceMention.message.text, mentionedBots: [APP] })
    const zeroOmitted = copy(spaceMention)
    delete zeroOmitted.message.annotations[0].startIndex
    expect(messageOf(normalize(zeroOmitted)).text).toBe('ask @OtherApp and @Example Person to review this')
  })

  it('mints a wire-valid msgId whose native coordinate is the message resource name', () => {
    const msg = messageOf(normalize(spaceMention))
    expect(NormalizedPlatformMessageSchema.parse(msg)).toEqual(msg)
    expect(msg).toMatchObject({ platform: 'googlechat', channel: SPACE, thread: `${SPACE}/threads/EXAMPLE_THREAD` })
    expect(nativeMessageCoordinates(msg)).toEqual({ channel: SPACE, messageId: spaceMention.message.name })
    expect(msg.sender).toEqual({ id: PERSON, isBot: false, name: 'Example Person' })
  })

  it('fails closed on Space types it cannot classify and admits no group DM', () => {
    const dm = messageOf(normalize(dmMessage))
    // A 1:1 DM is one continuous conversation, whatever thread Google files the message under.
    expect(dm).toMatchObject({ channel: DM, thread: DM, isDm: true, mentionedBots: [] })
    expect(dm.isGroupDm).toBeUndefined()
    const withSpace = (space: Record<string, unknown>, event: unknown = dmMessage) => ({ ...copy(event), space })
    expect(normalize(withSpace({ name: DM, spaceType: 'GROUP_CHAT' }))).toEqual({
      kind: 'unsupported',
      reason: 'group_dm'
    })
    expect(normalize(withSpace({ name: DM, spaceType: 'GROUP_CHAT' }, addedToDm)).kind).toBe('unsupported')
    for (const space of [
      { name: DM },
      { name: DM, type: 'DM' },
      { name: DM, type: 'ROOM' },
      { name: DM, spaceType: 'SPACE_TYPE_UNSPECIFIED' },
      { name: DM, spaceType: 'direct_message' }
    ]) {
      expect(normalize(withSpace(space)), JSON.stringify(space)).toEqual({ kind: 'unsupported', reason: 'space_type' })
    }
  })

  it('passes the message an add event carries through the same path as MESSAGE', () => {
    const added = normalize(addedWithMessage)
    const membership = {
      change: 'added',
      channel: SPACE,
      isDm: false,
      actor: PERSON,
      eventTimeMs: Date.UTC(2026, 0, 2, 3, 6)
    }
    expect(added).toEqual({
      kind: 'message',
      message: messageOf(normalize({ ...addedWithMessage, type: 'MESSAGE' })),
      membership
    })
    // The mention that added the app is still an explicit address, and is stripped the same way.
    expect(messageOf(added)).toMatchObject({ text: 'set up the release checklist', mentionedBots: [APP] })
    // An ignorable embedded message leaves the membership alone; a message-less add is membership only.
    const byApp = copy(addedWithMessage)
    byApp.message.sender = { name: OTHER_APP, type: 'BOT' }
    expect(normalize(byApp)).toEqual({ kind: 'membership', membership })
    expect(normalize(addedToDm)).toEqual({
      kind: 'membership',
      membership: { change: 'added', channel: DM, isDm: true, actor: PERSON, eventTimeMs: Date.UTC(2026, 0, 2, 3) }
    })
    expect(normalize(removedFromSpace)).toEqual({
      kind: 'membership',
      membership: {
        change: 'removed',
        channel: SPACE,
        isDm: false,
        actor: PERSON,
        eventTimeMs: Date.UTC(2026, 0, 2, 4)
      }
    })
  })

  it("rejects message and thread names outside the event's Space", () => {
    const cases: [string, (event: any) => void, string][] = [
      [
        'message in another Space',
        (e) => (e.message.name = 'spaces/OTHER_SPACE/messages/EXAMPLE_MESSAGE'),
        'cross_space'
      ],
      [
        'thread in another Space',
        (e) => (e.message.thread.name = 'spaces/OTHER_SPACE/threads/EXAMPLE_THREAD'),
        'cross_space'
      ],
      [
        'event thread in another Space',
        (e) => (e.thread = { name: 'spaces/OTHER_SPACE/threads/EXAMPLE_THREAD' }),
        'cross_space'
      ],
      ['message claiming another Space', (e) => (e.message.space = { name: 'spaces/OTHER_SPACE' }), 'cross_space'],
      [
        'event and message threads disagree',
        (e) => (e.thread = { name: `${SPACE}/threads/OTHER_THREAD` }),
        'thread_mismatch'
      ],
      ['a colon in a resource name', (e) => (e.message.name = `${SPACE}/messages/EXAMPLE:MESSAGE`), 'malformed']
    ]
    for (const [label, mutate, reason] of cases) {
      for (const fixture of [spaceMention, addedWithMessage]) {
        const event = copy(fixture)
        mutate(event)
        expect(normalize(event), `${label} (${fixture.type})`).toEqual({ kind: 'invalid', reason })
      }
    }
  })

  it('ignores app-authored messages and refuses senders it cannot classify', () => {
    const fromOtherApp = copy(spaceMention)
    fromOtherApp.message.sender = { name: OTHER_APP, displayName: 'OtherApp', type: 'BOT' }
    expect(normalize(fromOtherApp)).toEqual({ kind: 'ignored', reason: 'app_authored' })
    const fromSelf = copy(dmMessage)
    fromSelf.message.sender = { name: APP, type: 'HUMAN' }
    expect(normalize(fromSelf)).toEqual({ kind: 'ignored', reason: 'app_authored' })
    const untyped = copy(dmMessage)
    delete untyped.message.sender.type
    expect(normalize(untyped)).toEqual({ kind: 'unsupported', reason: 'sender_type' })
  })

  it('takes provider time from createTime, falling back to a valid eventTime', () => {
    expect(messageOf(normalize(spaceMention)).platformTimeMs).toBe(Date.UTC(2026, 0, 2, 3, 4, 59, 123))
    const timed = (createTime: unknown, eventTime: unknown) => {
      const event = copy(dmMessage)
      event.message.createTime = createTime
      event.eventTime = eventTime
      return messageOf(normalize(event)).platformTimeMs
    }
    expect(timed('2026-01-02T05:04:05.678+02:00', undefined)).toBe(Date.UTC(2026, 0, 2, 3, 4, 5, 678))
    const fallback = Date.UTC(2026, 0, 2, 3, 4, 6)
    for (const invalid of ['not a time', '2026-02-30T00:00:00Z', '2026-01-02T03:04:05', 1767323045000, undefined]) {
      expect(timed(invalid, dmMessage.eventTime), String(invalid)).toBe(fallback)
    }
    expect(timed('2026-13-01T00:00:00Z', '2026-01-02T24:00:00Z')).toBeUndefined()
  })

  it('starts nothing for other event types, dialogs, commands, or thread-less Space messages', () => {
    for (const type of ['WIDGET_UPDATED', 'APP_COMMAND', 'APP_HOME', 'SUBMIT_FORM', 'UNSPECIFIED']) {
      expect(normalize({ ...copy(spaceMention), type }), type).toEqual({ kind: 'unsupported', reason: 'event_type' })
    }
    for (const event of [
      null,
      [],
      'MESSAGE',
      {},
      { ...copy(spaceMention), type: 7 },
      { ...copy(spaceMention), space: {} }
    ]) {
      expect(normalize(event), JSON.stringify(event)).toEqual({ kind: 'invalid', reason: 'malformed' })
    }
    expect(normalize({ ...copy(spaceMention), isDialogEvent: true })).toEqual({ kind: 'unsupported', reason: 'dialog' })
    const command = copy(spaceMention)
    command.message.slashCommand = { commandId: '1' }
    expect(normalize(command)).toEqual({ kind: 'unsupported', reason: 'slash_command' })
    const threadless = copy(spaceMention)
    delete threadless.message.thread
    expect(normalize(threadless)).toEqual({ kind: 'unsupported', reason: 'thread_missing' })
  })

  it('says an attachment was not read rather than dropping or claiming it', () => {
    const withFile = copy(dmMessage)
    withFile.message.attachment = [{ name: `${DM}/messages/EXAMPLE_DM_MESSAGE/attachments/EXAMPLE_FILE` }]
    expect(messageOf(normalize(withFile)).text).toBe(
      'Summarize the open incidents\n[Attachment not read: Google Chat attachments are not supported.]'
    )
    withFile.message.text = ''
    expect(messageOf(normalize(withFile)).text).toBe(
      '[Attachment not read: Google Chat attachments are not supported.]'
    )
  })

  it('requires the caller to supply the app identity as a user resource name', () => {
    for (const appUserName of ['', 'ExampleApp', 'spaces/EXAMPLE_SPACE', 'users/']) {
      expect(() => normalize(dmMessage, appUserName), appUserName).toThrow(TypeError)
    }
  })
})

describe('Google Chat tenant keys and card clicks (design §10)', () => {
  const DOMAIN = `domains/${DOMAIN_ID}`

  it("keys a Space event by its customer and a DM by its sender's domain, never by a Space sender's domain", () => {
    expect(googleChatTenantKey(spaceMentionByExternalMember)).toBe(CUSTOMER)
    expect(normalize(spaceMentionByExternalMember)).toMatchObject({
      kind: 'message',
      tenant: CUSTOMER,
      configCompleteRedirectUrl: CONFIG_COMPLETE_URL
    })
    // Without a customer the external sender's own domain does not stand in: a Space may admit external members.
    const noCustomer = copy(spaceMentionByExternalMember)
    delete noCustomer.space.customer
    expect(googleChatTenantKey(noCustomer)).toBeUndefined()
    expect(normalize(noCustomer)).not.toHaveProperty('tenant')
    expect(googleChatTenantKey(dmMessageFromWorkspace)).toBe(DOMAIN)
    expect(normalize(dmMessageFromWorkspace)).toMatchObject({ kind: 'message', tenant: DOMAIN })
    // A DM keys by its sender even if the payload put a customer on the Space.
    const dmWithCustomer = copy(dmMessageFromWorkspace)
    dmWithCustomer.space.customer = CUSTOMER
    expect(googleChatTenantKey(dmWithCustomer)).toBe(DOMAIN)
    // A personal account has no domain, and a malformed id keys nothing.
    expect(googleChatTenantKey(dmMessage)).toBeUndefined()
    expect(normalize(dmMessage)).not.toHaveProperty('tenant')
    for (const customer of ['C0000000000', 'customers/', 'customers/a:b', 'domains/0000000000', 7]) {
      const event = copy(spaceMentionByExternalMember)
      event.space.customer = customer
      expect(googleChatTenantKey(event), String(customer)).toBeUndefined()
    }
    const oddDomain = copy(dmMessageFromWorkspace)
    oddDomain.user.domainId = 'a:b'
    expect(googleChatTenantKey(oddDomain)).toBeUndefined()
    expect(googleChatTenantKey(null)).toBeUndefined()
  })

  it('carries the tenant and the return URL on membership results too', () => {
    expect(normalize(addedToWorkspaceDm)).toEqual({
      kind: 'membership',
      membership: { change: 'added', channel: DM, isDm: true, actor: PERSON, eventTimeMs: Date.UTC(2026, 0, 2, 3) },
      tenant: DOMAIN,
      configCompleteRedirectUrl: CONFIG_COMPLETE_URL
    })
    const removed = { ...copy(removedFromSpace), space: { name: SPACE, spaceType: 'SPACE', customer: CUSTOMER } }
    expect(normalize(removed)).toMatchObject({ kind: 'membership', tenant: CUSTOMER })
    expect(normalize(removed)).not.toHaveProperty('configCompleteRedirectUrl')
    // An add that carries the triggering message keeps the context beside the message.
    const addedInCustomer = { ...copy(addedWithMessage), space: spaceMentionByExternalMember.space }
    expect(normalize(addedInCustomer)).toMatchObject({
      kind: 'message',
      membership: { change: 'added' },
      tenant: CUSTOMER
    })
    // A non-string return URL is dropped, never surfaced.
    const oddRedirect = copy(dmMessageFromWorkspace)
    oddRedirect.configCompleteRedirectUrl = 42
    expect(normalize(oddRedirect)).not.toHaveProperty('configCompleteRedirectUrl')
  })

  it('normalizes a card click into an interaction with the same Space and sender checks as a message', () => {
    expect(normalize(cardClicked)).toEqual({
      kind: 'interaction',
      interaction: {
        function: 'agentconnect.claim',
        parameters: { source: 'welcome' },
        formInputs: {},
        message: `${SPACE}/messages/EXAMPLE_CARD_MESSAGE`,
        user: PERSON,
        space: SPACE,
        thread: `${SPACE}/threads/EXAMPLE_ADD_THREAD`,
        isDm: false
      },
      tenant: CUSTOMER,
      configCompleteRedirectUrl: CONFIG_COMPLETE_URL
    })
    // Either shape of the invoked function suffices, and the Chat-app list wins over the add-on map.
    const commonOnly = copy(cardClicked)
    delete commonOnly.action
    expect(normalize(commonOnly)).toMatchObject({ interaction: { function: 'agentconnect.claim' } })
    const actionOnly = copy(cardClicked)
    delete actionOnly.common
    expect(normalize(actionOnly)).toMatchObject({ interaction: { parameters: { source: 'welcome' } } })
    const disagreeing = copy(cardClicked)
    disagreeing.common = { invokedFunction: 'other.function', parameters: { source: 'stale', extra: 'kept' } }
    disagreeing.action.parameters.push({ key: 'bad', value: 7 }, { value: 'no key' }, 'not an object')
    expect(normalize(disagreeing)).toMatchObject({
      interaction: { function: 'agentconnect.claim', parameters: { source: 'welcome', extra: 'kept' } }
    })
    // A click in a DM, with no card message at all, still classifies.
    const inDm = { ...copy(cardClicked), space: dmMessageFromWorkspace.space, message: undefined, thread: undefined }
    expect(normalize(inDm)).toMatchObject({
      kind: 'interaction',
      interaction: { space: DM, isDm: true },
      tenant: DOMAIN
    })
    expect(normalize(inDm)).not.toHaveProperty(['interaction', 'thread'])
    expect(normalize(inDm)).not.toHaveProperty(['interaction', 'message'])
  })

  it("reads a card click's input widgets as string lists and drops any other shape", () => {
    const submitted = copy(cardClicked) as any
    submitted.common.formInputs = {
      text: { stringInputs: { value: ['typed'] } },
      picks: { stringInputs: { value: ['o0', 7, 'o2'] } },
      date: { dateInput: { msSinceEpoch: '1' } },
      odd: 'not an object'
    }
    expect(normalize(submitted)).toMatchObject({
      interaction: { formInputs: { text: ['typed'], picks: ['o0', 'o2'] } }
    })
    expect(normalize(submitted)).not.toHaveProperty(['interaction', 'formInputs', 'date'])
  })

  it('refuses a card click the way it refuses a message: Space checks, sender checks, dialogs, group DMs', () => {
    const refused: [string, (e: any) => void, GoogleChatEventResult][] = [
      [
        'card in another Space',
        (e) => (e.message.name = 'spaces/OTHER/messages/M'),
        { kind: 'invalid', reason: 'cross_space' }
      ],
      [
        'card thread elsewhere',
        (e) => (e.message.thread.name = 'spaces/OTHER/threads/T'),
        { kind: 'invalid', reason: 'cross_space' }
      ],
      [
        'card claiming another Space',
        (e) => (e.message.space = { name: 'spaces/OTHER' }),
        { kind: 'invalid', reason: 'cross_space' }
      ],
      [
        'event thread disagrees',
        (e) => (e.thread = { name: `${SPACE}/threads/OTHER_THREAD` }),
        { kind: 'invalid', reason: 'thread_mismatch' }
      ],
      ['no clicker', (e) => delete e.user, { kind: 'invalid', reason: 'malformed' }],
      ['clicker with an odd name', (e) => (e.user.name = 'people/1'), { kind: 'invalid', reason: 'malformed' }],
      [
        'no function named',
        (e) => {
          delete e.action
          delete e.common
        },
        { kind: 'invalid', reason: 'malformed' }
      ],
      ['a bot clicking', (e) => (e.user.type = 'BOT'), { kind: 'ignored', reason: 'app_authored' }],
      [
        'the app itself clicking',
        (e) => (e.user = { name: APP, type: 'HUMAN' }),
        { kind: 'ignored', reason: 'app_authored' }
      ],
      ['an untyped clicker', (e) => delete e.user.type, { kind: 'unsupported', reason: 'sender_type' }],
      ['a dialog submission', (e) => (e.isDialogEvent = true), { kind: 'unsupported', reason: 'dialog' }],
      [
        'a group DM',
        (e) => (e.space = { name: DM, spaceType: 'GROUP_CHAT' }),
        { kind: 'unsupported', reason: 'group_dm' }
      ]
    ]
    for (const [label, mutate, expected] of refused) {
      const event = copy(cardClicked)
      mutate(event)
      expect(normalize(event), label).toEqual(expected)
    }
    // The external member's click keys the Space's customer, like their message would.
    const byExternal = copy(cardClicked)
    byExternal.user = { ...spaceMentionByExternalMember.user }
    expect(normalize(byExternal)).toMatchObject({ interaction: { user: EXTERNAL_PERSON }, tenant: CUSTOMER })
  })
})

describe('Google Chat add-on requests (design §11)', () => {
  const DOMAIN = `domains/${DOMAIN_ID}`
  const adapted = (body: unknown) => normalize(googleChatEventFromAddOn(body))

  it('tells the two request forms apart and refuses a body that is neither', () => {
    expect(googleChatEventForm(dmMessage)).toBe('chat')
    expect(googleChatEventForm(addOnDmMessage)).toBe('addon')
    for (const body of [null, [], {}, 'MESSAGE', { type: 7 }, { chat: 'x' }, { commonEventObject: {} }]) {
      expect(googleChatEventForm(body), JSON.stringify(body)).toBeUndefined()
    }
    expect(googleChatEventOf(addOnDmMessage)).toEqual({
      form: 'addon',
      event: googleChatEventFromAddOn(addOnDmMessage)
    })
    expect(googleChatEventOf(dmMessage)).toEqual({ form: 'chat', event: dmMessage })
    expect(googleChatEventOf({})).toBeUndefined()
  })

  it('classifies an add-on message exactly as its Chat API twin, tenant and return URL included', () => {
    expect(adapted(addOnDmMessage)).toEqual(normalize(dmMessageFromWorkspace))
    expect(adapted(addOnDmMessage)).toMatchObject({ kind: 'message', tenant: DOMAIN })
    expect(adapted(addOnSpaceMention)).toEqual(normalize(spaceMentionByExternalMember))
    expect(googleChatTenantKey(googleChatEventFromAddOn(addOnSpaceMention))).toBe(CUSTOMER)
    expect(googleChatTenantKey(googleChatEventFromAddOn(addOnDmMessage))).toBe(DOMAIN)
  })

  it('reads an add as membership alone, since an add-on receives the adding message separately, and a removal the same way', () => {
    expect(adapted(addOnAddedToSpace)).toEqual({
      kind: 'membership',
      membership: {
        change: 'added',
        channel: SPACE,
        isDm: false,
        actor: PERSON,
        eventTimeMs: Date.UTC(2026, 0, 2, 3, 6)
      },
      tenant: CUSTOMER,
      configCompleteRedirectUrl: CONFIG_COMPLETE_URL
    })
    expect(adapted(addOnRemovedFromSpace)).toMatchObject({
      kind: 'membership',
      membership: { change: 'removed', channel: SPACE },
      tenant: CUSTOMER
    })
  })

  it('reads a button click’s action from our own parameter, with the card’s widgets', () => {
    expect(adapted(addOnButtonClicked)).toEqual({
      kind: 'interaction',
      interaction: {
        function: 'agentconnect.elicit',
        parameters: { 'agentconnect.action': 'agentconnect.elicit', request: 'req-1', token: 'ok' },
        formInputs: { f0: ['typed'] },
        message: `${SPACE}/messages/EXAMPLE_CARD_MESSAGE`,
        user: PERSON,
        space: SPACE,
        thread: `${SPACE}/threads/EXAMPLE_ADD_THREAD`,
        isDm: false
      },
      tenant: CUSTOMER
    })
    const dialog = copy(addOnButtonClicked)
    dialog.chat.buttonClickedPayload.isDialogEvent = true
    expect(adapted(dialog)).toEqual({ kind: 'unsupported', reason: 'dialog' })
  })

  it('never carries the authorization tokens into the event', () => {
    for (const body of [addOnDmMessage, addOnSpaceMention, addOnAddedToSpace, addOnButtonClicked]) {
      const event = JSON.stringify(googleChatEventFromAddOn(body))
      expect(event).not.toContain('EXAMPLE_USER_OAUTH_TOKEN')
      expect(event).not.toContain('EXAMPLE_USER_ID_TOKEN')
      expect(event).not.toContain('EXAMPLE_SYSTEM_ID_TOKEN')
    }
  })

  it('starts nothing for commands and widget updates, and reads a body without exactly one payload as malformed', () => {
    const command = copy(addOnSpaceMention)
    command.chat = { ...command.chat, appCommandPayload: command.chat.messagePayload, messagePayload: undefined }
    expect(adapted(command)).toEqual({ kind: 'unsupported', reason: 'event_type' })
    const widget = { chat: { user: addOnDmMessage.chat.user, widgetUpdatedPayload: { space: dmMessage.space } } }
    expect(adapted(widget)).toEqual({ kind: 'unsupported', reason: 'event_type' })
    const none = { chat: { user: addOnDmMessage.chat.user } }
    const two = { chat: { ...addOnSpaceMention.chat, removedFromSpacePayload: { space: { name: SPACE } } } }
    for (const body of [none, two, {}, null]) {
      expect(adapted(body), JSON.stringify(body)).toEqual({ kind: 'invalid', reason: 'malformed' })
    }
  })

  it('takes the top-level Space when the payload names none, and refuses one that contradicts the payload', () => {
    const topLevel = copy(addOnRemovedFromSpace)
    topLevel.chat.space = topLevel.chat.removedFromSpacePayload.space
    delete topLevel.chat.removedFromSpacePayload.space
    expect(adapted(topLevel)).toMatchObject({ kind: 'membership', membership: { channel: SPACE } })
    const contradicting = copy(addOnSpaceMention)
    contradicting.chat.space = { name: DM, spaceType: 'DIRECT_MESSAGE' }
    expect(adapted(contradicting)).toEqual({ kind: 'invalid', reason: 'malformed' })
  })

  it('prefers our own action parameter, then a pre-conversion card’s function, then Chat’s own fields', () => {
    const ours = copy(cardClicked)
    ours.action.parameters.push({ key: 'agentconnect.action', value: 'agentconnect.elicit' })
    expect(normalize(ours)).toMatchObject({ interaction: { function: 'agentconnect.elicit' } })
    const converted = copy(addOnButtonClicked)
    converted.commonEventObject.parameters = { __action_method_name__: 'agentconnect.elicit', request: 'req-1' }
    expect(adapted(converted)).toMatchObject({ interaction: { function: 'agentconnect.elicit' } })
    const emptyOwn = copy(cardClicked)
    emptyOwn.common.parameters['agentconnect.action'] = ''
    expect(normalize(emptyOwn)).toMatchObject({ interaction: { function: 'agentconnect.claim' } })
    const nameless = copy(addOnButtonClicked)
    nameless.commonEventObject.parameters = { request: 'req-1' }
    expect(adapted(nameless)).toEqual({ kind: 'invalid', reason: 'malformed' })
  })
})
