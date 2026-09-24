import {
  HOOK_DECISION_ROUTING_V1_FEATURE,
  decisionChainIds,
  decisionRoutingIssues,
  isCodeHostRoutingScope,
  supportsDecision,
  type CodeHostRoutingFamily,
  type CodeHostRoutingProvider,
  type DecisionValidationIssue,
  type HookRoutingProjection
} from '@agentconnect.md/protocol'
import type { OrgId } from '../domain/ids.js'
import type { CodeHostDecisionRoutingRecord, CodeHostRoutingScope, HookRecord } from '../persistence/ports.js'

/** The projection's member bound (HookRoutingProjection.members). */
export const HOOK_ROUTING_MAX_MEMBERS = 64

export type HookRoutingStatus = 'enabled' | 'needs_review' | 'access_revoked'

/** Whether (provider, family) names a routable scope, narrowing both. */
export function isRoutingScope(provider: string, family: string | null | undefined): family is CodeHostRoutingFamily {
  return isCodeHostRoutingScope(provider, family)
}

type RoutingConfig = Pick<
  CodeHostDecisionRoutingRecord,
  'orgId' | 'decisionId' | 'config' | 'needsReview' | 'definition' | 'definitions'
>

function routingDefinitions(record: RoutingConfig) {
  return new Map(
    [...(record.definitions ?? []), ...(record.definition ? [record.definition] : [])].map((d) => [d.id, d])
  )
}

/** The routing scope a hook row belongs to; null for a generic webhook or a family its provider does not route. */
export function routingScopeOf(
  hook: Pick<HookRecord, 'orgId' | 'kind' | 'repoId' | 'family'>
): CodeHostRoutingScope | null {
  if (hook.repoId === null || !isRoutingScope(hook.kind, hook.family)) return null
  return {
    orgId: hook.orgId as OrgId,
    provider: hook.kind as CodeHostRoutingProvider,
    repoId: hook.repoId,
    family: hook.family
  }
}

type MemberHook = Pick<HookRecord, 'id' | 'agentId' | 'kind' | 'enabled' | 'repoId' | 'family'>

/** A scope's members: every enabled hook of the scope's provider on the repository whose one subject family is the scope's. */
export function routingMembers<H extends MemberHook>(
  hooks: readonly H[],
  scope: { provider: CodeHostRoutingProvider; repoId: bigint; family: CodeHostRoutingFamily }
): Array<H & { agentId: NonNullable<H['agentId']> }> {
  return hooks
    .filter(
      (h): h is H & { agentId: NonNullable<H['agentId']> } =>
        h.kind === scope.provider &&
        h.enabled &&
        h.agentId !== null &&
        h.repoId === scope.repoId &&
        h.family === scope.family
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Why a stored routing cannot execute as saved; empty when it can (pause aside). */
export function hookRoutingIssues(
  record: RoutingConfig,
  memberAgentIds: ReadonlySet<string>
): DecisionValidationIssue[] {
  const definition = record.definition
  if (!definition || definition.id !== record.decisionId || definition.orgId !== record.orgId)
    return [{ path: ['decisionId'], message: 'The Decision is unavailable.' }]
  if (!record.config) return [{ path: [], message: 'Save the routing configuration again.' }]
  const definitions = routingDefinitions(record)
  const issues = decisionRoutingIssues(
    definition.question,
    record.config,
    new Map([...definitions].map(([id, d]) => [id, d.question]))
  )
  if (record.needsReview) issues.push({ path: [], message: 'The Decision changed; review the routing rules.' })
  for (const [index, step] of [record.config, ...(record.config.steps ?? [])].entries()) {
    const path = index ? ['steps', index - 1] : []
    const d = definitions.get(step.decisionId)
    if (!d || d.orgId !== record.orgId || !supportsDecision(d))
      issues.push({ path: [...path, 'decisionId'], message: 'The Decision is unavailable or unsupported.' })
    step.rules.forEach((rule, i) => {
      if (rule.action.type === 'agent' && !memberAgentIds.has(rule.action.agentId))
        issues.push({ path: [...path, 'rules', i, 'action'], message: 'Choose an agent that watches this repository.' })
    })
  }
  return issues
}

/** The routing's executable state; pause is the config's own `enabled` and is not a status. */
export function hookRoutingStatus(record: RoutingConfig, memberAgentIds: ReadonlySet<string>): HookRoutingStatus {
  const definitions = routingDefinitions(record)
  if (decisionChainIds(record.config ?? record).some((id) => definitions.get(id)?.orgId !== record.orgId))
    return 'access_revoked'
  return hookRoutingIssues(record, memberAgentIds).length > 0 ? 'needs_review' : 'enabled'
}

/** The host's copy of one scope: none while paused or unresolvable, disabled while it needs review so the host holds. */
export function hookRoutingProjection(
  record: CodeHostDecisionRoutingRecord,
  members: ReadonlyArray<Pick<HookRecord, 'id'> & { agentId: string }>
): HookRoutingProjection | null {
  if (!record.enabled || !record.config || !record.definition) return null
  const status = hookRoutingStatus(record, new Set(members.map((m) => m.agentId)))
  if (status === 'access_revoked') return null
  return {
    routingId: record.id,
    provider: record.provider,
    repoId: record.repoId.toString(),
    repoFullName: record.repoFullName,
    family: record.family,
    config: status === 'enabled' ? record.config : { ...record.config, enabled: false },
    definition: record.definition,
    ...(record.definitions ? { definitions: record.definitions } : {}),
    members: members.slice(0, HOOK_ROUTING_MAX_MEMBERS).map((m) => ({ agentId: m.agentId, hookId: m.id }))
  }
}

/** One member the host choice weighs: its placement, the serving daemon's live features, and both creation times. */
export interface HostCandidate {
  agentId: string
  agentCreatedAt: number
  daemonId: string | null
  daemonCreatedAt?: number | undefined
  /** Undefined while the daemon is not connected: its support is unknown, not refused. */
  features?: readonly string[] | undefined
}

function earliest(candidates: readonly HostCandidate[]): HostCandidate | undefined {
  return [...candidates].sort(
    (a, b) =>
      (a.daemonCreatedAt ?? Number.POSITIVE_INFINITY) - (b.daemonCreatedAt ?? Number.POSITIVE_INFINITY) ||
      a.agentCreatedAt - b.agentCreatedAt ||
      (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0)
  )[0]
}

/** The host (§3.2): a live supporting incumbent, else the earliest supporting member, else an offline incumbent, else the earliest placed. */
export function chooseEvaluationAgent(
  current: string | null,
  candidates: readonly HostCandidate[],
  required: readonly string[] = [HOOK_DECISION_ROUTING_V1_FEATURE]
): string | null {
  const supports = (c: HostCandidate) => c.features !== undefined && required.every((f) => c.features!.includes(f))
  const placed = candidates.filter((c) => c.daemonId !== null)
  const incumbent = current ? placed.find((c) => c.agentId === current) : undefined
  if (incumbent && supports(incumbent)) return incumbent.agentId
  const supported = earliest(placed.filter(supports))
  if (supported) return supported.agentId
  if (incumbent && incumbent.features === undefined) return incumbent.agentId
  return earliest(placed)?.agentId ?? null
}
