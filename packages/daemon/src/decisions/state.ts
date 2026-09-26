import type { DecisionQuestion } from '@agentconnect.md/protocol'
import { transcriptQuoted, type ChannelTextRow } from '../store/local-store.js'
import { DECISION_REQUEST_MAX_BYTES, decisionRequestBody } from './evaluator.js'

/** decisions.md §8.2: the whole request targets this many tokens, estimated at four bytes each. */
export const DECISION_TOKEN_BUDGET = 8_000
const BYTES_PER_TOKEN = 4
/** decisions.md §8.1: one history entry's text cap; the current message is never truncated. */
export const DECISION_HISTORY_ENTRY_MAX_BYTES = 16 * 1024

export interface DecisionStateInput {
  source?: 'chat'
  current: ChannelTextRow
  /** Newest-first, as `LocalStore.decisionWindow` returns it. */
  history: readonly ChannelTextRow[]
  conversation?: { name?: string }
  addressing: {
    mentions: readonly string[]
    /** A gate's bound target; a router has none before its selection. */
    target?: { agentId: string; via: 'mention' | 'implicit' }
    /** A router's target constraint (message-intake.md §6 step 2). */
    constraint?: { eligibleAgentIds: readonly string[]; participantAgentIds: readonly string[] }
  }
  /** The read window was full, so older rows exist outside it. */
  full: boolean
  /** This record of the conversation began after the conversation did. */
  rootMissing: boolean
  forwardedHistory?: boolean
  question: DecisionQuestion
  model: string
}

export type DecisionStateResult =
  | { unsupported: true }
  | { unsupported?: false; state: Record<string, unknown>; omittedMessages: number; reasons: string[] }

export interface DecisionStateEntry {
  id: string
  sender: { id: string }
  text: string
  quote?: { sender?: string; text: string }
  threadId: string | null
  time?: string
  truncated?: true
}

function truncateUtf8(text: string, max: number): string | undefined {
  if (Buffer.byteLength(text, 'utf8') <= max) return undefined
  let out = Buffer.from(text, 'utf8').subarray(0, max).toString('utf8')
  while (Buffer.byteLength(out, 'utf8') > max) out = out.slice(0, -1)
  return out.replace(/�$/, '')
}

/** One transcript row as the state names it; history entries are capped, the current message never. */
export function decisionEntryOf(row: ChannelTextRow, truncate: boolean): DecisionStateEntry {
  const quoted = transcriptQuoted(row)
  const cut = truncate ? truncateUtf8(row.text, DECISION_HISTORY_ENTRY_MAX_BYTES) : undefined
  return {
    id: row.ts ?? String(row.seq),
    sender: { id: row.sender },
    text: cut ?? row.text,
    ...(quoted?.text ? { quote: { ...(quoted.sender ? { sender: quoted.sender } : {}), text: quoted.text } } : {}),
    threadId: row.thread,
    ...(row.eventTimeUs ? { time: new Date(Math.floor(row.eventTimeUs / 1000)).toISOString() } : {}),
    ...(cut !== undefined ? { truncated: true as const } : {})
  }
}

/** Whether a state's whole request fits the byte cap and the estimated token budget (decisions.md §8.2). */
export function fitsDecisionBudget(state: Record<string, unknown>, question: DecisionQuestion, model: string): boolean {
  const bytes = Buffer.byteLength(decisionRequestBody({ decision: { model, question }, state }), 'utf8')
  return bytes <= DECISION_REQUEST_MAX_BYTES && Math.ceil(bytes / BYTES_PER_TOKEN) <= DECISION_TOKEN_BUDGET
}

export type DecisionStateBudget = { question: DecisionQuestion; model: string }

type DecisionStateTextField = readonly [
  object: Record<string, unknown> | undefined,
  field: string,
  reason: string,
  truncate?: (text: string, maxBytes: number) => string
]

// State bytes are identical across requests, so the largest envelope budgets every step or chunk.
export function largestDecisionRequest<T extends DecisionStateBudget>(decisions: readonly [T, ...T[]]): T {
  const size = (decision: T) => Buffer.byteLength(decisionRequestBody({ decision, state: {} }), 'utf8')
  return decisions.reduce((largest, decision) => (size(decision) > size(largest) ? decision : largest))
}

export function decisionTextPrefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8')
  let end = Math.min(bytes.length, maxBytes)
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString('utf8')
}

// Every consumer trims a copy, preserving the trigger and identity while spending the same request budget.
export function fitDecisionState(
  input: Record<string, unknown>,
  decision: DecisionStateBudget,
  textFields: (state: Record<string, unknown>) => readonly DecisionStateTextField[] = () => []
): DecisionStateResult {
  const state = structuredClone(input)
  const history = (state.history ?? []) as unknown[]
  const context = (state.context ?? {}) as Record<string, unknown>
  const reasons = [...((context.reasons ?? []) as string[])]
  let omitted = (context.omittedMessages as number | undefined) ?? 0
  state.history = history
  state.context = context
  const update = () => {
    Object.assign(context, {
      partial: context.partial === true || reasons.length > 0,
      reasons,
      omittedMessages: omitted
    })
  }
  const mark = (reason: string) => {
    if (!reasons.includes(reason)) reasons.push(reason)
    update()
  }
  update()
  const fits = () => fitsDecisionBudget(state, decision.question, decision.model)
  while (!fits() && history.length) {
    history.shift()
    omitted++
    mark('budget_trimmed')
  }
  for (const [object, field, reason, truncate = decisionTextPrefix] of textFields(state)) {
    while (!fits() && object && typeof object[field] === 'string' && object[field]) {
      object[field] = truncate(object[field], Math.floor(Buffer.byteLength(object[field]) / 2))
      mark('budget_trimmed')
      mark(reason)
    }
  }
  return fits() ? { state, omittedMessages: omitted, reasons } : { unsupported: true }
}

/** Build the frozen Jev state at a verdict's row: newest history that fits, presented oldest-first. */
export function buildDecisionState(input: DecisionStateInput): DecisionStateResult {
  const current = decisionEntryOf(input.current, false)
  const candidates = input.history.map((row) => decisionEntryOf(row, true))
  const reasons: string[] = []
  if (input.full) reasons.push('history_limit')
  if (current.threadId === null || candidates.some((entry) => entry.threadId === null))
    reasons.push('legacy_thread_unknown')
  if (input.rootMissing) reasons.push('observation_started_after_conversation')
  if (input.forwardedHistory) reasons.push('forwarded_history')
  return fitDecisionState(
    {
      ...(input.source ? { source: input.source } : {}),
      currentMessage: current,
      history: candidates.reverse(),
      conversation: input.conversation ?? {},
      addressing: {
        mentions: [...input.addressing.mentions],
        ...(input.addressing.target ? { target: input.addressing.target } : {}),
        ...(input.addressing.constraint
          ? {
              constraint: {
                eligibleAgentIds: [...input.addressing.constraint.eligibleAgentIds],
                participantAgentIds: [...input.addressing.constraint.participantAgentIds]
              }
            }
          : {})
      },
      context: {
        partial: reasons.length > 0,
        reasons,
        omittedMessages: 0,
        snapshotSequence: input.current.seq,
        tokenCount: 'estimate'
      }
    },
    input
  )
}
