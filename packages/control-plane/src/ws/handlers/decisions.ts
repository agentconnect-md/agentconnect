import { DECISION_LIST_MAX_BYTES, isFrame, type DecisionListReply } from '@agentconnect.md/protocol'
import { AgentId } from '../../domain/ids.js'
import { PLACEMENT_ONLY } from '../../orchestrator/placementResolver.js'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'

export const handleDecisionRead: Handler = async (frame, conn, deps) => {
  if (!isFrame('decision/list')(frame) && !isFrame('decision/get')(frame)) return
  const orgId = frameOrgId(frame, conn)
  const repo = deps.decision
  if (!orgId || !repo) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'Decisions are unavailable for this organization', false)
    return
  }
  const authorized = async () => {
    const agent = await deps.agent.get(orgId, AgentId(frame.payload.requesterAgentId))
    return agent && (await (deps.placementResolver ?? PLACEMENT_ONLY).mayAct(agent, conn.daemonId)) ? agent : null
  }
  const agent = await authorized()
  if (!agent) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'this daemon does not serve that agent', false)
    return
  }
  if (isFrame('decision/list')(frame)) {
    const rows = await repo.listForAgent(orgId, agent.decisionIds ?? [], frame.payload)
    const result: DecisionListReply = { items: [], nextCursor: null }
    for (const row of rows) {
      const candidate = { items: [...result.items, row], nextCursor: row.id }
      if (
        result.items.length === frame.payload.limit ||
        Buffer.byteLength(JSON.stringify(candidate), 'utf8') > DECISION_LIST_MAX_BYTES
      ) {
        result.nextCursor = result.items.at(-1)!.id
        break
      }
      result.items.push(row)
    }
    const current = await authorized()
    if (!current) {
      conn.sendError(frame.id, 'SCOPE_DENIED', 'this daemon no longer serves that agent', false)
      return
    }
    result.items = result.items.filter((item) => current.decisionIds?.includes(item.id))
    conn.replyTo(frame, 'decision/list/result', result)
  } else {
    const bound = (current: typeof agent) =>
      frame.payload.purpose === 'model_selection'
        ? current.modelSelection?.decisionId === frame.payload.decisionId
        : current.decisionIds?.includes(frame.payload.decisionId)
    const decision = bound(agent) ? await repo.getForAgent(orgId, frame.payload.decisionId) : null
    const current = await authorized()
    if (!current) {
      conn.sendError(frame.id, 'SCOPE_DENIED', 'this daemon no longer serves that agent', false)
      return
    }
    conn.replyTo(frame, 'decision/get/result', {
      decision: bound(current) ? decision : null
    })
  }
}
