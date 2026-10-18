import { describe, expect, it } from 'vitest'
import { aboutDocument } from './handbook'

describe('aboutDocument', () => {
  it('numbers sources by first appearance, one per distinct source, with punctuation kept apart', () => {
    const doc = aboutDocument(
      [
        '# About',
        'Example Org ships release tooling. (#team-a, 2026-10-17)',
        '## How it works',
        '- Team A runs releases (#team_a, 2026-10-17)',
        '- Team A owns CI (#Team-A, 2026-10-16)',
        '- Billing is next (#team-a, 2026-10-15) (inferred)'
      ].join('\n')
    )!
    expect(doc.summary.map((line) => line.note)).toEqual([1])
    expect(doc.sections[0]!.lines.map((line) => line.note)).toEqual([2, 1])
    expect(doc.unconfirmed.map((line) => line.note)).toEqual([1])
    expect(doc.sources.map((source) => [source.note, source.lines])).toEqual([
      [1, 3],
      [2, 1]
    ])
  })
})
