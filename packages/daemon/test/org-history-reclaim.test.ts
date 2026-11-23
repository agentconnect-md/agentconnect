// The reclaim switch, the window rule and the re-confirmation match (org-session-policy.md, Reclaim).
import { describe, expect, it } from 'vitest'
import {
  OrgHistoryRetentionState,
  confirmationAnswers,
  confirms,
  reclaimWindowMs,
  sameVerdict,
  type OrgRetentionVerdict
} from '../src/daemon/org-history-retention.js'

const DAY = 86_400_000

const policy = (days: number | null, revision = 1): OrgRetentionVerdict => ({
  kind: 'policy',
  windowMs: days === null ? null : days * DAY,
  revision
})

describe('the reclaim switch', () => {
  it('is off until a snapshot turns it on, and a snapshot without it turns it off', () => {
    const state = new OrgHistoryRetentionState()
    expect(state.reclaiming()).toBe(false)
    state.applySnapshot({ orgIds: [], entries: [] })
    expect(state.reclaiming()).toBe(false)
    state.applySnapshot({ orgIds: [], entries: [], reclaim: true })
    expect(state.reclaiming()).toBe(true)
    state.applySnapshot({ orgIds: [], entries: [], reclaim: false })
    expect(state.reclaiming()).toBe(false)
  })

  it('survives a dropped link and a register/ok without a snapshot, while every org pauses', () => {
    const state = new OrgHistoryRetentionState()
    state.applySnapshot({ orgIds: ['org-a'], entries: [], reclaim: true })
    state.linkLost()
    expect(state.reclaiming()).toBe(true)
    expect(state.verdict('org-a')).toEqual({ kind: 'paused', reason: 'unsynced' })
    state.applySnapshot(undefined)
    expect(state.reclaiming()).toBe(true)
    expect(state.verdict('org-a')).toEqual({ kind: 'paused', reason: 'unsynced' })
  })
})

describe('reclaimWindowMs', () => {
  it('replaces the daemon-wide window with the org window on a pool member, unlimited included', () => {
    expect(reclaimWindowMs(policy(7), 90 * DAY, true)).toBe(7 * DAY)
    expect(reclaimWindowMs(policy(120), 90 * DAY, true)).toBe(120 * DAY)
    expect(reclaimWindowMs(policy(null), 90 * DAY, true)).toBeNull()
  })

  it('takes the shorter of the org window and the local setting on a self-hosted daemon', () => {
    expect(reclaimWindowMs(policy(7), 90 * DAY, false)).toBe(7 * DAY)
    expect(reclaimWindowMs(policy(120), 90 * DAY, false)).toBe(90 * DAY)
    expect(reclaimWindowMs(policy(null), 90 * DAY, false)).toBe(90 * DAY)
    expect(reclaimWindowMs(policy(7), null, false)).toBe(7 * DAY)
    expect(reclaimWindowMs(policy(null), null, false)).toBeNull()
  })

  it('keeps today’s rule without a policy and deletes nothing for a paused org', () => {
    for (const pool of [true, false]) {
      expect(reclaimWindowMs({ kind: 'missing' }, 90 * DAY, pool)).toBe(90 * DAY)
      expect(reclaimWindowMs({ kind: 'paused', reason: 'stale' }, 90 * DAY, pool)).toBe('paused')
    }
  })
})

describe('re-confirmation', () => {
  const answers = confirmationAnswers({
    entries: [
      { orgId: 'org-a', revision: 3, historyRetentionDays: 7 },
      { orgId: 'org-b', revision: 4, historyRetentionDays: 30 }
    ],
    noPolicy: ['org-c'],
    denied: ['org-d']
  })

  it('matches only the same revision and window, or still no policy', () => {
    expect(confirms(policy(7, 3), answers.get('org-a'))).toBe(true)
    // A newer revision, even one that would also delete, is not what the pass judged.
    expect(confirms(policy(7, 3), answers.get('org-b'))).toBe(false)
    expect(confirms(policy(30, 3), { kind: 'policy', revision: 3, historyRetentionDays: 7 })).toBe(false)
    expect(confirms({ kind: 'missing' }, answers.get('org-c'))).toBe(true)
    expect(confirms({ kind: 'missing' }, answers.get('org-a'))).toBe(false)
    expect(confirms(policy(7, 3), answers.get('org-c'))).toBe(false)
  })

  it('confirms nothing for a denied, unanswered or paused org', () => {
    expect(confirms(policy(7), answers.get('org-d'))).toBe(false)
    expect(confirms({ kind: 'missing' }, answers.get('org-d'))).toBe(false)
    expect(confirms(policy(7), undefined)).toBe(false)
    expect(confirms({ kind: 'paused', reason: 'unknown' }, { kind: 'none' })).toBe(false)
  })

  it('folds a newer answer into the table, as a push would', () => {
    const state = new OrgHistoryRetentionState()
    state.applySnapshot({ orgIds: ['org-a'], entries: [{ orgId: 'org-a', revision: 3, historyRetentionDays: 7 }] })
    state.applyConfirmation('org-a', { kind: 'policy', revision: 4, historyRetentionDays: null })
    expect(state.verdict('org-a')).toEqual({ kind: 'policy', windowMs: null, revision: 4 })
    // An older answer changes nothing.
    state.applyConfirmation('org-a', { kind: 'policy', revision: 2, historyRetentionDays: 1 })
    expect(state.verdict('org-a')).toEqual({ kind: 'policy', windowMs: null, revision: 4 })
  })

  it('pauses an org whose seen policy the answer omits, and learns a policy for an org that had none', () => {
    const state = new OrgHistoryRetentionState()
    state.applySnapshot({
      orgIds: ['org-a', 'org-b'],
      entries: [{ orgId: 'org-a', revision: 1, historyRetentionDays: 7 }]
    })
    state.applyConfirmation('org-a', { kind: 'none' })
    expect(state.verdict('org-a')).toEqual({ kind: 'paused', reason: 'stale' })
    state.applyConfirmation('org-b', { kind: 'policy', revision: 1, historyRetentionDays: null })
    expect(state.verdict('org-b')).toEqual({ kind: 'policy', windowMs: null, revision: 1 })
    state.applyConfirmation('org-b', { kind: 'denied' })
    expect(state.verdict('org-b')).toEqual({ kind: 'policy', windowMs: null, revision: 1 })
  })

  it('compares two readings by kind, revision and window, never treating a paused one as the same', () => {
    expect(sameVerdict(policy(7, 2), policy(7, 2))).toBe(true)
    expect(sameVerdict(policy(7, 2), policy(7, 3))).toBe(false)
    expect(sameVerdict({ kind: 'missing' }, { kind: 'missing' })).toBe(true)
    expect(sameVerdict({ kind: 'missing' }, policy(7))).toBe(false)
    expect(sameVerdict({ kind: 'paused', reason: 'stale' }, { kind: 'paused', reason: 'stale' })).toBe(false)
  })
})
