import { describe, expect, it } from 'vitest'
import { detailCrumb, type CrumbSlot } from './crumb'

const slot = (id: string, title: string): CrumbSlot => ({ id, title, status: 'completed', statusLabel: 'completed' })

describe('detailCrumb', () => {
  it('uses the list title when the entity is in a loaded page', () => {
    expect(detailCrumb('Sessions', 's1', 'Roll out api@1.4.2 to prod')).toEqual({
      title: 'Roll out api@1.4.2 to prod',
      show: true,
      badge: undefined
    })
  })

  it('collapses to the section label while nothing has resolved yet', () => {
    expect(detailCrumb('Sessions', 's1')).toEqual({ title: 'Sessions', show: false, badge: undefined })
  })

  // The regression this exists for: a deep link (or a parent/child link) to a session
  // outside the loaded cursor pages has no list row, so without the slot the crumb
  // stayed collapsed and the status badge nested inside it never rendered.
  it('renders an out-of-page deep link from the detail-backed slot alone', () => {
    const s = slot('s9', 'Rotate the staging token')
    expect(detailCrumb('Sessions', 's9', undefined, s)).toEqual({
      title: 'Rotate the staging token',
      show: true,
      badge: s
    })
  })

  it('prefers the slot over a stale list row', () => {
    expect(detailCrumb('Sessions', 's1', 'old title', slot('s1', 'renamed')).title).toBe('renamed')
  })

  it('still opens the crumb for a session named exactly like its section', () => {
    expect(detailCrumb('Sessions', 's1', undefined, slot('s1', 'Sessions')).show).toBe(true)
  })

  // The slot is shell state, so on client navigation it still holds the previous route's
  // session for one commit — before the old view's effect cleanup runs. Honouring it
  // there would paint session A's title and badge on session B.
  it('ignores a slot left over from the previous session', () => {
    expect(detailCrumb('Sessions', 's2', 'B title', slot('s1', 'A title'))).toEqual({
      title: 'B title',
      show: true,
      badge: undefined
    })
  })

  it('ignores a stale session slot on a different section entirely', () => {
    expect(detailCrumb('Agents', 'agent-7', undefined, slot('s1', 'A title'))).toEqual({
      title: 'Agents',
      show: false,
      badge: undefined
    })
  })

  it('ignores any slot on a section route with no id', () => {
    expect(detailCrumb('Sessions', undefined, undefined, slot('s1', 'A title'))).toEqual({
      title: 'Sessions',
      show: false,
      badge: undefined
    })
  })
})
