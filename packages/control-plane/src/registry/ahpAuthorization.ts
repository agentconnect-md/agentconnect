import { decodeJwt } from 'jose'
import { API_AHP_V1_FEATURE, type RcVerifyResult } from '@agentconnect.md/protocol'
import { canEdit, canView } from '../authorization/policy.js'
import { chatApprovalsAllowed, chatCallerRole } from '../domain/chat-actions.js'
import { AgentId, OrgId } from '../domain/ids.js'
import type { ApiKeyRepo, OrgMemberRole } from '../persistence/ports.js'
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
}

const denied = (): RcVerifyResult => ({ ok: false, reason: 'AHP access unavailable' })

export class AhpAuthorization {
  constructor(private readonly deps: AhpAuthorizationDeps) {}

  private async agentAccess(claims: Pick<AhpGrantClaims, 'orgId' | 'agentId' | 'userId'>) {
    const d = this.deps
    if (d.config.AHP_MODE !== 'on') return null
    const role = (await d.orgs.roleOf(claims.orgId, claims.userId)) as OrgMemberRole | null
    const agent = await d.agents.getUnscoped(AgentId(claims.agentId))
    if (!role || !agent || agent.orgId !== claims.orgId || !canView(agent, { userId: claims.userId, role })) return null
    if (!(await d.apiEntries.listForAgent(AgentId(claims.agentId))).some((entry) => entry.protocol === 'ahp'))
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
      callerRole: chatCallerRole(canEdit(access.agent, access.viewer), true),
      callerApproves: canEdit(access.agent, access.viewer) || chatApprovalsAllowed(access.agent)
    }
  }

  async verifyBrowser(req: { credential: string; agentId?: string }): Promise<RcVerifyResult> {
    const d = this.deps
    const claims = await d.tokens.verify(req.credential)
    if (!claims) return denied()
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
    const ahpGrant = await d.grants.mint(
      {
        orgId: claims.orgId,
        agentId,
        userId: claims.userId,
        user: claims.user,
        conversationId: claims.conversationId,
        ...(claims.privateSessionOwnerIdentity
          ? { privateSessionOwnerIdentity: claims.privateSessionOwnerIdentity }
          : {})
      },
      expiry * 1000
    )
    return {
      ...verdict,
      agentId,
      daemonId: access.daemonId,
      ahpGrant,
      callerRole: participant?.callerRole ?? chatCallerRole(canEdit(access.agent, access.viewer), false),
      callerApproves: canEdit(access.agent, access.viewer) || chatApprovalsAllowed(access.agent)
    }
  }

  async authorizeGrant(token: string, scope: { orgId: string; agentId: string }): Promise<AhpGrantClaims | null> {
    const claims = await this.deps.grants.verify(token)
    if (!claims || claims.orgId !== scope.orgId || claims.agentId !== scope.agentId) return null
    const access = await this.agentAccess(claims)
    if (!access) return null
    if (claims.apiKeyId) return (await this.liveKey(claims)) ? claims : null
    const binding = await this.deps.conversations.resumeBinding(claims.conversationId!, OrgId(claims.orgId))
    if (!binding) return null
    // Empty conversations have no session policy to authorize a different member.
    if (binding.currentSessionIds.every((id) => id === null) && binding.ownerUserId !== claims.userId) return null
    const verdict = await webchatBinding(this.deps)(
      {
        ...claims,
        agentId: binding.primaryAgentId,
        conversationId: claims.conversationId!
      },
      { remoteMcp: false, viewer: access.viewer }
    )
    if (!verdict.ok || !verdict.participants?.some((p) => p.agentId === claims.agentId)) return null
    return claims
  }
}
