'use client'

import { useState, type ReactNode } from 'react'
import { Icon } from '@/components/ui'
import {
  githubReviewCapabilities,
  githubReviewSettingsFromCapabilities,
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
  const [expanded, setExpanded] = useState(defaultExpanded)
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
  const brief = value.reviewPolicy === 'off' && value.reportingMode === 'off'
  const capabilities = githubReviewCapabilities(value)

  const applyValue = (next: GithubReviewSettingsValue) => {
    if (next.reviewPolicy !== value.reviewPolicy) onReviewPolicyChange(next.reviewPolicy)
    if (next.reportingMode !== value.reportingMode) onReportingModeChange(next.reportingMode)
  }

  const selectMode = (mode: 'brief' | 'details') =>
    applyValue(
      mode === 'brief'
        ? { reviewPolicy: 'off', reportingMode: 'off' }
        : { reviewPolicy: 'full', reportingMode: 'check' }
    )

  const setCapability = (key: keyof typeof capabilities, enabled: boolean) => {
    const next = { ...capabilities, [key]: enabled }
    if (key === 'inlineComments' && !enabled) {
      next.requestChanges = false
      next.approve = false
    } else if (key === 'requestChanges') {
      if (enabled) next.inlineComments = true
      else next.approve = false
    } else if (key === 'approve' && enabled) {
      next.inlineComments = true
      next.requestChanges = true
    }
    applyValue(githubReviewSettingsFromCapabilities(next))
  }

  const approveHelp = `Allows a formal APPROVE review. The App cannot approve its own PR or guarantee CODEOWNERS coverage${
    publicRepo ? '; public PR content is untrusted input' : ''
  }.`

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
        className="flex min-h-10 w-full items-center justify-between gap-3 rounded-md border border-(--border-default) bg-(--surface-card) px-3 py-[9px] text-left font-sans text-[12.5px] font-semibold leading-normal text-(--text-primary)"
      >
        <span>PR review</span>
        <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={15} className="flex-none" />
      </button>

      {expanded && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              aria-pressed={brief}
              onClick={() => selectMode('brief')}
              className={
                brief
                  ? 'h-10 rounded-md border border-(--brand) bg-(--brand-soft) font-sans text-[12.5px] font-semibold leading-normal text-(--brand-soft-text)'
                  : 'h-10 rounded-md border border-(--border-default) bg-(--surface-card) font-sans text-[12.5px] font-semibold leading-normal text-(--text-secondary)'
              }
            >
              Brief
            </button>
            <button
              type="button"
              aria-pressed={!brief}
              onClick={() => selectMode('details')}
              className={
                !brief
                  ? 'h-10 rounded-md border border-(--brand) bg-(--brand-soft) font-sans text-[12.5px] font-semibold leading-normal text-(--brand-soft-text)'
                  : 'h-10 rounded-md border border-(--border-default) bg-(--surface-card) font-sans text-[12.5px] font-semibold leading-normal text-(--text-secondary)'
              }
            >
              Details
            </button>
          </div>

          {!brief && (
            <div className="grid grid-cols-2 gap-x-3 gap-y-2 desktop:grid-cols-4">
              <Capability
                label="Inline comments"
                help="Submit formal COMMENT reviews with optional comments on specific changed lines."
                checked={capabilities.inlineComments}
                onChange={(checked) => setCapability('inlineComments', checked)}
              />
              <Capability
                label="Request changes"
                help="Allow formal REQUEST_CHANGES reviews for blocking findings. This also enables inline comments."
                checked={capabilities.requestChanges}
                onChange={(checked) => setCapability('requestChanges', checked)}
              />
              <Capability
                label="Approve"
                help={approveHelp}
                checked={capabilities.approve}
                onChange={(checked) => setCapability('approve', checked)}
              />
              <Capability
                label="Status check"
                help="Publish an informational GitHub Check Run for queued, in-progress, and final results. It does not block merging."
                checked={capabilities.statusCheck}
                onChange={(checked) => setCapability('statusCheck', checked)}
              />
            </div>
          )}
        </div>
      )}

      {accessBlocked && (
        <Notice
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
        </Notice>
      )}
      {reviewPermissionBlocked && (
        <Notice icon="triangle-alert" tone="error">
          {installation?.pullRequestsPermission === 'missing'
            ? 'This installation must grant the App Pull requests write permission for formal reviews.'
            : installation?.pullRequestsPermission === 'read'
              ? 'This installation must upgrade Pull requests permission from read to write for formal reviews.'
              : 'Pull requests write permission could not be confirmed for this installation.'}
          {installation?.settingsUrl && (
            <>
              {' '}
              <a href={installation.settingsUrl} target="_blank" rel="noopener noreferrer" className="lnk text-[12px]">
                Review permissions
                <Icon name="external-link" size={12} />
              </a>
            </>
          )}
        </Notice>
      )}

      {checkPermissionBlocked && (
        <Notice icon="triangle-alert" tone="error">
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
              <a href={installation.settingsUrl} target="_blank" rel="noopener noreferrer" className="lnk text-[12px]">
                Update permissions
                <Icon name="external-link" size={12} />
              </a>
            </>
          )}
        </Notice>
      )}

      {repoSelected && hasPendingPermissionUpgrade && !blocked && (
        <Notice icon="triangle-alert" tone="warning">
          {hasExactChecksWritePermission
            ? 'This installation has other GitHub App permission updates waiting for approval. Its current Checks write permission remains available.'
            : 'This installation has GitHub App permission updates waiting for approval.'}{' '}
          <a href={installation.settingsUrl} target="_blank" rel="noopener noreferrer" className="lnk text-[12px]">
            Review permissions
            <Icon name="external-link" size={12} />
          </a>
        </Notice>
      )}
    </div>
  )
}

function Capability({
  label,
  help,
  checked,
  onChange
}: {
  label: string
  help: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex min-w-0 cursor-help items-center gap-[7px]" title={help}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="accent-(--brand)"
      />
      <span className="truncate font-sans text-[11.5px] font-medium leading-normal text-(--text-secondary)">
        {label}
      </span>
      <Icon name="info" size={12} color="var(--text-tertiary)" className="flex-none" />
    </label>
  )
}

function Notice({
  icon,
  tone,
  action,
  children
}: {
  icon: string
  tone: 'warning' | 'error'
  action?: ReactNode
  children: ReactNode
}) {
  const error = tone === 'error'
  return (
    <div
      className={
        error
          ? 'flex items-start gap-2 rounded-md border border-(--status-error) bg-(--status-error-soft) px-3 py-[9px] font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)'
          : 'flex items-start gap-2 rounded-md border border-(--status-paused) bg-(--status-paused-soft) px-3 py-[9px] font-sans text-[12px] font-normal leading-[1.5] text-(--amber-500)'
      }
    >
      <Icon
        name={icon}
        size={14}
        color={error ? 'var(--status-error)' : 'var(--amber-500)'}
        className="mt-[2px] flex-none"
      />
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  )
}
