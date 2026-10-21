import { describe, expect, it } from 'vitest'
import {
  DEFAULT_COMPUTER_POOL_TIMINGS as T,
  managedComputerName,
  managedComputerPolicy,
  poolError,
  poolErrorCode,
  poolErrorMessage,
  poolActions,
  provisionStep,
  sweepAction,
  type PoolRow
} from './computerPool.js'

const NOW = Date.parse('2026-10-21T10:00:00.000Z')
const C = '00000000-0000-4000-8000-000000000001'

const row = (over: Partial<PoolRow> = {}): PoolRow => ({
  allocation: 'per-agent',
  phase: 'awake',
  phaseAt: NOW - 1000,
  activeAt: NOW - 1000,
  status: 'online',
  lastSeenAt: NOW - 1000,
  ...over
})

describe('sweepAction', () => {
  it('times out a desktop that never starts, never registers, or never wakes', () => {
    expect(sweepAction(row({ phase: 'provisioning' }), false, NOW)).toEqual({ kind: 'advance' })
    expect(sweepAction(row({ phase: 'provisioning', phaseAt: NOW - T.provisionTimeoutMs - 1 }), false, NOW)).toEqual({
      kind: 'timeout',
      message: 'the desktop pod never became ready'
    })
    expect(
      sweepAction(row({ phase: 'registering', phaseAt: NOW - T.registerTimeoutMs - 1 }), false, NOW)
    ).toMatchObject({
      kind: 'timeout',
      message: 'the desktop never registered with the Control Plane'
    })
    expect(sweepAction(row({ phase: 'waking', phaseAt: NOW - T.wakeTimeoutMs - 1 }), false, NOW)).toMatchObject({
      kind: 'timeout'
    })
  })

  it('reclaims an idle ephemeral desktop and puts an idle per-agent or manual one to sleep', () => {
    const idle = NOW - T.sleepIdleMs - 1
    expect(sweepAction(row({ allocation: 'ephemeral', activeAt: NOW - T.ephemeralIdleMs - 1 }), false, NOW)).toEqual({
      kind: 'reclaim',
      reason: 'idle'
    })
    expect(sweepAction(row({ activeAt: idle }), false, NOW)).toEqual({ kind: 'sleep' })
    expect(sweepAction(row({ allocation: 'manual', activeAt: idle }), false, NOW)).toEqual({ kind: 'sleep' })
    // A held lease is use, however long ago anything else happened.
    expect(sweepAction(row({ activeAt: idle }), true, NOW)).toEqual({ kind: 'none' })
    expect(sweepAction(row({ activeAt: NOW - T.ephemeralIdleMs - 1 }), false, NOW)).toEqual({ kind: 'none' })
  })

  it('restarts an awake desktop whose pod went away, after a grace', () => {
    expect(sweepAction(row({ status: 'offline', lastSeenAt: NOW - 1000 }), false, NOW)).toEqual({ kind: 'none' })
    expect(sweepAction(row({ status: 'offline', lastSeenAt: NOW - T.offlineGraceMs - 1 }), false, NOW)).toEqual({
      kind: 'advance'
    })
  })

  it('leaves sleeping and failed desktops alone and keeps reclaiming one that is', () => {
    expect(sweepAction(row({ phase: 'sleeping', activeAt: 0 }), false, NOW)).toEqual({ kind: 'none' })
    expect(sweepAction(row({ phase: 'failed' }), false, NOW)).toEqual({ kind: 'none' })
    expect(sweepAction(row({ phase: 'reclaiming' }), false, NOW)).toEqual({ kind: 'advance' })
  })
})

describe('provisionStep', () => {
  it('waits for the pod, asks for the registration push, and accepts only its own Computer', () => {
    expect(provisionStep(undefined, C)).toEqual({ kind: 'wait' })
    expect(provisionStep({ computerId: C, claim: 'present', pod: 'starting' }, C)).toEqual({ kind: 'wait' })
    expect(provisionStep({ computerId: C, claim: 'present', pod: 'running', registered: false }, C)).toEqual({
      kind: 'register'
    })
    expect(
      provisionStep({ computerId: C, claim: 'present', pod: 'running', registered: true, registeredComputerId: C }, C)
    ).toEqual({ kind: 'registered' })
    expect(
      provisionStep(
        { computerId: C, claim: 'present', pod: 'running', registered: true, registeredComputerId: 'other' },
        C
      )
    ).toMatchObject({ kind: 'fail' })
    expect(provisionStep({ computerId: C, claim: 'present', pod: 'failed', detail: 'ImagePullBackOff' }, C)).toEqual({
      kind: 'fail',
      message: 'the desktop pod cannot start: ImagePullBackOff'
    })
  })
})

describe('managed computer defaults', () => {
  it('asks no approvals on an isolated desktop, unless a user set a policy', () => {
    const policy = managedComputerPolicy('u1')
    expect(policy.allowedMembers).toEqual(['u1'])
    expect(policy.approvals).toEqual({ firstInputPerSession: false, launchApp: 'never-ask', submitLikeKeys: false })
    const kept = managedComputerPolicy('u1', { ...policy, agentMode: 'view', allowedMembers: ['u2'] })
    expect(kept.agentMode).toBe('view')
    expect(kept.allowedMembers).toEqual(['u1', 'u2'])
  })

  it('names a desktop after its agent and keeps the cause of a failure with its code', () => {
    expect(managedComputerName('per-agent', 'Researcher')).toBe('Researcher desktop')
    expect(managedComputerName('ephemeral', 'Researcher')).toBe('Researcher session desktop')
    const error = poolError('volume_missing', 'the volume is gone')
    expect(poolErrorCode(error)).toBe('volume_missing')
    expect(poolErrorMessage(error)).toBe('the volume is gone')
    expect(poolErrorCode(poolError('failed', 'x'))).toBe('failed')
    expect(poolErrorCode(null)).toBeUndefined()
  })
})

describe('poolActions', () => {
  const of = (over: Partial<Parameters<typeof poolActions>[0]> = {}) =>
    poolActions({ allocation: 'manual', poolPhase: 'awake', poolError: null, revoked: false, ...over })

  it('offers sleep and reset while awake, wake while asleep or failed', () => {
    expect(of()).toEqual({ wake: false, sleep: true, reset: true })
    expect(of({ poolPhase: 'sleeping' })).toEqual({ wake: true, sleep: false, reset: true })
    expect(of({ allocation: 'per-agent', poolPhase: 'failed', poolError: poolError('failed', 'x') })).toEqual({
      wake: true,
      sleep: false,
      reset: true
    })
  })

  it('offers only reset once the volume is gone', () => {
    expect(of({ poolPhase: 'failed', poolError: poolError('volume_missing', 'gone') })).toEqual({
      wake: false,
      sleep: false,
      reset: true
    })
  })

  it('offers only reset after a reset that did not remove the old desktop', () => {
    expect(
      of({ poolPhase: 'failed', poolError: poolError('reset_failed', 'the old desktop was not removed') })
    ).toEqual({
      wake: false,
      sleep: false,
      reset: true
    })
    expect(poolErrorCode(poolError('reset_failed', 'x'))).toBe('reset_failed')
    expect(poolErrorMessage(poolError('reset_failed', 'x'))).toBe('x')
  })

  it('offers nothing for an ephemeral, self-hosted, revoked, resetting or reclaiming computer', () => {
    const none = { wake: false, sleep: false, reset: false }
    expect(of({ allocation: 'ephemeral' })).toEqual(none)
    expect(of({ allocation: null, poolPhase: null })).toEqual(none)
    expect(of({ revoked: true })).toEqual(none)
    expect(of({ poolPhase: 'resetting' })).toEqual(none)
    expect(of({ poolPhase: 'reclaiming' })).toEqual(none)
  })

  it('advances a reset until the old desktop is gone, and times it out like a provision', () => {
    expect(sweepAction(row({ phase: 'resetting' }), false, NOW)).toEqual({ kind: 'advance' })
    expect(sweepAction(row({ phase: 'resetting', phaseAt: NOW - T.provisionTimeoutMs - 1 }), false, NOW)).toEqual({
      kind: 'timeout',
      message: 'the old desktop was not removed'
    })
  })
})
