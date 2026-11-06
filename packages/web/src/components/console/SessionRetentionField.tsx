// No 'use client': only client modals import it, and the directive would trip Next's serializable-props check on onChange.

// The daemon's cleanup row (Add/Edit daemon modals): workspace window first, then the session window, with one shared hint.
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import type { DaemonSessionRetention } from '@/lib/api'

export const SESSION_RETENTION_DEFAULT: DaemonSessionRetention = '90d'
export const WORKSPACE_RETENTION_DEFAULT: DaemonSessionRetention = '7d'

const KINDS = {
  session: {
    presets: ['7d', '30d', '90d', 'never'],
    defaultValue: SESSION_RETENTION_DEFAULT,
    scope: 'sessionRetention'
  },
  workspace: {
    presets: ['3d', '7d', '30d', 'never'],
    defaultValue: WORKSPACE_RETENTION_DEFAULT,
    scope: 'workspaceRetention'
  }
} as const satisfies Record<
  string,
  { presets: DaemonSessionRetention[]; defaultValue: DaemonSessionRetention; scope: string }
>

// Sentinel for the overlaid native <select>; never leaves this component.
const CUSTOM = '__custom'

// Full-string day count, same 1–9999 bound as the protocol's SESSION_RETENTION_RE.
const DAY_COUNT_RE = /^[1-9]\d{0,3}$/

// Whole-string parse only: this setting deletes data, so '1.5' or '1e2' must never coerce into another window.
export function parseCustomDays(text: string): number | null {
  const trimmed = text.trim()
  return DAY_COUNT_RE.test(trimmed) ? Number.parseInt(trimmed, 10) : null
}

function retentionDays(value: DaemonSessionRetention): number | null {
  if (value === 'never') return null
  const days = Number.parseInt(value, 10)
  return Number.isFinite(days) && days > 0 ? days : null
}

function RetentionPicker({
  kind,
  value,
  onChange,
  disabled
}: {
  kind: keyof typeof KINDS
  value: DaemonSessionRetention
  onChange: (value: DaemonSessionRetention) => void
  disabled?: boolean
}) {
  const t = useTranslations('Daemons.dialog')
  const { defaultValue, scope } = KINDS[kind]
  const presetValues: readonly DaemonSessionRetention[] = KINDS[kind].presets
  const presets = presetValues.map((preset) => ({
    value: preset,
    label:
      preset === 'never' ? t(`${scope}.never`) : t('sessionRetention.afterDays', { count: Number.parseInt(preset, 10) })
  }))
  const isPreset = presetValues.includes(value)
  // Sticky custom mode: the day input stays while the typed count passes through a preset (7 → 70).
  const [custom, setCustom] = useState(() => !isPreset)
  const [customText, setCustomText] = useState(() => (isPreset ? '' : String(retentionDays(value) ?? '')))
  const showCustom = custom || !isPreset
  const customInvalid = showCustom && parseCustomDays(customText) === null

  // Invalid text shows '…', not the parent's last valid window, so the row never claims a value nobody entered.
  const label = showCustom
    ? customInvalid
      ? t('sessionRetention.afterDays', { count: '…' })
      : t('sessionRetention.afterDays', { count: retentionDays(value) ?? 14 })
    : (presets.find((o) => o.value === value)?.label ?? value)

  const selectPreset = (next: string) => {
    if (next === CUSTOM) {
      setCustom(true)
      setCustomText(String(retentionDays(value) ?? 14))
      if (retentionDays(value) === null) onChange('14d')
      return
    }
    setCustom(false)
    onChange(next as DaemonSessionRetention)
  }

  const typeDays = (text: string) => {
    setCustomText(text)
    // Only a complete valid count propagates; the parent keeps the last valid value meanwhile.
    const days = parseCustomDays(text)
    if (days !== null) onChange(`${days}d`)
  }

  return (
    <div className="flex min-w-0 flex-col gap-[6px]">
      <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
        {t(`${scope}.label`)}
      </span>
      <div className={`inp relative ${disabled ? 'opacity-60' : ''}`}>
        <span className="truncate font-sans text-[13px] text-(--text-primary)">
          {label}
          {!showCustom && value === defaultValue && (
            <span className="text-(--text-tertiary)"> · {t('sessionRetention.default')}</span>
          )}
        </span>
        <Icon name="chevron-down" size={15} color="var(--text-tertiary)" className="ml-auto shrink-0" />
        <select
          value={showCustom ? CUSTOM : value}
          disabled={disabled}
          onChange={(e) => selectPreset(e.target.value)}
          className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-default"
          aria-label={t(`${scope}.ariaLabel`)}
        >
          {presets.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
              {o.value === defaultValue ? ` (${t('sessionRetention.default')})` : ''}
            </option>
          ))}
          <option value={CUSTOM}>{t('sessionRetention.custom')}</option>
        </select>
      </div>
      {showCustom && (
        <>
          <div className={`inp ${disabled ? 'opacity-60' : ''} ${customInvalid ? 'border-(--status-error)' : ''}`}>
            <input
              type="number"
              min={1}
              max={9999}
              step={1}
              value={customText}
              disabled={disabled}
              onChange={(e) => typeDays(e.target.value)}
              className="w-full bg-transparent font-sans text-[13px] text-(--text-primary) outline-none"
              aria-label={t(`${scope}.daysAriaLabel`)}
              aria-invalid={customInvalid || undefined}
              placeholder={t('sessionRetention.days')}
            />
            <span className="ml-auto shrink-0 font-sans text-[12px] text-(--text-tertiary)">
              {t('sessionRetention.daysSuffix')}
            </span>
          </div>
          {customInvalid && (
            <span className="font-sans text-[11.5px] font-normal leading-[1.5] text-(--status-error)">
              {t('sessionRetention.invalidDays')}
            </span>
          )}
        </>
      )}
    </div>
  )
}

export function SessionRetentionFields({
  session,
  workspace,
  onSessionChange,
  onWorkspaceChange,
  disabled
}: {
  session: DaemonSessionRetention
  workspace: DaemonSessionRetention
  onSessionChange: (value: DaemonSessionRetention) => void
  onWorkspaceChange: (value: DaemonSessionRetention) => void
  disabled?: boolean
}) {
  const t = useTranslations('Daemons.dialog')
  // The daemon caps the workspace window at the session window, so a longer one never takes effect.
  const sessionDays = retentionDays(session)
  const workspaceDays = retentionDays(workspace)
  const clampedDays =
    sessionDays !== null && (workspaceDays === null || workspaceDays >= sessionDays) ? sessionDays : null
  return (
    <div role="group" aria-label={t('retention.label')} className="fld mt-[14px]">
      <span className="fldlbl">{t('retention.label')}</span>
      <div className="grid grid-cols-1 items-start gap-[10px] desktop:grid-cols-2">
        <RetentionPicker kind="workspace" value={workspace} onChange={onWorkspaceChange} disabled={disabled} />
        <RetentionPicker kind="session" value={session} onChange={onSessionChange} disabled={disabled} />
      </div>
      <span className="font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
        {clampedDays === null ? t('retention.hint') : t('retention.clampedHint', { count: clampedDays })}
      </span>
    </div>
  )
}
