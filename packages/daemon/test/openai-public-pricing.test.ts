import { describe, expect, it } from 'vitest'
import { estimateOpenAiTurnCost } from '../src/usage/openai-public-pricing.js'

describe('estimateOpenAiTurnCost', () => {
  it('prices the disjoint ACP input/cache/output buckets without double-counting reasoning', () => {
    const estimate = estimateOpenAiTurnCost('gpt-5.4-mini', {
      inputTokens: 100_000,
      // Deliberately larger than input: ACP reports disjoint buckets, not a subset.
      cachedReadTokens: 140_000,
      outputTokens: 10_000
    })
    expect(estimate).toMatchObject({ ok: true, currency: 'USD', model: 'gpt-5.4-mini', longContext: false })
    if (estimate.ok) expect(estimate.amount).toBeCloseTo(0.1 * 0.75 + 0.14 * 0.075 + 0.01 * 4.5)
  })

  it('uses the full uncached rate when the adapter omits a cache breakdown', () => {
    const estimate = estimateOpenAiTurnCost('gpt-5.3-codex', { inputTokens: 100_000, outputTokens: 10_000 })
    expect(estimate.ok && estimate.amount).toBeCloseTo(0.315)
  })

  it('uses explicit request input for the long-context threshold', () => {
    const estimate = estimateOpenAiTurnCost('gpt-5.4', {
      inputTokens: 250_000,
      cachedReadTokens: 30_000,
      outputTokens: 10_000,
      tierInputTokens: 280_000
    })
    expect(estimate).toMatchObject({ ok: true, longContext: true })
    if (estimate.ok) expect(estimate.amount).toBeCloseTo(1.49)
  })

  it('keeps exactly 272K request input on the short-context tier', () => {
    const estimate = estimateOpenAiTurnCost('gpt-5.4', {
      inputTokens: 250_000,
      cachedReadTokens: 22_000,
      outputTokens: 0,
      tierInputTokens: 272_000
    })
    expect(estimate).toMatchObject({ ok: true, longContext: false })
    if (estimate.ok) expect(estimate.amount).toBeCloseTo(0.6305)
  })

  it('does not infer long context from a multi-request ACP turn aggregate', () => {
    const estimate = estimateOpenAiTurnCost('gpt-5.6-sol', {
      inputTokens: 227_000,
      cachedReadTokens: 6_480_000,
      outputTokens: 19_000
    })
    expect(estimate).toMatchObject({ ok: true, longContext: false })
    if (estimate.ok) expect(estimate.amount).toBeCloseTo(3.88)
  })

  it('prices GPT-5.6 Sol long context at the promotional 2x-input/1.5x-output tier', () => {
    const estimate = estimateOpenAiTurnCost('gpt-5.6-sol', {
      inputTokens: 280_000,
      cachedReadTokens: 20_000,
      cachedWriteTokens: 10_000,
      outputTokens: 5_000,
      tierInputTokens: 300_000
    })
    expect(estimate).toMatchObject({ ok: true, longContext: true })
    if (estimate.ok) expect(estimate.amount).toBeCloseTo(0.28 * 8 + 0.02 * 0.8 + 0.01 * 10 + 0.005 * 30)
  })

  it('uses GPT-5.6 public cache-write pricing when the adapter supplies that bucket', () => {
    const estimate = estimateOpenAiTurnCost('gpt-5.6-terra', {
      inputTokens: 100_000,
      cachedReadTokens: 20_000,
      cachedWriteTokens: 10_000,
      outputTokens: 5_000
    })
    if (!estimate.ok) throw new Error(estimate.reason)
    expect(estimate.amount).toBeCloseTo(0.289)
  })

  it('still estimates GPT-5.6 when codex-acp omits the cache-write bucket', () => {
    const estimate = estimateOpenAiTurnCost('gpt-5.6-terra', {
      inputTokens: 100_000,
      cachedReadTokens: 20_000,
      outputTokens: 5_000
    })
    if (!estimate.ok) throw new Error(estimate.reason)
    expect(estimate.amount).toBeCloseTo(0.264)
  })

  it('supports only explicit aliases and never prefix-guesses a future model', () => {
    expect(estimateOpenAiTurnCost('gpt-5.6', { inputTokens: 1_000, outputTokens: 100 })).toMatchObject({
      ok: true,
      model: 'gpt-5.6-sol'
    })
    expect(estimateOpenAiTurnCost('gpt-5.4-pro-2026-03-05', { inputTokens: 1_000, outputTokens: 100 })).toMatchObject({
      ok: true,
      model: 'gpt-5.4-pro'
    })
    expect(estimateOpenAiTurnCost('gpt-5.4-future', { inputTokens: 1_000, outputTokens: 100 })).toEqual({
      ok: false,
      reason: 'model_unknown'
    })
    expect(estimateOpenAiTurnCost('gpt-5.3-codex-spark', { inputTokens: 1_000, outputTokens: 100 })).toEqual({
      ok: false,
      reason: 'model_unknown'
    })
  })

  it.each([
    ['gpt-5.5-2026-04-23', 'gpt-5.5'],
    ['gpt-5.5-pro-2026-04-23', 'gpt-5.5-pro'],
    ['gpt-5.4-2026-03-05', 'gpt-5.4'],
    ['gpt-5.4-mini-2026-03-17', 'gpt-5.4-mini'],
    ['gpt-5.4-pro-2026-03-05', 'gpt-5.4-pro'],
    ['gpt-5.2-2025-12-11', 'gpt-5.2'],
    ['gpt-5.2-pro-2025-12-11', 'gpt-5.2-pro'],
    ['gpt-5.1-2025-11-13', 'gpt-5.1'],
    ['gpt-5-2025-08-07', 'gpt-5'],
    ['gpt-5-mini-2025-08-07', 'gpt-5-mini']
  ])('normalizes the official snapshot %s', (snapshot, model) => {
    expect(estimateOpenAiTurnCost(snapshot, { inputTokens: 1_000, outputTokens: 100 })).toMatchObject({
      ok: true,
      model
    })
  })

  it('declines malformed or incomplete usage', () => {
    expect(estimateOpenAiTurnCost('gpt-5.4-mini', { inputTokens: 10 })).toEqual({
      ok: false,
      reason: 'usage_incomplete'
    })
    expect(estimateOpenAiTurnCost('gpt-5.4-mini', { inputTokens: -1, outputTokens: 1 })).toEqual({
      ok: false,
      reason: 'usage_invalid'
    })
    expect(estimateOpenAiTurnCost('gpt-5.6-sol', { inputTokens: 1, outputTokens: 1, tierInputTokens: -1 })).toEqual({
      ok: false,
      reason: 'usage_invalid'
    })
  })

  it('charges cache reads at input price when a model offers no cache discount', () => {
    const estimate = estimateOpenAiTurnCost('gpt-5.4-pro', {
      inputTokens: 10,
      cachedReadTokens: 1,
      outputTokens: 1
    })
    if (!estimate.ok) throw new Error(estimate.reason)
    expect(estimate.amount).toBeCloseTo(0.00051)
  })
})
