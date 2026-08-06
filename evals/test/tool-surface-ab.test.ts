import { describe, expect, it } from 'vitest'
import { AB_SCENARIOS, classifySendForm, extractTrialMetrics } from '../games/tool-surface-ab.js'

/**
 * The A/B's measurement apparatus, tested without model credentials. If the
 * classifier or the metric extraction is wrong, every number in the write-up is
 * wrong — so both are pinned here rather than trusted.
 */

function toolCall(id: string, name: string, fields: Record<string, unknown> = {}) {
  return {
    type: 'acp.update',
    data: { update: { sessionUpdate: 'tool_call', toolCallId: id, title: name, ...fields } }
  }
}
function toolUpdate(id: string, name: string, fields: Record<string, unknown>) {
  return {
    type: 'acp.update',
    data: { update: { sessionUpdate: 'tool_call_update', toolCallId: id, title: name, ...fields } }
  }
}

describe('send-form classifier — one vocabulary for both arms', () => {
  it('maps every legal product shape to its form', () => {
    expect(classifySendForm({ toAgent: 'a', channel: 'C' })).toBe('agent-channel')
    expect(classifySendForm({ toAgent: 'a' })).toBe('agent-postless')
    expect(classifySendForm({ toAgent: { agentId: 'a', needsReply: true } })).toBe('agent-postless')
    expect(classifySendForm({ toUser: 'U', channel: 'C' })).toBe('user-channel')
    expect(classifySendForm({ toUser: 'U' })).toBe('user-dm')
    expect(classifySendForm({ channel: 'C' })).toBe('channel-bare')
    expect(classifySendForm({ sessionId: 'S' })).toBe('parent-session')
  })

  it('refuses to classify a shape that names no target', () => {
    expect(classifySendForm({ message: 'hi' })).toBe('unclassifiable')
    expect(classifySendForm(undefined)).toBe('unclassifiable')
    expect(classifySendForm({ channel: '' })).toBe('unclassifiable')
  })

  it('is symmetric: an arm-B compiled call scores exactly like the arm-A call it becomes', () => {
    // This is the property that makes the two arms comparable at all.
    const compiled = { toAgent: 'a', channel: 'C', message: 'x' }
    expect(classifySendForm(compiled)).toBe(classifySendForm({ toAgent: 'a', channel: 'C', message: 'x' }))
  })
})

describe('trial metric extraction', () => {
  it('scores a clean first-attempt success', () => {
    const metrics = extractTrialMetrics(
      [
        toolCall('t1', 'sendMessage'),
        toolUpdate('t1', 'sendMessage', { rawInput: { toAgent: 'a', channel: 'C', message: 'x' } }),
        toolUpdate('t1', 'sendMessage', { status: 'completed' }),
        { type: 'turn.completed', data: { usage: { totalTokens: 1200 } } }
      ],
      { toolName: 'sendMessage', expected: 'agent-channel', latencyMs: 5000 }
    )
    expect(metrics).toMatchObject({
      firstAttemptSuccess: true,
      completed: true,
      attemptsToSuccess: 1,
      toolCalls: 1,
      invalidCalls: 0,
      totalTokens: 1200
    })
  })

  it('counts a refused call and the self-correction that follows it', () => {
    // The comprehensibility signal: one rejection, then a corrected retry.
    const metrics = extractTrialMetrics(
      [
        toolCall('t1', 'sendMessage'),
        toolUpdate('t1', 'sendMessage', { rawInput: { toAgent: 'a', toUser: 'U', message: 'x' } }),
        toolUpdate('t1', 'sendMessage', { status: 'failed', content: 'exactly one target mode' }),
        toolCall('t2', 'sendMessage'),
        toolUpdate('t2', 'sendMessage', { rawInput: { toAgent: 'a', channel: 'C', message: 'x' } }),
        toolUpdate('t2', 'sendMessage', { status: 'completed' })
      ],
      { toolName: 'sendMessage', expected: 'agent-channel', latencyMs: 9000 }
    )
    expect(metrics.toolCalls).toBe(2)
    expect(metrics.invalidCalls).toBe(1)
    expect(metrics.firstAttemptSuccess).toBe(false)
    expect(metrics.completed).toBe(true)
    expect(metrics.attemptsToSuccess).toBe(2)
    expect(String(metrics.attempts[0]!.error)).toContain('exactly one target mode')
  })

  it('scores a wrong-but-accepted form as a failure to complete, not a success', () => {
    // Posting at a channel root when a postless call was required is accepted by
    // the product and still wrong for the task — the metric must not reward it.
    const metrics = extractTrialMetrics(
      [
        toolCall('t1', 'sendMessage'),
        toolUpdate('t1', 'sendMessage', { rawInput: { toAgent: 'a', channel: 'C', message: 'x' } }),
        toolUpdate('t1', 'sendMessage', { status: 'completed' })
      ],
      { toolName: 'sendMessage', expected: 'agent-postless', latencyMs: 4000 }
    )
    expect(metrics.invalidCalls).toBe(0)
    expect(metrics.firstAttemptSuccess).toBe(false)
    expect(metrics.completed).toBe(false)
    expect(metrics.attemptsToSuccess).toBe(0)
  })

  it('ignores tool calls that are not the surface under test', () => {
    const metrics = extractTrialMetrics(
      [
        toolCall('t0', 'listAgents'),
        toolUpdate('t0', 'listAgents', { status: 'completed' }),
        toolCall('t1', 'post'),
        toolUpdate('t1', 'post', { rawInput: { conversation: { kind: 'channel', channel: 'C' }, message: 'x' } }),
        toolUpdate('t1', 'post', { status: 'completed' })
      ],
      { toolName: 'post', expected: 'channel-bare', latencyMs: 3000 }
    )
    expect(metrics.toolCalls).toBe(1)
    // Arm B's raw input is the façade shape, so it classifies through the same
    // vocabulary only after compilation — an uncompiled façade call is not a form.
    expect(metrics.attempts[0]!.tool).toBe('post')
  })

  it('sums tokens across every turn of the trial', () => {
    const metrics = extractTrialMetrics(
      [
        { type: 'turn.completed', data: { usage: { totalTokens: 500 } } },
        { type: 'turn.completed', data: { usage: { totalTokens: 700 } } }
      ],
      { toolName: 'sendMessage', expected: 'channel-bare', latencyMs: 1 }
    )
    expect(metrics.totalTokens).toBe(1200)
  })
})

describe('the reduced scenario matrix', () => {
  it('is four scenarios, each with a known-correct product form', () => {
    expect(AB_SCENARIOS).toHaveLength(4)
    expect(AB_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      'agent-channel',
      'channel-bare',
      'agent-postless',
      'parent-session'
    ])
    for (const scenario of AB_SCENARIOS) expect(scenario.expected).not.toBe('unclassifiable')
  })

  it('never names a tool, a field or a form in the task text', () => {
    // Naming them would test instruction-following instead of the surface.
    const ids = { peerAgentId: 'PEER', channel: 'CHAN', humanUserId: 'UHUMAN' }
    const banned = ['sendMessage', 'post(', 'toAgent', 'toUser', 'sessionId', 'conversation', 'visibility', 'address']
    for (const scenario of AB_SCENARIOS) {
      const text = scenario.instruction(ids)
      for (const token of banned) {
        expect(text, `${scenario.id} leaks "${token}"`).not.toContain(token)
      }
    }
  })
})
