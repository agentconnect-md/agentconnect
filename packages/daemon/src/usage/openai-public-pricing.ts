/**
 * Best-effort OpenAI Standard API list-price estimates for Codex turns.
 *
 * These values are deliberately static: the daemon must remain deterministic and
 * must not fetch pricing at runtime. Refresh the manifest with the repo-local
 * `$update-model-pricing` skill and keep the focused tests in sync.
 *
 * Source: https://developers.openai.com/api/docs/pricing
 * Verified: 2026-09-05
 */

export const OPENAI_PUBLIC_PRICING_AS_OF = '2026-09-05'
export const OPENAI_PUBLIC_PRICING_SOURCE = 'https://developers.openai.com/api/docs/pricing'

const TOKENS_PER_MILLION = 1_000_000
const LONG_CONTEXT_THRESHOLD = 272_000

interface TokenRates {
  /** USD per 1M uncached input tokens. */
  input: number
  /** USD per 1M cached input tokens. Absent means the model has no public cached-input rate. */
  cachedInput?: number
  /** USD per 1M cache-write tokens. Absent means the model has no public cache-write rate. */
  cacheWrite?: number
  /** USD per 1M output tokens (reasoning tokens are already included). */
  output: number
}

interface ModelPricing {
  standard: TokenRates
  /** Rates applied to the whole request when its input exceeds 272K tokens. */
  longContext?: TokenRates
}

/** Exact public model ids only. Never prefix-match an unknown future model. */
const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  'gpt-6-astra': {
    standard: { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 },
    longContext: { input: 20, cachedInput: 2, cacheWrite: 25, output: 75 }
  },
  // Promotional list price ("available at least through November 21, 2026"); re-verify when the promo ends.
  'gpt-5.6-sol': {
    standard: { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 20 },
    longContext: { input: 8, cachedInput: 0.8, cacheWrite: 10, output: 30 }
  },
  'gpt-5.6-terra': {
    standard: { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 12 },
    longContext: { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 18 }
  },
  'gpt-5.6-luna': {
    standard: { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 1.2 },
    longContext: { input: 0.4, cachedInput: 0.04, cacheWrite: 0.5, output: 1.8 }
  },
  'gpt-5.5': {
    standard: { input: 5, cachedInput: 0.5, output: 30 },
    longContext: { input: 10, cachedInput: 1, output: 45 }
  },
  'gpt-5.5-pro': {
    standard: { input: 30, output: 180 },
    longContext: { input: 60, output: 270 }
  },
  'gpt-5.4': {
    standard: { input: 2.5, cachedInput: 0.25, output: 15 },
    longContext: { input: 5, cachedInput: 0.5, output: 22.5 }
  },
  'gpt-5.4-pro': {
    standard: { input: 30, output: 180 },
    longContext: { input: 60, output: 270 }
  },
  'gpt-5.4-mini': { standard: { input: 0.75, cachedInput: 0.075, output: 4.5 } },
  'gpt-5.3-codex': { standard: { input: 1.75, cachedInput: 0.175, output: 14 } },
  'gpt-5.2-codex': { standard: { input: 1.75, cachedInput: 0.175, output: 14 } },
  'gpt-5.2': { standard: { input: 1.75, cachedInput: 0.175, output: 14 } },
  'gpt-5.2-pro': { standard: { input: 21, output: 168 } },
  'gpt-5.1-codex-max': { standard: { input: 1.25, cachedInput: 0.125, output: 10 } },
  'gpt-5.1-codex': { standard: { input: 1.25, cachedInput: 0.125, output: 10 } },
  'gpt-5.1': { standard: { input: 1.25, cachedInput: 0.125, output: 10 } },
  'gpt-5-codex': { standard: { input: 1.25, cachedInput: 0.125, output: 10 } },
  'gpt-5': { standard: { input: 1.25, cachedInput: 0.125, output: 10 } },
  'gpt-5.1-codex-mini': { standard: { input: 0.25, cachedInput: 0.025, output: 2 } },
  'gpt-5-mini': { standard: { input: 0.25, cachedInput: 0.025, output: 2 } },
  'codex-mini-latest': { standard: { input: 1.5, cachedInput: 0.375, output: 6 } }
}

/** Aliases/snapshots that official model pages explicitly map to the rate above. */
const MODEL_ALIASES: Readonly<Record<string, string>> = {
  'gpt-5.6': 'gpt-5.6-sol',
  'gpt-5.5-2026-04-23': 'gpt-5.5',
  'gpt-5.5-pro-2026-04-23': 'gpt-5.5-pro',
  'gpt-5.4-2026-03-05': 'gpt-5.4',
  'gpt-5.4-mini-2026-03-17': 'gpt-5.4-mini',
  'gpt-5.4-pro-2026-03-05': 'gpt-5.4-pro',
  'gpt-5.2-2025-12-11': 'gpt-5.2',
  'gpt-5.2-pro-2025-12-11': 'gpt-5.2-pro',
  'gpt-5.1-2025-11-13': 'gpt-5.1',
  'gpt-5-2025-08-07': 'gpt-5',
  'gpt-5-mini-2025-08-07': 'gpt-5-mini'
}

export interface OpenAiTurnUsage {
  /** Non-cached input tokens. codex-acp separates cached reads before returning ACP usage. */
  inputTokens?: number
  outputTokens?: number
  cachedReadTokens?: number | null
  cachedWriteTokens?: number | null
  /**
   * Total cached + uncached input size for the single provider request
   * represented by these buckets.
   * Omit for ACP turn aggregates that span multiple requests; their sum cannot
   * determine whether any individual request crossed a pricing-tier boundary.
   */
  tierInputTokens?: number | null
}

export type PublicCostEstimate =
  | {
      ok: true
      amount: number
      currency: 'USD'
      model: string
      pricingAsOf: string
      basis: 'public-api-standard'
      longContext: boolean
    }
  | {
      ok: false
      reason: 'model_missing' | 'model_unknown' | 'usage_incomplete' | 'usage_invalid'
    }

function validCount(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Estimate one Codex turn at public OpenAI Standard API token rates.
 *
 * AgentConnect's managed `@agentconnect.md/codex-acp@agentconnect` runtime maps
 * provider usage into disjoint ACP buckets: `inputTokens` is non-cached input
 * and `cachedReadTokens` is the cached subset it removed. Unlike upstream
 * codex-acp, its PromptResponse is the total-token delta across every provider
 * request in the ACP prompt. That aggregate cannot select a per-request pricing
 * tier, so use standard rates unless request-level tier input is explicit.
 * `thoughtTokens` is intentionally absent: reasoning is already a subset of output
 * and charging it again would double-count. The current adapter does not expose
 * GPT-5.6 cache writes, so those tokens remain in input at the regular input rate;
 * that known approximation is preferable to inventing an unavailable split.
 */
export function estimateOpenAiTurnCost(model: string | undefined, usage: OpenAiTurnUsage): PublicCostEstimate {
  const rawModel = model?.trim()
  if (!rawModel) return { ok: false, reason: 'model_missing' }
  const normalizedModel = MODEL_ALIASES[rawModel] ?? rawModel
  const pricing = MODEL_PRICING[normalizedModel]
  if (!pricing) return { ok: false, reason: 'model_unknown' }

  if (usage.inputTokens === undefined || usage.outputTokens === undefined) {
    return { ok: false, reason: 'usage_incomplete' }
  }
  if (!validCount(usage.inputTokens) || !validCount(usage.outputTokens)) return { ok: false, reason: 'usage_invalid' }
  const cachedRead = usage.cachedReadTokens ?? 0
  const cachedWrite = usage.cachedWriteTokens ?? 0
  const tierInput = usage.tierInputTokens
  if (!validCount(cachedRead) || !validCount(cachedWrite) || (tierInput != null && !validCount(tierInput))) {
    return { ok: false, reason: 'usage_invalid' }
  }

  const isLongContext = tierInput != null && tierInput > LONG_CONTEXT_THRESHOLD && pricing.longContext !== undefined
  const rates = isLongContext ? pricing.longContext! : pricing.standard

  const amount =
    (usage.inputTokens * rates.input +
      // A missing cached-input price means no discount, not zero-cost input.
      cachedRead * (rates.cachedInput ?? rates.input) +
      cachedWrite * (rates.cacheWrite ?? rates.input) +
      usage.outputTokens * rates.output) /
    TOKENS_PER_MILLION

  return {
    ok: true,
    amount,
    currency: 'USD',
    model: normalizedModel,
    pricingAsOf: OPENAI_PUBLIC_PRICING_AS_OF,
    basis: 'public-api-standard',
    longContext: isLongContext
  }
}
