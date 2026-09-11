// GitLab final-answer poster (gitlab-com-integration.md 14.1): one note per completed turn as the project service account.
// The single-writer contract, the publish barrier, and the one auth retry are the shared comment poster's (codehost/comment-poster.ts).
import type { GithubCommentAttributionSource } from '../github/poster.js'
import {
  CodeHostCommentPoster,
  type CommentPosterDeps,
  type CommentPublishFailure
} from '../codehost/comment-poster.js'

/** The bounded absence vocabulary is shared by every note-shaped host; the name survives for its consumers. */
export type GitlabPublishFailure = CommentPublishFailure

export type GitlabFinalPosterDeps = CommentPosterDeps

export class GitlabFinalPoster extends CodeHostCommentPoster {
  constructor(
    deps: GitlabFinalPosterDeps,
    /** Numeric project id (decimal string) — the rename-stable API target. */
    projectId: string,
    subjectKind: 'issue' | 'merge_request',
    iid: number,
    attribution?: GithubCommentAttributionSource
  ) {
    const family = subjectKind === 'issue' ? 'issues' : 'merge_requests'
    super(
      deps,
      {
        provider: 'gitlab',
        target: `gitlab:${projectId} ${subjectKind === 'issue' ? '#' : '!'}${iid}`,
        request: (apiBaseUrl, token, body) => ({
          url: `${apiBaseUrl}/projects/${projectId}/${family}/${iid}/notes`,
          init: {
            method: 'POST',
            headers: { 'private-token': token, 'content-type': 'application/json' },
            body: JSON.stringify({ body })
          }
        }),
        published: (externalId) => ({ provider: 'gitlab', kind: 'note', externalId })
      },
      attribution
    )
  }
}
