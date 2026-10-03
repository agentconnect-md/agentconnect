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
import { canView } from '../authorization/policy.js'
import { AgentId, OrgId, SessionId } from '../domain/ids.js'
import { servesSessionContent } from '../domain/session-content.js'
import type { MemberSetRepo, OrgMemberRole, SessionContentStore, Shareable, ViewCtx } from '../persistence/ports.js'
import type { PlacementResolver, ResolvableAgent } from '../orchestrator/placementResolver.js'
import type { WebchatRemoteMcpService } from './webchatRemoteMcpService.js'
import type { WebchatTokenClaims, WebchatTokenService } from './webchatToken.js'

interface VerificationDaemon {
  state: string
  capabilities?: RegisterReq['capabilities']
}

export interface WebchatVerificationDeps {
  tokens: Pick<WebchatTokenService, 'verify'>
  agents: { getUnscoped(agentId: AgentId): Promise<(ResolvableAgent & Shareable & { orgId: string }) | null> }
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
      tenantScope?: string | null
      channel?: string | null
      thread?: string | null
      daemonId: string | null
      contentSetId: string | null
      contentStoreId: string | null
      visibility: string
      ownerIdentity: string | null
      contentPurgedAt: Date | null
    } | null>
  }
  /** Who else holds the shared store a session was written to (`domain/session-content.ts`). */
  memberSets: Pick<MemberSetRepo, 'sharedStoreMemberIdsOf'>
  orgs: { roleOf(orgId: string, userId: string): Promise<string | null> }
  remoteMcp: Pick<WebchatRemoteMcpService, 'establish'>
  /** Resolves the daemon a webchat turn should reach — the holder, or any live member that can
   *  claim the agent's duty on receipt. */
  placement: Pick<PlacementResolver, 'dispatchDaemon'>
}

/** The relay's webchat token check, re-run on every dial: the minter still a member who sees every participant, a primary on a READY daemon, and any continuation gates. */
export function createWebchatTokenVerifier(deps: WebchatVerificationDeps): (token: string) => Promise<RcVerifyResult> {
  const resolve = webchatBinding(deps)
  return async (token) => {
    const claims = await deps.tokens.verify(token)
    if (!claims) return { ok: false, reason: 'invalid token' }
    // The token proves who minted it, not that they still may: membership is re-read on every dial.
    const role = (await deps.orgs.roleOf(claims.orgId, claims.userId)) as OrgMemberRole | null
    if (!role) return ACCESS_REVOKED
    return resolve(claims, { remoteMcp: true, viewer: { userId: claims.userId, role } })
  }
}

const ACCESS_REVOKED: RcVerifyResult = { ok: false, reason: 'access revoked' }

/** Everything a verdict needs once a credential proved `claims`: live placement, the conversation, its roster, and the agent's chat APIs. */
export function webchatBinding(
  deps: Omit<WebchatVerificationDeps, 'tokens'>
): (claims: WebchatTokenClaims, opts: { remoteMcp: boolean; viewer: ViewCtx }) => Promise<RcVerifyResult> {
  return async (claims, opts) => {
    const agent = await deps.agents.getUnscoped(AgentId(claims.agentId))
    if (!agent || agent.orgId !== claims.orgId) return { ok: false, reason: 'invalid token' }
    if (!canView(agent, opts.viewer)) return ACCESS_REVOKED
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
      if (opts.viewer.role === 'viewer') return { ok: false, reason: 'continuation unavailable' }
      // Fence the exact owner proved by mint-time provider-identity expansion against the live row.
      if (
        session.visibility === 'private' &&
        (session.ownerIdentity === null || session.ownerIdentity !== claims.privateSessionOwnerIdentity)
      ) {
        return { ok: false, reason: 'continuation unavailable' }
      }
      // The dispatch daemon must still reach the content: the recorder, or a holder of the shared store it wrote to.
      const sharedStoreMembers = await deps.memberSets.sharedStoreMemberIdsOf(session)
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
        originKindOf(session.platform ?? '') === 'hook'
          ? await hookConversationPeers(deps, session, claims, opts.viewer)
          : []
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
      // A deleted member stays best-effort; one the caller can no longer see revokes the conversation, as at mint.
      if (member && member.orgId === claims.orgId && !canView(member, opts.viewer)) return ACCESS_REVOKED
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

/** The peers mint authorized for a hook target's merged conversation (#2500), each re-checked like the target and kept as a participant carrying its own session; one that drifted is left out rather than failing the token. */
async function hookConversationPeers(
  deps: Omit<WebchatVerificationDeps, 'tokens'>,
  target: { platform: string | null; tenantScope?: string | null; channel?: string | null; thread?: string | null },
  claims: WebchatTokenClaims,
  viewer: ViewCtx
): Promise<RcWebchatParticipant[]> {
  const peers: RcWebchatParticipant[] = []
  for (const claimed of claims.conversationPeers ?? []) {
    const peer = await deps.sessions.getUnscoped(SessionId(claimed.sessionId))
    if (!peer || peer.orgId !== claims.orgId || peer.agentId === claims.agentId) continue
    if (peers.some((p) => p.agentId === peer.agentId)) continue
    const sameConversation =
      peer.platform === target.platform &&
      (peer.tenantScope ?? null) === (target.tenantScope ?? null) &&
      peer.channel === target.channel &&
      peer.thread === target.thread
    if (!sameConversation || peer.contentPurgedAt !== null || !continuableOrigin(peer.platform ?? '')) continue
    if (
      peer.visibility === 'private' &&
      (peer.ownerIdentity === null || peer.ownerIdentity !== claimed.privateOwnerIdentity)
    ) {
      continue
    }
    const agent = await deps.agents.getUnscoped(AgentId(peer.agentId))
    if (!agent || agent.orgId !== claims.orgId || !canView(agent, viewer)) continue
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
    const sharedStoreMembers = await deps.memberSets.sharedStoreMemberIdsOf(peer)
    if (!servesSessionContent({ recordedDaemonId: peer.daemonId, sharedStoreMembers }, daemonId)) continue
    peers.push({ agentId: peer.agentId, daemonId, targetSessionId: claimed.sessionId })
  }
  return peers
}

export interface ContentReachDeps {
  sessions: {
    get(
      orgId: OrgId,
      id: SessionId
    ): Promise<({ agentId: string; daemonId: string | null } & SessionContentStore) | null>
  }
  agents: { get(orgId: OrgId, id: AgentId): Promise<ResolvableAgent | null> }
  placement: Pick<PlacementResolver, 'dispatchDaemon'>
  memberSets: Pick<MemberSetRepo, 'sharedStoreMemberIdsOf'>
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
    const sharedStoreMembers = await deps.memberSets.sharedStoreMemberIdsOf(s)
    if (!servesSessionContent({ recordedDaemonId: s.daemonId, sharedStoreMembers }, target)) return false
  }
  return true
}
