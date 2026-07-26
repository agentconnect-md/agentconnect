import { describe, expect, it } from 'vitest'
import { diffLines } from './LineDiff'

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

  it('handles a newline-heavy 4 KB snapshot without a quadratic matrix', () => {
    const before = `a${'\n'.repeat(3_998)}x`
    const after = `b${'\n'.repeat(3_998)}y`

    const rows = diffLines(before, after)

    expect(rows.filter((row) => row.kind === 'context')).toHaveLength(3_997)
    expect(rows.filter((row) => row.kind === 'delete').map((row) => row.text)).toEqual(['a', 'x'])
    expect(rows.filter((row) => row.kind === 'add').map((row) => row.text)).toEqual(['b', 'y'])
    expect(rows.filter((row) => row.kind === 'meta')).toHaveLength(2)
  })
})
