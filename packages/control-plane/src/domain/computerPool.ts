// Managed computers in the Kubernetes pool (computer-use.md §15.1): phases, timings and the controller's pure decisions.
import {
  COMPUTER_ALLOCATIONS,
  ComputerPolicySchema,
  type ComputerAllocation,
  type ComputerManagedMode,
  type ComputerPolicy,
  type ComputerPoolClaimState,
  type ComputerStatus
} from '@agentconnect.md/protocol'
import { isComputerReachable } from './computer.js'

export { COMPUTER_ALLOCATIONS, type ComputerAllocation, type ComputerManagedMode }

/** The pool controller's own phase of one managed computer; the live status stays the channel's. */
export const COMPUTER_POOL_PHASES = [
  'provisioning',
  'registering',
  'awake',
  'sleeping',
  'waking',
  'failed',
  'reclaiming'
] as const
export type ComputerPoolPhase = (typeof COMPUTER_POOL_PHASES)[number]

export const isComputerPoolPhase = (value: unknown): value is ComputerPoolPhase =>
  typeof value === 'string' && (COMPUTER_POOL_PHASES as readonly string[]).includes(value)

export interface ComputerPoolTimings {
  /** A claim whose pod is not running and registered by then has failed. */
  provisionTimeoutMs: number
  /** A registered pod whose channel has not come online by then has failed. */
  registerTimeoutMs: number
  /** A woken pod that is not back online by then goes back to sleep. */
  wakeTimeoutMs: number
  /** An ephemeral computer idle this long is reclaimed. */
  ephemeralIdleMs: number
  /** A per-agent or manual computer idle this long sleeps. */
  sleepIdleMs: number
  /** An awake computer offline this long is woken again (its pod was evicted or restarted). */
  offlineGraceMs: number
  /** A desktop claim with no Computer row is deleted once it is this old. */
  orphanGraceMs: number
}

export const DEFAULT_COMPUTER_POOL_TIMINGS: ComputerPoolTimings = {
  provisionTimeoutMs: 5 * 60_000,
  registerTimeoutMs: 2 * 60_000,
  wakeTimeoutMs: 5 * 60_000,
  ephemeralIdleMs: 10 * 60_000,
  sleepIdleMs: 30 * 60_000,
  offlineGraceMs: 60_000,
  orphanGraceMs: 10 * 60_000
}

/** Failure codes kept in `poolError` before the message, so a later acquire can name the cause. */
export type ComputerPoolFailure = 'volume_missing' | 'failed'

export const poolError = (code: ComputerPoolFailure, message: string): string => `${code}: ${message}`.slice(0, 500)

export function poolErrorCode(error: string | null | undefined): ComputerPoolFailure | undefined {
  if (!error) return undefined
  return error.startsWith('volume_missing:') ? 'volume_missing' : 'failed'
}

export const poolErrorMessage = (error: string): string => error.replace(/^(volume_missing|failed): /, '')

/** A desktop made by and for an agent asks no approvals: it is isolated and fresh, and nothing on it is a person's (§15.1). */
export function managedComputerPolicy(ownerUserId: string, base?: ComputerPolicy): ComputerPolicy {
  const policy =
    base ??
    ComputerPolicySchema.parse({
      approvals: { firstInputPerSession: false, launchApp: 'never-ask', submitLikeKeys: false }
    })
  const members = [ownerUserId, ...policy.allowedMembers.filter((id) => id !== ownerUserId)]
  return { ...policy, allowedMembers: members }
}

/** The pool's view of one managed row. */
export interface PoolRow {
  allocation: ComputerAllocation
  phase: ComputerPoolPhase
  phaseAt: number
  activeAt: number
  /** The presented status (stale reads as offline). */
  status: ComputerStatus
  lastSeenAt: number | null
}

export type SweepAction =
  | { kind: 'none' }
  | { kind: 'advance' }
  | { kind: 'sleep' }
  | { kind: 'reclaim'; reason: string }
  | { kind: 'timeout'; message: string }

/** What one sweep does with a row; `leaseHeld` is whether a session holds its control lease now. */
export function sweepAction(
  row: PoolRow,
  leaseHeld: boolean,
  now: number,
  t: ComputerPoolTimings = DEFAULT_COMPUTER_POOL_TIMINGS
): SweepAction {
  const inPhase = now - row.phaseAt
  switch (row.phase) {
    case 'provisioning':
      return inPhase > t.provisionTimeoutMs
        ? { kind: 'timeout', message: 'the desktop pod never became ready' }
        : { kind: 'advance' }
    case 'registering':
      return inPhase > t.registerTimeoutMs
        ? { kind: 'timeout', message: 'the desktop never registered with the Control Plane' }
        : { kind: 'advance' }
    case 'waking':
      return inPhase > t.wakeTimeoutMs
        ? { kind: 'timeout', message: 'the desktop did not come back online' }
        : { kind: 'advance' }
    case 'reclaiming':
      return { kind: 'advance' }
    case 'sleeping':
    case 'failed':
      return { kind: 'none' }
    case 'awake': {
      const idle =
        !leaseHeld && now - row.activeAt > (row.allocation === 'ephemeral' ? t.ephemeralIdleMs : t.sleepIdleMs)
      if (idle) return row.allocation === 'ephemeral' ? { kind: 'reclaim', reason: 'idle' } : { kind: 'sleep' }
      // A pod that went away under an awake row (eviction, node loss) is started again.
      if (!isComputerReachable(row.status) && row.status !== 'revoked') {
        const since = row.lastSeenAt ?? row.phaseAt
        if (now - since > t.offlineGraceMs) return { kind: 'advance' }
      }
      return { kind: 'none' }
    }
  }
}

/** Where provisioning stands after a member's answer about the claim. */
export type ProvisionStep =
  { kind: 'wait' } | { kind: 'register' } | { kind: 'registered' } | { kind: 'fail'; message: string }

export function provisionStep(state: ComputerPoolClaimState | undefined, computerId: string): ProvisionStep {
  if (!state) return { kind: 'wait' }
  if (state.pod === 'failed')
    return { kind: 'fail', message: `the desktop pod cannot start${state.detail ? `: ${state.detail}` : ''}` }
  if (state.pod !== 'running') return { kind: 'wait' }
  if (state.registered === false) return { kind: 'register' }
  if (state.registered === true) {
    if (state.registeredComputerId && state.registeredComputerId !== computerId)
      return { kind: 'fail', message: 'the desktop pod is registered as another computer' }
    return { kind: 'registered' }
  }
  return { kind: 'wait' }
}

/** The name a pool-made computer gets. */
export function managedComputerName(allocation: ComputerManagedMode, agentName: string): string {
  const label = allocation === 'ephemeral' ? 'session desktop' : 'desktop'
  return `${agentName.slice(0, 160)} ${label}`
}
