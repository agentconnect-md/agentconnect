/**
 * `PlacementResolver` — the ledger-aware half of `domain/placement.ts`, and the ONLY place that
 * answers "which daemons serve this agent right now" once placement stopped being a member id.
 *
 * `domain/placement.ts` answers eligibility from the row alone; this adds the live duty leases, so
 * a `set` agent — which names no machine — still resolves to the member currently holding it. Two
 * questions, one resolver: delivery/edge targets (`servingDaemons`, `servingDaemon`) and authority
 * (`mayAct`, the "is this agent yours" fence every daemon-originated write applies).
 *
 * No caller branches on the placement kind; this file and the ledger predicate it mirrors are the
 * two readers of it.
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
 *   #976 fixed for the fence — the gate opens before the fact; a peer wake addressed at an
 *   installing member would be refused by it, and the window between the two is exactly what the
 *   directory's PENDING entry (`resolveDirectory`) exists to name.
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
      /** A member set's members that are live right now. Only {@link PlacementResolver.dispatchDaemon}
       *  uses it, and only as the rendezvous target — never as a claim of who serves what. */
      liveMembers?: (setId: string) => Promise<string[]>
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
   * Between a grant and its first digest this names NOBODY for a set agent. For platform ingress
   * that is covered by the activation rendezvous (the trigger reaches a member and claims). For a
   * cross-daemon peer wake the directory carries the agent as PENDING instead
   * ({@link PlacementResolver.resolveDirectory}), so the relay answers the retryable `not_ready`
   * rather than a terminal `not_found`, and the source retries the same delivery until this
   * names the confirmed member.
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
   * Fill the serving daemon into a directory projection. The peer directory and the collaboration
   * snapshot both need "who do I wake", which is a live question for a set agent and a column read
   * for a machine-placed one — so it is answered here once rather than at each surface, where the
   * two could disagree.
   *
   * Three outcomes per row: a ROUTABLE member (`daemonId` set); PENDING (`daemonId: null`) — a set
   * agent nobody may be addressed at yet, but which a live member holds unconfirmed or is about to
   * claim, so a wake gets the retryable `not_ready` instead of a terminal miss; or dropped, when
   * nothing serves the agent and nothing can. Naming the installing member instead would send the
   * wake to a daemon that refuses it, which is why pending is a state of its own.
   */
  async resolveDirectory<T extends PlacementRef & { agentId: string }>(
    rows: readonly T[]
  ): Promise<(T & { daemonId: string | null })[]> {
    const resolved: (T & { daemonId: string | null })[] = []
    const liveBySet = new Map<string, Promise<boolean>>()
    const setHasLiveMember = (setId: string): Promise<boolean> => {
      let cached = liveBySet.get(setId)
      if (!cached) {
        cached = this.deps.liveMembers ? this.deps.liveMembers(setId).then((m) => m.length > 0) : Promise.resolve(false)
        liveBySet.set(setId, cached)
      }
      return cached
    }
    for (const row of rows) {
      const agent = { ...row, id: row.agentId }
      // ROUTABLE, not serving: this directory is what a cross-daemon peer wake is addressed through.
      const daemonId = await this.routableDaemon(agent)
      if (daemonId) {
        resolved.push({ ...row, daemonId })
        continue
      }
      const eligibility = dutyEligibility(row)
      if (eligibility.scope !== 'set') continue
      const pending = (await this.holders(row.agentId)).length > 0 || (await setHasLiveMember(eligibility.setId))
      if (pending) resolved.push({ ...row, daemonId: null })
    }
    return resolved
  }

  /**
   * Where to send a TRIGGER for this agent. Distinct from {@link PlacementResolver.servingDaemon}
   * on purpose: a set agent whose lease has lapsed is served by nobody for one lease horizon, and
   * refusing the trigger for that window is what left webchat permanently offline after a rollout
   * (#987). Any live member is a correct target — it claims the agent's group on receipt (the
   * activation rendezvous) and then serves the turn. A machine placement has no such fallback:
   * there is exactly one daemon that may serve it.
   */
  async dispatchDaemon(agent: ResolvableAgent): Promise<DaemonId | null> {
    const routable = await this.routableDaemon(agent)
    if (routable) return routable
    const eligibility = dutyEligibility(agent)
    if (eligibility.scope !== 'set' || !this.deps.liveMembers) return null
    return ((await this.deps.liveMembers(eligibility.setId))[0] as DaemonId | undefined) ?? null
  }
}

/** The resolver a graph with no duty ledger gets: placement alone, which is exactly the pre-duty
 *  behavior. Consumers default to it so a set-less composition needs no wiring at all. */
export const PLACEMENT_ONLY = new PlacementResolver({ clock: systemClock })
