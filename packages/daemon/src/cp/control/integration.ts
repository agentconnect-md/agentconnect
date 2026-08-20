import type { AnyFrame } from '@agentconnect.md/protocol'
import type { ConfigApply } from '../config-apply.js'
import type { ConfigApplyDeps } from './config.js'
import type { ControlHandler } from './context.js'

export const integrationUpsert: ControlHandler<ConfigApplyDeps> = (frame: AnyFrame, deps) => {
  // Token-bearing payload — NEVER log the frame body.
  deps.configApply.applyIntegrationUpsert(frame.payload as Parameters<ConfigApply['applyIntegrationUpsert']>[0])
  return // EVT — no reply (reconnect roster is the backstop)
}

export const integrationRemove: ControlHandler<ConfigApplyDeps> = (frame: AnyFrame, deps) => {
  deps.configApply.applyIntegrationRemove((frame.payload as { integrationId: string }).integrationId)
  return // EVT — no reply
}

export const integrationForget: ControlHandler<ConfigApplyDeps> = (frame: AnyFrame, deps, wire) => {
  // REQ → ack: an undelivered suppression means the conversation comes back, so
  // the CP must be able to tell the operator instead of reporting success.
  try {
    deps.configApply.applyIntegrationForget(frame.payload as Parameters<ConfigApply['applyIntegrationForget']>[0])
    wire.reply(frame, 'ack', { ok: true })
  } catch (err) {
    wire.reply(frame, 'ack', { ok: false, reason: (err as Error).message })
  }
}

export const integrationLeave: ControlHandler<ConfigApplyDeps> = (frame: AnyFrame, deps, wire) => {
  // REQ → reply: this one changes the OUTSIDE world, so the operator is told
  // what the platform said rather than what we hoped. A refusal is a normal
  // reply (`ok:false`), not a protocol error — a missing scope or a
  // `last_member` channel is the operator's problem to see, not a daemon fault.
  const leave = frame.payload as Parameters<ConfigApply['applyIntegrationLeave']>[0]
  deps.configApply
    .applyIntegrationLeave(leave)
    .then((result) => wire.reply(frame, 'integration/leave/ok', result))
    .catch((err) => wire.reply(frame, 'integration/leave/ok', { ok: false, error: (err as Error).message }))
}
