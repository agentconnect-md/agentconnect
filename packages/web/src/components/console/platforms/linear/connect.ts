'use client'

// The workspace connect round trip, shared by the two surfaces that start one:
// the wizard's "connect a workspace" hand-off and the settings card's Reconnect
// (linear-integration.md §7.1, §7.4). Both mint a one-shot state, open the
// linear.app authorize URL in a popup, and poll the FUNNEL ROW to a terminal
// state — never the bot list, because a reconnect replaces a grant in place and
// creates no row for a list to grow by.

import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '@/lib/api'
import { linearApi, type LinearConnectStartDto } from './api'

/** What the connect hand-off may offer right now, from the two deployment
 *  preconditions the console can see. */
export type LinearConnectAvailability = 'checking' | 'ready' | 'relay_required' | 'app_required'

/**
 * Resolve the hand-off's availability.
 *
 * `relayAvailable: null` ⇒ the shared deployment probe has no answer yet. The
 * deployment's own Linear app is NOT advertised anywhere the console can read, so
 * `appConfigured` starts null and only ever turns false when the funnel answers
 * 404 — the platform-app funnel's self-disable, learned from the route rather than
 * from a flag. An absent app outranks a missing relay: it is the one an operator
 * cannot fix from this console at all.
 */
export function linearConnectAvailability(input: {
  relayAvailable: boolean | null
  appConfigured: boolean | null
}): LinearConnectAvailability {
  if (input.appConfigured === false) return 'app_required'
  if (input.relayAvailable === null) return 'checking'
  return input.relayAvailable ? 'ready' : 'relay_required'
}

/** The funnel row's terminal failure codes, as sentences. The CP settles the row
 *  with a short code because the OAuth tab is a throwaway and the console is the
 *  only place the outcome can be read (§7.1). */
export function linearConnectFailure(reason: string | null): string {
  switch (reason) {
    case 'denied':
      return 'The connect was cancelled in Linear. Try again when you’re ready.'
    case 'expired':
      return 'That connect link expired or was already used. Start the connect again.'
    case 'workspace_taken':
      return 'This Linear workspace is already connected to a different organization. Disconnect it there first.'
    case 'wrong_workspace':
      return 'Linear authorized a different workspace. Try again and choose the workspace shown here.'
    case 'default_agent_required':
      return 'This workspace isn’t connected yet, so it needs a default agent. Start the connect from an agent.'
    case 'agent_missing':
      return 'The agent chosen for this workspace no longer exists. Start the connect again.'
    default:
      return 'Something went wrong finishing the connect. Try again.'
  }
}

/** The connect the popup is not required to report back: closing the tab without
 *  approving leaves the row pending forever, so the poll gives up on it. */
const LINEAR_CONNECT_ABANDONED = 'The Linear tab closed before the connect finished. Try again.'

export interface LinearConnectFlow {
  phase: 'idle' | 'authorizing'
  err: string | null
  /** The deployment has no Linear app — the funnel answered 404 (see
   *  {@link linearConnectAvailability}). */
  appMissing: boolean
  start(): void
  /** Abandon a round trip the operator no longer wants. The funnel row is left to
   *  its TTL — the nonce is one-shot, so the abandoned tab can still only settle
   *  the row it was minted for. */
  cancel(): void
  clearError(): void
}

/**
 * Drive one connect round trip. `mint` is the caller's own start call — the
 * wizard's `startConnect(agentId)` or the card's `reconnect(botId)` — so the two
 * flows share every step after it.
 *
 * `onCompleted` fires once the row settles `completed`.
 */
export function useLinearConnect(
  mint: () => Promise<LinearConnectStartDto>,
  onCompleted: (botId: string | null) => void
): LinearConnectFlow {
  const [phase, setPhase] = useState<'idle' | 'authorizing'>('idle')
  const [err, setErr] = useState<string | null>(null)
  const [appMissing, setAppMissing] = useState(false)
  const [connectId, setConnectId] = useState<string | null>(null)
  const busy = useRef(false)
  // Kept WITHOUT `noopener` so `.closed` is observable — the standard OAuth-popup
  // pattern against a trusted linear.app page.
  const popup = useRef<Window | null>(null)
  // `mint` and `onCompleted` are fresh closures on every render of the calling
  // pane; a ref keeps the poll effect from restarting under a live round trip.
  const latest = useRef({ mint, onCompleted })
  latest.current = { mint, onCompleted }

  const reset = useCallback(() => {
    setPhase('idle')
    setConnectId(null)
    popup.current = null
  }, [])

  const clearError = useCallback(() => setErr(null), [])

  // Cancel closes the tab we opened as well: leaving an orphan authorize page behind
  // is how an operator re-approves into a round trip nothing is polling any more.
  const cancel = useCallback(() => {
    try {
      popup.current?.close()
    } catch {
      // a cross-origin popup may refuse; the round trip is dropped either way
    }
    reset()
    setErr(null)
  }, [reset])

  const start = useCallback(() => {
    if (busy.current) return
    busy.current = true
    setErr(null)
    void (async () => {
      try {
        const started = await latest.current.mint()
        setConnectId(started.id)
        popup.current = window.open(started.connectUrl, '_blank', 'width=680,height=760')
        setPhase('authorizing')
      } catch (e) {
        // 404 ⇒ this deployment registered no Linear app, so the routes are off.
        if (e instanceof ApiError && e.status === 404) setAppMissing(true)
        else setErr(e instanceof Error ? e.message : String(e))
      } finally {
        busy.current = false
      }
    })()
  }, [])

  useEffect(() => {
    if (phase !== 'authorizing' || !connectId) return
    let alive = true
    let closeHandled = false
    const stop = (message: string) => {
      reset()
      setErr(message)
    }
    // Read the row once and act on its terminal state; `whenPending` decides
    // whether a closed popup means "landed" or "abandoned".
    const check = async (whenPending?: () => void) => {
      try {
        const row = await linearApi.getConnect(connectId)
        if (!alive) return
        if (row.status === 'pending') return whenPending?.()
        if (row.status === 'completed') {
          reset()
          latest.current.onCompleted(row.botId)
          return
        }
        stop(linearConnectFailure(row.failureReason))
      } catch (e) {
        // 404 = the row was TTL-reaped, which is terminal; anything else is transient.
        if (alive && e instanceof ApiError && e.status === 404) stop(linearConnectFailure('expired'))
      }
    }
    const poll = setInterval(() => void check(), 2500)
    const watch = setInterval(() => {
      if (!alive || closeHandled || !popup.current?.closed) return
      closeHandled = true
      void check(() => alive && stop(LINEAR_CONNECT_ABANDONED))
    }, 600)
    void check()
    return () => {
      alive = false
      clearInterval(poll)
      clearInterval(watch)
    }
  }, [connectId, phase, reset])

  return { phase, err, appMissing, start, cancel, clearError }
}
