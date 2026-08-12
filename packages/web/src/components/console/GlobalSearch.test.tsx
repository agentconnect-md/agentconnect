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
// …and the cluster-execution settings read, to decide the same for that card.
const clusterExecution = vi.fn<() => { data?: unknown; error?: unknown }>(() => ({ data: {} }))
vi.mock('swr', () => ({
  default: (key: unknown) => {
    if (!key) return { data: undefined }
    if (Array.isArray(key) && key[2] === 'cluster-execution') return clusterExecution()
    return { data: sessionAccess() }
  }
}))
vi.mock('@/lib/api', () => ({
  fetchSessionExternalAccess: vi.fn(),
  fetchClusterExecution: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number
    ) {
      super(message)
    }
  }
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({ agents: [], daemons: [], crons: [], allSessions: [] })
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

import { ApiError } from '@/lib/api'
import { GlobalSearch } from './GlobalSearch'
import { NAV_GROUPS, SEARCH_PAGES } from './nav'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  push.mockClear()
  authConfigured.mockReturnValue(true)
  myRole.mockReturnValue('owner')
  sessionAccess.mockReturnValue({ available: true, enabled: false })
  clusterExecution.mockReturnValue({ data: {} })
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
      '/settings#cluster-execution',
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

  it('hides the Cluster execution entry once the deployment is KNOWN to run no cluster', () => {
    render()
    type('cluster execution')
    expect(host.textContent).toContain('/settings#cluster-execution')

    // A read that merely failed keeps the entry — the card renders then too.
    clusterExecution.mockReturnValue({ data: undefined, error: new Error('offline') })
    type('cluster executio')
    type('cluster execution')
    expect(host.textContent).toContain('/settings#cluster-execution')

    // A 404 is the deployment saying it mounts no cluster routes at all, which
    // is what makes the card render nothing and the anchor not exist.
    clusterExecution.mockReturnValue({ data: undefined, error: new ApiError('not found', 404) })
    type('cluster executio')
    type('cluster execution')
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
