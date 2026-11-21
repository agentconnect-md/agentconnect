// Pure unit test: the move route's service must recompute duties awaited, never through the debounced kick.
import { describe, it, expect, vi } from 'vitest'
import type { FastifyBaseLogger } from 'fastify'
import { buildAgentMoves } from './agent-moves.js'
import type { HttpDeps } from './deps.js'

const recomputeOf = (deps: Partial<HttpDeps>) =>
  (
    buildAgentMoves({ repos: {}, ...deps } as unknown as HttpDeps, {} as FastifyBaseLogger) as unknown as {
      deps: { recomputeDuties?: (orgId: string) => Promise<void> | void }
    }
  ).deps.recomputeDuties

describe('buildAgentMoves', () => {
  it('re-derives duties with the awaited recompute, so a target daemon claims after the old lease is vacated', () => {
    const kick = vi.fn()
    const now = vi.fn(async () => {})
    expect(recomputeOf({ recomputeDuties: kick, recomputeDutiesNow: now })).toBe(now)
  })

  it('never falls back to the debounced kick', () => {
    expect(recomputeOf({ recomputeDuties: vi.fn() })).toBeUndefined()
  })
})
