// Re-ships the specs of agents whose derived Computer list moved (computer-use.md §4.1); the reconnect roster is the backstop.
import type { AgentRepo } from '../persistence/ports.js'
import type { OrgId } from '../domain/ids.js'
import { NoConnection } from './outbound.js'
import type { AgentDelivery } from './agentDelivery.js'

export interface ComputerAccessFanOutDeps {
  agents: Pick<AgentRepo, 'list'>
  delivery: () => Pick<AgentDelivery, 'upsert'>
  log?: { debug(obj: object, msg: string): void; warn(obj: object, msg: string): void }
}

/** The `onAgentAccessChanged` hook: push each affected agent's spec to whoever serves it, never failing the write. */
export function computerAccessFanOut(deps: ComputerAccessFanOutDeps) {
  return async (orgId: OrgId, affected: 'all' | string[]): Promise<void> => {
    const wanted = affected === 'all' ? null : new Set(affected)
    const agents = (await deps.agents.list(orgId)).filter((a) => !wanted || wanted.has(a.id))
    // Concurrent, as the org-environment fan-out is: a change to or from All agents covers every agent.
    await Promise.all(
      agents.map((agent) =>
        deps.delivery().upsert(agent, (err, daemonId) => {
          if (err instanceof NoConnection)
            deps.log?.debug({ agentId: agent.id, daemonId }, 'agent/upsert skipped: daemon offline')
          else
            deps.log?.warn(
              { err, agentId: agent.id, daemonId },
              'computer access: agent/upsert failed (backstop: reconnect roster)'
            )
        })
      )
    )
  }
}
