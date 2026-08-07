// @vitest-environment happy-dom

// The rail's hide VERDICT as the caller consumes it — the sequence, not the
// snapshot. `SessionDetailView` widens a collapsed seed off this callback and
// latches the result, and that latch is a one-way door: widening replaces the
// rows, so the collapse that justified it stops being observable the moment it
// works. A verdict reported before its inputs settle therefore does not merely
// flicker, it freezes — which is why the orderings below are pinned here rather
// than left to the pure-function tests, which cannot see them.
//
// Effects have to run for any of that to be observable, so this file is happy-dom
// rather than the SSR markup harness in SessionRail.test.tsx.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { Session } from '@/lib/data'
import type { SessionRelationDto } from '@/lib/api'
import { SESSION_PINS_KEY } from '@/lib/session-pins'

vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ orgPath: (path: string) => path, activeOrg: { id: 'org-1' } })
}))

vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({ agents: [], crons: [] })
}))

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactElement; href: string }) => <a href={href}>{children}</a>
}))

// The pin-hydration read, held open so the "still loading" window is a state the
// test controls rather than a race it hopes to win. Partial mock: the platform
// registry SessionRail pulls in re-exports much of this module, and replacing it
// wholesale fails at import time long before any of it is rendered.
const detailCalls: Array<(value: unknown) => void> = []
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchSessionDetail: () => new Promise((resolve) => detailCalls.push(resolve)),
  sessionFromDetailDto: (dto: unknown) => dto
}))

import { SessionRail } from './SessionRail'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

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

interface Family {
  parentSessions: SessionRelationDto[]
  siblingSessions?: SessionRelationDto[]
  childSessions: SessionRelationDto[]
}

const NO_FAMILY: Family = { parentSessions: [], siblingSessions: [], childSessions: [] }

let root: Root | undefined
let container: HTMLDivElement | undefined

beforeEach(() => {
  detailCalls.length = 0
  window.localStorage.clear()
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

async function render(node: ReactElement) {
  if (!container) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  }
  await act(async () => root?.render(node))
}

function rail({
  onWouldHideChange,
  family = NO_FAMILY,
  sessions = [] as Session[],
  total = 1
}: {
  onWouldHideChange: (wouldHide: boolean) => void
  family?: Family
  sessions?: Session[]
  total?: number
}) {
  return (
    <SessionRail
      sessions={sessions}
      current={session('current')}
      total={total}
      agentIds={['agent-1', 'agent-2']}
      filterTouched={false}
      onAgentIdsChange={() => {}}
      family={family}
      onSelect={() => {}}
      onWouldHideChange={onWouldHideChange}
    />
  )
}

describe('SessionRail hide verdict', () => {
  it('reports that it would draw nothing once a collapsed page has settled', async () => {
    // The reported bug's shape: a seeded page carrying only the open conversation.
    const onWouldHideChange = vi.fn()
    await render(rail({ onWouldHideChange }))

    expect(onWouldHideChange).toHaveBeenCalledWith(true)
  })

  it('corrects the verdict when lineage lands after the one-row page', async () => {
    // The ordering the geometry suite already acknowledges — a one-row rail that
    // learns about lineage only after its own list arrived. The rail renders its
    // Related tree and keeps the picker, so the earlier `true` is now wrong; the
    // caller must not have acted on it, which is why it waits for lineage before
    // latching.
    const onWouldHideChange = vi.fn()
    await render(rail({ onWouldHideChange }))
    expect(onWouldHideChange).toHaveBeenLastCalledWith(true)

    await render(rail({ onWouldHideChange, family: { ...NO_FAMILY, childSessions: [relation('child')] } }))

    expect(onWouldHideChange).toHaveBeenLastCalledWith(false)
  })

  it('withholds the verdict entirely while an off-page pin is still hydrating', async () => {
    // A pin the seeded page never carried is a row the rail is about to gain, and
    // an in-flight pin read is indistinguishable from having none. Reporting here
    // would latch a widen that the arriving row immediately disproves.
    window.localStorage.setItem(SESSION_PINS_KEY, JSON.stringify([{ id: 'pinned-elsewhere', orgId: 'org-1' }]))
    const onWouldHideChange = vi.fn()

    await render(rail({ onWouldHideChange }))

    expect(detailCalls.length).toBe(1)
    expect(onWouldHideChange).not.toHaveBeenCalled()

    await act(async () => detailCalls[0]?.(session('pinned-elsewhere')))

    // Settled — and the hydrated pin is a second row, so the rail is worth drawing.
    expect(onWouldHideChange).toHaveBeenCalled()
    expect(onWouldHideChange).toHaveBeenLastCalledWith(false)
  })
})
