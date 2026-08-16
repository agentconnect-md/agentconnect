'use client'

// The console's "start this agent's sandbox" (#1070): a cluster agent's files live on its pod's volume and are
// only readable through a running sandbox, so a read that refuses with the asleep code is answered by WAKING
// the sandbox — once, debounced — and polling the read with backoff until it answers or a bound passes. A GET
// never wakes anything; this hook is the one place that presses the explicit wake.

import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, wakeAgent } from '@/lib/api'

/** What the read this hook watches has resolved to. `failed` is any refusal other than the sleeping sandbox — kept polling while a wake is under way, because a pool agent nobody serves reads that way until the member the wake reached has claimed it. */
export type SandboxReadState = 'pending' | 'ready' | 'asleep' | 'failed'

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
}

/**
 * @param read what the panel's root read currently is
 * @param retry re-issue that read (a stable callback — it is what the poll presses)
 */
export function useSandboxWake(
  agentId: string,
  read: SandboxReadState,
  retry: () => void,
  { sandboxed = false, active = true }: SandboxWakeOptions = {}
): SandboxWake {
  const [phase, setPhase] = useState<SandboxWakePhase>('idle')
  // Which agent the automatic press already ran for: once per agent, so a refusal after a give-up does not re-press.
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
    wakeAgent(agentId).then(
      (ok) => {
        if (pressed !== generation.current) return
        wakeSettled.current = true
        if (ok.state === 'unsupported') settle('unsupported')
        else setTick((t) => t + 1)
      },
      (err: unknown) => {
        if (pressed !== generation.current) return
        // A refused press (viewer, vanished agent) has no polling to do; anything else may have raced, so the read decides.
        if (err instanceof ApiError && (err.status === 403 || err.status === 404)) settle('gave-up')
        else {
          wakeSettled.current = true
          setTick((t) => t + 1)
        }
      }
    )
  }, [agentId, settle])

  // A new agent is a new panel: nothing pressed, nothing under way. Declared before the automatic press so the reset never lands on top of it, and keyed on the agent actually changing so a re-run for the same one is inert.
  const shownAgent = useRef(agentId)
  useEffect(() => {
    if (shownAgent.current === agentId) return
    shownAgent.current = agentId
    settle('idle')
  }, [agentId, settle])

  // The automatic press: on a refusal, or on open for an agent known to be sandboxed — and only while on screen.
  useEffect(() => {
    if (!active || autoPressed.current === agentId) return
    if (read === 'asleep' || (sandboxed && read !== 'ready')) {
      autoPressed.current = agentId
      start()
    }
  }, [active, agentId, read, sandboxed, start])

  // The poll: after the wake answered, re-issue the read with backoff until it is ready or the bound passes.
  useEffect(() => {
    if (phase !== 'starting') return
    if (read === 'ready') {
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
