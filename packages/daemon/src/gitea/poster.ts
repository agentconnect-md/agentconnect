// Gitea final-answer poster (gitea-integration.md §10.1): one comment per completed turn as the organization
// bot, through the issue-comments path that serves issues and pull requests alike, under the `gitea_hook_reply`
// lease. The single-writer contract, the publish barrier, and the one auth retry are the shared comment poster's.
import type { GithubCommentAttributionSource } from '../github/poster.js'
import { CodeHostCommentPoster, type CommentPosterDeps } from '../codehost/comment-poster.js'
import { giteaRepoPath } from './api.js'

export type GiteaFinalPosterDeps = CommentPosterDeps

export class GiteaFinalPoster extends CodeHostCommentPoster {
  constructor(
    deps: GiteaFinalPosterDeps,
    /** Numeric repository id (decimal string) — the lease scope and the rename-stable log identity. */
    repoId: string,
    /** The current `owner/repo` the REST path addresses, from the delivery's trusted metadata. */
    repoPath: string,
    index: number,
    attribution?: GithubCommentAttributionSource
  ) {
    super(
      deps,
      {
        provider: 'gitea',
        target: `gitea:${repoId} #${index}`,
        request: (apiBaseUrl, token, body) => ({
          url: `${apiBaseUrl}${giteaRepoPath(repoPath)}/issues/${index}/comments`,
          init: {
            method: 'POST',
            headers: {
              authorization: `token ${token}`,
              accept: 'application/json',
              'content-type': 'application/json'
            },
            body: JSON.stringify({ body })
          }
        }),
        published: (externalId) => ({ provider: 'gitea', kind: 'comment', externalId })
      },
      attribution
    )
  }
}
