import type { AnyFrame } from '@agentconnect.md/protocol'
import type { ConfigApply } from '../config-apply.js'
import type { ControlHandler } from './context.js'

/** The config seam every control domain shares — the daemon's single writer for applied CP state. */
export interface ConfigApplyDeps {
  configApply: ConfigApply
}

export const configPush: ControlHandler<ConfigApplyDeps> = (frame: AnyFrame, deps) => {
  deps.configApply.applyConfigPush((frame.payload as { keys: Record<string, unknown> }).keys)
  return // EVT — no reply
}
