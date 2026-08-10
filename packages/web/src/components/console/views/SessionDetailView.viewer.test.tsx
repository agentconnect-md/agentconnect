// @vitest-environment happy-dom

// The conversation ↔ viewer switch on the real session page: that `?file=` opens the viewer, that closing it puts the conversation back, and above all that the round trip does not REMOUNT the transcript — the state inside that region (expanded tool bodies, the composer's caret, an open @mention menu and the latch it reports upward) belongs to the session, not to the pane.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Session } from '@/lib/data'

const nav = vi.hoisted(() => ({ search: '', replaced: [] as string[], pushed: [] as string[] }))
const wire = vi.hoisted(() => ({
  file: '',
  fileExists: true,
  fileCalls: [] as Array<{ path: string; sessionId?: string }>,
  listCalls: [] as Array<{ path: string; sessionId?: string }>,
  /** Whether the open session has a worktree of its own; a shared workspace must never be asked for one. */
  isolation: 'session' as 'session' | 'shared'
}))

const NASTY_DIR = 'my dir+x'
const NASTY_FILE = 'ノート a+b (1).md'

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'session-1' }),
  usePathname: () => '/acme/sessions/session-1',
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({
    replace: (href: string) => {
      nav.replaced.push(href)
      nav.search = href.includes('?') ? href.slice(href.indexOf('?') + 1) : ''
    },
    push: (href: string) => nav.pushed.push(href),
    prefetch: () => {},
    back: () => {},
    forward: () => {},
    refresh: () => {}
  })
}))

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    fetchWorkspaceFiles: vi.fn((_agentId: string, opts: { path: string; sessionId?: string }) => {
      wire.listCalls.push(opts)
      // Root carries a directory whose name and child are deliberately hostile to a URL — space, `+`, parens and non-ASCII — so the param round-trip is exercised on bytes that actually encode, not on `notes.md`.
      return Promise.resolve({
        path: opts.path,
        exists: true,
        entries:
          opts.path === NASTY_DIR
            ? [{ name: NASTY_FILE, type: 'file' as const, size: 12, mtime: null }]
            : [
                { name: NASTY_DIR, type: 'dir' as const, size: null, mtime: null },
                { name: 'notes.md', type: 'file' as const, size: 12, mtime: null }
              ],
        nextCursor: null
      })
    }),
    fetchWorkspaceGitStatus: vi.fn(() => Promise.resolve({ isRepo: false })),
    fetchWorkspaceFile: vi.fn((_agentId: string, opts: { path: string; sessionId?: string }) => {
      wire.fileCalls.push(opts)
      return Promise.resolve({
        path: opts.path,
        exists: wire.fileExists,
        size: wire.file.length,
        mtime: '2026-08-10T10:00:00.000Z',
        encoding: 'utf8' as const,
        content: wire.file,
        offset: 0,
        nextOffset: null,
        truncated: false
      })
    }),
    fetchSessionMessages: vi.fn(() => Promise.resolve({ messages: [], nextCursor: null })),
    fetchSessionDetail: vi.fn(() => Promise.reject(new Error('no detail'))),
    fetchMySessionIdentity: vi.fn(() => Promise.reject(new Error('no identity'))),
    fetchConversationByKey: vi.fn(() => Promise.reject(new Error('no conversation')))
  }
})

const agent: Agent = {
  id: 'agent-1',
  name: 'Ops bot',
  runtime: 'claude',
  model: 'sonnet',
  status: 'online',
  statusLabel: 'online',
  icon: 'bot',
  daemon: 'daemon-1',
  workdir: './services/api',
  // A github checkout, which with a session-isolated worktree is what makes the reads session-scoped.
  workspace: { mode: 'github', repo: 'https://github.com/acme/api', branch: 'main' },
  canEdit: false
} as unknown as Agent

const session: Session = {
  id: 'session-1',
  title: 'Deploy the thing',
  time: '11:02 AM',
  lastActivityAt: '2026-08-10T11:02:00.000Z',
  status: 'idle',
  platform: 'slack',
  channel: '#ops',
  user: 'sam',
  duration: '1m',
  tokens: '2.1K',
  cost: '$0.01',
  toolCount: '1',
  statusLabel: 'completed',
  agentId: 'agent-1',
  agentName: 'Ops bot',
  steps: [{ kind: 'msg', who: 'sam', text: 'TRANSCRIPT MARKER' }]
} as unknown as Session

vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents: [agent],
    allSessions: [{ ...session, workspaceIsolation: wire.isolation }],
    getSessions: () => [session],
    sessionsLoading: false,
    crons: [],
    daemons: [],
    members: [],
    sessionActivityVersionById: {},
    sessionStreamGeneration: 0,
    revalidateSessionLists: () => {}
  })
}))

vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1', slug: 'acme' }, orgPath: (path: string) => `/acme${path}` })
}))

vi.mock('@/lib/profile', () => ({ useProfile: () => ({ user: { name: 'Sam' }, me: null }) }))

vi.mock('@/lib/acp-registry', () => ({ useAcpRegistry: () => ({}), acpRuntime: () => undefined }))

vi.mock('@/lib/stick-to-bottom', () => ({ useStickToBottom: () => () => {} }))

vi.mock('@/lib/auth', () => ({ isAuthConfigured: () => false }))

vi.mock('@/lib/use-session-list', () => ({
  useSessionList: () => ({ sessions: [], total: 0, isLoading: false, nextCursor: null, loadingMore: false })
}))

vi.mock('@/components/console/Shell', () => ({
  useCrumbSlot: () => ({ register: () => {} }),
  useMobileActionSlot: () => ({ action: null, register: () => {} })
}))

vi.mock('@/components/console/PlaygroundProvider', () => ({
  usePlayground: () => ({
    getPgSession: () => undefined,
    getLiveSteps: () => [],
    getBusyLaneAgentIds: () => [],
    reconcileLiveSteps: () => {},
    getPgImage: () => null,
    getPgWorktree: () => false,
    isPgBusy: () => false,
    setPgImage: () => {},
    pgSend: () => {},
    getPgQueue: () => [],
    pgCancelQueued: () => {},
    pgAddAgent: () => {},
    pgSetModel: () => {},
    pgSetEffort: () => {},
    pgSetPermissionPreset: () => {},
    pgSetFast: () => {},
    pgSetWorktree: () => {},
    pgCancel: () => {},
    setPgInput: () => {}
  }),
  usePgDraft: () => '',
  usePgDraftHasText: () => false
}))

import SessionDetailView from './SessionDetailView'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let container: HTMLDivElement | undefined
let root: ReturnType<typeof createRoot> | undefined

async function render() {
  await act(async () => {
    root?.render(<SessionDetailView />)
    await Promise.resolve()
  })
  await act(async () => {
    await Promise.resolve()
  })
}

const text = () => container?.textContent ?? ''
const pane = () => container?.querySelector('[data-conversation-pane]')
const viewer = () => container?.querySelector('[data-viewer-code]')
// A real transcript leaf, found by its own text rather than by a hook added for the test: the node the marker text lives in is exactly what a remount would replace.
const marker = () =>
  Array.from(container?.querySelectorAll('*') ?? []).find(
    (element) => element.children.length === 0 && element.textContent === 'TRANSCRIPT MARKER'
  )

/** Navigate the way the app does — a `router.replace` the mocked router feeds straight back into `useSearchParams`. */
async function press(selector: string) {
  const target = container?.querySelector<HTMLElement>(selector)
  if (!target) throw new Error(`no ${selector}`)
  await act(async () => {
    target.click()
    await Promise.resolve()
  })
  await render()
}

beforeEach(() => {
  nav.search = ''
  nav.replaced = []
  nav.pushed = []
  wire.file = 'line one\nline two\n'
  wire.fileExists = true
  wire.fileCalls = []
  wire.listCalls = []
  wire.isolation = 'session'
  window.localStorage.clear()
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = undefined
  root = undefined
})

describe('the session page in conversation mode', () => {
  it('draws the transcript and no viewer', async () => {
    await render()
    expect(text()).toContain('TRANSCRIPT MARKER')
    expect(viewer()).toBeNull()
    expect(pane()?.className).toBe('contents')
  })
})

describe('the session page in viewer mode', () => {
  it('opens the file named by the route, keeping the session header above it', async () => {
    nav.search = 'file=src%2Fnotes.md'
    await render()
    expect(wire.fileCalls.at(-1)?.path).toBe('src/notes.md')
    expect(viewer()).not.toBeNull()
    // The header stays: the page still names the session it belongs to.
    expect(text()).toContain('Deploy the thing')
  })

  it('conceals the conversation rather than unmounting it, and gives it back on close', async () => {
    nav.search = 'file=src%2Fnotes.md'
    await render()
    expect(pane()?.className).toBe('hidden')
    // Concealed, not gone — the transcript nodes are still in the tree.
    expect(text()).toContain('TRANSCRIPT MARKER')

    await press('[data-viewer-close]')
    expect(viewer()).toBeNull()
    expect(pane()?.className).toBe('contents')
  })

  it('does not remount the transcript across the round trip', async () => {
    await render()
    const before = marker()
    expect(before).not.toBeNull()

    nav.search = 'file=src%2Fnotes.md'
    await render()
    expect(marker()).toBe(before)

    await press('[data-viewer-close]')
    // The SAME DOM node, not an equal one: a remount would have built a new element and thrown away every piece of state hanging off it.
    expect(marker()).toBe(before)
  })

  it('takes the full width of the body column, and never the dock track', async () => {
    await render()
    const column = container?.querySelector('[data-conversation-pane]')?.parentElement
    expect(column?.className).toContain('max-w-[880px]')

    nav.search = 'file=src%2Fnotes.md'
    await render()
    expect(column?.className).not.toContain('max-w-[880px]')
    const track = container?.querySelector('[data-dock-track]')
    expect(track?.className).toContain('w-[var(--dock-width)]')
    expect(track?.className).toContain('wide:block')
  })

  it('renders the not-found state for a path this checkout does not have', async () => {
    wire.fileExists = false
    nav.search = 'file=src%2Fgone.ts'
    await render()
    expect(text()).toContain('this checkout has no file at that path')
    expect(viewer()).toBeNull()
    expect(pane()?.className).toBe('hidden')
  })
})

describe('the dock, now that a second tab exists', () => {
  it('draws exactly one panel at a time, whichever tab is active', async () => {
    // Both panels stay MOUNTED, so "is the Files body in the document" cannot answer this — the question is which wrapper is the active one.
    await render()
    const active = () => Array.from(container?.querySelectorAll('[data-dock-panel][data-dock-panel-active]') ?? [])
    expect(active()).toHaveLength(1)
    expect(active()[0]?.querySelector('[data-files-panel]')).toBeNull()

    await act(async () => {
      container?.querySelector<HTMLElement>('[data-dock-tab="files"]')?.click()
      await Promise.resolve()
    })
    await render()
    expect(active()).toHaveLength(1)
    expect(active()[0]?.querySelector('[data-files-panel]')).not.toBeNull()
  })

  it('offers both tabs and keeps the reserved track', async () => {
    await render()
    expect(container?.querySelector('[data-dock-tab="sessions"]')).not.toBeNull()
    expect(container?.querySelector('[data-dock-tab="files"]')).not.toBeNull()
    // The Files tab's own header action, drawn only while that tab is the active one.
    expect(container?.querySelector('[data-dock-action="files"]')).toBeNull()
  })

  it('says which kind of nothing the Sessions tab has, which M0 could not because the dock withheld its chrome', async () => {
    // One session, no family, an untouched filter: the Sessions verdict is a settled hide. With Files ready beside it the dock is no longer `vacant`, so the placeholder branch is reachable for the first time.
    await render()
    expect(container?.querySelector('[role=\"tablist\"]')).not.toBeNull()
    expect(container?.querySelector('[data-dock-empty]')?.textContent).toContain('Nothing to show')
    expect(container?.querySelector('[data-dock-loading]')).toBeNull()
  })

  it('gives the Files tab its refresh action once it is the tab on screen', async () => {
    await render()
    await act(async () => {
      container?.querySelector<HTMLElement>('[data-dock-tab=\"files\"]')?.click()
      await Promise.resolve()
    })
    const action = container?.querySelector('[data-dock-action="files"]')
    expect(action?.getAttribute('aria-label')).toBe('Refresh files')
    expect(container?.querySelector('[data-dock-empty]')).toBeNull()
    const listsBefore = wire.listCalls.length
    await act(async () => {
      ;(action as HTMLElement | null)?.click()
      await Promise.resolve()
    })
    expect(wire.listCalls.length).toBeGreaterThan(listsBefore)
  })
})

describe('the collapsed-band overlay', () => {
  it('closes when a file opens, because the drawer covers the pane the file lands in', async () => {
    await render()
    const trigger = container?.querySelector<HTMLElement>('[data-dock-trigger]')
    expect(trigger?.getAttribute('aria-expanded')).toBe('false')
    await act(async () => {
      trigger?.click()
      await Promise.resolve()
    })
    expect(container?.querySelector('[data-dock-trigger]')?.getAttribute('aria-expanded')).toBe('true')
    expect(container?.querySelector('[data-dock-scrim]')).not.toBeNull()

    nav.search = 'file=src%2Fnotes.md'
    await render()
    expect(container?.querySelector('[data-dock-trigger]')?.getAttribute('aria-expanded')).toBe('false')
    expect(container?.querySelector('[data-dock-scrim]')).toBeNull()
  })
})

describe('the workspace scope both surfaces read', () => {
  it('reads this session\u2019s own worktree when it has one', async () => {
    nav.search = 'file=src%2Fnotes.md'
    await render()
    expect(wire.fileCalls.at(-1)).toEqual({ path: 'src/notes.md', sessionId: 'session-1' })
    expect(wire.listCalls[0]).toEqual({ path: '', sessionId: 'session-1' })
  })

  it('never asks a shared workspace for a session worktree', async () => {
    // The daemon answers a shared workspace's sessionId with BAD_PAYLOAD, which the CP maps to a 503 reading \u201cthe daemon may be offline\u201d \u2014 so the scope has to be decided here, not discovered there.
    wire.isolation = 'shared'
    nav.search = 'file=src%2Fnotes.md'
    await render()
    expect(wire.fileCalls.at(-1)).toEqual({ path: 'src/notes.md' })
    expect(wire.listCalls[0]).toEqual({ path: '' })
  })
})

describe('the viewer route', () => {
  it('round-trips a nested path whose every segment has to be encoded', async () => {
    // A slash separator, a space, a `+` (which decodes back to a space if the param was written as a query value), parens and non-ASCII — the encoder has to survive all of them in both directions.
    const clickRow = async (text: string) => {
      const row = Array.from(container?.querySelectorAll<HTMLElement>('[data-dock-panel] button') ?? []).find(
        (button) => button.textContent?.includes(text)
      )
      expect(row, `no row for ${text}`).not.toBeNull()
      await act(async () => {
        row?.click()
        await Promise.resolve()
      })
      await render()
    }

    await render()
    // Opened from the Files tree, which is what writes the param.
    await clickRow('Files')
    await clickRow(NASTY_DIR)
    await clickRow(NASTY_FILE)

    const full = `${NASTY_DIR}/${NASTY_FILE}`
    const written = nav.replaced.at(-1) ?? ''
    const query = written.slice(written.indexOf('?') + 1)
    // Asserted as PROPERTIES rather than against a copy of the encoder, which could not catch the encoder being wrong: it is encoded at all, and it decodes to exactly the bytes the daemon is asked for.
    expect(query).not.toContain(' ')
    expect(query).not.toContain(full)
    expect(new URLSearchParams(query).get('file')).toBe(full)
    expect(wire.fileCalls.at(-1)?.path).toBe(full)
  })

  it('asks for the bytes the param carries, whitespace and all', async () => {
    // A POSIX filename may begin or end with a space. `URLSearchParams` round-trips those bytes, so trimming here would ask the daemon for a DIFFERENT file — and a name made only of spaces would close the viewer instead of opening it.
    nav.search = `file=${encodeURIComponent(' padded .ts ')}`
    await render()
    expect(wire.fileCalls.at(-1)?.path).toBe(' padded .ts ')
    expect(viewer()).not.toBeNull()
  })

  it('records which workspace the path was read from, and reopens against that one', async () => {
    // Header focus is component state that defaults to the current representative, and on a merged conversation that representative moves as another participant becomes newest — so a link carrying only `file` reopens someone else's checkout under the same path.
    await render()
    await act(async () => {
      container?.querySelector<HTMLElement>('[data-dock-tab="files"]')?.click()
      await Promise.resolve()
    })
    await render()
    const row = Array.from(container?.querySelectorAll<HTMLElement>('[data-dock-panel] button') ?? []).find((button) =>
      button.textContent?.includes('notes.md')
    )
    await act(async () => {
      row?.click()
      await Promise.resolve()
    })
    await render()
    const written = new URLSearchParams((nav.replaced.at(-1) ?? '').split('?')[1] ?? '')
    expect(written.get('file')).toBe('notes.md')
    expect(written.get('agent')).toBe('agent-1')
  })

  it('drops the workspace along with the file, so a closed viewer leaves no scope behind', async () => {
    nav.search = 'file=a.ts&agent=agent-1'
    await render()
    await press('[data-viewer-close]')
    expect(nav.replaced.at(-1)).not.toContain('agent=')
    expect(nav.replaced.at(-1)).not.toContain('file=')
  })

  it('replaces rather than pushes, so reading N files costs no history entries', async () => {
    nav.search = 'file=a.ts'
    await render()
    await press('[data-viewer-close]')
    expect(nav.pushed).toEqual([])
    expect(nav.replaced.length).toBeGreaterThan(0)
  })

  it('keeps every other query param it found', async () => {
    nav.search = 'view=flat&file=a.ts'
    await render()
    await press('[data-viewer-close]')
    expect(nav.replaced.at(-1)).toBe('/acme/sessions/session-1?view=flat')
  })
})
