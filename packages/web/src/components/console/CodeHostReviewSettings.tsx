'use client'

import { useState, type ReactNode } from 'react'
import { Icon } from '@/components/ui'
import {
  codeHostReviewCapabilities,
  codeHostReviewSettingsFromCapabilities,
  REVIEW_PRESETS,
  reviewPresetOf,
  withCapability,
  type CodeHostReviewCapabilities,
  type CodeHostReviewSettingsValue,
  type HookReportingMode,
  type HookReviewPolicy
} from '@/lib/code-host-review-settings'

/** The four capability labels are shared; only the hover copy differs per host. */
export interface ReviewCapabilityHelp {
  inlineComments: string
  requestChanges: string
  approve: string
  statusCheck: string
}

// The disclosure both code hosts render: preset row, capability checkboxes, and a notice slot.
// It holds no authorization opinion — each host computes its own blockers and passes them in.
export function CodeHostReviewSettings({
  title,
  value,
  onReviewPolicyChange,
  onReportingModeChange,
  help,
  statusCheckLabel,
  defaultExpanded = false,
  notices
}: {
  title: string
  value: CodeHostReviewSettingsValue
  onReviewPolicyChange: (policy: HookReviewPolicy) => void
  onReportingModeChange: (mode: HookReportingMode) => void
  help: ReviewCapabilityHelp
  statusCheckLabel: string
  defaultExpanded?: boolean
  notices?: ReactNode
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const preset = reviewPresetOf(value)
  const capabilities = codeHostReviewCapabilities(value)

  const applyValue = (next: CodeHostReviewSettingsValue) => {
    if (next.reviewPolicy !== value.reviewPolicy) onReviewPolicyChange(next.reviewPolicy)
    if (next.reportingMode !== value.reportingMode) onReportingModeChange(next.reportingMode)
  }

  const setCapability = (key: keyof CodeHostReviewCapabilities, enabled: boolean) => {
    applyValue(codeHostReviewSettingsFromCapabilities(withCapability(capabilities, key, enabled)))
  }

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
        className="flex min-h-10 w-full items-center justify-between gap-3 rounded-md border border-(--border-default) bg-(--surface-card) px-3 py-[9px] text-left font-sans text-[12.5px] font-semibold leading-normal text-(--text-primary)"
      >
        <span>{title}</span>
        <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={15} className="flex-none" />
      </button>

      {expanded && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-3 gap-2">
            {REVIEW_PRESETS.map((option) => {
              const active = preset === option.id
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => applyValue(option.value)}
                  className={
                    active
                      ? 'h-10 rounded-md border border-(--brand) bg-(--brand-soft) font-sans text-[12.5px] font-semibold leading-normal text-(--brand-soft-text)'
                      : 'h-10 rounded-md border border-(--border-default) bg-(--surface-card) font-sans text-[12.5px] font-semibold leading-normal text-(--text-secondary)'
                  }
                >
                  {option.label}
                </button>
              )
            })}
          </div>

          {preset === 'details' && (
            <div className="grid grid-cols-2 gap-x-3 gap-y-2 desktop:grid-cols-4">
              <Capability
                label="Inline comments"
                help={help.inlineComments}
                checked={capabilities.inlineComments}
                onChange={(checked) => setCapability('inlineComments', checked)}
              />
              <Capability
                label="Request changes"
                help={help.requestChanges}
                checked={capabilities.requestChanges}
                onChange={(checked) => setCapability('requestChanges', checked)}
              />
              <Capability
                label="Approve"
                help={help.approve}
                checked={capabilities.approve}
                onChange={(checked) => setCapability('approve', checked)}
              />
              <Capability
                label={statusCheckLabel}
                help={help.statusCheck}
                checked={capabilities.statusCheck}
                onChange={(checked) => setCapability('statusCheck', checked)}
              />
            </div>
          )}
        </div>
      )}

      {notices}
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

/** The host-specific warning row; both wrappers render their blockers through it. */
export function ReviewNotice({
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
