import { describe, expect, it } from 'vitest'
import { estimateGeminiTurnCost } from '../src/usage/gemini-public-pricing.js'
import { isAntigravityRuntimeDef } from '../src/runtime-defs/antigravity-runtime.js'

const NOV = new Date('2026-11-23T12:00:00Z')

describe('estimateGeminiTurnCost', () => {
  it('prices disjoint input/cache/output buckets without charging thinking again', () => {
    // Shape observed from `agy acp` 1.5.13 for one prompt with two tool calls.
    const estimate = estimateGeminiTurnCost(
      'gemini-4-neon',
      { inputTokens: 15_220, cachedReadTokens: 16_980, cachedWriteTokens: 0, outputTokens: 536 },
      NOV
    )
    expect(estimate).toMatchObject({ ok: true, currency: 'USD', model: 'gemini-4-neon', longContext: false })
    if (estimate.ok) expect(estimate.amount).toBeCloseTo((15_220 * 3 + 16_980 * 0.15 + 536 * 15) / 1e6)
  })

  it.each([
    ['gemini-4-neon', 3, 0.15, 15],
    ['gemini-4-argon', 2, 0.1, 10],
    ['gemini-4-hydrogen', 1.5, 0.075, 7.5],
    ['gemini-3.8-flash', 0.75, 0.075, 3.75]
  ])('prices %s at its current Standard rate', (model, input, cached, output) => {
    const estimate = estimateGeminiTurnCost(
      model,
      { inputTokens: 1_000_000, cachedReadTokens: 1_000_000, outputTokens: 1_000_000 },
      NOV
    )
    expect(estimate.ok && estimate.amount).toBeCloseTo(input + cached + output)
  })

  it('switches to a published future rate on its effective date', () => {
    const usage = { inputTokens: 1_000_000, cachedReadTokens: 0, outputTokens: 1_000_000 }
    expect(estimateGeminiTurnCost('gemini-4-argon', usage, new Date('2026-11-30T23:59:59Z'))).toMatchObject({
      amount: 12
    })
    expect(estimateGeminiTurnCost('gemini-4-argon', usage, new Date('2026-12-01T00:00:00Z'))).toMatchObject({
      amount: 24
    })
    expect(estimateGeminiTurnCost('gemini-3.8-flash', usage, new Date('2026-12-31T23:59:59Z'))).toMatchObject({
      amount: 4.5
    })
    expect(estimateGeminiTurnCost('gemini-3.8-flash', usage, new Date('2027-01-01T00:00:00Z'))).toMatchObject({
      amount: 9
    })
  })

  it('bills a reported cache write as input, since Gemini 4 caching is implicit only', () => {
    const estimate = estimateGeminiTurnCost(
      'gemini-4-hydrogen',
      { inputTokens: 0, cachedWriteTokens: 1_000_000, outputTokens: 0 },
      NOV
    )
    expect(estimate.ok && estimate.amount).toBeCloseTo(1.5)
  })

  it('leaves models Antigravity offers but Google does not price unknown', () => {
    for (const model of [
      'claude-opus-5-5',
      'gpt-oss-120b-medium',
      'gemini-pro-orchestrator-neon',
      'gemini-4-neon-high'
    ]) {
      expect(estimateGeminiTurnCost(model, { inputTokens: 1, outputTokens: 1 }, NOV)).toEqual({
        ok: false,
        reason: 'model_unknown'
      })
    }
  })

  it('rejects missing models and malformed usage', () => {
    expect(estimateGeminiTurnCost(' ', { inputTokens: 1, outputTokens: 1 })).toEqual({
      ok: false,
      reason: 'model_missing'
    })
    expect(estimateGeminiTurnCost('gemini-4-neon', { inputTokens: 1 })).toEqual({
      ok: false,
      reason: 'usage_incomplete'
    })
    expect(estimateGeminiTurnCost('gemini-4-neon', { inputTokens: -1, outputTokens: 1 })).toEqual({
      ok: false,
      reason: 'usage_invalid'
    })
    expect(estimateGeminiTurnCost('gemini-4-neon', { inputTokens: 1, outputTokens: 1, cachedReadTokens: 0.5 })).toEqual(
      {
        ok: false,
        reason: 'usage_invalid'
      }
    )
  })
})

describe('isAntigravityRuntimeDef', () => {
  it('matches `agy acp` under any binary path', () => {
    expect(isAntigravityRuntimeDef({ command: 'agy', args: ['acp'], env: [] })).toBe(true)
    expect(isAntigravityRuntimeDef({ command: '/home/agent/.local/bin/agy', args: ['acp'], env: [] })).toBe(true)
    expect(isAntigravityRuntimeDef({ command: 'C:\\tools\\agy.exe', args: ['acp'], env: [] })).toBe(true)
    expect(isAntigravityRuntimeDef({ command: 'agy', args: ['chat'], env: [] })).toBe(false)
    expect(isAntigravityRuntimeDef({ command: 'not-agy', args: ['acp'], env: [] })).toBe(false)
  })
})
