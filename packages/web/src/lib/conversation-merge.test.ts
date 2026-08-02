import { describe, expect, it } from 'vitest'
import { duplicateIdentity, mergeConversation, transcriptEventTimeUs, type MergeSource } from './conversation-merge'
import type { SessionMessageDto } from '@/lib/api'

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const POST = 'c0c0c0c0-cccc-4ccc-8ccc-cccccccccccc'

let seq = 0
function row(over: Partial<SessionMessageDto>): SessionMessageDto {
  return { seq: ++seq, sender: 'user-1', ts: '1000', kind: 'text', text: 'hi', ...over }
}
function src(agentId: string, platform: string, rows: SessionMessageDto[]): MergeSource {
  return { sessionId: `sess-${agentId.slice(0, 4)}`, agentId, platform, rows }
}

describe('transcriptEventTimeUs', () => {
  it('normalizes every stored form onto one microsecond axis', () => {
    // Slack decimal seconds vs a daemon millisecond stamp one second later.
    expect(transcriptEventTimeUs('1754123456.000200')).toBe(1_754_123_456_000_200)
    expect(transcriptEventTimeUs('1754123457123')).toBe(1_754_123_457_123_000)
    expect(transcriptEventTimeUs('1754123456.000200')).toBeLessThan(transcriptEventTimeUs('1754123457123'))
    // local- prefix and hook |suffix forms; 10-digit-era integer seconds.
    expect(transcriptEventTimeUs('local-1754123457123')).toBe(1_754_123_457_123_000)
    expect(transcriptEventTimeUs('1754123457123|delivery-1')).toBe(1_754_123_457_123_000)
    expect(transcriptEventTimeUs('1754123456')).toBe(1_754_123_456_000_000)
    expect(transcriptEventTimeUs('garbage')).toBe(0)
  })
})

describe('duplicateIdentity', () => {
  it('is provenance-explicit — integer monotonicTs values never match the Slack predicate', () => {
    expect(duplicateIdentity('slack', row({ ts: '1754123456.000200' }))).toBe('ts:1754123456.000200')
    expect(duplicateIdentity('slack', row({ ts: '1754123457123' }))).toBeNull()
    expect(duplicateIdentity('webchat', row({ postId: POST }))).toBe(`post:${POST}`)
    expect(duplicateIdentity('webchat', row({ ts: '1000' }))).toBeNull()
    // Work-lane rows never dedupe, whatever their coordinates claim.
    expect(duplicateIdentity('slack', row({ kind: 'tool', ts: '1754123456.000200' }))).toBeNull()
    expect(duplicateIdentity('webchat', row({ kind: 'reasoning', postId: POST }))).toBeNull()
  })
})

describe('mergeConversation', () => {
  it('dedupes webchat copies by postId with author-copy precedence, surviving a collision bump', () => {
    // B's copy of A's post got collision-bumped (+1ms): raw-ts equality would
    // miss it, postId identifies it regardless. The author copy (A's) wins.
    const merged = mergeConversation([
      src(B, 'webchat', [row({ sender: A, postId: POST, ts: '1001', text: 'answer', trustedAgentBot: true })]),
      src(A, 'webchat', [row({ sender: A, postId: POST, ts: '1000', text: 'answer' })])
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]!.authorCopy).toBe(true)
    expect(merged[0]!.sourceAgentId).toBe(A)
    expect(merged[0]!.row.ts).toBe('1000')
  })

  it('never merges a same-millisecond local report-back with a distinct canonical post', () => {
    // The §6 data-loss case: A's transcript holds a daemon-local a2a
    // report-back at ms 5000 (no postId); B's holds a distinct canonical post
    // whose at collides on the same millisecond. Both must render.
    const merged = mergeConversation([
      src(A, 'webchat', [row({ sender: 'peer-agent', ts: '5000', text: 'report-back' })]),
      src(B, 'webchat', [row({ sender: 'user-1', ts: '5000', postId: POST, text: 'question' })])
    ])
    expect(merged.map((m) => m.row.text).sort()).toEqual(['question', 'report-back'])
  })

  it('dedupes Slack copies only on the provider-native decimal ts', () => {
    const platformTs = '1754123456.000200'
    const merged = mergeConversation([
      src(A, 'slack', [
        row({ sender: 'U-HUMAN', ts: platformTs, text: 'thread msg' }),
        row({ sender: A, ts: '1754123457123', text: 'a2a note from A' })
      ]),
      src(B, 'slack', [
        row({ sender: 'U-HUMAN', ts: platformTs, text: 'thread msg' }),
        // Distinct daemon-local row minting the SAME millisecond on another
        // daemon — raw equality would discard one; both must survive.
        row({ sender: B, ts: '1754123457123', text: 'a2a note from B' })
      ])
    ])
    expect(merged.filter((m) => m.row.text === 'thread msg')).toHaveLength(1)
    expect(merged.map((m) => m.row.text).filter((t) => t.startsWith('a2a'))).toHaveLength(2)
  })

  it('keeps the human copy from the first source when no author copy exists', () => {
    const platformTs = '1754123456.000200'
    const merged = mergeConversation([
      src(A, 'slack', [row({ sender: 'U-HUMAN', ts: platformTs, text: 'hello', senderName: 'Dana' })]),
      src(B, 'slack', [row({ sender: 'U-HUMAN', ts: platformTs, text: 'hello' })])
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]!.sourceAgentId).toBe(A)
    expect(merged[0]!.row.senderName).toBe('Dana')
  })

  it('never reorders same-source rows that share a normalized timestamp', () => {
    // Regression (review finding): a sender-first tie-break flipped
    // ['first', 'second'] because 'z' > 'a'. Source order must decide.
    const merged = mergeConversation([
      src(A, 'slack', [
        row({ sender: 'z-user', ts: '5000', text: 'first' }),
        row({ sender: 'a-user', ts: '5000', text: 'second' })
      ])
    ])
    expect(merged.map((m) => m.row.text)).toEqual(['first', 'second'])
  })

  it('orders on the normalized axis with per-source stability', () => {
    // Slack text (seconds domain) must interleave with work rows (ms domain)
    // chronologically, and each source's internal order survives ties.
    const merged = mergeConversation([
      src(A, 'slack', [
        row({ sender: 'U-HUMAN', ts: '1754123456.000200', text: 'first' }),
        row({ sender: A, kind: 'reasoning', ts: '1754123456500', text: 'thinking' }),
        row({ sender: A, ts: '1754123457123', text: 'answer' })
      ])
    ])
    expect(merged.map((m) => m.row.text)).toEqual(['first', 'thinking', 'answer'])
  })
})
