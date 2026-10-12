/** `agent/read-access`: the console's session visibility for whoever asks a cross-platform read; no resolver leaves every asker unidentifiable. */
import { isFrame } from '@agentconnect.md/protocol'
import type { Handler } from './index.js'

export const handleReadAccess: Handler = async (frame, conn, deps) => {
  if (!isFrame('agent/read-access')(frame)) return
  try {
    const answer = deps.readAccess
      ? await deps.readAccess(frame.payload, frame.orgId ?? conn.orgId ?? undefined)
      : { asker: 'unidentifiable' as const, visibleSessionIds: [] }
    conn.replyTo(frame, 'agent/read-access/ok', answer)
  } catch (error) {
    deps.log.error({ error, agentId: frame.payload.agentId }, 'read access lookup failed')
    conn.sendError(frame.id, 'INTERNAL', 'read access lookup failed', true)
  }
}
