// @vitest-environment happy-dom

// A task's own page is read-only (its channel is synthetic and its thread no platform thread, so a composer could reach neither it nor its turn) and names the session it belongs to.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, DaemonRow, Session } from '@/lib/data'
import { sessionFromDto, type SessionDetailDto, type SessionDto, type SessionMessageDto } from '@/lib/api'

const wire = vi.hoisted(() => ({
  rows: [] as unknown[],
  detail: null as unknown,
  messages: [] as unknown[],
  busy: false,
  draft: 'more please'
}))
const spies = vi.hoisted(() => ({ pgAttach: vi.fn(), pgCancel: vi.fn(), listFilters: [] as unknown[] }))

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

const daemons = [
  { daemonId: 'daemon-1', name: 'edge-1', runtimeModels: [], mcpServers: [], caps: { features: [] } }
] as unknown as DaemonRow[]

vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents: [agent],
    allSessions: wire.rows,
    getSessions: () => wire.rows,
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
vi.mock('@/lib/stick-to-bottom', () => ({ useStickToBottom: () => ({ pin: () => {}, awayFromBottom: false }) }))
vi.mock('@/lib/auth', () => ({ isAuthConfigured: () => false }))
vi.mock('@/lib/use-session-list', () => ({
  useSessionList: (orgId: string | null, filters: unknown) => {
    if (orgId) spies.listFilters.push(filters)
    return { sessions: [], total: 0, isLoading: false, nextCursor: null, loadingMore: false }
  }
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
    getPgFiles: () => [],
    setPgFiles: () => {},
    getPgWorktree: () => false,
    isPgBusy: () => wire.busy,
    setPgImage: () => {},
    openPlayground: () => 'pg_new',
    pgSend: () => true,
    markSessionTarget: () => {},
    pgAttach: spies.pgAttach,
    getPgQueue: () => [],
    pgCancelQueued: () => {},
    pgAddAgent: () => {},
    pgSetModel: () => {},
    pgSetEffort: () => {},
    pgSetPermissionPreset: () => {},
    pgSetFast: () => {},
    pgSetWorktree: () => {},
    pgCancel: spies.pgCancel,
    setPgInput: () => {},
    getPgInput: () => 'more please',
    subscribePgDraft: () => () => {}
  }
  return { usePlayground: () => playground, usePgDraft: () => wire.draft, usePgDraftHasText: () => wire.draft !== '' }
})

import SessionDetailView from './SessionDetailView'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

interface Origin {
  platform: string
  channel: string
  thread: string | null
}

// What the daemon records: the caller's platform, a channel derived from the agent, and a reserved thread of its own.
const WEBCHAT_SUBSESSION: Origin = { platform: 'webchat', channel: 'a2a:agent-1', thread: 'subsession:delivery-1' }
const WEBCHAT_PATROL: Origin = { platform: 'webchat', channel: 'a2a:agent-1', thread: 'subsession:patrol-delivery-2' }
const SLACK_SUBSESSION: Origin = { platform: 'slack', channel: 'a2a:agent-1', thread: 'subsession:delivery-3' }
const SLACK_PATROL: Origin = { platform: 'slack', channel: 'a2a:agent-1', thread: 'subsession:patrol-delivery-4' }
const WEBCHAT: Origin = { platform: 'webchat', channel: 'conv-1', thread: null }
const SLACK: Origin = { platform: 'slack', channel: 'C0123', thread: '1700000000.000100' }

const listRow = (origin: Origin): Session =>
  sessionFromDto({
    sessionId: 'session-1',
    sessionKey: {
      platform: origin.platform,
      channel: origin.channel,
      ...(origin.thread !== null ? { thread: origin.thread } : {})
    },
    agentId: 'agent-1',
    agentName: 'Ops bot',
    title: 'Fix the flaky test',
    status: 'idle',
    lastActivityAt: '2026-10-01T00:00:00.000Z',
    usage: null,
    triggeredBy: 'sam',
    channelName: null,
    triggeredByName: 'Sam',
    threadUrl: null,
    runtime: 'claude',
    model: 'sonnet',
    daemonId: 'daemon-1'
  } as unknown as SessionDto)

// The Control Plane's own verdict: a Slack-origin task still reads as continuable there.
const OWNER = { id: 'owner-1', agentId: 'agent-1', agentName: 'Ops bot', platform: 'slack', title: 'Deploy the thing' }

const detailOf = (origin: Origin, parentSession: SessionDetailDto['parentSession'] = null): SessionDetailDto => {
  const canContinue = origin.platform !== 'webchat'
  return {
    id: 'session-1',
    parentSession,
    siblingSessions: [],
    childSessions: [],
    agentId: 'agent-1',
    agentName: 'Ops bot',
    platform: origin.platform,
    channel: origin.channel,
    thread: origin.thread,
    title: 'Fix the flaky test',
    status: 'idle',
    lastActivityAt: '2026-10-01T00:00:00.000Z',
    usage: null,
    triggeredBy: 'sam',
    channelName: null,
    triggeredByName: 'Sam',
    threadUrl: null,
    runtime: 'claude',
    model: 'sonnet',
    effort: null,
    fastMode: null,
    permissionMode: null,
    outputMode: null,
    daemonId: 'daemon-1',
    workspaceIsolation: 'shared',
    executorDaemonId: null,
    stayedHomeReason: null,
    canContinue,
    continuationUnavailableReason: canContinue ? null : 'unsupported_platform'
  } as unknown as SessionDetailDto
}

const message = (seq: number, sender: string, text: string): SessionMessageDto => ({
  seq,
  sender,
  ts: String(1_700_000_000 + seq),
  kind: 'text',
  text
})

let container: HTMLDivElement | undefined
let root: ReturnType<typeof createRoot> | undefined

async function settle() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

async function open(
  origin: Origin,
  { listed = true, parent = null }: { listed?: boolean; parent?: SessionDetailDto['parentSession'] } = {}
) {
  wire.rows = listed ? [listRow(origin)] : []
  wire.detail = detailOf(origin, parent)
  await act(async () => {
    root?.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <SessionDetailView />
      </SWRConfig>
    )
  })
  await settle()
}

function setViewport(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: mobile && query.includes('max-width: 768px'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia
}

const text = () => container?.textContent ?? ''
const composer = () => container?.querySelector<HTMLTextAreaElement>('textarea[placeholder="Message Ops bot…"]')
const button = (label: string) => container?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)

beforeEach(() => {
  wire.rows = []
  wire.detail = null
  wire.messages = [message(1, 'agent-1', 'TRANSCRIPT MARKER')]
  wire.busy = false
  wire.draft = 'more please'
  spies.pgAttach.mockClear()
  spies.pgCancel.mockClear()
  setViewport(false)
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

const SUBSESSIONS = [
  ['a webchat-origin task', WEBCHAT_SUBSESSION],
  ['a webchat-origin patrol', WEBCHAT_PATROL],
  ['a Slack-origin task', SLACK_SUBSESSION],
  ['a Slack-origin patrol', SLACK_PATROL]
] as const

describe.each([
  ['on a desktop', false],
  ['on a phone', true]
])('a task’s own page %s', (_viewport, mobile) => {
  beforeEach(() => setViewport(mobile))

  it.each(SUBSESSIONS)('keeps %s readable but offers no composer', async (_name, origin) => {
    await open(origin)

    expect(text()).toContain('TRANSCRIPT MARKER')
    expect(container?.querySelector('textarea')).toBeNull()
    expect(button('Send message')).toBeNull()
  })

  it.each(SUBSESSIONS)('offers no composer stop for %s while its turn runs', async (_name, origin) => {
    wire.busy = true
    // Empty, so the composer would show Stop if it were offered at all.
    wire.draft = ''
    await open(origin)

    expect(button('Stop response')).toBeNull()
    expect(spies.pgCancel).not.toHaveBeenCalled()
  })

  it.each(SUBSESSIONS.slice(0, 2))('dials no webchat socket for %s', async (_name, origin) => {
    await open(origin)

    expect(spies.pgAttach).not.toHaveBeenCalled()
  })

  it('stays read-only when it is opened by a link rather than from a loaded list', async () => {
    await open(WEBCHAT_SUBSESSION, { listed: false })

    expect(text()).toContain('TRANSCRIPT MARKER')
    expect(container?.querySelector('textarea')).toBeNull()
  })

  it.each(SUBSESSIONS)('names the session %s belongs to and links back to it', async (_name, origin) => {
    await open(origin, { parent: OWNER })

    const owner = container?.querySelector('[data-task-owner]')
    expect(owner?.textContent).toBe('Belongs to Deploy the thing · task')
    expect(owner?.querySelector('a')?.getAttribute('href')).toMatch(/\/sessions\/owner-1$/)
    // Its tool calls stay in its own transcript, and the owner is a plain labelled link, not a tree.
    expect(text()).toContain('TRANSCRIPT MARKER')
    const related = container?.querySelector('[data-related-card]')
    expect(related?.querySelector('[data-related-row="startedBy"]')?.textContent).toContain(
      'Started by Deploy the thing'
    )
  })

  it('says the owning session is not visible rather than inventing a link', async () => {
    await open(SLACK_SUBSESSION)

    const owner = container?.querySelector('[data-task-owner]')
    expect(owner?.textContent).toBe('Task · the session it belongs to isn’t visible to you')
    expect(owner?.querySelector('a')).toBeNull()
  })
})

describe.each([
  ['on a desktop', false],
  ['on a phone', true]
])('an ordinary session’s page %s', (_viewport, mobile) => {
  beforeEach(() => setViewport(mobile))

  it('keeps a webchat conversation’s composer, its stop and its socket', async () => {
    wire.busy = true
    // Stop replaces Send only while the composer is empty.
    wire.draft = ''
    await open(WEBCHAT)

    expect(composer()).not.toBeNull()
    expect(button('Stop response')).not.toBeNull()
    expect(spies.pgAttach).toHaveBeenCalledWith('session-1', 'agent-1', 'conv-1')
  })

  it('keeps a channel session’s continuation composer', async () => {
    await open(SLACK)

    expect(composer()).not.toBeNull()
    expect(button('Send message')).not.toBeNull()
  })

  it('keeps tasks out of the Sessions rail, as All sessions does by default', async () => {
    spies.listFilters.length = 0
    await open(SLACK)

    expect(spies.listFilters.length).toBeGreaterThan(0)
    for (const filters of spies.listFilters) expect(filters).toMatchObject({ excludeTasks: true })
  })

  it('carries no task header, even with a session that started it', async () => {
    await open(SLACK, { parent: OWNER })

    expect(container?.querySelector('[data-task-owner]')).toBeNull()
    expect(container?.querySelector('[data-related-row="startedBy"]')).not.toBeNull()
  })
})
