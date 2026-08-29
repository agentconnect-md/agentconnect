/**
 * `AgentDelivery` — the ONE answer to "which daemons must receive this agent's
 * updates", and the fan-out that rides it.
 *
 * Placement used to be that answer, read inline as `agent.daemonId` at every
 * replicate site. A duty grant broke it: a pool member that wins a duty for an
 * agent it is not the placement of installs one bundle (`duty/fetch`) and then
 * serves it frozen, because every spec edit, rotated credential and organization
 * secret rides a placement-keyed push. The delivery set is therefore the union —
 * the placement if the agent has one, plus every member currently holding an
 * unexpired duty lease covering it.
 *
 * It is a seam, not a special case, and that is now load-bearing: placement is a TARGET rather
 * than a member id, so a `pool` agent names no machine at all and the ledger is its entire
 * delivery set. `PlacementResolver` owns that translation; this file never reads a placement kind.
 * The lifecycle sends keep taking an explicit `orgId`, because an install-wide
 * (frame-mode) member's connection carries no org and a duty holder is exactly
 * the connection that cannot resolve one from its own maps.
 */
import type { CronUpsert, IntegrationSpec } from '@agentconnect.md/protocol'
import type { AgentSpecAssembler } from './agentSpecAssembler.js'
import type { ControlSender } from './outbound.js'
import { PLACEMENT_ONLY, type PlacementResolver, type ResolvableAgent } from './placementResolver.js'
import { daemonSupportsAgent } from '../domain/daemon-features.js'
import type { AgentRecord } from '../persistence/ports.js'

export type { DutyHolderReader } from './placementResolver.js'

/** Per-target failure hook: every site logs it its own way, and none of them
 *  fails the HTTP write over it (the reconnect roster is the backstop). */
export type DeliveryErrorHandler = (err: unknown, daemonId: string) => void

export class AgentDelivery {
  constructor(
    private readonly deps: {
      control: Pick<
        ControlSender,
        'agentUpsert' | 'agentRemove' | 'integrationUpsert' | 'integrationRemove' | 'cronUpsert' | 'cronRemove'
      >
      specs: AgentSpecAssembler
      /** Absent (tests / no pool) ⇒ placement alone, which is the pre-duty behavior. */
      placement?: PlacementResolver
      /** Live advertised features per connected daemon (§17.3 projection gate).
       *  Absent or unknown reads as "no features" — fail-closed for gated agents. */
      daemonFeatures?: (daemonId: string) => readonly string[] | undefined
    }
  ) {}

  /**
   * Every daemon that must receive this agent's updates, placement first and deduped. The
   * placement half is what the resolver makes of the agent's placement fields — one machine for a
   * `daemon` placement, nothing for a `pool` one — so a caller passes the placement REF rather
   * than a daemon id, and gains a kind it never has to read.
   */
  daemonsFor(agent: ResolvableAgent): Promise<string[]> {
    return (this.deps.placement ?? PLACEMENT_ONLY).servingDaemons(agent)
  }

  /**
   * The union delivery set of several agents — the targets of a definition those
   * agents REFERENCE (an MCP proxy def, an external-memory connection). Those
   * defs are not addressed to an agent, so their fan-out sites resolve "who uses
   * this" first and hand the result here rather than reading `daemonId` inline.
   */
  async daemonsForAgents(agents: readonly ResolvableAgent[]): Promise<string[]> {
    const targets = new Set<string>()
    for (const agent of agents) {
      for (const daemonId of await this.daemonsFor(agent)) targets.add(daemonId)
    }
    return [...targets]
  }

  /**
   * Removal of every agent an organization owns, for the one caller whose delete takes the
   * delivery set with it: `DutyGroup` cascades from `Org`, so after the cascade the ledger that
   * names a pool member holding these agents no longer exists and {@link remove}'s "delete first,
   * resolve after" order — the order that makes a single deleted agent's holder still findable —
   * would resolve nothing at all. Resolve here, and hand back the send so the caller fires it once
   * its own delete has committed rather than announcing a removal that may still be refused.
   */
  async planRemoval(
    agents: readonly ResolvableAgent[],
    orgId: string
  ): Promise<(onError: DeliveryErrorHandler) => Promise<void>> {
    const planned = await Promise.all(
      agents.map(async (agent) => ({ agentId: agent.id, targets: await this.daemonsFor(agent) }))
    )
    return async (onError) => {
      for (const { agentId, targets } of planned) {
        await this.fanOut(targets, onError, (daemonId) => this.deps.control.agentRemove(daemonId, { agentId }, orgId))
      }
    }
  }

  /** Push an edited spec to every delivery target. The spec is assembled ONCE:
   *  the targets replicate the same agent, and two assemblies could disagree. */
  async upsert(agent: AgentRecord, onError: DeliveryErrorHandler): Promise<void> {
    const candidates = await this.daemonsFor(agent)
    if (candidates.length === 0) return
    const spec = await this.deps.specs.assemble(agent)
    // §17.3/§24.4 projection gate, judged on the ASSEMBLED spec: a gitlab additional
    // repository and the host axis are only visible there (grants and hooks are their
    // own tables), and a target that has not advertised the required features is skipped
    // rather than sent a frame it would decode into the wrong host.
    const shaped = {
      workspace: spec.workspace ?? agent.workspace,
      ...(spec.gitlabHost !== undefined ? { gitlabHost: spec.gitlabHost } : {})
    }
    const targets = candidates.filter((daemonId) => daemonSupportsAgent(shaped, this.deps.daemonFeatures?.(daemonId)))
    if (targets.length === 0) return
    // The per-peer workspace dual encoding (§8) lives in the sender's agentUpsert.
    await this.fanOut(targets, onError, (daemonId) =>
      this.deps.control.agentUpsert(daemonId, { agentId: agent.id, spec }, agent.orgId)
    )
  }

  /** Tell every delivery target the agent is gone. The agent row is already
   *  deleted by now; duty membership has no FK to it, so a holder is still
   *  resolvable — which is the whole point (a deleted agent must stop being
   *  served, not just stop being placed). */
  async remove(agent: ResolvableAgent, orgId: string, onError: DeliveryErrorHandler): Promise<void> {
    const targets = await this.daemonsFor(agent)
    await this.fanOut(targets, onError, (daemonId) =>
      this.deps.control.agentRemove(daemonId, { agentId: agent.id }, orgId)
    )
  }

  // A dependent goes exactly where its agent's own updates go. An integration
  // spec is token-bearing and a cron definition drives execution, so a holder
  // that receives neither keeps stale credentials, stale bind rules, or a stale
  // schedule until it happens to reconnect — the same frozen-bundle failure as a
  // stale spec, one level down. These take the placement REF rather than the whole record,
  // because a removal path may only have that.

  /** Push one integration's spec (token-bearing — NEVER log it) to every target.
   *  No explicit orgId: `IntegrationSpec.orgId` is a required wire field, so the
   *  payload IS the explicit org — and sending it also teaches the connection's
   *  id→org map, which is why upserts never had this problem. */
  async integrationUpsert(agent: ResolvableAgent, spec: IntegrationSpec, onError: DeliveryErrorHandler): Promise<void> {
    const targets = await this.daemonsFor(agent)
    await this.fanOut(targets, onError, (daemonId) => this.deps.control.integrationUpsert(daemonId, spec))
  }

  /** `orgId` is REQUIRED, not derived. A removal payload is a bare id, so an
   *  install-wide connection can only resolve the org from the id→org map it
   *  built at `register` — and a holder that acquired the integration through
   *  `duty/fetch` never registered it, so the send would raise SCOPE_DENIED
   *  before the frame left the process. The record in hand always has the org. */
  async integrationRemove(
    agent: ResolvableAgent,
    integrationId: string,
    orgId: string,
    onError: DeliveryErrorHandler
  ): Promise<void> {
    const targets = await this.daemonsFor(agent)
    await this.fanOut(targets, onError, (daemonId) =>
      this.deps.control.integrationRemove(daemonId, { integrationId }, orgId)
    )
  }

  /** Same as the integration upsert: `CronUpsert.orgId` is a required wire field. */
  async cronUpsert(agent: ResolvableAgent, wire: CronUpsert, onError: DeliveryErrorHandler): Promise<void> {
    const targets = await this.daemonsFor(agent)
    await this.fanOut(targets, onError, async (daemonId) => void (await this.deps.control.cronUpsert(daemonId, wire)))
  }

  /** `orgId` is REQUIRED for the same reason as {@link AgentDelivery.integrationRemove}. */
  async cronRemove(
    agent: ResolvableAgent,
    cronId: string,
    orgId: string,
    onError: DeliveryErrorHandler
  ): Promise<void> {
    const targets = await this.daemonsFor(agent)
    await this.fanOut(
      targets,
      onError,
      async (daemonId) => void (await this.deps.control.cronRemove(daemonId, { cronId }, orgId))
    )
  }

  /** Sequential so the placement keeps going first. A handler that rethrows (the
   *  delete route escalates anything that is not an offline daemon) still lets
   *  every remaining target hear the news before the error surfaces. */
  private async fanOut(
    targets: string[],
    onError: DeliveryErrorHandler,
    send: (daemonId: string) => Promise<void>
  ): Promise<void> {
    let escalated: unknown
    let failed = false
    for (const daemonId of targets) {
      try {
        await send(daemonId)
      } catch (err) {
        try {
          onError(err, daemonId)
        } catch (rethrown) {
          if (!failed) {
            escalated = rethrown
            failed = true
          }
        }
      }
    }
    if (failed) throw escalated
  }
}
