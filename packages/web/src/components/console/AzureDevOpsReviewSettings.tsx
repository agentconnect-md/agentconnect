'use client'

import { useTranslations } from 'next-intl'
import { CodeHostReviewSettings } from '@/components/console/CodeHostReviewSettings'
import type { CodeHostReviewSettingsValue, HookReportingMode, HookReviewPolicy } from '@/lib/code-host-review-settings'

// Azure DevOps's half of the review disclosure (azure-devops-integration.md §11.6, §11.7): a vote plus threads, and a pull-request status.
export function AzureDevOpsReviewSettings({
  value,
  onReviewPolicyChange,
  onReportingModeChange,
  layout = 'disclosure',
  defaultExpanded = false
}: {
  value: CodeHostReviewSettingsValue
  onReviewPolicyChange: (policy: HookReviewPolicy) => void
  onReportingModeChange: (mode: HookReportingMode) => void
  layout?: 'disclosure' | 'format'
  defaultExpanded?: boolean
}) {
  const t = useTranslations('Integrations.dialog.codeHostReview.azureDevOps')
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
    />
  )
}
