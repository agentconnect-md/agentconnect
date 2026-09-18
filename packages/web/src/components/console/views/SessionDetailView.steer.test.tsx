// @vitest-environment happy-dom

// A message steered into the running reply (#1847) on the real session page. The reply that keeps
// streaming after it belongs to the block above until the daemon confirms the steer landed; only a
// confirmed steer splits the reply into a fresh block below the message.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Session } from '@/lib/data'

const live = vi.hoisted(() => ({ steps: [] as unknown[] }))

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
    fetchSessionDetail: vi.fn(() => Promise.reject(new Error('no detail'))),
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
  title: 'Usage report',
  status: 'running',
  statusLabel: 'running',
  platform: 'webchat',
  channel: 'Playground',
  channelId: 'conv-1',
  user: 'sam',
  agentId: 'agent-1',
  agentName: 'Ops bot',
  // Empty puts the page on the real transcript, so the live steps below layer under fetched history.
  steps: []
} as unknown as Session

vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents: [agent],
    allSessions: [session],
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

// Frozen, like the elicitation suite: the transcript effect keys on `reconcileLiveSteps` by identity.
vi.mock('@/components/console/PlaygroundProvider', () => {
  const playground = {
    getPgSession: () => undefined,
    getLiveSteps: () => live.steps,
    getBusyLaneAgentIds: () => [],
    reconcileLiveSteps: () => {},
    getPgImage: () => null,
    getPgWorktree: () => false,
    isPgBusy: () => true,
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

const PROMPT = { kind: 'msg', who: '@you', turnId: 'turn-1', text: 'usage report please', time: '11:37:42 AM' }
const FIRST_HALF = { kind: 'done', turnId: 'turn-1', text: 'review-bot 137 sessions' }
const STEER = { kind: 'msg', who: '@you', turnId: 'steer-1', text: 'retry', steer: true, time: '11:38:00 AM' }
const SECOND_HALF = { kind: 'done', turnId: 'turn-1', text: 'review-bot-private 6 sessions' }

async function render() {
  await act(async () => {
    root?.render(<SessionDetailView />)
    await Promise.resolve()
  })
  await act(async () => {
    await Promise.resolve()
  })
}

// The steer mark on the bubble: a glyph plus one word, with the full meaning in its tooltip.
const steerMark = () => container?.querySelector('span[title^="Steer"]')
// One transcript turn per `gap-[5px]` column: a user bubble or an agent block, in reading order.
const turnColumns = () =>
  [...(container?.querySelectorAll('div') ?? [])].filter((d) => d.className === 'flex flex-col gap-[5px]')

beforeEach(() => {
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

describe('a message steered into the running reply', () => {
  it('keeps the continuing reply in the block above while the daemon has not confirmed the steer', async () => {
    live.steps = [PROMPT, FIRST_HALF, STEER, SECOND_HALF]
    await render()

    // Three turns: the prompt, ONE agent block holding both halves, the steer bubble below it.
    const columns = turnColumns()
    expect(columns).toHaveLength(3)
    expect(columns[1]?.textContent).toContain('review-bot 137 sessions')
    expect(columns[1]?.textContent).toContain('review-bot-private 6 sessions')
    expect(columns[2]?.textContent).toContain('retry')
    expect(steerMark()?.textContent).toBe('Steering…')
    expect(steerMark()?.getAttribute('title')).toBe('Steering into the running reply…')
  })

  it('splits the reply into a fresh block below the message once the steer is confirmed', async () => {
    live.steps = [PROMPT, FIRST_HALF, { ...STEER, steered: true }, SECOND_HALF]
    await render()

    // Four turns: the second half now stands as its own agent block under the steer bubble.
    const columns = turnColumns()
    expect(columns).toHaveLength(4)
    expect(columns[1]?.textContent).toContain('review-bot 137 sessions')
    expect(columns[1]?.textContent).not.toContain('review-bot-private 6 sessions')
    expect(columns[2]?.textContent).toContain('retry')
    expect(columns[3]?.textContent).toContain('review-bot-private 6 sessions')
    expect(steerMark()?.textContent).toBe('Steered')
    expect(steerMark()?.getAttribute('title')).toBe('Steered into the running reply')
  })
})
