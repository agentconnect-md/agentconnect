import type { AnyFrame, CodeHostNoteDesired } from '@agentconnect.md/protocol'
import type { ControlHandler } from './context.js'

export interface CodeHostControlDeps {
  /** Converge one desired run projection (gitlab-com-integration.md §16); absent on a daemon with no writer. */
  codeHostNoteProjection?: (desired: CodeHostNoteDesired, orgId?: string) => Promise<void>
}

/**
 * `codehost/note-desired` (C→D EVT): the Control Plane's desired projection generation.
 *
 * Uncorrelated by design — the authoritative answer is the daemon's own `codehost/note-result`
 * frame, not a transport ack, so this hands the frame to the writer and returns.
 */
export const codeHostNoteDesired: ControlHandler<CodeHostControlDeps> = (frame: AnyFrame, deps, wire) => {
  if (!deps.codeHostNoteProjection) {
    wire.log.debug('cp: ignoring codehost/note-desired — this daemon has no projection writer')
    return
  }
  void deps.codeHostNoteProjection(frame.payload as CodeHostNoteDesired, frame.orgId)
}
