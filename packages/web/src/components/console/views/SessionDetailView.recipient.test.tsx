// @vitest-environment happy-dom

// A continued multi-agent conversation reaches one member session per send, and the composer's roster
// chips pick which. Before this the merged page always continued its representative's session, so a
// reader could never address anyone else in the room.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@/lib/data'
import type { ConversationDto, SessionDetailDto, SessionDto } from '@/lib/api'

const fixtures = vi.hoisted(() => {
  const CONVERSATION_KEY = 'hook-conversation'
  const wire = { continuable: new Map<string, boolean>() }
  const member = (sessionId: string, agentId: string): SessionDto =>
    ({
      sessionId,
      sessionKey: { platform: 'hook', channel: 'github:1', thread: '7' },
      agentId,
      title: 'Pull request 7',
      status: 'idle',
      lastActivityAt: '2026-09-20T00:00:00.000Z',
      usage: null,
      triggeredBy: null,
      channelName: null,
      triggeredByName: null,
      threadUrl: null,
      runtime: 'claude',
      model: 'sonnet',
      daemonId: 'daemon-1'
    }) as unknown as SessionDto

  const detail = (id: string, agentId: string): SessionDetailDto =>
    ({
      id,
      parentSession: null,
      childSessions: [],
      agentId,
      platform: 'hook',
      channel: 'github:1',
      thread: '7',
      title: 'Pull request 7',
      status: 'idle',
      lastActivityAt: '2026-09-20T00:00:00.000Z',
      usage: null,
      triggeredBy: null,
      channelName: null,
      triggeredByName: null,
      threadUrl: null,
      runtime: 'claude',
      model: 'sonnet',
      effort: null,
      fastMode: null,
      permissionMode: null,
      outputMode: null,
      daemonId: 'daemon-1',
      canContinue: wire.continuable.get(id) ?? true,
      continuationUnavailableReason: (wire.continuable.get(id) ?? true) ? null : 'unavailable'
    }) as unknown as SessionDetailDto

  const AGENT_BY_SESSION: Record<string, string> = { 's-architect': 'agent-architect', 's-review': 'agent-review' }

  return { CONVERSATION_KEY, wire, member, detail, AGENT_BY_SESSION }
})
const { CONVERSATION_KEY, wire } = fixtures
const playgroundSpies = vi.hoisted(() => ({ pgSend: vi.fn(() => true), markSessionTarget: vi.fn() }))

vi.mock('next/navigation', () => ({
  useParams: () => ({ key: fixtures.CONVERSATION_KEY }),
  usePathname: () => `/acme/conversations/${fixtures.CONVERSATION_KEY}`,
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
  const { member, detail, AGENT_BY_SESSION } = fixtures
  const conversation: ConversationDto = {
    key: fixtures.CONVERSATION_KEY,
    platform: 'hook',
    channel: 'github:1',
    thread: '7',
    // Representative first, as the resolver serves it.
    sessions: [member('s-architect', 'agent-architect'), member('s-review', 'agent-review')]
  }
  return {
    ...actual,
    fetchConversationByKey: vi.fn(() => Promise.resolve({ conversation, accessSyncDegraded: false, accessIssues: [] })),
    fetchSessionMessages: vi.fn(() => Promise.resolve({ messages: [], nextCursor: null })),
    fetchSessionDetail: vi.fn((id: string) => Promise.resolve(detail(id, AGENT_BY_SESSION[id] ?? ''))),
    fetchMySessionIdentity: vi.fn(() => Promise.reject(new Error('no identity'))),
    fetchAgentTasks: vi.fn(() =>
      Promise.resolve({ sessionId: 's-architect', tracked: true, tasks: [], truncated: false })
    ),
    fetchSessionPullRequest: vi.fn(() => Promise.reject(new actual.ApiError('pull request not found', 404))),
    fetchWorkspaceFiles: vi.fn((_agentId: string, opts: { path: string }) =>
      Promise.resolve({ path: opts.path, exists: true, entries: [], nextCursor: null })
    ),
    fetchWorkspaceGitStatus: vi.fn(() => Promise.resolve({ isRepo: false })),
    fetchWorkspaceGitLog: vi.fn(() => Promise.resolve({ isRepo: false, commits: [], truncated: false, tracking: null }))
  }
})

const agentRow = (id: string, name: string) =>
  ({
    id,
    name,
    runtime: 'claude',
    model: 'sonnet',
    status: 'online',
    statusLabel: 'online',
    icon: 'bot',
    daemon: 'daemon-1',
    workdir: './',
    workspace: { mode: 'scratch' },
    canEdit: false
  }) as unknown as Agent
const agents = [agentRow('agent-architect', 'architect'), agentRow('agent-review', 'review-bot')]

vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents,
    allSessions: [],
    getSessions: () => [],
    sessionsLoading: false,
    crons: [],
    daemons: [{ daemonId: 'daemon-1', name: 'edge-1', runtimeModels: [], mcpServers: [], caps: { features: [] } }],
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
vi.mock('@/lib/stick-to-bottom', () => ({ useStickToBottom: () => ({ pin: () => {}, awayFromBottom: false }) }))
vi.mock('@/lib/auth', () => ({ isAuthConfigured: () => false }))
vi.mock('@/lib/use-session-list', () => ({
  useSessionList: () => ({ sessions: [], total: 0, isLoading: false, nextCursor: null, loadingMore: false })
}))

vi.mock('@/components/console/Shell', () => ({
  useCrumbSlot: () => ({ register: () => {} }),
  useMobileActionSlot: () => ({ action: null, register: () => {} })
}))

// One frozen object: the transcript effect keys on `reconcileLiveSteps` by identity.
vi.mock('@/components/console/PlaygroundProvider', () => {
  const playground = {
    getPgSession: () => undefined,
    getLiveSteps: () => [],
    getBusyLaneAgentIds: () => [],
    reconcileLiveSteps: () => {},
    getPgImage: () => undefined,
    getPgWorktree: () => false,
    isPgBusy: () => false,
    setPgImage: () => {},
    openPlayground: () => 'pg_new',
    pgSend: playgroundSpies.pgSend,
    markSessionTarget: playgroundSpies.markSessionTarget,
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
    setPgInput: () => {},
    getPgInput: () => 'please re-review',
    subscribePgDraft: () => () => {}
  }
  return { usePlayground: () => playground, usePgDraft: () => 'please re-review', usePgDraftHasText: () => true }
})

import SessionDetailView from './SessionDetailView'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let container: HTMLDivElement | undefined
let root: ReturnType<typeof createRoot> | undefined

async function settle() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

async function render() {
  await act(async () => {
    root?.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <SessionDetailView />
      </SWRConfig>
    )
  })
  await settle()
}

const recipient = (name: string) =>
  [...(container?.querySelectorAll<HTMLButtonElement>('button[aria-pressed]') ?? [])].find(
    (button) => button.textContent === name
  )
const placeholder = () => container?.querySelector<HTMLTextAreaElement>('textarea:not([disabled])')?.placeholder
const sendButton = () =>
  [...(container?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((button) =>
    /send/i.test(button.getAttribute('aria-label') ?? '')
  )

beforeEach(() => {
  wire.continuable = new Map()
  playgroundSpies.pgSend.mockClear()
  playgroundSpies.markSessionTarget.mockClear()
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

describe('the recipient of a continued multi-agent conversation', () => {
  it('starts on the representative and names it instead of promising everyone', async () => {
    await render()

    expect(recipient('architect')?.getAttribute('aria-pressed')).toBe('true')
    expect(recipient('review-bot')?.getAttribute('aria-pressed')).toBe('false')
    expect(placeholder()).toBe('Message architect…')
  })

  it('sends into the picked member’s own session', async () => {
    await render()
    await act(async () => recipient('review-bot')?.click())
    await settle()

    expect(recipient('review-bot')?.getAttribute('aria-pressed')).toBe('true')
    expect(placeholder()).toBe('Message review-bot…')

    await act(async () => sendButton()?.click())

    // The live lane stays on the page's session; only the socket's target and the addressed agent move.
    expect(playgroundSpies.markSessionTarget).toHaveBeenCalledWith('s-architect', 's-review')
    expect(playgroundSpies.pgSend).toHaveBeenCalledWith(
      's-architect',
      'agent-review',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    )
  })

  it('offers no member whose own session cannot continue here', async () => {
    wire.continuable.set('s-review', false)
    await render()

    expect(recipient('review-bot')?.disabled).toBe(true)
    await act(async () => sendButton()?.click())
    expect(playgroundSpies.markSessionTarget).toHaveBeenCalledWith('s-architect', 's-architect')
    expect(playgroundSpies.pgSend).toHaveBeenCalledWith(
      's-architect',
      'agent-architect',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    )
  })
})
