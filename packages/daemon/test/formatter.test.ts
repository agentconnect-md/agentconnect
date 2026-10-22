import { describe, it, expect } from 'vitest'
import { splitIntoSections } from '../src/slack/formatter.js'

describe('splitIntoSections', () => {
  it('returns no sections for whitespace-only input', () => {
    expect(splitIntoSections('   \n ')).toEqual([])
  })

  it('returns a single section when under the limit', () => {
    expect(splitIntoSections('short text', 3000)).toEqual(['short text'])
  })

  it('splits on line boundaries and never loses content', () => {
    const a = 'a'.repeat(60)
    const b = 'b'.repeat(60)
    const c = 'c'.repeat(60)
    const sections = splitIntoSections([a, b, c].join('\n'), 100)
    expect(sections.length).toBeGreaterThan(1)
    expect(sections.every((s) => s.length <= 100)).toBe(true)
    expect(sections.join('')).toBe([a, b, c].join('\n'))
  })

  it('preserves a newline exactly at the section boundary', () => {
    const text = `${'a'.repeat(100)}\nsecond section`
    const sections = splitIntoSections(text, 100)
    expect(sections).toEqual(['a'.repeat(100), '\nsecond section'])
    expect(sections.join('')).toBe(text)
  })

  it('hard-cuts a single line longer than the limit', () => {
    const sections = splitIntoSections('x'.repeat(250), 100)
    expect(sections).toEqual(['x'.repeat(100), 'x'.repeat(100), 'x'.repeat(50)])
  })

  it('preserves the agent markdown verbatim within a section (no mrkdwn conversion)', () => {
    const md = 'see **bold** and [docs](https://x.io)\n- one\n- two'
    expect(splitIntoSections(md)).toEqual([md])
  })

  it('keeps a table in one section when its raw text fits', () => {
    const text = ['| Implementation detail | Verification result |', '|---|---|', ...Array(250).fill('| a | b |')].join(
      '\n'
    )
    expect(splitIntoSections(text, 3000)).toEqual([text])
  })

  // Mention-safe splitting preserves peer delivery (send-message-routing-rework.md §5.3).
  describe('mention-safe boundaries (§5.3)', () => {
    it('never hard-cuts a dedicated agent mention, and rejoins to the exact input', () => {
      // The hard cut at maxLen would otherwise land inside `<@U_REVIEWER>`.
      const text = `${'x'.repeat(95)}<@U_REVIEWER> please verify`
      const sections = splitIntoSections(text, 100)
      expect(sections.join('')).toBe(text)
      expect(sections.some((s) => s.includes('<@U_REVIEWER>'))).toBe(true)
      // The address opens the following section whole, rather than straddling the cut.
      expect(sections[1]!.startsWith('<@U_REVIEWER>')).toBe(true)
      expect(sections.every((s) => s.length <= 100)).toBe(true)
    })

    it('keeps a shared bot mention attached to its agent slug', () => {
      // The shared bot mention and trailing agent slug identify one addressee.
      const address = '<@U_SHARED> reviewer'
      const text = `${'x'.repeat(92)}${address} please verify`
      const sections = splitIntoSections(text, 100, [address])
      expect(sections.join('')).toBe(text)
      expect(sections[1]!.startsWith(address)).toBe(true)
    })

    it('protects broadcast and user-group addresses too', () => {
      const text = `${'x'.repeat(96)}<!subteam^S1|@platform> ship it`
      const sections = splitIntoSections(text, 100)
      expect(sections.join('')).toBe(text)
      expect(sections[1]!.startsWith('<!subteam^S1|@platform>')).toBe(true)
    })

    it('fails rather than publishing a broken address it can never fit', () => {
      // §5.3 requires refusing delivery when an address cannot fit.
      const huge = `<@${'U'.repeat(200)}>`
      expect(() => splitIntoSections(`hello ${huge} there`, 100)).toThrow(/exceeds one message/)
    })

    it('leaves an address that already sits at a natural boundary alone', () => {
      const text = `${'a'.repeat(100)}\n<@U_REVIEWER> next`
      expect(splitIntoSections(text, 100)).toEqual(['a'.repeat(100), '\n<@U_REVIEWER> next'])
    })
  })
})
