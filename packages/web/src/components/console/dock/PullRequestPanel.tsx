'use client'

// The dock's PR tab (§3.4): the pull request this session was dispatched for — state, head→base, checks, current reviews and unresolved threads — plus M6's two writes: ONE Auto-fix post over the whole unresolved set (§5.2, a webchat turn, no CP route) and the Merge-when-ready auto-merge toggle.
// Identity comes from the CP's own records and live state from GitHub through the CP's short-TTL projection; thread bodies are proxied, never stored (§2). A rate-limited, denied or unreachable GitHub is DATA: the panel still names its PR and says why the live lists are missing.
// A 404 from the probe is PROVISIONAL on a bounded ladder (the session→run link can commit after the status flip, or with no flip at all), then the absence is believed and drawn: the branch's state and a Create-pull-request action, which is another one-turn post on the same path as Auto-fix.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Spinner } from '@/components/marks'
import { Icon } from '@/components/ui'
import {
  ApiError,
  fetchSessionPullRequest,
  setSessionPullRequestAutoMerge,
  type SessionPullRequestCheckDto,
  type SessionPullRequestDto,
  type SessionPullRequestReviewDto,
  type SessionPullRequestThreadDto
} from '@/lib/api'
import type { DockTabStatus } from './SessionDock'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const statusOf = (e: unknown) => (e instanceof ApiError ? e.status : null)

/** The four answers the probe can settle on; `none` (a 404) is "no pull-request run owns this session", which the panel draws rather than blanks. */
export type PullRequestPanelAnswer = 'pending' | 'linked' | 'none' | 'failed'

/** What the PR tab reports upward. The caller owns the tab descriptor, so the panel reports its verdict rather than applying it — the same shape every other tab uses. */
export interface PullRequestPanelVerdict {
  answer: PullRequestPanelAnswer
  /** Unresolved threads for the tab's badge; null while unknown AND while degraded, where 0 would assert "none" about lists GitHub withheld. */
  unresolved: number | null
  /** The PR's GitHub page for the tab's `external-link` action; null until a 200 carries one. */
  url: string | null
}

/** The PR tab's status: `loading` until the probe's first answer, `ready` after. */
// Never `empty`: a 200 always carries identity to draw, and a `none` or failed probe has copy of its own — no state is left for the dock's centred "Nothing to show" to describe.
export function pullRequestTabStatus(answer: PullRequestPanelAnswer): DockTabStatus {
  return answer === 'pending' ? 'loading' : 'ready'
}

/** §5.2's one structured instruction: every unresolved thread (location + body), one turn, the agent resolves what it fixes. Exported so the post's exact content is pinned, not approximated. */
export function autoFixInstruction(view: SessionPullRequestDto): string {
  const threads = view.threads
    .map((thread, index) => `${index + 1}. ${thread.location} — ${thread.author}: ${thread.body}`)
    .join('\n')
  return [
    `Fix the unresolved review threads on pull request #${view.pullNumber} (${view.repoFullName}):`,
    '',
    threads,
    '',
    'Address each thread in this session’s worktree, commit and push the fixes, then resolve the threads you fixed on GitHub.'
  ].join('\n')
}

/** The turn the Create-pull-request action posts. One instruction covering both halves, because a branch with no upstream cannot be reviewed: publish it, then open the PR. Exported so the post's exact content is pinned, not approximated. */
export function createPullRequestInstruction(branch: string | null, tracking: string | null): string {
  const named = branch ? `this session’s branch (${branch})` : 'this session’s branch'
  return [
    `Open a pull request for ${named}:`,
    '',
    '1. Commit anything outstanding in this worktree that belongs in the pull request.',
    tracking
      ? `2. Push the branch to its upstream (${tracking}).`
      : '2. Publish the branch to the remote with `git push -u`, so it has an upstream to review.',
    '3. Create the pull request against the repository’s default branch, then reply with its URL.'
  ].join('\n')
}

/** A finished check's `startedAt`→`completedAt`, in the elapsed shape the Tasks rows use; empty when either end is missing or unparseable — the design says duration "where present", not invented. */
export function formatCheckDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt || !completedAt) return ''
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime()
  if (Number.isNaN(ms) || ms < 0) return ''
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

interface PrRead {
  loading: boolean
  err: string | null
  errStatus: number | null
  data: SessionPullRequestDto | null
}

const PENDING: PrRead = { loading: true, err: null, errStatus: null, data: null }

// How long a 404 stays provisional: five CP-local retries over ~2.5 minutes, then the absence is believed.
export const PR_LINK_RETRY_LADDER_MS = [2_000, 5_000, 15_000, 45_000, 90_000]

/** One probe per (session, tick). The answer is held PER SCOPE and the pending state DERIVED from it (the M4 shape): a new session reads as pending on the very render that changes it, a re-read of the SAME session replaces the answer in place, and a settled 404 simply stays held — nothing bumps the tick for a hidden tab. */
function useSessionPullRequest(sessionId: string, reads: { tick: number; force: boolean }) {
  const [answered, setAnswered] = useState<{ scope: string; tick: number; read: PrRead } | null>(null)
  useEffect(() => {
    let live = true
    const settle = (read: PrRead) => {
      if (live) setAnswered({ scope: sessionId, tick: reads.tick, read })
    }
    // `force` bypasses the CP's short TTL; a leftover `force` riding a scope switch costs one uncached read at most, which is not worth a second effect that would double-fire the first one (measured in M4).
    fetchSessionPullRequest(sessionId, reads.force ? { refresh: true } : {}).then(
      (data) => settle({ ...PENDING, loading: false, data }),
      (e) => settle({ ...PENDING, loading: false, err: msg(e), errStatus: statusOf(e) })
    )
    return () => {
      live = false
    }
  }, [sessionId, reads])
  const read = answered?.scope === sessionId ? answered.read : PENDING
  // A re-read keeps the previous answer on screen rather than strobing back to pending; this flag is what lets the refresh control show its own progress.
  const refreshing = answered?.scope === sessionId && answered.tick !== reads.tick
  return { read, refreshing }
}

const PILL =
  'flex flex-none items-center gap-[4px] rounded-full px-[7px] py-px font-sans text-[10.5px] font-semibold leading-normal'

// The state pill, one full literal per state (STYLE.md rule 8). `unknown` is the degraded arm with no stored fact — drawn as unknown rather than guessed open.
const STATE_PILL: Record<string, { label: string; icon: string; cls: string }> = {
  open: { label: 'Open', icon: 'git-pull-request', cls: `${PILL} bg-(--status-online-soft) text-(--status-online)` },
  draft: {
    label: 'Draft',
    icon: 'git-pull-request-draft',
    cls: `${PILL} bg-(--surface-active) text-(--text-secondary)`
  },
  merged: { label: 'Merged', icon: 'git-merge', cls: `${PILL} bg-(--surface-sunken) text-(--purple-500)` },
  closed: { label: 'Closed', icon: 'circle-x', cls: `${PILL} bg-(--status-error-soft) text-(--status-error)` },
  unknown: {
    label: 'State unknown',
    icon: 'circle-dashed',
    cls: `${PILL} bg-(--surface-active) text-(--text-tertiary)`
  }
}

/** Which pill a view wears. Draft outranks open (GitHub's own rendering); a null state — degraded with nothing stored — is `unknown`, never a fabricated `open`. */
export function pullRequestPillKey(state: SessionPullRequestDto['state'], isDraft: boolean | null): string {
  if (state === 'open' && isDraft) return 'draft'
  return state ?? 'unknown'
}

// The overall review decision, drawn in the REVIEWS section header where it belongs.
const DECISION_PILL: Record<string, { label: string; cls: string }> = {
  approved: { label: 'Approved', cls: `${PILL} bg-(--status-online-soft) text-(--status-online)` },
  changes_requested: { label: 'Changes requested', cls: `${PILL} bg-(--status-error-soft) text-(--status-error)` },
  review_required: { label: 'Review required', cls: `${PILL} bg-(--surface-active) text-(--status-paused)` }
}

// One glyph per check state. `check-circle-2`, which §8's icon list names, does not exist in this lucide version — `circle-check` and `circle-x` do (the substitute M2 recorded).
const CHECK_ICON: Record<SessionPullRequestCheckDto['state'], { name: string; color: string }> = {
  success: { name: 'circle-check', color: 'var(--status-online)' },
  failure: { name: 'circle-x', color: 'var(--status-error)' },
  pending: { name: 'loader', color: 'var(--status-info)' },
  skipped: { name: 'circle-dashed', color: 'var(--text-disabled)' },
  neutral: { name: 'circle-minus', color: 'var(--text-tertiary)' }
}

const REVIEW_META: Record<SessionPullRequestReviewDto['state'], { icon: string; color: string; label: string }> = {
  approved: { icon: 'circle-check', color: 'var(--status-online)', label: 'approved' },
  changes_requested: { icon: 'circle-x', color: 'var(--status-error)', label: 'changes requested' },
  commented: { icon: 'message-square', color: 'var(--text-tertiary)', label: 'commented' },
  dismissed: { icon: 'circle-minus', color: 'var(--text-disabled)', label: 'dismissed' },
  pending: { icon: 'circle-dashed', color: 'var(--text-tertiary)', label: 'pending' }
}

// Why the live half is missing, per the projection's three reasons. Identity above each stays up — a panel that still names its PR beats an empty one (§9 M5).
function degradedNoticeText(reason: SessionPullRequestDto['degradedReason']): string {
  if (reason === 'rate_limited') {
    return 'GitHub is rate limiting this deployment, so checks, reviews and threads are withheld for a moment. They come back on their own — or refresh shortly.'
  }
  if (reason === 'denied') {
    return 'GitHub denied this read — the installation may be suspended or no longer cover the repository. What is shown above is what AgentConnect already knows.'
  }
  return 'GitHub couldn’t be reached, so checks, reviews and threads are unavailable. What is shown above is what AgentConnect already knows.'
}

export function PullRequestPanel({
  sessionId,
  active = true,
  sessionStatus,
  turnActive = false,
  branch = null,
  tracking = null,
  onPostTurn,
  onVerdictChange
}: {
  /** The OPEN SESSION's id, the scope the CP resolves to its hook run. Deliberately no agentId: the PR belongs to the session, so a merged conversation's header-focus change must not re-key this read — the prop shape makes that unbuildable rather than merely avoided. */
  sessionId: string
  /** Whether this tab is the visible one; the panel re-reads on the edge where it becomes so, because PR state read when the page opened is not an answer about now. It does not poll — GitHub rate limits are this milestone's one external budget (§9). */
  active?: boolean
  /** The open session's live status: a transition re-asks a held 404 immediately and refills the bounded retry ladder — a hint that the session→run link may just have committed, though the frames race, which is why the ladder exists at all. */
  sessionStatus?: string
  /** Whether a turn is streaming right now. After Auto-fix posts one, the FALLING edge is the panel's cue to force one re-read — the agent's GitHub write-back (resolved threads, pushed fixes) lands with the turn, and the CP's short TTL would otherwise hide it. */
  turnActive?: boolean
  /** The branch this session's checkout is on, from the Git tab's verdict — the panel's no-PR state is about THIS branch, and reading git status again here would be a second round trip for a fact the dock already holds. Null while that read has not answered, for a detached worktree, and for a workspace that is not a checkout. */
  branch?: string | null
  /** The remote branch it tracks, from the same verdict. Null ⇒ nothing to review yet: the branch has to be published before a pull request can exist. */
  tracking?: string | null
  /** Posts one webchat message into the open session (§5.2's browser→relay→daemon path — no CP route), returning whether the send was ACCEPTED. Absent when the session has no usable composer (none at all, or a persisted webchat that cannot resume), and the Auto-fix and Create-pull-request actions render ABSENT with it, not disabled. */
  onPostTurn?: (text: string) => boolean
  /** The inputs to {@link pullRequestTabStatus}, the tab's badge and its external-link action. */
  onVerdictChange?: (verdict: PullRequestPanelVerdict) => void
}) {
  // The panel owns its reads: the tab's header action is `external-link` (§1's table), so refresh lives in the body. Both fields move together so a press is exactly one effect run.
  const [reads, setReads] = useState({ tick: 0, force: false })
  const { read, refreshing } = useSessionPullRequest(sessionId, reads)
  const view = read.data

  // The activation EDGE, not the state: re-reading on `active` itself would re-read on every render while the tab is open. Unreachable for a hidden tab, which is what keeps a 404 asked once.
  const wasActive = useRef(active)
  useEffect(() => {
    if (active && !wasActive.current) setReads((r) => ({ tick: r.tick + 1, force: false }))
    wasActive.current = active
  }, [active])

  // A held 404 is PROVISIONAL: `hook/report` (which writes the session→run link) and the terminal `event/session` snapshot are separate concurrently-dispatched frames, so the link can commit after the status flip — or with no flip at all, when a reconnect restores an already-terminal session.
  const was404 = read.errStatus === 404 && !read.loading
  const attempt = useRef(0)
  // A status transition re-asks immediately and refills the ladder below — it is a strong hint, not proof of ordering.
  const lastStatus = useRef(sessionStatus)
  useEffect(() => {
    const changed = sessionStatus !== lastStatus.current
    lastStatus.current = sessionStatus
    if (!changed) return
    attempt.current = 0
    if (was404) setReads((r) => ({ tick: r.tick + 1, force: false }))
  }, [sessionStatus, was404])
  // The bounded ladder that survives the unfavorable orderings: a 404 never reaches GitHub — the CP answers it from its own tables — so these retries spend none of §9's rate-limit budget, and the bound is what lets a session with no PR go quiet.
  useEffect(() => {
    if (!was404) {
      attempt.current = 0
      return
    }
    const delay = PR_LINK_RETRY_LADDER_MS[attempt.current]
    if (delay === undefined) return
    const timer = setTimeout(() => {
      attempt.current += 1
      setReads((r) => ({ tick: r.tick + 1, force: false }))
    }, delay)
    return () => clearTimeout(timer)
  }, [was404, reads])

  const answer: PullRequestPanelAnswer = read.loading
    ? 'pending'
    : view
      ? 'linked'
      : read.errStatus === 404
        ? 'none'
        : 'failed'
  const unresolved = view && !view.degraded ? view.unresolvedCount : null
  const url = view?.url ?? null

  // Auto-fix hands the set to the agent as ONE turn (§5.2): `awaitingTurn` survives until that turn's
  // falling edge, where the panel forces one re-read past the CP TTL — the write-back it waits for
  // (resolved threads) happened on GitHub inside the turn. Reset per scope: a session switch mid-fix
  // must not graft the old session's wait onto the new one's reads.
  const [awaitingTurn, setAwaitingTurn] = useState(false)
  useEffect(() => setAwaitingTurn(false), [sessionId])
  const wasTurnActive = useRef(turnActive)
  useEffect(() => {
    const settled = wasTurnActive.current && !turnActive
    wasTurnActive.current = turnActive
    if (settled && awaitingTurn) {
      setAwaitingTurn(false)
      setReads((r) => ({ tick: r.tick + 1, force: true }))
    }
  }, [turnActive, awaitingTurn])

  // The auto-merge toggle's own in-flight/error state; the armed FACT stays on the view, re-read after every write.
  const [merge, setMerge] = useState<{ busy: boolean; err: string | null }>({ busy: false, err: null })
  useEffect(() => setMerge({ busy: false, err: null }), [sessionId])
  const toggleAutoMerge = (enabled: boolean) => {
    setMerge({ busy: true, err: null })
    setSessionPullRequestAutoMerge(sessionId, enabled).then(
      () => {
        setMerge({ busy: false, err: null })
        // The CP invalidated its cached view on the write, so a plain re-read already sees the new state.
        setReads((r) => ({ tick: r.tick + 1, force: false }))
      },
      (e) => setMerge({ busy: false, err: msg(e) })
    )
  }

  // Reported on the EDGE, like every other tab's verdict: the caller's callback is a fresh closure per render, and re-reporting a held verdict would write parent state for nothing.
  const reported = useRef<string | null>(null)
  useEffect(() => {
    const key = `${answer}:${unresolved ?? ''}:${url ?? ''}`
    if (reported.current === key) return
    reported.current = key
    onVerdictChange?.({ answer, unresolved, url })
  }, [answer, onVerdictChange, unresolved, url])

  // Nothing while the dock's own "Loading…" placeholder speaks.
  if (answer === 'pending') return null

  const refresh = (
    <button
      type="button"
      data-pr-refresh=""
      className="iconbtn h-[22px] w-[22px] flex-none rounded-xs disabled:pointer-events-none"
      disabled={refreshing}
      aria-label="Refresh pull request"
      title="Ask GitHub again, past the control plane’s short cache"
      onClick={() => setReads((r) => ({ tick: r.tick + 1, force: true }))}
    >
      {refreshing ? <Spinner size={11} /> : <Icon name="refresh-cw" size={13} />}
    </button>
  )

  // Both write actions post ONE turn on the same path (§5.2) and share one fence: ABSENT (never disabled) without a composer to post through, disabled while any turn streams — the composer would QUEUE the post, and the running turn's falling edge would consume the wait before this turn dispatched — and the wait arms only on an ACCEPTED send, since a synchronous refusal produces no turn and no edge to clear it.
  const postAction = (opts: {
    attr: Record<string, string>
    label: string
    icon: string
    title: string
    busyTitle: string
    className: string
    text: () => string
  }) =>
    onPostTurn ? (
      <button
        type="button"
        {...opts.attr}
        className={`${opts.className} disabled:pointer-events-none disabled:opacity-50`}
        disabled={awaitingTurn || turnActive}
        title={turnActive && !awaitingTurn ? opts.busyTitle : opts.title}
        onClick={() => {
          if (onPostTurn(opts.text())) setAwaitingTurn(true)
        }}
      >
        {awaitingTurn ? <Spinner size={11} /> : <Icon name={opts.icon} size={12} />}
        {opts.label}
      </button>
    ) : null

  // A session with no linked pull request keeps its tab: the branch behind it still has a next step, and this is where the reader takes it. The probe's 404 says only that no pull-request run owns this session — never that the work is unreviewable.
  if (answer === 'none') {
    const unpublished = branch !== null && tracking === null
    return (
      <div data-pr-panel="none" className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-none items-center gap-2 border-b border-(--border-subtle) px-3 py-[7px]">
          <span className="min-w-0 flex-1 font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
            {unpublished ? 'No upstream configured' : 'No pull request'}
          </span>
          {refresh}
        </div>
        <PanelNotice
          text={
            unpublished
              ? `Branch ${branch} tracks no remote branch. Publish this branch to set its upstream before creating a pull request.`
              : branch !== null
                ? `Branch ${branch} tracks ${tracking}, and no pull request is linked to this session yet.`
                : 'No pull request is linked to this session yet.'
          }
        />
        <div className="flex flex-none px-3 pb-2">
          {postAction({
            attr: { 'data-pr-create': '' },
            label: 'Create pull request',
            icon: 'git-pull-request',
            title: 'Ask the agent to publish this branch and open a pull request for it, as one turn in this session',
            busyTitle: 'A turn is already running — this posts its own turn, so wait for this one to settle',
            className: 'dsbtn dsbtn-secondary sm flex-none',
            text: () => createPullRequestInstruction(branch, tracking)
          })}
        </div>
      </div>
    )
  }

  // A failed probe is not "no PR": hiding the tab here would claim an absence nobody verified, so the tab stays and says why there is nothing behind it.
  if (answer === 'failed' || !view) {
    return (
      <div data-pr-panel="failed" className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-none items-center gap-2 border-b border-(--border-subtle) px-3 py-[7px]">
          <span className="min-w-0 flex-1 font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
            Pull request unavailable
          </span>
          {refresh}
        </div>
        <PanelNotice
          warn
          text="Couldn’t read this session’s pull request — the control plane may be unreachable. Its state is proxied live, so nothing is shown while the read fails."
        />
      </div>
    )
  }

  const pill = STATE_PILL[pullRequestPillKey(view.state, view.isDraft)]!
  const decision = view.reviewDecision ? DECISION_PILL[view.reviewDecision] : undefined

  const section = (name: string, title: string, count: ReactNode, children: ReactNode, aside?: ReactNode) => (
    <div data-pr-section={name} className="flex flex-none flex-col">
      <div className="flex items-center gap-2 px-3 pt-[10px] pb-[5px] font-sans text-[10.5px] font-semibold tracking-[0.04em] uppercase leading-normal text-(--text-disabled)">
        <span>{title}</span>
        <span className="mono font-medium normal-case tracking-normal">{count}</span>
        {aside ? <span className="ml-auto normal-case tracking-normal">{aside}</span> : null}
      </div>
      {children}
    </div>
  )

  const footnote = (text: string) => (
    <div className="px-3 py-[7px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">{text}</div>
  )

  const checkRow = (check: SessionPullRequestCheckDto, index: number) => {
    const duration = formatCheckDuration(check.startedAt, check.completedAt)
    const glyph = CHECK_ICON[check.state]
    return (
      // Keyed by position: GitHub does not promise distinct names across check suites, and the list is replaced whole on every read.
      <div
        key={`${index}:${check.name}`}
        data-pr-check={check.state}
        className="flex items-center gap-2 px-3 py-[5px]"
        title={check.detail ?? undefined}
      >
        <Icon
          name={glyph.name}
          size={13}
          color={glyph.color}
          className={check.state === 'pending' ? 'flex-none animate-spin' : 'flex-none'}
        />
        <span className="min-w-0 flex-1 truncate font-sans text-[12px] font-normal leading-normal text-(--text-primary)">
          {check.name}
        </span>
        {duration ? (
          <span className="mono flex-none text-[11px] font-normal leading-normal text-(--text-tertiary)">
            {duration}
          </span>
        ) : null}
      </div>
    )
  }

  const reviewRow = (review: SessionPullRequestReviewDto) => {
    const meta = REVIEW_META[review.state]
    return (
      // One row per reviewer — the wire already collapses review events to each reviewer's current review.
      <div key={review.author} data-pr-review={review.state} className="flex items-center gap-2 px-3 py-[5px]">
        <Icon name={meta.icon} size={13} color={meta.color} className="flex-none" />
        <span className="min-w-0 flex-1 truncate font-sans text-[12px] font-medium leading-normal text-(--text-primary)">
          {review.author}
        </span>
        {review.isBot ? (
          <span
            className="flex-none rounded-xs bg-(--surface-active) px-[5px] py-px font-sans text-[10px] font-medium leading-normal text-(--text-tertiary)"
            title="A GitHub App identity, not a person"
          >
            bot
          </span>
        ) : null}
        <span className="flex-none font-sans text-[11px] font-normal leading-normal text-(--text-secondary)">
          {meta.label}
        </span>
      </div>
    )
  }

  const threadCard = (thread: SessionPullRequestThreadDto, index: number) => (
    // Keyed by position: two threads can share a location, and the list is replaced whole on every read.
    <div
      key={`${index}:${thread.location}`}
      data-pr-thread=""
      className="flex flex-none flex-col gap-[4px] rounded-md border border-(--border-subtle) bg-(--surface-card) px-[10px] py-2"
    >
      <div className="flex items-center gap-2">
        <span
          className="mono min-w-0 flex-1 truncate text-[11px] font-medium leading-normal text-(--text-secondary)"
          title={thread.location}
        >
          {thread.location}
        </span>
        {thread.isOutdated ? (
          <span
            className="flex-none rounded-xs bg-(--surface-active) px-[5px] py-px font-sans text-[10px] font-medium leading-normal text-(--text-tertiary)"
            title="The commented lines have changed since this thread was opened"
          >
            outdated
          </span>
        ) : null}
      </div>
      <div className="line-clamp-2 font-sans text-[12px] font-normal leading-[1.5] text-(--text-primary)">
        {thread.body}
      </div>
      <div className="font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">{thread.author}</div>
    </div>
  )

  return (
    <div data-pr-panel="" className="flex min-h-0 flex-1 flex-col">
      {/* Identity, from the CP's own records: it survives every GitHub failure below, which is the §9 M5 bargain. */}
      <div className="flex flex-none flex-col gap-[6px] border-b border-(--border-subtle) px-3 py-[10px]">
        <div className="flex items-center gap-2">
          <span data-pr-state={pullRequestPillKey(view.state, view.isDraft)} className={pill.cls}>
            <Icon name={pill.icon} size={11} />
            {pill.label}
          </span>
          <span className="mono flex-none text-[11px] font-medium leading-normal text-(--text-secondary)">
            {`#${view.pullNumber}`}
          </span>
          <span
            className="mono min-w-0 flex-1 truncate text-[11px] font-normal leading-normal text-(--text-tertiary)"
            title={view.repoFullName}
          >
            {view.repoFullName}
          </span>
          {refresh}
        </div>
        <div className="font-sans text-[13px] font-semibold leading-[1.4] text-(--text-primary)">{view.title}</div>
        <div className="flex items-center gap-2">
          <span className="mono flex min-w-0 flex-1 items-center gap-[5px] text-[11px] font-normal leading-normal text-(--text-secondary)">
            <span className="min-w-0 truncate" title={view.headRef}>
              {view.headRef}
            </span>
            <Icon name="arrow-right" size={10} color="var(--text-tertiary)" className="flex-none" />
            <span className="min-w-0 truncate" title={view.baseRef}>
              {view.baseRef}
            </span>
          </span>
          {/* Line counts only when GitHub answered them — a degraded read has no stored counts to fall back on, and 0 would be an invented number. */}
          {view.additions !== null || view.deletions !== null ? (
            <span className="mono flex-none text-[11px] font-medium leading-normal">
              {view.additions !== null ? <span className="text-(--status-online)">{`+${view.additions}`}</span> : null}
              {view.additions !== null && view.deletions !== null ? ' ' : null}
              {view.deletions !== null ? <span className="text-(--status-error)">{`−${view.deletions}`}</span> : null}
            </span>
          ) : null}
        </div>
        <a
          data-pr-link=""
          href={view.url}
          target="_blank"
          rel="noopener noreferrer"
          className="lnk flex items-center gap-[4px] self-start font-sans text-[11.5px] font-medium leading-normal"
        >
          <Icon name="external-link" size={12} className="flex-none" />
          View on GitHub
        </a>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto pb-2">
        {view.degraded ? (
          <>
            <PanelNotice warn text={degradedNoticeText(view.degradedReason)} />
            {/* The one review state this deployment knows without GitHub: its own agent's, off the owning run. Populated by the SERVICE only on a degraded answer — when GitHub answered, its list is authoritative and already contains this review. */}
            {view.agentReview ? (
              <div
                data-pr-agent-review=""
                className="flex items-center gap-2 px-3 py-[7px] font-sans text-[12px] font-normal leading-normal text-(--text-secondary)"
              >
                <Icon
                  name={REVIEW_META[view.agentReview].icon}
                  size={13}
                  color={REVIEW_META[view.agentReview].color}
                  className="flex-none"
                />
                <span>
                  This agent’s recorded review:{' '}
                  <span className="font-medium">{REVIEW_META[view.agentReview].label}</span>
                </span>
              </div>
            ) : null}
          </>
        ) : (
          <>
            {section(
              'checks',
              'Checks',
              view.checks.length,
              view.checks.length === 0 ? (
                <PanelNotice text="No checks reported on this PR’s head commit." />
              ) : (
                <>
                  {view.checks.map(checkRow)}
                  {view.checksTruncated
                    ? footnote(`More checks than one read carries — the first ${view.checks.length} are listed.`)
                    : null}
                </>
              )
            )}
            {section(
              'reviews',
              'Reviews',
              view.reviews.length,
              view.reviews.length === 0 ? <PanelNotice text="No reviews yet." /> : <>{view.reviews.map(reviewRow)}</>,
              decision ? (
                <span data-pr-decision={view.reviewDecision} className={decision.cls}>
                  {decision.label}
                </span>
              ) : undefined
            )}
            {section(
              'threads',
              'Unresolved threads',
              // The count is a FLOOR when the thread page is truncated, and the `+` says so rather than presenting a page as the total.
              `${view.unresolvedCount}${view.threadsTruncated ? '+' : ''}`,
              view.threads.length === 0 ? (
                <PanelNotice text="No unresolved review threads." />
              ) : (
                <div className="flex flex-col gap-[6px] px-3 pt-px pb-[6px]">
                  {view.threads.map(threadCard)}
                  {view.threadsTruncated ? (
                    <div className="font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
                      More unresolved threads than one read carries — the first {view.threads.length} are shown.
                    </div>
                  ) : null}
                </div>
              ),
              // ONE Auto-fix over the whole set (§5.2) — a real agent turn on the webchat path.
              view.threads.length > 0
                ? postAction({
                    attr: { 'data-pr-autofix': '' },
                    label: 'Auto-fix',
                    icon: 'wand-sparkles',
                    title:
                      'Hand every unresolved thread to the agent as one turn; it edits this session’s worktree and resolves the threads it fixes',
                    busyTitle:
                      'A turn is already running — Auto-fix posts its own turn, so wait for this one to settle',
                    className: 'dsbtn dsbtn-secondary sm flex-none',
                    text: () => autoFixInstruction(view)
                  })
                : undefined
            )}
          </>
        )}
      </div>
      {/* The merge box (§3.4): the checkbox IS the action — there is no direct-merge route to back a Merge button, so none is drawn. Open PRs only; a degraded read has no armed fact to draw a control over. */}
      {!view.degraded && view.state === 'open' ? (
        <div data-pr-merge="" className="flex flex-none flex-col gap-[3px] border-t border-(--border-subtle) px-3 py-2">
          <label
            className={`flex items-center gap-[7px] font-sans text-[12px] font-medium leading-normal text-(--text-primary) ${view.canArmAutoMerge ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
            title={
              view.canArmAutoMerge
                ? 'GitHub merges automatically once checks and approvals pass'
                : 'The owning agent’s repository access is below write tier, so arming the merge is not available'
            }
          >
            <input
              type="checkbox"
              data-pr-automerge=""
              className="accent-(--brand)"
              checked={view.autoMergeArmed ?? false}
              disabled={!view.canArmAutoMerge || merge.busy}
              onChange={(event) => toggleAutoMerge(event.target.checked)}
            />
            Merge when ready
            {merge.busy ? <Spinner size={11} /> : null}
            {view.autoMergeArmed ? (
              <span className="flex-none rounded-full bg-(--brand-soft) px-[7px] py-px font-sans text-[10.5px] font-semibold leading-normal text-(--brand)">
                Auto-merge armed
              </span>
            ) : null}
          </label>
          <div className="font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
            {view.autoMergeArmed ? 'Squash · after checks + approvals' : 'Squash and merge'}
          </div>
          {merge.err ? (
            <div
              data-pr-merge-error=""
              className="font-sans text-[11.5px] font-normal leading-[1.5] text-(--status-error)"
            >
              {merge.err}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// A degraded or empty state, drawn calmly: a PR whose live half is missing still has something to say about why.
function PanelNotice({ text, warn = false }: { text: string; warn?: boolean }) {
  return (
    <div className="flex items-start gap-2 px-3 py-[10px] font-sans text-[12px] font-normal leading-[1.55] text-(--text-secondary)">
      <Icon
        name={warn ? 'triangle-alert' : 'git-pull-request'}
        size={14}
        color={warn ? 'var(--amber-500)' : 'var(--text-tertiary)'}
        className="mt-[2px] flex-none"
      />
      <span>{text}</span>
    </div>
  )
}
