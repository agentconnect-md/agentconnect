import type { AnyFrame, DaemonRestart, DaemonUpgrade, Drain, DrainProgress } from '@agentconnect.md/protocol'
import type { ConfigApplyDeps } from './config.js'
import type { ControlHandler } from './context.js'

export interface DaemonOpsDeps extends ConfigApplyDeps {
  /** §2.1: enter DRAINING so the legal-state gate still admits control frames while we drain. */
  beginDrain(): void
  /** Return to READY once the drain settles — a bare drain is a rebalance and the daemon stays connected. */
  endDrain(): void
}

export const daemonDrain: ControlHandler<DaemonOpsDeps> = (frame: AnyFrame, deps, wire) => {
  const drain = frame.payload as Drain
  deps.beginDrain()
  deps.configApply
    .applyDaemonDrain(drain, (p: DrainProgress) => wire.emit('drain/progress', p))
    .then((done) => {
      wire.reply(frame, 'drain/done', done)
      deps.endDrain()
    })
    .catch((err) => {
      wire.sendError(frame.id, 'INTERNAL', `drain failed: ${(err as Error).message}`, false)
      deps.endDrain()
    })
}

export const daemonRestart: ControlHandler<DaemonOpsDeps> = (frame: AnyFrame, deps, wire) => {
  wire.reply(frame, 'daemon/control/ack', deps.configApply.applyDaemonRestart(frame.payload as DaemonRestart))
}

export const daemonUpgrade: ControlHandler<DaemonOpsDeps> = (frame: AnyFrame, deps, wire) => {
  wire.reply(frame, 'daemon/control/ack', deps.configApply.applyDaemonUpgrade(frame.payload as DaemonUpgrade))
}
