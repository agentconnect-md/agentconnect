// Which old revisions the retention sweep removes (artifacts.md §10.1, P3): the publishing installation's `sessions.retention`.
import { SESSION_RETENTION_RE } from '@agentconnect.md/protocol'

const DAY_MS = 24 * 60 * 60_000

/** A `sessions.retention` value as a window; null keeps everything (`never`, or a value the CP would not deliver). */
export function retentionWindowMs(setting: string | null | undefined): number | null {
  if (!setting || !SESSION_RETENTION_RE.test(setting) || setting === 'never') return null
  return Number(setting.slice(0, -1)) * DAY_MS
}

/** What the sweep knows about one revision when it decides, read under the artifact's row lock. */
export interface RevisionRetentionFacts {
  state: 'pending' | 'ready'
  number: number
  createdAt: Date
  /** The artifact's newest ready revision. */
  latestRevision: number
  /** The publishing daemon's current `sessions.retention`, else the value it had at publish; null when neither is known. */
  retention: string | null
  /** Whether an unrevoked share pins this revision. */
  activelyShared: boolean
}

/** True when a ready, older, unshared revision has outlived its installation's window; a pending one is the publish path's. */
export function revisionExpired(facts: RevisionRetentionFacts, now: number): boolean {
  if (facts.state !== 'ready' || facts.number >= facts.latestRevision || facts.activelyShared) return false
  const window = retentionWindowMs(facts.retention)
  return window !== null && facts.createdAt.getTime() + window < now
}
