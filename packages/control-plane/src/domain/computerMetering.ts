// Managed computer metering (computer-use.md §15.5): what a pool phase bills as, and how an interval splits into UTC days.
import type { ComputerPoolPhase } from './computerPool.js'

export type MeteredState = 'running' | 'sleeping'

/** Running while a pod is (or is being) up; sleeping while only the volume is kept; reclaiming bills nothing. */
export function meteredState(phase: ComputerPoolPhase): MeteredState | null {
  switch (phase) {
    case 'provisioning':
    case 'registering':
    case 'awake':
    case 'waking':
    case 'resetting':
      return 'running'
    case 'sleeping':
    case 'failed':
      return 'sleeping'
    case 'reclaiming':
      return null
  }
}

const DAY_MS = 86_400_000

/** The UTC day (midnight) an instant falls in. */
export const utcDay = (ms: number): Date => new Date(Math.floor(ms / DAY_MS) * DAY_MS)

/** [from, to) cut at UTC midnights, as whole seconds per day; sub-second remainders carry into the last day. */
export function splitByUtcDay(from: number, to: number): Array<{ day: Date; seconds: number }> {
  const out: Array<{ day: Date; seconds: number }> = []
  if (to <= from) return out
  let at = from
  let carried = 0
  while (at < to) {
    const end = Math.min(to, (Math.floor(at / DAY_MS) + 1) * DAY_MS)
    const ms = end - at + carried
    const seconds = Math.floor(ms / 1000)
    carried = ms - seconds * 1000
    if (seconds > 0) out.push({ day: utcDay(at), seconds })
    at = end
  }
  return out
}
