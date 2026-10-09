// @vitest-environment happy-dom

// The dock's Sub-sessions panel: it lists only the sub-sessions this conversation opened, links only those the reader may open, stops one through the console's stop route, pages on, and reports the verdict that puts its tab in the strip.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const wire = vi.hoisted(() => ({
  pages: [] as unknown[],
  /** When set, the daemon's whole list, newest first, paged by an index cursor as the route pages it. */
  server: null as null | Array<{ state: string; canStop: boolean }>,
  failure: null as null | { status: number; code?: string },
  calls: [] as Array<{ agentId: string; opts: { parentSessionId?: string; cursor?: string; limit?: number } }>,
  stops: [] as Array<{ agentId: string; sessionId: string }>,
  stopAnswer: { result: 'stopped' } as unknown,
  stopFailure: null as null | { status: number; code?: string }
}))

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code?: string
    ) {
      super(message)
      this.name = 'ApiError'
    }
  }
  return {
    ApiError,
    fetchAssistantSubsessions: vi.fn(
      (agentId: string, opts: { parentSessionId?: string; cursor?: string; limit?: number }) => {
        wire.calls.push({ agentId, opts })
        if (wire.failure) return Promise.reject(new ApiError('nope', wire.failure.status, wire.failure.code))
        if (wire.server) {
          const start = opts.cursor ? Number(opts.cursor) : 0
          const end = start + (opts.limit ?? 50)
          const subsessions = wire.server.slice(start, end).map((r) => ({ ...r }))
          const nextCursor = end < wire.server.length ? String(end) : null
          return Promise.resolve({ subsessions, truncated: nextCursor !== null, nextCursor })
        }
        // Each read answers the next queued page; the last one repeats.
        const page = wire.pages.length > 1 ? wire.pages.shift() : wire.pages[0]
        return Promise.resolve(page)
      }
    ),
    stopAssistantSubsession: vi.fn((agentId: string, sessionId: string) => {
      wire.stops.push({ agentId, sessionId })
      if (wire.stopFailure) return Promise.reject(new ApiError('nope', wire.stopFailure.status, wire.stopFailure.code))
      return Promise.resolve(wire.stopAnswer)
    })
  }
})

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>
}))

vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ orgPath: (path: string) => `/acme${path}` }) }))

import {
  SUBSESSIONS_PAGE,
  SubsessionsPanel,
  subsessionsTabShown,
  type SubsessionsPanelVerdict
} from './SubsessionsPanel'
import type { AssistantSubsessionDto } from '@/lib/api'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let container: HTMLDivElement | undefined
let root: ReturnType<typeof createRoot> | undefined
let verdicts: SubsessionsPanelVerdict[] = []

function row(overrides: Partial<AssistantSubsessionDto> = {}): AssistantSubsessionDto {
  return {
    sessionId: 'child-1',
    title: 'Fix the flaky test',
    state: 'open',
    startedAt: '2026-10-09T09:00:00.000Z',
    visible: true,
    canStop: true,
    parent: { sessionId: 'session-1', title: 'support', platform: 'slack', channelName: 'support' },
    ...overrides
  }
}

const page = (subsessions: AssistantSubsessionDto[], nextCursor: string | null = null) => ({
  subsessions,
  truncated: nextCursor !== null,
  nextCursor
})

type PanelProps = Parameters<typeof SubsessionsPanel>[0]

const panel = (props: Partial<PanelProps> = {}) => (
  <SubsessionsPanel
    agentId="agent-a"
    sessionId="session-1"
    onVerdictChange={(verdict) => verdicts.push(verdict)}
    {...props}
  />
)

const flush = async () => {
  for (let i = 0; i < 3; i++) await Promise.resolve()
}

async function render(props: Partial<PanelProps> = {}) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(panel(props))
    await flush()
  })
}

async function rerender(props: Partial<PanelProps> = {}) {
  await act(async () => {
    root?.render(panel(props))
    await flush()
  })
}

async function click(el: Element | null | undefined) {
  if (!el) throw new Error('nothing to click')
  await act(async () => {
    ;(el as HTMLElement).click()
    await flush()
  })
}

const text = () => container?.textContent ?? ''
const rows = () => Array.from(container?.querySelectorAll<HTMLElement>('[data-subsession-row]') ?? [])
const buttons = (label: string) =>
  Array.from(container?.querySelectorAll<HTMLButtonElement>('button') ?? []).filter((b) =>
    b.textContent?.includes(label)
  )
const last = () => verdicts.at(-1)

beforeEach(() => {
  wire.pages = [page([])]
  wire.server = null
  wire.failure = null
  wire.calls = []
  wire.stops = []
  wire.stopAnswer = { result: 'stopped' }
  wire.stopFailure = null
  verdicts = []
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  container = undefined
  root = undefined
  vi.restoreAllMocks()
})

describe('SubsessionsPanel', () => {
  it('reads only this conversation’s sub-sessions and draws each one’s state and start', async () => {
    wire.pages = [
      page([
        row(),
        row({ sessionId: 'child-2', title: null, state: 'done', canStop: false }),
        row({ sessionId: 'child-3', title: 'Bump the chart', state: 'failed', canStop: false })
      ])
    ]
    await render()
    expect(wire.calls).toEqual([
      { agentId: 'agent-a', opts: { parentSessionId: 'session-1', limit: SUBSESSIONS_PAGE } }
    ])
    expect(rows().map((r) => r.dataset.subsessionRow)).toEqual(['open', 'done', 'failed'])
    expect(rows().map((r) => r.querySelector('[data-subsession-state]')?.textContent)).toEqual([
      'Running',
      'Reported',
      'Failed'
    ])
    expect(text()).toContain('Untitled sub-session')
    expect(rows()[0]?.querySelector('time')?.getAttribute('dateTime')).toBe('2026-10-09T09:00:00.000Z')
    expect(last()).toEqual({ settled: true, count: 3, running: 1, failed: false })
  })

  it('links a sub-session only where the reader may open it', async () => {
    wire.pages = [
      page([
        row(),
        row({ sessionId: null, title: null, visible: true, canStop: false }),
        row({ sessionId: null, title: null, visible: false, canStop: false, parent: null })
      ])
    ]
    await render()
    const links = Array.from(container?.querySelectorAll('a') ?? []).map((a) => a.getAttribute('href'))
    expect(links).toEqual(['/acme/sessions/child-1'])
    expect(rows()[1]?.textContent).toContain('Starting…')
    expect(rows()[2]?.textContent).toContain('Not visible to you')
    expect(rows()[2]?.querySelector('a')).toBeNull()
  })

  it('offers Stop only on a running sub-session the reader may stop, and shows what the stop did', async () => {
    wire.pages = [
      page([
        row(),
        row({ sessionId: 'child-2', canStop: false }),
        row({ sessionId: 'child-3', state: 'done', canStop: true })
      ])
    ]
    await render()
    expect(buttons('Stop')).toHaveLength(1)
    const reads = wire.calls.length
    await click(buttons('Stop')[0])
    expect(wire.stops).toEqual([{ agentId: 'agent-a', sessionId: 'child-1' }])
    expect(container?.querySelector('[data-subsession-stop]')?.textContent).toBe('Stopped.')
    // The stop re-reads, so the row's own state follows.
    expect(wire.calls.length).toBe(reads + 1)

    wire.stopAnswer = { result: 'not_running' }
    await click(buttons('Stop')[0])
    expect(container?.querySelector('[data-subsession-stop]')?.textContent).toBe('Nothing was running.')

    wire.stopFailure = { status: 503, code: 'DAEMON_OFFLINE' }
    await click(buttons('Stop')[0])
    expect(container?.querySelector('[data-subsession-stop]')?.textContent).toBe('Couldn’t stop it. Try again.')
  })

  it('pages on with the cursor, and a refresh after a new one keeps every row it had on screen', async () => {
    const older = (i: number) => row({ sessionId: `c${i}`, state: 'done', canStop: false })
    wire.server = Array.from({ length: SUBSESSIONS_PAGE + 1 }, (_, i) => older(SUBSESSIONS_PAGE + 1 - i))
    await render()
    expect(rows()).toHaveLength(SUBSESSIONS_PAGE)
    await click(buttons('Show more')[0])
    expect(wire.calls.at(-1)).toEqual({
      agentId: 'agent-a',
      opts: { parentSessionId: 'session-1', cursor: String(SUBSESSIONS_PAGE), limit: SUBSESSIONS_PAGE }
    })
    expect(rows()).toHaveLength(SUBSESSIONS_PAGE + 1)
    expect(buttons('Show more')).toHaveLength(0)

    // A new sub-session lands on top: the refresh reads as far as the reader had loaded, so the oldest stays.
    wire.server = [older(99), ...wire.server]
    await rerender({ refreshTick: 1 })
    const links = Array.from(container?.querySelectorAll('a') ?? []).map((a) => a.getAttribute('href'))
    expect(links).toHaveLength(SUBSESSIONS_PAGE + 1)
    expect(links[0]).toBe('/acme/sessions/c99')
    expect(links.at(-1)).toBe('/acme/sessions/c2')
    expect(buttons('Show more')).toHaveLength(1)
  })

  it('refreshes a row loaded by "Show more", so one that ended or was stopped stops reading Running', async () => {
    const done = (i: number) => row({ sessionId: `c${i}`, state: 'done', canStop: false })
    // 20 settled ones, then an older one still running past the first page.
    wire.server = [
      ...Array.from({ length: SUBSESSIONS_PAGE }, (_, i) => done(SUBSESSIONS_PAGE + 1 - i)),
      row({ sessionId: 'c1' })
    ]
    await render()
    expect(last()).toMatchObject({ count: SUBSESSIONS_PAGE, running: 0 })
    await click(buttons('Show more')[0])
    expect(rows().at(-1)?.dataset.subsessionRow).toBe('open')
    expect(buttons('Stop')).toHaveLength(1)
    expect(last()).toMatchObject({ count: SUBSESSIONS_PAGE + 1, running: 1 })

    // Stopped here: the read that follows the stop reaches it, and it reads as the daemon reports it.
    wire.server[SUBSESSIONS_PAGE] = { ...wire.server[SUBSESSIONS_PAGE]!, state: 'failed', canStop: false }
    await click(buttons('Stop')[0])
    expect(wire.stops).toEqual([{ agentId: 'agent-a', sessionId: 'c1' }])
    expect(rows().at(-1)?.dataset.subsessionRow).toBe('failed')
    expect(rows().at(-1)?.querySelector('[data-subsession-state]')?.textContent).toBe('Failed')
    expect(buttons('Stop')).toHaveLength(0)
    expect(last()).toMatchObject({ count: SUBSESSIONS_PAGE + 1, running: 0 })

    // One that finishes on its own is caught by the next refresh too.
    wire.server[SUBSESSIONS_PAGE] = { ...wire.server[SUBSESSIONS_PAGE]!, state: 'open', canStop: true }
    await rerender({ refreshTick: 1 })
    expect(last()).toMatchObject({ running: 1 })
    wire.server[SUBSESSIONS_PAGE] = { ...wire.server[SUBSESSIONS_PAGE]!, state: 'done', canStop: false }
    await rerender({ refreshTick: 2 })
    expect(rows().at(-1)?.querySelector('[data-subsession-state]')?.textContent).toBe('Reported')
    expect(buttons('Stop')).toHaveLength(0)
    expect(last()).toMatchObject({ count: SUBSESSIONS_PAGE + 1, running: 0 })
    // One request covers the 21 rows on screen, within the route's page cap.
    expect(wire.calls.at(-1)?.opts).toEqual({ parentSessionId: 'session-1', limit: SUBSESSIONS_PAGE + 1 })
  })

  it('reports an empty conversation as nothing to show, so its tab stays out of the strip', async () => {
    await render()
    expect(last()).toEqual({ settled: true, count: 0, running: 0, failed: false })
    expect(subsessionsTabShown(last()!)).toBe(false)
    // Reported on the edge: a re-render with the same rows says nothing new.
    const heard = verdicts.length
    await rerender()
    expect(verdicts).toHaveLength(heard)
  })

  it('says a daemon too old for the list should be upgraded, and keeps its tab to say so', async () => {
    wire.failure = { status: 409, code: 'DAEMON_FEATURE_MISSING' }
    await render()
    expect(text()).toContain('Upgrade this agent’s daemon to see its sub-sessions here.')
    expect(last()).toEqual({ settled: true, count: 0, running: 0, failed: true })
    expect(subsessionsTabShown(last()!)).toBe(true)
  })

  it('keeps the rows it showed when a later read fails', async () => {
    wire.pages = [page([row()])]
    await render()
    wire.failure = { status: 503, code: 'DAEMON_OFFLINE' }
    await rerender({ refreshTick: 1 })
    expect(rows()).toHaveLength(1)
    expect(text()).toContain('Sub-sessions are unavailable right now.')
    expect(last()).toEqual({ settled: true, count: 1, running: 1, failed: false })
  })

  it('starts over for another conversation, never showing the previous one’s rows', async () => {
    wire.pages = [page([row()])]
    await render()
    wire.pages = [page([])]
    await rerender({ sessionId: 'session-2' })
    expect(wire.calls.at(-1)?.opts.parentSessionId).toBe('session-2')
    expect(rows()).toHaveLength(0)
    expect(last()).toMatchObject({ settled: true, count: 0 })
  })
})
