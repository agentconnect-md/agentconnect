// @vitest-environment happy-dom

// Two tabs, one body position: what the dock draws for the tab a reader is looking at, what it must NOT draw for the one they are not, and the placeholder branch that only becomes reachable once a second tab is usually ready.

import { act, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const wire = vi.hoisted(() => ({
  entries: [] as Array<{ name: string; type: string }>,
  /** Non-null holds every listing until it is released, which is the only window in which the Files tab is not ready. */
  gate: null as null | Array<() => void>
}))

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(public status: number) {
      super(`HTTP ${status}`)
    }
  },
  fetchWorkspaceFiles: vi.fn(async (_agentId: string, opts: { path: string }) => {
    if (wire.gate) await new Promise<void>((resolve) => wire.gate?.push(resolve))
    return {
      path: opts.path,
      exists: true,
      entries: wire.entries.map((entry) => ({ ...entry, size: 10, mtime: null })),
      nextCursor: null
    }
  }),
  fetchWorkspaceGitStatus: vi.fn(() => Promise.resolve({ isRepo: false })),
  // The Sessions panel hydrates pins through this; no case here has a pin to hydrate.
  fetchSessionDetail: vi.fn(() => Promise.reject(new Error('no detail'))),
  sessionFromDetailDto: (dto: unknown) => dto
}))

vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ orgPath: (path: string) => path, activeOrg: { id: 'org-1' } })
}))

vi.mock('@/lib/data-context', () => ({ useConsoleData: () => ({ agents: [], crons: [] }) }))

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>
}))

// The dock reads the shell's mobile action slot; mounting the real Shell would pull the whole console behind the mocked api.
vi.mock('@/components/console/Shell', () => ({
  useMobileActionSlot: () => ({ action: null, register: () => {} })
}))

// The Sessions panel's "New session" action opens a playground then routes to it.
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn()
  })
}))

vi.mock('@/components/console/PlaygroundProvider', () => ({
  usePlayground: () => ({ openPlayground: vi.fn(() => 'pg_new') })
}))

import { DockPanel, SessionDock, type DockTab } from './SessionDock'
import { FilesPanel, filesTabStatus } from './FilesPanel'
import { SessionsPanel } from './SessionsPanel'
import type { Session } from '@/lib/data'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let container: HTMLDivElement | undefined
let root: ReturnType<typeof createRoot> | undefined

beforeEach(() => {
  wire.entries = [{ name: 'src', type: 'dir' }]
  wire.gate = null
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  window.localStorage.clear()
  // happy-dom's matchMedia ignores innerWidth, and `useIsMobile` reads the band.
  window.matchMedia = ((query: string) => ({
    matches: /max-width:\s*768px/.test(query) ? window.innerWidth <= 768 : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = undefined
  root = undefined
})

const text = () => container?.textContent ?? ''

describe('DockPanel', () => {
  // One mount, one node — the property, not its markup: an inactive panel that unmounted would silence the verdict that sets its own tab's status and throw away its tree, filter and scroll position.
  function Counted({ mounts, nodes }: { mounts: { current: number }; nodes: HTMLElement[] }) {
    const ref = useRef<HTMLDivElement | null>(null)
    useEffect(() => {
      mounts.current += 1
    }, [mounts])
    useEffect(() => {
      if (ref.current) nodes.push(ref.current)
    })
    return <div ref={ref} data-counted="" />
  }

  it('keeps the same mount and the same node across being hidden and shown again', async () => {
    const mounts = { current: 0 }
    const nodes: HTMLElement[] = []
    const render = (active: boolean) =>
      act(() => {
        root?.render(
          <DockPanel active={active}>
            <Counted mounts={mounts} nodes={nodes} />
          </DockPanel>
        )
      })
    await render(true)
    const first = container?.querySelector('[data-counted]')
    await render(false)
    await render(true)
    expect(mounts.current).toBe(1)
    expect(container?.querySelector('[data-counted]')).toBe(first)
    expect(new Set(nodes).size).toBe(1)
  })

  it('spends no box of its own while active, and draws nothing while not', async () => {
    await act(() => {
      root?.render(
        <DockPanel active>
          <div data-counted="" />
        </DockPanel>
      )
    })
    expect(container?.querySelector('[data-dock-panel]')?.className).toBe('contents')
    await act(() => {
      root?.render(
        <DockPanel active={false}>
          <div data-counted="" />
        </DockPanel>
      )
    })
    expect(container?.querySelector('[data-dock-panel]')?.className).toBe('hidden')
  })
})

// The caller's own composition, as SessionDetailView builds it: two tabs, both panels mounted, the dock told which one is active.
const SESSIONS_TAB: DockTab = { key: 'sessions', label: 'Sessions', icon: 'messages-square' }
const FILES_TAB: DockTab = { key: 'files', label: 'Files', icon: 'folder-tree' }

const openSession: Session = {
  id: 'session-1',
  title: 'Session one',
  time: '11:02 AM',
  lastActivityAt: '2026-08-10T11:02:00.000Z',
  status: 'online',
  platform: 'slack',
  channel: '#ops',
  user: 'sam',
  duration: '1m',
  tokens: '2.1K',
  cost: '$0.01',
  toolCount: '1',
  statusLabel: 'completed',
  steps: [],
  agentId: 'agent-1'
}

function Host({ activeKey, sessions }: { activeKey: string; sessions: Session[] }) {
  const [filesSettled, setFilesSettled] = useState(false)
  const [sessionsWouldHide, setSessionsWouldHide] = useState<boolean | null>(null)
  const tabs: DockTab[] = [
    // The Sessions verdict, settled: `empty` only once the panel has answered that it would hide itself.
    {
      ...SESSIONS_TAB,
      status: sessionsWouldHide === false ? 'ready' : sessionsWouldHide === true ? 'empty' : 'loading'
    },
    { ...FILES_TAB, status: filesTabStatus(filesSettled) }
  ]
  return (
    <SessionDock tabs={tabs} activeKey={activeKey} onTabChange={() => {}} label="Panels">
      <DockPanel active={activeKey === 'sessions'}>
        <SessionsPanel
          sessions={sessions}
          current={openSession}
          total={sessions.length}
          agentIds={[]}
          filterTouched={false}
          onAgentIdsChange={() => {}}
          family={{ parentSessions: [], siblingSessions: [], childSessions: [] }}
          flatView={false}
          onSelect={() => {}}
          onWouldHideChange={setSessionsWouldHide}
        />
      </DockPanel>
      <DockPanel active={activeKey === 'files'}>
        <FilesPanel
          agentId="agent-1"
          sessionId="session-1"
          onOpenFile={() => {}}
          onRootSettledChange={setFilesSettled}
        />
      </DockPanel>
    </SessionDock>
  )
}

async function host(props: { activeKey: string; sessions?: Session[] }) {
  await act(async () => {
    root?.render(<Host activeKey={props.activeKey} sessions={props.sessions ?? [openSession]} />)
    await Promise.resolve()
  })
  await act(async () => {
    await Promise.resolve()
  })
}

const activePanel = () => container?.querySelector('[data-dock-panel][data-dock-panel-active]')
// The Files body by the one thing only it draws — its filter input, whose label is not text content.
const filesBody = () => container?.querySelector('[aria-label="Find file by path"]')
// A second row is what keeps the Sessions list worth drawing (`sessionsPanelWouldHide`: fewer than two rows and no family hides it).
const secondSession: Session = { ...openSession, id: 'session-2', title: 'Session two' }

describe('two tabs in the real dock', () => {
  it('draws the active panel and no placeholder once its own fetch has answered', async () => {
    await host({ activeKey: 'files', sessions: [openSession, secondSession] })
    expect(filesBody()).not.toBeNull()
    expect(container?.querySelector('[data-dock-loading]')).toBeNull()
    expect(container?.querySelector('[data-dock-empty]')).toBeNull()
    // Both panels are mounted; only one wrapper is the active one, and the file tree is inside it.
    expect(container?.querySelectorAll('[data-dock-panel]').length).toBe(2)
    expect(activePanel()?.contains(filesBody() ?? null)).toBe(true)
    // The Sessions rows are in the DOM too, under the wrapper that draws nothing.
    expect(text()).toContain('Session two')
  })

  it('says which kind of nothing the active tab has, with the chrome up because the OTHER tab is ready', async () => {
    // One session, no family, an untouched filter: the panel's own verdict is that it would hide itself.
    await host({ activeKey: 'sessions', sessions: [] })
    expect(container?.querySelector('[data-dock-empty]')?.textContent).toContain('Nothing to show')
    // Chrome up: with M0's single tab this same verdict made the dock `vacant` and withheld the strip entirely.
    expect(container?.querySelector('[role="tablist"]')).not.toBeNull()
    // Placeholder and body share one tabpanel, so the Files tree has to be outside the ACTIVE wrapper and inside a concealed one — the dock draws `body` whichever tab is selected.
    expect(activePanel()?.contains(filesBody() ?? null)).toBe(false)
    expect(filesBody()?.closest('[data-dock-panel]')?.className).toBe('hidden')
    expect(container?.querySelector('[data-dock-loading]')).toBeNull()
  })

  it('draws the loading placeholder, not an empty panel, while the active tab is still reading', async () => {
    // The listing held open, which is the only window in which Files is not ready. Sessions is ready beside it, which is what raises the chrome the placeholder needs — with M0's one tab this state was `vacant` and drew nothing at all.
    wire.gate = []
    await host({ activeKey: 'files', sessions: [openSession, secondSession] })
    expect(container?.querySelector('[data-dock-loading]')?.textContent).toContain('Loading…')
    expect(container?.querySelector('[role="tablist"]')).not.toBeNull()
    expect(filesBody()).toBeNull()

    const release = wire.gate
    wire.gate = null
    await act(async () => {
      release.forEach((resolve) => resolve())
      await Promise.resolve()
    })
    expect(container?.querySelector('[data-dock-loading]')).toBeNull()
    expect(filesBody()).not.toBeNull()
  })

  it('holds the dock track and its width in every one of those states', async () => {
    await host({ activeKey: 'sessions', sessions: [] })
    const track = container?.querySelector('[data-dock-track]')
    expect(track?.className).toContain('w-[var(--dock-width)]')
    expect(track?.className).toContain('wide:block')
  })
})
