/** `agent/approval-route`: pick or revalidate a pending approval's DM recipient
 *  (slack-approval-dm.md §4.2). Absent resolver fails closed — the daemon then
 *  keeps today's notice-and-console behavior (route) or refuses the click (verify). */
import { isFrame } from '@agentconnect.md/protocol'
import type { Handler } from './index.js'

export const handleApprovalRoute: Handler = async (frame, conn, deps) => {
  if (!isFrame('agent/approval-route')(frame)) return
  if (!deps.approvalRoute) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'approval routing is not enabled', false)
    return
  }
  try {
    const routed = await deps.approvalRoute(frame.payload, frame.orgId ?? conn.orgId ?? undefined)
    conn.replyTo(frame, 'agent/approval-routed', routed)
  } catch (error) {
    deps.log.error({ error, agentId: frame.payload.agentId }, 'approval route failed')
    conn.sendError(frame.id, 'INTERNAL', 'approval routing failed', true)
  }
}
