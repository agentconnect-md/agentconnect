// @vitest-environment happy-dom

// The dock's PR panel: the verdict vocabulary it reports to its tab (linked / none / failed, and why `empty` is never one of them), the 404 that hides the tab and is asked exactly ONCE per session, the degraded answers that still name their PR, and the M5 absences — no Auto-fix and no merge control, which are M6's write loop and must be absent rather than disabled.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const wire = vi.hoisted(() => ({
  data: null as unknown,
  failure: null as null | { status: number },
  calls: [] as Array<{ sessionId: string; refresh: boolean }>,
  // Set to hand back a promise the test resolves by hand, so the panel is observable WHILE a read is in flight.
  hold: null as null | (() => Promise<unknown>)
}))

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number
    ) {
      super(message)
      this.name = 'ApiError'
    }
  }
  return {
    ApiError,
    fetchSessionPullRequest: vi.fn((sessionId: string, opts: { refresh?: boolean } = {}) => {
      wire.calls.push({ sessionId, refresh: opts.refresh === true })
      if (wire.failure) return Promise.reject(new ApiError('nope', wire.failure.status))
      if (wire.hold) return wire.hold()
      return Promise.resolve(wire.data)
    })
  }
})

import {
  PullRequestPanel,
  formatCheckDuration,
  pullRequestPillKey,
  pullRequestTabStatus,
  type PullRequestPanelVerdict
} from './PullRequestPanel'
import type { SessionPullRequestDto } from '@/lib/api'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let container: HTMLDivElement | undefined
let root: ReturnType<typeof createRoot> | undefined
let verdicts: PullRequestPanelVerdict[] = []

function pr(overrides: Partial<SessionPullRequestDto> = {}): SessionPullRequestDto {
  return {
    repoFullName: 'acme/api',
    pullNumber: 57,
    title: 'Ship the dock',
    state: 'open',
    isDraft: false,
    url: 'https://github.com/acme/api/pull/57',
    headRef: 'feat/dock',
    baseRef: 'main',
    additions: 120,
    deletions: 30,
    reviewDecision: 'changes_requested',
    checks: [
      {
        name: 'ci/build',
        state: 'success',
        detail: 'success',
        startedAt: '2026-08-11T10:00:00.000Z',
        completedAt: '2026-08-11T10:02:14.000Z',
        url: null
      },
      { name: 'ci/lint', state: 'pending', detail: 'in_progress', startedAt: null, completedAt: null, url: null }
    ],
    checksTruncated: false,
    reviews: [
      { author: 'sam', state: 'changes_requested', isBot: false },
      { author: 'review-bot', state: 'commented', isBot: true }
    ],
    threads: [
      { location: 'src/dock.ts:12', body: 'This cache key needs the org.', author: 'sam', isOutdated: false },
      { location: 'src/dock.ts:40', body: 'Stale comment on old lines.', author: 'sam', isOutdated: true }
    ],
    unresolvedCount: 2,
    threadsTruncated: false,
    degraded: false,
    degradedReason: null,
    agentReview: null,
    ...overrides
  }
}

// The degraded arm as the CP builds it: identity + stored facts survive, every live list is empty.
function degradedPr(reason: 'rate_limited' | 'denied' | 'unreachable'): SessionPullRequestDto {
  return pr({
    state: 'closed',
    isDraft: null,
    additions: null,
    deletions: null,
    reviewDecision: null,
    checks: [],
    reviews: [],
    threads: [],
    unresolvedCount: 0,
    degraded: true,
    degradedReason: reason
  })
}

type PanelProps = Parameters<typeof PullRequestPanel>[0]

function panel(props: Partial<PanelProps> = {}) {
  return <PullRequestPanel sessionId="session-1" onVerdictChange={(verdict) => verdicts.push(verdict)} {...props} />
}

async function render(props: Partial<PanelProps> = {}) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(panel(props))
    await Promise.resolve()
  })
}

async function rerender(props: Partial<PanelProps> = {}) {
  await act(async () => {
    root?.render(panel(props))
    await Promise.resolve()
  })
}

async function press(selector: string) {
  await act(async () => {
    container?.querySelector<HTMLElement>(selector)?.click()
    await Promise.resolve()
  })
}

const text = () => container?.textContent ?? ''
const last = () => verdicts.at(-1)

beforeEach(() => {
  wire.data = pr()
  wire.failure = null
  wire.calls = []
  wire.hold = null
  verdicts = []
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  container = undefined
  root = undefined
  vi.restoreAllMocks()
})

describe('pullRequestTabStatus', () => {
  it('is loading until the probe answers, and never empty', () => {
    // Never `empty`: a 200 always has identity to draw, `none` takes the tab out of the strip entirely, and a failed probe has copy — so no state is left for the dock's centred "Nothing to show".
    expect(pullRequestTabStatus('pending')).toBe('loading')
    expect(pullRequestTabStatus('linked')).toBe('ready')
    expect(pullRequestTabStatus('failed')).toBe('ready')
    expect(pullRequestTabStatus('none')).toBe('ready')
  })
})

describe('pullRequestPillKey', () => {
  it('lets draft outrank open, and reads a missing state as unknown rather than open', () => {
    expect(pullRequestPillKey('open', false)).toBe('open')
    expect(pullRequestPillKey('open', true)).toBe('draft')
    expect(pullRequestPillKey('merged', false)).toBe('merged')
    expect(pullRequestPillKey('closed', null)).toBe('closed')
    // The degraded arm with no stored fact: `open` here would be an invented claim about a PR nobody read.
    expect(pullRequestPillKey(null, null)).toBe('unknown')
  })
})

describe('formatCheckDuration', () => {
  it('reads seconds, then minutes-and-seconds, then hours-and-minutes', () => {
    expect(formatCheckDuration('2026-08-11T10:00:00.000Z', '2026-08-11T10:00:41.000Z')).toBe('41s')
    expect(formatCheckDuration('2026-08-11T10:00:00.000Z', '2026-08-11T10:02:14.000Z')).toBe('2m 14s')
    expect(formatCheckDuration('2026-08-11T10:00:00.000Z', '2026-08-11T11:04:00.000Z')).toBe('1h 04m')
  })

  it('says nothing when either end is missing, out of order, or unparseable', () => {
    // "Duration where present" — a pending check has no completion and gets no invented number.
    expect(formatCheckDuration(null, '2026-08-11T10:00:00.000Z')).toBe('')
    expect(formatCheckDuration('2026-08-11T10:00:00.000Z', null)).toBe('')
    expect(formatCheckDuration('2026-08-11T10:00:10.000Z', '2026-08-11T10:00:00.000Z')).toBe('')
    expect(formatCheckDuration('not a date', '2026-08-11T10:00:00.000Z')).toBe('')
  })
})

describe('PullRequestPanel verdicts', () => {
  it('reads by session, reports linked with the badge count and the URL, and only re-reports on the edge', async () => {
    await render()
    expect(wire.calls).toEqual([{ sessionId: 'session-1', refresh: false }])
    expect(last()).toEqual({ answer: 'linked', unresolved: 2, url: 'https://github.com/acme/api/pull/57' })
    const heard = verdicts.length
    await rerender()
    await rerender()
    expect(verdicts).toHaveLength(heard)
  })

  it('reports a 404 as none, renders nothing, and NEVER asks again for that session', async () => {
    // The linkage cannot appear later — the run is what created the session — so re-polling a 404 would spend reads on an answer that is already final (the M4 follow-up this panel must not repeat).
    wire.failure = { status: 404 }
    await render()
    expect(last()).toEqual({ answer: 'none', unresolved: null, url: null })
    expect(container?.querySelector('[data-pr-panel]')).toBeNull()

    await rerender()
    await rerender()
    expect(wire.calls).toHaveLength(1)
  })

  it('reports a non-404 failure as failed — not none — so the tab stays up and says why', async () => {
    // Hiding here would claim "no PR" on a fact nobody could read; the failed panel keeps the tab and its copy.
    wire.failure = { status: 503 }
    await render()
    expect(last()).toEqual({ answer: 'failed', unresolved: null, url: null })
    expect(container?.querySelector('[data-pr-panel="failed"]')).not.toBeNull()
    expect(text()).toContain('Couldn’t read this session’s pull request')
  })

  it('retries a failed probe from its own refresh control, bypassing the CP cache', async () => {
    wire.failure = { status: 503 }
    await render()
    wire.failure = null
    await press('[data-pr-refresh]')
    expect(wire.calls).toEqual([
      { sessionId: 'session-1', refresh: false },
      { sessionId: 'session-1', refresh: true }
    ])
    expect(last()).toEqual({ answer: 'linked', unresolved: 2, url: 'https://github.com/acme/api/pull/57' })
  })

  it('withholds the badge while degraded, where the thread count is unknown rather than zero', async () => {
    wire.data = degradedPr('rate_limited')
    await render()
    expect(last()).toEqual({ answer: 'linked', unresolved: null, url: 'https://github.com/acme/api/pull/57' })
  })

  it('holds answers PER SCOPE: a session switch reads as pending, never as the previous session’s PR', async () => {
    // Constructs the switch WINDOW itself (the M3 bug class): the new scope's read is held open, so serving the old scope's answer would leave its PR on screen and its count on the new tab's badge.
    await render()
    expect(text()).toContain('Ship the dock')

    let release: ((value: unknown) => void) | undefined
    wire.hold = () => new Promise((resolve) => (release = resolve))
    await rerender({ sessionId: 'session-2' })
    expect(wire.calls.at(-1)).toEqual({ sessionId: 'session-2', refresh: false })
    expect(container?.querySelector('[data-pr-panel]')).toBeNull()
    expect(last()).toEqual({ answer: 'pending', unresolved: null, url: null })

    await act(async () => {
      release?.(pr({ title: 'The other session’s PR', pullNumber: 99, unresolvedCount: 1 }))
      await Promise.resolve()
    })
    expect(text()).toContain('The other session’s PR')
    expect(last()?.unresolved).toBe(1)
  })

  it('re-reads on the edge where the reader opens the tab, not per render', async () => {
    // The panel is mounted from the moment the session page opens; a tab opened ten minutes later must not draw a ten-minute-old PR until someone presses refresh.
    await render({ active: false })
    expect(wire.calls).toHaveLength(1)
    await rerender({ active: true })
    expect(wire.calls).toHaveLength(2)
    // A plain re-read rides the CP's cache; only the explicit press bypasses it.
    expect(wire.calls[1]).toEqual({ sessionId: 'session-1', refresh: false })
    await rerender({ active: true })
    expect(wire.calls).toHaveLength(2)
  })
})

describe('PullRequestPanel body', () => {
  it('draws the identity header: state pill, number, repo, title, head→base, +/− and the GitHub link', async () => {
    await render()
    expect(container?.querySelector('[data-pr-state="open"]')?.textContent).toBe('Open')
    expect(text()).toContain('#57')
    expect(text()).toContain('acme/api')
    expect(text()).toContain('Ship the dock')
    expect(text()).toContain('feat/dock')
    expect(text()).toContain('main')
    expect(text()).toContain('+120')
    expect(text()).toContain('−30')
    const link = container?.querySelector<HTMLAnchorElement>('[data-pr-link]')
    expect(link?.href).toBe('https://github.com/acme/api/pull/57')
    expect(link?.textContent).toContain('View on GitHub')
  })

  it('draws each check with its own state marker and a duration only where both ends exist', async () => {
    await render()
    const checks = Array.from(container?.querySelectorAll<HTMLElement>('[data-pr-check]') ?? [])
    expect(checks.map((row) => row.dataset.prCheck)).toEqual(['success', 'pending'])
    expect(checks[0]?.textContent).toContain('ci/build')
    expect(checks[0]?.textContent).toContain('2m 14s')
    // The pending check reported no completion, so its row carries no number at all.
    expect(checks[1]?.textContent).toBe('ci/lint')
  })

  it('draws each reviewer’s current review with the bot marker, and the decision beside the section', async () => {
    await render()
    const reviews = Array.from(container?.querySelectorAll<HTMLElement>('[data-pr-review]') ?? [])
    expect(reviews.map((row) => row.dataset.prReview)).toEqual(['changes_requested', 'commented'])
    expect(reviews[0]?.textContent).toContain('sam')
    expect(reviews[1]?.textContent).toContain('bot')
    expect(container?.querySelector('[data-pr-decision="changes_requested"]')?.textContent).toBe('Changes requested')
  })

  it('draws unresolved threads with location, excerpt, author and the outdated mark, under their count', async () => {
    await render()
    const threads = Array.from(container?.querySelectorAll<HTMLElement>('[data-pr-thread]') ?? [])
    expect(threads).toHaveLength(2)
    expect(threads[0]?.textContent).toContain('src/dock.ts:12')
    expect(threads[0]?.textContent).toContain('This cache key needs the org.')
    expect(threads[0]?.textContent).toContain('sam')
    expect(threads[0]?.textContent).not.toContain('outdated')
    expect(threads[1]?.textContent).toContain('outdated')
    expect(container?.querySelector('[data-pr-section="threads"]')?.textContent).toContain('2')
  })

  it('marks a truncated thread count as a floor, because the wire carries a page and says so', async () => {
    wire.data = pr({ threadsTruncated: true, unresolvedCount: 2 })
    await render()
    expect(container?.querySelector('[data-pr-section="threads"]')?.textContent).toContain('2+')
    expect(text()).toContain('More unresolved threads than one read carries')
  })

  it('says which kind of nothing each empty section has', async () => {
    wire.data = pr({ checks: [], reviews: [], threads: [], unresolvedCount: 0, reviewDecision: null })
    await render()
    expect(text()).toContain('No checks reported')
    expect(text()).toContain('No reviews yet')
    expect(text()).toContain('No unresolved review threads')
  })

  it('offers NO Auto-fix, NO merge control and NO thread resolution — M6’s writes are absent, not disabled', async () => {
    // PREMISE (§9 M5): this panel is read-only. If M6 lands its Auto-fix button and Merge-when-ready checkbox, re-aim this assertion at the new controls — do not delete it.
    await render()
    // The refresh control is the ONLY button, and there is no checkbox for auto-merge to hide in.
    const buttons = Array.from(container?.querySelectorAll('button') ?? [])
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(['Refresh pull request'])
    expect(container?.querySelectorAll('input')).toHaveLength(0)
    expect(text().toLowerCase()).not.toContain('auto-fix')
    expect(text().toLowerCase()).not.toContain('merge when ready')
  })
})

describe('PullRequestPanel degraded answers', () => {
  it('still names the PR under rate limiting, with the stored state instead of a fabricated open', async () => {
    wire.data = degradedPr('rate_limited')
    await render()
    // Identity survives: repo, number, title and the link all render from what the CP already knew.
    expect(text()).toContain('#57')
    expect(text()).toContain('acme/api')
    expect(text()).toContain('Ship the dock')
    expect(container?.querySelector<HTMLAnchorElement>('[data-pr-link]')?.href).toBe(
      'https://github.com/acme/api/pull/57'
    )
    expect(container?.querySelector('[data-pr-state="closed"]')?.textContent).toBe('Closed')
    expect(text()).toContain('GitHub is rate limiting this deployment')
    // The live sections are withheld rather than drawn empty, which would read as "no checks ran".
    expect(container?.querySelector('[data-pr-section]')).toBeNull()
  })

  it('reads a missing stored state as unknown, and names the other two reasons', async () => {
    wire.data = { ...degradedPr('denied'), state: null }
    await render()
    expect(container?.querySelector('[data-pr-state="unknown"]')?.textContent).toBe('State unknown')
    expect(text()).toContain('GitHub denied this read')

    await act(async () => root?.unmount())
    container?.remove()
    wire.data = degradedPr('unreachable')
    await render()
    expect(text()).toContain('GitHub couldn’t be reached')
  })

  it('recovers through its refresh control, which bypasses the CP’s TTL for exactly that press', async () => {
    wire.data = degradedPr('rate_limited')
    await render()
    wire.data = pr()
    await press('[data-pr-refresh]')
    expect(wire.calls).toEqual([
      { sessionId: 'session-1', refresh: false },
      { sessionId: 'session-1', refresh: true }
    ])
    expect(container?.querySelector('[data-pr-section="checks"]')).not.toBeNull()
    expect(last()).toEqual({ answer: 'linked', unresolved: 2, url: 'https://github.com/acme/api/pull/57' })
  })

  it('keeps the previous answer on screen while a refresh is in flight, instead of strobing to pending', async () => {
    await render()
    let release: ((value: unknown) => void) | undefined
    wire.hold = () => new Promise((resolve) => (release = resolve))
    await press('[data-pr-refresh]')
    // Still the old answer, with the control itself marking the read in progress.
    expect(text()).toContain('Ship the dock')
    expect(container?.querySelector<HTMLButtonElement>('[data-pr-refresh]')?.disabled).toBe(true)
    await act(async () => {
      release?.(pr({ title: 'Fresh title' }))
      await Promise.resolve()
    })
    expect(text()).toContain('Fresh title')
    expect(container?.querySelector<HTMLButtonElement>('[data-pr-refresh]')?.disabled).toBe(false)
  })
  it('shows the agent recorded review on a degraded answer, and never beside GitHub own list', async () => {
    // Precedence is the service's — the panel just refuses to double-draw: the field is only ever
    // populated on degraded answers, and this pins that an answered view renders GitHub's list alone.
    wire.data = pr({ degraded: true, degradedReason: 'rate_limited', agentReview: 'changes_requested' })
    await render()
    expect(container?.querySelector('[data-pr-agent-review]')?.textContent).toContain('changes requested')

    wire.data = pr({ agentReview: null })
    await render()
    expect(container?.querySelector('[data-pr-agent-review]')).toBeNull()
  })
})
