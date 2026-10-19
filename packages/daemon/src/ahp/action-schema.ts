import { z } from 'zod'
import { ActionType, ToolCallConfirmationReason, ToolCallCancellationReason } from '@microsoft/agent-host-protocol'
import { SessionImageAttachment, type ElicitCard } from '@agentconnect.md/protocol'
import type { ChatInputCompletedAction } from '@microsoft/agent-host-protocol'
import { ChatAttachmentsInput } from '../session/chat-attachments.js'

const id = z.string().min(1).max(256)
const metadata = z.record(z.string(), z.unknown()).optional()
const runtime = z.strictObject({
  runtime: id.optional(),
  model: id.optional(),
  effort: id.optional(),
  permissionMode: id.optional(),
  fastMode: z.boolean().optional()
})
export const contextMetadata = z.strictObject({
  mentions: z.array(id).max(100).optional(),
  timeZone: z.string().max(128).optional(),
  worktree: z.boolean().optional(),
  runtimeConfig: runtime.optional(),
  files: ChatAttachmentsInput.shape.files,
  images: ChatAttachmentsInput.shape.images
})
const embeddedImage = z.strictObject({
  type: z.literal('embeddedResource'),
  label: z.string().min(1).max(256),
  displayKind: z.literal('image').optional(),
  contentType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  data: z
    .string()
    .min(1)
    .max(64 * 1024)
})
const message = z.strictObject({
  text: z.string().max(64 * 1024),
  origin: z.strictObject({ kind: z.literal('user') }),
  attachments: z.array(embeddedImage).max(1).optional(),
  _meta: metadata
})
export const startAction = z.strictObject({
  type: z.literal(ActionType.ChatTurnStarted),
  turnId: id,
  startedAt: z.string().datetime(),
  message
})
export const steeringAction = z.strictObject({
  type: z.literal(ActionType.ChatPendingMessageSet),
  kind: z.literal('steering'),
  id,
  message
})
export const cancelAction = z.strictObject({
  type: z.literal(ActionType.ChatTurnCancelled),
  turnId: id,
  duration: z.number().finite().nonnegative()
})
const permissionFields = {
  type: z.literal(ActionType.ChatToolCallConfirmed),
  turnId: id,
  toolCallId: id,
  selectedOptionId: id.optional()
}
export const permissionAction = z.discriminatedUnion('approved', [
  z.strictObject({
    ...permissionFields,
    approved: z.literal(true),
    confirmed: z.literal(ToolCallConfirmationReason.UserAction)
  }),
  z.strictObject({
    ...permissionFields,
    approved: z.literal(false),
    reason: z.enum([ToolCallCancellationReason.Denied, ToolCallCancellationReason.Skipped])
  })
])
const answerValue = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), value: z.string().max(16000) }),
  z.strictObject({ kind: z.literal('number'), value: z.number().finite() }),
  z.strictObject({ kind: z.literal('boolean'), value: z.boolean() }),
  z.strictObject({ kind: z.literal('selected'), value: z.string().max(16000) }),
  z.strictObject({ kind: z.literal('selected-many'), value: z.array(z.string().max(16000)).max(100) })
])
export const inputAction = z.strictObject({
  type: z.literal(ActionType.ChatInputCompleted),
  requestId: id,
  response: z.enum(['accept', 'decline', 'cancel']),
  answers: z.record(id, z.strictObject({ state: z.literal('submitted'), value: answerValue })).optional()
})
export const configAction = z.strictObject({
  type: z.literal(ActionType.SessionConfigChanged),
  config: z
    .strictObject({
      model: id.optional(),
      effort: id.optional(),
      permissionMode: id.optional(),
      fastMode: z.boolean().optional()
    })
    .refine((value) => Object.keys(value).length === 1, 'Change one setting at a time')
})

export function messageAttachments(
  message: z.infer<typeof startAction>['message'],
  context: z.infer<typeof contextMetadata>
) {
  const images = message.attachments?.map((image) =>
    SessionImageAttachment.parse({ name: image.label, mimeType: image.contentType, data: image.data })
  )
  if (images?.length && context.images?.length) throw new Error('Image supplied twice')
  return { images: images?.length ? images : context.images, files: context.files }
}

type ElicitValue = string | number | string[] | Record<string, string | number | string[]> | null
// Values must still pass the existing coordinator's constraints and exact pending-request gate.
export function ahpElicitValue(action: ChatInputCompletedAction, card: ElicitCard): ElicitValue {
  const parsed = inputAction.parse(action)
  if (parsed.response !== 'accept') {
    if (parsed.answers && Object.keys(parsed.answers).length) throw new Error('Dismissal cannot submit answers')
    return null
  }
  const answers = parsed.answers ?? {}
  if (card.url) {
    if (Object.keys(answers).length) throw new Error('URL consent has no answer fields')
    return card.url
  }
  const fields = card.fields ?? [
    {
      ...card,
      propName: 'value',
      kind: card.number ? 'number' : card.text ? 'text' : card.multi ? 'multi-enum' : 'enum'
    }
  ]
  const values: Record<string, string | number | string[]> = {}
  for (const [key, answer] of Object.entries(answers)) {
    const field = fields.find((candidate) => candidate.propName === key)
    if (!field) throw new Error('Unknown input question')
    const kind =
      field.kind === 'boolean'
        ? 'boolean'
        : field.number
          ? 'number'
          : field.text
            ? 'text'
            : field.multi
              ? 'selected-many'
              : 'selected'
    if (answer.value.kind !== kind) throw new Error('Input answer kind mismatch')
    values[key] = typeof answer.value.value === 'boolean' ? String(answer.value.value) : answer.value.value
  }
  if (card.fields) return values
  if (Object.keys(values).length !== 1 || values.value === undefined) throw new Error('Input answer is required')
  return values.value
}
