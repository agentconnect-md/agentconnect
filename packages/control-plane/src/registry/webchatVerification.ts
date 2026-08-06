import {
  WEBCHAT_REMOTE_MCP_FEATURE,
  type RcVerifyResult,
  type RcWebchatParticipant,
  type RegisterReq
} from '@agentconnect.md/protocol'
import { AgentId } from '../domain/ids.js'
import type { WebchatRemoteMcpService } from './webchatRemoteMcpService.js'
import type { WebchatTokenService } from './webchatToken.js'

interface VerificationDaemon {
  state: string
  capabilities?: RegisterReq['capabilities']
}

export interface WebchatVerificationDeps {
  tokens: Pick<WebchatTokenService, 'verify'>
  agents: { getUnscoped(agentId: AgentId): Promise<{ orgId: string; daemonId: string | null } | null> }
  daemons: { get(daemonId: string): VerificationDaemon | undefined }
  /** Roster reads for multi-agent conversations (webchat-multi-agents.md §6.2). */
  conversations: {
    participants(conversationId: string): Promise<Array<{ agentId: AgentId; role: 'primary' | 'member' }>>
  }
  remoteMcp: Pick<WebchatRemoteMcpService, 'establish'>
}

/**
 * Builds the relay-facing webchat verifier. Ordinary token and live-placement
 * checks are authoritative. The PRIMARY agent must be placed on a READY daemon
 * (unchanged single-agent behavior); member participants resolve best-effort —
 * one whose daemon is unplaced or not READY is returned WITHOUT a `daemonId`,
 * and the relay refuses turns targeting it. Expected delegation denials return
 * no reference; unexpected dependency failures propagate to the relay handler's
 * retryable INTERNAL response instead of being misreported as a successful
 * verification.
 */
export function createWebchatTokenVerifier(deps: WebchatVerificationDeps): (token: string) => Promise<RcVerifyResult> {
  return async (token) => {
    const claims = await deps.tokens.verify(token)
    if (!claims) return { ok: false, reason: 'invalid token' }
    const agent = await deps.agents.getUnscoped(AgentId(claims.agentId))
    if (!agent || agent.orgId !== claims.orgId) return { ok: false, reason: 'invalid token' }
    if (!agent.daemonId) return { ok: false, reason: 'agent unplaced' }
    const daemon = deps.daemons.get(agent.daemonId)
    if (daemon?.state !== 'READY') return { ok: false, reason: 'daemon offline' }

    // Resolve the roster. An empty result (a conversation minted before the
    // participant backfill, or a mid-deploy create) degrades to the token's
    // primary — exactly the single-agent shape.
    const roster = await deps.conversations.participants(claims.conversationId)
    const participants: RcWebchatParticipant[] = []
    for (const p of roster) {
      if (p.agentId === claims.agentId) {
        participants.push({ agentId: p.agentId, daemonId: agent.daemonId, primary: true })
        continue
      }
      const member = await deps.agents.getUnscoped(p.agentId)
      const memberDaemon =
        member && member.orgId === claims.orgId && member.daemonId ? deps.daemons.get(member.daemonId) : undefined
      participants.push({
        agentId: p.agentId,
        ...(memberDaemon?.state === 'READY' ? { daemonId: member!.daemonId! } : {}),
        ...(p.role === 'primary' ? { primary: true } : {})
      })
    }
    if (participants.length === 0) {
      participants.push({ agentId: claims.agentId, daemonId: agent.daemonId, primary: true })
    }

    const verified: RcVerifyResult = {
      ok: true,
      userId: claims.userId,
      user: claims.user,
      agentId: claims.agentId,
      daemonId: agent.daemonId,
      orgId: claims.orgId,
      conversationId: claims.conversationId,
      participants
    }
    // Delegated admin MCP is a single-participant privilege (webchat-multi-agents.md
    // §10.3): a multi-agent conversation never receives the entitlement.
    if (participants.length > 1) return verified
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
