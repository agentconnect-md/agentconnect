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
})
