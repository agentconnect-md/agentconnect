import { describe, expect, it } from 'vitest'
import {
  hookCoordinates,
  openReviewBatch,
  reviewSubjectLane,
  REVIEW_BATCH_MAX_COMMENTS,
  REVIEW_BATCH_MAX_WAIT_MS,
  REVIEW_BATCH_QUIET_MS,
  type HookQueueCandidate
} from '../src/codehost/hook-admission.js'
import {
  planRevisionAdmission,
  planRevisionAdmissionEffects,
  planReviewBatchCoalesce,
  reviewBatchSettleStep,
  selectReviewBatchLeader
} from '../src/codehost/queue-admission.js'
import type { HookDispatchContext } from '../src/github/hook-coords.js'
import type { QueueEntry } from '../src/daemon/turn-types.js'

const PROJECT = '4711'
const IID = 77
const KEY = `gitlab:${PROJECT}:merge_request:${IID}`
const HEAD_A = 'a'.repeat(40)
const HEAD_B = 'b'.repeat(40)

const hook = (deliveryKey: string, event: string, headSha: string, firedAt: string): HookDispatchContext => ({
  hookId: 'hook-1',
  agentId: 'agent-1',
  deliveryKey,
  firedAt,
  event,
  gitlab: {
    projectId: PROJECT,
    projectPath: 'example-group/example-project',
    target: { kind: 'merge_request', iid: IID, headSha, baseSha: '0'.repeat(40) }
  }
})

const entry = (deliveryKey: string, event: string, headSha: string, firedAt: string): QueueEntry =>
  ({
    agentId: 'agent-1',
    msg: { platform: 'gitlab', channel: KEY },
    inboxId: `inbox-${deliveryKey}`,
    hookContext: hook(deliveryKey, event, headSha, firedAt)
  }) as unknown as QueueEntry

const active = (entry: QueueEntry): HookQueueCandidate[] => [{ key: KEY, entry, state: 'active' }]

const coords = hookCoordinates('agent-1', { platform: 'gitlab', channel: KEY })

/** One note delivery already carrying the single-item batch the dispatch path opens for it. */
const noteEntry = (deliveryKey: string, text: string, firedAt: string, openedAt: number): QueueEntry => {
  const context = hook(deliveryKey, 'note:created', HEAD_A, firedAt)
  context.githubReply = {
    hookId: 'hook-1',
    provider: 'gitlab',
    subjectKind: 'merge_request',
    repo: PROJECT,
    number: IID
  }
  context.githubReviewBatch = openReviewBatch(context, coords, text, openedAt)
  return {
    agentId: 'agent-1',
    msg: { platform: 'gitlab', channel: KEY, text },
    inboxId: `inbox-${deliveryKey}`,
    hookContext: context
  } as unknown as QueueEntry
}

describe('planRevisionAdmission (gitlab)', () => {
  it('preempts a running merge_request:opened review with a newer pushed revision', () => {
    const opened = entry('opened', 'merge_request:opened', HEAD_A, '2026-08-19T01:24:44.000Z')
    const pushed = entry('pushed', 'merge_request:synchronize', HEAD_B, '2026-08-19T01:28:20.000Z')

    const plan = planRevisionAdmission(KEY, pushed, active(opened))

    expect(plan?.winner.entry).toBe(pushed)
    const effects = planRevisionAdmissionEffects(plan!, pushed)
    expect(effects.incomingWins).toBe(true)
    expect(effects.preemptableActiveLosers.map((candidate) => candidate.entry)).toEqual([opened])
    expect(effects.winnerLane).toBe(reviewSubjectLane(pushed.hookContext, coords))
  })

  it('supersedes a queued older revision of the same merge request', () => {
    const opened = entry('opened', 'merge_request:opened', HEAD_A, '2026-08-19T01:24:44.000Z')
    const queued = entry('queued', 'merge_request:synchronize', HEAD_A, '2026-08-19T01:25:00.000Z')
    const pushed = entry('pushed', 'merge_request:synchronize', HEAD_B, '2026-08-19T01:28:20.000Z')

    const plan = planRevisionAdmission(KEY, pushed, [
      { key: KEY, entry: opened, state: 'active' },
      { key: KEY, entry: queued, state: 'queued' }
    ])

    const effects = planRevisionAdmissionEffects(plan!, pushed)
    expect(effects.terminalLosers.map((candidate) => candidate.entry)).toEqual([queued])
    expect(effects.preemptableActiveLosers.map((candidate) => candidate.entry)).toEqual([opened])
  })

  it('waits out a running review of the same head instead of restarting it', () => {
    const opened = entry('opened', 'merge_request:opened', HEAD_A, '2026-08-19T01:24:44.000Z')
    const redelivered = entry('redelivered', 'merge_request:synchronize', HEAD_A, '2026-08-19T01:25:00.000Z')

    const plan = planRevisionAdmission(KEY, redelivered, active(opened))

    const effects = planRevisionAdmissionEffects(plan!, redelivered)
    expect(effects.activeLosers.map((candidate) => candidate.entry)).toEqual([opened])
    expect(effects.preemptableActiveLosers).toEqual([])
  })

  it('re-runs the current head an rc/hook-rerun names, preempting the review already generating it', () => {
    const opened = entry('opened', 'merge_request:opened', HEAD_A, '2026-08-19T01:24:44.000Z')
    const rerun = entry('rerun', 'merge_request:rerun', HEAD_A, '2026-08-19T01:26:00.000Z')

    const plan = planRevisionAdmission(KEY, rerun, active(opened))

    expect(plan?.winner.entry).toBe(rerun)
    const effects = planRevisionAdmissionEffects(plan!, rerun)
    expect(effects.incomingWins).toBe(true)
    expect(effects.preemptableActiveLosers.map((candidate) => candidate.entry)).toEqual([opened])
  })

  it('collapses a burst of reviewer re-requests for one head onto the newest delivery', () => {
    const first = entry('first', 'merge_request:review_requested', HEAD_A, '2026-08-19T17:55:42.765Z')
    const second = entry('second', 'merge_request:review_requested', HEAD_A, '2026-08-19T17:55:42.947Z')
    const third = entry('third', 'merge_request:rerun', HEAD_A, '2026-08-19T17:55:43.456Z')

    const plan = planRevisionAdmission(KEY, third, [
      { key: KEY, entry: first, state: 'active' },
      { key: KEY, entry: second, state: 'queued' }
    ])

    expect(plan?.winner.entry).toBe(third)
    const effects = planRevisionAdmissionEffects(plan!, third)
    expect(effects.terminalLosers.map((candidate) => candidate.entry)).toEqual([second])
    expect(effects.preemptableActiveLosers.map((candidate) => candidate.entry)).toEqual([first])
  })

  it('leaves the head under review alone when a re-run names a stale one', () => {
    const pushed = entry('pushed', 'merge_request:synchronize', HEAD_B, '2026-08-19T01:28:20.000Z')
    const rerun = entry('rerun', 'merge_request:rerun', HEAD_A, '2026-08-19T01:29:00.000Z')

    const plan = planRevisionAdmission(KEY, rerun, active(pushed))

    expect(plan?.winner.entry).toBe(rerun)
    expect(plan?.superseded).toEqual([])
  })

  it('never contests across merge requests, and a note opens no revision generation', () => {
    const other = entry('other', 'merge_request:synchronize', HEAD_A, '2026-08-19T01:24:44.000Z')
    other.hookContext!.gitlab!.target = { kind: 'merge_request', iid: IID + 1, headSha: HEAD_A }
    const pushed = entry('pushed', 'merge_request:synchronize', HEAD_B, '2026-08-19T01:28:20.000Z')

    expect(planRevisionAdmission(KEY, pushed, active(other))?.superseded).toEqual([])
    expect(
      planRevisionAdmission(KEY, noteEntry('note', 'please fix', '2026-08-19T01:30:00.000Z', 0), [])
    ).toBeUndefined()
  })
})

describe('gitlab note batching', () => {
  it('folds a second note on the same merge request into the open batch', () => {
    const leader = noteEntry('n1', 'first note', '2026-08-19T01:24:44.000Z', 1_000)
    const follower = noteEntry('n2', 'second note', '2026-08-19T01:24:46.000Z', 3_000)

    expect(selectReviewBatchLeader(follower, active(leader))).toBe(leader)
    const plan = planReviewBatchCoalesce(leader, follower, 3_000)
    expect(plan?.itemKey).toBe('n2')
    expect(plan?.nextHook.githubReviewBatch?.items.map((item) => item.text)).toEqual(['first note', 'second note'])
    expect(plan?.nextHook.githubReviewBatch?.updatedAt).toBe(3_000)
  })

  it('folds no redelivery of a note already in the batch', () => {
    const leader = noteEntry('n1', 'first note', '2026-08-19T01:24:44.000Z', 1_000)
    const redelivered = noteEntry('n1', 'first note', '2026-08-19T01:24:44.000Z', 3_000)

    expect(planReviewBatchCoalesce(leader, redelivered, 3_000)).toBeUndefined()
  })

  it('batches no note on an issue, and no note across merge requests', () => {
    const leader = noteEntry('n1', 'first note', '2026-08-19T01:24:44.000Z', 1_000)
    const issueNote = noteEntry('n2', 'issue note', '2026-08-19T01:24:46.000Z', 3_000)
    issueNote.hookContext!.gitlab!.target = { kind: 'issue', iid: IID }

    expect(selectReviewBatchLeader(issueNote, active(leader))).toBeUndefined()
    expect(issueNote.hookContext!.githubReviewBatch).toBeDefined()

    const otherMr = noteEntry('n3', 'other note', '2026-08-19T01:24:47.000Z', 3_000)
    otherMr.hookContext!.gitlab!.target = { kind: 'merge_request', iid: IID + 1, headSha: HEAD_A }
    expect(selectReviewBatchLeader(otherMr, active(leader))).toBeUndefined()
  })

  it('waits for the quiet window, then seals with a GitLab batch prompt', () => {
    const leader = noteEntry('n1', 'first note', '2026-08-19T01:24:44.000Z', 1_000)
    const follower = noteEntry('n2', 'second note', '2026-08-19T01:24:46.000Z', 3_000)
    leader.hookContext = planReviewBatchCoalesce(leader, follower, 3_000)!.nextHook

    const waiting = reviewBatchSettleStep(leader.hookContext, false, 4_000)
    expect(waiting).toEqual({ action: 'wait', delayMs: 3_000 + REVIEW_BATCH_QUIET_MS - 4_000 })

    const sealed = reviewBatchSettleStep(leader.hookContext, false, 3_000 + REVIEW_BATCH_QUIET_MS)
    expect(sealed.action).toBe('seal')
    if (sealed.action !== 'seal') throw new Error('expected a seal')
    expect(sealed.sealed.sealed).toBe(true)
    expect(sealed.promptText).toContain('GitLab merge-request note batch (2 notes')
    expect(sealed.promptText).toContain('first note')
    expect(sealed.promptText).toContain('second note')
    // The daemon publishes one ordinary note for a GitLab batch, so its reply target survives sealing.
    expect(sealed.clearReply).toBe(false)
  })

  it('seals at the max-wait ceiling even while notes keep arriving', () => {
    const leader = noteEntry('n1', 'first note', '2026-08-19T01:24:44.000Z', 0)
    const follower = noteEntry('n2', 'second note', '2026-08-19T01:24:46.000Z', REVIEW_BATCH_MAX_WAIT_MS - 1)
    leader.hookContext = planReviewBatchCoalesce(leader, follower, REVIEW_BATCH_MAX_WAIT_MS - 1)!.nextHook

    const step = reviewBatchSettleStep(leader.hookContext, false, REVIEW_BATCH_MAX_WAIT_MS)
    expect(step.action).toBe('seal')
  })

  it('admits no further note once the batch holds the maximum', () => {
    const leader = noteEntry('n1', 'first note', '2026-08-19T01:24:44.000Z', 1_000)
    const batch = leader.hookContext!.githubReviewBatch!
    batch.items = Array.from({ length: REVIEW_BATCH_MAX_COMMENTS }, (_unused, index) => ({
      deliveryKey: `n${index}`,
      firedAt: '2026-08-19T01:24:44.000Z',
      text: `note ${index}`
    }))
    const follower = noteEntry('overflow', 'one too many', '2026-08-19T01:24:46.000Z', 3_000)

    expect(selectReviewBatchLeader(follower, active(leader))).toBeUndefined()
    expect(planReviewBatchCoalesce(leader, follower, 3_000)).toBeUndefined()
  })

  it('keeps a lone note on the ordinary single-note path', () => {
    const leader = noteEntry('n1', 'only note', '2026-08-19T01:24:44.000Z', 1_000)

    const step = reviewBatchSettleStep(leader.hookContext, false, REVIEW_BATCH_QUIET_MS + 1_000)
    expect(step.action).toBe('seal')
    if (step.action !== 'seal') throw new Error('expected a seal')
    expect(step.promptText).toBeUndefined()
    expect(step.clearReply).toBe(false)
  })

  it('stops an open batch outright once its turn is cancelled', () => {
    const leader = noteEntry('n1', 'only note', '2026-08-19T01:24:44.000Z', 1_000)

    expect(reviewBatchSettleStep(leader.hookContext, true, 2_000)).toEqual({ action: 'stop', clearReply: false })
  })
})
