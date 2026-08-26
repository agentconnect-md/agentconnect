// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const push = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push })
}))
const myRole = vi.fn(() => 'owner' as string | null)
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ orgPath: (path: string) => `/org-test${path}`, myRole: myRole(), activeOrg: { id: 'org-1' } })
}))
// GlobalSearch reads the three session-access states through SWR to decide
// whether the Session access card would render at all.
const sessionAccess = vi.fn(() => ({ available: true, enabled: false }))
vi.mock('swr', () => ({
  default: (key: unknown) => {
    if (!key) return { data: undefined }
    return { data: sessionAccess() }
  }
}))
vi.mock('@/lib/api', () => ({
  fetchSessionExternalAccess: vi.fn()
}))
// Mutable so a test can hand the box a fleet; every entry defaults empty.
const consoleData = vi.hoisted(() => ({
  agents: [] as unknown[],
  daemons: [] as unknown[],
  memberSets: [] as unknown[],
  orgSetIds: new Set<string>(),
  crons: [] as unknown[],
  allSessions: [] as unknown[]
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => consoleData
}))
const authConfigured = vi.fn(() => true)
vi.mock('@/lib/auth', () => ({
  isAuthConfigured: () => authConfigured()
}))
vi.mock('@/components/ui', () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />
}))
vi.mock('@/components/marks', () => ({
  AgentIconView: () => <span data-agent-icon />
}))

import { GlobalSearch } from './GlobalSearch'
import { NAV_GROUPS, SEARCH_PAGES } from './nav'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  push.mockClear()
  consoleData.agents = []
  consoleData.daemons = []
  consoleData.memberSets = []
  consoleData.orgSetIds = new Set()
  consoleData.crons = []
  consoleData.allSessions = []
  setFlags('')
  authConfigured.mockReturnValue(true)
  myRole.mockReturnValue('owner')
  sessionAccess.mockReturnValue({ available: true, enabled: false })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

// Renders the mobile full-screen variant: `autoFocus` opens it immediately and the
// result list is inline, so tests don't have to simulate the desktop focus dance.
function render() {
  act(() => {
    root.render(<GlobalSearch mobile autoFocus />)
  })
}

function type(value: string) {
  const input = host.querySelector('input')
  if (!input) throw new Error('search input not found')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** The console names and offers the pool and groups only where the deployment asked for them. */
const setFlags = (value: string) => {
  ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV = { FEATURE_FLAGS: value }
}

// Page/setting result rows render the route as their meta line, which the
// type-filter chips (also <button>s, also labelled e.g. "Settings") never show —
// so locate results by route to avoid clicking a chip.
function resultButton(route: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(route))
  if (!found) throw new Error(`result not found: ${route}`)
  return found
}

describe('SEARCH_PAGES index', () => {
  it('contains every rail destination as a page', () => {
    const pageHrefs = SEARCH_PAGES.filter((p) => p.kind === 'page').map((p) => p.href)
    for (const n of NAV_GROUPS.flat()) expect(pageHrefs).toContain(n.href)
  })

  it('contains the per-card settings entries and Profile as settings', () => {
    const settings = SEARCH_PAGES.filter((p) => p.kind === 'setting').map((p) => p.href)
    expect(settings).toEqual([
      '/settings#organization',
      '/settings#agent-visibility',
      '/settings#session-access',
      '/settings#environment',
      '/settings#members',
      '/settings#invite-links',
      '/profile'
    ])
  })

  it('has no duplicate hrefs', () => {
    const hrefs = SEARCH_PAGES.map((p) => p.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })
})

describe('GlobalSearch pages & settings', () => {
  it('finds a feature page by label and navigates to it', () => {
    render()
    type('knowledge')
    expect(host.textContent).toContain('Pages')
    act(() => resultButton('/knowledge').click())
    expect(push).toHaveBeenCalledWith('/org-test/knowledge')
  })

  // The bare query matches every card via the shared 'settings' keyword; the list
  // renders the first CAP of them (the group count shows the full total).
  it('matches settings cards for the bare "settings" query', () => {
    render()
    type('settings')
    expect(host.textContent).toContain('Settings')
    act(() => resultButton('/settings#organization').click())
    expect(push).toHaveBeenCalledWith('/org-test/settings#organization')
  })

  it('finds a settings card by its own title and navigates to its anchor', () => {
    render()
    type('members')
    act(() => resultButton('/settings#members').click())
    expect(push).toHaveBeenCalledWith('/org-test/settings#members')
  })

  it('matches page route aliases (usage → Analytics)', () => {
    render()
    type('usage')
    act(() => resultButton('/usage').click())
    expect(push).toHaveBeenCalledWith('/org-test/usage')
  })

  it('hides owner-only cards from non-owners (their anchor never renders)', () => {
    myRole.mockReturnValue('collaborator')
    render()
    type('invite links')
    expect(host.textContent).toContain('No results')
    type('variables')
    expect(host.textContent).toContain('No results')
    // Cards every member can see stay searchable.
    type('members')
    expect(host.textContent).toContain('/settings#members')
  })

  it('hides the Session access entry when the card cannot render', () => {
    render()
    type('session access')
    expect(host.textContent).toContain('/settings#session-access')
    // Every provider unavailable AND disabled — SessionAccessCard returns null,
    // so the search entry must disappear with it.
    sessionAccess.mockReturnValue({ available: false, enabled: false })
    type('session acces')
    type('session access')
    expect(host.textContent).toContain('No results')
  })

  it('hides Settings and Profile in no-auth mode', () => {
    authConfigured.mockReturnValue(false)
    render()
    type('settings')
    expect(host.textContent).toContain('No results')
    type('profile')
    expect(host.textContent).toContain('No results')
    // Feature pages are still searchable.
    type('agents')
    expect(host.textContent).toContain('Pages')
  })

  it('shows the empty state when nothing matches', () => {
    render()
    type('zzz-no-such-thing')
    expect(host.textContent).toContain('No results for')
  })
})

// The Infra page shows three entities — the pool as ONE entry, the machines, the groups — and the
// box has to agree with it. Matching `daemons` alone found every pool Pod under the pool's shared
// name (N identical rows, each opening a Pod a roll replaces) and never found a group at all.
describe('GlobalSearch infra entities', () => {
  const daemonRow = (over: Record<string, unknown>) => ({
    daemonId: 'd',
    pool: false,
    memberSetId: null,
    name: 'edge-1',
    version: '1.41.0',
    status: 'online',
    lifecycleStatus: null,
    ...over
  })

  const withFleet = () => {
    // Two Pods, one pool: the shared name is exactly what used to duplicate the row.
    consoleData.daemons = [
      daemonRow({ daemonId: 'pod-a', pool: true, memberSetId: 'set-pool', name: 'AgentConnect Cloud' }),
      daemonRow({ daemonId: 'pod-b', pool: true, memberSetId: 'set-pool', name: 'AgentConnect Cloud' }),
      daemonRow({ daemonId: 'dmn-1', name: 'edge-1' }),
      daemonRow({ daemonId: 'dmn-2', memberSetId: 'set-lab', name: 'lab-box' })
    ]
    consoleData.memberSets = [{ setId: 'set-lab', name: 'lab', memberDaemonIds: ['dmn-2'], agentCount: 2 }]
    consoleData.orgSetIds = new Set(['set-lab'])
  }

  it('finds the pool as one entry and opens the pool, never a member Pod', () => {
    setFlags('daemon-pool,managed')
    withFleet()
    render()
    type('agentconnect cloud')
    const rows = [...host.querySelectorAll('button')].filter((b) => b.textContent?.includes('AgentConnect Cloud'))
    expect(rows).toHaveLength(1)
    act(() => rows[0]!.click())
    expect(push).toHaveBeenCalledWith('/org-test/daemons/cluster')
  })

  it('finds a group by name and opens the group', () => {
    setFlags('daemon-pool,daemon-groups,managed')
    withFleet()
    render()
    type('lab')
    act(() => resultButton('1 daemon · 2 agents').click())
    expect(push).toHaveBeenCalledWith('/org-test/daemons/groups/set-lab')
  })

  it('still finds a machine, and a group member is one', () => {
    setFlags('daemon-pool,daemon-groups,managed')
    withFleet()
    render()
    type('lab-box')
    act(() => resultButton('lab-box').click())
    expect(push).toHaveBeenCalledWith('/org-test/daemons/dmn-2')
  })

  it('offers neither the pool nor a group where the deployment does not', () => {
    withFleet()
    render()
    type('cloud')
    expect(host.textContent).not.toContain('AgentConnect Cloud')
    type('lab')
    // The group is hidden; the machine that happens to be in it is not.
    expect(host.textContent).toContain('lab-box')
    expect([...host.querySelectorAll('button')].some((b) => b.textContent?.includes('1 daemon ·'))).toBe(false)
  })
})
