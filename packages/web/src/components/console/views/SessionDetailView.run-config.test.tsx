// @vitest-environment happy-dom

// An open session page follows the run config the Control Plane records, since only its detail read refetches on a session event.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { SWRConfig, useSWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, DaemonRow, Session } from '@/lib/data'
import type { SessionDetailDto } from '@/lib/api'

const wire = vi.hoisted(() => ({ detail: null as unknown, setModelCalls: [] as string[], pg: undefined as unknown }))

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

// The agent has since moved to another runtime; the session only follows once a turn records it.
const agent = {
  id: 'agent-1',
  name: 'Ops bot',
  runtime: 'claude',
  model: 'model-b',
  allowRuntimeChangesInChat: true,
  status: 'online',
  statusLabel: 'online',
  icon: 'bot',
  daemon: 'daemon-1',
  workdir: './services/api',
  workspace: { mode: 'scratch' },
  canEdit: false
} as unknown as Agent

// The list row as it was loaded, before the session's next turn changed its runtime.
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
    runtimeModels: [
      { runtime: 'codex', version: '1', models: ['model-a', 'model-c'] },
      { runtime: 'claude', version: '1', models: ['model-b'] }
    ],
    mcpServers: [],
    caps: { features: [] }
  }
] as unknown as DaemonRow[]

vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents: [agent],
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

// Frozen, like the other suites: the transcript effect keys on `reconcileLiveSteps` by identity.
vi.mock('@/components/console/PlaygroundProvider', () => {
  const playground = {
    getPgSession: () => wire.pg,
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
    pgSetModel: (_id: string, _agentId: string, model: string) => {
      wire.setModelCalls.push(model)
    },
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
let revalidate: (() => Promise<unknown>) | undefined

/** A session detail as the Control Plane serves it, carrying the run config under test. */
const detail = (config: Partial<SessionDetailDto>): SessionDetailDto =>
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
    ...config
  }) as SessionDetailDto

/** The console's session-event refresh: every cached session read of the org revalidates. */
function SessionEventRefresh() {
  const { mutate } = useSWRConfig()
  revalidate = () => mutate((key) => Array.isArray(key) && key[0] === 'console' && key[2] === 'session-detail')
  return null
}

async function render() {
  await act(async () => {
    root?.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <SessionEventRefresh />
        <SessionDetailView />
      </SWRConfig>
    )
    await Promise.resolve()
  })
  await act(async () => {
    await Promise.resolve()
  })
}

/** The Control Plane records a new run config and publishes a session event. */
async function recordRunConfig(config: Partial<SessionDetailDto>) {
  wire.detail = detail(config)
  await act(async () => {
    await revalidate?.()
  })
}

const picker = () => container?.querySelector<HTMLButtonElement>('button[aria-label="Model"]')
const details = () => container?.querySelector('[role="tooltip"]')?.textContent ?? ''

beforeEach(() => {
  wire.detail = detail({})
  wire.setModelCalls = []
  wire.pg = undefined
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
  revalidate = undefined
})

describe('an open session page after its run config changes', () => {
  it('shows the runtime and model the Control Plane now records, in the composer and in Details', async () => {
    await render()
    expect(picker()?.textContent).toContain('model-a')
    expect(details()).toContain('RuntimeCodex')

    await recordRunConfig({ runtime: 'claude', model: 'model-b', effort: null })

    expect(picker()?.textContent).toContain('model-b')
    expect(picker()?.textContent).not.toContain('model-a')
    expect(details()).toContain('RuntimeClaude Code')
    expect(details()).toContain('Modelmodel-b')
    expect(details()).not.toContain('Codex')
  })

  it('never pairs the new runtime with the old runtime’s model when its own model is the default', async () => {
    await render()

    await recordRunConfig({ runtime: 'claude', model: null, effort: null })

    expect(picker()?.textContent).not.toContain('model-a')
    expect(details()).toContain('RuntimeClaude Code')
    expect(details()).not.toContain('model-a')
  })

  it('keeps a model the user picked on the page when a later snapshot arrives', async () => {
    await render()
    await act(async () => picker()?.click())
    const option = document.querySelector<HTMLButtonElement>('[aria-label="Codex · model-c"]')
    expect(option).not.toBeNull()
    await act(async () => option?.click())
    expect(wire.setModelCalls).toEqual(['model-c'])

    await recordRunConfig({ runtime: 'codex', model: 'model-a', effort: 'low' })

    expect(picker()?.textContent).toContain('model-c')
  })

  it('leaves a live playground session on the run config its status frames report', async () => {
    wire.pg = { ...listRow, platform: 'playground', realSessionId: 'session-1', model: 'model-c' }
    await render()

    await recordRunConfig({ runtime: 'claude', model: 'model-b', effort: null })

    expect(picker()?.textContent).toContain('model-c')
  })
})
