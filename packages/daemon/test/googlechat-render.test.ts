/**
 * Google Chat's renderer, byte-budget splitter and client-id derivation (google-chat-integration.md §5):
 * supported Markdown passes through, the rest degrades readably, every message stays inside the byte
 * budget with multi-byte text, a fence is closed and reopened across a cut, and ids stay in Google's alphabet.
 */
import { describe, it, expect } from 'vitest'
import {
  GOOGLE_CHAT_TEXT_BUDGET_BYTES,
  renderGoogleChatMarkdown,
  splitGoogleChatText
} from '../src/platforms/googlechat/render.js'
import { googleChatClientId } from '../src/platforms/googlechat/turn-output.js'

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8')

describe('renderGoogleChatMarkdown', () => {
  it('passes the supported subset through unchanged', () => {
    const text =
      '**bold** _em_ ~~gone~~ `code` [link](https://example.test/a)\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted'
    expect(renderGoogleChatMarkdown(text)).toBe(text)
  })

  it('degrades headings to bold lines, ATX and setext alike', () => {
    expect(renderGoogleChatMarkdown('# Title\n\nbody\n\n## Sub ##\n\nUnder\n===\n\nH2\n---')).toBe(
      '**Title**\n\nbody\n\n**Sub**\n\n**Under**\n\n**H2**'
    )
  })

  it('turns an image into its link, a rule into a blank line, and a task box into a glyph', () => {
    expect(renderGoogleChatMarkdown('![diagram](https://example.test/d.png)\n\n---\n\n- [ ] todo\n- [x] done')).toBe(
      '[diagram](https://example.test/d.png)\n\n\n\n- ☐ todo\n- ☑ done'
    )
    expect(renderGoogleChatMarkdown('![](https://example.test/d.png)')).toBe('[image](https://example.test/d.png)')
  })

  it('wraps a pipe table in a monospace block so the columns still line up', () => {
    expect(renderGoogleChatMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n\nafter')).toBe(
      '```\n| a | b |\n|---|---|\n| 1 | 2 |\n```\n\nafter'
    )
  })

  it('leaves fenced code untouched, including lines that look like headings or rules', () => {
    const code = '```sh\n# not a heading\n---\n![x](y)\n```'
    expect(renderGoogleChatMarkdown(code)).toBe(code)
  })
})

describe('splitGoogleChatText', () => {
  it('keeps one message when the encoded text fits, and drops a blank body', () => {
    expect(splitGoogleChatText('hello\n\nworld')).toEqual(['hello\n\nworld'])
    expect(splitGoogleChatText('   \n\n')).toEqual([])
  })

  it('budgets UTF-8 bytes, not characters, so multi-byte text still fits every message', () => {
    // 200 chars of 3-byte CJK per line: 600 bytes a line, 20 lines = 12,000 bytes against a 5,000-byte budget.
    const line = '字'.repeat(200)
    const text = Array.from({ length: 20 }, () => line).join('\n')
    const parts = splitGoogleChatText(text, 5_000)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) expect(bytes(part)).toBeLessThanOrEqual(5_000)
    expect(parts.join('\n')).toBe(text)
  })

  it('cuts at a paragraph break outside a fence when one fits', () => {
    const first = 'a'.repeat(3_000)
    const second = 'b'.repeat(3_000)
    const parts = splitGoogleChatText(`${first}\n\n${second}`, 4_000)
    expect(parts).toEqual([first, second])
  })

  it('closes an open fence at a cut and reopens it in the next message', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i} ${'x'.repeat(100)}`)
    const text = ['```ts', ...lines, '```'].join('\n')
    const parts = splitGoogleChatText(text, 1_500)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) {
      expect(bytes(part)).toBeLessThanOrEqual(1_500)
      expect(part.startsWith('```ts\n')).toBe(true)
      expect(part.endsWith('\n```')).toBe(true)
    }
    // Every code line survives, once, in order.
    const body = parts.flatMap((part) => part.split('\n').slice(1, -1))
    expect(body).toEqual(lines)
  })

  it('hard-cuts a single overlong line at a code-point boundary, never inside one', () => {
    const emoji = '😀'.repeat(2_000)
    const parts = splitGoogleChatText(emoji, 1_000)
    for (const part of parts) {
      expect(bytes(part)).toBeLessThanOrEqual(1_000)
      expect(part).toMatch(/^(?:😀)+$/)
    }
    expect(parts.join('')).toBe(emoji)
  })

  it('leaves headroom under the 32,000-byte message cap for the envelope', () => {
    expect(GOOGLE_CHAT_TEXT_BUDGET_BYTES).toBeLessThan(32_000)
    expect(GOOGLE_CHAT_TEXT_BUDGET_BYTES).toBeGreaterThanOrEqual(24_000)
  })
})

describe('googleChatClientId', () => {
  const delivery = 'scope\u001fgooglechat:spaces/EXAMPLE_SPACE:spaces/EXAMPLE_SPACE/messages/T.M'

  it('stays inside the custom-id contract: `client-`, lowercase letters, digits, hyphens, at most 63 chars', () => {
    const id = googleChatClientId(delivery, 0, 0)
    expect(id).toMatch(/^client-[a-z0-9-]+$/)
    expect(id.length).toBeLessThanOrEqual(63)
  })

  it('is stable for one (delivery, block, segment) and distinct across each axis', () => {
    expect(googleChatClientId(delivery, 0, 0)).toBe(googleChatClientId(delivery, 0, 0))
    const ids = new Set([
      googleChatClientId(delivery, 0, 0),
      googleChatClientId(delivery, 0, 1),
      googleChatClientId(delivery, 1, 0),
      googleChatClientId(`${delivery}2`, 0, 0)
    ])
    expect(ids.size).toBe(4)
  })
})

describe('splitGoogleChatText never exceeds the budget', () => {
  /** Every emitted segment fits, and no non-whitespace character is lost or invented. */
  function assertWithinBudget(text: string, budget: number): string[] {
    const parts = splitGoogleChatText(text, budget)
    for (const part of parts) expect(bytes(part), `segment of ${bytes(part)} bytes`).toBeLessThanOrEqual(budget)
    const strip = (s: string): string => s.replace(/\s+/g, '').replace(/```[a-z]*/g, '')
    expect(strip(parts.join('\n'))).toBe(strip(text))
    return parts
  }

  it('cuts again when the paragraph remainder plus the next line still overflows', () => {
    // A short paragraph, then a long one whose last line only fits on its own: one cut is not enough.
    const text = `${'a'.repeat(2000)}\n\n${'b'.repeat(27000)}\n${'c'.repeat(5000)}`
    const parts = assertWithinBudget(text, GOOGLE_CHAT_TEXT_BUDGET_BYTES)
    expect(parts).toEqual(['a'.repeat(2000), 'b'.repeat(27000), 'c'.repeat(5000)])
  })

  it('holds for adversarial shapes: long after short, inside a fence, multi-byte, and seeded mixes', () => {
    assertWithinBudget(`${'a'.repeat(100)}\n\n${'b'.repeat(900)}\n${'c'.repeat(900)}\n${'d'.repeat(900)}`, 1_000)
    const fenced = ['```', 'x'.repeat(50), '', 'y'.repeat(700), 'z'.repeat(700), '', 'w'.repeat(700), '```'].join('\n')
    for (const part of assertWithinBudget(fenced, 800)) {
      expect(part.startsWith('```\n')).toBe(true)
      expect(part.endsWith('\n```')).toBe(true)
    }
    assertWithinBudget(`${'字'.repeat(10)}\n\n${'字'.repeat(300)}\n${'😀'.repeat(200)}\n${'字'.repeat(300)}`, 1_000)
    // A seeded generator, so a failing shape reproduces exactly.
    let seed = 20260927
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    const alphabets = ['a', '字', '😀', 'b ']
    for (let round = 0; round < 40; round += 1) {
      const lines: string[] = []
      const lineCount = 3 + next(12)
      for (let i = 0; i < lineCount; i += 1) {
        const roll = next(10)
        if (roll === 0) lines.push('')
        else if (roll === 1) lines.push('```')
        else lines.push(alphabets[next(alphabets.length)]!.repeat(next(700)))
      }
      assertWithinBudget(lines.join('\n'), 500 + next(1_500))
    }
  })
})
