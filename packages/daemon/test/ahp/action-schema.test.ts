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
it('accepts standard user turns and refuses forged identity, model execution, and unsupported attachment fields', () => {
  expect(startAction.parse(start)).toEqual(start)
  for (const message of [
    { ...start.message, origin: { kind: 'agent' } },
    { ...start.message, origin: { kind: 'user', id: 'forged' } },
    { ...start.message, model: { id: 'unauthorized' } },
    { ...start.message, attachments: [{ type: 'resource', label: 'secret', uri: 'file:///etc/passwd' }] }
  ])
    expect(startAction.safeParse({ ...start, message }).success).toBe(false)
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
