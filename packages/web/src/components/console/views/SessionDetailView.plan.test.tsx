// @vitest-environment happy-dom

// The turn's PLAN on the real session page. The point of the block is where it is, not that
// it exists: the plan is what the agent set out to do, so it must be readable without opening
// the "Thought through…" panel — and it must not be counted as one of those steps either.

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

const PLAN = JSON.stringify({
  entries: [
    { content: 'Roll base-testnet-reth-a', status: 'completed' },
    { content: 'Roll base-testnet-reth-b', status: 'in_progress' }
  ]
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
    row({ seq: 1, sender: 'sam', kind: 'text', text: 'upgrade base testnet' }),
    row({ seq: 2, sender: 'agent-1', kind: 'reasoning', text: 'weighing the rollout order' }),
    row({ seq: 3, sender: 'agent-1', kind: 'plan', text: 'Plan · 1/2', body: PLAN }),
    row({ seq: 4, sender: 'agent-1', kind: 'text', text: 'both replicas are on v1.2.0' })
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

describe('the turn plan on the session page', () => {
  it('shows the checklist without opening the work panel, and does not count it as a step', async () => {
    await render()

    // Every entry is on screen while the work panel is still collapsed…
    expect(text()).toContain('Roll base-testnet-reth-a')
    expect(text()).toContain('Roll base-testnet-reth-b')
    expect(text()).toContain('Plan · 1/2')
    // …and the reasoning row that IS collapsed work is not, which is what proves the two
    // are rendered by different paths rather than the panel happening to be open.
    expect(text()).not.toContain('weighing the rollout order')
    // One reasoning step, not two: the plan is not folded into the count.
    expect(text()).toContain('Thought through 1 step')
  })

  it('falls back to the summary when the row arrives without a body', async () => {
    wire.messages = [
      row({ seq: 1, sender: 'sam', kind: 'text', text: 'go' }),
      row({ seq: 2, sender: 'agent-1', kind: 'plan', text: 'Plan · 3/6' }),
      row({ seq: 3, sender: 'agent-1', kind: 'text', text: 'done' })
    ]
    await render()

    expect(text()).toContain('Plan · 3/6')
    expect(text()).toContain('done')
  })
})

describe('a delivery turn on the session page', () => {
  it('shows the short text with a "more" that unfolds the facts, never the prompt', async () => {
    wire.messages = [
      row({
        seq: 1,
        sender: 'linear:user-1',
        kind: 'text',
        text: 'Delegated ENG-3 · investigate',
        body: JSON.stringify({
          prompt: 'Linear ENG-3 "investigate" — delegated by Dana\nTHE WHOLE PROMPT',
          codehost: {
            provider: 'github',
            event: 'issues:opened',
            subject: { repo: 'acme/infra', number: 7, title: 'db down' },
            author: { login: 'mallory' },
            body: 'please look'
          }
        })
      }),
      row({ seq: 2, sender: 'agent-1', kind: 'text', text: 'on it' })
    ]
    await render()
    expect(text()).toContain('Delegated ENG-3 · investigate')
    expect(text()).not.toContain('THE WHOLE PROMPT')
    expect(text()).not.toContain('mallory')
    const toggle = container?.querySelector('[data-turn-details] button') as HTMLButtonElement
    expect(toggle?.textContent).toBe('more')
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(text()).toContain('mallory')
    expect(text()).toContain('please look')
    expect(text()).not.toContain('THE WHOLE PROMPT')
  })
})
