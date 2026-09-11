/**
 * Gitea's turn-start acknowledgement (gitea-integration.md §10.1): the `eyes` reaction on the comment
 * that fired the turn, or on the subject when the subject itself did, placed only after the instance's
 * allowed-reaction list says it offers one. Gitea refuses a reaction outside that list with HTTP 403
 * and `'<name>' is not an allowed reaction`, which this adapter reads as "no reaction", never as a
 * credential fault; repeating a reaction the bot already left answers 200, so a redelivery is safe.
 */
import type { CodeHostAckAdapter } from '../codehost/ack.js'
import { giteaRepoPath } from './api.js'
import { forgetGiteaReactions, giteaReactionAllowed } from './reactions.js'

const REACTION = 'eyes'

export const giteaAck: CodeHostAckAdapter = {
  provider: 'gitea',
  permits: (apiBaseUrl, token, fetchImpl, signal) =>
    giteaReactionAllowed({ apiBaseUrl, token, fetchImpl, signal }, REACTION),
  request(target, token, apiBaseUrl) {
    // The issue-comment reaction path takes an inline review comment id too, so one comment path serves every comment.
    const repo = giteaRepoPath(target.repoPath ?? '')
    const path = target.triggerComment
      ? `${repo}/issues/comments/${target.triggerComment.id}/reactions`
      : `${repo}/issues/${target.number}/reactions`
    return {
      url: `${apiBaseUrl}${path}`,
      init: {
        method: 'POST',
        headers: { authorization: `token ${token}`, accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ content: REACTION })
      }
    }
  },
  declined(status, body, apiBaseUrl) {
    if (status !== 403 || !/is not an allowed reaction/.test(body)) return false
    // The remembered list was stale; the next acknowledgement re-reads it.
    forgetGiteaReactions(apiBaseUrl)
    return true
  }
}
