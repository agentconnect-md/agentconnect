/** `codehost/note-result`: the owning daemon settled one desired projection generation (§16). */
import { isFrame } from '@agentconnect.md/protocol'
import { HookId } from '../../domain/ids.js'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'

export const handleCodeHostNoteResult: Handler = async (frame, conn, deps) => {
  if (!isFrame('codehost/note-result')(frame)) return
  if (!deps.codeHostNoteProjection) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'note projection is not enabled', false)
    return
  }
  // The hook must live in the org the frame acts in: a cross-org id reads as absent here.
  const orgId = frameOrgId(frame, conn)
  if (!orgId || !(await deps.hook.get(orgId, HookId(frame.payload.hookId)))) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'hook is not in the organization this frame acts in', false)
    return
  }
  try {
    // The reporting daemon is the lease owner the result is fenced on, so a daemon that no longer
    // holds the write settles nothing and is told so rather than silently accepted.
    const settled = await deps.codeHostNoteProjection.recordResult(frame.payload, conn.daemonId)
    if (!settled) {
      conn.sendError(frame.id, 'CONFLICT', 'note result does not match the current projection write', false)
      return
    }
    conn.replyTo(frame, 'codehost/note-result/ok', { accepted: true })
  } catch {
    conn.sendError(frame.id, 'INTERNAL', 'note projection result failed', true)
  }
}
