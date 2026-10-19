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
      authorization: Pick<AhpAuthorization, 'authorizeGrant'>
      bindings: AhpSessionBindingRepo
    }
  ) {}

  async reserve(req: AhpSessionReserve, daemonId: string): Promise<AhpSessionResult> {
    const claims = await this.deps.authorization.authorizeGrant(req.grant, req)
    if (!claims) return FORBIDDEN
    if (claims.conversationId) {
      // A browser may only ensure its already-authorized conversation; public create is refused by the host.
      const existing = await this.deps.bindings.forConversation(req.orgId, req.agentId, claims.conversationId)
      if (existing) return { ok: true, ...publicBinding(existing) }
    }
    return resultOf(
      await this.deps.bindings.reserve({
        orgId: req.orgId,
        agentId: req.agentId,
        userId: claims.userId,
        sessionUri: claims.conversationId ? `ahp-session:/${claims.conversationId}/${req.agentId}` : req.sessionUri,
        operationId: claims.conversationId
          ? agentChatConversationId(req.orgId, claims.conversationId, req.agentId, 'ahp-binding-v1')
          : req.operationId,
        ...(claims.apiKeyId ? { apiKeyId: claims.apiKeyId } : {}),
        ...(claims.conversationId ? { conversationId: claims.conversationId } : {}),
        writer: { daemonId, ...(req.duty ? { duty: req.duty } : {}) }
      })
    )
  }

  async finalize(req: AhpSessionFinalize, daemonId: string): Promise<AhpSessionResult> {
    const claims = await this.deps.authorization.authorizeGrant(req.grant, req)
    if (!claims) return FORBIDDEN
    let userId = claims.userId
    if (claims.conversationId) {
      const binding = await this.deps.bindings.forConversation(req.orgId, req.agentId, claims.conversationId)
      if (!binding || binding.reservationId !== req.reservationId) return FORBIDDEN
      userId = binding.userId
    }
    return resultOf(
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
    const allowed = claims.conversationId
      ? binding.conversationId === claims.conversationId
      : binding.userId === claims.userId
    return allowed ? { ok: true, ...publicBinding(binding) } : NOT_FOUND
  }

  async list(req: AhpSessionList): Promise<AhpSessionListResult> {
    const claims = await this.deps.authorization.authorizeGrant(req.grant, req)
    if (!claims) return FORBIDDEN
    if (claims.conversationId) {
      const binding = await this.deps.bindings.forConversation(req.orgId, req.agentId, claims.conversationId)
      return { ok: true, sessions: binding?.sessionId ? [publicBinding(binding)] : [] }
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
      sessions: bindings.map(publicBinding),
      ...(bindings.length === req.limit ? { cursor: bindings[bindings.length - 1]!.reservationId } : {})
    }
  }
}
