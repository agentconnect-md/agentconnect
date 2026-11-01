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
const label = z.string().min(1).max(256)
const range = z.unknown().optional()
const embeddedImage = z.strictObject({
  type: z.literal('embeddedResource'),
  label,
  range,
  displayKind: z.literal('image').optional(),
  contentType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  data: z
    .string()
    .min(1)
    .max(64 * 1024),
  _meta: metadata
})
// Accepted so clients like VS Code can send their context, but never read or delivered to the runtime.
const ignoredAttachment = z.union([
  z.looseObject({ type: z.enum(['simple', 'resource', 'annotations', 'chat']), label }),
  z.looseObject({
    type: z.literal('embeddedResource'),
    label,
    contentType: z.string().refine((type) => !type.toLowerCase().startsWith('image/'), 'Unsupported image type')
  })
])
// The host offers only the agent's own model and no custom agents, so a client's selection is accepted and ignored.
const clientSelection = {
  model: z
    .strictObject({
      id,
      config: z
        .record(z.string().max(256), z.union([z.string().max(1024), z.number(), z.boolean(), z.null()]))
        .optional()
    })
    .optional(),
  agent: z.strictObject({ uri: z.string().min(1).max(2048) }).optional()
}
const message = z.strictObject({
  text: z.string().max(64 * 1024),
  origin: z.strictObject({ kind: z.literal('user') }),
  attachments: z
    .array(z.union([embeddedImage, ignoredAttachment]))
    .max(32)
    .optional(),
  ...clientSelection,
  _meta: metadata
})
export function deliveredImages<T>(attachments: readonly T[] | undefined): T[] {
  return (attachments ?? []).filter((item) => embeddedImage.safeParse(item).success)
}
// Strips the client context the runtime never received before a message is published.
export function publishedMessage<M extends { attachments?: readonly unknown[]; model?: unknown; agent?: unknown }>(
  message: M
): Omit<M, 'model' | 'agent'> {
  const published: Record<string, unknown> = { ...message }
  delete published.model
  delete published.agent
  delete published.attachments
  const images = deliveredImages(message.attachments)
  return { ...published, ...(images.length ? { attachments: images } : {}) } as Omit<M, 'model' | 'agent'>
}
export const startAction = z.strictObject({
  type: z.literal(ActionType.ChatTurnStarted),
  turnId: id,
  startedAt: z.string().datetime(),
  message
})
// Client UI state VS Code mirrors into the chat; neither reaches the runtime.
export const draftAction = z.strictObject({ type: z.literal(ActionType.ChatDraftChanged), draft: message.optional() })
export const readAction = z.strictObject({ type: z.literal(ActionType.ChatIsReadChanged), isRead: z.boolean() })
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
  const images = deliveredImages(message.attachments).map((item) => {
    const image = embeddedImage.parse(item)
    return SessionImageAttachment.parse({ name: image.label, mimeType: image.contentType, data: image.data })
  })
  if (images.length > 1) throw new Error('Only one image is supported')
  if (images.length && context.images?.length) throw new Error('Image supplied twice')
  return { images: images.length ? images : context.images, files: context.files }
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
