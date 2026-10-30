import { decodeJwt } from 'jose'
import {
  API_AHP_V1_FEATURE,
  WEBCHAT_SESSION_CONTINUATION_FEATURE,
  WEBCHAT_HOOK_CONTINUATION_FEATURE,
  continuableSession,
  isDelegatedTaskCoordinate,
  isSubsessionCoordinate,
  originKindOf,
  TASK_PAGE_MESSAGES_FEATURE,
  type ChatCallerRole,
  type RcVerifyResult
} from '@agentconnect.md/protocol'
import {
  canContinueSession,
  canViewSession,
  canEdit,
  canView,
  identitySetOf,
  type SessionViewable
} from '../authorization/policy.js'
import { chatApprovalsAllowed, chatCallerRole } from '../domain/chat-actions.js'
import { continuationAudience, continuationParentId } from '../domain/continuation-audience.js'
import { AgentId, OrgId, SessionId } from '../domain/ids.js'
import type {
  AhpSessionBindingRecord,
  ApiKeyRepo,
  OrgMemberRole,
  SessionExternalAccessSnapshot
} from '../persistence/ports.js'
import type { AgentChatKeyVerificationDeps } from './agentChatKeyVerification.js'
import { webchatAuthorIdentity } from './agentChatKeyVerification.js'
import type { AhpGrantClaims, AhpGrantService } from './ahpGrant.js'
import type { WebchatTokenService } from './webchatToken.js'
import { webchatBinding } from './webchatVerification.js'

export interface AhpAuthorizationDeps extends AgentChatKeyVerificationDeps {
  grants: AhpGrantService
  tokens: Pick<WebchatTokenService, 'verify'>
  keyRows: Pick<ApiKeyRepo, 'listForUser'>
  config: { AHP_MODE: 'off' | 'shadow' | 'on'; AHP_PUBLIC_ACCESS: boolean; AHP_TEST_KEY_IDS: string[] }
  now: () => number
  sessionAccess(
    claims: AhpGrantClaims,
    session: SessionViewable
  ): Promise<{
    identitySet: ReadonlySet<string>
    externalAccess?: SessionExternalAccessSnapshot
  }>
}

const denied = (): RcVerifyResult => ({ ok: false, reason: 'AHP access unavailable' })

export class AhpAuthorization {
  constructor(private readonly deps: AhpAuthorizationDeps) {}

  private async agentAccess(claims: Pick<AhpGrantClaims, 'orgId' | 'agentId' | 'userId' | 'apiKeyId'>) {
    const d = this.deps
    if (d.config.AHP_MODE !== 'on') return null
    const role = (await d.orgs.roleOf(claims.orgId, claims.userId)) as OrgMemberRole | null
    const agent = await d.agents.getUnscoped(AgentId(claims.agentId))
    if (!role || !agent || agent.orgId !== claims.orgId || !canView(agent, { userId: claims.userId, role })) return null
    // The API entry opts an agent into key-driven clients; the console's own Webchat is not one of them.
    if (
      claims.apiKeyId &&
      !(await d.apiEntries.listForAgent(AgentId(claims.agentId))).some((entry) => entry.protocol === 'ahp')
    )
      return null
    const daemonId = await d.placement.dispatchDaemon(agent)
    const daemon = daemonId ? d.daemons.get(daemonId) : undefined
    if (!daemonId || daemon?.state !== 'READY' || !daemon.capabilities?.features.includes(API_AHP_V1_FEATURE))
      return null
    return { agent, daemonId, viewer: { userId: claims.userId, role } }
  }

  private async liveKey(claims: AhpGrantClaims) {
    if (!claims.apiKeyId) return null
    const d = this.deps
    if (!d.config.AHP_PUBLIC_ACCESS && !d.config.AHP_TEST_KEY_IDS.includes(claims.apiKeyId)) return null
    const key = (await d.keyRows.listForUser(claims.userId, { includeRevoked: true })).find(
      (row) => row.id === claims.apiKeyId
    )
    if (
      !key ||
      key.orgId !== claims.orgId ||
      key.principalType !== 'user' ||
      key.permission !== 'full' ||
      key.scopes.length > 0 ||
      key.revokedAt ||
      (key.expiresAt && key.expiresAt.getTime() <= d.now())
    )
      return null
    return key
  }

  async verifyKey(req: { credential: string; agentId: string }): Promise<RcVerifyResult> {
    const d = this.deps
    const key = await d.keys.authenticateUser(req.credential)
    if (!key || key.permission !== 'full' || key.scopes.length > 0) return denied()
    const claims = {
      orgId: key.orgId,
      agentId: req.agentId,
      userId: key.userId,
      user: key.userId,
      apiKeyId: key.apiKeyId
    }
    const row = await this.liveKey(claims)
    const access = row ? await this.agentAccess(claims) : null
    if (!row || !access) return denied()
    const author = await webchatAuthorIdentity(d, key.userId)
    const ahpGrant = await d.grants.mint({ ...claims, user: author.user }, row.expiresAt?.getTime())
    return {
      ok: true,
      orgId: claims.orgId,
      agentId: claims.agentId,
      userId: claims.userId,
      ...author,
      daemonId: access.daemonId,
      apiProtocols: ['ahp'],
      ahpGrant,
      callerRole: chatCallerRole(canEdit(access.agent, access.viewer), false),
      callerApproves: canEdit(access.agent, access.viewer) || chatApprovalsAllowed(access.agent)
    }
  }

  private async conversationAccess(claims: Pick<AhpGrantClaims, 'orgId' | 'userId' | 'conversationId'>) {
    const binding = await this.deps.conversations.resumeBinding(claims.conversationId!, OrgId(claims.orgId))
    if (!binding) return null
    if (!(await this.deps.reachesContent(OrgId(claims.orgId), binding.currentSessionIds))) return null
    if (binding.ownerUserId === claims.userId) return binding
    const role = (await this.deps.orgs.roleOf(claims.orgId, claims.userId)) as OrgMemberRole | null
    if (!role || binding.currentSessionIds.length === 0 || binding.currentSessionIds.some((id) => id === null))
      return null
    const viewer = { userId: claims.userId, role }
    for (const id of binding.currentSessionIds) {
      const session = await this.deps.sessions.getUnscoped(SessionId(id!))
      const audience = session ? await this.continuationAudienceOf(session) : null
      if (
        !session ||
        !audience ||
        session.orgId !== claims.orgId ||
        session.contentPurgedAt !== null ||
        !canContinueSession(audience as SessionViewable, viewer, identitySetOf(viewer))
      )
        return null
    }
    return binding
  }

  async verifyBrowser(req: { credential: string; agentId?: string }): Promise<RcVerifyResult> {
    const d = this.deps
    const claims = await d.tokens.verify(req.credential)
    if (!claims || claims.protocol !== 'ahp' || !(await this.conversationAccess(claims))) return denied()
    const role = (await d.orgs.roleOf(claims.orgId, claims.userId)) as OrgMemberRole | null
    if (!role) return denied()
    const verdict = await webchatBinding(d)(claims, { remoteMcp: false, viewer: { userId: claims.userId, role } })
    if (!verdict.ok) return denied()
    const agentId = req.agentId ?? claims.agentId
    const participant = verdict.participants?.find((p) => p.agentId === agentId)
    if (agentId !== claims.agentId && !participant) return denied()
    const access = await this.agentAccess({ ...claims, agentId })
    if (!access) return denied()
    const expiry = decodeJwt(req.credential).exp
    if (!expiry) return denied()
    const { targetSessionId: primaryTarget, ...browserVerdict } = verdict
    const targetSessionId = agentId === claims.agentId ? primaryTarget : participant?.targetSessionId
    const ahpGrant = await d.grants.mint(
      {
        orgId: claims.orgId,
        agentId,
        userId: claims.userId,
        user: claims.user,
        conversationId: claims.conversationId,
        protocol: 'ahp',
        ...(targetSessionId ? { targetSessionId } : {}),
        ...(claims.conversationPeers ? { conversationPeers: claims.conversationPeers } : {}),
        ...(claims.privateSessionOwnerIdentity
          ? { privateSessionOwnerIdentity: claims.privateSessionOwnerIdentity }
          : {})
      },
      expiry * 1000
    )
    return {
      ...browserVerdict,
      agentId,
      daemonId: access.daemonId,
      apiProtocols: ['ahp'],
      ...(targetSessionId ? { targetSessionId } : {}),
      ahpGrant,
      callerRole: participant?.callerRole ?? chatCallerRole(canEdit(access.agent, access.viewer), false),
      callerApproves: canEdit(access.agent, access.viewer) || chatApprovalsAllowed(access.agent)
    }
  }

  /** A task is continued by whoever may continue its owning session (auto-session-mode.md §10). */
  private async continuationAudienceOf<S extends Parameters<typeof continuationAudience>[0]>(session: S) {
    const parentId = continuationParentId(session)
    return continuationAudience(session, parentId ? await this.deps.sessions.getUnscoped(SessionId(parentId)) : null)
  }

  private async sessionAllowed(
    claims: AhpGrantClaims,
    access: NonNullable<Awaited<ReturnType<AhpAuthorization['agentAccess']>>>,
    sessionId: string,
    session: NonNullable<Awaited<ReturnType<AhpAuthorizationDeps['sessions']['getUnscoped']>>>,
    ownConversation: boolean,
    continued: boolean
  ): Promise<boolean> {
    if (session.orgId !== claims.orgId || session.agentId !== claims.agentId || session.contentPurgedAt !== null)
      return false
    const subject = continued ? await this.continuationAudienceOf(session) : session
    if (!subject) return false
    const audience = await this.deps.sessionAccess(claims, subject as SessionViewable)
    const allowed = ownConversation ? canViewSession : canContinueSession
    if (!allowed(subject as SessionViewable, access.viewer, audience.identitySet, audience.externalAccess)) return false
    if (!(await this.deps.reachesContent(OrgId(claims.orgId), [SessionId(sessionId)]))) return false
    if (continued) {
      if (session.platform === 'webchat' && !isSubsessionCoordinate(session.thread)) {
        const source = await this.deps.conversations.target(session.channel ?? '')
        const roster = await this.deps.conversations.participants(OrgId(claims.orgId), session.channel ?? '')
        if (
          !source ||
          source.targetSessionId !== null ||
          !roster.some((slot) => slot.agentId === claims.agentId && slot.currentSessionId === sessionId)
        )
          return false
      }
      const features = this.deps.daemons.get(access.daemonId)?.capabilities?.features ?? []
      if (!continuableSession(session) || !features.includes(WEBCHAT_SESSION_CONTINUATION_FEATURE)) return false
      if (originKindOf(session.platform ?? '') === 'hook' && !features.includes(WEBCHAT_HOOK_CONTINUATION_FEATURE))
        return false
      if (isDelegatedTaskCoordinate(session.thread) && !features.includes(TASK_PAGE_MESSAGES_FEATURE)) return false
    }
    return true
  }

  /** Discovery checks current visibility before creating any continuation metadata. */
  async authorizeExisting(claims: AhpGrantClaims, sessionId: string): Promise<boolean> {
    const access = await this.agentAccess(claims)
    const session = await this.deps.sessions.getUnscoped(SessionId(sessionId))
    if (!access || !session) return false
    let ownConversation = false
    // A webchat conversation's task is no member of it, so it is continued by target too (auto-session-mode.md §10).
    const continued = session.platform !== 'webchat' || isSubsessionCoordinate(session.thread)
    if (!continued) {
      const conversation = await this.deps.conversations.target(session.channel ?? '')
      if (!conversation || conversation.targetSessionId !== null) return false
      const roster = await this.deps.conversations.participants(OrgId(claims.orgId), session.channel ?? '')
      if (!roster.some((slot) => slot.agentId === claims.agentId && slot.currentSessionId === sessionId)) return false
      ownConversation = conversation.ownerUserId === claims.userId
    }
    return this.sessionAllowed(claims, access, sessionId, session, ownConversation, continued)
  }

  /** An alias creator is not the continued session's owner; resolve its current audience for every read. */
  async authorizeBinding(
    claims: AhpGrantClaims,
    binding: AhpSessionBindingRecord
  ): Promise<{ callerRole: ChatCallerRole; callerApproves: boolean } | null> {
    if (binding.orgId !== claims.orgId || binding.agentId !== claims.agentId) return null
    const access = await this.agentAccess(claims)
    if (!access) return null
    const conversation = await this.deps.conversations.target(binding.conversationId)
    if (!conversation) return null
    const continued = conversation.targetSessionId !== null
    const ownConversation = !continued && conversation.ownerUserId === claims.userId
    const roster = continued
      ? []
      : await this.deps.conversations.participants(OrgId(claims.orgId), binding.conversationId)
    const slot = roster.find((participant) => participant.agentId === claims.agentId)
    if (!continued && (!slot || (slot.currentSessionId !== null && slot.currentSessionId !== binding.sessionId)))
      return null
    const session = binding.sessionId ? await this.deps.sessions.getUnscoped(SessionId(binding.sessionId)) : null
    if (!session) {
      // A native slot has no metadata until its first turn; only its verified creator may open that empty slot.
      if (!ownConversation || binding.userId !== claims.userId || slot?.currentSessionId != null) return null
    } else {
      if (
        !continued &&
        (slot?.currentSessionId !== binding.sessionId ||
          session.platform !== 'webchat' ||
          session.channel !== binding.conversationId)
      )
        return null
      if (!(await this.sessionAllowed(claims, access, binding.sessionId!, session, ownConversation, continued)))
        return null
    }
    const editor = canEdit(access.agent, access.viewer)
    return {
      callerRole: chatCallerRole(editor, ownConversation),
      callerApproves: editor || chatApprovalsAllowed(access.agent)
    }
  }

  async authorizeGrant(token: string, scope: { orgId: string; agentId: string }): Promise<AhpGrantClaims | null> {
    const claims = await this.deps.grants.verify(token)
    if (!claims || claims.orgId !== scope.orgId || claims.agentId !== scope.agentId) return null
    const access = await this.agentAccess(claims)
    if (!access) return null
    if (claims.apiKeyId) return (await this.liveKey(claims)) ? claims : null
    if (claims.protocol !== 'ahp') return null
    const binding = await this.conversationAccess(claims)
    if (!binding) return null
    const verdict = await webchatBinding(this.deps)(
      {
        ...claims,
        agentId: binding.primaryAgentId,
        conversationId: claims.conversationId!
      },
      { remoteMcp: false, viewer: access.viewer }
    )
    if (!verdict.ok) return null
    const participant = verdict.participants?.find((p) => p.agentId === claims.agentId)
    if (!participant) return null
    const currentTarget =
      claims.agentId === binding.primaryAgentId ? verdict.targetSessionId : participant.targetSessionId
    if (currentTarget !== claims.targetSessionId) return null
    return claims
  }
}
