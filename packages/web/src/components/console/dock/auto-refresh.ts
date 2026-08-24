'use client'

// The dock's shared refresh cadence (§3.3/§3.4). Every workspace panel reads a LIVE surface — the
// session worktree through its daemon, the pull request through GitHub — so a panel that only ever
// re-reads when pressed shows the tree as it was when the page opened. Three signals move it, and each
// one is here rather than re-derived per panel, because the differences between them are the bugs:
//
//  - the falling edge of a streaming TURN, which is when the agent's own writes (commits, pushes, an
//    opened pull request, resolved threads) have landed — the single highest-value signal, and the
//    only one that fires for a panel whose tab is hidden but whose BADGE is on screen;
//  - a poll while the document is visible, for the changes nobody here made (a coworker's push, a
//    check turning green) — for the three panels whose reads also decide whether the session's SANDBOX
//    is held (`pollWhileHidden`) this runs whatever tab is selected, because the page's whole state is
//    what an operator leaves open, not the one tab they last clicked;
//  - the reveal edge — a tab becoming active, or the document coming back — which is where a refresh
//    deferred by a hidden panel is actually spent.
//
// A background DOCUMENT polls nothing, `pollWhileHidden` included: these reads reach a daemon and, for
// the PR panel, an installation's rate limit, and a browser nobody is looking at must not spend either.
// Document visibility is the whole fence — the same one the sandbox keep-alive uses, so a page that
// stops refreshing is also a page that stops holding a pod.
import { useEffect, useRef, useState } from 'react'

/** Poll cadence for the daemon-backed panels (Files, Git) while their tab is on screen. */
export const DOCK_POLL_MS = 15_000

/** The PR panel's own, deliberately slower: it is the one read that spends an installation's GitHub
 *  rate limit (§9), and the CP already absorbs repeats behind a 20s projection TTL. */
export const PR_POLL_MS = 60_000

/** Why a refresh fired, for the panel that treats them differently (a `turn` forces past the CP's TTL). */
export type DockRefreshReason = 'turn' | 'poll' | 'reveal'

/** Whether the document is visible, SSR-safe and event-driven — `true` on the server and before the
 *  first effect, so a panel renders its first read rather than waiting for a signal that never comes. */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    const read = () => setVisible(document.visibilityState !== 'hidden')
    read()
    document.addEventListener('visibilitychange', read)
    return () => document.removeEventListener('visibilitychange', read)
  }, [])
  return visible
}

/**
 * One panel's refresh cadence. `onRefresh` must be safe to call repeatedly — every consumer here
 * bumps a tick, which is idempotent by construction.
 *
 * `whileHidden` is for a tab that shows a BADGE (Git's changed count, PR's unresolved threads): its
 * numbers are on screen even when its panel is not, so a turn's falling edge has to reach it. Without
 * it the refresh is DEFERRED rather than dropped, and spent on the reveal edge — which is what keeps a
 * hidden panel from re-reading a worktree nobody is looking at.
 */
export function useDockRefresh(opts: {
  /** Whether this panel's tab is the selected one. */
  active: boolean
  /** Poll cadence while active and visible; omit (or 0) for a panel that must not poll. */
  intervalMs?: number
  /** True while a turn streams in this session — the falling edge is the refresh signal. */
  turnActive?: boolean
  /** Fire the turn refresh even while the tab is hidden; otherwise it waits for the reveal edge. */
  whileHidden?: boolean
  /** Keep POLLING while this panel's tab is not the selected one (the document must still be visible).
   *  For the panels whose freshness the page itself depends on — Files, Git and the pull request. */
  pollWhileHidden?: boolean
  onRefresh: (reason: DockRefreshReason) => void
}): void {
  const { active, intervalMs = 0, turnActive = false, whileHidden = false, pollWhileHidden = false } = opts
  const visible = useDocumentVisible()
  // Held in a ref so a caller's fresh closure per render never re-arms the timer below.
  const onRefresh = useRef(opts.onRefresh)
  onRefresh.current = opts.onRefresh
  // A refresh a hidden panel owes itself. A boolean, not a count: two missed turns are still one
  // re-read, and the reveal edge reads the current tree either way.
  const pending = useRef(false)

  const wasTurnActive = useRef(turnActive)
  useEffect(() => {
    const settled = wasTurnActive.current && !turnActive
    wasTurnActive.current = turnActive
    if (!settled) return
    // Hidden means the tab is not selected OR the document is not on screen: neither is a moment to
    // spend a daemon round trip, and both end in a reveal edge that will.
    if (active && visible) onRefresh.current('turn')
    else if (whileHidden) onRefresh.current('turn')
    else pending.current = true
  }, [turnActive, active, visible, whileHidden])

  // The reveal EDGE, not the state: firing on `active && visible` itself would re-read every render.
  const wasRevealed = useRef(active && visible)
  useEffect(() => {
    const revealed = active && visible
    const edge = revealed && !wasRevealed.current
    wasRevealed.current = revealed
    if (!edge || !pending.current) return
    pending.current = false
    onRefresh.current('reveal')
  }, [active, visible])

  useEffect(() => {
    if (!visible || intervalMs <= 0) return
    if (!active && !pollWhileHidden) return
    const timer = window.setInterval(() => onRefresh.current('poll'), intervalMs)
    return () => window.clearInterval(timer)
  }, [active, visible, intervalMs, pollWhileHidden])
}
