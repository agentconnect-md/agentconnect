/**
 * `servedAgents` — the ONE answer to "which agents does this daemon serve".
 *
 * The daemon-side twin of `AgentDelivery.daemonsFor`: `pinned-to-me ∪ agents in
 * the duties I hold`. #978 introduced that union inside `Placement.reconcile` for
 * the roster; anything else keyed on "what this daemon serves" — the MCP and
 * external-memory definitions the roster ships, and the inbound ownership gate on
 * daemon-reported memory facts — has to use the same one or a duty holder is
 * served an agent whose definitions, or whose probe reports, silently do not
 * belong to it. Recomputing it per caller is exactly the drift to avoid.
 */
import type { AgentRecord, AgentRepo } from '../persistence/ports.js'
import type { AgentId, DaemonId } from '../domain/ids.js'

/** The duty ledger read behind the union's second half. */
export interface DutyHeldAgentReader {
  heldAgentIds(holder: DaemonId, now: Date): Promise<AgentId[]>
}

export interface ServedAgentsDeps {
  agents: Pick<AgentRepo, 'listForDaemon' | 'listByIds'>
  /** Absent (tests / no pool) ⇒ the placement half alone, the pre-duty behavior. */
  duties?: DutyHeldAgentReader
  now: Date
}

export interface ServedAgents {
  /** The duty half on its own — dependents keyed by agent id ride it directly. */
  heldAgentIds: AgentId[]
  /** The union, deduped, placement first. */
  agents: AgentRecord[]
}

export async function servedAgents(daemonId: DaemonId, deps: ServedAgentsDeps): Promise<ServedAgents> {
  const heldAgentIds = deps.duties ? await deps.duties.heldAgentIds(daemonId, deps.now) : []
  const [placed, held] = await Promise.all([deps.agents.listForDaemon(daemonId), deps.agents.listByIds(heldAgentIds)])
  const byId = new Map(placed.map((agent) => [agent.id as string, agent]))
  for (const agent of held) if (!byId.has(agent.id)) byId.set(agent.id, agent)
  return { heldAgentIds, agents: [...byId.values()] }
}
