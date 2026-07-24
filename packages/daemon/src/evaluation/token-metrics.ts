export interface EvaluationTokenMetrics {
  totalTokens?: number
  promptTokens?: number
  completionTokens?: number
  /** Prompt-token subset served from a cache hit. Cache writes are not hits. */
  cachedTokens?: number
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * Normalize ACP's disjoint input/cache buckets to ATIF semantics.
 *
 * AgentConnect adapters expose uncached input, cache reads, and cache writes as
 * separate buckets (the same contract used by public cost estimation). ATIF's
 * prompt total includes all three, while cached_tokens is only the cache-hit
 * subset. The ACP-reported total remains authoritative when present.
 */
export function evaluationTokenMetricsFromUsage(usage: unknown): EvaluationTokenMetrics {
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return {}
  const value = usage as Record<string, unknown>
  const totalTokens = count(value.totalTokens)
  const inputTokens = count(value.inputTokens)
  const outputTokens = count(value.outputTokens)
  const cachedReadTokens = count(value.cachedReadTokens)
  const cachedWriteTokens = count(value.cachedWriteTokens)
  const promptParts = [inputTokens, cachedReadTokens, cachedWriteTokens].filter(
    (part): part is number => part !== undefined
  )

  return {
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(promptParts.length > 0 ? { promptTokens: promptParts.reduce((sum, part) => sum + part, 0) } : {}),
    ...(outputTokens !== undefined ? { completionTokens: outputTokens } : {}),
    ...(cachedReadTokens !== undefined ? { cachedTokens: cachedReadTokens } : {})
  }
}
