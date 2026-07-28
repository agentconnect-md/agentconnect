import { describe, expect, it } from 'vitest'
import { diffLines, type LineDiffRow } from './LineDiff'

function rebuild(rows: LineDiffRow[], side: 'old' | 'new'): string {
  const contentKind = side === 'old' ? 'delete' : 'add'
  const lines = rows.filter((row) => row.kind === 'context' || row.kind === contentKind).map((row) => row.text)
  if (lines.length === 0) return ''
  const missingNewline = rows.some((row) => row.kind === 'meta' && (row.eofSide === side || row.eofSide === 'both'))
  return lines.join('\n') + (missingNewline ? '' : '\n')
}

describe('diffLines', () => {
  it('keeps context and marks only the exact removed and added lines', () => {
    expect(diffLines('alpha\nold value\nomega\n', 'alpha\nnew value\nomega\nextra\n')).toEqual([
      { kind: 'context', text: 'alpha', oldLine: 1, newLine: 1 },
      { kind: 'delete', text: 'old value', oldLine: 2 },
      { kind: 'add', text: 'new value', newLine: 2 },
      { kind: 'context', text: 'omega', oldLine: 3, newLine: 3 },
      { kind: 'add', text: 'extra', newLine: 4 }
    ])
  })

  it('renders whole-file additions and deletions with the correct side line numbers', () => {
    expect(diffLines('', 'one\ntwo\n')).toEqual([
      { kind: 'add', text: 'one', newLine: 1 },
      { kind: 'add', text: 'two', newLine: 2 }
    ])
    expect(diffLines('one\ntwo\n', '')).toEqual([
      { kind: 'delete', text: 'one', oldLine: 1 },
      { kind: 'delete', text: 'two', oldLine: 2 }
    ])
  })

  it('preserves EOF-newline-only changes with Git-style markers', () => {
    expect(diffLines('alpha', 'alpha\n')).toEqual([
      { kind: 'delete', text: 'alpha', oldLine: 1 },
      { kind: 'meta', text: 'No newline at end of file', eofSide: 'old' },
      { kind: 'add', text: 'alpha', newLine: 1 }
    ])
    expect(diffLines('alpha\n', 'alpha')).toEqual([
      { kind: 'delete', text: 'alpha', oldLine: 1 },
      { kind: 'add', text: 'alpha', newLine: 1 },
      { kind: 'meta', text: 'No newline at end of file', eofSide: 'new' }
    ])
  })

  it('treats an unterminated terminal line as different when it becomes a terminated nonterminal line', () => {
    expect(diffLines('a', 'a\nb')).toEqual([
      { kind: 'delete', text: 'a', oldLine: 1 },
      { kind: 'meta', text: 'No newline at end of file', eofSide: 'old' },
      { kind: 'add', text: 'a', newLine: 1 },
      { kind: 'add', text: 'b', newLine: 2 },
      { kind: 'meta', text: 'No newline at end of file', eofSide: 'new' }
    ])
    expect(diffLines('a', 'a\n\n')).toEqual([
      { kind: 'delete', text: 'a', oldLine: 1 },
      { kind: 'meta', text: 'No newline at end of file', eofSide: 'old' },
      { kind: 'add', text: 'a', newLine: 1 },
      { kind: 'add', text: '', newLine: 2 }
    ])
  })

  it('preserves a shared unterminated EOF line when an earlier line changes', () => {
    expect(diffLines('old\ntail', 'new\ntail')).toEqual([
      { kind: 'delete', text: 'old', oldLine: 1 },
      { kind: 'add', text: 'new', newLine: 1 },
      { kind: 'context', text: 'tail', oldLine: 2, newLine: 2 },
      { kind: 'meta', text: 'No newline at end of file', eofSide: 'both' }
    ])
  })

  it('reconstructs every small before/after line and EOF combination', () => {
    const values = new Set<string>([''])
    const atoms = ['a', 'b', '']
    const addValues = (parts: string[], remaining: number) => {
      if (remaining === 0) {
        const value = parts.join('\n')
        values.add(value)
        values.add(`${value}\n`)
        return
      }
      for (const atom of atoms) addValues([...parts, atom], remaining - 1)
    }
    for (let length = 1; length <= 3; length += 1) addValues([], length)

    for (const before of values) {
      for (const after of values) {
        if (before === after) continue
        const rows = diffLines(before, after)
        expect(rebuild(rows, 'old'), `${JSON.stringify(before)} → old`).toBe(before)
        expect(rebuild(rows, 'new'), `${JSON.stringify(after)} → new`).toBe(after)
      }
    }
  })

  it('handles a newline-heavy 4 KB snapshot without a quadratic matrix', () => {
    const before = `a${'\n'.repeat(3_998)}x`
    const after = `b${'\n'.repeat(3_998)}y`

    const rows = diffLines(before, after)

    expect(rows.filter((row) => row.kind === 'context')).toHaveLength(3_997)
    expect(rows.filter((row) => row.kind === 'delete').map((row) => row.text)).toEqual(['a', 'x'])
    expect(rows.filter((row) => row.kind === 'add').map((row) => row.text)).toEqual(['b', 'y'])
    expect(rows.filter((row) => row.kind === 'meta')).toHaveLength(2)
  })

  it('simplifies a large changed middle while preserving both complete files', () => {
    const before = [
      'head',
      ...Array.from({ length: 2_300 }, (_, index) => [`same-${index}`, `old-${index}`]).flat(),
      'tail'
    ].join('\n')
    const after = [
      'head',
      ...Array.from({ length: 2_300 }, (_, index) => [`same-${index}`, `new-${index}`]).flat(),
      'tail'
    ].join('\n')

    const rows = diffLines(before, after)

    expect(rows.filter((row) => row.kind === 'context').map((row) => row.text)).toEqual(['head', 'same-0', 'tail'])
    expect(rows).toContainEqual(
      expect.objectContaining({
        kind: 'meta',
        text: expect.stringContaining('Large diff simplified')
      })
    )
    expect(rebuild(rows, 'old')).toBe(before)
    expect(rebuild(rows, 'new')).toBe(after)
  })
})
