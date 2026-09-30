import { describe, expect, it } from 'vitest'
import { ProjectionSnapshot } from './projection-snapshot.js'

const SNAP = '33333333-3333-4333-8333-333333333333'
const NEXT = '44444444-4444-4444-8444-444444444444'

describe('ProjectionSnapshot', () => {
  it('prunes what the snapshot neither replayed nor withheld', () => {
    const s = new ProjectionSnapshot()
    s.begin(SNAP)
    s.see('kept')
    expect(s.end(SNAP, ['kept', 'held', 'gone'], ['held'])).toEqual(['gone'])
  })

  it('prunes nothing outside a snapshot, or for an end that is not the open one', () => {
    const s = new ProjectionSnapshot()
    expect(s.end(SNAP, ['a'], [])).toEqual([])
    s.begin(NEXT)
    expect(s.end(SNAP, ['a'], [])).toEqual([])
    s.abandon()
    expect(s.end(NEXT, ['a'], [])).toEqual([])
  })

  it('starts over when a new snapshot begins before the old one ended', () => {
    const s = new ProjectionSnapshot()
    s.begin(SNAP)
    s.see('a')
    s.begin(NEXT)
    expect(s.end(NEXT, ['a'], [])).toEqual(['a'])
  })
})
