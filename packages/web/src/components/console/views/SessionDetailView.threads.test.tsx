// @vitest-environment happy-dom

// A coordinator's page with threads (webchat-threads.md §6, §7): roots with their footers, thread messages kept to their threads, the turns that answer them labelled, Reply in thread, `?thread=`, the thread that opens on its own, and Slack's shape.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, DaemonRow, Session, SessionStep } from '@/lib/data'
import { sessionFromDto, type SessionDetailDto, type SessionDto, type SessionMessageDto } from '@/lib/api'

const ROOT = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b'
const LATER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

const nav = vi.hoisted(() => ({ search: '', replaced: [] as string[] }))
const wire = vi.hoisted(() => ({
  rows: [] as unknown[],
  detail: null as unknown,
  messages: [] as unknown[],
  threads: [] as unknown[],
  historyCalls: [] as unknown[],
  threadReads: [] as string[],
  threadReplies: [] as unknown[],
  live: [] as unknown[],
  owns: true,
  role: 'collaborator'
}))
const spies = vi.hoisted(() => ({ pgSendThread: vi.fn(() => true) }))

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
    fetchSessionMessages: vi.fn((_id: string, opts: unknown) => {
      wire.historyCalls.push(opts)
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
      wire.threadReads.push(`${sessionId}/${rootId}`)
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
    fetchAssistantSubsession: vi.fn(() => Promise.reject(new actual.ApiError('task not found', 404)))
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
    getPgSession: () => undefined,
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
    pgSendThread: spies.pgSendThread,
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
const replyCall = (seq: number) =>
  row(seq, 'agent-1', 'sendMessage', {
    kind: 'tool',
    thread: ROOT,
    toolCallId: 'call-1',
    body: JSON.stringify({
      toolCallId: 'call-1',
      rawInput: { action: 'replyToMessage', messageId: `msg-${ROOT}`, message: 'Use a warm cache.' }
    })
  })

/** A root, the coordinator's answer, a reply in its thread and the coordinator's turn answering it there. */
function conversation() {
  wire.messages = [
    row(1, 'sam', 'Why is the deploy slow?', { postId: ROOT }),
    row(2, 'agent-1', 'Looking into it.', { thread: ROOT }),
    row(3, 'sam', 'and the cache?', { thread: ROOT, postId: LATER }),
    replyCall(4),
    row(5, 'agent-1', 'Answered in its thread.', { thread: ROOT })
  ]
  wire.threads = [
    {
      rootId: ROOT,
      rootExcerpt: 'Why is the deploy slow?',
      replies: 2,
      lastReplyAt: '2026-10-01T00:00:00.000Z',
      lastReply: { sender: 'agent-1', excerpt: 'Use a warm cache.' },
      participants: [{ sender: 'sam', senderName: 'Sam' }],
      readable: true
    }
  ]
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
  wire.historyCalls = []
  wire.threadReads = []
  wire.threadReplies = []
  wire.live = []
  wire.owns = true
  wire.role = 'collaborator'
  daemonFeatures.length = 0
  daemonFeatures.push('session-mode-auto-v1', 'webchat-threads-v1', 'session-thread-reads-v1')
  spies.pgSendThread.mockClear()
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

describe('a webchat coordinator’s main timeline (webchat-threads.md §6.1)', () => {
  it('reads roots, draws each thread’s footer under its root, and keeps its replies in the thread', async () => {
    conversation()
    await open()
    expect(wire.historyCalls[0]).toMatchObject({ view: 'roots' })
    const footer = q(`[data-thread-footer="${ROOT}"]`)
    expect(footer?.textContent).toContain('2 replies')
    // The latest reply is read in the thread, not previewed on hover.
    expect(footer?.querySelector('[data-thread-preview]')).toBeNull()
    expect(text()).toContain('Why is the deploy slow?')
    expect(text()).not.toContain('and the cache?')
  })

  it('labels the turn that answered in a thread, and draws a replyToMessage call as one line', async () => {
    conversation()
    await open()
    const labels = [...(container?.querySelectorAll('[data-turn-in-thread]') ?? [])]
    // The coordinator's answer to the root has no label; the one answering the thread's reply does.
    expect(labels).toHaveLength(1)
    expect(labels[0]?.textContent).toBe('In thread: Why is the deploy slow?')
    // Its prose stays on the main timeline; its work in the thread does not.
    expect(text()).toContain('Looking into it.')
    expect(text()).toContain('Answered in its thread.')
    expect(q(`[data-turn-answered-in="${ROOT}"]`)).toBeNull()
  })

  it('draws the coordinator’s work in a thread in its panel, between the root and a divider over the replies', async () => {
    conversation()
    wire.threadReplies = [{ seq: 6, sender: 'agent-1', ts: '1700000006', kind: 'text', text: 'Use a warm cache.' }]
    nav.search = `thread=${ROOT}`
    await open()
    const panel = q(`[data-thread-panel="${ROOT}"]`)!
    const order = [...panel.querySelectorAll('[data-thread-message], [data-thread-replies-divider]')].map((el) =>
      el.hasAttribute('data-thread-replies-divider') ? 'divider' : el.getAttribute('data-thread-message')
    )
    expect(order).toEqual(['person', 'agent', 'divider', 'agent'])
    const messages = panel.querySelectorAll('[data-thread-message]')
    expect(messages[1]?.querySelector('[data-turn-fold]')?.getAttribute('title')).toBe('ran 1 command')
    expect(messages[2]?.textContent).toContain('Use a warm cache.')
  })

  it('marks a message handed into a task’s thread, opens that thread from it, and draws the coordinator’s work on it there', async () => {
    const HANDED = '1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d'
    wire.messages = [
      row(1, 'sam', 'Why is the deploy slow?', { postId: ROOT }),
      row(2, 'sam', 'also check the cache', { postId: HANDED, handedTo: ROOT }),
      row(3, 'agent-1', 'sendMessage', { kind: 'tool', thread: HANDED, toolCallId: 'call-h' })
    ]
    wire.threads = [
      {
        rootId: ROOT,
        rootExcerpt: 'Why is the deploy slow?',
        replies: 2,
        lastReplyAt: '2026-10-01T00:00:00.000Z',
        participants: [{ sender: 'sam', senderName: 'Sam' }],
        task: { sessionId: 'task-1', title: 'Deploy speed', state: 'open' },
        readable: true
      }
    ]
    await open()
    // The root's task card is the coordinator's message beside the timeline, not inside the person's bubble column.
    const message = q(`[data-thread-card="${ROOT}"] [data-task-card-message]`)
    expect(message?.textContent).toContain('Deploy speed')
    expect(message?.closest('.group\\/turn')).toBeNull()
    expect(q(`[data-thread-footer="${ROOT}"] [data-task-card-open]`)).toBeNull()
    const lead = q(`[data-turn-handed-to="${ROOT}"]`)
    expect(lead?.textContent).toBe('Replied to a thread:Deploy speed')
    // The coordinator's work on the handed message is not on the main timeline.
    expect(container?.querySelectorAll('[data-turn-fold]')).toHaveLength(0)
    // Its hover Reply writes in the thread it joined, not one of its own.
    const handedReply = q(`[data-turn-handed-to="${ROOT}"]`)
      ?.closest('.group\\/turn')
      ?.querySelector('[data-reply-in-thread]')
    expect(handedReply).not.toBeNull()
    act(() => (handedReply as HTMLButtonElement).click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(q(`[data-thread-panel="${ROOT}"] [data-thread-composer]`)).not.toBeNull()
    await click('[data-task-thread-close]')
    await click(`[data-turn-handed-to="${ROOT}"]`)
    const panel = q(`[data-thread-panel="${ROOT}"]`)
    expect(panel).not.toBeNull()
    expect(panel?.querySelector('[data-turn-fold]')?.getAttribute('title')).toBe('ran 1 command')
  })

  it('opens a thread from its footer, its label and its answered line, at the conversation’s ?thread=', async () => {
    conversation()
    await open()
    await click(`[data-thread-footer="${ROOT}"] [data-task-card-replies]`)
    expect(q(`[data-thread-panel="${ROOT}"]`)).not.toBeNull()
    expect(wire.threadReads).toContain(`session-1/${ROOT}`)
    expect(nav.replaced.at(-1)).toBe(`/acme/sessions/session-1?thread=${ROOT}`)
    await click('[data-task-thread-close]')
    expect(q('[data-thread-panel]')).toBeNull()
    expect(nav.replaced.at(-1)).toBe('/acme/sessions/session-1')
    await click('[data-turn-in-thread]')
    expect(q(`[data-thread-panel="${ROOT}"]`)).not.toBeNull()
  })

  it('draws the footer of a thread under the agent’s own root, which opens it (auto-session-mode.md §6.9.5)', async () => {
    wire.messages = [
      row(1, 'sam', 'anything to do today?', { postId: ROOT }),
      row(2, 'agent-1', 'I will check the findings. Approved by Sam.', { postId: LATER }),
      row(3, 'agent-1', 'A plain answer at the root.', { postId: '11111111-2222-4333-8444-555555555555' })
    ]
    wire.threads = [
      {
        rootId: LATER,
        rootExcerpt: 'I will check the findings.',
        replies: 1,
        lastReplyAt: '2026-10-01T00:00:00.000Z',
        participants: [{ sender: 'agent-1' }],
        task: { sessionId: 'sid-task', title: 'Check the findings', state: 'idle' },
        readable: true
      }
    ]
    await open()
    const footer = q(`[data-thread-footer="${LATER}"]`)
    expect(footer?.textContent).toContain('1 reply')
    // The task's card sits at the bottom of the post's bubble; the replies line is under the bubble, outside it.
    const card = q(`[data-thread-card="${LATER}"]`)
    expect(card?.querySelector('[data-task-card-open]')?.textContent).toContain('Check the findings')
    const bubble = card?.closest('[data-agent-bubble]')
    expect(bubble?.textContent).toContain('I will check the findings.')
    expect(bubble?.contains(footer!)).toBe(false)
    expect(bubble?.nextElementSibling?.contains(footer!)).toBe(true)
    // A post of the agent that holds no thread has no footer.
    expect(container?.querySelectorAll('[data-thread-footer]')).toHaveLength(1)
    await click(`[data-thread-footer="${LATER}"] [data-task-card-replies]`)
    expect(q(`[data-thread-panel="${LATER}"]`)).not.toBeNull()
    expect(nav.replaced.at(-1)).toBe(`/acme/sessions/session-1?thread=${LATER}`)
  })

  it('opens the thread the address names, and closes it when a navigation drops it', async () => {
    conversation()
    nav.search = `thread=${ROOT}`
    await open()
    expect(q(`[data-thread-panel="${ROOT}"]`)).not.toBeNull()
    nav.search = ''
    await open()
    expect(q('[data-thread-panel]')).toBeNull()
  })

  it('keeps what this visit said and streamed in a thread out of the main timeline', async () => {
    conversation()
    wire.live = [
      { kind: 'msg', who: '@you', turnId: 't1', text: 'LIVE THREAD MESSAGE', thread: ROOT },
      { kind: 'done', agentId: 'agent-1', turnId: 't1', text: 'LIVE TASK ANSWER', thread: ROOT },
      { kind: 'msg', who: '@you', turnId: 't2', text: 'LIVE THREAD QUESTION', thread: ROOT },
      { kind: 'done', agentId: 'agent-1', turnId: 't2', text: 'LIVE COORDINATOR ANSWER' }
    ] satisfies SessionStep[]
    await open()
    expect(text()).not.toContain('LIVE THREAD MESSAGE')
    expect(text()).not.toContain('LIVE TASK ANSWER')
    expect(text()).not.toContain('LIVE THREAD QUESTION')
    // The coordinator answering a thread message answers in the main timeline, labelled.
    expect(text()).toContain('LIVE COORDINATOR ANSWER')
    expect([...(container?.querySelectorAll('[data-turn-in-thread]') ?? [])]).toHaveLength(2)
  })
})

describe('writing in a thread (webchat-threads.md §6.3)', () => {
  it('shares a message on the main timeline by the conversation’s address with the message’s anchor', async () => {
    const written: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (text: string) => (written.push(text), Promise.resolve()) }
    })
    conversation()
    await open()
    await click('[data-msg-seq="1"] [data-message-share]')
    const copy = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (b) => b.textContent === 'Copy link'
    )!
    await act(async () => copy.click())
    expect(written.at(-1)).toBe(`${location.origin}/acme/sessions/session-1#msg=1`)
  })

  it('offers the owner Reply in thread on every root, in its hover menu, which opens it with a composer that takes the caret', async () => {
    conversation()
    wire.messages = [...wire.messages, row(6, 'sam', 'Ship the notes', { postId: LATER })]
    await open()
    // Each root's hover menu offers Reply, one with a thread as well as one with none yet.
    expect(container?.querySelectorAll('[data-reply-in-thread]')).toHaveLength(2)
    // A person's message and an agent's share one hover menu: Reply where the reader may, and Copy.
    expect(
      [...(q('[data-reply-in-thread]')?.parentElement?.querySelectorAll('button') ?? [])].map((b) =>
        b.getAttribute('aria-label')
      )
    ).toEqual(['Reply in thread', 'Copy message', 'Share'])
    expect(q('[data-reply-in-thread]')?.closest('[role="toolbar"]')).not.toBeNull()
    expect(q('[data-turn-toolbar] [title="Copy message"]')).not.toBeNull()
    act(() => container!.querySelectorAll<HTMLButtonElement>('[data-reply-in-thread]')[1]!.click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const box = q(`[data-thread-panel="${LATER}"] [data-thread-composer]`)
    expect(box).not.toBeNull()
    expect(document.activeElement).toBe(box)
  })

  it('offers shared threads to members, while keeping viewers and unsupported daemons read-only', async () => {
    conversation()
    wire.messages = [...wire.messages, row(6, 'sam', 'Ship the notes', { postId: LATER })]
    daemonFeatures.splice(daemonFeatures.indexOf('webchat-threads-v1'), 1)
    await open()
    expect(q('[data-reply-in-thread]')).toBeNull()
    await click(`[data-thread-footer="${ROOT}"] [data-task-card-replies]`)
    expect(q('[data-thread-composer]')).toBeNull()

    act(() => root?.unmount())
    root = createRoot(container!)
    daemonFeatures.push('webchat-threads-v1')
    wire.owns = false
    await open()
    expect(q('[data-reply-in-thread]')).not.toBeNull()
    await click(`[data-thread-footer="${ROOT}"] [data-task-card-replies]`)
    expect(q('[data-thread-composer]')).not.toBeNull()

    act(() => root?.unmount())
    root = createRoot(container!)
    wire.role = 'viewer'
    await open()
    expect(q('[data-reply-in-thread]')).toBeNull()
    await click(`[data-thread-footer="${ROOT}"] [data-task-card-replies]`)
    expect(q('[data-thread-composer]')).toBeNull()

    act(() => root?.unmount())
    root = createRoot(container!)
    wire.role = 'collaborator'
    await open(listRow, { ...detail, visibility: 'private' })
    expect(q('[data-reply-in-thread]')).toBeNull()
  })

  it('opens a root’s menu on a long press on a phone, whose Reply in thread opens the thread', async () => {
    conversation()
    setViewport(true)
    await open()
    const bubble = q(`[data-thread-footer="${ROOT}"]`)?.closest<HTMLElement>('.relative')
    expect(bubble).toBeTruthy()
    await act(async () => {
      bubble!.dispatchEvent(new Event('touchstart', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 550))
    })
    expect(q('[data-root-menu]')).not.toBeNull()
    await click('[data-root-menu-reply]')
    expect(q(`[data-thread-panel="${ROOT}"]`)).not.toBeNull()
  })
})

describe('a thread whose first reply starts while the reader watches (webchat-threads.md §6.2)', () => {
  const answer = { kind: 'done', agentId: 'agent-1', turnId: 'p1', postId: 'p1', text: 'On it.', thread: LATER }

  it('opens beside the chat on a desktop', async () => {
    conversation()
    wire.messages = [...wire.messages, row(6, 'sam', 'Ship the notes', { postId: LATER })]
    await open()
    expect(q('[data-thread-panel]')).toBeNull()
    wire.live = [answer]
    await open()
    expect(q(`[data-thread-panel="${LATER}"]`)).not.toBeNull()
  })

  it('stays shut for a thread that already had replies, and on a phone', async () => {
    conversation()
    wire.live = []
    await open()
    wire.live = [{ ...answer, thread: ROOT }]
    await open()
    expect(q('[data-thread-panel]')).toBeNull()

    act(() => root?.unmount())
    root = createRoot(container!)
    setViewport(true)
    wire.messages = [...wire.messages, row(6, 'sam', 'Ship the notes', { postId: LATER })]
    wire.live = []
    await open()
    wire.live = [answer]
    await open()
    expect(q('[data-thread-panel]')).toBeNull()
  })
})

describe('a Slack coordinator’s page in Slack’s shape (webchat-threads.md §7)', () => {
  const at = (seq: number) => `${1_754_123_456 + seq}.000100`
  const ROOT_TS = at(1)
  const slack = (platform: string) => ({
    list: sessionFromDto({
      sessionId: 'session-1',
      sessionKey: { platform, channel: 'C0EXAMPLE', thread: COORDINATE },
      agentId: 'agent-1',
      agentName: 'Ops bot',
      title: 'Coordinator',
      status: 'idle',
      lastActivityAt: '2026-10-01T00:00:00.000Z',
      usage: null,
      triggeredBy: 'U0SAM',
      channelName: 'deploys',
      triggeredByName: 'Sam',
      threadUrl: null
    } as unknown as SessionDto),
    detail: {
      ...detail,
      platform,
      channel: 'C0EXAMPLE',
      channelName: 'deploys',
      tenantScope: 'T0EXAMPLE'
    } as unknown as SessionDetailDto
  })
  const slackRow = (seq: number, sender: string, body: string, over: Partial<SessionMessageDto> = {}) =>
    row(seq, sender, body, { ts: at(seq), ...over })

  it('shows a Slack participant’s same photo in the footer and the open thread', async () => {
    const author = {
      sender: 'U0LEE',
      senderName: 'Lee',
      senderAvatarUrl: 'https://avatars.example.test/lee.png'
    }
    wire.messages = [slackRow(1, 'U0SAM', 'Why is the deploy slow?')]
    wire.threads = [{ rootId: ROOT_TS, replies: 1, participants: [author], readable: true }]
    wire.threadReplies = [slackRow(2, author.sender, 'and the cache?', author)]
    const { list, detail: read } = slack('slack')
    await open(list, read)
    expect(q('[data-thread-participant="U0LEE"] img')?.getAttribute('src')).toBe(author.senderAvatarUrl)
    await click(`[data-thread-footer="${ROOT_TS}"] [data-task-card-replies]`)
    expect(q(`[data-thread-panel="${ROOT_TS}"] [data-thread-message="person"] img`)?.getAttribute('src')).toBe(
      author.senderAvatarUrl
    )
  })

  function channel() {
    wire.messages = [
      slackRow(1, 'U0SAM', 'Why is the deploy slow?'),
      slackRow(2, 'agent-1', 'Looking into it.', { thread: ROOT_TS }),
      slackRow(3, 'U0LEE', 'and the cache?', { thread: ROOT_TS }),
      slackRow(4, 'agent-1', 'sendMessage', {
        kind: 'tool',
        thread: ROOT_TS,
        toolCallId: 'call-1',
        body: JSON.stringify({
          toolCallId: 'call-1',
          rawInput: { action: 'replyToMessage', messageId: `msg-${at(3)}`, message: 'Use a warm cache.' }
        })
      }),
      slackRow(5, 'agent-1', 'Answered in its thread.', { thread: ROOT_TS })
    ]
    wire.threads = [
      {
        rootId: ROOT_TS,
        rootExcerpt: 'Why is the deploy slow?',
        replies: 3,
        lastReplyAt: '2026-10-01T00:00:00.000Z',
        lastReply: { sender: 'agent-1', excerpt: 'Use a warm cache.' },
        participants: [{ sender: 'U0LEE', senderName: 'Lee' }],
        readable: true
      }
    ]
  }

  it('draws roots by their ts with footers, keeps replies in their threads, and labels the turns answering them', async () => {
    channel()
    const { list, detail: read } = slack('slack')
    await open(list, read)
    expect(wire.historyCalls[0]).toMatchObject({ view: 'roots' })
    expect(q(`[data-thread-footer="${ROOT_TS}"]`)?.textContent).toContain('3 replies')
    expect(text()).toContain('Why is the deploy slow?')
    expect(text()).not.toContain('and the cache?')
    expect([...(container?.querySelectorAll('[data-turn-in-thread]') ?? [])].map((el) => el.textContent)).toEqual([
      'In thread: Why is the deploy slow?'
    ])
    // The coordinator's work in the thread is drawn in its panel, not here.
    expect(q(`[data-turn-answered-in="${ROOT_TS}"]`)).toBeNull()
    // A reader who may not continue the coordinator is offered no Reply in thread.
    expect(q('[data-reply-in-thread]')).toBeNull()
  })

  it('draws the footer under the agent’s own top-level post, named by its ts', async () => {
    wire.messages = [slackRow(1, 'agent-1', 'I will check the findings. Approved by Sam.')]
    wire.threads = [
      {
        rootId: ROOT_TS,
        rootExcerpt: 'I will check the findings.',
        replies: 2,
        lastReplyAt: '2026-10-01T00:00:00.000Z',
        participants: [{ sender: 'agent-1' }],
        task: { sessionId: 'sid-task', title: 'Check the findings', state: 'idle' },
        readable: true
      }
    ]
    const { list, detail: read } = slack('slack')
    await open(list, read)
    expect(q(`[data-thread-footer="${ROOT_TS}"]`)?.textContent).toContain('2 replies')
  })

  it('offers whoever may continue the coordinator Reply in thread, whose composer posts in the Slack thread', async () => {
    channel()
    daemonFeatures.push('continuation-threads-v1')
    const { list, detail: read } = slack('slack')
    await open(list, {
      ...read,
      canContinue: true,
      continuationUnavailableReason: null,
      continuationAttachments: 'images'
    } as SessionDetailDto)
    expect(container?.querySelectorAll('[data-reply-in-thread]')).toHaveLength(1)
    await click('[data-reply-in-thread]')
    const panel = q(`[data-thread-panel="${ROOT_TS}"]`)
    expect(panel?.querySelector('[data-thread-composer]')).not.toBeNull()
    expect(panel?.querySelector('[data-task-thread-hint]')).toBeNull()
    expect(panel?.querySelector('[data-task-thread-attach]')).not.toBeNull()
  })

  it('offers no Reply in thread on a Slack root where the daemon cannot continue a coordinator in its threads', async () => {
    channel()
    const { list, detail: read } = slack('slack')
    await open(list, { ...read, canContinue: true, continuationUnavailableReason: null } as SessionDetailDto)
    expect(q('[data-reply-in-thread]')).toBeNull()
    await click(`[data-thread-footer="${ROOT_TS}"] [data-task-card-replies]`)
    expect(q('[data-thread-composer]')).toBeNull()
  })

  it('opens a thread’s record from its footer at ?thread=, linked to the thread in Slack', async () => {
    channel()
    const { list, detail: read } = slack('slack')
    await open(list, read)
    await click(`[data-thread-footer="${ROOT_TS}"] [data-task-card-replies]`)
    expect(wire.threadReads).toContain(`session-1/${ROOT_TS}`)
    expect(nav.replaced.at(-1)).toBe(`/acme/sessions/session-1?thread=${ROOT_TS}`)
    expect(q(`[data-thread-panel="${ROOT_TS}"] [data-thread-platform-link]`)?.getAttribute('href')).toBe(
      `https://app.slack.com/client/T0EXAMPLE/C0EXAMPLE/thread/C0EXAMPLE-${ROOT_TS}`
    )
    await click('[data-task-thread-close]')
    nav.search = `thread=${ROOT_TS}`
    await open(list, read)
    expect(q(`[data-thread-panel="${ROOT_TS}"]`)).not.toBeNull()
  })

  it('keeps the flat transcript for a coordinator whose platform declares no thread shape', async () => {
    channel()
    const { list, detail: read } = slack('telegram')
    await open(list, read)
    expect(wire.historyCalls[0]).not.toMatchObject({ view: 'roots' })
    expect(q('[data-thread-footer]')).toBeNull()
    expect(text()).toContain('and the cache?')
  })
})
