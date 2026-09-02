import {
  continuableOrigin,
  originKindOf,
  WEBCHAT_HOOK_CONTINUATION_FEATURE,
  WEBCHAT_REMOTE_MCP_FEATURE,
  WEBCHAT_SESSION_CONTINUATION_FEATURE,
  type RcVerifyResult,
  type RcWebchatParticipant,
  type RegisterReq
} from '@agentconnect.md/protocol'
import { AgentId, OrgId, SessionId } from '../domain/ids.js'
import { servesSessionContent } from '../domain/session-content.js'
import type { PlacementResolver, ResolvableAgent } from '../orchestrator/placementResolver.js'
import type { WebchatRemoteMcpService } from './webchatRemoteMcpService.js'
import type { WebchatTokenService } from './webchatToken.js'

interface VerificationDaemon {
  state: string
  capabilities?: RegisterReq['capabilities']
}

export interface WebchatVerificationDeps {
  tokens: Pick<WebchatTokenService, 'verify'>
  agents: { getUnscoped(agentId: AgentId): Promise<(ResolvableAgent & { orgId: string }) | null> }
  daemons: { get(daemonId: string): VerificationDaemon | undefined }
  /** Roster reads for multi-agent conversations (webchat-multi-agents.md §6.2). */
  conversations: {
    participants(orgId: OrgId, conversationId: string): Promise<Array<{ agentId: AgentId; role: 'primary' | 'member' }>>
    target(conversationId: string): Promise<{ targetSessionId: string | null } | null>
  }
  /** Session-targeted continuation re-checks (webchat-cross-integration-continuation.md §6.2). */
  sessions: {
    getUnscoped(id: SessionId): Promise<{
      orgId: string
      agentId: string
      platform: string | null
      daemonId: string | null
      contentSetId: string | null
      visibility: string
      ownerIdentity: string | null
      contentPurgedAt: Date | null
    } | null>
  }
  /** Who else holds the shared store a session was written to (`domain/session-content.ts`). */
  memberSets: { sharedStoreMemberIdsOf(setId: string): Promise<string[]> }
  orgs: { roleOf(orgId: string, userId: string): Promise<string | null> }
  remoteMcp: Pick<WebchatRemoteMcpService, 'establish'>
  /** Resolves the daemon a webchat turn should reach — the holder, or any live member that can
   *  claim the agent's duty on receipt. */
  placement: Pick<PlacementResolver, 'dispatchDaemon'>
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
 *
 * A SESSION-TARGETED conversation (non-null `targetSessionId`) re-checks the
 * continuation gates on every dial: the target session must exist un-purged and
 * chat-origin, the signed user must still hold a non-viewer role (private
 * sessions: console ownership), and the owner agent's dispatch daemon must still
 * serve the session's content (its recorder, or a holder of the shared store it
 * was written to) with the continuation capability. Any drift
 * fails the token instead of degrading into a fresh webchat session. The full
 * provider-identity expansion ran at mint (≤ token TTL ago); verify re-checks
 * with the console identity, which fails closed for platform-identity owners.
 */
export function createWebchatTokenVerifier(deps: WebchatVerificationDeps): (token: string) => Promise<RcVerifyResult> {
  return async (token) => {
    const claims = await deps.tokens.verify(token)
    if (!claims) return { ok: false, reason: 'invalid token' }
    const agent = await deps.agents.getUnscoped(AgentId(claims.agentId))
    if (!agent || agent.orgId !== claims.orgId) return { ok: false, reason: 'invalid token' }
    // Readiness is the resolver's answer, not a member id the row happens to carry: a pool agent
    // is dialable while ANY member is live, and after a rollout the member its row used to name is
    // gone by construction — which is what made webchat permanently offline (#987). A lapsed lease
    // resolves to a live member anyway; it claims the group on receipt.
    const agentDaemonId = await deps.placement.dispatchDaemon(agent)
    if (!agentDaemonId) return { ok: false, reason: 'agent unplaced' }
    const daemon = deps.daemons.get(agentDaemonId)
    if (daemon?.state !== 'READY') return { ok: false, reason: 'daemon offline' }

    // The durable conversation row is required for every dial; a targeted row
    // additionally re-runs the continuation gates. Purge or metadata deletion
    // therefore invalidates outstanding tokens instead of silently creating a
    // fresh webchat session.
    const conversation = await deps.conversations.target(claims.conversationId)
    if (!conversation) return { ok: false, reason: 'unknown conversation' }
    const targetSessionId = conversation.targetSessionId

    const verifiedBase = {
      ok: true,
      userId: claims.userId,
      user: claims.user,
      agentId: claims.agentId,
      daemonId: agentDaemonId,
      orgId: claims.orgId,
      conversationId: claims.conversationId
    }

    if (targetSessionId !== null) {
      const session = await deps.sessions.getUnscoped(SessionId(targetSessionId))
      if (!session || session.orgId !== claims.orgId || session.agentId !== claims.agentId) {
        return { ok: false, reason: 'continuation unavailable' }
      }
      if (session.contentPurgedAt !== null) return { ok: false, reason: 'continuation unavailable' }
      if (!continuableOrigin(session.platform ?? '')) return { ok: false, reason: 'continuation unavailable' }
      const role = await deps.orgs.roleOf(claims.orgId, claims.userId)
      if (!role || role === 'viewer') return { ok: false, reason: 'continuation unavailable' }
      // Fence the exact owner proved by mint-time provider-identity expansion against the live row.
      if (
        session.visibility === 'private' &&
        (session.ownerIdentity === null || session.ownerIdentity !== claims.privateSessionOwnerIdentity)
      ) {
        return { ok: false, reason: 'continuation unavailable' }
      }
      // The dispatch daemon must still reach the content: the recorder, or a holder of the shared store it wrote to.
      const sharedStoreMembers = session.contentSetId
        ? await deps.memberSets.sharedStoreMemberIdsOf(session.contentSetId)
        : []
      if (!servesSessionContent({ recordedDaemonId: session.daemonId, sharedStoreMembers }, agentDaemonId)) {
        return { ok: false, reason: 'continuation unavailable' }
      }
      if (!daemon.capabilities?.features.includes(WEBCHAT_SESSION_CONTINUATION_FEATURE)) {
        return { ok: false, reason: 'continuation unavailable' }
      }
      // Console-only hook continuation is a strictly newer daemon behavior (§9).
      if (
        originKindOf(session.platform ?? '') === 'hook' &&
        !daemon.capabilities.features.includes(WEBCHAT_HOOK_CONTINUATION_FEATURE)
      ) {
        return { ok: false, reason: 'continuation unavailable' }
      }
      // Single fixed participant; no roster growth, no remote MCP entitlement.
      return {
        ...verifiedBase,
        participants: [{ agentId: claims.agentId, daemonId: agentDaemonId, primary: true }],
        targetSessionId
      }
    }

    // Resolve the roster. An empty result (a conversation minted before the
    // participant backfill, or a mid-deploy create) degrades to the token's
    // primary — exactly the single-agent shape.
    // Fenced on the org the signed token asserts (org-scoped-data-layer.md §3).
    const roster = await deps.conversations.participants(OrgId(claims.orgId), claims.conversationId)
    const participants: RcWebchatParticipant[] = []
    for (const p of roster) {
      if (p.agentId === claims.agentId) {
        participants.push({ agentId: p.agentId, daemonId: agentDaemonId, primary: true })
        continue
      }
      const member = await deps.agents.getUnscoped(p.agentId)
      const memberDaemonId =
        member && member.orgId === claims.orgId ? await deps.placement.dispatchDaemon(member) : null
      const memberDaemon = memberDaemonId ? deps.daemons.get(memberDaemonId) : undefined
      participants.push({
        agentId: p.agentId,
        ...(memberDaemon?.state === 'READY' && memberDaemonId ? { daemonId: memberDaemonId } : {}),
        ...(p.role === 'primary' ? { primary: true } : {})
      })
    }
    if (participants.length === 0) {
      participants.push({ agentId: claims.agentId, daemonId: agentDaemonId, primary: true })
    }

    const verified: RcVerifyResult = { ...verifiedBase, participants }
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
      daemonId: agentDaemonId
    })
    return entitlement ? { ...verified, remoteMcp: entitlement } : verified
  }
}
