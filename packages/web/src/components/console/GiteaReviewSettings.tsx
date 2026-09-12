'use client'

import { CodeHostReviewSettings, ReviewNotice } from '@/components/console/CodeHostReviewSettings'
import type { CodeHostReviewSettingsValue, HookReportingMode, HookReviewPolicy } from '@/lib/code-host-review-settings'

// Gitea's half of the review disclosure (gitea-integration.md §10.3, §10.4). No access clamp, for
// the same reason GitLab has none: the organization's bot writes both effects under the Admin it
// already holds on the repository, so the only precondition is that the repository is set up.
export function GiteaReviewSettings({
  value,
  onReviewPolicyChange,
  onReportingModeChange,
  repositoryReady = true,
  layout = 'disclosure',
  defaultExpanded = false
}: {
  value: CodeHostReviewSettingsValue
  onReviewPolicyChange: (policy: HookReviewPolicy) => void
  onReportingModeChange: (mode: HookReportingMode) => void
  repositoryReady?: boolean
  layout?: 'disclosure' | 'format'
  defaultExpanded?: boolean
}) {
  const repositoryMissing = !repositoryReady && (value.reviewPolicy !== 'off' || value.reportingMode !== 'off')
  return (
    <CodeHostReviewSettings
      title="PR review"
      value={value}
      onReviewPolicyChange={onReviewPolicyChange}
      onReportingModeChange={onReportingModeChange}
      layout={layout}
      defaultExpanded={defaultExpanded}
      statusCheckLabel="Commit status"
      statusMode="status"
      help={{
        inlineComments:
          'Submit formal COMMENT reviews with optional comments on specific changed lines. Gitea takes one comment per line, never a range.',
        requestChanges: 'Allow formal REQUEST_CHANGES reviews. Gitea records them with no further precondition.',
        approve:
          'Allow the bot to record an approval in the same review. Gitea refuses one on a pull request the bot opened itself.',
        statusCheck:
          'Post one commit status on the pull request’s head for queued, running, and final results. It does not block merging unless an operator makes it a required check.'
      }}
      notices={
        repositoryMissing ? (
          <ReviewNotice icon="triangle-alert" tone="error">
            This repository is still being set up. Reviews and commit statuses are written through the
            organization&rsquo;s Gitea bot, so finish adding the repository first.
          </ReviewNotice>
        ) : undefined
      }
    />
  )
}
