'use client'

// The one-click "Add to Slack" flow for the built-in AgentConnect Bot (preset-agents.md
// §5.3): mint a state-bound authorize URL, open it in a popup, then poll the install row
// until it reaches a terminal state. Extracted so the getting-started "Meet your agents"
// card runs the SAME logic as the "Add to Slack" button inside AddIntegrationModal —
// keep the two in sync (the modal keeps its own copy, coupled to its cross-flow busy ref).
//
// Unlike the modal (whose whole dialog is the escape hatch), this card is persistent, so
// it must recover on its own: if the user just CLOSES the Slack popup without approving,
// the install row stays `pending` forever and polling would hang in `authorizing`. We
// keep the popup handle and, once it's closed without completing, fall back to idle so
// the button is clickable again. `cancel()` is the manual escape for when the popup ref
// is unavailable (pop-up blocked → window.open returns null, or a browser quirk).

import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '@/lib/api'
import type { WebInstallPoll } from '../contract'
import { slackApi } from './api'

// Why a platform install round trip ended without connecting, keyed by the install
// row's `failureReason`. Mirrors AddIntegrationModal's PLATFORM_INSTALL_FAILURES.
const FAILURES: Record<string, string> = {
  denied: 'The install was cancelled in Slack.',
  expired: 'This install link expired — start again.',
  workspace_taken: 'That Slack workspace is already connected to another organization.',
  workspace_mismatch: 'Slack authorized a different workspace. Start again and choose the expected workspace.',
  agent_taken: 'That Slack workspace is already connected to another agent here. Remove that integration first.',
  error: 'Slack could not complete the install. Please try again.'
}

/** `onCompleted` fires once the install reaches `completed` (refresh lists / close the surface). */
export function useSlackPlatformInstall(agentId: string, onCompleted: () => void): WebInstallPoll {
  const [phase, setPhase] = useState<'idle' | 'authorizing'>('idle')
  const [err, setErr] = useState<string | null>(null)
  const [installId, setInstallId] = useState<string | null>(null)
  const busy = useRef(false)
  // The authorize popup. Kept WITHOUT `noopener` so we can observe `.closed` (opener
  // access to a trusted slack.com auth page is the standard OAuth-popup pattern).
  const popup = useRef<Window | null>(null)

  const reset = useCallback(() => {
    setPhase('idle')
    setInstallId(null)
    popup.current = null
  }, [])

  const cancel = useCallback(() => {
    popup.current?.close()
    reset()
  }, [reset])

  const start = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    setErr(null)
    try {
      const r = await slackApi.startPlatformInstall({ agentId })
      setInstallId(r.id)
      popup.current = window.open(r.installUrl, '_blank', 'width=680,height=760')
      setPhase('authorizing')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      busy.current = false
    }
  }, [agentId])

  // While the user approves in the Slack tab, poll the INSTALL ROW for its terminal
  // state (a re-authorization only rotates the token and creates no integration, so
  // watching the list would hang). 404 ⇒ the row was TTL-reaped, which is terminal.
  useEffect(() => {
    if (phase !== 'authorizing' || !installId) return
    let alive = true
    let closeHandled = false
    const stop = (message: string) => {
      reset()
      setErr(message)
    }
    // Read the row once and act on its terminal state. `whenPending` runs when it's still
    // pending — used to decide whether a closed popup means "done" or "abandoned".
    const check = async (whenPending?: () => void) => {
      try {
        const s = await slackApi.getPlatformInstall(installId)
        if (!alive) return
        if (s.status === 'pending') return whenPending?.()
        if (s.status === 'completed') {
          reset()
          onCompleted()
          return
        }
        stop(FAILURES[s.failureReason ?? ''] ?? 'The Slack install did not complete.')
      } catch (e) {
        if (alive && e instanceof ApiError && e.status === 404) stop(FAILURES.expired!)
      }
    }
    const poll = setInterval(() => void check(), 2500)
    // Watch for the user closing the popup. On close, confirm the row's state once more
    // (it may have completed right as the popup auto-closed); only if it's still pending
    // do we treat it as abandoned and return to idle — no error, just clickable again.
    const watch = setInterval(() => {
      if (!alive || closeHandled || !popup.current?.closed) return
      closeHandled = true
      void check(() => alive && reset())
    }, 600)
    void check()
    return () => {
      alive = false
      clearInterval(poll)
      clearInterval(watch)
    }
  }, [phase, installId, onCompleted, reset])

  return { phase, err, start, cancel }
}
