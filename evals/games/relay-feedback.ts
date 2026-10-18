import type { CompiledTopology } from './types.js'

export const RELAY_VARIANTS = ['clean', 'stale', 'duplicate', 'conflict'] as const
export type RelayVariant = (typeof RELAY_VARIANTS)[number]

export interface RelayFeedback {
  id: string
  revision: number
  quantity: number
  format: string
}

export interface RelayTask {
  caseId: string
  sourceId: string
  quantity: number
  format: string
  returnTarget: { platform: string; integrationId: string; channel: string }
}

export interface RelayReport {
  caseId: string
  sourceId: string
  status: 'completed' | 'needs_clarification'
  quantity?: number
  format?: string
  evidenceIds: string[]
}

export function relayFixture(topology: CompiledTopology, variant: RelayVariant) {
  const origin = topology.rooms.find((room) => room.alias === 'discord-origin')!
  const integration = topology.integrations.find((i) => i.agentAlias === 'bridge' && i.platform === 'discord')!
  const quantity = (topology.seed % 9) + 1
  const format = topology.seed % 2 === 0 ? 'csv' : 'json'
  const task: RelayTask = {
    caseId: `relay-${topology.seed}-${variant}`,
    sourceId: `request-${topology.seed}`,
    quantity,
    format,
    returnTarget: { platform: origin.platform, integrationId: integration.integrationId, channel: origin.channel }
  }
  const current: RelayFeedback = {
    id: `feedback-${topology.seed}-1`,
    revision: 1,
    quantity: quantity + 2,
    format: format === 'csv' ? 'json' : 'csv'
  }
  const feedback =
    variant === 'stale'
      ? [current, { id: `feedback-${topology.seed}-0`, revision: 0, quantity, format }]
      : variant === 'duplicate'
        ? [current, { ...current }]
        : variant === 'conflict'
          ? [current, { ...current, id: `feedback-${topology.seed}-conflict`, quantity: quantity + 3 }]
          : [current]
  return { task, feedback }
}

// This scripted policy is a harness control, never the scorer or a real-agent repair step.
export function scriptedRelayReport(task: RelayTask, feedback: RelayFeedback[]): RelayReport {
  const revision = Math.max(...feedback.map((item) => item.revision))
  const current = feedback.filter((item) => item.revision === revision)
  const conflict = current.some((item) => item.quantity !== current[0]!.quantity || item.format !== current[0]!.format)
  return {
    caseId: task.caseId,
    sourceId: task.sourceId,
    status: conflict ? 'needs_clarification' : 'completed',
    ...(!conflict ? { quantity: current[0]!.quantity, format: current[0]!.format } : {}),
    evidenceIds: [...new Set(current.map((item) => item.id))]
  }
}

export function scoreRelayReport(task: RelayTask, feedback: RelayFeedback[], variant: RelayVariant, raw: unknown) {
  const report = raw as Partial<RelayReport> | null
  const record = typeof report === 'object' && report !== null && !Array.isArray(report)
  const ids = record && Array.isArray(report.evidenceIds) ? report.evidenceIds : []
  const revision = Math.max(...feedback.map((item) => item.revision))
  const latest = feedback.filter((item) => item.revision === revision)
  const requiredIds = new Set(latest.map((item) => item.id))
  const evidenceCorrect =
    ids.length === requiredIds.size &&
    new Set(ids).size === ids.length &&
    ids.every((id) => typeof id === 'string' && requiredIds.has(id))
  const sourceCorrect = record && report.caseId === task.caseId && report.sourceId === task.sourceId
  const statusCorrect = record && report.status === (variant === 'conflict' ? 'needs_clarification' : 'completed')
  const requirementsSatisfied =
    record &&
    (variant === 'conflict'
      ? report.quantity === undefined && report.format === undefined
      : report.quantity === latest[0]!.quantity && report.format === latest[0]!.format)
  return {
    sourceCorrect: Boolean(sourceCorrect),
    evidenceCorrect,
    statusCorrect: Boolean(statusCorrect),
    requirementsSatisfied: Boolean(requirementsSatisfied),
    successful: Boolean(sourceCorrect && evidenceCorrect && statusCorrect && requirementsSatisfied)
  }
}
