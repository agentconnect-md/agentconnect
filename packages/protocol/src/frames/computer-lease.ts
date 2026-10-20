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

// D→C REQ on the daemon wire: take or renew the lease for one agent session; the same session renews its own.
export const ComputerLeaseAcquire = z.object({
  computerId: z.string().uuid(),
  agentId: z.string().uuid(),
  sessionId: z.string().min(1).max(256),
  // The daemon-clock time of the request, compared with the `event/session` turn end on the same clock.
  requestedAt: z.string().datetime()
})
export type ComputerLeaseAcquire = z.infer<typeof ComputerLeaseAcquire>

// C→D REP to `computer-lease/acquire`; a refusal names the holder when the Computer is busy.
export const ComputerLeaseAcquireResult = z.discriminatedUnion('granted', [
  z.object({ granted: z.literal(true), lease: ComputerControlLease }),
  z.object({
    granted: z.literal(false),
    code: z.enum(COMPUTER_LEASE_REFUSALS),
    message: z.string().max(500),
    holder: ComputerLeaseHolder.optional()
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
