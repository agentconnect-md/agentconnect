import { z } from 'zod'
import { parseDecisionAnswer, type DecisionQuestion } from '@agentconnect.md/protocol'
import { DecisionProviderError, requestDecision, type DecisionProviderEvaluator } from './provider.js'

const Probability = z.number().min(0).max(1)
const ResponseBody = z.object({
  model: z.string().trim().min(1).max(128),
  answers: z
    .array(
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('predicate'), name: z.literal('decision'), probability: Probability }),
        z.object({
          type: z.literal('choice'),
          name: z.literal('decision'),
          choice: z.string(),
          confidence: Probability,
          probabilities: z.array(z.object({ value: z.string(), probability: Probability }))
        }),
        z.object({
          type: z.literal('score'),
          name: z.literal('decision'),
          score: z.number(),
          confidence: Probability,
          probabilities: z.array(
            z.object({ value: z.number().int().nonnegative(), label: z.string(), probability: Probability })
          )
        }),
        z.object({ type: z.literal('refusal'), name: z.literal('decision') })
      ])
    )
    .length(1),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() })
})

export function openaiQuestion(question: DecisionQuestion): Record<string, unknown> {
  const common = { name: 'decision', instructions: question.instructions }
  if (question.type === 'boolean')
    return {
      ...common,
      type: 'predicate',
      instructions: `${question.instructions}\n\nTrue: ${question.criteria.true}\nFalse: ${question.criteria.false}`
    }
  if (question.type === 'choice')
    return {
      ...common,
      type: 'choice',
      choices: Object.entries(question.criteria).map(([value, description]) => ({ value, description }))
    }
  return {
    ...common,
    type: 'score',
    levels: question.criteria.map((description, index) => ({ label: String(index), description }))
  }
}

export const evaluateOpenai: DecisionProviderEvaluator = async (
  question,
  body,
  credentials,
  signal,
  fetcher,
  onRawResponse
) => {
  const text = await requestDecision('decisions', body, credentials, signal, fetcher, onRawResponse)
  try {
    const result = ResponseBody.parse(JSON.parse(text) as unknown)
    const answer = result.answers[0]!
    if (answer.type === 'refusal') return { status: 'unavailable', reason: 'provider' }
    let normalized: unknown
    if (answer.type === 'predicate') {
      normalized = { type: 'boolean', value: answer.probability >= 0.5, probability: answer.probability }
    } else {
      if (new Set(answer.probabilities.map((entry) => entry.value)).size !== answer.probabilities.length)
        throw new DecisionProviderError('invalid_response')
      if (answer.type === 'choice') {
        normalized = {
          type: 'choice',
          value: answer.choice,
          confidence: answer.confidence,
          probabilities: Object.fromEntries(answer.probabilities.map(({ value, probability }) => [value, probability]))
        }
      } else {
        if (
          question.type !== 'score' ||
          answer.probabilities.some(({ value, label }) => value >= question.criteria.length || label !== String(value))
        )
          throw new DecisionProviderError('invalid_response')
        normalized = {
          type: 'score',
          value: answer.score,
          confidence: answer.confidence,
          probabilities: [...answer.probabilities]
            .sort((a, b) => a.value - b.value)
            .map(({ probability }) => probability)
        }
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
