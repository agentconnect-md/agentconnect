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

/** Saving these acts as Blocked until approvals ship (§13 stage 6), so the console offers them disabled. */
export const PENDING_DECISIONS: ReadonlySet<McpToolDecision> = new Set(['approval', 'ask'])

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

export type McpToolPreset = 'full' | 'readOnly' | 'custom'

export const ALL_ALLOWED: McpToolGroupDecisions = { readOnly: 'allow', write: 'allow', other: 'allow' }
export const READ_ONLY_GROUPS: McpToolGroupDecisions = { readOnly: 'allow', write: 'block', other: 'block' }

export const sameGroups = (a: McpToolGroupDecisions, b: McpToolGroupDecisions) =>
  MCP_TOOL_GROUPS.every((g) => a[g] === b[g])

export function sameOverrides(a: Record<string, McpToolDecision>, b: Record<string, McpToolDecision>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
}

/** The preset a saved policy reads as; no policy is Full access. */
export function presetOf(policy: Pick<AgentMcpToolPolicyDto, 'groups' | 'overrides'> | null): McpToolPreset {
  if (!policy) return 'full'
  return sameGroups(policy.groups, READ_ONLY_GROUPS) && Object.keys(policy.overrides).length === 0
    ? 'readOnly'
    : 'custom'
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
