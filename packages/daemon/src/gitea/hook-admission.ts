/** Gitea's implementation of the daemon hook-admission contract (gitea-integration.md §8; gitlab-com-integration.md
 *  §12.3): pull-request lanes, the reviewer-request and console re-run pins, and comment coalescing. */
import {
  codeHostLane,
  type CodeHostCoordinatedHook,
  type CodeHostHookAdmission,
  type CodeHostHookCoordinates,
  type CodeHostRevisionStream
} from '../codehost/hook-admission.js'
import type { GithubReviewBatch, GithubReviewBatchItem, HookDispatchContext } from '../github/hook-coords.js'
import { GITEA_PULL_RERUN_EVENTS, GITEA_PULL_REVISION_EVENTS, isGiteaCommentEvent } from './events.js'

/** The lane is (hook, repository, pull-request index); issues carry no revision and never contend. */
function pullRequestLane(
  hook: CodeHostCoordinatedHook | undefined,
  coords: CodeHostHookCoordinates
): string | undefined {
  const gitea = hook?.gitea
  if (hook?.agentId !== coords.agentId || gitea?.target.kind !== 'pull') return undefined
  return codeHostLane(hook, gitea.repoId, gitea.target.index, coords)
}

function headShaOf(hook: CodeHostCoordinatedHook | undefined): string | undefined {
  const target = hook?.gitea?.target
  return target?.kind === 'pull' ? target.headSha : undefined
}

/** `opened` and `synchronized` establish a head; a reviewer request and the console re-run pin to the head already current. */
function pullRevisionStream(
  hook: CodeHostCoordinatedHook | undefined,
  coords: CodeHostHookCoordinates
): CodeHostRevisionStream | undefined {
  const lane = pullRequestLane(hook, coords)
  const headSha = headShaOf(hook)
  if (!lane || !headSha) return undefined
  const event = hook?.event ?? ''
  if (GITEA_PULL_REVISION_EVENTS.has(event)) return { lane, revision: headSha, pinned: false }
  if (GITEA_PULL_RERUN_EVENTS.has(event)) return { lane, revision: headSha, pinned: true }
  return undefined
}

/** Comments and review submissions on one pull request are the stream, bounded by the three shared timing
 *  gates — several review deliveries for one head fold into one turn (§8); issue comments keep one turn each. */
function commentBatchStream(
  hook: CodeHostCoordinatedHook | undefined,
  coords: CodeHostHookCoordinates
): string | undefined {
  const lane = pullRequestLane(hook, coords)
  if (!lane || !isGiteaCommentEvent(hook?.event)) return undefined
  return JSON.stringify(['comments', lane])
}

/** One pull request's comment batch; its identity is the subject, since a comment delivery carries no durable batch key. */
function openReviewBatch(
  hook: HookDispatchContext,
  coords: CodeHostHookCoordinates,
  text: string,
  now: number
): GithubReviewBatch | undefined {
  const target = hook.gitea?.target
  if (!commentBatchStream(hook, coords) || target?.kind !== 'pull') return undefined
  return {
    reviewId: `${hook.gitea!.repoId}#${target.index}`,
    openedAt: now,
    updatedAt: now,
    items: [{ deliveryKey: hook.deliveryKey, firedAt: hook.firedAt, text }]
  }
}

function renderGiteaCommentBatchPrompt(batch: GithubReviewBatch): string {
  const items = [...batch.items].sort(
    (a, b) => a.firedAt.localeCompare(b.firedAt) || a.deliveryKey.localeCompare(b.deliveryKey)
  )
  return [
    `Gitea pull-request comment batch (${items.length} deliveries on the same pull request)`,
    '',
    ...items.flatMap((item, index) => [
      `===== DELIVERY ${index + 1} =====`,
      item.text,
      `===== END DELIVERY ${index + 1} =====`,
      ''
    ]),
    'Inspect shared pull-request context once, then return ONE self-contained final answer that addresses every delivery above. The daemon posts it back to that pull request automatically as one ordinary Gitea comment and exclusively owns that reply, so do not answer the deliveries one by one. Do NOT create, update, or delete Gitea comments or reviews through `tea`, another CLI, a connector, or a direct API call — those paths would race or double-post; every other Gitea access is READ-only inspection.'
  ].join('\n')
}

export const giteaHookAdmission: CodeHostHookAdmission = {
  provider: 'gitea',
  reviewSubjectLane: pullRequestLane,
  revisionStream: pullRevisionStream,
  rerunsCurrentRevision: (hook: Pick<HookDispatchContext, 'event'> | undefined) =>
    GITEA_PULL_RERUN_EVENTS.has(hook?.event ?? ''),
  reviewBatchStream: commentBatchStream,
  openReviewBatch,
  // A comment carries no durable id on the hook frame, and a review submission carries none at all, so the delivery is the item identity.
  batchItemKey: (item: GithubReviewBatchItem) => item.deliveryKey,
  renderBatchPrompt: renderGiteaCommentBatchPrompt,
  batchPublishesItems: false
}
