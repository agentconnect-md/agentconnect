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
})
