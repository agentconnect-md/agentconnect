import { describe, expect, it } from 'vitest'
import { distributionRows, modelLine, prettyJson } from './model-result'

const words = { yes: 'Yes', no: 'No' }

describe('Model result projections', () => {
  it('orders choice options by the frozen criteria and marks the chosen and matched keys with thresholds', () => {
    const rows = distributionRows({
      question: {
        type: 'choice',
        instructions: 'Which topic?',
        criteria: { billing: 'Payments', technical: 'Bugs', sales: 'Pricing' }
      },
      answer: {
        type: 'choice',
        value: 'billing',
        probabilities: { sales: 0.08, billing: 0.71, technical: 0.21 },
        confidence: 0.71
      },
      condition: { type: 'choice', thresholds: { billing: 0.5, technical: 0.2 } },
      matchedKeys: ['billing', 'technical'],
      matched: true,
      words
    })
    expect(rows.map((row) => [row.key, row.probability, row.chosen, row.triggers, row.thresholds])).toEqual([
      ['billing', 0.71, true, true, [0.5]],
      ['technical', 0.21, false, true, [0.2]],
      ['sales', 0.08, false, false, []]
    ])
    expect(rows[0]!.description).toBe('Payments')
  })

  it('splits a boolean answer into Yes and No and marks the chosen side only when it triggered', () => {
    const answer = { type: 'boolean' as const, value: true, probability: 0.86 }
    const question = {
      type: 'boolean' as const,
      instructions: 'Reply?',
      criteria: { true: 'Needs a reply', false: 'Chatter' }
    }
    const hit = distributionRows({ question, answer, matchedKeys: [], matched: true, words })
    expect(hit.map((row) => [row.label, row.probability, row.chosen, row.triggers, row.description])).toEqual([
      ['Yes', 0.86, true, true, 'Needs a reply'],
      ['No', expect.closeTo(0.14), false, false, 'Chatter']
    ])
    const miss = distributionRows({ question: null, answer, matchedKeys: [], matched: false, words })
    expect(miss.some((row) => row.triggers)).toBe(false)
    expect(miss[0]!.description).toBeNull()
  })

  it('takes every frozen routing rule threshold per option instead of a gate condition', () => {
    const rows = distributionRows({
      question: null,
      answer: { type: 'choice', value: 'billing', probabilities: { billing: 0.6, sales: 0.4 }, confidence: 0.6 },
      condition: { type: 'choice', thresholds: { billing: 0.9 } },
      ruleThresholds: new Map([
        ['billing', [0.7, 0.3, 0.7]],
        ['sales', [0.5]]
      ]),
      matchedKeys: ['billing'],
      matched: true,
      words
    })
    expect(rows.map((row) => [row.key, row.thresholds])).toEqual([
      ['billing', [0.3, 0.7]],
      ['sales', [0.5]]
    ])
  })

  it('marks score levels inside the interval but never a rounded level as the answer or trigger', () => {
    const rows = distributionRows({
      question: { type: 'score', instructions: 'How upset?', criteria: ['Calm', 'Concerned', 'Upset', 'Angry'] },
      answer: { type: 'score', value: 1.5, probabilities: [0.05, 0.45, 0.4, 0.1], confidence: 0.45 },
      condition: { type: 'score', min: 1, max: 1.6 },
      matchedKeys: [],
      matched: true,
      words
    })
    expect(rows.map((row) => row.inRange)).toEqual([false, true, false, false])
    expect(rows.some((row) => row.chosen || row.triggers)).toBe(false)
    const top = distributionRows({
      question: null,
      answer: { type: 'score', value: 3, probabilities: [0, 0, 0.2, 0.8], confidence: 0.8 },
      condition: { type: 'score', min: 2, max: 3 },
      matchedKeys: [],
      matched: true,
      words
    })
    expect(top.map((row) => row.inRange)).toEqual([false, false, true, true])
  })

  it('names a resolved alias and indents raw JSON, leaving a malformed body as it arrived', () => {
    expect(modelLine('jev-latest', 'jev-1.13.0')).toBe('jev-latest → jev-1.13.0')
    expect(modelLine('jev-1.13.0', 'jev-1.13.0')).toBe('jev-1.13.0')
    expect(modelLine('jev-1.13.0', null)).toBe('jev-1.13.0')
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(prettyJson('{"a":')).toBe('{"a":')
  })
})
