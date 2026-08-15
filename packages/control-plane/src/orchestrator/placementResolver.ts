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
 *
 * The inverse query — member→agents — is `servedAgents.ts`, which reads the same two relations
 * from the other side; its header states the biconditional the pair has to satisfy and names the
 * test that pins it.
 */
import { dutyEligibility, placementTargets, type PlacementRef } from '../domain/placement.js'
import { AgentId, type DaemonId } from '../domain/ids.js'
import { systemClock, type Clock } from '../domain/clock.js'

/**
 * The duty-ledger reads the resolver needs. TWO of them, and the difference is the point:
 *
 * - `holdersOf` — every live lease. Who must RECEIVE the agent's updates, and who may act for it.
 *   A member that is still installing is included, because it has to receive its bundle to finish.
 * - `confirmedHoldersOf` — only holds the member has reported in its digest. Who INGRESS may be
 *   addressed at. Publishing a member here before it has admitted the grant is the same error
 *   #976 fixed for the fence — the gate opens before the fact — and on a projection there is no
 *   second chance: a cross-daemon peer wake forwards once and gets a terminal miss.
 */
export interface DutyHolderReader {
  holdersOf(agentId: AgentId, now: Date): Promise<DaemonId[]>
  confirmedHoldersOf(agentId: AgentId, now: Date): Promise<DaemonId[]>
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

  private confirmedHolders(agentId: string): Promise<DaemonId[]> {
    if (!this.deps.duties) return Promise.resolve([])
    return this.deps.duties.confirmedHoldersOf(AgentId(agentId), new Date(this.deps.clock.now()))
  }

  /**
   * Every daemon INGRESS may be addressed at. `servingDaemons` minus the holds the member has not
   * confirmed yet — a grant it has not installed is a lease, not a route.
   *
   * Between a grant and its first digest this names NOBODY for a pool agent. For platform ingress
   * that is fully covered — the trigger reaches a member and claims through the activation
   * rendezvous. For a cross-daemon peer wake it is NOT covered, and the honest reason to prefer it
   * anyway is narrower than "absence is retryable", because absence is terminal too
   * (`admits()` fails closed on an agent missing from the directory, so the wake is refused
   * locally as `not_allowed`): naming the installing member instead makes the relay AND the target
   * cache a terminal `not_found` against that `deliveryId`, so even a retransmit stays dead after
   * the member is ready. Absence refuses the attempt without poisoning the next one.
   *
   * Closing it properly needs a retryable verdict on `rd/agentmsg`, which that wire does not have
   * — see the PR body; it is its own change.
   */
  async routableDaemons(agent: ResolvableAgent): Promise<string[]> {
    return [...new Set([...placementTargets(agent), ...(await this.confirmedHolders(agent.id))])]
  }

  /** The one daemon an ingress projection should name, or null when nothing may be addressed. */
  async routableDaemon(agent: ResolvableAgent): Promise<DaemonId | null> {
    return ((await this.routableDaemons(agent))[0] as DaemonId | undefined) ?? null
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
      // ROUTABLE, not serving: this directory is what a cross-daemon peer wake is addressed
      // through, and it forwards once.
      const daemonId = await this.routableDaemon({ ...row, id: row.agentId })
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
    const routable = await this.routableDaemon(agent)
    if (routable) return routable
    if (dutyEligibility(agent).scope !== 'install-wide') return null
    return ((this.deps.liveMembers?.() ?? [])[0] as DaemonId | undefined) ?? null
  }
}

/** The resolver a graph with no duty ledger gets: placement alone, which is exactly the pre-duty
 *  behavior. Consumers default to it so a pool-less composition needs no wiring at all. */
export const PLACEMENT_ONLY = new PlacementResolver({ clock: systemClock })
