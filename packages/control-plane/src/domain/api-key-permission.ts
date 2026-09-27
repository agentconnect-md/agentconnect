// What a key may do and which agents it reaches (daemon-api-key-auth.md §6, Key permissions and agent selection).

/** The wire spelling of a key's permission; `full` is today's behavior and the default. */
export const API_KEY_PERMISSIONS = ['full', 'read', 'agent:chat'] as const
export type ApiKeyPermission = (typeof API_KEY_PERMISSIONS)[number]

/** A permission scoped to agents, so the key's selection applies to it. */
export type AgentLevelPermission = Extract<ApiKeyPermission, 'agent:chat'>

/** What a route declares through its Fastify config: `read` admits a read key on a non-read method and gates writes itself; an agent-level permission admits keys carrying exactly it. */
export type RoutePermission = 'read' | AgentLevelPermission

/** Which agents an agent-level key reaches: every agent, or exactly the rows. An empty selection never means all. */
export interface AgentSelection {
  allAgents: boolean
  agentIds: readonly string[]
}

/** Accepts `unknown` so a token claim can be checked without a cast. */
export function isAgentLevelPermission(permission: unknown): permission is AgentLevelPermission {
  return permission === 'agent:chat'
}

/** GET/HEAD/OPTIONS are non-mutating; everything else is a write for permission purposes. */
export function isReadMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
}

/** Whether a key with `permission` may reach a route, given the route's declaration and the request method. */
export function keyAdmitted(
  permission: ApiKeyPermission,
  method: string,
  declared: RoutePermission | undefined
): boolean {
  if (permission === 'full') return true
  if (permission === 'read') return isReadMethod(method) || declared === 'read'
  return declared === permission
}

/** Whether the selection names `agentId`; consulted for an agent-level permission only, since `full` and `read` reach every agent. */
export function selectionCovers(selection: AgentSelection, agentId: string): boolean {
  return selection.allAgents || selection.agentIds.includes(agentId)
}
