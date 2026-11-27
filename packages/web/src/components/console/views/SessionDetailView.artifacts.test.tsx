// @vitest-environment happy-dom

// The artifact viewer on the real session page (artifacts.md §11.2): a main-conversation card opens it in the dock's Artifacts tab, a task thread's card in the left pane, a phone on the standalone page, and the URL restores each.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, DaemonRow, Session, SessionStep } from '@/lib/data'
import { sessionFromDto, type SessionDetailDto, type SessionDto, type SessionMessageDto } from '@/lib/api'

const ROOT = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b'
const ARTIFACT = '0b6d1d55-5f43-4c8e-9a51-2f0a8f5b1c3d'
const RUNBOOK = '7c2e9f10-3a4b-4c5d-8e6f-1a2b3c4d5e6f'
const MARKER = `[artifact: ${ARTIFACT} r2 "Q3 dashboard"]`

const nav = vi.hoisted(() => ({ search: '', replaced: [] as string[] }))
const wire = vi.hoisted(() => ({
  rows: [] as unknown[],
  detail: null as unknown,
  messages: [] as unknown[],
  threads: [] as unknown[],
  threadReplies: [] as unknown[],
  live: [] as unknown[],
  pg: null as null | ({ id: string; realSessionId?: string } & Record<string, unknown>),
  owns: true,
  role: 'collaborator',
  latest: {} as Record<string, number>,
  activity: {} as Record<string, number>
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'session-1' }),
  usePathname: () => '/acme/sessions/session-1',
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({
    replace: (href: string) => {
      nav.replaced.push(href)
      nav.search = href.includes('?') ? href.slice(href.indexOf('?') + 1) : ''
    },
    push: () => {},
    prefetch: () => {},
    back: () => {},
    forward: () => {},
    refresh: () => {}
  })
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  )
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    fetchSessionMessages: vi.fn(() => {
      return Promise.resolve({
        sessionId: 'session-1',
        messages: wire.messages,
        nextCursor: null,
        liveCursor: null,
        liveMore: false,
        threads: wire.threads
      })
    }),
    fetchSessionThreadMessages: vi.fn((sessionId: string, rootId: string) => {
      return Promise.resolve({
        sessionId,
        rootId,
        messages: [
          { seq: 1, sender: 'sam', ts: '1700000001', kind: 'text', text: 'Why is the deploy slow?', postId: rootId },
          ...wire.threadReplies
        ],
        nextCursor: null,
        liveCursor: null,
        liveMore: false,
        summary: { rootId, replies: 0, participants: [], readable: true }
      })
    }),
    fetchSessionDetail: vi.fn(() => Promise.resolve({ ...(wire.detail as object), ownsConversation: wire.owns })),
    fetchMySessionIdentity: vi.fn(() => Promise.reject(new Error('no identity'))),
    // The conversation's one member, still on the daemon that recorded it, so it resumes.
    fetchConversationByKey: vi.fn(() =>
      Promise.resolve({
        conversation: {
          key: null,
          platform: 'webchat',
          channel: 'conv-1',
          thread: null,
          sessions: [{ sessionId: 'session-1', agentId: 'agent-1', daemonId: 'daemon-1' }]
        },
        accessSyncDegraded: false,
        accessIssues: []
      })
    ),
    fetchAgentTasks: vi.fn(() =>
      Promise.resolve({ sessionId: 'session-1', tracked: true, tasks: [], truncated: false })
    ),
    fetchSessionPullRequest: vi.fn(() => Promise.reject(new actual.ApiError('pull request not found', 404))),
    fetchAssistantSubsessions: vi.fn(() => Promise.resolve({ subsessions: [], truncated: false, nextCursor: null })),
    fetchAssistantSubsession: vi.fn(() => Promise.reject(new actual.ApiError('task not found', 404))),
    getArtifact: vi.fn((id: string) => Promise.resolve(artifactDto(id))),
    // The body stays loading: these cases are about where the viewer opens, not what it draws.
    getArtifactRevision: vi.fn(() => new Promise(() => {}))
  }
})

function artifactDto(id: string = ARTIFACT) {
  const latest = wire.latest[id] ?? 2
  const revision = (number: number) => ({
    number,
    entry: 'index.html',
    entryMediaType: 'text/html',
    fileCount: 1,
    totalBytes: 2048,
    producedBy: { agentId: 'agent-1', name: 'Ops bot' },
    producedInSessionId: 'session-1',
    createdAt: '2026-11-25T10:00:00.000Z'
  })
  return {
    id,
    title: id === ARTIFACT ? 'Q3 dashboard' : 'Runbook',
    audience: { visibility: 'org', externalProvider: null, editorsAgentId: null },
    owner: null,
    viewerIsOwner: true,
    originSessionId: 'session-1',
    latestRevision: latest,
    createdAt: '2026-11-25T10:00:00.000Z',
    updatedAt: '2026-11-25T10:00:00.000Z',
    revisions: Array.from({ length: latest }, (_, i) => revision(latest - i))
  }
}

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
  { daemonId: 'daemon-1', name: 'edge-1', runtimeModels: [], mcpServers: [], caps: { features: [] as string[] } }
] as unknown as DaemonRow[]
const daemonFeatures = (daemons[0] as unknown as { caps: { features: string[] } }).caps.features

vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents: [agent],
    allSessions: wire.rows,
    getSessions: () => wire.rows,
    sessionsLoading: false,
    crons: [],
    daemons,
    memberSets: [],
    integrations: [],
    bots: [],
    orgSetIds: new Set<string>(),
    members: [],
    sessionActivityVersionById: wire.activity,
    sessionStreamGeneration: 0,
    revalidateSessionLists: () => {}
  })
}))

vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({
    activeOrg: { id: 'org-1', slug: 'acme' },
    myRole: wire.role,
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
    getPgSuggestion: () => undefined,
    getPgSession: (id: string) =>
      wire.pg && (wire.pg.id === id || wire.pg.realSessionId === id) ? wire.pg : undefined,
    getLiveSteps: () => wire.live,
    getBusyLaneAgentIds: () => [],
    reconcileLiveSteps: () => {},
    getPgImage: () => undefined,
    getPgFiles: () => [],
    setPgFiles: () => {},
    getPgWorktree: () => false,
    isPgBusy: () => false,
    isPgTurnUnstreamed: () => false,
    setPgImage: () => {},
    openPlayground: () => 'pg_new',
    pgSend: () => true,
    pgSendThread: () => true,
    getPgTurnThread: () => undefined,
    getPgRelayFeatures: () => undefined,
    markSessionTarget: () => {},
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
    getPgInput: () => '',
    subscribePgDraft: () => () => {}
  }
  return { usePlayground: () => playground, usePgDraft: () => '', usePgDraftHasText: () => false }
})

import SessionDetailView from './SessionDetailView'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// The member's coordinator conversation: a webchat conversation on the coordinator's append coordinate.
const COORDINATE = 'append:coordinator-1700000000000'
const listRow: Session = sessionFromDto({
  sessionId: 'session-1',
  sessionKey: { platform: 'webchat', channel: 'conv-1', thread: COORDINATE },
  agentId: 'agent-1',
  agentName: 'Ops bot',
  title: 'Coordinator',
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

const detail = {
  id: 'session-1',
  parentSession: null,
  siblingSessions: [],
  childSessions: [],
  agentId: 'agent-1',
  agentName: 'Ops bot',
  platform: 'webchat',
  channel: 'conv-1',
  thread: COORDINATE,
  title: 'Coordinator',
  status: 'idle',
  lastActivityAt: '2026-10-01T00:00:00.000Z',
  usage: null,
  triggeredBy: 'sam',
  channelName: null,
  triggeredByName: 'Sam',
  threadUrl: null,
  runtime: 'claude',
  model: 'sonnet',
  daemonId: 'daemon-1',
  workspaceIsolation: 'shared',
  visibility: 'org',
  canContinue: false,
  continuationUnavailableReason: 'unsupported_platform'
} as unknown as SessionDetailDto

const row = (seq: number, sender: string, text: string, over: Partial<SessionMessageDto> = {}): SessionMessageDto => ({
  seq,
  sender,
  ts: String(1_700_000_000 + seq),
  kind: 'text',
  text,
  ...over
})
/** A root, and the coordinator's answer on the main timeline carrying an artifact card. */
function conversation() {
  wire.messages = [row(1, 'sam', 'Chart last quarter', { postId: ROOT }), row(2, 'agent-1', `Here it is.\n${MARKER}`)]
  wire.threads = [
    {
      rootId: ROOT,
      rootExcerpt: 'Chart last quarter',
      replies: 1,
      lastReplyAt: '2026-10-01T00:00:00.000Z',
      lastReply: { sender: 'agent-1', excerpt: 'A revision' },
      participants: [{ sender: 'sam', senderName: 'Sam' }],
      readable: true
    }
  ]
  wire.threadReplies = [{ seq: 6, sender: 'agent-1', ts: '1700000006', kind: 'text', text: `A revision\n${MARKER}` }]
}

let container: HTMLDivElement | undefined
let root: ReturnType<typeof createRoot> | undefined

async function settle() {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

async function open(list: Session = listRow, read: SessionDetailDto = detail) {
  wire.rows = [list]
  wire.detail = read
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
const q = (selector: string) => container?.querySelector<HTMLElement>(selector) ?? null
async function click(selector: string) {
  const target = q(selector)
  if (!target) throw new Error(`no ${selector}`)
  await act(async () => {
    target.click()
  })
  await settle()
}

beforeEach(() => {
  nav.search = ''
  nav.replaced = []
  wire.messages = []
  wire.threads = []
  wire.threadReplies = []
  wire.live = []
  wire.pg = null
  wire.owns = true
  wire.role = 'collaborator'
  wire.latest = {}
  wire.activity = {}
  daemonFeatures.length = 0
  daemonFeatures.push('session-mode-auto-v1', 'webchat-threads-v1', 'session-thread-reads-v1')
  setViewport(false)
  window.__AC_ENV = { ARTIFACTS_CONTENT_DOMAIN: 'example-usercontent.net' }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  delete window.__AC_ENV
  act(() => root?.unmount())
  container?.remove()
  container = undefined
  root = undefined
})

const viewer = () => q('[data-testid="artifact-viewer"]')
const conversationHidden = () => q('[data-conversation-pane]')?.className === 'hidden'

describe('the artifact viewer on a session page (artifacts.md §11.2)', () => {
  it('opens a main-conversation card in the dock’s Artifacts tab, selected', async () => {
    conversation()
    await open()
    expect(q('[data-dock-tab="artifacts"]')?.getAttribute('aria-selected')).toBe('false')
    await click('[data-transcript-scroll] [data-artifact-open="dock"]')
    expect(nav.replaced.at(-1)).toBe(`/acme/sessions/session-1?artifact=${ARTIFACT}&artifactRevision=2`)
    expect(q('[data-dock-tab="artifacts"]')?.getAttribute('aria-selected')).toBe('true')
    expect(viewer()?.dataset.variant).toBe('dock')
    expect(viewer()?.textContent).toContain('Q3 dashboard')
    // The conversation keeps its place on the left.
    expect(conversationHidden()).toBe(false)
  })

  it('restores the dock viewer from the address on a reload', async () => {
    conversation()
    nav.search = `artifact=${ARTIFACT}&artifactRevision=1`
    await open()
    expect(q('[data-dock-tab="artifacts"]')?.getAttribute('aria-selected')).toBe('true')
    expect(viewer()?.dataset.variant).toBe('dock')
    expect(viewer()?.textContent).toContain('A newer revision (r2) is available.')
    expect(q('[data-artifact-viewer-full-screen]')?.getAttribute('href')).toBe(`/acme/artifacts/${ARTIFACT}?revision=1`)
  })

  it('switches revisions in the address and drops the site page', async () => {
    conversation()
    nav.search = `artifact=${ARTIFACT}&artifactRevision=2&artifactPath=%2Fdocs.html`
    await open()
    await click('[data-testid="artifact-viewer"] button[aria-haspopup="menu"]')
    const r1 = [...(container?.querySelectorAll('[role="menuitemradio"]') ?? [])].find((item) =>
      item.textContent?.startsWith('Revision 1')
    ) as HTMLElement
    await act(async () => r1.click())
    expect(nav.replaced.at(-1)).toBe(`/acme/sessions/session-1?artifact=${ARTIFACT}&artifactRevision=1`)
  })

  it('opens a task thread’s card in the left pane, keeping the thread in the dock', async () => {
    conversation()
    nav.search = `thread=${ROOT}`
    await open()
    await click(`[data-thread-panel="${ROOT}"] [data-artifact-open="pane"]`)
    expect(nav.replaced.at(-1)).toBe(
      `/acme/sessions/session-1?thread=${ROOT}&artifact=${ARTIFACT}&artifactRevision=2&artifactIn=pane`
    )
    await open()
    expect(viewer()?.dataset.variant).toBe('pane')
    expect(conversationHidden()).toBe(true)
    expect(q(`[data-thread-panel="${ROOT}"]`)).not.toBeNull()
  })

  it('closes the left pane back to the conversation', async () => {
    conversation()
    nav.search = `thread=${ROOT}&artifact=${ARTIFACT}&artifactIn=pane`
    await open()
    expect(viewer()?.dataset.variant).toBe('pane')
    await click('[data-artifact-viewer-close]')
    expect(nav.replaced.at(-1)).toBe(`/acme/sessions/session-1?thread=${ROOT}`)
    await open()
    expect(viewer()).toBeNull()
    expect(conversationHidden()).toBe(false)
  })

  it('opens the standalone page on a phone, which has no dock', async () => {
    setViewport(true)
    conversation()
    nav.search = `artifact=${ARTIFACT}&artifactRevision=2&artifactPath=%2Fdocs.html`
    await open()
    expect(nav.replaced.at(-1)).toBe(`/acme/artifacts/${ARTIFACT}?revision=2&path=%2Fdocs.html`)
    expect(q('[data-artifact-open]')?.getAttribute('data-artifact-open')).toBe('page')
  })

  it('offers no Artifacts tab and ignores the address on a deployment without artifacts', async () => {
    delete window.__AC_ENV
    conversation()
    nav.search = `artifact=${ARTIFACT}`
    await open()
    expect(q('[data-dock-tab="artifacts"]')).toBeNull()
    expect(viewer()).toBeNull()
  })
})

/** The agent answering this visit's message with a card, as the stream delivers it before the rows do. */
function publishLive(artifactId: string, revision: number, title = 'Runbook') {
  wire.live = [
    { kind: 'msg', who: '@you', turnId: 't9', text: 'And a runbook' },
    { kind: 'done', agentId: 'agent-1', turnId: 't9', text: `Done.\n[artifact: ${artifactId} r${revision} "${title}"]` }
  ] satisfies SessionStep[]
}
const openedArtifacts = () => nav.replaced.filter((href) => href.includes('artifact='))

describe('the viewer opening by itself (artifacts.md §11.2, D23)', () => {
  it('leaves the cards already in the conversation closed', async () => {
    conversation()
    nav.search = `thread=${ROOT}`
    await open()
    expect(q('[data-transcript-scroll] [data-testid="artifact-card"]')).not.toBeNull()
    expect(q(`[data-thread-panel="${ROOT}"] [data-testid="artifact-card"]`)).not.toBeNull()
    expect(openedArtifacts()).toEqual([])
    expect(viewer()).toBeNull()
  })

  it('opens a card that arrives in the main conversation in the dock’s Artifacts tab', async () => {
    conversation()
    await open()
    publishLive(RUNBOOK, 1)
    await open()
    expect(nav.replaced.at(-1)).toBe(`/acme/sessions/session-1?artifact=${RUNBOOK}&artifactRevision=1`)
    await open()
    expect(q('[data-dock-tab="artifacts"]')?.getAttribute('aria-selected')).toBe('true')
    expect(viewer()?.dataset.variant).toBe('dock')
    expect(conversationHidden()).toBe(false)
  })

  it('opens a card that arrives in a task thread in the left pane', async () => {
    conversation()
    nav.search = `thread=${ROOT}`
    await open()
    wire.threadReplies = [
      ...wire.threadReplies,
      {
        seq: 7,
        sender: 'agent-1',
        ts: '1700000007',
        kind: 'text',
        text: `Runbook\n[artifact: ${RUNBOOK} r1 "Runbook"]`
      }
    ]
    wire.activity = { 'session-1': 1 }
    await open()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await settle()
    expect(nav.replaced.at(-1)).toBe(
      `/acme/sessions/session-1?thread=${ROOT}&artifact=${RUNBOOK}&artifactRevision=1&artifactIn=pane`
    )
  })

  it('does not reopen an artifact the person closed at that revision', async () => {
    conversation()
    await open()
    publishLive(RUNBOOK, 1)
    await open()
    await open()
    await click('[data-artifact-viewer-close]')
    expect(nav.search).toBe('')
    // The same card again, as its saved row replaces the stream.
    wire.live = []
    wire.messages = [
      ...wire.messages,
      row(3, 'sam', 'And a runbook'),
      row(4, 'agent-1', `Done.\n[artifact: ${RUNBOOK} r1 "Runbook"]`)
    ]
    await open()
    expect(nav.search).toBe('')
  })

  it('never opens by itself on a phone', async () => {
    setViewport(true)
    conversation()
    await open()
    publishLive(RUNBOOK, 1)
    await open()
    expect(openedArtifacts()).toEqual([])
  })
})

describe('revision following in place (artifacts.md §11.4)', () => {
  it('moves a viewer on the latest revision to the one the agent just published, with a notice', async () => {
    conversation()
    nav.search = `artifact=${ARTIFACT}&artifactRevision=2`
    await open()
    wire.latest[ARTIFACT] = 3
    publishLive(ARTIFACT, 3, 'Q3 dashboard')
    await open()
    expect(nav.replaced.at(-1)).toBe(`/acme/sessions/session-1?artifact=${ARTIFACT}&artifactRevision=3`)
    await open()
    expect(viewer()?.textContent).toContain('Updated to r3.')
    await click('[data-artifact-updated-dismiss]')
    expect(viewer()?.textContent).not.toContain('Updated to r3.')
  })

  it('keeps a deliberately chosen older revision and offers the newer one', async () => {
    conversation()
    nav.search = `artifact=${ARTIFACT}&artifactRevision=1`
    await open()
    wire.latest[ARTIFACT] = 3
    publishLive(ARTIFACT, 3, 'Q3 dashboard')
    await open()
    expect(nav.search).toBe(`artifact=${ARTIFACT}&artifactRevision=1`)
    expect(viewer()?.textContent).toContain('A newer revision (r3) is available.')
    expect(viewer()?.textContent).not.toContain('Updated to')
    const latest = [...(viewer()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'View latest')!
    await act(async () => latest.click())
    expect(nav.replaced.at(-1)).toBe(`/acme/sessions/session-1?artifact=${ARTIFACT}&artifactRevision=3`)
  })
})
