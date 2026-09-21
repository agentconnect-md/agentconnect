// No 'use client' here: imported only by client components (the daemon modals
// under ModalProvider), so it's already in the client bundle — and keeping the
// directive off avoids Next's "props must be serializable" check on onChange.

/**
 * The daemon's "Expire sessions" picker (Add/Edit daemon modals): how long the
 * daemon keeps FINISHED sessions in its local store before its retention sweep
 * deletes them (session row + per-session Git worktree). 'never' disables the
 * sweep; any other value is an integer day count ('<n>d') — the picker offers
 * the common windows plus a custom day input. Rendered as the standard `.inp`
 * field with an invisible overlaid native <select> (same pattern as the
 * lifecycle modal's version picker).
 */
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import type { DaemonSessionRetention } from '@/lib/api'

export const SESSION_RETENTION_DEFAULT: DaemonSessionRetention = '7d'

const PRESET_VALUES: DaemonSessionRetention[] = ['7d', '30d', '90d', 'never']

// Sentinel for the overlaid native <select>; never leaves this component.
const CUSTOM = '__custom'

// Full-string day count, same 1–9999 bound as the protocol's SESSION_RETENTION_RE.
const DAY_COUNT_RE = /^[1-9]\d{0,3}$/

/**
 * Parse the custom day input. The COMPLETE text must be an integer day count
 * (1–9999): a prefix parse would silently save a window the operator didn't
 * type ('1.5' → 1, '1e2' → 1), and anything past the protocol cap would only
 * fail server-side with a generic 400 — this setting deletes sessions and
 * workspaces, so an invalid entry must never coerce into a different value.
 */
export function parseCustomDays(text: string): number | null {
  const trimmed = text.trim()
  return DAY_COUNT_RE.test(trimmed) ? Number.parseInt(trimmed, 10) : null
}

function retentionDays(value: DaemonSessionRetention): number | null {
  if (value === 'never') return null
  const days = Number.parseInt(value, 10)
  return Number.isFinite(days) && days > 0 ? days : null
}

export function SessionRetentionField({
  value,
  onChange,
  disabled
}: {
  value: DaemonSessionRetention
  onChange: (value: DaemonSessionRetention) => void
  disabled?: boolean
}) {
  const t = useTranslations('Daemons.dialog')
  const presets = PRESET_VALUES.map((preset) => ({
    value: preset,
    label:
      preset === 'never'
        ? t('sessionRetention.never')
        : t('sessionRetention.afterDays', { count: Number.parseInt(preset, 10) })
  }))
  const isPreset = PRESET_VALUES.includes(value)
  // Sticky custom mode: once the operator picks "Custom…" the day input stays
  // visible even while the typed count momentarily equals a preset (7 → 70).
  const [custom, setCustom] = useState(() => !isPreset)
  const [customText, setCustomText] = useState(() => (isPreset ? '' : String(retentionDays(value) ?? '')))
  const showCustom = custom || !isPreset
  const customInvalid = showCustom && parseCustomDays(customText) === null

  // While the typed text is invalid the parent still holds the last valid
  // value — show '…' rather than that stale window so the row never claims a
  // setting the operator didn't enter.
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
    // Only propagate a complete valid count; invalid text surfaces inline below
    // and the parent keeps the last valid value.
    const days = parseCustomDays(text)
    if (days !== null) onChange(`${days}d`)
  }

  return (
    <div className="fld mt-[14px]">
      <span className="fldlbl">{t('expireSessions')}</span>
      <div className={`inp relative ${disabled ? 'opacity-60' : ''}`}>
        <span className="truncate font-sans text-[13px] text-(--text-primary)">
          {label}
          {!showCustom && value === SESSION_RETENTION_DEFAULT && (
            <span className="text-(--text-tertiary)"> · {t('sessionRetention.default')}</span>
          )}
        </span>
        <Icon name="chevron-down" size={15} color="var(--text-tertiary)" className="ml-auto" />
        <select
          value={showCustom ? CUSTOM : value}
          disabled={disabled}
          onChange={(e) => selectPreset(e.target.value)}
          className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-default"
          aria-label={t('expireSessions')}
        >
          {presets.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
              {o.value === SESSION_RETENTION_DEFAULT ? ` (${t('sessionRetention.default')})` : ''}
            </option>
          ))}
          <option value={CUSTOM}>{t('sessionRetention.custom')}</option>
        </select>
      </div>
      {showCustom && (
        <>
          <div
            className={`inp mt-[6px] ${disabled ? 'opacity-60' : ''} ${customInvalid ? 'border-(--status-error)' : ''}`}
          >
            <input
              type="number"
              min={1}
              max={9999}
              step={1}
              value={customText}
              disabled={disabled}
              onChange={(e) => typeDays(e.target.value)}
              className="w-full bg-transparent font-sans text-[13px] text-(--text-primary) outline-none"
              aria-label={t('sessionRetention.daysAriaLabel')}
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
      <span className="font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
        {t('sessionRetention.hint')}
      </span>
    </div>
  )
}
