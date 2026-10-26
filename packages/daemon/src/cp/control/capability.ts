// C→D capability-request frames (capability-requests.md §4.5, §4.7): the settling wake, a reopen's card rewrite, and a forward.
import type {
  AgentMcpRebound,
  AnyFrame,
  CapabilityForward,
  CapabilityForwardResult,
  CapabilityReopened,
  SessionCapabilitySettled,
  SessionCapabilitySettledResult
} from '@agentconnect.md/protocol'
import type { ControlHandler } from './context.js'

export interface CapabilityControlDeps {
  /** Absent ⇒ every wake waits for a daemon that takes it. */
  capabilitySettled?: (req: SessionCapabilitySettled) => Promise<SessionCapabilitySettledResult>
  capabilityReopened?: (req: CapabilityReopened) => Promise<void>
  capabilityForward?: (req: CapabilityForward) => Promise<CapabilityForwardResult>
  mcpRebound?: (req: AgentMcpRebound) => Promise<void>
}

export const sessionCapabilitySettled: ControlHandler<CapabilityControlDeps> = (frame: AnyFrame, deps, wire) => {
  const req = frame.payload as SessionCapabilitySettled
  const answer = deps.capabilitySettled?.(req) ?? Promise.resolve({ accepted: false, reason: 'not_ready' as const })
  answer
    .then((result) => wire.reply(frame, 'session/capability-settled/result', result))
    .catch((err: unknown) => {
      wire.log.warn(`cp: session/capability-settled failed: ${(err as Error)?.message}`)
      wire.sendError(frame.id, 'INTERNAL', 'session/capability-settled failed', true)
    })
}

export const capabilityReopened: ControlHandler<CapabilityControlDeps> = (frame: AnyFrame, deps, wire) => {
  const req = frame.payload as CapabilityReopened
  ;(deps.capabilityReopened?.(req) ?? Promise.resolve())
    .then(() => wire.reply(frame, 'ack', { ok: true }))
    .catch((err: unknown) => wire.reply(frame, 'ack', { ok: false, reason: (err as Error)?.message ?? 'failed' }))
}

export const capabilityForward: ControlHandler<CapabilityControlDeps> = (frame: AnyFrame, deps, wire) => {
  const req = frame.payload as CapabilityForward
  const answer =
    deps.capabilityForward?.(req) ?? Promise.resolve({ delivered: false, reason: 'no_card_surface' as const })
  answer
    .then((result) => wire.reply(frame, 'capability/forward/result', result))
    .catch((err: unknown) => {
      wire.log.warn(`cp: capability/forward failed: ${(err as Error)?.message}`)
      wire.reply(frame, 'capability/forward/result', { delivered: false, reason: 'failed' })
    })
}

/** EVT: an MCP server's OAuth connected; the sessions that use it reload (§4.8 item 2). */
export const agentMcpRebound: ControlHandler<CapabilityControlDeps> = (frame: AnyFrame, deps, wire) => {
  const req = frame.payload as AgentMcpRebound
  void (deps.mcpRebound?.(req) ?? Promise.resolve()).catch((err: unknown) =>
    wire.log.warn(`cp: agent/mcp-rebound failed: ${(err as Error)?.message}`)
  )
  return // EVT — no reply
}
