import { describe, expect, it } from 'vitest'
import { NormalizedPlatformMessageSchema, manifestFor, type NormalizedPlatformMessage } from '@agentconnect.md/protocol'
import { isThreadRootMessage, nativeMessageCoordinates } from '../src/wire-coordinates.js'
import {
  msTeamsActivityTenantId,
  normalizeMsTeamsActivity,
  type MsTeamsActivity,
  type MsTeamsActivityResult
} from '../src/msteams-message.js'
import {
  AAD_USER,
  APP_ID,
  BOT_ID,
  CHANNEL,
  GROUP_CHAT,
  OTHER_BOT_ID,
  PERSONAL,
  ROOT,
  SERVICE_URL,
  TEAM,
  TENANT,
  USER,
  channelPost,
  channelReply,
  conversationUpdate,
  groupMention,
  groupQuote,
  personalText
} from './fixtures/msteams-activities.js'

const normalize = (activity: unknown, appId = APP_ID, tenantId = TENANT): MsTeamsActivityResult =>
  normalizeMsTeamsActivity(activity, { appId, tenantId, traceId: 'trace-1' })

function messageOf(activity: MsTeamsActivity): NormalizedPlatformMessage {
  const result = normalize(activity)
  if (result.kind !== 'message') throw new Error(`expected a message, got ${JSON.stringify(result)}`)
  // Every normalized message is a valid wire payload.
  expect(NormalizedPlatformMessageSchema.parse(result.message)).toEqual(result.message)
  return result.message
}

describe('Microsoft Teams normalization', () => {
  it('keys a 1:1 chat by its conversation and carries the reply coordinates it was sent from', () => {
    const message = messageOf(personalText)
    expect(message).toEqual({
      msgId: `msteams:${PERSONAL}:1767225610123`,
      traceId: 'trace-1',
      source: 'user',
      platform: 'msteams',
      channel: PERSONAL,
      sender: { id: AAD_USER, isBot: false, name: 'Example User' },
      text: 'hello there',
      mentionedBots: [],
      isDm: true,
      platformTimeMs: 1767225610123,
      adapterExt: { msteams: { serviceUrl: SERVICE_URL, conversationId: PERSONAL, userId: USER } }
    })
    expect(manifestFor('msteams').dmChannelPattern?.test(message.channel)).toBe(true)
    expect(nativeMessageCoordinates(message)).toEqual({ channel: PERSONAL, messageId: '1767225610123' })
  })

  it('threads a channel post on its own root and removes the bot mention', () => {
    const message = messageOf(channelPost)
    expect(message).toMatchObject({
      msgId: `msteams:${CHANNEL}:${ROOT}`,
      channel: CHANNEL,
      thread: ROOT,
      text: 'please summarize the release notes',
      mentionedBots: [BOT_ID],
      isDm: false,
      adapterExt: {
        msteams: { serviceUrl: SERVICE_URL, conversationId: `${CHANNEL};messageid=${ROOT}`, userId: USER, teamId: TEAM }
      }
    })
    expect(isThreadRootMessage(message)).toBe(true)
    expect(manifestFor('msteams').dmChannelPattern?.test(message.channel)).toBe(false)
  })

  it('keys a channel reply by the root its conversation ID names, with no reply-to', () => {
    const message = messageOf(channelReply)
    expect(message).toMatchObject({
      msgId: `msteams:${CHANNEL}:1767225620000`,
      channel: CHANNEL,
      thread: ROOT,
      text: 'and the breaking changes?',
      mentionedBots: []
    })
    expect(message.replyTo).toBeUndefined()
    expect(isThreadRootMessage(message)).toBe(false)
  })

  it('leaves a group chat unthreaded and renders a mention of anyone else by name', () => {
    const message = messageOf(groupMention)
    expect(message).toMatchObject({
      msgId: `msteams:${GROUP_CHAT}:1767225630000`,
      channel: GROUP_CHAT,
      text: 'ask @Another Person and what changed',
      mentionedBots: [BOT_ID],
      isDm: false
    })
    expect(message.thread).toBeUndefined()
    expect(message.adapterExt?.msteams).not.toHaveProperty('teamId')
  })

  it('names a quoted message as the reply-to and strips the quote tag from the text', () => {
    const message = messageOf(groupQuote)
    expect(message).toMatchObject({
      text: 'what about the tests?',
      replyTo: '1767225635000',
      quoted: { messageId: '1767225635000', sender: 'Example Bot', text: 'Here is the summary.' }
    })
    expect(message.thread).toBeUndefined()
    expect(message.quoted?.excerpt).toBeUndefined()
  })

  it('bounds a long quote preview and marks it as an excerpt', () => {
    const long = structuredClone(groupQuote)
    long.entities![0]!.quotedReply!.preview = 'x'.repeat(1200)
    expect(messageOf(long).quoted).toMatchObject({ text: `${'x'.repeat(1000)}…`, excerpt: true })
  })

  it('removes only the exact mention span, never a display name typed as text', () => {
    const typed = { ...channelReply, text: 'Example Bot is the name of <at>Example Bot</at> here' }
    typed.entities = [{ type: 'mention', mentioned: { id: BOT_ID, name: 'Example Bot' }, text: '<at>Example Bot</at>' }]
    expect(messageOf(typed)).toMatchObject({ text: 'Example Bot is the name of here', mentionedBots: [BOT_ID] })
    // A typed name with no mention entity addresses nobody.
    expect(messageOf({ ...channelReply, text: 'Example Bot, are you there?' }).mentionedBots).toEqual([])
  })

  it('records another bot by its ID without addressing this one', () => {
    const other = { ...channelReply, text: '<at>Other Bot</at> run the build' }
    other.entities = [
      { type: 'mention', mentioned: { id: OTHER_BOT_ID, name: 'Other Bot' }, text: '<at>Other Bot</at>' }
    ]
    expect(messageOf(other)).toMatchObject({ text: '@Other Bot run the build', mentionedBots: [OTHER_BOT_ID] })
  })

  it('keeps a bare mention and notes an attachment it cannot read', () => {
    expect(messageOf({ ...channelPost, text: '<at>Example Bot</at>' })).toMatchObject({
      text: '',
      mentionedBots: [BOT_ID]
    })
    const file = {
      ...personalText,
      attachments: [{ contentType: 'application/vnd.microsoft.teams.file.download.info' }]
    }
    expect(messageOf(file).text).toBe(
      'hello there\n[Attachment not read: Microsoft Teams attachments are not supported.]'
    )
  })

  it('falls back to the bot-specific sender ID when the activity carries no Entra object ID', () => {
    expect(messageOf({ ...personalText, from: { id: USER, name: 'Example User' } }).sender.id).toBe(USER)
  })

  it('serves no activity but a message', () => {
    expect(normalize(conversationUpdate)).toEqual({ kind: 'unsupported', reason: 'activity_type' })
    for (const type of ['installationUpdate', 'typing', 'messageReaction', 'invoke', 'messageUpdate'])
      expect(normalize({ ...personalText, type }), type).toEqual({ kind: 'unsupported', reason: 'activity_type' })
  })

  it('ignores its own messages and an empty one, and serves no other bot', () => {
    expect(normalize({ ...personalText, from: { id: BOT_ID } })).toEqual({ kind: 'ignored', reason: 'app_authored' })
    expect(normalize({ ...personalText, text: '  ' })).toEqual({ kind: 'ignored', reason: 'empty' })
    expect(normalize({ ...personalText, from: { id: OTHER_BOT_ID } })).toEqual({
      kind: 'unsupported',
      reason: 'sender_type'
    })
  })

  it('refuses an activity addressed to another bot or tenant', () => {
    expect(normalize(personalText, '00000000-0000-4000-8000-0000000000ff')).toEqual({
      kind: 'invalid',
      reason: 'wrong_bot'
    })
    expect(normalize(personalText, APP_ID, '00000000-0000-4000-8000-0000000000ff')).toEqual({
      kind: 'invalid',
      reason: 'cross_tenant'
    })
    // An Entra GUID matches in any case.
    expect(normalize(personalText, APP_ID.toUpperCase(), TENANT.toUpperCase()).kind).toBe('message')
  })

  it('refuses a channel activity whose conversation and channel disagree', () => {
    expect(
      normalize({
        ...channelPost,
        channelData: { ...channelPost.channelData, teamsChannelId: '19:other@thread.tacv2' }
      })
    ).toEqual({
      kind: 'invalid',
      reason: 'cross_conversation'
    })
    const unthreaded = { ...channelPost, conversation: { ...channelPost.conversation, id: CHANNEL } }
    expect(normalize(unthreaded)).toEqual({ kind: 'unsupported', reason: 'thread_missing' })
  })

  it('refuses anything it cannot address', () => {
    expect(normalize(null)).toEqual({ kind: 'invalid', reason: 'malformed' })
    expect(
      normalize({ ...personalText, conversation: { ...personalText.conversation, conversationType: 'meeting' } })
    ).toEqual({
      kind: 'unsupported',
      reason: 'conversation_type'
    })
    for (const overrides of [
      { id: '' },
      { id: 'f:has-a-colon' },
      { serviceUrl: undefined },
      { serviceUrl: 'http://smba.example.test/' },
      { recipient: undefined },
      { from: undefined },
      { text: 42 },
      { conversation: { id: PERSONAL, conversationType: 'personal' }, channelData: {} },
      { conversation: { id: 'a:1example', conversationType: 'groupChat', tenantId: TENANT } }
    ])
      expect(normalize({ ...personalText, ...overrides }), JSON.stringify(overrides)).toEqual({
        kind: 'invalid',
        reason: 'malformed'
      })
  })

  it('reads the tenant an activity claims for the relay demux', () => {
    expect(msTeamsActivityTenantId(channelPost)).toBe(TENANT)
    expect(msTeamsActivityTenantId({ conversation: { tenantId: TENANT } })).toBe(TENANT)
    expect(msTeamsActivityTenantId({})).toBeUndefined()
  })
})
