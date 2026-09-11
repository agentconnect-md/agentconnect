// Gitea hook admission (gitea-integration.md §8): lanes per (hook, repository, pull-request index), the
// newest head supersedes, reviewer requests and console re-runs pin to the current head, comments and
// review submissions on one pull request batch under the three shared gates, and issues never contend.
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

const REPO = '556677'
const INDEX = 12
const KEY = `gitea:${REPO}:pull:${INDEX}`
const HEAD_A = 'a'.repeat(40)
const HEAD_B = 'b'.repeat(40)

const hook = (deliveryKey: string, event: string, headSha: string, firedAt: string): HookDispatchContext => ({
  hookId: 'hook-1',
  agentId: 'agent-1',
  deliveryKey,
  firedAt,
  event,
  gitea: {
    repoId: REPO,
    repoPath: 'example-org/example-repo',
    target: { kind: 'pull', index: INDEX, headSha, baseSha: '0'.repeat(40) }
  }
})

const entry = (deliveryKey: string, event: string, headSha: string, firedAt: string): QueueEntry =>
  ({
    agentId: 'agent-1',
    msg: { platform: 'hook', channel: 'hook-1' },
    inboxId: `inbox-${deliveryKey}`,
    hookContext: hook(deliveryKey, event, headSha, firedAt)
  }) as unknown as QueueEntry

const active = (entry: QueueEntry): HookQueueCandidate[] => [{ key: KEY, entry, state: 'active' }]

const coords = hookCoordinates('agent-1', { platform: 'hook', channel: 'hook-1' })

/** One comment or review delivery already carrying the single-item batch the dispatch path opens for it. */
const commentEntry = (
  deliveryKey: string,
  text: string,
  firedAt: string,
  openedAt: number,
  event = 'note:created'
): QueueEntry => {
  const context = hook(deliveryKey, event, HEAD_A, firedAt)
  context.githubReply = {
    hookId: 'hook-1',
    provider: 'gitea',
    subjectKind: 'merge_request',
    repo: REPO,
    repoPath: 'example-org/example-repo',
    number: INDEX
  }
  context.githubReviewBatch = openReviewBatch(context, coords, text, openedAt)
  return {
    agentId: 'agent-1',
    msg: { platform: 'hook', channel: 'hook-1', text },
    inboxId: `inbox-${deliveryKey}`,
    hookContext: context
  } as unknown as QueueEntry
}

describe('planRevisionAdmission (gitea)', () => {
  it('preempts a running merge_request:opened review with a newer synchronized head', () => {
    const opened = entry('opened', 'merge_request:opened', HEAD_A, '2026-09-12T01:24:44.000Z')
    const pushed = entry('pushed', 'merge_request:synchronize', HEAD_B, '2026-09-12T01:28:20.000Z')

    const plan = planRevisionAdmission(KEY, pushed, active(opened))

    expect(plan?.winner.entry).toBe(pushed)
    const effects = planRevisionAdmissionEffects(plan!, pushed)
    expect(effects.incomingWins).toBe(true)
    expect(effects.preemptableActiveLosers.map((candidate) => candidate.entry)).toEqual([opened])
    expect(effects.winnerLane).toBe(reviewSubjectLane(pushed.hookContext, coords))
    expect(effects.winnerLane).toBe(JSON.stringify(['hook-1', 'agent-1', REPO, INDEX, 'hook', 'hook-1', null]))
  })

  it('supersedes a queued older revision and waits out a running review of the same head', () => {
    const opened = entry('opened', 'merge_request:opened', HEAD_A, '2026-09-12T01:24:44.000Z')
    const queued = entry('queued', 'merge_request:synchronize', HEAD_A, '2026-09-12T01:25:00.000Z')
    const pushed = entry('pushed', 'merge_request:synchronize', HEAD_B, '2026-09-12T01:28:20.000Z')
    const effects = planRevisionAdmissionEffects(
      planRevisionAdmission(KEY, pushed, [
        { key: KEY, entry: opened, state: 'active' },
        { key: KEY, entry: queued, state: 'queued' }
      ])!,
      pushed
    )
    expect(effects.terminalLosers.map((candidate) => candidate.entry)).toEqual([queued])
    expect(effects.preemptableActiveLosers.map((candidate) => candidate.entry)).toEqual([opened])

    const redelivered = entry('redelivered', 'merge_request:synchronize', HEAD_A, '2026-09-12T01:25:00.000Z')
    const same = planRevisionAdmissionEffects(planRevisionAdmission(KEY, redelivered, active(opened))!, redelivered)
    expect(same.activeLosers.map((candidate) => candidate.entry)).toEqual([opened])
    expect(same.preemptableActiveLosers).toEqual([])
  })

  it('pins a reviewer request and a console re-run to the current head, collapsing a burst onto the newest', () => {
    const opened = entry('opened', 'merge_request:opened', HEAD_A, '2026-09-12T01:24:44.000Z')
    const rerun = entry('rerun', 'merge_request:rerun', HEAD_A, '2026-09-12T01:26:00.000Z')
    const plan = planRevisionAdmission(KEY, rerun, active(opened))
    expect(plan?.winner.entry).toBe(rerun)
    expect(planRevisionAdmissionEffects(plan!, rerun).preemptableActiveLosers.map((c) => c.entry)).toEqual([opened])

    const first = entry('first', 'merge_request:review_requested', HEAD_A, '2026-09-12T17:55:42.765Z')
    const second = entry('second', 'merge_request:review_requested', HEAD_A, '2026-09-12T17:55:42.947Z')
    const third = entry('third', 'merge_request:rerun', HEAD_A, '2026-09-12T17:55:43.456Z')
    const burst = planRevisionAdmission(KEY, third, [
      { key: KEY, entry: first, state: 'active' },
      { key: KEY, entry: second, state: 'queued' }
    ])
    expect(burst?.winner.entry).toBe(third)
    const effects = planRevisionAdmissionEffects(burst!, third)
    expect(effects.terminalLosers.map((candidate) => candidate.entry)).toEqual([second])
    expect(effects.preemptableActiveLosers.map((candidate) => candidate.entry)).toEqual([first])

    // A re-run naming a stale head leaves the head under review alone.
    const pushed = entry('pushed', 'merge_request:synchronize', HEAD_B, '2026-09-12T01:28:20.000Z')
    const stale = entry('stale', 'merge_request:rerun', HEAD_A, '2026-09-12T01:29:00.000Z')
    expect(planRevisionAdmission(KEY, stale, active(pushed))?.superseded).toEqual([])
  })

  it('never contests across pull requests, and issues and comments open no revision generation', () => {
    const other = entry('other', 'merge_request:synchronize', HEAD_A, '2026-09-12T01:24:44.000Z')
    other.hookContext!.gitea!.target = { kind: 'pull', index: INDEX + 1, headSha: HEAD_A }
    const pushed = entry('pushed', 'merge_request:synchronize', HEAD_B, '2026-09-12T01:28:20.000Z')
    expect(planRevisionAdmission(KEY, pushed, active(other))?.superseded).toEqual([])

    const issue = entry('issue', 'issues:opened', HEAD_A, '2026-09-12T01:30:00.000Z')
    issue.hookContext!.gitea!.target = { kind: 'issue', index: INDEX }
    expect(planRevisionAdmission(KEY, issue, active(pushed))).toBeUndefined()
    expect(reviewSubjectLane(issue.hookContext, coords)).toBeUndefined()
    expect(
      planRevisionAdmission(KEY, commentEntry('c', 'please fix', '2026-09-12T01:30:00.000Z', 0), [])
    ).toBeUndefined()
  })
})

describe('gitea comment batching', () => {
  it('folds a comment and a review submission on the same pull request into one open batch', () => {
    const leader = commentEntry('n1', 'first comment', '2026-09-12T01:24:44.000Z', 1_000)
    const review = commentEntry('r1', 'ship it', '2026-09-12T01:24:46.000Z', 3_000, 'review:approved')

    expect(selectReviewBatchLeader(review, active(leader))).toBe(leader)
    const plan = planReviewBatchCoalesce(leader, review, 3_000)
    expect(plan?.itemKey).toBe('r1')
    expect(plan?.reviewId).toBe(`${REPO}#${INDEX}`)
    expect(plan?.nextHook.githubReviewBatch?.items.map((item) => item.text)).toEqual(['first comment', 'ship it'])
    expect(plan?.nextHook.githubReviewBatch?.updatedAt).toBe(3_000)
    // A redelivery of a comment already in the batch folds nothing.
    expect(
      planReviewBatchCoalesce(leader, commentEntry('n1', 'first comment', '2026-09-12T01:24:44.000Z', 3_000), 3_000)
    ).toBeUndefined()
  })

  it('batches no comment on an issue, and none across pull requests', () => {
    const leader = commentEntry('n1', 'first comment', '2026-09-12T01:24:44.000Z', 1_000)
    const issueComment = commentEntry('n2', 'issue comment', '2026-09-12T01:24:46.000Z', 3_000)
    issueComment.hookContext!.gitea!.target = { kind: 'issue', index: INDEX }
    expect(selectReviewBatchLeader(issueComment, active(leader))).toBeUndefined()
    // An issue comment keeps one turn each: it opens no batch of its own either.
    const issueContext = hook('n3', 'note:created', HEAD_A, '2026-09-12T01:24:46.000Z')
    issueContext.gitea!.target = { kind: 'issue', index: INDEX }
    expect(openReviewBatch(issueContext, coords, 'issue comment', 0)).toBeUndefined()

    const otherPull = commentEntry('n4', 'other comment', '2026-09-12T01:24:47.000Z', 3_000)
    otherPull.hookContext!.gitea!.target = { kind: 'pull', index: INDEX + 1, headSha: HEAD_A }
    expect(selectReviewBatchLeader(otherPull, active(leader))).toBeUndefined()
  })

  it('waits for the quiet window, then seals with a Gitea batch prompt that keeps the ordinary reply', () => {
    const leader = commentEntry('n1', 'first comment', '2026-09-12T01:24:44.000Z', 1_000)
    const follower = commentEntry('n2', 'second comment', '2026-09-12T01:24:46.000Z', 3_000)
    leader.hookContext = planReviewBatchCoalesce(leader, follower, 3_000)!.nextHook

    expect(reviewBatchSettleStep(leader.hookContext, false, 4_000)).toEqual({
      action: 'wait',
      delayMs: 3_000 + REVIEW_BATCH_QUIET_MS - 4_000
    })
    const sealed = reviewBatchSettleStep(leader.hookContext, false, 3_000 + REVIEW_BATCH_QUIET_MS)
    if (sealed.action !== 'seal') throw new Error('expected a seal')
    expect(sealed.sealed.sealed).toBe(true)
    expect(sealed.promptText).toContain('Gitea pull-request comment batch (2 deliveries')
    expect(sealed.promptText).toContain('first comment')
    expect(sealed.promptText).toContain('second comment')
    expect(sealed.promptText).toContain('one ordinary Gitea comment')
    expect(sealed.clearReply).toBe(false)
  })

  it('seals at the max-wait ceiling, admits no further comment once full, and keeps a lone comment on the single path', () => {
    const leader = commentEntry('n1', 'first comment', '2026-09-12T01:24:44.000Z', 0)
    const late = commentEntry('n2', 'second comment', '2026-09-12T01:24:46.000Z', REVIEW_BATCH_MAX_WAIT_MS - 1)
    leader.hookContext = planReviewBatchCoalesce(leader, late, REVIEW_BATCH_MAX_WAIT_MS - 1)!.nextHook
    expect(reviewBatchSettleStep(leader.hookContext, false, REVIEW_BATCH_MAX_WAIT_MS).action).toBe('seal')

    const full = commentEntry('f1', 'first', '2026-09-12T01:24:44.000Z', 1_000)
    full.hookContext!.githubReviewBatch!.items = Array.from(
      { length: REVIEW_BATCH_MAX_COMMENTS },
      (_unused, index) => ({
        deliveryKey: `f${index}`,
        firedAt: '2026-09-12T01:24:44.000Z',
        text: `comment ${index}`
      })
    )
    const overflow = commentEntry('overflow', 'one too many', '2026-09-12T01:24:46.000Z', 3_000)
    expect(selectReviewBatchLeader(overflow, active(full))).toBeUndefined()
    expect(planReviewBatchCoalesce(full, overflow, 3_000)).toBeUndefined()

    const lone = commentEntry('l1', 'only comment', '2026-09-12T01:24:44.000Z', 1_000)
    const step = reviewBatchSettleStep(lone.hookContext, false, REVIEW_BATCH_QUIET_MS + 1_000)
    if (step.action !== 'seal') throw new Error('expected a seal')
    expect(step.promptText).toBeUndefined()
    expect(step.clearReply).toBe(false)
    expect(reviewBatchSettleStep(lone.hookContext, true, 2_000)).toEqual({ action: 'stop', clearReply: false })
  })
})
