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
 * It is a seam, not a special case: a later change makes placement a delivery
 * TARGET rather than a member id, and this is the one place that has to learn it.
 * The lifecycle sends keep taking an explicit `orgId`, because an install-wide
 * (frame-mode) member's connection carries no org and a duty holder is exactly
 * the connection that cannot resolve one from its own maps.
 */
import type { CronUpsert, IntegrationSpec } from '@agentconnect.md/protocol'
import type { AgentSpecAssembler } from './agentSpecAssembler.js'
import type { ControlSender } from './outbound.js'
import type { AgentRecord } from '../persistence/ports.js'
import { AgentId, type DaemonId } from '../domain/ids.js'
import type { Clock } from '../domain/clock.js'

/** The duty ledger read this seam needs — the delivery half of `holdsAgent`. */
export interface DutyHolderReader {
  holdersOf(agentId: AgentId, now: Date): Promise<DaemonId[]>
}

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
      duties?: DutyHolderReader
      clock: Clock
    }
  ) {}

  /**
   * Every daemon that must receive this agent's updates, placement first and
   * deduped. No duty ledger wired (tests, or a deployment with no pool) ⇒ the
   * placement alone, which is exactly the pre-duty behavior.
   */
  async daemonsFor(agentId: string, placement: string | null): Promise<string[]> {
    const holders = this.deps.duties
      ? await this.deps.duties.holdersOf(AgentId(agentId), new Date(this.deps.clock.now()))
      : []
    return [...new Set([...(placement ? [placement] : []), ...holders])]
  }

  /** Push an edited spec to every delivery target. The spec is assembled ONCE:
   *  the targets replicate the same agent, and two assemblies could disagree. */
  async upsert(agent: AgentRecord, onError: DeliveryErrorHandler): Promise<void> {
    const targets = await this.daemonsFor(agent.id, agent.daemonId)
    if (targets.length === 0) return
    const spec = await this.deps.specs.assemble(agent)
    await this.fanOut(targets, onError, (daemonId) =>
      this.deps.control.agentUpsert(daemonId, { agentId: agent.id, spec }, agent.orgId)
    )
  }

  /** Tell every delivery target the agent is gone. The agent row is already
   *  deleted by now; duty membership has no FK to it, so a holder is still
   *  resolvable — which is the whole point (a deleted agent must stop being
   *  served, not just stop being placed). */
  async remove(agentId: string, placement: string | null, orgId: string, onError: DeliveryErrorHandler): Promise<void> {
    const targets = await this.daemonsFor(agentId, placement)
    await this.fanOut(targets, onError, (daemonId) => this.deps.control.agentRemove(daemonId, { agentId }, orgId))
  }

  // A dependent goes exactly where its agent's own updates go. An integration
  // spec is token-bearing and a cron definition drives execution, so a holder
  // that receives neither keeps stale credentials, stale bind rules, or a stale
  // schedule until it happens to reconnect — the same frozen-bundle failure as a
  // stale spec, one level down. These take the agent's id and placement rather
  // than the record, because a removal path may only have those.

  /** Push one integration's spec (token-bearing — NEVER log it) to every target.
   *  No explicit orgId: `IntegrationSpec.orgId` is a required wire field, so the
   *  payload IS the explicit org — and sending it also teaches the connection's
   *  id→org map, which is why upserts never had this problem. */
  async integrationUpsert(
    agentId: string,
    placement: string | null,
    spec: IntegrationSpec,
    onError: DeliveryErrorHandler
  ): Promise<void> {
    const targets = await this.daemonsFor(agentId, placement)
    await this.fanOut(targets, onError, (daemonId) => this.deps.control.integrationUpsert(daemonId, spec))
  }

  /** `orgId` is REQUIRED, not derived. A removal payload is a bare id, so an
   *  install-wide connection can only resolve the org from the id→org map it
   *  built at `register` — and a holder that acquired the integration through
   *  `duty/fetch` never registered it, so the send would raise SCOPE_DENIED
   *  before the frame left the process. The record in hand always has the org. */
  async integrationRemove(
    agentId: string,
    placement: string | null,
    integrationId: string,
    orgId: string,
    onError: DeliveryErrorHandler
  ): Promise<void> {
    const targets = await this.daemonsFor(agentId, placement)
    await this.fanOut(targets, onError, (daemonId) =>
      this.deps.control.integrationRemove(daemonId, { integrationId }, orgId)
    )
  }

  /** Same as the integration upsert: `CronUpsert.orgId` is a required wire field. */
  async cronUpsert(
    agentId: string,
    placement: string | null,
    wire: CronUpsert,
    onError: DeliveryErrorHandler
  ): Promise<void> {
    const targets = await this.daemonsFor(agentId, placement)
    await this.fanOut(targets, onError, async (daemonId) => void (await this.deps.control.cronUpsert(daemonId, wire)))
  }

  /** `orgId` is REQUIRED for the same reason as {@link AgentDelivery.integrationRemove}. */
  async cronRemove(
    agentId: string,
    placement: string | null,
    cronId: string,
    orgId: string,
    onError: DeliveryErrorHandler
  ): Promise<void> {
    const targets = await this.daemonsFor(agentId, placement)
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
