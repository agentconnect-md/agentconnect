// Pure projections of a conversation's By decision state and of the errors its save can meet.

import type { DecisionCondition, DecisionValidationIssue } from '@agentconnect.md/protocol/decision'
import type { DecisionUsage } from '@agentconnect.md/protocol/decision-api'
import { ApiError, type ChannelDecisionView } from '@/lib/api'
import type { IntegrationChannelRow } from '@/lib/data'
import { DecisionMockApiError } from './mock-api'

/** What a saved gate's strip reports; `access_revoked` is the disabled reason that outranks readiness. */
export type GateStatus = 'ready' | 'pending_sync' | 'needs_review' | 'daemon_offline' | 'unsupported' | 'access_revoked'

/** A conversation's saved fixed-target gate. */
export interface SavedGate {
  decisionId: string
  when: DecisionCondition
}

/** Why a binding save failed, in the terms the strip renders. */
export type BindingSaveError =
  | { kind: 'invalid'; issues: DecisionValidationIssue[] }
  | { kind: 'invalid_request'; message: string }
  | { kind: 'forbidden' }
  | { kind: 'decision_unavailable' }
  | { kind: 'unsupported' }
  | { kind: 'failed'; message: string }

/** The row's saved gate, or null for any other trigger or a shared-bot routing binding. */
export function savedGateOf(row: Pick<IntegrationChannelRow, 'trigger' | 'decisionBinding'>): SavedGate | null {
  const binding = row.decisionBinding
  if (row.trigger !== 'decision' || binding?.type !== 'gate') return null
  return { decisionId: binding.decisionId, when: binding.when }
}

/** Whether a shared bot's routing, not this row, decides who answers here. */
export function managedByRouting(row: Pick<IntegrationChannelRow, 'trigger' | 'decisionBinding'>): boolean {
  return row.trigger === 'decision' && row.decisionBinding?.type === 'shared_bot_routing'
}

/** A missing view has not been confirmed by any consumer yet, so it reads as pending. */
export function gateStatus(view: ChannelDecisionView | null | undefined): GateStatus {
  if (!view) return 'pending_sync'
  if (view.disabledReason === 'access_revoked') return 'access_revoked'
  return view.readiness.status
}

/** Status, machine code and body of either the live or the mock API's error. */
function errorParts(
  cause: unknown
): { status: number; code?: string; body: Record<string, unknown>; message: string } | null {
  if (cause instanceof ApiError)
    return { status: cause.status, code: cause.code, body: cause.details ?? {}, message: cause.message }
  if (cause instanceof DecisionMockApiError)
    return { status: cause.status, body: { ...cause.body }, message: cause.message }
  return null
}

function issuesOf(body: Record<string, unknown>): DecisionValidationIssue[] {
  return Array.isArray(body.issues) ? (body.issues as DecisionValidationIssue[]) : []
}

export function bindingSaveError(cause: unknown): BindingSaveError {
  const parts = errorParts(cause)
  if (!parts) return { kind: 'failed', message: cause instanceof Error ? cause.message : String(cause) }
  const { status, code, body, message } = parts
  if (status === 400) {
    const issues = issuesOf(body)
    return issues.length ? { kind: 'invalid', issues } : { kind: 'invalid_request', message }
  }
  if (status === 403) return { kind: 'forbidden' }
  if (status === 404 && code === 'DECISION_NOT_FOUND') return { kind: 'decision_unavailable' }
  if (status === 409 && code === 'DECISION_UNSUPPORTED_CONSUMER') return { kind: 'unsupported' }
  return { kind: 'failed', message }
}

/** A delete refused because the Decision is still used, with the usages the refusal lists. */
export function decisionInUse(
  cause: unknown
): { message: string; usages: DecisionUsage[]; hiddenUsageCount: number } | null {
  const parts = errorParts(cause)
  if (!parts || parts.status !== 409 || !Array.isArray(parts.body.usages)) return null
  const hidden = parts.body.hiddenUsageCount
  return {
    message: parts.message,
    usages: parts.body.usages as DecisionUsage[],
    hiddenUsageCount: typeof hidden === 'number' ? hidden : 0
  }
}
