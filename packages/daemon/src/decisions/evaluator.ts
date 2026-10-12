import {
  DECISION_RAW_JSON_MAX_CHARS,
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
import { evaluateTypesafe } from './typesafe.js'
import { DecisionProviderError } from './provider.js'
import { evaluateOpenai, openaiQuestion } from './openai.js'
import {
  decisionImageParts,
  resolveDecisionImages,
  type DecisionImage,
  type DecisionImageInput,
  type DecisionImageDownload
} from './images.js'

export interface DecisionEvaluationInput {
  agentId: string
  evaluationId: string
  decision: Pick<DecisionDraft, 'providerId' | 'model' | 'question'>
  state: Record<string, unknown>
  imageInput?: DecisionImageInput
  /** Epoch ms the whole decision stage must finish by; it shortens the evaluator's own timeout. */
  deadlineAt?: number
  // Receives the request just before sending, with image bytes omitted; absent when no request goes out.
  onRawRequest?: (text: string) => void
  // Receives text-response diagnostics or an image-safe normalized result; raw image error bodies are omitted.
  onRawResponse?: (text: string) => void
}

// Serialize provider input or an image-redacted diagnostic copy.
export function decisionRequestBody(input: {
  decision: Pick<DecisionDraft, 'model' | 'question'> & { providerId?: string }
  state: Record<string, unknown>
  images?: readonly DecisionImage[]
  imageMessageId?: string
  redactImages?: boolean
}): string {
  const question = DecisionQuestion.parse(input.decision.question)
  if (input.decision.providerId === 'openai')
    return JSON.stringify({
      model: input.decision.model,
      input: input.images?.length
        ? [
            {
              role: 'user',
              content: [
                { type: 'input_text', text: JSON.stringify(input.state) },
                ...decisionImageParts(input.images, input.imageMessageId ?? '', input.redactImages)
              ]
            }
          ]
        : JSON.stringify(input.state),
      questions: [openaiQuestion(question)]
    })
  return JSON.stringify({
    model: input.decision.model,
    state: input.state,
    questions: { decision: { ...question, type: question.type === 'boolean' ? 'noul' : question.type } }
  })
}

// Verdict diagnostics retain bounded request metadata and response text, with image payloads omitted.
export function rawAnswerFields(
  raw: string | undefined,
  request?: string
): { request?: string; raw?: string; rawTruncated?: true } {
  const sent = request === undefined ? {} : { request }
  if (raw === undefined) return sent
  return raw.length > DECISION_RAW_JSON_MAX_CHARS
    ? { ...sent, raw: raw.slice(0, DECISION_RAW_JSON_MAX_CHARS), rawTruncated: true }
    : { ...sent, raw }
}

export type RawAnswerFields = ReturnType<typeof rawAnswerFields>

/** A chain's provider bodies by step index; the first step's stay top-level, where rawAnswerFields puts them. */
export class ChainRawBodies {
  private readonly requests: Array<string | undefined> = []
  private readonly responses: Array<string | undefined> = []

  hooks(index: number): Pick<DecisionEvaluationInput, 'onRawRequest' | 'onRawResponse'> {
    return {
      onRawRequest: (text) => {
        this.requests[index] = text
      },
      onRawResponse: (text) => {
        this.responses[index] = text
      }
    }
  }

  get request(): string | undefined {
    return this.requests[0]
  }

  get raw(): string | undefined {
    return this.responses[0]
  }

  /** The later steps' bodies, aligned with the trace (the first entry is empty); none for a lone Decision. */
  steps(): RawAnswerFields[] {
    const length = Math.max(this.requests.length, this.responses.length)
    return length > 1
      ? Array.from({ length }, (_, index) =>
          index === 0 ? {} : rawAnswerFields(this.responses[index], this.requests[index])
        )
      : []
  }

  /** What a verdict's answerJson keeps: the first step's fields plus `stepRaw` for the rest. */
  fields(): RawAnswerFields & { stepRaw?: RawAnswerFields[] } {
    const stepRaw = this.steps()
    return { ...rawAnswerFields(this.raw, this.request), ...(stepRaw.length ? { stepRaw } : {}) }
  }
}

/** The provider's serialized input cap (decisions.md §7.3). */
export const DECISION_REQUEST_MAX_BYTES = 32 * 1024

export interface DecisionEvaluatorDeps {
  orgForAgent(agentId: string): string | undefined
  credentials(request: ProviderCredentialsRequest, signal: AbortSignal): Promise<ProviderCredentialsReply>
  keyServer(): KeyServerClient | undefined
  // Managed-pool gateway API roots per provider; a configured one replaces BYOK for that provider.
  cloudEndpoints?: Partial<Record<'typesafe' | 'openai', string>>
  fetch?: typeof fetch
  downloadImage?: DecisionImageDownload
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
    return {
      providers: DECISION_PROVIDER_PROFILES.map((profile) => ({
        ...profile,
        cloudAvailable: !!this.cloudEndpoint(profile.id)
      }))
    }
  }

  private cloudEndpoint(provider: string): { issuer: KeyServerClient; endpoint: string } | undefined {
    if (provider !== 'typesafe' && provider !== 'openai') return undefined
    const endpoint = ProviderEndpoint.safeParse(this.deps.cloudEndpoints?.[provider])
    const issuer = endpoint.success ? this.deps.keyServer() : undefined
    return issuer && endpoint.success ? { issuer, endpoint: endpoint.data } : undefined
  }

  close(): void {
    this.shutdown.abort()
  }

  async evaluate(input: DecisionEvaluationInput, cancellation?: AbortSignal): Promise<DecisionEvaluation> {
    const unavailable = (
      reason: Extract<DecisionEvaluation, { status: 'unavailable' }>['reason']
    ): DecisionEvaluation => ({ status: 'unavailable', reason })
    const now = this.deps.now?.() ?? Date.now()
    // AbortSignal.timeout rejects a fractional delay, and the production clock is sub-millisecond.
    const timeoutMs = Math.floor(
      Math.min(
        this.deps.timeoutMs ?? 5_000,
        input.deadlineAt === undefined ? Number.POSITIVE_INFINITY : input.deadlineAt - now
      )
    )
    this.shutdown.signal.throwIfAborted()
    cancellation?.throwIfAborted()
    if (timeoutMs <= 0) return unavailable('timeout')
    const signal = AbortSignal.any([
      this.shutdown.signal,
      AbortSignal.timeout(timeoutMs),
      ...(cancellation ? [cancellation] : [])
    ])
    const { agentId, evaluationId, decision } = input
    const orgId = this.deps.orgForAgent(agentId)
    if (!orgId) return unavailable('credentials')
    const provider = decision.providerId === 'openai' ? 'openai' : 'typesafe'
    let body: string
    let question: DecisionQuestion
    try {
      question = DecisionQuestion.parse(decision.question)
      if (!supportsDecision(decision)) return unavailable('unsupported_input')
      if (!evaluationId.trim() || evaluationId.length > 128 || !decision.model.trim() || decision.model.length > 128)
        return unavailable('unsupported_input')
      body = decisionRequestBody(input)
      if (Buffer.byteLength(body, 'utf8') > DECISION_REQUEST_MAX_BYTES) return unavailable('unsupported_input')
    } catch {
      return unavailable('unsupported_input')
    }
    if (this.active >= 4) return unavailable('capacity')
    this.active++
    let grant: KeyGrant | undefined
    let issuer: KeyServerClient | undefined
    try {
      let credentials
      const cloud = this.cloudEndpoint(provider)
      if (cloud) {
        issuer = cloud.issuer
        grant = await issuer.issue(
          { orgId, agentId, sessionId: `decision:${evaluationId}`, provider, ttlSeconds: 60 },
          signal
        )
        signal.throwIfAborted()
        const now = this.deps.now?.() ?? performance.timeOrigin + performance.now()
        if (grant.expiresAtMs !== undefined && grant.expiresAtMs <= now) return unavailable('credentials')
        credentials = { apiKey: grant.key, endpoint: cloud.endpoint, headers: {} }
      } else {
        try {
          credentials = (await this.deps.credentials({ agentId, provider }, signal)).credentials
        } catch {
          signal.throwIfAborted()
          return unavailable('credentials')
        }
        signal.throwIfAborted()
        if (!credentials) return unavailable('credentials')
        credentials = {
          ...credentials,
          endpoint: credentials.endpoint ?? PROVIDER_KEY_PROFILES[provider].defaultEndpoint
        }
      }
      if (this.deps.orgForAgent(agentId) !== orgId) return unavailable('credentials')
      let rawRequest = body
      let hasImages = false
      if (provider === 'openai' && input.imageInput) {
        const images = await resolveDecisionImages(agentId, input.imageInput, signal, this.deps.downloadImage)
        if (images.length) {
          const request = { ...input, images, imageMessageId: input.imageInput.messageId }
          rawRequest = decisionRequestBody({ ...request, redactImages: true })
          if (Buffer.byteLength(rawRequest, 'utf8') > DECISION_REQUEST_MAX_BYTES)
            return unavailable('unsupported_input')
          body = decisionRequestBody(request)
          hasImages = true
        }
      }
      signal.throwIfAborted()
      if (this.deps.orgForAgent(agentId) !== orgId) return unavailable('credentials')
      input.onRawRequest?.(rawRequest)
      const evaluate = provider === 'openai' ? evaluateOpenai : evaluateTypesafe
      // Image responses keep only the validated answer below; error bodies can echo image payloads.
      const result = await evaluate(
        question,
        body,
        credentials,
        signal,
        this.deps.fetch,
        hasImages ? undefined : input.onRawResponse
      )
      if (hasImages)
        input.onRawResponse?.(JSON.stringify({ imageResponse: 'Raw provider body omitted', evaluation: result }))
      return result
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
