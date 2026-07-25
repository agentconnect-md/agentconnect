'use client'

// Schedule editor for dreaming, built on the SAME cron model the Schedules
// feature uses (`lib/cron.ts`): the preset modes (hourly/daily/weekdays/weekly)
// with a custom-expression escape hatch, humanized back to the user, plus the
// next fire time. A raw cron box would have been a worse version of a control
// this console already solved.

import { buildCron, cronHuman, cronNext, fmtNextRun, parseCron, type CronMode } from '@/lib/cron'

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

/** The browser's zone — dreams fire on the daemon, but showing the next run in
 *  the reader's own zone is what makes the schedule legible. */
function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function DreamScheduleFields({
  value,
  onChange,
  disabled
}: {
  /** Cron expression, or '' for manual-only. */
  value: string
  onChange: (next: string) => void
  disabled: boolean
}) {
  const enabled = value.trim().length > 0
  const parts = parseCron(value.trim() || '0 4 * * *')
  const zone = localZone()
  const human = enabled ? cronHuman(value.trim()) : null
  const next = enabled ? fmtNextRun(cronNext(value.trim(), zone)) : null

  const set = (mode: CronMode, hour: number, minute: number, weekday: number) => {
    onChange(mode === 'custom' ? value.trim() || '0 4 * * *' : buildCron(mode, hour, minute, weekday))
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2 font-sans text-[12px] font-normal leading-normal text-(--text-secondary)">
        <input
          type="checkbox"
          checked={enabled}
          disabled={disabled}
          onChange={() => onChange(enabled ? '' : '0 4 * * *')}
        />
        Run on a schedule (otherwise dreams only run when you trigger them)
      </label>

      {enabled ? (
        <div className="ml-6 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={parts.mode}
              disabled={disabled}
              aria-label="Schedule frequency"
              onChange={(e) => set(e.target.value as CronMode, parts.hour, parts.minute, parts.weekday)}
              className={FIELD}
            >
              {MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>

            {parts.mode === 'weekly' ? (
              <select
                value={parts.weekday}
                disabled={disabled}
                aria-label="Day of week"
                onChange={(e) => set('weekly', parts.hour, parts.minute, Number(e.target.value))}
                className={FIELD}
              >
                {WEEKDAYS.map((day, i) => (
                  <option key={day} value={i}>
                    {day}
                  </option>
                ))}
              </select>
            ) : null}

            {parts.mode !== 'custom' && parts.mode !== 'hourly' ? (
              <input
                type="time"
                value={`${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`}
                disabled={disabled}
                aria-label="Time of day"
                onChange={(e) => {
                  const [h, m] = e.target.value.split(':').map(Number)
                  set(parts.mode as Exclude<CronMode, 'custom'>, h ?? 4, m ?? 0, parts.weekday)
                }}
                className={FIELD}
              />
            ) : null}

            {parts.mode === 'hourly' ? (
              <input
                type="number"
                min={0}
                max={59}
                value={parts.minute}
                disabled={disabled}
                aria-label="Minute past the hour"
                onChange={(e) => set('hourly', parts.hour, Number(e.target.value), parts.weekday)}
                className={`${FIELD} w-[72px]`}
              />
            ) : null}
          </div>

          {parts.mode === 'custom' ? (
            <input
              type="text"
              value={value}
              disabled={disabled}
              aria-label="Cron expression"
              placeholder="0 4 * * *"
              onChange={(e) => onChange(e.target.value)}
              className={`${FIELD} font-mono`}
            />
          ) : null}

          {/* Humanized + next fire time — the same reassurance Schedules gives,
              so nobody has to decode a cron string to know what they saved. */}
          <span className="font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
            {human ? `${human} · next ${next} (${zone})` : 'That cron expression is not valid.'}
          </span>
        </div>
      ) : null}
    </div>
  )
}
