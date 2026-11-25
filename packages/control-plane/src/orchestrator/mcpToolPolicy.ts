// Pure per-agent MCP tool policy logic: grouping, save-time expansion and drift (mcp-tool-permissions.md §3, §5.2, §5.3).
import {
  MCP_TOOL_LIST_MAX,
  type McpCatalogTool,
  type McpToolDecisions,
  type McpToolPolicy
} from '@agentconnect.md/protocol'
import type { AgentMcpToolPolicyRecord, McpGrantCustody, McpToolDecision, McpToolGroup } from '../persistence/ports.js'

export const MCP_TOOL_DECISIONS = ['allow', 'approval', 'ask', 'block'] as const satisfies readonly McpToolDecision[]
export const MCP_TOOL_GROUPS = ['readOnly', 'write', 'other'] as const satisfies readonly McpToolGroup[]

/** The catalog fields grouping reads. */
export type CatalogToolView = Pick<McpCatalogTool, 'name' | 'readOnlyHint'>

/** The expanded decision table a policy row stores. */
export interface ExpandedToolTable {
  allowTools: string[]
  approvalTools: string[]
  askTools: string[]
}

/** The group a tool lands in: only an explicit `readOnlyHint` sorts it; an absent hint is Other (§3.1). */
export function toolGroup(tool: CatalogToolView): McpToolGroup {
  if (tool.readOnlyHint === true) return 'readOnly'
  if (tool.readOnlyHint === false) return 'write'
  return 'other'
}

/** One tool's decision: its override, else its group's. */
export function toolDecision(
  tool: CatalogToolView,
  groups: Record<McpToolGroup, McpToolDecision>,
  overrides: Record<string, McpToolDecision>
): McpToolDecision {
  return overrides[tool.name] ?? groups[toolGroup(tool)]
}

const byteOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Save-time expansion (§5.2): catalog names by decision plus every override name by decision, sorted; without a catalog, overrides alone. */
export function expandToolPolicy(
  groups: Record<McpToolGroup, McpToolDecision>,
  overrides: Record<string, McpToolDecision>,
  catalog: readonly CatalogToolView[] = []
): ExpandedToolTable {
  const decided = new Map<string, McpToolDecision>()
  for (const tool of catalog) decided.set(tool.name, toolDecision(tool, groups, overrides))
  for (const [name, decision] of Object.entries(overrides)) decided.set(name, decision)
  const named = (d: McpToolDecision) =>
    [...decided]
      .filter(([, decision]) => decision === d)
      .map(([name]) => name)
      .sort(byteOrder)
  return { allowTools: named('allow'), approvalTools: named('approval'), askTools: named('ask') }
}

/** What a catalog refresh would change for a saved policy; reported, never applied (§5.3). */
export interface ToolPolicyDrift {
  /** Listed tools in no table that a re-save would no longer block. */
  newTools: string[]
  /** Table names whose decision a re-save would change, such as a tool whose group changed. */
  changedTools: string[]
  /** Table names the upstream no longer lists. */
  missingTools: string[]
}

/** Compare a saved table against a re-expansion over the current catalog. */
export function toolPolicyDrift(
  policy: Pick<AgentMcpToolPolicyRecord, 'groups' | 'overrides' | 'allowTools' | 'approvalTools' | 'askTools'>,
  catalog: readonly CatalogToolView[]
): ToolPolicyDrift {
  const saved = savedDecisions(policy)
  const listed = new Set(catalog.map((tool) => tool.name))
  const newTools: string[] = []
  const changedTools: string[] = []
  for (const tool of catalog) {
    const now = toolDecision(tool, policy.groups, policy.overrides)
    const was = saved.get(tool.name)
    if (was === undefined) {
      if (now !== 'block') newTools.push(tool.name)
    } else if (was !== now) changedTools.push(tool.name)
  }
  const missingTools = [...saved.keys()].filter((name) => !listed.has(name))
  return {
    newTools: newTools.sort(byteOrder),
    changedTools: changedTools.sort(byteOrder),
    missingTools: missingTools.sort(byteOrder)
  }
}

function savedDecisions(
  policy: Pick<AgentMcpToolPolicyRecord, 'allowTools' | 'approvalTools' | 'askTools'>
): Map<string, McpToolDecision> {
  const saved = new Map<string, McpToolDecision>()
  for (const name of policy.allowTools) saved.set(name, 'allow')
  for (const name of policy.approvalTools) saved.set(name, 'approval')
  for (const name of policy.askTools) saved.set(name, 'ask')
  return saved
}

/** The relay table a grant of this custody is judged by: a `runtime` grant blocks the approval-gated names (§5.6). */
export function relayToolPolicy(
  policy: Pick<AgentMcpToolPolicyRecord, 'allowTools' | 'approvalTools' | 'askTools'>,
  custody: McpGrantCustody
): McpToolPolicy {
  return custody === 'daemon'
    ? { allow: policy.allowTools, approval: policy.approvalTools, ask: policy.askTools }
    : { allow: policy.allowTools, approval: [], ask: [] }
}

/** The decision table an agent-scoped definition carries: a `runtime` grant sends approval-gated names as Blocked (§8), and `block` lists the other catalog names. */
export function definitionToolDecisions(
  policy: Pick<AgentMcpToolPolicyRecord, 'allowTools' | 'approvalTools' | 'askTools'>,
  custody: McpGrantCustody,
  catalog: readonly CatalogToolView[] = []
): McpToolDecisions {
  const table = relayToolPolicy(policy, custody)
  const decided = new Set([...table.allow, ...table.approval, ...table.ask])
  const gated = custody === 'daemon' ? [] : [...policy.approvalTools, ...policy.askTools]
  const block = [...new Set([...gated, ...catalog.map((tool) => tool.name)])].filter((name) => !decided.has(name))
  // The wire caps each list; a name past the cap is in no list, which the relay refuses anyway.
  return { ...table, block: block.sort(byteOrder).slice(0, MCP_TOOL_LIST_MAX) }
}
