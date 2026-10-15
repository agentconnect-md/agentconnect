// @vitest-environment happy-dom

// A delivered session message on the real session page: its body reads as the message, while
// its header and the guidance the agent received fold under "more" (send-message-guide.md §9.5).

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Session } from '@/lib/data'
import type { SessionMessageDto } from '@/lib/api'

const wire = vi.hoisted(() => ({ messages: [] as unknown[] }))

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
  title: 'Upgrade the node',
  status: 'idle',
  statusLabel: 'completed',
  platform: 'slack',
  channel: '#ops',
  user: 'sam',
  agentId: 'agent-1',
  agentName: 'Ops bot',
  // Empty, which is what puts the page on the REAL transcript (`wantTranscript`) instead of
  // the mock step list a list-only session carries.
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

// One frozen object, not a fresh one per render: the transcript effect keys on
// `reconcileLiveSteps` by identity, so a new closure each render refetches, re-renders, and
// spins forever. (The viewer suite never sees this — its session carries mock steps, which
// turns the real transcript off.)
vi.mock('@/components/console/PlaygroundProvider', () => {
  const playground = {
    getPgSession: () => undefined,
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
    setPgInput: () => {}
  }
  return { usePlayground: () => playground, usePgDraft: () => '', usePgDraftHasText: () => false }
})

import SessionDetailView from './SessionDetailView'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let container: HTMLDivElement | undefined
let root: ReturnType<typeof createRoot> | undefined

const row = (m: Partial<SessionMessageDto> & { seq: number; sender: string; kind: string; text: string }) => ({
  ts: String(1_700_000_000 + m.seq),
  ...m
})

const REPORT = JSON.stringify({
  prompt: '[Message msg-r] Report from your task (session sid-task):\n[task finished] …\n\n40 files, 15,393 lines.',
  sessionMessage: {
    messageId: 'msg-r',
    kind: 'report',
    source: { agentId: 'agent-1', label: 'Ops bot', sessionId: 'sid-task' },
    notes: ['To give it more work in the same context, call sendMessage with messageTask.']
  }
})
const REPLY = JSON.stringify({
  prompt: '[Message msg-p] Reply from reviewer (agent agent-2, session sid-peer) to your message msg-0:\nLGTM',
  sessionMessage: {
    messageId: 'msg-p',
    kind: 'reply',
    source: { agentId: 'agent-2', label: 'reviewer', sessionId: 'sid-peer' },
    inReplyTo: 'msg-0'
  }
})

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

beforeEach(() => {
  wire.messages = [
    row({ seq: 1, sender: 'sam', kind: 'text', text: 'count the lines in the workspace' }),
    row({ seq: 2, sender: 'agent-1', kind: 'text', text: '40 files, 15,393 lines.', body: REPORT }),
    row({ seq: 3, sender: 'agent-2', kind: 'text', text: 'LGTM', body: REPLY })
  ]
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

describe('a delivered session message on the session page', () => {
  it('shows the body under a caption naming its sender, and never the framed prompt', async () => {
    await render()
    expect(text()).toContain('Report from a background task')
    expect(text()).toContain('40 files, 15,393 lines.')
    expect(text()).toContain('Reply from reviewer')
    expect(text()).toContain('LGTM')
    expect(text()).not.toContain('[Message')
    expect(text()).not.toContain('messageTask')
  })

  it('captions a message from an agent this page does not list on its sender’s bubble as well', async () => {
    await render()
    const bubbles = [...(container?.querySelectorAll('[data-turn-details]') ?? [])].map(
      (fold) => fold.parentElement?.textContent ?? ''
    )
    expect(bubbles.some((bubble) => bubble.includes('Reply from reviewer') && bubble.includes('LGTM'))).toBe(true)
  })

  it('folds the header facts and the agent’s guidance under "more"', async () => {
    await render()
    const more = [...(container?.querySelectorAll('[data-turn-details] button') ?? [])]
    expect(more).toHaveLength(2)
    await act(async () => {
      more[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(text()).toContain('sid-task')
    expect(text()).toContain('To give it more work in the same context, call sendMessage with messageTask.')
    expect(text()).not.toContain('[Message')
  })
})
