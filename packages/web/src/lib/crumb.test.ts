import { describe, expect, it } from 'vitest'
import { detailCrumb } from './crumb'

describe('detailCrumb', () => {
  it('uses the list title when the entity is in a loaded page', () => {
    expect(detailCrumb('Sessions', 'Roll out api@1.4.2 to prod')).toEqual({
      title: 'Roll out api@1.4.2 to prod',
      show: true
    })
  })

  it('collapses to the section label while nothing has resolved yet', () => {
    expect(detailCrumb('Sessions')).toEqual({ title: 'Sessions', show: false })
  })

  // The regression this exists for: a deep link (or a parent/child link) to a session
  // outside the loaded cursor pages has no list row, so without the slot the crumb
  // stayed collapsed and the status badge nested inside it never rendered.
  it('renders an out-of-page deep link from the detail-backed slot alone', () => {
    expect(detailCrumb('Sessions', undefined, 'Rotate the staging token')).toEqual({
      title: 'Rotate the staging token',
      show: true
    })
  })

  it('prefers the slot over a stale list row', () => {
    expect(detailCrumb('Sessions', 'old title', 'renamed').title).toBe('renamed')
  })

  it('still opens the crumb for a session named exactly like its section', () => {
    expect(detailCrumb('Sessions', undefined, 'Sessions')).toEqual({ title: 'Sessions', show: true })
  })
})
