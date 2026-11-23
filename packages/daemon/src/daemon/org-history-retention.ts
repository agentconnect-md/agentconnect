// Per-organization history retention as the CP delivers it, the dry run, and the reclaim window rule (org-session-policy.md, History retention, Reclaim).
import { metrics } from '@opentelemetry/api'
import {
  OrgHistoryRetention as OrgHistoryRetentionEntry,
  type HistoryRetentionConfirmResult,
  type OrgHistoryRetentionSnapshot
} from '@agentconnect.md/protocol'

const DAY_MS = 86_400_000

/** Why an org's window cannot be trusted now: no delivery on this link, a revision older than one seen, or an org no delivery named. */
export type OrgRetentionPause = 'unsynced' | 'stale' | 'unknown'

/** How an org's history window would be chosen: its policy, today's daemon-wide rule, or not at all. */
export type OrgRetentionVerdict =
  | { kind: 'policy'; windowMs: number | null; revision: number }
  | { kind: 'missing' }
  | { kind: 'paused'; reason: OrgRetentionPause }

/** The delivered history retention of the orgs this daemon serves, held in memory and never persisted. */
export class OrgHistoryRetentionState {
  private registered = false
  private synced = false
  // The install's reclaim switch as the last snapshot carried it; a register/ok without a snapshot leaves it as it was.
  private reclaim = false
  private covered = new Set<string>()
  private readonly entries = new Map<string, OrgHistoryRetentionEntry>()
  private readonly stale = new Set<string>()
  // Survives reconnects, not restarts: a later snapshot below it is a lagging read, not a newer policy.
  private readonly highest = new Map<string, number>()

  /** A `register/ok`: replaces what this link knows; absent (a CP that does not deliver it) leaves every org unsynced. */
  applySnapshot(snapshot: OrgHistoryRetentionSnapshot | undefined): void {
    this.registered = true
    this.entries.clear()
    this.stale.clear()
    if (!snapshot) {
      this.synced = false
      this.covered = new Set()
      return
    }
    this.reclaim = snapshot.reclaim === true
    this.covered = new Set([...snapshot.orgIds, ...snapshot.entries.map((entry) => entry.orgId)])
    for (const entry of snapshot.entries) {
      this.entries.set(entry.orgId, entry)
      const seen = this.highest.get(entry.orgId) ?? 0
      if (entry.revision < seen) this.stale.add(entry.orgId)
      else this.highest.set(entry.orgId, entry.revision)
    }
    // A policy once seen cannot vanish while its org is served, so its absence is a lagging read too.
    for (const orgId of this.covered) if (!this.entries.has(orgId) && this.highest.has(orgId)) this.stale.add(orgId)
    this.synced = true
  }

  /** A `config/push` of one org after its policy changed; returns false for a malformed value. */
  applyUpdate(value: unknown): boolean {
    const parsed = OrgHistoryRetentionEntry.safeParse(value)
    if (!parsed.success) return false
    const entry = parsed.data
    this.covered.add(entry.orgId)
    // An older revision than one already seen changes nothing; the newer entry stands.
    if (entry.revision < (this.highest.get(entry.orgId) ?? 0)) return true
    this.entries.set(entry.orgId, entry)
    this.highest.set(entry.orgId, entry.revision)
    this.stale.delete(entry.orgId)
    return true
  }

  /** Whether a Control Plane has answered a register; a daemon without one has nothing to compare. */
  engaged(): boolean {
    return this.registered
  }

  /** Whether deletion follows the org windows: the install switched reclaim on in a snapshot this daemon read. */
  reclaiming(): boolean {
    return this.registered && this.reclaim
  }

  /** Fold one org's re-confirmed answer in: a policy as a push would, and "no policy" after one was seen as a lagging read. */
  applyConfirmation(orgId: string, answer: OrgHistoryRetentionAnswer): void {
    if (answer.kind === 'policy') {
      this.applyUpdate({ orgId, revision: answer.revision, historyRetentionDays: answer.historyRetentionDays })
      return
    }
    if (answer.kind !== 'none') return
    if (this.highest.has(orgId)) this.stale.add(orgId)
    else this.covered.add(orgId)
  }

  /** The CP link dropped: nothing delivered before it is trusted until the next `register/ok`. */
  linkLost(): void {
    this.synced = false
  }

  /** How this org's window would be chosen now; a session with no org (a local agent) keeps today's rule. */
  verdict(orgId: string | undefined): OrgRetentionVerdict {
    if (!this.synced) return { kind: 'paused', reason: 'unsynced' }
    if (orgId === undefined) return { kind: 'missing' }
    if (this.stale.has(orgId)) return { kind: 'paused', reason: 'stale' }
    const entry = this.entries.get(orgId)
    if (entry) {
      const days = entry.historyRetentionDays
      return { kind: 'policy', windowMs: days === null ? null : days * DAY_MS, revision: entry.revision }
    }
    return this.covered.has(orgId) ? { kind: 'missing' } : { kind: 'paused', reason: 'unknown' }
  }

  /** Every delivered finite window, so a pass can list the oldest rows any of them reaches. */
  windowsMs(): number[] {
    return [...this.entries.values()].flatMap((entry) =>
      entry.historyRetentionDays === null ? [] : [entry.historyRetentionDays * DAY_MS]
    )
  }
}

/** One candidate as the dry run judges it; `protected` is any guard the real sweep would keep it for. */
export interface OrgRetentionCandidate {
  updatedAt: number
  protected: boolean
  verdict: OrgRetentionVerdict
}

export type OrgRetentionDecision = {
  current: 'delete' | 'keep'
  org: 'delete' | 'keep' | 'paused' | 'protected'
}

/** What today's rule and the org window would each decide for one candidate; neither acts. */
export function judgeOrgRetention(
  candidate: OrgRetentionCandidate,
  currentWindowMs: number | null,
  now: number
): OrgRetentionDecision {
  const expired = (windowMs: number | null) => windowMs !== null && candidate.updatedAt < now - windowMs
  const current = expired(currentWindowMs) && !candidate.protected ? 'delete' : 'keep'
  if (candidate.protected) return { current, org: 'protected' }
  const { verdict } = candidate
  if (verdict.kind === 'paused') return { current, org: 'paused' }
  const windowMs = verdict.kind === 'policy' ? verdict.windowMs : currentWindowMs
  return { current, org: expired(windowMs) ? 'delete' : 'keep' }
}

/** One pass's counts; candidates = wouldDelete + wouldKeep + paused + protected. */
export interface OrgRetentionDryRunSummary {
  candidates: number
  currentDeletes: number
  wouldDelete: number
  wouldKeep: number
  differs: number
  orgDeletesMore: number
  orgKeepsMore: number
  policyMissing: number
  paused: number
  pausedUnsynced: number
  pausedStale: number
  pausedUnknown: number
  protected: number
}

export function emptyDryRunSummary(): OrgRetentionDryRunSummary {
  return {
    candidates: 0,
    currentDeletes: 0,
    wouldDelete: 0,
    wouldKeep: 0,
    differs: 0,
    orgDeletesMore: 0,
    orgKeepsMore: 0,
    policyMissing: 0,
    paused: 0,
    pausedUnsynced: 0,
    pausedStale: 0,
    pausedUnknown: 0,
    protected: 0
  }
}

/** Fold one candidate's decision into the pass's counts. */
export function countDryRun(
  summary: OrgRetentionDryRunSummary,
  verdict: OrgRetentionVerdict,
  decision: OrgRetentionDecision
): void {
  summary.candidates += 1
  if (decision.current === 'delete') summary.currentDeletes += 1
  if (decision.org === 'protected') {
    summary.protected += 1
    return
  }
  if (verdict.kind === 'paused') {
    summary.paused += 1
    if (verdict.reason === 'unsynced') summary.pausedUnsynced += 1
    else if (verdict.reason === 'stale') summary.pausedStale += 1
    else summary.pausedUnknown += 1
    return
  }
  if (verdict.kind === 'missing') summary.policyMissing += 1
  if (decision.org === 'delete') summary.wouldDelete += 1
  else summary.wouldKeep += 1
  if (decision.org !== decision.current) {
    summary.differs += 1
    if (decision.org === 'delete') summary.orgDeletesMore += 1
    else summary.orgKeepsMore += 1
  }
}

/** The pass's one structured log line. */
export function formatDryRunSummary(s: OrgRetentionDryRunSummary): string {
  return (
    `retention dry run: org history retention candidates=${s.candidates} currentDeletes=${s.currentDeletes}` +
    ` wouldDelete=${s.wouldDelete} wouldKeep=${s.wouldKeep} differs=${s.differs}` +
    ` orgDeletesMore=${s.orgDeletesMore} orgKeepsMore=${s.orgKeepsMore} policyMissing=${s.policyMissing}` +
    ` paused=${s.paused} pausedUnsynced=${s.pausedUnsynced} pausedStale=${s.pausedStale}` +
    ` pausedUnknown=${s.pausedUnknown} protected=${s.protected}`
  )
}

const meter = metrics.getMeter('@agentconnect.md/daemon-retention', '1.0.0')
const dryRunGauge = meter.createObservableGauge('agentconnect.session.retention.dry_run.sessions', {
  unit: '{session}',
  description: 'Sessions the last retention dry run counted, by what the organization window would decide'
})
let lastSummary: OrgRetentionDryRunSummary | undefined
dryRunGauge.addCallback((result) => {
  if (!lastSummary) return
  const s = lastSummary
  for (const [outcome, value] of [
    ['would_delete', s.wouldDelete],
    ['would_keep', s.wouldKeep],
    ['differs', s.differs],
    ['policy_missing', s.policyMissing],
    ['paused', s.paused],
    ['protected', s.protected],
    ['current_deletes', s.currentDeletes]
  ] as const) {
    result.observe(value, { outcome })
  }
})

/** Expose the pass's counts as the dry-run gauge. */
export function recordDryRunMetrics(summary: OrgRetentionDryRunSummary): void {
  lastSummary = { ...summary }
}

/** What the Control Plane answered for one org at a sweep's re-confirmation. */
export type OrgHistoryRetentionAnswer =
  { kind: 'policy'; revision: number; historyRetentionDays: number | null } | { kind: 'none' } | { kind: 'denied' }

/** One answer per asked org; an org the reply leaves out stays unconfirmed. */
export function confirmationAnswers(result: HistoryRetentionConfirmResult): Map<string, OrgHistoryRetentionAnswer> {
  const answers = new Map<string, OrgHistoryRetentionAnswer>()
  for (const orgId of result.denied) answers.set(orgId, { kind: 'denied' })
  for (const orgId of result.noPolicy) answers.set(orgId, { kind: 'none' })
  for (const entry of result.entries) {
    answers.set(entry.orgId, {
      kind: 'policy',
      revision: entry.revision,
      historyRetentionDays: entry.historyRetentionDays
    })
  }
  return answers
}

/** Whether the Control Plane's answer is exactly what the sweep would act on: the same revision and window, or still no policy. */
export function confirms(verdict: OrgRetentionVerdict, answer: OrgHistoryRetentionAnswer | undefined): boolean {
  if (verdict.kind === 'missing') return answer?.kind === 'none'
  if (verdict.kind !== 'policy' || answer?.kind !== 'policy') return false
  const windowMs = answer.historyRetentionDays === null ? null : answer.historyRetentionDays * DAY_MS
  return answer.revision === verdict.revision && windowMs === verdict.windowMs
}

/** Whether two readings of one org are the same basis for deletion: kind, revision and window. */
export function sameVerdict(a: OrgRetentionVerdict, b: OrgRetentionVerdict): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'policy' && b.kind === 'policy') return a.revision === b.revision && a.windowMs === b.windowMs
  return a.kind !== 'paused'
}

/** The idle window reclaim deletes a session after: a pool member's org window replaces the daemon-wide one, a self-hosted daemon takes the shorter; null keeps it, `paused` deletes nothing. */
export function reclaimWindowMs(
  verdict: OrgRetentionVerdict,
  daemonWindowMs: number | null,
  poolMember: boolean
): number | null | 'paused' {
  if (verdict.kind === 'paused') return 'paused'
  if (verdict.kind === 'missing') return daemonWindowMs
  if (poolMember) return verdict.windowMs
  if (verdict.windowMs === null) return daemonWindowMs
  return daemonWindowMs === null ? verdict.windowMs : Math.min(verdict.windowMs, daemonWindowMs)
}
