// Static Gemini API Standard paid-tier list prices for Antigravity turns; refresh with `$update-model-pricing`.

import type { OpenAiTurnUsage as TurnUsage, PublicCostEstimate } from './openai-public-pricing.js'

export const GEMINI_PUBLIC_PRICING_AS_OF = '2026-11-23'
export const GEMINI_PUBLIC_PRICING_SOURCE = 'https://aistudio.google.com/docs/pricing'

const TOKENS_PER_MILLION = 1_000_000

interface TokenRates {
  /** USD per 1M uncached input tokens. */
  input: number
  /** USD per 1M implicitly cached input tokens. */
  cachedInput: number
  /** USD per 1M output tokens, thinking included. */
  output: number
}

/** A published rate effective from `from` (UTC date, inclusive); entries are in ascending order. */
interface RatePeriod {
  from?: string
  rates: TokenRates
}

/** Exact public model ids only. Never prefix-match an unknown future model. */
const MODEL_PRICING: Readonly<Record<string, readonly RatePeriod[]>> = {
  'gemini-4-neon': [{ rates: { input: 3, cachedInput: 0.15, output: 15 } }],
  'gemini-4-argon': [
    { rates: { input: 2, cachedInput: 0.1, output: 10 } },
    { from: '2026-12-01', rates: { input: 4, cachedInput: 0.2, output: 20 } }
  ],
  'gemini-4-hydrogen': [{ rates: { input: 1.5, cachedInput: 0.075, output: 7.5 } }],
  'gemini-3.8-flash': [
    { rates: { input: 0.75, cachedInput: 0.075, output: 3.75 } },
    { from: '2027-01-01', rates: { input: 1.5, cachedInput: 0.15, output: 7.5 } }
  ]
}

function validCount(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function ratesAt(periods: readonly RatePeriod[], at: Date): TokenRates {
  const day = at.toISOString().slice(0, 10)
  let rates = periods[0]!.rates
  for (const period of periods) if (!period.from || period.from <= day) rates = period.rates
  return rates
}

// agy sums every request in a prompt into disjoint buckets; output includes thinking, and a cache write (implicit caching only) bills as input.
export function estimateGeminiTurnCost(
  model: string | undefined,
  usage: TurnUsage,
  at: Date = new Date()
): PublicCostEstimate {
  const rawModel = model?.trim()
  if (!rawModel) return { ok: false, reason: 'model_missing' }
  const periods = MODEL_PRICING[rawModel]
  if (!periods) return { ok: false, reason: 'model_unknown' }

  if (usage.inputTokens === undefined || usage.outputTokens === undefined) {
    return { ok: false, reason: 'usage_incomplete' }
  }
  if (!validCount(usage.inputTokens) || !validCount(usage.outputTokens)) return { ok: false, reason: 'usage_invalid' }
  const cachedRead = usage.cachedReadTokens ?? 0
  const cachedWrite = usage.cachedWriteTokens ?? 0
  if (!validCount(cachedRead) || !validCount(cachedWrite)) return { ok: false, reason: 'usage_invalid' }

  const rates = ratesAt(periods, at)
  const amount =
    ((usage.inputTokens + cachedWrite) * rates.input +
      cachedRead * rates.cachedInput +
      usage.outputTokens * rates.output) /
    TOKENS_PER_MILLION

  return {
    ok: true,
    amount,
    currency: 'USD',
    model: rawModel,
    pricingAsOf: GEMINI_PUBLIC_PRICING_AS_OF,
    basis: 'public-api-standard',
    longContext: false
  }
}
