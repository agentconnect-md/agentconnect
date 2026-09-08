// The rollout flip (memory-evolution.md §3.2.1): a pool-placed agent with a `daemon` home is moved to `control-plane`.
import type { AgentMemoryBinding } from '@agentconnect.md/protocol'
import { managedMemoryHomeOf, type ManagedMemoryBindingInput } from '../agent-memory/home.js'
import { DaemonId } from '../domain/ids.js'
import type { AgentRepo, MemberSetRepo } from '../persistence/ports.js'
import type { AgentDelivery } from './agentDelivery.js'

export interface PoolMemoryHomeLog {
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
}

export interface PoolMemoryHomeSummary {
  flipped: number
  already: number
  skipped: number
  failed: number
}

/** The patch that moves a managed binding home: its policy fields kept, `home` set, the CP-owned flag left to the rule. */
function flipInput(current: AgentMemoryBinding | null): ManagedMemoryBindingInput {
  if (current?.provider !== 'managed') return { provider: 'managed', home: 'control-plane' }
  const { home: _home, homeMigration: _flag, ...policy } = current
  return { ...policy, home: 'control-plane' }
}

export class PoolMemoryHomeReconciler {
  constructor(
    private readonly deps: {
      agents: Pick<AgentRepo, 'listForSet' | 'listForDaemon' | 'update'>
      memberSets: Pick<MemberSetRepo, 'crossOrgSetId' | 'memberIdsOf'>
      delivery: Pick<AgentDelivery, 'upsert'>
      log: PoolMemoryHomeLog
    }
  ) {}

  /** One pass over the pool's agents. Per-agent failures are logged and retried on the next boot. */
  async run(): Promise<PoolMemoryHomeSummary> {
    const summary: PoolMemoryHomeSummary = { flipped: 0, already: 0, skipped: 0, failed: 0 }
    const pool = await this.deps.memberSets.crossOrgSetId()
    if (!pool) return summary
    // On the pool: placed on the org-less set, or pinned to a machine that is one of its members (a legacy row).
    const members = await this.deps.memberSets.memberIdsOf(pool)
    const pinned = await Promise.all(members.map((daemonId) => this.deps.agents.listForDaemon(DaemonId(daemonId))))
    for (const agent of [...(await this.deps.agents.listForSet(pool)), ...pinned.flat()]) {
      const home = managedMemoryHomeOf(agent.memory)
      // A provider without a managed tree has no home to move.
      if (home === null) {
        summary.skipped++
        continue
      }
      if (home === 'control-plane') {
        summary.already++
        continue
      }
      try {
        // The route's own row-locked write, so the rule module decides the binding (`homeMigration: 'pending'`).
        const flipped = await this.deps.agents.update(
          agent.orgId,
          agent.id,
          {},
          { memoryHome: { input: flipInput(agent.memory), onPool: true, force: false } }
        )
        // Pushed like a PATCH, so the holding member learns of the flip now; an offline one re-syncs on reconnect.
        await this.deps.delivery.upsert(flipped, (err, daemonId) =>
          this.deps.log.warn({ err, agentId: agent.id, daemonId }, 'pool-memory-home: agent/upsert failed')
        )
        summary.flipped++
      } catch (err) {
        summary.failed++
        this.deps.log.warn({ err, agentId: agent.id }, 'pool-memory-home: flip failed — will retry next boot')
      }
    }
    this.deps.log.info(summary, 'pool-memory-home: pass complete')
    return summary
  }
}
