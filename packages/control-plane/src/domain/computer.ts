// The Computer resource's closed vocabularies, policy and capabilities (docs/designs/computer-use.md §2.2, §4.1).
import {
  COMPUTER_ACCESS_AGENTS_MAX,
  ComputerCapabilitiesSchema,
  ComputerDoctorReport,
  agentAccessGrants,
  normalizeAgentAccess,
  type ComputerAgentAccess,
  ComputerPolicySchema,
  type ComputerCapabilities,
  type ComputerPolicy,
  type ComputerStatus
} from '@agentconnect.md/protocol'

// The vocabularies, policy and capabilities are wire contracts, so the protocol package owns them.
export {
  COMPUTER_ACCESS_AGENTS_MAX,
  COMPUTER_KINDS,
  COMPUTER_ISOLATIONS,
  COMPUTER_OSES,
  COMPUTER_SESSIONS,
  COMPUTER_STATUSES,
  ComputerApprovalsSchema,
  ComputerCapabilitiesSchema,
  ComputerDoctorReport,
  ComputerPolicySchema,
  ComputerAgentAccess,
  COMPUTER_AGENT_ACCESS_MODES,
  agentAccessGrants,
  normalizeAgentAccess,
  type ComputerAgentAccessMode,
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

/** A Selected agent access past the cap; the write is refused whole, so the stored list never exceeds what the DTO admits. */
export class TooManyComputerAgents extends Error {
  constructor() {
    super(`a computer lists at most ${COMPUTER_ACCESS_AGENTS_MAX} agents; grant it to all agents instead`)
  }
}

/** The stored form of an access write, refusing a Selected list over the cap. */
export function cappedAgentAccess(access: ComputerAgentAccess): ComputerAgentAccess {
  const normalized = normalizeAgentAccess(access)
  if (normalized.agents.length > COMPUTER_ACCESS_AGENTS_MAX) throw new TooManyComputerAgents()
  return normalized
}

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

/** Whether a presented status can take a call now: not offline, sleeping or revoked. */
export const isComputerReachable = (status: ComputerStatus): boolean =>
  status !== 'offline' && status !== 'sleeping' && status !== 'revoked'

/** The status to show and to gate on: a stale live one has gone offline, and a console Stop reads as paused. */
export function presentComputerStatus(
  c: { status: ComputerStatus; lastSeenAt: Date | null; stoppedAt?: Date | null },
  nowMs: number,
  staleAfterMs = COMPUTER_STALE_AFTER_MS
): ComputerStatus {
  if (c.status === 'offline' || c.status === 'sleeping' || c.status === 'revoked') return c.status
  if (!c.lastSeenAt || nowMs - c.lastSeenAt.getTime() > staleAfterMs) return 'offline'
  if (c.stoppedAt && c.status !== 'human_in_control') return 'paused'
  return c.status
}

/** Whether a Computer admits this agent (§4.1): its agent access lists the agent or grants every agent. */
export const computerGrantsAgent = (c: { agentAccess: ComputerAgentAccess }, agentId: string): boolean =>
  agentAccessGrants(c.agentAccess, agentId)

/** A per-agent or ephemeral computer's access is fixed to the agent it was made for (§15.1). */
export const agentAccessIsFixed = (c: { allocation: string | null }): boolean =>
  c.allocation === 'per-agent' || c.allocation === 'ephemeral'

/** Reads the stored agent access columns; an unknown mode reads as none. */
export function readAgentAccess(mode: string, agentIds: readonly string[]): ComputerAgentAccess {
  if (mode === 'all') return { mode: 'all', agents: [] }
  if (mode === 'selected') return normalizeAgentAccess({ mode: 'selected', agents: [...agentIds] })
  return { mode: 'none', agents: [] }
}

/** The agents whose derived Computer list a change of access moves: every agent when either side is All. */
export function agentsAffectedByAccess(before: ComputerAgentAccess, after: ComputerAgentAccess): 'all' | string[] {
  if (before.mode === 'all' || after.mode === 'all') return before.mode === after.mode ? [] : 'all'
  const was = new Set(before.agents)
  const now = new Set(after.agents)
  return [...new Set([...was, ...now])].filter((id) => was.has(id) !== now.has(id))
}

/** An agent's usable Computers, in the order the grants were read: every one whose access admits it (§4.1). */
export const derivedComputerIds = (
  grants: readonly { id: string; agentAccess: ComputerAgentAccess }[],
  agentId: string
): string[] => grants.filter((g) => agentAccessGrants(g.agentAccess, agentId)).map((g) => g.id)
