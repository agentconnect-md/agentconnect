// The people's local time on an assistant-mode turn (assistant-mode.md §5.4): their zone, else the place's last seen, else UTC.
import { knownTimeZone } from '../messages/time-zone.js'

/** The prelude line naming the current local time, e.g. `Now: 2026-10-12 Mon 04:20 (Asia/Shanghai, UTC+08:00).` */
export function renderLocalNow(now: number, timeZone: string | undefined): string {
  const zone = knownTimeZone(timeZone)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone ?? 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset'
  }).formatToParts(new Date(now))
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? ''
  const stamp = `${part('year')}-${part('month')}-${part('day')} ${part('weekday')} ${part('hour')}:${part('minute')}`
  // `longOffset` reads `GMT+08:00`, or a bare `GMT` at zero on some engines.
  const offset = `UTC${part('timeZoneName').replace(/^GMT/, '') || '+00:00'}`
  const where = !zone ? 'UTC, local time zone unknown' : /^[+-]/.test(zone) ? offset : `${zone}, ${offset}`
  return `<system-reminder>\nNow: ${stamp} (${where}).\n</system-reminder>`
}
