/**
 * Gitea's entry in the daemon hook-admission seam (gitea-integration.md §8, §16).
 *
 * Admission is the provider-neutral seam's, and Gitea's members of it are G4's. Until then every
 * member declines: a delivery opens no lane, contests no generation and coalesces with nothing, so
 * nothing it could do is done by another host's rules. Declining is also the honest answer — no
 * Gitea delivery exists to admit, because the relay serves no Gitea ingress until G3.
 */
import { giteaNotImplemented } from './not-implemented.js'
import type { CodeHostHookAdmission } from '../codehost/hook-admission.js'
import type { GithubReviewBatchItem } from '../github/hook-coords.js'

export const giteaHookAdmission: CodeHostHookAdmission = {
  provider: 'gitea',
  reviewSubjectLane: () => undefined,
  revisionStream: () => undefined,
  rerunsCurrentRevision: () => false,
  reviewBatchStream: () => undefined,
  openReviewBatch: () => undefined,
  batchItemKey: (item: GithubReviewBatchItem) => item.deliveryKey,
  // Unreachable: a batch exists only where `openReviewBatch` opened one, and this one opens none.
  renderBatchPrompt: () => giteaNotImplemented('comment batch prompts'),
  batchPublishesItems: false
}
