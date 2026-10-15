/** `transfer/sign`, `transfer/settle` and `transfer/get`: the daemon's half of console file transfer, signed here (source-cache-file-transfer.md §5). */
import { isFrame } from '@agentconnect.md/protocol'
import { AgentId } from '../../domain/ids.js'
import { FileTransferRefusal } from '../../file-transfer/service.js'
import { PLACEMENT_ONLY } from '../../orchestrator/placementResolver.js'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'

export const handleTransferSign: Handler = async (frame, conn, deps) => {
  if (!isFrame('transfer/sign')(frame)) return
  if (!deps.fileTransfer) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'this deployment has no bucket for file transfers', false)
    return
  }
  try {
    conn.replyTo(frame, 'transfer/sign/ok', await deps.fileTransfer.signUpload(conn.daemonId, frame.payload))
  } catch (err) {
    if (err instanceof FileTransferRefusal) {
      conn.sendError(frame.id, err.code === 'WORKSPACE_STALE' ? 'CONFLICT' : 'SCOPE_DENIED', err.message, false)
      return
    }
    conn.sendError(frame.id, 'INTERNAL', 'the upload could not be signed', true)
  }
}

export const handleTransferSettle: Handler = async (frame, conn, deps) => {
  if (!isFrame('transfer/settle')(frame)) return
  if (!deps.fileTransfer) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'this deployment has no bucket for file transfers', false)
    return
  }
  try {
    // Bound to the daemon the ticket was issued to; an unknown, expired or settled ticket is acknowledged unchanged.
    await deps.fileTransfer.settleUpload(conn.daemonId, frame.payload)
    conn.replyTo(frame, 'transfer/settle/ok', {})
  } catch {
    conn.sendError(frame.id, 'INTERNAL', 'the upload outcome could not be recorded', true)
  }
}

export const handleTransferGet: Handler = async (frame, conn, deps) => {
  if (!isFrame('transfer/get')(frame)) return
  const orgId = frameOrgId(frame, conn)
  if (!orgId || !deps.fileTransfer) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'this deployment has no bucket for file transfers', false)
    return
  }
  // An upload's key names the agent it was reserved for, so a daemon reads only uploads for an agent it serves.
  const agent = await deps.agent.get(orgId, AgentId(frame.payload.agentId))
  if (!agent || !(await (deps.placementResolver ?? PLACEMENT_ONLY).mayAct(agent, conn.daemonId))) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'this daemon does not serve that agent', false)
    return
  }
  try {
    conn.replyTo(
      frame,
      'transfer/get/ok',
      await deps.fileTransfer.uploadedFile(orgId, { ...frame.payload, agentId: agent.id })
    )
  } catch {
    conn.sendError(frame.id, 'INTERNAL', 'the upload could not be located', true)
  }
}
