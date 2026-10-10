// @vitest-environment happy-dom

// A live playground conversation offers removal on each member chip, never on the primary (webchat-multi-agents.md §3.1a).

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Session } from '@/lib/data'

const wire = vi.hoisted(() => ({ busy: false, removed: [] as Array<[string, string]> }))

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'pg_1' }),
  usePathname: () => '/acme/sessions/pg_1',
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
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    fetchSessionMessages: vi.fn(() => Promise.resolve({ messages: [], nextCursor: null })),
    fetchSessionDetail: vi.fn(() => Promise.reject(new Error('no detail'))),
    fetchMySessionIdentity: vi.fn(() => Promise.reject(new Error('no identity'))),
    fetchConversationByKey: vi.fn(() => Promise.reject(new Error('no conversation'))),
    fetchAgentTasks: vi.fn(() => Promise.resolve({ sessionId: 'pg_1', tracked: true, tasks: [], truncated: false })),
    fetchSessionPullRequest: vi.fn(() => Promise.reject(new actual.ApiError('pull request not found', 404))),
    fetchWorkspaceFiles: vi.fn((_agentId: string, opts: { path: string }) =>
      Promise.resolve({ path: opts.path, exists: true, entries: [], nextCursor: null })
    ),
    fetchWorkspaceGitStatus: vi.fn(() => Promise.resolve({ isRepo: false })),
    fetchWorkspaceGitLog: vi.fn(() => Promise.resolve({ isRepo: false, commits: [], truncated: false, tracking: null }))
  }
})

const agent = (id: string, name: string) =>
  ({
    id,
    name,
    runtime: 'claude',
    model: 'model-a',
    status: 'online',
    statusLabel: 'online',
    icon: 'bot',
    daemon: 'daemon-1',
    workspace: { mode: 'scratch' },
    canEdit: false
  }) as unknown as Agent

const agents = [agent('agent-a', 'Primary'), agent('agent-b', 'Helper')]

const pgSession = {
  id: 'pg_1',
  title: 'Playground · Primary, Helper',
  status: 'online',
  statusLabel: 'Live',
  platform: 'playground',
  channel: 'Playground',
  user: 'sam',
  agentId: 'agent-a',
  agentName: 'Primary',
  daemon: 'daemon-1',
  participants: [
    { agentId: 'agent-a', name: 'Primary', primary: true },
    { agentId: 'agent-b', name: 'Helper' }
  ],
  steps: []
} as unknown as Session

vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents,
    allSessions: [],
    getSessions: () => [],
    sessionsLoading: false,
    crons: [],
    daemons: [],
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
    myRole: 'collaborator',
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
    getPgSession: () => pgSession,
    getLiveSteps: () => [],
    getBusyLaneAgentIds: () => [],
    reconcileLiveSteps: () => {},
    getPgImage: () => null,
    getPgFiles: () => [],
    setPgFiles: () => {},
    getPgWorktree: () => false,
    isPgBusy: () => wire.busy,
    setPgImage: () => {},
    openPlayground: () => 'pg_new',
    pgSend: () => {},
    pgAttach: () => {},
    getPgQueue: () => [],
    pgCancelQueued: () => {},
    pgAddAgent: () => {},
    pgRemoveAgent: (id: string, agentId: string) => {
      wire.removed.push([id, agentId])
      return Promise.resolve(true)
    },
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

async function render() {
  await act(async () => {
    root?.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <SessionDetailView />
      </SWRConfig>
    )
    await Promise.resolve()
  })
}

const removeButton = (name: string) =>
  container?.querySelector<HTMLButtonElement>(`button[aria-label="Remove ${name} from this conversation"]`)

beforeEach(() => {
  wire.busy = false
  wire.removed = []
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

describe('removing a member from a live playground conversation', () => {
  it('offers removal on the member chip only, and removes that member', async () => {
    await render()
    expect(removeButton('Primary')).toBeNull()
    const helper = removeButton('Helper')
    expect(helper?.disabled).toBe(false)

    await act(async () => helper?.click())
    expect(wire.removed).toEqual([['pg_1', 'agent-b']])
  })

  it('holds removal while a reply streams', async () => {
    wire.busy = true
    await render()
    expect(removeButton('Helper')?.disabled).toBe(true)
  })
})
