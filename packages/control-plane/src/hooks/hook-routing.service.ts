import type { AgentId, DaemonId, OrgId } from '../domain/ids.js'
import type {
  AgentRecord,
  CodeHostDecisionRoutingRepo,
  CodeHostRoutingScope,
  DaemonRecord,
  HookRecord,
  HookRepo
} from '../persistence/ports.js'
import type { PlacementResolver } from '../orchestrator/placementResolver.js'
import { codeHostProviders } from '../codehost/registry.js'
import { chooseEvaluationAgent, routingMembers, routingScopeOf, type HostCandidate } from './hook-routing.js'
import type { HookRoutingReconciler, HookService } from './hook.service.js'

export interface HookRoutingServiceDeps {
  routings: CodeHostDecisionRoutingRepo
  hooks: Pick<HookRepo, 'listForOrgKind' | 'listForAgent'>
  agents: { getUnscoped(agentId: AgentId): Promise<AgentRecord | null> }
  daemons: { getUnscoped(daemonId: DaemonId): Promise<DaemonRecord | null> }
  placement: Pick<PlacementResolver, 'routableDaemon'>
  /** A connected daemon's advertised features; undefined while it is not connected. */
  daemonFeatures(daemonId: string): readonly string[] | undefined
  hookService: Pick<HookService, 'broadcast'>
  /** Push one agent's re-assembled spec (its hookRoutings changed). */
  projectAgentSpec(orgId: OrgId, agentId: AgentId): Promise<void>
  log?: { warn(obj: unknown, msg?: string): void }
}

const scopeKey = (s: CodeHostRoutingScope) => `${s.orgId}\u0000${s.provider}\u0000${s.repoId}\u0000${s.family}`

/** Keeps each code-host routing scope converged (code-host-decisions.md §3.2): its host, its rules, its hosts' specs. */
export class HookRoutingService implements HookRoutingReconciler {
  constructor(private readonly deps: HookRoutingServiceDeps) {}

  /** Re-choose the scope's host, push the affected hosts' specs, then rebroadcast every rule in the scope. */
  async reconcile(
    scope: CodeHostRoutingScope,
    opts: { formerHost?: AgentId | null; membersChanged?: boolean; onlyIfHostMoves?: boolean } = {}
  ): Promise<void> {
    const record = await this.deps.routings.get(scope)
    const scopeHooks = (await this.deps.hooks.listForOrgKind(scope.orgId, scope.provider)).filter(
      (h) => h.repoId === scope.repoId && h.family === scope.family
    )
    const hosts = new Set<AgentId>()
    if (opts.formerHost) hosts.add(opts.formerHost)
    if (record) {
      const current = record.evaluationAgentId
      const next = chooseEvaluationAgent(
        current,
        await this.candidates(routingMembers(scopeHooks, scope)),
        codeHostProviders[scope.provider].routing.requiredFeatures
      )
      if (next !== current) {
        if (!(await this.deps.routings.setEvaluationAgent(record.id, current, next as AgentId | null))) {
          // A concurrent reconcile moved it first; its own pass converges the scope.
          return
        }
        if (current) hosts.add(current)
        if (next) hosts.add(next as AgentId)
      } else {
        if (opts.onlyIfHostMoves) return
        if (opts.membersChanged) await this.deps.routings.touchHost(record.id)
        if (current) hosts.add(current)
      }
    } else if (opts.onlyIfHostMoves) return
    // The host learns the scope before any relay names it.
    for (const agentId of hosts) await this.deps.projectAgentSpec(scope.orgId, agentId)
    for (const hook of scopeHooks) await this.deps.hookService.broadcast(hook)
  }

  async reconcileHooks(
    hooks: ReadonlyArray<Pick<HookRecord, 'orgId' | 'kind' | 'repoId' | 'family'> | null | undefined>,
    opts: { membersChanged?: boolean } = {}
  ): Promise<void> {
    for (const scope of this.scopesOf(hooks)) {
      // An unrouted scope has nothing beyond the hook's own broadcast.
      if (!(await this.deps.routings.get(scope))) continue
      await this.guard(scope, () => this.reconcile(scope, opts))
    }
  }

  async reconcileForAgent(agentId: AgentId): Promise<void> {
    const hosted = await this.deps.routings.listForHost(agentId)
    const scopes = new Map<string, CodeHostRoutingScope>()
    for (const s of [...this.scopesOf(await this.deps.hooks.listForAgent(agentId)), ...hosted]) {
      scopes.set(scopeKey(s), { orgId: s.orgId, provider: s.provider, repoId: s.repoId, family: s.family })
    }
    for (const scope of scopes.values()) {
      if (!(await this.deps.routings.get(scope))) continue
      await this.guard(scope, () => this.reconcile(scope))
    }
  }

  /** A daemon (re)connected with its features: move any scope whose better host it now is. */
  async daemonReady(daemonId: string): Promise<void> {
    for (const scope of await this.deps.routings.listScopesForDaemon(daemonId as DaemonId)) {
      await this.guard(scope, () => this.reconcile(scope, { onlyIfHostMoves: true }))
    }
  }

  private scopesOf(
    hooks: ReadonlyArray<Pick<HookRecord, 'orgId' | 'kind' | 'repoId' | 'family'> | null | undefined>
  ): CodeHostRoutingScope[] {
    const scopes = new Map<string, CodeHostRoutingScope>()
    for (const h of hooks) {
      const scope = h ? routingScopeOf(h) : null
      if (scope) scopes.set(scopeKey(scope), scope)
    }
    return [...scopes.values()]
  }

  private async candidates(members: ReadonlyArray<{ agentId: AgentId }>): Promise<HostCandidate[]> {
    const out: HostCandidate[] = []
    for (const agentId of new Set(members.map((m) => m.agentId))) {
      const agent = await this.deps.agents.getUnscoped(agentId)
      if (!agent) continue
      // A paused agent's rules leave the pool, so a relay could not address its host copy.
      const daemonId = agent.pause === true ? null : await this.deps.placement.routableDaemon(agent)
      const daemon = daemonId ? await this.deps.daemons.getUnscoped(daemonId) : null
      out.push({
        agentId,
        agentCreatedAt: agent.createdAt.getTime(),
        daemonId,
        ...(daemon ? { daemonCreatedAt: daemon.createdAt.getTime() } : {}),
        ...(daemonId ? { features: this.deps.daemonFeatures(daemonId) } : {})
      })
    }
    return out
  }

  private async guard(scope: CodeHostRoutingScope, run: () => Promise<void>): Promise<void> {
    try {
      await run()
    } catch (err) {
      this.deps.log?.warn(
        { err, orgId: scope.orgId, provider: scope.provider, repoId: scope.repoId.toString(), family: scope.family },
        'hook routing: scope reconcile deferred'
      )
    }
  }
}
