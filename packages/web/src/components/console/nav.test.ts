// @vitest-environment happy-dom
// nav.ts exists so the rail, the mobile sheet and the search index cannot disagree
// about what a deployment offers. A flagged destination is where that promise is
// easiest to break — one consumer forgetting to filter is a rail without the entry
// but a search result that navigates to it anyway.
import { describe, expect, it, afterEach } from 'vitest'
import english from '../../../messages/en.json'
import {
  MORE_ROWS,
  MOBILE_NAV,
  NAV_GROUPS,
  NAV_LABEL_KEYS,
  SEARCH_PAGES,
  SECTIONS,
  SHEET_LABEL_KEYS,
  navVisible
} from './nav'

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

  // Decisions reads an opt-in mock service, so a deployment that never asked for the
  // surface must not be able to reach it from the rail, the More sheet, or search.
  it('hides the Decisions surface everywhere until its flag is on', () => {
    const tables = () => [offered(NAV_GROUPS.flat()), offered(MORE_ROWS), offered(SEARCH_PAGES)]

    setFlags('billing,daemon-pool')
    for (const hrefs of tables()) expect(hrefs).not.toContain('/decisions')

    setFlags('decisions')
    for (const hrefs of tables()) expect(hrefs).toContain('/decisions')
  })

  it('leaves the rest of the rail alone when a flag is off', () => {
    setFlags()
    expect(offered(NAV_GROUPS.flat())).toContain('/home')
    expect(offered(NAV_GROUPS.flat())).toContain('/daemons')
  })
})

// The rail, the bottom tab bar, the More sheet, and the mobile crumb each name a
// destination through one of these maps. A destination the map misses renders its raw
// English label — it still shows, so nothing else in the suite notices.
describe('localized destination labels', () => {
  const navigation = english.Shell.navigation as Record<string, string>
  const railHrefs = [
    ...NAV_GROUPS.flat().map((item) => item.href),
    ...MOBILE_NAV.map((item) => item.href),
    ...MORE_ROWS.map((item) => item.href),
    ...SECTIONS.map((section) => section.prefix)
  ]

  it('words every destination the rail, the tab bar, or a crumb can name', () => {
    const missing = railHrefs.filter((href) => !NAV_LABEL_KEYS[href])
    expect([...new Set(missing)]).toEqual([])
  })

  it('words every row the More sheet can name', () => {
    const missing = MORE_ROWS.map((item) => item.href).filter((href) => !SHEET_LABEL_KEYS[href])
    expect(missing).toEqual([])
  })

  it('resolves every mapped key to a real catalog entry', () => {
    const keys = new Set([...Object.values(NAV_LABEL_KEYS), ...Object.values(SHEET_LABEL_KEYS)])
    const unknown = [...keys].filter((key) => !navigation[key])
    expect(unknown).toEqual([])
  })

  // The one route the two surfaces word differently, and the reason they are two maps.
  it('keeps the sheet naming Organization settings', () => {
    expect(NAV_LABEL_KEYS['/settings']).toBe('settings')
    expect(SHEET_LABEL_KEYS['/settings']).toBe('organizationSettings')
  })

  it('localizes the Decisions entry on both surfaces', () => {
    expect(NAV_LABEL_KEYS['/decisions']).toBe('decisions')
    expect(SHEET_LABEL_KEYS['/decisions']).toBe('decisions')
    expect(navigation.decisions).toBe('Decisions')
  })
})
