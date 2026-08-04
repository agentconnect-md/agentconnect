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

import { SessionRail, SessionRailSlot } from './SessionRail'
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

const NO_FAMILY = { parentSession: null, siblingSessions: [], childSessions: [] }

function railMarkup({
  sessions = [],
  total = 0,
  family = NO_FAMILY,
  filterTouched = false
}: {
  sessions?: Session[]
  total?: number
  family?: {
    parentSession: SessionRelationDto | null
    siblingSessions: SessionRelationDto[]
    childSessions: SessionRelationDto[]
  }
  filterTouched?: boolean
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
      onSelect={() => {}}
    />
  )
}

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
})
