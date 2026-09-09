// @vitest-environment happy-dom

// A PERSISTED elicitation card on the real session page (#1794). The card used to live only in
// the moment: a page reload lost it, and a reader who joined later never learned the question was
// asked at all. It is now a transcript row, and this is the reader who was not there — a Slack
// session read back in the console, whose card is a record rather than something to answer.

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

const CARD = {
  requestId: 'elicit-1',
  message: 'Which branch should I cut from?',
  options: [
    { value: 'main', label: 'main' },
    { value: 'develop', label: 'develop' }
  ]
}

const elicitRow = (body: Record<string, unknown>) =>
  row({ seq: 2, sender: 'agent-1', kind: 'elicit', text: CARD.message, body: JSON.stringify(body) })

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
const buttonNamed = (label: string) =>
  [...(container?.querySelectorAll('button') ?? [])].find((b) => b.textContent === label)

beforeEach(() => {
  wire.messages = []
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

describe('a recorded elicitation card on the session page', () => {
  it('shows what was asked and what was answered, with nothing left to answer', async () => {
    wire.messages = [
      row({ seq: 1, sender: 'sam', kind: 'text', text: 'cut a release' }),
      elicitRow({ ...CARD, outcome: 'accepted', answerLabel: 'release/1.2' }),
      row({ seq: 3, sender: 'agent-1', kind: 'text', text: 'cut from develop' })
    ]
    await render()

    expect(text()).toContain('Which branch should I cut from?')
    // The recorded answer — a label the surrounding conversation does not repeat, so this can
    // only come from the card's own row.
    expect(text()).toContain('release/1.2')
    // A settled card collapses to its outcome, so there is nothing here to tap.
    expect(buttonNamed('main')).toBeUndefined()
    expect(buttonNamed('Dismiss')).toBeUndefined()
    // And the conversation around it is still the conversation.
    expect(text()).toContain('cut a release')
    expect(text()).toContain('cut from develop')
  })

  it('shows an unanswered card as a record, every control inert', async () => {
    wire.messages = [elicitRow(CARD)]
    await render()

    expect(text()).toContain('Which branch should I cut from?')
    // The options are still visible — what was OFFERED is part of the record — but this reader
    // has no socket to answer over, so the card is read-only rather than missing its controls.
    for (const label of ['main', 'develop', 'Dismiss']) expect(buttonNamed(label)?.disabled).toBe(true)
  })

  it('keeps the card where it was asked, not above the turn that asked it', async () => {
    // The agent explains itself and THEN asks. Both rows belong to one turn, and the card used
    // to be hoisted to the head of it — so a reader met the form before the sentence that set
    // it up, and the acknowledgement of an earlier round read as an answer to this one.
    wire.messages = [
      row({ seq: 1, sender: 'agent-1', kind: 'text', text: 'Before I cut it, one question.' }),
      elicitRow(CARD),
      row({ seq: 3, sender: 'agent-1', kind: 'text', text: 'Standing by for your pick.' })
    ]
    await render()

    const shown = text()
    const preamble = shown.indexOf('Before I cut it')
    const question = shown.indexOf('Which branch should I cut from?')
    const after = shown.indexOf('Standing by for your pick.')
    expect(preamble).toBeGreaterThanOrEqual(0)
    expect(question).toBeGreaterThan(preamble)
    expect(after).toBeGreaterThan(question)
  })

  it('says an ask nothing could show was not answerable here', async () => {
    wire.messages = [elicitRow({ ...CARD, options: [], outcome: 'unrenderable' })]
    await render()

    expect(text()).toContain('Which branch should I cut from?')
    expect(text()).toContain("Couldn't be answered here")
  })

  it('falls back to the question alone when the recorded card cannot be read', async () => {
    wire.messages = [row({ seq: 2, sender: 'agent-1', kind: 'elicit', text: CARD.message, body: 'not json' })]
    await render()

    expect(text()).toContain('Which branch should I cut from?')
    expect(buttonNamed('main')).toBeUndefined()
  })
})
