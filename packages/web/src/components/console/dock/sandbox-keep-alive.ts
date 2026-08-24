'use client'

// An open session page holding its agent's sandbox pod against the daemon's idle sweep.
//
// The sweep's clock is MESSAGE activity, which is the right rule for a conversation and the wrong one
// for a page: a worktree with uncommitted edits, or a pull request armed to merge when ready, has live
// state in that pod that a suspend throws away — the edits go with it, and the in-pod merge watcher
// dies with it. So while this page is open and on screen, it renews a lease.
//
// A LEASE, not a switch. There is nothing to release: the renewals simply stop when the page closes,
// the tab goes to the background, or the machine sleeps, and the daemon's hold lapses within one TTL.
// That is what keeps a forgotten tab from pinning a pod forever, and it is why this hook has no
// cleanup call to make. The daemon decides whether to hold at all — this side asserts nothing.
import { useEffect, useRef, useState } from 'react'
import { keepSessionSandboxAlive, type SessionSandboxKeepAliveDto } from '@/lib/api'
import { useDocumentVisible } from './auto-refresh'

/** Renewal cadence. Comfortably inside the daemon's own hold TTL (180s), so one dropped poll — a slow
 *  daemon, a re-render, a network blip — never suspends a pod out from under a page still watching it. */
export const KEEP_ALIVE_MS = 60_000

/**
 * Renew while `sessionId` is open and the document is visible. The first tick fires immediately, so a
 * page opened onto a dirty worktree holds the pod without waiting out a cadence.
 *
 * Failures are swallowed on purpose: a daemon too old to hold a lease (409), an offline one (503), or
 * a local agent with no pod at all are all answers this page has nothing to do about — the sweep's
 * pre-feature rules simply apply. The last answer is returned for a caller that wants to say why the
 * sandbox is being kept.
 */
export function useSandboxKeepAlive(sessionId: string | null): SessionSandboxKeepAliveDto | null {
  const visible = useDocumentVisible()
  const [state, setState] = useState<SessionSandboxKeepAliveDto | null>(null)
  // A renewal in flight when the session changes must not write the new session's state.
  const generation = useRef(0)

  useEffect(() => {
    generation.current += 1
    setState(null)
    if (!sessionId || !visible) return
    const mine = generation.current
    let live = true
    const renew = () => {
      keepSessionSandboxAlive(sessionId).then(
        (answer) => {
          if (live && generation.current === mine) setState(answer)
        },
        () => {
          if (live && generation.current === mine) setState(null)
        }
      )
    }
    renew()
    const timer = window.setInterval(renew, KEEP_ALIVE_MS)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [sessionId, visible])

  return state
}
