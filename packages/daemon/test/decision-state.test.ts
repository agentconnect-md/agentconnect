import { describe, expect, it } from 'vitest'
import type { DecisionQuestion } from '@agentconnect.md/protocol'
import { decisionRequestBody } from '../src/decisions/evaluator.js'
import { buildDecisionState, DECISION_HISTORY_ENTRY_MAX_BYTES } from '../src/decisions/state.js'
import type { ChannelTextRow } from '../src/store/local-store.js'

// decisions.md §8.2 / message-intake.md §9: the frozen Jev state, budgeted against the exact request body.

const question: DecisionQuestion = {
  type: 'boolean',
  instructions: 'Is help needed?',
  criteria: { true: 'Yes', false: 'No' }
}
const row = (seq: number, over: Partial<ChannelTextRow> = {}): ChannelTextRow => ({
  seq,
  thread: `T${seq}`,
  ts: `ts-${seq}`,
  sender: `U${seq % 3}`,
  text: `message ${seq}`,
  body: null,
  quoteJson: null,
  eventTimeUs: 1_720_000_000_000_000 + seq,
  kind: 'text',
  ...over
})
const build = (
  current: ChannelTextRow,
  history: ChannelTextRow[],
  over: { full?: boolean; rootMissing?: boolean } = {}
) =>
  buildDecisionState({
    current,
    history: [...history].reverse(),
    addressing: { mentions: [], target: { agentId: 'bot-a', via: 'implicit' } },
    full: over.full ?? false,
    rootMissing: over.rootMissing ?? false,
    question,
    model: 'jev-1.13.0'
  })
const bytes = (state: Record<string, unknown>): number =>
  Buffer.byteLength(decisionRequestBody({ decision: { model: 'jev-1.13.0', question }, state }), 'utf8')

describe('buildDecisionState', () => {
  it('presents history oldest-first with the current message outside it', () => {
    const result = build(row(4), [row(1), row(2), row(3)])
    if (result.unsupported) throw new Error('unsupported')
    const state = result.state as { currentMessage: { id: string }; history: { id: string }[]; context: unknown }
    expect(state.currentMessage.id).toBe('ts-4')
    expect(state.history.map((e) => e.id)).toEqual(['ts-1', 'ts-2', 'ts-3'])
    expect(state.context).toMatchObject({ partial: false, reasons: [], omittedMessages: 0, snapshotSequence: 4 })
  })

  it('trims from the oldest end to the exact 32 KiB request body and counts what it dropped', () => {
    const history = Array.from({ length: 40 }, (_, i) => row(i + 1, { text: 'x'.repeat(2_000) }))
    const result = build(row(100), history)
    if (result.unsupported) throw new Error('unsupported')
    const kept = (result.state.history as { id: string }[]).map((e) => e.id)
    expect(result.omittedMessages).toBeGreaterThan(0)
    expect(kept.at(-1)).toBe('ts-40')
    expect(kept[0]).toBe(`ts-${result.omittedMessages + 1}`)
    expect(bytes(result.state)).toBeLessThanOrEqual(32 * 1024)
    expect(result.reasons).toContain('budget_trimmed')
    expect(result.state.context).toMatchObject({ partial: true, omittedMessages: result.omittedMessages })
  })

  it('truncates an oversized history entry and marks it', () => {
    const result = build(row(2), [row(1, { text: 'y'.repeat(DECISION_HISTORY_ENTRY_MAX_BYTES + 500) })])
    if (result.unsupported) throw new Error('unsupported')
    const [entry] = result.state.history as { text: string; truncated?: boolean }[]
    expect(entry?.truncated).toBe(true)
    expect(Buffer.byteLength(entry!.text, 'utf8')).toBe(DECISION_HISTORY_ENTRY_MAX_BYTES)
  })

  it('never truncates the current message: one that cannot fit is unsupported', () => {
    expect(build(row(2, { text: 'z'.repeat(40 * 1024) }), [row(1)])).toEqual({ unsupported: true })
  })

  it('reports legacy thread-unknown rows with a null threadId', () => {
    const result = build(row(3), [row(1, { thread: null }), row(2)])
    if (result.unsupported) throw new Error('unsupported')
    expect((result.state.history as { threadId: string | null }[])[0]?.threadId).toBeNull()
    expect(result.reasons).toEqual(['legacy_thread_unknown'])
  })

  it('marks a full window and a record that began after the conversation', () => {
    const result = build(row(3), [row(1), row(2)], { full: true, rootMissing: true })
    if (result.unsupported) throw new Error('unsupported')
    expect(result.reasons).toEqual(['history_limit', 'observation_started_after_conversation'])
    expect(result.state.context).toMatchObject({ partial: true })
  })
})
