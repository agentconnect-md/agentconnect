import { describe, expect, it } from 'vitest'
import type { SessionMessageDto } from '@/lib/api'
import { lastAgentReply, replyExcerpt } from './use-last-reply'

const row = (seq: number, sender: string, text: string, kind = 'text'): SessionMessageDto =>
  ({ seq, sender, ts: '2026-01-01T00:00:00.000Z', kind, text }) as SessionMessageDto

describe('lastAgentReply', () => {
  const agents = new Set(['agent-1'])

  it('picks the newest agent text row, whatever order the page arrives in', () => {
    const page = [row(5, 'agent-1', 'Done.'), row(2, 'agent-1', 'Working'), row(6, 'user-1', 'thanks')]
    expect(lastAgentReply(page, agents)).toBe('Done.')
  })

  it('skips tool rows and replies that hold only a code fence', () => {
    const page = [
      row(1, 'agent-1', 'Opened the PR'),
      row(2, 'agent-1', '```\nls\n```'),
      row(3, 'agent-1', 'ls', 'tool')
    ]
    expect(lastAgentReply(page, agents)).toBe('Opened the PR')
  })

  it('is null when no agent has answered', () => {
    expect(lastAgentReply([row(1, 'user-1', 'hi')], agents)).toBeNull()
  })
})

describe('replyExcerpt', () => {
  it('flattens markdown to one line and keeps identifiers intact', () => {
    expect(replyExcerpt('## Summary\n\n- **Fixed** `session_meta` read\n> note')).toBe(
      'Summary Fixed session_meta read note'
    )
  })
})
