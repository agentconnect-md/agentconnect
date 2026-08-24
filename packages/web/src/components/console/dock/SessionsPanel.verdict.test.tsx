// @vitest-environment happy-dom

// The hide VERDICT as the caller consumes it — the sequence rather than the snapshot, since the widen it feeds is a one-way door (a verdict reported before its inputs settle does not flicker, it FREEZES), pinned in happy-dom because effects have to run for any of it to be observable.

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

// The pin-hydration read, held open so the "still loading" window is a state the test controls rather than a race it hopes to win.
const detailCalls: Array<(value: unknown) => void> = []
// Partial: the platform registry SessionsPanel pulls in re-exports much of this module, and replacing it wholesale fails at import time.
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchSessionDetail: () => new Promise((resolve) => detailCalls.push(resolve)),
  sessionFromDetailDto: (dto: unknown) => dto
}))

import { SessionsPanel } from './SessionsPanel'

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

function panel({
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
    <SessionsPanel
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

describe('SessionsPanel hide verdict', () => {
  it('reports that it would draw nothing once a collapsed page has settled', async () => {
    // The reported bug's shape: a seeded page carrying only the open conversation.
    const onWouldHideChange = vi.fn()
    await render(panel({ onWouldHideChange }))

    expect(onWouldHideChange).toHaveBeenCalledWith(true)
  })

  it('corrects the verdict when lineage lands after the one-row page', async () => {
    // A one-row list that learns about lineage afterwards: it now draws a Related tree, so the earlier `true` is wrong and must not have been acted on.
    const onWouldHideChange = vi.fn()
    await render(panel({ onWouldHideChange }))
    expect(onWouldHideChange).toHaveBeenLastCalledWith(true)

    await render(panel({ onWouldHideChange, family: { ...NO_FAMILY, childSessions: [relation('child')] } }))

    expect(onWouldHideChange).toHaveBeenLastCalledWith(false)
  })

  it('withholds the verdict entirely while an off-page pin is still hydrating', async () => {
    // An in-flight pin read is indistinguishable from having none, so reporting here latches a widen the arriving row immediately disproves.
    window.localStorage.setItem(SESSION_PINS_KEY, JSON.stringify([{ id: 'pinned-elsewhere', orgId: 'org-1' }]))
    const onWouldHideChange = vi.fn()

    await render(panel({ onWouldHideChange }))

    expect(detailCalls.length).toBe(1)
    expect(onWouldHideChange).not.toHaveBeenCalled()

    await act(async () => detailCalls[0]?.(session('pinned-elsewhere')))

    // Settled — and the hydrated pin is a second row, so the list is worth drawing.
    expect(onWouldHideChange).toHaveBeenCalled()
    expect(onWouldHideChange).toHaveBeenLastCalledWith(false)
  })
})
