import type { AnyFrame, SandboxKeepAlive, SandboxHoldReason, SandboxKeepAliveReq } from '@agentconnect.md/protocol'
import type { ControlHandler, ControlWire } from './context.js'

/**
 * `sandbox/keepalive` — the daemon deciding, from its own facts, whether an open console page's
 * agent has anything worth keeping its pod alive for.
 *
 * The console's word is never taken for it: it asks, and the daemon reads the worktree and its own
 * merge-when-ready registry. That matters because the answer authorizes cost — a page that could
 * assert "dirty" would be able to pin a pod indefinitely.
 */
export interface SandboxKeepAliveDeps {
  /** Undefined on a daemon that runs no sandboxes: every request answers `placement:'daemon'`. */
  sandboxKeepAlive?: (req: SandboxKeepAliveReq) => Promise<SandboxKeepAlive>
}

export const sandboxKeepAlive: ControlHandler<SandboxKeepAliveDeps> = (frame: AnyFrame, deps, wire) => {
  const req = frame.payload as SandboxKeepAliveReq
  const work = deps.sandboxKeepAlive?.(req)
  if (!work) {
    // A daemon with no sandbox plane has nothing to hold, and that is DATA — a console asking a
    // local daemon must get "no sandbox here", not an error it would have to special-case.
    wire.reply(frame, 'sandbox/keepalive/result', {
      agentId: req.agentId,
      held: false,
      reasons: [] as SandboxHoldReason[],
      placement: 'daemon'
    } satisfies SandboxKeepAlive)
    return
  }
  work.then((result) => wire.reply(frame, 'sandbox/keepalive/result', result)).catch((err) => fail(wire, frame.id, err))
}

/** Every failure here is INTERNAL: the request names only an agent, so there is no payload for the
 *  caller to fix, and a hold that could not be evaluated must not read as one that was refused. */
function fail(wire: ControlWire, corr: string, err: unknown): void {
  wire.log.warn(`cp: sandbox/keepalive failed: ${(err as Error)?.message}`)
  wire.sendError(corr, 'INTERNAL', 'sandbox/keepalive failed', false)
}
