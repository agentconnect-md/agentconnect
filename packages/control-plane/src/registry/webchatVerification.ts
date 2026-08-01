import { WEBCHAT_REMOTE_MCP_FEATURE, type RcVerifyResult, type RegisterReq } from '@agentconnect.md/protocol'
import { AgentId } from '../domain/ids.js'
import type { WebchatRemoteMcpService } from './webchatRemoteMcpService.js'
import type { WebchatTokenService } from './webchatToken.js'

interface VerificationDaemon {
  state: string
  capabilities?: RegisterReq['capabilities']
}

export interface WebchatVerificationDeps {
  tokens: Pick<WebchatTokenService, 'verify'>
  agents: { get(agentId: AgentId): Promise<{ orgId: string; daemonId: string | null } | null> }
  daemons: { get(daemonId: string): VerificationDaemon | undefined }
  remoteMcp: Pick<WebchatRemoteMcpService, 'establish'>
}

/**
 * Builds the relay-facing webchat verifier. Ordinary token and live-placement
 * checks are authoritative. Expected delegation denials return no reference;
 * unexpected dependency failures propagate to the relay handler's retryable
 * INTERNAL response instead of being misreported as a successful verification.
 */
export function createWebchatTokenVerifier(deps: WebchatVerificationDeps): (token: string) => Promise<RcVerifyResult> {
  return async (token) => {
    const claims = await deps.tokens.verify(token)
    if (!claims) return { ok: false, reason: 'invalid token' }
    const agent = await deps.agents.get(AgentId(claims.agentId))
    if (!agent || agent.orgId !== claims.orgId) return { ok: false, reason: 'invalid token' }
    if (!agent.daemonId) return { ok: false, reason: 'agent unplaced' }
    const daemon = deps.daemons.get(agent.daemonId)
    if (daemon?.state !== 'READY') return { ok: false, reason: 'daemon offline' }

    const verified: RcVerifyResult = {
      ok: true,
      userId: claims.userId,
      user: claims.user,
      agentId: claims.agentId,
      daemonId: agent.daemonId,
      orgId: claims.orgId,
      conversationId: claims.conversationId
    }
    if (!daemon.capabilities?.features.includes(WEBCHAT_REMOTE_MCP_FEATURE)) {
      return verified
    }

    const entitlement = await deps.remoteMcp.establish({
      conversationId: claims.conversationId,
      verifiedUserId: claims.userId,
      orgId: claims.orgId,
      agentId: claims.agentId,
      daemonId: agent.daemonId
    })
    return entitlement ? { ...verified, remoteMcp: entitlement } : verified
  }
}
