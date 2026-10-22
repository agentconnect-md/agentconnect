import type { SessionRecord } from '../store/local-store.js'
import { SESSION_RETENTION_RECHECK_MAX_MS, SESSION_RETENTION_SWEEP_INTERVAL_MS } from './constants.js'

type KeptSession = Pick<SessionRecord, 'updatedAt' | 'retentionKeptAt' | 'retentionRecheckAt'>

// The wait of the keep still in force: none once the session has had activity since, which makes the next keep a first one.
function currentWait({ updatedAt, retentionKeptAt, retentionRecheckAt }: KeptSession): number | undefined {
  if (retentionKeptAt == null || retentionRecheckAt == null || retentionKeptAt < updatedAt) return undefined
  return retentionRecheckAt - retentionKeptAt
}

/** Whether retention kept this session since its last activity and its wait has not run out, so judging it again would wake its pod for nothing (#3281). */
export function retentionRecheckPending(rec: KeptSession, now: number): boolean {
  // Half a pass of slack: the hourly pass lands a little before the stamp plus one interval, and that pass is the one meant.
  return currentWait(rec) !== undefined && rec.retentionRecheckAt! - SESSION_RETENTION_SWEEP_INTERVAL_MS / 2 > now
}

/** When a session kept at `keptAt` may be judged again: one pass after a first keep, then double the last wait, up to the cap. */
export function nextRetentionRecheck(rec: KeptSession, keptAt: number): number {
  const wait = Math.min(
    Math.max(2 * (currentWait(rec) ?? 0), SESSION_RETENTION_SWEEP_INTERVAL_MS),
    SESSION_RETENTION_RECHECK_MAX_MS
  )
  return keptAt + wait
}
