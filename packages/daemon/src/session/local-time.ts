// The people's local time on every agent's turn (product-conventions.md "Local time"), and each person's last known zone.
import type { ReadAsker } from '../assistant/place-access.js'
import { askerKey } from '../assistant/place-members.js'
import { knownTimeZone } from '../messages/time-zone.js'

/** How many people's last known zones are kept; the oldest is forgotten first. */
const PERSON_ZONE_ENTRIES = 5000

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

/** A time of day such as `14:05` in the people's zone, `14:05 UTC` when it is unknown. */
export function renderClock(at: number, timeZone: string | undefined): string {
  const zone = knownTimeZone(timeZone)
  const clock = new Intl.DateTimeFormat('en-US', {
    timeZone: zone ?? 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(new Date(at))
  return zone ? clock : `${clock} UTC`
}

/** A calendar day such as `2026-10-17` in the people's zone, UTC's when it is unknown. */
export function renderDay(at: number, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: knownTimeZone(timeZone) ?? 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(at))
}

/** Each person's last known zone, by who they are to the read rule; in memory, so after a restart a run falls through to its place's. */
export class PersonTimeZones {
  private readonly zones = new Map<string, string>()

  note(person: ReadAsker, zone: string): void {
    const key = askerKey(person)
    this.zones.delete(key)
    this.zones.set(key, zone)
    const oldest = this.zones.size > PERSON_ZONE_ENTRIES ? this.zones.keys().next().value : undefined
    if (oldest !== undefined) this.zones.delete(oldest)
  }

  get(person: ReadAsker): string | undefined {
    return this.zones.get(askerKey(person))
  }
}
