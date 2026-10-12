// @vitest-environment happy-dom

// An assistant-mode agent's proposals in a webchat conversation's page: the live Playground's composer strip and an editor's Requests popover, whatever the console flag.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Session } from '@/lib/data'
import type { AssistantConversationProposalDto, SessionDetailDto } from '@/lib/api'

const wire = vi.hoisted(() => ({
  pg: undefined as unknown,
  canEdit: false,
  assistantMode: true,
  proposals: [] as unknown[],
  proposalReads: [] as Array<[string, string]>
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
    fetchSessionMessages: vi.fn(() => Promise.resolve({ messages: [], nextCursor: null })),
    fetchSessionDetail: vi.fn(() => Promise.resolve(detail)),
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
    fetchAssistantSubsessions: vi.fn(() => Promise.resolve({ subsessions: [], truncated: false, nextCursor: null })),
    fetchAgentPermissionRequests: vi.fn(() => Promise.resolve([])),
    fetchSessionPermissionRequests: vi.fn(() => Promise.resolve([])),
    fetchAssistantConversationProposals: vi.fn((agentId: string, sessionId: string) => {
      wire.proposalReads.push([agentId, sessionId])
      return Promise.resolve({ proposals: wire.proposals, truncated: false })
    })
  }
})

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
  chatActions: 'talk'
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

vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents: [
      {
        ...agent,
        canEdit: wire.canEdit,
        ...(wire.assistantMode ? { assistantMode: { enabled: true, responsibleUserId: 'usr-1' } } : {})
      }
    ],
    allSessions: [listRow],
    getSessions: () => [listRow],
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
    getPgSession: () => wire.pg,
    getLiveSteps: () => [],
    getBusyLaneAgentIds: () => [],
    reconcileLiveSteps: () => {},
    getPgImage: () => null,
    getPgFiles: () => [],
    setPgFiles: () => {},
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
    pgAnswerElicitation: () => {},
    setPgInput: () => {}
  }
  return { usePlayground: () => playground, usePgDraft: () => '', usePgDraftHasText: () => false }
})

import SessionDetailView from './SessionDetailView'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let container: HTMLDivElement | undefined
let root: ReturnType<typeof createRoot> | undefined

const detail = {
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
  ownsConversation: true
} as unknown as SessionDetailDto

const proposal: AssistantConversationProposalDto = {
  id: 'proposal-1',
  sentence: 'I want to rebase PR #12 onto main because it conflicts.',
  why: 'it conflicts',
  task: 'rebase PR #12 onto main and push',
  itemId: 'item-1',
  itemTitle: 'Release PR #12',
  createdAt: '2026-09-26T00:00:00.000Z',
  expiresAt: '2026-09-27T00:00:00.000Z'
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

/** The header's Requests popover, as the desktop page keeps it mounted. */
const popover = () => container?.querySelector('[role="dialog"][aria-label="Approval requests"]')
/** The proposal rows outside that popover: the pending-requests strip. */
const stripRows = () =>
  [...(container?.querySelectorAll('[data-conversation-proposal="proposal-1"]') ?? [])].filter(
    (row) => !popover()?.contains(row)
  )

beforeEach(() => {
  wire.pg = undefined
  wire.canEdit = false
  wire.assistantMode = true
  wire.proposals = [proposal]
  wire.proposalReads = []
  delete window.__AC_ENV
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

describe('an assistant-mode agent’s proposals on a webchat conversation’s page', () => {
  it('wait in the live Playground conversation’s pending requests', async () => {
    wire.pg = { ...listRow, platform: 'playground', realSessionId: 'session-1' }
    await render()
    expect(wire.proposalReads).toContainEqual(['agent-1', 'session-1'])
    expect(stripRows()).toHaveLength(1)
    expect(stripRows()[0]?.textContent).toContain(proposal.sentence)
  })

  it('are listed in an editor’s Requests popover too', async () => {
    wire.canEdit = true
    await render()
    expect(popover()?.querySelector('[data-conversation-proposal="proposal-1"]')?.textContent).toContain(
      proposal.sentence
    )
    expect(stripRows()).toHaveLength(1)
  })

  it('are read for an agent already in assistant mode with the console flag off, and never for one outside it', async () => {
    expect(window.__AC_ENV).toBeUndefined()
    await render()
    expect(stripRows()).toHaveLength(1)

    act(() => root?.unmount())
    root = createRoot(container!)
    wire.assistantMode = false
    wire.canEdit = true
    wire.proposalReads = []
    await render()
    expect(wire.proposalReads).toEqual([])
    expect(container?.querySelector('[data-conversation-proposal]')).toBeNull()
  })
})
