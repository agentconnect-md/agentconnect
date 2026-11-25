import { describe, expect, it } from 'vitest'
import { unreadFirst } from './use-mark-sessions-read'

describe('unreadFirst', () => {
  it('floats unread rows and keeps the list order inside each group', () => {
    const rows = [{ id: 'a' }, { id: 'b', unread: true }, { id: 'c' }, { id: 'd', unread: true }]
    expect(unreadFirst(rows).map((row) => row.id)).toEqual(['b', 'd', 'a', 'c'])
  })
})
