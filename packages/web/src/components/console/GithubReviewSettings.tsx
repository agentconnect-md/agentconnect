'use client'

import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { CodeHostReviewSettings, ReviewNotice } from '@/components/console/CodeHostReviewSettings'
import {
  hasChecksWritePermission,
  hasPullRequestsReadPermission,
  hasPullRequestsWritePermission,
  repoAccessSatisfies,
  requiredRepoAccess,
  type EffectiveRepoAccess,
  type GithubReviewSettingsValue,
  type HookReportingMode,
  type HookReviewPolicy
} from '@/lib/github-review-settings'

interface InstallationPermissionView {
  permissionsStatus: 'current' | 'outdated' | 'unknown'
  pullRequestsPermission: 'read' | 'write' | 'missing' | 'unknown'
  checksPermission: 'write' | 'missing' | 'unknown'
  settingsUrl: string
}

export function GithubReviewSettings({
  value,
  onReviewPolicyChange,
  onReportingModeChange,
  repoAccess,
  installation,
  publicRepo = false,
  repoSelected = true,
  layout = 'disclosure',
  defaultExpanded = false,
  canAuthorizeRepo = false,
  authorizingRepo = false,
  onAuthorizeRepo
}: {
  value: GithubReviewSettingsValue
  onReviewPolicyChange: (policy: HookReviewPolicy) => void
  onReportingModeChange: (mode: HookReportingMode) => void
  repoAccess: EffectiveRepoAccess
  installation?: InstallationPermissionView
  publicRepo?: boolean
  repoSelected?: boolean
  layout?: 'disclosure' | 'format'
  defaultExpanded?: boolean
  canAuthorizeRepo?: boolean
  authorizingRepo?: boolean
  onAuthorizeRepo?: () => void
}) {
  const t = useTranslations('Integrations.dialog.codeHostReview.github')
  const needed = requiredRepoAccess(value)
  const accessBlocked = repoSelected && !repoAccessSatisfies(repoAccess, needed)
  const hasExactChecksWritePermission = hasChecksWritePermission(installation)
  const hasExactPullRequestsReadPermission = hasPullRequestsReadPermission(installation)
  const reviewPermissionBlocked =
    repoSelected && !accessBlocked && value.reviewPolicy !== 'off' && !hasPullRequestsWritePermission(installation)
  const checkPermissionBlocked =
    repoSelected &&
    !accessBlocked &&
    value.reportingMode === 'check' &&
    (!hasExactChecksWritePermission || !hasExactPullRequestsReadPermission)
  const hasPendingPermissionUpgrade = installation?.permissionsStatus === 'outdated'
  const blocked = accessBlocked || reviewPermissionBlocked || checkPermissionBlocked

  const approveHelp = publicRepo ? t('helpApprovePublic') : t('helpApprove')

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
        approve: approveHelp,
        statusCheck: t('helpStatusCheck')
      }}
      notices={
        <>
          {accessBlocked && (
            <ReviewNotice
              icon="lock"
              tone="error"
              action={
                canAuthorizeRepo && onAuthorizeRepo ? (
                  <button
                    type="button"
                    onClick={onAuthorizeRepo}
                    disabled={authorizingRepo}
                    className="flex-none rounded-sm border border-(--status-error) px-2 py-[5px] font-sans text-[11.5px] font-semibold leading-normal disabled:cursor-default disabled:opacity-60"
                  >
                    {authorizingRepo
                      ? t('authorizing')
                      : repoAccess === 'none'
                        ? t('authorizeRepo')
                        : t('upgradeAccess')}
                  </button>
                ) : undefined
              }
            >
              {t('accessNeeded', { needed, repoAccess })}
            </ReviewNotice>
          )}
          {reviewPermissionBlocked && (
            <ReviewNotice icon="triangle-alert" tone="error">
              {installation?.pullRequestsPermission === 'missing'
                ? t('reviewPermissionMissing')
                : installation?.pullRequestsPermission === 'read'
                  ? t('reviewPermissionReadOnly')
                  : t('reviewPermissionUnconfirmed')}
              {installation?.settingsUrl && (
                <>
                  {' '}
                  <a
                    href={installation.settingsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="lnk text-[12px]"
                  >
                    {t('reviewPermissions')}
                    <Icon name="external-link" size={12} />
                  </a>
                </>
              )}
            </ReviewNotice>
          )}

          {checkPermissionBlocked && (
            <ReviewNotice icon="triangle-alert" tone="error">
              {!hasExactChecksWritePermission
                ? installation?.checksPermission === 'missing'
                  ? t('checksPermissionMissing')
                  : t('checksPermissionUnconfirmed')
                : installation?.pullRequestsPermission === 'missing'
                  ? t('readPermissionMissing')
                  : t('readPermissionUnconfirmed')}
              {installation?.settingsUrl && (
                <>
                  {' '}
                  <a
                    href={installation.settingsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="lnk text-[12px]"
                  >
                    {t('updatePermissions')}
                    <Icon name="external-link" size={12} />
                  </a>
                </>
              )}
            </ReviewNotice>
          )}

          {repoSelected && hasPendingPermissionUpgrade && !blocked && (
            <ReviewNotice icon="triangle-alert" tone="warning">
              {hasExactChecksWritePermission ? t('pendingUpgradeChecksKept') : t('pendingUpgrade')}{' '}
              <a href={installation.settingsUrl} target="_blank" rel="noopener noreferrer" className="lnk text-[12px]">
                {t('reviewPermissions')}
                <Icon name="external-link" size={12} />
              </a>
            </ReviewNotice>
          )}
        </>
      }
    />
  )
}
