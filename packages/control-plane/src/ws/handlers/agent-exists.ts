// `agent/exists` handler — the batch existence read behind the pool's orphan reconciler.
// A member lists sandbox objects in its cluster, reads the agent ids they carry, and asks
// here in one round trip which of those agents still exist. Existence only: an id absent
// from the reply is gone and its objects may be collected; a present id is live and its
// objects are never touched. An org-scoped connection sees only its own org's agents.
import { isFrame } from '@agentconnect.md/protocol'
import { AgentId } from '../../domain/ids.js'
import type { Handler } from './index.js'

export const handleAgentExists: Handler = async (frame, conn, deps) => {
  if (!isFrame('agent/exists')(frame)) return
  const asked = [...new Set(frame.payload.agentIds)].map((id) => AgentId(id))
  const agents = await deps.agent.listByIds(asked)
  const existing = agents.filter((agent) => conn.orgId === null || agent.orgId === conn.orgId).map((agent) => agent.id)
  conn.replyTo(frame, 'agent/exists/ok', { existing })
}
