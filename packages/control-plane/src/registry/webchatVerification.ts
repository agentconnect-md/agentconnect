import { DELEGATED_MCP_ASSERTION_FEATURE, type RcVerifyResult, type RegisterReq } from '@agentconnect.md/protocol'
import { AgentId } from '../domain/ids.js'
import type { WebchatMcpDelegationService } from './webchatMcpDelegationService.js'
import type { WebchatTokenService } from './webchatToken.js'

interface VerificationDaemon {
  state: string
  capabilities?: RegisterReq['capabilities']
}

export interface WebchatVerificationDeps {
  enabled: boolean
  tokens: Pick<WebchatTokenService, 'verify'>
  agents: { get(agentId: AgentId): Promise<{ orgId: string; daemonId: string | null } | null> }
  daemons: { get(daemonId: string): VerificationDaemon | undefined }
  delegations: Pick<WebchatMcpDelegationService, 'establish'>
}

/**
 * Builds the relay-facing webchat verifier. Ordinary token and live-placement
 * checks are authoritative; preset MCP delegation is a best-effort additive
 * entitlement and can only add an opaque reference to an otherwise valid result.
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
    if (!deps.enabled || !daemon.capabilities?.features.includes(DELEGATED_MCP_ASSERTION_FEATURE)) {
      return verified
    }

    try {
      const delegation = await deps.delegations.establish({
        conversationId: claims.conversationId,
        verifiedUserId: claims.userId,
        orgId: claims.orgId,
        agentId: claims.agentId,
        daemonId: agent.daemonId
      })
      return delegation ? { ...verified, delegation } : verified
    } catch {
      return verified
    }
  }
}
