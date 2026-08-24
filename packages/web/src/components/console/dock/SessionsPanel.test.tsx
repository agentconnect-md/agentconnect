// The Sessions panel inside the dock: the geometry contract first (the detail body centres in whatever space the dock leaves it, so the ONE thing this panel must never do is change its own width when data arrives), then what the list draws.

import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

// Explicit factories: each must export every name the module under test imports, or the import throws before render.
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ orgPath: (path: string) => path, activeOrg: { id: 'org-1' } })
}))

vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({ agents: [], crons: [] })
}))

// next/link wants App Router context that renderToStaticMarkup does not provide.
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactElement; href: string }) => <a href={href}>{children}</a>
}))

// The panel's "New session" action opens a playground then routes to it; renderToStaticMarkup has neither a router nor a provider.
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn()
  })
}))

vi.mock('@/components/console/PlaygroundProvider', () => ({
  usePlayground: () => ({ openPlayground: vi.fn(() => 'pg_new') })
}))

import { SessionsPanel, sessionsPanelWouldHide, sessionsTabStatus } from './SessionsPanel'
import { SessionDock, SessionDockSlot, type DockTab, type DockTabStatus } from './SessionDock'
import type { Session } from '@/lib/data'
import type { SessionRelationDto } from '@/lib/api'

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    title: `Session ${id}`,
    time: '11:02 AM',
    lastActivityAt: '2026-08-03T11:02:00.000Z',
    status: 'online',
    platform: 'slack',
    channel: '#ops',
    user: 'sam',
    duration: '1m',
    tokens: '2.1K',
    cost: '$0.01',
    toolCount: '1',
    statusLabel: 'completed',
    steps: [],
    agentId: 'agent-1',
    ...overrides
  }
}

const relation = (id: string): SessionRelationDto => ({
  id,
  agentId: 'agent-1',
  title: `Session ${id}`,
  platform: 'slack'
})

const NO_FAMILY = { parentSessions: [], siblingSessions: [], childSessions: [] }

const SESSIONS_TAB: DockTab = { key: 'sessions', label: 'Sessions', icon: 'messages-square' }

function panelMarkup({
  sessions = [],
  total = 0,
  family = NO_FAMILY,
  filterTouched = false,
  flatView = false,
  roomLineage,
  status
}: {
  sessions?: Session[]
  total?: number
  family?: {
    parentSessions: SessionRelationDto[]
    siblingSessions?: SessionRelationDto[]
    childSessions: SessionRelationDto[]
  }
  filterTouched?: boolean
  flatView?: boolean
  roomLineage?: { wokenBy: SessionRelationDto | null; woke: SessionRelationDto[] }
  /** The verdict the caller reports for this list — absent = `ready`, which is the only status that draws chrome. A case naming a non-ready state has to pass it, or the dock renders the ready branch. */
  status?: DockTabStatus
} = {}) {
  return renderToStaticMarkup(
    <SessionDock
      tabs={[status ? { ...SESSIONS_TAB, status } : SESSIONS_TAB]}
      activeKey="sessions"
      onTabChange={() => {}}
    >
      <SessionsPanel
        sessions={sessions}
        current={session('current')}
        total={total}
        agentIds={['agent-1']}
        filterTouched={filterTouched}
        onAgentIdsChange={() => {}}
        family={family}
        flatView={flatView}
        {...(roomLineage ? { roomLineage } : {})}
        onSelect={() => {}}
      />
    </SessionDock>
  )
}

/** The depth elbow and the divider, read out of the markup because level is what this list communicates and text assertions cannot see it. */
const ELBOW = 'rounded-bl-[4px]'
const DIVIDER = 'bg-(--border-subtle)'

// The reserved track and its breakpoint gate. The width is the property the pre-paint script sets — the reader's own, and never a function of the DATA.
const COLUMN = 'w-[var(--dock-width)]'
const WIDE_ONLY = 'wide:block'

// The panel's inputs — the filtered page, the family, the reader's filter — settle in any order, and every combination reserves the same track.
describe('SessionDock column', () => {
  it('holds its column with nothing to show, so the body does not re-centre', () => {
    // The resolved "one session, no lineage" outcome, reported as the SETTLED-empty status the caller derives from it — the state that used to give the column back and slide the transcript sideways.
    const markup = panelMarkup({ sessions: [], total: 0, status: 'empty' })

    expect(markup).toContain(COLUMN)
    expect(markup).toContain(WIDE_ONLY)
    expect(markup).not.toContain('All sessions')
    // Withheld with it: the chrome, which is the part that would open a void.
    expect(markup).not.toContain('role="tablist"')
  })

  it('holds the same column while its page is still in flight', () => {
    // Mid-flight looks identical from the inside — `total` is 0 and the only row is the open session — and reads out as `loading`.
    const markup = panelMarkup({ sessions: [], total: 0, status: 'loading' })

    expect(markup).toContain(COLUMN)
    expect(markup).toContain(WIDE_ONLY)
    expect(markup).not.toContain('role="tablist"')
  })

  it('keeps the column width once rows arrive', () => {
    const markup = panelMarkup({ sessions: [session('a'), session('b')], total: 2 })

    expect(markup).toContain(COLUMN)
    expect(markup).toContain('All sessions')
  })

  it('keeps the column width when family arrives after a one-row list', () => {
    // The other ordering: a one-row page settles, then the detail reveals lineage and the list gains rows. Width must not move.
    const before = panelMarkup({ sessions: [], total: 1 })
    const after = panelMarkup({ sessions: [], total: 1, family: { ...NO_FAMILY, childSessions: [relation('child')] } })

    expect(before).toContain(COLUMN)
    expect(after).toContain(COLUMN)
    expect(after).toContain('Related')
  })

  it('keeps the column width for a reader-cleared filter with no rows', () => {
    expect(panelMarkup({ sessions: [], total: 0, filterTouched: true })).toContain(COLUMN)
  })

  it('renders the placeholder at the same width the populated dock uses', () => {
    // SessionDetailFrame draws SessionDockSlot while the detail loads; it only holds the page still if it is the same box as the dock.
    const slot = renderToStaticMarkup(<SessionDockSlot />)

    expect(slot).toContain(COLUMN)
    expect(slot).toContain(WIDE_ONLY)
    expect(panelMarkup({ sessions: [session('a'), session('b')], total: 2 })).toContain(COLUMN)
  })

  it('shows the row time inline and still carries it in the tooltip', () => {
    // The 224px rail could only afford the title; the dock buys the time back, while the channel stays behind the tooltip.
    const markup = panelMarkup({ sessions: [session('a'), session('b')], total: 2 })

    expect(markup).toContain('>11:02 AM</span>')
    expect(markup).not.toContain('#ops')
  })

  it('keeps flat mode on session and list links', () => {
    const markup = panelMarkup({ sessions: [session('a'), session('b')], total: 2, flatView: true })

    expect(markup).toContain('href="/sessions/a?view=flat"')
    expect(markup).toContain('href="/sessions?view=flat&amp;agent=agent-1"')
  })
})

// The verdict a caller widens a collapsed SEED on (railSeedShouldWiden) — a unit, because re-deriving it from the fetched page misses lineage and off-page pins, and gets both wrong in the direction that widens a serviceable list and throws its seeded chips away.
describe('sessionsPanelWouldHide', () => {
  const collapsed = { total: 1, rowCount: 1, hasFamily: false, filterTouched: false }

  it('hides a list holding only the session already on screen', () => {
    expect(sessionsPanelWouldHide(collapsed)).toBe(true)
  })

  it('keeps a one-row list that has lineage to draw', () => {
    // The Related tree is the panel's content here, and the picker rides with it.
    expect(sessionsPanelWouldHide({ ...collapsed, hasFamily: true })).toBe(false)
  })

  it('keeps a list whose merged rows outnumber the open session', () => {
    // `rowCount` is the merged set, so an off-page pin lands here even when the filtered page held one conversation.
    expect(sessionsPanelWouldHide({ ...collapsed, rowCount: 2 })).toBe(false)
  })

  it('keeps a list whose filtered page is shorter than its total', () => {
    expect(sessionsPanelWouldHide({ ...collapsed, total: 86 })).toBe(false)
  })

  it('keeps the filter control reachable once the reader has set one', () => {
    expect(sessionsPanelWouldHide({ ...collapsed, filterTouched: true })).toBe(false)
  })
})

// The same verdict as the tab status: the dock withholds its chrome for both non-ready answers, but only a settled one can be drawn as an empty body.
describe('sessionsTabStatus', () => {
  it('is loading until the panel has reported a verdict at all', () => {
    // The initial-fetch window, which the old code spent showing an empty dock.
    expect(sessionsTabStatus(null, false)).toBe('loading')
    expect(sessionsTabStatus(null, true)).toBe('loading')
  })

  it('is still loading for a hide reported while the caller is fetching', () => {
    // The rows are the open session alone until the page lands, so the hide is true here and means nothing yet.
    expect(sessionsTabStatus(true, false)).toBe('loading')
  })

  it('is empty only once a hide has settled over every input', () => {
    expect(sessionsTabStatus(true, true)).toBe('empty')
  })

  it('is ready the moment the panel has content, settled or not', () => {
    // A list worth drawing is worth drawing now: a page revalidating behind it must not take the dock away again.
    expect(sessionsTabStatus(false, false)).toBe('ready')
    expect(sessionsTabStatus(false, true)).toBe('ready')
  })
})

// Attribution answers WHO woke whom, so the row has to name the agent: participants of one thread share a title and a platform, and identify nobody by them.
describe('SessionsPanel room attribution', () => {
  const participant = (id: string, agentId: string, agentName: string): SessionRelationDto => ({
    id,
    agentId,
    agentName,
    platform: 'slack',
    // Deliberately identical to the other participant's, and to the open row's.
    title: 'Session current'
  })

  it('names the agents when the participants share a session title', () => {
    const markup = panelMarkup({
      roomLineage: {
        wokenBy: participant('rel-a', 'agent-a', 'Alert Analyzer'),
        woke: [participant('rel-b', 'agent-b', 'node-operator'), participant('rel-c', 'agent-c', 'db-operator')]
      }
    })

    // Direction is drawn as indent, so the words live in the tooltip and in sr-only text, never in a heading that restates the indent.
    expect(markup).toContain('title="Delegated by Alert Analyzer')
    expect(markup).toContain('title="Delegated to node-operator')
    expect(markup).toContain('<span class="sr-only">Delegated by</span>')
    expect(markup).toContain('<span class="sr-only">Delegated to</span>')
    // The identities, which the shared title cannot carry.
    expect(markup).toContain('Alert Analyzer')
    expect(markup).toContain('node-operator')
    expect(markup).toContain('db-operator')
  })

  it('gives the navigation rows the same words', () => {
    // A cross-room parent is `wokenBy`'s edge seen from elsewhere, and a screen reader has no indent, so both kinds of row carry the words.
    const markup = panelMarkup({
      family: { ...NO_FAMILY, parentSessions: [relation('rel-p')], childSessions: [relation('rel-k')] }
    })

    expect(markup).toContain('<span class="sr-only">Delegated by</span>')
    expect(markup).toContain('<span class="sr-only">Delegated to</span>')
  })

  it('falls back to the agent id when nothing can name the agent', () => {
    // Older CPs omit the projection, and a restricted agent can own a member session while staying out of this roster. An id beats a blank row.
    const anonymous: SessionRelationDto = {
      id: 'rel-x',
      agentId: 'agent-restricted',
      platform: 'slack',
      title: 'Session current'
    }
    const markup = panelMarkup({ roomLineage: { wokenBy: anonymous, woke: [] } })

    expect(markup).toContain('agent-restricted')
  })

  it('does not turn a co-participant into a navigation target', () => {
    // Attribution (§9.1): `/sessions/:id` would redirect back to this page, so no link — and no pin, which is a shortcut to another conversation.
    const markup = panelMarkup({
      roomLineage: {
        wokenBy: participant('rel-a', 'agent-a', 'Alert Analyzer'),
        woke: [participant('rel-b', 'agent-b', 'node-operator'), participant('rel-c', 'agent-c', 'db-operator')]
      }
    })

    expect(markup).not.toContain('href="/sessions/rel-a"')
    expect(markup).not.toContain('href="/sessions/rel-b"')
    expect(markup).not.toContain('href="/sessions/rel-c"')
    // Four rows are drawn, three of them attribution, and only the open row — a real session in the list — carries a pin toggle.
    expect(markup.split('aria-pressed=').length - 1).toBe(1)
  })
})

// Level 0 over a MERGED page, the one that can have several parents. The drawn level is the ONLY thing naming a relation, so misplacing one misreports it.
describe('SessionsPanel conversation parents', () => {
  it('draws every waking conversation on the level above the open row', () => {
    // The regression: with one parent slot the second waker rode in `siblingSessions` and was drawn BELOW the open row, under the divider.
    const markup = panelMarkup({
      family: { parentSessions: [relation('parent-a'), relation('parent-b')], childSessions: [] }
    })

    const first = markup.indexOf('href="/sessions/parent-a"')
    const second = markup.indexOf('href="/sessions/parent-b"')
    const open = markup.indexOf('href="/sessions/current"')
    expect(first).toBeGreaterThan(-1)
    expect(second).toBeGreaterThan(first)
    expect(open).toBeGreaterThan(second)
    // Level 0 draws no elbow, so the only one belongs to the open row beneath them — and nothing was set aside behind a divider.
    expect(markup.split(ELBOW).length - 1).toBe(1)
    expect(markup).not.toContain(DIVIDER)
  })

  it('gives each waking conversation the same edge words', () => {
    // Both are the same edge, so the words a screen reader hears must not depend on which parent came second.
    const markup = panelMarkup({
      family: { parentSessions: [relation('parent-a'), relation('parent-b')], childSessions: [] }
    })

    expect(markup.split('<span class="sr-only">Delegated by</span>').length - 1).toBe(2)
  })

  it('keeps lineage siblings beside the open row, which is what they are', () => {
    // The other meaning, on a single-session page: siblings share the open session's PARENT, so they sit at its level past the divider.
    const markup = panelMarkup({
      family: {
        parentSessions: [relation('parent-a')],
        siblingSessions: [relation('sibling-a')],
        childSessions: []
      }
    })

    const open = markup.indexOf('href="/sessions/current"')
    const divider = markup.indexOf(DIVIDER)
    const sibling = markup.indexOf('href="/sessions/sibling-a"')
    expect(divider).toBeGreaterThan(open)
    expect(sibling).toBeGreaterThan(divider)
    // Both the open row and the sibling hang off the parent above them.
    expect(markup.split(ELBOW).length - 1).toBe(2)
    // A sibling sits on neither edge the two words name, so it carries neither.
    expect(markup.split('<span class="sr-only">Delegated by</span>').length - 1).toBe(1)
  })
})
