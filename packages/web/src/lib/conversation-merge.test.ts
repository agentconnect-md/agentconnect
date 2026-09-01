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
  it('recognizes per-platform native id shapes; 13-digit local stamps never match any', () => {
    const SNOWFLAKE = '1101111111111111111'
    expect(duplicateIdentity('discord', row({ ts: SNOWFLAKE }))).toBe(`ts:${SNOWFLAKE}`)
    expect(duplicateIdentity('telegram', row({ ts: '4821' }))).toBe('ts:4821')
    expect(duplicateIdentity('feishu', row({ ts: 'om_abc123' }))).toBe('ts:om_abc123')
    for (const platform of ['discord', 'telegram', 'feishu', 'slack']) {
      expect(duplicateIdentity(platform, row({ ts: '1754123457123' }))).toBeNull()
    }
    // The 10-digit legacy-seconds era stays outside the Telegram predicate.
    expect(duplicateIdentity('telegram', row({ ts: '1754123456' }))).toBeNull()
  })

  it('is provenance-explicit — integer monotonicTs values never match the Slack predicate', () => {
    expect(duplicateIdentity('slack', row({ ts: '1754123456.000200' }))).toBe('ts:1754123456.000200')
    expect(duplicateIdentity('slack', row({ ts: '1754123457123' }))).toBeNull()
    expect(duplicateIdentity('webchat', row({ postId: POST }))).toBe(`post:${POST}`)
    expect(duplicateIdentity('webchat', row({ ts: '1000' }))).toBeNull()
    // Work-lane rows never dedupe, whatever their coordinates claim.
    expect(duplicateIdentity('slack', row({ kind: 'tool', ts: '1754123456.000200' }))).toBeNull()
    expect(duplicateIdentity('webchat', row({ kind: 'reasoning', postId: POST }))).toBeNull()
  })

  it('dedupes nothing under a platform id no module claims', () => {
    // The rule used to be Slack's for every unrecognized id, because Slack was
    // the fall-through arm of the if-chain. The published module contract says
    // the opposite — absent `messageIdentity` ⇒ never dedupe — and dedupe is
    // the only step here that can delete a row, so the guess goes the other
    // way now. A Slack-SHAPED ts under an unknown id is the case that changed.
    for (const platform of ['zulip', 'hook', 'github', 'playground', 'Slack', '']) {
      expect(duplicateIdentity(platform, row({ ts: '1754123456.000200' })), platform).toBeNull()
      expect(duplicateIdentity(platform, row({ postId: POST })), platform).toBeNull()
    }
    // Prototype keys are ids like any other — the registry is a Map, so they
    // resolve to no module rather than to `Object.prototype`.
    expect(duplicateIdentity('constructor', row({ ts: '1754123456.000200' }))).toBeNull()
    expect(duplicateIdentity('__proto__', row({ ts: '1754123456.000200' }))).toBeNull()
    // The registered ids keep theirs.
    expect(duplicateIdentity('slack', row({ ts: '1754123456.000200' }))).toBe('ts:1754123456.000200')
  })
})

describe('mergeConversation', () => {
  it('keeps each rendered tool row tied to its source session', () => {
    const merged = mergeConversation([
      src(A, 'slack', [row({ sender: A, kind: 'tool', toolCallId: 'tool-a', body: '{"toolCallId":"tool-a"}' })]),
      src(B, 'slack', [row({ sender: B, kind: 'tool', toolCallId: 'tool-b', body: '{"toolCallId":"tool-b"}' })])
    ])

    expect(merged.map(({ row, sourceSessionId }) => ({ toolCallId: row.toolCallId, sourceSessionId }))).toEqual([
      { toolCallId: 'tool-a', sourceSessionId: 'sess-aaaa' },
      { toolCallId: 'tool-b', sourceSessionId: 'sess-bbbb' }
    ])
  })

  it('preserves each source-local bot turn when private work interleaves', () => {
    const triggerTs = '1754123456.000000'
    const nextTriggerTs = '1754123457.000000'
    const merged = mergeConversation([
      src(A, 'slack', [
        row({ sender: 'U-HUMAN', ts: triggerTs, text: 'start' }),
        row({ sender: A, kind: 'reasoning', ts: '1754123456100', text: 'a-think' }),
        row({ sender: A, kind: 'tool', ts: '1754123456300', text: 'a-tool' }),
        row({ sender: A, ts: '1754123456500', text: 'a-answer' }),
        row({ sender: 'U-HUMAN', ts: nextTriggerTs, text: 'next' }),
        row({ sender: A, kind: 'reasoning', ts: '1754123457100', text: 'a-next-turn' })
      ]),
      src(B, 'slack', [
        row({ sender: 'U-HUMAN', ts: triggerTs, text: 'start' }),
        row({ sender: B, kind: 'reasoning', ts: '1754123456200', text: 'b-think' }),
        row({ sender: B, ts: '1754123456400', text: 'b-answer' }),
        row({ sender: 'U-HUMAN', ts: nextTriggerTs, text: 'next' })
      ])
    ])

    expect(merged.map(({ row }) => row.text)).toEqual([
      'start',
      'a-think',
      'b-think',
      'a-tool',
      'b-answer',
      'a-answer',
      'next',
      'a-next-turn'
    ])
    const turnKeyByText = Object.fromEntries(merged.map(({ row, sourceTurnKey }) => [row.text, sourceTurnKey]))
    expect(turnKeyByText['a-think']).toBe(turnKeyByText['a-tool'])
    expect(turnKeyByText['a-tool']).toBe(turnKeyByText['a-answer'])
    expect(turnKeyByText['b-think']).toBe(turnKeyByText['b-answer'])
    expect(turnKeyByText['a-think']).not.toBe(turnKeyByText['b-think'])
    expect(turnKeyByText['a-next-turn']).not.toBe(turnKeyByText['a-answer'])
  })

  it('dedupes Discord copies on the snowflake and orders them by its embedded time', () => {
    // Snowflake for ~2024: time bits decode via (id >> 22) + Discord epoch.
    const SNOWFLAKE = '1101111111111111111'
    const merged = mergeConversation([
      src(A, 'discord', [
        row({ sender: 'U-HUMAN', ts: SNOWFLAKE, text: 'thread msg' }),
        row({ sender: A, kind: 'reasoning', ts: '1754123457123', text: 'thinking' })
      ]),
      src(B, 'discord', [row({ sender: 'U-HUMAN', ts: SNOWFLAKE, text: 'thread msg' })])
    ])
    expect(merged.filter((m) => m.row.text === 'thread msg')).toHaveLength(1)
    // The snowflake must NOT overflow to epoch-0: its decoded time (2023+)
    // sorts near the daemon-ms work row, not before everything.
    expect(transcriptEventTimeUs(SNOWFLAKE)).toBeGreaterThan(1_600_000_000_000_000)
  })

  it('orders Telegram rows by the daemon-stored event time, not the sequence id', () => {
    // TG message ids are per-chat sequences (no embedded time): the daemon
    // stamps eventTimeUs from message.date; the merge must prefer it over
    // deriving from the id (which would read as 1970s seconds).
    const merged = mergeConversation([
      src(A, 'telegram', [
        row({ sender: 'tg-user', ts: '4821', eventTimeUs: 1_754_123_458_000_000, text: 'later' }),
        row({ sender: A, ts: '1754123457123', text: 'agent reply' })
      ])
    ])
    expect(merged.map((m) => m.row.text)).toEqual(['agent reply', 'later'])
  })

  it('dedupes Feishu copies on the om_ message id', () => {
    const merged = mergeConversation([
      src(A, 'feishu', [row({ sender: 'U-H', ts: 'om_xyz', eventTimeUs: 1_754_123_456_000_000, text: 'hello' })]),
      src(B, 'feishu', [row({ sender: 'U-H', ts: 'om_xyz', eventTimeUs: 1_754_123_456_000_000, text: 'hello' })])
    ])
    expect(merged).toHaveLength(1)
  })

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

  it('keeps both copies when the platform id is one no module claims', () => {
    // The blast radius of the fall-through removal, end to end: two sources of
    // an unrecognized platform carrying the same Slack-shaped ts used to
    // collapse into one row, and now render as two. Fail-open by design —
    // "toward a visible duplicate, never toward data loss" (§6).
    const platformTs = '1754123456.000200'
    const merged = mergeConversation([
      src(A, 'zulip', [row({ sender: 'U-HUMAN', ts: platformTs, text: 'hello' })]),
      src(B, 'zulip', [row({ sender: 'U-HUMAN', ts: platformTs, text: 'hello' })])
    ])
    expect(merged).toHaveLength(2)
  })

  it('carries each row’s own source platform out of the merge', () => {
    // The transcript resolves its text renderer from this key (§10), so it has
    // to survive the interleave that mixes the sources up.
    const merged = mergeConversation([
      src(A, 'slack', [row({ ts: '1754123456.000100', text: 's1' }), row({ ts: '1754123458.000100', text: 's2' })]),
      src(B, 'telegram', [
        row({ ts: '4821', eventTimeUs: 1_754_123_457_000_000, text: 't1' }),
        row({ ts: '4822', eventTimeUs: 1_754_123_459_000_000, text: 't2' })
      ])
    ])
    expect(merged.map((m) => [m.row.text, m.sourcePlatform])).toEqual([
      ['s1', 'slack'],
      ['t1', 'telegram'],
      ['s2', 'slack'],
      ['t2', 'telegram']
    ])
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
