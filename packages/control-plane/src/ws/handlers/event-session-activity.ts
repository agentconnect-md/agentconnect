/**
 * Body-free transcript activity invalidation. The daemon remains the transcript
 * authority; the CP only verifies placement and fans the cursor signal to SSE.
 */
import { isFrame } from '@agentconnect.md/protocol'
import { AgentId, DaemonId } from '../../domain/ids.js'
import type { Handler } from './index.js'
import { runForReportingAgent } from './reporting-agent.js'

export const handleSessionActivity: Handler = async (frame, conn, deps) => {
  if (!isFrame('event/session-activity')(frame)) return
  const agentId = AgentId(frame.payload.agentId)
  const daemonId = DaemonId(conn.daemonId)
  await runForReportingAgent(agentId, daemonId, deps, async () => {
    deps.events.publishActivity(daemonId, frame.payload)
  })
}
