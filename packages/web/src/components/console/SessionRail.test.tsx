// The rail's geometry contract, not its contents. The detail body is centred in
// whatever horizontal space the rail leaves it, so the ONE thing this component
// must never do is change its own width in response to data arriving. Its three
// inputs — the agent-filtered session page, the session's family, and the reader's
// filter — settle in any order and at any time, and every combination has to render
// the same 250px column. These cases are the orderings that used to shift the page:
// a rail that resolves to "no rows worth showing", and a one-row rail that learns
// about lineage only after its own list has landed.

import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

// Explicit factories: each must export every name the module under test imports,
// or the import throws before render.
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

import { SessionRail, SessionRailSlot, railWouldHide } from './SessionRail'
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

function railMarkup({
  sessions = [],
  total = 0,
  family = NO_FAMILY,
  filterTouched = false,
  flatView = false,
  roomLineage
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
} = {}) {
  return renderToStaticMarkup(
    <SessionRail
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
  )
}

/** The indent elbow a row draws at depth > 0, and the horizontal rule that sets
 *  rows beside the open one apart from the path through it. Read out of the
 *  markup because level is what this rail communicates, and both are invisible
 *  to any assertion made on text alone. */
const ELBOW = 'rounded-bl-[4px]'
const DIVIDER = 'bg-(--border-subtle)'

// The column's width and its breakpoint gate, as they appear in the markup. A
// change here is a change to the page's geometry, so it should fail loudly rather
// than quietly move the transcript.
const COLUMN = 'w-[250px]'
const WIDE_ONLY = 'wide:block'

describe('SessionRail column', () => {
  it('holds its column with nothing to show, so the body does not re-centre', () => {
    // The resolved "this agent has one session and no lineage" outcome. Returning
    // nothing here is what used to slide the transcript 125px left.
    const markup = railMarkup({ sessions: [], total: 0 })

    expect(markup).toContain(COLUMN)
    expect(markup).toContain(WIDE_ONLY)
    expect(markup).not.toContain('All sessions')
  })

  it('holds the same column while its page is still in flight', () => {
    // Mid-flight looks identical to the empty outcome from the inside: `total` is 0
    // and the only row is the open session merged in by the component.
    expect(railMarkup({ sessions: [], total: 0 })).toContain(COLUMN)
  })

  it('keeps the column width once rows arrive', () => {
    const markup = railMarkup({ sessions: [session('a'), session('b')], total: 2 })

    expect(markup).toContain(COLUMN)
    expect(markup).toContain('All sessions')
  })

  it('keeps the column width when family arrives after a one-row list', () => {
    // The other ordering: the rail's own page settles first at one row, then the
    // session detail reveals lineage and the rail gains rows. Width must not move.
    const before = railMarkup({ sessions: [], total: 1 })
    const after = railMarkup({ sessions: [], total: 1, family: { ...NO_FAMILY, childSessions: [relation('child')] } })

    expect(before).toContain(COLUMN)
    expect(after).toContain(COLUMN)
    expect(after).toContain('Related')
  })

  it('keeps the column width for a reader-cleared filter with no rows', () => {
    expect(railMarkup({ sessions: [], total: 0, filterTouched: true })).toContain(COLUMN)
  })

  it('renders the placeholder at the same width the populated rail uses', () => {
    // SessionDetailFrame draws SessionRailSlot while the detail is loading. It only
    // holds the page still if it is the same box as the populated rail.
    const slot = renderToStaticMarkup(<SessionRailSlot />)

    expect(slot).toContain(COLUMN)
    expect(slot).toContain(WIDE_ONLY)
    expect(railMarkup({ sessions: [session('a'), session('b')], total: 2 })).toContain(COLUMN)
  })

  it('keeps flat mode on session and list links', () => {
    const markup = railMarkup({ sessions: [session('a'), session('b')], total: 2, flatView: true })

    expect(markup).toContain('href="/sessions/a?view=flat"')
    expect(markup).toContain('href="/sessions?view=flat&amp;agent=agent-1"')
  })
})

// The verdict the rail reports upward so a caller can widen a SEEDED filter that
// collapsed (see railSeedShouldWiden). Pinned here as a unit because a caller that
// re-derived it from its own fetched page would miss the two inputs the page does
// not carry — lineage, and pins hydrated from outside it — and would widen a rail
// that is in fact perfectly serviceable, throwing the seeded chips away with it.
describe('railWouldHide', () => {
  const collapsed = { total: 1, rowCount: 1, hasFamily: false, filterTouched: false }

  it('hides a rail holding only the session already on screen', () => {
    expect(railWouldHide(collapsed)).toBe(true)
  })

  it('keeps a one-row rail that has lineage to draw', () => {
    // The Related tree is the rail's content here, and the picker rides with it.
    expect(railWouldHide({ ...collapsed, hasFamily: true })).toBe(false)
  })

  it('keeps a rail whose merged rows outnumber the open session', () => {
    // `rowCount` is the merged set, so an off-page pin lands here even when the
    // filtered page itself came back with a single conversation.
    expect(railWouldHide({ ...collapsed, rowCount: 2 })).toBe(false)
  })

  it('keeps a rail whose filtered list is longer than its first page', () => {
    expect(railWouldHide({ ...collapsed, total: 86 })).toBe(false)
  })

  it('keeps the filter control reachable once the reader has set one', () => {
    expect(railWouldHide({ ...collapsed, filterTouched: true })).toBe(false)
  })
})

// Attribution answers WHO woke whom, so the row has to name the agent. Sessions
// in one merged thread routinely share a title — it is derived from the same
// first message — and necessarily share the platform, so a row built from those
// two fields identifies nobody.
describe('SessionRail room attribution', () => {
  const participant = (id: string, agentId: string, agentName: string): SessionRelationDto => ({
    id,
    agentId,
    agentName,
    platform: 'slack',
    // Deliberately identical to the other participant's, and to the open row's.
    title: 'Session current'
  })

  it('names the agents when the participants share a session title', () => {
    const markup = railMarkup({
      roomLineage: {
        wokenBy: participant('rel-a', 'agent-a', 'Alert Analyzer'),
        woke: [participant('rel-b', 'agent-b', 'node-operator'), participant('rel-c', 'agent-c', 'db-operator')]
      }
    })

    // Direction is drawn as indent, so the words live in the tooltip and in
    // sr-only text — never in a heading line, which restated the indent below
    // it and usually the title with it.
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
    // A cross-room parent is the same edge as `wokenBy`, and a cross-room
    // delegation the same edge as `woke` — only the other end's location
    // differs. A screen reader gets no indent and no tooltip, so both kinds of
    // row have to carry the words, or half the tree loses its direction.
    const markup = railMarkup({
      family: { ...NO_FAMILY, parentSessions: [relation('rel-p')], childSessions: [relation('rel-k')] }
    })

    expect(markup).toContain('<span class="sr-only">Delegated by</span>')
    expect(markup).toContain('<span class="sr-only">Delegated to</span>')
  })

  it('falls back to the agent id when nothing can name the agent', () => {
    // Older Control Planes omit the projection, and a restricted agent can own a
    // member session while staying out of this viewer's roster. An id beats a
    // blank row.
    const anonymous: SessionRelationDto = {
      id: 'rel-x',
      agentId: 'agent-restricted',
      platform: 'slack',
      title: 'Session current'
    }
    const markup = railMarkup({ roomLineage: { wokenBy: anonymous, woke: [] } })

    expect(markup).toContain('agent-restricted')
  })

  it('does not turn a co-participant into a navigation target', () => {
    // These rows are attribution (§9.1). `/sessions/:id` would redirect back to
    // the page they are rendered on, so the row must not be a link. Nor a pin:
    // a pin is a shortcut back to another conversation, and this row is a
    // statement about the one already open.
    const markup = railMarkup({
      roomLineage: {
        wokenBy: participant('rel-a', 'agent-a', 'Alert Analyzer'),
        woke: [participant('rel-b', 'agent-b', 'node-operator'), participant('rel-c', 'agent-c', 'db-operator')]
      }
    })

    expect(markup).not.toContain('href="/sessions/rel-a"')
    expect(markup).not.toContain('href="/sessions/rel-b"')
    expect(markup).not.toContain('href="/sessions/rel-c"')
    // Four rows are drawn — three attribution plus the open one — and only the
    // open row, which is a real session in the list, carries a pin toggle.
    expect(markup.split('aria-pressed=').length - 1).toBe(1)
  })
})

// Level 0 over a MERGED page, which is the one that can have several parents:
// each member woken from another room contributes its own. With the headings
// gone, the level a row is drawn at is the ONLY thing saying which of the three
// it is, so a parent put anywhere else is a parent misreported.
describe('SessionRail conversation parents', () => {
  it('draws every waking conversation on the level above the open row', () => {
    // The regression: only one parent slot existed, so the second waking
    // conversation was carried in `siblingSessions` — a field that means "other
    // children of my parent" on a single-session page — and the rail drew it
    // BELOW the open row, at the open row's own level, under the divider.
    const markup = railMarkup({
      family: { parentSessions: [relation('parent-a'), relation('parent-b')], childSessions: [] }
    })

    const first = markup.indexOf('href="/sessions/parent-a"')
    const second = markup.indexOf('href="/sessions/parent-b"')
    const open = markup.indexOf('href="/sessions/current"')
    expect(first).toBeGreaterThan(-1)
    expect(second).toBeGreaterThan(first)
    expect(open).toBeGreaterThan(second)
    // Level 0 draws no elbow, so the only one belongs to the open row beneath
    // them — and nothing was set aside behind a divider.
    expect(markup.split(ELBOW).length - 1).toBe(1)
    expect(markup).not.toContain(DIVIDER)
  })

  it('gives each waking conversation the same edge words', () => {
    // Both are the same edge, so neither gets a different vocabulary for being
    // second — the words a screen reader hears must not depend on order.
    const markup = railMarkup({
      family: { parentSessions: [relation('parent-a'), relation('parent-b')], childSessions: [] }
    })

    expect(markup.split('<span class="sr-only">Delegated by</span>').length - 1).toBe(2)
  })

  it('keeps lineage siblings beside the open row, which is what they are', () => {
    // The other meaning, on a single-session page: siblings share the open
    // session's PARENT, so they belong at its level, past the divider that ends
    // the path through it. Nothing on a merged page reaches this branch.
    const markup = railMarkup({
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
