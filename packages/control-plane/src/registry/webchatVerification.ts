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
import type { WebchatTokenClaims, WebchatTokenService } from './webchatToken.js'
import type { ConversationKey } from '../persistence/ports.js'

interface VerificationDaemon {
  state: string
  capabilities?: RegisterReq['capabilities']
}

/** The member-session fields a peer's continuation gate reads. */
interface ConversationMember {
  id: string
  agentId: string
  daemonId: string | null
  contentSetId: string | null
  visibility: string
  contentPurgedAt: Date | null
}

export interface WebchatVerificationDeps {
  tokens: Pick<WebchatTokenService, 'verify'>
  agents: { getUnscoped(agentId: AgentId): Promise<(ResolvableAgent & { orgId: string }) | null> }
  daemons: { get(daemonId: string): VerificationDaemon | undefined }
  /** Roster reads for multi-agent conversations (webchat-multi-agents.md §6.2). */
  conversations: {
    participants(
      orgId: OrgId,
      conversationId: string
    ): Promise<Array<{ agentId: AgentId; role: 'primary' | 'member'; currentSessionId?: string | null }>>
    target(conversationId: string): Promise<{ targetSessionId: string | null } | null>
  }
  /** Session-targeted continuation re-checks (webchat-cross-integration-continuation.md §6.2). */
  sessions: {
    getUnscoped(id: SessionId): Promise<{
      orgId: string
      agentId: string
      platform: string | null
      tenantScope?: string | null
      channel?: string | null
      thread?: string | null
      daemonId: string | null
      contentSetId: string | null
      visibility: string
      ownerIdentity: string | null
      contentPurgedAt: Date | null
    } | null>
  }
  /** The current session per agent of one merged conversation in the org, unfiltered by viewer (merged-conversation-view.md §5.2). */
  conversationMembers?: (orgId: string, key: ConversationKey) => Promise<ConversationMember[]>
  /** Who else holds the shared store a session was written to (`domain/session-content.ts`). */
  memberSets: { sharedStoreMemberIdsOf(setId: string): Promise<string[]> }
  orgs: { roleOf(orgId: string, userId: string): Promise<string | null> }
  remoteMcp: Pick<WebchatRemoteMcpService, 'establish'>
  /** Resolves the daemon a webchat turn should reach — the holder, or any live member that can
   *  claim the agent's duty on receipt. */
  placement: Pick<PlacementResolver, 'dispatchDaemon'>
}

/** Builds the relay-facing webchat verifier: the primary must be placed on a READY daemon while members resolve best-effort, and a session-targeted row re-runs its continuation gates on every dial so drift fails the token instead of opening a fresh webchat session. */
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
      ...(claims.userPicture ? { userPicture: claims.userPicture } : {}),
      agentId: claims.agentId,
      daemonId: agentDaemonId,
      orgId: claims.orgId,
      conversationId: claims.conversationId,
      // The minting key's agent-level permission, so the relay confines the token to the agent chat API (§10.4).
      ...(claims.permission ? { permission: claims.permission } : {})
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
      // No roster growth and no remote MCP entitlement; a hook target also brings its conversation's other members (#2500).
      const peers =
        originKindOf(session.platform ?? '') === 'hook' ? await hookConversationPeers(deps, session, claims) : []
      return {
        ...verifiedBase,
        participants: [{ agentId: claims.agentId, daemonId: agentDaemonId, primary: true }, ...peers],
        targetSessionId
      }
    }

    // Resolve the roster. An empty result (a conversation minted before the
    // participant backfill, or a mid-deploy create) degrades to the token's
    // primary — exactly the single-agent shape.
    // Fenced on the org the signed token asserts (org-scoped-data-layer.md §3).
    const roster = await deps.conversations.participants(OrgId(claims.orgId), claims.conversationId)
    const participants: RcWebchatParticipant[] = []
    // Where this participant's content is, so a member the turn reaches another way can refuse it (#2218).
    const recordedBy = async (sessionId?: string | null): Promise<{ recordedDaemonId?: string }> => {
      if (!sessionId) return {}
      const session = await deps.sessions.getUnscoped(SessionId(sessionId))
      return session?.daemonId ? { recordedDaemonId: session.daemonId } : {}
    }
    for (const p of roster) {
      if (p.agentId === claims.agentId) {
        participants.push({
          agentId: p.agentId,
          daemonId: agentDaemonId,
          ...(await recordedBy(p.currentSessionId)),
          primary: true
        })
        continue
      }
      const member = await deps.agents.getUnscoped(p.agentId)
      const memberDaemonId =
        member && member.orgId === claims.orgId ? await deps.placement.dispatchDaemon(member) : null
      const memberDaemon = memberDaemonId ? deps.daemons.get(memberDaemonId) : undefined
      participants.push({
        agentId: p.agentId,
        ...(memberDaemon?.state === 'READY' && memberDaemonId ? { daemonId: memberDaemonId } : {}),
        ...(await recordedBy(p.currentSessionId)),
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

/** The other agents' sessions of a hook target's merged conversation that pass the same continuation gates, each as a participant carrying its own target (#2500); a private one stays out, since only the target's owner was proven at mint. */
async function hookConversationPeers(
  deps: WebchatVerificationDeps,
  target: { platform: string | null; tenantScope?: string | null; channel?: string | null; thread?: string | null },
  claims: WebchatTokenClaims
): Promise<RcWebchatParticipant[]> {
  if (!deps.conversationMembers || !target.platform || !target.channel || !target.thread) return []
  const members = await deps.conversationMembers(claims.orgId, {
    platform: target.platform,
    tenantScope: target.tenantScope ?? null,
    channel: target.channel,
    thread: target.thread
  })
  const peers: RcWebchatParticipant[] = []
  for (const member of members) {
    if (member.agentId === claims.agentId || member.visibility !== 'org' || member.contentPurgedAt !== null) continue
    const agent = await deps.agents.getUnscoped(AgentId(member.agentId))
    if (!agent || agent.orgId !== claims.orgId) continue
    const daemonId = await deps.placement.dispatchDaemon(agent)
    const daemon = daemonId ? deps.daemons.get(daemonId) : undefined
    if (!daemonId || daemon?.state !== 'READY') continue
    const features = daemon.capabilities?.features ?? []
    if (
      !features.includes(WEBCHAT_SESSION_CONTINUATION_FEATURE) ||
      !features.includes(WEBCHAT_HOOK_CONTINUATION_FEATURE)
    ) {
      continue
    }
    const sharedStoreMembers = member.contentSetId
      ? await deps.memberSets.sharedStoreMemberIdsOf(member.contentSetId)
      : []
    if (!servesSessionContent({ recordedDaemonId: member.daemonId, sharedStoreMembers }, daemonId)) continue
    peers.push({ agentId: member.agentId, daemonId, targetSessionId: member.id })
  }
  return peers
}
