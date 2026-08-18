// @vitest-environment happy-dom
// nav.ts exists so the rail, the mobile sheet and the search index cannot disagree
// about what a deployment offers. A flagged destination is where that promise is
// easiest to break — one consumer forgetting to filter is a rail without the entry
// but a search result that navigates to it anyway.
import { describe, expect, it, afterEach } from 'vitest'
import { MORE_ROWS, NAV_GROUPS, SEARCH_PAGES, navVisible } from './nav'

const setFlags = (value?: string) => {
  ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV =
    value === undefined ? {} : { FEATURE_FLAGS: value }
}

const offered = (items: { href: string; requires?: string }[]) =>
  items.filter((i) => navVisible(i as Parameters<typeof navVisible>[0])).map((i) => i.href)

afterEach(() => setFlags())

describe('navVisible', () => {
  it('shows an unflagged destination regardless of what the deployment set', () => {
    setFlags()
    expect(navVisible({})).toBe(true)
    setFlags('billing')
    expect(navVisible({})).toBe(true)
  })

  it('hides a flagged destination until its flag is on', () => {
    setFlags()
    expect(navVisible({ requires: 'billing' })).toBe(false)
    setFlags('billing')
    expect(navVisible({ requires: 'billing' })).toBe(true)
  })

  it('reaches the same verdict in every table, so no surface can offer what the rail hides', () => {
    const tables = () => [offered(NAV_GROUPS.flat()), offered(MORE_ROWS), offered(SEARCH_PAGES)]

    setFlags()
    for (const hrefs of tables()) expect(hrefs).not.toContain('/billing')

    setFlags('billing')
    for (const hrefs of tables()) expect(hrefs).toContain('/billing')
  })

  it('leaves the rest of the rail alone when a flag is off', () => {
    setFlags()
    expect(offered(NAV_GROUPS.flat())).toContain('/home')
    expect(offered(NAV_GROUPS.flat())).toContain('/daemons')
  })
})
