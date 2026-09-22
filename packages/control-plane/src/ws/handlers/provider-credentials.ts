import { isFrame, REPLY_BUDGET } from '@agentconnect.md/protocol'
import { AgentId } from '../../domain/ids.js'
import { PLACEMENT_ONLY } from '../../orchestrator/placementResolver.js'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'

export const handleProviderCredentials: Handler = async (frame, conn, deps) => {
  if (!isFrame('provider-credentials/request')(frame)) return
  const orgId = frameOrgId(frame, conn)
  if (!orgId || !deps.providerKey) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'provider credentials are unavailable for this organization', false)
    return
  }
  const { agentId, provider } = frame.payload
  const authorized = async () => {
    const agent = await deps.agent.get(orgId, AgentId(agentId))
    return !!agent && (await (deps.placementResolver ?? PLACEMENT_ONLY).mayAct(agent, conn.daemonId))
  }
  if (!(await authorized())) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'this daemon does not serve that agent', false)
    return
  }
  try {
    const credentials = await deps.providerKey.get(orgId, provider)
    if (!(await authorized())) {
      conn.sendError(frame.id, 'SCOPE_DENIED', 'this daemon no longer serves that agent', false)
      return
    }
    if (Buffer.byteLength(JSON.stringify({ credentials }), 'utf8') > REPLY_BUDGET) {
      conn.sendError(frame.id, 'LEASE_DENIED', 'provider configuration exceeds the credential delivery limit', false)
      return
    }
    conn.replyTo(frame, 'provider-credentials/reply', { credentials })
  } catch {
    // Cipher errors may contain secret values; return only a stable failure classification.
    conn.sendError(frame.id, 'INTERNAL', 'provider credentials could not be read', true)
  }
}
