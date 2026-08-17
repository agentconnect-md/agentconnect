/**
 * `convergeAgentRouting` — re-derive every projection that BAKES IN which daemon serves an agent.
 *
 * Most of the CP resolves that per use, through `PlacementResolver`. Three things cannot: the
 * compiled hook rules the relay dispatches on, the HTTP bot's `rc/bot-assign` table, and the
 * collaboration snapshot peers are woken through. Each is computed once and pushed, so each holds
 * a member id that was true only at compile time.
 *
 * A placement move has always re-converged them (`AgentMoveService.convergeDerived`, which now
 * calls this). A DUTY change never did — and that is the gap that made "the sweep re-granted it"
 * stop short of "it heals": the agent is installed on the new member while ingress keeps arriving
 * at the old one. A holder change moves who serves the agent exactly as a placement move does, so
 * it converges through the same code rather than a second, drifting copy of it.
 *
 * Deliberately NOT here: thread affinity and `SessionMeta.daemonId`. Those are per-conversation
 * provenance that a placement move does not invalidate either; they are a separate, pre-existing
 * question (`docs/designs/k8s-daemon-pool.md` §8) and inventing an answer for the duty path alone
 * would make the two disagree.
 */
import type { AgentId } from '../domain/ids.js'
import type { AgentRepo, IntegrationRepo } from '../persistence/ports.js'
import type { Clock, TimerHandle } from '../domain/clock.js'

/** The three pushed projections, as the narrow surface each one is used through. */
export interface RoutingProjections {
  hooks: { rebroadcastForAgent(agentId: string): Promise<void> }
  collabRoutes: { broadcast(orgId?: string): Promise<void> }
  httpBot: { syncBot(botId: string): Promise<void> }
}

export interface RoutingConvergeLog {
  warn(obj: unknown, msg?: string): void
}

/** One agent's convergence inputs: the projections are keyed by agent, org and bot respectively. */
export interface RoutingTarget {
  agentId: string
  orgId: string
  /** The agent's HTTP-transport bots — an `rc/bot-assign` names its members by daemon. */
  httpBotIds: readonly string[]
}

/** The repositories that answer "which `rc/bot-assign` tables name this agent's serving daemon". */
export interface HttpBotLookupDeps {
  integrations: Pick<IntegrationRepo, 'listForAgent'>
  bots: { getUnscoped(botId: string): Promise<{ transport: string } | null> }
}

/**
 * Resolve an agent's HTTP-transport bots — the `RoutingTarget.httpBotIds` for a caller that has no
 * move bundle to read them off. Anything that changes who serves an agent needs this, so it lives
 * beside the convergence rather than being re-derived per caller.
 */
export async function httpBotIdsForAgent(deps: HttpBotLookupDeps, agentId: AgentId): Promise<string[]> {
  const httpBotIds = new Set<string>()
  for (const integration of await deps.integrations.listForAgent(agentId)) {
    const bot = await deps.bots.getUnscoped(integration.botId)
    if (bot?.transport === 'http') httpBotIds.add(integration.botId)
  }
  return [...httpBotIds]
}

/**
 * Push all three projections for one agent. Each job is independently caught: they are pushes
 * over a live wire, every one of them has a reconnect/replay backstop, and a transient failure in
 * one must not stop the other two — the same posture `convergeDerived` has always had.
 */
export async function convergeAgentRouting(
  deps: RoutingProjections,
  target: RoutingTarget,
  log?: RoutingConvergeLog
): Promise<void> {
  const jobs: Array<{ label: string; run: () => Promise<void> }> = [
    { label: 'hook routes', run: () => deps.hooks.rebroadcastForAgent(target.agentId) },
    { label: 'collaboration routes', run: () => deps.collabRoutes.broadcast(target.orgId) },
    ...target.httpBotIds.map((botId) => ({ label: `HTTP bot ${botId}`, run: () => deps.httpBot.syncBot(botId) }))
  ]
  for (const job of jobs) {
    try {
      await job.run()
    } catch (err) {
      log?.warn({ err, agentId: target.agentId, job: job.label }, 'agent routing convergence deferred')
    }
  }
}

/**
 * The duty side's entry point: "these agents changed hands, re-converge what routes to them."
 *
 * Coalescing and fire-and-forget for the same reasons `DutyRecomputeSweep.kick` is: the callers
 * are a heartbeat exchange and a sweep tick, neither of which may block on a relay push, and one
 * beat routinely moves several groups covering the same agent. The reconnect/replay path remains
 * the backstop, so a dropped kick costs latency, never correctness.
 */
export class AgentRoutingConverger {
  private readonly pending = new Set<string>()
  private timer: TimerHandle | undefined
  private stopped = false

  constructor(
    private readonly deps: RoutingProjections & {
      agents: Pick<AgentRepo, 'listByIds'>
      integrations: Pick<IntegrationRepo, 'listForAgent'>
      bots: { getUnscoped(botId: string): Promise<{ transport: string } | null> }
      clock: Clock
      /** Coalescing window; a burst covering one agent costs one convergence. */
      delayMs: number
      log?: RoutingConvergeLog
    }
  ) {}

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) {
      this.deps.clock.clearTimeout(this.timer)
      this.timer = undefined
    }
    this.pending.clear()
  }

  kick(agentIds: Iterable<string>): void {
    if (this.stopped) return
    for (const agentId of agentIds) this.pending.add(agentId)
    if (this.pending.size === 0 || this.timer !== undefined) return
    this.timer = this.deps.clock.setTimeout(() => {
      this.timer = undefined
      const agentIds = [...this.pending]
      this.pending.clear()
      void this.converge(agentIds).catch((err) =>
        this.deps.log?.warn({ err, agentIds }, 'agent routing convergence kick failed')
      )
    }, this.deps.delayMs)
  }

  /** Exported for tests; the timer path calls exactly this. */
  async converge(agentIds: readonly string[]): Promise<void> {
    const agents = await this.deps.agents.listByIds(agentIds as AgentId[])
    for (const agent of agents) {
      const httpBotIds = await httpBotIdsForAgent(this.deps, agent.id)
      await convergeAgentRouting(this.deps, { agentId: agent.id, orgId: agent.orgId, httpBotIds }, this.deps.log)
    }
  }
}
