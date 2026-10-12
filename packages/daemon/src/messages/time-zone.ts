// A person's time zone as a client or a platform profile reports it, checked against the runtime's Intl.

/** Longest zone accepted from a client or a profile; IANA names are far shorter. */
export const TIME_ZONE_MAX_CHARS = 64

/** The zone as reported (`Asia/Shanghai`, `+08:00`) when the runtime's Intl knows it, else undefined. */
export function knownTimeZone(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > TIME_ZONE_MAX_CHARS) return undefined
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return value
  } catch {
    return undefined
  }
}

/** A fixed-offset zone (`+05:30`) from seconds east of UTC, as a platform profile's offset gives it. */
export function offsetTimeZone(seconds: unknown): string | undefined {
  if (typeof seconds !== 'number' || !Number.isInteger(seconds) || Math.abs(seconds) > 18 * 3600) return undefined
  const minutes = Math.round(Math.abs(seconds) / 60)
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0')
  const mm = String(minutes % 60).padStart(2, '0')
  return knownTimeZone(`${seconds < 0 ? '-' : '+'}${hh}:${mm}`)
}

/** A platform profile's zone: its IANA name, else its offset in seconds, else none. */
export function profileTimeZone(name: unknown, offsetSeconds: unknown): string | undefined {
  return knownTimeZone(name) ?? offsetTimeZone(offsetSeconds)
}
