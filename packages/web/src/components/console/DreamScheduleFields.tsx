'use client'

// Schedule editor for dreaming, built on the SAME cron model the Schedules
// feature uses (`lib/cron.ts`): the preset modes (hourly/daily/weekdays/weekly)
// with a custom-expression escape hatch, humanized back to the user, plus the
// next fire time. A raw cron box would have been a worse version of a control
// this console already solved.
//
// Two things the Schedules modal gets right and this mirrors:
//   * `mode` is held SEPARATELY from the expression. Deriving it from the cron
//     alone makes Custom unreachable — picking it would emit a preset-shaped
//     expression, `parseCron` would read the preset back, and the select would
//     snap shut without ever mounting the raw input.
//   * The preview is evaluated in the schedule's OWN timezone (what the daemon's
//     DreamScheduler uses), not the reader's browser zone — otherwise a New York
//     schedule read from Berlin advertises a fire time that never happens.

import { useState } from 'react'
import { buildCron, cronHuman, cronNext, fmtNextRun, isIanaTimezone, parseCron, type CronMode } from '@/lib/cron'

const MODES: ReadonlyArray<{ value: CronMode; label: string }> = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'custom', label: 'Custom' }
]

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const FIELD =
  'rounded-sm border border-(--border-subtle) bg-(--surface-card) px-2 py-1 font-sans text-[12px] leading-normal text-(--text-primary)'

/** The reader's zone — only ever a DEFAULT for a new schedule, never the zone a
 *  saved schedule is evaluated in. */
function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function DreamScheduleFields({
  value,
  timezone,
  onChange,
  disabled
}: {
  /** Cron expression, or '' for manual-only. */
  value: string
  /** IANA zone the cron is evaluated in; '' means the daemon host's local zone. */
  timezone: string
  onChange: (schedule: string, timezone: string) => void
  disabled: boolean
}) {
  const enabled = value.trim().length > 0
  const parsed = parseCron(value.trim() || '0 4 * * *')
  // Held separately so Custom is reachable from a preset (see the note above).
  // `null` means "follow the expression", which is what a fresh mount wants.
  const [modeOverride, setModeOverride] = useState<CronMode | null>(null)
  const mode = modeOverride ?? parsed.mode

  // Empty timezone = the daemon decides (its own local zone). We cannot know
  // that zone here, so the preview is only honest once a zone is explicit.
  const zoneKnown = isIanaTimezone(timezone)
  const human = enabled ? cronHuman(value.trim()) : null
  const next = enabled && zoneKnown ? fmtNextRun(cronNext(value.trim(), timezone)) : null

  const emit = (nextMode: CronMode, hour: number, minute: number, weekday: number) => {
    setModeOverride(nextMode)
    // Custom keeps whatever expression is already there — switching mode must not
    // rewrite the user's cron.
    if (nextMode === 'custom') return
    onChange(buildCron(nextMode, hour, minute, weekday), timezone)
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2 font-sans text-[12px] font-normal leading-normal text-(--text-secondary)">
        <input
          type="checkbox"
          checked={enabled}
          disabled={disabled}
          onChange={() => {
            setModeOverride(null)
            // A new schedule defaults to the reader's zone — an explicit zone is
            // what makes the preview (and the daemon's evaluation) unambiguous.
            onChange(enabled ? '' : '0 4 * * *', enabled ? '' : browserZone())
          }}
        />
        Run on a schedule (otherwise dreams only run when you trigger them)
      </label>

      {enabled ? (
        <div className="ml-6 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={mode}
              disabled={disabled}
              aria-label="Schedule frequency"
              onChange={(e) => emit(e.target.value as CronMode, parsed.hour, parsed.minute, parsed.weekday)}
              className={FIELD}
            >
              {MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>

            {mode === 'weekly' ? (
              <select
                value={parsed.weekday}
                disabled={disabled}
                aria-label="Day of week"
                onChange={(e) => emit('weekly', parsed.hour, parsed.minute, Number(e.target.value))}
                className={FIELD}
              >
                {WEEKDAYS.map((day, i) => (
                  <option key={day} value={i}>
                    {day}
                  </option>
                ))}
              </select>
            ) : null}

            {mode !== 'custom' && mode !== 'hourly' ? (
              <input
                type="time"
                value={`${String(parsed.hour).padStart(2, '0')}:${String(parsed.minute).padStart(2, '0')}`}
                disabled={disabled}
                aria-label="Time of day"
                onChange={(e) => {
                  const [h, m] = e.target.value.split(':').map(Number)
                  emit(mode as Exclude<CronMode, 'custom'>, h ?? 4, m ?? 0, parsed.weekday)
                }}
                className={FIELD}
              />
            ) : null}

            {mode === 'hourly' ? (
              <input
                type="number"
                min={0}
                max={59}
                value={parsed.minute}
                disabled={disabled}
                aria-label="Minute past the hour"
                onChange={(e) => emit('hourly', parsed.hour, Number(e.target.value), parsed.weekday)}
                className={`${FIELD} w-[72px]`}
              />
            ) : null}
          </div>

          {mode === 'custom' ? (
            <input
              type="text"
              value={value}
              disabled={disabled}
              aria-label="Cron expression"
              placeholder="0 4 * * *"
              onChange={(e) => onChange(e.target.value, timezone)}
              className={`${FIELD} font-mono`}
            />
          ) : null}

          <label className="flex flex-col gap-1 font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
            Timezone
            <input
              type="text"
              value={timezone}
              disabled={disabled}
              aria-label="Schedule timezone"
              placeholder={`${browserZone()} (blank = the daemon host’s zone)`}
              onChange={(e) => onChange(value, e.target.value)}
              className={`${FIELD} max-w-[280px]`}
            />
          </label>

          {/* Humanized + next fire time — the same reassurance Schedules gives,
              so nobody has to decode a cron string to know what they saved. */}
          <span className="font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
            {!human
              ? 'That cron expression is not valid.'
              : timezone && !zoneKnown
                ? `${human} · “${timezone}” is not a known IANA timezone`
                : zoneKnown
                  ? `${human} · next ${next} (${timezone})`
                  : `${human} · in the daemon host’s timezone`}
          </span>
        </div>
      ) : null}
    </div>
  )
}
