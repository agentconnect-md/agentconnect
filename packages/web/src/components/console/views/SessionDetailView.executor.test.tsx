// @vitest-environment happy-dom

// Where a session's turns actually run (session-executors.md §7), in the session's own Details.
// An isolated session of a grouped agent can be born on a member other than its holder, and one
// that stayed with its holder records why — without that, "why is everything still running on one
// machine" has no answer an operator can find.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, DaemonRow, Session } from '@/lib/data'
import type { SessionDetailDto } from '@/lib/api'

const wire = vi.hoisted(() => ({ detail: null as unknown }))

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
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    fetchSessionMessages: vi.fn(() => Promise.resolve({ messages: [], nextCursor: null })),
    fetchSessionDetail: vi.fn(() => Promise.resolve(wire.detail)),
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
    fetchWorkspaceGitLog: vi.fn(() => Promise.resolve({ isRepo: false, commits: [], truncated: false, tracking: null }))
  }
})

const agent = {
  id: 'agent-1',
  name: 'Ops bot',
  runtime: 'claude',
  model: 'sonnet',
  status: 'online',
  statusLabel: 'online',
  icon: 'bot',
  daemon: 'daemon-1',
  workdir: './services/api',
  workspace: { mode: 'scratch' },
  canEdit: false
} as unknown as Agent

const session = {
  id: 'session-1',
  title: 'Upgrade the node',
  status: 'idle',
  statusLabel: 'completed',
  platform: 'slack',
  channel: '#ops',
  user: 'sam',
  agentId: 'agent-1',
  agentName: 'Ops bot',
  daemon: 'daemon-1',
  steps: []
} as unknown as Session

/** The two machines in the agent's group, as the console holds them. */
const daemons = [
  { daemonId: 'daemon-1', name: 'edge-1', runtimeModels: [], mcpServers: [], caps: { features: [] } },
  { daemonId: 'daemon-2', name: 'edge-2', runtimeModels: [], mcpServers: [], caps: { features: [] } }
] as unknown as DaemonRow[]

vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents: [agent],
    allSessions: [session],
    getSessions: () => [session],
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

// One frozen object, not a fresh one per render: the transcript effect keys on
// `reconcileLiveSteps` by identity, so a new closure each render spins forever.
vi.mock('@/components/console/PlaygroundProvider', () => {
  const playground = {
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
  }
  return { usePlayground: () => playground, usePgDraft: () => '', usePgDraftHasText: () => false }
})

import SessionDetailView from './SessionDetailView'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let container: HTMLDivElement | undefined
let root: ReturnType<typeof createRoot> | undefined

/** A session detail as the Control Plane serves it, carrying only the birth verdict under test. */
const detail = (verdict: Partial<SessionDetailDto>): SessionDetailDto =>
  ({
    id: 'session-1',
    parentSession: null,
    childSessions: [],
    agentId: 'agent-1',
    platform: 'slack',
    channel: '#ops',
    thread: null,
    title: 'Upgrade the node',
    status: 'idle',
    lastActivityAt: '2026-09-20T00:00:00.000Z',
    usage: null,
    triggeredBy: 'sam',
    channelName: '#ops',
    triggeredByName: 'Sam',
    threadUrl: null,
    runtime: 'claude',
    model: 'sonnet',
    effort: null,
    fastMode: null,
    permissionMode: null,
    outputMode: null,
    daemonId: 'daemon-1',
    workspaceIsolation: 'session',
    executorDaemonId: null,
    stayedHomeReason: null,
    ...verdict
  }) as SessionDetailDto

// A cache per test: every case reads the same session id, so a shared provider would serve the
// previous case's verdict and every assertion after the first would be about stale data.
async function render() {
  await act(async () => {
    root?.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <SessionDetailView />
      </SWRConfig>
    )
    await Promise.resolve()
  })
  await act(async () => {
    await Promise.resolve()
  })
}

const text = () => container?.textContent ?? ''

beforeEach(() => {
  wire.detail = detail({})
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

describe('where a session runs, in its Details', () => {
  it('names the group member executing it, not the daemon that holds it', async () => {
    wire.detail = detail({ executorDaemonId: 'daemon-2' })
    await render()

    expect(text()).toContain('Runs on')
    // The holder is still named on its own row; this one is the machine the turns land on.
    expect(text()).toContain('edge-2')
  })

  it('names the holder and why it stayed, wording the ordinary case as a result rather than a fault', async () => {
    wire.detail = detail({ stayedHomeReason: 'holder_least_loaded' })
    await render()

    expect(text()).toContain('edge-1 · least loaded')
  })

  it('says which consent is missing when the group has spreading off', async () => {
    wire.detail = detail({ stayedHomeReason: 'group_switch_off' })
    await render()

    expect(text()).toContain('edge-1 · spreading off')
  })

  it('stays silent for a session whose Control Plane recorded no verdict at all', async () => {
    await render()

    expect(text()).not.toContain('Runs on')
  })
})
