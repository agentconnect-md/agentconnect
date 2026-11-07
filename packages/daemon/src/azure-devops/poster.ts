// Azure DevOps final-answer poster (azure-devops-integration.md §11.5): a comment trigger is answered in its own thread, any other opens one, under the `azure_devops_hook_reply` lease.
import type { GithubCommentAttributionSource } from '../github/poster.js'
import { CodeHostCommentPoster, type CommentPosterDeps } from '../codehost/comment-poster.js'
import { azureDevOpsHeaders, azureDevOpsUrl } from './api.js'

/** A text comment. */
const TEXT = 1
/** A thread opens active. */
const ACTIVE = 1
/** A thread's first comment, the parent a reply falls back to. */
const FIRST_COMMENT = 1

export type AzureDevOpsFinalPosterDeps = CommentPosterDeps

/** Where one turn's answer goes: a new thread on the pull request, or a reply in the triggering comment's thread. */
export interface AzureDevOpsReplyPlace {
  /** The surrogate repository id — the lease scope and the log identity. */
  repoId: string
  pullRequestId: number
  threadId?: string
  /** The comment the reply answers; absent ⇒ the thread's first. */
  parentCommentId?: string
}

export class AzureDevOpsFinalPoster extends CodeHostCommentPoster {
  constructor(
    deps: AzureDevOpsFinalPosterDeps,
    place: AzureDevOpsReplyPlace,
    attribution?: GithubCommentAttributionSource
  ) {
    const pull = `/pullRequests/${place.pullRequestId}`
    const thread = place.threadId
    super(
      deps,
      {
        provider: 'azure-devops',
        target: `azure-devops:${place.repoId} !${place.pullRequestId}${thread ? ` thread ${thread}` : ''}`,
        request: (apiBaseUrl, token, content) => ({
          url: azureDevOpsUrl(apiBaseUrl, thread ? `${pull}/threads/${thread}/comments` : `${pull}/threads`),
          init: {
            method: 'POST',
            headers: azureDevOpsHeaders(token, true),
            body: JSON.stringify(
              thread
                ? { parentCommentId: Number(place.parentCommentId ?? FIRST_COMMENT), content, commentType: TEXT }
                : { comments: [{ parentCommentId: 0, content, commentType: TEXT }], status: ACTIVE }
            )
          }
        }),
        // A created thread answers its own id; a reply answers the comment's, so the thread it went into is what is reported.
        published: (externalId) => ({ provider: 'azure-devops', kind: 'thread', externalId: thread ?? externalId })
      },
      attribution
    )
  }
}
