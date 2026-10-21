import { describe, expect, it } from 'vitest'
import { NormalizedPlatformMessageSchema, manifestFor, type NormalizedPlatformMessage } from '@agentconnect.md/protocol'
import { normalizeDingTalkMessage, type DingTalkRobotMessage } from '../src/dingtalk-message.js'
import {
  BOT_USER,
  DM_CONVERSATION,
  GROUP,
  ROBOT,
  STAFF,
  dmPicture,
  dmRichText,
  dmText,
  dmUnknownType,
  groupMention,
  quoteOfBotMessage,
  quoteOfFile,
  quoteOfHumanMessage
} from './fixtures/dingtalk-messages.js'

const normalize = (payload: DingTalkRobotMessage, robotCode = ROBOT) =>
  normalizeDingTalkMessage(payload, { robotCode, traceId: 'trace-1' })

function messageOf(payload: DingTalkRobotMessage): NormalizedPlatformMessage {
  const message = normalize(payload)
  if (!message) throw new Error('expected a message')
  // Every normalized message is a valid wire payload, and the per-message webhook never leaves the adapter.
  expect(NormalizedPlatformMessageSchema.parse(message)).toEqual(message)
  expect(JSON.stringify(message)).not.toContain('webhook')
  return message
}

describe('DingTalk normalization', () => {
  it('keys a DM by its member and keeps its text verbatim', () => {
    const message = messageOf(dmText)
    expect(message).toEqual({
      msgId: `dingtalk:${DM_CONVERSATION}:msg-dm-0001`,
      traceId: 'trace-1',
      source: 'user',
      platform: 'dingtalk',
      channel: `dm:${STAFF}`,
      sender: { id: STAFF, isBot: false, name: 'Example User' },
      text: 'hello there',
      mentionedBots: [],
      isDm: true,
      platformTimeMs: 1767225600000
    })
    expect(manifestFor('dingtalk').dmChannelPattern?.test(message.channel)).toBe(true)
  })

  it('keys a group by its conversation and trims the space the removed mention leaves', () => {
    const message = messageOf(groupMention)
    expect(message).toMatchObject({
      msgId: `dingtalk:${GROUP}:msg-group-0001`,
      channel: GROUP,
      text: 'please summarize the thread',
      mentionedBots: [ROBOT],
      isDm: false
    })
    expect(message.replyTo).toBeUndefined()
    expect(manifestFor('dingtalk').dmChannelPattern?.test(message.channel)).toBe(false)
  })

  it('names a quoted bot message by the process query key its send returned', () => {
    expect(messageOf(quoteOfBotMessage)).toMatchObject({
      text: 'and the next step?',
      replyTo: 'process-query-key-0001',
      quoted: { messageId: 'process-query-key-0001', text: 'Here is the summary.' }
    })
  })

  it('names a quoted human message by its message id', () => {
    const message = messageOf(quoteOfHumanMessage)
    expect(message).toMatchObject({
      text: 'what does this mean?',
      replyTo: 'msg-human-0001',
      quoted: { messageId: 'msg-human-0001', text: 'The build is red again.' }
    })
    expect(message.quoted?.excerpt).toBeUndefined()
  })

  it('bounds a long quote and marks it as an excerpt', () => {
    const long = structuredClone(quoteOfHumanMessage)
    long.text!.repliedMsg!.content = { text: 'x'.repeat(1200) }
    expect(messageOf(long).quoted).toMatchObject({ text: `${'x'.repeat(1000)}…`, excerpt: true })
  })

  it('carries a quoted file as an attachment holding its download code', () => {
    const message = messageOf(quoteOfFile)
    expect(message.attachments).toEqual([
      {
        id: 'msg-file-0001:quote:0',
        name: 'report.pdf',
        mimeType: 'application/pdf',
        sourceUrl: 'download-code-file-0001'
      }
    ])
    expect(message.quoted).toEqual({
      messageId: 'msg-file-0001',
      text: '[attached: report.pdf (application/pdf)]'
    })
    expect(message.text).toBe('review this file')
  })

  it('carries a picture by its download code', () => {
    expect(messageOf(dmPicture)).toMatchObject({
      text: '',
      attachments: [
        { id: 'msg-dm-0002:0', name: 'image-1.jpg', mimeType: 'image/jpeg', sourceUrl: 'download-code-picture-0001' }
      ]
    })
  })

  it('joins rich text and carries its pictures', () => {
    expect(messageOf(dmRichText)).toMatchObject({
      text: 'see the screenshot\nthanks',
      attachments: [{ id: 'msg-dm-0003:0', mimeType: 'image/jpeg', sourceUrl: 'download-code-picture-0002' }]
    })
  })

  it('serves no message type it does not know', () => {
    expect(normalize(dmUnknownType)).toBeNull()
  })

  it('refuses another robot, its own messages, and anything it cannot address', () => {
    expect(normalize(dmText, 'robot-other')).toBeNull()
    expect(normalize({ ...groupMention, senderStaffId: undefined, senderId: BOT_USER })).toBeNull()
    for (const overrides of [
      { conversationType: '3' },
      { conversationId: undefined },
      { msgId: '' },
      { senderStaffId: undefined },
      { text: { content: '' } }
    ] satisfies Partial<DingTalkRobotMessage>[])
      expect(normalize({ ...dmText, ...overrides }), JSON.stringify(overrides)).toBeNull()
    expect(normalize({ ...groupMention, conversationId: 'dm:user-0002' })).toBeNull()
  })

  it('falls back to the platform sender id in a group without a staff id', () => {
    expect(messageOf({ ...groupMention, senderStaffId: undefined }).sender.id).toBe('sender-dingtalk-id-0001')
  })
})
