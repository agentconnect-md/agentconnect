// Pure rules of the per-agent MCP tool permissions panel (mcp-tool-permissions.md §3, §10).
import type {
  AgentMcpToolPolicyDto,
  McpCatalogToolDto,
  McpToolDecision,
  McpToolGroup,
  McpToolGroupDecisions
} from '@/lib/api'

export const MCP_TOOL_GROUPS: readonly McpToolGroup[] = ['readOnly', 'write', 'other']
export const MCP_TOOL_DECISIONS: readonly McpToolDecision[] = ['allow', 'approval', 'ask', 'block']

/** The relay and CP failure codes a catalog fetch can record. */
export const MCP_CATALOG_FAILURES = [
  'relay_unavailable',
  'relay_timeout',
  'unreachable',
  'upstream_rejected',
  'timeout',
  'too_large',
  'invalid_response',
  'blocked_address',
  'misconfigured',
  'unknown_provider'
] as const
export type McpCatalogFailureCode = (typeof MCP_CATALOG_FAILURES)[number]

export const isKnownCatalogFailure = (code: string): code is McpCatalogFailureCode =>
  (MCP_CATALOG_FAILURES as readonly string[]).includes(code)

export type McpToolPreset = 'full' | 'readOnly' | 'approveWrites' | 'askWrites' | 'custom'
export const MCP_TOOL_PRESETS: readonly McpToolPreset[] = ['full', 'readOnly', 'approveWrites', 'askWrites', 'custom']

export const ALL_ALLOWED: McpToolGroupDecisions = { readOnly: 'allow', write: 'allow', other: 'allow' }

/** The groups each named preset sets (§3.3); Other is never more permissive than Write/delete. */
export const PRESET_GROUPS: Readonly<Record<'readOnly' | 'approveWrites' | 'askWrites', McpToolGroupDecisions>> = {
  readOnly: { readOnly: 'allow', write: 'block', other: 'block' },
  approveWrites: { readOnly: 'allow', write: 'approval', other: 'approval' },
  askWrites: { readOnly: 'allow', write: 'ask', other: 'ask' }
}

export const sameGroups = (a: McpToolGroupDecisions, b: McpToolGroupDecisions) =>
  MCP_TOOL_GROUPS.every((g) => a[g] === b[g])

export function sameOverrides(a: Record<string, McpToolDecision>, b: Record<string, McpToolDecision>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
}

/** The preset a saved policy reads as; no policy is Full access. */
export function presetOf(policy: Pick<AgentMcpToolPolicyDto, 'groups' | 'overrides'> | null): McpToolPreset {
  if (!policy) return 'full'
  if (Object.keys(policy.overrides).length > 0) return 'custom'
  const named = (['readOnly', 'approveWrites', 'askWrites'] as const).find((p) =>
    sameGroups(policy.groups, PRESET_GROUPS[p])
  )
  return named ?? 'custom'
}

/** A tool's effective decision: its override, else its group's. */
export function resolveDecision(
  tool: Pick<McpCatalogToolDto, 'name' | 'group'>,
  groups: McpToolGroupDecisions,
  overrides: Record<string, McpToolDecision>
): McpToolDecision {
  return overrides[tool.name] ?? groups[tool.group]
}

/** The names a save would store against this catalog, by the control plane's own expansion rule (§5.2). */
export function expandTable(
  groups: McpToolGroupDecisions,
  overrides: Record<string, McpToolDecision>,
  tools: readonly Pick<McpCatalogToolDto, 'name' | 'group'>[]
): Record<'allow' | 'approval' | 'ask', Set<string>> {
  const table = { allow: new Set<string>(), approval: new Set<string>(), ask: new Set<string>() }
  const add = (name: string, decision: McpToolDecision) => {
    if (decision !== 'block') table[decision].add(name)
  }
  for (const tool of tools) add(tool.name, resolveDecision(tool, groups, overrides))
  for (const [name, decision] of Object.entries(overrides)) add(name, decision)
  return table
}

/** Whether saving the same rules against this catalog would store a different table: the catalog changed since the last save. */
export function needsResave(
  policy: Pick<AgentMcpToolPolicyDto, 'groups' | 'overrides' | 'allowTools' | 'approvalTools' | 'askTools'>,
  tools: readonly Pick<McpCatalogToolDto, 'name' | 'group'>[]
): boolean {
  const table = expandTable(policy.groups, policy.overrides, tools)
  const same = (expanded: Set<string>, saved: readonly string[]) =>
    expanded.size === new Set(saved).size && saved.every((name) => expanded.has(name))
  return !(
    same(table.allow, policy.allowTools) &&
    same(table.approval, policy.approvalTools) &&
    same(table.ask, policy.askTools)
  )
}

export type ApprovalDecision = 'approval' | 'ask'

/** The approval decisions a save would store for at least one tool. */
export function approvalDecisionsInUse(
  groups: McpToolGroupDecisions,
  overrides: Record<string, McpToolDecision>,
  tools: readonly Pick<McpCatalogToolDto, 'name' | 'group'>[]
): Set<ApprovalDecision> {
  const table = expandTable(groups, overrides, tools)
  return new Set((['approval', 'ask'] as const).filter((d) => table[d].size > 0))
}

/** Why a runtime's mode refuses approval decisions (§7.3): it asks no one, only its reviewer decides, or its gate is unverified. */
export type ApprovalRefusalReason = 'noAsking' | 'reviewerOnly' | 'unsupported'

export interface ApprovalRefusal {
  reason: ApprovalRefusalReason
  refused: readonly ApprovalDecision[]
}

const BOTH: readonly ApprovalDecision[] = ['approval', 'ask']

/** What the daemon's runtime gate refuses for this runtime and permission mode (§7.3), or null when it can honor both decisions. */
export function approvalRefusal(runtime: string, mode: string): ApprovalRefusal | null {
  const id = runtime.toLowerCase()
  if (!id) return null
  if (id.includes('claude')) return mode === 'dontAsk' ? { reason: 'noAsking', refused: BOTH } : null
  if (!id.includes('codex')) return { reason: 'unsupported', refused: BOTH }
  if (mode === 'read-only' || mode === 'workspace-write') return null
  if (mode === 'agent') return { reason: 'reviewerOnly', refused: ['ask'] }
  // Full access asks no one, and the daemon records nothing in a Codex mode it does not know.
  return { reason: 'noAsking', refused: BOTH }
}

/** Write/delete tools are destructive unless they say otherwise (§3.1). */
export const isDestructive = (tool: Pick<McpCatalogToolDto, 'group' | 'destructiveHint'>) =>
  tool.group === 'write' && tool.destructiveHint !== false

const DAY_MS = 24 * 60 * 60 * 1000

/** A catalog never fetched, or fetched over a day ago, is refreshed when the panel opens. */
export function isCatalogStale(fetchedAt: string | null, now: number): boolean {
  if (!fetchedAt) return true
  const at = Date.parse(fetchedAt)
  return Number.isNaN(at) || now - at > DAY_MS
}

/** Drift worth a banner: new, changed or missing tools. */
export function hasDrift(drift: AgentMcpToolPolicyDto['drift']): drift is NonNullable<AgentMcpToolPolicyDto['drift']> {
  return !!drift && drift.newTools.length + drift.changedTools.length + drift.missingTools.length > 0
}
