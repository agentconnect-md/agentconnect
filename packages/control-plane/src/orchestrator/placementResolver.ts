/**
 * `PlacementResolver` — the ledger-aware half of `domain/placement.ts`, and the ONLY place that
 * answers "which daemons serve this agent right now" once placement stopped being a member id.
 *
 * `domain/placement.ts` answers eligibility from the row alone; this adds the live duty leases, so
 * a `pool` agent — which names no machine — still resolves to the member currently holding it. Two
 * questions, one resolver: delivery/edge targets (`servingDaemons`, `servingDaemon`) and authority
 * (`mayAct`, the "is this agent yours" fence every daemon-originated write applies).
 *
 * No caller branches on the placement kind; a later `group` kind changes only this file and the
 * ledger predicate it mirrors.
 */
import { dutyEligibility, placementTargets, type PlacementRef } from '../domain/placement.js'
import { AgentId, type DaemonId } from '../domain/ids.js'
import { systemClock, type Clock } from '../domain/clock.js'

/** The duty-ledger read the resolver needs — the delivery half of `holdsAgent`. */
export interface DutyHolderReader {
  holdersOf(agentId: AgentId, now: Date): Promise<DaemonId[]>
}

/** An agent as the resolver reads it: its identity plus the placement columns. */
export type ResolvableAgent = PlacementRef & { id: string }

export class PlacementResolver {
  constructor(
    private readonly deps: {
      /** Absent (tests, or a deployment with no pool) ⇒ placement alone, which is the pre-duty behavior. */
      duties?: DutyHolderReader
      /** The install-wide members that are live right now. Only {@link PlacementResolver.dispatchDaemon}
       *  uses it, and only as the rendezvous target — never as a claim of who serves what. */
      liveMembers?: () => string[]
      clock: Clock
    }
  ) {}

  private holders(agentId: string): Promise<DaemonId[]> {
    if (!this.deps.duties) return Promise.resolve([])
    return this.deps.duties.holdersOf(AgentId(agentId), new Date(this.deps.clock.now()))
  }

  /** Every daemon that serves this agent: what placement names, then every live duty holder. */
  async servingDaemons(agent: ResolvableAgent): Promise<string[]> {
    return [...new Set([...placementTargets(agent), ...(await this.holders(agent.id))])]
  }

  /** The one daemon a live edge read should go to, or null when nothing serves the agent. */
  async servingDaemon(agent: ResolvableAgent): Promise<DaemonId | null> {
    return ((await this.servingDaemons(agent))[0] as DaemonId | undefined) ?? null
  }

  /** May this daemon act on the agent's behalf — report its sessions, mint its credentials, ask on
   *  its behalf? True where it is the placement, and true where it holds the agent's duty. */
  async mayAct(agent: ResolvableAgent, daemonId: string): Promise<boolean> {
    return (await this.servingDaemons(agent)).includes(daemonId)
  }

  /**
   * Fill the serving daemon into a directory projection, dropping every row nothing serves right
   * now. The peer directory and the collaboration snapshot both need "who do I wake", which is a
   * live question for a pool agent and a column read for a machine-placed one — so it is answered
   * here once rather than at each surface, where the two could disagree.
   */
  async resolveDirectory<T extends PlacementRef & { agentId: string }>(
    rows: readonly T[]
  ): Promise<(T & { daemonId: string })[]> {
    const resolved: (T & { daemonId: string })[] = []
    for (const row of rows) {
      const daemonId = await this.servingDaemon({ ...row, id: row.agentId })
      if (daemonId) resolved.push({ ...row, daemonId })
    }
    return resolved
  }

  /**
   * Where to send a TRIGGER for this agent. Distinct from {@link PlacementResolver.servingDaemon}
   * on purpose: a pool agent whose lease has lapsed is served by nobody for one lease horizon, and
   * refusing the trigger for that window is what left webchat permanently offline after a rollout
   * (#987). Any live member is a correct target — it claims the agent's group on receipt (the
   * activation rendezvous) and then serves the turn. A machine placement has no such fallback:
   * there is exactly one daemon that may serve it.
   */
  async dispatchDaemon(agent: ResolvableAgent): Promise<DaemonId | null> {
    const serving = await this.servingDaemon(agent)
    if (serving) return serving
    if (dutyEligibility(agent).scope !== 'install-wide') return null
    return ((this.deps.liveMembers?.() ?? [])[0] as DaemonId | undefined) ?? null
  }
}

/** The resolver a graph with no duty ledger gets: placement alone, which is exactly the pre-duty
 *  behavior. Consumers default to it so a pool-less composition needs no wiring at all. */
export const PLACEMENT_ONLY = new PlacementResolver({ clock: systemClock })
