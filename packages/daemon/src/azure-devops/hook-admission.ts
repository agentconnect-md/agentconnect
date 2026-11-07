// Azure DevOps's hook-admission members (azure-devops-integration.md §11.4): pull-request lanes keyed on the newest iteration's source commit, the review-request pin, and comment batching per thread.
import {
  codeHostLane,
  type CodeHostCoordinatedHook,
  type CodeHostHookAdmission,
  type CodeHostHookCoordinates,
  type CodeHostRevisionStream
} from '../codehost/hook-admission.js'
import type { GithubReviewBatch, GithubReviewBatchItem, HookDispatchContext } from '../github/hook-coords.js'
import {
  AZURE_DEVOPS_COMMENT_EVENT,
  AZURE_DEVOPS_PULL_RERUN_EVENTS,
  AZURE_DEVOPS_PULL_REVISION_EVENTS
} from './events.js'

/** The lane is (hook, repository, pull request); a push carries no revision and never contends. */
function pullRequestLane(
  hook: CodeHostCoordinatedHook | undefined,
  coords: CodeHostHookCoordinates
): string | undefined {
  const azure = hook?.azureDevOps
  if (hook?.agentId !== coords.agentId || azure?.target.kind !== 'pull') return undefined
  return codeHostLane(hook, azure.repoId, azure.target.pullRequestId, coords)
}

/** The head the turn-start read fenced on: the newest iteration's source commit. */
function headShaOf(hook: CodeHostCoordinatedHook | undefined): string | undefined {
  const target = hook?.azureDevOps?.target
  return target?.kind === 'pull' ? target.headSha : undefined
}

/** `opened` and a new iteration establish a head; a confirmed review request pins to the head already current. */
function pullRevisionStream(
  hook: CodeHostCoordinatedHook | undefined,
  coords: CodeHostHookCoordinates
): CodeHostRevisionStream | undefined {
  const lane = pullRequestLane(hook, coords)
  const headSha = headShaOf(hook)
  if (!lane || !headSha) return undefined
  const event = hook?.event ?? ''
  if (AZURE_DEVOPS_PULL_REVISION_EVENTS.has(event)) return { lane, revision: headSha, pinned: false }
  if (AZURE_DEVOPS_PULL_RERUN_EVENTS.has(event)) return { lane, revision: headSha, pinned: true }
  return undefined
}

/** Comments coalesce per thread, since the one reply goes into the thread its leader fired in. */
function commentBatchStream(
  hook: CodeHostCoordinatedHook | undefined,
  coords: CodeHostHookCoordinates
): string | undefined {
  const lane = pullRequestLane(hook, coords)
  const threadId = hook?.azureDevOps?.threadId
  if (!lane || !threadId || hook?.event !== AZURE_DEVOPS_COMMENT_EVENT) return undefined
  return JSON.stringify(['comments', lane, threadId])
}

/** One thread's comment batch; the item carries the assembled prompt, which holds what the turn-start read found. */
function openReviewBatch(
  hook: HookDispatchContext,
  coords: CodeHostHookCoordinates,
  text: string,
  now: number,
  prompt?: string
): GithubReviewBatch | undefined {
  const azure = hook.azureDevOps
  if (!commentBatchStream(hook, coords) || azure?.target.kind !== 'pull') return undefined
  return {
    reviewId: `${azure.repoId}#${azure.target.pullRequestId}:${azure.threadId}`,
    openedAt: now,
    updatedAt: now,
    items: [{ deliveryKey: hook.deliveryKey, firedAt: hook.firedAt, text: prompt ?? text }]
  }
}

function renderAzureDevOpsCommentBatchPrompt(batch: GithubReviewBatch): string {
  const items = [...batch.items].sort(
    (a, b) => a.firedAt.localeCompare(b.firedAt) || a.deliveryKey.localeCompare(b.deliveryKey)
  )
  return [
    `Azure DevOps pull-request comment batch (${items.length} deliveries in the same comment thread)`,
    '',
    ...items.flatMap((item, index) => [
      `===== DELIVERY ${index + 1} =====`,
      item.text,
      `===== END DELIVERY ${index + 1} =====`,
      ''
    ]),
    'Inspect shared pull-request context once, then return ONE self-contained final answer that addresses every delivery above. The daemon posts it back into that comment thread automatically as one reply and exclusively owns that reply, so do not answer the deliveries one by one. Do NOT create, update, or delete Azure DevOps comments or threads through `az`, another CLI, a connector, or a direct API call — those paths would race or double-post; every other Azure DevOps access is READ-only inspection.'
  ].join('\n')
}

export const azureDevOpsHookAdmission: CodeHostHookAdmission = {
  provider: 'azure-devops',
  reviewSubjectLane: pullRequestLane,
  revisionStream: pullRevisionStream,
  rerunsCurrentRevision: (hook: Pick<HookDispatchContext, 'event'> | undefined) =>
    AZURE_DEVOPS_PULL_RERUN_EVENTS.has(hook?.event ?? ''),
  reviewBatchStream: commentBatchStream,
  openReviewBatch,
  // A delivery's event id is its identity; a redelivery repeats it.
  batchItemKey: (item: GithubReviewBatchItem) => item.deliveryKey,
  renderBatchPrompt: renderAzureDevOpsCommentBatchPrompt,
  batchPublishesItems: false
}
