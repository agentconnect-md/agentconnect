import { describe, expect, it } from 'vitest'
import { PREVIEW_SENDER } from './decision-gate-preview.js'
import { PREVIEW_THREAD, routingNotApplied, routingSampleState } from './decision-routing-preview.js'

const sample = { history: [{ sender: 'U1', text: 'earlier' }], currentMessage: { text: 'now' } }

describe('routingSampleState', () => {
  it('addresses a new conversation with no mentions and an empty constraint', () => {
    const state = routingSampleState(sample, { type: 'new' }, { conversationName: 'support' })
    expect(state).toMatchObject({
      currentMessage: { id: 'preview-2', sender: { id: PREVIEW_SENDER }, text: 'now', threadId: null },
      history: [{ id: 'preview-1', sender: { id: 'U1' }, text: 'earlier', threadId: null }],
      conversation: { name: 'support' },
      addressing: { mentions: [], constraint: { eligibleAgentIds: [], participantAgentIds: [] } }
    })
  })

  it('names mentioned agents and splits participants from eligible recipients', () => {
    const state = routingSampleState(sample, { type: 'mention', agentIds: ['A', 'B'], participantAgentIds: ['B'] })
    expect(state.addressing).toEqual({
      mentions: ['A', 'B'],
      constraint: { eligibleAgentIds: ['A'], participantAgentIds: ['B'] }
    })
    expect((state.currentMessage as { threadId: unknown }).threadId).toBeNull()
  })

  it('places an established-thread sample in a thread without mentions', () => {
    const state = routingSampleState(sample, { type: 'thread', agentIds: ['A'], participantAgentIds: [] })
    expect(state.addressing).toEqual({ mentions: [], constraint: { eligibleAgentIds: ['A'], participantAgentIds: [] } })
    expect((state.currentMessage as { threadId: unknown }).threadId).toBe(PREVIEW_THREAD)
    expect((state.history as Array<{ threadId: unknown }>)[0]!.threadId).toBe(PREVIEW_THREAD)
  })
})

describe('routingNotApplied', () => {
  const ok = {
    channelOff: false,
    inScope: true,
    enabled: true,
    savedNeedsReview: false,
    draftIsSaved: false,
    unsupported: false
  }
  it('checks Off, then scope, pause, review, and support', () => {
    expect(routingNotApplied(ok)).toBeNull()
    expect(
      routingNotApplied({
        channelOff: true,
        inScope: false,
        enabled: false,
        savedNeedsReview: true,
        draftIsSaved: true,
        unsupported: true
      })
    ).toBe('off')
    expect(routingNotApplied({ ...ok, inScope: false, enabled: false, unsupported: true })).toBe('outside_scope')
    expect(routingNotApplied({ ...ok, enabled: false, savedNeedsReview: true, draftIsSaved: true })).toBe('paused')
    expect(routingNotApplied({ ...ok, savedNeedsReview: true, draftIsSaved: true, unsupported: true })).toBe(
      'needs_review'
    )
    // An edited draft is what repairs a stranded configuration, so it runs.
    expect(routingNotApplied({ ...ok, savedNeedsReview: true, draftIsSaved: false })).toBeNull()
    expect(routingNotApplied({ ...ok, unsupported: true })).toBe('unsupported')
  })
})
