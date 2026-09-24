import { z } from 'zod'
import {
  ProviderEndpoint,
  parseDecisionAnswer,
  type DecisionEvaluation,
  type DecisionQuestion,
  type ProviderCredential
} from '@agentconnect.md/protocol'

type UnavailableReason = Extract<DecisionEvaluation, { status: 'unavailable' }>['reason']
export class DecisionProviderError extends Error {
  constructor(readonly reason: UnavailableReason) {
    super(`Decision evaluation unavailable: ${reason}`)
  }
}

const Probability = z.number().min(0).max(1)
const Distribution = z.record(z.string(), Probability)
const ResponseBody = z.object({
  model: z.string().trim().min(1).max(128),
  answers: z
    .object({
      decision: z.discriminatedUnion('type', [
        z.object({ type: z.literal('noul'), noul: Probability }),
        z.object({
          type: z.literal('choice'),
          choice: z.string(),
          probabilities: Distribution,
          confidence: Probability
        }),
        z.object({ type: z.literal('score'), score: z.number(), probabilities: Distribution, confidence: Probability })
      ])
    })
    .strict(),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() })
})

async function readText(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) throw new DecisionProviderError('invalid_response')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 128 * 1024) throw new DecisionProviderError('invalid_response')
      chunks.push(value)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function evaluateTypesafe(
  question: DecisionQuestion,
  body: string,
  credentials: ProviderCredential,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  onRawResponse?: (text: string) => void
): Promise<DecisionEvaluation> {
  const base = ProviderEndpoint.safeParse(credentials.endpoint)
  if (!base.success) throw new DecisionProviderError('credentials')
  const url = new URL('v1/systemone', `${base.data.replace(/\/+$/, '')}/`)
  const headers = new Headers(credentials.headers)
  headers.set('authorization', `Bearer ${credentials.apiKey}`)
  headers.set('content-type', 'application/json')
  const response = await fetcher(url, { method: 'POST', headers, body, signal, redirect: 'error' })
  if (!response.ok) {
    // An error body is kept best effort for the evaluation record; the status still decides the reason.
    const text = await readText(response).catch(() => null)
    if (text !== null) onRawResponse?.(text)
    const reason = [401, 403].includes(response.status)
      ? 'credentials'
      : [429, 529].includes(response.status)
        ? 'capacity'
        : [400, 413, 422].includes(response.status)
          ? 'unsupported_input'
          : 'provider'
    throw new DecisionProviderError(reason)
  }
  const text = await readText(response)
  onRawResponse?.(text)
  try {
    const result = ResponseBody.parse(JSON.parse(text) as unknown)
    const answer = result.answers.decision
    let normalized: unknown
    if (answer.type === 'noul') {
      normalized = { type: 'boolean', value: answer.noul >= 0.5, probability: answer.noul }
    } else if (answer.type === 'choice') {
      normalized = {
        type: 'choice',
        value: answer.choice,
        probabilities: answer.probabilities,
        confidence: answer.confidence
      }
    } else {
      if (
        question.type !== 'score' ||
        Object.keys(answer.probabilities).length !== question.criteria.length ||
        question.criteria.some((_, index) => !Object.hasOwn(answer.probabilities, String(index)))
      )
        throw new DecisionProviderError('invalid_response')
      normalized = {
        type: 'score',
        value: answer.score,
        confidence: answer.confidence,
        probabilities: question.criteria.map((_, index) => answer.probabilities[String(index)])
      }
    }
    return {
      status: 'answered',
      answer: parseDecisionAnswer(question, normalized),
      model: result.model,
      usage: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens }
    }
  } catch {
    signal.throwIfAborted()
    throw new DecisionProviderError('invalid_response')
  }
}
