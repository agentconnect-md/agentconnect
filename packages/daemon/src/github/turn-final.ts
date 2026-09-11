/** GitHub's implementation of the daemon turn-final contract (§6.5, §14.1): the issue/PR
 *  comment target, its repo-targeted mint, and the pull-request lifecycle pairing. */
import type { RdMsgHook } from '@agentconnect.md/protocol'
import type {
  CodeHostDelivery,
  CodeHostEffectLease,
  CodeHostFinalPoster,
  CodeHostFinalPosterDeps,
  CodeHostThreadWorktreeCleanup,
  CodeHostTurnFinal
} from '../codehost/turn-final.js'
import type { CodeHostReplyTarget } from '../codehost/reply-target.js'
import { GithubFinalPoster } from './poster.js'

/** The deployment's App speaks to github.com alone, so this root is not a per-turn fact. */
const GITHUB_API_BASE_URL = 'https://api.github.com'

/** What GitHub's members read back on the daemon — the repo-targeted gitcred mint and nothing wider. */
export interface GithubTurnFinalHost {
  /** Issues/PR write for this delivery's repo, no contents; the token never enters agent env. */
  getPostToken(agentId: string, repo: string, hookId: string): Promise<{ token: string }>
  invalidatePost(agentId: string, repo: string, presentedToken?: string): void
}

function replyTarget(msg: RdMsgHook): CodeHostReplyTarget | undefined {
  const github = msg.github
  // Inline coordinates and their PR target are one body-free trusted unit.
  if (
    github?.subjectKind === 'pull_request' &&
    github.pullNumber !== undefined &&
    github.reviewThreadRootCommentId !== undefined
  ) {
    return {
      hookId: msg.hookId,
      provider: 'github',
      repo: github.repoFullName,
      number: github.pullNumber,
      ...(github.reviewCommentId
        ? {
            reviewCommentId: github.reviewCommentId,
            triggerComment: { kind: 'review_comment' as const, id: github.reviewCommentId }
          }
        : {}),
      reviewThreadRootCommentId: github.reviewThreadRootCommentId
    }
  }
  // A mixed-version frame without that unit keeps the rolling-compatible ordinary
  // issue/PR comment path derived from HookContext.
  const c = msg.context
  if (!c?.repo || c.number === undefined) return undefined
  return {
    hookId: msg.hookId,
    provider: 'github',
    repo: c.repo,
    number: c.number,
    ...(github?.issueCommentId ? { triggerComment: { kind: 'issue_comment' as const, id: github.issueCommentId } } : {})
  }
}

/** Pair the normalized event with trusted subject metadata so an old or malformed frame cannot turn an ordinary hook into maintenance. */
function worktreeCleanup(delivery: CodeHostDelivery): CodeHostThreadWorktreeCleanup | undefined {
  const github = delivery.github
  if (delivery.event === 'pull_request:merged' && github?.subjectKind === 'pull_request') return 'pull_request_merged'
  if (delivery.event === 'issues:closed' && github?.subjectKind === 'issue') return 'issue_closed'
  if (delivery.event === 'issues:deleted' && github?.subjectKind === 'issue') return 'issue_deleted'
  return undefined
}

function effectLease(agentId: string, target: CodeHostReplyTarget, host: GithubTurnFinalHost): CodeHostEffectLease {
  return {
    token: async () => (await host.getPostToken(agentId, target.repo, target.hookId)).token,
    invalidateToken: (presented) => host.invalidatePost(agentId, target.repo, presented),
    apiBaseUrl: () => GITHUB_API_BASE_URL
  }
}

function finalPoster(target: CodeHostReplyTarget, deps: CodeHostFinalPosterDeps): CodeHostFinalPoster {
  return new GithubFinalPoster(
    { token: deps.token, invalidateToken: deps.invalidateToken, log: deps.log },
    target.repo,
    target.number,
    deps.attribution,
    target.reviewThreadRootCommentId
  )
}

export const githubTurnFinal: CodeHostTurnFinal<'github'> = {
  provider: 'github',
  replyTarget,
  // The App is bound to github.com, so a delivery names no instance that could disagree with the spec.
  hostFence: () => undefined,
  worktreeCleanup,
  effectLease,
  finalPoster,
  reportsAbsentOutput: false
}
