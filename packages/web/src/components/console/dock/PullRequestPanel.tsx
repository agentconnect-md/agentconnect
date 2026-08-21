'use client'

// The dock's PR tab (§3.4): the pull request this session was dispatched for — state, head→base, checks, current reviews and unresolved threads — plus M6's writes: ONE Auto-fix post over the whole unresolved set (§5.2, a webchat turn, no CP route), a direct squash Merge, and the Merge-when-ready toggle over the EDGE's own watcher (not GitHub auto-merge, which refuses any PR that is not BLOCKED).
// Identity comes from the CP's own records and live state from GitHub through the CP's short-TTL projection; thread bodies are proxied, never stored (§2). A rate-limited, denied or unreachable GitHub is DATA: the panel still names its PR and says why the live lists are missing.
// A 404 from the probe is PROVISIONAL on a bounded ladder (the session→run link can commit after the status flip, or with no flip at all), then the absence is believed and drawn: the branch's state and a Create-pull-request action, which is another one-turn post on the same path as Auto-fix.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Spinner } from '@/components/marks'
import { Icon } from '@/components/ui'
import {
  ApiError,
  fetchSessionPullRequest,
  mergeSessionPullRequest,
  setSessionPullRequestAutoMerge,
  type SessionPullRequestCheckDto,
  type SessionPullRequestDto,
  type SessionPullRequestReviewDto,
  type SessionPullRequestThreadDto
} from '@/lib/api'
import { PR_POLL_MS, useDocumentVisible, useDockRefresh } from '@/components/console/dock/auto-refresh'
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
export function createPullRequestInstruction(
  branch: string | null,
  tracking: string | null,
  base: string | null
): string {
  const named = branch ? `this session’s branch (${branch})` : 'this session’s branch'
  // The base is the WORKSPACE's configured branch, which a repository whose default is another branch
  // makes a different thing: naming the default there opens the review against the wrong base and drags
  // in history this branch never added. Unknown ⇒ the agent derives it, rather than being told a guess.
  const target = base
    ? `against ${base}`
    : 'against the branch this worktree was created from — the workspace’s configured branch, or the repository’s default only where it configures none'
  return [
    `Open a pull request for ${named}:`,
    '',
    '1. Commit anything outstanding in this worktree that belongs in the pull request.',
    tracking
      ? `2. Push the branch to its upstream (${tracking}).`
      : '2. Publish the branch to the remote with `git push -u`, so it has an upstream to review.',
    // Explicitly idempotent: this panel cannot tell whether the PR already exists (it identifies one
    // only through the run that owns the session), so the reader can press again — and the agent, which
    // CAN tell, is the one told not to open a second pull request for the same branch.
    `3. If the branch already has an open pull request, reply with its URL instead of opening another; otherwise create one ${target} and reply with its URL.`
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
  base = null,
  onPostTurn,
  onVerdictChange
}: {
  /** The OPEN SESSION's id, the scope the CP resolves to its hook run. Deliberately no agentId: the PR belongs to the session, so a merged conversation's header-focus change must not re-key this read — the prop shape makes that unbuildable rather than merely avoided. */
  sessionId: string
  /** Whether this tab is the visible one; the panel re-reads on the edge where it becomes so, because PR state read when the page opened is not an answer about now. It also polls while it is — slowly, because GitHub rate limits are this surface's one external budget (§9) and the CP already absorbs repeats behind its projection TTL. */
  active?: boolean
  /** The open session's live status: a transition re-asks a held 404 immediately and refills the bounded retry ladder — a hint that the session→run link may just have committed, though the frames race, which is why the ladder exists at all. */
  sessionStatus?: string
  /** Whether a turn is streaming right now. Its FALLING edge forces one re-read past the CP's TTL, whether or not this panel posted the turn: anything the agent did on GitHub — resolving threads, pushing fixes, OPENING the pull request this tab is looking for — lands with the turn, and it is the same edge either way. */
  turnActive?: boolean
  /** The branch this session's checkout is on, from the Git tab's verdict — the panel's no-PR state is about THIS branch, and reading git status again here would be a second round trip for a fact the dock already holds. Null while that read has not answered, for a detached worktree, and for a workspace that is not a checkout. */
  branch?: string | null
  /** The remote branch it tracks, from the same verdict. Null ⇒ nothing to review yet: the branch has to be published before a pull request can exist. */
  tracking?: string | null
  /** The base branch this checkout's commits are measured against, from the same verdict — the workspace's configured branch, which is the base a pull request from here takes. Null ⇒ unknown, and the posted turn then has the agent derive it instead of naming the repository default, which a workspace configured onto another branch would make wrong. */
  base?: string | null
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
  // The bounded ladder that survives the unfavorable orderings. It is NOT free any more: since the CP
  // resolves a runless session's PR from its worktree's head branch, a 404 costs a `workspace/gitstatus`
  // REQ to the owning daemon and — for a pushed branch with no PR — a GitHub `pulls` list, and the
  // rungs outrun the CP's 15s miss cache. So it is gated on the document being VISIBLE, like the poll:
  // a backgrounded page spends nothing. It is deliberately NOT gated on the tab being active, unlike
  // the poll — a held 404 REMOVES this tab, so there would be no tab left to reveal and no way back.
  const visible = useDocumentVisible()
  useEffect(() => {
    if (!was404 || !visible) {
      if (!was404) attempt.current = 0
      return
    }
    const delay = PR_LINK_RETRY_LADDER_MS[attempt.current]
    if (delay === undefined) return
    const timer = setTimeout(() => {
      attempt.current += 1
      setReads((r) => ({ tick: r.tick + 1, force: false }))
    }, delay)
    return () => clearTimeout(timer)
  }, [was404, reads, visible])

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
  // Whether a create-pull-request turn was already handed to the agent HERE. It is remembered because
  // the result is not instantaneous: the PR is found through this worktree's own head branch, so it
  // appears once the branch is pushed and one exists against it — and until then the state would
  // re-offer creation as though nothing had happened, which invites a second PR for the same branch.
  // Reset per scope, like the wait.
  const [createRequested, setCreateRequested] = useState(false)
  useEffect(() => setCreateRequested(false), [sessionId])
  // Every turn's falling edge, not only a turn THIS panel posted: the reader's own "open a PR for this"
  // in the composer produces the same GitHub write-back, and a panel that re-read only after its own
  // button was the reason a PR opened from the conversation stayed invisible until someone pressed
  // refresh. `awaitingTurn` still clears here — it is the button's spinner, not the refresh's trigger.
  // Forced, because the write-back is younger than the CP's projection TTL by construction. The 404
  // ladder is refilled too: a turn is a fresh reason to believe the link may exist now — and that
  // refill is bounded per turn and gated on visibility below, which is what keeps a page left open on
  // an unreviewed branch from re-asking the daemon and GitHub forever.
  useDockRefresh({
    active,
    turnActive,
    whileHidden: true,
    // The page's state, not the selected tab's — but ONLY once a pull request is actually linked: its
    // badge is on screen either way, and an armed merge-when-ready watcher is one of the two facts the
    // daemon holds the session's sandbox for. A session with NO pull request keeps the old rule, since
    // re-asking a 404 behind a hidden tab costs a daemon read and, for a pushed branch, a GitHub list
    // — that bounded ladder is the surface for finding a PR that appears later, not a poll.
    pollWhileHidden: answer === 'linked',
    intervalMs: PR_POLL_MS,
    onRefresh: (reason) => {
      if (reason === 'turn') {
        setAwaitingTurn(false)
        attempt.current = 0
      }
      setReads((r) => ({ tick: r.tick + 1, force: reason === 'turn' }))
    }
  })

  // `indeterminate` is the one checkbox state no prop expresses, and it has to be re-applied AFTER
  // every render: React writes `checked` on commit, which clears it. A dependency-less effect runs on
  // each commit, which is exactly the cadence the DOM property needs.
  const armedBox = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (armedBox.current) armedBox.current.indeterminate = view?.autoMergeArmed === null
  })
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

  // The direct merge's own in-flight/error state, kept apart from the auto-merge toggle's. Two presses:
  // the first ARMS (reversible), the second (danger) actually merges — a one-click merge is irreversible,
  // and the box's most prominent control must not spend it.
  const [mergeNow, setMergeNow] = useState<{ busy: boolean; err: string | null }>({ busy: false, err: null })
  const [mergeArmed, setMergeArmed] = useState(false)
  useEffect(() => {
    setMergeNow({ busy: false, err: null })
    setMergeArmed(false)
  }, [sessionId])
  const doMerge = () => {
    setMergeNow({ busy: true, err: null })
    mergeSessionPullRequest(sessionId).then(
      () => {
        setMergeNow({ busy: false, err: null })
        setMergeArmed(false)
        // The CP invalidated its cached view on the write; the next read shows the merged state.
        setReads((r) => ({ tick: r.tick + 1, force: false }))
      },
      (e) => setMergeNow({ busy: false, err: msg(e) })
    )
  }

  // The description clamps to a bounded preview so it never pushes checks/reviews below the fold; the
  // reader can expand it in place.
  const [bodyExpanded, setBodyExpanded] = useState(false)
  useEffect(() => setBodyExpanded(false), [sessionId])

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
    /** Ran on an ACCEPTED send only, for the action that has to remember it was taken. */
    onPosted?: () => void
  }) =>
    onPostTurn ? (
      <button
        type="button"
        {...opts.attr}
        className={`${opts.className} disabled:pointer-events-none disabled:opacity-50`}
        disabled={awaitingTurn || turnActive}
        title={turnActive && !awaitingTurn ? opts.busyTitle : opts.title}
        onClick={() => {
          if (!onPostTurn(opts.text())) return
          setAwaitingTurn(true)
          opts.onPosted?.()
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
        {/* What this state still depends on, said rather than hidden: a PR is found through this worktree's own head branch, so it appears once the branch is pushed and the PR exists against it — not the instant the agent replies. Drawn only after the ask, because until then it is not the reader's problem. */}
        {createRequested ? (
          <div
            data-pr-create-requested=""
            className="flex items-start gap-2 px-3 pb-[6px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)"
          >
            <Icon name="info" size={13} color="var(--text-tertiary)" className="mt-[2px] flex-none" />
            <span>
              A pull request was requested in this session — the agent replies with its URL in the conversation. This
              tab links it once the branch is pushed and a pull request exists for it; press refresh if that just
              happened.
            </span>
          </div>
        ) : null}
        <div className="flex flex-none px-3 pb-2">
          {postAction({
            attr: { 'data-pr-create': '' },
            // Relabelled once asked: the same press is now a RETRY, and a button that still reads
            // "Create pull request" would invite a second PR for the branch that already has one.
            label: createRequested ? 'Ask again' : 'Create pull request',
            icon: createRequested ? 'rotate-ccw' : 'git-pull-request',
            title: createRequested
              ? 'Ask again — if this branch already has a pull request the agent will say so instead of opening a second one'
              : 'Ask the agent to publish this branch and open a pull request for it, as one turn in this session',
            busyTitle: 'A turn is already running — this posts its own turn, so wait for this one to settle',
            className: 'dsbtn dsbtn-secondary sm flex-none',
            text: () => createPullRequestInstruction(branch, tracking, base),
            onPosted: () => setCreateRequested(true)
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
        {/* The PR description, clamped to a bounded preview so a long body never pushes checks/reviews below the fold. */}
        {view.body ? (
          <div data-pr-body="" className="flex flex-none flex-col">
            <div className="flex items-center gap-2 px-3 pt-[10px] pb-[5px] font-sans text-[10.5px] font-semibold tracking-[0.04em] uppercase leading-normal text-(--text-disabled)">
              Description
            </div>
            <div
              className={`px-3 font-sans text-[12px] font-normal leading-[1.55] whitespace-pre-wrap break-words text-(--text-secondary) ${
                bodyExpanded ? 'pb-2' : 'max-h-[168px] overflow-hidden pb-1'
              }`}
            >
              {view.body}
            </div>
            {view.body.length > 400 ? (
              <button
                type="button"
                data-pr-body-toggle=""
                className="self-start px-3 pb-2 font-sans text-[11px] font-medium leading-normal text-(--text-link) hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand)"
                onClick={() => setBodyExpanded((v) => !v)}
              >
                {bodyExpanded ? 'Show less' : 'Show more'}
              </button>
            ) : null}
          </div>
        ) : null}
        {/* A shared checkout is the agent's ONE tree, so its PR may not be exclusively this session's work — a caveat, not an identity detail, and most relevant beside the Merge button. */}
        {view.linkScope === 'shared' ? (
          <div
            data-pr-link-shared=""
            className="flex items-start gap-2 px-3 pt-[7px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)"
          >
            <Icon name="info" size={13} color="var(--text-tertiary)" className="mt-[2px] flex-none" />
            <span>This pull request may carry work from other sessions on this agent’s shared checkout.</span>
          </div>
        ) : null}
        {/* A branch-resolved link can be ambiguous where a run-linked one never is: the head branch is the whole identity, so several open PRs on it are all equally "this session's". The panel names the pick rather than picking silently. */}
        {view.linkAmbiguous ? (
          <div
            data-pr-link-ambiguous=""
            className="flex items-start gap-2 px-3 pt-[7px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)"
          >
            <Icon name="info" size={13} color="var(--text-tertiary)" className="mt-[2px] flex-none" />
            <span>
              {view.linkBranch
                ? `Branch ${view.linkBranch} has more than one open pull request`
                : 'This session’s branch has more than one open pull request'}{' '}
              — this is the first of them.
            </span>
          </div>
        ) : null}
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
      {/* The merge box (§3.4): a direct Merge (squash) for a pull request that is ready now, plus the merge-when-ready toggle for one that is not — the watcher runs at the EDGE, so unlike GitHub's auto-merge it arms in any state. Open PRs only; a degraded read has no armed fact to draw a control over. */}
      {!view.degraded && view.state === 'open' ? (
        <div data-pr-merge="" className="flex flex-none flex-col gap-[6px] border-t border-(--border-subtle) px-3 py-2">
          <div className="flex items-center gap-2">
            {mergeArmed ? (
              <>
                <button
                  type="button"
                  data-pr-merge-cancel=""
                  className="dsbtn dsbtn-secondary sm flex-none disabled:pointer-events-none disabled:opacity-50"
                  disabled={mergeNow.busy}
                  title="Keep the pull request open"
                  onClick={() => setMergeArmed(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  data-pr-merge-now=""
                  className="dsbtn dsbtn-danger sm flex-none disabled:pointer-events-none disabled:opacity-50"
                  disabled={!view.canArmAutoMerge || view.isDraft || mergeNow.busy}
                  title={
                    !view.canArmAutoMerge
                      ? 'The owning agent’s repository access is below write tier, so merging is not available'
                      : view.isDraft
                        ? 'Draft pull requests can’t be merged'
                        : 'Merge this pull request now (squash) — this cannot be undone'
                  }
                  onClick={doMerge}
                >
                  {mergeNow.busy ? <Spinner size={11} /> : <Icon name="git-merge" size={13} />}
                  Confirm merge
                </button>
              </>
            ) : (
              <button
                type="button"
                data-pr-merge-arm=""
                className="dsbtn dsbtn-primary sm flex-none disabled:pointer-events-none disabled:opacity-50"
                disabled={!view.canArmAutoMerge || view.isDraft === true}
                title={
                  !view.canArmAutoMerge
                    ? 'The owning agent’s repository access is below write tier, so merging is not available'
                    : view.isDraft
                      ? 'Draft pull requests can’t be merged'
                      : 'Merge this pull request now (squash)'
                }
                onClick={() => setMergeArmed(true)}
              >
                <Icon name="git-merge" size={13} />
                Merge
              </button>
            )}
            {mergeNow.err ? (
              <span
                data-pr-merge-now-error=""
                className="min-w-0 flex-1 font-sans text-[11px] font-normal leading-[1.4] text-(--status-error)"
              >
                {mergeNow.err}
              </span>
            ) : null}
          </div>
          {/* The box is armable in EVERY state a pull request can be in — running checks, requested
              changes, conflicts. That is the point of moving the watcher to the edge: GitHub's own
              auto-merge refused all of them, which is what made this control look broken. */}
          {/* `autoMergeArmed: null` is UNKNOWN, not "off": nobody could be asked, because the owning
              daemon is offline or too old to answer. Drawn indeterminate and inert rather than as an
              empty box — an enabled empty box invites a click whose write would fail anyway, and
              `canArmAutoMerge` is a Postgres fact that knows nothing about the daemon's reachability. */}
          <label
            className={`flex items-center gap-[7px] font-sans text-[12px] font-medium leading-normal text-(--text-primary) ${view.canArmAutoMerge && view.autoMergeArmed !== null ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
            title={
              view.autoMergeArmed === null
                ? 'Whether a merge-when-ready watcher is armed can’t be read right now — its daemon is offline or too old to answer'
                : view.canArmAutoMerge
                  ? 'Watch this pull request and squash-merge it once checks pass, nobody has requested changes, and it has no conflicts'
                  : 'The owning agent’s repository access is below write tier, so arming the merge is not available'
            }
          >
            <input
              type="checkbox"
              data-pr-automerge=""
              data-pr-automerge-unknown={view.autoMergeArmed === null ? '' : undefined}
              ref={armedBox}
              className="accent-(--brand)"
              checked={view.autoMergeArmed ?? false}
              disabled={!view.canArmAutoMerge || view.autoMergeArmed === null || merge.busy}
              onChange={(event) => toggleAutoMerge(event.target.checked)}
            />
            Merge when ready
            {merge.busy ? <Spinner size={11} /> : null}
            {view.autoMergeArmed ? (
              <span
                data-pr-automerge-armed=""
                className="flex-none rounded-full bg-(--brand-soft) px-[7px] py-px font-sans text-[10.5px] font-semibold leading-normal text-(--brand)"
                title={
                  view.autoMergePlacement === 'sandbox'
                    ? 'Watched in the agent’s sandbox — reclaiming the sandbox stops it'
                    : view.autoMergePlacement === 'daemon'
                      ? 'Watched by the agent’s daemon — restarting the daemon stops it'
                      : undefined
                }
              >
                Watching
              </span>
            ) : null}
          </label>
          {/* What the watcher is actually holding for, in its own words — the answer GitHub's
              auto-merge never gave, and the reason an armed box is not a black hole. */}
          <div
            data-pr-automerge-status=""
            className="font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)"
          >
            {view.autoMergeArmed === null
              ? 'Squash · can’t read whether anything is watching'
              : view.autoMergeArmed
                ? view.autoMergeWaitingOn
                  ? `Squash · waiting on ${view.autoMergeWaitingOn}`
                  : 'Squash · once checks pass and nothing blocks it'
                : 'Squash and merge'}
          </div>
          {/* A failed tick keeps the watcher ARMED: the usual cure is the next commit, so this is a
              status line rather than a dead end, and it is drawn apart from the toggle's own error. */}
          {view.autoMergeArmed && view.autoMergeError ? (
            <div
              data-pr-automerge-error=""
              className="font-sans text-[11px] font-normal leading-[1.5] text-(--status-paused)"
            >
              Last check: {view.autoMergeError}
            </div>
          ) : null}
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
