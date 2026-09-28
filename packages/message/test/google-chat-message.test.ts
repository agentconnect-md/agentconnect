import { describe, expect, it } from 'vitest'
import { NormalizedPlatformMessageSchema, type NormalizedPlatformMessage } from '@agentconnect.md/protocol'
import {
  googleChatPayloadOf,
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
  addedToDm,
  addedToSpace,
  addedToWorkspaceDm,
  buttonClicked,
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

// The message a copied message request carries, and the payload a copied click carries.
const messageIn = (event: any) => event.chat.messagePayload.message
const clickIn = (event: any) => event.chat.buttonClickedPayload

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
    messageIn(unaddressed).annotations = messageIn(unaddressed).annotations.slice(1)
    expect(messageOf(normalize(unaddressed))).toMatchObject({ text: messageIn(spaceMention).text, mentionedBots: [] })
    // The @mention that added the app is still an explicit address, and is stripped the same way.
    const adding = copy(spaceMention)
    messageIn(adding).annotations[0].userMention.type = 'ADD'
    expect(messageOf(normalize(adding))).toMatchObject({ mentionedBots: [APP] })
  })

  it('never strips text an annotation does not point at, and reads an omitted startIndex as zero', () => {
    const misaligned = copy(spaceMention)
    messageIn(misaligned).annotations[0].startIndex = 1
    expect(messageOf(normalize(misaligned))).toMatchObject({ text: messageIn(spaceMention).text, mentionedBots: [APP] })
    const zeroOmitted = copy(spaceMention)
    delete messageIn(zeroOmitted).annotations[0].startIndex
    expect(messageOf(normalize(zeroOmitted)).text).toBe('ask @OtherApp and @Example Person to review this')
  })

  it('mints a wire-valid msgId whose native coordinate is the message resource name', () => {
    const msg = messageOf(normalize(spaceMention))
    expect(NormalizedPlatformMessageSchema.parse(msg)).toEqual(msg)
    expect(msg).toMatchObject({ platform: 'googlechat', channel: SPACE, thread: `${SPACE}/threads/EXAMPLE_THREAD` })
    expect(nativeMessageCoordinates(msg)).toEqual({ channel: SPACE, messageId: messageIn(spaceMention).name })
    expect(msg.sender).toEqual({ id: PERSON, isBot: false, name: 'Example Person' })
  })

  it('fails closed on Space types it cannot classify and admits no group DM', () => {
    const dm = messageOf(normalize(dmMessage))
    // A 1:1 DM is one continuous conversation, whatever thread Google files the message under.
    expect(dm).toMatchObject({ channel: DM, thread: DM, isDm: true, mentionedBots: [] })
    expect(dm.isGroupDm).toBeUndefined()
    const withSpace = (space: Record<string, unknown>, event: unknown = dmMessage) => {
      const e = copy(event)
      const payload: any = Object.values(e.chat).find((p: any) => p?.space)
      payload.space = space
      return e
    }
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

  it('reads an add as membership alone, since the @mention that adds the app arrives as its own message', () => {
    expect(normalize(addedToSpace)).toEqual({
      kind: 'membership',
      membership: {
        change: 'added',
        channel: SPACE,
        isDm: false,
        actor: PERSON,
        eventTimeMs: Date.UTC(2026, 0, 2, 3, 6)
      }
    })
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
    const cases: [string, (message: any) => void, string][] = [
      ['message in another Space', (m) => (m.name = 'spaces/OTHER_SPACE/messages/EXAMPLE_MESSAGE'), 'cross_space'],
      ['thread in another Space', (m) => (m.thread.name = 'spaces/OTHER_SPACE/threads/EXAMPLE_THREAD'), 'cross_space'],
      ['message claiming another Space', (m) => (m.space = { name: 'spaces/OTHER_SPACE' }), 'cross_space'],
      ['a colon in a resource name', (m) => (m.name = `${SPACE}/messages/EXAMPLE:MESSAGE`), 'malformed']
    ]
    for (const [label, mutate, reason] of cases) {
      const event = copy(spaceMention)
      mutate(messageIn(event))
      expect(normalize(event), label).toEqual({ kind: 'invalid', reason })
    }
  })

  it('ignores app-authored messages and refuses senders it cannot classify', () => {
    const fromOtherApp = copy(spaceMention)
    messageIn(fromOtherApp).sender = { name: OTHER_APP, displayName: 'OtherApp', type: 'BOT' }
    expect(normalize(fromOtherApp)).toEqual({ kind: 'ignored', reason: 'app_authored' })
    const fromSelf = copy(dmMessage)
    messageIn(fromSelf).sender = { name: APP, type: 'HUMAN' }
    expect(normalize(fromSelf)).toEqual({ kind: 'ignored', reason: 'app_authored' })
    const untyped = copy(dmMessage)
    delete messageIn(untyped).sender.type
    expect(normalize(untyped)).toEqual({ kind: 'unsupported', reason: 'sender_type' })
  })

  it('takes provider time from createTime, falling back to a valid eventTime', () => {
    expect(messageOf(normalize(spaceMention)).platformTimeMs).toBe(Date.UTC(2026, 0, 2, 3, 4, 59, 123))
    const timed = (createTime: unknown, eventTime: unknown) => {
      const event = copy(dmMessage)
      messageIn(event).createTime = createTime
      event.chat.eventTime = eventTime
      return messageOf(normalize(event)).platformTimeMs
    }
    expect(timed('2026-01-02T05:04:05.678+02:00', undefined)).toBe(Date.UTC(2026, 0, 2, 3, 4, 5, 678))
    const fallback = Date.UTC(2026, 0, 2, 3, 4, 6)
    for (const invalid of ['not a time', '2026-02-30T00:00:00Z', '2026-01-02T03:04:05', 1767323045000, undefined]) {
      expect(timed(invalid, dmMessage.chat.eventTime), String(invalid)).toBe(fallback)
    }
    expect(timed('2026-13-01T00:00:00Z', '2026-01-02T24:00:00Z')).toBeUndefined()
  })

  it('starts nothing for commands, widget updates, dialogs, slash commands, or thread-less Space messages', () => {
    const command = copy(spaceMention)
    command.chat.appCommandPayload = command.chat.messagePayload
    delete command.chat.messagePayload
    expect(normalize(command)).toEqual({ kind: 'unsupported', reason: 'event_type' })
    const widget = {
      chat: { user: dmMessage.chat.user, widgetUpdatedPayload: { space: dmMessage.chat.messagePayload.space } }
    }
    expect(normalize(widget)).toEqual({ kind: 'unsupported', reason: 'event_type' })
    const dialog = copy(spaceMention)
    dialog.chat.messagePayload.isDialogEvent = true
    expect(normalize(dialog)).toEqual({ kind: 'unsupported', reason: 'dialog' })
    const slash = copy(spaceMention)
    messageIn(slash).slashCommand = { commandId: '1' }
    expect(normalize(slash)).toEqual({ kind: 'unsupported', reason: 'slash_command' })
    const threadless = copy(spaceMention)
    delete messageIn(threadless).thread
    expect(normalize(threadless)).toEqual({ kind: 'unsupported', reason: 'thread_missing' })
  })

  it('reads a body without exactly one payload, without a Space, or with a contradicting top-level Space as malformed', () => {
    const none = { chat: { user: dmMessage.chat.user } }
    const two = { chat: { ...spaceMention.chat, removedFromSpacePayload: { space: { name: SPACE } } } }
    const noSpace = copy(spaceMention)
    noSpace.chat.messagePayload.space = {}
    const contradicting = copy(spaceMention)
    contradicting.chat.space = { name: DM, spaceType: 'DIRECT_MESSAGE' }
    const messageless = copy(dmMessage)
    delete messageless.chat.messagePayload.message
    for (const body of [
      null,
      [],
      'MESSAGE',
      {},
      { chat: 'x' },
      { type: 'MESSAGE' },
      none,
      two,
      noSpace,
      contradicting,
      messageless
    ]) {
      expect(normalize(body), JSON.stringify(body)).toEqual({ kind: 'invalid', reason: 'malformed' })
    }
    // A payload without its own Space takes the top-level one; the two agreeing is no contradiction.
    const topLevel = copy(removedFromSpace)
    topLevel.chat.space = topLevel.chat.removedFromSpacePayload.space
    expect(normalize(topLevel)).toMatchObject({ kind: 'membership', membership: { channel: SPACE } })
    delete topLevel.chat.removedFromSpacePayload.space
    expect(normalize(topLevel)).toMatchObject({ kind: 'membership', membership: { channel: SPACE } })
  })

  it('names the one payload and its Space, and nothing for a body it cannot read', () => {
    expect(googleChatPayloadOf(spaceMention)).toEqual({
      key: 'messagePayload',
      payload: spaceMention.chat.messagePayload,
      space: spaceMention.chat.messagePayload.space
    })
    expect(googleChatPayloadOf(addedToDm)?.key).toBe('addedToSpacePayload')
    expect(googleChatPayloadOf({ chat: { user: dmMessage.chat.user } })).toBeUndefined()
    expect(googleChatPayloadOf(null)).toBeUndefined()
  })

  it('says an attachment was not read rather than dropping or claiming it', () => {
    const withFile = copy(dmMessage)
    messageIn(withFile).attachment = [{ name: `${DM}/messages/EXAMPLE_DM_MESSAGE/attachments/EXAMPLE_FILE` }]
    expect(messageOf(normalize(withFile)).text).toBe(
      'Summarize the open incidents\n[Attachment not read: Google Chat attachments are not supported.]'
    )
    messageIn(withFile).text = ''
    expect(messageOf(normalize(withFile)).text).toBe(
      '[Attachment not read: Google Chat attachments are not supported.]'
    )
  })

  it('never carries the authorization tokens into a result', () => {
    for (const body of [dmMessage, spaceMention, addedToSpace, buttonClicked]) {
      const result = JSON.stringify(normalize(body))
      expect(result).not.toContain('EXAMPLE_USER_OAUTH_TOKEN')
      expect(result).not.toContain('EXAMPLE_USER_ID_TOKEN')
      expect(result).not.toContain('EXAMPLE_SYSTEM_ID_TOKEN')
    }
  })

  it('requires the caller to supply the app identity as a user resource name', () => {
    for (const appUserName of ['', 'ExampleApp', 'spaces/EXAMPLE_SPACE', 'users/']) {
      expect(() => normalize(dmMessage, appUserName), appUserName).toThrow(TypeError)
    }
  })
})

describe('Google Chat tenant keys and button clicks (design §10)', () => {
  const DOMAIN = `domains/${DOMAIN_ID}`

  it("keys a Space event by its customer and a DM by its sender's domain, never by a Space sender's domain", () => {
    expect(googleChatTenantKey(spaceMentionByExternalMember)).toBe(CUSTOMER)
    expect(normalize(spaceMentionByExternalMember)).toMatchObject({
      kind: 'message',
      tenant: CUSTOMER,
      configCompleteRedirectUri: CONFIG_COMPLETE_URL
    })
    // Without a customer the external sender's own domain does not stand in: a Space may admit external members.
    const noCustomer = copy(spaceMentionByExternalMember)
    delete noCustomer.chat.messagePayload.space.customer
    expect(googleChatTenantKey(noCustomer)).toBeUndefined()
    expect(normalize(noCustomer)).not.toHaveProperty('tenant')
    expect(googleChatTenantKey(dmMessageFromWorkspace)).toBe(DOMAIN)
    expect(normalize(dmMessageFromWorkspace)).toMatchObject({ kind: 'message', tenant: DOMAIN })
    // A DM keys by its sender even if the payload put a customer on the Space.
    const dmWithCustomer = copy(dmMessageFromWorkspace)
    dmWithCustomer.chat.messagePayload.space.customer = CUSTOMER
    expect(googleChatTenantKey(dmWithCustomer)).toBe(DOMAIN)
    // A personal account has no domain, and a malformed id keys nothing.
    expect(googleChatTenantKey(dmMessage)).toBeUndefined()
    expect(normalize(dmMessage)).not.toHaveProperty('tenant')
    for (const customer of ['C0000000000', 'customers/', 'customers/a:b', 'domains/0000000000', 7]) {
      const event = copy(spaceMentionByExternalMember)
      event.chat.messagePayload.space.customer = customer
      expect(googleChatTenantKey(event), String(customer)).toBeUndefined()
    }
    const oddDomain = copy(dmMessageFromWorkspace)
    oddDomain.chat.user.domainId = 'a:b'
    expect(googleChatTenantKey(oddDomain)).toBeUndefined()
    expect(googleChatTenantKey(null)).toBeUndefined()
    expect(googleChatTenantKey({ chat: { user: dmMessageFromWorkspace.chat.user } })).toBeUndefined()
  })

  it('carries the tenant and the return URL on membership results too', () => {
    expect(normalize(addedToWorkspaceDm)).toEqual({
      kind: 'membership',
      membership: { change: 'added', channel: DM, isDm: true, actor: PERSON, eventTimeMs: Date.UTC(2026, 0, 2, 3) },
      tenant: DOMAIN,
      configCompleteRedirectUri: CONFIG_COMPLETE_URL
    })
    const removed = copy(removedFromSpace)
    removed.chat.removedFromSpacePayload.space.customer = CUSTOMER
    expect(normalize(removed)).toMatchObject({ kind: 'membership', tenant: CUSTOMER })
    expect(normalize(removed)).not.toHaveProperty('configCompleteRedirectUri')
    // A non-string return URL is dropped, never surfaced.
    const oddRedirect = copy(dmMessageFromWorkspace)
    oddRedirect.chat.messagePayload.configCompleteRedirectUri = 42
    expect(normalize(oddRedirect)).not.toHaveProperty('configCompleteRedirectUri')
  })

  it('normalizes a button click into an interaction named by our own parameter, with the same Space and sender checks as a message', () => {
    expect(normalize(buttonClicked)).toEqual({
      kind: 'interaction',
      interaction: {
        function: 'agentconnect.elicit',
        parameters: { 'agentconnect.action': 'agentconnect.elicit', request: 'req-1', token: 'ok' },
        formInputs: { f0: ['typed'] },
        message: `${SPACE}/messages/EXAMPLE_CARD_MESSAGE`,
        user: PERSON,
        space: SPACE,
        thread: `${SPACE}/threads/EXAMPLE_CARD_THREAD`,
        isDm: false
      },
      tenant: CUSTOMER,
      configCompleteRedirectUri: CONFIG_COMPLETE_URL
    })
    // Non-string parameters are dropped.
    const odd = copy(buttonClicked)
    odd.commonEventObject.parameters.bad = 7
    expect(normalize(odd)).not.toHaveProperty(['interaction', 'parameters', 'bad'])
    // A click in a DM, with no card message at all, still classifies.
    const inDm = copy(buttonClicked)
    inDm.chat.buttonClickedPayload = { space: dmMessageFromWorkspace.chat.messagePayload.space }
    expect(normalize(inDm)).toMatchObject({
      kind: 'interaction',
      interaction: { space: DM, isDm: true },
      tenant: DOMAIN
    })
    expect(normalize(inDm)).not.toHaveProperty(['interaction', 'thread'])
    expect(normalize(inDm)).not.toHaveProperty(['interaction', 'message'])
  })

  it("reads a button click's input widgets as string lists and drops any other shape", () => {
    const submitted = copy(buttonClicked)
    submitted.commonEventObject.formInputs = {
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

  it('refuses a button click the way it refuses a message: Space checks, sender checks, dialogs, group DMs', () => {
    const refused: [string, (e: any) => void, GoogleChatEventResult][] = [
      [
        'card in another Space',
        (e) => (clickIn(e).message.name = 'spaces/OTHER/messages/M'),
        { kind: 'invalid', reason: 'cross_space' }
      ],
      [
        'card thread elsewhere',
        (e) => (clickIn(e).message.thread.name = 'spaces/OTHER/threads/T'),
        { kind: 'invalid', reason: 'cross_space' }
      ],
      [
        'card claiming another Space',
        (e) => (clickIn(e).message.space = { name: 'spaces/OTHER' }),
        { kind: 'invalid', reason: 'cross_space' }
      ],
      ['no clicker', (e) => delete e.chat.user, { kind: 'invalid', reason: 'malformed' }],
      ['clicker with an odd name', (e) => (e.chat.user.name = 'people/1'), { kind: 'invalid', reason: 'malformed' }],
      [
        'no action parameter',
        (e) => delete e.commonEventObject.parameters['agentconnect.action'],
        { kind: 'invalid', reason: 'malformed' }
      ],
      [
        'an empty action parameter',
        (e) => (e.commonEventObject.parameters['agentconnect.action'] = ''),
        { kind: 'invalid', reason: 'malformed' }
      ],
      ['no parameters at all', (e) => delete e.commonEventObject, { kind: 'invalid', reason: 'malformed' }],
      ['a bot clicking', (e) => (e.chat.user.type = 'BOT'), { kind: 'ignored', reason: 'app_authored' }],
      [
        'the app itself clicking',
        (e) => (e.chat.user = { name: APP, type: 'HUMAN' }),
        { kind: 'ignored', reason: 'app_authored' }
      ],
      ['an untyped clicker', (e) => delete e.chat.user.type, { kind: 'unsupported', reason: 'sender_type' }],
      ['a dialog submission', (e) => (clickIn(e).isDialogEvent = true), { kind: 'unsupported', reason: 'dialog' }],
      [
        'a group DM',
        (e) => (clickIn(e).space = { name: DM, spaceType: 'GROUP_CHAT' }),
        { kind: 'unsupported', reason: 'group_dm' }
      ]
    ]
    for (const [label, mutate, expected] of refused) {
      const event = copy(buttonClicked)
      mutate(event)
      expect(normalize(event), label).toEqual(expected)
    }
    // The external member's click keys the Space's customer, like their message would.
    const byExternal = copy(buttonClicked)
    byExternal.chat.user = { ...spaceMentionByExternalMember.chat.user }
    expect(normalize(byExternal)).toMatchObject({ interaction: { user: EXTERNAL_PERSON }, tenant: CUSTOMER })
  })
})
