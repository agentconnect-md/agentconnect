import type { AnyFrame } from '@agentconnect.md/protocol'
import type { ConfigApply } from '../config-apply.js'
import type { ConfigApplyDeps } from './config.js'
import type { ControlHandler } from './context.js'

export const routeAssign: ControlHandler<ConfigApplyDeps> = (frame: AnyFrame, deps, wire) => {
  const a = frame.payload as Parameters<ConfigApply['applyRouteAssign']>[0]
  deps.configApply.applyRouteAssign(a)
  wire.reply(frame, 'route/assign/ack', { ok: true, sessionKey: a.sessionKey })
}

export const routeUpdate: ControlHandler<ConfigApplyDeps> = (frame: AnyFrame, deps) => {
  deps.configApply.applyRouteUpdate(frame.payload as Parameters<ConfigApply['applyRouteUpdate']>[0])
  return // EVT — no reply
}

export const relayRoster: ControlHandler<ConfigApplyDeps> = (frame: AnyFrame, deps) => {
  // Hot roster update (shared-bot-relay.md §5) — converge the relay dial-out set.
  // The reconnect register/ok.relays snapshot is the backstop.
  deps.configApply.applyRelayRoster(
    (frame.payload as { relays: Parameters<ConfigApply['applyRelayRoster']>[0] }).relays
  )
  return // EVT — no reply
}

export const collaborationRoutes: ControlHandler<ConfigApplyDeps> = (frame: AnyFrame, deps) => {
  // Hot collaboration routing snapshot (agent-collaboration §2.3/§6.5) —
  // FULL-REPLACE the daemon's terminal-verify table for remote agent callers.
  // The reconnect register/ok.collabRoutes baseline is the backstop.
  deps.configApply.applyCollabRoutes(frame.payload as Parameters<ConfigApply['applyCollabRoutes']>[0])
  return // EVT — no reply
}
