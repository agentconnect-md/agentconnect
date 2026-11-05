import { describe, expect, it } from 'vitest'
import type { SessionHistoryDto, SessionMessageDto } from '@/lib/api'
import type { SessionStep } from '@/lib/data'
import { threadEntries, threadMessages } from './task-thread'

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

describe('threadEntries', () => {
  it('draws the spoken record in order, then what this visit sent and is streaming back', () => {
    const live: SessionStep[] = [
      { kind: 'msg', turnId: 't1', text: 'what about #1291?' },
      { kind: 'plan', turnId: 't1', text: 'checking CI' },
      { kind: 'done', turnId: 't1', text: 'CI is rerunning.' },
      { kind: 'msg', turnId: 't0', text: 'already on record', hidden: true }
    ]
    const entries = threadEntries(
      threadMessages(
        page([row(2, 'agent_1', 'On it'), row(3, 'agent_1', 'gh pr list', 'tool'), row(1, 'user_dana', 'go')])
      ),
      live,
      'agent_1'
    )
    expect(entries.map((e) => [e.who, e.text, e.live])).toEqual([
      ['person', 'go', false],
      ['agent', 'On it', false],
      ['person', 'what about #1291?', true],
      ['agent', 'CI is rerunning.', true]
    ])
  })

  it('keeps the agent’s open question, recorded or live, once, and says how the panel can answer it', () => {
    const ask = (requestId: string, extra: Record<string, unknown> = {}) => ({
      requestId,
      options: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' }
      ],
      ...extra
    })
    const recorded = {
      ...row(3, 'agent_1', 'Ship it?', 'elicit'),
      body: JSON.stringify(ask('q-recorded'))
    }
    const settled = {
      ...row(4, 'agent_1', 'Old question', 'elicit'),
      body: JSON.stringify(ask('q-settled', { outcome: 'accepted' }))
    }
    const live: SessionStep[] = [
      { kind: 'elicit', turnId: 't2', text: 'Ship it?', elicit: ask('q-recorded') },
      { kind: 'elicit', turnId: 't2', text: '', elicit: { requestId: 'q-text', options: [], text: { minLength: 5 } } },
      { kind: 'elicit', turnId: 't2', text: 'Fill the form', elicit: { requestId: 'q-form', options: [], fields: [] } }
    ]
    const entries = threadEntries(threadMessages(page([recorded, settled])), live, 'agent_1')
    expect(entries.map((e) => [e.text, e.question])).toEqual([
      ['Ship it?', { requestId: 'q-recorded', choices: ask('q-recorded').options, text: null }],
      ['', { requestId: 'q-text', choices: null, text: { minLength: 5 } }],
      ['Fill the form', { requestId: 'q-form', choices: null, text: null }]
    ])
  })

  it('makes one agent turn of its consecutive work and replies, each reply its own block', () => {
    const entries = threadEntries(
      threadMessages(
        page([
          row(1, 'user_dana', 'go'),
          row(2, 'agent_1', 'Planning', 'reasoning'),
          row(3, 'agent_1', 'gh pr list', 'tool'),
          row(4, 'agent_1', 'Three are clear.'),
          row(5, 'agent_1', 'Two need review.'),
          row(6, 'bot_peer', 'Noted.'),
          row(7, 'agent_1', 'Thanks.')
        ])
      ),
      [
        { kind: 'tool', turnId: 't1', text: 'pnpm test', toolCallId: 'c1', toolStatus: 'in_progress' },
        { kind: 'done', turnId: 't1', text: 'Tests are running.' }
      ],
      'agent_1',
      (m) => (m.sender === 'bot_peer' ? 'agent_peer' : undefined)
    )
    expect(entries.map((e) => [e.who, e.prose ?? e.text, (e.work ?? []).map((w) => w.lane), e.live])).toEqual([
      ['person', 'go', [], false],
      ['agent', ['Three are clear.', 'Two need review.'], ['THINK', 'TOOL'], false],
      ['agent', 'Noted.', [], false],
      ['agent', ['Thanks.'], [], false],
      ['agent', ['Tests are running.'], ['TOOL'], true]
    ])
  })
})
