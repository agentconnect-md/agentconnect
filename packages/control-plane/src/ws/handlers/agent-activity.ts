// `agent/activity` (D→C EVT): persist the session's wait state and fan it to SSE — the approval bell's signal (slack-approval-dm.md §7).
import { isFrame } from '@agentconnect.md/protocol'
import { AgentId, DaemonId, SessionId } from '../../domain/ids.js'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'
import { runForReportingAgent } from './reporting-agent.js'

export const handleAgentActivity: Handler = async (frame, conn, deps) => {
  if (!isFrame('agent/activity')(frame)) return
  const orgId = frameOrgId(frame, conn)
  if (!orgId) return
  const { agentId, sessionId, state } = frame.payload
  const daemonId = DaemonId(conn.daemonId)
  // On the per-daemon tail: behind a predecessor socket's close clear and this socket's register
  // clear, and ahead of its own close clear, so the last mutation a connection makes is its clear.
  await deps.connReg.runApprovalMutation(conn.daemonId, async () => {
    if (conn.state === 'CLOSED') return
    await runForReportingAgent(orgId, AgentId(agentId), daemonId, deps, async () => {
      // A row that never committed has no visibility to check, so it is not published either.
      if (await deps.session.setActivityState(SessionId(sessionId), AgentId(agentId), state)) {
        deps.events.publishState(daemonId, frame.payload)
      }
    })
  })
}
