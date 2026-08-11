import { describe, expect, it } from 'vitest'
import {
  AB_SCENARIOS,
  THREAD_COUNT_SCENARIO,
  classifySendForm,
  extractTrialMetrics,
  isMessagingToolName,
  judgeThreadCount,
  type ThreadCountEffect
} from '../games/tool-surface-ab.js'

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
    // The rule covers scenario 5's kickoff too: the in-thread game must be
    // won by the STANDING guidance alone, never by the task text steering
    // the model toward or away from a tool.
    const ids = { peerAgentId: 'PEER', channel: 'CHAN', humanUserId: 'UHUMAN' }
    const banned = ['sendMessage', 'post(', 'toAgent', 'toUser', 'sessionId', 'conversation', 'visibility', 'address']
    const texts = [
      ...AB_SCENARIOS.map((scenario) => [scenario.id, scenario.instruction(ids)] as const),
      [THREAD_COUNT_SCENARIO.id, THREAD_COUNT_SCENARIO.instruction({ first: '<@B1>', second: '<@B2>' })] as const
    ]
    for (const [id, text] of texts) {
      for (const token of banned) {
        expect(text, `${id} leaks "${token}"`).not.toContain(token)
      }
    }
  })

  it('includes the in-thread turn-taking scenario with a small stop target', () => {
    expect(THREAD_COUNT_SCENARIO.id).toBe('in-thread-count')
    expect(THREAD_COUNT_SCENARIO.target).toBe(6)
    const text = THREAD_COUNT_SCENARIO.instruction({ first: '<@B1>', second: '<@B2>' })
    // The kickoff @-mentions both participants and states the stop target.
    expect(text).toContain('<@B1>')
    expect(text).toContain('<@B2>')
    expect(text).toContain('6')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 5's judge. The incident it gates (#801 → revert #861): a prompt
// change validated only against parent-session made an agent route in-thread
// turns through `sendMessage`, posting meta-narration with skipped/duplicated
// numbers. The judge must score that trace FAIL from the daemon's records, and
// a clean reply-only trace PASS.
// ─────────────────────────────────────────────────────────────────────────────

const RUNNER = 'agent-runner'
const PEER = 'agent-peer'
const CHANNEL = 'C-PLAZA'
const THREAD = 'T-ROOT'

function reply(sequence: number, agentId: string, text: string, status = 'delivered'): ThreadCountEffect {
  return { sequence, kind: 'reply', status, channel: CHANNEL, thread: THREAD, agentId, text }
}

/** A completed messaging-tool call as the ACP stream records it. */
function messagingCall(agentId: string, id: string, name: string, viaMeta = false) {
  const update = viaMeta
    ? { sessionUpdate: 'tool_call', toolCallId: id, title: 'Send a message', _meta: { claudeCode: { toolName: name } } }
    : { sessionUpdate: 'tool_call', toolCallId: id, title: name }
  return [
    { type: 'acp.update', agentId, data: { update } },
    {
      type: 'acp.update',
      agentId,
      data: { update: { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' } }
    }
  ]
}

function turns(agentId: string, count: number) {
  return Array.from({ length: count }, () => ({ type: 'turn.completed', agentId, data: {} }))
}

/** Alternating bare-number replies 1..target — the clean game. */
function cleanReplies(target: number): ThreadCountEffect[] {
  return Array.from({ length: target }, (_, index) =>
    reply(index + 1, index % 2 === 0 ? RUNNER : PEER, String(index + 1))
  )
}

describe('messaging-tool name matcher', () => {
  it('matches every messaging surface a session might carry, and nothing else', () => {
    expect(isMessagingToolName('sendMessage')).toBe(true)
    expect(isMessagingToolName('mcp__agentconnect__sendMessage')).toBe(true)
    expect(isMessagingToolName('SendMessage')).toBe(true) // Claude Code built-in
    expect(isMessagingToolName('post')).toBe(true)
    expect(isMessagingToolName('mcp__agentconnect__post')).toBe(true)
    // The daemon supports the dotted ACP identity too (daemon.ts FQN matching):
    // a call under that spelling must not slip past the hard rule.
    expect(isMessagingToolName('mcp.agentconnect.post')).toBe(true)
    // ...and adapters may suffix an opaque invocation id to the flattened FQN
    // (daemon.ts containsBuiltinToolFqn) — the suffixed spellings must match.
    expect(isMessagingToolName('mcp__agentconnect__post-42')).toBe(true)
    expect(isMessagingToolName('mcp.agentconnect.post-42')).toBe(true)
    expect(isMessagingToolName('mcp__agentconnect__sendMessage-42')).toBe(true)
    expect(isMessagingToolName('listAgents')).toBe(false)
    expect(isMessagingToolName('setSessionTitle')).toBe(false)
    expect(isMessagingToolName('compost')).toBe(false)
    expect(isMessagingToolName('postpone')).toBe(false)
  })
})

describe('in-thread turn-taking judge — hard rules', () => {
  it('passes a clean reply-only game', () => {
    const verdict = judgeThreadCount({
      target: 6,
      participants: [RUNNER, PEER],
      channel: CHANNEL,
      thread: THREAD,
      effects: cleanReplies(6),
      events: [...turns(RUNNER, 3), ...turns(PEER, 3)]
    })
    expect(verdict.pass).toBe(true)
    expect(verdict.failures).toEqual([])
    expect(verdict.reached).toBe(6)
    expect(verdict.numbersPosted).toEqual([1, 2, 3, 4, 5, 6])
    expect(verdict.messagingToolCalls).toEqual([])
    expect(verdict.lostMessages).toBe(0)
    expect(verdict.duplicates).toBe(0)
    expect(verdict.skips).toBe(0)
    expect(verdict.bareNumberReplies).toBe(6)
    expect(verdict.metaNarrationReplies).toBe(0)
    expect(verdict.turnsPerNumber).toBe(1)
  })

  it('fails the #801 trace: a sendMessage "handoff" during the game', () => {
    // The recorded live regression: the agent posts meta-narration in-thread
    // and routes the actual number through the messaging tool.
    const effects = [
      reply(1, RUNNER, '1'),
      reply(2, PEER, '2'),
      reply(3, RUNNER, '3'),
      reply(4, PEER, '4'),
      reply(5, RUNNER, 'Handing off for 5 / 已把 5 交给 test2'),
      reply(6, PEER, '5'),
      reply(7, RUNNER, '6')
    ]
    const verdict = judgeThreadCount({
      target: 6,
      participants: [RUNNER, PEER],
      channel: CHANNEL,
      thread: THREAD,
      effects,
      events: [...messagingCall(RUNNER, 't1', 'mcp__agentconnect__sendMessage'), ...turns(RUNNER, 4), ...turns(PEER, 3)]
    })
    expect(verdict.pass).toBe(false)
    expect(verdict.failures.some((failure) => failure.includes('mcp__agentconnect__sendMessage'))).toBe(true)
    expect(verdict.messagingToolCalls).toEqual([
      { agentId: RUNNER, tool: 'mcp__agentconnect__sendMessage', failed: false }
    ])
    // The meta-narration is measured even though the tool call already fails it.
    expect(verdict.metaNarrationReplies).toBe(1)
  })

  it('fails on the runtime built-in SendMessage too (the #800 collision, via _meta)', () => {
    const verdict = judgeThreadCount({
      target: 6,
      participants: [RUNNER, PEER],
      channel: CHANNEL,
      thread: THREAD,
      effects: cleanReplies(6),
      events: [...messagingCall(PEER, 't9', 'SendMessage', true), ...turns(RUNNER, 3), ...turns(PEER, 3)]
    })
    expect(verdict.pass).toBe(false)
    expect(verdict.messagingToolCalls).toEqual([{ agentId: PEER, tool: 'SendMessage', failed: false }])
  })

  it("fails on arm B's `post` façade the same way — the rule is surface-neutral", () => {
    const verdict = judgeThreadCount({
      target: 6,
      participants: [RUNNER, PEER],
      channel: CHANNEL,
      thread: THREAD,
      effects: cleanReplies(6),
      events: [...messagingCall(RUNNER, 't2', 'mcp__agentconnect__post'), ...turns(RUNNER, 3), ...turns(PEER, 3)]
    })
    expect(verdict.pass).toBe(false)
    expect(verdict.messagingToolCalls[0]!.tool).toBe('mcp__agentconnect__post')
  })

  it('counts even a REFUSED messaging call — the reflex is the failure, not the delivery', () => {
    const events = [
      {
        type: 'acp.update',
        agentId: RUNNER,
        data: { update: { sessionUpdate: 'tool_call', toolCallId: 'tf', title: 'sendMessage' } }
      },
      {
        type: 'acp.update',
        agentId: RUNNER,
        data: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'tf', status: 'failed', content: 'refused' } }
      },
      ...turns(RUNNER, 3),
      ...turns(PEER, 3)
    ]
    const verdict = judgeThreadCount({
      target: 6,
      participants: [RUNNER, PEER],
      channel: CHANNEL,
      thread: THREAD,
      effects: cleanReplies(6),
      events
    })
    expect(verdict.pass).toBe(false)
    expect(verdict.messagingToolCalls).toEqual([{ agentId: RUNNER, tool: 'sendMessage', failed: true }])
  })

  it('ignores non-messaging tools and non-participant events', () => {
    const events = [
      ...messagingCall(RUNNER, 't3', 'listAgents'),
      ...messagingCall('someone-else', 't4', 'sendMessage'),
      ...turns(RUNNER, 3),
      ...turns(PEER, 3)
    ]
    const verdict = judgeThreadCount({
      target: 6,
      participants: [RUNNER, PEER],
      channel: CHANNEL,
      thread: THREAD,
      effects: cleanReplies(6),
      events
    })
    expect(verdict.pass).toBe(true)
    expect(verdict.messagingToolCalls).toEqual([])
  })

  it('fails when the count never reaches the target', () => {
    const verdict = judgeThreadCount({
      target: 6,
      participants: [RUNNER, PEER],
      channel: CHANNEL,
      thread: THREAD,
      effects: cleanReplies(4),
      events: [...turns(RUNNER, 2), ...turns(PEER, 2)]
    })
    expect(verdict.pass).toBe(false)
    expect(verdict.reached).toBe(4)
    expect(verdict.failures[0]).toContain('reached 4 of 6')
  })

  it('fails on the dotted and invocation-id-suffixed ACP identities of the façade too', () => {
    // Adapters legitimately spell the same tool `mcp.agentconnect.post` or
    // suffix an opaque invocation id (`mcp__agentconnect__post-42`); every
    // spelling must fail the hard rule identically.
    for (const spelling of ['mcp.agentconnect.post', 'mcp__agentconnect__post-42', 'mcp.agentconnect.post-42']) {
      const verdict = judgeThreadCount({
        target: 6,
        participants: [RUNNER, PEER],
        channel: CHANNEL,
        thread: THREAD,
        effects: cleanReplies(6),
        events: [...messagingCall(PEER, 't8', spelling), ...turns(RUNNER, 3), ...turns(PEER, 3)]
      })
      expect(verdict.pass, `${spelling} must fail the hard rule`).toBe(false)
      expect(verdict.messagingToolCalls[0]!.tool).toBe(spelling)
    }
  })

  it('does not count numbers posted OUTSIDE the game thread toward the count', () => {
    // A reply effect with no `thread` (or a different one) is a channel-root
    // post opening a different conversation — exactly where a messaging-tool
    // detour would land the numbers. The count must not be satisfiable there.
    const offThread = cleanReplies(6).map((effect, index) => (index >= 3 ? { ...effect, thread: undefined } : effect))
    const verdict = judgeThreadCount({
      target: 6,
      participants: [RUNNER, PEER],
      channel: CHANNEL,
      thread: THREAD,
      effects: offThread,
      events: [...turns(RUNNER, 3), ...turns(PEER, 3)]
    })
    expect(verdict.pass).toBe(false)
    expect(verdict.reached).toBe(3)
    expect(verdict.numbersPosted).toEqual([1, 2, 3])
  })

  it('fails when a participant reply was rejected (a lost message)', () => {
    const effects = [...cleanReplies(6), reply(7, PEER, 'and this one never landed', 'rejected')]
    const verdict = judgeThreadCount({
      target: 6,
      participants: [RUNNER, PEER],
      channel: CHANNEL,
      thread: THREAD,
      effects,
      events: [...turns(RUNNER, 3), ...turns(PEER, 4)]
    })
    expect(verdict.pass).toBe(false)
    expect(verdict.lostMessages).toBe(1)
  })
})

describe('in-thread turn-taking judge — soft metrics never fail a trial', () => {
  it('reports duplicates and skips while the trial still passes', () => {
    // 4 was skipped, 2 was duplicated, and 6 appeared: hard criteria hold.
    const effects = [
      reply(1, RUNNER, '1'),
      reply(2, PEER, '2'),
      reply(3, RUNNER, '2'),
      reply(4, PEER, '3'),
      reply(5, RUNNER, '5'),
      reply(6, PEER, '6')
    ]
    const verdict = judgeThreadCount({
      target: 6,
      participants: [RUNNER, PEER],
      channel: CHANNEL,
      thread: THREAD,
      effects,
      events: [...turns(RUNNER, 3), ...turns(PEER, 3)]
    })
    expect(verdict.pass).toBe(true)
    expect(verdict.duplicates).toBe(1)
    expect(verdict.skips).toBe(1)
  })

  it('measures meta-narration and overshoot without failing on them', () => {
    const effects = [
      ...cleanReplies(5),
      reply(6, PEER, 'And now **6** — the count is complete!'),
      reply(7, RUNNER, '7')
    ]
    const verdict = judgeThreadCount({
      target: 6,
      participants: [RUNNER, PEER],
      channel: CHANNEL,
      thread: THREAD,
      effects,
      events: [...turns(RUNNER, 4), ...turns(PEER, 3)]
    })
    expect(verdict.pass).toBe(true)
    expect(verdict.metaNarrationReplies).toBe(1)
    expect(verdict.overshoot).toBe(1)
    expect(verdict.bareNumberReplies).toBe(6) // 1..5 plus the bare "7"
    expect(verdict.meanReplyChars).toBeGreaterThan(1)
    expect(verdict.turnsPerNumber).toBeCloseTo(7 / 6, 2)
  })

  it('does not count digits inside mention tokens as count signal', () => {
    const effects = [...cleanReplies(6), reply(7, PEER, '<@W123456> the count is complete')]
    const verdict = judgeThreadCount({
      target: 6,
      participants: [RUNNER, PEER],
      channel: CHANNEL,
      thread: THREAD,
      effects,
      events: [...turns(RUNNER, 3), ...turns(PEER, 4)]
    })
    expect(verdict.pass).toBe(true)
    expect(verdict.numbersPosted).toEqual([1, 2, 3, 4, 5, 6])
  })
})
