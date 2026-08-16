import { PLACEMENT_ONLY } from '../../orchestrator/placementResolver.js'
import type { AgentId, DaemonId, OrgId } from '../../domain/ids.js'
import type { DaemonWsDeps } from '../deps.js'

/**
 * Run one daemon-originated agent write only while the authenticated reporting daemon actually
 * serves that agent — its placement, or a duty it currently holds. The shared mutation lease
 * prevents a cold move from racing the check and the write.
 *
 * `orgId` is the reporting frame's org (M4): the agent read is fenced on it, so a member of one
 * org can never name an agent of another on the same install-wide socket.
 */
export async function runForReportingAgent(
  orgId: OrgId,
  agentId: AgentId,
  daemonId: DaemonId,
  deps: Pick<DaemonWsDeps, 'agent' | 'agentMutations' | 'placementResolver'>,
  write: () => Promise<void>
): Promise<boolean> {
  const release = deps.agentMutations.tryBeginMutation(agentId)
  if (!release) return false
  try {
    const agent = await deps.agent.get(orgId, agentId)
    if (!agent || !(await (deps.placementResolver ?? PLACEMENT_ONLY).mayAct(agent, daemonId))) return false
    await write()
    return true
  } finally {
    release()
  }
}
