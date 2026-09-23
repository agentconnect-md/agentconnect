import type { AnyFrame } from '@agentconnect.md/protocol'
import type { ControlHandler } from './context.js'

/** `daemon/runtimes/probe` — the self-hosted console's "refresh runtimes" for a cluster member. */
export interface RuntimeProbeDeps {
  /** Undefined unless this member takes requests (`AC_RUNTIME_PROBE_ON_DEMAND`); the probe itself runs in the background. */
  runtimeProbe?: () => void
}

export const runtimeProbe: ControlHandler<RuntimeProbeDeps> = (frame: AnyFrame, deps, wire) => {
  if (!deps.runtimeProbe) {
    wire.reply(frame, 'ack', { ok: false, reason: 'this daemon does not take runtime probe requests' })
    return
  }
  deps.runtimeProbe()
  wire.reply(frame, 'ack', { ok: true })
}
