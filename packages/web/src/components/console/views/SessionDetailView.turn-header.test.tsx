// @vitest-environment happy-dom

// An agent turn on the real session page: prose without bubble chrome under one header line that folds the turn's work.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Session } from '@/lib/data'
import type { SessionMessageDto } from '@/lib/api'

const wire = vi.hoisted(() => ({ messages: [] as unknown[], statusLabel: 'completed' }))

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
  // The RAW daemon state; `prompting` puts the trailing turn in flight.
  get statusLabel() {
    return wire.statusLabel
  },
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
    setPgInput: () => {}
  }
  return { usePlayground: () => playground, usePgDraft: () => '', usePgDraftHasText: () => false }
})

import SessionDetailView from './SessionDetailView'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let container: HTMLDivElement | undefined
let root: ReturnType<typeof createRoot> | undefined

const row = (m: Partial<SessionMessageDto> & { seq: number; sender: string; kind: string; text: string }) => ({
  ts: String(1_700_000_000 + m.seq * 30),
  ...m
})

const tool = (seq: number, toolCallId: string, text: string, toolStatus: string) =>
  row({ seq, sender: 'agent-1', kind: 'tool', text, toolCallId, toolStatus, body: JSON.stringify({ input: text }) })

async function render() {
  await act(async () => {
    root?.render(<SessionDetailView />)
    await Promise.resolve()
  })
  await act(async () => {
    await Promise.resolve()
  })
}

const fold = () => container?.querySelector<HTMLButtonElement>('[data-turn-fold]') ?? null

beforeEach(() => {
  wire.statusLabel = 'completed'
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

describe('a finished agent turn', () => {
  beforeEach(() => {
    wire.messages = [
      row({ seq: 1, sender: 'sam', kind: 'text', text: 'ship it to staging' }),
      tool(2, 'call-1', 'kubectl apply -f k8s/staging/api.yaml', 'completed'),
      tool(3, 'call-2', 'kubectl rollout status deploy/api', 'failed'),
      row({ seq: 4, sender: 'agent-1', kind: 'text', text: 'Applied the manifest.' }),
      row({ seq: 5, sender: 'agent-1', kind: 'text', text: 'The rollout check failed.' })
    ]
  })

  it('folds its work into one header line: its duration and failures, the counts in its tooltip', async () => {
    await render()
    const line = fold()!
    // First step to last step: rows two and five are 90s apart.
    expect(line.textContent).toBe('1m 30s· 1 failed')
    expect(line.title).toBe('Worked for 1m 30s · ran 2 commands · 1 failed')
    expect(line.getAttribute('aria-expanded')).toBe('false')
    expect(container?.textContent).not.toContain('kubectl apply')
  })

  it('keeps each text step its own prose block, with no bubble chrome', async () => {
    await render()
    const prose = Array.from(container?.querySelectorAll('[data-agent-prose]') ?? [])
    expect(prose.map((block) => block.textContent)).toEqual(['Applied the manifest.', 'The rollout check failed.'])
    for (const block of prose) expect(block.className).not.toMatch(/\bborder\b|rounded/)
  })

  it('opens the work above the answer, each step marked with its status', async () => {
    await render()
    await act(async () => fold()!.click())
    expect(fold()!.getAttribute('aria-expanded')).toBe('true')
    const marks = Array.from(container?.querySelectorAll('[data-step-status]') ?? []).map((step) =>
      step.getAttribute('data-step-status')
    )
    expect(marks).toEqual(['done', 'failed'])
    const meta = Array.from(container?.querySelectorAll('[data-step-meta]') ?? []).map((m) => m.textContent)
    expect(meta).toEqual(['Done', 'Failed'])
    const panelStep = container!.querySelector('[data-step-status]')!
    const answer = container!.querySelector('[data-agent-prose]')!
    expect(panelStep.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('links its agent mark to the agent’s page', async () => {
    await render()
    const turnRow = container!.querySelector('[data-agent-prose]')!.closest('[class*="group/turn"]')!
    expect(turnRow.querySelector('a[href="/acme/agents/agent-1"]')).not.toBeNull()
  })

  it('omits the duration when no step carries a timestamp', async () => {
    wire.messages = (wire.messages as SessionMessageDto[]).map((m) => ({ ...m, ts: '' }))
    await render()
    expect(fold()!.textContent).toBe('1 failed')
    expect(fold()!.title).toBe('ran 2 commands · 1 failed')
  })

  it('shows no fold control on a turn that did no work', async () => {
    wire.messages = [
      row({ seq: 1, sender: 'sam', kind: 'text', text: 'hi' }),
      row({ seq: 2, sender: 'agent-1', kind: 'text', text: 'hello' })
    ]
    await render()
    expect(fold()).toBeNull()
    expect(container?.querySelector('[data-agent-prose]')?.textContent).toBe('hello')
  })
})

describe('a running agent turn', () => {
  it('shows a running dot and its duration, and no step text', async () => {
    wire.statusLabel = 'prompting'
    wire.messages = [
      row({ seq: 1, sender: 'sam', kind: 'text', text: 'ship it to staging' }),
      tool(2, 'call-1', 'kubectl apply -f k8s/staging/api.yaml', 'completed'),
      tool(3, 'call-2', 'kubectl rollout status deploy/api --watch', 'in_progress')
    ]
    await render()
    const line = fold()!
    expect(line.querySelector('[data-turn-running]')).not.toBeNull()
    expect(line.textContent).toMatch(/^\d+(h \d+m|m \d+s|s)$/)
    expect(line.title).toMatch(/^Working for .* · ran 2 commands$/)
    await act(async () => line.click())
    const marks = Array.from(container?.querySelectorAll('[data-step-status]') ?? []).map((step) =>
      step.getAttribute('data-step-status')
    )
    expect(marks).toEqual(['done', 'running'])
  })
})
