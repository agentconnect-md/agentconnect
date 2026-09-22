import {
  DecisionQuestion,
  DECISION_PROVIDER_PROFILES,
  supportsDecision,
  type DecisionCatalogReply,
  PROVIDER_KEY_PROFILES,
  ProviderEndpoint,
  type DecisionDraft,
  type DecisionEvaluation,
  type ProviderCredentialsReply,
  type ProviderCredentialsRequest
} from '@agentconnect.md/protocol'
import { KeyServerError, type KeyGrant, type KeyServerClient } from '../key-server/client.js'
import { DecisionProviderError, evaluateTypesafe } from './typesafe.js'

export interface DecisionEvaluationInput {
  agentId: string
  evaluationId: string
  decision: Pick<DecisionDraft, 'providerId' | 'model' | 'question'>
  state: Record<string, unknown>
}

export interface DecisionEvaluatorDeps {
  orgForAgent(agentId: string): string | undefined
  credentials(request: ProviderCredentialsRequest, signal: AbortSignal): Promise<ProviderCredentialsReply>
  keyServer(): KeyServerClient | undefined
  cloudBaseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
  now?: () => number
  warn?(message: string): void
}

// One daemon owns this bounded evaluator; admission, history, and durable replay belong to its consumers.
export class DecisionEvaluator {
  private active = 0
  private readonly shutdown = new AbortController()

  constructor(private readonly deps: DecisionEvaluatorDeps) {}

  catalog(): DecisionCatalogReply {
    const cloudAvailable = !!this.deps.keyServer() && ProviderEndpoint.safeParse(this.deps.cloudBaseUrl).success
    return { providers: DECISION_PROVIDER_PROFILES.map((profile) => ({ ...profile, cloudAvailable })) }
  }

  close(): void {
    this.shutdown.abort()
  }

  async evaluate(input: DecisionEvaluationInput, cancellation?: AbortSignal): Promise<DecisionEvaluation> {
    const signal = AbortSignal.any([
      this.shutdown.signal,
      AbortSignal.timeout(this.deps.timeoutMs ?? 5_000),
      ...(cancellation ? [cancellation] : [])
    ])
    signal.throwIfAborted()
    const unavailable = (
      reason: Extract<DecisionEvaluation, { status: 'unavailable' }>['reason']
    ): DecisionEvaluation => ({ status: 'unavailable', reason })
    const { agentId, evaluationId, decision } = input
    const orgId = this.deps.orgForAgent(agentId)
    if (!orgId) return unavailable('credentials')
    let body: string
    let question: DecisionQuestion
    try {
      question = DecisionQuestion.parse(decision.question)
      if (!supportsDecision(decision)) return unavailable('unsupported_input')
      if (!evaluationId.trim() || evaluationId.length > 128 || !decision.model.trim() || decision.model.length > 128)
        return unavailable('unsupported_input')
      body = JSON.stringify({
        model: decision.model,
        state: input.state,
        questions: { decision: { ...question, type: question.type === 'boolean' ? 'noul' : question.type } }
      })
      if (Buffer.byteLength(body, 'utf8') > 32 * 1024) return unavailable('unsupported_input')
    } catch {
      return unavailable('unsupported_input')
    }
    if (this.active >= 4) return unavailable('capacity')
    this.active++
    let grant: KeyGrant | undefined
    let issuer: KeyServerClient | undefined
    try {
      let credentials
      try {
        credentials = (await this.deps.credentials({ agentId, provider: 'typesafe' }, signal)).credentials
      } catch {
        signal.throwIfAborted()
        return unavailable('credentials')
      }
      signal.throwIfAborted()
      if (credentials) {
        credentials = {
          ...credentials,
          endpoint: credentials.endpoint ?? PROVIDER_KEY_PROFILES.typesafe.defaultEndpoint
        }
      } else {
        issuer = this.deps.keyServer()
        const endpoint = ProviderEndpoint.safeParse(this.deps.cloudBaseUrl)
        if (!issuer || !endpoint.success) return unavailable('credentials')
        grant = await issuer.issue(
          { orgId, agentId, sessionId: `decision:${evaluationId}`, provider: 'typesafe', ttlSeconds: 60 },
          signal
        )
        signal.throwIfAborted()
        const now = this.deps.now?.() ?? performance.timeOrigin + performance.now()
        if (grant.expiresAtMs !== undefined && grant.expiresAtMs <= now) return unavailable('credentials')
        credentials = { apiKey: grant.key, endpoint: endpoint.data, headers: {} }
      }
      if (this.deps.orgForAgent(agentId) !== orgId) return unavailable('credentials')
      return await evaluateTypesafe(question, body, credentials, signal, this.deps.fetch)
    } catch (error) {
      // Consumer cancellation must never become a fail-open provider outcome.
      this.shutdown.signal.throwIfAborted()
      cancellation?.throwIfAborted()
      if (signal.aborted) return unavailable('timeout')
      if (error instanceof DecisionProviderError) return unavailable(error.reason)
      if (error instanceof KeyServerError) return unavailable(error.code === 'unavailable' ? 'provider' : 'credentials')
      return unavailable('provider')
    } finally {
      this.active--
      if (grant && issuer) {
        void issuer.revoke(grant.keyId).catch(() => this.deps.warn?.('Decision credential revocation failed'))
      }
    }
  }
}
