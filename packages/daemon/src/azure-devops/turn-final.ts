// Azure DevOps's reply target, hook-reply lease, turn-start read and lifecycle pairing (azure-devops-integration.md §11.4, §11.5).
import type { AzureDevOpsHookMetadata, RdMsgHook } from '@agentconnect.md/protocol'
import type {
  CodeHostDelivery,
  CodeHostEffectLease,
  CodeHostFinalPoster,
  CodeHostFinalPosterDeps,
  CodeHostReplySource,
  CodeHostResolvedDelivery,
  CodeHostThreadWorktreeCleanup,
  CodeHostTurnFinal
} from '../codehost/turn-final.js'
import type { CodeHostReplyTarget } from '../codehost/reply-target.js'
import { AzureDevOpsRequestError, azureDevOpsRepositoryApi } from './api.js'
import {
  AZURE_DEVOPS_CLOSED_EVENT,
  AZURE_DEVOPS_IGNORED_EVENTS,
  AZURE_DEVOPS_MERGED_EVENT,
  AZURE_DEVOPS_REOPENED_EVENT,
  AZURE_DEVOPS_REVIEW_REQUESTED_EVENT,
  AZURE_DEVOPS_REVIEWERS_UPDATED_EVENT,
  AZURE_DEVOPS_STATE_CHANGED_EVENT
} from './events.js'
import { AzureDevOpsFinalPoster } from './poster.js'
import { readAzureDevOpsPull, type AzureDevOpsPullRead } from './pull-read.js'

/** What Azure DevOps's members read back on the daemon: the §11.5 hook-reply lease. */
export interface AzureDevOpsTurnFinalHost {
  /** The connection's token at `comment`, gated by the enabled hook; the user name is the connection identity's id. */
  getAzureDevOpsPostLease(agentId: string, repoId: string, hookId: string): Promise<{ token: string; username: string }>
  invalidateAzureDevOpsPost(agentId: string, repoId: string, presentedToken?: string): void
  log: { warn: (message: string) => void }
}

/** The refusal an update kind takes when the read it is classified on fails. */
export const AZURE_DEVOPS_READ_FAILED = 'azure_devops_read_failed'

/** The whole read must not hold the relay's ack open for long. */
const READ_TIMEOUT_MS = 10_000

/** A repository's API root as a reply target pins it; anything else is refused, so a token never leaves for another host. */
const REPOSITORY_API =
  /^https:\/\/dev\.azure\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/_apis\/git\/repositories\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The REST root a target names; throws for one that is not exactly a repository's. */
export function azureDevOpsTargetApi(target: Pick<CodeHostReplyTarget, 'host'>): string {
  if (!target.host || !REPOSITORY_API.test(target.host))
    throw new Error('azure-devops reply target names no repository')
  return target.host
}

/** A pull request answers on its own; a push has no thread and stays silent. The thread a comment fired in rides as the thread root. */
function replyTarget(msg: CodeHostReplySource): CodeHostReplyTarget | undefined {
  const azure = msg.azureDevOps
  if (!azure || azure.target.kind !== 'pull') return undefined
  return {
    hookId: msg.hookId,
    provider: 'azure-devops',
    host: azureDevOpsRepositoryApi(azure),
    subjectKind: 'merge_request',
    repo: azure.repoId,
    repoPath: azure.repoPath,
    number: azure.target.pullRequestId,
    ...(azure.threadId ? { reviewThreadRootCommentId: azure.threadId } : {}),
    ...(azure.threadId && azure.commentId ? { triggerComment: { kind: 'note' as const, id: azure.commentId } } : {})
  }
}

/** The maintenance family: a completed pull request and an abandoned one retire the per-thread checkout. */
function worktreeCleanup(delivery: CodeHostDelivery): CodeHostThreadWorktreeCleanup | undefined {
  if (delivery.azureDevOps?.target.kind !== 'pull') return undefined
  if (delivery.event === AZURE_DEVOPS_MERGED_EVENT) return 'pull_request_merged'
  if (delivery.event === AZURE_DEVOPS_CLOSED_EVENT) return 'pull_request_closed'
  return undefined
}

function ignoredReason(delivery: CodeHostDelivery): string | undefined {
  return delivery.azureDevOps && delivery.event !== undefined
    ? AZURE_DEVOPS_IGNORED_EVENTS.get(delivery.event)
    : undefined
}

function effectLease(
  agentId: string,
  target: CodeHostReplyTarget,
  host: AzureDevOpsTurnFinalHost
): CodeHostEffectLease {
  return {
    token: async () => (await host.getAzureDevOpsPostLease(agentId, target.repo, target.hookId)).token,
    invalidateToken: (presented) => host.invalidateAzureDevOpsPost(agentId, target.repo, presented),
    apiBaseUrl: () => azureDevOpsTargetApi(target)
  }
}

function finalPoster(target: CodeHostReplyTarget, deps: CodeHostFinalPosterDeps): CodeHostFinalPoster {
  return new AzureDevOpsFinalPoster(
    { token: deps.token, invalidateToken: deps.invalidateToken, apiBaseUrl: deps.apiBaseUrl, log: deps.log },
    {
      repoId: target.repo,
      pullRequestId: target.number,
      ...(target.reviewThreadRootCommentId ? { threadId: target.reviewThreadRootCommentId } : {}),
      ...(target.triggerComment ? { parentCommentId: target.triggerComment.id } : {})
    },
    deps.attribution
  )
}

/** Read under the hook-reply lease; one re-mint after a definite rejection. */
async function readUnderLease(
  msg: RdMsgHook,
  azure: AzureDevOpsHookMetadata,
  pullRequestId: number,
  host: AzureDevOpsTurnFinalHost,
  fetchImpl?: typeof fetch
): Promise<AzureDevOpsPullRead> {
  const signal = AbortSignal.timeout(READ_TIMEOUT_MS)
  for (let attempt = 0; ; attempt += 1) {
    const lease = await host.getAzureDevOpsPostLease(msg.agentId, azure.repoId, msg.hookId)
    try {
      return await readAzureDevOpsPull(
        {
          apiBaseUrl: azureDevOpsRepositoryApi(azure),
          token: lease.token,
          signal,
          ...(fetchImpl ? { fetchImpl } : {})
        },
        {
          pullRequestId,
          identityId: lease.username,
          ...(azure.deliveryKind === 'comment' && azure.threadId ? { threadId: azure.threadId } : {}),
          ...(azure.deliveryKind === 'comment' && azure.commentId ? { commentId: azure.commentId } : {})
        }
      )
    } catch (err) {
      if (attempt > 0 || !(err instanceof AzureDevOpsRequestError) || !err.authRejected) throw err
      host.invalidateAzureDevOpsPost(msg.agentId, azure.repoId, lease.token)
    }
  }
}

/** §11.4: an update kind is what the read finds, never what the body said; a status change no rule turns into a turn is left to be ignored. */
function classify(
  azure: AzureDevOpsHookMetadata,
  event: string | undefined,
  read: AzureDevOpsPullRead
): string | undefined {
  const status = read.pull.status
  if (azure.deliveryKind === 'reviewers') {
    return status === 'active' && read.reviewRequested
      ? AZURE_DEVOPS_REVIEW_REQUESTED_EVENT
      : AZURE_DEVOPS_REVIEWERS_UPDATED_EVENT
  }
  // "Merge attempted" fires on every merge check, opening included: only a completed pull request is a merge.
  if (azure.deliveryKind === 'merged')
    return status === 'completed' ? AZURE_DEVOPS_MERGED_EVENT : AZURE_DEVOPS_STATE_CHANGED_EVENT
  if (azure.deliveryKind !== 'state') return event
  if (status === 'completed') return AZURE_DEVOPS_MERGED_EVENT
  if (status === 'abandoned') return AZURE_DEVOPS_CLOSED_EVENT
  const reopens = status === 'active' && azure.target.kind === 'pull' && azure.target.admitsReopened === true
  return reopens ? AZURE_DEVOPS_REOPENED_EVENT : AZURE_DEVOPS_STATE_CHANGED_EVENT
}

/** The turn-start read: classify an update kind, fence the head on the newest iteration, and hand the prompt what was read. */
export async function resolveAzureDevOpsDelivery(
  msg: RdMsgHook,
  host: AzureDevOpsTurnFinalHost,
  fetchImpl?: typeof fetch
): Promise<CodeHostResolvedDelivery | undefined> {
  const azure = msg.azureDevOps
  // A push has no pull request to read.
  if (!azure || azure.target.kind !== 'pull') return undefined
  // The update kinds need the read: four to classify, and a revision for the head its lane and supersession key on.
  const needsRead =
    azure.deliveryKind === 'reviewers' ||
    azure.deliveryKind === 'state' ||
    azure.deliveryKind === 'merged' ||
    azure.deliveryKind === 'revision'
  let read: AzureDevOpsPullRead
  try {
    read = await readUnderLease(msg, azure, azure.target.pullRequestId, host, fetchImpl)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    host.log.warn(`hook: azure-devops read for ${msg.msgId} failed (${reason})`)
    if (needsRead) return { refused: AZURE_DEVOPS_READ_FAILED }
    return { msg, supplement: { azureDevOps: { kind: 'unavailable', reason } } }
  }
  const event = classify(azure, msg.event, read)
  const { headSha, isDraft, title } = read.pull
  if (azure.deliveryKind === 'revision' && !headSha) return { refused: AZURE_DEVOPS_READ_FAILED }
  const target = {
    ...azure.target,
    ...(headSha ? { headSha } : {}),
    ...(isDraft !== undefined ? { isDraft } : {})
  }
  const c = msg.context
  const colon = event?.indexOf(':') ?? -1
  const context = c && {
    ...c,
    ...(event !== msg.event && colon !== -1 ? { action: event!.slice(colon + 1) } : {}),
    ...(!c.title && title ? { title } : {})
  }
  return {
    msg: {
      ...msg,
      ...(event !== undefined ? { event } : {}),
      azureDevOps: { ...azure, target },
      ...(context ? { context } : {})
    },
    supplement: { azureDevOps: { kind: 'read', pull: read.pull } }
  }
}

export const azureDevOpsTurnFinal: CodeHostTurnFinal<'azure-devops'> = {
  provider: 'azure-devops',
  replyTarget,
  // One fixed host: there is no instance for a delivery to disagree with.
  hostFence: () => undefined,
  worktreeCleanup,
  ignoredReason,
  effectLease,
  finalPoster,
  resolveDelivery: (msg, host) => resolveAzureDevOpsDelivery(msg, host),
  // Decision routing is not offered for Azure DevOps, so nothing reads a pull request's context for one.
  pullRequestContext: async () => undefined,
  reportsAbsentOutput: true
}
