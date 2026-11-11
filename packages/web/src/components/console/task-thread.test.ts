import { describe, expect, it } from 'vitest'
import type { SessionHistoryDto, SessionMessageDto } from '@/lib/api'
import type { SessionStep } from '@/lib/data'
import { threadMessages, threadPollMs, threadRows, unsavedLive, withoutAttribution } from './task-thread'

const row = (seq: number, sender: string, text: string, kind = 'text'): SessionMessageDto => ({
  seq,
  sender,
  ts: new Date(Date.UTC(2026, 10, 3, 9, seq)).toISOString(),
  kind,
  text
})

const page = (messages: SessionMessageDto[], nextCursor: string | null = null): SessionHistoryDto => ({
  sessionId: 'ses_task',
  messages,
  nextCursor,
  liveCursor: null,
  liveMore: false
})

describe('threadMessages', () => {
  it('keeps every row in order, plans, questions and settled ones included, as the session page reads them', () => {
    const rows = threadMessages(
      page([
        row(3, 'agent_1', 'Plan · 1/2', 'plan'),
        row(1, 'user_dana', 'go'),
        { ...row(2, 'agent_1', 'Ship it?', 'elicit'), body: JSON.stringify({ requestId: 'q', outcome: 'accepted' }) }
      ])
    )
    expect(rows.map((m) => [m.seq, m.kind])).toEqual([
      [1, 'text'],
      [2, 'elicit'],
      [3, 'plan']
    ])
  })
})

describe('threadRows', () => {
  it('leaves out the saved work of the reply this visit is streaming, which the live turn shows once', () => {
    const since = Date.UTC(2026, 10, 3, 9, 3)
    const saved = [
      row(1, 'user_dana', 'go'),
      row(2, 'agent_1', 'Thinking earlier', 'reasoning'),
      { ...row(4, 'agent_1', 'Checking', 'reasoning'), ts: new Date(since + 1000).toISOString() },
      { ...row(5, 'agent_1', 'pnpm test', 'tool'), toolCallId: 'c1' },
      { ...row(6, 'agent_1', 'gh pr list', 'tool'), toolCallId: 'c0' }
    ]
    const live: SessionStep[] = [
      { kind: 'msg', turnId: 't2', text: 'run the tests', observedAtMs: since },
      { kind: 'tool', turnId: 't2', text: 'pnpm test', toolCallId: 'c1', observedAtMs: since + 2000 }
    ]
    expect(threadRows(saved, live).map((m) => m.seq)).toEqual([1, 2, 6])
    expect(threadRows(saved, []).map((m) => m.seq)).toEqual([1, 2, 4, 5, 6])
  })
})

describe('unsavedLive', () => {
  it('draws a prompt this visit sent once, when the poll already reads it back while the reply runs', () => {
    const sent = Date.UTC(2026, 10, 3, 9, 5)
    const live: SessionStep[] = [
      { kind: 'msg', turnId: 't2', text: 'which computer?', observedAtMs: sent },
      { kind: 'tool', turnId: 't2', text: 'computer_list', toolCallId: 'c9', observedAtMs: sent + 3000 },
      { kind: 'msg', turnId: 't3', text: '  ', observedAtMs: sent + 4000 }
    ]
    const saved = [{ ...row(6, 'user_draco', 'which computer?'), ts: new Date(sent + 2000).toISOString() }]
    expect(unsavedLive(live, saved, 'agent_1').map((step) => step.kind)).toEqual(['tool'])
    // An earlier message with the same words is not this visit's prompt.
    const older = [row(1, 'user_dana', 'which computer?')]
    expect(unsavedLive(live, older, 'agent_1').map((step) => step.kind)).toEqual(['msg', 'tool'])
  })
})

describe('withoutAttribution', () => {
  it('drops a peer post’s trailing "sent by" line', () => {
    expect(
      withoutAttribution('I only handle support.\n\nsent by <https://console.example.test/acme/agents/a1|support>')
    ).toBe('I only handle support.')
  })
})

describe('threadPollMs', () => {
  const idle = () => false
  it('re-reads a thread whose task is starting or running as often as a running one, so its starting notice clears', () => {
    const quick = threadPollMs({ running: true }, idle)
    const slow = threadPollMs({}, idle)
    expect(quick).toBeLessThan(slow)
    expect(threadPollMs({ task: { sessionId: 'ses_task', state: 'open', starting: true } }, idle)).toBe(quick)
    expect(threadPollMs({ task: { sessionId: 'ses_task', state: 'done' } }, idle)).toBe(slow)
    expect(threadPollMs({ task: { sessionId: 'ses_task', state: 'done' } }, (id) => id === 'ses_task')).toBe(quick)
    expect(threadPollMs(undefined, idle)).toBe(slow)
  })
})
