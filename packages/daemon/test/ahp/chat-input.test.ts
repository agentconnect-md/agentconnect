import { describe, expect, it } from 'vitest'
import { ahpInputRequest, ahpSubmittedAnswers } from '../../src/ahp/chat-input.js'

describe('AHP elicitation mapping', () => {
  it('uses stable original property IDs and typed values', () => {
    const request = ahpInputRequest({
      requestId: 'ask',
      message: 'Details',
      options: [],
      fields: [
        {
          propName: 'count',
          label: 'Count',
          kind: 'number',
          options: [],
          number: { integer: true, minimum: 1 },
          required: true
        },
        { propName: 'enabled', label: 'Enabled', kind: 'boolean', options: [] },
        { propName: 'choices', label: 'Choices', kind: 'multi-enum', options: [{ label: 'One', value: 'one' }] }
      ]
    })
    expect(request.questions?.map((field) => [field.id, field.kind])).toEqual([
      ['count', 'integer'],
      ['enabled', 'boolean'],
      ['choices', 'multi-select']
    ])
    expect(ahpSubmittedAnswers(request, { count: 2, enabled: false, choices: ['one'], foreign: 'ignored' })).toEqual({
      count: { state: 'submitted', value: { kind: 'number', value: 2 } },
      enabled: { state: 'submitted', value: { kind: 'boolean', value: false } },
      choices: { state: 'submitted', value: { kind: 'selected-many', value: ['one'] } }
    })
  })
  it('maps scalar cards to value and leaves URL consent without invented questions', () => {
    const request = ahpInputRequest({
      requestId: 'ask',
      message: 'Confirm',
      options: [{ label: 'Yes', value: 'true' }]
    })
    expect(ahpSubmittedAnswers(request, { value: true })).toMatchObject({
      value: { value: { kind: 'selected', value: 'true' } }
    })
    expect(ahpInputRequest({ requestId: 'url', message: 'Open', options: [], url: 'https://example.com' })).toEqual({
      id: 'url',
      message: 'Open',
      url: 'https://example.com'
    })
  })
})
