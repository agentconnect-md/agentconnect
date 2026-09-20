// The rollout flip (memory-evolution.md §3.2.1): a set-placed agent (a group's or the pool's) with a `daemon` home is moved to `control-plane`.
import type { AgentMemoryBinding } from '@agentconnect.md/protocol'
import { managedBindingHomedInControlPlane, managedMemoryHomeOf } from '../agent-memory/home.js'
import { DaemonId } from '../domain/ids.js'
import type { AgentRepo, MemberSetRepo } from '../persistence/ports.js'
import type { AgentDelivery } from './agentDelivery.js'

export interface SetMemoryHomeLog {
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
}

export interface SetMemoryHomeSummary {
  flipped: number
  already: number
  skipped: number
  failed: number
}

/** Where a binding stands for the flip: `flip` when its home is the daemon, else the summary bucket it lands in. */
function verdict(memory: AgentMemoryBinding | null): 'flip' | 'already' | 'skipped' {
  const home = managedMemoryHomeOf(memory)
  // A provider without a managed tree has no home to move.
  if (home === null) return 'skipped'
  return home === 'control-plane' ? 'already' : 'flip'
}

/** Raised from under the row lock when the binding changed since the scan and no longer needs the flip. */
class NothingToFlip extends Error {
  constructor(readonly verdict: 'already' | 'skipped') {
    super('nothing to flip')
  }
}

export class SetMemoryHomeReconciler {
  constructor(
    private readonly deps: {
      agents: Pick<AgentRepo, 'listSetPlaced' | 'listForDaemon' | 'update'>
      memberSets: Pick<MemberSetRepo, 'crossOrgSetId' | 'memberIdsOf'>
      delivery: Pick<AgentDelivery, 'upsert'>
      log: SetMemoryHomeLog
    }
  ) {}

  /** One pass over every set-placed agent. Per-agent failures are logged and retried on the next boot. */
  async run(): Promise<SetMemoryHomeSummary> {
    const summary: SetMemoryHomeSummary = { flipped: 0, already: 0, skipped: 0, failed: 0 }
    // Beside the set placements, a legacy row pinned to a pool member; a pin to a group's member stays a pinned agent.
    const pool = await this.deps.memberSets.crossOrgSetId()
    const members = pool ? await this.deps.memberSets.memberIdsOf(pool) : []
    const pinned = await Promise.all(members.map((daemonId) => this.deps.agents.listForDaemon(DaemonId(daemonId))))
    for (const agent of [...(await this.deps.agents.listSetPlaced()), ...pinned.flat()]) {
      // The scan is the cheap filter; the verdict that counts is taken again under the row lock below.
      const scanned = verdict(agent.memory)
      if (scanned !== 'flip') {
        summary[scanned]++
        continue
      }
      try {
        // The route's own row-locked write, so the rule module decides the binding (`homeMigration: 'pending'`). The
        // input is derived from the LOCKED binding: an edit that landed since the scan is honored, never overwritten.
        const flipped = await this.deps.agents.update(
          agent.orgId,
          agent.id,
          {},
          {
            memoryHome: {
              input: (locked) => {
                const now = verdict(locked)
                if (now !== 'flip') throw new NothingToFlip(now)
                return managedBindingHomedInControlPlane(locked)
              },
              onSet: true,
              force: false
            }
          }
        )
        // Pushed like a PATCH, so the holding member learns of the flip now; an offline one re-syncs on reconnect.
        await this.deps.delivery.upsert(flipped, (err, daemonId) =>
          this.deps.log.warn({ err, agentId: agent.id, daemonId }, 'set-memory-home: agent/upsert failed')
        )
        summary.flipped++
      } catch (err) {
        if (err instanceof NothingToFlip) {
          summary[err.verdict]++
          continue
        }
        summary.failed++
        this.deps.log.warn({ err, agentId: agent.id }, 'set-memory-home: flip failed — will retry next boot')
      }
    }
    this.deps.log.info(summary, 'set-memory-home: pass complete')
    return summary
  }
}
