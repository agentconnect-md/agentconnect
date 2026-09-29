import { RcCodeHostFeedback, type RcCodeHostFeedbackWatch } from '@agentconnect.md/protocol'
import type { GiteaPayload } from './gitea/events.js'
import type { GitlabPayload } from './gitlab-ingress.js'

type Watch = RcCodeHostFeedbackWatch & { watch: NonNullable<RcCodeHostFeedbackWatch['watch']> }

function signal(watch: Watch, deliveryKey: string, facts: Partial<RcCodeHostFeedback>): RcCodeHostFeedback | undefined {
  const parsed = RcCodeHostFeedback.safeParse({
    provider: watch.provider,
    repoId: watch.repoId,
    orgId: watch.watch.orgId,
    bindingId: watch.watch.bindingId,
    host: watch.watch.host,
    deliveryKey,
    ...facts
  })
  return parsed.success ? parsed.data : undefined
}

export function gitlabFeedback(
  watch: Watch,
  deliveryKey: string,
  payload: GitlabPayload
): RcCodeHostFeedback | undefined {
  const attrs = payload.object_attributes
  if (
    payload.object_kind === 'note' &&
    attrs?.noteable_type === 'MergeRequest' &&
    !attrs.system &&
    (!attrs.action || ['create', 'update'].includes(attrs.action)) &&
    attrs.note?.trim()
  ) {
    return signal(watch, deliveryKey, {
      kind: 'comment',
      pullNumber: payload.merge_request?.iid,
      ...(payload.user?.id ? { actorId: String(payload.user.id) } : {})
    })
  }
  if (payload.object_kind === 'pipeline' && attrs?.status === 'failed') {
    return signal(watch, deliveryKey, { kind: 'ci', headSha: attrs.sha, pullNumber: payload.merge_request?.iid })
  }
  return undefined
}

export function giteaFeedback(
  watch: Watch,
  deliveryKey: string,
  event: string,
  payload: GiteaPayload
): RcCodeHostFeedback | undefined {
  const review = [
    'pull_request_review_comment',
    'pull_request_review_approved',
    'pull_request_review_rejected'
  ].includes(event)
  const comment =
    ['issue_comment', 'pull_request_comment'].includes(event) &&
    payload.is_pull === true &&
    ['created', 'edited'].includes(payload.action ?? '') &&
    !!payload.comment?.body?.trim()
  if (comment || (review && (event === 'pull_request_review_rejected' || payload.review?.content?.trim()))) {
    const actor = review ? (payload.requested_reviewer ?? payload.sender) : payload.sender
    return signal(watch, deliveryKey, {
      kind: 'comment',
      pullNumber: payload.pull_request?.number ?? payload.issue?.number,
      ...(actor?.id ? { actorId: String(actor.id) } : {}),
      actorUsername: actor?.login ?? actor?.username
    })
  }
  if (
    event === 'status' &&
    ['failure', 'error'].includes(payload.state ?? '') &&
    !payload.context?.toLowerCase().startsWith('agentconnect')
  ) {
    return signal(watch, deliveryKey, { kind: 'ci', headSha: payload.sha })
  }
  if (event === 'workflow_run' && payload.action === 'completed' && payload.workflow_run?.conclusion === 'failure') {
    return signal(watch, deliveryKey, {
      kind: 'ci',
      headSha: payload.workflow_run.head_sha,
      pullNumber: payload.pull_request?.number
    })
  }
  return undefined
}
