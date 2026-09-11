/** Gitea's implementation of the daemon turn-final contract (gitea-integration.md §8, §10.1, §11): the
 *  comment target on a numbered subject, the per-instance effect lease, the turn-start host fence, the
 *  lifecycle pairing, and the review-delivery correlation the prompt needs fetched first. */
import { GITEA_DEFAULT_BASE_URL, type RdMsgHook } from '@agentconnect.md/protocol'
import type {
  CodeHostDelivery,
  CodeHostEffectLease,
  CodeHostFinalPoster,
  CodeHostFinalPosterDeps,
  CodeHostPromptSupplementDeps,
  CodeHostThreadWorktreeCleanup,
  CodeHostTurnFinal
} from '../codehost/turn-final.js'
import type { CodeHostReplyTarget } from '../codehost/reply-target.js'
import type { HookPromptSupplement } from '../messages/hook-message.js'
import { giteaApiBaseUrl } from './api-base.js'
import { GITEA_ISSUE_CLOSED_EVENT, GITEA_PULL_MERGED_EVENT } from './events.js'
import { GITEA_HOST_MISMATCH_REASON } from './host-fence.js'
import { GiteaFinalPoster } from './poster.js'
import { correlateGiteaReview, giteaReviewEventState } from './review-correlation.js'

/** What Gitea's members read back on the daemon: the §10.1 effect lease, and the instance its spec names. */
export interface GiteaTurnFinalHost {
  /** The connection token as a hook-reply lease, gated by the enabled gitea hook. */
  getGiteaPostToken(agentId: string, repoId: string, hookId: string): Promise<{ token: string }>
  invalidateGiteaPost(agentId: string, repoId: string, presentedToken?: string): void
  /** The instance this agent's spec is bound to; absent means gitea.com (§11). */
  giteaHostFor(agentId: string): string | undefined
  log: { warn: (message: string) => void }
}

/** The whole review lookup — one list plus one read per candidate — must not hold the relay's ack open for long. */
const REVIEW_LOOKUP_TIMEOUT_MS = 10_000

/** §10.1 rides the same pipe as GitHub: `repo` is the numeric repository id (the lease scope), `repoPath` the
 *  current owner/repo the REST paths address, and `number` the subject index; pushes have no thread and stay silent. */
function replyTarget(msg: RdMsgHook): CodeHostReplyTarget | undefined {
  const gitea = msg.gitea
  if (!gitea || gitea.target.kind === 'push') return undefined
  return {
    hookId: msg.hookId,
    provider: 'gitea',
    // The product's subject vocabulary: a pull request answers on the merge-request family; both post through issues.
    subjectKind: gitea.target.kind === 'pull' ? 'merge_request' : 'issue',
    repo: gitea.repoId,
    repoPath: gitea.repoPath,
    number: gitea.target.index,
    ...(gitea.commentId ? { triggerComment: { kind: 'issue_comment' as const, id: gitea.commentId } } : {})
  }
}

/** §11: a delivery naming another instance than the spec is refused under this reason and never re-targeted. */
function hostFence(msg: RdMsgHook, host: GiteaTurnFinalHost): string | undefined {
  if (msg.gitea === undefined) return undefined
  const expected = host.giteaHostFor(msg.agentId) ?? GITEA_DEFAULT_BASE_URL
  const delivered = msg.gitea.host ?? GITEA_DEFAULT_BASE_URL
  if (delivered === expected) return undefined
  host.log.warn(
    `hook: fire ${msg.msgId} for agent "${msg.agentId}" names gitea instance ${delivered} but its spec is bound to ${expected} — refusing`
  )
  return GITEA_HOST_MISMATCH_REASON
}

/** The maintenance family (§8): a merged pull request and a closed issue retire the per-thread checkout. */
function worktreeCleanup(delivery: CodeHostDelivery): CodeHostThreadWorktreeCleanup | undefined {
  const gitea = delivery.gitea
  if (delivery.event === GITEA_PULL_MERGED_EVENT && gitea?.target.kind === 'pull') return 'pull_request_merged'
  if (delivery.event === GITEA_ISSUE_CLOSED_EVENT && gitea?.target.kind === 'issue') return 'issue_closed'
  return undefined
}

function effectLease(agentId: string, target: CodeHostReplyTarget, host: GiteaTurnFinalHost): CodeHostEffectLease {
  return {
    token: async () => (await host.getGiteaPostToken(agentId, target.repo, target.hookId)).token,
    invalidateToken: (presented) => host.invalidateGiteaPost(agentId, target.repo, presented),
    // §11: the instance this agent's spec names, read when the comment is actually posted.
    apiBaseUrl: () => giteaApiBaseUrl(host.giteaHostFor(agentId))
  }
}

function finalPoster(target: CodeHostReplyTarget, deps: CodeHostFinalPosterDeps): CodeHostFinalPoster {
  return new GiteaFinalPoster(
    { token: deps.token, invalidateToken: deps.invalidateToken, apiBaseUrl: deps.apiBaseUrl, log: deps.log },
    target.repo,
    // A target without the path composes no URL; the poster then reports the publish as failed rather than guessing one.
    target.repoPath ?? '',
    target.number,
    deps.attribution
  )
}

/** §8: a review delivery carries only its summary, so the inline comments are read under the turn's own lease before the prompt is built. */
async function promptSupplement(
  msg: RdMsgHook,
  deps: CodeHostPromptSupplementDeps
): Promise<HookPromptSupplement | undefined> {
  const gitea = msg.gitea
  const c = msg.context
  const event = msg.event ?? (c?.action ? `${c.event}:${c.action}` : c?.event)
  const state = c?.source === 'gitea' ? giteaReviewEventState(event) : undefined
  if (!gitea || !c || gitea.target.kind !== 'pull' || state === undefined) return undefined
  const senderLogin = c.senderLogin?.trim()
  if (!senderLogin) return { giteaReview: { kind: 'unavailable', reason: 'the delivery names no sender' } }
  let token: string
  try {
    token = await deps.token()
  } catch (err) {
    return { giteaReview: { kind: 'unavailable', reason: err instanceof Error ? err.message : String(err) } }
  }
  const review = await correlateGiteaReview(
    {
      apiBaseUrl: deps.apiBaseUrl(),
      token,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      signal: AbortSignal.timeout(REVIEW_LOOKUP_TIMEOUT_MS)
    },
    {
      repoPath: gitea.repoPath,
      index: gitea.target.index,
      state,
      senderLogin,
      summary: c.bodyExcerpt ?? '',
      ...(c.truncated !== undefined ? { truncated: c.truncated } : {})
    }
  )
  return { giteaReview: review }
}

export const giteaTurnFinal: CodeHostTurnFinal<'gitea'> = {
  provider: 'gitea',
  replyTarget,
  hostFence,
  worktreeCleanup,
  effectLease,
  finalPoster,
  promptSupplement,
  reportsAbsentOutput: true
}
