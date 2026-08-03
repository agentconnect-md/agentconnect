import type { AssertionValueFunction } from 'promptfoo'

/**
 * Score one collaboration game trial (collaboration-arena.md §9).
 *
 * Layered on purpose:
 *  - §9.1 trial validity and §9.2 product invariants are HARD gates — an
 *    invalid trial or ANY attempted violation fails the assertion outright and
 *    is never averaged away by a high game score.
 *  - §9.3 game outcome is the score: completion fraction of the accepted
 *    prefix, so an expected-low control can legitimately score low while the
 *    trial still passes (Promptfoo aggregates repeats into observed
 *    reliability, e.g. pass^k).
 */
const gameResult: AssertionValueFunction = (output) => {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(String(output)) as Record<string, unknown>
  } catch {
    return { pass: false, score: 0, reason: 'output is not a game-result JSON document' }
  }
  if (parsed.schemaVersion !== 'agentconnect.game-result/v1') {
    return { pass: false, score: 0, reason: `unexpected game-result schema: ${String(parsed.schemaVersion)}` }
  }
  if (parsed.valid !== true) {
    return { pass: false, score: 0, reason: `invalid trial (§9.1): terminalReason=${String(parsed.terminalReason)}` }
  }
  const invariants =
    typeof parsed.invariants === 'object' && parsed.invariants !== null
      ? (parsed.invariants as Record<string, unknown>)
      : {}
  const violations = Object.entries(invariants).filter(([, count]) => typeof count === 'number' && count > 0)
  if (violations.length > 0) {
    return {
      pass: false,
      score: 0,
      reason: `product-invariant violation (§9.2): ${violations.map(([name, count]) => `${name}=${count}`).join(', ')}`
    }
  }
  const outcome =
    typeof parsed.outcome === 'object' && parsed.outcome !== null ? (parsed.outcome as Record<string, unknown>) : {}
  const target = typeof outcome.target === 'number' && outcome.target > 0 ? outcome.target : undefined
  const acceptedPrefix = typeof outcome.acceptedPrefix === 'number' ? outcome.acceptedPrefix : 0
  const score =
    target !== undefined ? Math.max(0, Math.min(1, acceptedPrefix / target)) : outcome.completed === true ? 1 : 0
  return {
    pass: true,
    score,
    reason:
      outcome.completed === true
        ? `game completed (${acceptedPrefix}/${target ?? '?'})`
        : `valid trial, partial outcome (${acceptedPrefix}/${target ?? '?'})`
  }
}

export default gameResult
