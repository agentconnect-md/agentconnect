import type { AgentId, DaemonId } from '../../domain/ids.js'
import type { DaemonWsDeps } from '../deps.js'

/**
 * Run one daemon-originated agent write only while that agent is placed on the
 * authenticated reporting daemon. The shared mutation lease prevents a cold
 * move from racing the placement check and the write.
 */
export async function runForReportingAgent(
  agentId: AgentId,
  daemonId: DaemonId,
  deps: Pick<DaemonWsDeps, 'agent' | 'agentMutations'>,
  write: () => Promise<void>
): Promise<boolean> {
  const release = deps.agentMutations.tryBeginMutation(agentId)
  if (!release) return false
  try {
    const agent = await deps.agent.get(agentId)
    if (agent?.daemonId !== daemonId) return false
    await write()
    return true
  } finally {
    release()
  }
}
