// The rollout flip (memory-evolution.md §3.2.1, assistant-mode.md §4.1): an agent on a member set or in assistant mode with a `daemon` home is moved to `control-plane`.
import type { AgentMemoryBinding } from '@agentconnect.md/protocol'
import { managedBindingHomedInControlPlane, managedMemoryHomeOf } from '../agent-memory/home.js'
import { DaemonId } from '../domain/ids.js'
import type { AgentRecord, AgentRepo, MemberSetRepo } from '../persistence/ports.js'
import type { AgentDelivery } from './agentDelivery.js'
import { isAssistantModeAgent } from './placement.js'

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
function verdict(memory: AgentMemoryBinding | null, assistantMode: boolean): 'flip' | 'already' | 'skipped' {
  const home = managedMemoryHomeOf(memory)
  // Memory off in assistant mode becomes managed in the CP with no tree to copy; any other provider has no home to move.
  if (home === null) return assistantMode && memory?.provider === 'none' ? 'flip' : 'skipped'
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
      agents: Pick<AgentRepo, 'listSetPlaced' | 'listForDaemon' | 'listAssistantModeOn' | 'update'>
      memberSets: Pick<MemberSetRepo, 'crossOrgSetId' | 'memberIdsOf'>
      delivery: Pick<AgentDelivery, 'upsert'>
      log: SetMemoryHomeLog
    }
  ) {}

  /** One pass over every set-placed or assistant-mode agent. Per-agent failures are logged and retried on the next boot. */
  async run(): Promise<SetMemoryHomeSummary> {
    const summary: SetMemoryHomeSummary = { flipped: 0, already: 0, skipped: 0, failed: 0 }
    // Beside the set placements, a legacy row pinned to a pool member; a pin to a group's member stays a pinned agent.
    const pool = await this.deps.memberSets.crossOrgSetId()
    const members = pool ? await this.deps.memberSets.memberIdsOf(pool) : []
    const pinned = await Promise.all(members.map((daemonId) => this.deps.agents.listForDaemon(DaemonId(daemonId))))
    const onSet = [...(await this.deps.agents.listSetPlaced()), ...pinned.flat()]
    const onSetIds = new Set(onSet.map((agent) => agent.id))
    const assistantOnly = (await this.deps.agents.listAssistantModeOn()).filter((agent) => !onSetIds.has(agent.id))
    const candidates: Array<[AgentRecord, boolean]> = [
      ...onSet.map((agent): [AgentRecord, boolean] => [agent, true]),
      ...assistantOnly.map((agent): [AgentRecord, boolean] => [agent, false])
    ]
    for (const [agent, placedOnSet] of candidates) {
      // The scan is the cheap filter; the verdict that counts is taken again under the row lock below.
      const scanned = verdict(agent.memory, isAssistantModeAgent(agent))
      if (scanned !== 'flip') {
        summary[scanned]++
        continue
      }
      try {
        // The route's own row-locked write, its input taken from the LOCKED binding and mode, so an edit since the scan is honored.
        const flipped = await this.deps.agents.update(
          agent.orgId,
          agent.id,
          {},
          {
            memoryHome: {
              input: (locked, assistantMode) => {
                const now = placedOnSet || assistantMode ? verdict(locked, assistantMode) : 'skipped'
                if (now !== 'flip') throw new NothingToFlip(now)
                return managedBindingHomedInControlPlane(locked)
              },
              onSet: placedOnSet,
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
