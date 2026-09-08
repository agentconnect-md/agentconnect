// Every way an agent's memory home can be out of reach (memory-evolution.md §3.2.1 "Degradation"): the daemon refuses
// the request with one of these reasons, and each is "not now" for the console — a 503 that says why, never a 400.
import { z } from 'zod'
import { ProtocolError } from '../domain/errors.js'

/** The daemon's `MemoryHomeUnavailableReason` set; add a reason here and every memory route answers it with 503. */
export const MemoryHomeUnavailableReason = z.enum([
  'sandbox-unavailable',
  'connection',
  'feature',
  'scope-denied',
  'migrating',
  'pool-daemon-home'
])
export type MemoryHomeUnavailableReason = z.infer<typeof MemoryHomeUnavailableReason>

/** The one code the console acts on (it wakes the sandbox, #1077) — shared with the workspace reader, kept verbatim. */
export const SANDBOX_UNAVAILABLE_CODE = 'WORKSPACE_SANDBOX_UNAVAILABLE'

export interface MemoryHomeUnavailable {
  status: 503
  error: 'Service Unavailable'
  message: string
  code: string
}

/** The 503 a memory home refusal maps to, or null when `err` is not one; only the sandbox case carries the wake code. */
export function memoryHomeUnavailable(err: unknown): MemoryHomeUnavailable | null {
  if (!(err instanceof ProtocolError) || err.code !== 'BAD_PAYLOAD') return null
  const reason = MemoryHomeUnavailableReason.safeParse(err.details?.reason)
  if (!reason.success) return null
  const code =
    reason.data === 'sandbox-unavailable'
      ? SANDBOX_UNAVAILABLE_CODE
      : `MEMORY_HOME_${reason.data.toUpperCase().replaceAll('-', '_')}`
  return { status: 503, error: 'Service Unavailable', message: err.message, code }
}
