export type WebchatTextDelta = { kind: 'message' | 'thinking'; text: string }

export interface WebchatTextDeltaBatch {
  laneKey: string
  sessionId: string
  turnId: string
  event: WebchatTextDelta
}

interface ScheduledBatch extends WebchatTextDeltaBatch {
  frameId: number
  timerId: number
}

export interface WebchatDeltaScheduler {
  requestFrame: (callback: FrameRequestCallback) => number
  cancelFrame: (id: number) => void
  setTimer: (callback: () => void, delayMs: number) => number
  clearTimer: (id: number) => void
}

export interface WebchatDeltaBuffer {
  enqueue: (laneKey: string, sessionId: string, turnId: string, event: WebchatTextDelta) => void
  flush: (laneKey: string) => void
  flushSession: (sessionId: string) => void
  discardAll: () => void
}

export const WEBCHAT_DELTA_MAX_WAIT_MS = 50

const browserScheduler: WebchatDeltaScheduler = {
  requestFrame: (callback) => window.requestAnimationFrame(callback),
  cancelFrame: (id) => window.cancelAnimationFrame(id),
  setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimer: (id) => window.clearTimeout(id)
}

/**
 * Coalesce high-frequency text deltas independently per participant lane.
 * The next animation frame normally supplies the ~16 ms boundary; the timer
 * caps latency when rAF is throttled (for example in a background tab).
 */
export function createWebchatDeltaBuffer(
  onFlush: (batch: WebchatTextDeltaBatch) => void,
  options: { maxWaitMs?: number; scheduler?: WebchatDeltaScheduler } = {}
): WebchatDeltaBuffer {
  const maxWaitMs = options.maxWaitMs ?? WEBCHAT_DELTA_MAX_WAIT_MS
  const scheduler = options.scheduler ?? browserScheduler
  const pending = new Map<string, ScheduledBatch>()

  const flushBatch = (laneKey: string, expected?: ScheduledBatch): void => {
    const batch = pending.get(laneKey)
    if (!batch || (expected && batch !== expected)) return
    pending.delete(laneKey)
    scheduler.cancelFrame(batch.frameId)
    scheduler.clearTimer(batch.timerId)
    onFlush({
      laneKey: batch.laneKey,
      sessionId: batch.sessionId,
      turnId: batch.turnId,
      event: batch.event
    })
  }

  const enqueue = (laneKey: string, sessionId: string, turnId: string, event: WebchatTextDelta): void => {
    const current = pending.get(laneKey)
    if (current && current.sessionId === sessionId && current.turnId === turnId && current.event.kind === event.kind) {
      current.event.text += event.text
      return
    }
    if (current) flushBatch(laneKey, current)

    const batch: ScheduledBatch = {
      laneKey,
      sessionId,
      turnId,
      event: { ...event },
      frameId: 0,
      timerId: 0
    }
    batch.frameId = scheduler.requestFrame(() => flushBatch(laneKey, batch))
    batch.timerId = scheduler.setTimer(() => flushBatch(laneKey, batch), maxWaitMs)
    pending.set(laneKey, batch)
  }

  const flushSession = (sessionId: string): void => {
    for (const [laneKey, batch] of pending) {
      if (batch.sessionId === sessionId) flushBatch(laneKey, batch)
    }
  }

  const discardAll = (): void => {
    for (const batch of pending.values()) {
      scheduler.cancelFrame(batch.frameId)
      scheduler.clearTimer(batch.timerId)
    }
    pending.clear()
  }

  return { enqueue, flush: flushBatch, flushSession, discardAll }
}
