// A Try sample is the live Jev state minus the fields its consumer binds (decisions.md §9.3); one parser for both editors.

import {
  ApiGateTryState,
  CodeHostTryState,
  ConversationTryState,
  RoutingTryState,
  type CodeHostRoutingFamily,
  type CodeHostRoutingProvider,
  type DecisionPreviewSample
} from '@agentconnect.md/protocol/decision'
import type { DecisionTargetConstraint } from '@agentconnect.md/protocol/decision-api'

export type TryLane = 'conversation' | 'routing' | 'api' | 'code_host'

export interface TryStates {
  conversation: ConversationTryState
  routing: RoutingTryState
  api: ApiGateTryState
  code_host: CodeHostTryState
}

interface TryIssue {
  code: string
  path: PropertyKey[]
  message: string
  keys?: string[]
}
type TrySchema<T> = {
  safeParse(raw: unknown): { success: true; data: T } | { success: false; error: { issues: TryIssue[] } }
}

const SCHEMAS: { [L in TryLane]: TrySchema<TryStates[L]> } = {
  conversation: ConversationTryState,
  routing: RoutingTryState,
  api: ApiGateTryState,
  code_host: CodeHostTryState
}

/** The top-level state fields each consumer fills in itself, shown folded as `…`. */
export const TRY_BOUND_KEYS: Record<TryLane, readonly string[]> = {
  conversation: ['agent', 'conversation', 'addressing', 'context'],
  routing: ['conversation', 'context'],
  api: ['source', 'agent', 'truncated'],
  code_host: ['source', 'repository', 'context']
}
// A message entry's own ids are synthetic in every preview.
const BOUND_ENTRY_KEYS = new Set(['id', 'threadId', 'time', 'truncated'])
const BOUND_ANYWHERE = new Set(['source', 'agent', 'truncated', 'conversation', 'addressing', 'context', 'repository'])

export type TryParseError =
  | { kind: 'json'; message: string }
  | { kind: 'shape' }
  | { kind: 'bound'; key: string }
  | { kind: 'schema'; path: string; message: string }

export type TryParse<L extends TryLane> = { ok: true; value: TryStates[L] } | { ok: false; error: TryParseError }

const pathOf = (path: ReadonlyArray<PropertyKey>) =>
  path
    .map((part) => (typeof part === 'number' ? `[${part}]` : `.${String(part)}`))
    .join('')
    .replace(/^\./, '')

/** Validate a state for a run: bound fields are refused by name, the rest by the protocol's schema. */
export function checkTryState<L extends TryLane>(lane: L, raw: unknown): TryParse<L> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: { kind: 'shape' } }
  const bound = Object.keys(raw).find((key) => TRY_BOUND_KEYS[lane].includes(key) || BOUND_ANYWHERE.has(key))
  if (bound && !(lane === 'routing' && bound === 'addressing'))
    return { ok: false, error: { kind: 'bound', key: bound } }
  const parsed = SCHEMAS[lane].safeParse(raw)
  if (parsed.success) return { ok: true, value: parsed.data }
  const issue = parsed.error.issues[0]!
  if (issue.code === 'unrecognized_keys' && issue.keys) {
    const key = issue.keys.find((k) => BOUND_ENTRY_KEYS.has(k) || BOUND_ANYWHERE.has(k))
    if (key) return { ok: false, error: { kind: 'bound', key: pathOf([...issue.path, key]) } }
  }
  return { ok: false, error: { kind: 'schema', path: pathOf(issue.path), message: issue.message } }
}

/** Parse Raw JSON; an empty current message still parses, so switching editors never loses a draft. */
export function parseTryState<L extends TryLane>(lane: L, text: string): TryParse<L> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (cause) {
    return { ok: false, error: { kind: 'json', message: cause instanceof Error ? cause.message : String(cause) } }
  }
  const current = (raw as { currentMessage?: { text?: unknown } } | null)?.currentMessage
  if (current && typeof current === 'object' && typeof current.text === 'string' && !current.text.trim()) {
    const blank = current.text
    const probe = structuredClone(raw) as { currentMessage: { text: string } }
    probe.currentMessage.text = '-'
    const result = checkTryState(lane, probe)
    if (result.ok) (result.value as { currentMessage: { text: string } }).currentMessage.text = blank
    return result
  }
  return checkTryState(lane, raw)
}

export const tryStateJson = (value: unknown) => JSON.stringify(value, null, 2)

/** The text a result card names the sample by. */
export const trySampleTitle = (value: { currentMessage: { text: string } }) => value.currentMessage.text.trim()

export function conversationTemplate(): ConversationTryState {
  return { currentMessage: { sender: { id: 'U0123ABCD' }, text: '' }, history: [] }
}

export function routingTemplate(): RoutingTryState {
  return {
    ...conversationTemplate(),
    addressing: { mentions: [], constraint: { eligibleAgentIds: [], participantAgentIds: [] } }
  }
}

export function apiTemplate(): ApiGateTryState {
  return { currentMessage: { text: '' }, history: [] }
}

/** A plausible first event of the scope's subject, as the provider's hook state names it. */
export function codeHostTemplate(provider: CodeHostRoutingProvider, family: CodeHostRoutingFamily): CodeHostTryState {
  const author = { login: 'reporter', type: 'User', association: 'NONE' }
  const currentMessage = { sender: { id: 'reporter', association: 'NONE' }, text: '' }
  if (family === 'issues')
    return {
      event: { name: 'issues', action: 'opened' },
      subject: { kind: 'issue', number: 42, title: 'Crash on start', author, labels: [], state: 'open', body: '' },
      currentMessage,
      history: []
    }
  const gitlab = provider === 'gitlab'
  return {
    event: gitlab ? { name: 'merge_request', action: 'open' } : { name: 'pull_request', action: 'opened' },
    subject: {
      kind: gitlab ? 'merge_request' : 'pull_request',
      number: 42,
      title: 'Handle an empty config',
      author,
      labels: [],
      state: 'open',
      draft: false,
      body: ''
    },
    currentMessage,
    history: [],
    pullRequest: {
      commitMessages: '',
      files: [
        { path: 'src/config.ts', status: 'modified', additions: 3, deletions: 1, diff: '', diffTruncated: false }
      ],
      filesTruncated: false
    }
  }
}

/** A conversation state as the gate preview's sample: sender ids flatten to the wire's strings. */
export function conversationSample(state: ConversationTryState): DecisionPreviewSample {
  const sender = state.currentMessage.sender?.id.trim()
  return {
    history: state.history.map((entry) => ({ sender: entry.sender.id, text: entry.text })),
    currentMessage: { ...(sender ? { sender } : {}), text: state.currentMessage.text.trim() }
  }
}

/** The routing situation the state's addressing names, as the router's own state would carry it. */
export function routingTargets(state: RoutingTryState): DecisionTargetConstraint {
  const mentions = [...new Set(state.addressing?.mentions ?? [])]
  const eligible = state.addressing?.constraint.eligibleAgentIds ?? []
  const participants = [...new Set(state.addressing?.constraint.participantAgentIds ?? [])]
  if (mentions.length)
    return {
      type: 'mention',
      agentIds: mentions,
      participantAgentIds: participants.filter((id) => mentions.includes(id))
    }
  const recipients = [...new Set([...eligible, ...participants])]
  if (recipients.length) return { type: 'thread', agentIds: recipients, participantAgentIds: participants }
  return { type: 'new' }
}
