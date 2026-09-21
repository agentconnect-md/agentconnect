'use client'

import { useTranslations } from 'next-intl'
import { CodeHostReviewSettings, ReviewNotice } from '@/components/console/CodeHostReviewSettings'
import type { CodeHostReviewSettingsValue, HookReportingMode, HookReviewPolicy } from '@/lib/code-host-review-settings'

// GitLab's half of the review disclosure. No access clamp on purpose: the project bot writes both
// effects under its provisioned role, so the only precondition is that the project has a bot.
export function GitlabReviewSettings({
  value,
  onReviewPolicyChange,
  onReportingModeChange,
  projectBotReady = true,
  layout = 'disclosure',
  defaultExpanded = false
}: {
  value: CodeHostReviewSettingsValue
  onReviewPolicyChange: (policy: HookReviewPolicy) => void
  onReportingModeChange: (mode: HookReportingMode) => void
  projectBotReady?: boolean
  layout?: 'disclosure' | 'format'
  defaultExpanded?: boolean
}) {
  const t = useTranslations('Integrations.dialog.codeHostReview.gitlab')
  const botMissing = !projectBotReady && (value.reviewPolicy !== 'off' || value.reportingMode === 'check')
  return (
    <CodeHostReviewSettings
      title={t('title')}
      value={value}
      onReviewPolicyChange={onReviewPolicyChange}
      onReportingModeChange={onReportingModeChange}
      layout={layout}
      defaultExpanded={defaultExpanded}
      statusCheckLabel={t('statusCheckLabel')}
      help={{
        inlineComments: t('helpInlineComments'),
        requestChanges: t('helpRequestChanges'),
        approve: t('helpApprove'),
        statusCheck: t('helpStatusCheck')
      }}
      notices={
        botMissing ? (
          <ReviewNotice icon="triangle-alert" tone="error">
            {t('botMissing')}
          </ReviewNotice>
        ) : undefined
      }
    />
  )
}
