import { describe, expect, it } from 'vitest'
import type { DecisionEvaluation, DecisionQuestion, SharedBotDecisionRouting } from '@agentconnect.md/protocol'
import { codeHostSampleState, settleCodeHostPreview } from './code-host-routing-preview.js'
import { PREVIEW_THREAD } from './decision-routing-preview.js'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const question: DecisionQuestion = {
  type: 'choice',
  instructions: 'Which kind?',
  criteria: { bug: 'A bug', question: 'A question' }
}
const routing = (otherwise: SharedBotDecisionRouting['otherwise']): SharedBotDecisionRouting => ({
  enabled: true,
  decisionId: '33333333-3333-4333-8333-333333333333',
  rules: [{ id: 'r1', when: { type: 'choice', thresholds: { bug: 0.5 } }, action: { type: 'agent', agentId: A } }],
  otherwise
})
const answered = (bug: number): DecisionEvaluation => ({
  status: 'answered',
  answer: {
    type: 'choice',
    value: bug >= 0.5 ? 'bug' : 'question',
    probabilities: { bug, question: 1 - bug },
    confidence: 0.9
  },
  model: 'jev-1.13.0',
  usage: { inputTokens: 1, outputTokens: 1 }
})
const settle = (evaluation: DecisionEvaluation, otherwise: SharedBotDecisionRouting['otherwise'] = { type: 'skip' }) =>
  settleCodeHostPreview({ question, routing: routing(otherwise), evaluation, chain: new Map(), memberIds: [A, B] })

describe('codeHostSampleState', () => {
  it('binds the provider and repository and gives each entry a synthetic id on one thread', () => {
    const state = codeHostSampleState(
      {
        event: { name: 'issues', action: 'opened' },
        subject: { kind: 'issue', number: 7, labels: ['bug'] },
        currentMessage: { sender: { id: 'reporter' }, text: 'It crashes' },
        history: [{ sender: { id: 'maintainer' }, text: 'Which version?' }]
      },
      { provider: 'github', repoFullName: 'example-org/example-repo' }
    )
    expect(state).toEqual({
      source: 'github',
      event: { name: 'issues', action: 'opened' },
      repository: { fullName: 'example-org/example-repo' },
      subject: { kind: 'issue', number: 7, labels: ['bug'] },
      currentMessage: { id: 'preview-2', sender: { id: 'reporter' }, text: 'It crashes', threadId: PREVIEW_THREAD },
      history: [{ id: 'preview-1', sender: { id: 'maintainer' }, text: 'Which version?', threadId: PREVIEW_THREAD }],
      context: { partial: true, reasons: ['observed_history'], omittedMessages: 0 }
    })
  })

  it('marks a change whose sample carries no pull request context as the live state does', () => {
    const state = codeHostSampleState(
      {
        event: { name: 'pull_request', action: 'opened' },
        subject: { kind: 'pull_request', number: 7, labels: [] },
        currentMessage: { sender: { id: 'author' }, text: 'Please review' },
        history: []
      },
      { provider: 'github', repoFullName: 'example-org/example-repo' }
    )
    expect(state).toMatchObject({
      pullRequest: { commitMessages: '', files: [], filesTruncated: true },
      context: { partial: true, reasons: ['observed_history', 'pull_request_unavailable'] }
    })
  })
})

describe('settleCodeHostPreview', () => {
  it("fires a matched rule's member only", () => {
    expect(settle(answered(0.9))).toMatchObject({ outcome: 'activate', agentIds: [A], matchedRuleIds: ['r1'] })
  })

  it('applies Otherwise: nobody, or every member when it asks for them', () => {
    expect(settle(answered(0.1))).toMatchObject({ outcome: 'skip', agentIds: [], usedOtherwise: true })
    expect(settle(answered(0.1), { type: 'default_agent' })).toMatchObject({ outcome: 'activate', agentIds: [A, B] })
  })

  it('fails open to every member when the evaluation is unavailable or unreadable', () => {
    expect(settle({ status: 'unavailable', reason: 'timeout' })).toEqual({
      outcome: 'unavailable',
      reason: 'timeout',
      agentIds: [A, B],
      matchedRuleIds: [],
      matchedKeys: [],
      usedOtherwise: false
    })
    const wrongShape: DecisionEvaluation = {
      status: 'answered',
      answer: { type: 'boolean', value: true, probability: 1 },
      model: 'jev-1.13.0',
      usage: { inputTokens: 1, outputTokens: 1 }
    }
    expect(settle(wrongShape)).toMatchObject({ outcome: 'unavailable', reason: 'invalid_response', agentIds: [A, B] })
  })
})
