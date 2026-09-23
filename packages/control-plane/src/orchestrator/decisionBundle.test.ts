import { describe, expect, it } from 'vitest'
import type { IntegrationChannelRecord } from '../persistence/ports.js'
import { activationOf, decisionBundleOf, decisionGateState, heldDecisionChannels } from './decisionBundle.js'

const definition = {
  id: 'd1',
  orgId: 'org',
  name: 'Topic',
  providerId: 'typesafe',
  model: 'jev-1.13.0',
  question: { type: 'choice' as const, instructions: 'Which topic?', criteria: { billing: 'Money', tech: 'Code' } }
}
const gate = {
  type: 'gate' as const,
  decisionId: 'd1',
  when: { type: 'choice' as const, thresholds: { billing: 0.6 } }
}
const row = (over: Partial<IntegrationChannelRecord> = {}) => ({
  channelId: 'C1',
  kind: 'channel' as const,
  trigger: 'decision' as const,
  decisionBinding: gate,
  decisionNeedsReview: false,
  decisionDefinition: definition,
  ...over
})

describe('decisionGateState', () => {
  it('enables a valid gate', () => {
    expect(decisionGateState(row())).toMatchObject({ enabled: true })
  })

  it('reports needs_review from the stored flag and from a derived incompatibility', () => {
    expect(decisionGateState(row({ decisionNeedsReview: true }))).toMatchObject({
      enabled: false,
      disabledReason: 'needs_review'
    })
    const removedKey = { ...definition, question: { ...definition.question, criteria: { tech: 'Code', ops: 'Ops' } } }
    expect(decisionGateState(row({ decisionDefinition: removedKey }))).toMatchObject({
      enabled: false,
      disabledReason: 'needs_review'
    })
  })

  it('reports access_revoked for a missing definition or binding', () => {
    expect(decisionGateState(row({ decisionDefinition: null }))).toMatchObject({ disabledReason: 'access_revoked' })
    expect(decisionGateState(row({ decisionBinding: null }))).toMatchObject({ disabledReason: 'access_revoked' })
  })

  it('never enables a 1:1 DM and ignores other triggers', () => {
    expect(decisionGateState(row({ kind: 'im' }))?.enabled).toBe(false)
    expect(decisionGateState(row({ trigger: 'any', decisionBinding: null }))).toBeNull()
  })
})

describe('decisionBundleOf', () => {
  it('keeps every binding and deduplicates definitions', () => {
    const bundle = decisionBundleOf([row(), row({ channelId: 'C2', decisionNeedsReview: true })])
    expect(bundle.bindings.map((b) => [b.channel, b.enabled, b.disabledReason])).toEqual([
      ['C1', true, undefined],
      ['C2', false, 'needs_review']
    ])
    expect(bundle.definitions).toEqual([definition])
    expect(heldDecisionChannels([row(), row({ channelId: 'C2', decisionDefinition: null })])).toEqual(['C2'])
  })
})

describe('activationOf', () => {
  it('carries the binding with the trigger, and fails closed without one', () => {
    expect(activationOf(row())).toEqual({ trigger: 'decision', decisionBinding: gate, decisionNeedsReview: false })
    expect(activationOf(row({ decisionBinding: null }))).toEqual({ trigger: 'off' })
    expect(activationOf(row({ trigger: 'mention', decisionBinding: null }))).toEqual({ trigger: 'mention' })
  })
})
