// @vitest-environment happy-dom

// A file the agent shared, on the real session page: the row's provenance marker becomes a chip that
// downloads the original bytes from the session that shared them, and the caption stays the message.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Session } from '@/lib/data'
import type { SessionMessageDto } from '@/lib/api'

const wire = vi.hoisted(() => ({ messages: [] as unknown[], download: vi.fn(), save: vi.fn() }))

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
    fetchWorkspaceGitLog: vi.fn(() =>
      Promise.resolve({ isRepo: false, commits: [], truncated: false, tracking: null })
    ),
    downloadSessionFile: wire.download
  }
})

vi.mock('@/lib/shared-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shared-file')>()
  return { ...actual, saveBlob: wire.save }
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

const SHA = '1a2b3c4d5e6f7a8b'

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
  wire.download.mockReset()
  wire.save.mockReset()
  wire.messages = [
    row({ seq: 1, sender: 'sam', kind: 'text', text: 'chart last week’s revenue' }),
    row({
      seq: 2,
      sender: 'agent-1',
      kind: 'text',
      text: `revenue by week\n[shared: out/chart.png (image/png, 48213 bytes, sha256:${SHA})]`
    })
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

describe('a shared file on the session page', () => {
  it('shows the caption and a download chip instead of the raw marker', async () => {
    const blob = new Blob(['png'])
    wire.download.mockResolvedValue(blob)
    await render()

    expect(text()).toContain('revenue by week')
    expect(text()).not.toContain('[shared:')
    const chip = container?.querySelector('button[title="Download chart.png"]') as HTMLButtonElement | null
    expect(chip).not.toBeNull()
    await act(async () => {
      chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(wire.download).toHaveBeenCalledWith('agent-1', {
      sessionId: 'session-1',
      path: 'out/chart.png',
      sha256: SHA
    })
    expect(wire.save).toHaveBeenCalledWith(blob, 'chart.png')
  })

  it('leaves a person’s message that merely looks like a marker as text', async () => {
    wire.messages = [
      row({ seq: 1, sender: 'sam', kind: 'text', text: `[shared: a.png (image/png, 1 bytes, sha256:${SHA})]` })
    ]
    await render()
    expect(text()).toContain('[shared: a.png')
    expect(container?.querySelector('button[title="Download a.png"]')).toBeNull()
  })
})
