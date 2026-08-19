import { describe, expect, it } from 'vitest'
import { splitIntoSections, UnsplittableSpanError } from '../src/messages/split-sections.js'

describe('splitIntoSections (platform-neutral)', () => {
  it('returns no sections for whitespace-only text', () => {
    expect(splitIntoSections('  \n ', 100)).toEqual([])
  })

  it('keeps text that already fits as one section', () => {
    expect(splitIntoSections('short', 100)).toEqual(['short'])
  })

  it('prefers line boundaries and never loses content', () => {
    const text = ['a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60)].join('\n')
    const sections = splitIntoSections(text, 100)
    expect(sections.every((s) => s.length <= 100)).toBe(true)
    expect(sections.join('')).toBe(text)
    expect(sections[0]).toBe(`${'a'.repeat(60)}\n`)
  })

  it('hard-cuts a single line longer than the limit', () => {
    expect(splitIntoSections('x'.repeat(250), 100)).toEqual(['x'.repeat(100), 'x'.repeat(100), 'x'.repeat(50)])
  })

  it('retreats a boundary that would fall inside a protected span', () => {
    const text = `${'a'.repeat(95)}[[keep-together]]${'b'.repeat(50)}`
    const sections = splitIntoSections(text, 100, { protectedSpans: [{ start: 95, end: 112 }] })
    expect(sections[0]).toBe('a'.repeat(95))
    expect(sections[1]?.startsWith('[[keep-together]]')).toBe(true)
    expect(sections.join('')).toBe(text)
  })

  it('throws when a protected span cannot fit in one section', () => {
    const span = 'z'.repeat(120)
    expect(() => splitIntoSections(`hi ${span} there`, 100, { protectedSpans: [{ start: 3, end: 123 }] })).toThrow(
      UnsplittableSpanError
    )
  })

  it('lets the caller supply its own unsplittable error', () => {
    const span = 'z'.repeat(120)
    expect(() =>
      splitIntoSections(`hi ${span} there`, 100, {
        protectedSpans: [{ start: 3, end: 123 }],
        unsplittable: (fragment) => new Error(`nope: ${fragment.length}`)
      })
    ).toThrow('nope: 120')
  })
})
