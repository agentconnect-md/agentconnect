import type {
  AnyFrame,
  ChildSessionStatus,
  ChildSessionStatusProbe,
  SessionHistoryReq,
  SessionListReq,
  SessionPullRequestFeedback,
  SessionPullRequestFeedbackResult,
  SessionToolBodyReq,
  SessionVisibilityPush
} from '@agentconnect.md/protocol'
import type { SessionReader } from '../session-reader.js'
import type { ConfigApplyDeps } from './config.js'
import type { ControlHandler } from './context.js'

export interface SessionControlDeps extends ConfigApplyDeps {
  /** Read-only session list/history seam over the local store (§1/§12). */
  sessionRead: SessionReader
  /** Answer a CP-forwarded child-session status probe for a child THIS daemon owns
   *  (session-concept §5.4). The daemon re-checks the lineage itself — the CP proves only that the
   *  asking daemon owns the claimed parent session, never that the child belongs to it. */
  childSessionStatusProbe?: (probe: ChildSessionStatusProbe) => ChildSessionStatus | Promise<ChildSessionStatus>
  /** Continue the exact local session named by body-free GitHub feedback metadata. */
  pullRequestFeedback?: (req: SessionPullRequestFeedback) => Promise<SessionPullRequestFeedbackResult>
}

export const sessionVisibility: ControlHandler<SessionControlDeps> = async (frame: AnyFrame, deps, wire) => {
  // session-visibility.md §5.1. ALWAYS reply: a stale revision is answered
  // `superseded`, never an error frame — an error would reject the CP's
  // promise and drive its retransmit budget to exhaustion.
  const p = frame.payload as SessionVisibilityPush
  const status = await deps.configApply.applySessionVisibility(p)
  wire.reply(frame, 'session/visibility/ok', {
    sessionId: p.sessionId,
    visibilityRev: p.visibilityRev,
    status
  })
}

export const sessionVisibilitySnapshot: ControlHandler<SessionControlDeps> = async (frame: AnyFrame, deps, wire) => {
  // Register-time convergence: the full gate set, applied entry by entry
  // under the same revision rule. One ack for the whole chunk.
  const { entries } = frame.payload as { entries: SessionVisibilityPush[] }
  for (const entry of entries) await deps.configApply.applySessionVisibility(entry)
  wire.reply(frame, 'ack', { ok: true })
}

export const sessionList: ControlHandler<SessionControlDeps> = (frame: AnyFrame, deps, wire) => {
  // Read-only — legal in READY/DRAINING (no epoch mutation). Body-locality §12.
  // The frame's org is the read's partition on a shared pool store: this member may hold
  // none of the agents whose sessions it serves, so it cannot resolve one locally.
  Promise.resolve()
    .then(() => deps.sessionRead.list(frame.payload as SessionListReq, { orgId: frame.orgId }))
    .then((page) => wire.reply(frame, 'session/list/page', page))
    .catch((err) => wire.sendError(frame.id, 'INTERNAL', `session/list failed: ${(err as Error).message}`, false))
}

export const sessionHistory: ControlHandler<SessionControlDeps> = (frame: AnyFrame, deps, wire) => {
  const req = frame.payload as SessionHistoryReq
  if (!req.agentId) wire.log.warn('cp: legacy session/history request omitted agentId; owner binding is unavailable')
  Promise.resolve()
    .then(() => deps.sessionRead.history(req, { orgId: frame.orgId }))
    .then((page) => wire.reply(frame, 'session/history/page', page))
    .catch((err) => wire.sendError(frame.id, 'INTERNAL', `session/history failed: ${(err as Error).message}`, false))
}

export const sessionToolBody: ControlHandler<SessionControlDeps> = (frame: AnyFrame, deps, wire) => {
  const req = frame.payload as SessionToolBodyReq
  if (!req.agentId) wire.log.warn('cp: legacy session/tool-body request omitted agentId; owner binding is unavailable')
  Promise.resolve()
    .then(() => deps.sessionRead.toolBody(req, { orgId: frame.orgId }))
    .then((chunk) => wire.reply(frame, 'session/tool-body/chunk', chunk))
    .catch((err) => wire.sendError(frame.id, 'INTERNAL', `session/tool-body failed: ${(err as Error).message}`, false))
}

export const sessionChildStatusProbe: ControlHandler<SessionControlDeps> = async (frame: AnyFrame, deps, wire) => {
  try {
    const probe = frame.payload as ChildSessionStatusProbe
    // No handler wired (older/embedded daemon) ⇒ answer `found:false`, which the asking side
    // renders as "not your child" rather than a hard failure.
    const answer = (await deps.childSessionStatusProbe?.(probe)) ?? { found: false }
    wire.reply(frame, 'session/child-status/probe/ok', answer)
  } catch (err) {
    wire.sendError(frame.id, 'INTERNAL', `session/child-status/probe failed: ${(err as Error).message}`, false)
  }
}

export const sessionPullRequestFeedback: ControlHandler<SessionControlDeps> = async (frame: AnyFrame, deps, wire) => {
  const req = frame.payload as SessionPullRequestFeedback
  try {
    const result = (await deps.pullRequestFeedback?.(req)) ?? {
      deliveryKey: req.deliveryKey,
      accepted: false,
      reason: 'not_ready' as const
    }
    wire.reply(frame, 'session/pull-request-feedback/result', result)
  } catch (err) {
    wire.sendError(frame.id, 'INTERNAL', `session/pull-request-feedback failed: ${(err as Error).message}`, true)
  }
}
