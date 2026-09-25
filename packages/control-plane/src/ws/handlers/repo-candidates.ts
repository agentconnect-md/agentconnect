import { isFrame } from '@agentconnect.md/protocol'
import { AgentId } from '../../domain/ids.js'
import { GithubApiError } from '../../github/api.js'
import { PLACEMENT_ONLY } from '../../orchestrator/placementResolver.js'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'

// The selector's installation rosters for an agent this daemon serves: control metadata, answered and never stored.
export const handleRepoCandidates: Handler = async (frame, conn, deps) => {
  if (!isFrame('repo-candidates/request')(frame)) return
  const orgId = frameOrgId(frame, conn)
  const service = deps.repoCandidates
  if (!orgId || !service) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'repository candidates are unavailable for this organization', false)
    return
  }
  const authorized = async () => {
    const agent = await deps.agent.get(orgId, AgentId(frame.payload.agentId))
    return agent && (await (deps.placementResolver ?? PLACEMENT_ONLY).mayAct(agent, conn.daemonId)) ? agent : null
  }
  const agent = await authorized()
  if (!agent) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'this daemon does not serve that agent', false)
    return
  }
  try {
    const reply = await service.forAgent(agent)
    if (!(await authorized())) {
      conn.sendError(frame.id, 'SCOPE_DENIED', 'this daemon no longer serves that agent', false)
      return
    }
    conn.replyTo(frame, 'repo-candidates/reply', reply)
  } catch (e) {
    if (e instanceof GithubApiError) {
      conn.sendError(frame.id, e.code, `github: ${e.message}`, e.retryable)
      return
    }
    conn.sendError(frame.id, 'INTERNAL', 'repository candidates could not be read', true)
  }
}
