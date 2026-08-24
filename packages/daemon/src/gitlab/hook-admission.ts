/** GitLab's implementation of the daemon hook-admission contract (§6.5, §12.3):
 *  merge-request lanes, the console/reviewer re-run pins, and note coalescing. */
import {
  codeHostLane,
  type CodeHostCoordinatedHook,
  type CodeHostHookAdmission,
  type CodeHostHookCoordinates,
  type CodeHostRevisionStream
} from '../codehost/hook-admission.js'
import type { GithubReviewBatch, GithubReviewBatchItem, HookDispatchContext } from '../github/hook-coords.js'

/** Deliveries that establish a new merge-request head. */
const MERGE_REQUEST_REVISION_EVENTS = new Set(['merge_request:opened', 'merge_request:synchronize'])

/** Deliveries that re-run the head already current: a reviewer request, or the console's `rc/hook-rerun`. */
const MERGE_REQUEST_RERUN_EVENTS = new Set(['merge_request:review_requested', 'merge_request:rerun'])

/** The one comment family; GitLab normalizes conversation notes and diff notes to the same event. */
const NOTE_EVENT = 'note:created'

function mergeRequestLane(
  hook: CodeHostCoordinatedHook | undefined,
  coords: CodeHostHookCoordinates
): string | undefined {
  const gitlab = hook?.gitlab
  if (hook?.agentId !== coords.agentId || gitlab?.target.kind !== 'merge_request') return undefined
  return codeHostLane(hook, gitlab.projectId, gitlab.target.iid, coords)
}

function headShaOf(hook: CodeHostCoordinatedHook | undefined): string | undefined {
  const target = hook?.gitlab?.target
  return target?.kind === 'merge_request' ? target.headSha : undefined
}

function mergeRequestRevisionStream(
  hook: CodeHostCoordinatedHook | undefined,
  coords: CodeHostHookCoordinates
): CodeHostRevisionStream | undefined {
  const lane = mergeRequestLane(hook, coords)
  const headSha = headShaOf(hook)
  if (!lane || !headSha) return undefined
  const event = hook?.event ?? ''
  if (MERGE_REQUEST_REVISION_EVENTS.has(event)) return { lane, headSha, pinned: false }
  if (MERGE_REQUEST_RERUN_EVENTS.has(event)) return { lane, headSha, pinned: true }
  return undefined
}

/** GitLab's Note Hook carries no batch key, so one merge request's notes are the stream and the
 *  three shared timing gates bound it; issue notes keep one turn each (§12.3). */
function noteBatchStream(
  hook: CodeHostCoordinatedHook | undefined,
  coords: CodeHostHookCoordinates
): string | undefined {
  const lane = mergeRequestLane(hook, coords)
  if (!lane || hook?.event !== NOTE_EVENT) return undefined
  return JSON.stringify(['notes', lane])
}

/** One merge request's note batch; its identity is the subject, since a note carries none of its own. */
function openReviewBatch(
  hook: HookDispatchContext,
  coords: CodeHostHookCoordinates,
  text: string,
  now: number
): GithubReviewBatch | undefined {
  const target = hook.gitlab?.target
  if (!noteBatchStream(hook, coords) || target?.kind !== 'merge_request') return undefined
  return {
    reviewId: `${hook.gitlab!.projectId}!${target.iid}`,
    openedAt: now,
    updatedAt: now,
    items: [{ deliveryKey: hook.deliveryKey, firedAt: hook.firedAt, text }]
  }
}

function renderGitlabNoteBatchPrompt(batch: GithubReviewBatch): string {
  const items = [...batch.items].sort(
    (a, b) => a.firedAt.localeCompare(b.firedAt) || a.deliveryKey.localeCompare(b.deliveryKey)
  )
  return [
    `GitLab merge-request note batch (${items.length} notes on the same merge request)`,
    '',
    ...items.flatMap((item, index) => [
      `===== NOTE ${index + 1} =====`,
      item.text,
      `===== END NOTE ${index + 1} =====`,
      ''
    ]),
    'Inspect shared merge-request context once, then return ONE self-contained final answer that addresses every note above. The daemon posts it back to that merge request automatically as one ordinary GitLab note and exclusively owns that reply, so do not answer the notes one by one. Do NOT create, update, or delete GitLab notes through `glab`, another CLI, a connector, or a direct API call — those paths would race or double-post; every other GitLab access is READ-only inspection.'
  ].join('\n')
}

export const gitlabHookAdmission: CodeHostHookAdmission = {
  provider: 'gitlab',
  claims: (hook) => hook?.gitlab !== undefined,
  reviewSubjectLane: mergeRequestLane,
  revisionStream: mergeRequestRevisionStream,
  headSha: headShaOf,
  rerunsCurrentHead: (hook: Pick<HookDispatchContext, 'event'> | undefined) =>
    MERGE_REQUEST_RERUN_EVENTS.has(hook?.event ?? ''),
  reviewBatchStream: noteBatchStream,
  openReviewBatch,
  // Notes carry no durable id on the hook frame, so the delivery is the item identity.
  batchItemKey: (item: GithubReviewBatchItem) => item.deliveryKey,
  renderBatchPrompt: renderGitlabNoteBatchPrompt,
  batchPublishesItems: false
}
