import { PLACEMENT_ONLY } from '../../orchestrator/placementResolver.js'
import type { AgentId, DaemonId } from '../../domain/ids.js'
import type { DaemonWsDeps } from '../deps.js'

/**
 * Run one daemon-originated agent write only while the authenticated reporting daemon actually
 * serves that agent — its placement, or a duty it currently holds. The shared mutation lease
 * prevents a cold move from racing the check and the write.
 */
export async function runForReportingAgent(
  agentId: AgentId,
  daemonId: DaemonId,
  deps: Pick<DaemonWsDeps, 'agent' | 'agentMutations' | 'placementResolver'>,
  write: () => Promise<void>
): Promise<boolean> {
  const release = deps.agentMutations.tryBeginMutation(agentId)
  if (!release) return false
  try {
    const agent = await deps.agent.getUnscoped(agentId)
    if (!agent || !(await (deps.placementResolver ?? PLACEMENT_ONLY).mayAct(agent, daemonId))) return false
    await write()
    return true
  } finally {
    release()
  }
}
