// @vitest-environment happy-dom
// nav.ts exists so the rail, the mobile drawer and the search index cannot disagree
// about what a deployment offers. A flagged destination is where that promise is
// easiest to break — one consumer forgetting to filter is a rail without the entry
// but a search result that navigates to it anyway.
import { describe, expect, it, afterEach } from 'vitest'
import english from '../../../messages/en.json'
import { NAV_GROUPS, NAV_LABEL_KEYS, SEARCH_PAGES, SECTIONS, navVisible } from './nav'

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
    const tables = () => [offered(NAV_GROUPS.flat()), offered(SEARCH_PAGES)]

    setFlags()
    for (const hrefs of tables()) expect(hrefs).not.toContain('/billing')

    setFlags('billing')
    for (const hrefs of tables()) expect(hrefs).toContain('/billing')
  })

  it('offers the Decisions surface everywhere with no flag set', () => {
    setFlags('')
    for (const hrefs of [offered(NAV_GROUPS.flat()), offered(SEARCH_PAGES)]) expect(hrefs).toContain('/decisions')
  })

  it('leaves the rest of the rail alone when a flag is off', () => {
    setFlags()
    expect(offered(NAV_GROUPS.flat())).toContain('/home')
    expect(offered(NAV_GROUPS.flat())).toContain('/daemons')
  })
})

// A destination missing from these maps renders its raw English label and still shows,
// so nothing else in the suite would notice.
describe('localized destination labels', () => {
  const navigation = english.Shell.navigation as Record<string, string>
  const railHrefs = [...NAV_GROUPS.flat().map((item) => item.href), ...SECTIONS.map((section) => section.prefix)]

  it('words every destination the rail, the drawer, or a crumb can name', () => {
    const missing = railHrefs.filter((href) => !NAV_LABEL_KEYS[href])
    expect([...new Set(missing)]).toEqual([])
  })

  it('resolves every mapped key to a real catalog entry', () => {
    const keys = new Set(Object.values(NAV_LABEL_KEYS))
    const unknown = [...keys].filter((key) => !navigation[key])
    expect(unknown).toEqual([])
  })

  // The account menus name `/settings` in full themselves; the crumb keeps the short form.
  it('keeps the crumb naming Settings', () => {
    expect(NAV_LABEL_KEYS['/settings']).toBe('settings')
    expect(navigation.organizationSettings).toBe('Organization settings')
  })

  it('localizes the Decisions entry', () => {
    expect(NAV_LABEL_KEYS['/decisions']).toBe('decisions')
    expect(navigation.decisions).toBe('Decisions')
  })
})
