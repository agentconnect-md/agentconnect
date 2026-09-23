// The Routing editor's draft model: transitions, dirty state, validation, Score ordering and gaps, and Retry.

import { describe, expect, it } from 'vitest'
import type { DecisionQuestion } from '@agentconnect.md/protocol/decision'
import type { DecisionRoutingDetail } from '@agentconnect.md/protocol/decision-api'
import {
  INITIAL_ROUTING_STATE,
  displayOrder,
  ruleNumbers,
  draftFromDetail,
  newRule,
  routingCanSave,
  routingDirty,
  routingDraftIssues,
  routingPendingSync,
  routingReducer,
  scoreGaps,
  toSave,
  type RoutingEditorState,
  type RoutingEvent
} from './routing-draft'

const choice: DecisionQuestion = {
  type: 'choice',
  instructions: 'Topic?',
  criteria: { billing: 'Money', technical: 'Code', sales: 'Quotes' }
}
const score: DecisionQuestion = { type: 'score', instructions: 'Urgency?', criteria: ['a', 'b', 'c', 'd'] }
const detail = (over: Partial<DecisionRoutingDetail> = {}): DecisionRoutingDetail => ({
  botId: 'bot',
  config: {
    enabled: true,
    decisionId: 'd1',
    rules: [
      { id: 'r1', when: { type: 'choice', thresholds: { billing: 0.3 } }, action: { type: 'agent', agentId: 'a' } }
    ],
    otherwise: { type: 'skip' }
  },
  channelIds: ['C1', 'C2'],
  readiness: { status: 'ready' },
  evaluationHost: null,
  channels: [],
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over
})
const run = (events: RoutingEvent[], state: RoutingEditorState = INITIAL_ROUTING_STATE) =>
  events.reduce(routingReducer, state)
const members = new Set(['a', 'b'])

describe('routing draft', () => {
  it('starts a new configuration as an unsaved draft whose Otherwise is Do not activate', () => {
    const state = run([{ type: 'LOADED', detail: detail({ config: null, channelIds: [] }) }])
    expect(state.draft).toEqual({
      enabled: true,
      decisionId: null,
      rules: [],
      otherwise: 'skip',
      channelIds: [],
      removals: {}
    })
    expect(routingDirty(state)).toBe(true)
    expect(routingDraftIssues(state.draft!, null, { savedChannelIds: [], memberIds: members })).toEqual([
      { path: ['decisionId'], code: 'decision_required' }
    ])
  })

  it('tracks dirty edits, restores the saved draft on Cancel, and becomes saved on success', () => {
    const loaded = run([{ type: 'LOADED', detail: detail() }])
    expect(routingDirty(loaded)).toBe(false)
    const edited = run([{ type: 'EDIT', patch: { otherwise: 'default_agent' } }], loaded)
    expect(routingDirty(edited)).toBe(true)
    expect(routingCanSave(edited, [], true)).toBe(true)
    expect(routingCanSave(edited, [], false)).toBe(false)
    expect(run([{ type: 'CANCEL' }], edited).draft).toEqual(loaded.draft)
    const body = toSave(edited.draft!, ['C1', 'C2'])!
    const saving = run([{ type: 'SAVE_START', body }], edited)
    expect(saving.phase).toBe('saving')
    expect(routingCanSave(saving, [], true)).toBe(false)
    const saved = run(
      [{ type: 'SAVE_OK', detail: detail({ config: { ...detail().config!, otherwise: { type: 'default_agent' } } }) }],
      saving
    )
    expect(saved.phase).toBe('saved')
    expect(routingDirty(saved)).toBe(false)
    expect(run([{ type: 'EDIT', patch: { enabled: false } }], saved).phase).toBe('editing')
  })

  it('keeps the draft on a failed save and retries the same body', () => {
    const loaded = run([
      { type: 'LOADED', detail: detail() },
      { type: 'EDIT', patch: { enabled: false } }
    ])
    const body = toSave(loaded.draft!, ['C1', 'C2'])!
    const failed = run(
      [
        { type: 'SAVE_START', body },
        { type: 'SAVE_FAIL', error: new Error('boom') }
      ],
      loaded
    )
    expect(failed).toMatchObject({ phase: 'save_error', lastAttempt: body, draft: loaded.draft })
    const retried = run([{ type: 'RETRY' }], failed)
    expect(retried).toMatchObject({ phase: 'saving', lastAttempt: body })
    // A reload during editing never replaces the draft.
    expect(run([{ type: 'LOADED', detail: detail() }], failed).draft).toEqual(loaded.draft)
  })

  it('opens replacement settings for a removed saved channel and requires its trigger', () => {
    const loaded = run([{ type: 'LOADED', detail: detail() }])
    const removed = run([{ type: 'TOGGLE_CHANNEL', channelId: 'C2' }], loaded)
    expect(removed.draft!.removals).toEqual({ C2: { trigger: null } })
    expect(toSave(removed.draft!, ['C1', 'C2'])).toBeNull()
    expect(routingDraftIssues(removed.draft!, choice, { savedChannelIds: ['C1', 'C2'], memberIds: members })).toEqual([
      { path: ['removals', 'C2'], code: 'trigger_required' }
    ])
    const replaced = run(
      [{ type: 'SET_REMOVAL', channelId: 'C2', removal: { trigger: 'mention', agentId: 'b' } }],
      removed
    )
    expect(toSave(replaced.draft!, ['C1', 'C2'])!.removals).toEqual([
      { channelId: 'C2', settings: { trigger: 'mention' }, agentId: 'b' }
    ])
    const restored = run([{ type: 'TOGGLE_CHANNEL', channelId: 'C2' }], replaced)
    expect(restored.draft!.removals).toEqual({})
    const added = run([{ type: 'TOGGLE_CHANNEL', channelId: 'C3' }], loaded)
    expect(added.draft!.channelIds).toEqual(['C1', 'C2', 'C3'])
    expect(added.draft!.removals).toEqual({})
  })

  it('reports a missing or removed target and marks both conflicting rows', () => {
    const state = run([{ type: 'LOADED', detail: detail() }])
    const rules = [
      {
        id: 'x',
        when: { type: 'choice' as const, thresholds: { billing: 0.3 } },
        action: { type: 'agent' as const, agentId: null }
      },
      {
        id: 'y',
        when: { type: 'choice' as const, thresholds: { billing: 0.5 } },
        action: { type: 'agent' as const, agentId: 'gone' }
      }
    ]
    const issues = routingDraftIssues({ ...state.draft!, rules }, choice, { savedChannelIds: [], memberIds: members })
    expect(issues).toEqual(
      expect.arrayContaining([
        { path: ['rules', 0, 'action'], code: 'target_required' },
        { path: ['rules', 1, 'action'], code: 'target_removed' },
        expect.objectContaining({ path: ['rules', 0, 'when'], message: expect.any(String) }),
        expect.objectContaining({ path: ['rules', 1, 'when'], message: expect.any(String) })
      ])
    )
    expect(routingCanSave({ ...state, draft: { ...state.draft!, rules } }, issues, true)).toBe(false)
  })

  it('selecting another Decision keeps the rules for revalidation', () => {
    const state = run([
      { type: 'LOADED', detail: detail() },
      { type: 'SELECT_DECISION', decisionId: 'score' }
    ])
    expect(state.draft!.decisionId).toBe('score')
    expect(state.draft!.rules).toEqual(draftFromDetail(detail()).rules)
    expect(
      routingDraftIssues(state.draft!, score, { savedChannelIds: ['C1', 'C2'], memberIds: members })
    ).not.toHaveLength(0)
  })

  it('sorts Score rows by lower bound, lists gaps, and seeds new rules from what is unassigned', () => {
    const rules = [
      { id: 'hi', when: { type: 'score' as const, min: 2.5, max: 3 }, action: { type: 'skip' as const } },
      { id: 'lo', when: { type: 'score' as const, min: 0, max: 1 }, action: { type: 'skip' as const } }
    ]
    expect(displayOrder(score, rules)).toEqual([1, 0])
    expect(displayOrder(choice, rules)).toEqual([0, 1])
    expect([...ruleNumbers(score, rules)]).toEqual([
      ['lo', 1],
      ['hi', 2]
    ])
    expect(scoreGaps(score, rules)).toEqual([{ min: 1, max: 2.5 }])
    expect(newRule(score, rules).when).toEqual({ type: 'score', min: 1, max: 2.5 })
    const used = [
      { id: 'b', when: { type: 'choice' as const, thresholds: { billing: 0.3 } }, action: { type: 'skip' as const } }
    ]
    expect(newRule(choice, used).when).toEqual({ type: 'choice', thresholds: { technical: 0.5 } })
    const boolean: DecisionQuestion = { type: 'boolean', instructions: 'Y?', criteria: { true: 'y', false: 'n' } }
    expect(
      newRule(boolean, [{ id: 'y', when: { type: 'boolean', values: [true] }, action: { type: 'skip' } }]).when
    ).toEqual({
      type: 'boolean',
      values: [false]
    })
    expect(newRule(choice, []).action).toEqual({ type: 'agent', agentId: null })
  })

  it('distinguishes saved from applied', () => {
    expect(
      routingPendingSync(run([{ type: 'LOADED', detail: detail({ readiness: { status: 'pending_sync' } }) }]))
    ).toBe(true)
    expect(routingPendingSync(run([{ type: 'LOADED', detail: detail() }]))).toBe(false)
  })
})
