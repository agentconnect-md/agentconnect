import type {
  ActionType,
  ChatInputAnswer,
  ChatInputQuestion,
  ChatState,
  SessionState,
  StateAction,
  StringOrMarkdown,
  ChatInputAnswerState,
  ChatInputAnswerValueKind,
  ChatInputResponseKind,
  ToolCallConfirmationReason,
  ToolCallCancellationReason
} from '@microsoft/agent-host-protocol'
import type { ElicitAnswerValue, ElicitFieldSpec, SessionStep } from '@/lib/data'
import type { McpAppCard, McpAppOutcome } from '@agentconnect.md/protocol'

const text = (value: StringOrMarkdown | undefined): string =>
  typeof value === 'string' ? value : (value?.markdown ?? '')
function field(q: ChatInputQuestion): ElicitFieldSpec | undefined {
  const base = {
    propName: q.id,
    label: q.title ?? q.message,
    description: q.message,
    required: q.required,
    options: []
  }
  switch (q.kind) {
    case 'single-select':
      return { ...base, kind: 'enum', options: q.options.map((o) => ({ value: o.id, label: o.label })) }
    case 'multi-select':
      return {
        ...base,
        kind: 'multi-enum',
        options: q.options.map((o) => ({ value: o.id, label: o.label })),
        multi: { minItems: q.min, maxItems: q.max }
      }
    case 'boolean':
      return {
        ...base,
        kind: 'boolean',
        options: [
          { value: 'true', label: 'Yes' },
          { value: 'false', label: 'No' }
        ],
        defaultValue: q.defaultValue
      }
    case 'number':
    case 'integer':
      return {
        ...base,
        kind: 'number',
        number: { integer: q.kind === 'integer', minimum: q.min, maximum: q.max },
        defaultValue: q.defaultValue
      }
    case 'text':
      return {
        ...base,
        kind: 'text',
        text: { minLength: q.min, maxLength: q.max, format: q.format },
        defaultValue: q.defaultValue
      }
  }
}

export function ahpSteps(chat: ChatState, agentId: string, session?: SessionState): SessionStep[] {
  const steps: SessionStep[] = []
  const meta = session?._meta?.['agentconnect.md'] as
    | { sessionId?: string; apps?: Array<{ turnId: string; card: McpAppCard; html?: string; outcome?: McpAppOutcome }> }
    | undefined
  const turns = [...chat.turns, ...(chat.activeTurn ? [chat.activeTurn] : [])]
  for (const turn of turns) {
    const base = { turnId: turn.id, agentId, observedAtMs: Date.parse(turn.startedAt ?? '') || undefined }
    const image = turn.message.attachments?.find(
      (item) => item.type === 'embeddedResource' && ['image/png', 'image/jpeg', 'image/webp'].includes(item.contentType)
    )
    steps.push({
      ...base,
      kind: 'msg',
      text: turn.message.text,
      turnComplete: 'state' in turn,
      ...(image?.type === 'embeddedResource'
        ? {
            image: {
              name: image.label,
              mimeType: image.contentType as 'image/png' | 'image/jpeg' | 'image/webp',
              data: image.data
            }
          }
        : {})
    })
    for (const part of turn.responseParts) {
      if (part.kind === 'markdown' || part.kind === 'reasoning')
        steps.push({
          ...base,
          kind: part.kind === 'markdown' ? 'done' : 'plan',
          segmentId: part.id,
          text: part.content
        })
      else if (part.kind === 'error') steps.push({ ...base, kind: 'notice', text: part.error.message, standing: true })
      else if (part.kind === 'systemNotification') {
        const steering = part._meta?.['agentconnect.md'] as { steeringId?: string; text?: string } | undefined
        steps.push(
          steering?.steeringId
            ? {
                ...base,
                turnId: steering.steeringId,
                kind: 'msg',
                text: steering.text ?? text(part.content),
                steer: true,
                steered: true
              }
            : { ...base, kind: 'notice', text: text(part.content), standing: true }
        )
      } else if (part.kind === 'toolCall') {
        const tool = part.toolCall
        steps.push({
          ...base,
          kind: 'tool',
          text: tool.displayName,
          toolCallId: tool.toolCallId,
          toolStatus: tool.status === 'completed' ? (tool.success ? 'completed' : 'failed') : tool.status,
          toolSessionId: meta?.sessionId
        })
        if (tool.status === 'pending-confirmation' || tool.status === 'pending-result-confirmation') {
          const options = 'options' in tool ? tool.options : undefined
          steps.push({
            ...base,
            kind: 'elicit',
            text: text(tool.invocationMessage),
            elicit: {
              requestId: `tool:${turn.id}:${tool.toolCallId}`,
              options: options?.map((option) => ({ value: option.id, label: option.label })) ?? [
                { value: 'approve', label: 'Approve' },
                { value: 'deny', label: 'Deny' }
              ]
            }
          })
        }
      } else if (part.kind === 'inputRequest') {
        const request = part.request,
          questions = request.questions ?? [],
          fields = questions.map(field).filter((item): item is ElicitFieldSpec => !!item)
        if (fields.length !== questions.length) {
          steps.push({ ...base, kind: 'notice', text: 'This question requires a newer client.', standing: true })
          continue
        }
        const single = fields.length === 1 ? fields[0] : undefined
        steps.push({
          ...base,
          kind: 'elicit',
          text: request.message ?? questions[0]?.message ?? 'Input requested',
          elicit: {
            requestId: request.id,
            options: single?.options ?? [],
            ...(single
              ? { multi: single.multi, text: single.text, number: single.number, defaultValue: single.defaultValue }
              : { fields }),
            url: request.url,
            ...(part.response
              ? {
                  outcome:
                    part.response === 'accept' ? 'accepted' : part.response === 'decline' ? 'dismissed' : 'cancelled'
                }
              : {})
          }
        })
      }
    }
  }
  if (chat.steeringMessage)
    steps.push({
      kind: 'msg',
      turnId: chat.steeringMessage.id,
      agentId,
      text: chat.steeringMessage.message.text,
      steer: true
    })
  for (const app of meta?.apps ?? [])
    steps.push({
      kind: 'app',
      turnId: app.turnId,
      agentId,
      text: app.card.title,
      app: { ...app.card, html: app.html ?? app.card.html, outcome: app.outcome }
    })
  return steps
}

function answer(q: ChatInputQuestion, value: string | number | string[]): ChatInputAnswer {
  const state = 'submitted' as ChatInputAnswerState.Submitted
  switch (q.kind) {
    case 'boolean':
      return { state, value: { kind: 'boolean' as ChatInputAnswerValueKind.Boolean, value: value === 'true' } }
    case 'number':
    case 'integer':
      return { state, value: { kind: 'number' as ChatInputAnswerValueKind.Number, value: Number(value) } }
    case 'single-select':
      return { state, value: { kind: 'selected' as ChatInputAnswerValueKind.Selected, value: String(value) } }
    case 'multi-select':
      return {
        state,
        value: {
          kind: 'selected-many' as ChatInputAnswerValueKind.SelectedMany,
          value: Array.isArray(value) ? value : [String(value)]
        }
      }
    case 'text':
      return { state, value: { kind: 'text' as ChatInputAnswerValueKind.Text, value: String(value) } }
  }
  throw new Error('This question requires a newer client.')
}
export function ahpAnswer(chat: ChatState, requestId: string, value: ElicitAnswerValue): StateAction {
  for (const turn of [...chat.turns, ...(chat.activeTurn ? [chat.activeTurn] : [])]) {
    for (const part of turn.responseParts) {
      if (part.kind === 'toolCall' && requestId === `tool:${turn.id}:${part.toolCall.toolCallId}`) {
        const tool = part.toolCall,
          selected = 'options' in tool ? tool.options?.find((option) => option.id === value) : undefined
        const approved = selected ? selected.kind === 'approve' : value === 'approve'
        const base = { turnId: turn.id, toolCallId: tool.toolCallId }
        if (tool.status === 'pending-result-confirmation')
          return { ...base, type: 'chat/toolCallResultConfirmed' as ActionType.ChatToolCallResultConfirmed, approved }
        if (tool.status !== 'pending-confirmation') break
        return approved
          ? {
              ...base,
              type: 'chat/toolCallConfirmed' as ActionType.ChatToolCallConfirmed,
              approved: true,
              confirmed: 'user-action' as ToolCallConfirmationReason.UserAction,
              selectedOptionId: selected?.id
            }
          : {
              ...base,
              type: 'chat/toolCallConfirmed' as ActionType.ChatToolCallConfirmed,
              approved: false,
              reason: 'denied' as ToolCallCancellationReason.Denied,
              selectedOptionId: selected?.id
            }
      }
      if (part.kind === 'inputRequest' && part.request.id === requestId && !part.response) {
        const questions = part.request.questions ?? []
        const answers: Record<string, ChatInputAnswer> = {}
        if (value !== null)
          for (const q of questions) {
            const selected =
              typeof value === 'object' && !Array.isArray(value)
                ? value[q.id]
                : questions.length === 1
                  ? value
                  : undefined
            if (selected !== undefined) answers[q.id] = answer(q, selected)
          }
        return {
          type: 'chat/inputCompleted' as ActionType.ChatInputCompleted,
          requestId,
          response: (value === null ? 'decline' : 'accept') as ChatInputResponseKind,
          answers
        }
      }
    }
  }
  throw new Error('This question has already been answered. Refresh the conversation.')
}
