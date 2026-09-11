/** The binding lifecycle rules of gitea-integration.md §4.3, §4.4, §6 — pure, so every consumer reads one answer. */
import { describe, expect, it } from 'vitest'
import type { GiteaBindingState } from '../persistence/ports.js'
import {
  ADMIN_LOST_REASON,
  afterDeliveryVerified,
  afterTokenRejection,
  authorizesMembership,
  compilesHookRule,
  readyOutcome,
  servesRuntime,
  TOKEN_REJECTED_REASON,
  WEBHOOK_UNVERIFIED_REASON
} from './binding-state.js'

const STATES: GiteaBindingState[] = ['provisioning', 'ready', 'admin_degraded', 'runtime_degraded', 'cleanup_pending']

describe('gitea binding state rules', () => {
  it('serves runtime through an admin-plane fault, never through a rejected token or cleanup', () => {
    expect(STATES.filter(servesRuntime)).toEqual(['provisioning', 'ready', 'admin_degraded'])
  })

  it('authorizes a collaborator lookup only from a fully converged binding (§4.4)', () => {
    expect(STATES.filter(authorizesMembership)).toEqual(['ready'])
  })

  it('keeps every rule but a cleanup one in the relay pool', () => {
    expect(STATES.filter((state) => !compilesHookRule(state))).toEqual(['cleanup_pending'])
  })

  it('degrades every servable binding on a rejected token and leaves cleanup alone (§4.3)', () => {
    expect(afterTokenRejection('ready')).toBe('runtime_degraded')
    expect(afterTokenRejection('admin_degraded')).toBe('runtime_degraded')
    expect(afterTokenRejection('provisioning')).toBe('runtime_degraded')
    expect(afterTokenRejection('cleanup_pending')).toBe('cleanup_pending')
    expect(TOKEN_REJECTED_REASON).toBe('token_rejected')
    expect(ADMIN_LOST_REASON).toBe('admin_lost')
  })

  it('is ready either way after a converged webhook, warning when the test delivery never arrived (§6)', () => {
    expect(readyOutcome(true)).toEqual({ state: 'ready', stateReason: null })
    expect(readyOutcome(false)).toEqual({ state: 'ready', stateReason: WEBHOOK_UNVERIFIED_REASON })
  })

  it('a verified delivery clears exactly the unverified warning', () => {
    expect(afterDeliveryVerified('ready', WEBHOOK_UNVERIFIED_REASON)).toEqual({ state: 'ready', stateReason: null })
    expect(afterDeliveryVerified('ready', null)).toEqual({ state: 'ready', stateReason: null })
    expect(afterDeliveryVerified('admin_degraded', ADMIN_LOST_REASON)).toEqual({
      state: 'admin_degraded',
      stateReason: ADMIN_LOST_REASON
    })
    expect(afterDeliveryVerified('runtime_degraded', TOKEN_REJECTED_REASON)).toEqual({
      state: 'runtime_degraded',
      stateReason: TOKEN_REJECTED_REASON
    })
  })
})
