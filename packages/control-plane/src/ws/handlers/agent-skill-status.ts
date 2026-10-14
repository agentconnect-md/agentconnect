// `agent/skill-status` (D→C EVT): one completed skill reconcile's failed Sources by name and code (source-cache.md §11).
import { isFrame } from '@agentconnect.md/protocol'
import { AgentId, DaemonId } from '../../domain/ids.js'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'
import { runForReportingAgent } from './reporting-agent.js'

export const handleAgentSkillStatus: Handler = async (frame, conn, deps) => {
  if (!isFrame('agent/skill-status')(frame)) return
  const store = deps.agentSkillSourceStatus
  const orgId = frameOrgId(frame, conn)
  if (!store || !orgId) return
  const { agentId, failed } = frame.payload
  // The CP's clock dates the row: a daemon's clock never orders rows across reporters.
  const reportedAt = new Date(deps.clock.now())
  // Only the daemon serving the agent may report; one mid-move is dropped and the next reconcile reports again.
  await runForReportingAgent(orgId, AgentId(agentId), DaemonId(conn.daemonId), deps, () =>
    store.replace(
      AgentId(agentId),
      failed.map((entry) => ({ sourceName: entry.name, code: entry.code })),
      reportedAt
    )
  )
}
