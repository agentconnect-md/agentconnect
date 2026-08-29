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
  isolation: 'session' as 'session' | 'shared',
  /** Which credential vouches for the checkout. Both are git, so both have session worktrees. */
  workspaceProvider: 'github' as 'github' | 'gitlab',
  /** The Git tab's two reads. A from-scratch workspace by default, so every case that predates the tab sees what it saw. */
  git: { isRepo: false } as unknown,
  log: { isRepo: false, commits: [], truncated: false, tracking: null } as unknown,
  diffCalls: [] as Array<{ path: string; scope?: string; sessionId?: string }>,
  /** Every git read and every git write the page issued, so the coherence of the panel and the viewer after a write is observable rather than assumed. */
  gitCalls: 0,
  // The commit log is the ONLY read the Git panel alone issues — FilesPanel reads the same git status, so a status counter cannot tell the two panels' re-reads apart.
  logCalls: 0,
  stageCalls: [] as Array<{ kind: 'stage' | 'unstage'; paths: string[]; sessionId?: string }>,
  /** A session with no agent behind it at all — there is no checkout to offer a workspace tab for. */
  agentless: false,
  rail: [] as unknown[],
  /** The Tasks tab's read. Scoped by SESSION rather than by worktree, so its calls are recorded with the scope they asked for. */
  tasks: { sessionId: 'session-1', tracked: true, tasks: [] as unknown[], truncated: false } as unknown,
  taskCalls: [] as Array<{ agentId: string; sessionId: string }>,
  /** The PR tab's probe. `null` is the CP's 404 — the default, because most sessions were not dispatched for a pull request; `prFailStatus` overrides the failure shape. */
  pr: null as unknown,
  prFailStatus: 404,
  prCalls: [] as Array<{ sessionId: string; refresh: boolean }>,
  /** Non-null holds every PR probe until released, so the strip is observable while the linkage is unknown. */
  prGate: null as null | Array<() => void>,
  /** A synthetic playground session the daemon has not created yet — its route id names no canonical session the lease could be keyed by. */
  playground: false
}))

// The reader's role in the org. `viewer` is what the CP 403s on every git-write route, so the console withholds those controls.
const org = vi.hoisted(() => ({ role: 'collaborator' as 'collaborator' | 'viewer' }))

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
    fetchWorkspaceGitStatus: vi.fn(() => {
      wire.gitCalls += 1
      return Promise.resolve(wire.git)
    }),
    stageWorkspacePaths: vi.fn((_agentId: string, opts: { paths: string[]; sessionId?: string }) => {
      wire.stageCalls.push({ kind: 'stage', ...opts })
      return Promise.resolve(wire.git)
    }),
    unstageWorkspacePaths: vi.fn((_agentId: string, opts: { paths: string[]; sessionId?: string }) => {
      wire.stageCalls.push({ kind: 'unstage', ...opts })
      return Promise.resolve(wire.git)
    }),
    fetchWorkspaceGitLog: vi.fn(() => {
      wire.logCalls += 1
      return Promise.resolve(wire.log)
    }),
    fetchWorkspaceGitDiff: vi.fn((_agentId: string, opts: { path: string; scope?: string; sessionId?: string }) => {
      wire.diffCalls.push(opts)
      return Promise.resolve({
        path: opts.path,
        isRepo: true,
        exists: true,
        diff: '@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n',
        binary: false,
        truncated: false
      })
    }),
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
    fetchAgentTasks: vi.fn((agentId: string, sessionId: string) => {
      wire.taskCalls.push({ agentId, sessionId })
      return Promise.resolve(wire.tasks)
    }),
    fetchSessionPullRequest: vi.fn(async (sessionId: string, opts: { refresh?: boolean } = {}) => {
      wire.prCalls.push({ sessionId, refresh: opts.refresh === true })
      if (wire.prGate) await new Promise<void>((resolve) => wire.prGate?.push(resolve))
      if (wire.pr) return wire.pr
      throw new actual.ApiError('pull request not found', wire.prFailStatus)
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
  workspace: {
    mode: 'git',
    provider: 'github',
    gitRepo: 'https://github.com/acme/api',
    repo: 'acme/api',
    branch: 'main'
  },
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
    agents: [{ ...agent, workspace: { ...agent.workspace, provider: wire.workspaceProvider } }],
    allSessions: [
      {
        ...session,
        workspaceIsolation: wire.isolation,
        ...(wire.agentless ? { agentId: '', agentName: '' } : {}),
        ...(wire.playground ? { platform: 'playground' } : {})
      }
    ],
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
  useOrgs: () => ({
    activeOrg: { id: 'org-1', slug: 'acme' },
    myRole: org.role,
    orgPath: (path: string) => `/acme${path}`
  })
}))

vi.mock('@/lib/profile', () => ({ useProfile: () => ({ user: { name: 'Sam' }, me: null }) }))

vi.mock('@/lib/acp-registry', () => ({ useAcpRegistry: () => ({}), acpRuntime: () => undefined }))

vi.mock('@/lib/stick-to-bottom', () => ({ useStickToBottom: () => () => {} }))

vi.mock('@/lib/auth', () => ({ isAuthConfigured: () => false }))

// The dock's Sessions page. Non-empty in the cases that need the tab STRIP on screen: with every tab non-ready the dock is `vacant` and withholds the strip entirely, which would mask which tabs it was offered.
vi.mock('@/lib/use-session-list', () => ({
  useSessionList: () => ({
    sessions: wire.rail,
    total: wire.rail.length,
    isLoading: false,
    nextCursor: null,
    loadingMore: false
  })
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
    openPlayground: () => 'pg_new',
    pgSend: () => {},
    pgAttach: () => {},
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
  wire.workspaceProvider = 'github'
  wire.git = { isRepo: false }
  wire.log = { isRepo: false, commits: [], truncated: false, tracking: null }
  wire.diffCalls = []
  wire.gitCalls = 0
  wire.logCalls = 0
  wire.stageCalls = []
  org.role = 'collaborator'
  wire.agentless = false
  wire.playground = false
  wire.rail = []
  wire.tasks = { sessionId: 'session-1', tracked: true, tasks: [], truncated: false }
  wire.taskCalls = []
  wire.pr = null
  wire.prFailStatus = 404
  wire.prCalls = []
  wire.prGate = null
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

  it('reads a GitLab checkout\u2019s own worktree too \u2014 the gate is git, not one host', async () => {
    // The gate used to name GitHub, so a GitLab worktree session silently read the agent's PRIMARY checkout.
    wire.workspaceProvider = 'gitlab'
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

  it('fails CLOSED when the link names a workspace this conversation does not have', async () => {
    // The dangerous alternative is falling back to the default agent: the same path opens against a different checkout and draws plausible, wrong content — which is the ambiguity `agent=` exists to remove.
    nav.search = 'file=a.ts&agent=agent-not-here'
    await render()
    expect(viewer()).toBeNull()
    expect(container?.querySelector('[data-viewer-stale-link]')).not.toBeNull()
    // And nothing was read from anyone's checkout on the strength of that link.
    expect(wire.fileCalls).toEqual([])
    expect(pane()?.className).toBe('contents')
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

describe('the Git tab', () => {
  const gitFile = (path: string, index: string, workingDir: string) => ({
    path,
    index,
    workingDir,
    additions: 12,
    deletions: 3
  })
  const dirtyRepo = {
    isRepo: true,
    clean: false,
    repo: null,
    agentDir: null,
    branch: 'main',
    tracking: 'origin/main',
    ahead: 1,
    behind: 0,
    files: [gitFile('src/staged.ts', 'A', ' '), gitFile('src/edited.ts', ' ', 'M')],
    truncated: false,
    lastCommit: null,
    lastFetchAt: null
  }
  const openTab = async (key: string) => {
    await act(async () => {
      container?.querySelector<HTMLElement>(`[data-dock-tab="${key}"]`)?.click()
      await Promise.resolve()
    })
    await render()
  }
  const gitRow = (path: string) => container?.querySelector<HTMLElement>(`[data-git-row="${path}"]`)
  const written = () => new URLSearchParams((nav.replaced.at(-1) ?? '').split('?')[1] ?? '')

  it('sits beside Files with its own refresh action, and mounts its panel with it', async () => {
    wire.git = dirtyRepo
    await render()
    expect(container?.querySelector('[data-dock-tab="git"]')).not.toBeNull()
    // Mounted with the other panels rather than on first visit: its verdict is what keeps its own tab reachable.
    expect(container?.querySelector('[data-git-panel]')).not.toBeNull()

    await openTab('git')
    const action = container?.querySelector('[data-dock-action="git"]')
    expect(action?.getAttribute('aria-label')).toBe('Refresh git status')
    expect(container?.querySelector('[data-dock-empty]')).toBeNull()
  })

  it('badges the tab with the changed-file count, and drops the badge when the refresh finds a clean tree', async () => {
    wire.git = dirtyRepo
    await render()
    expect(container?.querySelector('[data-dock-tab="git"]')?.textContent).toContain('2')

    // A re-read is the only way the count changes — the panel does not poll — so the tab's own refresh action is what has to carry the new verdict up.
    wire.git = { ...dirtyRepo, clean: true, files: [] }
    await openTab('git')
    await act(async () => {
      container?.querySelector<HTMLElement>('[data-dock-action="git"]')?.click()
      await Promise.resolve()
    })
    await render()
    expect(container?.querySelector('[data-dock-tab="git"]')?.textContent).not.toContain('2')
    expect(container?.querySelector('[data-git-panel]')?.textContent).toContain('Nothing has changed')
  })

  it('opens a row’s diff in the viewer, on the side of the index the row came from', async () => {
    wire.git = dirtyRepo
    await render()
    await openTab('git')

    await act(async () => {
      gitRow('src/edited.ts')?.click()
      await Promise.resolve()
    })
    await render()
    // The whole scope travels in the URL: the path, the workspace it was read from, and which read.
    expect(written().get('file')).toBe('src/edited.ts')
    expect(written().get('agent')).toBe('agent-1')
    expect(written().get('mode')).toBe('diff')
    expect(wire.diffCalls.at(-1)).toEqual({ path: 'src/edited.ts', scope: 'unstaged', sessionId: 'session-1' })
    // Diff mode draws the parsed diff, and never spends a file read on the way there.
    expect(container?.querySelector('[data-viewer-diff]')).not.toBeNull()
    expect(wire.fileCalls).toEqual([])

    await act(async () => {
      gitRow('src/staged.ts')?.click()
      await Promise.resolve()
    })
    await render()
    expect(written().get('mode')).toBe('staged')
    expect(wire.diffCalls.at(-1)).toEqual({ path: 'src/staged.ts', scope: 'staged', sessionId: 'session-1' })
  })

  it('toggles the pill through the URL, spends no history entry, and takes the mode away with the file', async () => {
    wire.git = dirtyRepo
    nav.search = 'file=src%2Fedited.ts&agent=agent-1&mode=diff'
    await render()
    expect(container?.querySelector('[data-viewer-diff]')).not.toBeNull()

    await press('[data-viewer-mode="file"]')
    expect(written().get('mode')).toBeNull()
    expect(written().get('file')).toBe('src/edited.ts')
    expect(container?.querySelector('[data-viewer-code]')).not.toBeNull()

    await press('[data-viewer-mode="diff"]')
    expect(written().get('mode')).toBe('diff')

    await press('[data-viewer-close]')
    expect(nav.replaced.at(-1)).not.toContain('mode=')
    expect(nav.pushed).toEqual([])
  })

  it('reads an unknown mode as File mode rather than refusing to open the file', async () => {
    nav.search = 'file=src%2Fnotes.md&mode=sideways'
    await render()
    expect(container?.querySelector('[data-viewer-code]')).not.toBeNull()
    expect(container?.querySelector('[data-viewer-diff]')).toBeNull()
    expect(wire.diffCalls).toEqual([])
  })

  it('withholds every git read from a link whose workspace this conversation does not have', async () => {
    wire.git = dirtyRepo
    nav.search = 'file=a.ts&agent=agent-not-here&mode=diff'
    await render()
    // Fails closed like M1's file read: no diff is read against a checkout the link could not name.
    expect(container?.querySelector('[data-viewer-diff]')).toBeNull()
    expect(wire.diffCalls).toEqual([])
    expect(container?.querySelector('[data-viewer-stale-link]')).not.toBeNull()
  })

  it('keeps the panel and the open diff in step after a stage from the Git panel', async () => {
    wire.git = dirtyRepo
    // A diff of that same path is on screen, which is the disagreement M2 recorded: the tab's refresh re-read status and log, never the viewer.
    nav.search = 'file=src%2Fedited.ts&agent=agent-1&mode=diff'
    await render()
    await openTab('git')
    const diffReads = wire.diffCalls.length
    const listReads = wire.listCalls.length
    const logReads = wire.logCalls

    await act(async () => {
      container?.querySelector<HTMLElement>('[data-git-toggle="src/edited.ts"]')?.click()
      await Promise.resolve()
    })
    await render()

    expect(wire.stageCalls).toEqual([{ kind: 'stage', paths: ['src/edited.ts'], sessionId: 'session-1' }])
    // The viewer re-reads the diff it is showing, and the Files tree re-lists so its status badges are not left describing the tree before the write.
    expect(wire.diffCalls.length).toBeGreaterThan(diffReads)
    expect(wire.listCalls.length).toBeGreaterThan(listReads)
    // The panel itself does NOT re-read: the write's reply carried the fresh status, which is the whole reason the REP has that shape (§6).
    expect(wire.logCalls).toBe(logReads)
  })

  it('makes the panel re-read its lists after a stage from the VIEWER, which holds no fresh status', async () => {
    wire.git = dirtyRepo
    nav.search = 'file=src%2Fedited.ts&agent=agent-1&mode=diff'
    await render()
    await openTab('git')
    const logReads = wire.logCalls

    await act(async () => {
      container?.querySelector<HTMLElement>('[data-viewer-stage]')?.click()
      await Promise.resolve()
    })
    await render()

    expect(wire.stageCalls).toEqual([{ kind: 'stage', paths: ['src/edited.ts'], sessionId: 'session-1' }])
    // The panel made no write, so nothing handed it a fresh status: it has to ask again — status and log both.
    expect(wire.logCalls).toBeGreaterThan(logReads)
  })

  it('withholds every write control from a viewer-role reader, in the panel and in the pane', async () => {
    org.role = 'viewer'
    wire.git = dirtyRepo
    nav.search = 'file=src%2Fedited.ts&agent=agent-1&mode=diff'
    await render()
    await openTab('git')

    expect(container?.querySelector('[data-git-toggle="src/edited.ts"]')).toBeNull()
    expect(container?.querySelector('[data-commit-box]')).toBeNull()
    expect(container?.querySelector('[data-viewer-stage]')).toBeNull()
    // The diff is still readable — a viewer reviews, and is told why there is nothing to press.
    expect(container?.querySelector('[data-viewer-diff]')).not.toBeNull()
    expect(container?.querySelector('[data-git-panel]')?.textContent).toContain('Review only')
  })
})

describe('the Tasks tab', () => {
  const openTab = async (key: string) => {
    await act(async () => {
      container?.querySelector<HTMLElement>(`[data-dock-tab="${key}"]`)?.click()
      await Promise.resolve()
    })
    await render()
  }
  const runningTask = (id: string) => ({
    id,
    description: `background ${id}`,
    state: 'running',
    subagent: false,
    startedAt: '2026-08-10T10:59:00.000Z',
    endedAt: null,
    detail: null
  })

  it('sits beside Files and Git with its own refresh action, and mounts its panel with them', async () => {
    await render()
    expect(container?.querySelector('[data-dock-tab="tasks"]')).not.toBeNull()
    // Mounted rather than lazily created on first visit: like the others, its verdict is what keeps its own tab reachable.
    expect(container?.querySelector('[data-tasks-panel]')).not.toBeNull()

    await openTab('tasks')
    expect(container?.querySelector('[data-dock-action="tasks"]')?.getAttribute('aria-label')).toBe(
      'Refresh background tasks'
    )
    expect(container?.querySelector('[data-dock-empty]')).toBeNull()
  })

  it('reads the FOCUSED SESSION’s lease even on a shared workspace, where the worktree scope is empty', async () => {
    // The divergence M4 rewrote the CP gate for: a background task is not a checkout, so a session that shares its agent's workspace still runs them and still has a lease keyed by (agent, session). Files and Git must pass no sessionId here — the daemon rejects one for a shared workspace — and Tasks must pass one anyway, or the panel reads a scope the daemon has nothing to answer with.
    wire.isolation = 'shared'
    wire.tasks = { sessionId: 'session-1', tracked: true, tasks: [runningTask('t1')], truncated: false }
    await render()
    expect(wire.listCalls.every((call) => call.sessionId === undefined)).toBe(true)
    expect(wire.taskCalls).toEqual([{ agentId: 'agent-1', sessionId: 'session-1' }])
    expect(container?.querySelector('[data-tasks-panel]')?.textContent).toContain('background t1')
  })

  it('badges the tab with the running count, and drops the badge when its refresh finds them finished', async () => {
    wire.tasks = {
      sessionId: 'session-1',
      tracked: true,
      tasks: [runningTask('t1'), runningTask('t2')],
      truncated: false
    }
    await render()
    expect(container?.querySelector('[data-dock-tab="tasks"]')?.textContent).toContain('2')

    // Opened FIRST, so the panel's own on-activation read is already spent and cannot be what makes the badge move below. The tab's refresh action is then the only thing left that can.
    await openTab('tasks')
    expect(wire.taskCalls).toHaveLength(2)
    expect(container?.querySelector('[data-dock-tab="tasks"]')?.textContent).toContain('2')

    wire.tasks = {
      sessionId: 'session-1',
      tracked: true,
      tasks: [{ ...runningTask('t1'), state: 'done', endedAt: '2026-08-10T11:00:00.000Z' }],
      truncated: false
    }
    await act(async () => {
      container?.querySelector<HTMLElement>('[data-dock-action="tasks"]')?.click()
      await Promise.resolve()
    })
    await render()
    expect(container?.querySelector('[data-dock-tab="tasks"]')?.textContent).not.toContain('2')
    expect(container?.querySelector('[data-tasks-panel]')?.textContent).toContain('1 done')
  })

  it('offers no Tasks tab for a synthetic playground session, whose canonical id does not exist yet', async () => {
    // The lease is keyed by the daemon's OWN session id. A playground session it has not created yet has no such id and no tasks either, so asking with the synthetic route id would only manufacture a 404 notice; Files and Git keep their tabs — the checkout is real even while the session is not.
    wire.playground = true
    await render()
    expect(container?.querySelector('[data-dock-tab="files"]')).not.toBeNull()
    expect(container?.querySelector('[data-dock-tab="tasks"]')).toBeNull()
    expect(container?.querySelector('[data-tasks-panel]')).toBeNull()
    expect(wire.taskCalls).toEqual([])
  })

  it('draws an untracked session as data, with no badge and no error', async () => {
    // A runtime that publishes no task lifecycle holds no lease at all. That is an answer, not a failure, and it is a different sentence from "nothing is running".
    wire.tasks = { sessionId: 'session-1', tracked: false, tasks: [], truncated: false }
    await render()
    await openTab('tasks')
    expect(container?.querySelector('[data-tasks-panel]')?.textContent).toContain('doesn’t report background tasks')
    expect(container?.querySelector('[data-dock-tab="tasks"]')?.textContent).toBe('Tasks')
    expect(container?.querySelector('[data-dock-empty]')).toBeNull()
  })
})

describe('the PR tab', () => {
  const openTab = async (key: string) => {
    await act(async () => {
      container?.querySelector<HTMLElement>(`[data-dock-tab="${key}"]`)?.click()
      await Promise.resolve()
    })
    await render()
  }
  // The wire shape of GET /sessions/:id/pull-request, in the small: identity plus the three live lists.
  const prDto = (overrides: Record<string, unknown> = {}) => ({
    repoFullName: 'acme/api',
    pullNumber: 57,
    title: 'Ship the dock',
    state: 'open',
    isDraft: false,
    url: 'https://github.com/acme/api/pull/57',
    headRef: 'feat/dock',
    baseRef: 'main',
    additions: 120,
    deletions: 30,
    reviewDecision: null,
    checks: [],
    checksTruncated: false,
    reviews: [],
    threads: [
      { location: 'src/dock.ts:12', body: 'This needs the org.', author: 'sam', isOutdated: false },
      { location: 'src/dock.ts:40', body: 'And this.', author: 'sam', isOutdated: false }
    ],
    unresolvedCount: 2,
    threadsTruncated: false,
    degraded: false,
    degradedReason: null,
    ...overrides
  })

  it('is HIDDEN for a session whose workspace is no checkout, whose 404 is asked exactly once', async () => {
    // The default wire answer IS the 404, over a from-scratch workspace: with no checkout there is no branch a pull request could ever be opened from, so the strip must not carry a dead tab. One probe decides it — the linkage cannot appear later, so nothing re-asks.
    await render()
    expect(container?.querySelector('[data-dock-tab="pr"]')).toBeNull()
    expect(wire.prCalls).toEqual([{ sessionId: 'session-1', refresh: false }])
    await render()
    await render()
    expect(wire.prCalls).toHaveLength(1)
  })

  it('KEEPS its tab over a checkout with no linked run, naming the branch that has no upstream yet', async () => {
    // The same 404, but the session works in a real checkout: "no pull request" is then a state with a next action, not an absence to hide.
    wire.git = {
      isRepo: true,
      clean: true,
      repo: null,
      agentDir: null,
      branch: 'dev/jane-doe/candid-lynx',
      tracking: null,
      ahead: null,
      behind: null,
      files: [],
      truncated: false,
      lastCommit: null,
      lastFetchAt: null
    }
    wire.log = { isRepo: true, commits: [], truncated: false, tracking: null }
    await render()
    const tab = container?.querySelector('[data-dock-tab="pr"]')
    expect(tab).not.toBeNull()
    await act(async () => {
      tab?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    await render()
    const panel = container?.querySelector('[data-pr-panel="none"]')
    expect(panel?.textContent).toContain('No upstream configured')
    expect(panel?.textContent).toContain('dev/jane-doe/candid-lynx')
  })

  it('withholds the no-PR state when the git read is about a DIFFERENT scope than this panel', async () => {
    // Files/Git follow header focus; the PR tab follows the open session. A shared-workspace session
    // makes the Git read the agent's PRIMARY checkout — `main` here — which is no session branch at
    // all. Drawing the state off it would both name the wrong branch and put THIS session's create
    // action on screen off another checkout's eligibility, so the tab is dropped instead.
    wire.isolation = 'shared'
    wire.git = {
      isRepo: true,
      clean: true,
      repo: null,
      agentDir: null,
      branch: 'main',
      tracking: 'origin/main',
      ahead: null,
      behind: null,
      files: [],
      truncated: false,
      lastCommit: null,
      lastFetchAt: null
    }
    wire.log = { isRepo: true, commits: [], truncated: false, tracking: 'origin/main', base: null }
    await render()
    // No tab, so the action is unreachable — the panel still MOUNTS (its verdict is what could reveal
    // a tab at all), and what it drew names no branch: the scope-free copy, not `main`'s state.
    expect(container?.querySelector('[data-dock-tab="pr"]')).toBeNull()
    const panel = container?.querySelector('[data-pr-panel="none"]')
    expect(panel?.textContent).toContain('No pull request is linked to this session yet')
    expect(panel?.textContent).not.toContain('main')
    expect(panel?.textContent).not.toContain('No upstream configured')
  })

  it('stands in the strip as loading while the linkage is unknown, then leaves it when the 404 lands', async () => {
    // The strip CHANGES SHAPE on the answer: a session with no PR AND no checkout loses the tab rather than keeping a dead one — the probe's verdict is what tells it from a linked one.
    wire.prGate = []
    await render()
    expect(container?.querySelector('[data-dock-tab="pr"]')).not.toBeNull()

    const release = wire.prGate
    wire.prGate = null
    await act(async () => {
      release.forEach((resolve) => resolve())
      await Promise.resolve()
    })
    await render()
    expect(container?.querySelector('[data-dock-tab="pr"]')).toBeNull()
  })

  it('shows the tab with the unresolved-thread badge for a linked session, keyed by the SESSION', async () => {
    wire.pr = prDto()
    await render()
    expect(container?.querySelector('[data-dock-tab="pr"]')?.textContent).toContain('2')
    // Session-keyed, never agent-keyed: the run belongs to the session, so a header-focus change in a merged conversation has nothing to re-key (the probe carries no agent id at all).
    expect(wire.prCalls).toEqual([{ sessionId: 'session-1', refresh: false }])

    await openTab('pr')
    expect(container?.querySelector('[data-pr-panel]')?.textContent).toContain('Ship the dock')
    expect(container?.querySelector('[data-dock-empty]')).toBeNull()
  })

  it('gives the active tab the design’s external-link action, which opens the PR’s own page', async () => {
    wire.pr = prDto()
    const opened: string[] = []
    window.open = ((url: string) => {
      opened.push(String(url))
      return null
    }) as typeof window.open
    await render()
    await openTab('pr')
    const action = container?.querySelector<HTMLElement>('[data-dock-action="pr"]')
    expect(action?.getAttribute('aria-label')).toBe('Open the pull request on GitHub')
    await act(async () => {
      action?.click()
      await Promise.resolve()
    })
    expect(opened).toEqual(['https://github.com/acme/api/pull/57'])
  })

  it('keeps the tab when the probe FAILS, because a failed read is not "no PR"', async () => {
    // 404 means the CP verified there is no linked run; a 503 or a network failure verified nothing, so hiding here would assert an absence nobody read. The tab stays and its panel says why it is empty-handed.
    wire.prFailStatus = 503
    await render()
    expect(container?.querySelector('[data-dock-tab="pr"]')).not.toBeNull()
    await openTab('pr')
    expect(container?.querySelector('[data-pr-panel="failed"]')?.textContent).toContain(
      'Couldn’t read this session’s pull request'
    )
  })

  it('wears no badge and still names its PR when GitHub is degraded', async () => {
    // Degraded is DATA (§2): identity from the CP's own records survives, and the badge is withheld because the thread count is unknown rather than zero.
    wire.pr = prDto({
      state: 'closed',
      isDraft: null,
      additions: null,
      deletions: null,
      threads: [],
      unresolvedCount: 0,
      degraded: true,
      degradedReason: 'rate_limited'
    })
    await render()
    await openTab('pr')
    // The ACTIVE tab draws its label, so a badge pill would be visible beside it — `PR` alone is the withheld badge.
    expect(container?.querySelector('[data-dock-tab="pr"]')?.textContent).toBe('PR')
    expect(container?.querySelector('[data-pr-panel]')?.textContent).toContain('Ship the dock')
    expect(container?.querySelector('[data-pr-panel]')?.textContent).toContain('rate limiting')
  })

  it('sends no probe at all for a synthetic playground session, which names no CP row', async () => {
    wire.playground = true
    await render()
    expect(container?.querySelector('[data-dock-tab="pr"]')).toBeNull()
    expect(wire.prCalls).toEqual([])
  })
})

describe('a session with no agent behind it', () => {
  it('offers neither workspace tab, because a tab that can never answer is not a tab', async () => {
    wire.agentless = true
    // A second row so the Sessions tab reports `ready`: with every tab non-ready the dock is vacant and draws no strip at all, which would hide the answer this case is about.
    wire.rail = [{ ...session, id: 'session-2', title: 'Another run' }]
    await render()

    expect(container?.querySelector('[data-dock-tab="sessions"]')).not.toBeNull()
    expect(container?.querySelector('[data-dock-tab="files"]')).toBeNull()
    expect(container?.querySelector('[data-dock-tab="git"]')).toBeNull()
    // Tasks goes with them: with no agent there is no daemon to ask for a lease either.
    expect(container?.querySelector('[data-dock-tab="tasks"]')).toBeNull()
    // And no panel was mounted to read a checkout that does not exist.
    expect(container?.querySelector('[data-git-panel]')).toBeNull()
    expect(container?.querySelector('[data-files-panel]')).toBeNull()
    expect(container?.querySelector('[data-tasks-panel]')).toBeNull()
    expect(wire.taskCalls).toEqual([])
  })

  it('falls back to a tab that exists when the open one is dropped under the reader', async () => {
    wire.rail = [{ ...session, id: 'session-2', title: 'Another run' }]
    await render()
    await act(async () => {
      container?.querySelector<HTMLElement>('[data-dock-tab="git"]')?.click()
      await Promise.resolve()
    })
    await render()
    expect(container?.querySelector('[data-dock-tab="git"]')?.getAttribute('aria-selected')).toBe('true')

    // The agent leaves the conversation while its tab is the open one: without the fallback the dock is left with no active tab and an unlabelled panel.
    wire.agentless = true
    await render()
    const active = Array.from(container?.querySelectorAll('[data-dock-panel][data-dock-panel-active]') ?? [])
    expect(active).toHaveLength(1)
    expect(container?.querySelector('[data-dock-tab="sessions"]')?.getAttribute('aria-selected')).toBe('true')
  })
})
