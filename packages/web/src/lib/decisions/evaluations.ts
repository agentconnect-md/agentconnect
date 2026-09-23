// Pure projections of Recent evaluations rows (decisions.md §9.5) for the console.

import type { DecisionAnswerSummary, DecisionEvaluationOutcome } from '@agentconnect.md/protocol/decision'

const percent = (value: number): string => `${Math.round(value * 100)}%`
const scoreText = (value: number): string => String(Math.round(value * 100) / 100)

/** One line for a summary answer: the value and its confidence, or null when the row kept none. */
export function answerText(
  summary: DecisionAnswerSummary | null | undefined,
  words: { yes: string; no: string }
): string | null {
  if (!summary) return null
  if (summary.type === 'boolean')
    return summary.value
      ? `${words.yes} · ${percent(summary.probability)}`
      : `${words.no} · ${percent(1 - summary.probability)}`
  if (summary.type === 'choice') return `${summary.value} · ${percent(summary.confidence)}`
  return `${scoreText(summary.value)} · ${percent(summary.confidence)}`
}

export type OutcomeTone = 'success' | 'neutral' | 'error' | 'muted' | 'pending'

/** Triggered reads as success, Unavailable as an error distinct from a Skipped neutral. */
export function outcomeTone(outcome: DecisionEvaluationOutcome): OutcomeTone {
  if (outcome === 'triggered') return 'success'
  if (outcome === 'unavailable') return 'error'
  if (outcome === 'canceled') return 'muted'
  if (outcome === 'pending') return 'pending'
  return 'neutral'
}

/** The badge classes for each tone, as complete literals so Tailwind sees them. */
export const OUTCOME_BADGE: Record<OutcomeTone, string> = {
  success: 'bg-(--status-online-soft) text-(--status-online)',
  neutral: 'bg-(--surface-active) text-(--text-secondary)',
  error: 'bg-(--status-error-soft) text-(--red-600)',
  muted: 'bg-(--surface-active) text-(--text-tertiary)',
  pending: 'bg-(--brand-soft) text-(--brand-soft-text)'
}

export const REASON_KEYS = [
  'timeout',
  'capacity',
  'credentials',
  'provider',
  'invalid_response',
  'unsupported_input',
  'stop',
  'cancel',
  'config_changed',
  'integration_removed',
  'binding_removed',
  'delivery_missing',
  'shutdown',
  'ownership',
  'admission',
  'not_member',
  'stopped',
  'routing_disabled',
  'no_agent',
  'off',
  'unsupported',
  'rejected',
  'targets_rejected',
  'no_default',
  'host_reassigned',
  'other'
] as const
export type ReasonKey = (typeof REASON_KEYS)[number]

/** The message key for a stored unavailable or cancel reason; unknown ones fall back to `other`. */
export function cancelReasonKey(reason: string | null | undefined): ReasonKey | null {
  if (!reason) return null
  if (reason.startsWith('admission:')) return 'admission'
  return (REASON_KEYS as readonly string[]).includes(reason) ? (reason as ReasonKey) : 'other'
}

/** Latency as the list prints it: milliseconds under a second, else seconds to one decimal. */
export function latencyText(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}
