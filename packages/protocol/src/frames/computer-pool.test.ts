import { describe, expect, it } from 'vitest'
import { AgentComputerUse } from '../agent-computer-use.js'
import { FRAME_SCHEMAS } from '../frame.js'
import { isInstallWideFrameType } from '../frame-scope.js'
import { COMPUTER_STATUSES, COMPUTER_LIVE_STATUSES } from './computer.js'
import { ComputerPoolAcquireResult, ComputerPoolOp, ComputerPoolOpResult } from './computer-pool.js'

const C = '00000000-0000-4000-8000-000000000001'

describe('managed computer frames (computer-use.md §15.1)', () => {
  it('lets an agent pick a managed mode beside its Computers, and only an agent-driven one', () => {
    expect(AgentComputerUse.parse({ enabled: true, managed: { mode: 'per-agent' } })).toEqual({
      enabled: true,
      computers: [],
      managed: { mode: 'per-agent' }
    })
    expect(AgentComputerUse.safeParse({ enabled: true, managed: { mode: 'manual' } }).success).toBe(false)
  })

  it('reads ready, pending and failed acquire results and bounds the retry', () => {
    expect(ComputerPoolAcquireResult.parse({ state: 'ready', computerId: C })).toEqual({
      state: 'ready',
      computerId: C
    })
    expect(
      ComputerPoolAcquireResult.safeParse({ state: 'pending', phase: 'waking', retryAfterMs: 60_000 }).success
    ).toBe(false)
    expect(ComputerPoolAcquireResult.parse({ state: 'failed', code: 'volume_missing', message: 'gone' })).toMatchObject(
      {
        code: 'volume_missing'
      }
    )
  })

  it('sends claim ops install-wide and keeps sleeping a CP verdict', () => {
    expect(isInstallWideFrameType('computer-pool/op')).toBe(true)
    expect(isInstallWideFrameType('computer-pool/op/result')).toBe(true)
    expect(isInstallWideFrameType('computer-pool/acquire')).toBe(false)
    expect(FRAME_SCHEMAS['computer-pool/acquire']).toBeDefined()
    expect(
      ComputerPoolOp.parse({ op: 'ensure', computerId: C, allocation: 'ephemeral', running: true, create: true })
    ).toMatchObject({ op: 'ensure' })
    expect(ComputerPoolOpResult.parse({ ok: true, claims: [{ computerId: C, claim: 'present' }] }).claims).toHaveLength(
      1
    )
    expect(COMPUTER_STATUSES).toContain('sleeping')
    expect(COMPUTER_LIVE_STATUSES as readonly string[]).not.toContain('sleeping')
  })
})
