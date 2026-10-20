// The Computer resource's closed vocabularies, policy and capabilities (docs/designs/computer-use.md §2.2, §4.1).
import {
  ComputerCapabilitiesSchema,
  ComputerDoctorReport,
  ComputerPolicySchema,
  type ComputerCapabilities,
  type ComputerPolicy,
  type ComputerStatus
} from '@agentconnect.md/protocol'

// The vocabularies, policy and capabilities are wire contracts, so the protocol package owns them.
export {
  COMPUTER_KINDS,
  COMPUTER_ISOLATIONS,
  COMPUTER_OSES,
  COMPUTER_SESSIONS,
  COMPUTER_STATUSES,
  ComputerApprovalsSchema,
  ComputerCapabilitiesSchema,
  ComputerDoctorReport,
  ComputerPolicySchema,
  type ComputerDoctorCheck,
  type ComputerKind,
  type ComputerIsolation,
  type ComputerOs,
  type ComputerSession,
  type ComputerStatus,
  type ComputerLiveStatus,
  type ComputerCapabilities,
  type ComputerPolicy
} from '@agentconnect.md/protocol'

/** Registration tokens live this long unless the console asks otherwise. */
export const COMPUTER_REGISTRATION_DEFAULT_TTL_MINUTES = 60
export const COMPUTER_REGISTRATION_MAX_TTL_MINUTES = 24 * 60

/** The policy a newly registered Computer starts with: its owner may manage it, no agent may use it yet. */
export function defaultComputerPolicy(ownerUserId: string): ComputerPolicy {
  return ComputerPolicySchema.parse({ allowedMembers: [ownerUserId] })
}

/** Reads a stored policy; a row written by a newer replica keeps its known fields and falls back on the rest. */
export function readComputerPolicy(raw: unknown, ownerUserId: string): ComputerPolicy {
  const parsed = ComputerPolicySchema.safeParse(raw)
  return parsed.success ? parsed.data : defaultComputerPolicy(ownerUserId)
}

/** The owner always stays among the members who may watch, take over and manage (§4.1). */
export function withOwnerMember(policy: ComputerPolicy, ownerUserId: string): ComputerPolicy {
  const members = [ownerUserId, ...policy.allowedMembers.filter((id) => id !== ownerUserId)]
  return { ...policy, allowedMembers: members }
}

/** Reads stored capabilities; an unreadable blob reports nothing rather than failing the read. */
export function readComputerCapabilities(raw: unknown): ComputerCapabilities {
  const parsed = ComputerCapabilitiesSchema.safeParse(raw)
  return parsed.success ? parsed.data : ComputerCapabilitiesSchema.parse({})
}

/** Reads the stored `doctor` report; a missing or unreadable one reads as never reported. */
export function readComputerDoctor(raw: unknown): ComputerDoctorReport | null {
  const parsed = ComputerDoctorReport.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** A live status older than this reads as offline: its channel died without a clean close (three heartbeats). */
export const COMPUTER_STALE_AFTER_MS = 45_000

/** The status to show and to gate on: a live one the channel stopped refreshing has gone offline. */
export function presentComputerStatus(
  c: { status: ComputerStatus; lastSeenAt: Date | null },
  nowMs: number,
  staleAfterMs = COMPUTER_STALE_AFTER_MS
): ComputerStatus {
  if (c.status === 'offline' || c.status === 'revoked') return c.status
  if (!c.lastSeenAt || nowMs - c.lastSeenAt.getTime() > staleAfterMs) return 'offline'
  return c.status
}
