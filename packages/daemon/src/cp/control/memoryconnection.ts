import type { AnyFrame } from '@agentconnect.md/protocol'
import type { ConfigApply } from '../config-apply.js'
import type { ConfigApplyDeps } from './config.js'
import type { ControlHandler } from './context.js'

export const memoryConnectionUpsert: ControlHandler<ConfigApplyDeps> = (frame: AnyFrame, deps, wire) => {
  // Grant/secret-bearing daemon-private payload — NEVER log the frame body.
  deps.configApply
    .applyMemoryConnectionUpsert(frame.payload as Parameters<ConfigApply['applyMemoryConnectionUpsert']>[0])
    .then((ack) => wire.reply(frame, 'ack', ack))
    .catch(() => wire.reply(frame, 'ack', { ok: false, reason: 'memory connection probe failed' }))
  return // REQ → probe ACK; reconnect snapshot remains the backstop
}

export const memoryConnectionRemove: ControlHandler<ConfigApplyDeps> = (frame: AnyFrame, deps) => {
  deps.configApply.applyMemoryConnectionRemove((frame.payload as { connectionId: string }).connectionId)
  return // EVT
}
