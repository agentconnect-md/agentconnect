// Age buckets for the session rail's grouped list.
//
// The rail dropped its per-row timestamp — at 224px a title and a time fight over
// the same line, and the title is what you are scanning for. Recency still has to
// be legible, so it moves up a level: rows group under "Today" / "Yesterday" / …
// headings, and the exact time lives in the row's hover tooltip.
//
// Bucketing is by CALENDAR DAY, not elapsed hours: a run from 11pm last night is
// "Yesterday" at 1am even though it is two hours old, because that is how people
// read their own history. `now` is injected so the boundaries are testable.

export type SessionAgeBucket = 'today' | 'yesterday' | 'week' | 'month' | 'older'

export const SESSION_AGE_LABELS: Record<SessionAgeBucket, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'Previous 7 days',
  month: 'Previous 30 days',
  older: 'Older'
}

/** Bucket order, oldest last — the rail renders groups in this sequence. */
const BUCKET_ORDER: SessionAgeBucket[] = ['today', 'yesterday', 'week', 'month', 'older']

const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/**
 * Which bucket a timestamp falls in, relative to `now`.
 *
 * A missing or unparseable timestamp sorts to `older` rather than throwing — the
 * rail must still render a row whose activity time the daemon never reported. A
 * FUTURE timestamp (clock skew between the daemon and this browser) reads as
 * `today`, which is the least surprising place to find it.
 */
export function sessionAgeBucket(iso: string | null | undefined, now: Date): SessionAgeBucket {
  if (!iso) return 'older'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'older'
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days <= 7) return 'week'
  if (days <= 30) return 'month'
  return 'older'
}

export interface SessionAgeGroup<T> {
  bucket: SessionAgeBucket
  label: string
  rows: T[]
}

/**
 * Split rows into age groups, dropping empty ones. Within a group the caller's
 * order is preserved (the CP already returns its page newest-first), so this only
 * decides where the headings land.
 */
export function groupSessionsByAge<T extends { lastActivityAt?: string | null }>(
  rows: T[],
  now: Date
): SessionAgeGroup<T>[] {
  const byBucket = new Map<SessionAgeBucket, T[]>()
  for (const row of rows) {
    const bucket = sessionAgeBucket(row.lastActivityAt, now)
    const bin = byBucket.get(bucket)
    if (bin) bin.push(row)
    else byBucket.set(bucket, [row])
  }
  return BUCKET_ORDER.filter((b) => byBucket.has(b)).map((bucket) => ({
    bucket,
    label: SESSION_AGE_LABELS[bucket],
    rows: byBucket.get(bucket) as T[]
  }))
}
