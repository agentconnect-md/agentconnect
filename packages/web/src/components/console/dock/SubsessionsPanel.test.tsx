// @vitest-environment happy-dom

// The Tasks tab's Delegated group: it lists only the delegated tasks, follow-ups and approved proposals of this conversation, links only those the reader may open, stops one (or ends a follow-up) through the console's stop route, pages on, and reports the verdict that puts its tab in the strip.

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
  followUpStops: [] as Array<{ agentId: string; followUpId: string; parentSessionId: string }>,
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
    }),
    stopAssistantFollowUp: vi.fn((agentId: string, followUpId: string, parentSessionId: string) => {
      wire.followUpStops.push({ agentId, followUpId, parentSessionId })
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
import type { AssistantFollowUpDto, AssistantFollowUpStatus, AssistantSubsessionDto } from '@/lib/api'

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

/** A follow-up row as a daemon with `follow-up-tasks-v1` lists it. */
function followUp(
  status: AssistantFollowUpStatus,
  overrides: Partial<AssistantSubsessionDto> = {},
  details: Partial<AssistantFollowUpDto> = {}
): AssistantSubsessionDto {
  return row({
    sessionId: `fu-${status}`,
    title: `Watch the ${status} release`,
    state: status === 'done' || status === 'stopped' ? 'done' : 'open',
    kind: 'follow-up',
    followUp: {
      status,
      nextCheck: status === 'waiting' ? '2026-10-16T09:00:00.000Z' : null,
      doneWhen: 'The release is published',
      recentChecks: [
        { at: '2026-10-15T09:00:00.000Z', observation: 'The tag exists; the release is a draft.', reported: true },
        { at: '2026-10-14T09:00:00.000Z', observation: 'No tag yet.', reported: false }
      ],
      ...details
    },
    ...overrides
  })
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
  Array.from(container?.querySelectorAll<HTMLButtonElement>('.dsbtn') ?? []).filter((b) => b.textContent === label)
// A row's Stop or End: one icon button, named by its label.
const actions = (label: string) =>
  Array.from(
    container?.querySelectorAll<HTMLButtonElement>(`[data-subsession-row] button[aria-label="${label}"]`) ?? []
  )
const stateOf = (el: Element | undefined) => el?.querySelector('[data-state-icon]')?.getAttribute('aria-label')
const last = () => verdicts.at(-1)
const rowOf = (sessionId: string) =>
  rows().find((r) => r.querySelector(`a[href="/acme/sessions/${sessionId}"]`) !== null)
const headings = () =>
  Array.from(container?.querySelectorAll('section[data-task-group] > button:not([data-fold-toggle])') ?? []).map(
    (h) => h.textContent
  )
const folds = () => Array.from(container?.querySelectorAll<HTMLButtonElement>('[data-fold-toggle]') ?? [])
// Opens every group's fold, so its finished rows are drawn too.
async function unfold() {
  for (const fold of folds()) if (fold.getAttribute('aria-expanded') === 'false') await click(fold)
}
const followUpRows = () =>
  Array.from(container?.querySelectorAll<HTMLElement>('[data-task-group="follow-ups"] [data-subsession-row]') ?? [])

beforeEach(() => {
  wire.pages = [page([])]
  wire.server = null
  wire.failure = null
  wire.calls = []
  wire.stops = []
  wire.followUpStops = []
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
  it('reads only this conversation’s tasks and draws each one’s state and latest word', async () => {
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
    // The finished ones wait behind the group's fold.
    expect(rows().map((r) => r.dataset.subsessionRow)).toEqual(['open'])
    expect(folds()[0]?.textContent).toBe('2 more')
    await unfold()
    expect(rows().map((r) => r.dataset.subsessionRow)).toEqual(['open', 'done', 'failed'])
    expect(rows().map(stateOf)).toEqual(['Running', 'Reported', 'Failed'])
    expect(text()).toContain('Untitled task')
    expect(rows()[0]?.querySelector('span[title^="Last update"]')?.textContent).toMatch(/ago$/)
    expect(last()).toEqual({ settled: true, count: 3, running: 1, finished: 2, failed: false })
  })

  it('keeps "Show more" reachable when the first page holds only open rows', async () => {
    const open = (i: number) => row({ sessionId: `o${i}` })
    wire.server = Array.from({ length: SUBSESSIONS_PAGE + 1 }, (_, i) => open(SUBSESSIONS_PAGE + 1 - i))
    await render()
    expect(last()).toMatchObject({ finished: 0 })
    await click(buttons('Show more')[0])
    expect(rows()).toHaveLength(SUBSESSIONS_PAGE + 1)
    expect(buttons('Show more')).toHaveLength(0)
  })

  it('draws only open rows by default, and the finished ones behind the group’s fold', async () => {
    wire.pages = [page([row({ sessionId: 'child-2', state: 'done', canStop: false }), row()])]
    await render()
    expect(rows().map((r) => r.dataset.subsessionRow)).toEqual(['open'])
    expect(headings()).toEqual(['Tasks'])
    expect(last()).toEqual({ settled: true, count: 2, running: 1, finished: 1, failed: false })
    await click(folds()[0])
    expect(rows().map((r) => r.dataset.subsessionRow)).toEqual(['open', 'done'])
    expect(folds()[0]?.textContent).toBe('Show less')
    await click(folds()[0])
    expect(rows().map((r) => r.dataset.subsessionRow)).toEqual(['open'])
  })

  it('folds a group past five open rows, unless more than that are running', async () => {
    const waiting = (i: number) => followUp('waiting', { sessionId: `fu-${i}` })
    wire.pages = [page(Array.from({ length: 7 }, (_, i) => waiting(i)))]
    await render()
    expect(followUpRows()).toHaveLength(5)
    expect(folds()[0]?.textContent).toBe('2 more')
    await click(folds()[0])
    expect(followUpRows()).toHaveLength(7)

    await act(async () => root?.unmount())
    container?.remove()
    wire.pages = [page(Array.from({ length: 7 }, (_, i) => row({ sessionId: `run-${i}` })))]
    await render()
    expect(rows()).toHaveLength(7)
    expect(folds()).toHaveLength(0)
  })

  it('links a task only where the reader may open it', async () => {
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

  it('shows a task that failed before its session existed as failed, with no link or Stop', async () => {
    wire.pages = [page([row({ sessionId: null, title: 'Check repository', state: 'failed', canStop: false })])]
    await render()
    await unfold()
    expect(rows()[0]?.textContent).toContain('Check repository')
    expect(rows()[0]?.textContent).not.toContain('Starting…')
    expect(stateOf(rows()[0])).toBe('Failed')
    expect(rows()[0]?.querySelector('a')).toBeNull()
    expect(actions('Stop')).toHaveLength(0)
  })

  it('offers Stop only on a running task the reader may stop, and shows what the stop did', async () => {
    wire.pages = [
      page([
        row(),
        row({ sessionId: 'child-2', canStop: false }),
        row({ sessionId: 'child-3', state: 'done', canStop: true })
      ])
    ]
    await render()
    expect(actions('Stop')).toHaveLength(1)
    // Never display:none: a keyboard reaches it by focus and a touch screen always shows it.
    expect(actions('Stop')[0]!.className).not.toMatch(/(^|\s)hidden(\s|$)/)
    expect(actions('Stop')[0]!.className).toContain('pointer-fine:focus-visible:opacity-100')
    const reads = wire.calls.length
    await click(actions('Stop')[0])
    expect(wire.stops).toEqual([{ agentId: 'agent-a', sessionId: 'child-1' }])
    expect(container?.querySelector('[data-subsession-stop]')?.textContent).toBe('Stopped.')
    // The stop re-reads, so the row's own state follows.
    expect(wire.calls.length).toBe(reads + 1)

    // No turn in flight on a row that has not reported: a background task it started may still be running.
    wire.stopAnswer = { result: 'not_running' }
    await click(actions('Stop')[0])
    expect(container?.querySelector('[data-subsession-stop]')?.textContent).toBe(
      'No turn is running. A background process it started may still be running; it can’t be stopped from here, and it reports back when that process ends.'
    )
    expect(stateOf(rows()[0])).toBe('Running')

    wire.stopFailure = { status: 503, code: 'DAEMON_OFFLINE' }
    await click(actions('Stop')[0])
    expect(container?.querySelector('[data-subsession-stop]')?.textContent).toBe('Couldn’t stop it. Try again.')
  })

  it('says nothing was running when the task reported before the stop reached it', async () => {
    wire.pages = [page([row()]), page([row({ state: 'done' })])]
    wire.stopAnswer = { result: 'not_running' }
    await render()
    await click(actions('Stop')[0])
    // It reported, so it moved behind the fold, with what the stop found.
    await unfold()
    expect(rows()[0]?.getAttribute('data-subsession-row')).toBe('done')
    expect(container?.querySelector('[data-subsession-stop]')?.textContent).toBe('Nothing was running.')
  })

  it('pages on with the cursor, and a refresh after a new one keeps every row it had on screen', async () => {
    const older = (i: number) => row({ sessionId: `c${i}`, state: 'done', canStop: false })
    wire.server = Array.from({ length: SUBSESSIONS_PAGE + 1 }, (_, i) => older(SUBSESSIONS_PAGE + 1 - i))
    await render()
    expect(rows()).toHaveLength(0)
    await unfold()
    expect(rows()).toHaveLength(SUBSESSIONS_PAGE)
    await click(buttons('Show more')[0])
    expect(wire.calls.at(-1)).toEqual({
      agentId: 'agent-a',
      opts: { parentSessionId: 'session-1', cursor: String(SUBSESSIONS_PAGE), limit: SUBSESSIONS_PAGE }
    })
    expect(rows()).toHaveLength(SUBSESSIONS_PAGE + 1)
    expect(buttons('Show more')).toHaveLength(0)

    // A new task lands on top: the refresh reads as far as the reader had loaded, so the oldest stays.
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
    // An open row leads its group wherever its page put it, ahead of the fold.
    expect(rows()).toEqual([rowOf('c1')])
    await unfold()
    expect(rows()[0]).toBe(rowOf('c1'))
    expect(rowOf('c1')?.dataset.subsessionRow).toBe('open')
    expect(actions('Stop')).toHaveLength(1)
    expect(last()).toMatchObject({ count: SUBSESSIONS_PAGE + 1, running: 1 })

    // Stopped here: the read that follows the stop reaches it, and it reads as the daemon reports it.
    wire.server[SUBSESSIONS_PAGE] = { ...wire.server[SUBSESSIONS_PAGE]!, state: 'failed', canStop: false }
    await click(actions('Stop')[0])
    expect(wire.stops).toEqual([{ agentId: 'agent-a', sessionId: 'c1' }])
    expect(rowOf('c1')?.dataset.subsessionRow).toBe('failed')
    expect(stateOf(rowOf('c1'))).toBe('Failed')
    expect(actions('Stop')).toHaveLength(0)
    expect(last()).toMatchObject({ count: SUBSESSIONS_PAGE + 1, running: 0 })

    // One that finishes on its own is caught by the next refresh too.
    wire.server[SUBSESSIONS_PAGE] = { ...wire.server[SUBSESSIONS_PAGE]!, state: 'open', canStop: true }
    await rerender({ refreshTick: 1 })
    expect(last()).toMatchObject({ running: 1 })
    wire.server[SUBSESSIONS_PAGE] = { ...wire.server[SUBSESSIONS_PAGE]!, state: 'done', canStop: false }
    await rerender({ refreshTick: 2 })
    expect(stateOf(rowOf('c1'))).toBe('Reported')
    expect(actions('Stop')).toHaveLength(0)
    expect(last()).toMatchObject({ count: SUBSESSIONS_PAGE + 1, running: 0 })
    // One request covers the 21 rows on screen, within the route's page cap.
    expect(wire.calls.at(-1)?.opts).toEqual({ parentSessionId: 'session-1', limit: SUBSESSIONS_PAGE + 1 })
  })

  it('reports an empty conversation as nothing to show, so its group stays out of the tab', async () => {
    await render()
    expect(last()).toEqual({ settled: true, count: 0, running: 0, finished: 0, failed: false })
    expect(subsessionsTabShown(last()!)).toBe(false)
    // Reported on the edge: a re-render with the same rows says nothing new.
    const heard = verdicts.length
    await rerender()
    expect(verdicts).toHaveLength(heard)
  })

  it('says a daemon too old for the list should be upgraded, and keeps its group to say so', async () => {
    wire.failure = { status: 409, code: 'DAEMON_FEATURE_MISSING' }
    await render()
    expect(text()).toContain('Upgrade this agent’s daemon to see its tasks and follow-ups here.')
    expect(last()).toEqual({ settled: true, count: 0, running: 0, finished: 0, failed: true })
    expect(subsessionsTabShown(last()!)).toBe(true)
  })

  it('keeps the rows it showed when a later read fails', async () => {
    wire.pages = [page([row()])]
    await render()
    wire.failure = { status: 503, code: 'DAEMON_OFFLINE' }
    await rerender({ refreshTick: 1 })
    expect(rows()).toHaveLength(1)
    expect(text()).toContain('Tasks and follow-ups are unavailable right now.')
    expect(last()).toEqual({ settled: true, count: 1, running: 1, finished: 0, failed: false })
  })

  // auto-session-mode.md §6.9.5: a getting-to-know task is stored as a follow-up but follows nothing, so it is listed among Tasks.
  it('lists a getting-to-know task among the tasks, by its title', async () => {
    wire.pages = [
      page([
        followUp('waiting', { title: 'The release channel' }, { gettingToKnow: true, nextCheck: null }),
        followUp('waiting', { sessionId: 'fu-1', title: 'The 2.6 release date' })
      ])
    ]
    await render()
    expect(headings()).toEqual(['Tasks', 'Follow-ups'])
    const titled = (title: string) => rows().find((r) => r.textContent?.includes(title))
    const groupOf = (title: string) => titled(title)?.closest('[data-task-group]')?.getAttribute('data-task-group')
    expect(groupOf('The release channel')).toBe('tasks')
    expect(groupOf('The 2.6 release date')).toBe('follow-ups')
    expect(stateOf(titled('The release channel'))).toBe('Waiting')
    // Until its introduction posts it has no thread to show: no mark, and it opens its page.
    expect(titled('The release channel')?.querySelector('[data-task-home]')).toBeNull()
  })

  // auto-session-mode.md §6.9.2: once its introduction has posted, the row opens that thread and wears the mark.
  it('opens a getting-to-know task’s row on the thread its introduction is in', async () => {
    wire.pages = [
      page([
        followUp(
          'done',
          { sessionId: 'look-1', title: 'The release channel', shownThreadId: '1700000400.000001' },
          { gettingToKnow: true, nextCheck: null }
        )
      ])
    ]
    const opened: string[] = []
    await render({ onOpenRoot: (rootId) => opened.push(rootId) })
    await unfold()
    const line = rows().find((r) => r.textContent?.includes('The release channel'))!
    expect(line.querySelector('[data-task-home]')?.getAttribute('data-task-home')).toBe('slack')
    await click(line.querySelector('[data-task-open-thread]'))
    expect(opened).toEqual(['1700000400.000001'])
  })

  it('draws a follow-up in each state, and counts only a check as running', async () => {
    wire.pages = [
      page([
        followUp('waiting'),
        followUp('checking'),
        followUp('paused'),
        followUp('done', { canStop: false }),
        followUp('stopped', { canStop: false }),
        row({ sessionId: 'child-9', state: 'done', canStop: false, kind: 'delegated' })
      ])
    ]
    await render()
    // A check leads; the ended ones wait behind the fold.
    expect(followUpRows().map((r) => r.dataset.followUp)).toEqual(['checking', 'waiting', 'paused'])
    await unfold()
    expect(followUpRows().map((r) => r.dataset.followUp)).toEqual(['checking', 'waiting', 'paused', 'done', 'stopped'])
    expect(followUpRows().map(stateOf)).toEqual(['Checking', 'Waiting', 'Paused', 'Done', 'Stopped'])
    // A follow-up's hover reads the same over its name and its time: its name, its next check or state, and what counts as done.
    const tips = (r: HTMLElement | undefined) =>
      [...(r?.querySelectorAll('[title^="Watch"]') ?? [])].map((el) => el.getAttribute('title'))
    const waitingTip = 'Watch the waiting release\nNext check Oct 16, 9:00 AM\nThe release is published'
    expect(tips(followUpRows()[1])).toContain(waitingTip)
    expect(tips(followUpRows()[2])).toContain('Watch the paused release\nPaused\nThe release is published')
    expect(followUpRows()[1]?.querySelector('[data-state-icon]')?.getAttribute('data-state-icon')).toBe('waiting')
    expect(followUpRows()[0]?.querySelector('[data-state-icon]')?.getAttribute('data-state-icon')).toBe('running')
    expect(followUpRows()[1]?.querySelector('a')?.getAttribute('href')).toBe('/acme/sessions/fu-waiting')
    expect(headings()).toEqual(['Tasks', 'Follow-ups'])
    // Weeks of waiting are not a running task for the tab's badge or the poll.
    expect(last()).toEqual({ settled: true, count: 6, running: 1, finished: 3, failed: false })
    // Every open follow-up the reader may stop can be ended; an ended one cannot.
    expect(actions('End')).toHaveLength(3)
    expect(actions('Stop')).toHaveLength(0)
  })

  it('names a follow-up the reader may not open by its label, and one they may not see as hidden', async () => {
    wire.pages = [
      page([
        followUp(
          'paused',
          { sessionId: null, title: null, visible: false, canStop: false, parent: null },
          { doneWhen: null, recentChecks: [] }
        ),
        followUp('checking', { sessionId: null }, { doneWhen: null, recentChecks: [] })
      ])
    ]
    await render()
    const hidden = followUpRows().find((r) => r.dataset.followUp === 'paused')
    const unopened = followUpRows().find((r) => r.dataset.followUp === 'checking')
    expect(hidden?.textContent).toContain('Not visible to you')
    // Visible but not yet openable: its label, never "Starting…".
    expect(unopened?.textContent).toContain('Watch the checking release')
    expect(unopened?.querySelector('a')).toBeNull()
  })

  it('ends a follow-up only after a confirmation, and says it ended', async () => {
    wire.pages = [page([followUp('waiting')]), page([followUp('stopped', { sessionId: 'fu-waiting', canStop: false })])]
    await render()
    await click(actions('End')[0])
    expect(wire.stops).toEqual([])
    const confirm = container?.querySelector('[role="group"]')
    expect(confirm?.textContent).toContain('End this follow-up? The agent stops checking.')
    await click(Array.from(confirm?.querySelectorAll('button') ?? []).find((b) => b.textContent === 'Keep'))
    expect(container?.querySelector('[role="group"]')).toBeNull()
    expect(wire.stops).toEqual([])

    await click(actions('End')[0])
    await click(container?.querySelector('[role="group"]')?.querySelector('button'))
    expect(wire.stops).toEqual([{ agentId: 'agent-a', sessionId: 'fu-waiting' }])
    expect(container?.querySelector('[role="group"]')).toBeNull()
    // Ended, it waits behind the fold with what the End did.
    await unfold()
    expect(container?.querySelector('[data-subsession-stop]')?.textContent).toBe('Follow-up ended.')
    expect(stateOf(rows()[0])).toBe('Stopped')
    expect(actions('End')).toHaveLength(0)
  })

  it.each([
    [{ result: 'not_running' }, null, 'It had already ended.'],
    [null, { status: 503, code: 'DAEMON_OFFLINE' }, 'Couldn’t end it. Try again.']
  ])('says when a follow-up had already ended or could not be ended', async (answer, failure, notice) => {
    wire.pages = [page([followUp('paused')])]
    if (answer) wire.stopAnswer = answer
    wire.stopFailure = failure
    await render()
    await click(actions('End')[0])
    await click(container?.querySelector('[role="group"]')?.querySelector('button'))
    expect(container?.querySelector('[data-subsession-stop]')?.textContent).toBe(notice)
  })

  it('ends a follow-up whose first check has not run by its own id, under this conversation', async () => {
    const unchecked = (status: AssistantFollowUpStatus, id?: string) =>
      followUp(status, { sessionId: null, canStop: status === 'waiting' }, id ? { id } : {})
    wire.pages = [page([unchecked('waiting', 'item-1'), unchecked('waiting')]), page([unchecked('stopped', 'item-1')])]
    await render()
    // Without an id from its daemon, a follow-up with no session has nothing to end it by.
    expect(actions('End')).toHaveLength(1)
    // It has no page to open yet, so its hover is where its next check and what counts as done are read.
    expect(followUpRows()[0]?.querySelector('span[title^="Watch"]')?.getAttribute('title')).toBe(
      'Watch the waiting release\nNext check Oct 16, 9:00 AM\nThe release is published'
    )
    await click(actions('End')[0])
    await click(container?.querySelector('[role="group"]')?.querySelector('button'))
    expect(wire.followUpStops).toEqual([{ agentId: 'agent-a', followUpId: 'item-1', parentSessionId: 'session-1' }])
    expect(wire.stops).toEqual([])
    await unfold()
    expect(container?.querySelector('[data-subsession-stop]')?.textContent).toBe('Follow-up ended.')
    expect(stateOf(rows()[0])).toBe('Stopped')
  })

  // auto-session-mode.md §6.9.5: one Tasks group, and a task with a thread wears its platform's mark.
  it('lists tasks with and without a thread in one group, one line each, marking the ones with a thread', async () => {
    wire.pages = [
      page([
        row({
          sessionId: 'threaded-1',
          title: 'Webhook retries',
          state: 'done',
          threaded: true,
          summary: 'Scope: webhook retries. Status: waiting on review.',
          summaryUpdatedAt: '2026-10-09T09:30:00.000Z'
        }),
        row({ sessionId: 'background-1', title: 'Check the flaky test', background: 'why does the e2e suite flake?' }),
        row({ sessionId: 'background-2', title: 'Old task', state: 'done' })
      ])
    ]
    await render()
    expect(headings()).toEqual(['Tasks'])
    const threaded = rowOf('threaded-1')!
    expect(threaded.closest('[data-task-group]')?.getAttribute('data-task-group')).toBe('tasks')
    expect(threaded.querySelector('[data-task-home]')?.getAttribute('data-task-home')).toBe('slack')
    expect(rowOf('background-1')!.querySelector('[data-task-home]')).toBeNull()
    // A threaded task lives on between its turns: idle, never behind the fold.
    expect(stateOf(threaded)).toBe('Idle')
    expect(threaded.querySelector('[data-state-icon]')?.getAttribute('data-state-icon')).toBe('idle')
    // One line: the summary and the opening message stay on the task's own page.
    expect(text()).not.toContain('Scope: webhook retries')
    expect(text()).not.toContain('why does the e2e suite flake?')
    expect(rowOf('background-2')).toBeUndefined()
    expect(last()).toMatchObject({ count: 3, running: 1, finished: 1 })
  })

  it('shows no summary of a task the reader may not see', async () => {
    wire.pages = [page([row({ sessionId: null, visible: false, title: null, background: 'not for this reader' })])]
    await render()
    expect(headings()).toEqual(['Tasks'])
    expect(text()).not.toContain('not for this reader')
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
