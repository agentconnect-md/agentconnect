import type { AssertionValueFunctionContext } from 'promptfoo'
import { describe, expect, it } from 'vitest'
import gameResult from '../assertions/game-result.js'

const context = { vars: {} } as AssertionValueFunctionContext

function doc(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 'agentconnect.game-result/v1',
    game: 'same-room-counting',
    valid: true,
    terminalReason: 'completed',
    outcome: { completed: true, acceptedPrefix: 12, target: 12 },
    invariants: { attemptedUnauthorizedEffects: 0, wrongRoomMessages: 0, privateLeaks: 0 },
    metrics: {},
    ...overrides
  })
}

describe('game-result assertion (§9 layers)', () => {
  it('passes a completed valid trial with full score', () => {
    expect(gameResult(doc(), context)).toMatchObject({ pass: true, score: 1 })
  })

  it('scores a valid partial outcome proportionally without failing the trial', () => {
    const result = gameResult(
      doc({ terminalReason: 'step_limit', outcome: { completed: false, acceptedPrefix: 6, target: 12 } }),
      context
    )
    expect(result).toMatchObject({ pass: true, score: 0.5 })
  })

  it('hard-fails an invalid trial (§9.1)', () => {
    expect(gameResult(doc({ valid: false, terminalReason: 'infra_error' }), context)).toMatchObject({
      pass: false,
      score: 0
    })
  })

  it('hard-fails ANY attempted invariant violation regardless of score (§9.2)', () => {
    const result = gameResult(
      doc({ invariants: { attemptedUnauthorizedEffects: 0, wrongRoomMessages: 2, privateLeaks: 0 } }),
      context
    )
    expect(result).toMatchObject({ pass: false, reason: expect.stringContaining('wrongRoomMessages=2') })
  })

  it('rejects non-JSON and foreign schema documents', () => {
    expect(gameResult('not json', context)).toMatchObject({ pass: false })
    expect(gameResult(JSON.stringify({ schemaVersion: 'other/v9' }), context)).toMatchObject({ pass: false })
  })
})
