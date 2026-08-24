'use client'

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
  defaultExpanded?: boolean
  canAuthorizeRepo?: boolean
  authorizingRepo?: boolean
  onAuthorizeRepo?: () => void
}) {
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

  const approveHelp = `Allows a formal APPROVE review. The App cannot approve its own PR or guarantee CODEOWNERS coverage${
    publicRepo ? '; public PR content is untrusted input' : ''
  }.`

  return (
    <CodeHostReviewSettings
      title="PR review"
      value={value}
      onReviewPolicyChange={onReviewPolicyChange}
      onReportingModeChange={onReportingModeChange}
      defaultExpanded={defaultExpanded}
      statusCheckLabel="Status check"
      help={{
        inlineComments: 'Submit formal COMMENT reviews with optional comments on specific changed lines.',
        requestChanges:
          'Allow formal REQUEST_CHANGES reviews for blocking findings. This also enables inline comments.',
        approve: approveHelp,
        statusCheck:
          'Publish an informational GitHub Check Run for queued, in-progress, and final results. It does not block merging.'
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
                    {authorizingRepo ? 'Authorizing…' : repoAccess === 'none' ? 'Authorize repo' : 'Upgrade access'}
                  </button>
                ) : undefined
              }
            >
              This configuration needs {needed} repository access; the agent currently has {repoAccess}.
            </ReviewNotice>
          )}
          {reviewPermissionBlocked && (
            <ReviewNotice icon="triangle-alert" tone="error">
              {installation?.pullRequestsPermission === 'missing'
                ? 'This installation must grant the App Pull requests write permission for formal reviews.'
                : installation?.pullRequestsPermission === 'read'
                  ? 'This installation must upgrade Pull requests permission from read to write for formal reviews.'
                  : 'Pull requests write permission could not be confirmed for this installation.'}
              {installation?.settingsUrl && (
                <>
                  {' '}
                  <a
                    href={installation.settingsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="lnk text-[12px]"
                  >
                    Review permissions
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
                  ? 'This installation must accept the App’s updated Checks permission.'
                  : 'Checks permission could not be confirmed for this installation.'
                : installation?.pullRequestsPermission === 'missing'
                  ? 'This installation must grant the App Pull requests read permission for live PR association.'
                  : 'Pull requests read permission could not be confirmed for live PR association.'}
              {installation?.settingsUrl && (
                <>
                  {' '}
                  <a
                    href={installation.settingsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="lnk text-[12px]"
                  >
                    Update permissions
                    <Icon name="external-link" size={12} />
                  </a>
                </>
              )}
            </ReviewNotice>
          )}

          {repoSelected && hasPendingPermissionUpgrade && !blocked && (
            <ReviewNotice icon="triangle-alert" tone="warning">
              {hasExactChecksWritePermission
                ? 'This installation has other GitHub App permission updates waiting for approval. Its current Checks write permission remains available.'
                : 'This installation has GitHub App permission updates waiting for approval.'}{' '}
              <a href={installation.settingsUrl} target="_blank" rel="noopener noreferrer" className="lnk text-[12px]">
                Review permissions
                <Icon name="external-link" size={12} />
              </a>
            </ReviewNotice>
          )}
        </>
      }
    />
  )
}
