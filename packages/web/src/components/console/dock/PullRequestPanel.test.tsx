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
  hold: null as null | (() => Promise<unknown>),
  // The auto-merge write seam: every POST recorded, failing with `mergeFailure` when set.
  mergeCalls: [] as Array<{ sessionId: string; enabled: boolean }>,
  mergeFailure: null as null | Error,
  // The direct merge seam: every call recorded, failing with `mergeNowFailure` when set.
  mergeNowCalls: [] as string[],
  mergeNowFailure: null as null | Error
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
    }),
    setSessionPullRequestAutoMerge: vi.fn((sessionId: string, enabled: boolean) => {
      wire.mergeCalls.push({ sessionId, enabled })
      if (wire.mergeFailure) return Promise.reject(wire.mergeFailure)
      return Promise.resolve({ armed: enabled, placement: enabled ? 'daemon' : null, waitingOn: null, error: null })
    }),
    mergeSessionPullRequest: vi.fn((sessionId: string) => {
      wire.mergeNowCalls.push(sessionId)
      if (wire.mergeNowFailure) return Promise.reject(wire.mergeNowFailure)
      return Promise.resolve({ merged: true })
    })
  }
})

import { PR_POLL_MS } from './auto-refresh'
import {
  PR_LINK_RETRY_LADDER_MS,
  PullRequestPanel,
  createPullRequestInstruction,
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
    body: 'Fixes the dock flicker and adds the PR panel.',
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
    autoMergeArmed: false,
    canArmAutoMerge: true,
    degraded: false,
    degradedReason: null,
    agentReview: null,
    ...overrides
  }
}

// The degraded arm as the CP builds it: identity + stored facts survive, every live list is empty.
function degradedPr(reason: 'rate_limited' | 'denied' | 'unreachable'): SessionPullRequestDto {
  return pr({
    body: '',
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

function accept(posted: string[]) {
  return (text: string) => {
    posted.push(text)
    return true
  }
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
  wire.mergeCalls = []
  wire.mergeFailure = null
  wire.mergeNowCalls = []
  wire.mergeNowFailure = null
  verdicts = []
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  container = undefined
  root = undefined
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('pullRequestTabStatus', () => {
  it('is loading until the probe answers, and never empty', () => {
    // Never `empty`: a 200 always has identity to draw, and `none` and a failed probe each have copy of their own — so no state is left for the dock's centred "Nothing to show".
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

describe('createPullRequestInstruction', () => {
  it('targets the workspace’s configured base branch, which is not always the repository default', async () => {
    const instruction = createPullRequestInstruction('dev/jane-doe/candid-lynx', null, 'release')
    expect(instruction).toContain('create one against release')
    // The default is what the review would have been opened against had this said nothing — and on a
    // workspace configured onto `release` that is the wrong base, carrying history this branch never added.
    expect(instruction).not.toContain('default branch')
  })

  it('has the agent derive the base rather than naming a default, when the read could not name one', async () => {
    // Null base is three cases at once (no configured branch, HEAD already on it, a base ref never fetched);
    // only the first makes the repository default right, so none of them gets told it is.
    const instruction = createPullRequestInstruction(
      'dev/jane-doe/candid-lynx',
      'origin/dev/jane-doe/candid-lynx',
      null
    )
    expect(instruction).toContain('the branch this worktree was created from')
    expect(instruction).toContain('the workspace’s configured branch')
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

  it('reports a 404 as none, draws the no-PR state, and NEVER asks again for that session', async () => {
    // The linkage cannot appear later — the run is what created the session — so re-polling a 404 would spend reads on an answer that is already final (the M4 follow-up this panel must not repeat).
    wire.failure = { status: 404 }
    await render()
    expect(last()).toEqual({ answer: 'none', unresolved: null, url: null })
    expect(container?.querySelector('[data-pr-panel="none"]')).not.toBeNull()

    await rerender()
    await rerender()
    expect(wire.calls).toHaveLength(1)
  })

  it('names the branch and its missing upstream in the no-PR state, and offers one turn that opens the pull request', async () => {
    wire.failure = { status: 404 }
    await render({ branch: 'dev/jane-doe/candid-lynx', tracking: null, onPostTurn: () => true })
    // The upstream is the FIRST obstacle, so it is the headline rather than the absent pull request.
    expect(text()).toContain('No upstream configured')
    expect(text()).toContain('Publish this branch to set its upstream before creating a pull request.')
    expect(text()).toContain('dev/jane-doe/candid-lynx')

    const posted: string[] = []
    await rerender({ branch: 'dev/jane-doe/candid-lynx', tracking: null, base: 'release', onPostTurn: accept(posted) })
    await press('[data-pr-create]')
    expect(posted).toHaveLength(1)
    expect(posted[0]).toContain('dev/jane-doe/candid-lynx')
    expect(posted[0]).toContain('git push -u')
    // The base comes from the same scoped git read as the branch: a workspace configured onto `release`
    // must not have its review opened against the repository's default.
    expect(posted[0]).toContain('against release')
  })

  it('stops presenting creation as fresh once asked, and says what the link still waits on', async () => {
    // The PR is found through this worktree's head branch, so it appears once the branch is pushed and a
    // pull request exists for it — not the instant the agent replies. Re-offering "Create pull request"
    // against that state is what invited a second PR for the same branch.
    wire.failure = { status: 404 }
    const posted: string[] = []
    await render({ branch: 'dev/jane-doe/candid-lynx', tracking: null, onPostTurn: accept(posted) })
    expect(container?.querySelector('[data-pr-create]')?.textContent).toContain('Create pull request')
    expect(container?.querySelector('[data-pr-create-requested]')).toBeNull()

    await press('[data-pr-create]')
    expect(posted).toHaveLength(1)
    // The instruction makes the retry safe where it CAN be checked — on the agent, not in this panel.
    expect(posted[0]).toContain('already has an open pull request')

    await rerender({ branch: 'dev/jane-doe/candid-lynx', tracking: null, onPostTurn: accept(posted) })
    expect(container?.querySelector('[data-pr-create-requested]')?.textContent).toContain(
      'links it once the branch is pushed and a pull request exists'
    )
    expect(container?.querySelector('[data-pr-create]')?.textContent).toContain('Ask again')
  })

  it('forgets the ask when the panel switches session — it is a fact about ONE session', async () => {
    wire.failure = { status: 404 }
    const posted: string[] = []
    await render({ branch: 'dev/jane-doe/candid-lynx', tracking: null, onPostTurn: accept(posted) })
    await press('[data-pr-create]')
    await rerender({ branch: 'dev/jane-doe/candid-lynx', tracking: null, onPostTurn: accept(posted) })
    expect(container?.querySelector('[data-pr-create-requested]')).not.toBeNull()

    await rerender({
      sessionId: 'session-2',
      branch: 'dev/sam/eager-heron',
      tracking: null,
      onPostTurn: accept(posted)
    })
    expect(container?.querySelector('[data-pr-create-requested]')).toBeNull()
    expect(container?.querySelector('[data-pr-create]')?.textContent).toContain('Create pull request')
  })

  it('says a published branch has no pull request yet, without claiming a missing upstream', async () => {
    wire.failure = { status: 404 }
    await render({ branch: 'dev/jane-doe/candid-lynx', tracking: 'origin/dev/jane-doe/candid-lynx' })
    expect(text()).toContain('No pull request')
    expect(text()).not.toContain('No upstream configured')
    expect(text()).toContain('origin/dev/jane-doe/candid-lynx')
    // No composer to post through ⇒ the action is ABSENT, not a button that would fail.
    expect(container?.querySelector('[data-pr-create]')).toBeNull()
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

  it('names the pick when a branch-resolved link is ambiguous, and stays silent when it is not', async () => {
    // A run-linked PR is unique by construction; a branch's is not — several open PRs on one head are all
    // equally "this session's", so the panel says which one it drew rather than picking silently.
    await render()
    expect(container?.querySelector('[data-pr-link-ambiguous]')).toBeNull()

    // A scope switch is what re-reads: the answer is held per session, so a new id is how the second
    // shape reaches the panel at all.
    wire.data = pr({ linkedBy: 'head-branch', linkBranch: 'dev/jane-doe/candid-lynx', linkAmbiguous: true })
    await rerender({ sessionId: 'session-2' })
    expect(container?.querySelector('[data-pr-link-ambiguous]')?.textContent).toContain(
      'Branch dev/jane-doe/candid-lynx has more than one open pull request'
    )
  })

  it('discloses when the PR came from the agent’s SHARED checkout, and stays silent for a session worktree', async () => {
    // The caveat is about whose work the PR may contain — most relevant beside the Merge button — not
    // which checkout answered, so it survives the description block rather than being folded into it.
    await render()
    expect(container?.querySelector('[data-pr-link-shared]')).toBeNull()

    wire.data = pr({ linkedBy: 'head-branch', linkBranch: 'main', linkScope: 'shared' })
    await rerender({ sessionId: 'session-2' })
    expect(container?.querySelector('[data-pr-link-shared]')?.textContent).toContain(
      'may carry work from other sessions'
    )
  })

  it('draws the PR description under its own section, and hides it when empty', async () => {
    // The body replaces the old "Found through …" shared-checkout note: the description is what the
    // reader came for, and which checkout resolved the link is an implementation detail.
    await render()
    expect(container?.querySelector('[data-pr-body]')?.textContent).toContain('Fixes the dock flicker')
    expect(text()).toContain('Description')

    wire.data = pr({ body: '' })
    await rerender({ sessionId: 'session-2' })
    expect(container?.querySelector('[data-pr-body]')).toBeNull()
  })

  it('clamps a long description and expands it in place', async () => {
    wire.data = pr({ body: 'A'.repeat(600) })
    await render()
    const toggle = () => container?.querySelector<HTMLButtonElement>('[data-pr-body-toggle]')
    expect(toggle()?.textContent).toContain('Show more')
    // Clamping is visual (max-height + overflow), so the full text is still in the DOM.
    expect(container?.querySelector('[data-pr-body]')?.textContent).toContain('A'.repeat(600))

    await press('[data-pr-body-toggle]')
    expect(toggle()?.textContent).toContain('Show less')
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

  it('gates M6’s writes: Auto-fix is ABSENT without a live composer, merge disabled below write tier or on a draft', async () => {
    // Re-aimed from M5's read-only premise (§9), as that test asked: the writes exist now, but each is
    // earned. No onPostTurn (a hook session with no composer) means NO button — absent, not disabled.
    await render()
    expect(container?.querySelector('[data-pr-autofix]')).toBeNull()
    // The write-capable fixture's merge controls are live; a read-tier caller's are disabled, not hidden —
    // the CP's canArmAutoMerge flag is exactly the "disabled control, not a failed call" contract.
    expect(container?.querySelector<HTMLInputElement>('[data-pr-automerge]')?.disabled).toBe(false)
    expect(container?.querySelector<HTMLButtonElement>('[data-pr-merge-arm]')?.disabled).toBe(false)

    wire.data = pr({ canArmAutoMerge: false })
    await render()
    expect(container?.querySelector<HTMLInputElement>('[data-pr-automerge]')?.disabled).toBe(true)
    expect(container?.querySelector<HTMLButtonElement>('[data-pr-merge-arm]')?.disabled).toBe(true)

    // A draft PR is not mergeable — the button stays disabled rather than learning "no" from GitHub.
    wire.data = pr({ isDraft: true })
    await render()
    expect(container?.querySelector<HTMLButtonElement>('[data-pr-merge-arm]')?.disabled).toBe(true)

    // No merge box at all where there is nothing to arm: closed/merged PRs and degraded answers.
    wire.data = pr({ state: 'merged' })
    await render()
    expect(container?.querySelector('[data-pr-merge]')).toBeNull()
    wire.data = degradedPr('rate_limited')
    await render()
    expect(container?.querySelector('[data-pr-merge]')).toBeNull()
  })

  it('Auto-fix posts ONE instruction carrying every unresolved thread, then re-reads once when the turn settles', async () => {
    // §5.2: one action over the whole set, a real webchat turn — and the panel's ONLY follow-up is a
    // single forced re-read on the turn's FALLING edge, where the agent's GitHub write-back landed.
    const posted: string[] = []
    await render({ onPostTurn: accept(posted), turnActive: false })
    expect(wire.calls).toHaveLength(1)

    await press('[data-pr-autofix]')
    expect(posted).toHaveLength(1)
    expect(posted[0]).toContain('#57')
    expect(posted[0]).toContain('src/dock.ts:12 — sam: This cache key needs the org.')
    expect(posted[0]).toContain('src/dock.ts:40')
    expect(posted[0]).toContain('resolve the threads')
    // Pressed = in flight: the button disables rather than double-posting the same set.
    expect(container?.querySelector<HTMLButtonElement>('[data-pr-autofix]')?.disabled).toBe(true)

    // The turn starts streaming, then settles: exactly one re-read, forced past the CP's TTL.
    await rerender({ onPostTurn: accept(posted), turnActive: true })
    expect(wire.calls).toHaveLength(1)
    wire.data = pr({ threads: [], unresolvedCount: 0 })
    await rerender({ onPostTurn: accept(posted), turnActive: false })
    expect(wire.calls).toHaveLength(2)
    expect(wire.calls[1]).toMatchObject({ refresh: true })
    // A LATER turn settling re-reads AGAIN, and forced: the edge belongs to the dock's refresh
    // cadence, not to `awaitingTurn` — whatever that turn did on GitHub is younger than the CP's TTL.
    await rerender({ onPostTurn: accept(posted), turnActive: true })
    await rerender({ onPostTurn: accept(posted), turnActive: false })
    expect(wire.calls).toHaveLength(3)
    expect(wire.calls[2]).toMatchObject({ refresh: true })
  })

  it('does not arm the wait on a REFUSED send — the button stays pressable and no edge is owed', async () => {
    // onPgSend refuses synchronously while an image prepares or a mention joins; an armed wait there
    // would disable the button forever, since the refused send produces no turn and no falling edge.
    await render({ onPostTurn: () => false, turnActive: false })

    await press('[data-pr-autofix]')
    expect(container?.querySelector<HTMLButtonElement>('[data-pr-autofix]')?.disabled).toBe(false)

    // A later, unrelated turn still refreshes — that is the dock's cadence, not this button's wait —
    // and the button, whose wait was never armed, stays pressable through it.
    await rerender({ onPostTurn: () => false, turnActive: true })
    await rerender({ onPostTurn: () => false, turnActive: false })
    expect(wire.calls).toHaveLength(2)
    expect(container?.querySelector<HTMLButtonElement>('[data-pr-autofix]')?.disabled).toBe(false)
  })

  it('holds Auto-fix while ANY turn streams — a queued post would let that turn eat the wait', async () => {
    // The composer QUEUES a send during a running turn; the running turn's falling edge would then
    // consume `awaitingTurn` before the Auto-fix turn dispatched, and its real settle would refresh nothing.
    await render({ onPostTurn: () => true, turnActive: true })
    expect(container?.querySelector<HTMLButtonElement>('[data-pr-autofix]')?.disabled).toBe(true)

    await rerender({ onPostTurn: () => true, turnActive: false })
    expect(container?.querySelector<HTMLButtonElement>('[data-pr-autofix]')?.disabled).toBe(false)
  })

  it('draws an UNKNOWN armed state as indeterminate and inert, not as an empty box', async () => {
    // `autoMergeArmed: null` means nobody could be asked — the daemon is offline or too old. An
    // enabled empty box would invite a click whose write fails anyway, and `canArmAutoMerge` is a
    // Postgres fact that knows nothing about reachability.
    wire.data = pr({ autoMergeArmed: null })
    await render()
    const box = container?.querySelector<HTMLInputElement>('[data-pr-automerge]')
    expect(box?.hasAttribute('data-pr-automerge-unknown')).toBe(true)
    expect(box?.indeterminate).toBe(true)
    expect(box?.disabled).toBe(true)
    expect(text()).toContain('can’t read whether anything is watching')
  })

  it('arms the edge watcher through the CP and re-reads the view it invalidated', async () => {
    await render()
    expect(wire.calls).toHaveLength(1)

    // Armable in a state GitHub's own auto-merge refuses outright: a check still running, and a
    // review asking for changes. That refusal is what the edge watcher exists to replace.
    wire.data = pr({
      autoMergeArmed: true,
      autoMergePlacement: 'sandbox',
      autoMergeWaitingOn: 'checks running: ci/lint'
    })
    await press('[data-pr-automerge]')

    expect(wire.mergeCalls).toEqual([{ sessionId: 'session-1', enabled: true }])
    expect(wire.calls).toHaveLength(2) // the post-write re-read, riding the CP's own invalidation
    expect(container?.querySelector<HTMLInputElement>('[data-pr-automerge]')?.checked).toBe(true)
    expect(text()).toContain('Watching')
    // The watcher's own verdict, which is the answer to "why has this not merged yet".
    expect(text()).toContain('waiting on checks running: ci/lint')

    // Unchecking disarms with the same round trip.
    wire.data = pr({ autoMergeArmed: false })
    await press('[data-pr-automerge]')
    expect(wire.mergeCalls[1]).toEqual({ sessionId: 'session-1', enabled: false })
  })

  it('surfaces a refused arm as data in the merge box and keeps the toggle usable', async () => {
    // GitHub declining the state change (the CP's 409) is an answer the operator acts on, not a crash.
    wire.mergeFailure = new Error('Pull request is in clean status')
    await render()

    await press('[data-pr-automerge]')

    expect(container?.querySelector('[data-pr-merge-error]')?.textContent).toContain('clean status')
    expect(container?.querySelector<HTMLInputElement>('[data-pr-automerge]')?.disabled).toBe(false)
    expect(wire.calls).toHaveLength(1) // no re-read: nothing changed behind the failed write
  })

  it('arms the merge on the first press and disarms on cancel — no mutation until the danger press', async () => {
    await render()
    // Unarmed: the primary "Merge" arm button, no danger confirm yet.
    expect(container?.querySelector('[data-pr-merge-arm]')?.textContent).toContain('Merge')
    expect(container?.querySelector('[data-pr-merge-now]')).toBeNull()

    await press('[data-pr-merge-arm]')
    // Armed: the danger confirm replaces the arm button, and nothing was sent yet.
    expect(container?.querySelector('[data-pr-merge-arm]')).toBeNull()
    expect(container?.querySelector<HTMLButtonElement>('[data-pr-merge-now]')?.textContent).toContain('Confirm merge')
    expect(wire.mergeNowCalls).toHaveLength(0)

    await press('[data-pr-merge-cancel]')
    expect(container?.querySelector('[data-pr-merge-arm]')?.textContent).toContain('Merge')
    expect(container?.querySelector('[data-pr-merge-now]')).toBeNull()
    expect(wire.mergeNowCalls).toHaveLength(0)
  })

  it('merges now through the CP and re-reads the view it invalidated', async () => {
    await render()
    expect(wire.calls).toHaveLength(1)

    await press('[data-pr-merge-arm]')
    expect(wire.mergeNowCalls).toHaveLength(0) // arming is local, nothing sent yet

    await press('[data-pr-merge-now]')

    expect(wire.mergeNowCalls).toEqual(['session-1'])
    expect(wire.calls).toHaveLength(2) // the post-write re-read, riding the CP's own invalidation
  })

  it('surfaces a refused merge as data and keeps the armed confirm usable', async () => {
    // GitHub declining the merge (the CP's 409) is an answer the operator acts on, not a crash.
    wire.mergeNowFailure = new Error('Pull request is not mergeable')
    await render()

    await press('[data-pr-merge-arm]')
    await press('[data-pr-merge-now]')

    expect(container?.querySelector('[data-pr-merge-now-error]')?.textContent).toContain('not mergeable')
    expect(container?.querySelector<HTMLButtonElement>('[data-pr-merge-now]')?.disabled).toBe(false)
    expect(wire.calls).toHaveLength(1) // no re-read: nothing changed behind the failed write
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
  it('survives the status flip landing BEFORE the link commits — a ladder retry still finds it', async () => {
    // The unfavorable ordering: `event/session` and `hook/report` are separate concurrently-dispatched
    // frames, so the transition can arrive, spend its immediate re-ask on a second 404, and never fire
    // again. The bounded ladder is what discovers the link that commits after that.
    vi.useFakeTimers()
    wire.failure = { status: 404 }
    await render({ sessionStatus: 'online' })
    expect(wire.calls).toHaveLength(1)

    // The terminal snapshot lands first: the transition re-asks immediately — and gets 404 AGAIN.
    await rerender({ sessionStatus: 'idle' })
    expect(wire.calls).toHaveLength(2)
    expect(verdicts.at(-1)?.answer).toBe('none')

    // hook/report finally commits the link; no further transition ever comes. The ladder finds it.
    wire.failure = null
    wire.data = pr()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PR_LINK_RETRY_LADDER_MS[0]!)
    })
    expect(wire.calls).toHaveLength(3)
    expect(verdicts.at(-1)?.answer).toBe('linked')
  })

  it('recovers a link with NO status transition at all — the reconnect-to-terminal-session ordering', async () => {
    // A reconnect can restore an already-terminal session before the hook-report outbox drains: the
    // first probe 404s and the status will never change. The ladder is the only way back here.
    vi.useFakeTimers()
    wire.failure = { status: 404 }
    await render({ sessionStatus: 'idle' })
    expect(wire.calls).toHaveLength(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PR_LINK_RETRY_LADDER_MS[0]!)
    })
    expect(wire.calls).toHaveLength(2)

    wire.failure = null
    wire.data = pr()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PR_LINK_RETRY_LADDER_MS[1]!)
    })
    expect(wire.calls).toHaveLength(3)
    expect(verdicts.at(-1)?.answer).toBe('linked')
  })

  it('goes quiet once the ladder drains, and a status transition refills it', async () => {
    // Bounded: a session that genuinely has no PR must stop asking — but a later transition is a fresh
    // hint that the link may just have committed, so it re-asks immediately and re-arms the ladder.
    vi.useFakeTimers()
    wire.failure = { status: 404 }
    // Hidden TAB, so the ladder is the only clock in the test: the whole ladder spans past the poll
    // cadence, and a poll landing mid-drain would count as a rung it never was. The ladder runs for a
    // hidden tab on purpose — a held 404 removes the tab, so there is no tab left to reveal and the
    // ladder is the only way back — but it IS gated on the document being visible, since a runless
    // session's 404 now costs a daemon read and, for a pushed branch, a GitHub list.
    await render({ sessionStatus: 'online', active: false })

    // Rung by rung: each retry schedules the next only after its answer settles, so the clock advances per step.
    for (const step of PR_LINK_RETRY_LADDER_MS) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(step)
      })
    }
    const drained = 1 + PR_LINK_RETRY_LADDER_MS.length
    expect(wire.calls).toHaveLength(drained)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_000)
    })
    expect(wire.calls).toHaveLength(drained)

    await rerender({ sessionStatus: 'idle', active: false })
    expect(wire.calls).toHaveLength(drained + 1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PR_LINK_RETRY_LADDER_MS[0]!)
    })
    expect(wire.calls).toHaveLength(drained + 2)
  })

  it('arms no ladder for a LINKED answer, and re-reads only on its own slow poll', async () => {
    // The provisional treatment is for the missing link ONLY: an answered probe schedules no ladder and
    // does not re-ask on status churn. What it does keep is the dock's poll — a check turns green and a
    // review lands without anything here changing — at a cadence sized for §9's GitHub budget.
    vi.useFakeTimers()
    wire.data = pr()
    await render({ sessionStatus: 'online' })
    expect(wire.calls).toHaveLength(1)
    await rerender({ sessionStatus: 'idle' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PR_POLL_MS - 1)
    })
    expect(wire.calls).toHaveLength(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    // A poll, not a forced read: the CP's projection TTL is what keeps several open panels cheap.
    expect(wire.calls).toHaveLength(2)
    expect(wire.calls[1]).toMatchObject({ refresh: false })
  })

  it('polls behind its own tab, and still takes a turn’s edge — the badge is on screen', async () => {
    // Its badge is on screen whatever tab is selected, and so is the armed merge-when-ready fact the
    // daemon holds the sandbox for — so this panel keeps its slow cadence while hidden, and a turn's
    // falling edge still reaches it. Only a background DOCUMENT stops it (`auto-refresh.test.tsx`).
    vi.useFakeTimers()
    wire.data = pr()
    await render({ active: false, sessionStatus: 'online' })
    expect(wire.calls).toHaveLength(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * PR_POLL_MS)
    })
    // The count, not the exact number of ticks: what matters is that a hidden tab keeps reading.
    expect(wire.calls.length).toBeGreaterThan(1)
    const polled = wire.calls.length

    await rerender({ active: false, sessionStatus: 'online', turnActive: true })
    await rerender({ active: false, sessionStatus: 'online', turnActive: false })
    expect(wire.calls).toHaveLength(polled + 1)
    expect(wire.calls[polled]).toMatchObject({ refresh: true })
  })

  it('links a pull request the agent opened mid-turn, without anyone pressing refresh', async () => {
    // The case this cadence exists for: the probe answered 404, the agent opened the PR inside the
    // turn, and the falling edge is what turns the tab's no-PR state into the linked one.
    vi.useFakeTimers()
    wire.failure = { status: 404 }
    await render({ sessionStatus: 'online', turnActive: true })
    expect(verdicts.at(-1)?.answer).toBe('none')

    wire.failure = null
    wire.data = pr()
    await rerender({ sessionStatus: 'online', turnActive: false })
    expect(verdicts.at(-1)?.answer).toBe('linked')
    expect(container?.querySelector('[data-pr-panel=""]')).not.toBeNull()
  })
})
