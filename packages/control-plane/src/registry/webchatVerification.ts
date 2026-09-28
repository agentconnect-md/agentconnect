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
    participants(
      orgId: OrgId,
      conversationId: string
    ): Promise<Array<{ agentId: AgentId; role: 'primary' | 'member'; currentSessionId?: string | null }>>
    target(conversationId: string): Promise<{ targetSessionId: string | null } | null>
  }
  /** The primary agent's enabled chat APIs, which the relay's chat API is confined to (shared-bot-relay.md §10.4). */
  apiEntries: { listForAgent(agentId: AgentId): Promise<Array<{ protocol: string }>> }
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

/** The relay's webchat token check: a primary placed on a READY daemon, members best-effort, and a targeted conversation's continuation gates re-run on every dial. */
export function createWebchatTokenVerifier(deps: WebchatVerificationDeps): (token: string) => Promise<RcVerifyResult> {
  const resolve = webchatBinding(deps)
  return async (token) => {
    const claims = await deps.tokens.verify(token)
    if (!claims) return { ok: false, reason: 'invalid token' }
    return resolve(claims, { remoteMcp: true })
  }
}

/** Everything a verdict needs once a credential proved `claims`: live placement, the conversation, its roster, and the agent's chat APIs. */
export function webchatBinding(
  deps: Omit<WebchatVerificationDeps, 'tokens'>
): (claims: WebchatTokenClaims, opts: { remoteMcp: boolean }) => Promise<RcVerifyResult> {
  return async (claims, opts) => {
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
    const apiProtocols = (await deps.apiEntries.listForAgent(AgentId(claims.agentId))).map((e) => e.protocol)

    const verifiedBase = {
      ok: true,
      userId: claims.userId,
      user: claims.user,
      ...(claims.userPicture ? { userPicture: claims.userPicture } : {}),
      agentId: claims.agentId,
      daemonId: agentDaemonId,
      orgId: claims.orgId,
      conversationId: claims.conversationId,
      apiProtocols
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
    if (participants.length > 1 || !opts.remoteMcp) return verified
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

export interface ContentReachDeps {
  sessions: {
    get(
      orgId: OrgId,
      id: SessionId
    ): Promise<{ agentId: string; daemonId: string | null; contentSetId: string | null } | null>
  }
  agents: { get(orgId: OrgId, id: AgentId): Promise<ResolvableAgent | null> }
  placement: Pick<PlacementResolver, 'dispatchDaemon'>
  memberSets: { sharedStoreMemberIdsOf(setId: string): Promise<string[]> }
}

/** Resume fence: each participant's current session must be served where its next turn goes, its recorder or a member of its shared store — a group keeps none, so after a failover the successor never takes a turn without the transcript. */
export async function everyTurnReachesItsContent(
  deps: ContentReachDeps,
  orgId: OrgId,
  currentSessionIds: Array<SessionId | null>
): Promise<boolean> {
  for (const id of currentSessionIds) {
    if (id === null) continue
    const s = await deps.sessions.get(orgId, id)
    const agent = s ? await deps.agents.get(orgId, AgentId(s.agentId)) : null
    if (!s || !agent) continue
    // Nobody to reach right now is an offline agent, not a moved one: the turn waits for a member.
    const target = await deps.placement.dispatchDaemon(agent)
    if (!target) continue
    const sharedStoreMembers = s.contentSetId ? await deps.memberSets.sharedStoreMemberIdsOf(s.contentSetId) : []
    if (!servesSessionContent({ recordedDaemonId: s.daemonId, sharedStoreMembers }, target)) return false
  }
  return true
}
