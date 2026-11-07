// Azure DevOps has no hooks in v1 (azure-devops-integration.md §11): every admission member declines.
import { azureDevOpsNotImplemented } from './not-implemented.js'
import type { CodeHostHookAdmission } from '../codehost/hook-admission.js'
import type { GithubReviewBatchItem } from '../github/hook-coords.js'

export const azureDevOpsHookAdmission: CodeHostHookAdmission = {
  provider: 'azure-devops',
  reviewSubjectLane: () => undefined,
  revisionStream: () => undefined,
  rerunsCurrentRevision: () => false,
  reviewBatchStream: () => undefined,
  openReviewBatch: () => undefined,
  batchItemKey: (item: GithubReviewBatchItem) => item.deliveryKey,
  // Unreachable: a batch exists only where `openReviewBatch` opened one, and this one opens none.
  renderBatchPrompt: () => azureDevOpsNotImplemented('comment batch prompts'),
  batchPublishesItems: false
}
