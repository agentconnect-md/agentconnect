// @vitest-environment happy-dom

// The session page's one-line desktop header: state, name and place on the left; people, requests, details and the link on the right.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, DaemonRow, Session } from '@/lib/data'
import type { AgentPermissionRequestDto, SessionDetailDto } from '@/lib/api'

const wire = vi.hoisted(() => ({
  detail: null as unknown,
  ownerDetail: null as unknown,
  chatActions: 'approve' as 'talk' | 'approve' | 'settings',
  canEdit: true,
  requests: [] as AgentPermissionRequestDto[],
  messages: [] as unknown[],
  conversationReads: [] as string[],
  agentReads: [] as string[],
  decisions: [] as unknown[][]
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'session-1' }),
  usePathname: () => '/acme/sessions/session-1',
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({
    replace: () => {},
    push: () => {},
    prefetch: () => {},
    back: () => {},
    forward: () => {},
    refresh: () => {}
  })
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  )
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    fetchSessionMessages: vi.fn(() => Promise.resolve({ messages: wire.messages, nextCursor: null })),
    fetchSessionDetail: vi.fn((id: string) =>
      Promise.resolve(id === 'owner-1' && wire.ownerDetail ? wire.ownerDetail : wire.detail)
    ),
    fetchMySessionIdentity: vi.fn(() => Promise.reject(new Error('no identity'))),
    fetchConversationByKey: vi.fn(() => Promise.reject(new Error('no conversation'))),
    fetchAgentTasks: vi.fn(() =>
      Promise.resolve({ sessionId: 'session-1', tracked: true, tasks: [], truncated: false })
    ),
    fetchSessionPullRequest: vi.fn(() => Promise.reject(new actual.ApiError('pull request not found', 404))),
    fetchWorkspaceFiles: vi.fn((_agentId: string, opts: { path: string }) =>
      Promise.resolve({ path: opts.path, exists: true, entries: [], nextCursor: null })
    ),
    fetchWorkspaceGitStatus: vi.fn(() => Promise.resolve({ isRepo: false })),
    fetchWorkspaceGitLog: vi.fn(() =>
      Promise.resolve({ isRepo: false, commits: [], truncated: false, tracking: null })
    ),
    fetchSessionPermissionRequests: vi.fn((sessionId: string) => {
      wire.conversationReads.push(sessionId)
      return Promise.resolve(wire.requests)
    }),
    fetchAgentPermissionRequests: vi.fn((agentId: string) => {
      wire.agentReads.push(agentId)
      return Promise.resolve(wire.requests)
    }),
    decideSessionPermissionRequest: vi.fn((...args: unknown[]) => {
      wire.decisions.push(args)
      return Promise.resolve()
    })
  }
})

// A viewer of the agent: they edit nothing, so only owning the conversation lets them act in it.
const agent = {
  id: 'agent-1',
  name: 'Ops bot',
  runtime: 'codex',
  model: 'model-a',
  status: 'online',
  statusLabel: 'online',
  icon: 'bot',
  daemon: 'daemon-1',
  workdir: './services/api',
  workspace: { mode: 'scratch' },
  canEdit: false
} as unknown as Agent

const listRow = {
  id: 'session-1',
  title: 'Usage report',
  status: 'idle',
  statusLabel: 'completed',
  platform: 'webchat',
  channel: 'Playground',
  channelId: 'conv-1',
  user: 'sam',
  agentId: 'agent-1',
  agentName: 'Ops bot',
  daemon: 'daemon-1',
  runtime: 'codex',
  model: 'model-a',
  effort: 'high',
  steps: []
} as unknown as Session

const daemons = [
  {
    daemonId: 'daemon-1',
    name: 'edge-1',
    runtimeModels: [{ runtime: 'codex', version: '1', models: ['model-a', 'model-c'] }],
    mcpServers: [],
    caps: { features: [] }
  }
] as unknown as DaemonRow[]

vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents: [{ ...agent, chatActions: wire.chatActions, canEdit: wire.canEdit }],
    allSessions: [listRow],
    getSessions: () => [listRow],
    sessionsLoading: false,
    crons: [],
    daemons,
    memberSets: [],
    orgSetIds: new Set<string>(),
    members: [],
    sessionActivityVersionById: {},
    sessionStreamGeneration: 0,
    revalidateSessionLists: () => {}
  })
}))

vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({
    activeOrg: { id: 'org-1', slug: 'acme' },
    myRole: 'viewer',
    orgPath: (p: string) => `/acme${p}`
  })
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

vi.mock('@/components/console/PlaygroundProvider', () => {
  const playground = {
    getPgSuggestion: () => undefined,
    getPgSession: () => undefined,
    getLiveSteps: () => [],
    getBusyLaneAgentIds: () => [],
    reconcileLiveSteps: () => {},
    getPgImage: () => null,
    getPgFiles: () => [],
    setPgFiles: () => {},
    getPgWorktree: () => false,
    isPgBusy: () => false,
    isPgTurnUnstreamed: () => false,
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
    pgAnswerElicitation: () => {},
    setPgInput: () => {}
  }
  return { usePlayground: () => playground, usePgDraft: () => '', usePgDraftHasText: () => false }
})

import SessionDetailView from './SessionDetailView'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let container: HTMLDivElement | undefined
let root: ReturnType<typeof createRoot> | undefined

const detail = (ownsConversation: boolean): SessionDetailDto =>
  ({
    id: 'session-1',
    parentSession: null,
    childSessions: [],
    agentId: 'agent-1',
    platform: 'webchat',
    channel: 'conv-1',
    thread: null,
    title: 'Usage report',
    status: 'idle',
    lastActivityAt: '2026-09-26T00:00:00.000Z',
    usage: null,
    triggeredBy: 'sam',
    channelName: 'Playground',
    triggeredByName: 'Sam',
    threadUrl: null,
    runtime: 'codex',
    model: 'model-a',
    effort: 'high',
    fastMode: null,
    permissionMode: null,
    outputMode: null,
    daemonId: 'daemon-1',
    workspaceIsolation: 'shared',
    executorDaemonId: null,
    stayedHomeReason: null,
    ownsConversation
  }) as SessionDetailDto

const request: AgentPermissionRequestDto = {
  id: 'request-1',
  agentId: 'agent-1',
  sessionId: 'session-1',
  createdAt: '2026-09-26T00:00:00.000Z',
  requesterId: null,
  requesterName: 'Sam',
  command: 'Bash: npm test',
  status: 'pending',
  resolvedAt: null
}

async function render() {
  await act(async () => {
    root?.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <SessionDetailView />
      </SWRConfig>
    )
    await Promise.resolve()
  })
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

const button = (label: string) =>
  [...(container?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent === label)
const picker = () => container?.querySelector<HTMLButtonElement>('button[aria-label="Model"]')

beforeEach(() => {
  delete listRow.threadUrl
  wire.detail = detail(true)
  wire.ownerDetail = null
  wire.chatActions = 'approve'
  wire.canEdit = true
  wire.requests = [request]
  wire.messages = []
  wire.conversationReads = []
  wire.agentReads = []
  wire.decisions = []
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

const header = () => container?.querySelector<HTMLElement>('[data-session-header]')

describe('the one-line session header', () => {
  it('holds the state, the name, the people, Details and the link in one row, with no Workspace entry', async () => {
    await render()
    const row = header()!
    expect(row).not.toBeNull()
    expect(row.querySelector('[data-state-icon]')).not.toBeNull()
    expect(row.querySelector('h1')?.textContent).toBe('Usage report')
    expect(row.querySelector('[data-header-people]')).not.toBeNull()
    expect(row.querySelector('[data-header-details]')?.getAttribute('aria-label')).toBe('Details')
    expect(row.querySelector('[data-header-share]')?.getAttribute('aria-label')).toBe('Share')
    expect(row.textContent).not.toContain('Workspace')
    expect(row.querySelector('[data-header-coordinator]')).toBeNull()
  })

  it('shows a place chip that opens its thread as a link, and one without a thread as plain text', async () => {
    listRow.threadUrl = 'https://example.test/thread/1'
    await render()
    const link = header()!.querySelector<HTMLElement>('[data-header-place]')!
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe('https://example.test/thread/1')
    expect(link.className).toContain('text-(--text-link)')
    delete listRow.threadUrl
    root?.unmount()
    root = createRoot(container!)
    await render()
    const plain = header()!.querySelector<HTMLElement>('[data-header-place]')!
    expect(plain.tagName).toBe('SPAN')
    expect(plain.className).not.toContain('text-(--text-link)')
    expect(plain.className).not.toContain('hover:')
  })

  it('counts what waits for an editor on an amber Requests pill, and shows a quiet icon once nothing does', async () => {
    wire.requests = [
      request,
      { ...request, id: 'request-2' },
      { ...request, id: 'request-3', status: 'allowed' } as never
    ]
    await render()
    const pill = header()!.querySelector('[data-header-requests]')!
    expect(pill.getAttribute('data-header-requests')).toBe('pending')
    expect(pill.textContent).toBe('2')
    expect(pill.getAttribute('aria-label')).toBe('2 requests waiting for you')
    wire.requests = [{ ...request, status: 'allowed' } as never]
    root?.unmount()
    root = createRoot(container!)
    await render()
    const quiet = header()!.querySelector('[data-header-requests]')!
    expect(quiet.getAttribute('data-header-requests')).toBe('history')
    expect(quiet.textContent).toBe('')
  })

  it.each(['desktop', 'compact'])(
    'shares from the %s header with the original audience cards and a primary copy action',
    async (layout) => {
      wire.detail = { ...detail(true), visibility: 'org', canChangeVisibility: true }
      const matchMedia = window.matchMedia
      vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
        ...matchMedia(query),
        matches: layout === 'compact'
      }))
      await render()
      expect(container!.querySelectorAll('[data-header-share]')).toHaveLength(1)
      await act(async () => header()!.querySelector<HTMLButtonElement>('[data-header-share]')!.click())
      const dialog = container!.ownerDocument.querySelector('[data-share-dialog]')!
      expect(header()!.contains(dialog)).toBe(false)
      expect(dialog.textContent).toContain('Share “Usage report”')
      expect(dialog.textContent).toContain('Who can see it')
      const choices = [...dialog.querySelectorAll('[role="radio"]')]
      expect(choices.map((choice) => choice.textContent?.slice(0, 7))).toEqual(['Everyon', 'Private'])
      expect(choices[0]!.getAttribute('aria-checked')).toBe('true')
      expect(dialog.textContent).toContain('Copy link')
      expect(dialog.textContent).not.toContain('Done')
      await act(async () => dialog.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click())
      expect(container!.ownerDocument.querySelector('[data-share-dialog]')).toBeNull()
    }
  )

  it('opens one header popover at a time, without native tips over them', async () => {
    await render()
    const requests = header()!.querySelector<HTMLButtonElement>('[data-header-requests]')!
    const details = header()!.querySelector<HTMLButtonElement>('[data-header-details]')!
    expect(requests.getAttribute('title')).toBeNull()
    expect(details.getAttribute('title')).toBeNull()
    // Opened by focus, as a click leaves it, then the pointer moves on to Details.
    await act(async () => requests.focus())
    expect(requests.getAttribute('aria-expanded')).toBe('true')
    await act(async () => {
      details.parentElement!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }))
    })
    expect(requests.getAttribute('aria-expanded')).toBe('false')
    const panel = document.getElementById(details.getAttribute('aria-controls')!)
    expect(panel?.getAttribute('role')).toBe('dialog')
    expect(panel?.className).not.toContain('invisible')
  })

  it.each(['details', 'requests'])('toggles %s by tap and closes it on an outside press', async (name) => {
    await render()
    const trigger = header()!.querySelector<HTMLButtonElement>(`[data-header-${name}]`)!
    await act(async () => trigger.click())
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    await act(async () => trigger.click())
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    await act(async () => trigger.click())
    await act(async () => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('opens who is in the session from the faces, with who can see it at the foot', async () => {
    await render()
    await act(async () => header()!.querySelector<HTMLButtonElement>('[data-header-people]')!.click())
    const dialog = container?.querySelector('[data-header-people-dialog]')
    expect(dialog?.getAttribute('aria-label')).toBe('Who is in this session')
    expect(dialog?.textContent).toContain('Ops bot')
    expect(dialog?.textContent).toContain('model-a')
  })

  it('leads a task’s own page back to the session that owns it from an icon beside its name', async () => {
    wire.detail = {
      ...detail(true),
      thread: 'subsession:1700000000000',
      parentSession: {
        id: 'owner-1',
        agentId: 'agent-1',
        agentName: 'Ops bot',
        platform: 'slack',
        title: 'Ship api 1.5',
        subsession: false
      }
    }
    // The page reads a task from its row's own thread, as the list carries it.
    Object.assign(listRow, { subsession: true })
    await render()
    Object.assign(listRow, { subsession: undefined })
    expect(header()?.querySelector('h1 + a')?.getAttribute('href')).toBe('/acme/sessions/owner-1')
  })

  it('lets the owner of a webchat coordinator answer its task’s request on the task’s page, read through the coordinator', async () => {
    wire.canEdit = false
    const owner = {
      id: 'owner-1',
      agentId: 'agent-1',
      agentName: 'Ops bot',
      platform: 'webchat',
      title: 'Ship api 1.5',
      subsession: false
    }
    wire.detail = { ...detail(false), task: true, platform: 'slack', parentSession: owner }
    wire.ownerDetail = { ...detail(true), id: 'owner-1', platform: 'webchat' }
    wire.messages = [
      { seq: 1, sender: 'sam', kind: 'text', text: 'check the release', ts: '2026-09-26T00:00:00.000Z' },
      { seq: 2, sender: 'agent-1', kind: 'text', text: 'running the tests', ts: '2026-09-26T00:00:01.000Z' }
    ]
    await render()
    for (let i = 0; i < 5; i++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    // The task's own coordinate is refused by the conversation route, so the read goes through its owner.
    expect(wire.conversationReads).toContain('owner-1')
    expect(wire.conversationReads).not.toContain('session-1')
    expect(container?.textContent).toContain('npm test')
  })

  it('returns from a task’s page to its owner with Back or Close and opens its dock on Files', async () => {
    // A threaded task runs in its own platform thread; the CP's `task` says some session owns it.
    wire.detail = {
      ...detail(true),
      task: true,
      parentSession: {
        id: 'owner-1',
        agentId: 'agent-1',
        agentName: 'Ops bot',
        platform: 'slack',
        title: 'Ship api 1.5',
        subsession: false
      }
    }
    await render()
    const row = header()!
    expect(row.querySelector('[data-task-page-back]')?.getAttribute('href')).toBe('/acme/sessions/owner-1')
    expect(row.querySelector('[data-task-page-shrink]')).toBeNull()
    expect(row.querySelector('[data-task-page-close]')?.getAttribute('href')).toBe('/acme/sessions/owner-1')
    const tabs = [...(container?.querySelectorAll('[data-dock-tab]') ?? [])].map((el) =>
      el.getAttribute('data-dock-tab')
    )
    expect(tabs).not.toContain('sessions')
    expect(tabs).toContain('files')
    expect(container?.querySelector('[data-dock-tab="files"]')?.getAttribute('aria-selected')).toBe('true')
  })

  it('gives an ordinary session no way back to a coordinator, and keeps its Sessions tab', async () => {
    await render()
    const row = header()!
    expect(row.querySelector('[data-task-page-back]')).toBeNull()
    expect(row.querySelector('[data-task-page-shrink]')).toBeNull()
    expect(row.querySelector('[data-task-page-close]')).toBeNull()
    expect(container?.querySelector('[data-dock-tab="sessions"]')).not.toBeNull()
  })
})
