// Azure DevOps's turn-start acknowledgement (azure-devops-integration.md §11.5): a like on the comment that fired the turn; a pull request has no reaction of its own, so other triggers get none.
import type { CodeHostAckAdapter } from '../codehost/ack.js'
import { azureDevOpsHeaders, azureDevOpsUrl } from './api.js'

export const azureDevOpsAck: CodeHostAckAdapter = {
  provider: 'azure-devops',
  applies: (target) => target.reviewThreadRootCommentId !== undefined && target.triggerComment !== undefined,
  request(target, token, apiBaseUrl) {
    const thread = target.reviewThreadRootCommentId ?? ''
    const comment = target.triggerComment?.id ?? ''
    return {
      // A like takes no body and answers 200; liking twice is the same like.
      url: azureDevOpsUrl(apiBaseUrl, `/pullRequests/${target.number}/threads/${thread}/comments/${comment}/likes`),
      init: { method: 'POST', headers: azureDevOpsHeaders(token, false) }
    }
  }
}
