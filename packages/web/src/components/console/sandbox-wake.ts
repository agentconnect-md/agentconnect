'use client'

// The console's "start this sandbox" (#1070): a read refused as asleep is answered by ONE wake, then polled with backoff; a GET never wakes anything, so this is the one press.

import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, wakeAgent } from '@/lib/api'

/** What the read this hook watches has resolved to. `removed` is a session whose own sandbox is gone, final for the hook; `failed` is any other refusal, kept polling while a wake is under way because a pool agent nobody serves reads that way until the member the wake reached has claimed it. */
export type SandboxReadState = 'pending' | 'ready' | 'asleep' | 'removed' | 'failed'

/** The CP's code, on a read and on a wake alike, for a session whose own sandbox was removed: nothing to start, since no wake recreates it. */
export const SANDBOX_REMOVED_CODE = 'WORKSPACE_SANDBOX_REMOVED'

/** `starting` = a wake was pressed and the read is being polled; `gave-up` = the bound passed without an answer, so the terminal copy shows with a Start button; `unsupported` = the daemon had nothing to wake, so the terminal copy shows without one. */
export type SandboxWakePhase = 'idle' | 'starting' | 'gave-up' | 'unsupported'

/** How long the read is polled after a wake before the panel stops and offers Start again. */
export const SANDBOX_WAKE_BOUND_MS = 90_000
/** Poll spacing after a wake: quick at first, since a warm resume binds in seconds, then eased off. */
export const SANDBOX_WAKE_POLL_MS = [2_000, 3_000, 5_000, 8_000, 10_000] as const

export interface SandboxWake {
  phase: SandboxWakePhase
  /** Press the wake (again). A no-op while one is already under way. */
  start: () => void
}

export interface SandboxWakeOptions {
  /** The agent is known to run in a cluster sandbox, so the wake is pressed on open rather than only after a refusal — the pool's "no holder" window is covered by the same press. */
  sandboxed?: boolean
  /** Whether the surface is actually on screen. A mounted-but-hidden panel (a dock tab that is not selected) neither presses the wake nor polls: a pod start is never a side effect of a page whose reader has not asked for the files. Defaults to true. */
  active?: boolean
  /** The isolated session whose own sandbox the press resumes; omit for the agent's (its checkout, memory, dreams). */
  sessionId?: string
}

/**
 * @param read what the panel's root read currently is
 * @param retry re-issue that read (a stable callback — it is what the poll presses)
 */
export function useSandboxWake(
  agentId: string,
  read: SandboxReadState,
  retry: () => void,
  { sandboxed = false, active = true, sessionId }: SandboxWakeOptions = {}
): SandboxWake {
  const [phase, setPhase] = useState<SandboxWakePhase>('idle')
  // The sandbox a press names: the agent's, or one session's own.
  const scope = sessionId === undefined ? agentId : `${agentId}:${sessionId}`
  // Which scope the automatic press already ran for: once per scope, so a refusal after a give-up does not re-press.
  const autoPressed = useRef<string | null>(null)
  // The press under way, if any — a ref rather than the phase, so a double-invoked updater cannot press twice.
  const pressing = useRef(false)
  const startedAt = useRef(0)
  const attempt = useRef(0)
  const wakeSettled = useRef(false)
  // Which press an answer belongs to: a reset (new agent) or a give-up outdates the one in flight.
  const generation = useRef(0)
  // Bumped when the wake answers and after each poll, so the scheduler re-runs even when `read` did not change.
  const [tick, setTick] = useState(0)

  const settle = useCallback((next: SandboxWakePhase) => {
    generation.current += 1
    pressing.current = false
    setPhase(next)
  }, [])

  const start = useCallback(() => {
    if (pressing.current) return
    pressing.current = true
    startedAt.current = Date.now()
    attempt.current = 0
    wakeSettled.current = false
    setPhase('starting')
    const pressed = generation.current
    const press = sessionId === undefined ? wakeAgent(agentId) : wakeAgent(agentId, sessionId)
    press.then(
      (ok) => {
        if (pressed !== generation.current) return
        wakeSettled.current = true
        if (ok.state === 'unsupported') settle('unsupported')
        else setTick((t) => t + 1)
      },
      (err: unknown) => {
        if (pressed !== generation.current) return
        // A removed session sandbox has nothing to start: re-read at once, and the read's own answer ends the press.
        if (err instanceof ApiError && err.code === SANDBOX_REMOVED_CODE) {
          wakeSettled.current = true
          retry()
          setTick((t) => t + 1)
        }
        // A refused press (viewer, vanished agent) has no polling to do; anything else may have raced, so the read decides.
        else if (err instanceof ApiError && (err.status === 403 || err.status === 404)) settle('gave-up')
        else {
          wakeSettled.current = true
          setTick((t) => t + 1)
        }
      }
    )
  }, [agentId, retry, sessionId, settle])

  // A new scope is a new panel: nothing pressed, nothing under way. Declared before the automatic press so the reset never lands on top of it, and keyed on the scope actually changing so a re-run for the same one is inert.
  const shownScope = useRef(scope)
  useEffect(() => {
    if (shownScope.current === scope) return
    shownScope.current = scope
    settle('idle')
  }, [scope, settle])

  // The automatic press: on a refusal, or on open for an agent known to be sandboxed — and only while on screen.
  useEffect(() => {
    if (!active || autoPressed.current === scope) return
    if (read === 'asleep' || (sandboxed && read !== 'ready' && read !== 'removed')) {
      autoPressed.current = scope
      start()
    }
  }, [active, read, sandboxed, scope, start])

  // The poll: after the wake answered, re-issue the read with backoff until it is ready, removed, or the bound passes.
  useEffect(() => {
    if (phase !== 'starting') return
    if (read === 'ready' || read === 'removed') {
      settle('idle')
      return
    }
    // Hidden mid-poll: the timer simply does not run; the next activation resumes it where it stopped.
    if (!active || read === 'pending' || !wakeSettled.current) return
    if (Date.now() - startedAt.current >= SANDBOX_WAKE_BOUND_MS) {
      settle('gave-up')
      return
    }
    const delay = SANDBOX_WAKE_POLL_MS[Math.min(attempt.current, SANDBOX_WAKE_POLL_MS.length - 1)]!
    const timer = setTimeout(() => {
      attempt.current += 1
      retry()
      setTick((t) => t + 1)
    }, delay)
    return () => clearTimeout(timer)
  }, [active, phase, read, retry, settle, tick])

  return { phase, start }
}
