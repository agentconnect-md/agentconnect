import { describe, it, expect } from 'vitest'
import {
  renderTablesForSlack,
  SLACK_MARKDOWN_BLOCK_LIMIT,
  slackMarkdownBlockText,
  splitIntoSections
} from '../src/slack/formatter.js'

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

  // send-message-routing-rework.md §5.3 — a mention is now how an agent addresses a peer
  // in its own thread, so cutting one does not merely render badly: it drops a delivery.
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
      // A shared bot's user id identifies the APP, not the agent — the slug selects the
      // agent, so splitting between them addresses nobody.
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
      // §5.3: "If one address cannot fit a platform message, delivery fails instead of
      // publishing a broken address."
      const huge = `<@${'U'.repeat(200)}>`
      expect(() => splitIntoSections(`hello ${huge} there`, 100)).toThrow(/exceeds one message/)
    })

    it('leaves an address that already sits at a natural boundary alone', () => {
      const text = `${'a'.repeat(100)}\n<@U_REVIEWER> next`
      expect(splitIntoSections(text, 100)).toEqual(['a'.repeat(100), '\n<@U_REVIEWER> next'])
    })
  })
})

describe('renderTablesForSlack', () => {
  const reply = [
    'Here is the log:',
    '| Author | Time | Summary |',
    '|---|:---:|---|',
    '| alice | 10:26 | fixed [the build](https://example.test/b) in `ci.yml` |',
    '| bob | | **reverted** |',
    'That is all.'
  ].join('\n')

  it('turns each data row into one list item labelled by its headers, keeping the text around it', () => {
    expect(renderTablesForSlack(reply)).toBe(
      [
        'Here is the log:',
        '',
        '- **Author:** alice · **Time:** 10:26 · **Summary:** fixed [the build](https://example.test/b) in `ci.yml`',
        '- **Author:** bob · **Summary:** **reverted**',
        '',
        'That is all.'
      ].join('\n')
    )
  })

  it('leaves a table inside a code fence alone', () => {
    const fenced = ['```', '| a | b |', '|---|---|', '| 1 | 2 |', '```'].join('\n')
    expect(renderTablesForSlack(fenced)).toBe(fenced)
  })

  it('unescapes pipes in cells and accepts rows without outer pipes', () => {
    expect(renderTablesForSlack('a | b\n--- | ---\nx \\| y | z')).toBe('- **a:** x | y · **b:** z')
  })

  it('keeps a header-only table as its names and leaves pipe prose untouched', () => {
    expect(renderTablesForSlack('| a | b |\n|---|---|')).toBe('- a · b')
    expect(renderTablesForSlack('run `a | b` then\n---')).toBe('run `a | b` then\n---')
    expect(renderTablesForSlack('| a | b |\n|---|')).toBe('| a | b |\n|---|')
  })

  it('splits a body so every section still fits once its tables are rendered', () => {
    const row = '| a | b |'
    const table = ['| first header | second header |', '|---|---|', ...Array.from({ length: 30 }, () => row)].join('\n')
    const sections = splitIntoSections(table, 400)
    expect(sections.join('')).toBe(table)
    expect(sections.every((s) => renderTablesForSlack(s).length <= 400)).toBe(true)
  })

  it('falls back to a verbatim code block, then the raw text, when list items would overflow one block', () => {
    const rows = (n: number) => Array.from({ length: n }, () => '| a | b |')
    const table = (n: number) => ['| Implementation detail | Verification result |', '|---|---|', ...rows(n)].join('\n')
    expect(slackMarkdownBlockText(table(2))).toBe(renderTablesForSlack(table(2)))
    const coded = slackMarkdownBlockText(table(250))
    expect(coded).toBe(['```', ...table(250).split('\n'), '```'].join('\n'))
    expect(coded.length).toBeLessThanOrEqual(SLACK_MARKDOWN_BLOCK_LIMIT)
    const full = table(1194)
    expect(full.length).toBeLessThanOrEqual(SLACK_MARKDOWN_BLOCK_LIMIT)
    expect(slackMarkdownBlockText(full)).toBe(full)
  })
})
