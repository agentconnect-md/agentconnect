// @vitest-environment happy-dom

// What a webchat conversation's owner may do from its page at each level of "What people can do in chat", and what anyone else who views it sees instead.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, DaemonRow, Session } from '@/lib/data'
import type { AgentPermissionRequestDto, SessionDetailDto } from '@/lib/api'

const wire = vi.hoisted(() => ({
  detail: null as unknown,
  chatActions: 'approve' as 'talk' | 'approve' | 'settings',
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
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    fetchSessionMessages: vi.fn(() => Promise.resolve({ messages: wire.messages, nextCursor: null })),
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
    agents: [{ ...agent, chatActions: wire.chatActions }],
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
    visibility: 'org',
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
  wire.detail = detail(true)
  wire.chatActions = 'approve'
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

describe('a webchat conversation’s pending requests', () => {
  it('shows its owner who only views the agent their requests at approve, and answers through the conversation', async () => {
    await render()
    expect(container?.textContent).toContain('Pending requests')
    expect(container?.textContent).toContain('Bash: npm test')
    expect(wire.conversationReads).toContain('session-1')
    expect(wire.agentReads).toEqual([])

    await act(async () => button('Allow')?.click())
    expect(wire.decisions).toEqual([['session-1', 'request-1', 'allow', undefined]])
  })

  it('shows them at talk only the join confirmations that ask them, and nothing to anyone else who views it', async () => {
    // At talk the Control Plane lists the owner only the join confirmations that ask them.
    wire.chatActions = 'talk'
    wire.requests = [
      {
        ...request,
        id: 'join-1',
        command: 'Let Ops bot join #general to post there?',
        kind: 'join',
        options: [
          { optionId: 'join', name: 'Join', kind: 'allow_once' },
          { optionId: 'dont-join', name: 'Don’t join', kind: 'reject_once' }
        ]
      }
    ]
    await render()
    expect(container?.textContent).toContain('Pending requests')
    expect(container?.textContent).toContain('Join a channel')
    expect(container?.textContent).toContain('Let Ops bot join #general to post there?')
    await act(async () => button('Join')?.click())
    expect(wire.decisions).toEqual([['session-1', 'join-1', 'allow', 'join']])

    act(() => root?.unmount())
    root = createRoot(container!)
    wire.conversationReads = []
    wire.chatActions = 'settings'
    wire.detail = detail(false)
    await render()
    expect(container?.textContent).not.toContain('Pending requests')
    expect(wire.conversationReads).toEqual([])
    expect(wire.agentReads).toEqual([])
  })
})

describe('a webchat conversation’s tool-call approvals', () => {
  // The agent's turn started at 10:00:30; the owner's message came 30s before it.
  const turnRows = [
    { ts: '1790416800', seq: 1, sender: 'sam', kind: 'text', text: 'run the tests' },
    { ts: '1790416830', seq: 2, sender: 'agent-1', kind: 'text', text: 'Running them now.' }
  ]
  const askedAt = new Date(1_790_416_840_000).toISOString()
  const strip = () =>
    [...(container?.querySelectorAll('.card') ?? [])].find((card) => card.textContent?.includes('Pending requests'))

  it('asks inside the turn that was running, answered there, and leaves the strip to what is not a tool call', async () => {
    wire.messages = turnRows
    wire.requests = [
      { ...request, createdAt: askedAt, options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }] },
      {
        ...request,
        id: 'join-1',
        createdAt: askedAt,
        command: 'Let Ops bot join #general to post there?',
        kind: 'join'
      }
    ]
    await render()
    const card = container?.querySelector('[data-turn-approval="request-1"]')
    expect(card?.textContent).toContain('Approval needed:')
    expect(card?.textContent).toContain('Bash: npm test')
    expect(strip()?.textContent).toContain('Let Ops bot join #general to post there?')
    expect(strip()?.textContent).not.toContain('Bash: npm test')

    await act(async () => card?.querySelector('button')?.click())
    expect(wire.decisions).toEqual([['session-1', 'request-1', 'allow', 'once']])
  })

  it('collapses a settled one to a line that says what was asked, how it ended, who answered and where', async () => {
    wire.messages = turnRows
    wire.requests = [
      {
        ...request,
        createdAt: askedAt,
        status: 'allowed',
        resolvedAt: askedAt,
        resolvedBy: 'slack:T1:U1',
        resolvedByName: 'Dana Reyes'
      }
    ]
    await render()
    const line = container?.querySelector('[data-turn-approval="request-1"]')
    expect(line?.textContent).toContain('Asked: Bash: npm test · Allowed · Answered by Dana Reyes in Slack ·')
    expect(line?.querySelector('button')).toBeNull()
    expect(strip()).toBeUndefined()
  })
})

describe('a webchat conversation’s runtime controls', () => {
  it('lets its owner change the runtime at settings', async () => {
    wire.chatActions = 'settings'
    await render()
    await act(async () => picker()?.click())
    expect(document.querySelector('[aria-label="Codex · model-c"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('can change the runtime')
  })

  it('keeps a shared conversation read-only for a viewer who does not own it', async () => {
    wire.chatActions = 'settings'
    wire.detail = detail(false)
    await render()
    expect(picker()).toBeNull()
    expect(document.querySelector('[aria-label="Codex · model-c"]')).toBeNull()
  })
})
