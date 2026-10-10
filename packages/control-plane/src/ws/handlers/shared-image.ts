/** `image/original/put` and `image/original/get`: the daemon's half of shared-image originals (webchat-generated-images.md §5). */
import { isFrame } from '@agentconnect.md/protocol'
import { AgentId } from '../../domain/ids.js'
import { SharedImageRefusal } from '../../file-transfer/shared-image.js'
import { PLACEMENT_ONLY } from '../../orchestrator/placementResolver.js'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'
import type { DaemonConnection } from '../connection.js'

function sendRefusal(conn: DaemonConnection, id: string, err: unknown, fallback: string): void {
  if (err instanceof SharedImageRefusal) {
    conn.sendError(id, err.code === 'UNAVAILABLE' ? 'INTERNAL' : 'SCOPE_DENIED', err.message, err.retryable)
    return
  }
  conn.sendError(id, 'INTERNAL', fallback, true)
}

export const handleSharedImagePut: Handler = async (frame, conn, deps) => {
  if (!isFrame('image/original/put')(frame)) return
  const orgId = frameOrgId(frame, conn)
  if (!orgId || !deps.sharedImages) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'this deployment cannot store shared-image originals', false)
    return
  }
  // Publication needs current placement authority: a daemon that no longer serves the agent stores nothing for it.
  const agent = await deps.agent.get(orgId, AgentId(frame.payload.agentId))
  if (!agent || !(await (deps.placementResolver ?? PLACEMENT_ONLY).mayAct(agent, conn.daemonId))) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'this daemon does not serve that agent', false)
    return
  }
  try {
    conn.replyTo(frame, 'image/original/put/ok', await deps.sharedImages.signPut(orgId, frame.payload))
  } catch (err) {
    sendRefusal(conn, frame.id, err, 'the upload could not be signed')
  }
}

export const handleSharedImageGet: Handler = async (frame, conn, deps) => {
  if (!isFrame('image/original/get')(frame)) return
  const orgId = frameOrgId(frame, conn)
  if (!orgId || !deps.sharedImages) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'this deployment cannot store shared-image originals', false)
    return
  }
  // The key is org-scoped; a historical read on a moved agent is authorized by the console's open resolve instead.
  const agent = await deps.agent.get(orgId, AgentId(frame.payload.agentId))
  if (!agent) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'no such agent in this organization', false)
    return
  }
  const placed = await (deps.placementResolver ?? PLACEMENT_ONLY).mayAct(agent, conn.daemonId)
  try {
    conn.replyTo(
      frame,
      'image/original/get/ok',
      await deps.sharedImages.signGet(orgId, conn.daemonId, frame.payload, placed)
    )
  } catch (err) {
    sendRefusal(conn, frame.id, err, 'the original could not be located')
  }
}
