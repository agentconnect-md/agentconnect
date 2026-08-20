import type { AgentLaunch, AgentStop, AgentUpsert, AgentWakeReq, AnyFrame } from '@agentconnect.md/protocol'
import { AgentWakeViolationError, type AgentWaker } from '../agent-wake.js'
import type { ConfigApply } from '../config-apply.js'
import type { ConfigApplyDeps } from './config.js'
import type { ControlHandler, ControlWire } from './context.js'

export interface AgentControlDeps extends ConfigApplyDeps {
  /** The console's sandbox wake (`agent/wake`); absent ⇒ every wake answers `unsupported`. */
  agentWake?: AgentWaker
}

export const agentUpsert: ControlHandler<AgentControlDeps> = (frame: AnyFrame, deps, wire) => {
  deps.configApply
    .applyAgentUpsert(frame.payload as AgentUpsert)
    .then((ack) => wire.reply(frame, 'ack', ack))
    .catch((err) => {
      wire.log.warn(`cp: agent/upsert failed: ${(err as Error)?.message}`)
      wire.reply(frame, 'ack', { ok: false, reason: 'agent/upsert failed' })
    })
}

export const agentRemove: ControlHandler<AgentControlDeps> = (frame: AnyFrame, deps, wire) => {
  try {
    const run = deps.configApply.applyAgentRemove((frame.payload as { agentId: string }).agentId)
    void Promise.resolve(run).catch((err) =>
      wire.log.error(`cp: agent/remove failed closed: ${(err as Error).message}`)
    )
  } catch (err) {
    wire.log.error(`cp: agent/remove failed closed: ${(err as Error).message}`)
  }
  return // EVT — no reply
}

export const agentDetach: ControlHandler<AgentControlDeps> = (frame: AnyFrame, deps, wire) => {
  deps.configApply
    .applyAgentDetach(frame.payload as Parameters<ConfigApply['applyAgentDetach']>[0])
    .then((ack) => wire.reply(frame, 'ack', ack))
    .catch((err) => wire.sendError(frame.id, 'INTERNAL', `agent/detach failed: ${(err as Error).message}`, false))
}

export const agentActivate: ControlHandler<AgentControlDeps> = (frame: AnyFrame, deps, wire) => {
  // Token-bearing authoritative bundle — NEVER log the frame body.
  deps.configApply
    .applyAgentActivate(frame.payload as Parameters<ConfigApply['applyAgentActivate']>[0])
    .then((ack) => wire.reply(frame, 'ack', ack))
    .catch((err) => wire.sendError(frame.id, 'INTERNAL', `agent/activate failed: ${(err as Error).message}`, false))
}

export const agentPermissionRequests: ControlHandler<AgentControlDeps> = async (frame: AnyFrame, deps, wire) => {
  try {
    wire.reply(
      frame,
      'agent/permission-requests/page',
      await deps.configApply.listAgentPermissionRequests(
        frame.payload as Parameters<ConfigApply['listAgentPermissionRequests']>[0]
      )
    )
  } catch (err) {
    wire.sendError(frame.id, 'INTERNAL', `permission request list failed: ${(err as Error).message}`, false)
  }
}

export const agentPermissionDecision: ControlHandler<AgentControlDeps> = async (frame: AnyFrame, deps, wire) => {
  try {
    wire.reply(
      frame,
      'ack',
      await deps.configApply.decideAgentPermission(frame.payload as Parameters<ConfigApply['decideAgentPermission']>[0])
    )
  } catch (err) {
    wire.sendError(frame.id, 'INTERNAL', `permission decision failed: ${(err as Error).message}`, false)
  }
}

export const agentLaunch: ControlHandler<AgentControlDeps> = (frame: AnyFrame, deps, wire) => {
  const launch = frame.payload as AgentLaunch
  deps.configApply
    .applyAgentLaunch(launch)
    .then((launched) => wire.reply(frame, 'agent/launched', launched))
    .catch((err) => wire.sendError(frame.id, 'INTERNAL', `agent/launch failed: ${(err as Error).message}`, false))
}

export const agentStop: ControlHandler<AgentControlDeps> = (frame: AnyFrame, deps, wire) => {
  const stop = frame.payload as AgentStop
  deps.configApply
    .applyAgentStop(stop)
    .then((ack) => wire.reply(frame, 'ack', ack))
    .catch((err) => wire.sendError(frame.id, 'INTERNAL', `agent/stop failed: ${(err as Error).message}`, false))
}

export const agentWake: ControlHandler<AgentControlDeps> = (frame: AnyFrame, deps, wire) => {
  // A sandbox resume with no turn; a daemon with no waker has nothing to wake.
  const wake = frame.payload as AgentWakeReq
  const answer = deps.agentWake?.wake(wake) ?? Promise.resolve({ agentId: wake.agentId, state: 'unsupported' as const })
  answer.then((result) => wire.reply(frame, 'agent/wake/ok', result)).catch((err) => wakeError(wire, frame.id, err))
}

/** Unknown agent → BAD_PAYLOAD with the machine reason (the CP maps it like a workspace read's); else INTERNAL. */
function wakeError(wire: ControlWire, corr: string, err: unknown): void {
  if (err instanceof AgentWakeViolationError) {
    wire.sendError(corr, 'BAD_PAYLOAD', `agent/wake failed: ${err.message}`, false, { reason: err.reason })
    return
  }
  wire.log.warn(`cp: agent/wake failed: ${(err as Error)?.message}`)
  wire.sendError(corr, 'INTERNAL', 'agent/wake failed', false)
}
