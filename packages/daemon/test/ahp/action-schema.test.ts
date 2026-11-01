import { expect, it } from 'vitest'
import {
  ActionType,
  ChatInputAnswerState,
  ChatInputAnswerValueKind,
  ChatInputResponseKind
} from '@microsoft/agent-host-protocol'
import {
  ahpElicitValue,
  contextMetadata,
  deliveredImages,
  messageAttachments,
  permissionAction,
  startAction
} from '../../src/ahp/action-schema.js'
const start = {
  type: ActionType.ChatTurnStarted,
  turnId: 'turn',
  startedAt: new Date(0).toISOString(),
  message: { text: 'hello', origin: { kind: 'user' as const } }
}
it('accepts standard user turns and refuses forged identity and unsupported image fields', () => {
  expect(startAction.parse(start)).toEqual(start)
  const gif = { type: 'embeddedResource', label: 'a.gif', contentType: 'image/gif', data: 'R0lG' }
  for (const message of [
    { ...start.message, origin: { kind: 'agent' } },
    { ...start.message, origin: { kind: 'user', id: 'forged' } },
    { ...start.message, model: { id: 'gpt', extra: true } },
    { ...start.message, attachments: [gif] },
    { ...start.message, attachments: [{ type: 'unknown', label: 'x' }] }
  ])
    expect(startAction.safeParse({ ...start, message }).success).toBe(false)
})
it("accepts VS Code's model, agent and context attachments without delivering them", () => {
  const message = startAction.parse({
    ...start,
    message: {
      ...start.message,
      model: { id: 'copilot/gpt', config: { reasoning: 'high' } },
      agent: { uri: 'file:///home/user/.github/agents/review.agent.md' },
      attachments: [
        { type: 'resource', label: 'passwd', uri: 'file:///etc/passwd', displayKind: 'document' },
        { type: 'simple', label: 'selection', modelRepresentation: 'secret text' },
        { type: 'embeddedResource', label: 'notes.txt', contentType: 'text/plain', data: 'bm90ZXM=' }
      ],
      _meta: { 'copilot.hidden': true }
    }
  }).message
  expect(deliveredImages(message.attachments)).toEqual([])
  expect(messageAttachments(message, contextMetadata.parse({}))).toEqual({ images: undefined, files: undefined })
})
it('maps standard embedded images through existing upload validation without permitting a second image', () => {
  const image = {
    type: 'embeddedResource' as const,
    label: 'photo.png',
    contentType: 'image/png' as const,
    data: Buffer.from('image').toString('base64')
  }
  const message = startAction.parse({ ...start, message: { ...start.message, attachments: [image] } }).message
  const decoded = messageAttachments(message, contextMetadata.parse({}))
  expect(decoded.images).toEqual([{ name: 'photo.png', mimeType: 'image/png', data: image.data }])
  expect(() => messageAttachments(message, { images: decoded.images })).toThrow('twice')
  const two = startAction.parse({ ...start, message: { ...start.message, attachments: [image, image] } }).message
  expect(() => messageAttachments(two, contextMetadata.parse({}))).toThrow('one image')
})
it('refuses automatic confirmation claims and edited tool input', () => {
  const action = {
    type: ActionType.ChatToolCallConfirmed,
    turnId: 'turn',
    toolCallId: 'approval',
    approved: true,
    confirmed: 'user-action'
  }
  expect(permissionAction.safeParse(action).success).toBe(true)
  expect(permissionAction.safeParse({ ...action, confirmed: 'not-needed' }).success).toBe(false)
  expect(permissionAction.safeParse({ ...action, editedToolInput: 'different command' }).success).toBe(false)
})
it('maps submitted answers only to the pending card question and kind', () => {
  const action = {
    type: ActionType.ChatInputCompleted,
    requestId: 'input',
    response: ChatInputResponseKind.Accept,
    answers: {
      value: { state: ChatInputAnswerState.Submitted, value: { kind: ChatInputAnswerValueKind.Text, value: 'Ada' } }
    }
  } as const
  const card = { requestId: 'input', message: 'Name?', options: [], text: {} }
  expect(ahpElicitValue(action, card)).toBe('Ada')
  expect(() => ahpElicitValue({ ...action, answers: { foreign: action.answers.value } }, card)).toThrow('Unknown')
  expect(() =>
    ahpElicitValue(
      {
        ...action,
        answers: {
          value: { state: ChatInputAnswerState.Submitted, value: { kind: ChatInputAnswerValueKind.Number, value: 42 } }
        }
      },
      card
    )
  ).toThrow('kind')
  expect(ahpElicitValue({ ...action, answers: undefined, response: ChatInputResponseKind.Cancel }, card)).toBeNull()
})

it('maps standard boolean form answers into the existing coordinator representation', () => {
  expect(
    ahpElicitValue(
      {
        type: ActionType.ChatInputCompleted,
        requestId: 'form',
        response: ChatInputResponseKind.Accept,
        answers: {
          allowed: {
            state: ChatInputAnswerState.Submitted,
            value: { kind: ChatInputAnswerValueKind.Boolean, value: true }
          }
        }
      },
      {
        requestId: 'form',
        message: 'Choose',
        options: [],
        fields: [{ propName: 'allowed', label: 'Allowed', kind: 'boolean', options: [] }]
      }
    )
  ).toEqual({ allowed: 'true' })
})
