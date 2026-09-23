import { describe, expect, it } from 'vitest'
import { answerText, cancelReasonKey, latencyText, outcomeTone } from './evaluations'

const words = { yes: 'Yes', no: 'No' }

describe('Recent evaluations projections', () => {
  it('prints each answer type with its confidence and nothing for a stripped row', () => {
    expect(answerText({ type: 'boolean', value: true, probability: 0.9 }, words)).toBe('Yes · 90%')
    expect(answerText({ type: 'boolean', value: false, probability: 0.2 }, words)).toBe('No · 80%')
    expect(answerText({ type: 'choice', value: 'billing', confidence: 0.72 }, words)).toBe('billing · 72%')
    expect(answerText({ type: 'score', value: 2.4999, confidence: 0.6 }, words)).toBe('2.5 · 60%')
    expect(answerText(null, words)).toBeNull()
  })

  it('keeps Unavailable distinct from Skipped', () => {
    expect(outcomeTone('triggered')).toBe('success')
    expect(outcomeTone('skipped')).toBe('neutral')
    expect(outcomeTone('unavailable')).toBe('error')
    expect(outcomeTone('canceled')).toBe('muted')
    expect(outcomeTone('pending')).toBe('pending')
  })

  it('maps stored reasons to message keys', () => {
    expect(cancelReasonKey('stop')).toBe('stop')
    expect(cancelReasonKey('timeout')).toBe('timeout')
    expect(cancelReasonKey('admission:queue_full')).toBe('admission')
    expect(cancelReasonKey('something_new')).toBe('other')
    expect(cancelReasonKey(null)).toBeNull()
  })

  it('formats latency', () => {
    expect(latencyText(120)).toBe('120 ms')
    expect(latencyText(2340)).toBe('2.3 s')
    expect(latencyText(null)).toBeNull()
  })
})
