import type { AnyFrame } from '@agentconnect.md/protocol'
import type { ConfigApply } from '../config-apply.js'
import type { ConfigApplyDeps } from './config.js'
import type { ControlHandler } from './context.js'

export const mcpServerUpsert: ControlHandler<ConfigApplyDeps> = (frame: AnyFrame, deps) => {
  // Grant-key-bearing payload — NEVER log the frame body.
  deps.configApply.applyMcpServerUpsert(frame.payload as Parameters<ConfigApply['applyMcpServerUpsert']>[0])
  return // EVT — no reply (reconnect roster is the backstop)
}

export const mcpServerRemove: ControlHandler<ConfigApplyDeps> = (frame: AnyFrame, deps) => {
  deps.configApply.applyMcpServerRemove(frame.payload as Parameters<ConfigApply['applyMcpServerRemove']>[0])
  return // EVT — no reply
}
