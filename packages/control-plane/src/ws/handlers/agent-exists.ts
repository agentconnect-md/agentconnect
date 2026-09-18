// `agent/exists` handler — the batch existence read behind the pool's orphan reconciler.
// A member lists sandbox objects in its cluster, reads the agent ids they carry, and asks
// here in one round trip which of those agents still exist. Existence only: an id absent
// from the reply is gone and its objects may be collected; a present id is live and its
// objects are never touched. An org-scoped connection sees only its own org's agents.
//
// A request that names the set it sweeps for also gets `elsewhere`: the surviving ids
// placement no longer puts on that set, each with when its placement last changed. Those
// agents are live, but nothing in the set will ever serve their objects or rows again, and
// the timestamp is the only trustworthy age a scheduled sweep has for that departure.
import { isFrame } from '@agentconnect.md/protocol'
import { AgentId } from '../../domain/ids.js'
import { placedOnSet } from '../../domain/placement.js'
import type { Handler } from './index.js'

export const handleAgentExists: Handler = async (frame, conn, deps) => {
  if (!isFrame('agent/exists')(frame)) return
  const asked = [...new Set(frame.payload.agentIds)].map((id) => AgentId(id))
  const setId = frame.payload.placedOnSetId
  const agents = await deps.agent.listByIds(asked)
  const visible = agents.filter((agent) => conn.orgId === null || agent.orgId === conn.orgId)
  const existing = visible.map((agent) => agent.id)
  const elsewhere = setId
    ? visible
        .filter((agent) => !placedOnSet(agent, setId))
        .map((agent) => ({ agentId: agent.id, since: agent.placementChangedAt.toISOString() }))
    : undefined
  conn.replyTo(frame, 'agent/exists/ok', { existing, ...(elsewhere ? { elsewhere } : {}) })
}
