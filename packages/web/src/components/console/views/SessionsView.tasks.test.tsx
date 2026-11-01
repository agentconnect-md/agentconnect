// @vitest-environment happy-dom
// All sessions hides tasks (delegated tasks, follow-ups, approved proposals) unless "Show tasks" is on: a URL param the list and facet reads pass to the CP, on desktop and in the phone's filter sheet.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionFromDto, type SessionDto, type SessionListFilters } from '@/lib/api'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  search: '',
  listFilters: [] as SessionListFilters[],
  facetFilters: [] as SessionListFilters[],
  openSheet: null as null | (() => void),
  sessions: [] as unknown[]
}))

vi.mock('next/link', () => ({
  default: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  )
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(mocks.search)
}))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, orgPath: (path: string) => `/acme${path}` })
}))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: null }) }))
// Marks would fetch their images, which the test environment aborts on teardown.
vi.mock('@/components/marks', async (original) => ({
  ...(await original<typeof import('@/components/marks')>()),
  PlatformMark: () => <span />,
  AgentIconView: () => <span />
}))
vi.mock('@/components/console/PlaygroundProvider', () => ({ usePlayground: () => ({ pgSessionList: [] }) }))
vi.mock('@/components/console/Shell', () => ({
  useMobileFilterSlot: () => ({
    register: (slot: { open: () => void } | null) => {
      if (slot) mocks.openSheet = slot.open
    }
  })
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents: [],
    allSessions: [],
    crons: [],
    members: [],
    sessionFacets: { agentIds: [], agentNames: {}, integrations: [], channels: [], triggers: [] }
  })
}))
vi.mock('@/lib/use-session-list', () => ({
  useSessionList: (_orgId: string, filters: SessionListFilters) => {
    mocks.listFilters.push(filters)
    return {
      sessions: mocks.sessions,
      total: mocks.sessions.length,
      nextCursor: null,
      loadingMore: false,
      loadMore: () => undefined,
      isLoading: false,
      isValidating: false
    }
  },
  sessionFilterAgentKey: () => ''
}))
vi.mock('@/lib/use-session-facets', () => ({
  useSessionFacets: (_orgId: string, filters: SessionListFilters) => {
    mocks.facetFilters.push(filters)
    return { data: { agentIds: [], agentNames: {}, integrations: [], channels: [], triggers: [] } }
  }
}))

const SessionsView = (await import('./SessionsView')).default

let root: Root | undefined
let host: HTMLDivElement | undefined

async function render() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<SessionsView />)
  })
}

const toggle = () => document.querySelector<HTMLButtonElement>('[data-show-tasks]')

beforeEach(() => {
  mocks.search = ''
  mocks.listFilters = []
  mocks.facetFilters = []
  mocks.openSheet = null
  mocks.sessions = []
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.replace.mockClear()
})

describe('SessionsView, Show tasks', () => {
  it('asks the CP to leave tasks out by default, for the rows and the facets alike', async () => {
    await render()
    expect(mocks.listFilters.at(-1)).toEqual({ excludeTasks: true })
    expect(mocks.facetFilters.at(-1)).toEqual({ excludeTasks: true })
    expect(toggle()?.getAttribute('aria-pressed')).toBe('false')
    expect(toggle()?.textContent).toBe('Show tasks')
  })

  it('turns the toggle on through the URL, keeping the other filters', async () => {
    mocks.search = 'agent=agent-a'
    await render()
    await act(async () => toggle()?.click())
    expect(mocks.replace).toHaveBeenCalledWith('/acme/sessions?agent=agent-a&tasks=show')
  })

  it('lists tasks once the toggle is on, and turns it off again', async () => {
    mocks.search = 'tasks=show'
    await render()
    expect(mocks.listFilters.at(-1)).toEqual({})
    expect(mocks.facetFilters.at(-1)).toEqual({})
    expect(toggle()?.getAttribute('aria-pressed')).toBe('true')
    await act(async () => toggle()?.click())
    expect(mocks.replace).toHaveBeenCalledWith('/acme/sessions')
  })

  it('offers the same choice in the phone’s filter sheet, and a chip that clears it', async () => {
    await render()
    await act(async () => mocks.openSheet?.())
    const pill = Array.from(document.querySelectorAll<HTMLButtonElement>('.msheet-scrim button')).find(
      (button) => button.textContent === 'Show tasks'
    )
    expect(pill).toBeDefined()
    await act(async () => pill?.click())
    expect(mocks.replace).toHaveBeenCalledWith('/acme/sessions?tasks=show')

    if (root) await act(async () => root?.unmount())
    host?.remove()
    mocks.search = 'tasks=show'
    await render()
    const clear = document.querySelector<HTMLElement>('[aria-label="Clear Tasks filter"]')
    expect(clear).not.toBeNull()
    await act(async () => clear?.click())
    expect(mocks.replace).toHaveBeenLastCalledWith('/acme/sessions')
  })
})

// auto-session-mode.md §11: the list labels an Auto conversation's coordinator, on desktop and on a phone alike.
describe('SessionsView, the coordinator', () => {
  it('labels the coordinator’s row in both arrangements, and no other row', async () => {
    const row = (id: string, thread: string, title: string) =>
      sessionFromDto({
        sessionId: id,
        sessionKey: { platform: 'slack', channel: 'C1', thread },
        agentId: 'agent-1',
        title,
        status: 'idle',
        lastActivityAt: '2026-10-30T09:00:00.000Z',
        usage: null,
        triggeredBy: 'U0ALICE',
        channelName: 'eng',
        triggeredByName: 'alice',
        threadUrl: null
      } as unknown as SessionDto)
    mocks.sessions = [
      row('coordinator', 'append:coordinator-1700000000000', 'morning all'),
      row('task', '1700000000.000100', 'Webhook retries')
    ]
    mocks.search = 'view=flat'
    await render()
    const tagged = (title: string) =>
      Array.from(document.querySelectorAll('a.row')).filter(
        (link) => link.textContent?.includes(title) && link.querySelector('[data-coordinator-tag]')
      )
    expect(tagged('morning all')).toHaveLength(1)
    expect(document.querySelectorAll('[data-coordinator-tag]')).toHaveLength(2)
    expect(tagged('Webhook retries')).toHaveLength(0)
  })
})
