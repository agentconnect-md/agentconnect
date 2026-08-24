'use client'

import { CodeHostReviewSettings, ReviewNotice } from '@/components/console/CodeHostReviewSettings'
import type { CodeHostReviewSettingsValue, HookReportingMode, HookReviewPolicy } from '@/lib/code-host-review-settings'

// GitLab's half of the review disclosure. No access clamp on purpose: the project bot writes both
// effects under its provisioned role, so the only precondition is that the project has a bot.
export function GitlabReviewSettings({
  value,
  onReviewPolicyChange,
  onReportingModeChange,
  projectBotReady = true,
  defaultExpanded = false
}: {
  value: CodeHostReviewSettingsValue
  onReviewPolicyChange: (policy: HookReviewPolicy) => void
  onReportingModeChange: (mode: HookReportingMode) => void
  projectBotReady?: boolean
  defaultExpanded?: boolean
}) {
  const botMissing = !projectBotReady && (value.reviewPolicy !== 'off' || value.reportingMode === 'check')
  return (
    <CodeHostReviewSettings
      title="MR review"
      value={value}
      onReviewPolicyChange={onReviewPolicyChange}
      onReportingModeChange={onReportingModeChange}
      defaultExpanded={defaultExpanded}
      statusCheckLabel="Run note"
      help={{
        inlineComments: 'Submit formal COMMENT reviews with optional comments on specific changed lines.',
        requestChanges:
          'Allow formal REQUEST_CHANGES reviews. GitLab records them only while the project bot is a current reviewer — otherwise the finding is recorded as a COMMENT that does not pass.',
        approve:
          'Allow the project bot to record an approval. That is a separate act from a review, and project rules may still refuse it.',
        statusCheck:
          'Post one status note on the merge request for queued, running, and final results. It does not block merging.'
      }}
      notices={
        botMissing ? (
          <ReviewNotice icon="triangle-alert" tone="error">
            This project is still being set up. Reviews and run notes are posted by the agent’s own bot account, so
            finish connecting the project first.
          </ReviewNotice>
        ) : undefined
      }
    />
  )
}
