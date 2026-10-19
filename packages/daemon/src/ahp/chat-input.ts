import type { ElicitCard, ElicitField } from '@agentconnect.md/protocol'
import {
  ChatInputQuestionKind as Question,
  ChatInputAnswerValueKind as Value,
  ChatInputAnswerState,
  type ChatInputQuestion,
  type ChatInputRequest,
  type ChatInputAnswer,
  type ChatInputAnswerValue
} from '@microsoft/agent-host-protocol'

export function ahpInputRequest(card: ElicitCard): ChatInputRequest {
  if (card.url) return { id: card.requestId, message: card.message, url: card.url }
  const fields: ElicitField[] = card.fields ?? [
    {
      ...card,
      propName: 'value',
      label: card.message,
      required: true,
      kind: card.text ? 'text' : card.number ? 'number' : card.multi ? 'multi-enum' : 'enum'
    }
  ]
  return { id: card.requestId, message: card.message, questions: fields.map(question) }
}

function question(field: ElicitField): ChatInputQuestion {
  const base = {
    id: field.propName,
    title: field.label,
    message: field.description ?? field.label,
    required: field.required
  }
  switch (field.kind) {
    case 'text':
      return {
        ...base,
        kind: Question.Text,
        format: field.text?.format,
        min: field.text?.minLength,
        max: field.text?.maxLength,
        ...(typeof field.defaultValue === 'string' ? { defaultValue: field.defaultValue } : {})
      }
    case 'number':
      return {
        ...base,
        kind: field.number?.integer ? Question.Integer : Question.Number,
        min: field.number?.minimum,
        max: field.number?.maximum,
        ...(typeof field.defaultValue === 'number' ? { defaultValue: field.defaultValue } : {})
      }
    case 'boolean':
      return {
        ...base,
        kind: Question.Boolean,
        ...(typeof field.defaultValue === 'boolean' ? { defaultValue: field.defaultValue } : {})
      }
    case 'enum':
      return {
        ...base,
        kind: Question.SingleSelect,
        options: field.options.map((option) => ({ id: option.value, label: option.label }))
      }
    case 'multi-enum':
      return {
        ...base,
        kind: Question.MultiSelect,
        options: field.options.map((option) => ({ id: option.value, label: option.label })),
        min: field.multi?.minItems,
        max: field.multi?.maxItems
      }
  }
}

export function ahpSubmittedAnswers(
  request: ChatInputRequest,
  values: Record<string, string | number | boolean | string[]>
): Record<string, ChatInputAnswer> {
  const answers: Record<string, ChatInputAnswer> = {}
  for (const question of request.questions ?? []) {
    const value = values[question.id]
    let result: ChatInputAnswerValue | undefined
    switch (question.kind) {
      case Question.Text:
        if (typeof value === 'string') result = { kind: Value.Text, value }
        break
      case Question.Number:
      case Question.Integer:
        if (typeof value === 'number' && Number.isFinite(value)) result = { kind: Value.Number, value }
        break
      case Question.Boolean:
        if (typeof value === 'boolean') result = { kind: Value.Boolean, value }
        break
      case Question.SingleSelect: {
        const selected = typeof value === 'boolean' ? String(value) : value
        if (typeof selected === 'string' && question.options.some((option) => option.id === selected))
          result = { kind: Value.Selected, value: selected }
        break
      }
      case Question.MultiSelect:
        if (Array.isArray(value)) result = { kind: Value.SelectedMany, value }
        break
    }
    if (result) answers[question.id] = { state: ChatInputAnswerState.Submitted, value: result }
  }
  return answers
}
