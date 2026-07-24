// Client-side cron helpers for the Schedules console: the human-readable
// reading of an expression and the next-fire preview. Both are display-only —
// the daemon (croner, same library) remains authoritative for actual firing.
import { Cron } from 'croner'
import cronstrue from 'cronstrue'
import type { CronDto, UpsertCronInput } from './api'

// The visual "Repeats" builder in the schedule modal speaks in these presets;
// `custom` is the escape hatch that exposes the raw expression. buildCron turns
// a preset + time into a 5-field cron; parseCron does the inverse so editing an
// existing schedule lands on the matching preset (falling back to `custom`).
export type CronMode = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom'

export interface CronParts {
  mode: CronMode
  minute: number // 0–59
  hour: number // 0–23
  weekday: number // 0–6, Sunday = 0
}

/** Compose a 5-field cron from the builder parts (never called for `custom`,
 *  which drives the raw expression directly). */
export function buildCron(mode: Exclude<CronMode, 'custom'>, hour: number, minute: number, weekday: number): string {
  switch (mode) {
    case 'hourly':
      return `${minute} * * * *`
    case 'daily':
      return `${minute} ${hour} * * *`
    case 'weekdays':
      return `${minute} ${hour} * * 1-5`
    case 'weekly':
      return `${minute} ${hour} * * ${weekday}`
  }
}

/** Recognize the presets buildCron emits and read them back into builder parts.
 *  Anything else (ranges, step values, comma lists, day-of-month …) is `custom`,
 *  paired with sensible defaults so the builder still has a complete state. */
export function parseCron(expr: string): CronParts {
  const parts = expr.trim().split(/\s+/)
  const fallback: CronParts = { mode: 'custom', minute: 0, hour: 9, weekday: 1 }
  if (parts.length !== 5) return fallback
  const [min, hr, dom, mon, dow] = parts
  const num = (s: string | undefined, hi: number) => (s && /^\d+$/.test(s) && +s <= hi ? +s : null)
  const minute = num(min, 59)
  if (minute === null || dom !== '*' || mon !== '*') return fallback
  // Hourly: fires every hour, so the hour field is a wildcard.
  if (hr === '*') return dow === '*' ? { mode: 'hourly', minute, hour: 9, weekday: 1 } : fallback
  const hour = num(hr, 23)
  if (hour === null) return fallback
  if (dow === '*') return { mode: 'daily', minute, hour, weekday: 1 }
  if (dow === '1-5') return { mode: 'weekdays', minute, hour, weekday: 1 }
  const weekday = num(dow, 6)
  if (weekday !== null) return { mode: 'weekly', minute, hour, weekday }
  return fallback
}

/** "0 9 * * 1" → "At 09:00 AM, only on Monday"; null when the expression
 *  doesn't parse (the caller decides how to show the error). */
export function cronHuman(expr: string): string | null {
  try {
    return cronstrue.toString(expr)
  } catch {
    return null
  }
}

export function isIanaTimezone(timezone: string): boolean {
  if (!timezone) return false
  try {
    const canonical = new Intl.DateTimeFormat('en', { timeZone: timezone }).resolvedOptions().timeZone
    return !canonical.startsWith('+') && !canonical.startsWith('-')
  } catch {
    return false
  }
}

export function cronTimezoneSelectModel(
  storedTimezone: string | null | undefined,
  browserTimezone: string,
  supportedTimezones: readonly string[]
) {
  const values = [
    ...new Set([...supportedTimezones, 'UTC', browserTimezone, storedTimezone].filter((value) => value != null))
  ].sort()
  return {
    initialValue: storedTimezone ?? browserTimezone,
    options: values.map((value) => ({
      value,
      label: storedTimezone == null && value === browserTimezone ? `Browser default (${value})` : value
    }))
  }
}

/** Next fire time, or null when the expression is invalid / never fires. */
export function cronNext(expr: string, timezone: string): Date | null {
  try {
    const job = new Cron(expr, { paused: true, timezone })
    const next = job.nextRun()
    job.stop()
    return next
  } catch {
    return null
  }
}

/** Build the complete PUT body for an existing cron. Centralizing this keeps
 * every edit/toggle path from accidentally dropping the stored timezone. */
export function cronUpdateInput(cron: CronDto, overrides: Partial<UpsertCronInput> = {}): UpsertCronInput | null {
  if (!cron.agentId) return null
  return {
    agentId: cron.agentId,
    ...(cron.name ? { name: cron.name } : {}),
    schedule: cron.schedule,
    timezone: cron.timezone,
    targetPlatform: cron.targetPlatform,
    ...(cron.targetChannel ? { targetChannel: cron.targetChannel } : {}),
    ...(cron.targetIntegrationId ? { targetIntegrationId: cron.targetIntegrationId } : {}),
    trigger: cron.trigger,
    enabled: cron.enabled,
    ...overrides
  }
}

/** Resolve the timezone fragment owned by the create/edit modal. A blank
 * create delegates to the CP default; an edit must retain an explicit zone. */
export function cronTimezoneInput(
  cron: CronDto | null | undefined,
  timezone: string
): Pick<UpsertCronInput, 'timezone'> | null {
  const value = timezone.trim()
  if (!value) return cron ? null : {}
  if (cron && timezone === cron.timezone) return { timezone }
  return isIanaTimezone(value) ? { timezone: value } : null
}

/** Short next-run label: "in 14 min" / "Today 3:00 AM" / "Mon 9:00 AM" / "—". */
export function fmtNextRun(d: Date | null): string {
  if (!d) return '—'
  const now = Date.now()
  const mins = Math.round((d.getTime() - now) / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `in ${mins} min`
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return `Today ${time}`
  const tomorrow = new Date(now + 86400000)
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`
}
