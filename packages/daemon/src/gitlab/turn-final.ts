// GitLab's note target, instance-bound grant and turn-start host fence (§6.5, §14.1, §24.4).
import { GITLAB_DEFAULT_BASE_URL, type RdMsgHook } from '@agentconnect.md/protocol'
import type {
  CodeHostDelivery,
  CodeHostReplySource,
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
import { PULL_CONTEXT_COMMIT_LIMIT, readPullRequestContext, webhookPullRevision } from '../codehost/pull-context.js'
import { diffLineCounts, PULL_CONTEXT_FILE_LIMIT } from '../codehost/pull-files.js'

/** What GitLab's members read back on the daemon: the §14.1 effect lease, and the instance its spec names. */
export interface GitlabTurnFinalHost {
  /** The binding's effect PAT, gated by the enabled gitlab hook. */
  getGitlabPostToken(agentId: string, projectId: string, hookId: string): Promise<{ token: string }>
  invalidateGitlabPost(agentId: string, projectId: string, presentedToken?: string): void
  /** The instance this agent's spec is bound to; absent means GitLab.com (§24.4). */
  gitlabHostFor(agentId: string): string | undefined
  log: { warn: (message: string) => void }
}

/** §14.1 rides the same pipe as GitHub: `repo` is the numeric project id and `number` the subject IID; pushes and releases have no thread and stay silent. */
function replyTarget(msg: CodeHostReplySource): CodeHostReplyTarget | undefined {
  const gitlab = msg.gitlab
  if (!gitlab || gitlab.target.kind === 'push' || gitlab.target.kind === 'release') return undefined
  return {
    hookId: msg.hookId,
    provider: 'gitlab',
    host: gitlab.host ?? GITLAB_DEFAULT_BASE_URL,
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
    token: async () => {
      if (target.host && target.host !== (host.gitlabHostFor(agentId) ?? GITLAB_DEFAULT_BASE_URL)) {
        throw new Error(GITLAB_HOST_MISMATCH_REASON)
      }
      return (await host.getGitlabPostToken(agentId, target.repo, target.hookId)).token
    },
    invalidateToken: (presented) => host.invalidateGitlabPost(agentId, target.repo, presented),
    // Keep a persisted parent's destination pinned even if its spec changes during the lease request.
    apiBaseUrl: () => gitlabApiBaseUrl(target.host ?? host.gitlabHostFor(agentId))
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
  pullRequestContext: async (source, agentId, host, signal) => {
    if (source.gitlab?.target.kind !== 'merge_request') return undefined
    const target = replyTarget(source)!
    const path = `/projects/${encodeURIComponent(target.repo)}/merge_requests/${target.number}`
    return readPullRequestContext(
      effectLease(agentId, target, host),
      {
        description: path,
        descriptionField: 'description',
        baseShaPath: ['diff_refs', 'base_sha'],
        headShaPaths: [['sha'], ['diff_refs', 'head_sha']],
        commits: `${path}/commits?per_page=${PULL_CONTEXT_COMMIT_LIMIT}&page=1`,
        commitMessagePath: ['message'],
        files: `${path}/diffs?per_page=${PULL_CONTEXT_FILE_LIMIT}&page=1`,
        fileCountPath: ['changes_count'],
        file: (row) => {
          if (typeof row.new_path !== 'string' || !row.new_path) return undefined
          const diff = typeof row.diff === 'string' ? row.diff : undefined
          const truncated = row.collapsed === true || row.too_large === true
          return {
            path: row.new_path,
            ...(typeof row.old_path === 'string' && row.old_path !== row.new_path
              ? { previousPath: row.old_path }
              : {}),
            status: row.deleted_file ? 'deleted' : row.new_file ? 'added' : row.renamed_file ? 'renamed' : 'modified',
            ...(diff !== undefined && !truncated ? diffLineCounts(diff) : {}),
            diff: diff ?? '',
            diffTruncated: truncated,
            ...(diff === undefined || (truncated && !diff) ? { diffUnavailable: true as const } : {})
          }
        },
        revision: webhookPullRevision(source)
      },
      signal
    )
  },
  reportsAbsentOutput: true
}
