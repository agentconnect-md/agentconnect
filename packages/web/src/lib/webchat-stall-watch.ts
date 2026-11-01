// Resume a busy webchat stream that went quiet or holds a hole: an open socket never re-sends what a relay gap dropped.

export type WebchatStallCause = 'gap' | 'idle'

export interface WebchatStallTimers {
  setTimer: (callback: () => void, delayMs: number) => unknown
  clearTimer: (id: unknown) => void
}

export interface WebchatStallWatch {
  /** A busy session moved; `gap` means a lane holds frames past a missing index or a `done` it has not reached. */
  observe: (sessionId: string, gap: boolean) => void
  clear: (sessionId: string) => void
  clearAll: () => void
}

/** A hole rarely fills by itself: a later frame cannot carry an index the relay already dropped. */
export const WEBCHAT_GAP_RESUME_MS = 1_500
/** A quiet turn (a long tool call) is normal, so silence only earns a cheap, replay-only resume. */
export const WEBCHAT_IDLE_RESUME_MS = 20_000

const globalTimers: WebchatStallTimers = {
  setTimer: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimer: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>)
}

export function createWebchatStallWatch(
  onStall: (sessionId: string, cause: WebchatStallCause) => void,
  options: { gapMs?: number; idleMs?: number; timers?: WebchatStallTimers } = {}
): WebchatStallWatch {
  const gapMs = options.gapMs ?? WEBCHAT_GAP_RESUME_MS
  const idleMs = options.idleMs ?? WEBCHAT_IDLE_RESUME_MS
  const timers = options.timers ?? globalTimers
  const armed = new Map<string, { id: unknown; cause: WebchatStallCause }>()

  const clear = (sessionId: string): void => {
    const entry = armed.get(sessionId)
    if (!entry) return
    timers.clearTimer(entry.id)
    armed.delete(sessionId)
  }

  const arm = (sessionId: string, cause: WebchatStallCause): void => {
    clear(sessionId)
    const entry = { id: undefined as unknown, cause }
    entry.id = timers.setTimer(
      () => {
        if (armed.get(sessionId) !== entry) return
        armed.delete(sessionId)
        onStall(sessionId, cause)
      },
      cause === 'gap' ? gapMs : idleMs
    )
    armed.set(sessionId, entry)
  }

  const observe = (sessionId: string, gap: boolean): void => {
    // Frames still flowing past a hole must not keep postponing its repair.
    if (gap && armed.get(sessionId)?.cause === 'gap') return
    arm(sessionId, gap ? 'gap' : 'idle')
  }

  const clearAll = (): void => {
    for (const entry of armed.values()) timers.clearTimer(entry.id)
    armed.clear()
  }

  return { observe, clear, clearAll }
}
