// auto-session-mode.md §4.9: opening the console on a pool agent prewarms its pod and the member's coordinator, at most once a minute.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COORDINATOR_PREWARM_REPEAT_MS, prewarmAgentOnOpen, prewarmsOnOpen } from './coordinator'

afterEach(() => vi.unstubAllGlobals())

describe('prewarmsOnOpen', () => {
  it('prewarms only an agent on the pool, never one on a machine or the organization’s own group', () => {
    expect(prewarmsOnOpen({ placementKind: 'pool' }, new Set())).toBe(true)
    expect(prewarmsOnOpen({ placementKind: 'daemon' }, new Set())).toBe(false)
    expect(prewarmsOnOpen({ placementKind: 'set', setId: 'group-1' }, new Set(['group-1']))).toBe(false)
  })
})

describe('prewarmAgentOnOpen', () => {
  it('asks once a minute per agent', () => {
    const send = vi.fn(async () => ({ state: 'starting' }))
    prewarmAgentOnOpen('repeat-agent', 1_000, send)
    prewarmAgentOnOpen('repeat-agent', 1_000 + COORDINATOR_PREWARM_REPEAT_MS - 1, send)
    expect(send).toHaveBeenCalledTimes(1)
    prewarmAgentOnOpen('repeat-agent', 1_000 + COORDINATOR_PREWARM_REPEAT_MS, send)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('asks nothing from a hidden page', () => {
    vi.stubGlobal('document', { visibilityState: 'hidden' })
    const send = vi.fn(async () => ({ state: 'starting' }))
    prewarmAgentOnOpen('hidden-agent', 1_000, send)
    expect(send).not.toHaveBeenCalled()
  })

  it('swallows a refusal, so the first message only starts cold', async () => {
    const send = vi.fn(async () => {
      throw new Error('402')
    })
    expect(() => prewarmAgentOnOpen('unfunded-agent', 1_000, send)).not.toThrow()
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(1)
  })
})
