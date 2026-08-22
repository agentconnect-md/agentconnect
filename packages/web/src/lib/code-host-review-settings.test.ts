import { describe, expect, it } from 'vitest'
import {
  codeHostReviewCapabilities,
  codeHostReviewSettingsFromCapabilities,
  REVIEW_PRESETS,
  reviewPolicyLabel,
  reviewPresetOf,
  withCapability,
  type CodeHostReviewSettingsValue
} from './code-host-review-settings'

describe('codeHostReviewCapabilities', () => {
  it('projects the hierarchical policy onto the four checkboxes', () => {
    expect(codeHostReviewCapabilities({ reviewPolicy: 'off', reportingMode: 'off' })).toEqual({
      inlineComments: false,
      requestChanges: false,
      approve: false,
      statusCheck: false
    })
    expect(codeHostReviewCapabilities({ reviewPolicy: 'full', reportingMode: 'check' })).toEqual({
      inlineComments: true,
      requestChanges: true,
      approve: true,
      statusCheck: true
    })
  })

  it('round-trips every reachable value', () => {
    const values: CodeHostReviewSettingsValue[] = [
      { reviewPolicy: 'off', reportingMode: 'off' },
      { reviewPolicy: 'off', reportingMode: 'check' },
      { reviewPolicy: 'comment', reportingMode: 'off' },
      { reviewPolicy: 'request_changes', reportingMode: 'check' },
      { reviewPolicy: 'full', reportingMode: 'check' }
    ]
    for (const value of values) {
      expect(codeHostReviewSettingsFromCapabilities(codeHostReviewCapabilities(value))).toEqual(value)
    }
  })
})

describe('withCapability', () => {
  it('drops the dependants when the base capability is turned off', () => {
    const full = codeHostReviewCapabilities({ reviewPolicy: 'full', reportingMode: 'check' })
    expect(withCapability(full, 'inlineComments', false)).toMatchObject({
      inlineComments: false,
      requestChanges: false,
      approve: false
    })
    expect(withCapability(full, 'requestChanges', false)).toMatchObject({ requestChanges: false, approve: false })
  })

  it('raises the prerequisites when a stronger capability is turned on', () => {
    const none = codeHostReviewCapabilities({ reviewPolicy: 'off', reportingMode: 'off' })
    expect(withCapability(none, 'approve', true)).toMatchObject({
      inlineComments: true,
      requestChanges: true,
      approve: true
    })
    expect(withCapability(none, 'requestChanges', true)).toMatchObject({ inlineComments: true, requestChanges: true })
  })

  it('keeps the reporting axis independent of the review ladder', () => {
    const none = codeHostReviewCapabilities({ reviewPolicy: 'off', reportingMode: 'off' })
    expect(codeHostReviewSettingsFromCapabilities(withCapability(none, 'statusCheck', true))).toEqual({
      reviewPolicy: 'off',
      reportingMode: 'check'
    })
  })
})

describe('reviewPresetOf', () => {
  it('reads each preset back from the value it writes', () => {
    for (const preset of REVIEW_PRESETS) expect(reviewPresetOf(preset.value)).toBe(preset.id)
  })

  it('reads anything richer than brief as details', () => {
    expect(reviewPresetOf({ reviewPolicy: 'comment', reportingMode: 'check' })).toBe('details')
    expect(reviewPresetOf({ reviewPolicy: 'request_changes', reportingMode: 'off' })).toBe('details')
  })
})

describe('reviewPolicyLabel', () => {
  it('names each policy without naming a host', () => {
    expect(reviewPolicyLabel('off')).toBe('Off')
    expect(reviewPolicyLabel('request_changes')).toBe('Request changes')
    expect(REVIEW_PRESETS.map(({ label }) => label)).toEqual(['None', 'Brief', 'Details'])
  })
})
