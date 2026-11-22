// `session/admit` handler — admit a new session for its agent's organization before it starts (org-session-policy.md, Admission).
import { effectiveMemoryDreamingPolicy, isFrame } from '@agentconnect.md/protocol'
import { PLACEMENT_ONLY } from '../../orchestrator/placementResolver.js'
import { AgentId, DaemonId } from '../../domain/ids.js'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'

export const handleSessionAdmit: Handler = async (frame, conn, deps) => {
  if (!isFrame('session/admit')(frame)) return
  const orgId = frameOrgId(frame, conn)
  if (!orgId || !deps.sessionAdmission) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'session admission is unavailable for this organization', false)
    return
  }
  const agentId = AgentId(frame.payload.agentId)
  // A cold move holds this lease for as long as a drain; retryable, unlike an agent this daemon does not serve.
  const release = deps.agentMutations.tryBeginMutation(agentId)
  if (!release) {
    conn.sendError(frame.id, 'INTERNAL', 'agent placement is mutating; retry the admission', true)
    return
  }
  try {
    const agent = await deps.agent.get(orgId, agentId)
    if (!agent || !(await (deps.placementResolver ?? PLACEMENT_ONLY).mayAct(agent, DaemonId(conn.daemonId)))) {
      conn.sendError(frame.id, 'SCOPE_DENIED', 'this daemon does not serve that agent', false)
      return
    }
    // A dream is maintenance only when the agent's own stored config runs dreaming on the managed provider.
    const maintenance =
      frame.payload.purpose === 'memory-dream' && effectiveMemoryDreamingPolicy(agent.memory ?? undefined)?.enabled
        ? frame.payload.purpose
        : undefined
    // The agent's own org, read under the frame's org fence, never one the frame names beyond it.
    const outcome = await deps.sessionAdmission.admit(agent.orgId, agent.id, frame.payload.sessionId, maintenance)
    if (!outcome.admitted) {
      conn.sendError(frame.id, 'SCOPE_DENIED', 'that session id belongs to another agent', false)
      return
    }
    conn.replyTo(frame, 'session/admit/result', { admitted: true, counted: outcome.counted })
  } catch (err) {
    deps.log.error({ err, agentId, sessionId: frame.payload.sessionId }, 'session/admit: admission failed')
    conn.sendError(frame.id, 'INTERNAL', 'session admission failed to persist', true)
  } finally {
    release()
  }
}
