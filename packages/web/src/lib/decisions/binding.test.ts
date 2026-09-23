// The channel DTO and API errors become the strip's saved gate, status, and save-failure copy.

import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api'
import { DecisionMockApiError } from './mock-api'
import { bindingSaveError, decisionInUse, gateStatus, managedByRouting, savedGateOf } from './binding'

const when = { type: 'boolean' as const, values: [true] }
const view = (over: Record<string, unknown> = {}) => ({
  id: 'dec-1',
  name: 'Needs a response',
  enabled: true,
  readiness: { status: 'ready' as const },
  ...over
})

describe('savedGateOf / managedByRouting', () => {
  it('reads only a By decision gate as a saved gate', () => {
    expect(savedGateOf({ trigger: 'decision', decisionBinding: { type: 'gate', decisionId: 'dec-1', when } })).toEqual({
      decisionId: 'dec-1',
      when
    })
    expect(savedGateOf({ trigger: 'decision', decisionBinding: { type: 'shared_bot_routing' } })).toBeNull()
    expect(savedGateOf({ trigger: 'mention', decisionBinding: null })).toBeNull()
  })

  it('marks only a shared-bot routing binding as managed elsewhere', () => {
    expect(managedByRouting({ trigger: 'decision', decisionBinding: { type: 'shared_bot_routing' } })).toBe(true)
    expect(managedByRouting({ trigger: 'decision', decisionBinding: { type: 'gate', decisionId: 'd', when } })).toBe(
      false
    )
    expect(managedByRouting({ trigger: 'any' })).toBe(false)
  })
})

describe('gateStatus', () => {
  it('lets a revoked grant outrank a ready consumer', () => {
    expect(gateStatus(view({ enabled: false, disabledReason: 'access_revoked' }))).toBe('access_revoked')
  })

  it.each(['ready', 'pending_sync', 'needs_review', 'daemon_offline', 'unsupported'] as const)(
    'passes readiness %s through',
    (status) => {
      expect(gateStatus(view({ readiness: { status } }))).toBe(status)
    }
  )

  it('reads a missing view as pending sync', () => {
    expect(gateStatus(null)).toBe('pending_sync')
    expect(gateStatus(undefined)).toBe('pending_sync')
  })
})

describe('bindingSaveError', () => {
  const issues = [{ path: ['values'], message: 'Pick at least one answer.' }]
  it.each([
    [new ApiError('bad', 400, undefined, { issues }), { kind: 'invalid', issues }],
    [
      new ApiError('By decision applies only to group conversations', 400),
      { kind: 'invalid_request', message: 'By decision applies only to group conversations' }
    ],
    [new ApiError('cannot edit', 403), { kind: 'forbidden' }],
    [new ApiError('decision not found', 404, 'DECISION_NOT_FOUND'), { kind: 'decision_unavailable' }],
    [new ApiError('channel not found', 404), { kind: 'failed', message: 'channel not found' }],
    [new ApiError('upgrade', 409, 'DECISION_UNSUPPORTED_CONSUMER'), { kind: 'unsupported' }],
    [new ApiError('owner changed', 409), { kind: 'failed', message: 'owner changed' }],
    [new Error('network down'), { kind: 'failed', message: 'network down' }],
    [new DecisionMockApiError(400, { error: 'invalid_input', message: 'Check', issues }), { kind: 'invalid', issues }]
  ])('maps %s', (cause, expected) => {
    expect(bindingSaveError(cause)).toEqual(expected)
  })
})

describe('decisionInUse', () => {
  const usages = [{ kind: 'gate' as const, id: 'int-1:C1', label: '#general', integrationId: 'int-1', channelId: 'C1' }]
  it('narrows a live 409 with its hidden count', () => {
    expect(decisionInUse(new ApiError('in use', 409, undefined, { usages, hiddenUsageCount: 3 }))).toEqual({
      message: 'in use',
      usages,
      hiddenUsageCount: 3
    })
  })

  it('narrows a mock 409 and defaults the hidden count to zero', () => {
    expect(decisionInUse(new DecisionMockApiError(409, { error: 'conflict', message: 'in use', usages }))).toEqual({
      message: 'in use',
      usages,
      hiddenUsageCount: 0
    })
  })

  it('ignores every other error', () => {
    expect(decisionInUse(new ApiError('in use', 409))).toBeNull()
    expect(decisionInUse(new ApiError('gone', 404, undefined, { usages }))).toBeNull()
    expect(decisionInUse(new Error('boom'))).toBeNull()
  })
})
