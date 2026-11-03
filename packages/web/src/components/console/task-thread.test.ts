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
})
