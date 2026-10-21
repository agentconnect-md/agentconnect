import { z } from 'zod'

// Computer control leases (computer-use.md §4.4): one agent session's exclusive, time-limited right to send input.

/** The longest agent name a holder carries; the CP clamps longer display names. */
export const COMPUTER_LEASE_AGENT_NAME_MAX = 200

/** Who holds a lease: one agent session; the agent's name is a display hint for `computer_busy`. */
export const ComputerLeaseHolder = z.object({
  sessionId: z.string().min(1).max(256),
  agentId: z.string().uuid(),
  agentName: z.string().min(1).max(COMPUTER_LEASE_AGENT_NAME_MAX).optional()
})
export type ComputerLeaseHolder = z.infer<typeof ComputerLeaseHolder>

/** The caller name a desktop gives a lease holder: agent and session together, the identity the CP's lease service compares. */
export const computerLeaseHolderName = (holder: { agentId: string; sessionId: string }): string =>
  `${holder.agentId}/${holder.sessionId}`

/** A granted lease; `expiresAt` is its hard cap, and it may end sooner (idle, holder lost, release, pre-emption). */
export const ComputerControlLease = z.object({
  leaseId: z.string().uuid(),
  computerId: z.string().uuid(),
  holder: ComputerLeaseHolder,
  acquiredAt: z.string().datetime(),
  expiresAt: z.string().datetime()
})
export type ComputerControlLease = z.infer<typeof ComputerControlLease>

/** Definite refusals (§5.4): the input was never sent. */
export const COMPUTER_LEASE_REFUSALS = ['computer_busy', 'human_in_control', 'unavailable', 'denied'] as const
export type ComputerLeaseRefusal = (typeof COMPUTER_LEASE_REFUSALS)[number]

/** The longest one `computer-lease/acquire` may hold its reply while queued; the daemon asks again after it. */
export const COMPUTER_LEASE_POLL_MAX_MS = 10_000

/** The longest a Computer's policy may make an acquire wait in its queue (§4.4). */
export const COMPUTER_LEASE_WAIT_MAX_SECONDS = 600

// D→C REQ on the daemon wire: take or renew the lease for one agent session; the same session renews its own.
export const ComputerLeaseAcquire = z.object({
  computerId: z.string().uuid(),
  agentId: z.string().uuid(),
  sessionId: z.string().min(1).max(256),
  // The daemon-clock time of the request, compared with the `event/session` turn end on the same clock.
  requestedAt: z.string().datetime(),
  // Behind COMPUTER_LEASE_QUEUE_FEATURE: wait in the Computer's FIFO queue, holding the reply up to this long.
  waitMs: z.number().int().min(0).max(COMPUTER_LEASE_POLL_MAX_MS).optional()
})
export type ComputerLeaseAcquire = z.infer<typeof ComputerLeaseAcquire>

/** A waiting acquire's place: `position` 1 is next; asking again with the same `requestedAt` keeps it. */
export const ComputerLeaseQueued = z.object({
  position: z.number().int().min(1),
  waitedMs: z.number().int().min(0),
  // Time left before the wait ends in `computer_busy`.
  leftMs: z.number().int().min(0)
})
export type ComputerLeaseQueued = z.infer<typeof ComputerLeaseQueued>

// C→D REP to `computer-lease/acquire`; a refusal names the holder when the Computer is busy, and carries `queued` while it waits.
export const ComputerLeaseAcquireResult = z.discriminatedUnion('granted', [
  z.object({ granted: z.literal(true), lease: ComputerControlLease }),
  z.object({
    granted: z.literal(false),
    code: z.enum(COMPUTER_LEASE_REFUSALS),
    message: z.string().max(500),
    holder: ComputerLeaseHolder.optional(),
    queued: ComputerLeaseQueued.optional()
  })
])
export type ComputerLeaseAcquireResult = z.infer<typeof ComputerLeaseAcquireResult>

// D→C REQ on the daemon wire (reply: generic `ack`): the session gives the lease up; a no-op when it holds none.
export const ComputerLeaseRelease = z.object({
  computerId: z.string().uuid(),
  agentId: z.string().uuid(),
  sessionId: z.string().min(1).max(256)
})
export type ComputerLeaseRelease = z.infer<typeof ComputerLeaseRelease>
