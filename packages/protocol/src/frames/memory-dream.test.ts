import { describe, expect, it } from 'vitest'
import { AnyFrame } from '../frame.js'
import {
  AgentMemoryBinding,
  DEFAULT_MEMORY_DREAMING_POLICY,
  effectiveMemoryDreamingPolicy,
  MemoryDreamingPolicy
} from './memory-connection.js'
import { DreamInfo, DreamStartReq, DreamFileReadReq, DreamAdoptReq } from './memory.js'

const ID = '11111111-1111-4111-8111-111111111111'
const TS = '2026-07-24T00:00:00.000Z'

const dream = {
  dreamId: 'drm-0001',
  agentId: 'agent-1',
  status: 'completed' as const,
  trigger: 'manual' as const,
  sessionIds: ['sess-1', 'sess-2'],
  snapshotDigest: 'sha256:abc',
  createdAt: TS
}

describe('memory dreaming policy (agent binding)', () => {
  it('accepts dreaming only on the managed provider', () => {
    expect(
      AgentMemoryBinding.parse({
        provider: 'managed',
        autoDistill: true,
        dreaming: { enabled: true, sessionWindow: 20, schedule: '0 4 * * *' }
      })
    ).toMatchObject({ provider: 'managed', dreaming: { enabled: true } })

    for (const provider of ['native', 'none'] as const) {
      expect(() => AgentMemoryBinding.parse({ provider, dreaming: { enabled: true } })).toThrow(
        /managed memory provider/
      )
    }
    // external is a different union branch — dreaming is an unknown key there.
    expect(() =>
      AgentMemoryBinding.parse({
        provider: 'external',
        connectionId: ID,
        dreaming: { enabled: true }
      })
    ).toThrow()
  })

  it('bounds the policy fields', () => {
    expect(() => MemoryDreamingPolicy.parse({ enabled: true, sessionWindow: 101 })).toThrow()
    expect(() => MemoryDreamingPolicy.parse({ enabled: true, instructions: 'x'.repeat(4097) })).toThrow()
    expect(() => MemoryDreamingPolicy.parse({ enabled: true, unknown: 1 })).toThrow()
  })

  it('defaults managed memory to a daily auto-adopting, skill-mining dream while preserving explicit opt-out', () => {
    expect(effectiveMemoryDreamingPolicy(undefined)).toEqual(DEFAULT_MEMORY_DREAMING_POLICY)
    expect(effectiveMemoryDreamingPolicy({ provider: 'managed' })).toEqual(DEFAULT_MEMORY_DREAMING_POLICY)

    // An explicit policy with no schedule is manual-only; absent autoAdopt and
    // mineSkills normalize to the product default (true).
    expect(effectiveMemoryDreamingPolicy({ provider: 'managed', dreaming: { enabled: true } })).toEqual({
      enabled: true,
      autoAdopt: true,
      mineSkills: true
    })
    // An explicit false is a durable opt-out.
    expect(
      effectiveMemoryDreamingPolicy({
        provider: 'managed',
        dreaming: { enabled: true, autoAdopt: false, mineSkills: false }
      })
    ).toEqual({ enabled: true, autoAdopt: false, mineSkills: false })
    expect(effectiveMemoryDreamingPolicy({ provider: 'none' })).toBeUndefined()
  })
})

describe('memory dreaming frames', () => {
  it('defaults and bounds dream/start', () => {
    expect(DreamStartReq.parse({ agentId: 'a' })).toEqual({ agentId: 'a', trigger: 'manual' })
    expect(() => DreamStartReq.parse({ agentId: 'a', sessionWindow: 0 })).toThrow()
  })

  it('defaults the staged-file read slice like memory/read', () => {
    expect(DreamFileReadReq.parse({ agentId: 'a', dreamId: 'd' })).toEqual({
      agentId: 'a',
      dreamId: 'd',
      path: 'MEMORY.md',
      offset: 0,
      limit: 65536
    })
  })

  it('adopt defaults to fenced (force=false)', () => {
    expect(DreamAdoptReq.parse({ agentId: 'a', dreamId: 'd' })).toMatchObject({ force: false })
  })

  it('rejects unbounded or malformed dream metadata', () => {
    expect(DreamInfo.parse(dream)).toMatchObject({ status: 'completed' })
    expect(DreamInfo.parse({ ...dream, status: 'superseded' })).toMatchObject({ status: 'superseded' })
    expect(() => DreamInfo.parse({ ...dream, status: 'dreaming' })).toThrow()
    expect(() =>
      DreamInfo.parse({ ...dream, skills: [{ name: 'Bad Name', description: '', state: 'proposed' }] })
    ).toThrow()
    expect(() => DreamInfo.parse({ ...dream, sessionIds: Array.from({ length: 101 }, (_, i) => `s${i}`) })).toThrow()
  })

  it('preserves execution correlation and token/cost usage', () => {
    expect(
      DreamInfo.parse({
        ...dream,
        executionSessionId: 'dream-session-1',
        runtime: 'codex',
        model: 'gpt-5.6',
        stopReason: 'end_turn',
        usage: {
          inputBytes: 2048,
          outputBytes: 512,
          totalTokens: 120,
          inputTokens: 90,
          outputTokens: 30,
          cachedReadTokens: 20,
          costAmount: 0.012,
          costCurrency: 'USD'
        }
      })
    ).toMatchObject({
      executionSessionId: 'dream-session-1',
      runtime: 'codex',
      model: 'gpt-5.6',
      stopReason: 'end_turn',
      usage: { totalTokens: 120, cachedReadTokens: 20, costAmount: 0.012 }
    })
  })

  it('round-trips dream frames through the wire union', () => {
    const start = AnyFrame.parse({
      v: 1,
      id: ID,
      ts: TS,
      type: 'memory/dream/start',
      payload: { agentId: 'agent-1', trigger: 'manual' }
    })
    expect(start.type).toBe('memory/dream/start')

    const state = AnyFrame.parse({
      v: 1,
      id: ID,
      ts: TS,
      type: 'memory/dream/adopt/ok',
      corr: ID,
      payload: { dream: { ...dream, status: 'adopted' } }
    })
    if (state.type !== 'memory/dream/adopt/ok') throw new Error('wrong branch')
    expect(state.payload.dream.status).toBe('adopted')
  })
})
