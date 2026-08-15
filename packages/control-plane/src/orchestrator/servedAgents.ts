/**
 * `servedAgents` — the ONE answer to "which agents does this daemon serve".
 *
 * The daemon-side twin of `PlacementResolver.servingDaemons`: `pinned-to-me ∪ agents in
 * the duties I hold`. #978 introduced that union inside `Placement.reconcile` for
 * the roster; anything else keyed on "what this daemon serves" — the MCP and
 * external-memory definitions the roster ships, and the inbound ownership gate on
 * daemon-reported memory facts — has to use the same one or a duty holder is
 * served an agent whose definitions, or whose probe reports, silently do not
 * belong to it. Recomputing it per caller is exactly the drift to avoid.
 *
 * ## Why this is not expressible over the resolver, and what keeps them honest
 *
 * The two are inverse queries over the same two relations, not one function and a wrapper:
 * this one is member→agents, the resolver is agent→members. Neither can be written as the
 * other without scanning the opposite side, so both exist — and the invariant that matters is
 * that they never disagree:
 *
 *   `D ∈ servingDaemons(A)` ⟺ `A ∈ servedAgents(D).agents`
 *
 * It holds because each half reads ONE predicate from its own side:
 *
 * | Half      | member→agents (here)                    | agent→members (resolver)          |
 * | --------- | --------------------------------------- | --------------------------------- |
 * | placement | `listForDaemon` (`placementKind:'daemon'`, `daemonId`) | `placementTargets` (`domain/placement.ts`) |
 * | duty      | `heldAgentIds(holder, now)`             | `holdersOf(agentId, now)`         |
 *
 * Both duty reads are the same live-lease join in `duty-group.repo.ts`, and both placement
 * reads are now the same `(kind, ref)` pair rather than `daemonId` alone. `servedAgents.test.ts`
 * pins the biconditional over a fixture that mixes machine, pool and unplaced agents.
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
