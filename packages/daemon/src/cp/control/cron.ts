import type { AnyFrame } from '@agentconnect.md/protocol'
import type { ConfigApply } from '../config-apply.js'
import type { ConfigApplyDeps } from './config.js'
import type { ControlHandler } from './context.js'

export const cronUpsert: ControlHandler<ConfigApplyDeps> = (frame: AnyFrame, deps, wire) => {
  try {
    deps.configApply.upsertCron(frame.payload as Parameters<ConfigApply['upsertCron']>[0])
    wire.reply(frame, 'ack', { ok: true })
  } catch (err) {
    wire.sendError(frame.id, 'BAD_PAYLOAD', `cron upsert failed: ${(err as Error).message}`, false)
  }
}

export const cronRemove: ControlHandler<ConfigApplyDeps> = (frame: AnyFrame, deps, wire) => {
  deps.configApply.removeCron((frame.payload as { cronId: string }).cronId)
  wire.reply(frame, 'ack', { ok: true })
}

export const cronRun: ControlHandler<ConfigApplyDeps> = (frame: AnyFrame, deps, wire) => {
  wire.reply(frame, 'ack', deps.configApply.runCron((frame.payload as { cronId: string }).cronId))
}
