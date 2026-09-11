/** GitLab's implementation of the daemon turn-final contract (§6.5, §14.1, §24.4): the note
 *  target on a numbered subject, the per-instance effect lease, and the turn-start host fence. */
import { GITLAB_DEFAULT_BASE_URL, type RdMsgHook } from '@agentconnect.md/protocol'
import type {
  CodeHostDelivery,
  CodeHostEffectLease,
  CodeHostFinalPoster,
  CodeHostFinalPosterDeps,
  CodeHostThreadWorktreeCleanup,
  CodeHostTurnFinal
} from '../codehost/turn-final.js'
import type { CodeHostReplyTarget } from '../codehost/reply-target.js'
import { gitlabApiBaseUrl } from './api-base.js'
import { GITLAB_HOST_MISMATCH_REASON } from './host-fence.js'
import { GitlabFinalPoster } from './poster.js'

/** What GitLab's members read back on the daemon: the §14.1 effect lease, and the instance its spec names. */
export interface GitlabTurnFinalHost {
  /** The binding's effect PAT, gated by the enabled gitlab hook. */
  getGitlabPostToken(agentId: string, projectId: string, hookId: string): Promise<{ token: string }>
  invalidateGitlabPost(agentId: string, projectId: string, presentedToken?: string): void
  /** The instance this agent's spec is bound to; absent means GitLab.com (§24.4). */
  gitlabHostFor(agentId: string): string | undefined
  log: { warn: (message: string) => void }
}

/** §14.1 rides the same pipe as GitHub: `repo` is the numeric project id and `number` the subject IID; pushes have no thread and stay silent. */
function replyTarget(msg: RdMsgHook): CodeHostReplyTarget | undefined {
  const gitlab = msg.gitlab
  if (!gitlab || gitlab.target.kind === 'push') return undefined
  return {
    hookId: msg.hookId,
    provider: 'gitlab',
    subjectKind: gitlab.target.kind,
    repo: gitlab.projectId,
    number: gitlab.target.iid,
    ...(gitlab.noteId ? { triggerComment: { kind: 'note' as const, id: gitlab.noteId } } : {})
  }
}

/**
 * §24.4: a hook may reach an ALREADY-RUNNING session whose environment cannot be retroactively
 * edited — its credential git-config block, injected helper table and `GITLAB_HOST` export were
 * all established at spawn for the instance the spec named. A delivery naming another instance is
 * refused under this reason and never re-targeted.
 */
function hostFence(msg: RdMsgHook, host: GitlabTurnFinalHost): string | undefined {
  if (msg.gitlab === undefined) return undefined
  const expected = host.gitlabHostFor(msg.agentId) ?? GITLAB_DEFAULT_BASE_URL
  const delivered = msg.gitlab.host ?? GITLAB_DEFAULT_BASE_URL
  if (delivered === expected) return undefined
  host.log.warn(
    `hook: fire ${msg.msgId} for agent "${msg.agentId}" names gitlab instance ${delivered} but its spec is bound to ${expected} — refusing`
  )
  return GITLAB_HOST_MISMATCH_REASON
}

/** The counterpart of GitHub's pairing (§12): merged MRs and closed issues retire the per-thread checkout. */
function worktreeCleanup(delivery: CodeHostDelivery): CodeHostThreadWorktreeCleanup | undefined {
  const gitlab = delivery.gitlab
  if (delivery.event === 'merge_request:merged' && gitlab?.target.kind === 'merge_request') return 'pull_request_merged'
  if (delivery.event === 'issues:closed' && gitlab?.target.kind === 'issue') return 'issue_closed'
  return undefined
}

function effectLease(agentId: string, target: CodeHostReplyTarget, host: GitlabTurnFinalHost): CodeHostEffectLease {
  return {
    token: async () => (await host.getGitlabPostToken(agentId, target.repo, target.hookId)).token,
    invalidateToken: (presented) => host.invalidateGitlabPost(agentId, target.repo, presented),
    // §24.4: the instance this agent's spec names, read when the note is actually posted.
    apiBaseUrl: () => gitlabApiBaseUrl(host.gitlabHostFor(agentId))
  }
}

function finalPoster(target: CodeHostReplyTarget, deps: CodeHostFinalPosterDeps): CodeHostFinalPoster {
  return new GitlabFinalPoster(
    {
      token: deps.token,
      invalidateToken: deps.invalidateToken,
      apiBaseUrl: deps.apiBaseUrl,
      log: deps.log
    },
    target.repo,
    target.subjectKind ?? 'issue',
    target.number,
    deps.attribution
  )
}

export const gitlabTurnFinal: CodeHostTurnFinal<'gitlab'> = {
  provider: 'gitlab',
  replyTarget,
  hostFence,
  worktreeCleanup,
  effectLease,
  finalPoster,
  reportsAbsentOutput: true
}
