import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { MessageText } from '@/components/console/MessageText'
import { mergeConversation, type MergeSource } from '@/lib/conversation-merge'
import type { SessionMessageDto } from '@/lib/api'

/**
 * The §10 renderer seam, exercised with OVERRIDES INSTALLED — which the shipped
 * registry deliberately has none of, so the mechanism has to be tested against
 * a stand-in. What is under test is that the lookup happens PER ROW: a merged
 * conversation interleaves several sources by event time, so a renderer
 * resolved once for the page (or once per turn) would render one platform's
 * rows with another platform's semantics, silently, and only for users who
 * merged two platforms into one conversation.
 */
const { overrides } = vi.hoisted(() => ({ overrides: new Map<string, unknown>() }))

vi.mock('@/components/console/platforms/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./registry')>()
  return { ...actual, platformTextRenderer: (id?: string) => (id ? overrides.get(id) : undefined) }
})

function Marker({ text, tag }: { text: string; tag: string }) {
  return <span data-renderer={tag}>{text}</span>
}
overrides.set('slack', ({ text }: { text: string }) => <Marker text={text} tag="slack" />)
overrides.set('discord', ({ text }: { text: string }) => <Marker text={text} tag="discord" />)

let seq = 0
function row(over: Partial<SessionMessageDto>): SessionMessageDto {
  return { seq: ++seq, sender: 'user-1', ts: '1000', kind: 'text', text: 'hi', ...over }
}
function src(sessionId: string, platform: string, rows: SessionMessageDto[]): MergeSource {
  return { sessionId, agentId: `agent-${sessionId}`, platform, rows }
}

/** What SessionDetailView does per row: render the row's own text under the
 *  row's own platform. Kept to one expression so the test cannot accidentally
 *  hoist the lookup the production loop must not hoist either. */
function renderTranscript(rows: ReadonlyArray<{ text: string; platform: string }>): string {
  return renderToStaticMarkup(
    <>
      {rows.map((r, i) => (
        <MessageText key={i} text={r.text} platform={r.platform} />
      ))}
    </>
  )
}

describe('per-platform transcript text renderer', () => {
  it('resolves one renderer per row when two platforms interleave in a merged conversation', () => {
    // Two sources whose rows alternate on the normalized event-time axis, so
    // the merged order is s1, d1, s2, d2 — never grouped by source.
    const merged = mergeConversation([
      src('sess-a', 'slack', [
        row({ ts: '1754123456.000100', text: 's1' }),
        row({ ts: '1754123458.000100', text: 's2' })
      ]),
      src('sess-b', 'discord', [row({ ts: '1754123457000', text: 'd1' }), row({ ts: '1754123459000', text: 'd2' })])
    ])

    // The key each row will be rendered under travels WITH the row out of the
    // merge, so the view cannot pair a row with a neighbour's platform.
    expect(merged.map((m) => [m.row.text, m.sourcePlatform])).toEqual([
      ['s1', 'slack'],
      ['d1', 'discord'],
      ['s2', 'slack'],
      ['d2', 'discord']
    ])

    const markup = renderTranscript(merged.map((m) => ({ text: m.row.text, platform: m.sourcePlatform })))
    expect(markup).toBe(
      '<span data-renderer="slack">s1</span>' +
        '<span data-renderer="discord">d1</span>' +
        '<span data-renderer="slack">s2</span>' +
        '<span data-renderer="discord">d2</span>'
    )
  })

  it('falls back to the core default for an unknown key sitting between overridden rows', () => {
    // The fallback has to hold ROW-LOCALLY: an unrecognized platform in the
    // middle of a conversation renders through the default, and leaves its
    // neighbours on their own renderers.
    const markup = renderTranscript([
      { text: 'a', platform: 'slack' },
      { text: 'b', platform: 'zulip' },
      { text: 'c', platform: 'discord' }
    ])
    expect(markup).toBe(
      '<span data-renderer="slack">a</span>' +
        '<div class="mdtxt"><p>b</p></div>' +
        '<span data-renderer="discord">c</span>'
    )
  })

  it('does not memoize one row’s renderer onto the next', () => {
    // `MessageText` is memoized on its props; two rows with the SAME text and
    // different platforms must still resolve separately.
    expect(
      renderTranscript([
        { text: 'same', platform: 'slack' },
        { text: 'same', platform: 'discord' },
        { text: 'same', platform: 'telegram' }
      ])
    ).toBe(
      '<span data-renderer="slack">same</span>' +
        '<span data-renderer="discord">same</span>' +
        '<div class="mdtxt"><p>same</p></div>'
    )
  })
})
