import { z } from 'zod'
import {
  parseDecisionAnswer,
  type DecisionEvaluation,
  type DecisionQuestion,
  type ProviderCredential
} from '@agentconnect.md/protocol'
import { DecisionProviderError, requestDecision } from './provider.js'

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

export async function evaluateTypesafe(
  question: DecisionQuestion,
  body: string,
  credentials: ProviderCredential,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  onRawResponse?: (text: string) => void
): Promise<DecisionEvaluation> {
  const text = await requestDecision('v1/systemone', body, credentials, signal, fetcher, onRawResponse)
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
