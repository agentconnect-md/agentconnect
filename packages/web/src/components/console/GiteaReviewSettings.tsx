'use client'

import { useTranslations } from 'next-intl'
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
  const t = useTranslations('Integrations.dialog.codeHostReview.gitea')
  const repositoryMissing = !repositoryReady && (value.reviewPolicy !== 'off' || value.reportingMode !== 'off')
  return (
    <CodeHostReviewSettings
      title={t('title')}
      value={value}
      onReviewPolicyChange={onReviewPolicyChange}
      onReportingModeChange={onReportingModeChange}
      layout={layout}
      defaultExpanded={defaultExpanded}
      statusCheckLabel={t('statusCheckLabel')}
      statusMode="status"
      help={{
        inlineComments: t('helpInlineComments'),
        requestChanges: t('helpRequestChanges'),
        approve: t('helpApprove'),
        statusCheck: t('helpStatusCheck')
      }}
      notices={
        repositoryMissing ? (
          <ReviewNotice icon="triangle-alert" tone="error">
            {t('repositoryMissing')}
          </ReviewNotice>
        ) : undefined
      }
    />
  )
}
