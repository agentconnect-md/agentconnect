import { historicalSessionUri } from './ahpSessionUri.js'
import type {
  AhpSessionBinding,
  AhpSessionFinalize,
  AhpSessionList,
  AhpSessionListResult,
  AhpSessionReserve,
  AhpSessionResolve,
  AhpSessionResult
} from '@agentconnect.md/protocol'
import type { AhpSessionBindingRecord, AhpSessionBindingRepo, AhpSessionWriteResult } from '../persistence/ports.js'
import type { AhpGrantClaims } from './ahpGrant.js'
import type { AhpAuthorization } from './ahpAuthorization.js'
import { agentChatConversationId } from './agentChatKeyVerification.js'

const publicBinding = (record: AhpSessionBindingRecord): AhpSessionBinding => ({
  reservationId: record.reservationId,
  conversationId: record.conversationId,
  sessionUri: record.sessionUri,
  ...(record.sessionId === null ? {} : { sessionId: record.sessionId })
})
const resultOf = (result: AhpSessionWriteResult): AhpSessionResult =>
  result.ok
    ? { ok: true, ...publicBinding(result.binding) }
    : { ok: false, reason: result.reason === 'conflict' ? 'stale_owner' : result.reason }
const FORBIDDEN = { ok: false, reason: 'forbidden' } as const
const NOT_FOUND = { ok: false, reason: 'not_found' } as const

export class AhpSessionService {
  constructor(
    private readonly deps: {
      authorization: Pick<AhpAuthorization, 'authorizeGrant' | 'authorizeBinding'>
      bindings: AhpSessionBindingRepo
    }
  ) {}

  private async authorizedBinding(claims: AhpGrantClaims, binding: AhpSessionBindingRecord) {
    const callerRole = await this.deps.authorization.authorizeBinding(claims, binding)
    return callerRole ? { ...publicBinding(binding), callerRole } : null
  }

  private async authorizedResult(claims: AhpGrantClaims, result: AhpSessionWriteResult): Promise<AhpSessionResult> {
    if (!result.ok) return resultOf(result)
    const binding = await this.authorizedBinding(claims, result.binding)
    return binding
      ? { ok: true, ...binding, ...(claims.conversationId ? { conversationId: claims.conversationId } : {}) }
      : FORBIDDEN
  }

  async reserve(req: AhpSessionReserve, daemonId: string): Promise<AhpSessionResult> {
    const claims = await this.deps.authorization.authorizeGrant(req.grant, req)
    if (!claims) return FORBIDDEN
    if (claims.apiKeyId && /^ahp-session:\/(?:webchat|session)(?:\/|$)/.test(req.sessionUri)) return FORBIDDEN
    if (claims.conversationId && claims.targetSessionId) {
      const result = await this.deps.bindings.bindExisting({
        orgId: req.orgId,
        agentId: req.agentId,
        conversationId: claims.conversationId,
        sessionId: claims.targetSessionId,
        sessionUri: historicalSessionUri({ ...claims, sessionId: claims.targetSessionId }),
        operationId: agentChatConversationId(req.orgId, claims.targetSessionId, req.agentId, 'ahp-existing-v1'),
        writer: { daemonId, ...(req.duty ? { duty: req.duty } : {}) }
      })
      return this.authorizedResult(claims, result)
    }
    if (claims.conversationId) {
      // A browser may only ensure its already-authorized conversation; public create is refused by the host.
      const existing = await this.deps.bindings.forConversation(req.orgId, req.agentId, claims.conversationId)
      if (existing) return this.authorizedResult(claims, { ok: true, binding: existing })
    }
    const reserved = await this.deps.bindings.reserve({
      orgId: req.orgId,
      agentId: req.agentId,
      userId: claims.userId,
      sessionUri: claims.conversationId
        ? `ahp-session:/webchat/${claims.conversationId}/${req.agentId}`
        : req.sessionUri,
      operationId: claims.conversationId
        ? agentChatConversationId(req.orgId, claims.conversationId, req.agentId, 'ahp-binding-v1')
        : req.operationId,
      ...(claims.apiKeyId ? { apiKeyId: claims.apiKeyId } : {}),
      ...(claims.conversationId ? { conversationId: claims.conversationId } : {}),
      writer: { daemonId, ...(req.duty ? { duty: req.duty } : {}) }
    })
    return this.authorizedResult(
      claims,
      !reserved.ok && reserved.reason === 'conflict' ? { ok: false, reason: 'collision' } : reserved
    )
  }

  async finalize(req: AhpSessionFinalize, daemonId: string): Promise<AhpSessionResult> {
    const claims = await this.deps.authorization.authorizeGrant(req.grant, req)
    if (!claims) return FORBIDDEN
    if (claims.conversationId && claims.targetSessionId) {
      const binding = await this.deps.bindings.forSession(req.orgId, claims.targetSessionId)
      if (!binding || binding.reservationId !== req.reservationId || req.sessionId !== claims.targetSessionId)
        return FORBIDDEN
      return this.authorizedResult(claims, { ok: true, binding })
    }
    let userId = claims.userId
    if (claims.conversationId) {
      const binding = await this.deps.bindings.forConversation(req.orgId, req.agentId, claims.conversationId)
      if (!binding || binding.reservationId !== req.reservationId) return FORBIDDEN
      userId = binding.userId
    }
    return this.authorizedResult(
      claims,
      await this.deps.bindings.finalize({
        orgId: req.orgId,
        agentId: req.agentId,
        userId,
        reservationId: req.reservationId,
        sessionId: req.sessionId,
        writer: { daemonId, ...(req.duty ? { duty: req.duty } : {}) }
      })
    )
  }

  async resolve(req: AhpSessionResolve): Promise<AhpSessionResult> {
    const claims = await this.deps.authorization.authorizeGrant(req.grant, req)
    if (!claims) return FORBIDDEN
    const binding = await this.deps.bindings.get(req.orgId, req.sessionUri)
    if (!binding || binding.agentId !== req.agentId || binding.sessionId === null) return NOT_FOUND
    const allowed = claims.targetSessionId
      ? binding.sessionId === claims.targetSessionId
      : claims.conversationId
        ? binding.conversationId === claims.conversationId
        : binding.userId === claims.userId
    if (!allowed) return NOT_FOUND
    const authorized = await this.authorizedBinding(claims, binding)
    return authorized
      ? { ok: true, ...authorized, ...(claims.conversationId ? { conversationId: claims.conversationId } : {}) }
      : NOT_FOUND
  }

  async list(req: AhpSessionList): Promise<AhpSessionListResult> {
    const claims = await this.deps.authorization.authorizeGrant(req.grant, req)
    if (!claims) return FORBIDDEN
    if (claims.conversationId) {
      const binding = claims.targetSessionId
        ? await this.deps.bindings.forSession(req.orgId, claims.targetSessionId)
        : await this.deps.bindings.forConversation(req.orgId, req.agentId, claims.conversationId)
      const authorized = binding?.sessionId ? await this.authorizedBinding(claims, binding) : null
      return { ok: true, sessions: authorized ? [{ ...authorized, conversationId: claims.conversationId }] : [] }
    }
    const bindings = await this.deps.bindings.listOwned({
      orgId: req.orgId,
      agentId: req.agentId,
      userId: claims.userId,
      after: req.cursor,
      limit: req.limit
    })
    return {
      ok: true,
      sessions: (await Promise.all(bindings.map((binding) => this.authorizedBinding(claims, binding)))).filter(
        (binding): binding is NonNullable<typeof binding> => binding !== null
      ),
      ...(bindings.length === req.limit ? { cursor: bindings[bindings.length - 1]!.reservationId } : {})
    }
  }
}
