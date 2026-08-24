/** `codehost/note-result`: the owning daemon settled one desired projection generation (§16). */
import { isFrame } from '@agentconnect.md/protocol'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'

export const handleCodeHostNoteResult: Handler = async (frame, conn, deps) => {
  if (!isFrame('codehost/note-result')(frame)) return
  if (!deps.codeHostNoteProjection) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'note projection is not enabled', false)
    return
  }
  const orgId = frameOrgId(frame, conn)
  if (!orgId) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'organization is required', false)
    return
  }
  try {
    // Authorized on the PERSISTED projection, not a live HookDef: a row outlives its hook so an
    // in-flight write can still settle and its tombstone drain after the hook is deleted.
    const outcome = await deps.codeHostNoteProjection.recordResult(frame.payload, conn.daemonId, orgId)
    if (outcome === 'denied') {
      conn.sendError(frame.id, 'SCOPE_DENIED', 'projection is not in the organization this frame acts in', false)
      return
    }
    if (outcome === 'not_found') {
      conn.sendError(frame.id, 'CONFLICT', 'no such projection', false)
      return
    }
    if (outcome === 'conflict') {
      conn.sendError(frame.id, 'CONFLICT', 'note result does not match the current projection write', false)
      return
    }
    conn.replyTo(frame, 'codehost/note-result/ok', { accepted: true })
  } catch {
    conn.sendError(frame.id, 'INTERNAL', 'note projection result failed', true)
  }
}
