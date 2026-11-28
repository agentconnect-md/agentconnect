// Which revisions the reaper removes (artifacts.md §10.1): old ready ones past retention (P3), unfinished ones past their PUTs.
import { SESSION_RETENTION_RE } from '@agentconnect.md/protocol'
import type { ArtifactRevisionState } from '../persistence/ports.js'

const DAY_MS = 24 * 60 * 60_000

/** A `sessions.retention` value as a window; null keeps everything (`never`, or a value the CP would not deliver). */
export function retentionWindowMs(setting: string | null | undefined): number | null {
  if (!setting || !SESSION_RETENTION_RE.test(setting) || setting === 'never') return null
  return Number(setting.slice(0, -1)) * DAY_MS
}

/** What the sweep knows about one revision when it decides, read under the artifact's row lock. */
export interface RevisionRetentionFacts {
  state: ArtifactRevisionState
  number: number
  createdAt: Date
  /** The artifact's newest ready revision. */
  latestRevision: number
  /** The publishing daemon's current `sessions.retention`, else the value it had at publish; null when neither is known. */
  retention: string | null
  /** Whether an unrevoked share pins this revision. */
  activelyShared: boolean
}

/** True when a ready, older, unshared revision has outlived its installation's window; a pending or closed one is the publish path's. */
export function revisionExpired(facts: RevisionRetentionFacts, now: number): boolean {
  if (facts.state !== 'ready' || facts.number >= facts.latestRevision || facts.activelyShared) return false
  const window = retentionWindowMs(facts.retention)
  return window !== null && facts.createdAt.getTime() + window < now
}

/** What the reaper knows about a revision that never became ready, read under the artifact's row lock. */
export interface UnfinishedRevisionFacts {
  state: ArtifactRevisionState
  /** When PUTs were last signed for it, at begin or a replay of it. */
  uploadsSignedAt: Date
}

/** True when a pending or closed revision's last PUTs expired more than `delayMs` (URL lifetime plus grace) ago. */
export function unfinishedRevisionExpired(facts: UnfinishedRevisionFacts, now: number, delayMs: number): boolean {
  return facts.state !== 'ready' && facts.uploadsSignedAt.getTime() + delayMs < now
}
